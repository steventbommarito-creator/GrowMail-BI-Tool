/**
 * Close the "New Lead Creation" automation tasks that fired when our BULK
 * imports created contacts (address-update creates, missing-leads import,
 * osprey-contact-fill creates). The FW workflow assigns these to Christian
 * Cabrera; the mass-import ones are noise. Tasks on contacts created by the
 * live osprey-lead-sync (genuine new signups) are NOT touched — their contact
 * ids are excluded explicitly.
 *
 *   node crm-import/close-lead-creation-tasks.js [--dry-run]
 *
 * Stateless + idempotent: reads each bulk-created contact's tasks, closes open
 * ones titled "New Lead Creation" (PUT status:1). Re-runs skip already-closed.
 */
const C = require('./common');

const TITLE = 'new lead creation';

async function bulkCreatedContactIds() {
  const ids = new Set();
  const { data: imps } = await C.supabase.from('crm_imports')
    .select('id, mapping_json, original_filename').order('uploaded_at', { ascending: false }).limit(150);
  const collect = async (impId, filter) => {
    for (let f = 0; ; f += 1000) {
      let q = C.supabase.from('crm_import_rows').select('fs_id, error_message, status').eq('import_id', impId).range(f, f + 999);
      const { data } = await q;
      if (!data || !data.length) break;
      for (const r of data) if (r.fs_id && filter(r)) ids.add(String(r.fs_id));
      if (data.length < 1000) break;
    }
  };
  const addr = (imps || []).find((i) => /mailing addresses/.test(i.original_filename || ''));
  if (addr) await collect(addr.id, (r) => /creat/.test(r.error_message || ''));
  const leads = (imps || []).find((i) => i.mapping_json?.__marker === 'sfdc-leads-2026-07');
  if (leads) await collect(leads.id, (r) => r.status === 'sent');
  const ofill = (imps || []).find((i) => i.mapping_json?.__marker === 'osprey-contact-fill-2026-08');
  if (ofill) await collect(ofill.id, (r) => r.status === 'sent' && r.fs_id);   // fs_id = linked/created contact
  // exclude live osprey-lead-sync contacts (genuine signups — keep their tasks)
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_lead_sync').select('fw_contact_id').range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) if (r.fw_contact_id) ids.delete(String(r.fw_contact_id));
    if (data.length < 1000) break;
  }
  return [...ids];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ids = await bulkCreatedContactIds();
  console.log(`bulk-created contacts to sweep: ${ids.length}${dryRun ? ' (DRY RUN)' : ''}`);
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  let checked = 0, closed = 0, alreadyClosed = 0, noTask = 0, otherOpen = 0, failed = 0;
  for (const id of ids) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — rerun to continue (idempotent).'); break; }
    const g = await C.fs('GET', `/contacts/${id}?include=tasks`);
    if (!g.ok) { failed++; checked++; continue; }
    const tasks = g.data?.tasks || [];
    if (!tasks.length) noTask++;
    for (const t of tasks) {
      if (String(t.title || '').trim().toLowerCase() !== TITLE) { if (t.status === 0) otherOpen++; continue; }
      if (t.status === 1) { alreadyClosed++; continue; }
      if (dryRun) { closed++; continue; }
      const r = await C.fs('PUT', `/tasks/${t.id}`, { task: { status: 1 } });
      if (r.ok) closed++; else failed++;
    }
    checked++;
    if (checked % 250 === 0) console.log(`  ${checked}/${ids.length} — closed:${closed} already:${alreadyClosed} none:${noTask} failed:${failed}`);
  }
  console.log(`\nDone: ${checked} contacts checked — ${closed} ${dryRun ? 'would be ' : ''}closed, ${alreadyClosed} already closed, ${noTask} had no tasks, ${otherOpen} unrelated open tasks left alone, ${failed} failed.`);
}

main().catch((e) => { console.error('CLOSE-LEAD-TASKS FAILED:', e.message); process.exit(1); });
