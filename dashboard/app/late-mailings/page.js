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
  const [hotJobs, setHotJobs] = useState(new Set());         // Set<mail_drop_id> currently hot
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState('daysLate');
  const [sortDir, setSortDir] = useState('desc');
  const [planningMode, setPlanningMode] = useState(false);   // Planning Mode toggle
  const [planSelected, setPlanSelected] = useState(new Set()); // Set<mail_drop_id> checked in plan

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

    // Load currently-hot drops for read-only fire emoji display
    const { data: hotData } = await supabase
      .from('hot_jobs')
      .select('mail_drop_id')
      .eq('is_hot', true);
    const hotSet = new Set((hotData || []).map(h => h.mail_drop_id));

    setTransactions(txns || []);
    setDrops(deduped);
    setCustomerTerms(termsMap);
    setEpsDeductedMap(epsMap);
    setHotJobs(hotSet);
    setLoading(false);
  }, [today]);

  useEffect(() => { load(); }, [load]);

  // Enrich each late drop with the fields the rest of the page needs:
  // billVia, daysLate, postageRequired (post EPS-deduction), epsCharged,
  // isEst (whether the postage figure is from estimate vs. actual — used
  // to render the (est) suffix on row-level displays).
  const lateDrops = useMemo(() => {
    return drops.map(d => {
      const billVia = classifyTerm(customerTerms[d.customer_id]);
      const epsCharged = !!epsDeductedMap[d.mail_drop_id];
      const rawPostage = effectivePostage(d);
      const postageRequired = epsCharged ? 0 : rawPostage;
      const isEst = isEstimatedPostage(d);
      const daysLate = d.drop_est_date
        ? Math.floor((new Date(today + 'T12:00:00') - new Date(d.drop_est_date + 'T12:00:00')) / 86400000)
        : 0;
      return {
        ...d,
        billVia,
        epsCharged,
        rawPostage,
        isEst,
        postageRequired,
        daysLate,
      };
    });
  }, [drops, customerTerms, epsDeductedMap, today]);

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
  // current sort order. We use postageRequired (post-EPS-deduction), so the
  // last row's runningTotal equals the "Postage to Catch Up" KPI exactly,
  // and EPS-already-charged rows contribute $0 — matching the strikethrough
  // convention. Recomputed whenever sortedRows changes (i.e. on re-sort).
  const sortedRowsWithRunning = useMemo(() => {
    let running = 0;
    return sortedRows.map(d => {
      running += d.postageRequired;
      return { ...d, runningTotal: +running.toFixed(2) };
    });
  }, [sortedRows]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'daysLate' ? 'desc' : 'asc');
    }
  }

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
        <div className="px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Late Drops ({sortedRows.length})
            </h2>
            <button
              onClick={() => {
                setPlanningMode(p => !p);
                setPlanSelected(new Set());
              }}
              className="text-xs px-2.5 py-1 rounded font-medium"
              style={{
                background: planningMode ? 'var(--accent)' : 'var(--surface2)',
                color:      planningMode ? '#fff'          : 'var(--text-secondary)',
                border:     planningMode ? 'none'          : '1px solid var(--border)',
                cursor: 'pointer',
              }}>
              {planningMode ? '📋 Planning Mode ON' : '📋 Planning Mode'}
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {planningMode
              ? 'Check rows to build a postage plan. Click export to download selected.'
              : 'Click a column header to re-sort. Running Total accumulates postage top-down in the current sort order. Strikethrough postage = drop already charged to EPS. (est) = estimate from Osprey, actual not yet posted.'}
          </p>
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
                ].map(col => {
                  const active = sortKey === col.key;
                  return (
                    <th key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`px-3 py-2 font-medium cursor-pointer select-none ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                      style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {col.label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  );
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
                  <td colSpan={planningMode ? 13 : 12} className="px-3 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                    No late drops. 🎉
                  </td>
                </tr>
              )}
              {sortedRowsWithRunning.map(d => (
                <tr key={d.mail_drop_id} style={{ borderTop: '1px solid var(--border)', background: planningMode && planSelected.has(d.mail_drop_id) ? 'var(--accent-light)' : undefined }}>
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
                        title={`Hot job — flagged on Cashflow tab`}
                        style={{ fontSize: 14, lineHeight: 1, cursor: 'default' }}
                      >🔥</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: 'var(--surface2)', color: daysLateColor(d.daysLate) }}>
                      {d.daysLate}d
                    </span>
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(d.drop_est_date)}</td>
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
              ))}
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
    </div>
  );
}
