/**
 * Prepare step (cloud): build the contact-email cache, account-name cache, and
 * owner-by-name map from Freshsales, then fill each staged activity's task
 * payload (normalized_json) and flip the import to 'pushing'.
 *
 *   node crm-import/tasks-prepare.js [importId]
 *
 * The two ~1.5h cache scans (289k contacts, 300k accounts) fit in one 6h job.
 */
const C = require('./common');
const T = require('./tasks');

async function pickImport() {
  const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (explicit) return explicit;
  const { data } = await C.supabase
    .from('crm_imports').select('id, status, mapping_json')
    .eq('import_type', 'tasks').in('status', ['mapping', 'ready'])
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === 'sfdc-tasks-script')?.id || null;
}

async function main() {
  const importId = await pickImport();
  if (!importId) { console.log('No tasks import in mapping/ready state.'); return; }
  console.log(`Preparing tasks import ${importId}…`);

  console.log('Building caches from Freshsales (contacts, accounts, owners)…');
  const ownerByName = await T.buildOwnerByName();
  const contactCache = await C.buildContactCache((m) => console.log(m));
  const accountCache = await T.buildAccountCache((m) => console.log(m));
  console.log(`owners: ${Object.keys(ownerByName).length}, contacts: ${Object.keys(contactCache).length}, accounts: ${Object.keys(accountCache).length}`);
  const ctx = { ownerByName, contactCache, accountCache };

  const PAGE = 1000;
  let done = 0, linkedContact = 0, linkedAccount = 0, unlinked = 0, offset = 0;
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', importId).is('normalized_json', null).eq('status', 'pending')
      .order('row_index', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetch rows failed: ${error.message}`);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const built = T.buildTaskPayload(row.raw_json, ctx);
      const t = built.task;
      if (t.targetable_type === 'Contact') linkedContact++;
      else if (t.targetable_type === 'SalesAccount') linkedAccount++;
      else unlinked++;
      await C.supabase.from('crm_import_rows').update({ normalized_json: built }).eq('id', row.id);
      done++;
    }
    console.log(`  prepared ${done} (contact:${linkedContact} account:${linkedAccount} unlinked:${unlinked})`);
    if (rows.length < PAGE) break;
  }

  await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', importId);
  console.log(`\nPrepare complete: ${done} tasks (contact-linked ${linkedContact}, account-linked ${linkedAccount}, unlinked ${unlinked}). status=pushing.`);
}

main().catch((e) => { console.error('TASKS PREPARE FAILED:', e.message); process.exit(1); });
