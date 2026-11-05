/**
 * Industry "30 Day Untouched" tags on FW contacts for email pushes.
 *
 * Pool: every FW contact (leads + customers) whose Industry (cf_industry) is
 * one of INDUSTRIES. Excluded:
 *   - mailed in the last 30 days or with a drop scheduled: contacts of
 *     accounts with such an Osprey drop — FW account contacts (via
 *     osprey_deal_sync), SFDC deal contacts of matching account names, and any
 *     contact sharing a business email domain with them
 *   - last contacted (email/call) or last sales activity in the last 30 days
 *   - contacts already carrying a win-back tag from audience-tags.js
 * A contact in more than one industry gets only the first.
 *
 *   node crm-import/industry-tags.js build      # read-only vs FW → stage rows in crm_import_rows
 *   FRESHSALES_WRITES_ENABLED=true node crm-import/industry-tags.js tag   # drain (cloud: industry-tags.yml)
 *
 * Staged in crm_imports (type contacts_accounts, marker MARKER): one row per
 * contact, fs_id = contact id, raw_json = {tag, email, name}. FW PUT replaces
 * the whole tag list, so tagging GETs each contact and PUTs existing tags + the
 * new one. Resumable by row status; MAX_RUNTIME_MS bounds each run.
 */
const C = require('./common');
const { BASE } = require('./audience-tags');

const INDUSTRIES = ['Dental', 'Church or Ministry'];
const tagFor = (ind) => `${ind} - 30 Day Untouched`;
const WINBACK_TAGS = ['Lapsed Nov-Dec 2025', 'Rep Left', 'No Current Rep'];
const MARKER = 'industry-tags-2026-11';
const WORKERS = Number(process.env.TAG_WORKERS || 5);
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com', 'outlook.com', 'icloud.com', 'comcast.net', 'msn.com', 'live.com', 'att.net', 'verizon.net', 'me.com', 'sbcglobal.net', 'bellsouth.net', 'ymail.com', 'cox.net', 'charter.net']);
const domain = (e) => String(e || '').toLowerCase().split('@')[1] || '';

// POST, but a read: /filtered_search doesn't modify anything, so it bypasses
// the write gate in C.fs (paced the same way).
async function search(rules, page) {
  const base = `https://${String(process.env.FRESHSALES_DOMAIN).replace(/^https?:\/\//, '').split('/')[0]}/crm/sales/api`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await C.sleep(1900);
    const r = await fetch(base + '/filtered_search/contact', {
      method: 'POST',
      headers: { Authorization: `Token token=${process.env.FRESHSALES_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter_rule: rules, page, per_page: 100 }),
    });
    if (r.status === 429 || r.status >= 500) { await C.sleep(30000); continue; }
    return (await r.json()).contacts || [];
  }
  throw new Error('filtered_search kept failing');
}

// Contacts at accounts with an Osprey drop in the last 30 days or scheduled.
async function recentlyMailed() {
  const { Client } = require('pg');   // local-only step (pg isn't a package dependency)
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const recent = (await db.query(`${BASE} select acct_id, nm from os where d >= current_date - 30`)).rows;
  const sf = (await db.query(`${BASE} select acct_id, nm, email, contact_id from sf where email is not null`)).rows;
  await db.end();
  const ids = new Set(recent.map((r) => r.acct_id).filter(Boolean));
  const nms = recent.map((r) => r.nm);
  const same = (l) => (l.acct_id && ids.has(l.acct_id))
    || nms.some((n) => n === l.nm || (Math.min(n.length, l.nm.length) >= 6 && (n.startsWith(l.nm) || l.nm.startsWith(n))));
  const emails = new Set(), cids = new Set();
  for (const r of sf) if (same(r)) { emails.add(r.email); if (r.contact_id) cids.add(String(r.contact_id)); }
  for (const id of ids) {
    const g = await C.fs('GET', `/sales_accounts/${id}/contacts?per_page=100`);
    for (const x of g.data?.contacts || []) { cids.add(String(x.id)); if (x.email) emails.add(x.email.toLowerCase()); }
  }
  const domains = new Set([...emails].map(domain).filter((d) => d && !FREEMAIL.has(d)));
  return { emails, cids, domains };
}

async function build() {
  const mailed = await recentlyMailed();
  const cut = Date.now() - 30 * 864e5;
  const seen = new Set();
  const out = [];
  for (const ind of INDUSTRIES) {
    const st = { pool: 0, noEmail: 0, mailed30: 0, contacted30: 0, otherIndustry: 0, eligible: 0 };
    for (let page = 1; ; page++) {
      const cs = await search([{ attribute: 'cf_industry', operator: 'is_in', value: [ind] }], page);
      for (const c of cs) {
        st.pool++;
        const e = String(c.email || '').toLowerCase();
        if (!e) { st.noEmail++; continue; }
        if (mailed.cids.has(String(c.id)) || mailed.emails.has(e) || mailed.domains.has(domain(e))) { st.mailed30++; continue; }
        const last = Math.max(Date.parse(c.last_contacted || 0) || 0, Date.parse(c.last_contacted_via_sales_activity || 0) || 0);
        if (last >= cut) { st.contacted30++; continue; }
        if (seen.has(c.id)) { st.otherIndustry++; continue; }
        seen.add(c.id); st.eligible++;
        out.push({ tag: tagFor(ind), id: c.id, email: e, name: c.display_name });
      }
      if (cs.length < 100) break;
    }
    console.log(ind, JSON.stringify(st));
  }
  const { data: imp, error } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: `Industry tags: ${INDUSTRIES.join(', ')}`,
    total_rows: out.length, sheet_name: 'industry-tags', status: 'pushing', uploaded_by: 'script:industry-tags',
    mapping_json: { __marker: MARKER, industries: INDUSTRIES, definition: 'cf_industry match; no Osprey drop in 30d/scheduled; not contacted/activity in 30d' },
  }).select('id').single();
  if (error) throw new Error(`import insert failed: ${error.message}`);
  for (let i = 0; i < out.length; i += 500) {
    const batch = out.slice(i, i + 500).map((r, j) => ({
      import_id: imp.id, row_index: i + j, status: 'pending', fs_id: String(r.id),
      raw_json: { tag: r.tag, email: r.email, name: r.name },
    }));
    const { error: e2 } = await C.supabase.from('crm_import_rows').insert(batch);
    if (e2) throw new Error(`stage insert failed: ${e2.message}`);
  }
  console.log(`${out.length} contacts staged → crm_imports ${imp.id}`);
}

async function tag() {
  const { data: imps } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .eq('import_type', 'contacts_accounts').eq('status', 'pushing').order('uploaded_at', { ascending: false }).limit(30);
  const imp = (imps || []).find((i) => i.mapping_json?.__marker === MARKER);
  if (!imp) { console.log('Nothing staged — done.'); return; }
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  const started = Date.now();
  const stats = { tagged: 0, already: 0, winback: 0, notFound: 0, failed: 0 };
  let n = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, fs_id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(200);
    if (!rows || !rows.length) {
      await C.supabase.from('crm_imports').update({ status: 'complete' }).eq('id', imp.id);
      console.log('All rows done — import marked complete.');
      break;
    }
    // WORKERS contacts at a time; C.fs still paces total requests to FRESHSALES_RATE.
    const one = async (row) => {
      const set = (status, error_message = null) => C.supabase.from('crm_import_rows')
        .update({ status, error_message, attempted_at: new Date().toISOString() }).eq('id', row.id);
      const t = row.raw_json.tag;
      const g = await C.fs('GET', `/contacts/${row.fs_id}`);
      if (!g.ok) { stats.notFound++; await set('failed', `GET ${g.status}`); return; }
      const tags = g.data.contact.tags || [];
      if (tags.includes(t)) { stats.already++; await set('sent'); }
      else if (tags.some((x) => WINBACK_TAGS.includes(x))) { stats.winback++; await set('skipped', 'in win-back push'); }
      else {
        const r = await C.fs('PUT', `/contacts/${row.fs_id}`, { contact: { tags: [...tags, t] } });
        if (r.ok) { stats.tagged++; await set('sent'); }
        else { stats.failed++; await set('failed', `PUT ${r.status} ${r.error}`); }
      }
      if (++n % 250 === 0) console.log(`  ${n} ${JSON.stringify(stats)}`);
    };
    for (let i = 0; i < rows.length; i += WORKERS) {
      if (MAX && Date.now() - started >= MAX) break;
      await Promise.all(rows.slice(i, i + WORKERS).map(one));
    }
  }
  console.log(JSON.stringify(stats));
}

const cmd = process.argv[2];
(cmd === 'build' ? build() : cmd === 'tag' ? tag() : Promise.reject(new Error('usage: build | tag')))
  .catch((e) => { console.error(e); process.exit(1); });
