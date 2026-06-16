/**
 * CRM Imports — Excel → Freshworks bulk loader.
 *
 * Pipeline:
 *   1. parseExcel(buffer) — read .xlsx/.csv, return { columns, rows }
 *   2. Upload row data into crm_import_rows (status='pending')
 *   3. User maps Excel columns → FS fields in the UI, saves mapping_json
 *   4. User clicks "Push N rows" → pushBatch picks N pending rows, normalizes
 *      each row, calls FS bulk_upsert in chunks of 100, polls each job,
 *      writes the result back per row.
 *
 * Normalization (auto-applied per row before push):
 *   - Excel serial dates → ISO YYYY-MM-DD
 *   - Smart quotes / em dashes / non-ASCII → ASCII equivalents
 *   - Phone: strip non-digits except leading +
 *   - Email: lowercase + trim
 *   - Trim all string whitespace
 *   - Empty strings → null
 *   - Currency strings ($1,234.56) → number
 *
 * Rate-limit aware: tasks are slow (no bulk endpoint, 1000/hr cap); bulk types
 * see roughly 100,000 records/hr. We don't sleep inside the engine — the
 * scheduler is the user clicking "Push N" — but we DO surface ETA estimates
 * to the UI so the user knows what they're committing to.
 */

const XLSX = require('xlsx');
const fw = require('./freshworks');

const BULK_BATCH_SIZE = 100;        // FS hard limit per bulk_upsert call
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 40;       // ~60s total

// ─── Excel parsing ──────────────────────────────────────────────────────────

/**
 * Parse an Excel (.xlsx/.xls) or CSV buffer. Returns:
 *   { columns: ['Name', 'Email', ...], rows: [{Name: '...', Email: '...'}, ...] }
 * Drops fully-empty rows. Preserves Excel date serials (we'll normalize on push).
 */
function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) throw new Error('Workbook has no sheets');
  const sheet = wb.Sheets[firstSheet];

  // header:1 returns array-of-arrays so we can capture the exact header row.
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (aoa.length === 0) return { sheetName: firstSheet, columns: [], rows: [] };

  const headers = aoa[0].map(h => String(h ?? '').trim()).filter(Boolean);
  const seen = new Set();
  const columns = headers.map(h => {
    // Dedupe duplicate column names so JSON keys don't collide.
    let name = h, i = 2;
    while (seen.has(name)) { name = `${h} (${i++})`; }
    seen.add(name);
    return name;
  });

  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row || row.every(c => c === '' || c == null)) continue;
    const obj = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = row[c] ?? null;
    }
    rows.push(obj);
  }

  return { sheetName: firstSheet, columns, rows };
}

// ─── Normalization ──────────────────────────────────────────────────────────

// Excel serial → ISO date. Excel's epoch is 1900-01-01, with a leap-year bug
// for Feb 29 1900 — we replicate Excel's intent (subtract the bug day).
function excelSerialToISO(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 60) return null;     // negative / 0 / too small
  const ms = (num - 25569) * 86400 * 1000;                 // 25569 = days from 1900-01-01 to 1970-01-01 (Excel bug-adjusted)
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function looksLikeDate(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s);
}

function parseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToISO(v);
  const s = String(v).trim();
  if (looksLikeDate(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return s;   // give up — let FS reject it; we log the source value
}

// Strip smart quotes, em dashes, NBSPs, zero-width chars. Lossy on purpose:
// FS rejects a lot of non-ASCII silently or partially, and these are the
// usual culprits when pasting from Word / Google Docs.
const CHAR_REPLACEMENTS = [
  [/[‘’‚‛]/g, "'"],   // curly single quotes
  [/[“”„‟]/g, '"'],   // curly double quotes
  [/[–—]/g, '-'],                // en/em dashes
  [/[…]/g, '...'],                    // ellipsis
  [/[ ]/g, ' '],                      // non-breaking space
  [/[​-‍﻿]/g, ''],          // zero-width chars
];
function cleanString(s) {
  let out = String(s);
  for (const [pat, rep] of CHAR_REPLACEMENTS) out = out.replace(pat, rep);
  return out.trim();
}

function normalizeEmail(v) {
  if (v == null || v === '') return null;
  const s = cleanString(v).toLowerCase();
  return /^\S+@\S+\.\S+$/.test(s) ? s : s; // keep even invalid emails — FS may reject, we log
}

function normalizePhone(v) {
  if (v == null || v === '') return null;
  const s = cleanString(v);
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  return hasPlus ? `+${digits}` : digits;
}

function normalizeCurrency(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$,\s]/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one row's raw_json into a FS-bound payload.
 * `mapping` is { "Excel Column Name": "fs_field_name", ... }.
 * `type` is one of contacts_accounts | leads | opportunities | tasks.
 *
 * Returns { normalized, errors[] }. errors is non-empty when a required
 * field is missing or fails validation — caller sets the row to
 * 'validation_failed' so it never hits FS.
 */
function normalizeRow(raw, mapping, type, schemaIndex, valueMappings, staticValues) {
  const normalized = {};
  const errors = [];

  // Value mapping helper. Looks up the raw Excel value against per-(col, field)
  // rules the user has set. Returns:
  //   { skip: true }                          — explicit "don't send this field"
  //   { override: true, value: <translated> } — replace the raw value
  //   { override: false }                     — no rule, pass through unchanged
  const applyValueMap = (excelCol, fsField, value) => {
    const rules = valueMappings?.[excelCol]?.[fsField];
    if (!rules) return { override: false };
    // Case-sensitive first (exact), then case-insensitive fallback for forgiveness.
    // The __fallback__ key is reserved for the on-miss fallback applied later,
    // never used for per-value lookup.
    let target;
    if (value === '__fallback__') return { override: false };
    if (Object.prototype.hasOwnProperty.call(rules, value)) target = rules[value];
    else {
      const lc = String(value).toLowerCase().trim();
      const hit = Object.keys(rules).find(k => k !== '__fallback__' && k.toLowerCase().trim() === lc);
      if (hit !== undefined) target = rules[hit];
      else return { override: false };
    }
    if (target === null) return { skip: true };       // explicit skip
    return { override: true, value: target };
  };

  // Apply column→field mapping with per-field normalization based on fs_field_name.
  //
  // DATA-SAFETY RULE: never send null/empty values in the upsert payload. If
  // the Excel cell is empty, OMIT the field entirely so FS keeps whatever
  // value it already had. Without this, a re-upload of a partial spreadsheet
  // would wipe filled-in FS fields on the second pass (FS upsert semantics
  // are: present-in-payload = overwrite, absent = leave alone). Users who
  // actually want to clear a field can do so in FS directly.
  //
  // MULTI-FIELD MAPPING: each excel column maps to ONE OR MORE fs fields.
  // The UI stores the value as an array; old mappings (just a string) are
  // accepted for backward compat. Same Excel value goes to every target,
  // each one normalized independently based on its own field name (so a
  // 'phone' column mapped to both 'mobile_number' and 'work_number' gets
  // phone-normalized once per destination).
  for (const [excelCol, mappedValue] of Object.entries(mapping || {})) {
    const v = raw[excelCol];
    if (v == null || v === '') continue;   // skip empty cells — preserves existing FS data

    // Normalize the mapping shape to an array of field names.
    const fsFields = Array.isArray(mappedValue) ? mappedValue : [mappedValue];
    for (const fsField of fsFields) {
      if (!fsField || fsField === '__skip__') continue;

      // Pick the normalization strategy. Prefer the FS field's actual type
      // when we have it (from the schema index) so we don't, for example,
      // try to parse a text-typed cf_create_date column whose values are
      // raw strings the user wants preserved as-is.
      const fsType = schemaIndex?.fieldTypes?.get(fsField);
      let cleaned;
      if (fsType === 'date' || fsType === 'datetime') {
        cleaned = parseDate(v);
      } else if (fsType === 'checkbox') {
        // FS checkboxes need booleans. Excel often stores 0/1, "yes"/"no",
        // "true"/"false" — coerce defensively. Treat blank/0/no/false as false,
        // everything else as true.
        if (typeof v === 'boolean') cleaned = v;
        else {
          const s = String(v).trim().toLowerCase();
          cleaned = !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'n');
        }
      } else if (fsType === 'number') {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
        cleaned = Number.isFinite(n) ? n : null;
      } else if (/email/i.test(fsField))                 cleaned = normalizeEmail(v);
      else if (/phone|mobile/i.test(fsField))            cleaned = normalizePhone(v);
      else if (/amount|value|price|revenue/i.test(fsField)) cleaned = normalizeCurrency(v);
      else if (typeof v === 'string')                    cleaned = cleanString(v);
      else                                               cleaned = v;

      // Even after normalization, a value could become null (e.g. unparseable
      // date or invalid currency). Same rule: skip rather than wipe.
      if (cleaned == null || cleaned === '') continue;

      // Value mapping — apply the user's per-import translation rules BEFORE
      // dropdown resolution. Lets the user say "when this column has 'Not
      // Ready', send 'Interested' to FS" so messy source data lines up with
      // the FS canonical choices. Null target = drop the field on this row.
      const vm = applyValueMap(excelCol, fsField, cleaned);
      if (vm.skip) continue;
      if (vm.override) cleaned = vm.value;

      // Dropdown text→ID resolution. If this field is a dropdown
      // (or multi_select_dropdown) in the FS schema, convert the label to
      // the choice ID — FS rejects payloads where dropdowns carry text. On
      // miss, fall back to the user-configured __fallback__ rule if present
      // (so unknown owner names roll up to "Customer Service" etc.).
      if (schemaIndex) {
        const r = resolveDropdownValue(fsField, cleaned, schemaIndex);
        if (!r.ok) {
          // Try fallback: a special __fallback__ rule under value_mappings.
          const fallback = valueMappings?.[excelCol]?.[fsField]?.__fallback__;
          if (fallback === null) continue;   // explicit "skip on miss"
          if (fallback !== undefined && fallback !== '') {
            const fr = resolveDropdownValue(fsField, fallback, schemaIndex);
            if (fr.ok) { cleaned = fr.value; normalized[fsField] = cleaned; continue; }
            errors.push(`${fsField}: fallback "${fallback}" also unresolved (${r.error})`);
            continue;
          }
          errors.push(r.error);
          continue;
        }
        cleaned = r.value;
      }
      normalized[fsField] = cleaned;
    }
  }

  // ── Status → Lifecycle auto-derive ─────────────────────────────────────
  // FS doesn't enforce the lifecycle/status pairing at the API layer, so when
  // the user mapped a column to Status (contact_status_id) but did NOT also
  // map a column to lifecycle_stage_id, we look up the status's parent
  // lifecycle in the schema index (from /selector/contact_statuses) and set
  // it ourselves. Mapping just Status → "Qualified" now correctly lands the
  // contact in the "Sales Qualified Lead" lifecycle.
  if (schemaIndex && normalized.contact_status_id != null && normalized.lifecycle_stage_id == null) {
    const lifecycle = schemaIndex.statusToLifecycle.get(normalized.contact_status_id);
    if (lifecycle != null) normalized.lifecycle_stage_id = lifecycle;
  }

  // Per-type required-field validation. Match the unique_identifier used in
  // the bulk_upsert calls — without these we can't dedup, FS rejects the row.
  //
  // EMAIL FIELD NAME GOTCHA: the FS field name is `emails` (it's a
  // group_field that can hold multiple addresses), not `email`. The user's
  // mapping correctly targets `emails` because that's what shows up in our
  // schema dropdown — so the value lives under normalized.emails. Accept
  // either key here so we don't false-positive "email is required" on every
  // row when the mapping is actually correct.
  if (type === 'contacts_accounts' || type === 'leads') {
    if (!normalized.email && !normalized.emails) errors.push('email is required');
  }
  if (type === 'opportunities') {
    // We use cf_order_id as the FS unique identifier (see bulkUpsertDeals).
    const orderId = normalized['custom_field.cf_order_id'] || normalized.cf_order_id || normalized.order_id;
    if (!orderId) errors.push('order_id is required');
  }
  if (type === 'tasks') {
    if (!normalized.title) errors.push('title is required');
  }

  // ── Static values: ALWAYS override whatever the per-row mapping produced ──
  // Applies last so the user's "every row in this batch is Sales Qualified
  // Lead" rule beats anything the Excel column would have set. For dropdown
  // fields, the saved value is the label — we resolve it through the same
  // text→ID path the per-row mapping uses, including value-mapping rules.
  if (staticValues && schemaIndex) {
    for (const [fsField, raw] of Object.entries(staticValues)) {
      if (raw == null || raw === '') { delete normalized[fsField]; continue; }
      let val = raw;
      // Apply the value mapping if a rule exists for THIS field's static value
      // (rare but harmless to support — keeps everything composable).
      // We synthesize a fake excel column key so the existing helper works.
      const fakeCol = `__static__:${fsField}`;
      const vm = applyValueMap(fakeCol, fsField, val);
      if (vm.skip) { delete normalized[fsField]; continue; }
      if (vm.override) val = vm.value;
      // Dropdown resolution (text → id) — same as the per-row path.
      if (schemaIndex.dropdownChoices.has(fsField)) {
        const r = resolveDropdownValue(fsField, val, schemaIndex);
        if (!r.ok) { errors.push(`static[${fsField}]: ${r.error}`); continue; }
        val = r.value;
      }
      // Checkbox / number static values: coerce same as per-row path.
      const fsType = schemaIndex.fieldTypes.get(fsField);
      if (fsType === 'checkbox' && typeof val !== 'boolean') {
        const s = String(val).trim().toLowerCase();
        val = !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'n');
      }
      normalized[fsField] = val;
    }
  }

  // FS group_field shaping. emails / phone_numbers expect arrays of objects
  // on bulk_upsert; a bare string is rejected. We also include the type
  // subfield (Work for emails, Other for phone_numbers) because some FS
  // tenants reject the items without it.
  const groupFieldShapers = {
    emails:        v => [{ value: String(v), is_primary: true, email_type: 'Work' }],
    phone_numbers: v => [{ value: String(v), is_primary: true, phone_type: 'Other' }],
  };
  for (const [field, shape] of Object.entries(groupFieldShapers)) {
    if (normalized[field] != null && !Array.isArray(normalized[field])) {
      normalized[field] = shape(normalized[field]);
    }
  }

  return { normalized, errors };
}

// ─── External-ID → FS Account lookup (for contacts_accounts type) ──────────

/**
 * Ensure an FS Account exists for the given external_id. Returns the FS
 * account id (string). Strategy:
 *   1. Look up our local crm_account_external_ids table — if found, return.
 *   2. Otherwise, upsert the account in FS by name, store the mapping, return.
 *
 * `accountFields` is the FS-shaped account payload (name + custom fields).
 * `externalId` is the user-assigned key from the Excel.
 */
async function ensureAccount(supabase, externalId, accountFields, ctx) {
  // 1. local cache
  const { data: cached } = await supabase
    .from('crm_account_external_ids')
    .select('fs_account_id')
    .eq('external_id', externalId)
    .maybeSingle();
  if (cached?.fs_account_id) return cached.fs_account_id;

  // 2. push to FS (single-account upsert is fine here — accounts are usually
  //    1-per-many-contacts, so volume is much lower than contacts).
  const res = await fw.bulkUpsertAccounts(supabase, [accountFields]);
  if (!res.ok) throw new Error(`Account upsert failed: ${res.error}`);

  // FS bulk_upsert is async; we poll the job to get the created account id.
  const jobId = res.data?.bulk_upsert_job?.id || res.data?.id;
  const fsId = await pollForResultId(supabase, jobId, 'sales_accounts');
  if (!fsId) throw new Error(`Account upsert job ${jobId} returned no id`);

  await supabase.from('crm_account_external_ids').upsert({
    external_id: externalId,
    fs_account_id: String(fsId),
    fs_account_name: accountFields.name || null,
    created_by: ctx?.triggeredBy || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'external_id' });
  return String(fsId);
}

// ─── Bulk job polling ───────────────────────────────────────────────────────

/**
 * Poll a single FS bulk job until it's finished. Returns the job payload, or
 * throws on timeout / job failure.
 */
async function pollJob(supabase, jobId) {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const r = await fw.getBulkJob(supabase, jobId);
    if (!r.ok) throw new Error(`Job ${jobId} poll failed: ${r.error}`);
    const job = r.data?.bulk_upsert_job || r.data?.job || r.data;
    const status = job?.status;
    if (status === 'finished' || status === 'completed' || status === 'success') return job;
    if (status === 'failed' || status === 'error')   throw new Error(`Job ${jobId} failed: ${JSON.stringify(job?.errors || job)}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Job ${jobId} timed out after ${POLL_MAX_ATTEMPTS} polls`);
}

async function pollForResultId(supabase, jobId, entityKey) {
  const job = await pollJob(supabase, jobId);
  // FS returns either job.records or job.created/updated arrays — try both
  const recs = job?.records || job?.[entityKey] || [];
  return recs[0]?.id || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── FS schema index — text→ID resolution for dropdown fields ──────────────
//
// FS dropdown / multi_select_dropdown fields require the numeric choice ID on
// upsert, not the human label. Excel rows have the label ("Qualified"), so
// before pushing we need to translate. This builds a per-field choice map
// keyed by lowercased label so the lookup is case-insensitive and tolerant
// of weird spreadsheet capitalization.
//
// For contact imports it also pulls the contact_statuses selector, which
// gives us each status's parent lifecycle_stage_id. Used by pushBatch to
// auto-set lifecycle_stage_id when the user mapped Status but not Lifecycle.

async function buildSchemaIndex(supabase, importType) {
  // dropdownChoices:   Map<fs_field_name, Map<label_lowercase, choice_id>>
  // dropdownLabels:    Map<fs_field_name, comma_separated_label_list> (for errors)
  // multiSelectFields: Set<fs_field_name>  — types that expect an array of IDs
  // statusToLifecycle: Map<status_id, lifecycle_id> (contact imports only)
  // fieldTypes:        Map<fs_field_name, fs_type_string>
  //                    Used to gate per-type normalization: only parse dates
  //                    when the FS field is actually a date/datetime type,
  //                    only coerce booleans when it's a checkbox, etc. The
  //                    field-name regex our engine used to use was too greedy
  //                    (any field with 'date' in the name got date-parsed,
  //                    even text-typed cf_* columns that store raw strings).
  const index = {
    dropdownChoices:   new Map(),
    dropdownLabels:    new Map(),
    multiSelectFields: new Set(),
    statusToLifecycle: new Map(),
    fieldTypes:        new Map(),
  };

  const addFields = (fields, group) => {
    for (const f of fields || []) {
      // Record the FS type for every field so the normalizer can branch on it.
      if (f.name && f.type) index.fieldTypes.set(f.name, f.type);
      if (f.type !== 'dropdown' && f.type !== 'multi_select_dropdown') continue;
      if (!Array.isArray(f.choices) || f.choices.length === 0) continue;
      const m = new Map();
      const labels = [];
      for (const c of f.choices) {
        const label = (c.value || c.name || '').toString();
        const id    = c.id;
        if (label && id != null) {
          m.set(label.toLowerCase().trim(), id);
          labels.push(label);
        }
      }
      // namespace by field name; if a contact and account share a field name
      // (rare but possible), the group prefix isn't needed because the engine
      // already keys by fs_field_name which is unique within an entity.
      index.dropdownChoices.set(f.name, m);
      index.dropdownLabels.set(f.name, labels.join(', '));
      if (f.type === 'multi_select_dropdown') index.multiSelectFields.add(f.name);
    }
  };

  if (importType === 'contacts_accounts' || importType === 'leads') {
    const [c, a, statuses] = await Promise.all([
      fw.getContactFields(supabase),
      importType === 'contacts_accounts' ? fw.getAccountFields(supabase) : Promise.resolve({ ok: true, data: { fields: [] } }),
      fw.listContactStatuses(supabase),
    ]);
    if (c.ok) addFields(c.data?.fields, 'contact');
    if (a.ok) addFields(a.data?.fields, 'account');
    if (statuses.ok) {
      for (const s of statuses.data?.contact_statuses || []) {
        if (s.id != null && s.lifecycle_stage_id != null) {
          index.statusToLifecycle.set(s.id, s.lifecycle_stage_id);
        }
      }
    }
  } else if (importType === 'opportunities') {
    const d = await fw.getDealFields(supabase);
    if (d.ok) addFields(d.data?.fields, 'deal');
  } else if (importType === 'tasks') {
    const t = await fw.getTaskFields(supabase);
    if (t.ok) addFields(t.data?.fields, 'task');
  }
  return index;
}

// Resolve a single value against the choice map for a given field. Returns
// { ok: true, value } on hit, { ok: false, error } on miss. Multi-select
// values can be a comma- or semicolon-separated string; each part is resolved
// independently.
function resolveDropdownValue(fsField, rawValue, index) {
  const choices = index.dropdownChoices.get(fsField);
  if (!choices) return { ok: true, value: rawValue };   // not a dropdown — pass through
  const isMulti = index.multiSelectFields.has(fsField);

  const resolveOne = (s) => {
    const key = String(s).toLowerCase().trim();
    if (!key) return null;
    return choices.has(key) ? choices.get(key) : undefined;  // undefined = not found
  };

  if (isMulti) {
    const parts = String(rawValue).split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const ids = [];
    const unresolved = [];
    for (const p of parts) {
      const r = resolveOne(p);
      if (r === undefined) unresolved.push(p);
      else if (r !== null) ids.push(r);
    }
    if (unresolved.length) {
      return { ok: false, error: `${fsField}: "${unresolved.join(', ')}" not in choices (${index.dropdownLabels.get(fsField)})` };
    }
    return { ok: true, value: ids };
  }
  // Single-select
  const r = resolveOne(rawValue);
  if (r === undefined) {
    return { ok: false, error: `${fsField}: "${rawValue}" not in choices (${index.dropdownLabels.get(fsField)})` };
  }
  return { ok: true, value: r };
}

// ─── pushBatch — the user-triggered "Send N rows" operation ────────────────

/**
 * Pull N pending rows from the import, normalize, push to FS in bulk chunks,
 * write status back. Designed to be called from /api/crm/imports/[id]/push.
 *
 * Returns { sent, failed, skipped, batchId, errors[] }.
 */
async function pushBatch(supabase, importId, count, ctx) {
  // 0. Load import metadata
  const { data: imp, error: impErr } = await supabase
    .from('crm_imports')
    .select('*')
    .eq('id', importId)
    .single();
  if (impErr || !imp) throw new Error(`Import ${importId} not found: ${impErr?.message}`);
  const mapping = imp.mapping_json || {};

  // 1. Open a batch record
  const { data: batch, error: bErr } = await supabase
    .from('crm_import_batches')
    .insert({
      import_id: importId,
      requested_size: count,
      status: 'running',
      triggered_by: ctx?.triggeredBy || 'unknown',
    })
    .select()
    .single();
  if (bErr) throw new Error(`Failed to open batch: ${bErr.message}`);
  const batchId = batch.id;

  // 2. Claim N pending rows. PostgREST caps any single response at ~1000
  //    rows, so we paginate to handle larger pushes (87k contacts, etc.).
  //    Three phases:
  //      a) Page through pending IDs in 1k chunks until we've collected `count`
  //      b) Single bulk-update to claim them all (batch_id + status='validating')
  //      c) Page through to fetch the full row data for processing
  //    Doing IDs-first avoids the race where reading pages of pending rows
  //    while updating them shifts what counts as 'pending' mid-iteration.
  const PAGE = 1000;
  const claimedIds = [];
  let offset = 0;
  while (claimedIds.length < count) {
    const need = Math.min(PAGE, count - claimedIds.length);
    const { data: idPage } = await supabase
      .from('crm_import_rows')
      .select('id')
      .eq('import_id', importId)
      .eq('status', 'pending')
      .order('row_index', { ascending: true })
      .range(offset, offset + need - 1);
    if (!idPage?.length) break;
    claimedIds.push(...idPage.map(r => r.id));
    if (idPage.length < need) break;
    offset += need;
  }
  if (claimedIds.length === 0) {
    await supabase.from('crm_import_batches').update({
      status: 'complete', actual_size: 0,
      stats_json: { sent: 0, failed: 0, skipped: 0 },
      completed_at: new Date().toISOString(),
    }).eq('id', batchId);
    return { sent: 0, failed: 0, skipped: 0, batchId };
  }

  // Phase b — claim every ID we collected in one bulk update.
  await supabase.from('crm_import_rows')
    .update({ batch_id: batchId, status: 'validating' })
    .in('id', claimedIds);

  // Phase c — fetch the full row data for the claimed IDs, in 1k chunks
  // because .in() can hit the same row cap.
  const pendingRows = [];
  for (let i = 0; i < claimedIds.length; i += PAGE) {
    const chunk = claimedIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('crm_import_rows')
      .select('*')
      .in('id', chunk);
    if (data) pendingRows.push(...data);
  }
  // Keep ordering stable for deterministic processing
  pendingRows.sort((a, b) => a.row_index - b.row_index);

  // Build the FS schema index (dropdown choice maps + status→lifecycle table)
  // once for the whole batch. Cheap — one API call per entity type — and the
  // result is reused for every row's normalization. Without this, dropdown
  // mappings ship raw text and FS rejects every row.
  const schemaIndex = await buildSchemaIndex(supabase, imp.import_type);

  // Per-import value mappings: { excel_col: { fs_field: { raw_value: target } } }
  const valueMappings = imp.value_mappings_json || {};
  // Per-import static field values: { fs_field: value } — overrides per-row mapping.
  const staticValues = imp.static_values_json || {};

  // 3. Normalize each row and split into FS-bound chunks
  const normResults = pendingRows.map(r => {
    const nr = normalizeRow(r.raw_json, mapping, imp.import_type, schemaIndex, valueMappings, staticValues);
    return { row: r, ...nr };
  });

  // Mark validation_failed rows immediately; don't send them
  const valid = [];
  let failed = 0;
  for (const { row, normalized, errors } of normResults) {
    if (errors.length > 0) {
      await supabase.from('crm_import_rows').update({
        normalized_json: normalized,
        status: 'validation_failed',
        error_message: errors.join('; '),
        attempt_count: row.attempt_count + 1,
        attempted_at: new Date().toISOString(),
      }).eq('id', row.id);
      failed++;
    } else {
      valid.push({ row, normalized });
    }
  }

  let sent = 0;
  const errors = [];

  // 4. Per-type push logic
  if (imp.import_type === 'tasks') {
    // No bulk endpoint — one-at-a-time. Slow.
    for (const { row, normalized } of valid) {
      const res = await fw.createTask(supabase, normalized);
      if (res.ok) {
        await supabase.from('crm_import_rows').update({
          normalized_json: normalized, status: 'sent',
          fs_id: String(res.data?.task?.id || ''),
          attempt_count: row.attempt_count + 1, attempted_at: new Date().toISOString(),
        }).eq('id', row.id);
        sent++;
      } else {
        await supabase.from('crm_import_rows').update({
          normalized_json: normalized, status: 'failed',
          error_message: res.error, attempt_count: row.attempt_count + 1,
          attempted_at: new Date().toISOString(),
        }).eq('id', row.id);
        failed++;
      }
    }
  } else {
    // Bulk types: contacts_accounts, leads, opportunities
    // For contacts_accounts, first ensure each row's account exists, then push contacts.
    if (imp.import_type === 'contacts_accounts') {
      // Group rows by account external_id; create the account once per group.
      const byExternalId = new Map();
      for (const v of valid) {
        const extId = v.normalized.account_external_id || v.normalized['cf_account_external_id'];
        if (!extId) {
          await supabase.from('crm_import_rows').update({
            normalized_json: v.normalized, status: 'validation_failed',
            error_message: 'account_external_id missing — required for contacts_accounts',
            attempt_count: v.row.attempt_count + 1, attempted_at: new Date().toISOString(),
          }).eq('id', v.row.id);
          failed++;
          continue;
        }
        if (!byExternalId.has(extId)) byExternalId.set(extId, []);
        byExternalId.get(extId).push(v);
      }

      for (const [extId, vs] of byExternalId) {
        const first = vs[0];
        const acctFields = {
          name: first.normalized.account_name || first.normalized.company || extId,
          // any other account-prefixed mapped fields can be passed through here
        };
        let fsAccountId;
        try {
          fsAccountId = await ensureAccount(supabase, extId, acctFields, ctx);
        } catch (e) {
          for (const v of vs) {
            await supabase.from('crm_import_rows').update({
              normalized_json: v.normalized, status: 'failed',
              error_message: `Account ensure failed: ${e.message}`,
              attempt_count: v.row.attempt_count + 1, attempted_at: new Date().toISOString(),
            }).eq('id', v.row.id);
            failed++;
          }
          errors.push(`Account ${extId}: ${e.message}`);
          continue;
        }
        // Link each contact to the resolved FS account. In Freshsales Suite,
        // contacts associate to sales accounts via an array of {id, is_primary}
        // objects (the "sales_accounts" relationship), NOT a flat
        // sales_account_id field. We set both for forward compatibility
        // in case the bulk endpoint accepts either; FS ignores the unknown.
        for (const v of vs) {
          v.normalized.sales_accounts = [{ id: fsAccountId, is_primary: true }];
          v.normalized.sales_account_id = fsAccountId;
          v.row.fs_account_id_pending = fsAccountId;
        }
      }
    }

    // Chunk valid rows into BULK_BATCH_SIZE-sized arrays for bulk_upsert
    const stillValid = valid.filter(v => v.normalized && (imp.import_type !== 'contacts_accounts' || v.normalized.sales_account_id));
    for (let i = 0; i < stillValid.length; i += BULK_BATCH_SIZE) {
      const chunk = stillValid.slice(i, i + BULK_BATCH_SIZE);
      const payload = chunk.map(c => c.normalized);

      let res;
      if (imp.import_type === 'contacts_accounts' || imp.import_type === 'leads') {
        res = await fw.bulkUpsertContacts(supabase, payload);
      } else if (imp.import_type === 'opportunities') {
        res = await fw.bulkUpsertDeals(supabase, payload);
      }

      if (!res?.ok) {
        for (const c of chunk) {
          await supabase.from('crm_import_rows').update({
            normalized_json: c.normalized, status: 'failed',
            error_message: res?.error || 'bulk_upsert failed',
            attempt_count: c.row.attempt_count + 1, attempted_at: new Date().toISOString(),
            fs_account_id: c.row.fs_account_id_pending || null,
          }).eq('id', c.row.id);
          failed++;
        }
        errors.push(res?.error || 'bulk_upsert failed');
        continue;
      }

      // FS returns a job; poll for completion
      const jobId = res.data?.bulk_upsert_job?.id || res.data?.id;
      try {
        const job = await pollJob(supabase, jobId);
        // Mark all chunk rows sent. FS doesn't always tell us which row got
        // which id; we trust the dedup-by-email/order_id and let the user
        // verify in FS if needed.
        for (const c of chunk) {
          await supabase.from('crm_import_rows').update({
            normalized_json: c.normalized, status: 'sent',
            attempt_count: c.row.attempt_count + 1, attempted_at: new Date().toISOString(),
            fs_account_id: c.row.fs_account_id_pending || null,
          }).eq('id', c.row.id);
          sent++;
        }
      } catch (e) {
        for (const c of chunk) {
          await supabase.from('crm_import_rows').update({
            normalized_json: c.normalized, status: 'failed',
            error_message: e.message, attempt_count: c.row.attempt_count + 1,
            attempted_at: new Date().toISOString(),
            fs_account_id: c.row.fs_account_id_pending || null,
          }).eq('id', c.row.id);
          failed++;
        }
        errors.push(e.message);
      }
    }
  }

  // 5. Close out the batch
  await supabase.from('crm_import_batches').update({
    status: errors.length > 0 ? (sent > 0 ? 'complete' : 'failed') : 'complete',
    actual_size: claimedIds.length,
    stats_json: { sent, failed, skipped: 0 },
    completed_at: new Date().toISOString(),
  }).eq('id', batchId);

  // If everything for the import is sent, mark the import complete
  const { count: pendingLeft } = await supabase
    .from('crm_import_rows').select('id', { count: 'exact', head: true })
    .eq('import_id', importId).eq('status', 'pending');
  if (!pendingLeft) {
    await supabase.from('crm_imports').update({
      status: 'complete', completed_at: new Date().toISOString(),
    }).eq('id', importId);
  } else {
    await supabase.from('crm_imports').update({ status: 'pushing' }).eq('id', importId);
  }

  return { sent, failed, skipped: 0, batchId, errors };
}

module.exports = {
  parseExcel,
  normalizeRow,
  parseDate,
  cleanString,
  normalizeEmail,
  normalizePhone,
  normalizeCurrency,
  pushBatch,
};
