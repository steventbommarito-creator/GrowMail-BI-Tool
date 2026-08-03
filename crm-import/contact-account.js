/**
 * Priority 2: contact↔account matching from SFDC's ~88k contacts.
 *
 *   node crm-import/contact-account.js load           # SFDC contact pull → stage (cloud-safe)
 *   node crm-import/contact-account.js drain [--limit N]
 *
 * Drain, per staged SFDC contact:
 *   - resolve its FW account: SFDC AccountId → FW id via the real-accounts map;
 *     if the SFDC account is real-but-missing in FW (the ~927), CREATE it
 *     (tagged 'Real Account') and record it back into the real-accounts staging.
 *     Contacts whose account isn't in the real universe are skipped (logged) —
 *     we don't attach people to pre-2018 non-real accounts or lead-shells.
 *   - find the FW contact by email (exact lookup): exists → associate to the
 *     account (is_primary); missing → CREATE contact (name/email/phone/title,
 *     owner via alias map, linked to the account).
 *   - no email → skipped + logged (user policy).
 * Idempotent: re-running re-associates harmlessly; lookups dedupe creates.
 */
const C = require('./common');
const S = require('./sfdc');
const E = require('./sync-enrich');
const L = require('./sfdc-leads');

const MARKER = 'contact-account-2026-08';
const REAL_MARKER = 'real-accounts-2026-07';

async function findImport(marker, statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .in('status', statuses).order('uploaded_at', { ascending: false }).limit(80);
  return (data || []).find((i) => i.mapping_json?.__marker === marker) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

async function load() {
  if (await findImport(MARKER, ['pushing'])) { console.log('contact-account already staged.'); return; }
  console.log('Pulling contacts from SFDC…');
  const rows = await S.queryAll(
    'SELECT Id, FirstName, LastName, Email, Phone, Title, AccountId, Account.Name, Owner.Name FROM Contact WHERE AccountId != null',
    (m) => console.log(m));
  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: 'Contact↔account repair (SFDC 88k)',
    total_rows: 0, sheet_name: 'contact-account', status: 'pushing', uploaded_by: 'script:contact-account',
    mapping_json: { __marker: MARKER },
  }).select('id').single();
  let staged = 0, noEmail = 0, batch = [];
  const flush = async () => { if (!batch.length) return; const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0)); if (error) throw new Error(error.message); };
  for (const r of rows) {
    const email = String(r.Email || '').trim().toLowerCase();
    const ok = /^\S+@\S+\.\S+$/.test(email);
    if (!ok) noEmail++;
    batch.push({
      import_id: imp.id, row_index: ++staged, status: ok ? 'pending' : 'skipped',
      error_message: ok ? null : 'no email (logged per policy)',
      raw_json: {
        sf_id: r.Id, email, first: r.FirstName || '', last: r.LastName || '', phone: r.Phone || '',
        title: r.Title || '', sf_account: String(r.AccountId || '').slice(0, 15),
        account_name: r.Account?.Name || '', owner: r.Owner?.Name || '',
      },
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged} SFDC contacts (${noEmail} no-email skipped). IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(MARKER, ['pushing']);
  if (!imp) { console.log('contact-account: nothing staged.'); return; }
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);

  // sf account (15-char) → { fw, name } from the real-accounts staging; rows
  // without fs_id are the real-but-missing-in-FW set (create on demand).
  const real = await findImport(REAL_MARKER, ['complete', 'ready', 'pushing']);
  if (!real) throw new Error('real-accounts staging not found');
  const acctMap = new Map(); const missingRow = new Map();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('id, fs_id, raw_json').eq('import_id', real.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      const sf = r.raw_json?.sf_id ? String(r.raw_json.sf_id).slice(0, 15) : null;
      if (!sf) continue;
      if (r.fs_id) acctMap.set(sf, Number(r.fs_id));
      else missingRow.set(sf, { rowId: r.id, name: r.raw_json.sf_name });
    }
    if (data.length < 1000) break;
  }
  console.log(`account map: ${acctMap.size} mapped, ${missingRow.size} creatable-on-demand`);
  const ownerByName = await L.buildOwnerByName();

  const stats = { associated: 0, contactCreated: 0, accountCreated: 0, notReal: 0, failed: 0 };
  let done = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(300);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const j = row.raw_json;
      const now = new Date().toISOString();
      const mark = (status, msg, fsId) => C.supabase.from('crm_import_rows').update({ status, error_message: msg || null, fs_id: fsId ? String(fsId) : null, attempted_at: now }).eq('id', row.id);

      let fwAcct = acctMap.get(j.sf_account) || null;
      if (!fwAcct && missingRow.has(j.sf_account)) {         // real account missing in FW → create
        const m = missingRow.get(j.sf_account);
        const cr = await C.fs('POST', '/sales_accounts', { sales_account: { name: String(m.name || j.account_name).slice(0, 255), tags: ['Real Account'], custom_field: { cf_sf_acct_id: j.sf_account } } });
        if (cr.ok && cr.data?.sales_account?.id) {
          fwAcct = cr.data.sales_account.id; stats.accountCreated++;
          acctMap.set(j.sf_account, fwAcct); missingRow.delete(j.sf_account);
          await C.supabase.from('crm_import_rows').update({ fs_id: String(fwAcct), status: 'sent', error_message: 'created by contact-account repair' }).eq('id', m.rowId);
        }
      }
      if (!fwAcct) { await mark('skipped', 'account not in real universe'); stats.notReal++; done++; continue; }

      const lk = await C.fs('GET', `/lookup?q=${encodeURIComponent(j.email)}&f=email&entities=contact`);
      const existing = (lk.data?.contacts?.contacts || [])[0];
      if (existing) {
        const r = await C.fs('PUT', `/contacts/${existing.id}`, { contact: { sales_accounts: [{ id: fwAcct, is_primary: true }] } });
        if (r.ok) { stats.associated++; await mark('sent', 'associated', existing.id); }
        else { stats.failed++; await mark('failed', `assoc PUT ${r.status}`); }
      } else {
        const contact = {
          first_name: String(j.first || '').slice(0, 100) || 'Unknown', last_name: String(j.last || '').slice(0, 100),
          emails: [{ value: j.email, is_primary: true }],
          owner_id: ownerByName[String(j.owner || '').trim().toLowerCase()] || C.CS_OWNER_ID,
          sales_accounts: [{ id: fwAcct, is_primary: true }],
          custom_field: { cf_lead_sf_id: L.genSfid() },
        };
        if (j.phone) contact.work_number = String(j.phone).slice(0, 30);
        if (j.title) contact.job_title = String(j.title).slice(0, 100);
        const r = await C.fs('POST', '/contacts', { contact });
        if (r.ok && r.data?.contact?.id) { stats.contactCreated++; await mark('sent', 'created', r.data.contact.id); }
        else { stats.failed++; await mark('failed', `create ${r.status}: ${String(r.error || '').slice(0, 120)}`); }
      }
      done++;
      if (done % 500 === 0) console.log(`  ${done} — ${JSON.stringify(stats)}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('contact-account complete.'); }
  console.log(`contact-account: ${JSON.stringify(stats)}. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/contact-account.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`CONTACT-ACCOUNT ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
