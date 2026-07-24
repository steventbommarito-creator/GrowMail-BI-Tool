/**
 * Shared builder for SFDC lead rows → Freshsales contact payloads.
 *
 * Used by sfdc-leads-import.js (the full missing-leads import) and
 * open-tasks-import.js (which creates a lead on the fly when an open task's
 * target email only exists in the leads CSV).
 *
 * Leads in this Freshsales instance are contacts with lifecycle stage "Lead".
 * Status mapping collapses SFDC lead statuses onto the live status set; the
 * raw SFDC status is preserved in cf_status_reason whenever the mapping isn't
 * 1:1, and the raw "LEAD SOURCE 2" value always lands in cf_lead_source_2.
 */
const C = require('./common');

const LIFECYCLE = { LEAD: 128081818855, SQL: 128081818856 };
const STATUS = {
  NEW: 127004203345, CONTACTED: 127004203346, INTERESTED: 127004203347,
  UNQUALIFIED: 127004203348, QUALIFIED: 127004203349,
};

// SFDC "Lead Status" → { status, stage, exact } (exact=false ⇒ keep raw in cf_status_reason)
const STATUS_MAP = {
  'new lead': { status: STATUS.NEW, stage: LIFECYCLE.LEAD, exact: true },
  'contacted': { status: STATUS.CONTACTED, stage: LIFECYCLE.LEAD, exact: true },
  'working': { status: STATUS.CONTACTED, stage: LIFECYCLE.LEAD },
  'not ready': { status: STATUS.CONTACTED, stage: LIFECYCLE.LEAD },
  'disqualified': { status: STATUS.UNQUALIFIED, stage: LIFECYCLE.LEAD },
  'low budget / quantity': { status: STATUS.UNQUALIFIED, stage: LIFECYCLE.LEAD },
  'bad phone #': { status: STATUS.UNQUALIFIED, stage: LIFECYCLE.LEAD },
  'spam': { status: STATUS.UNQUALIFIED, stage: LIFECYCLE.LEAD },
  'qualified': { status: STATUS.QUALIFIED, stage: LIFECYCLE.SQL, exact: true },
  'converted': { status: STATUS.QUALIFIED, stage: LIFECYCLE.SQL },
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const leadEmail = (row) => String(row['Email'] || '').trim().toLowerCase();
const validLeadEmail = (row) => EMAIL_RE.test(leadEmail(row));

// Unique generated SFID for contacts created by this import: '999' + 10 random
// digits. Numeric-only (real SFDC lead ids start with '00Q', so no collision)
// and doubles as an audit marker in cf_lead_sf_id.
const _usedSfids = new Set();
function genSfid() {
  for (;;) {
    const id = '999' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
    if (!_usedSfids.has(id)) { _usedSfids.add(id); return id; }
  }
}

// name(lowercased) → lead_source_id, resolved from the live instance once.
async function buildSourceMap() {
  const r = await C.fs('GET', '/selector/lead_sources');
  if (!r.ok) throw new Error(`lead_sources fetch failed: ${r.error}`);
  const map = {};
  for (const s of r.data.lead_sources || []) {
    const nm = String(s.name || '').trim().toLowerCase();
    if (nm) map[nm] = s.id;
  }
  return map;
}

// SFDC display name → Freshworks display name, where they differ.
const OWNER_ALIASES = { 'danielle dennis': 'dani dennis' };

// display name(lowercased) → owner id.
async function buildOwnerByName() {
  const r = await C.fs('GET', '/selector/owners');
  if (!r.ok) throw new Error(`owners fetch failed: ${r.error}`);
  const byName = {};
  for (const u of r.data.users || []) {
    const nm = String(u.display_name || '').trim().toLowerCase();
    if (nm) byName[nm] = u.id;
  }
  for (const [alias, target] of Object.entries(OWNER_ALIASES)) {
    if (byName[target]) byName[alias] = byName[target];
  }
  return byName;
}

function buildLeadContact(row, { ownerByName, sourceMap }) {
  const email = leadEmail(row);
  const st = STATUS_MAP[String(row['Lead Status'] || '').trim().toLowerCase()]
    || { status: STATUS.NEW, stage: LIFECYCLE.LEAD };
  const contact = {
    first_name: String(row['First Name'] || '').trim().slice(0, 100) || 'Unknown',
    last_name: String(row['Last Name'] || '').trim().slice(0, 100),
    emails: [{ value: email, is_primary: true }],
    lifecycle_stage_id: st.stage,
    contact_status_id: st.status,
    owner_id: ownerByName[String(row['Lead Owner'] || '').trim().toLowerCase()] || C.CS_OWNER_ID,
    custom_field: { cf_lead_sf_id: genSfid() },
  };
  // No plain company field on contacts (osprey-lead-sync precedent): Title, else Company.
  const title = String(row['Title'] || '').trim() || String(row['Company / Account'] || '').trim();
  if (title) contact.job_title = title.slice(0, 100);
  const rawSource = String(row['LEAD SOURCE 2'] || '').trim();
  if (rawSource) {
    contact.custom_field.cf_lead_source_2 = rawSource.slice(0, 255);
    const sid = sourceMap[rawSource.toLowerCase()];
    if (sid) contact.lead_source_id = sid;
  }
  const rawStatus = String(row['Lead Status'] || '').trim();
  if (rawStatus && !st.exact) contact.custom_field.cf_status_reason = `SFDC Lead Status: ${rawStatus}`;
  const created = C.parseUSDate(row['Created Month']);
  if (created) contact.custom_field.cf_sf_created = created;
  const ga = String(row['Google Analytics Campaign'] || '').trim();
  if (ga) contact.custom_field.cf_description = `GA Campaign: ${ga}`.slice(0, 500);
  if (!Object.keys(contact.custom_field).length) delete contact.custom_field;
  return contact;
}

// email → contact id | null, via the exact-match lookup endpoint.
async function lookupContactByEmail(email) {
  const r = await C.fs('GET', `/lookup?q=${encodeURIComponent(email)}&f=email&entities=contact`);
  if (!r.ok) throw new Error(`lookup ${email} failed: ${r.status} ${r.error}`);
  const list = r.data?.contacts?.contacts || [];
  return list.length ? list[0].id : null;
}

// account name → id | null (search, then case-insensitive exact-name filter).
async function searchAccountByName(name) {
  const r = await C.fs('GET', `/search?q=${encodeURIComponent(name.slice(0, 100))}&include=sales_account&per_page=10`);
  if (!r.ok) throw new Error(`account search "${name}" failed: ${r.status} ${r.error}`);
  const want = name.trim().toLowerCase();
  const hit = (r.data || []).find((a) => String(a.name || '').trim().toLowerCase() === want);
  return hit ? Number(hit.id) : null;
}

module.exports = {
  LIFECYCLE, STATUS, STATUS_MAP, EMAIL_RE,
  leadEmail, validLeadEmail, genSfid,
  buildSourceMap, buildOwnerByName, buildLeadContact,
  lookupContactByEmail, searchAccountByName,
};
