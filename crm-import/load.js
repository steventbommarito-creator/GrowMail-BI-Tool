/**
 * Stage step (fast, local): read the SFDC opportunity CSVs (~/Downloads/
 * OppsFWImport/), keep rows dated 2022-01-01+, newest-first, and insert them as
 * raw rows into crm_imports + crm_import_rows. No Freshsales calls here, so it
 * finishes in a couple minutes — after this the machine can be off.
 *
 *   node crm-import/load.js [--force]
 *
 * The import starts in status 'mapping'. The cloud `prepare` step then builds
 * each row's Freshsales payload (normalized_json) and flips it to 'pushing';
 * the cloud `drain` step pushes 'pushing' imports.
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

  const { data: existing } = await C.supabase
    .from('crm_imports')
    .select('id, status, mapping_json, total_rows')
    .eq('import_type', 'opportunities')
    .order('uploaded_at', { ascending: false })
    .limit(20);
  const prior = (existing || []).find((i) => i.mapping_json?.__marker === MARKER && i.status !== 'complete');
  if (prior && !force) {
    console.log(`An unfinished import already exists: ${prior.id} (status=${prior.status}, ${prior.total_rows} rows).`);
    console.log(`Continue it (prepare/drain) or re-run with --force. IMPORT_ID=${prior.id}`);
    return;
  }

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

  const { data: imp, error: impErr } = await C.supabase
    .from('crm_imports')
    .insert({
      import_type: 'opportunities',
      original_filename: 'SFDC Opportunities 2022+ (script import)',
      total_rows: rows.length,
      sheet_name: 'OppsReport_Cleaned',
      excel_columns: columns,
      status: 'mapping',   // -> 'pushing' once prepare fills normalized_json
      uploaded_by: UPLOADED_BY,
      mapping_json: {
        __marker: MARKER,
        note: 'Single-create import via crm-import/{prepare,drain}.js (not the bulk engine).',
        'Opportunity Name': 'name', 'Amount': 'amount', 'Stage': 'deal_stage_id (collapsed Won/Quoted/Lost)',
        'Owner Email': 'owner_id (name-part match, default Customer Service)',
        'Primary Contact Email': 'contacts_added_list', 'Opportunity ID': 'cf_sf_oppty_id',
      },
    })
    .select('id')
    .single();
  if (impErr) throw new Error(`create import failed: ${impErr.message}`);
  const importId = imp.id;
  console.log(`Created import ${importId} (status=mapping). Inserting ${rows.length} raw rows…`);

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const payload = slice.map((r, j) => ({
      import_id: importId,
      row_index: i + j + 1,
      raw_json: r,
      status: 'pending',
    }));
    const { error } = await C.supabase.from('crm_import_rows').insert(payload);
    if (error) throw new Error(`row insert @${i} failed: ${error.message}`);
    inserted += slice.length;
    if (inserted % 5000 === 0 || inserted === rows.length) console.log(`  inserted ${inserted}/${rows.length}`);
  }

  console.log(`\nStaged. import_id=${importId}`);
  console.log('Next (cloud): run the "CRM Prepare" workflow to build payloads, then the hourly "CRM Deal Drain" pushes them.');
  console.log(`IMPORT_ID=${importId}`);
}

main().catch((e) => { console.error('LOAD FAILED:', e.message); process.exit(1); });
