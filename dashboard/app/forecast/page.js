'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import { effectivePostage, isLdpMailMethod } from '../../lib/postage';
import {
  ComposedChart, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, Cell, Line,
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

// ─── Live vs not-live (is_live_status) ────────────────────────────────────────
// "Live" = drop is in production and its postage actually hits EPS (outsourced /
// production / pending ship); "Not Live" = still upstream (scheduled, list
// received, EDDM routes, etc.). Same definition used on the cashflow page.
//
// Not-live drops are graded against the HISTORICAL FLIP CURVE (Apr–Jul 2026,
// 420 observed flips in drop_status_history × drop_date_history): cumulative
// % of drops already live at N days before their scheduled date —
//   14d: 13% · 10d: 30% · 8d: 56% · 7d: 75% · 5d: 90% · 3d: 96% · 0d: ~100%.
// So a not-live drop ≤5 days out is in the last ~10% historically (behind pace);
// 6–8 days out is inside the normal flip window; >8 days out is on pace.
const LIVE_BUCKETS = {
  'Live':        '#10b981',
  'Flip Window': '#f59e0b',   // ≤8 days out, not yet live — normal flip zone
  'Behind Pace': '#ef4444',   // ≤5 days out (or past date), still not live
  'On Pace':     '#9ca3af',   // >8 days out — too early to expect a flip
  'Projected Arrivals': '#93c5fd',   // orders not yet in the system (see model below)
};

// ─── Order-arrival ("backfill") projection ────────────────────────────────────
// From the drop_date_history cohort analysis (8 completed weeks, Jun–Jul 2026):
// future weeks fill in with orders that aren't in the system yet, at a stable
// ABSOLUTE volume (avg final ≈129 non-canceled drops/week, range 107–162), not
// a multiplier. Avg drops still to arrive at N weeks out:
//   1w: ~60 · 2w: ~86 · 3w: ~92 · 4w: ~105 · 5w+: ~107 (no data beyond 5w).
// Dollarized with the avg postage of currently-known future drops — treat as a
// ±25% directional band, not precise dollars. Chart-only: NOT added to week
// totals, so the EPS runway stays driven by real known drops.
// weekly_pipeline_snapshots (capturing since 2026-07-22) will let us refit
// these constants — and add quote-aware conversion — from exact history.
const ARRIVALS_BY_WEEKS_OUT = { 0: 8, 1: 60, 2: 86, 3: 92, 4: 105, 5: 107 };
const arrivalsFor = (wo) => (wo < 0 ? 0 : ARRIVALS_BY_WEEKS_OUT[Math.min(wo, 5)] ?? 0);

// Legend-pill definitions for the Live vs Not-Live view. All figures are
// POSTAGE dollars (actual once priced, else Est. Postage) — not drop revenue.
const LIVE_BUCKET_DEFS = {
  'Live': 'Drop is in production now (Outsourced / Production / Pending Ship) — its postage hits or is about to hit EPS.',
  'Flip Window': 'Not live yet, scheduled 6–8 days out. Normal flip zone: historically 56–90% of drops have gone live by this point.',
  'Behind Pace': 'Still not live with ≤5 days to the scheduled date (or past it). Historically ~90% of drops are live by 5 days out — these are late-risk, act now.',
  'On Pace': 'Not live, scheduled more than 8 days out — too early to expect a flip (only ~30% of drops are live 10 days out).',
  'Projected Arrivals': 'Orders NOT in the system yet: historical average arrivals for that horizon (≈60 drops 1wk out, up to ≈107 at 5+ wks) × avg postage of known future drops. Directional (±25%). Chart-only — excluded from totals and the EPS runway.',
};

function liveBucket(d, today) {
  if (d.is_live_status) return 'Live';
  if (!d.drop_est_date) return 'On Pace';
  const days = Math.round((new Date(d.drop_est_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  if (days <= 5) return 'Behind Pace';
  if (days <= 8) return 'Flip Window';
  return 'On Pace';
}

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
function InfoTip({ statuses, color, text }) {
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
          {text ? (
            <div style={{ color: 'var(--text-primary)', lineHeight: 1.5 }}>{text}</div>
          ) : (
            <>
              <div className="font-semibold mb-1" style={{ color }}>Includes:</div>
              <ul className="space-y-0.5">
                {statuses.map(s => (
                  <li key={s} className="flex items-center gap-1">
                    <span style={{ color: color, fontSize: 8 }}>●</span>
                    <span style={{ color: 'var(--text-primary)' }}>{s}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
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
  const [chartMode, setChartMode]               = useState('product'); // 'order' | 'drop' | 'product' | 'live'
  const [metricMode, setMetricMode]             = useState('postage'); // 'postage' | 'revenue' — chart/pills only; runway stays postage
  const [selectedProduct, setSelectedProduct]   = useState(null);
  // When true the load extends drop_est_date back 4 weeks so the trend chart /
  // weekly breakdown include the prior month for comparison. Filter is on
  // est date specifically — we want to see scheduled-mailing trends, not
  // when drops actually mailed.
  const [includePast4Weeks, setIncludePast4Weeks] = useState(false);

  const today         = new Date().toISOString().split('T')[0];
  const nextWeekStart = addDays(getWeekStart(today), 7); // start of next week

  const load = useCallback(async () => {
    setLoading(true);
    const in12w   = addDays(today, 84);
    const since90 = addDays(today, -90);
    // Window start: today by default, 4 weeks back when the toggle is on.
    // Anchor to the start of the current week (Sunday) so we get 4 complete
    // prior weeks + the current week in full — avoids a mid-week gap if
    // today is not a Sunday.
    const windowStart = includePast4Weeks ? addDays(getWeekStart(today), -28) : today;

    const [{ data: dropData }, { data: txns }, { data: projData }, { data: debitData }] = await Promise.all([
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, actual_postage, mail_method, mail_drop_quantity, mail_drop_amount, order_amount, payment_amount_applied')
        .in('order_status', FORECAST_STATUSES)
        .gte('drop_est_date', windowStart)
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
  }, [today, nextWeekStart, includePast4Weeks]);

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

  // Chart metric: postage (default) or revenue (Mail Drop Amount). Revenue is
  // gross — no EPS/LDP exclusions, since those only apply to postage cost.
  // Used ONLY by the weekly chart + legend pills; the EPS runway always uses
  // postage() via w.total.
  const dropValue = useCallback(
    (d) => (metricMode === 'revenue' ? (d.mail_drop_amount || 0) : postage(d)),
    [metricMode, postage]
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

  // ── Weekly breakdown — order, drop, AND product buckets ─────────────────────
  // When includePast4Weeks is on, include from windowStart (4 prior full weeks)
  // so the chart shows the comparison window. Otherwise start from next week.
  const weeklyBreakdown = useMemo(() => {
    const currentWeekStart = getWeekStart(today);
    const cutoff = includePast4Weeks ? addDays(currentWeekStart, -28) : nextWeekStart;
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (ws < cutoff) continue;
      if (!weekMap[ws]) weekMap[ws] = {
        week: ws, label: weekRangeLabel(ws), total: 0,
        // weeks whose Sunday is before this week's Sunday are "past"
        isPast: ws < currentWeekStart,
      };
      // w.total is ALWAYS postage — it feeds the EPS runway. The bucket keys
      // (chart segments) follow the selected metric (postage or revenue).
      weekMap[ws].total += postage(d);
      const p = dropValue(d);
      weekMap[ws].metricTotal = (weekMap[ws].metricTotal || 0) + p;

      const ob = orderBucket(d.order_status);
      if (ob) weekMap[ws][`o_${ob}`] = (weekMap[ws][`o_${ob}`] || 0) + p;

      const db = dropBucket(d.drop_status);
      if (db) weekMap[ws][`d_${db}`] = (weekMap[ws][`d_${db}`] || 0) + p;

      const cat = d.product_category || 'Unknown';
      weekMap[ws][`p_${cat}`] = (weekMap[ws][`p_${cat}`] || 0) + p;

      const lb = liveBucket(d, today);
      weekMap[ws][`l_${lb}`] = (weekMap[ws][`l_${lb}`] || 0) + p;
      weekMap[ws].knownCount = (weekMap[ws].knownCount || 0) + 1;
    }
    // Projected arrivals overlay (Live vs Not-Live mode only). Dollarize the
    // historical arrival counts with the avg value (per metric) of known future drops.
    const future = Object.values(weekMap).filter((w) => !w.isPast);
    const futPost = future.reduce((s, w) => s + (w.metricTotal || 0), 0);
    const futCnt  = future.reduce((s, w) => s + (w.knownCount || 0), 0);
    const avgPost = futCnt ? futPost / futCnt : 0;
    if (avgPost > 0) {
      for (const w of future) {
        const wo = Math.round((new Date(w.week + 'T00:00:00Z') - new Date(currentWeekStart + 'T00:00:00Z')) / (7 * 86400000));
        const proj = arrivalsFor(wo) * avgPost;
        if (proj > 0) w['l_Projected Arrivals'] = proj;   // chart-only; w.total untouched (runway unaffected)
      }
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 17);
  }, [drops, postage, dropValue, nextWeekStart, includePast4Weeks, today]);

  // ── Filtered chart data when a product is selected ────────────────────────
  const chartWeeklyBreakdown = useMemo(() => {
    if (!selectedProduct) return weeklyBreakdown;
    const currentWeekStart = getWeekStart(today);
    const cutoff = includePast4Weeks ? addDays(currentWeekStart, -28) : nextWeekStart;
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      if ((d.product_category || 'Unknown') !== selectedProduct) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (ws < cutoff) continue;
      if (!weekMap[ws]) weekMap[ws] = {
        week: ws, label: weekRangeLabel(ws), total: 0,
        isPast: ws < currentWeekStart,
      };
      const p = dropValue(d);
      weekMap[ws].total += p;
      const ob = orderBucket(d.order_status);
      if (ob) weekMap[ws][`o_${ob}`] = (weekMap[ws][`o_${ob}`] || 0) + p;
      const db = dropBucket(d.drop_status);
      if (db) weekMap[ws][`d_${db}`] = (weekMap[ws][`d_${db}`] || 0) + p;
      const lb = liveBucket(d, today);
      weekMap[ws][`l_${lb}`] = (weekMap[ws][`l_${lb}`] || 0) + p;
      weekMap[ws][`p_${selectedProduct}`] = (weekMap[ws][`p_${selectedProduct}`] || 0) + p;
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week));
  }, [drops, weeklyBreakdown, selectedProduct, dropValue, includePast4Weeks, nextWeekStart, today]);

  // ── EPS runway ────────────────────────────────────────────────────────────
  const runwayData = useMemo(() => {
    let balance = currentBalance;
    const data = [{ date: today, balance }];
    // Filter to only events on or after today — past est dates are included
    // in the breakdown table for trend visibility, but a runway projection
    // walks the balance forward from today, so historical events would
    // distort the line.
    const events = [
      // Only project future (and current-week) postage — past weeks are already
      // reflected in currentBalance and shouldn't double-count the runway.
      ...weeklyBreakdown.filter(w => !w.isPast).map(w => ({ date: addDays(w.week, 3), amount: -w.total, type: 'postage' })),
      ...projectedDeposits.map(p => ({ date: p.deposit_date, amount: p.amount, type: 'deposit' })),
      // Manual future debits — non-Osprey EPS outflows logged on /cashflow.
      // Subtract on their date so the runway agrees with the cashflow page.
      ...projectedDebits.map(d => ({ date: d.debit_date, amount: -(d.amount || 0), type: 'debit' })),
    ].filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    for (const e of events) {
      balance += e.amount;
      data.push({ date: e.date, balance: +balance.toFixed(2), type: e.type });
    }
    return data;
  }, [currentBalance, weeklyBreakdown, projectedDeposits, projectedDebits, today]);

  // Historical EPS balance points for the faded "past" portion of the runway.
  const epsChartData = useMemo(() => {
    if (!includePast4Weeks) return runwayData;
    const windowStart = addDays(getWeekStart(today), -28);
    // Build a past-balance series from transactions, sorted ascending.
    const pastPoints = [...transactions]
      .filter(t => t.transaction_date >= windowStart && t.transaction_date < today)
      .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
      .map(t => ({ date: t.transaction_date, pastBalance: t.ending_balance }));
    // Deduplicate by date (keep last balance for each day).
    const deduped = pastPoints.reduce((acc, pt) => {
      if (acc.length && acc[acc.length - 1].date === pt.date) {
        acc[acc.length - 1].pastBalance = pt.pastBalance;
      } else {
        acc.push(pt);
      }
      return acc;
    }, []);
    // Splice at today: share the currentBalance so both lines connect cleanly.
    const todayJoin = { date: today, pastBalance: currentBalance, balance: currentBalance };
    const futurePoints = runwayData.filter(d => d.date > today);
    return [...deduped, todayJoin, ...futurePoints];
  }, [includePast4Weeks, transactions, runwayData, currentBalance, today]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalPostage = useMemo(() => drops.reduce((s, d) => s + postage(d), 0), [drops, postage]);
  const totalPieces  = useMemo(() => drops.reduce((s, d) => s + (d.mail_drop_quantity || 0), 0), [drops]);

  // Bucket totals for pills
  const orderBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = orderBucket(d.order_status); if (b) out[b] = (out[b] || 0) + dropValue(d); }
    return out;
  }, [drops, dropValue]);
  const dropBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = dropBucket(d.drop_status); if (b) out[b] = (out[b] || 0) + dropValue(d); }
    return out;
  }, [drops, dropValue]);
  const liveBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = liveBucket(d, today); out[b] = (out[b] || 0) + dropValue(d); }
    const proj = weeklyBreakdown.reduce((s, w) => s + (w['l_Projected Arrivals'] || 0), 0);
    if (proj > 0) out['Projected Arrivals'] = proj;
    return out;
  }, [drops, dropValue, today, weeklyBreakdown]);
  // Metric-aware product totals for the legend pills. productTotals (postage)
  // stays untouched — it drives the stable color assignment and the
  // "Postage by Product Type" section below.
  const productMetricTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const cat = d.product_category || 'Unknown'; out[cat] = (out[cat] || 0) + dropValue(d); }
    return out;
  }, [drops, dropValue]);

  const activeBuckets = chartMode === 'order' ? ORDER_BUCKETS
                      : chartMode === 'drop'  ? DROP_BUCKETS
                      : chartMode === 'live'  ? LIVE_BUCKETS
                      : Object.fromEntries(productCategories.map(({ cat, color }) => [cat, color]));
  const prefix        = chartMode === 'order' ? 'o_'
                      : chartMode === 'drop'  ? 'd_'
                      : chartMode === 'live'  ? 'l_'
                      : 'p_';

  if (loading) return <p style={{ color: 'var(--text-muted)' }} className="p-4">Loading...</p>;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Postage Forecast</h1>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Toggle: extend the est-date window 4 weeks back so weekly
              breakdown / chart can show the prior month's scheduled trend.
              Filtered on drop_est_date specifically — the user wants to see
              what was *planned* to mail, not what actually mailed. */}
          <button onClick={() => setIncludePast4Weeks(v => !v)}
            className="text-xs px-3 py-1 rounded font-medium transition-colors"
            style={{
              background: includePast4Weeks ? 'var(--accent)' : 'var(--surface2)',
              color:      includePast4Weeks ? 'var(--accent-text)' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}>
            {includePast4Weeks ? '✓ Including past 4 weeks' : '+ Include past 4 weeks'}
          </button>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {includePast4Weeks ? 'Past 4 weeks → next 12 weeks' : 'Next week onwards'} · {drops.length} drops · {weeklyBreakdown.length} weeks
          </p>
        </div>
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            EPS Balance Runway — {includePast4Weeks ? 'Past 4 weeks → next 12 weeks' : 'Next 12 weeks'}
          </h2>
          {includePast4Weeks && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Faded line = historical balance
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={epsChartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            <ReferenceLine y={0} stroke="var(--status-critical)" strokeDasharray="4 4" />
            {includePast4Weeks && (
              <Line
                type="monotone"
                dataKey="pastBalance"
                stroke="var(--accent)"
                strokeWidth={1.5}
                strokeOpacity={0.35}
                dot={false}
                connectNulls={false}
                legendType="none"
              />
            )}
            <Area type="monotone" dataKey="balance" stroke="var(--accent)" fill="var(--accent-light)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Stacked bar with toggle */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {metricMode === 'revenue' ? 'Revenue by Week' : 'Postage by Week'}
            </h2>
            <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}
              title={metricMode === 'postage'
                ? 'Postage: actual once priced, else Est. Postage. Excludes LDP-method drops and drops already charged in EPS.'
                : 'Revenue: Mail Drop Amount (gross, per drop). No EPS/LDP exclusions. Chart & pills only — the EPS runway below stays postage-based.'}>
              {[['postage', 'Postage $'], ['revenue', 'Revenue $']].map(([m, label]) => (
                <button key={m} onClick={() => setMetricMode(m)}
                  className="text-xs px-2 py-0.5 font-medium"
                  style={{
                    background: metricMode === m ? 'var(--accent)' : 'var(--surface2)',
                    color: metricMode === m ? 'var(--accent-text)' : 'var(--text-secondary)',
                    borderLeft: m === 'revenue' ? '1px solid var(--border)' : 'none',
                  }}>
                  {label}
                </button>
              ))}
            </div>
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
            {[['order', 'By Order Stage'], ['drop', 'By Drop Status'], ['product', 'By Product'], ['live', 'Live vs Not-Live']].map(([mode, label]) => (
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
                            : chartMode === 'live'  ? liveBucketTotals
                            : productMetricTotals;
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
                {chartMode === 'live' && LIVE_BUCKET_DEFS[bucket] && <InfoTip text={LIVE_BUCKET_DEFS[bucket]} color={color} />}
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
              <Bar key={bucket} dataKey={`${prefix}${bucket}`} name={bucket} stackId="a" fill={color}>
                {chartWeeklyBreakdown.map((w, i) => (
                  <Cell key={i} fill={color}
                    fillOpacity={bucket === 'Projected Arrivals' ? 0.45 : (w.isPast ? 0.32 : 1)} />
                ))}
              </Bar>
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
