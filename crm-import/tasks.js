/**
 * Helpers for importing SFDC activities as Freshsales Tasks (POST /tasks).
 * Shares the FS client + Supabase + contact-cache from common.js.
 *
 * Scope (decided with the user): calls + real tasks + external emails, EXCLUDING
 * the automated "Scheduled Call Back" cadence rows and Intercom chats. Email rows
 * whose counterparty is one of our own sales users are dropped (there are ~none).
 *
 * Target resolution per task: contact by Email, else account by Company/Account
 * name, else unlinked. Owner from the "Assigned" display name. Completed status
 * from the SFDC Status column. Verified task payload:
 *   { task: { title, description, due_date, owner_id, status(1=done/0=open),
 *             targetable_type: 'Contact'|'SalesAccount', targetable_id } }
 */
const C = require('./common');

const EMAIL_TYPES = new Set(['Email Sent', 'Email', 'Email Due']);
const EXCLUDE_TYPES = new Set(['Scheduled Call Back', 'Intercom Chat']);

// Only these columns are staged (the raw CSV has 50MB chat-transcript fields we
// never use); Full Comments is truncated.
const KEEP_COLS = [
  'Subject', 'Comments', 'Full Comments', 'Due Time', 'Completed Date/Time', 'Date',
  'Created Date', 'Assigned', 'Status', 'Activity Type', 'Email', 'Company / Account',
  'Contact', 'Opportunity', '18SFID',
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

// Include a row in scope. salesEmails: Set of lowercased FS user emails.
function inScopeActivity(row, salesEmails) {
  const at = String(row['Activity Type'] || '').trim();
  if (EXCLUDE_TYPES.has(at)) return false;
  if (EMAIL_TYPES.has(at)) {
    const em = String(row['Email'] || '').trim().toLowerCase();
    if (em && salesEmails.has(em)) return false; // internal email — drop
    return true;
  }
  return true; // calls + tasks
}

function parseDateTime(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/.exec(s);
  if (m) {
    let [, mo, d, y, h, mi, se, ap] = m;
    let H = h ? parseInt(h, 10) : 12;
    mi = mi || '00'; se = se || '00';
    if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && H < 12) H += 12; if (ap === 'AM' && H === 12) H = 0; }
    return `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}T${String(H).padStart(2, '0')}:${mi}:${se}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.length === 10 ? s + 'T12:00:00Z' : s;
  return null;
}

async function salesEmailSet() {
  const r = await C.fs('GET', '/selector/owners');
  if (!r.ok) throw new Error(`owners fetch failed: ${r.error}`);
  return new Set((r.data.users || []).map((u) => String(u.email || '').toLowerCase()).filter(Boolean));
}

async function buildOwnerByName() {
  const r = await C.fs('GET', '/selector/owners');
  if (!r.ok) throw new Error(`owners fetch failed: ${r.error}`);
  const byName = {};
  for (const u of r.data.users || []) {
    const nm = String(u.display_name || '').trim().toLowerCase();
    if (nm) byName[nm] = u.id;
  }
  return byName;
}

// name(lowercased) -> account id, from the "All Accounts" view.
async function buildAccountCache(log = () => {}) {
  const f = await C.fs('GET', '/sales_accounts/filters');
  if (!f.ok) throw new Error(`account filters failed: ${f.error}`);
  const views = f.data.filters || [];
  const view = views.find((v) => String(v.name || '').toLowerCase() === 'all accounts') || views[0];
  const cache = {};
  let page = 1;
  for (;;) {
    const r = await C.fs('GET', `/sales_accounts/view/${view.id}?page=${page}&per_page=100`);
    if (!r.ok) throw new Error(`accounts page ${page} failed: ${r.error}`);
    const rows = r.data.sales_accounts || [];
    if (!rows.length) break;
    for (const a of rows) {
      const nm = String(a.name || '').trim().toLowerCase();
      if (nm && !(nm in cache)) cache[nm] = a.id;
    }
    const total = r.data.meta?.total_pages;
    if (page % 50 === 0) log(`  accounts page ${page}${total ? '/' + total : ''} — ${Object.keys(cache).length} names`);
    if (total && page >= total) break;
    page++;
  }
  return cache;
}

function buildTaskPayload(row, ctx) {
  const { ownerByName, contactCache, accountCache } = ctx;
  const title = String(row['Subject'] || row['Activity Type'] || 'Activity').slice(0, 250);
  const desc = String(row['Full Comments'] || row['Comments'] || '').slice(0, 2000);
  const due = parseDateTime(row['Due Time'] || row['Completed Date/Time'] || row['Date'] || row['Created Date'])
    || '2025-01-01T12:00:00Z';
  const owner = ownerByName[String(row['Assigned'] || '').trim().toLowerCase()] || C.CS_OWNER_ID;
  const status = String(row['Status'] || '').trim() === 'Completed' ? 1 : 0;

  const task = { title, due_date: due, owner_id: owner, status };
  if (desc) task.description = desc;

  const email = String(row['Email'] || '').trim().toLowerCase();
  const acctName = String(row['Company / Account'] || '').trim().toLowerCase();
  if (email && contactCache[email]) {
    task.targetable_type = 'Contact'; task.targetable_id = contactCache[email];
  } else if (acctName && accountCache[acctName]) {
    task.targetable_type = 'SalesAccount'; task.targetable_id = accountCache[acctName];
  }
  return { task };
}

module.exports = {
  EMAIL_TYPES, EXCLUDE_TYPES, KEEP_COLS,
  trimRow, inScopeActivity, parseDateTime,
  salesEmailSet, buildOwnerByName, buildAccountCache, buildTaskPayload,
};
