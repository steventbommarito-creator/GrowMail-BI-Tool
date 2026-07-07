/**
 * Loader: read the SFDC opportunity CSVs (~/Downloads/OppsFWImport/), keep rows
 * dated 2022-01-01+, newest-first, build each deal's FS payload, and stage them
 * into crm_imports + crm_import_rows so the /crm/imports dashboard tracks the run.
 *
 *   node crm-import/load.js
 *
 * Idempotent-ish: if an unfinished 'opportunities' import from this loader
 * already exists (marker in mapping_json), it refuses to create a duplicate —
 * pass --force to make a new one anyway.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse/sync');
const C = require('./common');

const CSV_DIR = path.join(os.homedir(), 'Downloads', 'OppsFWImport');
const MARKER = 'sfdc-opps-2022-script';
const UPLOADED_BY = process.env.TRIGGERED_BY || 'script:sfdc-import';

async function main() {
  const force = process.argv.includes('--force');

  // Guard against creating duplicate imports.
  const { data: existing } = await C.supabase
    .from('crm_imports')
    .select('id, status, mapping_json, total_rows')
    .eq('import_type', 'opportunities')
    .order('uploaded_at', { ascending: false })
    .limit(20);
  const prior = (existing || []).find((i) => i.mapping_json?.__marker === MARKER && i.status !== 'complete');
  if (prior && !force) {
    console.log(`An unfinished import from this loader already exists: ${prior.id} (status=${prior.status}, ${prior.total_rows} rows).`);
    console.log('Run the drainer to continue it, or re-run load with --force to create a new one.');
    console.log(`IMPORT_ID=${prior.id}`);
    return;
  }

  console.log('Building owner map + contact cache from Freshsales…');
  const ownerMap = await C.buildOwnerMap();
  const contactCache = await C.buildContactCache((m) => process.stdout.write(m + '\n'));
  console.log(`owners: ${Object.keys(ownerMap.byEmail).length}, contact emails cached: ${Object.keys(contactCache).length}`);

  // Read + filter + sort.
  const files = fs.readdirSync(CSV_DIR)
    .filter((f) => /^OppsReport_Cleaned_Part.*\.csv$/.test(f))
    .sort()
    .map((f) => path.join(CSV_DIR, f));
  if (!files.length) throw new Error(`No CSVs found in ${CSV_DIR}`);
  let rows = [];
  let columns = null;
  for (const file of files) {
    const recs = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
    if (!columns && recs.length) columns = Object.keys(recs[0]);
    for (const r of recs) if (C.inScope(r)) rows.push(r);
  }
  rows.sort((a, b) => (C.rowDateKey(a) < C.rowDateKey(b) ? 1 : -1)); // newest-first
  console.log(`Rows in scope (>= ${C.SCOPE_CUTOFF}): ${rows.length}`);

  // Create the import record.
  const { data: imp, error: impErr } = await C.supabase
    .from('crm_imports')
    .insert({
      import_type: 'opportunities',
      original_filename: 'SFDC Opportunities 2022+ (script import)',
      total_rows: rows.length,
      sheet_name: 'OppsReport_Cleaned',
      excel_columns: columns,
      status: 'pushing',
      uploaded_by: UPLOADED_BY,
      mapping_json: {
        __marker: MARKER,
        note: 'Single-create import via crm-import/drain.js (not the bulk engine).',
        'Opportunity Name': 'name', 'Amount': 'amount', 'Stage': 'deal_stage_id (collapsed Won/Quoted/Lost)',
        'Owner Email': 'owner_id (name-part match, default Customer Service)',
        'Primary Contact Email': 'contacts_added_list', 'Opportunity ID': 'cf_sf_oppty_id',
      },
    })
    .select('id')
    .single();
  if (impErr) throw new Error(`create import failed: ${impErr.message}`);
  const importId = imp.id;
  console.log(`Created import ${importId}. Inserting ${rows.length} rows…`);

  // Insert rows in chunks. Store the built FS payload in normalized_json; rows
  // whose payload can't be built are staged as validation_failed up-front.
  const CHUNK = 500;
  let inserted = 0, preFailed = 0, withContact = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const payload = slice.map((r, j) => {
      const built = C.buildDealPayload(r, ownerMap, contactCache);
      if (built.deal && built.deal.contacts_added_list) withContact++;
      if (built.error) preFailed++;
      return {
        import_id: importId,
        row_index: i + j + 1,
        raw_json: r,
        normalized_json: built.deal || null,
        status: built.error ? 'validation_failed' : 'pending',
        error_message: built.error || null,
      };
    });
    const { error } = await C.supabase.from('crm_import_rows').insert(payload);
    if (error) throw new Error(`row insert @${i} failed: ${error.message}`);
    inserted += slice.length;
    if (inserted % 5000 === 0 || inserted === rows.length) console.log(`  inserted ${inserted}/${rows.length}`);
  }

  console.log(`\nDone. import_id=${importId}`);
  console.log(`  pending: ${inserted - preFailed}, validation_failed: ${preFailed}, will link a contact: ${withContact}`);
  console.log(`Track it at /crm/imports/${importId}. Start pushing with: node crm-import/drain.js ${importId}`);
  console.log(`IMPORT_ID=${importId}`);
}

main().catch((e) => { console.error('LOAD FAILED:', e.message); process.exit(1); });
