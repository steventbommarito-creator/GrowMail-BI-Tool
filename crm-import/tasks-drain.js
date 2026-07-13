/**
 * Drain step (cloud, hourly): push prepared activity rows to Freshsales via
 * POST /tasks, updating row status live so the /crm/imports dashboard tracks it.
 * Resumable; only 'pending' rows with a normalized payload are sent.
 *
 *   node crm-import/tasks-drain.js [importId] [--limit N]
 */
const C = require('./common');

async function pickImportId() {
  const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (explicit) return explicit;
  const { data } = await C.supabase
    .from('crm_imports').select('id, status, mapping_json')
    .eq('import_type', 'tasks').eq('status', 'pushing')
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === 'sfdc-tasks-script')?.id || null;
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
  const importId = await pickImportId();
  if (!importId) { console.log('No tasks import in status=pushing — nothing to drain.'); return; }
  console.log(`Draining tasks import ${importId}${limit ? ` (limit ${limit})` : ''}…`);

  const { data: batch } = await C.supabase
    .from('crm_import_batches').insert({ import_id: importId, requested_size: limit || 0, status: 'running', triggered_by: 'script:tasks-drain' })
    .select('id').single();
  const batchId = batch?.id;

  let sent = 0, failed = 0;
  const started = Date.now();
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || (process.env.CI ? 50 * 60 * 1000 : 0));
  const outOfTime = () => MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS;
  const PAGE = 200;

  for (;;) {
    if (outOfTime()) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, normalized_json')
      .eq('import_id', importId).eq('status', 'pending').not('normalized_json', 'is', null)
      .order('row_index', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`fetch pending failed: ${error.message}`);
    if (!rows || !rows.length) break;

    for (const row of rows) {
      const body = row.normalized_json; // { task: {...} }
      const res = await C.fs('POST', '/tasks', body);
      const now = new Date().toISOString();
      if (res.ok && res.data?.task?.id) {
        await C.supabase.from('crm_import_rows').update({ status: 'sent', fs_id: String(res.data.task.id), error_message: null, attempted_at: now, batch_id: batchId }).eq('id', row.id);
        sent++;
      } else {
        await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `HTTP ${res.status}: ${(res.error || '').slice(0, 250)}`, attempted_at: now, batch_id: batchId }).eq('id', row.id);
        failed++;
      }
      if ((sent + failed) % 100 === 0) {
        const rate = sent / Math.max((Date.now() - started) / 3600000, 1e-9);
        console.log(`  ${sent} sent, ${failed} failed (~${Math.round(rate)}/hr)`);
      }
      if (limit && sent >= limit) break;
      if (outOfTime()) break;
    }
    if (limit && sent >= limit) break;
  }

  await C.supabase.from('crm_import_batches').update({ status: 'complete', actual_size: sent + failed, stats_json: { sent, failed, skipped: 0 }, completed_at: new Date().toISOString() }).eq('id', batchId);
  const { count: pendingLeft } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', importId).eq('status', 'pending');
  if (!pendingLeft) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', importId);
    console.log('\nAll tasks processed — import marked complete.');
  }
  console.log(`\nBatch done: ${sent} sent, ${failed} failed. Pending remaining: ${pendingLeft || 0}.`);
}

main().catch((e) => { console.error('TASKS DRAIN FAILED:', e.message); process.exit(1); });
