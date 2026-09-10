/**
 * Priority 4: enrich lead-contacts from the SFDC Lead table (company + address
 * + phones + title). The migration's lead-shells hold ONLY a company name, so
 * ALL enrichment sources from SFDC Leads, joined by email — one authoritative
 * pull, richer data, one PUT per contact.
 *
 *   node crm-import/lead-enrich.js load           # SFDC Lead pull + FW scan → stage
 *   node crm-import/lead-enrich.js drain [--limit N]
 *
 * Rules (per user):
 *   - lead-lifecycle contacts only (lifecycle 128081818855)
 *   - fill gaps only, NEVER overwrite an existing value
 *   - the address block (address/city/state/zipcode/country) is written only
 *     when the contact has none of it — no Frankenstein half-addresses
 *   - duplicate SFDC leads under one email: most recently modified wins
 *   - staging pre-computes the exact payload from the view-listing snapshot, so
 *     drain is a single PUT per contact (no re-reads)
 *
 * The FW view scan runs ~3.5s/page (~3h for 2,950 pages), longer than any
 * default job window — so load checkpoints its page into mapping_json and
 * RESUMES from there if the runner dies; drain refuses to run until the scan
 * has finished (staging_done), else it could drain a partial set to zero and
 * mark the import complete, silently orphaning the unscanned contacts.
 * A killed run can re-stage its last checkpoint interval; drain double-PUTs
 * those harmlessly (same idempotent fill-empty payload).
 */
const C = require('./common');
const S = require('./sfdc');

const MARKER = 'lead-enrich-2026-09';
const ALL_CONTACTS_VIEW = 127029218666;
const LEAD_LIFECYCLE = 128081818855;

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, mapping_json')
    .in('status', statuses).order('uploaded_at', { ascending: false }).limit(80);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }
const clean = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : ''; };
const empty = (v) => !String(v ?? '').trim();

async function load() {
  const prior = await findImport(['pushing', 'complete']);
  if (prior && (prior.status === 'complete' || prior.mapping_json?.staging_done)) { console.log('lead-enrich already staged or complete.'); return; }
  console.log('Pulling SFDC Leads…');
  const leads = await S.queryAll(
    'SELECT Email, Company, Street, City, State, PostalCode, Country, Phone, MobilePhone, Title, LastModifiedDate FROM Lead WHERE Email != null',
    (m) => console.log(m));
  const byEmail = new Map();                        // email → newest-modified lead
  for (const l of leads) {
    const em = String(l.Email || '').trim().toLowerCase();
    if (!em) continue;
    const prev = byEmail.get(em);
    if (!prev || String(l.LastModifiedDate) > String(prev.LastModifiedDate)) byEmail.set(em, l);
  }
  console.log(`SFDC: ${leads.length} leads → ${byEmail.size} unique emails`);

  let imp = prior, stats;
  if (imp) {                                        // resume a scan a dead runner left behind
    stats = imp.mapping_json.stats || { scanned: 0, notLead: 0, noMatch: 0, nothingToAdd: 0, staged: 0 };
    console.log(`Resuming scan at page ${imp.mapping_json.next_page} — ${JSON.stringify(stats)}`);
  } else {
    const { data } = await C.supabase.from('crm_imports').insert({
      import_type: 'contacts_accounts', original_filename: 'Lead enrichment from SFDC Leads (company/address/phones)',
      total_rows: 0, sheet_name: 'lead-enrich', status: 'pushing', uploaded_by: 'script:lead-enrich',
      mapping_json: { __marker: MARKER, next_page: 1 },
    }).select('id, mapping_json').single();
    imp = data;
    stats = { scanned: 0, notLead: 0, noMatch: 0, nothingToAdd: 0, staged: 0 };
  }
  let batch = [];
  const flush = async () => { if (!batch.length) return; const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0)); if (error) throw new Error(error.message); };
  const checkpoint = (page, done) => C.supabase.from('crm_imports')
    .update({ mapping_json: { __marker: MARKER, next_page: page, stats, staging_done: !!done } }).eq('id', imp.id);

  for (let page = Number(imp.mapping_json.next_page) || 1; ; page++) {
    const r = await C.fs('GET', `/contacts/view/${ALL_CONTACTS_VIEW}?per_page=100&page=${page}&sort=id&sort_type=asc&include=lifecycle_stage`);
    if (!r.ok) throw new Error(`view page ${page} failed: ${r.status}`);
    const contacts = r.data?.contacts || [];
    if (!contacts.length) break;
    for (const c of contacts) {
      stats.scanned++;
      if (String(c.lifecycle_stage_id) !== String(LEAD_LIFECYCLE)) { stats.notLead++; continue; }
      const em = String(c.email || '').trim().toLowerCase();
      const lead = em && byEmail.get(em);
      if (!lead) { stats.noMatch++; continue; }

      const payload = {};
      const company = clean(lead.Company, 255);
      if (company && empty((c.custom_field || {}).cf_company)) payload.custom_field = { cf_company: company };
      if (empty(c.address) && empty(c.city) && empty(c.state) && empty(c.zipcode)) {
        if (lead.Street) payload.address = clean(lead.Street, 255);
        if (lead.City) payload.city = clean(lead.City, 100);
        if (lead.State) payload.state = clean(lead.State, 100);
        if (lead.PostalCode) payload.zipcode = clean(lead.PostalCode, 20);
        if (lead.Country) payload.country = clean(lead.Country, 100);
      }
      if (empty(c.work_number) && lead.Phone) payload.work_number = clean(lead.Phone, 30);
      if (empty(c.mobile_number) && lead.MobilePhone) payload.mobile_number = clean(lead.MobilePhone, 30);
      if (empty(c.job_title) && lead.Title) payload.job_title = clean(lead.Title, 100);

      if (!Object.keys(payload).length) { stats.nothingToAdd++; continue; }
      batch.push({
        import_id: imp.id, row_index: ++stats.staged, status: 'pending',
        raw_json: { contact_id: c.id, email: em, payload },
      });
    }
    await flush();                                  // page-aligned so the checkpoint never skips staged rows
    await checkpoint(page + 1, false);
    if (page % 100 === 0) console.log(`  page ${page}: ${JSON.stringify(stats)}`);
    if (contacts.length < 100) break;
  }
  await checkpoint(0, true);
  await C.supabase.from('crm_imports').update({ total_rows: stats.staged }).eq('id', imp.id);
  console.log(`Staged. ${JSON.stringify(stats)} IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('lead-enrich: nothing staged.'); return; }
  if (!imp.mapping_json?.staging_done) { console.log('lead-enrich: staging not finished — drain deferred.'); return; }
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  const stats = { sent: 0, failed: 0 };
  let done = 0, pendingMarks = [];
  const flushMarks = async () => { if (pendingMarks.length) await Promise.all(pendingMarks.splice(0)); };

  // Serial PUTs cap out around 7k/hr (180ms rate gap + ~350ms FW latency per
  // call). A slot pacer + worker pool keeps the exact FRESHSALES_RATE spacing
  // between request STARTS while overlapping the latency → full 20k/hr.
  const CONC = Number(process.env.DRAIN_CONCURRENCY || 8);
  const INTERVAL = 3600000 / Number(process.env.FRESHSALES_RATE || 1900);
  let slot = 0;
  const paced = async () => { slot = Math.max(slot + INTERVAL, Date.now()); const w = slot - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); };

  outer: for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    // A swallowed fetch error here once made 3 cron runs "succeed" at 0 rows
    // with 225k pending — never treat an errored fetch as an empty queue.
    let rows = null;
    for (let a = 0; a < 4; a++) {
      const { data, error } = await C.supabase.from('crm_import_rows').select('id, raw_json')
        .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(300);
      if (!error) { rows = data; break; }
      console.log(`row fetch error (attempt ${a + 1}): ${error.message || JSON.stringify(error)}`);
      if (a === 3) throw new Error(`row fetch failed 4x: ${error.message || JSON.stringify(error)}`);
      await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
    }
    if (!rows || !rows.length) break;
    let idx = 0;
    const worker = async () => {
      for (;;) {
        if (MAX && Date.now() - started >= MAX) return;
        if (limit && done >= limit) return;
        const row = rows[idx++];
        if (!row) return;
        const j = row.raw_json;
        await paced();
        const r = await C.fs('PUT', `/contacts/${j.contact_id}`, { contact: j.payload });
        const ok = r.ok || r.status === 404;               // 404 = contact deleted in FW since staging
        const msg = r.ok ? null : (r.status === 404 ? 'contact deleted in FW' : `PUT ${r.status}: ${String(r.error || '').slice(0, 120)}`);
        if (ok) stats.sent++; else stats.failed++;
        pendingMarks.push(C.supabase.from('crm_import_rows').update({
          status: ok ? (r.ok ? 'sent' : 'skipped') : 'failed', error_message: msg,
          fs_id: String(j.contact_id), attempted_at: new Date().toISOString(),
        }).eq('id', row.id));
        if (pendingMarks.length >= 50) await flushMarks();
        done++;
        if (done % 1000 === 0) console.log(`  ${done} — ${JSON.stringify(stats)}`);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    await flushMarks();
    if (limit && done >= limit) break outer;
  }
  await flushMarks();
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('lead-enrich COMPLETE.'); }
  console.log(`lead-enrich: ${JSON.stringify(stats)}. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { load, drain }[cmd];
if (!run) { console.log('Usage: node crm-import/lead-enrich.js load|drain [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`LEAD-ENRICH ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
