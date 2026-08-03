/**
 * Shared account/contact/customer enrichment for the Osprey→Freshworks sync and
 * its backfills. Goal: every deal has an account + (where identifiable) a
 * contact, the contact is tied to the account, and contacts on Won-deal
 * accounts are promoted to lifecycle "Customer".
 *
 * Contact policy (per user): we LINK an account's existing contact to the deal;
 * if the account has no contact we SKIP and LOG the gap (creating brand-new
 * contacts from the Osprey users feed is a separate, deferred backfill).
 * Customer promotion NEVER downgrades — it only ever sets lifecycle=Customer.
 */
const C = require('./common');

const CUSTOMER_LIFECYCLE = 128081818857;   // "Customer"
const CUSTOMER_STATUS = 127004203351;      // "Won" (default status under Customer)
const WON_STAGE = C.STAGE_IDS.Won;

const toInt = (v) => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Find an existing account for an Osprey customer name, tolerant of Osprey's
// punctuation/spacing (e.g. "H.Brickman&Sons" ↔ "H Brickman & Sons"): exact
// filtered_search first, then a keyword /search compared on a normalized key.
// When SEVERAL accounts share the name (real account + lead-shells from the
// migration), prefer the one tagged 'Real Account' so deals never attach to a
// shell. Returns account id or null (caller creates on null).
async function findAccount(name) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const key = normName(nm);
  const cands = [];
  const f = await C.fs('POST', '/filtered_search/sales_account', { filter_rule: [{ attribute: 'name', operator: 'is', value: nm }] });
  if (f.ok) for (const a of f.data?.sales_accounts || []) if (normName(a.name) === key) cands.push(Number(a.id));
  const s = await C.fs('GET', `/search?q=${encodeURIComponent(nm.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().slice(0, 100))}&include=sales_account&per_page=10`);
  if (s.ok) for (const a of s.data || []) if (normName(a.name) === key) cands.push(Number(a.id));
  const uniq = [...new Set(cands)];
  if (uniq.length <= 1) return uniq[0] || null;
  for (const id of uniq.slice(0, 5)) {          // collision: prefer the tagged real account
    const g = await C.fs('GET', `/sales_accounts/${id}`);
    if ((g.data?.sales_account?.tags || []).includes('Real Account')) return id;
  }
  return uniq[0];
}

// Create a Sales Account from an Osprey order. Returns id or null.
// Order-backed accounts are real by definition → tagged 'Real Account' at birth.
async function createAccount(order) {
  const name = String(order.customer_name || '').trim();
  if (!name) return null;
  const payload = { sales_account: { name: name.slice(0, 255), tags: ['Real Account'], custom_field: {} } };
  if (order.web_id) payload.sales_account.custom_field.cf_webid = toInt(order.web_id);
  if (order.customer_id) payload.sales_account.custom_field.cf_sf_acct_id = String(order.customer_id);
  const r = await C.fs('POST', '/sales_accounts', payload);
  return r.ok && r.data?.sales_account?.id ? r.data.sales_account.id : null;
}

// Contacts on an account: [{id, lifecycle_stage_id}]. Empty if none.
async function accountContacts(acctId) {
  const r = await C.fs('GET', `/sales_accounts/${acctId}/contacts`);
  return (r.ok && r.data?.contacts) || [];
}

// Promote a contact to Customer unless already there (never downgrades — Customer
// is the top lifecycle, so setting it is always ≥ current). Returns 'set' | 'already' | 'failed'.
async function promoteToCustomer(contactId, currentLifecycle) {
  if (String(currentLifecycle) === String(CUSTOMER_LIFECYCLE)) return 'already';
  const r = await C.fs('PUT', `/contacts/${contactId}`, {
    contact: { lifecycle_stage_id: CUSTOMER_LIFECYCLE, contact_status_id: CUSTOMER_STATUS },
  });
  return r.ok ? 'set' : 'failed';
}

// Ensure a contact is associated with the account (idempotent-ish; FW dedupes).
async function linkContactToAccount(contactId, acctId) {
  return C.fs('PUT', `/contacts/${contactId}`, { contact: { sales_accounts: [{ id: acctId, is_primary: true }] } });
}

// Record a "no contact to link" gap into a dedicated crm_imports log the user can review.
let _gapImportId = null;
async function logContactGap(order, acctId) {
  if (_gapImportId === null) {
    const { data } = await C.supabase.from('crm_imports').select('id, mapping_json')
      .eq('import_type', 'contacts_accounts').order('uploaded_at', { ascending: false }).limit(30);
    const existing = (data || []).find((i) => i.mapping_json?.__marker === 'osprey-contact-gaps');
    if (existing) _gapImportId = existing.id;
    else {
      const { data: created } = await C.supabase.from('crm_imports').insert({
        import_type: 'contacts_accounts', original_filename: 'Osprey sync — orders with no contact to link (review)',
        total_rows: 0, sheet_name: 'contact-gaps', status: 'pushing', uploaded_by: 'script:sync-enrich',
        mapping_json: { __marker: 'osprey-contact-gaps', note: 'Order created a deal + account but the account had no contact to attach. Skipped per policy; listed for review.' },
      }).select('id').single();
      _gapImportId = created?.id || null;
    }
  }
  if (!_gapImportId) { console.log(`CONTACT-GAP order ${order.order_id} ${order.customer_name} (acct ${acctId}) — no table`); return; }
  await C.supabase.from('crm_import_rows').insert({
    import_id: _gapImportId, row_index: toInt(order.order_id) || 0,
    fs_id: acctId ? String(acctId) : null, status: 'skipped', error_message: 'no contact on account',
    raw_json: { order_id: order.order_id, customer_id: order.customer_id, customer_name: order.customer_name, seller: order.seller },
  });
}

module.exports = {
  CUSTOMER_LIFECYCLE, CUSTOMER_STATUS, WON_STAGE, normName,
  findAccount, createAccount, accountContacts, promoteToCustomer, linkContactToAccount, logContactGap,
};
