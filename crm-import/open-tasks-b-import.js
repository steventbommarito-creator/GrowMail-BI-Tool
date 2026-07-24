/**
 * Second July 2026 open-tasks import (report1784899410802.csv): all open SFDC
 * tasks, a superset of the first export. Of 2,244 rows, 1,543 are exact
 * duplicates of tasks already imported (matched multiset-aware on
 * Subject+Assigned+Created Date+Account) — staged as 'skipped'; only the 701
 * new ones are pushed.
 *
 *   node crm-import/open-tasks-b-import.js load
 *   node crm-import/open-tasks-b-import.js prepare [--limit N]
 *   node crm-import/open-tasks-b-import.js drain   [--limit N]
 *
 * This export has NO Email column, so target resolution is name-based:
 *   1. Company/Account name → exact-name account search → SalesAccount
 *   2. else Contact/Lead name → exact-name contact search → Contact
 *   3. else unlinked (Account/Contact/Lead names go in the description header)
 * Same description format as the first import: [names when unlinked] +
 * Created By + Status, then Full Comments. Due = Date, else Created Date.
 *
 * CSV: OPEN_TASKS_B_CSV (default ~/Downloads/report1784899410802.csv)
 */
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');
const T = require('./tasks');
const L = require('./sfdc-leads');

const CSV = process.env.OPEN_TASKS_B_CSV || path.join(os.homedir(), 'Downloads', 'report1784899410802.csv');
const MARKER = 'sfdc-open-tasks-2026-07b';
const PRIOR_IMPORTS = [
  'e0d1303a-f4b2-4963-ab3d-4f80b3b3537f', // first open-tasks import (2026-07-23)
  'd521e2e4-e6ec-42c2-900b-4e271179e5c2', // original activities import (2026-07-13)
];

const KEEP_COLS = [
  'Date', 'Company / Account', 'Contact', 'Lead', 'Subject', 'Assigned',
  'Priority', 'Status', 'Task', 'Created Date', 'Created By', 'Full Comments',
];

const dupKey = (r) => ['Subject', 'Assigned', 'Created Date', 'Company / Account']
  .map((k) => String(r[k] || '').trim().toLowerCase()).join('|');

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

// name → contact id | null (search, exact case-insensitive display-name match).
async function searchContactByName(name) {
  const r = await C.fs('GET', `/search?q=${encodeURIComponent(name.slice(0, 100))}&include=contact&per_page=10`);
  if (!r.ok) throw new Error(`contact search "${name}" failed: ${r.status} ${r.error}`);
  const want = name.trim().toLowerCase();
  const hit = (r.data || []).find((c) => String(c.name || '').trim().toLowerCase() === want);
  return hit ? Number(hit.id) : null;
}

// ── load ────────────────────────────────────────────────────────────────────
async function load() {
  if (!fsNode.existsSync(CSV)) throw new Error(`CSV not found: ${CSV}`);
  const prior = await findImport(['mapping', 'ready', 'pushing']);
  if (prior && !process.argv.includes('--force')) {
    console.log(`Unfinished import already exists: ${prior.id} (status=${prior.status}).`);
    return;
  }

  console.log('Building duplicate keys from prior imports…');
  const seenKeys = new Map(); // key → remaining multiset count
  for (const impId of PRIOR_IMPORTS) {
    for (let from = 0; ; from += 1000) {
      const { data } = await C.supabase.from('crm_import_rows')
        .select('raw_json').eq('import_id', impId).range(from, from + 999);
      if (!data || !data.length) break;
      for (const r of data) { const k = dupKey(r.raw_json); seenKeys.set(k, (seenKeys.get(k) || 0) + 1); }
      if (data.length < 1000) break;
    }
  }
  console.log(`${seenKeys.size} distinct prior keys.`);

  const { data: imp, error } = await C.supabase.from('crm_imports').insert({
    import_type: 'tasks',
    original_filename: 'SFDC open tasks Jul-2026 batch B (all types, deduped vs prior imports)',
    total_rows: 0, sheet_name: 'open-tasks-b', status: 'mapping',
    uploaded_by: process.env.TRIGGERED_BY || 'script:sfdc-open-tasks-b',
    mapping_json: {
      __marker: MARKER,
      note: 'Deduped single-create open tasks via crm-import/open-tasks-b-import.js.',
      scope: 'Task=1 rows; duplicates of prior imports staged as skipped. Name-based matching (no Email column).',
      'Subject': 'title', 'Date': 'due_date (fallback Created Date)', 'Assigned': 'owner (by name, aliased)',
      'Company / Account': 'targetable SalesAccount (exact-name search)',
      'Contact/Lead': 'targetable Contact (exact-name search, fallback)',
    },
  }).select('id').single();
  if (error) throw new Error(`create import failed: ${error.message}`);

  const rows = (await csvRows(CSV)).filter((r) => String(r['Task']).trim() === '1');
  let staged = 0, dups = 0, pend = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map((r, j) => {
      const k = dupKey(r);
      const isDup = (seenKeys.get(k) || 0) > 0;
      if (isDup) { seenKeys.set(k, seenKeys.get(k) - 1); dups++; } else pend++;
      return {
        import_id: imp.id, row_index: i + j + 1, raw_json: trimRow(r),
        status: isDup ? 'skipped' : 'pending',
        error_message: isDup ? 'duplicate of previously imported task' : null,
      };
    });
    const { error: insErr } = await C.supabase.from('crm_import_rows').insert(batch);
    if (insErr) throw new Error(`row insert failed @${i}: ${insErr.message}`);
    staged += batch.length;
  }
  await C.supabase.from('crm_imports').update({ total_rows: staged }).eq('id', imp.id);
  console.log(`Staged ${staged}: ${pend} pending (new), ${dups} duplicates skipped. IMPORT_ID=${imp.id}`);
}

// ── prepare ─────────────────────────────────────────────────────────────────
async function prepare() {
  const imp = await findImport(['mapping', 'ready', 'pushing']);
  if (!imp) { console.log('Nothing staged — run load first.'); return; }
  const limit = argLimit();
  console.log(`Preparing import ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);

  const ownerByName = await L.buildOwnerByName();
  const acctCache = {}, contactCache = {};
  const stats = { account: 0, contact: 0, unlinked: 0 };
  const cached = async (cache, name, fn) => {
    const k = name.toLowerCase();
    if (!(k in cache)) {
      try { cache[k] = await fn(name); }
      catch (e) { console.log(`  ! ${e.message}`); return null; } // not cached — retry next time
    }
    return cache[k];
  };

  let done = 0;
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).is('normalized_json', null).eq('status', 'pending')
      .order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(`fetch rows failed: ${error.message}`);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = row.raw_json;
      const title = String(r['Subject'] || 'Task').slice(0, 250);
      const due = T.parseDateTime(r['Date'] || r['Created Date']) || '2026-07-24T12:00:00Z';
      const owner = ownerByName[String(r['Assigned'] || '').trim().toLowerCase()] || C.CS_OWNER_ID;
      const task = { title, due_date: due, owner_id: owner, status: String(r['Status'] || '').trim() === 'Completed' ? 1 : 0 };

      const acctName = String(r['Company / Account'] || '').trim();
      const personName = String(r['Contact'] || r['Lead'] || '').trim();
      let linked = false;
      if (acctName) {
        const aid = await cached(acctCache, acctName, L.searchAccountByName);
        if (aid) { task.targetable_type = 'SalesAccount'; task.targetable_id = aid; stats.account++; linked = true; }
      }
      if (!linked && personName) {
        const cid = await cached(contactCache, personName, searchContactByName);
        if (cid) { task.targetable_type = 'Contact'; task.targetable_id = cid; stats.contact++; linked = true; }
      }
      if (!linked) stats.unlinked++;

      const lines = [];
      if (!linked) {
        if (acctName) lines.push(`Account: ${acctName}`);
        if (r['Contact']) lines.push(`Contact: ${String(r['Contact']).trim()}`);
        if (r['Lead']) lines.push(`Lead: ${String(r['Lead']).trim()}`);
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
    }
    if (limit && done >= limit) break;
  }
  if (!limit) await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', imp.id);
  console.log(`\nPrepare ${limit ? 'pilot ' : ''}complete: ${done} rows — ${JSON.stringify(stats)}`);
}

// ── drain ───────────────────────────────────────────────────────────────────
async function drain() {
  const imp = await findImport(['mapping', 'ready', 'pushing']);
  if (!imp) { console.log('Nothing to drain.'); return; }
  const limit = argLimit();
  console.log(`Draining import ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);

  const { data: batch } = await C.supabase
    .from('crm_import_batches').insert({ import_id: imp.id, requested_size: limit || 0, status: 'running', triggered_by: 'script:open-tasks-b-drain' })
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
      if ((sent + failed) % 100 === 0) console.log(`  ${sent} sent, ${failed} failed`);
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
if (!run) { console.log('Usage: node crm-import/open-tasks-b-import.js load|prepare|drain [--limit N] [--force]'); process.exit(1); }
run().catch((e) => { console.error(`OPEN-TASKS-B ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
