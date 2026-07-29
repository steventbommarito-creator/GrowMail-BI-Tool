/**
 * Batch 2: promote to lifecycle "Customer" the contacts of Closed/Won deals.
 * Never downgrades — only ever sets Customer, the top lifecycle.
 *
 *   node crm-import/customer-status-backfill.js load    # stage targets (Supabase only)
 *   node crm-import/customer-status-backfill.js drain [--limit N]
 *
 * NOTE: across the migration, contacts are largely NOT linked to their accounts
 * (GET /sales_accounts/{id}/contacts is empty for most), so "promote the Won
 * account's contacts" finds almost nothing. The reliable signal is the Won
 * deal's OWN contact — the SFDC Primary Contact Email. So targets are:
 *   - kind 'email' : SFDC Won opps' Primary Contact Email (the workhorse)
 *   - kind 'id'    : Osprey Won accounts by fw_account_id (catches the few that
 *                    DO have linked contacts + everything the go-forward sync links)
 * Resumable by row status; promotion is idempotent.
 */
const C = require('./common');
const E = require('./sync-enrich');

const MARKER = 'customer-status-2026-07';
const WON = C.STAGE_IDS.Won;
const collapseWon = (s) => C.STAGE_COLLAPSE[String(s || '').trim()] === 'Won';

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'contacts_accounts').in('status', statuses).order('uploaded_at', { ascending: false }).limit(30);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

async function load() {
  if (await findImport(['pushing', 'mapping'])) { console.log('Customer-status targets already staged.'); return; }
  // Osprey Won accounts (resolved ids in state)
  const acctIds = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_deal_sync').select('last_stage_id, fw_account_id').range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) if (String(r.last_stage_id) === String(WON) && r.fw_account_id) acctIds.add(String(r.fw_account_id));
    if (data.length < 1000) break;
  }
  // SFDC Won opps' Primary Contact Email (the reliable Won-deal contact signal)
  const { data: imps } = await C.supabase.from('crm_imports').select('id, total_rows').eq('import_type', 'opportunities');
  const sfdc = (imps || []).find((i) => i.total_rows > 10000);
  const emails = new Set();
  const EMAIL_RE = /^\S+@\S+\.\S+$/;
  if (sfdc) for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('raw_json').eq('import_id', sfdc.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) { if (collapseWon(r.raw_json['Stage'])) { const e = String(r.raw_json['Primary Contact Email'] || '').trim().toLowerCase(); if (EMAIL_RE.test(e)) emails.add(e); } }
    if (data.length < 1000) break;
  }

  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: 'Batch 2: Won-deal contacts → Customer status',
    total_rows: acctIds.size + emails.size, sheet_name: 'customer-status', status: 'pushing', uploaded_by: 'script:customer-status',
    mapping_json: { __marker: MARKER, note: 'Promote Won-deal contacts to lifecycle Customer (never downgrade). Email-based + Osprey Won accounts.' },
  }).select('id').single();

  const rows = [...[...acctIds].map((id) => ({ kind: 'id', v: id })), ...[...emails].map((e) => ({ kind: 'email', v: e }))];
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r, j) => ({
      import_id: imp.id, row_index: i + j + 1, status: 'pending',
      fs_id: r.kind === 'id' ? r.v : null, raw_json: { kind: r.kind, value: r.v },
    }));
    await C.supabase.from('crm_import_rows').insert(batch);
  }
  console.log(`Staged ${rows.length} targets (${acctIds.size} Osprey accounts by id, ${emails.size} SFDC Won contact emails). IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('No customer-status targets — run load first.'); return; }
  const limit = argLimit();
  console.log(`Draining customer-status ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  let done = 0, promoted = 0, already = 0, notFound = 0, failed = 0;
  const seenContact = new Set();

  const mark = (id, status, msg) => C.supabase.from('crm_import_rows').update({ status, error_message: msg, attempted_at: new Date().toISOString() }).eq('id', id);
  const promote = async (contactId, lifecycle) => {
    if (seenContact.has(String(contactId))) return 'dup';
    seenContact.add(String(contactId));
    const r = await E.promoteToCustomer(contactId, lifecycle);
    if (r === 'set') promoted++; else if (r === 'already') already++; else failed++;
    return r;
  };

  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(100);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const { kind, value } = row.raw_json;
      if (kind === 'email') {
        const lk = await C.fs('GET', `/lookup?q=${encodeURIComponent(value)}&f=email&entities=contact`);
        const c = (lk.data?.contacts?.contacts || [])[0];
        if (!c) { await mark(row.id, 'skipped', 'contact not found'); notFound++; done++; continue; }
        const r = await promote(c.id, c.lifecycle_stage_id);
        await mark(row.id, r === 'failed' ? 'failed' : 'sent', `contact ${c.id}: ${r}`);
      } else { // kind 'id' — account's linked contacts (few, but covers linked ones)
        let setHere = 0, ok = true;
        for (const ct of await E.accountContacts(Number(value))) {
          const r = await promote(ct.id, ct.lifecycle_stage_id);
          if (r === 'set') setHere++; else if (r === 'failed') ok = false;
        }
        await mark(row.id, ok ? 'sent' : 'failed', `account ${value}: promoted ${setHere}`);
      }
      done++;
      if (done % 100 === 0) console.log(`  ${done} targets — promoted:${promoted} already:${already} notFound:${notFound} failed:${failed}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('Complete.'); }
  console.log(`\nDone: ${done} targets processed, ${promoted} contacts promoted to Customer, ${already} already, ${notFound} not-found, ${failed} failed. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/customer-status-backfill.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`CUSTOMER-STATUS ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
