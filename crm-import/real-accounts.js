/**
 * Phase 1 of the real-account cleanup: identify which of Freshworks' ~300k
 * Sales Accounts are REAL accounts (vs lead-company shells the migration
 * manufactured), per the user's definition:
 *   real = SFDC account created >= 2018-01-01, OR with an opportunity created
 *          >= 2018 (~23,971), OR an FW account linked to any deal (order-backed).
 *
 *   node crm-import/real-accounts.js scan      # SFDC pull + FW full scan → stage matches (READ-ONLY vs FW)
 *   node crm-import/real-accounts.js report    # write review xlsx from staged data
 *   node crm-import/real-accounts.js tag [--limit N]   # after user approval: apply 'Real Account' tag (cloud)
 *
 * Staged in crm_imports (type contacts_accounts, marker 'real-accounts-2026-07'):
 * one row per FW account to tag, plus 'skipped' rows for SFDC accounts with no
 * FW match (visibility). Tagging drain is resumable.
 */
const fsNode = require('fs');
const C = require('./common');
const S = require('./sfdc');
const E = require('./sync-enrich');

const MARKER = 'real-accounts-2026-07';
const ACCOUNTS_VIEW = 127029218693;   // "All Accounts"
const TAG = 'Real Account';

async function findImport(statuses) {
  const { data } = await C.supabase.from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'contacts_accounts').in('status', statuses).order('uploaded_at', { ascending: false }).limit(40);
  return (data || []).find((i) => i.mapping_json?.__marker === MARKER) || null;
}
function argLimit() { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : 0; }

// ── scan ────────────────────────────────────────────────────────────────────
async function scan() {
  if (await findImport(['mapping', 'pushing'])) { console.log('Already staged — delete or tag it.'); return; }

  console.log('Pulling real-account list from SFDC…');
  const created = await S.queryAll(
    'SELECT Id, Name, CreatedDate FROM Account WHERE CreatedDate >= 2018-01-01T00:00:00Z', (m) => console.log(m));
  // plain (pageable) opp rows, deduped client-side — GROUP BY can't queryMore past 2k
  const oppRows = await S.queryAll(
    'SELECT AccountId, Account.Name FROM Opportunity WHERE CreatedDate >= 2018-01-01T00:00:00Z AND Account.CreatedDate < 2018-01-01T00:00:00Z', (m) => console.log(m));
  const real = new Map();  // normName -> {sfId, name, why}
  for (const a of created) { const k = E.normName(a.Name); if (k && !real.has(k)) real.set(k, { sfId: a.Id, name: a.Name, why: 'created>=2018' }); }
  for (const o of oppRows) { const nm = o.Account?.Name; const k = E.normName(nm); if (k && !real.has(k)) real.set(k, { sfId: o.AccountId, name: nm, why: 'opp>=2018' }); }
  console.log(`SFDC real-account names (deduped): ${real.size}`);

  // FW deal-backed accounts (order-backed = real regardless of SFDC)
  const dealBacked = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_deal_sync').select('fw_account_id').range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) if (r.fw_account_id) dealBacked.add(String(r.fw_account_id));
    if (data.length < 1000) break;
  }
  console.log(`FW deal-backed account ids: ${dealBacked.size}`);

  const { data: imp } = await C.supabase.from('crm_imports').insert({
    import_type: 'contacts_accounts', original_filename: 'Phase 1: Real Account identification (review before tagging)',
    total_rows: 0, sheet_name: 'real-accounts', status: 'mapping', uploaded_by: 'script:real-accounts',
    mapping_json: { __marker: MARKER, tag: TAG, definition: 'SFDC acct created>=2018 OR opp>=2018 OR FW deal-backed' },
  }).select('id').single();

  console.log('Scanning all FW accounts (~3,000 pages, ~1.6h)…');
  let page = 1, scanned = 0, matched = 0, dealOnly = 0, idx = 0, consecFail = 0;
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const { error } = await C.supabase.from('crm_import_rows').insert(batch.splice(0));
    if (error) throw new Error(`stage insert failed: ${error.message}`);
  };
  const matchedKeys = new Set();
  for (;;) {
    if (page > 3600) break;
    const r = await C.fs('GET', `/sales_accounts/view/${ACCOUNTS_VIEW}?page=${page}&per_page=100`);
    if (!r.ok) { if (++consecFail > 25) throw new Error(`FW scan stalled p${page}`); page++; continue; }
    consecFail = 0;
    const rows = r.data?.sales_accounts || [];
    if (!rows.length) break;
    for (const a of rows) {
      scanned++;
      const k = E.normName(a.name);
      const sfdcHit = real.get(k);
      const isDealBacked = dealBacked.has(String(a.id));
      if (sfdcHit || isDealBacked) {
        matched++; if (!sfdcHit) dealOnly++;
        if (sfdcHit) matchedKeys.add(k);
        batch.push({
          import_id: imp.id, row_index: ++idx, status: 'pending', fs_id: String(a.id),
          raw_json: { fw_name: a.name, sf_id: sfdcHit?.sfId || null, sf_name: sfdcHit?.name || null, why: sfdcHit?.why || 'fw-deal-backed' },
        });
        if (batch.length >= 400) await flush();
      }
    }
    if (page % 200 === 0) console.log(`  page ${page} — scanned ${scanned}, matched ${matched}`);
    const total = r.data?.meta?.total_pages;
    if (total && page >= total) break;
    page++;
  }
  // SFDC reals with NO FW account at all — visibility rows
  for (const [k, v] of real) if (!matchedKeys.has(k)) {
    batch.push({ import_id: imp.id, row_index: ++idx, status: 'skipped', error_message: 'no FW account matched', raw_json: { sf_id: v.sfId, sf_name: v.name, why: v.why } });
    if (batch.length >= 400) await flush();
  }
  await flush();
  await C.supabase.from('crm_imports').update({ total_rows: idx }).eq('id', imp.id);
  console.log(`\nScan complete: ${scanned} FW accounts scanned, ${matched} matched as REAL (${dealOnly} deal-backed only), ${real.size - matchedKeys.size} SFDC reals with no FW match. IMPORT_ID=${imp.id}`);
  console.log('Next: node crm-import/real-accounts.js report');
}

// ── report ──────────────────────────────────────────────────────────────────
async function report() {
  const imp = await findImport(['mapping', 'pushing']);
  if (!imp) { console.log('Nothing staged.'); return; }
  const out = [['FW Account ID', 'FW Name', 'SFDC ID', 'SFDC Name', 'Why Real']];
  const miss = [['SFDC ID', 'SFDC Name', 'Why Real']];
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('crm_import_rows').select('fs_id,status,raw_json').eq('import_id', imp.id).range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      const j = r.raw_json;
      if (r.status === 'pending') out.push([r.fs_id, j.fw_name, j.sf_id || '', j.sf_name || '', j.why]);
      else miss.push([j.sf_id, j.sf_name, j.why]);
    }
    if (data.length < 1000) break;
  }
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const dir = process.env.REPORT_DIR || '.';
  fsNode.writeFileSync(`${dir}/real-accounts-to-tag.csv`, out.map((r) => r.map(esc).join(',')).join('\n'));
  fsNode.writeFileSync(`${dir}/sfdc-accounts-missing-in-fw.csv`, miss.map((r) => r.map(esc).join(',')).join('\n'));
  console.log(`Wrote real-accounts-to-tag.csv (${out.length - 1}) and sfdc-accounts-missing-in-fw.csv (${miss.length - 1}).`);
}

// ── tag (after approval) ────────────────────────────────────────────────────
async function tag() {
  // 'mapping' = scan still staging rows — don't drain yet, or an early
  // pending-exhaustion would mark the import complete mid-scan.
  const imp = await findImport(['ready', 'pushing']);
  if (!imp) { console.log('No finished scan to tag (still scanning, or nothing staged).'); return; }
  await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', imp.id);
  const limit = argLimit();
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);
  let done = 0, tagged = 0, failed = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('crm_import_rows').select('id, fs_id')
      .eq('import_id', imp.id).eq('status', 'pending').order('row_index', { ascending: true }).limit(200);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const now = new Date().toISOString();
      const r = await C.fs('PUT', `/sales_accounts/${row.fs_id}`, { sales_account: { tags: [TAG] } });
      if (r.ok) { await C.supabase.from('crm_import_rows').update({ status: 'sent', attempted_at: now }).eq('id', row.id); tagged++; }
      else { await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: `PUT ${r.status}`, attempted_at: now }).eq('id', row.id); failed++; }
      done++;
      if (done % 200 === 0) console.log(`  ${done} — tagged:${tagged} failed:${failed}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) { await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id); console.log('Complete.'); }
  console.log(`\nTag run: ${tagged} tagged, ${failed} failed. Pending: ${left || 0}.`);
}

const cmd = process.argv[2];
const run = { scan, report, tag }[cmd];
if (!run) { console.log('Usage: node crm-import/real-accounts.js scan|report|tag [--limit N]'); process.exit(1); }
run().catch((e) => { console.error(`REAL-ACCOUNTS ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
