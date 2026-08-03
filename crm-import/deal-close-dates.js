/**
 * Fix deal close dates to reflect SFDC. Every imported Won/Lost deal got
 * closed_date auto-stamped with the July 2026 import date; the true date lives
 * in the staged SFDC rows. Rule (user): closed date = SFDC Close Date; if none
 * and the deal was created > 3 months ago, closed date = SFDC Created Date +
 * 30 days. Won/Lost → closed_date; open (Quoted) → expected_close only.
 *
 *   node crm-import/deal-close-dates.js load           # stage targets (no FS calls)
 *   node crm-import/deal-close-dates.js drain [--limit N]
 */
const C = require('./common');

const MARKER = 'deal-close-dates-2026-07';
const THREE_MONTHS_AGO = '2026-04-30';

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .eq('import_type', 'opportunities').in('status', statuses).order('uploaded_at', { ascending: false }).limit(30);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function load() {
  if (await findImport(['pushing'])) { console.log('Already staged.'); return; }
  const { data: imps } = await C.supabase.from('crm_imports').select('id, total_rows')
    .eq('import_type', 'opportunities').eq('status', 'complete');
  const orig = (imps || []).find((i) => i.total_rows > 10000);
  if (!orig) throw new Error('original opportunities import not found');

  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'opportunities', original_filename: 'Deal close-date fix (SFDC Close Date, else created+30d if >3mo old)',
    total_rows: 0, sheet_name: 'close-dates', status: 'pushing', uploaded_by: 'script:deal-close-dates',
    mapping_json: { __marker: MARKER },
  }).select('id').single();

  let staged = 0, fromSfdc = 0, fromRule = 0, skippedNoDate = 0, batch = [];
  const flush = async () => { if (!batch.length) return; const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0)); if (error) throw new Error(error.message); };
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('raw_json, fs_id').eq('import_id', orig.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      if (!r.fs_id) continue;
      const close = C.parseUSDate(r.raw_json['Close Date']);
      const created = C.parseUSDate(r.raw_json['Created Date']);
      let target = close, src = 'sfdc-close-date';
      if (!target) {
        if (created && created < THREE_MONTHS_AGO) { target = addDays(created, 30); src = 'created+30d'; }
        else { skippedNoDate++; continue; }
      }
      src === 'sfdc-close-date' ? fromSfdc++ : fromRule++;
      const stage = C.STAGE_COLLAPSE[String(r.raw_json['Stage'] || '').trim()];
      const closedStage = stage === 'Won' || stage === 'Lost';
      batch.push({ import_id: imp.id, row_index: ++staged, fs_id: String(r.fs_id), status: 'pending',
        raw_json: { date: target, src, closedStage } });
      if (batch.length >= 500) await flush();
    }
    if (data.length < 1000) break;
  }
  await flush();
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged} deals: ${fromSfdc} from SFDC Close Date, ${fromRule} via created+30d rule, ${skippedNoDate} skipped (no date, not >3mo). IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('Nothing staged.'); return; }
  const limit = argLimit();
  console.log(`Draining close-date fix ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  let done = 0, ok = 0, failed = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, fs_id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(200);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const { date, closedStage } = row.raw_json;
      const deal = closedStage ? { closed_date: date, expected_close: date } : { expected_close: date };
      const r = await C.fs('PUT', `/deals/${row.fs_id}`, { deal });
      const now = new Date().toISOString();
      if (r.ok) { await C.supabase.from('crm_import_rows').update({ status: 'sent', attempted_at: now }).eq('id', row.id); ok++; }
      else { await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `PUT ${r.status}`, attempted_at: now }).eq('id', row.id); failed++; }
      done++;
      if (done % 200 === 0) console.log(`  ${done} — ok:${ok} failed:${failed}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('Complete.'); }
  console.log(`\nClose-date fix: ${ok} updated, ${failed} failed. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/deal-close-dates.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`CLOSE-DATES ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
