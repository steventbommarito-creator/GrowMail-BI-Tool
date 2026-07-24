/**
 * Opportunities audit + enrichment + order-ID refresh for the 2,570-row SFDC
 * export (report1784907504990.csv). All rows are pre-matched to existing FW
 * deals; this does NOT create deals (matched ~99.7%; 8 garbled VGS rows and
 * any no-match are staged 'skipped' for review).
 *
 *   node crm-import/opp-refresh.js load               # match to deals via staged opp import, stage plan (no FS calls)
 *   node crm-import/opp-refresh.js drain [--limit N]  # per deal: confirm live → enrich → order-ID 0→original
 *
 * Per matched deal (drain):
 *   1. GET deal (dedupe: confirm it still exists in FW; skip if gone).
 *   2. Enrich the linked contact, fill-only-empty: First Order Date →
 *      cf_first_order_date, Last Order Date → cf_last_order_date, Contact:Phone
 *      → work_number. If the deal has NO contact and Contact:Email resolves,
 *      link it first.
 *   3. Order-ID refresh (real order numbers only): PUT cf_order_number = 0,
 *      then PUT cf_order_number = <original SFDC order number> — forces the
 *      dependent formula field to recalc. Row marked 'sent' only after the
 *      restore lands; a mid-row crash leaves it 'pending' and the whole
 *      idempotent cycle repeats (final state always = original).
 *
 * Original order numbers come from the staged opportunities import, so they are
 * durably saved before anything is touched. CSV: OPP_CSV.
 */
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');

const CSV = process.env.OPP_CSV || path.join(os.homedir(), 'Downloads', 'report1784907504990.csv');
const MARKER = 'sfdc-opp-refresh-2026-07';

const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s) => String(s ?? '').trim();

async function csvRows() {
  const out = [];
  const parser = fsNode.createReadStream(CSV).pipe(parse({
    columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
  }));
  for await (const row of parser) out.push(row);
  return out;
}

async function findImport(statuses) {
  const { data } = await C.supabase
    .from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'opportunities').in('status', statuses)
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}

function argLimit() {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
}
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 0);
const outOfTime = (t) => MAX_RUNTIME_MS && Date.now() - t >= MAX_RUNTIME_MS;

const realOrder = (on) => { const n = parseInt(String(on || '').replace(/[^0-9]/g, ''), 10); return n && n !== 999 ? n : null; };

// ── load ────────────────────────────────────────────────────────────────────
async function load() {
  if (!fsNode.existsSync(CSV)) throw new Error(`CSV not found: ${CSV}`);
  const prior = await findImport(['mapping', 'ready', 'pushing']);
  if (prior && !process.argv.includes('--force')) {
    console.log(`Unfinished opp-refresh import exists: ${prior.id} (status=${prior.status}).`);
    return;
  }

  // Bridge from the original opportunities import: name|account -> {fs_id, order}
  const { data: imps } = await C.supabase.from('crm_imports').select('id')
    .eq('import_type', 'opportunities').eq('status', 'complete').limit(1);
  if (!imps || !imps.length) throw new Error('original opportunities import not found');
  const bridge = new Map();
  for (let from = 0; ; from += 1000) {
    const { data } = await C.supabase.from('crm_import_rows')
      .select('raw_json, fs_id').eq('import_id', imps[0].id).range(from, from + 999);
    if (!data || !data.length) break;
    for (const r of data) bridge.set(norm(r.raw_json['Opportunity Name']) + '|' + norm(r.raw_json['Account Name']),
      { fs: r.fs_id, order: r.raw_json['Order Number'] });
    if (data.length < 1000) break;
  }
  console.log(`bridge: ${bridge.size} keys from original import.`);

  const { data: imp, error } = await C.supabase.from('crm_imports').insert({
    import_type: 'opportunities',
    original_filename: 'SFDC opps 2021-22 — dedupe/enrich/order-ID refresh',
    total_rows: 0, sheet_name: 'opp-refresh', status: 'mapping',
    uploaded_by: process.env.TRIGGERED_BY || 'script:opp-refresh',
    mapping_json: {
      __marker: MARKER,
      note: 'No deal creates. Confirm-live + enrich linked contact + order-ID 0→original. crm-import/opp-refresh.js',
    },
  }).select('id').single();
  if (error) throw new Error(`create import failed: ${error.message}`);

  const rows = await csvRows();
  let staged = 0, matched = 0, skipped = 0;
  const batchRows = rows.map((r, i) => {
    const b = bridge.get(norm(r['Opportunity Name']) + '|' + norm(r['Account Name']));
    if (!b || !b.fs) {
      skipped++;
      return { import_id: imp.id, row_index: i + 1, raw_json: r, status: 'skipped',
        error_message: b ? 'matched opp has no created deal id' : 'no matching deal (name+account)' };
    }
    matched++;
    const plan = {
      deal_id: Number(b.fs),
      order_original: realOrder(b.order),           // null → skip order-ID cycle
      contact_email: norm(r['Contact: Email']) || null,
      contact_phone: clean(r['Contact: Phone']) || null,
      first_order_date: clean(r['First Order Date']) || null,
      last_order_date: clean(r['Last Order Date']) || null,
    };
    return { import_id: imp.id, row_index: i + 1, raw_json: r, normalized_json: plan, status: 'pending' };
  });
  for (let i = 0; i < batchRows.length; i += 500) {
    const { error: e } = await C.supabase.from('crm_import_rows').insert(batchRows.slice(i, i + 500));
    if (e) throw new Error(`row insert failed @${i}: ${e.message}`);
    staged += Math.min(500, batchRows.length - i);
  }
  await C.supabase.from('crm_imports').update({ total_rows: staged, status: 'pushing' }).eq('id', imp.id);
  console.log(`Staged ${staged}: ${matched} matched (pending), ${skipped} skipped. IMPORT_ID=${imp.id}`);
}

// date passthrough: SFDC "M/D/YYYY" → YYYY-MM-DD (FW date custom fields)
function isoDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean(s));
  return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null;
}

// Enrich the deal's linked contact (fill-only-empty). Returns short status note.
async function enrichContact(plan) {
  const g = await C.fs('GET', `/deals/${plan.deal_id}?include=contacts`);
  if (!g.ok) return { ok: false, note: `deal GET ${g.status}` };
  let contactId = (g.data?.contacts || [])[0]?.id || null;

  if (!contactId && plan.contact_email) {          // deal has no contact — link by email if resolvable
    const lk = await C.fs('GET', `/lookup?q=${encodeURIComponent(plan.contact_email)}&f=email&entities=contact`);
    contactId = (lk.data?.contacts?.contacts || [])[0]?.id || null;
    if (contactId) await C.fs('PUT', `/deals/${plan.deal_id}`, { deal: { contacts_added_list: [contactId] } });
  }
  if (!contactId) return { ok: true, note: 'no contact to enrich' };

  const cg = await C.fs('GET', `/contacts/${contactId}`);
  if (!cg.ok) return { ok: true, note: 'contact GET failed' };
  const c = cg.data?.contact || {};
  const cf = c.custom_field || {};
  const patch = {};
  const fod = isoDate(plan.first_order_date), lod = isoDate(plan.last_order_date);
  if (fod && !clean(cf.cf_first_order_date)) patch.custom_field = { ...(patch.custom_field || {}), cf_first_order_date: fod };
  if (lod && !clean(cf.cf_last_order_date)) patch.custom_field = { ...(patch.custom_field || {}), cf_last_order_date: lod };
  if (plan.contact_phone && !clean(c.work_number)) patch.work_number = plan.contact_phone.slice(0, 30);
  if (Object.keys(patch).length) {
    const r = await C.fs('PUT', `/contacts/${contactId}`, { contact: patch });
    return { ok: true, note: r.ok ? 'contact enriched' : `contact PUT ${r.status}` };
  }
  return { ok: true, note: 'contact already complete' };
}

// PUT cf_order_number with hard retry (fs() alone does not retry 400s, and the
// restore write MUST land or the deal is left at 0).
async function putOrder(dealId, value, attempts) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const r = await C.fs('PUT', `/deals/${dealId}`, { deal: { custom_field: { cf_order_number: value } } });
    if (r.ok) return r;
    last = r;
    await C.sleep(2000 * (i + 1));
  }
  return last;
}

// Order-ID refresh: 0 → original. Zero-write is retried lightly (a failure
// there leaves the deal untouched at its original value — safe). The restore
// is retried hard; if it still fails the row fails LOUDLY with the deal at 0,
// and a re-run re-cycles it (order_original is durable in the plan).
async function refreshOrderId(plan) {
  if (!plan.order_original) return { ok: true, note: 'no real order #' };
  const z = await putOrder(plan.deal_id, 0, 3);
  if (!z.ok) return { ok: false, note: `zero-write ${z.status} (deal untouched at original)` };
  const o = await putOrder(plan.deal_id, plan.order_original, 10);
  if (!o.ok) return { ok: false, note: `restore FAILED ${o.status} — deal ${plan.deal_id} LEFT AT 0` };
  return { ok: true, note: 'order-ID cycled' };
}

// ── drain ───────────────────────────────────────────────────────────────────
async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('No opp-refresh import in pushing state — run load first.'); return; }
  const limit = argLimit();
  console.log(`Draining opp-refresh ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);
  const { data: batch } = await C.supabase.from('crm_import_batches')
    .insert({ import_id: imp.id, requested_size: limit || 0, status: 'running', triggered_by: 'script:opp-refresh-drain' })
    .select('id').single();

  let done = 0, enriched = 0, cycled = 0, failed = 0;
  const started = Date.now();
  outer: for (;;) {
    if (outOfTime(started)) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows, error } = await C.supabase.from('crm_import_rows')
      .select('id, normalized_json').eq('import_id', imp.id).eq('status', 'pending')
      .not('normalized_json', 'is', null).order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(error.message);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const plan = row.normalized_json;
      const now = new Date().toISOString();
      const enr = await enrichContact(plan);            // idempotent (fill-empty)
      if (!enr.ok) {
        await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `enrich: ${enr.note}`, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        failed++; done++; if (limit && done >= limit) break outer; continue;
      }
      if (enr.note === 'contact enriched') enriched++;
      const ref = await refreshOrderId(plan);           // last — restore must land before 'sent'
      if (!ref.ok) {
        await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `orderid: ${ref.note}`, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        failed++; done++; if (limit && done >= limit) break outer; continue;
      }
      if (ref.note === 'order-ID cycled') cycled++;
      await C.supabase.from('crm_import_rows').update({ status: 'sent', fs_id: String(plan.deal_id), error_message: `${enr.note}; ${ref.note}`, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
      done++;
      if (done % 100 === 0) console.log(`  ${done} done — enriched:${enriched} cycled:${cycled} failed:${failed}`);
      if (limit && done >= limit) break outer;
      if (outOfTime(started)) { console.log('Runtime budget reached — exiting (resumable).'); break outer; }
    }
  }
  await C.supabase.from('crm_import_batches').update({ status: 'complete', actual_size: done, stats_json: { sent: done - failed, failed, skipped: 0, enriched, cycled }, completed_at: new Date().toISOString() }).eq('id', batch?.id);
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id);
    console.log('All rows processed — import marked complete.');
  }
  console.log(`\nBatch done: ${done} processed (${enriched} contacts enriched, ${cycled} order-IDs cycled, ${failed} failed). Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/opp-refresh.js load|drain [--limit N] [--force]'); process.exit(1); }
run().catch((e) => { console.error(`OPP-REFRESH ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
