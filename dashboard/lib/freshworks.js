/**
 * Freshworks / Freshsales CRM API client.
 *
 * Thin wrapper around the v2 API documented at
 * https://developers.freshworks.com/crm/api/. Reads creds from crm_settings
 * (singleton row id=1) on each call rather than caching — config can change
 * mid-runtime via the Integrations page, and we always want the fresh value.
 *
 * Auth: `Authorization: Token token=<api_key>` header — Freshsales calls this
 * the "API key" but the header name is "Token" with a "token=" prefix.
 *
 * Base URL: the user enters something like
 *   https://acme.myfreshworks.com/crm/sales
 * and all endpoints hang off /api below that, e.g.
 *   GET <base>/api/sales_accounts
 *   POST <base>/api/deals
 */

const TIMEOUT_MS = 15000;

// ─── helpers ────────────────────────────────────────────────────────────────

function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

// Normalize the base URL: trim, drop trailing slash, prepend https:// if the
// user entered a bare hostname like "growmail.myfreshworks.com/crm/sales".
// Node fetch errors with "Failed to parse URL" if the protocol is missing.
function normalizeBaseUrl(s) {
  const trimmed = trimSlash(String(s || '').trim());
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return 'https://' + trimmed;
}

async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function loadSettings(supabase) {
  const { data, error } = await supabase
    .from('crm_settings')
    .select('api_url, api_key, pipeline_id, pipeline_name')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Failed to load crm_settings: ${error.message}`);
  if (!data?.api_url || !data?.api_key) {
    const e = new Error('CRM API URL or key not configured');
    e.code = 'CRM_NOT_CONFIGURED';
    throw e;
  }
  return data;
}

function headersFor(apiKey) {
  return {
    'Authorization': `Token token=${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * Low-level request used by every higher-level helper below. Always returns
 * { ok, status, data, error } — never throws on HTTP errors, only on network
 * / timeout / config-missing. Lets callers (sync engine + API routes) decide
 * what to log without try/catch noise.
 */
async function call(supabase, method, path, body) {
  let settings;
  try { settings = await loadSettings(supabase); }
  catch (e) { return { ok: false, status: 0, error: e.message, code: e.code }; }

  const base = normalizeBaseUrl(settings.api_url);
  const url  = `${base}/api${path.startsWith('/') ? path : '/' + path}`;

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: headersFor(settings.api_key),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'Request timed out' : e.message };
  }

  // FS returns JSON for both success + error; sometimes 204 No Content.
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }

  if (!res.ok) {
    const errMsg = data?.errors?.message
      || data?.errors?.[0]?.message
      || data?.message
      || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errMsg, data };
  }
  return { ok: true, status: res.status, data };
}

// ─── high-level API ─────────────────────────────────────────────────────────

/** GET /api/selector/owners — cheapest auth-validating endpoint. */
async function testConnection(supabase) {
  // selector/owners returns 200 with a tiny payload when auth is valid.
  // It exists on every FS account regardless of pipeline config.
  return call(supabase, 'GET', '/selector/owners');
}

/**
 * GET /api/selector/deal_pipelines — list pipelines so the Integrations page
 * can ask the user which one to use. Each pipeline has its own stage list.
 */
async function listPipelines(supabase) {
  return call(supabase, 'GET', '/selector/deal_pipelines');
}

/**
 * GET /api/selector/deal_pipelines/{id}/deal_stages — list stages for the
 * configured pipeline so the Status Mapping modal populates with real IDs.
 */
async function listStages(supabase, pipelineId) {
  if (!pipelineId) return { ok: false, status: 0, error: 'pipeline_id not configured' };
  return call(supabase, 'GET', `/selector/deal_pipelines/${pipelineId}/deal_stages`);
}

/** GET /api/deals/{id} — used by the sync engine to detect FS-side edits. */
async function getDeal(supabase, dealId) {
  return call(supabase, 'GET', `/deals/${dealId}`);
}

/**
 * POST /api/deals — creates a deal. The FS deal schema is:
 *   {
 *     deal: {
 *       name, amount, deal_stage_id, deal_pipeline_id,
 *       custom_field: { ... },
 *       sales_account_id (optional), contact_id (optional)
 *     }
 *   }
 * Callers pass the inner `deal` object; we wrap it.
 */
async function createDeal(supabase, deal) {
  return call(supabase, 'POST', '/deals', { deal });
}

/** PUT /api/deals/{id} — partial update; only fields present are changed. */
async function updateDeal(supabase, dealId, deal) {
  return call(supabase, 'PUT', `/deals/${dealId}`, { deal });
}

// ─── Bulk endpoints (Excel→FS import path) ──────────────────────────────────
// FS supports async bulk upsert for contacts, sales_accounts, and deals at
// 100 records per request. Each call returns a job_id we poll until done.
// Tasks have no bulk endpoint — those go one-at-a-time via createTask.

async function bulkUpsertContacts(supabase, contacts) {
  // FS expects { contacts: [...] } shape; "upsert_identifier" picks the key
  // to match on (email). Each contact obj uses regular FS contact fields.
  return call(supabase, 'POST', '/contacts/bulk_upsert', {
    contacts,
    unique_identifier: { lookup_by: 'email' },
  });
}

async function bulkUpsertAccounts(supabase, accounts) {
  return call(supabase, 'POST', '/sales_accounts/bulk_upsert', {
    sales_accounts: accounts,
    unique_identifier: { lookup_by: 'name' },
  });
}

async function bulkUpsertDeals(supabase, deals) {
  return call(supabase, 'POST', '/deals/bulk_upsert', {
    deals,
    unique_identifier: { lookup_by: 'custom_field.cf_order_id' },
  });
}

/**
 * Tasks have no bulk endpoint in FS. Caller iterates serially.
 * Body shape: { task: { title, description, due_date, owner_id, targetable: {...} } }
 */
async function createTask(supabase, task) {
  return call(supabase, 'POST', '/tasks', { task });
}

/**
 * Poll a bulk job for completion. FS bulk_upsert returns:
 *   { bulk_upsert_job: { id, status: 'in_progress'|'finished'|'failed', ... } }
 * Status URL pattern:  /api/bulk_jobs/{id}
 */
async function getBulkJob(supabase, jobId) {
  return call(supabase, 'GET', `/bulk_jobs/${jobId}`);
}

// ─── Field schema discovery ─────────────────────────────────────────────────
// FS exposes form definitions at /api/settings/forms/{entity}, which lists the
// default + custom fields available for that entity type. Used by the Imports
// page mapping UI so the user picks real FS field names, not invented ones.

// Field-schema endpoints. FS returns a flat { fields: [...] } object with all
// default + custom fields. The actual paths (verified against the FS docs)
// are /api/settings/{entity}/fields, NOT /forms/{entity} which I guessed and
// silently 404'd. Tasks live under sales_activities since FS treats Tasks
// as one variety of sales activity.
async function getContactFields(supabase) { return call(supabase, 'GET', '/settings/contacts/fields'); }
async function getAccountFields(supabase) { return call(supabase, 'GET', '/settings/sales_accounts/fields'); }
async function getDealFields(supabase)    { return call(supabase, 'GET', '/settings/deals/fields'); }
async function getTaskFields(supabase)    { return call(supabase, 'GET', '/settings/sales_activities/fields'); }

module.exports = {
  // basic
  testConnection,
  listPipelines,
  listStages,
  getDeal,
  createDeal,
  updateDeal,
  // bulk
  bulkUpsertContacts,
  bulkUpsertAccounts,
  bulkUpsertDeals,
  getBulkJob,
  createTask,
  // schema
  getContactFields,
  getAccountFields,
  getDealFields,
  getTaskFields,
  // internals
  call,
  loadSettings,
};
