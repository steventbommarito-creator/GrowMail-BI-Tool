/**
 * Audience tags on FW contacts for email pushes. Three audiences, in priority
 * order — a contact lands in the first one it qualifies for, so nobody gets
 * two of these emails:
 *
 *   1. "Lapsed Nov-Dec 2025" — Won order closed Nov–Dec 2025, no order since
 *      2026-01-01 (any seller).
 *   2. "Rep Left" — the account's latest Won deal (since 2025) was owned by a
 *      now-deactivated FW rep and nothing has been ordered since that deal.
 *   3. "No Current Rep" — latest Won deal (since 2025) owned by Customer
 *      Service or a deactivated rep, and no order in 2026.
 *
 * Orders = SFDC Closed Won rows (staged in crm_import_rows, marker
 * 'sfdc-opps-2022-script') + Osprey orders (osprey_mail_drops; an order's date
 * is its latest drop, so anything still mailing — incl. scheduled drops —
 * counts as activity). An account is keyed by its FW account id where known
 * (deal-accounts mapping / osprey_deal_sync / the SFDC deal's Osprey order
 * number) and also by normalized name (no punctuation, spaces or LLC/Inc-style
 * words, prefix match either way); activity under ANY key counts, so near-miss name matches err
 * toward leaving active customers out. Contacts = the FW contact on the
 * qualifying deal. Most recent customers first.
 *
 *   node crm-import/audience-tags.js build            # read-only → audiences JSON in AUDIENCE_OUT dir
 *   FRESHSALES_WRITES_ENABLED=true node crm-import/audience-tags.js tag [--only "<tag>"] [--limit N]
 *
 * Tagging GETs each contact and PUTs the union of its existing tags + the new
 * one, so no existing tag is removed. Idempotent: contacts that already have
 * the tag are skipped.
 */
const fsNode = require('fs');
const C = require('./common');

const OUT = (process.env.AUDIENCE_OUT || '.') + '/audiences.json';
// Deactivated FW sales reps as of 2026-11-04 (/selector/owners is_active=false).
const DEPARTED = ['chrisf@growmail.com', 'danielled@growmail.com', 'ericr@growmail.com', 'marks@growmail.com', 'christianc@growmail.com', 'jennifert@growmail.com'];
const NO_REP = [...DEPARTED, 'cs@growmail.com'];
const list = (a) => a.map((e) => `'${e}'`).join(',');
// Same account: FW account id, or one normalized name is a prefix of the other
// ("tuckerstree" ~ "tuckerstreeservices"), min 6 chars so short names don't sweep.
const SAME = (o) => `(${o}.acct_id = sf.acct_id or ${o}.nm = sf.nm
  or (least(length(${o}.nm), length(sf.nm)) >= 6 and (${o}.nm like sf.nm || '%' or sf.nm like ${o}.nm || '%')))`;
const EXCLUDE = `sf.nm not like 'valassis%' and sf.nm not like 'paleovalley%'`;   // house account; orders in 2026 as Paleovalley/Wild Pastures

const BASE = `
with deal_acct as (
  select r.fs_id deal_id, r.raw_json->>'fw_account_id' acct_id
  from crm_import_rows r join crm_imports i on i.id = r.import_id
  where i.mapping_json->>'__marker' = 'deal-accounts-2026-08'
),
sf as (
  select r.fs_id deal_id, da.acct_id,
         regexp_replace(regexp_replace(lower(r.raw_json->>'Account Name'), '[^a-z0-9 ]', '', 'g'), '\\m(llc|inc|co|the|and|company)\\M|\\s+', '', 'g') nm,
         r.raw_json->>'Account Name' account_name,
         to_date(r.raw_json->>'Close Date', 'MM/DD/YYYY') d,
         r.raw_json->>'Opportunity Owner' owner,
         r.normalized_json->'custom_field'->>'cf_order_number' order_no,
         (r.normalized_json->'contacts_added_list'->>0) contact_id,
         lower(nullif(trim(split_part(r.raw_json->>'Contact Emails', ',', 1)), '')) email
  from crm_import_rows r join crm_imports i on i.id = r.import_id
  left join deal_acct da on da.deal_id = r.fs_id
  where i.mapping_json->>'__marker' = 'sfdc-opps-2022-script'
    and r.raw_json->>'Stage' in ('Closed Won', 'Closed Won - Not Paid')
),
os as (
  select d.order_id, regexp_replace(regexp_replace(lower(max(d.customer_name)), '[^a-z0-9 ]', '', 'g'), '\\m(llc|inc|co|the|and|company)\\M|\\s+', '', 'g') nm,
         coalesce(max(s.fw_account_id::text), max(sf.acct_id)) acct_id,
         max(coalesce(d.drop_act_date, d.drop_est_date)) d   -- latest drop: still mailing in 2026 = active
  from osprey_mail_drops d
  left join osprey_deal_sync s on s.order_id = d.order_id
  left join sf on sf.order_no = d.order_id
  where d.order_status not in ('QUOTE', 'CANCELED', 'VOID', 'INCOMPLETE')
  group by d.order_id
),
orders as (
  select acct_id, nm, d from sf
  union all select acct_id, nm, d from os
),
active26 as (
  select distinct acct_id, nm from orders where d >= '2026-01-01'   -- incl. scheduled future drops
)
, lastdeal as (
  select distinct on (coalesce(acct_id, nm)) * from sf where coalesce(contact_id, email) is not null
  order by coalesce(acct_id, nm), d desc
)`

const AUDIENCES = [
  { tag: 'Lapsed Nov-Dec 2025', sql: `
    select * from sf
    where sf.d between '2025-11-01' and '2025-12-31' and coalesce(sf.contact_id, sf.email) is not null
      and not exists (select 1 from active26 a where ${SAME('a')})` },
  { tag: 'Rep Left', sql: `
    select * from lastdeal sf
    where sf.d >= '2025-01-01' and lower(sf.owner) in (${list(DEPARTED)})
      and not exists (select 1 from orders o where ${SAME('o')} and o.d > sf.d)` },
  { tag: 'No Current Rep', sql: `
    select * from lastdeal sf
    where sf.d >= '2025-01-01' and lower(sf.owner) in (${list(NO_REP)})
      and not exists (select 1 from active26 a where ${SAME('a')})` },
];

async function build() {
  const { Client } = require('pg');   // local-only step (pg isn't a package dependency)
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const seen = new Set();
  const out = [];
  for (const a of AUDIENCES) {
    const { rows } = await db.query(`${BASE} select * from (${a.sql}) sf where ${EXCLUDE} order by sf.d desc`);
    let n = 0;
    for (const r of rows) {
      const k = r.contact_id || r.email;
      if (seen.has(k)) continue;
      seen.add(k); n++;
      out.push({ tag: a.tag, contact_id: r.contact_id, email: r.email, account_name: r.account_name, acct_id: r.acct_id, owner: r.owner, deal_close: r.d });
    }
    console.log(`${a.tag}: ${n} contacts`);
  }
  await db.end();
  fsNode.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`→ ${OUT}`);
}

const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };

async function tag() {
  const only = arg('--only');
  const rows = JSON.parse(fsNode.readFileSync(OUT, 'utf8')).filter((r) => !only || r.tag === only);
  const limit = Number(arg('--limit') || rows.length);
  const stats = { tagged: 0, already: 0, notFound: 0, failed: 0 };
  let done = 0;
  for (const row of rows.slice(0, limit)) {
    if (++done % 100 === 0) console.log(`  ${done}/${limit} ${JSON.stringify(stats)}`);
    let id = row.contact_id;
    if (!id && row.email) {
      const lk = await C.fs('GET', `/lookup?q=${encodeURIComponent(row.email)}&f=email&entities=contact`);
      id = lk.data?.contacts?.contacts?.[0]?.id;
    }
    const g = id && await C.fs('GET', `/contacts/${id}`);
    if (!g || !g.ok) { stats.notFound++; console.log(`  not found: ${row.email || id} (${row.account_name})`); continue; }
    const tags = g.data.contact.tags || [];
    if (tags.includes(row.tag)) { stats.already++; continue; }
    const r = await C.fs('PUT', `/contacts/${id}`, { contact: { tags: [...tags, row.tag] } });
    if (r.ok) stats.tagged++;
    else { stats.failed++; console.log(`  failed ${id}: ${r.status} ${r.error}`); }
  }
  console.log(JSON.stringify(stats));
}

module.exports = { BASE, SAME };
if (require.main !== module) return;
const cmd = process.argv[2];
(cmd === 'build' ? build() : cmd === 'tag' ? tag() : Promise.reject(new Error('usage: build | tag')))
  .catch((e) => { console.error(e); process.exit(1); });
