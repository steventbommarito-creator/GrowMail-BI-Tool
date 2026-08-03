/**
 * Priority 3: give contactless Osprey deals a contact, scraped from the Osprey
 * customer record (api.onebrand.io/api/v1/customers/{customer_id} — first/last
 * name, customer_email, customer_phone, default billing address).
 *
 *   node crm-import/osprey-contact-fill.js load             # stage one row per Osprey deal
 *   node crm-import/osprey-contact-fill.js drain [--limit N]
 *
 * Drain, per deal: skip if it already has a contact; otherwise fetch the Osprey
 * customer → find FW contact by email (create if missing, with name/phone/
 * address, owner from the seller alias map) → associate to the deal's account
 * (is_primary) → attach to the deal. No email → skip + gap-log (user policy).
 * Run AFTER contact-account.js so SFDC-known contacts already exist.
 */
const { chromium } = require('@playwright/test');
const C = require('./common');
const E = require('./sync-enrich');
const L = require('./sfdc-leads');

const MARKER = 'osprey-contact-fill-2026-08';

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .in('status', statuses).order('uploaded_at', { ascending: false }).limit(80);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

async function load() {
  if (await findImport(['pushing'])) { console.log('osprey-contact-fill already staged.'); return; }
  const rows = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_deal_sync')
      .select('order_id, fw_deal_id, fw_account_id, customer_id, customer_name, seller').range(f, f + 999);
    if (!data || !data.length) break;
    rows.push(...data.filter((r) => r.fw_deal_id));
    if (data.length < 1000) break;
  }
  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: 'Osprey deal contacts via customer-page scrape',
    total_rows: rows.length, sheet_name: 'osprey-contact-fill', status: 'pushing', uploaded_by: 'script:osprey-contact-fill',
    mapping_json: { __marker: MARKER },
  }).select('id').single();
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r, j) => ({ import_id: imp.id, row_index: i + j + 1, status: 'pending', raw_json: r }));
    const { error } = await C.supabase.from('crm_import_rows').insert(batch);
    if (error) throw new Error(error.message);
  }
  console.log(`Staged ${rows.length} Osprey deals. IMPORT_ID=${imp.id}`);
}

async function ospreyToken() {
  const base = process.env.OSPREY_URL || 'https://osprey.onebrand.io';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let token = null;
  page.on('request', (r) => { if (/api\.onebrand\.io/.test(r.url()) && !token && r.headers()['authorization']) token = r.headers()['authorization']; });
  try {
    await page.goto(`${base}/login`);
    await page.getByRole('textbox', { name: 'Email' }).fill(process.env.OSPREY_USER);
    await page.getByRole('textbox', { name: 'Email' }).press('Tab');
    await page.getByRole('textbox', { name: 'Password' }).fill(process.env.OSPREY_PASS);
    await page.getByRole('textbox', { name: 'Password' }).press('Enter');
    await page.waitForLoadState('networkidle');
    await page.goto(`${base}/users`);
    await page.waitForTimeout(6000);
    if (!token) throw new Error('failed to capture Osprey API token');
    return token;
  } finally { await browser.close(); }
}

async function ospreyCustomer(token, customerId) {
  const r = await fetch(`https://api.onebrand.io/api/v1/customers/${customerId}`, { headers: { authorization: token } });
  if (!r.ok) return null;
  const d = (await r.json()).data || {};
  const addr = d.defaultBillingAddress || {};
  return {
    first: d.first_name || '', last: d.last_name || '',
    email: String(d.customer_email || '').trim().toLowerCase(), phone: d.customer_phone || '',
    address: addr.address_line_1 || '', city: addr.city || '', state: addr.state_code || '', zip: addr.zip_code || '',
  };
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('osprey-contact-fill: nothing staged.'); return; }
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  const token = await ospreyToken();
  const ownerByName = await L.buildOwnerByName();

  const stats = { alreadyLinked: 0, linkedExisting: 0, created: 0, noEmail: 0, noCustomer: 0, failed: 0 };
  let done = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(200);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = row.raw_json;
      const now = new Date().toISOString();
      const mark = (status, msg, fsId) => C.supabase.from('crm_import_rows').update({ status, error_message: msg || null, fs_id: fsId ? String(fsId) : null, attempted_at: now }).eq('id', row.id);

      const g = await C.fs('GET', `/deals/${r.fw_deal_id}?include=contacts`);
      if (!g.ok) { stats.failed++; await mark('failed', `deal GET ${g.status}`); done++; continue; }
      if ((g.data?.contacts || []).length) { stats.alreadyLinked++; await mark('skipped', 'deal already has contact'); done++; continue; }

      const cust = r.customer_id ? await ospreyCustomer(token, r.customer_id) : null;
      if (!cust) { stats.noCustomer++; await mark('skipped', 'osprey customer not found'); await E.logContactGap(r, r.fw_account_id); done++; continue; }
      if (!/^\S+@\S+\.\S+$/.test(cust.email)) { stats.noEmail++; await mark('skipped', 'no email on osprey customer (logged)'); await E.logContactGap(r, r.fw_account_id); done++; continue; }

      const lk = await C.fs('GET', `/lookup?q=${encodeURIComponent(cust.email)}&f=email&entities=contact`);
      let contactId = (lk.data?.contacts?.contacts || [])[0]?.id || null;
      if (!contactId) {
        const contact = {
          first_name: String(cust.first || '').slice(0, 100) || 'Unknown', last_name: String(cust.last || '').slice(0, 100),
          emails: [{ value: cust.email, is_primary: true }],
          owner_id: ownerByName[String(r.seller || '').trim().toLowerCase()] || C.CS_OWNER_ID,
          custom_field: { cf_lead_sf_id: L.genSfid() },
        };
        if (cust.phone) contact.work_number = String(cust.phone).slice(0, 30);
        if (cust.address) { contact.address = cust.address.slice(0, 255); contact.city = cust.city; contact.state = cust.state; contact.zipcode = cust.zip; }
        if (r.fw_account_id) contact.sales_accounts = [{ id: Number(r.fw_account_id), is_primary: true }];
        const cr = await C.fs('POST', '/contacts', { contact });
        if (cr.ok && cr.data?.contact?.id) { contactId = cr.data.contact.id; stats.created++; }
        else { stats.failed++; await mark('failed', `contact create ${cr.status}`); done++; continue; }
      } else {
        if (r.fw_account_id) await C.fs('PUT', `/contacts/${contactId}`, { contact: { sales_accounts: [{ id: Number(r.fw_account_id), is_primary: true }] } });
        stats.linkedExisting++;
      }
      const pd = await C.fs('PUT', `/deals/${r.fw_deal_id}`, { deal: { contacts_added_list: [contactId] } });
      if (pd.ok) await mark('sent', stats.created && contactId ? 'linked' : 'linked', contactId);
      else { stats.failed++; await mark('failed', `deal link ${pd.status}`); }
      done++;
      if (done % 100 === 0) console.log(`  ${done} — ${JSON.stringify(stats)}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('osprey-contact-fill complete.'); }
  console.log(`osprey-contact-fill: ${JSON.stringify(stats)}. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/osprey-contact-fill.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`OSPREY-CONTACT-FILL ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
