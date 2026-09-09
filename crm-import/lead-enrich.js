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
  if (await findImport(['pushing', 'complete'])) { console.log('lead-enrich already staged or complete.'); return; }
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

  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: 'Lead enrichment from SFDC Leads (company/address/phones)',
    total_rows: 0, sheet_name: 'lead-enrich', status: 'pushing', uploaded_by: 'script:lead-enrich',
    mapping_json: { __marker: MARKER },
  }).select('id').single();

  const stats = { scanned: 0, notLead: 0, noMatch: 0, nothingToAdd: 0, staged: 0 };
  let batch = [];
  const flush = async () => { if (!batch.length) return; const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0)); if (error) throw new Error(error.message); };

  for (let page = 1; ; page++) {
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
      if (batch.length >= 500) await flush();
    }
    if (page % 200 === 0) console.log(`  page ${page}: ${JSON.stringify(stats)}`);
    if (contacts.length < 100) break;
  }
  await flush();
  await C.supabase.from('crm_imports').update({ total_rows: stats.staged }).eq('id', imp.id);
  console.log(`Staged. ${JSON.stringify(stats)} IMPORT_ID=${imp.id}`);
}

async function drain() {
  const imp = await findImport(['pushing']);
  if (!imp) { console.log('lead-enrich: nothing staged.'); return; }
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  const stats = { sent: 0, failed: 0 };
  let done = 0, pendingMarks = [];
  const flushMarks = async () => { if (pendingMarks.length) await Promise.all(pendingMarks.splice(0)); };

  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(300);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const j = row.raw_json;
      const r = await C.fs('PUT', `/contacts/${j.contact_id}`, { contact: j.payload });
      const ok = r.ok || r.status === 404;                 // 404 = contact deleted in FW since staging
      const msg = r.ok ? null : (r.status === 404 ? 'contact deleted in FW' : `PUT ${r.status}: ${String(r.error || '').slice(0, 120)}`);
      if (ok) stats.sent++; else stats.failed++;
      pendingMarks.push(C.supabase.from('crm_import_rows').update({
        status: ok ? (r.ok ? 'sent' : 'skipped') : 'failed', error_message: msg,
        fs_id: String(j.contact_id), attempted_at: new Date().toISOString(),
      }).eq('id', row.id));
      if (pendingMarks.length >= 50) await flushMarks();
      done++;
      if (done % 1000 === 0) console.log(`  ${done} — ${JSON.stringify(stats)}`);
      if (limit && done >= limit) break;
    }
    await flushMarks();
    if (limit && done >= limit) break;
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
