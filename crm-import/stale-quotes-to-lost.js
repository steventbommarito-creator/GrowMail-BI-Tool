/**
 * Sweep stale quotes to Lost. Deals still in stage 127003582554 (the old
 * Quoted stage, renamed "Incomplete") are quotes whose orders fell out of the
 * G&L report window — expired pipeline. Move them to Lost in FW and, for
 * Osprey-synced ones, set osprey_deal_sync.last_stage_id = Lost so that if the
 * order ever REAPPEARS in the report, the live sync sees stage-changed and
 * automatically revives the deal into its true stage (user-approved behavior).
 *
 * Safety: any deal whose order IS in the current snapshot is skipped (the live
 * sync owns those). Idempotent — re-runs find nothing left in the stage.
 *
 *   node crm-import/stale-quotes-to-lost.js [--dry-run]
 */
const C = require('./common');
const E = require('./sync-enrich');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // orders visible in the current snapshot (live sync owns these)
  const { data: snap } = await C.supabase.from('osprey_mail_drops')
    .select('snapshot_id').order('captured_at', { ascending: false }).limit(1);
  const inFeed = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_mail_drops').select('order_id')
      .eq('snapshot_id', snap[0].snapshot_id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) inFeed.add(String(r.order_id));
    if (data.length < 1000) break;
  }

  // candidates, source 1: osprey state rows still on the old-quoted stage
  const targets = new Map();   // deal id -> orderId|null
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_deal_sync').select('order_id, fw_deal_id, last_stage_id').range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      if (String(r.last_stage_id) !== String(E.STAGES.INCOMPLETE) || !r.fw_deal_id) continue;
      if (inFeed.has(String(r.order_id))) continue;   // live sync will handle it
      targets.set(String(r.fw_deal_id), String(r.order_id));
    }
    if (data.length < 1000) break;
  }
  // candidates, source 2: SFDC-imported deals staged into the old Quoted stage
  const { data: imps } = await C.supabase.from('crm_imports').select('id, total_rows, original_filename')
    .eq('import_type', 'opportunities').eq('status', 'complete');
  const orig = (imps || []).find((i) => /^SFDC Opportunities 2022\+/.test(i.original_filename || ''));
  if (orig) for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('raw_json, fs_id').eq('import_id', orig.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      if (!r.fs_id || targets.has(String(r.fs_id))) continue;
      if (C.STAGE_COLLAPSE[String(r.raw_json['Stage'] || '').trim()] === 'Quoted') targets.set(String(r.fs_id), null);
    }
    if (data.length < 1000) break;
  }
  console.log(`candidates: ${targets.size}${dryRun ? ' (DRY RUN)' : ''}`);

  let moved = 0, notInStage = 0, gone = 0, failed = 0, done = 0;
  for (const [dealId, orderId] of targets) {
    const g = await C.fs('GET', `/deals/${dealId}`);
    if (!g.ok) { gone++; done++; continue; }
    if (String(g.data?.deal?.deal_stage_id) !== String(E.STAGES.INCOMPLETE)) { notInStage++; done++; continue; }
    if (dryRun) { moved++; done++; continue; }
    const p = await C.fs('PUT', `/deals/${dealId}`, { deal: { deal_stage_id: E.STAGES.LOST } });
    if (p.ok) {
      moved++;
      if (orderId) await C.supabase.from('osprey_deal_sync').update({ last_stage_id: E.STAGES.LOST, updated_at: new Date().toISOString() }).eq('order_id', orderId);
    } else failed++;
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${targets.size} — moved:${moved} skipped:${notInStage} gone:${gone} failed:${failed}`);
  }
  console.log(`\nDone: ${moved} ${dryRun ? 'would move' : 'moved'} to Lost, ${notInStage} already elsewhere, ${gone} deleted, ${failed} failed.`);
}

main().catch((e) => { console.error('STALE-QUOTES FAILED:', e.message); process.exit(1); });
