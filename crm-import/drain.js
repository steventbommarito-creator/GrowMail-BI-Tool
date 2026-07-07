/**
 * Drainer: push pending crm_import_rows to Freshsales via POST /deals, updating
 * each row's status live so the /crm/imports dashboard reflects progress.
 * Resumable and Ctrl-C-safe — only 'pending' rows are ever sent.
 *
 *   node crm-import/drain.js [importId] [--limit N]
 *
 * If importId is omitted, uses the most recent non-complete 'opportunities'
 * import created by the loader. Paced under the FS 2000/hr cap (see common.js).
 */
const C = require('./common');

async function pickImportId() {
  const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (explicit) return explicit;
  const { data } = await C.supabase
    .from('crm_imports')
    .select('id, status, mapping_json')
    .eq('import_type', 'opportunities')
    .eq('status', 'pushing')   // only drain once prepare has filled normalized_json
    .order('uploaded_at', { ascending: false })
    .limit(20);
  const hit = (data || []).find((i) => i.mapping_json?.__marker === 'sfdc-opps-2022-script');
  return hit?.id || null;
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
  const importId = await pickImportId();
  if (!importId) { console.error('No open opportunities import found. Run load.js first.'); process.exit(1); }
  console.log(`Draining import ${importId}${limit ? ` (limit ${limit})` : ''}…`);

  const { data: batch } = await C.supabase
    .from('crm_import_batches')
    .insert({ import_id: importId, requested_size: limit || 0, status: 'running', triggered_by: 'script:drain' })
    .select('id').single();
  const batchId = batch?.id;

  let sent = 0, failed = 0;
  const started = Date.now();
  const PAGE = 200;
  // Stop cleanly before a GitHub Actions run hits limits / the next cron fires.
  // 0 = no budget (local unattended run). Default 50 min in CI.
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || (process.env.CI ? 50 * 60 * 1000 : 0));
  const outOfTime = () => MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS;

  for (;;) {
    if (outOfTime()) { console.log('Runtime budget reached — exiting cleanly (resumable).'); break; }
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows')
      .select('id, row_index, raw_json, normalized_json')
      .eq('import_id', importId)
      .eq('status', 'pending')
      .not('normalized_json', 'is', null)   // only rows prepare has built
      .order('row_index', { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`fetch pending failed: ${error.message}`);
    if (!rows || !rows.length) break;

    for (const row of rows) {
      const deal = row.normalized_json;
      if (!deal) {
        await C.supabase.from('crm_import_rows').update({
          status: 'validation_failed', error_message: 'no normalized payload',
          attempted_at: new Date().toISOString(), batch_id: batchId,
        }).eq('id', row.id);
        failed++; continue;
      }
      const res = await C.fs('POST', '/deals', { deal });
      const now = new Date().toISOString();
      if (res.ok && res.data?.deal?.id) {
        await C.supabase.from('crm_import_rows').update({
          status: 'sent', fs_id: String(res.data.deal.id), error_message: null,
          attempted_at: now, batch_id: batchId,
        }).eq('id', row.id);
        sent++;
      } else {
        await C.supabase.from('crm_import_rows').update({
          status: 'failed', error_message: `HTTP ${res.status}: ${(res.error || '').slice(0, 250)}`,
          attempted_at: now, batch_id: batchId,
        }).eq('id', row.id);
        // bump attempt_count separately (can't ++ in one call without rpc)
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

  await C.supabase.from('crm_import_batches').update({
    status: 'complete', actual_size: sent + failed,
    stats_json: { sent, failed, skipped: 0 }, completed_at: new Date().toISOString(),
  }).eq('id', batchId);

  const { count: pendingLeft } = await C.supabase
    .from('crm_import_rows').select('id', { count: 'exact', head: true })
    .eq('import_id', importId).eq('status', 'pending');
  if (!pendingLeft) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', importId);
    console.log('\nAll rows processed — import marked complete.');
  }
  console.log(`\nBatch done: ${sent} sent, ${failed} failed. Pending remaining: ${pendingLeft || 0}.`);
  if (pendingLeft) console.log(`Resume with: node crm-import/drain.js ${importId}`);
}

main().catch((e) => { console.error('DRAIN FAILED:', e.message); process.exit(1); });
