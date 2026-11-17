/**
 * USPS Monthly Affiliate Report — shared by the dashboard (/usps-report) and
 * the CLI (crm-import/usps-affiliate-report.js). Read-only: only Freshsales
 * GETs and /filtered_search (a read) are called.
 *
 * Rules (from the "Salesforce USPS Report" guidance):
 *  - Orders = Freshsales deals in Won with closed_date inside the month.
 *  - USPS-attributed if USPS appears on the deal's Source, on any contact on
 *    the deal, or on any contact of the deal's account (Source dropdown, SF
 *    Acct Lead Source, Lead Source 2, original/created/latest source/campaign).
 *    How old the lead is doesn't matter.
 *  - New = the account's first ever Won deal closed in this month; every
 *    order that account places in the month is New. Otherwise Existing.
 *  - Only New (first-order) business is reported and earns the 15% share.
 *    Existing USPS customers fill the two Existing lines for reference only.
 *  - Revenue and pieces come from Osprey drops (latest osprey_mail_drops
 *    snapshot, summed per order); if the order isn't there, the deal amount
 *    is used as production and the row says so.
 *  - Deals named "[TEST" are ignored.
 */

export const REV_SHARE_PCT = 0.15;
const WON_STAGE_ID = 127003582559;
const USPS_SOURCE_IDS = new Set([127007286694, 127007286695, 127007318586, 127007318663, 127007318698, 127007318699,
  127007318700, 127007318701, 127007318702, 127007318703, 127007318704, 127007318714, 127007318719, 127007320203,
  127007320204]);
const TEXT_FIELDS = ['cf_sf_acct_lead_source', 'cf_lead_source_2', 'first_source', 'first_campaign', 'last_source',
  'last_campaign', 'latest_source', 'latest_campaign'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base, apiKey) {
  const headers = { Authorization: `Token token=${apiKey}`, 'Content-Type': 'application/json' };
  async function call(method, path, body) {
    for (let i = 0; i < 6; i++) {
      let res;
      try { res = await fetch(base + path, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined }); }
      catch { await sleep(2000 * (i + 1)); continue; }
      if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') || 20) * 1000); continue; }
      if (res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      const text = await res.text();
      if (!res.ok) throw new Error(`Freshsales ${method} ${path.split('?')[0]}: HTTP ${res.status}`);
      return text ? JSON.parse(text) : {};
    }
    throw new Error(`Freshsales ${method} ${path.split('?')[0]}: retries exhausted`);
  }
  return { get: (p) => call('GET', p), search: (p, b) => call('POST', p, b) };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

export function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    label: new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/**
 * @param {object} o
 * @param {string} o.month     YYYY-MM
 * @param {string} o.baseUrl   Freshsales API base, e.g. https://x.myfreshworks.com/crm/sales/api
 * @param {string} o.apiKey
 * @param {object} o.supabase  client that can read osprey_mail_drops
 */
export async function buildUspsAffiliateReport({ month, baseUrl, apiKey, supabase }) {
  const { from, to, label } = monthRange(month);
  const fs = client(baseUrl.replace(/\/+$/, ''), apiKey);

  async function wonDeals(rules) {
    const out = [];
    for (let p = 1; ; p++) {
      const r = await fs.search(`/filtered_search/deal?per_page=100&page=${p}`,
        { filter_rule: [{ attribute: 'deal_stage_id', operator: 'is_in', value: [WON_STAGE_ID] }, ...rules] });
      out.push(...(r.deals || []));
      if ((r.deals || []).length < 100) return out;
    }
  }

  // 1. Won deals closed in the month, with their contacts and account.
  const list = (await wonDeals([{ attribute: 'closed_date', operator: 'is_in_the_range', value: [from, to] }]))
    .filter((d) => !/^\s*\[TEST/i.test(d.name || ''));
  const deals = [];
  await pool(list, 8, async (d) => { deals.push((await fs.get(`/deals/${d.id}?include=contacts,sales_account`)).deal); });

  const accounts = {};
  await pool([...new Set(deals.map((d) => d.sales_account_id).filter(Boolean))], 6, async (id) => {
    const r = await fs.get(`/sales_accounts/${id}?include=contacts`);
    accounts[id] = { name: r.sales_account.name, contactIds: (r.contacts || []).map((c) => c.id) };
  });

  const contactIds = new Set();
  deals.forEach((d) => (d.contact_ids || []).forEach((c) => contactIds.add(c)));
  Object.values(accounts).forEach((a) => a.contactIds.forEach((c) => contactIds.add(c)));
  const contacts = {};
  await pool([...contactIds], 8, async (id) => {
    const c = (await fs.get(`/contacts/${id}`)).contact;
    const cf = c.custom_field || {};
    const hits = [];
    if (USPS_SOURCE_IDS.has(c.lead_source_id)) hits.push('Source');
    for (const k of TEXT_FIELDS) { const v = c[k] ?? cf[k]; if (v && /usps/i.test(String(v))) hits.push(`${k}=${v}`); }
    contacts[id] = { name: c.display_name, hits };
  });

  // 2. USPS attribution.
  const qualifying = [];
  for (const d of deals) {
    const why = [];
    if (USPS_SOURCE_IDS.has(d.lead_source_id)) why.push('Deal source');
    for (const c of d.contact_ids || []) if (contacts[c]?.hits.length) why.push(`Contact ${contacts[c].name} (${contacts[c].hits.join(', ')})`);
    for (const c of accounts[d.sales_account_id]?.contactIds || []) {
      if (!(d.contact_ids || []).includes(c) && contacts[c]?.hits.length) why.push(`Account contact ${contacts[c].name} (${contacts[c].hits.join(', ')})`);
    }
    if (why.length) qualifying.push({ deal: d, why });
  }

  // 3. New vs existing. Search results don't carry closed_date, so ask
  // Freshsales how many Won deals the account closed before the month: any
  // means Existing. A New account's first order is its earliest Won deal in
  // the month (all of the month's Won deals are already loaded above).
  const priorWon = {};
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  await pool([...new Set(qualifying.map((q) => q.deal.sales_account_id).filter(Boolean))], 4, async (id) => {
    const r = await fs.search('/filtered_search/deal?per_page=1&page=1', { filter_rule: [
      { attribute: 'deal_stage_id', operator: 'is_in', value: [WON_STAGE_ID] },
      { attribute: 'sales_account_id', operator: 'is_in', value: [id] },
      { attribute: 'closed_date', operator: 'is_in_the_range', value: ['1990-01-01', dayBefore] },
    ] });
    priorWon[id] = Number(r.meta?.total) || 0;
  });
  const firstInMonth = {};
  for (const d of deals) {
    const a = d.sales_account_id;
    if (a && d.closed_date && (!firstInMonth[a] || d.closed_date < firstInMonth[a])) firstInMonth[a] = d.closed_date;
  }

  // 4. Revenue and pieces from the latest Osprey snapshot.
  const orderNos = [...new Set(qualifying.map((q) => String(q.deal.custom_field?.cf_order_number || '')).filter(Boolean))];
  const drops = {};
  if (orderNos.length) {
    const { data: snap, error: snapErr } = await supabase.from('osprey_mail_drops')
      .select('snapshot_id').order('captured_at', { ascending: false }).limit(1);
    if (snapErr) throw new Error(snapErr.message);
    const { data, error } = await supabase.from('osprey_mail_drops')
      .select('order_id, mail_drop_quantity, production_amount, postage_amount, actual_postage')
      .eq('snapshot_id', snap[0].snapshot_id).in('order_id', orderNos);
    if (error) throw new Error(error.message);
    for (const r of data) {
      const o = (drops[r.order_id] ||= { pieces: 0, production: 0, postage: 0 });
      o.pieces += r.mail_drop_quantity || 0;
      o.production += Number(r.production_amount) || 0;
      o.postage += Number(r.actual_postage || r.postage_amount) || 0;
    }
  }

  const rows = qualifying.map(({ deal: d, why }) => {
    const order = String(d.custom_field?.cf_order_number || '');
    const prior = priorWon[d.sales_account_id] || 0;
    const o = drops[order];
    return {
      account: accounts[d.sales_account_id]?.name || '(no account)', deal: d.name, dealId: d.id, order,
      closed: d.closed_date, type: prior ? 'Existing' : 'New',
      firstOrder: prior ? `Before ${label} (${prior} earlier order${prior === 1 ? '' : 's'})` : (firstInMonth[d.sales_account_id] || d.closed_date),
      production: o ? +o.production.toFixed(2) : Number(d.amount) || 0, postage: o ? +o.postage.toFixed(2) : 0,
      pieces: o ? o.pieces : 0, source: o ? 'Osprey drops' : 'Deal amount (order not in Osprey snapshot)', why: why.join('; '),
    };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.account.localeCompare(b.account) || a.closed.localeCompare(b.closed));

  const sum = (rs, k) => +rs.reduce((s, r) => s + r[k], 0).toFixed(2);
  const neu = rows.filter((r) => r.type === 'New');
  const old = rows.filter((r) => r.type === 'Existing');
  const postage = sum(neu, 'postage');
  const production = sum(neu, 'production');
  const share = +(production * REV_SHARE_PCT).toFixed(2);
  const newRevenue = +(production + postage).toFixed(2);
  const summary = {
    monthLabel: label, postage, production, share, totalUsps: +(postage + share).toFixed(2), totalCustomer: newRevenue,
    newCustomers: new Set(neu.map((r) => r.account)).size, newRevenue,
    existingCustomers: new Set(old.map((r) => r.account)).size,
    existingRevenue: +(sum(old, 'production') + sum(old, 'postage')).toFixed(2),
    transactions: neu.length, pieces: neu.reduce((s, r) => s + r.pieces, 0),
  };
  return { month, from, to, wonDealsInMonth: deals.length, contactsChecked: contactIds.size, summary, rows };
}

// Summary rows in the order of the USPS template (label, summary key, format).
export const SUMMARY_LINES = [
  ['Postage Revenue', 'postage', '$'],
  ['Production Revenue', 'production', '$'],
  ['USPS Reported Revenue Share', 'share', '$'],
  ['Total USPS Revenue', 'totalUsps', '$'],
  ['Total Customer Revenue', 'totalCustomer', '$'],
  ['Total New Customers', 'newCustomers', '#'],
  ['Total New Customer Revenue', 'newRevenue', '$'],
  ['Total Existing Customers', 'existingCustomers', '#'],
  ['Total Existing Customer Revenue', 'existingRevenue', '$'],
  ['Total Transactions', 'transactions', '#'],
  ['Total Volume / Mail pieces', 'pieces', '#'],
];
