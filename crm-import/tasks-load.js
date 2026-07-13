/**
 * Stage step (local): stream the SFDC activities CSV, keep in-scope rows
 * (calls + tasks + external emails, minus automated call-backs & chats), trim
 * the giant chat/comment fields, and stage them as a 'tasks' import in
 * crm_imports + crm_import_rows. No per-row FS calls (one owners lookup for the
 * internal-email filter), so it stays fast on the ~876MB file.
 *
 *   node crm-import/tasks-load.js [--force]
 *
 * Path defaults to ~/Downloads/report1783006375507.csv (override with ACTIVITIES_CSV).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');
const T = require('./tasks');

const CSV = process.env.ACTIVITIES_CSV || path.join(os.homedir(), 'Downloads', 'report1783006375507.csv');
const MARKER = 'sfdc-tasks-script';
const UPLOADED_BY = process.env.TRIGGERED_BY || 'script:sfdc-tasks';

async function main() {
  const force = process.argv.includes('--force');
  if (!fs.existsSync(CSV)) throw new Error(`Activities CSV not found: ${CSV}`);

  const { data: existing } = await C.supabase
    .from('crm_imports').select('id, status, mapping_json, total_rows')
    .eq('import_type', 'tasks').order('uploaded_at', { ascending: false }).limit(20);
  const prior = (existing || []).find((i) => i.mapping_json?.__marker === MARKER && i.status !== 'complete');
  if (prior && !force) {
    console.log(`Unfinished tasks import already exists: ${prior.id} (status=${prior.status}, ${prior.total_rows} rows). IMPORT_ID=${prior.id}`);
    return;
  }

  console.log('Fetching sales users (for internal-email filter)…');
  const salesEmails = await T.salesEmailSet();

  const { data: imp, error: impErr } = await C.supabase
    .from('crm_imports').insert({
      import_type: 'tasks',
      original_filename: 'SFDC Activities (calls/tasks/ext-emails, script import)',
      total_rows: 0,
      sheet_name: 'activities',
      status: 'mapping',
      uploaded_by: UPLOADED_BY,
      mapping_json: {
        __marker: MARKER,
        note: 'Single-create tasks via crm-import/tasks-{prepare,drain}.js.',
        scope: 'calls + tasks + external emails; excludes Scheduled Call Back + Intercom Chat',
        'Subject': 'title', 'Assigned': 'owner (by name)', 'Email': 'targetable Contact',
        'Company / Account': 'targetable SalesAccount (fallback)', 'Status': 'completed flag',
      },
    }).select('id').single();
  if (impErr) throw new Error(`create import failed: ${impErr.message}`);
  const importId = imp.id;
  console.log(`Created tasks import ${importId}. Streaming ${path.basename(CSV)}…`);

  const parser = fs.createReadStream(CSV).pipe(parse({
    columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
  }));

  let scanned = 0, staged = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const { error } = await C.supabase.from('crm_import_rows').insert(batch);
    if (error) throw new Error(`row insert failed @${staged}: ${error.message}`);
    staged += batch.length;
    batch = [];
    if (staged % 5000 === 0) console.log(`  staged ${staged}…`);
  };

  for await (const row of parser) {
    scanned++;
    if (!T.inScopeActivity(row, salesEmails)) continue;
    batch.push({ import_id: importId, row_index: staged + batch.length + 1, raw_json: T.trimRow(row), status: 'pending' });
    if (batch.length >= 500) await flush();
  }
  await flush();

  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', importId);
  console.log(`\nScanned ${scanned} rows, staged ${staged} in-scope tasks.`);
  console.log('Next (cloud): run "CRM Tasks Prepare", then "CRM Tasks Drain".');
  console.log(`IMPORT_ID=${importId}`);
}

main().catch((e) => { console.error('TASKS LOAD FAILED:', e.message); process.exit(1); });
