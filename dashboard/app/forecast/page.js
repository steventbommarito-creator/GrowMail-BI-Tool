'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
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
  'Pre-Mail':           '#8b5cf6',
  'In Production':      '#3b82f6',
  'EDDM':               '#06b6d4',
  'Near Mail':          '#10b981',
  'Outsourced/WH':      '#f59e0b',
  'On Hold':            '#ef4444',
};

function dropBucket(status) {
  if (!status) return null;
  const s = status.toUpperCase().trim();
  if (['NEW', 'LIST RECEIVED', 'SCHEDULED', 'MAILING_LIST_IMPORTED', 'INITIAL', 'QUOTED'].includes(s)) return 'Pre-Mail';
  if (['PRODUCTION', 'INKJETTING', 'DAL', 'DAL SUBMITTED'].includes(s)) return 'In Production';
  if (s.startsWith('EDDM')) return 'EDDM';
  if (['READY SHIP', 'PENDING SHIP', 'RFL'].includes(s)) return 'Near Mail';
  if (['OUTSOURCED', 'WAREHOUSE'].includes(s)) return 'Outsourced/WH';
  if (s.startsWith('HOLD') || s === 'PAUSED') return 'On Hold';
  return null;
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

const effectivePostage = (d) =>
  (d.product_category || '').toLowerCase().includes('ldp postcard')
    ? (d.mail_drop_quantity || 0) * 0.244
    : d.postage_amount || 0;

// ─── Component ────────────────────────────────────────────────────────────────
export default function ForecastPage() {
  const supabase = createClient();
  const [drops, setDrops]                       = useState([]);
  const [transactions, setTransactions]         = useState([]);
  const [projectedDeposits, setProjectedDeposits] = useState([]);
  const [loading, setLoading]                   = useState(true);
  const [chartMode, setChartMode]               = useState('order'); // 'order' | 'drop'

  const today         = new Date().toISOString().split('T')[0];
  const nextWeekStart = addDays(getWeekStart(today), 7); // start of next week

  const load = useCallback(async () => {
    setLoading(true);
    const in12w   = addDays(today, 84);
    const since90 = addDays(today, -90);

    const [{ data: dropData }, { data: txns }, { data: projData }] = await Promise.all([
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, order_status, postage_amount, mail_drop_quantity, mail_drop_amount, order_amount, payment_amount_applied')
        .in('order_status', FORECAST_STATUSES)
        .gte('drop_est_date', nextWeekStart)   // ← next week and beyond only
        .lte('drop_est_date', in12w),
      supabase.from('usps_transactions')
        .select('transaction_number, transaction_date, ending_balance')
        .gte('transaction_date', since90)
        .order('transaction_date', { ascending: false })
        .limit(10),
      supabase.from('projected_deposits')
        .select('*').eq('is_active', true).order('deposit_date'),
    ]);

    setDrops(dropData || []);
    setTransactions(txns || []);
    setProjectedDeposits(projData || []);
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

  // ── Weekly breakdown — with BOTH bucket sets pre-computed ──────────────────
  const weeklyBreakdown = useMemo(() => {
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (!weekMap[ws]) weekMap[ws] = { week: ws, label: weekRangeLabel(ws), total: 0 };
      const p  = effectivePostage(d);
      weekMap[ws].total += p;

      const ob = orderBucket(d.order_status);
      if (ob) weekMap[ws][`o_${ob}`] = (weekMap[ws][`o_${ob}`] || 0) + p;

      const db = dropBucket(d.drop_status);
      if (db) weekMap[ws][`d_${db}`] = (weekMap[ws][`d_${db}`] || 0) + p;
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 12);
  }, [drops]);

  // ── EPS runway ────────────────────────────────────────────────────────────
  const runwayData = useMemo(() => {
    let balance = currentBalance;
    const data = [{ date: today, balance }];
    const events = [
      ...weeklyBreakdown.map(w => ({ date: addDays(w.week, 3), amount: -w.total, type: 'postage' })),
      ...projectedDeposits.map(p => ({ date: p.deposit_date, amount: p.amount, type: 'deposit' })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of events) {
      balance += e.amount;
      data.push({ date: e.date, balance: +balance.toFixed(2), type: e.type });
    }
    return data;
  }, [currentBalance, weeklyBreakdown, projectedDeposits, today]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalPostage = useMemo(() => drops.reduce((s, d) => s + effectivePostage(d), 0), [drops]);
  const totalPieces  = useMemo(() => drops.reduce((s, d) => s + (d.mail_drop_quantity || 0), 0), [drops]);

  // Bucket totals for pills
  const orderBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = orderBucket(d.order_status); if (b) out[b] = (out[b] || 0) + effectivePostage(d); }
    return out;
  }, [drops]);
  const dropBucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) { const b = dropBucket(d.drop_status); if (b) out[b] = (out[b] || 0) + effectivePostage(d); }
    return out;
  }, [drops]);

  const activeBuckets = chartMode === 'order' ? ORDER_BUCKETS : DROP_BUCKETS;
  const prefix        = chartMode === 'order' ? 'o_' : 'd_';

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Current EPS Balance', value: fmt$(currentBalance), color: currentBalance < 0 ? 'var(--status-critical)' : 'var(--status-ok)' },
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
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Postage by Week
          </h2>
          {/* Toggle */}
          <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {[['order', 'By Order Stage'], ['drop', 'By Drop Status']].map(([mode, label]) => (
              <button key={mode} onClick={() => setChartMode(mode)}
                className="text-xs px-3 py-1 font-medium"
                style={{
                  background: chartMode === mode ? 'var(--accent)' : 'var(--surface2)',
                  color: chartMode === mode ? 'var(--accent-text)' : 'var(--text-secondary)',
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Bucket legend pills */}
        <div className="flex flex-wrap gap-2 mb-3">
          {Object.entries(activeBuckets).map(([bucket, color]) => {
            const totals = chartMode === 'order' ? orderBucketTotals : dropBucketTotals;
            return totals[bucket] ? (
              <div key={bucket} className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                {bucket}: {fmt$(totals[bucket])}
              </div>
            ) : null;
          })}
        </div>

        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={weeklyBreakdown} margin={{ left: 10 }}>
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
                    style={{ color: c, borderBottom: '1px solid var(--border)', opacity: 0.9 }}>{b}</th>
                ))}
                {/* Divider */}
                <th className="px-1" style={{ borderBottom: '1px solid var(--border)', borderLeft: '2px solid var(--border)' }} />
                {/* Drop status columns */}
                {Object.entries(DROP_BUCKETS).map(([b, c]) => (
                  <th key={`d_${b}`} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: c, borderBottom: '1px solid var(--border)', opacity: 0.9 }}>{b}</th>
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
