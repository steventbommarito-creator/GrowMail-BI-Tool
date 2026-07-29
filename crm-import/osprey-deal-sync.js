/**
 * Osprey (Gordon & Lance) -> Freshworks deal sync.
 *
 * Reads the latest osprey_mail_drops (refreshed 5x/day by the scraper),
 * collapses to one record per order_id, and upserts a Freshworks deal per order:
 *   - new order_id            -> create a deal
 *   - seen order_id, changed  -> update stage/amount (only when they actually change)
 *   - INCOMPLETE order         -> skip (no deal; existing deals left untouched)
 * State is tracked in osprey_deal_sync so runs are cheap and resumable.
 *
 *   node crm-import/osprey-deal-sync.js [--limit N] [--dry-run]
 *
 * Field mapping (decided with the user):
 *   name              = "{Customer} – {Product Category} (#{order_id})"
 *   amount            = order_amount
 *   deal_stage_id     = order_status -> WON/QUOTED/LOST buckets (INCOMPLETE excluded)
 *   owner_id          = Seller -> FS user (Dani Dennis->Danielle Dennis; else Customer Service)
 *   sales_account_id  = match Customer name to an existing FS account, else blank
 *   cf_order_number   = order_id            cf_webid = web_id
 *   cf_sf_oppty_id    = "{customer_id}-{order_id}"  (unique guard: contains the unique order id)
 */
const C = require('./common');
const E = require('./sync-enrich');

const QUOTED = C.STAGE_IDS.Quoted, WON = C.STAGE_IDS.Won, LOST = C.STAGE_IDS.Lost;
// Explicit buckets; everything not listed here (all the active/production/design
// stages, plus LIMBO and DESIGN/PROOF DENIED) maps to WON, per the user.
const STATUS_QUOTED = new Set(['QUOTE']);
const STATUS_LOST = new Set(['CANCELED', 'VOID']);
const STATUS_EXCLUDE = new Set(['INCOMPLETE']);

// Osprey seller display name → FW user display name, where they differ.
// FW renamed "Danielle Dennis" → "Dani Dennis", so map the long form onto the
// current name; Stephanie Hanna is Stephanie Grabowski in FW.
const SELLER_ALIAS = { 'danielle dennis': 'dani dennis', 'stephanie hanna': 'stephanie grabowski', 'nick krutko': 'nicholas krutko' };

function stageForStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  if (STATUS_EXCLUDE.has(s)) return null;          // no deal
  if (STATUS_LOST.has(s)) return LOST;
  if (STATUS_QUOTED.has(s)) return QUOTED;
  return WON;                                        // everything else
}

async function buildOwnerByName() {
  const r = await C.fs('GET', '/selector/owners');
  if (!r.ok) throw new Error(`owners fetch failed: ${r.error}`);
  const byName = {};
  for (const u of r.data.users || []) {
    const nm = String(u.display_name || '').trim().toLowerCase();
    if (nm) byName[nm] = u.id;
  }
  return byName;
}
// Seller → FW user id, or null when the seller is blank / departed / a generic
// placeholder ("Default OBOPP") — i.e. anything that doesn't map to a live user.
function resolveSellerOwner(ownerByName, seller) {
  let nm = String(seller || '').trim().toLowerCase();
  nm = SELLER_ALIAS[nm] || nm;
  return ownerByName[nm] || null;
}

// Gap-filler used only when the seller doesn't resolve: the matched account's
// owner, else the most common real owner among the account's contacts. Cached
// per run. Returns a real (non-CS) owner id or null. filtered_search does not
// return owner_id, so this needs a GET.
const acctOwnerCache = new Map();
async function resolveAccountOwner(acctId) {
  if (acctOwnerCache.has(acctId)) return acctOwnerCache.get(acctId);
  let owner = null;
  const g = await C.fs('GET', `/sales_accounts/${acctId}`);
  const ao = g.ok ? g.data?.sales_account?.owner_id : null;
  if (ao && ao !== C.CS_OWNER_ID) owner = ao;
  if (!owner) {                                   // fall back to a contact on the account
    const c = await C.fs('GET', `/sales_accounts/${acctId}/contacts`);
    const counts = {};
    for (const ct of (c.ok && c.data?.contacts) || []) {
      if (ct.owner_id && ct.owner_id !== C.CS_OWNER_ID) counts[ct.owner_id] = (counts[ct.owner_id] || 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) owner = Number(best[0]);
  }
  acctOwnerCache.set(acctId, owner);
  return owner;
}

// Match a customer name to an existing FS account (first exact-ish match), cached
// per run + persisted in state. Returns account id or null. Never creates.
const acctCache = new Map();
async function resolveAccount(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (acctCache.has(key)) return acctCache.get(key);
  const r = await C.fs('POST', '/filtered_search/sales_account', {
    filter_rule: [{ attribute: 'name', operator: 'is', value: String(name).trim() }],
  });
  let id = null;
  if (r.ok) {
    const list = r.data?.sales_accounts || [];
    const hit = list.find((a) => String(a.name || '').trim().toLowerCase() === key) || list[0];
    id = hit ? hit.id : null;
  }
  acctCache.set(key, id);
  return id;
}

// Collapse osprey_mail_drops to one record per order_id (order-level fields).
async function loadOrders() {
  const byOrder = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await C.supabase
      .from('osprey_mail_drops')
      .select('order_id,order_status,order_amount,customer_id,customer_name,seller,web_id,product_category,drop_est_date')
      .range(from, from + 999);
    if (error) throw new Error(`osprey_mail_drops read failed: ${error.message}`);
    if (!data.length) break;
    for (const r of data) {
      if (!r.order_id) continue;
      const cur = byOrder.get(r.order_id);
      if (!cur) {
        byOrder.set(r.order_id, {
          order_id: r.order_id, order_status: r.order_status, order_amount: r.order_amount,
          customer_id: r.customer_id, customer_name: r.customer_name, seller: r.seller,
          web_id: r.web_id, product_category: r.product_category, drop_est_date: r.drop_est_date,
        });
      } else if (r.drop_est_date && (!cur.drop_est_date || r.drop_est_date < cur.drop_est_date)) {
        cur.drop_est_date = r.drop_est_date; // keep earliest drop date
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return [...byOrder.values()];
}

function toInt(v) { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; }

// name → account id, matching an existing account or CREATING one if none.
// Tracks creates via stats. Cached per run (extends the resolveAccount cache).
async function ensureAccount(o, stats) {
  const key = String(o.customer_name || '').trim().toLowerCase();
  if (acctCache.has(key)) return acctCache.get(key);
  let id = await E.findAccount(o.customer_name);       // exact + normalized match
  if (!id) { id = await E.createAccount(o); if (id) stats.accountsCreated++; }
  acctCache.set(key, id);
  return id;
}

function buildDealFields(o, acctId, ownerId, contactId) {
  const name = `${o.customer_name || 'Unknown'} – ${o.product_category || 'Order'} (#${o.order_id})`.slice(0, 255);
  const deal = {
    name,
    amount: o.order_amount != null ? Number(o.order_amount) : 0,
    deal_pipeline_id: C.DEAL_PIPELINE_ID,
    deal_stage_id: stageForStatus(o.order_status),
    owner_id: ownerId,
    custom_field: {
      cf_order_number: toInt(o.order_id),
      cf_webid: toInt(o.web_id),
      cf_sf_oppty_id: `${o.customer_id || 'NA'}-${o.order_id}`,
    },
  };
  if (acctId) deal.sales_account_id = acctId;
  if (contactId) deal.contacts_added_list = [contactId];
  if (o.drop_est_date) deal.expected_close = o.drop_est_date;
  return deal;
}

// Promote every contact on an account to Customer (never downgrades). Returns count set.
async function promoteAccountCustomers(acctId) {
  let set = 0;
  for (const ct of await E.accountContacts(acctId)) {
    if ((await E.promoteToCustomer(ct.id, ct.lifecycle_stage_id)) === 'set') set++;
  }
  return set;
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
  const dryRun = process.argv.includes('--dry-run');

  const ownerByName = await buildOwnerByName();
  const orders = await loadOrders();
  console.log(`orders in current Osprey data: ${orders.length}`);

  // load state
  const state = new Map();
  { let from = 0; for (;;) {
      const { data } = await C.supabase.from('osprey_deal_sync').select('*').range(from, from + 999);
      if (!data || !data.length) break;
      for (const r of data) state.set(r.order_id, r);
      if (data.length < 1000) break; from += 1000;
  } }

  const stats = { created: 0, updated: 0, unchanged: 0, excluded: 0, failed: 0, ownerFromAccount: 0, ownerCsDefault: 0, accountsCreated: 0, contactsLinked: 0, contactGaps: 0, customersPromoted: 0, unknownStatus: {} };
  const started = Date.now();
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || (process.env.CI ? 330 * 60 * 1000 : 0));
  for (const o of orders) {
    if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) { console.log('Runtime budget reached — exiting (resumable via state).'); break; }
    const stage = stageForStatus(o.order_status);
    if (stage === null) { stats.excluded++; continue; }               // INCOMPLETE — skip
    const known = STATUS_QUOTED.has(String(o.order_status).toUpperCase()) ||
                  STATUS_LOST.has(String(o.order_status).toUpperCase()) ||
                  String(o.order_status).toUpperCase() === 'COMPLETE';
    if (!known) stats.unknownStatus[o.order_status] = (stats.unknownStatus[o.order_status] || 0) + 1;

    const prev = state.get(o.order_id);
    const amount = o.order_amount != null ? Number(o.order_amount) : 0;

    if (!prev) {
      // NEW order -> ensure account (create if missing), attach the account's
      // existing contact (else log the gap), then create the deal. Owner: seller
      // mapping first; if unresolved, fill from the account/contacts; else CS.
      const acctId = await ensureAccount(o, stats);
      let ownerId = resolveSellerOwner(ownerByName, o.seller), ownerSrc = 'seller';
      if (!ownerId && acctId) { ownerId = await resolveAccountOwner(acctId); if (ownerId) ownerSrc = 'account'; }
      if (!ownerId) { ownerId = C.CS_OWNER_ID; ownerSrc = 'cs-default'; }
      if (ownerSrc === 'account') stats.ownerFromAccount++;
      else if (ownerSrc === 'cs-default') stats.ownerCsDefault++;

      const contacts = acctId ? await E.accountContacts(acctId) : [];
      const contactId = contacts[0]?.id || null;    // link the account's primary contact
      const deal = buildDealFields(o, acctId, ownerId, contactId);
      if (dryRun) { stats.created++; if (stats.created <= 5) console.log('CREATE', ownerSrc, JSON.stringify(deal)); continue; }
      const res = await C.fs('POST', '/deals', { deal });
      if (res.ok && res.data?.deal?.id) {
        await C.supabase.from('osprey_deal_sync').insert({
          order_id: o.order_id, fw_deal_id: String(res.data.deal.id), customer_id: o.customer_id,
          customer_name: o.customer_name, last_status: o.order_status, last_stage_id: stage,
          last_amount: amount, fw_account_id: acctId ? String(acctId) : null, excluded: false,
        });
        stats.created++;
        if (contactId) stats.contactsLinked++;
        else if (acctId) { stats.contactGaps++; await E.logContactGap(o, acctId); }
        // Won order -> promote the account's contacts to Customer.
        if (stage === WON && acctId) {
          for (const ct of contacts) if ((await E.promoteToCustomer(ct.id, ct.lifecycle_stage_id)) === 'set') stats.customersPromoted++;
        }
      } else { stats.failed++; console.error(`create failed order ${o.order_id}: ${res.status} ${res.error}`); }
    } else {
      // EXISTING -> update stage/amount only if changed; on a transition INTO Won,
      // promote the account's contacts to Customer.
      const stageChanged = String(prev.last_stage_id) !== String(stage);
      const amtChanged = Number(prev.last_amount) !== amount;
      if (!stageChanged && !amtChanged) { stats.unchanged++; continue; }
      if (dryRun) { stats.updated++; continue; }
      const res = await C.fs('PUT', `/deals/${prev.fw_deal_id}`, { deal: { deal_stage_id: stage, amount } });
      if (res.ok) {
        await C.supabase.from('osprey_deal_sync').update({
          last_status: o.order_status, last_stage_id: stage, last_amount: amount, updated_at: new Date().toISOString(),
        }).eq('order_id', o.order_id);
        stats.updated++;
        if (stageChanged && stage === WON && prev.fw_account_id) stats.customersPromoted += await promoteAccountCustomers(prev.fw_account_id);
      } else { stats.failed++; console.error(`update failed order ${o.order_id}: ${res.status} ${res.error}`); }
    }
    if (limit && (stats.created + stats.updated) >= limit) { console.log(`--limit ${limit} reached`); break; }
  }

  console.log(`\n${dryRun ? 'DRY RUN ' : ''}done:`, JSON.stringify({ ...stats, unknownStatus: undefined }));
  console.log(`owner source on creates — from account/contacts: ${stats.ownerFromAccount}, CS default (no seller/account owner): ${stats.ownerCsDefault}`);
  console.log(`enrichment — accounts created: ${stats.accountsCreated}, contacts linked: ${stats.contactsLinked}, contact gaps (logged): ${stats.contactGaps}, contacts promoted to Customer: ${stats.customersPromoted}`);
  const uk = Object.keys(stats.unknownStatus);
  if (uk.length) console.log('statuses treated as WON by default (review if any should be Quoted/Lost):', stats.unknownStatus);
}

main().catch((e) => { console.error('OSPREY SYNC FAILED:', e.message); process.exit(1); });
