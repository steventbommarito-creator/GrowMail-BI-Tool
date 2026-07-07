/**
 * Prepare step (cloud, one-time): build the owner map + contact-email cache from
 * Freshsales, then fill each staged row's normalized_json with its FS deal
 * payload (contact linked, owner resolved, stage collapsed, customs). Flips the
 * import to 'pushing' when done so the drain can start.
 *
 *   node crm-import/prepare.js [importId]
 *
 * Runs as a single long GitHub Actions job (the ~289k-contact scan is ~1.5h at
 * the 2000/hr FS cap, well within the 6h job limit). Resumable: only rows whose
 * normalized_json is still null are (re)built.
 */
const C = require('./common');

async function pickImport() {
  const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (explicit) return explicit;
  const { data } = await C.supabase
    .from('crm_imports')
    .select('id, status, mapping_json')
    .eq('import_type', 'opportunities')
    .in('status', ['mapping', 'ready'])
    .order('uploaded_at', { ascending: false })
    .limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === 'sfdc-opps-2022-script')?.id || null;
}

async function main() {
  const importId = await pickImport();
  if (!importId) { console.log('No import in mapping/ready state to prepare.'); return; }
  console.log(`Preparing import ${importId}…`);

  console.log('Building owner map + contact cache from Freshsales (this is the slow part)…');
  const ownerMap = await C.buildOwnerMap();
  const contactCache = await C.buildContactCache((m) => console.log(m));
  console.log(`owners: ${Object.keys(ownerMap.byEmail).length}, contact emails: ${Object.keys(contactCache).length}`);

  const PAGE = 1000;
  let done = 0, failed = 0, withContact = 0, offset = 0;
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows')
      .select('id, raw_json')
      .eq('import_id', importId)
      .is('normalized_json', null)
      .eq('status', 'pending')
      .order('row_index', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetch rows failed: ${error.message}`);
    if (!rows || !rows.length) break;

    for (const row of rows) {
      const built = C.buildDealPayload(row.raw_json, ownerMap, contactCache);
      if (built.error) {
        await C.supabase.from('crm_import_rows').update({
          status: 'validation_failed', error_message: built.error,
        }).eq('id', row.id);
        failed++;
      } else {
        if (built.deal.contacts_added_list) withContact++;
        await C.supabase.from('crm_import_rows').update({ normalized_json: built.deal }).eq('id', row.id);
        done++;
      }
    }
    console.log(`  prepared ${done} (+${failed} invalid), ${withContact} with a contact`);
    if (rows.length < PAGE) break;
  }

  await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', importId);
  console.log(`\nPrepare complete: ${done} ready, ${failed} validation_failed, ${withContact} linked to a contact.`);
  console.log('Import flipped to status=pushing. The hourly CRM Deal Drain will now push them.');
}

main().catch((e) => { console.error('PREPARE FAILED:', e.message); process.exit(1); });
