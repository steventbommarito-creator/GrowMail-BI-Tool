'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import { effectivePostage, isLdpMailMethod } from '../../lib/postage';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';

// ─── Order Status whitelist ───────────────────────────────────────────────────
const FORECAST_STATUSES = [
  'INCOMING [APPROVED]',
  'DESIGN', 'DESIGN [PROOF]', 'DESIGN [PROOF - INT]', 'DESIGN [REUPLOAD]',
  'DESIGN PROOF QC', 'DESIGN FINAL QC', 'DESIGN APPROVED',
  'GRAPHICS [WIP]',
  'PREPRESS', 'PREPRESS [PROOF]', 'PREPRESS [REUPLOAD]', 'PREPRESS [PCCB]',
  'PROOF APPROVED', 'QC APPROVAL', 'PRESS [READY]',
  'DIGITAL READY', 'DIGITAL OUTSOURCED', 'DIGITAL [STAGING]', 'DIGITAL [CUTTING]', 'DIGITAL [SHIPPING]',
  'DAL [STAGING]', 'DAL [SUBMITTED]',
  'DMM [STAGING]', 'DMM [ACTIVE]',
  'OUTSOURCED', 'OUTSOURCED [STAGING]', 'OUTSOURCED [LVC]',
  'WAREHOUSE [KSCOPE]', 'WAREHOUSE [LVC]',
  'READY [MAIL]', 'SHIPPED', 'ACTIVE RUN', 'COMPLETE',
];

// ─── Order status buckets ─────────────────────────────────────────────────────
const ORDER_BUCKETS = {
  'Pre-Production': '#8b5cf6',
  'Press':          '#3b82f6',
  'Digital':        '#06b6d4',
  'Outsourced':     '#f59e0b',
  'Mail Ready':     '#10b981',
};

const ORDER_BUCKET_STATUSES = {
  'Pre-Production': ['INCOMING [APPROVED]', 'DESIGN', 'DESIGN [PROOF]', 'DESIGN [PROOF - INT]', 'DESIGN [REUPLOAD]', 'DESIGN PROOF QC', 'DESIGN FINAL QC', 'DESIGN APPROVED', 'GRAPHICS [WIP]'],
  'Press':          ['PREPRESS', 'PREPRESS [PROOF]', 'PREPRESS [REUPLOAD]', 'PREPRESS [PCCB]', 'PROOF APPROVED', 'QC APPROVAL', 'PRESS [READY]'],
  'Digital':        ['DIGITAL READY', 'DIGITAL OUTSOURCED', 'DIGITAL [STAGING]', 'DIGITAL [CUTTING]', 'DIGITAL [SHIPPING]', 'DAL [STAGING]', 'DAL [SUBMITTED]', 'DMM [STAGING]', 'DMM [ACTIVE]'],
  'Outsourced':     ['OUTSOURCED', 'OUTSOURCED [STAGING]', 'OUTSOURCED [LVC]', 'WAREHOUSE [KSCOPE]', 'WAREHOUSE [LVC]', 'ACTIVE RUN'],
  'Mail Ready':     ['READY [MAIL]', 'SHIPPED', 'COMPLETE'],
};

function orderBucket(status) {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s.startsWith('DESIGN') || s === 'INCOMING [APPROVED]' || s === 'GRAPHICS [WIP]') return 'Pre-Production';
  if (s.startsWith('PREPRESS') || s.includes('PROOF') || s === 'QC APPROVAL' || s === 'PRESS [READY]') return 'Press';
  if (s.startsWith('DIGITAL') || s.startsWith('DAL') || s.startsWith('DMM')) return 'Digital';
  if (s.startsWith('OUTSOURCED') || s.startsWith('WAREHOUSE') || s === 'ACTIVE RUN') return 'Outsourced';
  if (s === 'READY [MAIL]' || s === 'SHIPPED' || s === 'COMPLETE') return 'Mail Ready';
  return null;
}

// ─── Drop status buckets ──────────────────────────────────────────────────────
const DROP_BUCKETS = {
  'Pre-Mail':      '#8b5cf6',
  'In Production': '#3b82f6',
  'EDDM':          '#06b6d4',
  'Near Mail':     '#10b981',
  'Outsourced/WH': '#f59e0b',
  'On Hold':       '#ef4444',
};

const DROP_BUCKET_STATUSES = {
  'Pre-Mail':      ['NEW', 'LIST RECEIVED', 'SCHEDULED', 'MAILING_LIST_IMPORTED', 'INITIAL', 'QUOTED'],
  'In Production': ['PRODUCTION', 'INKJETTING', 'DAL', 'DAL SUBMITTED', 'OUTSOURCED'],
  'EDDM':          ['EDDM AWAITING ROUTES', 'EDDM PROCESSED', 'EDDM ROUTES ASSIGNED', 'EDDM ROUTES RECEIVED', '(any EDDM* status)'],
  'Near Mail':     ['READY SHIP', 'PENDING SHIP', 'RFL'],
  'Outsourced/WH': ['WAREHOUSE'],
  'On Hold':       ['HOLD [CUST]', 'HOLD [MGR]', 'PAUSED'],
};

function dropBucket(status) {
  if (!status) return null;
  const s = status.toUpperCase().trim();
  if (['NEW', 'LIST RECEIVED', 'SCHEDULED', 'MAILING_LIST_IMPORTED', 'INITIAL', 'QUOTED'].includes(s)) return 'Pre-Mail';
  if (['PRODUCTION', 'INKJETTING', 'DAL', 'DAL SUBMITTED', 'OUTSOURCED'].includes(s)) return 'In Production';
  if (s.startsWith('EDDM')) return 'EDDM';
  if (['READY SHIP', 'PENDING SHIP', 'RFL'].includes(s)) return 'Near Mail';
  if (['WAREHOUSE'].includes(s)) return 'Outsourced/WH';
  if (s.startsWith('HOLD') || s === 'PAUSED') return 'On Hold';
  return null;
}

// ─── Info tooltip component ───────────────────────────────────────────────────
function InfoTip({ statuses, color }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center" style={{ verticalAlign: 'middle' }}>
      <button
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center justify-center rounded-full text-xs font-bold ml-1 flex-shrink-0"
        style={{
          width: 14, height: 14,
          background: color + '22',
          color,
          border: `1px solid ${color}55`,
          lineHeight: 1,
          cursor: 'default',
        }}
        tabIndex={-1}
      >
        i
      </button>
      {open && (
        <div className="absolute z-50 rounded-lg shadow-xl border p-2 text-xs"
          style={{
            bottom: '120%', left: '50%', transform: 'translateX(-50%)',
            background: 'var(--surface)', borderColor: 'var(--border)',
            color: 'var(--text-secondary)',
            minWidth: 160, maxWidth: 240,
            pointerEvents: 'none',
          }}>
          <div className="font-semibold mb-1" style={{ color }}>Includes:</div>
          <ul className="space-y-0.5">
            {statuses.map(s => (
              <li key={s} className="flex items-center gap-1">
                <span style={{ color: color, fontSize: 8 }}>●</span>
                <span style={{ color: 'var(--text-primary)' }}>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const ws = new Date(d);
  ws.setDate(d.getDate() - d.getDay());
  return ws.toISOString().split('T')[0];
}

function weekRangeLabel(weekStart) {
  const s = new Date(weekStart + 'T12:00:00');
  const e = new Date(weekStart + 'T12:00:00');
  e.setDate(s.getDate() + 6);
  return `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`;
}

// effectivePostage imported from ../../lib/postage — shared across pages

// ─── Component ────────────────────────────────────────────────────────────────
export default function ForecastPage() {
  const supabase = createClient();
  const [drops, setDrops]                       = useState([]);
  const [transactions, setTransactions]         = useState([]);
  const [projectedDeposits, setProjectedDeposits] = useState([]);
  const [projectedDebits,   setProjectedDebits]   = useState([]);
  const [loading, setLoading]                   = useState(true);
  const [chartMode, setChartMode]               = useState('product'); // 'order' | 'drop' | 'product'
  const [selectedProduct, setSelectedProduct]   = useState(null);

  const today         = new Date().toISOString().split('T')[0];
  const nextWeekStart = addDays(getWeekStart(today), 7); // start of next week

  const load = useCallback(async () => {
    setLoading(true);
    const in12w   = addDays(today, 84);
    const since90 = addDays(today, -90);

    const [{ data: dropData }, { data: txns }, { data: projData }, { data: debitData }] = await Promise.all([
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, order_status, postage_amount, actual_postage, mail_method, mail_drop_quantity, mail_drop_amount, order_amount, payment_amount_applied')
        .in('order_status', FORECAST_STATUSES)
        .gte('drop_est_date', today)           // ← from today (KPI includes current week)
        .lte('drop_est_date', in12w),
      supabase.from('usps_transactions')
        .select('transaction_number, transaction_date, ending_balance, osprey_mail_drop_id')
        .gte('transaction_date', since90)
        .order('transaction_date', { ascending: false }),
      supabase.from('projected_deposits')
        .select('*').eq('is_active', true).gte('deposit_date', nextWeekStart).order('deposit_date'),
      supabase.from('projected_debits')
        .select('*').eq('is_active', true).gte('debit_date', today).order('debit_date'),
    ]);

    // Deduplicate drops by mail_drop_id — keep last record (most recent sync state).
    // Then drop anything with mail_method = "LDP" — those are handled by LDP and
    // don't hit our EPS, so they shouldn't show in pipeline/postage forecasts.
    const seenDrops = new Map();
    for (const d of (dropData || [])) seenDrops.set(d.mail_drop_id, d);
    const dropsWithoutLdp = [...seenDrops.values()].filter(d => !isLdpMailMethod(d));

    setDrops(dropsWithoutLdp);
    setTransactions(txns || []);
    setProjectedDeposits(projData || []);
    setProjectedDebits(debitData || []);
    setLoading(false);
  }, [today, nextWeekStart]);

  useEffect(() => { load(); }, [load]);

  const currentBalance = useMemo(() => {
    if (!transactions.length) return 0;
    const sorted = [...transactions].sort((a, b) => {
      const dd = new Date(b.transaction_date) - new Date(a.transaction_date);
      if (dd !== 0) return dd;
      return Number(b.transaction_number) - Number(a.transaction_number);
    });
    return sorted[0]?.ending_balance ?? 0;
  }, [transactions]);

  // Drops whose mail_drop_id already appears as a charge in EPS have been paid —
  // don't double-count them in the forecast. Matches the logic on cashflow/overview.
  const epsSet = useMemo(() => {
    const s = new Set();
    for (const t of transactions) {
      if (t.osprey_mail_drop_id) s.add(t.osprey_mail_drop_id);
    }
    return s;
  }, [transactions]);

  // postage(d) = 0 when the drop is already EPS-charged, otherwise effectivePostage(d).
  // Defined here so every sum on this page picks up EPS exclusion uniformly.
  const postage = useCallback(
    (d) => (epsSet.has(d.mail_drop_id) ? 0 : effectivePostage(d)),
    [epsSet]
  );

  // ── Product category totals & color palette ───────────────────────────────
  const PALETTE = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6','#a855f7','#6366f1'];

  const productTotals = useMemo(() => {
    const out = {};
    for (const d of drops) {
      const cat = d.product_category || 'Unknown';
      out[cat] = (out[cat] || 0) + postage(d);
    }
    return out;
  }, [drops, postage]);

  // Sorted by total postage desc, assigned stable colors
  const productCategories = useMemo(() =>
    Object.entries(productTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([cat], i) => ({ cat, color: PALETTE[i % PALETTE.length] })),
  [productTotals]);

  const productColorMap = useMemo(() =>
    Object.fromEntries(productCategories.map(({ cat, color }) => [cat, color])),
  [productCategories]);

  // ── Weekly breakdown — order, drop, AND product buckets (chart: next week+) ─
  const weeklyBreakdown = useMemo(() => {
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (ws < nextWeekStart) continue; // chart starts next week; current week only in KPI totals
      if (!weekMap[ws]) weekMap[ws] = { week: ws, label: weekRangeLabel(ws), total: 0 };
      const p  = postage(d);
      weekMap[ws].total += p;

      const ob = orderBucket(d.order_status);
      if (ob) weekMap[ws][`o_${ob}`] = (weekMap[ws][`o_${ob}`] || 0) + p;

      const db = dropBucket(d.drop_status);
      if (db) weekMap[ws][`d_${db}`] = (weekMap[ws][`d_${db}`] || 0) + p;

      const cat = d.product_category || 'Unknown';
      weekMap[ws][`p_${cat}`] = (weekMap[ws][`p_${cat}`] || 0) + p;
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 12);
  }, [drops, postage, nextWeekStart]);

  // ── Filtered chart data when a product is selected ────────────────────────
  const chartWeeklyBreakdown = useMemo(() => {
    if (!selectedProduct) return weeklyBreakdown;
    // Recompute weekly data using only drops matching the selected product
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      if ((d.product_category || 'Unknown') !== selectedProduct) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (!weekMap[ws]) weekMap[ws] = { week: ws, label: weekRangeLabel(ws), total: 0 };
      const p = postage(d);
      weekMap[ws].total += p;
      const ob = orderBucket(d.order_status);
      if (ob) weekMap[ws][`o_${ob}`] = (weekMap[ws][`o_${ob}`] || 0) + p;
      const db = dropBucket(d.drop_status);
      if (db) weekMap[ws][`d_${db}`] = (weekMap[ws][`d_${db}`] || 0) + p;
      weekMap[ws][`p_${selectedProduct}`] = (weekMap[ws][`p_${selectedProduct}`] || 0) + p;
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week));
  }, [drops, weeklyBreakdown, selectedProduct, postage]);

  // ── EPS runway ────────────────────────────────────────────────────────────
  const runwayData = useMemo(() => {
    let balance = currentBalance;
    const data = [{ date: today, balance }];
    const events = [
      ...weeklyBreakdown.map(w => ({ date: addDays(w.week, 3), amount: -w.total, type: 'postage' })),
      ...projectedDeposits.map(p => ({ date: p.deposit_date, amount: p.amount, type: 'deposit' })),
      // Manual future debits — non-Osprey EPS outflows logged on /cashflow.
      // Subtract on their date so the runway agrees with the cashflow page.
      ...projectedDebits.map(d => ({ date: d.debit_date, amount: -(d.amount || 0), type: 'debit' })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of events) {
      balance += e.amount;
      data.push({ date: e.date, balance: +balance.toFixed(2), type: e.type });
    }
    return data;
  }, [currentBalance, weeklyBreakdown, projectedDeposits, projectedDebits, today]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalPostage = useMemo(() => drops.reduce((s, d) => s + postage(d), 0), [drops, postage]);
  const totalPieces  = useMemo(() => drops.reduce((s, d) => s + (d.mail_drop_quantity || 0), 0), [drops]);

  // Bucket totals for pills
  const orderBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = orderBucket(d.order_status); if (b) out[b] = (out[b] || 0) + postage(d); }
    return out;
  }, [drops, postage]);
  const dropBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = dropBucket(d.drop_status); if (b) out[b] = (out[b] || 0) + postage(d); }
    return out;
  }, [drops, postage]);

  const activeBuckets = chartMode === 'order' ? ORDER_BUCKETS
                      : chartMode === 'drop'  ? DROP_BUCKETS
                      : Object.fromEntries(productCategories.map(({ cat, color }) => [cat, color]));
  const prefix        = chartMode === 'order' ? 'o_'
                      : chartMode === 'drop'  ? 'd_'
                      : 'p_';

  if (loading) return <p style={{ color: 'var(--text-muted)' }} className="p-4">Loading...</p>;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Postage Forecast</h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Next week onwards · {drops.length} drops · {weeklyBreakdown.length} weeks
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          { label: 'Total Postage in Pipeline', value: fmt$(totalPostage) },
          { label: 'Total Pieces', value: totalPieces.toLocaleString() },
          { label: 'Total Drops', value: drops.length.toLocaleString() },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-xl font-bold" style={{ color: k.color || 'var(--text-primary)' }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* EPS Balance Runway */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
          EPS Balance Runway — Next 12 Weeks
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={runwayData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            <ReferenceLine y={0} stroke="var(--status-critical)" strokeDasharray="4 4" />
            <Area type="monotone" dataKey="balance" stroke="var(--accent)" fill="var(--accent-light)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Stacked bar with toggle */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Postage by Week
            </h2>
            {selectedProduct && (
              <span className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ background: (productColorMap[selectedProduct] || 'var(--accent)') + '22', color: productColorMap[selectedProduct] || 'var(--accent)', border: `1px solid ${productColorMap[selectedProduct] || 'var(--accent)'}55` }}>
                {selectedProduct}
                <button onClick={() => setSelectedProduct(null)}
                  className="ml-0.5 font-bold hover:opacity-70"
                  style={{ lineHeight: 1 }}>×</button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedProduct && (
              <button onClick={() => setSelectedProduct(null)}
                className="text-xs px-2.5 py-1 rounded font-medium"
                style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                ↺ Reset filter
              </button>
            )}
          {/* Toggle */}
          <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {[['order', 'By Order Stage'], ['drop', 'By Drop Status'], ['product', 'By Product']].map(([mode, label]) => (
              <button key={mode} onClick={() => setChartMode(mode)}
                className="text-xs px-3 py-1 font-medium"
                style={{
                  background: chartMode === mode ? 'var(--accent)' : 'var(--surface2)',
                  color: chartMode === mode ? 'var(--accent-text)' : 'var(--text-secondary)',
                  borderLeft: mode !== 'order' ? '1px solid var(--border)' : 'none',
                }}>
                {label}
              </button>
            ))}
          </div>
          </div>
        </div>

        {/* Bucket legend pills */}
        <div className="flex flex-wrap gap-2 mb-3">
          {Object.entries(activeBuckets).map(([bucket, color]) => {
            const totals    = chartMode === 'order' ? orderBucketTotals
                            : chartMode === 'drop'  ? dropBucketTotals
                            : productTotals;
            const statusMap = chartMode === 'order' ? ORDER_BUCKET_STATUSES
                            : chartMode === 'drop'  ? DROP_BUCKET_STATUSES
                            : null;
            const val = totals[bucket];
            return val ? (
              <div key={bucket} className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                {bucket}: {fmt$(val)}
                {statusMap && <InfoTip statuses={statusMap[bucket] || []} color={color} />}
              </div>
            ) : null;
          })}
        </div>

        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartWeeklyBreakdown} margin={{ left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip
              formatter={(v, name) => [fmt$(v), name]}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
            {Object.entries(activeBuckets).map(([bucket, color]) => (
              <Bar key={bucket} dataKey={`${prefix}${bucket}`} name={bucket} stackId="a" fill={color} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Product Type Breakdown */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
          Postage by Product Type
        </h2>
        <div className="space-y-1">
          {productCategories.map(({ cat, color }) => {
            const val      = productTotals[cat] || 0;
            const pct      = totalPostage > 0 ? (val / totalPostage) * 100 : 0;
            const cnt      = drops.filter(d => (d.product_category || 'Unknown') === cat).length;
            const pcs      = drops.filter(d => (d.product_category || 'Unknown') === cat)
                                  .reduce((s, d) => s + (d.mail_drop_quantity || 0), 0);
            const isActive = selectedProduct === cat;
            const isDimmed = selectedProduct && !isActive;
            return (
              <div key={cat}
                onClick={() => setSelectedProduct(isActive ? null : cat)}
                className="rounded-lg px-3 py-2 cursor-pointer"
                style={{
                  background: isActive ? color + '18' : 'transparent',
                  border: `1px solid ${isActive ? color + '55' : 'transparent'}`,
                  opacity: isDimmed ? 0.35 : 1,
                  transition: 'all 0.15s ease',
                }}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{cat}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {cnt} drop{cnt !== 1 ? 's' : ''} · {pcs.toLocaleString()} pcs
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{pct.toFixed(1)}%</span>
                    <span className="text-sm font-semibold" style={{ color: isActive ? color : 'var(--text-primary)', minWidth: 100, textAlign: 'right' }}>{fmt$(val)}</span>
                    {isActive && <span className="text-xs font-medium" style={{ color }}> ✓</span>}
                  </div>
                </div>
                <div className="rounded-full h-1.5 w-full" style={{ background: 'var(--surface2)' }}>
                  <div className="rounded-full h-1.5" style={{ width: `${pct}%`, background: color, transition: 'width 0.4s ease' }} />
                </div>
              </div>
            );
          })}
        </div>
        {/* Product totals footer */}
        <div className="mt-4 pt-3 flex items-center justify-between border-t" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
            {productCategories.length} product types · {drops.length} total drops
          </span>
          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(totalPostage)}</span>
        </div>
      </div>

      {/* Weekly summary table — shows both breakdowns */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center gap-3"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Weekly Pipeline</h2>
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
            Both order &amp; drop status shown
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Week</th>
                <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Postage</th>
                {/* Order stage columns */}
                {Object.entries(ORDER_BUCKETS).map(([b, c]) => (
                  <th key={`o_${b}`} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: c, borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                    <span className="flex items-center gap-0.5">
                      {b}<InfoTip statuses={ORDER_BUCKET_STATUSES[b] || []} color={c} />
                    </span>
                  </th>
                ))}
                {/* Divider */}
                <th className="px-1" style={{ borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--border)' }} />
                {/* Drop status columns */}
                {Object.entries(DROP_BUCKETS).map(([b, c]) => (
                  <th key={`d_${b}`} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: c, borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                    <span className="flex items-center gap-0.5">
                      {b}<InfoTip statuses={DROP_BUCKET_STATUSES[b] || []} color={c} />
                    </span>
                  </th>
                ))}
                <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Proj. Deposit</th>
              </tr>
            </thead>
            <tbody>
              {weeklyBreakdown.map((w, i) => {
                const dep = projectedDeposits.find(p => getWeekStart(p.deposit_date) === w.week);
                return (
                  <tr key={w.week} style={{
                    background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{w.label}</td>
                    <td className="px-3 py-2 font-semibold" style={{ color: 'var(--text-primary)' }}>{fmt$(w.total)}</td>
                    {Object.entries(ORDER_BUCKETS).map(([b, c]) => (
                      <td key={`o_${b}`} className="px-3 py-2" style={{ color: w[`o_${b}`] ? c : 'var(--text-muted)' }}>
                        {w[`o_${b}`] ? fmt$(w[`o_${b}`]) : '—'}
                      </td>
                    ))}
                    <td style={{ borderLeft: '2px solid var(--border)' }} />
                    {Object.entries(DROP_BUCKETS).map(([b, c]) => (
                      <td key={`d_${b}`} className="px-3 py-2" style={{ color: w[`d_${b}`] ? c : 'var(--text-muted)' }}>
                        {w[`d_${b}`] ? fmt$(w[`d_${b}`]) : '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2" style={{ color: dep ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {dep ? fmt$(dep.amount) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
              <tr>
                <td className="px-3 py-2 font-bold text-xs" style={{ color: 'var(--text-muted)' }}>TOTAL</td>
                <td className="px-3 py-2 font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(totalPostage)}</td>
                {Object.entries(ORDER_BUCKETS).map(([b, c]) => (
                  <td key={`o_${b}`} className="px-3 py-2 font-semibold" style={{ color: orderBucketTotals[b] ? c : 'var(--text-muted)' }}>
                    {orderBucketTotals[b] ? fmt$(orderBucketTotals[b]) : '—'}
                  </td>
                ))}
                <td style={{ borderLeft: '2px solid var(--border)' }} />
                {Object.entries(DROP_BUCKETS).map(([b, c]) => (
                  <td key={`d_${b}`} className="px-3 py-2 font-semibold" style={{ color: dropBucketTotals[b] ? c : 'var(--text-muted)' }}>
                    {dropBucketTotals[b] ? fmt$(dropBucketTotals[b]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2 font-semibold" style={{ color: 'var(--accent)' }}>
                  {fmt$(projectedDeposits.reduce((s, p) => s + p.amount, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

    </div>
  );
}
