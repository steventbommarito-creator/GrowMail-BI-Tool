/**
 * Import the July 2026 SFDC missing-leads export (Jan–Jul 2026 leads) as
 * Freshsales lead contacts (lifecycle stage "Lead", or SQL for
 * Qualified/Converted).
 *
 *   node crm-import/sfdc-leads-import.js load               # stage CSV rows
 *   node crm-import/sfdc-leads-import.js drain [--limit N]  # lookup → skip existing, else POST /contacts
 *
 * Every row is checked against Freshsales with an exact email /lookup before
 * creating, so re-runs and the lead-contacts already created by
 * open-tasks-import.js are skipped, never duplicated. Rows without a valid
 * email are staged as failed ('no valid email') for visibility.
 *
 * ~2 API calls per new lead (~6900 lookups + creates) ≈ 6–7h at the shared
 * 1900/hr rate limit — resumable, only 'pending' rows are attempted.
 *
 * CSV: LEADS_CSV (default ~/Downloads/report1784858430890.csv)
 */
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');
const L = require('./sfdc-leads');

const LEADS_CSV = process.env.LEADS_CSV || path.join(os.homedir(), 'Downloads', 'report1784858430890.csv');
const MARKER = 'sfdc-leads-2026-07';
// Only months >= this cutoff get the lookup+create pass. A stratified sample
// (20/month vs live FW) showed Jan–May 100% already exist; Jun/Jul ~80%.
// Earlier rows are staged as 'skipped' — still available as reference data for
// open-tasks-import's create-lead fallback, never drained.
const MIN_MONTH = process.env.LEADS_MIN_MONTH || '2026-06-01';

async function csvRows(file) {
  const out = [];
  const parser = fsNode.createReadStream(file).pipe(parse({
    columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
  }));
  for await (const row of parser) out.push(row);
  return out;
}

async function findImport(statuses) {
  const { data } = await C.supabase
    .from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'leads').in('status', statuses)
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}

function argLimit() {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
}

async function load() {
  if (!fsNode.existsSync(LEADS_CSV)) throw new Error(`Leads CSV not found: ${LEADS_CSV}`);
  const prior = await findImport(['mapping', 'ready', 'pushing']);
  if (prior && !process.argv.includes('--force')) {
    console.log(`Unfinished leads import already exists: ${prior.id} (status=${prior.status}, ${prior.total_rows} rows).`);
    return;
  }
  const { data: imp, error } = await C.supabase.from('crm_imports').insert({
    import_type: 'leads',
    original_filename: 'SFDC missing leads Jan–Jul 2026 (script import)',
    total_rows: 0, sheet_name: 'leads', status: 'pushing',
    uploaded_by: process.env.TRIGGERED_BY || 'script:sfdc-leads',
    mapping_json: {
      __marker: MARKER,
      note: 'Lookup-before-create lead contacts via crm-import/sfdc-leads-import.js.',
      'First/Last Name': 'name', 'Email': 'primary email (dedupe key)',
      'Lead Owner': 'owner (by name)', 'Lead Status': 'lifecycle stage + status (raw in cf_status_reason)',
      'LEAD SOURCE 2': 'lead_source_id by name + cf_lead_source_2', 'Created Month': 'cf_sf_created',
      'Title/Company': 'job_title', 'Google Analytics Campaign': 'cf_description',
    },
  }).select('id').single();
  if (error) throw new Error(`create import failed: ${error.message}`);

  const rows = await csvRows(LEADS_CSV);
  let staged = 0, noEmail = 0, preScope = 0, pending = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r, j) => {
      const ok = L.validLeadEmail(r);
      const month = C.parseUSDate(r['Created Month']);
      const inScope = ok && month && month >= MIN_MONTH;
      if (!ok) noEmail++; else if (!inScope) preScope++; else pending++;
      return {
        import_id: imp.id, row_index: i + j + 1, raw_json: r,
        status: ok ? (inScope ? 'pending' : 'skipped') : 'failed',
        error_message: ok ? (inScope ? null : `pre-${MIN_MONTH} scope: sampled 100% already in Freshworks`) : 'no valid email',
      };
    });
    const { error: insErr } = await C.supabase.from('crm_import_rows').insert(batch);
    if (insErr) throw new Error(`row insert failed @${i}: ${insErr.message}`);
    staged += batch.length;
  }
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged} lead rows: ${pending} pending (>= ${MIN_MONTH}), ${preScope} out-of-scope skipped, ${noEmail} no-email failed. IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('No leads import to drain — run load first.'); return; }
  const limit = argLimit();
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Draining leads import ${imp.id}${limit ? ` (limit ${limit})` : ''}${dryRun ? ' DRY RUN' : ''}…`);

  const ownerByName = await L.buildOwnerByName();
  const sourceMap = await L.buildSourceMap();
  const ctx = { ownerByName, sourceMap };

  const { data: batch } = await C.supabase
    .from('crm_import_batches').insert({ import_id: imp.id, requested_size: limit || 0, status: 'running', triggered_by: 'script:sfdc-leads-drain' })
    .select('id').single();
  let created = 0, skipped = 0, failed = 0, done = 0;
  const started = Date.now();
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 0);
  const seen = new Set(); // in-CSV duplicate emails → first row wins

  outer: for (;;) {
    if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending')
      .order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(`fetch pending failed: ${error.message}`);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const email = L.leadEmail(row.raw_json);
      const now = new Date().toISOString();
      const finish = (status, fsId, err) => C.supabase.from('crm_import_rows')
        .update({ status, fs_id: fsId ? String(fsId) : null, error_message: err || null, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);

      if (seen.has(email)) { await finish('skipped', null, 'duplicate email in CSV'); skipped++; done++; continue; }
      seen.add(email);

      if (dryRun) {
        if (created < 3) console.log('WOULD CREATE', JSON.stringify(L.buildLeadContact(row.raw_json, ctx)));
        created++; done++;
        if (limit && done >= limit) break outer;
        continue;
      }

      let existingId;
      try { existingId = await L.lookupContactByEmail(email); }
      catch (e) { await finish('failed', null, `lookup: ${e.message}`.slice(0, 250)); failed++; done++; continue; }
      if (existingId) { await finish('skipped', existingId, 'already in Freshsales'); skipped++; done++; }
      else {
        const res = await C.fs('POST', '/contacts', { contact: L.buildLeadContact(row.raw_json, ctx) });
        if (res.ok && res.data?.contact?.id) { await finish('sent', res.data.contact.id, null); created++; }
        else { await finish('failed', null, `HTTP ${res.status}: ${(res.error || '').slice(0, 240)}`); failed++; }
        done++;
      }
      if (done % 100 === 0) {
        const rate = done / Math.max((Date.now() - started) / 3600000, 1e-9);
        console.log(`  ${created} created, ${skipped} skipped, ${failed} failed (~${Math.round(rate)}/hr)`);
      }
      if (limit && done >= limit) break outer;
      if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) { console.log('Runtime budget reached — exiting (resumable).'); break outer; }
    }
  }
  await C.supabase.from('crm_import_batches').update({ status: 'complete', actual_size: done, stats_json: { sent: created, failed, skipped }, completed_at: new Date().toISOString() }).eq('id', batch?.id);
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left && !dryRun) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id);
    console.log('All rows processed — import marked complete.');
  }
  console.log(`\nBatch done: ${created} created, ${skipped} skipped, ${failed} failed. Pending remaining: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/sfdc-leads-import.js load|drain [--limit N] [--dry-run] [--force]'); process.exit(1); }
run().catch((e) => { console.error(`SFDC-LEADS ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
