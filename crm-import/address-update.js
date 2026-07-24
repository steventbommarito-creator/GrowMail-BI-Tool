/**
 * SFDC contact/account address + phone backfill (report1784900375452.csv,
 * 18,203 contact rows / 13,739 unique accounts).
 *
 *   node crm-import/address-update.js load                     # stage both imports (local, no FS calls)
 *   node crm-import/address-update.js prepare-accounts         # scan FW accounts once, build update payloads
 *   node crm-import/address-update.js prepare-contacts         # scan FW contacts once, build update/create payloads
 *   node crm-import/address-update.js drain-accounts [--limit] # PUT account updates
 *   node crm-import/address-update.js drain-contacts [--limit] # PUT updates / POST creates
 *
 * Policy (user-confirmed): FILL-ONLY-EMPTY — a field is written only when the
 * Freshworks value is blank; existing values are never overwritten. Records
 * where FW already has an address are staged 'skipped' with the reason, so
 * conflicts are reviewable. CSV contacts with no FW match are CREATED
 * (per user), linked to their account when it resolves, owner mapped by
 * Account Owner display name (with the Danielle→Dani / Stephanie aliases),
 * lifecycle Customer when Total Account Value > 0, and stamped with a
 * generated cf_lead_sf_id ('999…') like the leads import.
 *
 * Prepares avoid per-record lookups by paging the All-Contacts / All-Accounts
 * views once (~2.9k + ~3k requests) and matching in memory. Accounts prepare
 * runs FIRST so contact creates can link account ids from its results.
 *
 * CSV: ADDR_CSV (default ~/Downloads/report1784900375452.csv)
 */
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse');
const C = require('./common');
const L = require('./sfdc-leads');

const CSV = process.env.ADDR_CSV || path.join(os.homedir(), 'Downloads', 'report1784900375452.csv');
const M_CONTACTS = 'sfdc-addr-contacts-2026-07';
const M_ACCOUNTS = 'sfdc-addr-accounts-2026-07';
const CUSTOMER_LIFECYCLE = 128081818857;

const emailOf = (r) => String(r['Email'] || '').trim().toLowerCase();
const validEmail = (r) => /^\S+@\S+\.\S+$/.test(emailOf(r));
const clean = (v) => String(v ?? '').trim();

async function csvRows() {
  const out = [];
  const parser = fsNode.createReadStream(CSV).pipe(parse({
    columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
  }));
  for await (const row of parser) out.push(row);
  return out;
}

async function findImport(marker, statuses) {
  const { data } = await C.supabase
    .from('crm_imports').select('id, status, total_rows, mapping_json')
    .eq('import_type', 'contacts_accounts').in('status', statuses)
    .order('uploaded_at', { ascending: false }).limit(20);
  return (data || []).find((i) => i.mapping_json?.__marker === marker) || null;
}

function argLimit() {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
}
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 0);
const outOfTime = (started) => MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS;

// ── payload builders (exported for the pilot) ───────────────────────────────
// Contact update: fill-only-empty. fw: {address, city, work_number, mobile_number}
function buildContactUpdate(row, fw) {
  const contact = {};
  if (!clean(fw.address) && clean(row['Mailing Street'])) {
    contact.address = clean(row['Mailing Street']).slice(0, 255);
    if (clean(row['Mailing City'])) contact.city = clean(row['Mailing City']).slice(0, 100);
    if (clean(row['Mailing State/Province'])) contact.state = clean(row['Mailing State/Province']).slice(0, 100);
    if (clean(row['Mailing Zip/Postal Code'])) contact.zipcode = clean(row['Mailing Zip/Postal Code']).slice(0, 20);
    if (clean(row['Mailing Country'])) contact.country = clean(row['Mailing Country']).slice(0, 100);
  }
  if (!clean(fw.work_number) && clean(row['Phone'])) contact.work_number = clean(row['Phone']).slice(0, 30);
  if (!clean(fw.mobile_number) && clean(row['Mobile'])) contact.mobile_number = clean(row['Mobile']).slice(0, 30);
  return Object.keys(contact).length ? contact : null;
}

function buildAccountUpdate(row, fw) {
  const acct = {};
  if (!clean(fw.address) && clean(row['Billing Street'])) {
    acct.address = clean(row['Billing Street']).slice(0, 255);
    if (clean(row['Billing City'])) acct.city = clean(row['Billing City']).slice(0, 100);
    if (clean(row['Billing State/Province'])) acct.state = clean(row['Billing State/Province']).slice(0, 100);
    if (clean(row['Billing Zip/Postal Code'])) acct.zipcode = clean(row['Billing Zip/Postal Code']).slice(0, 20);
  }
  if (!clean(fw.phone) && clean(row['Phone'])) acct.phone = clean(row['Phone']).slice(0, 30);
  return Object.keys(acct).length ? acct : null;
}

function buildContactCreate(row, ownerByName, accountId) {
  const contact = {
    first_name: clean(row['First Name']).slice(0, 100) || 'Unknown',
    last_name: clean(row['Last Name']).slice(0, 100),
    emails: [{ value: emailOf(row), is_primary: true }],
    owner_id: ownerByName[clean(row['Account Owner']).toLowerCase()] || C.CS_OWNER_ID,
    custom_field: { cf_lead_sf_id: L.genSfid() },
  };
  if (clean(row['Mailing Street'])) {
    contact.address = clean(row['Mailing Street']).slice(0, 255);
    if (clean(row['Mailing City'])) contact.city = clean(row['Mailing City']).slice(0, 100);
    if (clean(row['Mailing State/Province'])) contact.state = clean(row['Mailing State/Province']).slice(0, 100);
    if (clean(row['Mailing Zip/Postal Code'])) contact.zipcode = clean(row['Mailing Zip/Postal Code']).slice(0, 20);
    if (clean(row['Mailing Country'])) contact.country = clean(row['Mailing Country']).slice(0, 100);
  }
  if (clean(row['Phone'])) contact.work_number = clean(row['Phone']).slice(0, 30);
  if (clean(row['Mobile'])) contact.mobile_number = clean(row['Mobile']).slice(0, 30);
  const title = clean(row['Title']);
  if (title) contact.job_title = title.slice(0, 100);
  const value = parseFloat(String(row['Total Account Value - Commissionable'] || '').replace(/[$,]/g, ''));
  if (Number.isFinite(value) && value > 0) contact.lifecycle_stage_id = CUSTOMER_LIFECYCLE;
  if (accountId) contact.sales_accounts = [{ id: accountId, is_primary: true }];
  return contact;
}

// ── load ────────────────────────────────────────────────────────────────────
async function load() {
  if (!fsNode.existsSync(CSV)) throw new Error(`CSV not found: ${CSV}`);
  for (const m of [M_CONTACTS, M_ACCOUNTS]) {
    const prior = await findImport(m, ['mapping', 'ready', 'pushing']);
    if (prior && !process.argv.includes('--force')) {
      console.log(`Unfinished import ${m} exists: ${prior.id}. Aborting.`);
      return;
    }
  }
  const rows = await csvRows();

  // accounts: unique by name, first row WITH a billing street wins
  const acctRow = new Map();
  for (const r of rows) {
    const name = clean(r['Account Name']);
    if (!name) continue;
    if (!acctRow.has(name) || (!clean(acctRow.get(name)['Billing Street']) && clean(r['Billing Street']))) acctRow.set(name, r);
  }

  const mk = async (marker, filename, sheet, note) => {
    const { data, error } = await C.supabase.from('crm_imports').insert({
      import_type: 'contacts_accounts', original_filename: filename, total_rows: 0,
      sheet_name: sheet, status: 'mapping', uploaded_by: process.env.TRIGGERED_BY || 'script:sfdc-addr',
      mapping_json: { __marker: marker, note },
    }).select('id').single();
    if (error) throw new Error(`create import failed: ${error.message}`);
    return data.id;
  };
  const acctImp = await mk(M_ACCOUNTS, 'SFDC billing addresses → accounts (fill-empty)', 'accounts',
    'Billing Street/City/State/Zip + Phone → account address/phone where blank. crm-import/address-update.js');
  const ctImp = await mk(M_CONTACTS, 'SFDC mailing addresses + phones → contacts (fill-empty, create missing)', 'contacts',
    'Mailing addr → contact address, Phone→work, Mobile→mobile where blank; unmatched contacts created. crm-import/address-update.js');

  const insert = async (impId, list, mapRow) => {
    let n = 0;
    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500).map((r, j) => mapRow(r, i + j + 1, impId));
      const { error } = await C.supabase.from('crm_import_rows').insert(batch);
      if (error) throw new Error(`row insert failed @${i}: ${error.message}`);
      n += batch.length;
    }
    await C.supabase.from('crm_imports').update({ total_rows: n }).eq('id', impId);
    return n;
  };
  const nA = await insert(acctImp, [...acctRow.values()], (r, idx, imp) => ({
    import_id: imp, row_index: idx, raw_json: r, status: 'pending',
  }));
  const nC = await insert(ctImp, rows, (r, idx, imp) => ({
    import_id: imp, row_index: idx, raw_json: r,
    status: validEmail(r) ? 'pending' : 'skipped',
    error_message: validEmail(r) ? null : 'no valid email',
  }));
  console.log(`Staged accounts: ${nA} (IMPORT_ID=${acctImp})`);
  console.log(`Staged contacts: ${nC} (IMPORT_ID=${ctImp})`);
}

// ── shared view scan ────────────────────────────────────────────────────────
async function scanView(entity, listKey, pick, log) {
  const f = await C.fs('GET', `/${entity}/filters`);
  if (!f.ok) throw new Error(`${entity} filters failed: ${f.error}`);
  const views = f.data.filters || [];
  const view = views.find((v) => /^all /i.test(String(v.name || ''))) || views[0];
  const out = new Map();
  let page = 1, total = null, consecFail = 0;
  for (;;) {
    if (page > 6000) break;
    const r = await C.fs('GET', `/${entity}/view/${view.id}?page=${page}&per_page=100`);
    if (!r.ok) {
      if (++consecFail > 25) throw new Error(`${entity} scan stalled near page ${page}: ${r.error}`);
      page++; continue;
    }
    consecFail = 0;
    const rows = r.data[listKey] || [];
    if (!rows.length) break;
    for (const row of rows) pick(out, row);
    total = r.data.meta?.total_pages || total;
    if (page % 200 === 0 || (total && page >= total)) log(`  ${entity} page ${page}${total ? '/' + total : ''} — ${out.size} keys`);
    if (total && page >= total) break;
    page++;
  }
  return out;
}

// ── prepare: accounts ───────────────────────────────────────────────────────
async function prepareAccounts() {
  const imp = await findImport(M_ACCOUNTS, ['mapping', 'ready']);
  if (!imp) { console.log('No accounts import in mapping state (already prepared or not loaded).'); return; }
  console.log(`Preparing accounts import ${imp.id} — scanning FW accounts…`);
  const fwByName = await scanView('sales_accounts', 'sales_accounts', (m, a) => {
    const k = clean(a.name).toLowerCase();
    if (!k) return;
    if (m.has(k)) m.get(k).dup = true; // 2+ FW accounts share this name — too ambiguous to update
    else m.set(k, { id: a.id, address: a.address, phone: a.phone });
  }, console.log);
  console.log(`${fwByName.size} FW account names.`);

  const stats = { update: 0, hasAddress: 0, notFound: 0, noData: 0, ambiguous: 0 };
  let done = 0;
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).is('normalized_json', null).eq('status', 'pending')
      .order('row_index', { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = row.raw_json;
      const fw = fwByName.get(clean(r['Account Name']).toLowerCase());
      let patch = null;
      if (!fw) {
        stats.notFound++;
        await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: 'account not in Freshworks' }).eq('id', row.id);
      } else if (fw.dup) {
        stats.ambiguous++;
        await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: 'multiple FW accounts share this name — not updated' }).eq('id', row.id);
      } else if (!(patch = buildAccountUpdate(r, fw))) {
        const reason = clean(fw.address) ? 'already has address (+phone or none in CSV)' : 'no billing address/phone in CSV';
        clean(fw.address) ? stats.hasAddress++ : stats.noData++;
        await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: reason, fs_id: String(fw.id) }).eq('id', row.id);
      } else {
        stats.update++;
        await C.supabase.from('crm_import_rows').update({ normalized_json: { action: 'update', id: fw.id, sales_account: patch } }).eq('id', row.id);
      }
      done++;
      if (done % 1000 === 0) console.log(`  classified ${done} — ${JSON.stringify(stats)}`);
    }
  }
  await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', imp.id);
  console.log(`\nAccounts prepare complete: ${JSON.stringify(stats)}. status=pushing`);
}

// ── prepare: contacts ───────────────────────────────────────────────────────
async function prepareContacts() {
  const imp = await findImport(M_CONTACTS, ['mapping', 'ready']);
  if (!imp) { console.log('No contacts import in mapping state (already prepared or not loaded).'); return; }
  console.log(`Preparing contacts import ${imp.id} — scanning FW contacts…`);
  const fwByEmail = await scanView('contacts', 'contacts', (m, c) => {
    const rec = { id: c.id, address: c.address, work_number: c.work_number, mobile_number: c.mobile_number };
    const keys = [String(c.email || '').toLowerCase()];
    for (const e of c.emails || []) keys.push(String((e && e.value) || e || '').toLowerCase());
    for (const k of keys) if (k && !m.has(k)) m.set(k, rec);
  }, console.log);
  console.log(`${fwByEmail.size} FW contact emails.`);

  // account ids from the (already-prepared) accounts import, for create-links
  const acctIdByName = new Map();
  const acctImp = await findImport(M_ACCOUNTS, ['pushing', 'complete']);
  if (acctImp) {
    for (let from = 0; ; from += 1000) {
      const { data } = await C.supabase.from('crm_import_rows')
        .select('raw_json, fs_id, normalized_json').eq('import_id', acctImp.id).range(from, from + 999);
      if (!data || !data.length) break;
      for (const r of data) {
        const id = r.normalized_json?.id || (r.fs_id ? Number(r.fs_id) : null);
        if (id) acctIdByName.set(clean(r.raw_json['Account Name']).toLowerCase(), id);
      }
      if (data.length < 1000) break;
    }
  }
  const ownerByName = await L.buildOwnerByName();

  const stats = { update: 0, create: 0, noop: 0, dupEmail: 0 };
  const seen = new Set();
  let done = 0;
  for (;;) {
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, raw_json')
      .eq('import_id', imp.id).is('normalized_json', null).eq('status', 'pending')
      .order('row_index', { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const r = row.raw_json;
      const email = emailOf(r);
      if (seen.has(email)) {
        stats.dupEmail++;
        await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: 'duplicate email in CSV' }).eq('id', row.id);
        done++; continue;
      }
      seen.add(email);
      const fw = fwByEmail.get(email);
      if (fw) {
        const patch = buildContactUpdate(r, fw);
        if (patch) {
          stats.update++;
          await C.supabase.from('crm_import_rows').update({ normalized_json: { action: 'update', id: fw.id, contact: patch } }).eq('id', row.id);
        } else {
          stats.noop++;
          await C.supabase.from('crm_import_rows').update({ status: 'skipped', error_message: 'nothing to fill (already populated or no data in CSV)', fs_id: String(fw.id) }).eq('id', row.id);
        }
      } else {
        stats.create++;
        const accountId = acctIdByName.get(clean(r['Account Name']).toLowerCase()) || null;
        const contact = buildContactCreate(r, ownerByName, accountId);
        await C.supabase.from('crm_import_rows').update({ normalized_json: { action: 'create', contact } }).eq('id', row.id);
      }
      done++;
      if (done % 1000 === 0) console.log(`  classified ${done} — ${JSON.stringify(stats)}`);
    }
  }
  await C.supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', imp.id);
  console.log(`\nContacts prepare complete: ${JSON.stringify(stats)}. status=pushing`);
}

// ── drains ──────────────────────────────────────────────────────────────────
async function drainGeneric(marker, send, label) {
  const imp = await findImport(marker, ['pushing']);
  if (!imp) { console.log(`No ${label} import in pushing state.`); return; }
  const limit = argLimit();
  console.log(`Draining ${label} import ${imp.id}${limit ? ` (limit ${limit})` : ''}…`);
  const { data: batch } = await C.supabase
    .from('crm_import_batches').insert({ import_id: imp.id, requested_size: limit || 0, status: 'running', triggered_by: `script:addr-${label}-drain` })
    .select('id').single();
  let sent = 0, failed = 0;
  const started = Date.now();
  outer: for (;;) {
    if (outOfTime(started)) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows, error } = await C.supabase
      .from('crm_import_rows').select('id, normalized_json')
      .eq('import_id', imp.id).eq('status', 'pending').not('normalized_json', 'is', null)
      .order('row_index', { ascending: true }).limit(200);
    if (error) throw new Error(error.message);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const res = await send(row.normalized_json);
      const now = new Date().toISOString();
      if (res.ok) {
        await C.supabase.from('crm_import_rows').update({ status: 'sent', fs_id: String(res.id), error_message: res.note || null, attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        sent++;
      } else {
        await C.supabase.from('crm_import_rows').update({ status: 'failed', error_message: res.error.slice(0, 250), attempted_at: now, batch_id: batch?.id }).eq('id', row.id);
        failed++;
      }
      if ((sent + failed) % 200 === 0) console.log(`  ${sent} sent, ${failed} failed`);
      if (limit && sent + failed >= limit) break outer;
      if (outOfTime(started)) { console.log('Runtime budget reached — exiting (resumable).'); break outer; }
    }
  }
  await C.supabase.from('crm_import_batches').update({ status: 'complete', actual_size: sent + failed, stats_json: { sent, failed, skipped: 0 }, completed_at: new Date().toISOString() }).eq('id', batch?.id);
  const { count: left } = await C.supabase.from('crm_import_rows').select('id', { count: 'exact', head: true }).eq('import_id', imp.id).eq('status', 'pending');
  if (!left) {
    await C.supabase.from('crm_imports').update({ status: 'complete', completed_at: new Date().toISOString() }).eq('id', imp.id);
    console.log('All rows processed — import marked complete.');
  }
  console.log(`\nBatch done: ${sent} sent, ${failed} failed. Pending remaining: ${left || 0}.`);
}

const drainAccounts = () => drainGeneric(M_ACCOUNTS, async (n) => {
  const r = await C.fs('PUT', `/sales_accounts/${n.id}`, { sales_account: n.sales_account });
  return r.ok ? { ok: true, id: n.id } : { ok: false, error: `HTTP ${r.status}: ${r.error || ''}` };
}, 'accounts');

const drainContacts = () => drainGeneric(M_CONTACTS, async (n) => {
  if (n.action === 'update') {
    const r = await C.fs('PUT', `/contacts/${n.id}`, { contact: n.contact });
    return r.ok ? { ok: true, id: n.id, note: 'updated' } : { ok: false, error: `HTTP ${r.status}: ${r.error || ''}` };
  }
  const r = await C.fs('POST', '/contacts', { contact: n.contact });
  return r.ok && r.data?.contact?.id ? { ok: true, id: r.data.contact.id, note: 'created' } : { ok: false, error: `HTTP ${r.status}: ${r.error || ''}` };
}, 'contacts');

module.exports = { buildContactUpdate, buildAccountUpdate, buildContactCreate };

if (require.main === module) {
  const cmd = process.argv[2];
  const run = {
    load, 'prepare-accounts': prepareAccounts, 'prepare-contacts': prepareContacts,
    'drain-accounts': drainAccounts, 'drain-contacts': drainContacts,
  }[cmd];
  if (!run) {
    console.log('Usage: node crm-import/address-update.js load|prepare-accounts|prepare-contacts|drain-accounts|drain-contacts [--limit N] [--force]');
    process.exit(1);
  }
  run().catch((e) => { console.error(`ADDR ${cmd.toUpperCase()} FAILED:`, e.message); process.exit(1); });
}
