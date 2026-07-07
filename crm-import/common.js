/**
 * Shared helpers for the SFDC-opportunities → Freshsales deal import.
 *
 * This import runs OUTSIDE the dashboard's bulk-upsert engine (which can't be
 * used here: Freshsales has no unique deal field, so bulk_upsert is rejected,
 * and bulk silently drops contact links). Instead we create deals one at a
 * time via POST /deals — verified to persist owner, contact link, stage, and
 * custom fields — while recording progress in the same crm_imports /
 * crm_import_rows tables the dashboard reads, so the /crm/imports UI shows it.
 *
 * FS creds + Supabase creds come from the repo .env (dotenv).
 */
require('dotenv').config();
const supabase = require('../lib/supabase');

// ── Freshsales client (direct, rate-limited) ────────────────────────────────
const FS_DOMAIN = String(process.env.FRESHSALES_DOMAIN || '').replace(/^https?:\/\//, '').split('/')[0];
const FS_KEY = process.env.FRESHSALES_API_KEY;
const FS_BASE = `https://${FS_DOMAIN}/crm/sales/api`;
// Account cap is 2000 req/hr + 400/min. Default to 1900/hr for safety margin.
const RATE_PER_HOUR = Number(process.env.FRESHSALES_RATE || 1900);
const MIN_INTERVAL_MS = 3600000 / RATE_PER_HOUR;
let _lastReq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fs(method, path, body, retries = 5) {
  const wait = _lastReq + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const url = FS_BASE + path;
  for (let attempt = 0; attempt < retries; attempt++) {
    _lastReq = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Token token=${FS_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < retries - 1) { await sleep(10000 * (attempt + 1)); continue; }
      return { ok: false, status: 0, error: e.message };
    }
    if (res.status === 429) {
      const delay = Number(res.headers.get('retry-after') || 60);
      await sleep(delay * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < retries - 1) { await sleep(5000 * (attempt + 1)); continue; }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; } }
    if (!res.ok) return { ok: false, status: res.status, error: data?.errors?.message || data?.message || `HTTP ${res.status}`, data };
    return { ok: true, status: res.status, data };
  }
  return { ok: false, status: 0, error: 'retries exhausted' };
}

// ── Fixed IDs (verified against the live instance) ──────────────────────────
const DEAL_PIPELINE_ID = 127000511262;
const STAGE_IDS = { Quoted: 127003582554, Won: 127003582559, Lost: 127003582560 };
const CS_OWNER_ID = 127000558289; // cs@growmail.com "Customer Service" — default owner

const STAGE_COLLAPSE = {
  'Closed Won': 'Won', 'Closed Won - Not Paid': 'Won', 'Agreement Signed': 'Won', 'Closed Prepaid': 'Won',
  'Quoted': 'Quoted', 'Open': 'Quoted', 'Cultivating': 'Quoted', 'Negotiating': 'Quoted',
  'Closed Lost': 'Lost', 'Closed Lost - Competition': 'Lost', 'Closed NI': 'Lost',
  'Internal (Clipper/Valassis)': 'Lost',
};

// (sfdcColumn, cfName, kind, defaultWhenEmpty)
const CUSTOM_FIELDS = [
  ['Opportunity ID', 'cf_sf_oppty_id', 'text', null],
  ['WebID', 'cf_webid', 'number', 0],
  ['Order Number', 'cf_order_number', 'number', 999],
  ['AMP Quote URL', 'cf_amp_quote_url', 'text', null],
  ['Map Image Link', 'cf_map_image_link', 'text', null],
  ['In Home Week', 'cf_estimated_mail_date', 'date', null],
  ['Description', 'cf_description', 'text', null],
];

const SCOPE_CUTOFF = '2022-01-01';

// ── value helpers ───────────────────────────────────────────────────────────
const cleanScalar = (s) => { s = String(s ?? '').trim(); return /^\d+\.0$/.test(s) ? s.slice(0, -2) : s; };
function parseUSDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : null;
}
function parseAmount(s) { const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function parseNumber(s) { const n = parseFloat(cleanScalar(s).replace(/,/g, '')); return Number.isFinite(n) ? Math.trunc(n) : null; }
function rowDateKey(row) {
  return parseUSDate(row['Close Date']) || parseUSDate(row['Created Date']) || `${String(row['Fiscal Year'] || '').trim()}-00-00`;
}
const inScope = (row) => rowDateKey(row) >= SCOPE_CUTOFF;

// ── owner map + contact cache (built once, from FS) ─────────────────────────
async function buildOwnerMap() {
  const r = await fs('GET', '/selector/owners');
  if (!r.ok) throw new Error(`owners fetch failed: ${r.error}`);
  const byEmail = {}, byLocal = {};
  for (const u of r.data.users || []) {
    const em = String(u.email || '').toLowerCase();
    if (!em) continue;
    byEmail[em] = u.id;
    const local = em.split('@')[0];
    if (!(local in byLocal)) byLocal[local] = u.id;
  }
  return { byEmail, byLocal };
}
function resolveOwner(ownerMap, email) {
  const em = String(email || '').toLowerCase();
  return ownerMap.byEmail[em] || ownerMap.byLocal[em.split('@')[0]] || CS_OWNER_ID;
}

async function buildContactCache(log = () => {}) {
  const f = await fs('GET', '/contacts/filters');
  if (!f.ok) throw new Error(`contact filters failed: ${f.error}`);
  const views = f.data.filters || [];
  const view = views.find((v) => String(v.name || '').toLowerCase() === 'all contacts') || views[0];
  if (!view) throw new Error('no contacts view');
  const cache = {};
  let page = 1;
  for (;;) {
    const r = await fs('GET', `/contacts/view/${view.id}?page=${page}&per_page=100`);
    if (!r.ok) throw new Error(`contacts page ${page} failed: ${r.error}`);
    const rows = r.data.contacts || [];
    if (!rows.length) break;
    for (const ct of rows) {
      const keys = [String(ct.email || '').toLowerCase()];
      for (const e of ct.emails || []) keys.push(String((e && e.value) || e || '').toLowerCase());
      for (const k of keys) if (k && !(k in cache)) cache[k] = ct.id;
    }
    const total = r.data.meta?.total_pages;
    log(`  contacts page ${page}${total ? '/' + total : ''} — ${Object.keys(cache).length} emails`);
    if (total && page >= total) break;
    page++;
  }
  return cache;
}

// ── build the FS deal payload for one SFDC row ──────────────────────────────
function buildDealPayload(row, ownerMap, contactCache) {
  const stage = STAGE_IDS[STAGE_COLLAPSE[row['Stage']]];
  if (!stage) return { error: `unmapped stage: ${row['Stage']}` };
  const deal = {
    name: String(row['Opportunity Name'] || 'Untitled').slice(0, 255),
    deal_pipeline_id: DEAL_PIPELINE_ID,
    deal_stage_id: stage,
    amount: parseAmount(row['Amount']) ?? parseAmount(row['Total Price']) ?? 0,
    owner_id: resolveOwner(ownerMap, row['Owner Email'] || row['Opportunity Owner']),
    custom_field: {},
  };
  const close = parseUSDate(row['Close Date']);
  if (close) deal.expected_close = close;
  const cid = contactCache[String(row['Primary Contact Email'] || '').toLowerCase()];
  if (cid) deal.contacts_added_list = [cid];
  for (const [col, cf, kind, def] of CUSTOM_FIELDS) {
    let v;
    if (kind === 'number') { v = parseNumber(row[col]); if (v === null) v = def; }
    else if (kind === 'date') { v = parseUSDate(row[col]); }
    else { v = cleanScalar(row[col]).slice(0, 255) || null; if (v === null && def !== null) v = def; }
    if (v !== null && v !== undefined && v !== '') deal.custom_field[cf] = v;
  }
  return { deal };
}

module.exports = {
  supabase, fs, sleep,
  DEAL_PIPELINE_ID, STAGE_IDS, CS_OWNER_ID, STAGE_COLLAPSE, CUSTOM_FIELDS, SCOPE_CUTOFF,
  cleanScalar, parseUSDate, parseAmount, parseNumber, rowDateKey, inScope,
  buildOwnerMap, resolveOwner, buildContactCache, buildDealPayload,
};
