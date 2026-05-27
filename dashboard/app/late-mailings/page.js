'use client';

// Late Mailings — single-screen view of every drop that's past est date but
// hasn't actually mailed yet. Mirrors the cashflow page's pastDueDrops set
// (is_live_status + drop_est_date < today + no drop_act_date) and uses the
// same effectivePostage() rules + EPS-deduction exclusion so the postage
// number on this page ties out exactly to the Past-Due Liability KPI.
//
// Three financial perspectives surface as KPIs:
//   1. Postage to catch up — what we need to fund EPS to actually mail these
//   2. PrePay deferred revenue — Stripe-paid drops we still owe service on
//   3. Terms uninvoiced revenue — NET30/NET45/Other drops NetSuite hasn't
//      invoiced yet because the drop hasn't shipped
//
// Bill Via per drop comes from customer_terms.term_label. Anything that
// isn't 'PrePay' falls under Terms; we further split Terms into NET30 /
// NET45 / Other for the chart and KPI subtext.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { exportToCSV } from '../../lib/export';
import { effectivePostage, isEstimatedPostage, isLdpMailMethod } from '../../lib/postage';
import { OspreyOrderLink, OspreyDropLink } from '../../lib/ospreyLinks';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => n == null ? '—' : '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';

// Date-only strings (YYYY-MM-DD) need T12:00:00 to avoid the UTC-midnight
// shift that bumps the displayed date back a day in Eastern time.
const ET = (iso) => {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Detroit' });
};

// "2026-05-27" + 7 → "2026-06-03"  (date-only arithmetic, no DST drift)
function addDays(d, n) {
  const r = new Date(d + 'T12:00:00');
  r.setDate(r.getDate() + n);
  return r.toISOString().split('T')[0];
}

// Same active-order filter cashflow uses, lifted up so anyone reading the
// page sees the exact set of statuses we treat as "still in flight".
const ACTIVE_ORDER_STATUSES = [
  'DAL [SUBMITTED]', 'DIGITAL READY', 'DIGITAL [STAGING]',
  'OUTSOURCED', 'OUTSOURCED [STAGING]',
];

// Aging bucket definitions. Each bucket is [minDays, maxDays] inclusive.
// 60+ uses Infinity so anything ancient lands there.
const AGING_BUCKETS = [
  { key: '1-7',   label: '1–7 d',   min: 1,  max: 7   },
  { key: '8-14',  label: '8–14 d',  min: 8,  max: 14  },
  { key: '15-30', label: '15–30 d', min: 15, max: 30  },
  { key: '31-60', label: '31–60 d', min: 31, max: 60  },
  { key: '60+',   label: '60+ d',   min: 61, max: Infinity },
];

// Map a customer_terms.term_label into one of our four buckets. We treat
// anything outside PrePay/NET30/NET45 (including null) as "Other" so the
// breakdown adds up to 100% no matter what's in the table.
function classifyTerm(label) {
  const t = (label || '').toUpperCase().trim();
  if (t === 'PREPAY') return 'PrePay';
  if (t === 'NET30')  return 'NET30';
  if (t === 'NET45')  return 'NET45';
  return 'Other';
}

function bucketFor(daysLate) {
  return AGING_BUCKETS.find(b => daysLate >= b.min && daysLate <= b.max) || AGING_BUCKETS[AGING_BUCKETS.length - 1];
}

// Color scale for aging buckets — gets redder as drops get older. Used on
// the days-late chip in the table.
function daysLateColor(d) {
  if (d <= 7)  return 'var(--status-warn)';
  if (d <= 30) return '#ea7c45';            // amber/orange
  return 'var(--status-critical)';
}

export default function LateMailingsPage() {
  const supabase = createClient();
  const [drops, setDrops] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [customerTerms, setCustomerTerms] = useState({});
  const [epsDeductedMap, setEpsDeductedMap] = useState({});
  const [hotJobs, setHotJobs] = useState(new Map());         // mail_drop_id → { reason, set_by }
  const [hotTooltip, setHotTooltip] = useState(null);        // null | { dropId, x, y } — hover card
  const [plannedDrops, setPlannedDrops] = useState(new Map()); // mail_drop_id → { planned_date, planned_by }
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('daysLate');
  const [sortDir, setSortDir] = useState('desc');
  const [planningMode, setPlanningMode] = useState(false);   // Planning Mode toggle
  const [planSelected, setPlanSelected] = useState(new Set()); // Set<mail_drop_id> checked in plan
  const [futureDrops, setFutureDrops] = useState([]);        // drops with drop_est_date >= today loaded into the plan view
  const [futureCutoffInput, setFutureCutoffInput] = useState(''); // value of the "add through date" picker
  const [savePlanModal, setSavePlanModal] = useState(null);  // null | { date } — save plan date picker modal
  const [planClearConfirm, setPlanClearConfirm] = useState(null); // null | { drop } — remove-from-plan confirm
  const [userEmail, setUserEmail] = useState('');

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const load = useCallback(async () => {
    setLoading(true);
    const since90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

    const [{ data: txns }, { data: dropData }] = await Promise.all([
      supabase.from('usps_transactions').select('*').gte('transaction_date', since90),
      // Pull every active live drop with an est date strictly before today and
      // no actual drop date — that's the "late" set. We deliberately don't
      // cap how far back to look, since old stalled drops are exactly what
      // this page is supposed to surface.
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_id, customer_name, product_category, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, actual_postage, mail_method, mail_drop_amount, mail_drop_quantity, payment_amount_applied, order_amount, web_id')
        .in('order_status', ACTIVE_ORDER_STATUSES)
        .eq('is_live_status', true)
        .lt('drop_est_date', today)
        .is('drop_act_date', null),
    ]);

    // Defensive dedupe by mail_drop_id (keep last row from sync results).
    // Then drop anything with mail_method = "LDP" — those are handled by LDP
    // and don't hit our EPS, so they shouldn't appear in our backlog views.
    const seen = new Map();
    for (const d of (dropData || [])) seen.set(d.mail_drop_id, d);
    const deduped = [...seen.values()].filter(d => !isLdpMailMethod(d));

    // Pull terms only for the customers actually present in the late set —
    // avoids the 1k row default cap on the full table.
    const customerIds = [...new Set(deduped.map(d => d.customer_id).filter(Boolean))];
    const termsMap = {};
    if (customerIds.length > 0) {
      const { data: termsData } = await supabase
        .from('customer_terms')
        .select('customer_id, term_label')
        .in('customer_id', customerIds);
      for (const t of (termsData || [])) termsMap[t.customer_id] = t.term_label;
    }

    // Build EPS-charged map. Same logic as cashflow: any drop whose
    // mail_drop_id appears as the osprey_mail_drop_id on a usps_transactions
    // row has already been deducted from EPS — we shouldn't include its
    // postage in "catch up" since the cash already left the account.
    const epsMap = {};
    for (const t of (txns || [])) {
      if (t.osprey_mail_drop_id && !epsMap[t.osprey_mail_drop_id]) {
        epsMap[t.osprey_mail_drop_id] = t.transaction_number;
      }
    }

    // Load currently-hot drops for read-only fire emoji display (with reason + set_by for tooltip)
    const { data: hotData } = await supabase
      .from('hot_jobs')
      .select('mail_drop_id, reason, set_by')
      .eq('is_hot', true);
    const hotSet = new Map();
    for (const h of (hotData || [])) hotSet.set(h.mail_drop_id, { reason: h.reason, set_by: h.set_by });

    // Load planned drops (always visible — drives the Planned column + cashflow clock icon)
    const { data: plannedData } = await supabase
      .from('planned_drops')
      .select('mail_drop_id, planned_date, planned_by');
    const plannedMap = new Map();
    for (const p of (plannedData || [])) plannedMap.set(p.mail_drop_id, { planned_date: p.planned_date, planned_by: p.planned_by });

    setTransactions(txns || []);
    setDrops(deduped);
    setCustomerTerms(termsMap);
    setEpsDeductedMap(epsMap);
    setHotJobs(hotSet);
    setPlannedDrops(plannedMap);
    setLoading(false);
  }, [today]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data?.user?.email || ''));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Enrich each drop with the fields the rest of the page needs:
  // billVia, daysLate (negative for future), postageRequired (post EPS-deduction),
  // epsCharged, isEst. Shared between lateDrops and futureDrops so both have the
  // same shape for rendering / running total / save plan.
  const enrichDrop = useCallback((d) => {
    const billVia = classifyTerm(customerTerms[d.customer_id]);
    const epsCharged = !!epsDeductedMap[d.mail_drop_id];
    const rawPostage = effectivePostage(d);
    const postageRequired = epsCharged ? 0 : rawPostage;
    const isEst = isEstimatedPostage(d);
    const daysLate = d.drop_est_date
      ? Math.floor((new Date(today + 'T12:00:00') - new Date(d.drop_est_date + 'T12:00:00')) / 86400000)
      : 0;
    return { ...d, billVia, epsCharged, rawPostage, isEst, postageRequired, daysLate };
  }, [customerTerms, epsDeductedMap, today]);

  const lateDrops = useMemo(() => drops.map(enrichDrop), [drops, enrichDrop]);
  const enrichedFutureDrops = useMemo(() => futureDrops.map(enrichDrop).map(d => ({ ...d, _isFuture: true })), [futureDrops, enrichDrop]);

  // KPI roll-ups. Postage is post-EPS-deduction; revenue numbers use the
  // full mail_drop_amount per the customer's contract regardless of how
  // much has been collected so far.
  const kpis = useMemo(() => {
    const totalPostage    = lateDrops.reduce((s, d) => s + d.postageRequired, 0);
    const prepayRevenue   = lateDrops.filter(d => d.billVia === 'PrePay').reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
    const net30Revenue    = lateDrops.filter(d => d.billVia === 'NET30').reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
    const net45Revenue    = lateDrops.filter(d => d.billVia === 'NET45').reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
    const otherRevenue    = lateDrops.filter(d => d.billVia === 'Other').reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
    const termsRevenue    = net30Revenue + net45Revenue + otherRevenue;
    const totalRevenue    = prepayRevenue + termsRevenue;
    return { totalPostage, prepayRevenue, net30Revenue, net45Revenue, otherRevenue, termsRevenue, totalRevenue };
  }, [lateDrops]);

  // Aging-bucket table for the chart. Each bucket gets postage + revenue
  // split by term, so a stacked-bar chart can show the term mix per bucket.
  const aging = useMemo(() => {
    const empty = () => ({ postage: 0, prepay: 0, net30: 0, net45: 0, other: 0, count: 0 });
    const buckets = Object.fromEntries(AGING_BUCKETS.map(b => [b.key, empty()]));
    for (const d of lateDrops) {
      const b = bucketFor(d.daysLate);
      const slot = buckets[b.key];
      slot.postage += d.postageRequired;
      slot.count   += 1;
      const revenue = d.mail_drop_amount || 0;
      if (d.billVia === 'PrePay') slot.prepay += revenue;
      else if (d.billVia === 'NET30') slot.net30 += revenue;
      else if (d.billVia === 'NET45') slot.net45 += revenue;
      else slot.other += revenue;
    }
    // Round to clean dollar values for chart tooltips.
    return AGING_BUCKETS.map(b => ({
      label: b.label,
      key: b.key,
      postage: +buckets[b.key].postage.toFixed(2),
      prepay:  +buckets[b.key].prepay.toFixed(2),
      net30:   +buckets[b.key].net30.toFixed(2),
      net45:   +buckets[b.key].net45.toFixed(2),
      other:   +buckets[b.key].other.toFixed(2),
      count:   buckets[b.key].count,
    }));
  }, [lateDrops]);

  // Sortable rows. Default is daysLate desc (oldest first). Click a header
  // to flip the sort or pick a new column.
  const sortedRows = useMemo(() => {
    const rows = [...lateDrops];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Strings vs numbers — string compare for non-numeric, numeric otherwise.
      let cmp;
      if (typeof av === 'string' || typeof bv === 'string') {
        cmp = String(av || '').localeCompare(String(bv || ''));
      } else {
        cmp = (av || 0) - (bv || 0);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [lateDrops, sortKey, sortDir]);

  // Running cumulative postage as you scan the table top-to-bottom in the
  // current sort order. Future drops always go at the bottom (chronological)
  // regardless of sort — the user's "Add Future Days" view is a planning
  // append, not a sort-aware row.
  const sortedRowsWithRunning = useMemo(() => {
    let running = 0;
    const lateWithRunning = sortedRows.map(d => {
      running += d.postageRequired;
      return { ...d, runningTotal: +running.toFixed(2) };
    });
    const futureWithRunning = [...enrichedFutureDrops]
      .sort((a, b) => (a.drop_est_date || '').localeCompare(b.drop_est_date || ''))
      .map(d => {
        running += d.postageRequired;
        return { ...d, runningTotal: +running.toFixed(2) };
      });
    return [...lateWithRunning, ...futureWithRunning];
  }, [sortedRows, enrichedFutureDrops]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'daysLate' ? 'desc' : 'asc');
    }
  }

  // ── Future Days picker (planning mode) ───────────────────────────────────
  // Loads drops with drop_est_date in [today, cutoff] that aren't already in
  // the late set. Per user choice: picking 5/30 brings in everything from
  // today through 5/30 in one batch (option "All drops scheduled up to that date").
  const addFutureDrops = useCallback(async () => {
    if (!futureCutoffInput) return;
    const maxDate = addDays(today, 7);
    const cutoff = futureCutoffInput > maxDate ? maxDate : futureCutoffInput;
    const { data, error } = await supabase.from('osprey_mail_drops')
      .select('mail_drop_id, order_id, customer_id, customer_name, product_category, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, actual_postage, mail_method, mail_drop_amount, mail_drop_quantity, payment_amount_applied, order_amount, web_id')
      .in('order_status', ACTIVE_ORDER_STATUSES)
      .eq('is_live_status', true)
      .gte('drop_est_date', today)
      .lte('drop_est_date', cutoff)
      .is('drop_act_date', null);
    if (error) { console.error('Failed to load future drops:', error.message); return; }
    const seen = new Map();
    for (const d of (data || [])) seen.set(d.mail_drop_id, d);
    const existingIds = new Set([...drops, ...futureDrops].map(d => d.mail_drop_id));
    const newOnes = [...seen.values()].filter(d => !isLdpMailMethod(d) && !existingIds.has(d.mail_drop_id));
    if (newOnes.length === 0) { setFutureCutoffInput(''); return; }
    setFutureDrops(prev => [...prev, ...newOnes]);
    // Fetch any missing customer term labels
    const newCustomerIds = [...new Set(newOnes.map(d => d.customer_id).filter(c => c && !customerTerms[c]))];
    if (newCustomerIds.length > 0) {
      const { data: termsData } = await supabase.from('customer_terms').select('customer_id, term_label').in('customer_id', newCustomerIds);
      if (termsData) setCustomerTerms(prev => { const next = { ...prev }; for (const t of termsData) next[t.customer_id] = t.term_label; return next; });
    }
    setFutureCutoffInput('');
  }, [futureCutoffInput, today, drops, futureDrops, customerTerms, supabase]);

  // ── Save Plan ────────────────────────────────────────────────────────────
  // Upserts planned_drops for every currently-checked row with the picked
  // date. One row per mail_drop_id (re-save overwrites). Logs to notifications.
  const savePlan = useCallback(async (planDate) => {
    if (planSelected.size === 0 || !planDate) return;
    const now = new Date().toISOString();
    const rows = [...planSelected].map(mid => ({ mail_drop_id: mid, planned_date: planDate, planned_by: userEmail, planned_at: now }));
    const { error } = await supabase.from('planned_drops').upsert(rows, { onConflict: 'mail_drop_id' });
    if (error) { console.error('Save plan failed:', error.message); alert('Failed to save plan: ' + error.message); return; }
    await supabase.from('notifications').insert({
      event_type: 'plan_saved',
      title: `📅 Plan saved — ${planSelected.size} drop${planSelected.size !== 1 ? 's' : ''} for ${planDate}`,
      body: `${planSelected.size} drops planned for ${planDate} by ${userEmail || 'unknown'}`,
      severity: 'info',
      source: 'planned_drops',
      data_json: { count: planSelected.size, planned_date: planDate, planned_by: userEmail },
    });
    setPlannedDrops(prev => { const next = new Map(prev); for (const mid of planSelected) next.set(mid, { planned_date: planDate, planned_by: userEmail }); return next; });
    setPlanSelected(new Set());
    setSavePlanModal(null);
  }, [planSelected, userEmail, supabase]);

  // ── Clear Plan (remove a single drop from the plan) ──────────────────────
  const clearPlan = useCallback(async (drop) => {
    const { error } = await supabase
      .from('planned_drops')
      .delete()
      .eq('mail_drop_id', drop.mail_drop_id);
    if (error) { console.error('Clear plan failed:', error.message); return; }
    await supabase.from('notifications').insert({
      event_type: 'plan_cleared',
      title: `Plan removed — Drop ${drop.mail_drop_id}`,
      body: `${drop.customer_name || drop.mail_drop_id} removed from plan by ${userEmail || 'unknown'}`,
      severity: 'info',
      source: 'planned_drops',
      data_json: { mail_drop_id: drop.mail_drop_id, cleared_by: userEmail },
    });
    setPlannedDrops(prev => { const m = new Map(prev); m.delete(drop.mail_drop_id); return m; });
  }, [userEmail, supabase]);

  function handleExport() {
    // Export uses the running-total view so the CSV reflects exactly what
    // the user sees on screen, including the cumulative postage column.
    const rows = sortedRowsWithRunning.map(d => ({
      'Days Late': d.daysLate,
      'Est Date': d.drop_est_date || '',
      'Customer': d.customer_name || '',
      'Customer ID': d.customer_id || '',
      'Product': d.product_category || '',
      'Mail Method': d.mail_method || '',
      'Bill Via': d.billVia,
      'Quantity': d.mail_drop_quantity || 0,
      'Drop Amount': (d.mail_drop_amount || 0).toFixed(2),
      'Postage Required': d.postageRequired.toFixed(2),
      'Postage Source': d.isEst ? 'estimated' : 'actual',
      'Running Total': d.runningTotal.toFixed(2),
      'EPS Charged': d.epsCharged ? 'Yes' : 'No',
      'Order Status': d.order_status || '',
      'Drop Status': d.drop_status || '',
      'Order ID': d.order_id || '',
      'Mail Drop ID': d.mail_drop_id,
    }));
    exportToCSV(rows, `late-mailings-${today}`);
  }

  if (loading) {
    return <div className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>Loading late mailings…</div>;
  }

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Late Mailings</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Live drops with an est. date before today and no actual drop date. Postage rules match the cashflow page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport}
            className="text-xs px-3 py-1.5 rounded font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
            Export CSV
          </button>
        </div>
      </div>

      {/* KPI cards: postage required, deferred PrePay revenue, uninvoiced
          Terms revenue (with sub-breakdown), and combined late revenue. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl p-4 border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          title="Sum of effectivePostage() across late drops, excluding any already charged to EPS. This is what we need to fund the EPS account to actually catch up.">
          <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Postage to Catch Up</p>
          <p className="text-xl font-bold" style={{ color: kpis.totalPostage > 0 ? 'var(--status-warn)' : 'var(--text-primary)' }}>
            {fmt$(kpis.totalPostage)}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {lateDrops.length} late drop{lateDrops.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="rounded-xl p-4 border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          title="Drop amount for late drops where the customer is on PrePay (Stripe). Cash is already in the bank; the matching service hasn't been delivered yet, so it sits as deferred revenue.">
          <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Deferred Revenue (PrePay)</p>
          <p className="text-xl font-bold" style={{ color: 'var(--accent)' }}>{fmt$(kpis.prepayRevenue)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {lateDrops.filter(d => d.billVia === 'PrePay').length} drop{lateDrops.filter(d => d.billVia === 'PrePay').length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="rounded-xl p-4 border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          title="Drop amount for late drops on net terms (NET30/NET45/Other). NetSuite hasn't invoiced these yet because the drops haven't shipped.">
          <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Uninvoiced Revenue (Terms)</p>
          <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(kpis.termsRevenue)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            NET30 {fmt$(kpis.net30Revenue)} • NET45 {fmt$(kpis.net45Revenue)} • Other {fmt$(kpis.otherRevenue)}
          </p>
        </div>

        <div className="rounded-xl p-4 border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          title="PrePay deferred revenue + Terms uninvoiced revenue. The full revenue exposure of the late backlog.">
          <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Total Late Revenue</p>
          <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(kpis.totalRevenue)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Drop amount stuck in the backlog
          </p>
        </div>
      </div>

      {/* Aging charts side by side: postage to fund per bucket, and revenue
          per bucket stacked by billing term. Both share the same x-axis so
          you can read across to see e.g. "60+ days has $X late and $Y of it
          is on PrePay so cash is sitting deferred". */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
            Postage Required by Aging Bucket
          </h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={aging}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <Tooltip
                formatter={(v) => fmt$(v)}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <Bar dataKey="postage" name="Postage" fill="var(--status-warn)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
            Late Revenue by Aging Bucket (stacked by terms)
          </h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={aging}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <Tooltip
                formatter={(v, n) => [fmt$(v), n]}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {/* Explicit hex colors for the term categories so they don't
                  collide with theme accent vars (which can both resolve to
                  green and make PrePay + NET30 visually identical). These
                  semantic colors stay stable across light/dark/mono themes. */}
              <Bar dataKey="prepay" name="PrePay" stackId="rev" fill="#16a34a" />
              <Bar dataKey="net30"  name="NET30"  stackId="rev" fill="#2563eb" />
              <Bar dataKey="net45"  name="NET45"  stackId="rev" fill="#7c3aed" />
              <Bar dataKey="other"  name="Other"  stackId="rev" fill="#94a3b8" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* The drop-by-drop list. Default sort is daysLate desc so the oldest
          stuff is at the top — that's almost always what you came here for. */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                Late Drops ({sortedRows.length}{enrichedFutureDrops.length > 0 ? ` + ${enrichedFutureDrops.length} future` : ''})
              </h2>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}>
                {/* Toggle track */}
                <span
                  onClick={() => {
                    setPlanningMode(p => !p);
                    setPlanSelected(new Set());
                    setFutureDrops([]);          // future drops are a planning-mode-only construct
                    setFutureCutoffInput('');
                  }}
                  style={{
                    display: 'inline-flex', alignItems: 'center',
                    width: 32, height: 18, borderRadius: 9, padding: 2,
                    background: planningMode ? 'var(--accent)' : 'var(--border)',
                    transition: 'background 0.2s',
                    cursor: 'pointer', flexShrink: 0,
                  }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: '50%', background: '#fff',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                    transform: planningMode ? 'translateX(14px)' : 'translateX(0)',
                    transition: 'transform 0.2s',
                    display: 'block',
                  }} />
                </span>
                <span
                  onClick={() => {
                    setPlanningMode(p => !p);
                    setPlanSelected(new Set());
                    setFutureDrops([]);
                    setFutureCutoffInput('');
                  }}
                  style={{ fontSize: 12, color: planningMode ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: planningMode ? 600 : 400 }}>
                  Planning Mode
                </span>
              </label>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {planningMode
                ? 'Check rows to build a postage plan. Click Save Plan or Export Selected to act on it.'
                : 'Click a column header to re-sort. Running Total accumulates postage top-down. Strikethrough postage = already charged to EPS. (est) = estimate from Osprey.'}
            </p>
          </div>
          {/* Planning-mode-only: Add Future Days picker */}
          {planningMode && (
            <div className="px-4 pb-3 pt-1 flex items-center gap-3 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>📆 Add Future Days:</span>
              <input
                type="date"
                value={futureCutoffInput}
                min={today}
                max={addDays(today, 7)}
                onChange={e => setFutureCutoffInput(e.target.value)}
                style={{
                  fontSize: 12, padding: '4px 8px', borderRadius: 6,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', outline: 'none',
                }}
              />
              <button
                onClick={addFutureDrops}
                disabled={!futureCutoffInput}
                style={{
                  fontSize: 12, padding: '4px 12px', borderRadius: 6, fontWeight: 600,
                  background: futureCutoffInput ? 'var(--accent)' : 'var(--surface2)',
                  color: futureCutoffInput ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  cursor: futureCutoffInput ? 'pointer' : 'not-allowed',
                }}>
                Save
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Adds every drop with est date from today through the picked date (max +7 days).
              </span>
              {enrichedFutureDrops.length > 0 && (
                <button
                  onClick={() => setFutureDrops([])}
                  style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 6,
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    color: 'var(--text-secondary)', cursor: 'pointer',
                    marginLeft: 'auto',
                  }}>
                  Clear future drops
                </button>
              )}
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)', color: 'var(--text-secondary)' }}>
              <tr>
                {/* Planning Mode: Include checkbox column */}
                {planningMode && (
                  <th className="px-2 py-2 w-8 text-center font-medium"
                    style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                    Include
                  </th>
                )}
                {/* Fire emoji column — read-only, not sortable */}
                <th className="px-2 py-2 w-8" />
                {[
                  { key: 'daysLate',           label: 'Days Late',  align: 'left' },
                  { key: 'drop_est_date',      label: 'Est Date',   align: 'left' },
                  { key: 'customer_name',      label: 'Customer',   align: 'left' },
                  { key: 'product_category',   label: 'Product',    align: 'left' },
                  { key: 'order_id',           label: 'Order ID',   align: 'left' },
                  { key: 'mail_drop_id',       label: 'Drop ID',    align: 'left' },
                  { key: 'billVia',            label: 'Bill Via',   align: 'left' },
                  { key: 'mail_drop_quantity', label: 'Qty',        align: 'right' },
                  { key: 'mail_drop_amount',   label: 'Drop Amt',   align: 'right' },
                  { key: 'postageRequired',    label: 'Postage',    align: 'right' },
                ].flatMap(col => {
                  const active = sortKey === col.key;
                  const th = (
                    <th key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`px-3 py-2 font-medium cursor-pointer select-none ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                      style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {col.label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  );
                  // Inject the (non-sortable) Planned column right after Est Date.
                  if (col.key === 'drop_est_date') {
                    return [th, (
                      <th key="planned" className="px-3 py-2 font-medium text-left select-none"
                        style={{ color: 'var(--text-secondary)' }}
                        title="Date this drop is planned for (set via Save Plan in Planning Mode)">
                        Planned
                      </th>
                    )];
                  }
                  return [th];
                })}
                {/* Running Total is intentionally NOT sortable — its values are
                    derived from the current sort order, so sorting by it
                    would create a paradox. */}
                <th className="px-3 py-2 font-medium text-right select-none"
                  style={{ color: 'var(--text-secondary)' }}
                  title="Cumulative postage top-down in the current sort order. Final row = total Postage to Catch Up.">
                  Running Total
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRowsWithRunning.length === 0 && (
                <tr>
                  <td colSpan={planningMode ? 14 : 13} className="px-3 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                    No late drops. 🎉
                  </td>
                </tr>
              )}
              {sortedRowsWithRunning.map(d => {
                const plannedInfo = plannedDrops.get(d.mail_drop_id);
                const isFuture = d._isFuture;
                // Future drops get a subtle accent-tinted background so they read
                // as "added to plan" rather than late. Selected rows still win.
                const rowBg = planningMode && planSelected.has(d.mail_drop_id)
                  ? 'var(--accent-light)'
                  : isFuture ? 'var(--surface2)' : undefined;
                // Days Late chip: late=Nd (red), today=Today (warn), future=+Nd (accent)
                const chipLabel = d.daysLate > 0 ? `${d.daysLate}d` : d.daysLate === 0 ? 'Today' : `+${-d.daysLate}d`;
                const chipColor = d.daysLate > 0 ? daysLateColor(d.daysLate) : d.daysLate === 0 ? 'var(--status-warn)' : 'var(--accent)';
                return (
                <tr key={d.mail_drop_id} style={{ borderTop: '1px solid var(--border)', background: rowBg }}>
                  {/* Planning Mode checkbox */}
                  {planningMode && (
                    <td className="px-2 py-1.5 w-8 text-center">
                      <input
                        type="checkbox"
                        checked={planSelected.has(d.mail_drop_id)}
                        onChange={() => {
                          setPlanSelected(prev => {
                            const next = new Set(prev);
                            next.has(d.mail_drop_id) ? next.delete(d.mail_drop_id) : next.add(d.mail_drop_id);
                            return next;
                          });
                        }}
                        style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
                      />
                    </td>
                  )}
                  <td className="px-2 py-1.5 w-8 text-center">
                    {hotJobs.has(d.mail_drop_id) && (
                      <span
                        onMouseEnter={e => setHotTooltip({ dropId: d.mail_drop_id, x: e.clientX, y: e.clientY })}
                        onMouseMove={e => setHotTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
                        onMouseLeave={() => setHotTooltip(null)}
                        style={{ fontSize: 14, lineHeight: 1, cursor: 'default', display: 'inline-block' }}
                      >🔥</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: 'var(--surface2)', color: chipColor }}>
                      {chipLabel}
                    </span>
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(d.drop_est_date)}</td>
                  {/* Planned column — shows planned_date if set. Click to clear. */}
                  <td className="px-3 py-1.5"
                    onClick={plannedInfo ? () => setPlanClearConfirm({ drop: d }) : undefined}
                    style={{
                      color: plannedInfo ? 'var(--accent)' : 'var(--text-muted)',
                      fontWeight: plannedInfo ? 600 : 'normal',
                      cursor: plannedInfo ? 'pointer' : 'default',
                    }}
                    title={plannedInfo ? 'Click to remove from plan' : undefined}>
                    {plannedInfo ? `⏰ ${ET(plannedInfo.planned_date)}` : '—'}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                  <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
                    <OspreyOrderLink id={d.order_id} />
                  </td>
                  <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
                    <OspreyDropLink id={d.mail_drop_id} />
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{
                        background: d.billVia === 'PrePay' ? 'var(--status-ok-bg)' : 'var(--surface2)',
                        color:      d.billVia === 'PrePay' ? 'var(--status-ok)'    : 'var(--text-secondary)',
                      }}>
                      {d.billVia}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                    {d.mail_drop_quantity?.toLocaleString() || '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium" style={{ color: 'var(--text-primary)' }}>
                    {fmt$(d.mail_drop_amount)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium"
                    style={{
                      color: d.epsCharged ? 'var(--text-muted)' : 'var(--text-primary)',
                      textDecoration: d.epsCharged ? 'line-through' : 'none',
                    }}
                    title={d.epsCharged ? 'Already charged to EPS — excluded from "Postage to Catch Up"' : (d.isEst ? 'Estimated postage — Osprey hasn\'t posted the actual yet' : '')}>
                    {fmt$(d.rawPostage)}
                    {d.isEst && d.rawPostage > 0 && (
                      <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(est)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right"
                    style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt$(d.runningTotal)}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Planning Mode floating bar ────────────────────────────────────── */}
      {planningMode && planSelected.size > 0 && (() => {
        const selectedDrops = sortedRowsWithRunning.filter(d => planSelected.has(d.mail_drop_id));
        const planPostageTotal = selectedDrops.reduce((sum, d) => sum + (d.rawPostage || 0), 0);
        return (
          <div style={{
            position: 'fixed', bottom: 24, right: 28,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex', alignItems: 'center', gap: 16,
            boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
            zIndex: 9000,
            minWidth: 280,
          }}>
            <div>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                {planSelected.size} drop{planSelected.size !== 1 ? 's' : ''} selected
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {fmt$(planPostageTotal)}
              </p>
            </div>
            <button
              onClick={() => setSavePlanModal({ date: today })}
              style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: 'var(--status-ok)', border: 'none', color: '#fff', fontWeight: 600,
                whiteSpace: 'nowrap',
              }}>
              Save Plan
            </button>
            <button
              onClick={() => {
                const rows = selectedDrops.map(d => ({
                  'Est Date':   d.drop_est_date || '',
                  'Customer':   d.customer_name || '',
                  'Product':    d.product_category || '',
                  'Order ID':   d.order_id || '',
                  'Drop ID':    d.mail_drop_id || '',
                  'Qty':        d.mail_drop_quantity ?? '',
                  'Postage':    (d.rawPostage || 0).toFixed(2),
                }));
                exportToCSV(rows, `late-mailings-plan-${new Date().toISOString().split('T')[0]}`);
              }}
              style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
                whiteSpace: 'nowrap',
              }}>
              Export CSV
            </button>
          </div>
        );
      })()}

      {/* ── Save Plan date picker modal ───────────────────────────────────── */}
      {savePlanModal && (
        <div
          onClick={() => setSavePlanModal(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999,
          }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '20px 24px',
              width: 340,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}>
            <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
              Save Plan
            </p>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
              Set the plan date for {planSelected.size} selected drop{planSelected.size !== 1 ? 's' : ''}. If a drop already has a plan date, it will be overwritten.
            </p>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Plan date</label>
            <input
              type="date"
              value={savePlanModal.date}
              min={today}
              onChange={e => setSavePlanModal({ date: e.target.value })}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '8px 10px', fontSize: 13,
                color: 'var(--text-primary)', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setSavePlanModal(null)}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                }}>
                Cancel
              </button>
              <button
                onClick={() => savePlan(savePlanModal.date)}
                disabled={!savePlanModal.date || savePlanModal.date < today}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13,
                  cursor: (!savePlanModal.date || savePlanModal.date < today) ? 'not-allowed' : 'pointer',
                  background: 'var(--status-ok)', border: 'none', color: '#fff', fontWeight: 600,
                  opacity: (!savePlanModal.date || savePlanModal.date < today) ? 0.5 : 1,
                }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hot Job hover tooltip ─────────────────────────────────────────── */}
      {hotTooltip && (() => {
        const info = hotJobs.get(hotTooltip.dropId);
        if (!info) return null;
        return (
          <div style={{
            position: 'fixed',
            left: hotTooltip.x + 14,
            top: hotTooltip.y - 12,
            zIndex: 9998,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: 12,
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            pointerEvents: 'none',
            minWidth: 180,
            maxWidth: 280,
          }}>
            <p style={{ margin: '0 0 6px', fontWeight: 700, color: 'var(--text-primary)', fontSize: 13 }}>🔥 Hot Job</p>
            <p style={{ margin: '0 0 2px', color: 'var(--text-muted)', fontSize: 11 }}>Set by</p>
            <p style={{ margin: '0 0 6px', color: 'var(--text-secondary)' }}>{info.set_by || '—'}</p>
            {info.reason ? (
              <>
                <p style={{ margin: '0 0 2px', color: 'var(--text-muted)', fontSize: 11 }}>Reason</p>
                <p style={{ margin: 0, color: 'var(--text-primary)', fontStyle: 'italic' }}>"{info.reason}"</p>
              </>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-muted)', fontStyle: 'italic' }}>No reason provided</p>
            )}
          </div>
        );
      })()}

      {/* ── Remove-from-plan confirm dialog ───────────────────────────────── */}
      {planClearConfirm && (() => {
        const info = plannedDrops.get(planClearConfirm.drop.mail_drop_id);
        return (
          <div
            onClick={() => setPlanClearConfirm(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 9999,
            }}>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '20px 24px',
                width: 360,
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              }}>
              <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                Remove from Plan?
              </p>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-muted)' }}>
                {planClearConfirm.drop.customer_name || planClearConfirm.drop.mail_drop_id} — Drop {planClearConfirm.drop.mail_drop_id}
              </p>
              {info && (
                <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  Currently planned for <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{ET(info.planned_date)}</span>.
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setPlanClearConfirm(null)}
                  style={{
                    padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                    background: 'var(--surface2)', border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                  }}>
                  Cancel
                </button>
                <button
                  onClick={() => { clearPlan(planClearConfirm.drop); setPlanClearConfirm(null); }}
                  style={{
                    padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                    background: 'var(--status-critical)', border: 'none', color: '#fff', fontWeight: 600,
                  }}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
