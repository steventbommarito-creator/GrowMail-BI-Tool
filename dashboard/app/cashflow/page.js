'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import { exportToExcel, exportToPDF } from '../../lib/export';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => n == null ? '—' : '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
const ET = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Detroit' }) : '—';

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r.toISOString().split('T')[0];
}

function weekLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function weekRangeLabel(weekStart) {
  const start = new Date(weekStart + 'T12:00:00');
  const end = new Date(weekStart + 'T12:00:00');
  end.setDate(start.getDate() + 6);
  return `Week of ${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`;
}

function dayLabel(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    timeZone: 'America/Detroit', weekday: 'short', month: 'numeric', day: 'numeric'
  });
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const ws = new Date(d);
  ws.setDate(d.getDate() - d.getDay());
  return ws.toISOString().split('T')[0];
}

export default function CashflowPage() {
  const supabase = createClient();
  const [transactions, setTransactions] = useState([]);
  const [drops, setDrops] = useState([]);
  const [projectedDeposits, setProjectedDeposits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [weekView, setWeekView] = useState(null);
  const [expandedWeeks, setExpandedWeeks] = useState({});
  const [expandedDays, setExpandedDays] = useState({});
  const [showAddDeposit, setShowAddDeposit] = useState(false);
  const [newDeposit, setNewDeposit] = useState({ date: '', amount: '', note: '' });
  const [userEmail, setUserEmail] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data?.user?.email || ''));
    load();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const since90 = addDays(new Date().toISOString().split('T')[0], -90);
    const in8w = addDays(new Date().toISOString().split('T')[0], 56);
    const today = new Date().toISOString().split('T')[0];

    const [{ data: txns }, { data: dropData }, { data: projData }] = await Promise.all([
      supabase.from('usps_transactions').select('*').gte('transaction_date', since90).order('transaction_date', { ascending: true }),
      supabase.from('osprey_mail_drops').select('mail_drop_id, order_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, is_live_status, postage_amount, production_amount, mail_drop_quantity, payment_amount_applied, order_amount, web_id').or(`drop_est_date.gte.${today},drop_act_date.gte.${since90}`).lte('drop_est_date', in8w),
      supabase.from('projected_deposits').select('*').eq('is_active', true).order('deposit_date'),
    ]);

    setTransactions(txns || []);
    setDrops(dropData || []);
    setProjectedDeposits(projData || []);
    setLoading(false);
  }, []);

  // Current EPS balance = last ending_balance in transactions
  const currentBalance = useMemo(() => {
    if (!transactions.length) return 0;
    const sorted = [...transactions].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));
    return sorted[0]?.ending_balance || 0;
  }, [transactions]);

  // Past-due drops: live status AND scheduled date is before today
  const today = new Date().toISOString().split('T')[0];
  const pastDueDrops = useMemo(() =>
    drops.filter(d => d.is_live_status && d.drop_est_date < today && !d.drop_act_date),
    [drops, today]);

  // Weekly postage needs (8 weeks forward + past-due rolled into current week)
  const weeklyNeeds = useMemo(() => {
    const weeks = {};
    const currentWeekStart = getWeekStart(today);

    // Past-due drops → current week
    for (const d of pastDueDrops) {
      const w = currentWeekStart;
      if (!weeks[w]) weeks[w] = { week: w, postage: 0, drops: [], pastDue: 0 };
      weeks[w].postage += d.postage_amount || 0;
      weeks[w].pastDue += d.postage_amount || 0;
      weeks[w].drops.push({ ...d, _pastDue: true });
    }

    // Future drops
    for (const d of drops) {
      if (!d.drop_est_date || d.drop_act_date || (d.drop_est_date < today && d.is_live_status)) continue;
      const w = getWeekStart(d.drop_est_date);
      if (!weeks[w]) weeks[w] = { week: w, postage: 0, drops: [], pastDue: 0 };
      weeks[w].postage += d.postage_amount || 0;
      weeks[w].drops.push(d);
    }

    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 8);
  }, [drops, today, pastDueDrops]);

  // EPS balance runway chart
  const runwayData = useMemo(() => {
    let balance = currentBalance;
    const data = [{ date: today, balance, projected: false }];

    const events = [];
    for (const w of weeklyNeeds) {
      const daysToMidWeek = 3;
      events.push({ date: addDays(w.week, daysToMidWeek), amount: -(w.postage), type: 'postage' });
    }
    for (const p of projectedDeposits) {
      events.push({ date: p.deposit_date, amount: p.amount, type: 'deposit', label: p.note });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));

    for (const e of events) {
      balance += e.amount;
      data.push({ date: e.date, balance: +balance.toFixed(2), type: e.type, label: e.label });
    }
    return data;
  }, [currentBalance, weeklyNeeds, projectedDeposits, today]);

  // Accounting weekly table: postage due, expected stripe, expected invoice
  const accountingRows = useMemo(() => {
    return weeklyNeeds.map(w => {
      const prepay = w.drops.filter(d => (d.payment_amount_applied || 0) > 0);
      const terms = w.drops.filter(d => !d.payment_amount_applied || d.payment_amount_applied === 0);

      // Stripe Expected: prepay customers where ~50% deposit was collected at order —
      // remaining balance (order_amount - paid) expected at delivery
      const expectedStripe = prepay.reduce((s, d) => {
        const paid = d.payment_amount_applied || 0;
        const total = d.order_amount || 0;
        const pct = total ? paid / total : 0;
        return s + (pct > 0.4 && pct < 0.7 ? (total - paid) : 0);
      }, 0);

      // Invoice Expected: net-terms customers — full production amount (order less postage)
      const expectedInvoice = terms.reduce((s, d) => s + (d.production_amount || (d.order_amount || 0) - (d.postage_amount || 0)), 0);

      const projDeposit = projectedDeposits.find(p => getWeekStart(p.deposit_date) === w.week);
      const epsGap = balance => balance - w.postage < 0;

      return {
        week: weekLabel(w.week),
        weekStart: w.week,
        postageDue: w.postage,
        pastDue: w.pastDue,
        expectedStripe,
        expectedInvoice,
        totalExpected: expectedStripe + expectedInvoice,
        projDeposit: projDeposit?.amount || 0,
        dropCount: w.drops.length,
      };
    });
  }, [weeklyNeeds, projectedDeposits]);

  async function addProjectedDeposit() {
    if (!newDeposit.date || !newDeposit.amount) return;
    const { error } = await supabase.from('projected_deposits').upsert({
      deposit_date: newDeposit.date,
      amount: parseFloat(newDeposit.amount),
      note: newDeposit.note || null,
      created_by: userEmail,
      is_active: true,
    }, { onConflict: 'deposit_date' });

    if (!error) {
      // Audit log
      await supabase.from('projected_deposit_audit').insert({
        action: 'create',
        new_amount: parseFloat(newDeposit.amount),
        new_date: newDeposit.date,
        changed_by: userEmail,
        note: newDeposit.note || null,
      });
      await supabase.from('notifications').insert({
        event_type: 'deposit_projected',
        title: `Projected deposit added: ${newDeposit.date}`,
        body: `$${parseFloat(newDeposit.amount).toLocaleString()} by ${userEmail}`,
        severity: 'info', source: 'cashflow',
        data_json: { date: newDeposit.date, amount: parseFloat(newDeposit.amount) },
      });
      setNewDeposit({ date: '', amount: '', note: '' });
      setShowAddDeposit(false);
      load();
    }
  }

  async function deleteDeposit(id, date, amount) {
    await supabase.from('projected_deposits').update({ is_active: false }).eq('id', id);
    await supabase.from('projected_deposit_audit').insert({
      projected_deposit_id: id,
      action: 'delete',
      previous_amount: amount,
      previous_date: date,
      changed_by: userEmail,
    });
    load();
  }

  if (loading) return <p style={{ color: 'var(--text-muted)' }} className="p-4">Loading...</p>;

  const exportAccountingExcel = () => {
    exportToExcel(accountingRows.map(r => ({
      'Week': r.week,
      'Postage Due': r.postageDue.toFixed(2),
      'Past-Due Rolled': r.pastDue.toFixed(2),
      'Expected Stripe': r.expectedStripe.toFixed(2),
      'Expected Invoice': r.expectedInvoice.toFixed(2),
      'Total Expected': r.totalExpected.toFixed(2),
      'Projected Deposit': r.projDeposit.toFixed(2),
    })), 'weekly-cashflow', 'Weekly Cashflow');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Cashflow & EPS</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowAddDeposit(v => !v)}
            className="text-sm px-3 py-1.5 rounded font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: 'none' }}>
            + Add Projected Deposit
          </button>
          <button onClick={exportAccountingExcel}
            className="text-sm px-3 py-1.5 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Export Excel
          </button>
        </div>
      </div>

      {/* Add Deposit Form */}
      {showAddDeposit && (
        <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--accent)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Add Projected Deposit</h3>
          <div className="flex flex-wrap gap-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Date</label>
              <input type="date" value={newDeposit.date} onChange={e => setNewDeposit(d => ({ ...d, date: e.target.value }))}
                className="border rounded px-2 py-1 text-sm"
                style={{ background: 'var(--surface2)', color: 'var(--text-primary)', borderColor: 'var(--border)' }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Amount ($)</label>
              <input type="number" value={newDeposit.amount} onChange={e => setNewDeposit(d => ({ ...d, amount: e.target.value }))}
                placeholder="50000"
                className="border rounded px-2 py-1 text-sm w-32"
                style={{ background: 'var(--surface2)', color: 'var(--text-primary)', borderColor: 'var(--border)' }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Note (optional)</label>
              <input type="text" value={newDeposit.note} onChange={e => setNewDeposit(d => ({ ...d, note: e.target.value }))}
                placeholder="e.g. Monthly transfer"
                className="border rounded px-2 py-1 text-sm w-48"
                style={{ background: 'var(--surface2)', color: 'var(--text-primary)', borderColor: 'var(--border)' }} />
            </div>
            <div className="flex items-end gap-2">
              <button onClick={addProjectedDeposit}
                className="text-sm px-3 py-1.5 rounded font-medium"
                style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
                Save
              </button>
              <button onClick={() => setShowAddDeposit(false)}
                className="text-sm px-3 py-1.5 rounded"
                style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Current EPS Balance', value: fmt$(currentBalance), color: currentBalance < 0 ? 'var(--status-critical)' : 'var(--status-ok)' },
          { label: 'Postage Needed (8 wks)', value: fmt$(weeklyNeeds.reduce((s, w) => s + w.postage, 0)) },
          { label: 'Past-Due Liability', value: fmt$(pastDueDrops.reduce((s, d) => s + (d.postage_amount || 0), 0)), color: pastDueDrops.length ? 'var(--status-warn)' : undefined },
          { label: 'Projected Deposits', value: fmt$(projectedDeposits.reduce((s, p) => s + p.amount, 0)) },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-xl font-bold" style={{ color: k.color || 'var(--text-primary)' }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Balance Runway Chart */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
          EPS Balance Runway — Current + 8 Weeks
        </h2>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={runwayData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            <ReferenceLine y={0} stroke="var(--status-critical)" strokeDasharray="4 4" />
            <Area type="monotone" dataKey="balance" stroke="var(--accent)" fill="var(--accent-light)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Projected Deposits List */}
      {projectedDeposits.length > 0 && (
        <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>Projected Deposits</h2>
          <div className="space-y-2">
            {projectedDeposits.map(p => (
              <div key={p.id} className="flex items-center justify-between text-sm py-2 border-b"
                style={{ borderColor: 'var(--border)' }}>
                <div>
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{ET(p.deposit_date)}</span>
                  <span className="ml-3" style={{ color: 'var(--status-ok)' }}>{fmt$(p.amount)}</span>
                  {p.note && <span className="ml-3 text-xs" style={{ color: 'var(--text-muted)' }}>{p.note}</span>}
                  {p.created_by && <span className="ml-3 text-xs" style={{ color: 'var(--text-muted)' }}>by {p.created_by}</span>}
                </div>
                <button onClick={() => deleteDeposit(p.id, p.deposit_date, p.amount)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ color: 'var(--status-critical)', background: 'var(--status-critical-bg)' }}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Weekly Accounting Table — Accordion */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Weekly Accounting View</h2>
          <button onClick={exportAccountingExcel} className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Export All (Excel)
          </button>
        </div>

        {/* Column headers */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {['', 'Week', 'Postage Due', 'Stripe Expected', 'Invoice Expected', 'Total Expected', 'Proj. Deposit', 'Drops', ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accountingRows.map((r, i) => {
                const isGap = r.postageDue > currentBalance && r.projDeposit === 0;
                const isExpanded = expandedWeeks[r.weekStart];
                const weekData = weeklyNeeds.find(w => w.week === r.weekStart);

                // Group drops by day
                const byDay = {};
                for (const d of (weekData?.drops || [])) {
                  const key = d._pastDue ? 'past-due' : (d.drop_est_date || 'unknown');
                  if (!byDay[key]) byDay[key] = [];
                  byDay[key].push(d);
                }
                // past-due always first, then chronological
                const dayKeys = Object.keys(byDay).sort((a, b) => {
                  if (a === 'past-due') return -1;
                  if (b === 'past-due') return 1;
                  return a.localeCompare(b);
                });

                const exportWeekExcel = () => {
                  exportToExcel((weekData?.drops || []).map(d => ({
                    'Customer': d.customer_name || '',
                    'Product': d.product_category || '',
                    'Drop ID': d.mail_drop_id || '',
                    'Order ID': d.order_id || '',
                    'Est. Date': d.drop_est_date || '',
                    'Status': d.drop_status || '',
                    'Postage': d.postage_amount || 0,
                    'Pieces': d.mail_drop_quantity || 0,
                    'Past-Due': d._pastDue ? 'Yes' : 'No',
                  })), `week-${r.weekStart}`, r.weekStart);
                };

                return [
                  // Main week row
                  <tr key={r.weekStart}
                    onClick={() => setExpandedWeeks(s => ({ ...s, [r.weekStart]: !s[r.weekStart] }))}
                    className="cursor-pointer"
                    style={{
                      background: isGap ? 'var(--status-critical-bg)' :
                                  r.pastDue > 0 ? 'var(--status-warn-bg)' :
                                  i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                      borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                    }}>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-muted)', width: 24 }}>
                      {isExpanded ? '▼' : '▶'}
                    </td>
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      {weekRangeLabel(r.weekStart)}
                      {r.pastDue > 0 && <span className="ml-2 text-xs" style={{ color: 'var(--status-warn)' }}>⚠ past-due</span>}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: isGap ? 'var(--status-critical)' : 'var(--text-primary)' }}>{fmt$(r.postageDue)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--status-ok)' }}>{fmt$(r.expectedStripe)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>{fmt$(r.expectedInvoice)}</td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: 'var(--text-primary)' }}>{fmt$(r.totalExpected)}</td>
                    <td className="px-3 py-2.5" style={{ color: r.projDeposit > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {r.projDeposit > 0 ? fmt$(r.projDeposit) : '—'}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.dropCount}</td>
                    <td className="px-3 py-2.5">
                      <button onClick={e => { e.stopPropagation(); exportWeekExcel(); }}
                        className="text-xs px-2 py-0.5 rounded whitespace-nowrap"
                        style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                        Export Week
                      </button>
                    </td>
                  </tr>,

                  // Expanded: day accordions
                  isExpanded && (
                    <tr key={`${r.weekStart}-expanded`}>
                      <td colSpan={9} style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)', padding: 0 }}>
                        <div className="px-8 py-3 space-y-2">
                          {dayKeys.map(dayKey => {
                            const dayDrops = byDay[dayKey];
                            const dayPostage = dayDrops.reduce((s, d) => s + (d.postage_amount || 0), 0);
                            const isDayExpanded = expandedDays[`${r.weekStart}-${dayKey}`];
                            const label = dayKey === 'past-due' ? '⚠ Late Mail (rolled forward)' : dayLabel(dayKey);
                            const dayDeposit = dayKey !== 'past-due'
                              ? projectedDeposits.filter(p => p.deposit_date === dayKey).reduce((s, p) => s + p.amount, 0)
                              : 0;

                            const exportDayExcel = () => {
                              exportToExcel(dayDrops.map(d => ({
                                'Customer': d.customer_name || '',
                                'Product': d.product_category || '',
                                'Drop ID': d.mail_drop_id || '',
                                'Order ID': d.order_id || '',
                                'Est. Date': d.drop_est_date || '',
                                'Status': d.drop_status || '',
                                'Postage': d.postage_amount || 0,
                                'Pieces': d.mail_drop_quantity || 0,
                              })), `drops-${dayKey}`, dayKey);
                            };

                            return (
                              <div key={dayKey} className="rounded border overflow-hidden"
                                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                                {/* Day header */}
                                <div className="flex items-center justify-between px-3 py-2 cursor-pointer"
                                  onClick={() => setExpandedDays(s => ({ ...s, [`${r.weekStart}-${dayKey}`]: !s[`${r.weekStart}-${dayKey}`] }))}
                                  style={{ borderBottom: isDayExpanded ? '1px solid var(--border)' : 'none' }}>
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isDayExpanded ? '▼' : '▶'}</span>
                                    <span className="text-sm font-medium" style={{ color: dayKey === 'past-due' ? 'var(--status-warn)' : 'var(--text-primary)' }}>
                                      {label}
                                    </span>
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                      {dayDrops.length} drop{dayDrops.length !== 1 ? 's' : ''} · {fmt$(dayPostage)}
                                    </span>
                                    {dayDeposit > 0 && (
                                      <span className="text-xs font-medium px-2 py-0.5 rounded"
                                        style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>
                                        Expected Deposit: {fmt$(dayDeposit)}
                                      </span>
                                    )}
                                  </div>
                                  <button onClick={e => { e.stopPropagation(); exportDayExcel(); }}
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                    Export Day
                                  </button>
                                </div>

                                {/* Day drops table */}
                                {isDayExpanded && (
                                  <table className="w-full text-xs">
                                    <thead style={{ background: 'var(--surface2)' }}>
                                      <tr>
                                        {['Customer', 'Product', 'Drop ID', 'Status', 'Postage', 'Pieces', 'Flag'].map(h => (
                                          <th key={h} className="text-left px-3 py-1.5 font-medium"
                                            style={{ color: 'var(--text-muted)' }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {dayDrops.map((d, di) => (
                                        <tr key={d.mail_drop_id || di} style={{
                                          background: di % 2 === 0 ? 'transparent' : 'var(--surface2)',
                                          borderTop: '1px solid var(--border)',
                                        }}>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_id || '—'}</td>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.drop_status || '—'}</td>
                                          <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>{fmt$(d.postage_amount)}</td>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_quantity?.toLocaleString() || '—'}</td>
                                          <td className="px-3 py-1.5">
                                            {d._pastDue && <span className="font-medium" style={{ color: 'var(--status-warn)' }}>PAST DUE</span>}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent EPS Transactions */}
      <div className="rounded-xl border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Recent EPS Transactions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {['Date (ET)', 'Type', 'Amount', 'Balance', 'Job ID', 'Bucket', 'Match'].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...transactions].reverse().slice(0, 30).map((t, i) => (
                <tr key={t.id} style={{
                  background: i % 2 === 0 ? 'transparent' : 'var(--surface2)',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(t.transaction_date)}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{t.transaction_type || '—'}</td>
                  <td className="px-3 py-1.5 font-medium"
                    style={{ color: (t.amount || 0) >= 0 ? 'var(--status-ok)' : 'var(--status-critical)' }}>
                    {fmt$(t.amount)}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{fmt$(t.ending_balance)}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{t.job_id || '—'}</td>
                  <td className="px-3 py-1.5">
                    <span className="px-1.5 py-0.5 rounded text-xs"
                      style={{
                        background: t.transaction_bucket === 'matched' ? 'var(--status-ok-bg)' :
                                    t.transaction_bucket === 'deposit' ? 'var(--accent-light)' :
                                    t.transaction_bucket === 'dmm' ? 'var(--status-warn-bg)' : 'var(--surface2)',
                        color: t.transaction_bucket === 'matched' ? 'var(--status-ok)' :
                               t.transaction_bucket === 'deposit' ? 'var(--accent)' :
                               t.transaction_bucket === 'dmm' ? 'var(--status-warn)' : 'var(--text-muted)',
                      }}>
                      {t.transaction_bucket?.toUpperCase() || 'UNKNOWN'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>
                    {t.osprey_mail_drop_id || (t.is_dmm ? 'DMM' : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
