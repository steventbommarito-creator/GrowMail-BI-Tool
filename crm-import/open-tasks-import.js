/**
 * Import the July 2026 SFDC open-tasks export (Scheduled Call Backs + open KPI
 * tasks — the types/statuses the original activities import deliberately
 * skipped) as open Freshsales tasks.
 *
 *   node crm-import/open-tasks-import.js load                # stage CSV rows (Task=1 only)
 *   node crm-import/open-tasks-import.js prepare [--limit N] # resolve targets, build payloads
 *   node crm-import/open-tasks-import.js drain   [--limit N] # POST /tasks
 *
 * Scope: rows with Task="1" (1,548). Task="0" rows are calendar events (Home /
 * Lunch / standing meetings) and are skipped. All rows are open (status 0) —
 * none are Completed in the export.
 *
 * Target resolution per row (prepare):
 *   1. Email → exact /lookup contact match.
 *   2. Email found only in the missing-leads CSV → CREATE that lead contact
 *      (sfdc-leads.js payload) and link it; the later leads import then skips
 *      it via its own lookup.
 *   3. Company/Account name → /search sales_account exact-name match.
 *   4. Otherwise unlinked.
 * Lookups/creates are cached per unique email / account name, so ~2.3k API
 * calls total (~1.2h at the shared rate limit) instead of the two ~1.5h
 * full-cache scans the original tasks-prepare needed.
 *
 * CSVs: OPEN_TASKS_CSV (default ~/Downloads/report1784859145200.csv)
 *       LEADS_CSV      (default ~/Downloads/report1784858430890.csv)
 */
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');
const T = require('./tasks');
const L = require('./sfdc-leads');

const TASKS_CSV = process.env.OPEN_TASKS_CSV || path.join(os.homedir(), 'Downloads', 'report1784859145200.csv');
const LEADS_CSV = process.env.LEADS_CSV || path.join(os.homedir(), 'Downloads', 'report1784858430890.csv');
const MARKER = 'sfdc-open-tasks-2026-07';

const KEEP_COLS = [
  'Subject', 'Date', 'Priority', 'Company / Account', 'Contact', 'Lead', 'Email',
  'Opportunity', 'Assigned', 'Created By', 'Activity Type', 'Created Date', 'Full Comments', 'Status',
];

function trimRow(row) {
  const out = {};
  for (const k of KEEP_COLS) {
    let v = row[k];
    if (k === 'Full Comments' && v) v = String(v).slice(0, 2000);
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}

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
    .eq('import_type', 'tasks').in('status', statuses)
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}

function argLimit() {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
}

// ── load ────────────────────────────────────────────────────────────────────
async function load() {
  if (!fsNode.existsSync(TASKS_CSV)) throw new Error(`Tasks CSV not found: ${TASKS_CSV}`);
  const prior = await findImport(['mapping', 'ready', 'pushing']);
  if (prior && !process.argv.includes('--force')) {
    console.log(`Unfinished open-tasks import already exists: ${prior.id} (status=${prior.status}, ${prior.total_rows} rows).`);
    return;
  }
  const { data: imp, error } = await C.supabase.from('crm_imports').insert({
    import_type: 'tasks',
    original_filename: 'SFDC open tasks Jul-2026 (Scheduled Call Backs + open KPI tasks)',
    total_rows: 0, sheet_name: 'open-tasks', status: 'mapping',
    uploaded_by: process.env.TRIGGERED_BY || 'script:sfdc-open-tasks',
    mapping_json: {
      __marker: MARKER,
      note: 'Single-create open tasks via crm-import/open-tasks-import.js (load/prepare/drain).',
      scope: 'Task=1 rows only; Task=0 calendar events skipped. Missing lead targets created from leads CSV.',
      'Subject': 'title', 'Date': 'due_date', 'Assigned': 'owner (by name)',
      'Email': 'targetable Contact (lookup, create-from-leads-CSV if missing)',
      'Company / Account': 'targetable SalesAccount (search fallback)',
    },
  }).select('id').single();
  if (error) throw new Error(`create import failed: ${error.message}`);

  const rows = (await csvRows(TASKS_CSV)).filter((r) => String(r['Task']).trim() === '1');
  let staged = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r, j) => ({
      import_id: imp.id, row_index: i + j + 1, raw_json: trimRow(r), status: 'pending',
    }));
    const { error: insErr } = await C.supabase.from('crm_import_rows').insert(batch);
    if (insErr) throw new Error(`row insert failed @${i}: ${insErr.message}`);
    staged += batch.length;
  }
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged} open tasks (of ${rows.length} Task=1 rows). IMPORT_ID=${imp.id}`);
}

// ── prepare ─────────────────────────────────────────────────────────────────
async function prepare() {
  const imp = await findImport(['mapping', 'ready', 'pushing']);
  if (!imp) { console.log('No open-tasks import staged — run load first.'); return; }
  const limit = argLimit();
  console.log(`Preparing open-tasks import ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);

  const ownerByName = await L.buildOwnerByName();
  const sourceMap = await L.buildSourceMap();
  // Lead reference rows: local CSV if present, else the staged leads import in
  // Supabase (cloud runners have no ~/Downloads).
  const leadRowByEmail = {};
  if (fsNode.existsSync(LEADS_CSV)) {
    for (const r of await csvRows(LEADS_CSV)) {
      if (L.validLeadEmail(r)) leadRowByEmail[L.leadEmail(r)] = r;
    }
  } else {
    const { data: leadImps } = await C.supabase
      .from('crm_imports').select('id, mapping_json').eq('import_type', 'leads')
      .order('uploaded_at', { ascending: false }).limit(20);
    const leadImp = (leadImps || []).find((i) => i.mapping_json?.__marker === 'sfdc-leads-2026-07');
    if (leadImp) {
      for (let from = 0; ; from += 1000) {
        const { data } = await C.supabase.from('crm_import_rows')
          .select('raw_json').eq('import_id', leadImp.id).range(from, from + 999);
        if (!data || !data.length) break;
        for (const { raw_json: r } of data) if (L.validLeadEmail(r)) leadRowByEmail[L.leadEmail(r)] = r;
        if (data.length < 1000) break;
      }
    } else console.log('! No leads CSV or staged leads import — no lead-creates, email misses fall through to account.');
  }
  console.log(`owners: ${Object.keys(ownerByName).length}, sources: ${Object.keys(sourceMap).length}, lead rows: ${Object.keys(leadRowByEmail).length}`);

  const emailCache = {};   // email → contact id | null
  const acctCache = {};    // name(lower) → account id | null
  const stats = { contact: 0, createdLead: 0, account: 0, unlinked: 0, leadCreateFailed: 0 };

  async function resolveContact(email) {
    if (email in emailCache) return emailCache[email];
    let id = await L.lookupContactByEmail(email);
    if (!id && leadRowByEmail[email]) {
      const contact = L.buildLeadContact(leadRowByEmail[email], { ownerByName, sourceMap });
      const res = await C.fs('POST', '/contacts', { contact });
      if (res.ok && res.data?.contact?.id) { id = res.data.contact.id; stats.createdLead++; }
      else { stats.leadCreateFailed++; console.log(`  ! lead create failed ${email}: ${res.status} ${res.error}`); }
    }
    emailCache[email] = id || null;
    return emailCache[email];
  }

  async function resolveAccount(name) {
    const key = name.toLowerCase();
    if (key in acctCache) return acctCache[key];
    acctCache[key] = await searchSafe(name);
    return acctCache[key];
  }
  async function searchSafe(name) {
    try { return await L.searchAccountByName(name); }
    catch (e) { console.log(`  ! ${e.message}`); return null; }
  }

  let done = 0, ranOut = false;
  const started = Date.now();
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 0);
  const outOfTime = () => MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS;
  for (;;) {
    if (outOfTime()) { ranOut = true; console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).is('normalized_json', null).eq('status', 'pending')
      .order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(`fetch rows failed: ${error.message}`);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = row.raw_json;
      const title = String(r['Subject'] || r['Activity Type'] || 'Task').slice(0, 250);
      const due = T.parseDateTime(r['Date'] || r['Created Date']) || '2026-07-23T12:00:00Z';
      const owner = ownerByName[String(r['Assigned'] || '').trim().toLowerCase()] || C.CS_OWNER_ID;
      const task = { title, due_date: due, owner_id: owner, status: String(r['Status'] || '').trim() === 'Completed' ? 1 : 0 };

      const email = String(r['Email'] || '').trim().toLowerCase();
      const acctName = String(r['Company / Account'] || '').trim();
      let cid = null;
      if (email && L.EMAIL_RE.test(email)) cid = await resolveContact(email);
      let linked = true;
      if (cid) { task.targetable_type = 'Contact'; task.targetable_id = cid; stats.contact++; }
      else if (acctName && (task.targetable_id = await resolveAccount(acctName))) {
        task.targetable_type = 'SalesAccount'; stats.account++;
      } else { delete task.targetable_id; linked = false; stats.unlinked++; }

      // Description: [Account/Email when unlinked] + Created By + Status, then comments.
      const lines = [];
      if (!linked) {
        if (acctName) lines.push(`Account: ${acctName}`);
        if (r['Email']) lines.push(`Email: ${String(r['Email']).trim()}`);
      }
      if (r['Created By']) lines.push(`Created By: ${String(r['Created By']).trim()}`);
      if (r['Status']) lines.push(`Status: ${String(r['Status']).trim()}`);
      const comments = String(r['Full Comments'] || '').trim();
      const desc = (lines.join('\n') + (comments ? '\n\n' + comments : '')).slice(0, 2000);
      if (desc) task.description = desc;

      await C.supabase.from('crm_import_rows').update({ normalized_json: { task } }).eq('id', row.id);
      done++;
      if (done % 50 === 0) console.log(`  prepared ${done} — ${JSON.stringify(stats)}`);
      if (limit && done >= limit) break;
      if (outOfTime()) { ranOut = true; console.log('Runtime budget reached — exiting (resumable).'); break; }
    }
    if ((limit && done >= limit) || ranOut) break;
  }
  const finished = !limit && !ranOut;
  if (finished) await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', imp.id);
  console.log(`\nPrepare ${finished ? 'complete' : 'batch done'}: ${done} rows — ${JSON.stringify(stats)}${finished ? '. status=pushing' : ''}`);
}

// ── drain ───────────────────────────────────────────────────────────────────
async function drain() {
  const imp = await findImport(['mapping', 'ready', 'pushing']);
  if (!imp) { console.log('No open-tasks import to drain.'); return; }
  const limit = argLimit();
  console.log(`Draining open-tasks import ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);

  const { data: batch } = await C.supabase
    .from('crm_import_batches').insert({ import_id: imp.id, requested_size: limit || 0, status: 'running', triggered_by: 'script:open-tasks-drain' })
    .select('id').single();
  let sent = 0, failed = 0;
  const started = Date.now();
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, normalized_json')
      .eq('import_id', imp.id).eq('status', 'pending').not('normalized_json', 'is', null)
      .order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(`fetch pending failed: ${error.message}`);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const res = await C.fs('POST', '/tasks', row.normalized_json);
      const now = new Date().toISOString();
      if (res.ok && res.data?.task?.id) {
        await C.supabase.from('crm_import_rows').update({ status: 'sent', fs_id: String(res.data.task.id), error_message: null, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        sent++;
      } else {
        await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `HTTP ${res.status}: ${(res.error || '').slice(0, 250)}`, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        failed++;
      }
      if ((sent + failed) % 100 === 0) {
        const rate = sent / Math.max((Date.now() - started) / 3600000, 1e-9);
        console.log(`  ${sent} sent, ${failed} failed (~${Math.round(rate)}/hr)`);
      }
      if (limit && sent + failed >= limit) break;
    }
    if (limit && sent + failed >= limit) break;
  }
  await C.supabase.from('crm_import_batches').update({ status: 'complete', actual_size: sent + failed, stats_json: { sent, failed, skipped: 0 }, completed_at: new Date().toISOString() }).eq('id', batch?.id);
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id);
    console.log('All rows processed — import marked complete.');
  }
  console.log(`\nBatch done: ${sent} sent, ${failed} failed. Pending remaining: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, prepare, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/open-tasks-import.js load|prepare|drain [--limit N] [--force]'); process.exit(1); }
run().catch((e) => { console.error(`OPEN-TASKS ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
