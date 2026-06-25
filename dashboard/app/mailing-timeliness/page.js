'use client';

// Mailing Timeliness — how reliably we hit the scheduled mail date.
// ---------------------------------------------------------------------------
// Bucket basis = drop_act_date (the day it actually mailed). We compute
// lateness as (act - est) in days: negative = Early, zero = On Time,
// positive = Late. The page has four layers:
//
//   1. Snapshot KPIs        — current state right now (past-due, last
//                             completed period, trailing on-time rate)
//   2. Date range + grain   — picker defaults 3/1/2026 -> yesterday;
//                             week (Sun-Sat) or month grain
//   3. Historical chart     — stacked Early/OnTime/Late bars by period,
//                             with avg days late as a line overlay
//   4. Breakdown cards      — per Mail Location, per Mail Method, showing
//                             on-time % and avg days late
//   5. Period detail table  — sortable, expandable rows for drill-down
//
// Inclusion rules locked in with the user:
//   • Exclude CANCELED / VOID / null drop_est_date / future-dated unmailed
//   • LDP drops are included only when actual_postage > 0 (they only count
//     once production has priced them)

import { useEffect, useState, useMemo, useCallback } from 'react';
import { createClient } from '../../lib/supabase';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { exportToCSV } from '../../lib/export';
import { OspreyOrderLink, OspreyDropLink } from '../../lib/ospreyLinks';

// ─── tiny helpers ────────────────────────────────────────────────────────────

const fmt$  = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN  = (n) => n == null ? '—' : Number(n).toLocaleString('en-US');
const fmtPct = (n) => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const fmtDays = (n) => n == null ? '—' : (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

// Date-only strings (YYYY-MM-DD) need T12:00:00 to avoid the UTC midnight
// shift that bumps the displayed date back a day in Eastern time.
const ET = (iso) => {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Detroit' });
};

// Add N days to a YYYY-MM-DD string; returns YYYY-MM-DD.
function addDays(yyyymmdd, n) {
  const d = new Date(yyyymmdd + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Difference in whole days between two YYYY-MM-DD strings. Positive = b is
// later than a. Uses noon UTC so DST transitions don't shift the answer.
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T12:00:00').getTime();
  const db = new Date(b + 'T12:00:00').getTime();
  return Math.round((db - da) / 86400000);
}

// Returns the Sunday-of that week (YYYY-MM-DD) — matches the cashflow page.
function getWeekStart(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());                 // .getDay() = 0 (Sun) .. 6 (Sat)
  return d.toISOString().split('T')[0];
}

// "Week of 3/8" / "Mar 2026"
function periodLabel(periodKey, grain) {
  if (grain === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  const d = new Date(periodKey + 'T12:00:00');
  return `Week of ${d.getMonth() + 1}/${d.getDate()}`;
}

// Yesterday as YYYY-MM-DD in Eastern time. Used as the default `end` so we
// never look at today's drops (they might still mail).
function yesterdayET() {
  const now = new Date();
  // Roll backward at least 24h. For more correctness across DST we shift
  // ~26h so any same-day Eastern morning still resolves to yesterday's date.
  now.setTime(now.getTime() - 26 * 3600 * 1000);
  return now.toISOString().split('T')[0];
}

// Today in Eastern time (used for the past-due snapshot definition).
function todayET() {
  return new Date().toISOString().split('T')[0];
}

// Categorize a drop's act-vs-est lateness. Per the user's revised rule:
//   On Time = act <= est  (early counts as on time)
//   Late    = act >  est
// "Avg Days vs Est" (signed average of act - est) is still surfaced so the
// negative-vs-positive direction is visible at a glance even though the
// categorical buckets don't separate early.
function categorize(estDate, actDate) {
  if (!estDate || !actDate) return null;
  const d = daysBetween(estDate, actDate);
  return d > 0 ? 'late' : 'ontime';
}

// LDP inclusion rule: include only when actual_postage > 0 (real posted cost).
function passesLdpRule(drop) {
  const isLdp = (drop.mail_method || '').toUpperCase() === 'LDP';
  if (!isLdp) return true;
  return Number(drop.actual_postage) > 0;
}

// Mail location aliases — silent rewrites for known mislabels in the report.
// Applied at the load() step so every downstream consumer (breakdown card,
// period bucketing, table, drill-down modal, CSV export) sees the canonical
// label. Add more entries here if other facilities get reclassified.
const MAIL_LOCATION_ALIASES = {
  'Las Vegas Color': 'Kaleidoscope',
  'Unspecified':     'Valassis',
};
function normalizeMailLocation(loc) {
  if (!loc) return loc;
  return MAIL_LOCATION_ALIASES[loc.trim()] || loc;
}

// Status exclusions are uniform across the page — pre-sale / dead orders
// shouldn't dilute timeliness numbers.
const EXCLUDED_ORDER_STATUSES = new Set(['CANCELED', 'VOID']);

// Aging buckets — same definitions the Late Mailings page uses so the
// Past-Due KPI breakdown reads the same as that page's bar chart.
const AGING_BUCKETS = [
  { key: '1-7',   label: '1–7 d',   min: 1,  max: 7   },
  { key: '8-14',  label: '8–14 d',  min: 8,  max: 14  },
  { key: '15-30', label: '15–30 d', min: 15, max: 30  },
  { key: '31-60', label: '31–60 d', min: 31, max: 60  },
  { key: '60+',   label: '60+ d',   min: 61, max: Infinity },
];
function bucketForDays(daysLate) {
  return AGING_BUCKETS.find(b => daysLate >= b.min && daysLate <= b.max) || AGING_BUCKETS[AGING_BUCKETS.length - 1];
}
// Color scale — gets redder as drops sit longer. Mirrors the late-mailings
// daysLateColor helper but exposed as a per-bucket attribute so the small
// KPI grid can highlight oldest buckets in critical red without needing a
// shared util.
function bucketColor(key) {
  if (key === '1-7')   return 'var(--status-warn)';
  if (key === '8-14')  return 'var(--status-warn)';
  if (key === '15-30') return '#ea7c45';
  if (key === '31-60') return 'var(--status-critical)';
  return 'var(--status-critical)';
}

// Active production statuses — same set the Late Mailings page uses to
// define "in flight". The past-due snapshot KPI uses these so its count
// ties out exactly to the Late Mailings table count.
const ACTIVE_ORDER_STATUSES = [
  'DAL [SUBMITTED]', 'DIGITAL READY', 'DIGITAL [STAGING]',
  'OUTSOURCED', 'OUTSOURCED [STAGING]',
];

// Same LDP test the Late Mailings page uses (mirror of lib/postage's
// isLdpMailMethod). The past-due snapshot drops EVERY LDP row so the
// count matches the Late Mailings page exactly — even LDP drops with
// posted postage are excluded from past-due because Late Mailings does
// the same. (The completed-in-range query still uses the more permissive
// rule: include LDP when actual_postage > 0.)
function isLdpDrop(drop) {
  return (drop.mail_method || '').toUpperCase().trim() === 'LDP';
}

// ─── component ──────────────────────────────────────────────────────────────

export default function MailingTimelinessPage() {
  const supabase = createClient();

  const DEFAULT_START = '2026-03-01';
  const defaultEnd    = useMemo(yesterdayET, []);

  const [range, setRange]   = useState({ start: DEFAULT_START, end: defaultEnd });
  const [grain, setGrain]   = useState('week');             // 'week' | 'month'
  const [drops, setDrops]   = useState([]);                  // completed drops in range
  const [pastDue, setPastDue] = useState([]);                // current past-due unmailed
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});              // periodKey -> bool
  const [sortKey, setSortKey] = useState('period');
  const [sortDir, setSortDir] = useState('desc');
  const [drillPeriod, setDrillPeriod] = useState(null);      // period clicked on the chart — opens drop matrix modal

  // ── Loaders ────────────────────────────────────────────────────────────
  //
  // Two queries: completed drops in the user-picked range (bucket source for
  // the historical chart + table + breakdowns), and the current past-due set
  // (mirrors the Late Mailings page so the snapshot KPI ties out). Both
  // paginate around the 1k default cap on .select().
  const load = useCallback(async () => {
    setLoading(true);
    const fields = 'mail_drop_id, order_id, customer_name, product_category, ' +
                   'order_status, drop_status, is_live_status, ' +
                   'drop_est_date, drop_act_date, ' +
                   'mail_drop_quantity, mail_drop_amount, postage_amount, actual_postage, ' +
                   'mail_method, mail_location';

    // 1. Completed-in-range
    const completedRows = [];
    {
      let from = 0; const size = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('osprey_mail_drops')
          .select(fields)
          .not('drop_act_date', 'is', null)
          .not('drop_est_date', 'is', null)
          .gte('drop_act_date', range.start)
          .lte('drop_act_date', range.end)
          .range(from, from + size - 1);
        if (error) { console.error('completed load failed:', error.message); break; }
        if (!data?.length) break;
        completedRows.push(...data);
        if (data.length < size) break;
        from += size;
      }
    }

    // 2. Past-due snapshot — MIRROR the Late Mailings page exactly so the
    //    KPI count ties out to that page row-for-row:
    //       - is_live_status = true
    //       - drop_est_date < today
    //       - drop_act_date IS NULL
    //       - order_status IN (ACTIVE_ORDER_STATUSES)  ← additional filter
    //       - mail_method != 'LDP' (filtered client-side)
    const today = todayET();
    const pastDueRows = [];
    {
      let from = 0; const size = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('osprey_mail_drops')
          .select(fields)
          .eq('is_live_status', true)
          .in('order_status', ACTIVE_ORDER_STATUSES)
          .lt('drop_est_date', today)
          .is('drop_act_date', null)
          .range(from, from + size - 1);
        if (error) { console.error('past-due load failed:', error.message); break; }
        if (!data?.length) break;
        pastDueRows.push(...data);
        if (data.length < size) break;
        from += size;
      }
    }

    // Normalize mail_location aliases on every row before they hit state so
    // the rest of the page reads a single canonical label per facility.
    const normalize = (d) => ({ ...d, mail_location: normalizeMailLocation(d.mail_location) });

    setDrops(completedRows
      .filter(d => !EXCLUDED_ORDER_STATUSES.has(d.order_status) && passesLdpRule(d))
      .map(normalize));
    // Past-due drops drop ALL LDP rows (not the postage-gated rule), matching
    // the Late Mailings page so the snapshot count is identical.
    setPastDue(pastDueRows
      .filter(d => !isLdpDrop(d))
      .map(normalize));
    setLoading(false);
  }, [range.start, range.end]);

  useEffect(() => { load(); }, [load]);

  // ── Snapshot KPI strip ─────────────────────────────────────────────────
  //
  // Independent of grain — KPIs answer "right now, how are we doing?" The
  // trailing on-time rate is computed across the visible date range though,
  // so the picker affects that one number.
  const kpis = useMemo(() => {
    const today = todayET();

    // Past-due (incomplete, currently overdue)
    const pastDueWithDays = pastDue.map(d => ({ ...d, _daysLateNow: daysBetween(d.drop_est_date, today) }));
    const pastDueAvgDays  = pastDueWithDays.length
      ? pastDueWithDays.reduce((s, d) => s + (d._daysLateNow || 0), 0) / pastDueWithDays.length
      : null;

    // Per-bucket counts so the KPI card can show the aging distribution
    // instead of a single average. Same buckets as the Late Mailings page.
    const pastDueBuckets = AGING_BUCKETS.map(b => ({ ...b, count: 0 }));
    for (const d of pastDueWithDays) {
      const b = bucketForDays(d._daysLateNow || 0);
      const row = pastDueBuckets.find(x => x.key === b.key);
      if (row) row.count += 1;
    }

    // Trailing on-time rate across the full visible date range
    const total = drops.length;
    const onTime = drops.filter(d => categorize(d.drop_est_date, d.drop_act_date) === 'ontime').length;
    const trailingOnTime = total > 0 ? onTime / total : null;

    // Last completed period — derived from the chart's bucketing so KPI ties
    // back to the most recent visible bar in the chart.
    const bucketByGrain = (date) => grain === 'month' ? date.slice(0, 7) : getWeekStart(date);
    const periodSums = new Map();
    for (const d of drops) {
      const key = bucketByGrain(d.drop_act_date);
      if (!periodSums.has(key)) periodSums.set(key, { count: 0, sumDays: 0 });
      const slot = periodSums.get(key);
      slot.count += 1;
      slot.sumDays += daysBetween(d.drop_est_date, d.drop_act_date) || 0;
    }
    const keys = [...periodSums.keys()].sort();
    const lastKey = keys[keys.length - 1];
    const lastSlot = lastKey ? periodSums.get(lastKey) : null;
    const lastPeriodAvg = lastSlot && lastSlot.count > 0 ? lastSlot.sumDays / lastSlot.count : null;

    return {
      pastDueCount:    pastDueWithDays.length,
      pastDueAvgDays,
      pastDueBuckets,
      trailingOnTime,
      trailingTotal:   total,
      lastPeriodKey:   lastKey,
      lastPeriodCount: lastSlot?.count ?? 0,
      lastPeriodAvg,
    };
  }, [drops, pastDue, grain]);

  // ── Period buckets — the main chart + detail table data ────────────────
  const periods = useMemo(() => {
    const bucketByGrain = (date) => grain === 'month' ? date.slice(0, 7) : getWeekStart(date);
    const map = new Map();
    for (const d of drops) {
      const key = bucketByGrain(d.drop_act_date);
      if (!map.has(key)) map.set(key, { key, label: periodLabel(key, grain), drops: [], ontime: 0, late: 0, sumDays: 0 });
      const slot = map.get(key);
      const cat = categorize(d.drop_est_date, d.drop_act_date);
      slot.drops.push(d);
      slot[cat] += 1;
      slot.sumDays += daysBetween(d.drop_est_date, d.drop_act_date) || 0;
    }
    const arr = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    return arr.map(p => ({
      ...p,
      count: p.drops.length,
      avgDays: p.drops.length > 0 ? p.sumDays / p.drops.length : 0,
      ontimePct: p.drops.length > 0 ? p.ontime / p.drops.length : 0,
      latePct:   p.drops.length > 0 ? p.late   / p.drops.length : 0,
    }));
  }, [drops, grain]);

  // ── Breakdowns (Mail Location + Mail Method) ───────────────────────────
  const breakdownByLocation = useMemo(() => buildBreakdown(drops, 'mail_location'), [drops]);
  const breakdownByMethod   = useMemo(() => buildBreakdown(drops, 'mail_method'),   [drops]);

  // ── Sortable period table ──────────────────────────────────────────────
  const sortedPeriods = useMemo(() => {
    const rows = [...periods];
    rows.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'period') { av = a.key; bv = b.key; }
      let cmp;
      if (typeof av === 'string') cmp = String(av).localeCompare(String(bv));
      else cmp = (av || 0) - (bv || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [periods, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'period' ? 'desc' : 'desc'); }
  }

  function handleExport() {
    const rows = sortedPeriods.map(p => ({
      'Period':     p.label,
      'Period Key': p.key,
      'Drops Mailed': p.count,
      'Avg Days vs Est': p.avgDays.toFixed(2),
      'On Time':    p.ontime,
      'Late':       p.late,
      '% On Time':  (p.ontimePct * 100).toFixed(1),
      '% Late':     (p.latePct   * 100).toFixed(1),
    }));
    exportToCSV(rows, `mailing-timeliness-${grain}-${range.start}-${range.end}`);
  }

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Mailing Timeliness</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          How reliably we mail on or before the scheduled date. Bucketed by actual mail date.
          On Time = drop mailed on or before the scheduled date (early counts as on time).
          Excludes CANCELED / VOID, rows without a scheduled date, and LDP drops with no posted postage.
        </p>
      </div>

      {/* Snapshot KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard title="Past-Due (Right Now)" loading={loading}
          subtitle="Currently overdue, not yet mailed">
          <p className="text-2xl font-bold" style={{ color: 'var(--status-warn)' }}>
            {fmtN(kpis.pastDueCount)} drop{kpis.pastDueCount === 1 ? '' : 's'}
          </p>
          {/* Aging-bucket breakdown — same buckets the Late Mailings page
              uses. Each bucket shows the count tinted by severity, with
              the bucket label below in muted text. Buckets with zero
              count are rendered too so the layout stays stable. */}
          <div style={{
            display: 'grid', gridTemplateColumns: `repeat(${kpis.pastDueBuckets?.length || 5}, 1fr)`,
            gap: 4, marginTop: 10,
          }}>
            {(kpis.pastDueBuckets || []).map(b => (
              <div key={b.key} title={`${b.label}: ${fmtN(b.count)} drop${b.count === 1 ? '' : 's'}`}
                style={{ textAlign: 'center', padding: '2px 0', borderTop: `2px solid ${bucketColor(b.key)}` }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700,
                  color: b.count > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums' }}>
                  {fmtN(b.count)}
                </p>
                <p style={{ margin: 0, fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {b.label}
                </p>
              </div>
            ))}
          </div>
        </KpiCard>

        <KpiCard title="Last Completed Period" loading={loading}
          subtitle={kpis.lastPeriodKey ? periodLabel(kpis.lastPeriodKey, grain) : '—'}>
          <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {fmtN(kpis.lastPeriodCount)}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Avg {kpis.lastPeriodAvg != null ? `${fmtDays(kpis.lastPeriodAvg)} day${Math.abs(kpis.lastPeriodAvg - 1) > 0.05 ? 's' : ''} vs scheduled` : '—'}
          </p>
        </KpiCard>

        <KpiCard title="Trailing On-Time Rate" loading={loading}
          subtitle={`Across ${fmtN(kpis.trailingTotal)} completed drops in range`}>
          <p className="text-2xl font-bold" style={{ color: 'var(--status-ok)' }}>
            {fmtPct(kpis.trailingOnTime)}
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            On Time = act ≤ est (early counts as on time)
          </p>
        </KpiCard>

        <KpiCard title="Date Range" loading={false}
          subtitle="Default 3/1/2026 to yesterday">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input type="date" value={range.start}
              onChange={e => setRange(r => ({ ...r, start: e.target.value }))}
              style={dateInputStyle} />
            <input type="date" value={range.end}
              onChange={e => setRange(r => ({ ...r, end: e.target.value }))}
              style={dateInputStyle} />
          </div>
        </KpiCard>
      </div>

      {/* Controls row: grain toggle + export */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Grain:</span>
        {['week', 'month'].map(g => (
          <button key={g} onClick={() => setGrain(g)}
            className="text-xs px-3 py-1 rounded font-medium"
            style={{
              background: grain === g ? 'var(--accent)' : 'var(--surface2)',
              color:      grain === g ? '#fff'          : 'var(--text-secondary)',
              border: 'none', cursor: 'pointer',
            }}>
            {g === 'week' ? 'Week (Sun–Sat)' : 'Month'}
          </button>
        ))}
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>·</span>
        <button onClick={() => { setRange({ start: DEFAULT_START, end: defaultEnd }); }}
          className="text-xs px-2 py-1 rounded"
          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          Reset range
        </button>
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={handleExport}
            className="text-xs px-3 py-1 rounded font-medium"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Export CSV
          </button>
        </div>
      </div>

      {/* Historical chart */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
          Mailing Timeliness over Time
        </h2>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Bars: On Time (mailed on or before scheduled) vs Late drops per period.
          Black line = <strong>Avg Days vs Est</strong>, the signed average of
          <em> (actual − scheduled)</em> in days — positive means the period ran late on average, negative means it ran early.
        </p>
        {loading ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Loading…</div>
        ) : periods.length === 0 ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
            No completed drops in the selected range.
          </div>
        ) : (<>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={periods}
              onClick={(state) => {
                // Recharts hands us the activePayload for whatever bar/line
                // is under the cursor. The .payload is the original row,
                // which IS our period object, so we can set drill directly.
                const payload = state?.activePayload?.[0]?.payload;
                if (payload?.key) {
                  const fresh = periods.find(p => p.key === payload.key) || payload;
                  setDrillPeriod(fresh);
                }
              }}
              style={{ cursor: 'pointer' }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} angle={-30} textAnchor="end" height={60} />
              <YAxis yAxisId="left"  tick={{ fontSize: 11, fill: 'var(--text-muted)' }} label={{ value: 'Drops', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} label={{ value: 'Avg days vs est', angle: 90, position: 'insideRight', fill: 'var(--text-muted)', fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                formatter={(v, n) => n === 'Avg Days vs Est (signed)' ? [fmtDays(v), n] : [fmtN(v), n]}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar  yAxisId="left" dataKey="ontime" name="On Time (incl. Early)" stackId="a" fill="#16a34a" cursor="pointer" />
              <Bar  yAxisId="left" dataKey="late"   name="Late"                  stackId="a" fill="#dc2626" radius={[3, 3, 0, 0]} cursor="pointer" />
              <Line yAxisId="right" type="monotone" dataKey="avgDays" name="Avg Days vs Est (signed)"
                stroke="var(--text-primary)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Tip: click any bar (or anywhere over its period) to open a drop-by-drop matrix for that week / month.
          </p>
        </>)}
      </div>

      {/* Breakdown row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard title="On-Time Rate by Mail Location"
          rows={breakdownByLocation} loading={loading} />
        <BreakdownCard title="On-Time Rate by Mail Method"
          rows={breakdownByMethod} loading={loading} />
      </div>

      {/* Period detail table */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            By Period ({fmtN(periods.length)} {grain === 'month' ? 'months' : 'weeks'})
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Click a row to expand the underlying drops. Click a column header to re-sort.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)', color: 'var(--text-secondary)' }}>
              <tr>
                {[
                  { key: 'period',   label: 'Period',          align: 'left' },
                  { key: 'count',    label: 'Drops Mailed',    align: 'right' },
                  { key: 'avgDays',  label: 'Avg Days vs Est', align: 'right',
                    tooltip: 'Signed average of (actual − scheduled) in days across drops in this period. Positive = running late, negative = running early, zero = exactly on day.' },
                  { key: 'ontimePct',label: '% On Time',       align: 'right',
                    tooltip: 'Includes drops mailed on or before scheduled date.' },
                  { key: 'latePct',  label: '% Late',          align: 'right' },
                ].map(col => {
                  const active = sortKey === col.key;
                  return (
                    <th key={col.key} onClick={() => toggleSort(col.key)}
                      title={col.tooltip}
                      className={`px-3 py-2 font-medium cursor-pointer select-none ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                      style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {col.label}{col.tooltip ? ' ⓘ' : ''}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedPeriods.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  {loading ? 'Loading…' : 'No drops in this range.'}
                </td></tr>
              )}
              {sortedPeriods.map(p => {
                const isExp = !!expanded[p.key];
                return (
                  <PeriodRow key={p.key} period={p} isExp={isExp}
                    onToggle={() => setExpanded(prev => ({ ...prev, [p.key]: !prev[p.key] }))} />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drill-down modal — opens when the user clicks a chart bar.
          Surfaces every drop that mailed in that period with a matrix
          the user can scroll/sort/export to confirm the numbers. */}
      {drillPeriod && (
        <PeriodDrillModal period={drillPeriod} grain={grain}
          onClose={() => setDrillPeriod(null)} />
      )}
    </div>
  );
}

// ─── building blocks ────────────────────────────────────────────────────────

function KpiCard({ title, subtitle, loading, children }) {
  return (
    <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{title}</p>
      {loading ? (
        <p className="text-2xl font-bold" style={{ color: 'var(--text-muted)' }}>…</p>
      ) : children}
      {subtitle && (
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
      )}
    </div>
  );
}

const dateInputStyle = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)', outline: 'none',
};

// Build a sorted breakdown ([{ key, count, ontimePct, avgDays }, ...]) keyed
// by an arbitrary column on the drop row. Empty/null keys bucket to
// "Unspecified" so they don't get dropped.
function buildBreakdown(drops, columnKey) {
  const map = new Map();
  for (const d of drops) {
    const key = (d[columnKey] || '').trim() || 'Unspecified';
    if (!map.has(key)) map.set(key, { key, count: 0, ontime: 0, sumDays: 0 });
    const slot = map.get(key);
    slot.count += 1;
    if (categorize(d.drop_est_date, d.drop_act_date) === 'ontime') slot.ontime += 1;
    slot.sumDays += daysBetween(d.drop_est_date, d.drop_act_date) || 0;
  }
  return [...map.values()]
    .map(r => ({ ...r, ontimePct: r.count ? r.ontime / r.count : 0, avgDays: r.count ? r.sumDays / r.count : 0 }))
    .sort((a, b) => b.count - a.count);
}

// Horizontal-bar breakdown card. Width represents on-time %, count + avg
// shown alongside.
function BreakdownCard({ title, rows, loading }) {
  return (
    <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>{title}</h2>
      {loading ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No data.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(r => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 60px 60px', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.key}>{r.key}</span>
              <div style={{ height: 14, background: 'var(--surface2)', borderRadius: 7, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <div style={{
                  width: `${(r.ontimePct * 100).toFixed(1)}%`, height: '100%',
                  background: r.ontimePct >= 0.75 ? 'var(--status-ok)' : r.ontimePct >= 0.5 ? 'var(--status-warn)' : 'var(--status-critical)',
                  transition: 'width 0.2s',
                }} />
              </div>
              <span style={{ textAlign: 'right', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {(r.ontimePct * 100).toFixed(0)}%
              </span>
              <span style={{ textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtN(r.count)}
              </span>
            </div>
          ))}
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Bar = % on time (act ≤ est, early counts as on time). Right number = drop count.
          </p>
        </div>
      )}
    </div>
  );
}

// One period row + optional expanded drop list.
function PeriodRow({ period, isExp, onToggle }) {
  return (
    <>
      <tr onClick={onToggle}
        style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
        <td className="px-3 py-2" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
          <span style={{ display: 'inline-block', width: 10 }}>{isExp ? '▾' : '▸'}</span>
          {period.label}
        </td>
        <td className="px-3 py-2 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtN(period.count)}
        </td>
        <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums',
          color: period.avgDays > 0 ? 'var(--status-critical)' : period.avgDays < 0 ? 'var(--status-ok)' : 'var(--text-primary)' }}>
          {fmtDays(period.avgDays)}
        </td>
        <td className="px-3 py-2 text-right" style={{ color: 'var(--status-ok)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {(period.ontimePct * 100).toFixed(0)}%
        </td>
        <td className="px-3 py-2 text-right" style={{ color: 'var(--status-critical)', fontVariantNumeric: 'tabular-nums' }}>
          {(period.latePct   * 100).toFixed(0)}%
        </td>
      </tr>
      {isExp && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface2)', padding: 0 }}>
            <div style={{ padding: '8px 12px' }}>
              <table className="w-full text-[11px]">
                <thead>
                  <tr>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Customer</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Product</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Order ID</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Drop ID</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Mail Method</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Mail Location</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Est Date</th>
                    <th className="text-left px-2 py-1" style={{ color: 'var(--text-muted)' }}>Act Date</th>
                    <th className="text-right px-2 py-1" style={{ color: 'var(--text-muted)' }}>Days vs Est</th>
                    <th className="text-right px-2 py-1" style={{ color: 'var(--text-muted)' }}>Pieces</th>
                  </tr>
                </thead>
                <tbody>
                  {period.drops
                    .slice()
                    .sort((a, b) => (b.drop_act_date || '').localeCompare(a.drop_act_date || ''))
                    .slice(0, 500)
                    .map(d => {
                      const dl = daysBetween(d.drop_est_date, d.drop_act_date);
                      return (
                        <tr key={d.mail_drop_id} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-2 py-1" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                          <td className="px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                          <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-muted)' }}>
                            <OspreyOrderLink id={d.order_id} />
                          </td>
                          <td className="px-2 py-1 font-mono" style={{ color: 'var(--text-muted)' }}>
                            <OspreyDropLink id={d.mail_drop_id} />
                          </td>
                          <td className="px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{d.mail_method || '—'}</td>
                          <td className="px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{d.mail_location || '—'}</td>
                          <td className="px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{ET(d.drop_est_date)}</td>
                          <td className="px-2 py-1" style={{ color: 'var(--text-secondary)' }}>{ET(d.drop_act_date)}</td>
                          <td className="px-2 py-1 text-right" style={{ fontVariantNumeric: 'tabular-nums',
                            color: dl > 0 ? 'var(--status-critical)' : dl < 0 ? 'var(--status-ok)' : 'var(--text-primary)' }}>
                            {fmtDays(dl)}
                          </td>
                          <td className="px-2 py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                            {fmtN(d.mail_drop_quantity)}
                          </td>
                        </tr>
                      );
                    })}
                  {period.drops.length > 500 && (
                    <tr><td colSpan={10} className="px-2 py-2 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Showing first 500 of {fmtN(period.drops.length)} drops. Export CSV for the full set.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Period drill-down modal ────────────────────────────────────────────────
// Click any bar in the historical chart → this modal pops up showing every
// drop that mailed in that period as a matrix. Columns per user spec:
// Actual mail date · Est mail date · Delta · Order # · Drop ID · Customer ·
// Product type · Mail location.
//
// Sortable by clicking any column header. Defaults to delta-desc so the
// worst-late drops are at the top — fastest path to investigating outliers.
// CSV export of the visible matrix (full set, not the on-screen page) is
// available so the user can take the data into Excel.
function PeriodDrillModal({ period, grain, onClose }) {
  const [sortKey, setSortKey] = useState('delta');
  const [sortDir, setSortDir] = useState('desc');

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Build the matrix rows once — keep raw fields the column headers expect.
  const rows = useMemo(() => {
    return (period.drops || []).map(d => ({
      mail_drop_id:    d.mail_drop_id,
      order_id:        d.order_id,
      customer_name:   d.customer_name,
      product_category:d.product_category,
      mail_location:   d.mail_location,
      mail_method:     d.mail_method,
      drop_est_date:   d.drop_est_date,
      drop_act_date:   d.drop_act_date,
      delta:           daysBetween(d.drop_est_date, d.drop_act_date),
    }));
  }, [period]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      let cmp;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  function toggle(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'delta' || key === 'drop_act_date' ? 'desc' : 'asc'); }
  }

  function handleExport() {
    const out = sorted.map(r => ({
      'Actual Mail Date': r.drop_act_date || '',
      'Est Mail Date':    r.drop_est_date || '',
      'Delta (days)':     r.delta ?? '',
      'Order #':          r.order_id || '',
      'Drop ID':          r.mail_drop_id || '',
      'Customer':         r.customer_name || '',
      'Product':          r.product_category || '',
      'Mail Location':    r.mail_location || '',
      'Mail Method':      r.mail_method || '',
    }));
    exportToCSV(out, `mailing-timeliness-${grain}-${period.key}-drops`);
  }

  const lateCount = rows.filter(r => (r.delta || 0) > 0).length;
  const onTimeCount = rows.length - lateCount;
  const avgDelta = rows.length > 0 ? rows.reduce((s, r) => s + (r.delta || 0), 0) / rows.length : 0;

  const cols = [
    { key: 'drop_act_date',     label: 'Actual Mail Date', align: 'left',  fmt: v => ET(v) },
    { key: 'drop_est_date',     label: 'Est Mail Date',    align: 'left',  fmt: v => ET(v) },
    { key: 'delta',             label: 'Delta',            align: 'right', fmt: v => fmtDays(v) },
    { key: 'order_id',          label: 'Order #',          align: 'left',  fmt: v => v || '—' },
    { key: 'mail_drop_id',      label: 'Drop ID',          align: 'left',  fmt: v => v || '—' },
    { key: 'customer_name',     label: 'Customer',         align: 'left',  fmt: v => v || '—' },
    { key: 'product_category',  label: 'Product',          align: 'left',  fmt: v => v || '—' },
    { key: 'mail_location',     label: 'Mail Location',    align: 'left',  fmt: v => v || '—' },
  ];

  return (
    <div onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        padding: 24,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          width: 1080, maxWidth: '96vw', maxHeight: '92vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <p style={{ margin: 0, fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
              {period.label} — Drops Mailed
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              {fmtN(rows.length)} drop{rows.length === 1 ? '' : 's'} · {onTimeCount} on time · {lateCount} late · avg delta {fmtDays(avgDelta)} day{Math.abs(avgDelta - 1) > 0.05 ? 's' : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleExport}
              style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              Export CSV
            </button>
            <button onClick={onClose}
              style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              Close
            </button>
          </div>
        </div>

        {/* Matrix */}
        <div style={{ overflow: 'auto', flex: 1 }}>
          {rows.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No drops in this period.
            </p>
          ) : (
            <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--surface2)', zIndex: 1 }}>
                <tr>
                  {cols.map(col => {
                    const active = sortKey === col.key;
                    return (
                      <th key={col.key} onClick={() => toggle(col.key)}
                        className={`px-3 py-2 font-medium cursor-pointer select-none ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                        style={{
                          color: active ? 'var(--accent)' : 'var(--text-secondary)',
                          borderBottom: '1px solid var(--border)',
                          whiteSpace: 'nowrap',
                        }}>
                        {col.label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.mail_drop_id} style={{ borderTop: '1px solid var(--border)' }}>
                    {cols.map(col => {
                      const v = r[col.key];
                      const isDelta = col.key === 'delta';
                      return (
                        <td key={col.key}
                          className={`px-3 py-1.5 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                          style={{
                            color: isDelta
                              ? (v > 0 ? 'var(--status-critical)' : v < 0 ? 'var(--status-ok)' : 'var(--text-primary)')
                              : (col.key === 'customer_name' ? 'var(--text-primary)' : 'var(--text-secondary)'),
                            fontFamily: (col.key === 'order_id' || col.key === 'mail_drop_id') ? 'monospace' : 'inherit',
                            fontVariantNumeric: isDelta ? 'tabular-nums' : 'normal',
                            fontWeight: isDelta && v > 0 ? 600 : 'normal',
                            whiteSpace: 'nowrap',
                          }}>
                          {col.key === 'order_id' && v
                            ? <OspreyOrderLink id={v} />
                            : col.key === 'mail_drop_id' && v
                              ? <OspreyDropLink id={v} />
                              : col.fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
