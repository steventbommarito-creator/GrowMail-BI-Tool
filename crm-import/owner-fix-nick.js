/**
 * Backfill: reassign SFDC-import deals that fell to Customer Service to their
 * real owner, Nicholas Krutko. Cause: the opportunities export put the login
 * handle "NickK@growmail.com" in the Opportunity Owner column (Owner Email
 * blank), which the email-based owner resolver could not match to
 * nicholask@growmail.com → CS. ~3,789 such deals; ~95% are on CS.
 *
 *   node crm-import/owner-fix-nick.js load          # stage the affected deal ids
 *   node crm-import/owner-fix-nick.js drain [--limit N]
 *
 * Drain is idempotent and SAFE: each deal is GET first and reassigned ONLY if
 * it is currently owned by Customer Service — deals already on Nick (or
 * manually moved to someone else) are left untouched and marked 'skipped'.
 */
const C = require('./common');

const NICK_ID = 127000558299;          // Nicholas Krutko (nicholask@growmail.com)
const CS_ID = C.CS_OWNER_ID;           // 127000558289
const MARKER = 'owner-fix-nick-2026-07';
const OPP_OWNER_MATCH = 'nickk@growmail.com';

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'opportunities').in('status', statuses).order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

async function load() {
  if (await findImport(['pushing', 'mapping'])) { console.log('Nick owner-fix already staged.'); return; }
  // source: the original 28k opportunities import
  const { data: imps } = await C.supabase.from('crm_imports').select('id, total_rows')
    .eq('import_type', 'opportunities').eq('status', 'complete');
  const orig = (imps || []).find((i) => i.total_rows > 10000);
  if (!orig) throw new Error('original opportunities import not found');

  const dealIds = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('raw_json, fs_id').eq('import_id', orig.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      const oo = String(r.raw_json['Opportunity Owner'] || '').trim().toLowerCase();
      const oe = String(r.raw_json['Owner Email'] || '').trim().toLowerCase();
      if (r.fs_id && (oo === OPP_OWNER_MATCH || oe === OPP_OWNER_MATCH)) dealIds.push(String(r.fs_id));
    }
    if (data.length < 1000) break;
  }
  const unique = [...new Set(dealIds)];
  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'opportunities', original_filename: 'Owner backfill: NickK@growmail.com CS deals → Nicholas Krutko',
    total_rows: unique.length, sheet_name: 'owner-fix-nick', status: 'pushing',
    uploaded_by: 'script:owner-fix-nick', mapping_json: { __marker: MARKER, target_owner_id: NICK_ID, only_if_owner: CS_ID },
  }).select('id').single();
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500).map((id, j) => ({ import_id: imp.id, row_index: i + j + 1, fs_id: id, raw_json: {}, status: 'pending' }));
    const { error } = await C.supabase.from('crm_import_rows').insert(batch);
    if (error) throw new Error(error.message);
  }
  console.log(`Staged ${unique.length} Nick deals. IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('No Nick owner-fix to drain.'); return; }
  const limit = argLimit();
  console.log(`Draining Nick owner-fix ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);
  let fixed = 0, skipped = 0, failed = 0, done = 0;
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, fs_id')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(200);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const now = new Date().toISOString();
      const g = await C.fs('GET', `/deals/${row.fs_id}?include=owner`);
      if (!g.ok) { await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `GET ${g.status}`, attempted_at: now }).eq('id', row.id); failed++; done++; continue; }
      const cur = g.data?.deal?.owner_id;
      if (cur !== CS_ID) { await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: `already owner ${cur}`, attempted_at: now }).eq('id', row.id); skipped++; done++; }
      else {
        const p = await C.fs('PUT', `/deals/${row.fs_id}`, { deal: { owner_id: NICK_ID } });
        if (p.ok) { await C.supabase.from('crm_import_rows').update({ status: 'sent', error_message: null, attempted_at: now }).eq('id', row.id); fixed++; }
        else { await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `PUT ${p.status}`, attempted_at: now }).eq('id', row.id); failed++; }
        done++;
      }
      if (done % 100 === 0) console.log(`  ${done} — fixed:${fixed} skipped:${skipped} failed:${failed}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('Complete.'); }
  console.log(`\nDone: ${fixed} reassigned to Nicholas Krutko, ${skipped} left as-is, ${failed} failed. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/owner-fix-nick.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`OWNER-FIX-NICK ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
