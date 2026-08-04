/**
 * Priority 1.5: connect accounts to the ~28k SFDC-imported deals.
 * SFDC Opportunity.AccountId → FW account via the SFDC↔FW map built by the
 * real-account tagging scan (exact ID join, no name matching). Deals whose
 * account has no FW counterpart are logged 'skipped'.
 *
 *   node crm-import/deal-accounts.js load           # SFDC pull + join (cloud-safe)
 *   node crm-import/deal-accounts.js drain [--limit N]
 */
const C = require('./common');
const S = require('./sfdc');

const MARKER = 'deal-accounts-2026-08';
const REAL_MARKER = 'real-accounts-2026-07';

async function findImport(marker, statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .in('status', statuses).order('uploaded_at', { ascending: false }).limit(60);
  return (data || []).find((i) => i.mapping_json?.__marker === marker) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

async function load() {
  if (await findImport(MARKER, ['pushing', 'complete'])) { console.log('deal-accounts already staged or complete.'); return; }

  // SFDC↔FW account map from the real-accounts staging (sf_id 18-char → fw fs_id)
  const real = await findImport(REAL_MARKER, ['complete', 'ready', 'pushing']);
  if (!real) throw new Error('real-accounts staging not found');
  const sfToFw = new Map();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('fs_id, raw_json').eq('import_id', real.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) if (r.fs_id && r.raw_json?.sf_id) sfToFw.set(String(r.raw_json.sf_id).slice(0, 15), r.fs_id);
    if (data.length < 1000) break;
  }
  console.log(`sf→fw account map: ${sfToFw.size}`);

  console.log('Pulling Opportunity→Account from SFDC…');
  const opps = await S.queryAll('SELECT Id, AccountId FROM Opportunity WHERE AccountId != null', (m) => console.log(m));
  const oppToAcct = new Map();
  for (const o of opps) oppToAcct.set(String(o.Id).slice(0, 15), String(o.AccountId).slice(0, 15));
  console.log(`opp→account pairs: ${oppToAcct.size}`);

  // the ORIGINAL 28k import specifically — several other staging imports are
  // also type=opportunities/complete/28k rows (close-dates bit us here once)
  const { data: imps } = await C.supabase.from('crm_imports').select('id, total_rows, original_filename')
    .eq('import_type', 'opportunities').eq('status', 'complete');
  const orig = (imps || []).find((i) => /^SFDC Opportunities 2022\+/.test(i.original_filename || ''));
  if (!orig) throw new Error('original SFDC opportunities import not found by filename');
  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'opportunities', original_filename: 'Deal→account linking (SFDC AccountId join)',
    total_rows: 0, sheet_name: 'deal-accounts', status: 'pushing', uploaded_by: 'script:deal-accounts',
    mapping_json: { __marker: MARKER },
  }).select('id').single();

  let staged = 0, linkable = 0, noAcctInFw = 0, noOppMatch = 0, batch = [];
  const flush = async () => { if (!batch.length) return; const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0)); if (error) throw new Error(error.message); };
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('raw_json, fs_id').eq('import_id', orig.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      if (!r.fs_id) continue;
      const opp15 = String(r.raw_json['Opportunity ID'] || '').slice(0, 15);
      const sfAcct = oppToAcct.get(opp15);
      const fwAcct = sfAcct ? sfToFw.get(sfAcct) : null;
      let status = 'pending', err = null;
      if (!sfAcct) { status = 'skipped'; err = 'opp not found in SFDC'; noOppMatch++; }
      else if (!fwAcct) { status = 'skipped'; err = 'SFDC account has no FW match'; noAcctInFw++; }
      else linkable++;
      batch.push({ import_id: imp.id, row_index: ++staged, fs_id: String(r.fs_id), status, error_message: err,
        raw_json: { fw_account_id: fwAcct || null, sf_account: sfAcct || null } });
      if (batch.length >= 500) await flush();
    }
    if (data.length < 1000) break;
  }
  await flush();
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged}: ${linkable} linkable, ${noAcctInFw} account-not-in-FW, ${noOppMatch} opp-not-found. IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(MARKER, ['pushing']);
  if (!imp) { console.log('deal-accounts: nothing staged.'); return; }
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  let done = 0, ok = 0, failed = 0;
  const writes = [];   // bookkeeping writes run async so they don't pace the FS calls
  const flushWrites = async () => { await Promise.all(writes.splice(0)); };
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, fs_id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(300);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = await C.fs('PUT', `/deals/${row.fs_id}`, { deal: { sales_account_id: row.raw_json.fw_account_id } });
      const now = new Date().toISOString();
      if (r.ok) { writes.push(C.supabase.from('crm_import_rows').update({ status: 'sent', attempted_at: now }).eq('id', row.id)); ok++; }
      else { writes.push(C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `PUT ${r.status}`, attempted_at: now }).eq('id', row.id)); failed++; }
      done++;
      if (writes.length >= 50) await flushWrites();
      if (done % 500 === 0) console.log(`  ${done} — ok:${ok} failed:${failed}`);
      if (limit && done >= limit) break;
    }
    await flushWrites();
    if (limit && done >= limit) break;
  }
  await flushWrites();
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('deal-accounts complete.'); }
  console.log(`deal-accounts: ${ok} linked, ${failed} failed. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/deal-accounts.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`DEAL-ACCOUNTS ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
