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

// All active pipeline statuses — excludes: CANCELED, VOID, LIMBO, INCOMPLETE,
// QUOTE, QUOTE [SENT], INCOMING [DECLINED], DESIGN DENIED, PROOF DENIED,
// PAYMENT REQUIRED, PAYMENT REQUIRED - INTERNAL, PAYMENT PENDING
const FORECAST_STATUSES = [
  'INCOMING [APPROVED]',
  'DESIGN', 'DESIGN [PROOF]', 'DESIGN [PROOF - INT]', 'DESIGN [REUPLOAD]',
  'DESIGN PROOF QC', 'DESIGN FINAL QC', 'DESIGN APPROVED',
  'GRAPHICS [WIP]',
  'PREPRESS', 'PREPRESS [PROOF]', 'PREPRESS [REUPLOAD]', 'PREPRESS [PCCB]',
  'PROOF APPROVED', 'QC APPROVAL',
  'PRESS [READY]',
  'DIGITAL READY', 'DIGITAL OUTSOURCED', 'DIGITAL [STAGING]',
  'DIGITAL [CUTTING]', 'DIGITAL [SHIPPING]',
  'DAL [STAGING]', 'DAL [SUBMITTED]',
  'DMM [STAGING]', 'DMM [ACTIVE]',
  'OUTSOURCED', 'OUTSOURCED [STAGING]', 'OUTSOURCED [LVC]',
  'WAREHOUSE [KSCOPE]', 'WAREHOUSE [LVC]',
  'READY [MAIL]', 'SHIPPED',
  'ACTIVE RUN',
  'COMPLETE',
];

// Group a status into a display bucket
const BUCKET_COLORS = {
  'Pre-Production': '#8b5cf6',
  'Press':          '#3b82f6',
  'Digital':        '#06b6d4',
  'Outsourced':     '#f59e0b',
  'Mail Ready':     '#10b981',
  'Other':          '#6b7280',
};

function statusBucket(status) {
  if (!status) return 'Other';
  const s = status.toUpperCase();
  if (s.startsWith('DESIGN') || s === 'INCOMING [APPROVED]' || s === 'GRAPHICS [WIP]') return 'Pre-Production';
  if (s.startsWith('PREPRESS') || s.includes('PROOF') || s === 'QC APPROVAL' || s === 'PRESS [READY]') return 'Press';
  if (s.startsWith('DIGITAL') || s.startsWith('DAL') || s.startsWith('DMM')) return 'Digital';
  if (s.startsWith('OUTSOURCED') || s.startsWith('WAREHOUSE') || s === 'ACTIVE RUN') return 'Outsourced';
  if (s === 'READY [MAIL]' || s === 'SHIPPED' || s === 'COMPLETE') return 'Mail Ready';
  return 'Other';
}

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

// LDP Postcard postage override
const effectivePostage = (d) =>
  (d.product_category || '').toLowerCase().includes('ldp postcard')
    ? (d.mail_drop_quantity || 0) * 0.244
    : d.postage_amount || 0;

export default function ForecastPage() {
  const supabase = createClient();
  const [drops, setDrops]                     = useState([]);
  const [transactions, setTransactions]       = useState([]);
  const [projectedDeposits, setProjectedDeposits] = useState([]);
  const [loading, setLoading]                 = useState(true);

  const today = new Date().toISOString().split('T')[0];

  const load = useCallback(async () => {
    setLoading(true);
    const in12w = addDays(today, 84);
    const since90 = addDays(today, -90);

    const [{ data: dropData }, { data: txns }, { data: projData }] = await Promise.all([
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, order_status, postage_amount, mail_drop_quantity, mail_drop_amount, order_amount, payment_amount_applied')
        .in('order_status', FORECAST_STATUSES)
        .lte('drop_est_date', in12w),
      supabase.from('usps_transactions')
        .select('transaction_number, transaction_date, ending_balance')
        .gte('transaction_date', since90)
        .order('transaction_date', { ascending: false })
        .limit(1),
      supabase.from('projected_deposits')
        .select('*')
        .eq('is_active', true)
        .order('deposit_date'),
    ]);

    setDrops(dropData || []);
    setTransactions(txns || []);
    setProjectedDeposits(projData || []);
    setLoading(false);
  }, [today]);

  useEffect(() => { load(); }, [load]);

  // Current EPS balance from most recent transaction
  const currentBalance = useMemo(() => {
    if (!transactions.length) return 0;
    const sorted = [...transactions].sort((a, b) => {
      const dd = new Date(b.transaction_date) - new Date(a.transaction_date);
      if (dd !== 0) return dd;
      return Number(b.transaction_number) - Number(a.transaction_number);
    });
    return sorted[0]?.ending_balance ?? 0;
  }, [transactions]);

  // Group drops by week with bucket breakdown
  const weeklyBreakdown = useMemo(() => {
    const weekMap = {};
    for (const d of drops) {
      if (!d.drop_est_date) continue;
      const ws = getWeekStart(d.drop_est_date);
      if (!weekMap[ws]) weekMap[ws] = { week: ws, label: weekRangeLabel(ws), total: 0 };
      const bucket = statusBucket(d.order_status);
      const p = effectivePostage(d);
      weekMap[ws].total += p;
      weekMap[ws][bucket] = (weekMap[ws][bucket] || 0) + p;
    }
    return Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 12);
  }, [drops]);

  // EPS runway chart: current balance - weekly postage + projected deposits
  const runwayData = useMemo(() => {
    let balance = currentBalance;
    const data = [{ date: today, balance, type: 'start' }];

    const events = [];
    for (const w of weeklyBreakdown) {
      events.push({ date: addDays(w.week, 3), amount: -w.total, type: 'postage' });
    }
    for (const p of projectedDeposits) {
      events.push({ date: p.deposit_date, amount: p.amount, type: 'deposit', label: p.note });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));

    for (const e of events) {
      balance += e.amount;
      data.push({ date: e.date, balance: +balance.toFixed(2), type: e.type, label: e.label || '' });
    }
    return data;
  }, [currentBalance, weeklyBreakdown, projectedDeposits, today]);

  // KPIs
  const totalPostage  = useMemo(() => drops.reduce((s, d) => s + effectivePostage(d), 0), [drops]);
  const totalPieces   = useMemo(() => drops.reduce((s, d) => s + (d.mail_drop_quantity || 0), 0), [drops]);
  const totalDrops    = drops.length;
  const weeksOfPipe   = weeklyBreakdown.length;

  // Bucket totals for KPI
  const bucketTotals = useMemo(() => {
    const out = {};
    for (const d of drops) {
      const b = statusBucket(d.order_status);
      out[b] = (out[b] || 0) + effectivePostage(d);
    }
    return out;
  }, [drops]);

  if (loading) return <p style={{ color: 'var(--text-muted)' }} className="p-4">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Postage Forecast</h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          All active pipeline statuses · {FORECAST_STATUSES.length} statuses · next 12 weeks
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Postage in Pipeline', value: fmt$(totalPostage) },
          { label: 'Total Pieces', value: totalPieces.toLocaleString() },
          { label: 'Total Drops', value: totalDrops.toLocaleString() },
          { label: 'Weeks of Pipeline', value: weeksOfPipe },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Bucket postage breakdown pills */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(BUCKET_COLORS).map(([bucket, color]) =>
          bucketTotals[bucket] ? (
            <div key={bucket} className="flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium border"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
              {bucket}: {fmt$(bucketTotals[bucket])}
            </div>
          ) : null
        )}
      </div>

      {/* EPS Balance Runway */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            EPS Balance Runway — Full Pipeline (12 Weeks)
          </h2>
          <span className="text-xs px-2 py-0.5 rounded font-medium"
            style={{
              background: currentBalance < 0 ? 'var(--status-critical-bg)' : 'var(--status-ok-bg)',
              color: currentBalance < 0 ? 'var(--status-critical)' : 'var(--status-ok)',
            }}>
            Current: {fmt$(currentBalance)}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={runwayData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip
              formatter={(v) => fmt$(v)}
              labelFormatter={(l) => l}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
            <ReferenceLine y={0} stroke="var(--status-critical)" strokeDasharray="4 4" label={{ value: '$0', fill: 'var(--status-critical)', fontSize: 10 }} />
            <Area type="monotone" dataKey="balance" stroke="var(--accent)" fill="var(--accent-light)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Weekly postage stacked by bucket */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
          Postage by Week — Breakdown by Stage
        </h2>
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
            {Object.entries(BUCKET_COLORS).map(([bucket, color]) => (
              <Bar key={bucket} dataKey={bucket} stackId="a" fill={color} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Weekly summary table */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Weekly Pipeline Summary</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {['Week', 'Total Postage', ...Object.keys(BUCKET_COLORS), 'Proj. Deposit'].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
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
                    {Object.keys(BUCKET_COLORS).map(bucket => (
                      <td key={bucket} className="px-3 py-2" style={{ color: w[bucket] ? BUCKET_COLORS[bucket] : 'var(--text-muted)' }}>
                        {w[bucket] ? fmt$(w[bucket]) : '—'}
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
                {Object.keys(BUCKET_COLORS).map(bucket => (
                  <td key={bucket} className="px-3 py-2 font-semibold" style={{ color: bucketTotals[bucket] ? BUCKET_COLORS[bucket] : 'var(--text-muted)' }}>
                    {bucketTotals[bucket] ? fmt$(bucketTotals[bucket]) : '—'}
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
