'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
  ComposedChart, Line,
} from 'recharts';
import { exportToCSV, exportToPDF } from '../../lib/export';
import { effectivePostage, isEstimatedPostage, isLdpMailMethod } from '../../lib/postage';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => n == null ? '—' : '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
// Date-only strings (YYYY-MM-DD) must use T12:00:00 — new Date('2026-04-13') is UTC midnight
// which becomes April 12 at 8pm Eastern, shifting the displayed date one day back.
const ET = (iso) => {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Detroit' });
};

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
  const [tableViewMode, setTableViewMode] = useState('week'); // 'week' | 'day'
  const [timelineMode, setTimelineMode] = useState('day');    // 'day' | 'week' (for balance runway chart)
  const [expandedWeeks, setExpandedWeeks] = useState({});
  const [expandedDays, setExpandedDays] = useState({});
  const [showAddDeposit, setShowAddDeposit] = useState(false);
  const [newDeposit, setNewDeposit] = useState({ date: '', amount: '', note: '' });
  const [userEmail, setUserEmail] = useState('');
  const [customerTerms, setCustomerTerms] = useState({}); // customer_id → term_label
  const [expandedBillingRows, setExpandedBillingRows] = useState({});
  const [epsDeductedMap, setEpsDeductedMap] = useState({}); // mail_drop_id → transaction_number (already charged to EPS)
  const [activeDrawer, setActiveDrawer] = useState(null);   // null | 'balance' | 'postage' | 'pastdue' | 'deposits' — KPI drilldown drawer

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
      supabase.from('osprey_mail_drops').select('mail_drop_id, order_id, customer_id, customer_name, product_category, fulfillment_path, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, actual_postage, mail_method, mail_drop_amount, production_amount, mail_drop_quantity, payment_amount_applied, order_amount, web_id').in('order_status', ['DAL [SUBMITTED]', 'DIGITAL READY', 'DIGITAL [STAGING]', 'OUTSOURCED', 'OUTSOURCED [STAGING]']).eq('is_live_status', true).lte('drop_est_date', in8w),
      supabase.from('projected_deposits').select('*').eq('is_active', true).order('deposit_date'),
    ]);

    // Deduplicate drops by mail_drop_id — keep last record (most recent sync state)
    const seenDrops = new Map();
    for (const d of (dropData || [])) {
      seenDrops.set(d.mail_drop_id, d);
    }

    // Fetch terms only for customer_ids present in current drops (avoids 1k row limit on full table)
    const uniqueCustomerIds = [...new Set([...seenDrops.values()].map(d => d.customer_id).filter(Boolean))];
    const termsMap = {};
    if (uniqueCustomerIds.length > 0) {
      const { data: termsData } = await supabase
        .from('customer_terms')
        .select('customer_id, term_label')
        .in('customer_id', uniqueCustomerIds);
      for (const t of (termsData || [])) termsMap[t.customer_id] = t.term_label;
    }

    // Build EPS-deducted map from already-fetched transactions
    // Any drop whose mail_drop_id appears in usps_transactions has already been charged —
    // don't deduct it again from the running balance forecast.
    const epsMap = {};
    for (const t of (txns || [])) {
      if (t.osprey_mail_drop_id && !epsMap[t.osprey_mail_drop_id]) {
        epsMap[t.osprey_mail_drop_id] = t.transaction_number;
      }
    }

    // Drop anything with mail_method = "LDP" — those are handled by LDP and
    // don't hit our EPS, so they shouldn't appear anywhere in cashflow views.
    const dropsWithoutLdp = [...seenDrops.values()].filter(d => !isLdpMailMethod(d));

    setTransactions(txns || []);
    setDrops(dropsWithoutLdp);
    setProjectedDeposits(projData || []);
    setCustomerTerms(termsMap);
    setEpsDeductedMap(epsMap);
    setLoading(false);
  }, []);

  // Current EPS balance = last ending_balance in transactions
  const currentBalance = useMemo(() => {
    if (!transactions.length) return 0;
    // Primary sort: date DESC. Secondary: transaction_number DESC (EPS sequential IDs) as tiebreaker
    const sorted = [...transactions].sort((a, b) => {
      const dateDiff = new Date(b.transaction_date) - new Date(a.transaction_date);
      if (dateDiff !== 0) return dateDiff;
      return Number(b.transaction_number) - Number(a.transaction_number);
    });
    return sorted[0]?.ending_balance ?? 0;
  }, [transactions]);

  // LDP Postcard postage: only applies when DAL [SUBMITTED] + OUTSOURCED or PRODUCTION drop status
  // effectivePostage imported from ../../lib/postage — shared across pages

  // Past-due drops: live status AND scheduled date is before today
  const today = new Date().toISOString().split('T')[0];
  const pastDueDrops = useMemo(() =>
    drops.filter(d => d.is_live_status && d.drop_est_date < today && !d.drop_act_date),
    [drops, today]);

  // Running EPS balance by day — used to highlight the day balance runs out
  const dayBalances = useMemo(() => {
    const dayMap = {};

    // Past-due drops → today (skip if already charged to EPS)
    for (const d of pastDueDrops) {
      if (!dayMap[today]) dayMap[today] = { postage: 0, deposits: 0 };
      dayMap[today].postage += epsDeductedMap[d.mail_drop_id] ? 0 : effectivePostage(d);
    }

    // Future drops by est date (skip if already charged to EPS)
    for (const d of drops) {
      if (!d.is_live_status || d.drop_act_date || d.drop_est_date < today) continue;
      const date = d.drop_est_date;
      if (!dayMap[date]) dayMap[date] = { postage: 0, deposits: 0 };
      dayMap[date].postage += epsDeductedMap[d.mail_drop_id] ? 0 : effectivePostage(d);
    }

    // Projected deposits
    for (const p of projectedDeposits) {
      const date = p.deposit_date;
      if (!dayMap[date]) dayMap[date] = { postage: 0, deposits: 0 };
      dayMap[date].deposits += p.amount;
    }

    // Compute running balance in chronological order
    const sorted = Object.keys(dayMap).sort();
    let balance = currentBalance;
    const result = {};
    for (const date of sorted) {
      balance += dayMap[date].deposits - dayMap[date].postage;
      result[date] = {
        runningBalance: +balance.toFixed(2),
        isGap: balance < 0,
        postage: +dayMap[date].postage.toFixed(2),
        deposits: +dayMap[date].deposits.toFixed(2),
      };
    }
    return result;
  }, [drops, pastDueDrops, projectedDeposits, currentBalance, today, epsDeductedMap]);

  // Weekly postage needs (8 weeks forward + past-due rolled into current week)
  const weeklyNeeds = useMemo(() => {
    const weeks = {};
    const currentWeekStart = getWeekStart(today);

    // Past-due drops → current week
    for (const d of pastDueDrops) {
      const w = currentWeekStart;
      if (!weeks[w]) weeks[w] = { week: w, postage: 0, drops: [], pastDue: 0 };
      const rawPostage = effectivePostage(d);
      const p = epsDeductedMap[d.mail_drop_id] ? 0 : rawPostage; // skip if already charged to EPS
      weeks[w].postage += p;
      weeks[w].pastDue += p;
      weeks[w].drops.push({ ...d, _pastDue: true, _effectivePostage: rawPostage, _epsTransactionNumber: epsDeductedMap[d.mail_drop_id] || null });
    }

    // Future drops
    for (const d of drops) {
      if (!d.drop_est_date || d.drop_act_date || (d.drop_est_date < today && d.is_live_status)) continue;
      const w = getWeekStart(d.drop_est_date);
      if (!weeks[w]) weeks[w] = { week: w, postage: 0, drops: [], pastDue: 0 };
      const rawPostage = effectivePostage(d);
      const p = epsDeductedMap[d.mail_drop_id] ? 0 : rawPostage; // skip if already charged to EPS
      weeks[w].postage += p;
      weeks[w].drops.push({ ...d, _effectivePostage: rawPostage, _epsTransactionNumber: epsDeductedMap[d.mail_drop_id] || null });
    }

    return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).slice(0, 8);
  }, [drops, today, pastDueDrops, epsDeductedMap]);

  // EPS balance runway chart — day-by-day for 14 days
  // Day-mode: 14 rolling days. Each point carries post-event balance plus the
  // inflow (deposits) and outflow (postage) on that day for the composed chart.
  // Deposits are positive (green bar up); postage shown as negative so it renders
  // below the axis (red bar down) — this makes cash in/out visually obvious.
  const dailyTimeline = useMemo(() => {
    const data = [];
    let balance = currentBalance;
    for (let i = 0; i <= 14; i++) {
      const date = addDays(today, i);
      const entry = dayBalances[date];
      if (i > 0 && entry) balance = entry.runningBalance;
      data.push({
        key: date,
        label: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
        balance: +balance.toFixed(2),
        deposits: +(entry?.deposits || 0).toFixed(2),
        postage:  -(+(entry?.postage  || 0).toFixed(2)),  // negative so it renders below axis
      });
    }
    return data;
  }, [currentBalance, dayBalances, today]);

  // Week-mode: 8 rolling weeks. We reuse weeklyNeeds for postage and sum
  // projectedDeposits per week. Running balance walks forward one week at a time.
  const weeklyTimeline = useMemo(() => {
    const data = [];
    let balance = currentBalance;
    for (const w of weeklyNeeds) {
      const weekDeposits = projectedDeposits
        .filter(p => getWeekStart(p.deposit_date) === w.week)
        .reduce((s, p) => s + (p.amount || 0), 0);
      balance += weekDeposits - w.postage;
      data.push({
        key: w.week,
        label: weekLabel(w.week),
        balance: +balance.toFixed(2),
        deposits: +weekDeposits.toFixed(2),
        postage:  -(+w.postage.toFixed(2)),
      });
    }
    return data;
  }, [currentBalance, weeklyNeeds, projectedDeposits]);

  const timelineData = timelineMode === 'week' ? weeklyTimeline : dailyTimeline;

  // Accounting weekly table: postage due, expected stripe, expected invoice
  const accountingRows = useMemo(() => {
    let running = currentBalance;

    return weeklyNeeds.map(w => {
      const prepay = w.drops.filter(d => (d.payment_amount_applied || 0) > 0);
      const terms  = w.drops.filter(d => !d.payment_amount_applied || d.payment_amount_applied === 0);

      // Stripe Expected: prepay customers where ~50% deposit was collected at order —
      // remaining balance (order_amount - paid) expected at delivery
      const expectedStripe = prepay.reduce((s, d) => {
        const paid = d.payment_amount_applied || 0;
        const total = d.order_amount || 0;
        const pct = total ? paid / total : 0;
        return s + (pct > 0.4 && pct < 0.7 ? (total - paid) : 0);
      }, 0);

      // Invoice Expected: net-terms customers — full drop amount
      const expectedInvoice = terms.reduce((s, d) => s + (d.mail_drop_amount || 0), 0);

      // Sum ALL projected deposits landing in this week — a week can have more than
      // one (e.g. separate Stripe settlement + FEDWIRE). .find() only returned the
      // first, so weeks with multiple deposits were underreported.
      const projDeposit = projectedDeposits
        .filter(p => getWeekStart(p.deposit_date) === w.week)
        .reduce((s, p) => s + (p.amount || 0), 0);
      running += projDeposit - w.postage;

      return {
        week: weekLabel(w.week),
        weekStart: w.week,
        postageDue: w.postage,
        pastDue: w.pastDue,
        pastDueCount: w.drops.filter(d => d._pastDue).length,
        expectedStripe,
        expectedInvoice,
        totalExpected: expectedStripe + expectedInvoice,
        projDeposit,
        dropCount: w.drops.length,
        drops: w.drops,
        runningBalance: running,
      };
    });
  }, [weeklyNeeds, projectedDeposits, currentBalance]);

  // Flat day rows for day view — all drops grouped by date, chronological
  const dayRows = useMemo(() => {
    const dayMap = {};

    // Late mail → today
    for (const d of pastDueDrops) {
      if (!dayMap[today]) dayMap[today] = { drops: [], isLateMail: true };
      dayMap[today].drops.push({ ...d, _pastDue: true, _effectivePostage: effectivePostage(d), _epsTransactionNumber: epsDeductedMap[d.mail_drop_id] || null });
    }

    // Future drops by est date
    for (const w of weeklyNeeds) {
      for (const d of w.drops) {
        if (d._pastDue) continue;
        const date = d.drop_est_date || 'unknown';
        if (!dayMap[date]) dayMap[date] = { drops: [], isLateMail: false };
        dayMap[date].drops.push({ ...d }); // _effectivePostage + _epsTransactionNumber already set by weeklyNeeds
      }
    }

    return Object.keys(dayMap).sort().map(date => {
      const { drops: dayDrops, isLateMail } = dayMap[date];
      const postage = dayDrops.reduce((s, d) => s + (d._epsTransactionNumber ? 0 : (d._effectivePostage || 0)), 0);
      const deposit = projectedDeposits.filter(p => p.deposit_date === date).reduce((s, p) => s + p.amount, 0);
      const bal = dayBalances[date];
      return { date, drops: dayDrops, postage, deposit, isLateMail, runningBalance: bal?.runningBalance, isGap: bal?.isGap };
    });
  }, [weeklyNeeds, pastDueDrops, projectedDeposits, dayBalances, today, epsDeductedMap]);

  // Payment terms by day — all live drops grouped by date, split by term_label
  const paymentTermsRows = useMemo(() => {
    const dayMap = {};

    const allDrops = [
      ...pastDueDrops.map(d => ({ ...d, _pastDue: true })),
      ...drops.filter(d => d.is_live_status && !d.drop_act_date && d.drop_est_date >= today),
    ];

    for (const d of allDrops) {
      const dateKey = d._pastDue ? 'past-due' : (d.drop_est_date || 'unknown');
      if (!dayMap[dateKey]) dayMap[dateKey] = [];
      const term = customerTerms[d.customer_id] || 'Other';
      const postage = effectivePostage(d);
      const amtDue = Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0));
      dayMap[dateKey].push({ ...d, _term: term, _postage: postage, _amtDue: amtDue });
    }

    const sortedKeys = Object.keys(dayMap).sort((a, b) => {
      if (a === 'past-due') return -1;
      if (b === 'past-due') return 1;
      return a.localeCompare(b);
    });

    return sortedKeys.map(dateKey => {
      const dayDrops = dayMap[dateKey];

      const prepay = dayDrops.filter(d => d._term === 'PrePay');
      const net30  = dayDrops.filter(d => d._term === 'NET30');
      const net45  = dayDrops.filter(d => d._term === 'NET45');
      const other  = dayDrops.filter(d => !['PrePay', 'NET30', 'NET45'].includes(d._term));

      // PrePay: charge the remaining card balance (order total minus deposit already collected)
      const prepayCharge = prepay.reduce((s, d) =>
        s + Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0)), 0);

      // Terms customers: invoice the mail drop amount for this specific drop
      const net30Invoice  = net30.reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
      const net45Invoice  = net45.reduce((s, d) => s + (d.mail_drop_amount || 0), 0);
      const otherInvoice  = other.reduce((s, d) => s + (d.mail_drop_amount || 0), 0);

      const total = prepayCharge + net30Invoice + net45Invoice + otherInvoice;

      return {
        dateKey,
        drops: dayDrops,
        prepayCount: prepay.length,
        net30Count: net30.length,
        net45Count: net45.length,
        otherCount: other.length,
        prepayCharge,
        net30Invoice,
        net45Invoice,
        otherInvoice,
        total,
      };
    });
  }, [drops, pastDueDrops, customerTerms, today]);

  // Flat drop list for the "Postage Needed (8 wks)" drawer — one row per contributing
  // drop, sorted by est date, with EPS-matched drops filtered out so the list matches
  // the KPI number exactly.
  const postageDrilldown = useMemo(() => {
    const rows = [];
    for (const w of weeklyNeeds) {
      for (const d of w.drops) {
        if (epsDeductedMap[d.mail_drop_id]) continue; // already charged
        rows.push({
          ...d,
          _week: w.week,
          _postage: d._effectivePostage ?? effectivePostage(d),
        });
      }
    }
    return rows.sort((a, b) => (a.drop_est_date || '').localeCompare(b.drop_est_date || ''));
  }, [weeklyNeeds, epsDeductedMap]);

  // Recent EPS transactions for the "Current EPS Balance" drawer — newest first,
  // capped at 20 so the drawer stays skimmable.
  const recentTransactions = useMemo(() => {
    return [...transactions]
      .sort((a, b) => {
        const dd = new Date(b.transaction_date) - new Date(a.transaction_date);
        if (dd !== 0) return dd;
        return Number(b.transaction_number) - Number(a.transaction_number);
      })
      .slice(0, 20);
  }, [transactions]);

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

  const exportAccountingCSV = () => {
    exportToCSV(accountingRows.map(r => ({
      'Week': r.week,
      'Postage Due': r.postageDue.toFixed(2),
      'Past-Due Rolled': r.pastDue.toFixed(2),
      'Expected Stripe': r.expectedStripe.toFixed(2),
      'Expected Invoice': r.expectedInvoice.toFixed(2),
      'Total Expected': r.totalExpected.toFixed(2),
      'Projected Deposit': r.projDeposit.toFixed(2),
    })), 'weekly-cashflow');
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
          <button onClick={exportAccountingCSV}
            className="text-sm px-3 py-1.5 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Export CSV
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

      {/* KPI Cards — each one click-opens a right-side drawer with the underlying rows */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { drawerId: 'balance',  label: 'Current EPS Balance', value: fmt$(currentBalance), color: currentBalance < 0 ? 'var(--status-critical)' : 'var(--status-ok)', title: 'USPS Electronic Payment System — the prepaid postage account drops are charged against. Click to see recent transactions.' },
          { drawerId: 'postage',  label: 'Postage Needed (8 wks)', value: fmt$(weeklyNeeds.reduce((s, w) => s + w.postage, 0)), title: 'Sum of expected postage for all upcoming drops in the next 8 weeks. Drops already charged to EPS are excluded. Click to see contributing drops.' },
          { drawerId: 'pastdue',  label: 'Past-Due Liability', value: fmt$(pastDueDrops.reduce((s, d) => s + (epsDeductedMap[d.mail_drop_id] ? 0 : effectivePostage(d)), 0)), sub: `${pastDueDrops.length} drop${pastDueDrops.length === 1 ? '' : 's'}`, color: pastDueDrops.length ? 'var(--status-warn)' : undefined, title: 'Postage owed on drops whose scheduled date has passed but never actually mailed. Drops already charged to EPS are excluded. Click to see each drop.' },
          { drawerId: 'deposits', label: 'Projected Deposits', value: fmt$(projectedDeposits.reduce((s, p) => s + p.amount, 0)), title: 'Total of active projected deposits (Stripe settlements, FEDWIRE, etc.) not yet matched to a real EPS deposit. Click to see each deposit.' },
        ].map(k => (
          <button key={k.label} onClick={() => setActiveDrawer(k.drawerId)} title={k.title}
            className="rounded-xl p-4 border text-left transition-all hover:shadow-md"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)', cursor: 'pointer' }}>
            <p className="text-xs mb-1 flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>{k.label}</span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>↗</span>
            </p>
            <p className="text-xl font-bold" style={{ color: k.color || 'var(--text-primary)' }}>{k.value}</p>
            {k.sub && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{k.sub}</p>}
          </button>
        ))}
      </div>

      {/* Balance Runway Chart — bars for inflow/outflow, line for running balance */}
      <div className="rounded-xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            EPS Balance Runway — {timelineMode === 'week' ? 'Next 8 Weeks' : 'Next 14 Days'}
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--status-ok)' }}></span>
                Deposits
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--status-critical)' }}></span>
                Postage
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-4 h-0.5" style={{ background: 'var(--accent)' }}></span>
                Balance
              </span>
            </div>
            <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {['day', 'week'].map(mode => (
                <button key={mode} onClick={() => setTimelineMode(mode)}
                  className="text-xs px-2 py-0.5 font-medium"
                  style={{
                    background: timelineMode === mode ? 'var(--accent)' : 'var(--surface2)',
                    color: timelineMode === mode ? 'white' : 'var(--text-secondary)',
                  }}>
                  {mode === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={timelineData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <Tooltip
              formatter={(v, name) => [fmt$(Math.abs(v)), name]}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            <ReferenceLine y={0} stroke="var(--text-muted)" />
            <Bar dataKey="deposits" name="Deposits" fill="var(--status-ok)" radius={[2, 2, 0, 0]} />
            <Bar dataKey="postage"  name="Postage"  fill="var(--status-critical)" radius={[0, 0, 2, 2]} />
            <Line type="monotone" dataKey="balance" name="Balance" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          </ComposedChart>
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
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Weekly Accounting View</h2>
            <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {['week', 'day'].map(mode => (
                <button key={mode} onClick={() => setTableViewMode(mode)}
                  className="text-xs px-2 py-0.5 font-medium"
                  style={{
                    background: tableViewMode === mode ? 'var(--accent)' : 'var(--surface2)',
                    color: tableViewMode === mode ? 'var(--accent-text)' : 'var(--text-secondary)',
                  }}>
                  {mode === 'week' ? 'By Week' : 'By Day'}
                </button>
              ))}
            </div>
          </div>
          <button onClick={exportAccountingCSV} className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Export All (CSV)
          </button>
        </div>

        {/* Legend */}
        <div className="px-4 py-2 flex items-center gap-4 text-xs" style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <span className="flex items-center gap-1.5">
            <span style={{ textDecoration: 'line-through', opacity: 0.45, color: 'var(--text-primary)' }}>$123.45</span>
            <span>= already charged to EPS (not re-deducted from running balance)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: 'var(--status-ok-bg)', color: 'var(--status-ok)', border: '1px solid var(--status-ok)', fontSize: '0.7rem' }}>EPS 12345</span>
            <span>= EPS transaction number</span>
          </span>
        </div>

        {/* Column headers */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {['', tableViewMode === 'week' ? 'Week' : 'Date', 'Proj. Deposit', 'Postage Due', 'EPS Balance', 'Stripe Expected', 'Invoice Expected', 'Drops', ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableViewMode === 'day' && dayRows.map((r, i) => {
                const isGap = r.isGap;
                const isExpanded = expandedDays[`day-${r.date}`];
                const prepay = r.drops.filter(d => (d.payment_amount_applied || 0) > 0);
                const terms = r.drops.filter(d => !d.payment_amount_applied || d.payment_amount_applied === 0);
                const expectedStripe = prepay.reduce((s, d) => {
                  const paid = d.payment_amount_applied || 0;
                  const total = d.order_amount || 0;
                  const pct = total ? paid / total : 0;
                  return s + (pct > 0.4 && pct < 0.7 ? (total - paid) : 0);
                }, 0);
                const expectedInvoice = terms.reduce((s, d) => s + (d.mail_drop_amount || 0), 0);

                return [
                  <tr key={r.date}
                    onClick={() => setExpandedDays(s => ({ ...s, [`day-${r.date}`]: !s[`day-${r.date}`] }))}
                    className="cursor-pointer"
                    style={{
                      background: isGap ? 'var(--status-critical-bg)' :
                                  r.isLateMail ? 'var(--status-warn-bg)' :
                                  i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                      borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                    }}>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-muted)', width: 24 }}>
                      {isExpanded ? '▼' : '▶'}
                    </td>
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: r.isLateMail ? 'var(--status-warn)' : 'var(--text-primary)' }}>
                      {r.isLateMail ? `⚠ Late Mail · ${dayLabel(r.date)}` : dayLabel(r.date)}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: r.deposit > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {r.deposit > 0 ? fmt$(r.deposit) : '—'}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: isGap ? 'var(--status-critical)' : 'var(--text-primary)' }}>{fmt$(r.postage)}</td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: r.runningBalance == null ? 'var(--text-muted)' : isGap ? 'var(--status-critical)' : 'var(--status-ok)' }}>
                      {r.runningBalance != null ? fmt$(r.runningBalance) : '—'}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--status-ok)' }}>{expectedStripe > 0 ? fmt$(expectedStripe) : '—'}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>{expectedInvoice > 0 ? fmt$(expectedInvoice) : '—'}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.drops.length}</td>
                    <td className="px-3 py-2.5" />
                  </tr>,

                  isExpanded && (
                    <tr key={`day-${r.date}-exp`}>
                      <td colSpan={9} style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)', padding: 0 }}>
                        <div className="px-8 py-2">
                          <table className="w-full text-xs">
                            <thead style={{ background: 'var(--surface)' }}>
                              <tr>
                                {['Customer', 'Product', 'Drop ID', 'Status', r.isLateMail ? 'Sched. Date' : null, 'Postage', 'Pieces', 'Flag'].filter(Boolean).map(h => (
                                  <th key={h} className="text-left px-3 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {r.drops.map((d, di) => (
                                <tr key={d.mail_drop_id || di} style={{
                                  background: di % 2 === 0 ? 'transparent' : 'var(--surface)',
                                  borderTop: '1px solid var(--border)',
                                }}>
                                  <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                                  <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_id || '—'}</td>
                                  <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.drop_status || '—'}</td>
                                  {r.isLateMail && (
                                    <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--status-warn)' }}>
                                      {d.drop_est_date || '—'}
                                    </td>
                                  )}
                                  <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)', textDecoration: d._epsTransactionNumber ? 'line-through' : 'none', opacity: d._epsTransactionNumber ? 0.45 : 1 }}>{fmt$(d._effectivePostage ?? d.postage_amount)}{isEstimatedPostage(d) && (d._effectivePostage ?? d.postage_amount) > 0 && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(est)</span>}</td>
                                  <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_quantity?.toLocaleString() || '—'}</td>
                                  <td className="px-3 py-1.5" style={{ whiteSpace: 'nowrap' }}>
                                    {d._pastDue && <span className="font-medium mr-1" style={{ color: 'var(--status-warn)' }}>PAST DUE</span>}
                                    {d._epsTransactionNumber && <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--status-ok-bg)', color: 'var(--status-ok)', border: '1px solid var(--status-ok)' }}>EPS {d._epsTransactionNumber}</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
              {tableViewMode === 'week' && accountingRows.map((r, i) => {
                const isGap = r.runningBalance != null && r.runningBalance < 0;
                const isExpanded = expandedWeeks[r.weekStart];
                const rowDrops = r.drops || [];

                // Group drops by day
                const byDay = {};
                for (const d of rowDrops) {
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

                const exportWeekCSV = () => {
                  const rows = [];
                  for (const d of rowDrops) {
                    const postage = d._effectivePostage ?? effectivePostage(d);
                    rows.push({
                      'Web ID': d.web_id || '',
                      'Customer': d.customer_name || '',
                      'Product': d.product_category || '',
                      'Drop ID': d.mail_drop_id || '',
                      'Order ID': d.order_id || '',
                      'Sched. Date': d.drop_est_date || '',
                      'Order Status': d.order_status || '',
                      'Drop Status': d.drop_status || '',
                      'Postage': postage.toFixed(2),
                      'Pieces': d.mail_drop_quantity || 0,
                      'Past-Due': d._pastDue ? 'Yes' : 'No',
                      'EPS Transaction': '',
                    });
                    if (d._epsTransactionNumber) {
                      rows.push({
                        'Web ID': d.web_id || '',
                        'Customer': d.customer_name || '',
                        'Product': d.product_category || '',
                        'Drop ID': d.mail_drop_id || '',
                        'Order ID': d.order_id || '',
                        'Sched. Date': d.drop_est_date || '',
                        'Order Status': d.order_status || '',
                        'Drop Status': d.drop_status || '',
                        'Postage': (-postage).toFixed(2),
                        'Pieces': d.mail_drop_quantity || 0,
                        'Past-Due': d._pastDue ? 'Yes' : 'No',
                        'EPS Transaction': d._epsTransactionNumber,
                      });
                    }
                  }
                  exportToCSV(rows, `week-${r.weekStart}`);
                };

                return [
                  // Main week row
                  <tr key={r.weekStart}
                    onClick={() => setExpandedWeeks(s => ({ ...s, [r.weekStart]: !s[r.weekStart] }))}
                    className="cursor-pointer"
                    style={{
                      background: isGap ? 'var(--status-critical-bg)' : i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                      borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                    }}>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-muted)', width: 24 }}>
                      {isExpanded ? '▼' : '▶'}
                    </td>
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      <span>{weekRangeLabel(r.weekStart)}</span>
                      {r.pastDueCount > 0 && (
                        <span className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--status-warn-bg)', color: 'var(--status-warn)', border: '1px solid var(--status-warn)', verticalAlign: 'middle' }}>
                          ⚠ {r.pastDueCount} late
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: r.projDeposit > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {r.projDeposit > 0 ? fmt$(r.projDeposit) : '—'}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: isGap ? 'var(--status-critical)' : 'var(--text-primary)' }}>{fmt$(r.postageDue)}</td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: isGap ? 'var(--status-critical)' : 'var(--status-ok)' }}>{fmt$(r.runningBalance)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--status-ok)' }}>{fmt$(r.expectedStripe)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>{fmt$(r.expectedInvoice)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.dropCount}</td>
                    <td className="px-3 py-2.5">
                      <button onClick={e => { e.stopPropagation(); exportWeekCSV(); }}
                        className="text-xs px-2 py-0.5 rounded whitespace-nowrap"
                        style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                        Export CSV
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
                            // Use effectivePostage (handles LDP) and zero out EPS-deducted drops so the
                            // day subtotal matches the row-level strikethroughs below it.
                            const dayPostage = dayDrops.reduce((s, d) => s + (d._epsTransactionNumber ? 0 : (d._effectivePostage ?? effectivePostage(d))), 0);
                            const isDayExpanded = expandedDays[`${r.weekStart}-${dayKey}`];
                            const label = dayKey === 'past-due' ? '⚠ Late Mail (rolled forward)' : dayLabel(dayKey);
                            const dayDeposit = dayKey !== 'past-due'
                              ? projectedDeposits.filter(p => p.deposit_date === dayKey).reduce((s, p) => s + p.amount, 0)
                              : 0;
                            const balanceKey = dayKey === 'past-due' ? today : dayKey;
                            const dayBal = dayBalances[balanceKey];
                            const dayIsGap = dayBal?.isGap;

                            const exportDayCSV = () => {
                              const rows = [];
                              for (const d of dayDrops) {
                                const postage = d._effectivePostage ?? effectivePostage(d);
                                rows.push({
                                  'Web ID': d.web_id || '',
                                  'Customer': d.customer_name || '',
                                  'Product': d.product_category || '',
                                  'Drop ID': d.mail_drop_id || '',
                                  'Order ID': d.order_id || '',
                                  'Sched. Date': d.drop_est_date || '',
                                  'Order Status': d.order_status || '',
                                  'Drop Status': d.drop_status || '',
                                  'Postage': postage.toFixed(2),
                                  'Pieces': d.mail_drop_quantity || 0,
                                  'EPS Transaction': '',
                                });
                                if (d._epsTransactionNumber) {
                                  rows.push({
                                    'Web ID': d.web_id || '',
                                    'Customer': d.customer_name || '',
                                    'Product': d.product_category || '',
                                    'Drop ID': d.mail_drop_id || '',
                                    'Order ID': d.order_id || '',
                                    'Sched. Date': d.drop_est_date || '',
                                    'Order Status': d.order_status || '',
                                    'Drop Status': d.drop_status || '',
                                    'Postage': (-postage).toFixed(2),
                                    'Pieces': d.mail_drop_quantity || 0,
                                    'EPS Transaction': d._epsTransactionNumber,
                                  });
                                }
                              }
                              exportToCSV(rows, `drops-${dayKey}`);
                            };

                            return (
                              <div key={dayKey} className="rounded border overflow-hidden"
                                style={{ borderColor: dayIsGap ? 'var(--status-critical)' : 'var(--border)', background: dayIsGap ? 'var(--status-critical-bg)' : 'var(--surface)' }}>
                                {/* Day header */}
                                <div className="flex items-center justify-between px-3 py-2 cursor-pointer"
                                  onClick={() => setExpandedDays(s => ({ ...s, [`${r.weekStart}-${dayKey}`]: !s[`${r.weekStart}-${dayKey}`] }))}
                                  style={{ borderBottom: isDayExpanded ? '1px solid var(--border)' : 'none' }}>
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isDayExpanded ? '▼' : '▶'}</span>
                                    <span className="text-sm font-medium" style={{ color: dayIsGap ? 'var(--status-critical)' : dayKey === 'past-due' ? 'var(--status-warn)' : 'var(--text-primary)' }}>
                                      {label}
                                    </span>
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                      {dayDrops.length} drop{dayDrops.length !== 1 ? 's' : ''} · {fmt$(dayPostage)}
                                    </span>
                                    {dayBal && (
                                      <span className="text-xs font-medium px-2 py-0.5 rounded"
                                        style={{ background: dayIsGap ? 'var(--status-critical-bg)' : 'var(--surface2)', color: dayIsGap ? 'var(--status-critical)' : 'var(--text-muted)', border: '1px solid var(--border)' }}>
                                        EPS after: {fmt$(dayBal.runningBalance)}
                                      </span>
                                    )}
                                    {dayDeposit > 0 && (
                                      <span className="text-xs font-medium px-2 py-0.5 rounded"
                                        style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>
                                        Expected Deposit: {fmt$(dayDeposit)}
                                      </span>
                                    )}
                                  </div>
                                  <button onClick={e => { e.stopPropagation(); exportDayCSV(); }}
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                    Export CSV
                                  </button>
                                </div>

                                {/* Day drops table */}
                                {isDayExpanded && (
                                  <table className="w-full text-xs">
                                    <thead style={{ background: 'var(--surface2)' }}>
                                      <tr>
                                        {['Customer', 'Product', 'Drop ID', 'Status', dayKey === 'past-due' ? 'Sched. Date' : null, 'Postage', 'Pieces', 'Flag'].filter(Boolean).map(h => (
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
                                          {dayKey === 'past-due' && (
                                            <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--status-warn)' }}>
                                              {ET(d.drop_est_date) || '—'}
                                            </td>
                                          )}
                                          <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)', textDecoration: d._epsTransactionNumber ? 'line-through' : 'none', opacity: d._epsTransactionNumber ? 0.45 : 1 }}>{fmt$(d._effectivePostage ?? d.postage_amount)}{isEstimatedPostage(d) && (d._effectivePostage ?? d.postage_amount) > 0 && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(est)</span>}</td>
                                          <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_quantity?.toLocaleString() || '—'}</td>
                                          <td className="px-3 py-1.5" style={{ whiteSpace: 'nowrap' }}>
                                            {d._pastDue && <span className="font-medium mr-1" style={{ color: 'var(--status-warn)' }}>PAST DUE</span>}
                                            {d._epsTransactionNumber && <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--status-ok-bg)', color: 'var(--status-ok)', border: '1px solid var(--status-ok)' }}>EPS {d._epsTransactionNumber}</span>}
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

      {/* Billing Forecast by Day */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Billing Forecast by Day
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--accent)' }}>PrePay → Stripe</span> (charged on/around drop date) ·{' '}
              <span style={{ color: 'var(--text-secondary)' }}>NET30 / NET45 / Other → NetSuite invoice</span>{' '}
              (collection est. = drop date + term days)
            </p>
          </div>
          <button
            onClick={() => {
              // Drop-level export: one row per drop with bill via + est collection so the
              // user can feed it straight into AR tooling or cross-check NetSuite.
              const rows = [];
              for (const r of paymentTermsRows) {
                for (const d of r.drops) {
                  const billingAmt = d._term === 'PrePay'
                    ? Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0))
                    : (d.mail_drop_amount || 0);
                  const billVia = d._term === 'PrePay' ? 'Stripe' : 'NetSuite';
                  const lag = d._term === 'NET30' ? 30 : d._term === 'NET45' ? 45 : d._term === 'PrePay' ? 0 : 30;
                  const estCollection = d.drop_est_date ? addDays(d.drop_est_date, lag) : '';
                  rows.push({
                    'Date': r.dateKey === 'past-due' ? 'Past Due' : r.dateKey,
                    'Customer': d.customer_name || '',
                    'Web ID': d.web_id || '',
                    'Drop ID': d.mail_drop_id || '',
                    'Product': d.product_category || '',
                    'Terms': d._term || '',
                    'Bill Via': billVia,
                    'Est Invoice Date': d.drop_est_date || '',
                    'Est Collection Date': estCollection,
                    'Amount': billingAmt.toFixed(2),
                  });
                }
              }
              exportToCSV(rows, 'billing-forecast');
            }}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            Export CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {[
                  { label: '', sub: null },
                  { label: 'Date', sub: null },
                  { label: 'Drops', sub: null },
                  { label: 'PrePay', sub: 'charge card' },
                  { label: 'NET30', sub: 'invoice' },
                  { label: 'NET45', sub: 'invoice' },
                  { label: 'Other Terms', sub: 'invoice' },
                  { label: 'Total', sub: null },
                ].map(h => (
                  <th key={h.label} className="text-left px-3 py-2 text-xs font-semibold whitespace-nowrap"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                    {h.label}
                    {h.sub && <span className="block text-xs font-normal" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{h.sub}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paymentTermsRows.map((r, i) => {
                const isPastDue = r.dateKey === 'past-due';
                const isExpanded = expandedBillingRows[r.dateKey];
                const rowBg = isPastDue ? 'var(--status-warn-bg)' : i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)';
                return [
                  <tr key={r.dateKey}
                    onClick={() => setExpandedBillingRows(s => ({ ...s, [r.dateKey]: !s[r.dateKey] }))}
                    className="cursor-pointer"
                    style={{
                      background: rowBg,
                      borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                      borderLeft: isPastDue ? '3px solid var(--status-warn)' : undefined,
                    }}>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-muted)', width: 24 }}>
                      {isExpanded ? '▼' : '▶'}
                    </td>
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap"
                      style={{ color: isPastDue ? 'var(--status-warn)' : 'var(--text-primary)' }}>
                      {isPastDue ? `⚠ Past Due (${r.drops.length} drops)` : dayLabel(r.dateKey)}
                    </td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>{r.drops.length}</td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: r.prepayCharge > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {r.prepayCharge > 0 ? fmt$(r.prepayCharge) : '—'}
                      {r.prepayCount > 0 && <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({r.prepayCount})</span>}
                    </td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: r.net30Invoice > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {r.net30Invoice > 0 ? fmt$(r.net30Invoice) : '—'}
                      {r.net30Count > 0 && <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({r.net30Count})</span>}
                    </td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: r.net45Invoice > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {r.net45Invoice > 0 ? fmt$(r.net45Invoice) : '—'}
                      {r.net45Count > 0 && <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({r.net45Count})</span>}
                    </td>
                    <td className="px-3 py-2.5 font-medium" style={{ color: r.otherInvoice > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                      {r.otherInvoice > 0 ? fmt$(r.otherInvoice) : '—'}
                      {r.otherCount > 0 && <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({r.otherCount})</span>}
                    </td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: r.total > 0 ? 'var(--status-ok)' : 'var(--text-muted)' }}>
                      {r.total > 0 ? fmt$(r.total) : '—'}
                    </td>
                  </tr>,

                  isExpanded && (
                    <tr key={`${r.dateKey}-expanded`}>
                      <td colSpan={8} style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)', padding: 0 }}>
                        <div className="px-8 py-2">
                          <table className="w-full text-xs">
                            <thead>
                              <tr style={{ background: 'var(--surface)' }}>
                                {['Customer', 'Web ID', 'Drop ID', 'Product', 'Terms', 'Bill Via', 'Sched. Date', 'Est Collection', 'Drop Status', 'Amount'].map(h => (
                                  <th key={h} className="text-left px-3 py-1.5 font-semibold"
                                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {r.drops.map((d, di) => {
                                const billingAmt = d._term === 'PrePay'
                                  ? Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0))
                                  : (d.mail_drop_amount || 0);
                                const billVia = d._term === 'PrePay' ? 'Stripe' : 'NetSuite';
                                // Collection lag: PrePay charges immediately, NET30/45 per their term;
                                // Other is estimated at NET30 and flagged with a "?" so it's obvious.
                                const collectionLag = d._term === 'NET30' ? 30
                                                    : d._term === 'NET45' ? 45
                                                    : d._term === 'PrePay' ? 0
                                                    : 30;
                                const collectionEstimated = !['PrePay', 'NET30', 'NET45'].includes(d._term);
                                const estCollection = d.drop_est_date ? addDays(d.drop_est_date, collectionLag) : null;
                                return (
                                  <tr key={d.mail_drop_id || di} style={{
                                    background: di % 2 === 0 ? 'transparent' : 'var(--surface)',
                                    borderTop: '1px solid var(--border)',
                                  }}>
                                    <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.web_id || '—'}</td>
                                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_id || '—'}</td>
                                    <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                                    <td className="px-3 py-1.5">
                                      <span className="px-1.5 py-0.5 rounded font-semibold"
                                        style={{
                                          fontSize: '0.65rem',
                                          background: d._term === 'PrePay' ? 'var(--accent-light)' : 'var(--surface2)',
                                          color: d._term === 'PrePay' ? 'var(--accent)' : 'var(--text-secondary)',
                                          border: '1px solid var(--border)',
                                        }}>
                                        {d._term}
                                      </span>
                                    </td>
                                    <td className="px-3 py-1.5" style={{ color: billVia === 'Stripe' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                      {billVia}
                                    </td>
                                    <td className="px-3 py-1.5" style={{ color: d._pastDue ? 'var(--status-warn)' : 'var(--text-secondary)' }}>
                                      {d.drop_est_date ? ET(d.drop_est_date) : '—'}
                                      {d._pastDue && <span className="ml-1" style={{ color: 'var(--status-warn)' }}>⚠</span>}
                                    </td>
                                    <td className="px-3 py-1.5"
                                      title={collectionEstimated ? 'Assumed NET30 — confirm actual terms' : undefined}
                                      style={{ color: collectionEstimated ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                                      {estCollection ? ET(estCollection) : '—'}
                                      {collectionEstimated && estCollection && <span className="ml-1" style={{ color: 'var(--text-muted)' }}>?</span>}
                                    </td>
                                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.drop_status || '—'}</td>
                                    <td className="px-3 py-1.5 font-bold" style={{ color: billingAmt > 0 ? 'var(--status-ok)' : 'var(--text-muted)' }}>
                                      {billingAmt > 0 ? fmt$(billingAmt) : '—'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
              {/* Totals row */}
              {paymentTermsRows.length > 0 && (() => {
                const totals = paymentTermsRows.reduce((acc, r) => ({
                  drops: acc.drops + r.drops.length,
                  prepayCharge: acc.prepayCharge + r.prepayCharge,
                  net30Invoice: acc.net30Invoice + r.net30Invoice,
                  net45Invoice: acc.net45Invoice + r.net45Invoice,
                  otherInvoice: acc.otherInvoice + r.otherInvoice,
                  total: acc.total + r.total,
                }), { drops: 0, prepayCharge: 0, net30Invoice: 0, net45Invoice: 0, otherInvoice: 0, total: 0 });
                return (
                  <tr style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5 text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>TOTALS</td>
                    <td className="px-3 py-2.5 font-semibold" style={{ color: 'var(--text-secondary)' }}>{totals.drops}</td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(totals.prepayCharge)}</td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(totals.net30Invoice)}</td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: 'var(--text-primary)' }}>{fmt$(totals.net45Invoice)}</td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: 'var(--text-secondary)' }}>{fmt$(totals.otherInvoice)}</td>
                    <td className="px-3 py-2.5 font-bold" style={{ color: 'var(--status-ok)' }}>{fmt$(totals.total)}</td>
                  </tr>
                );
              })()}
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
              {[...transactions].sort((a, b) => {
                const dd = new Date(b.transaction_date) - new Date(a.transaction_date);
                if (dd !== 0) return dd;
                return Number(b.transaction_number) - Number(a.transaction_number);
              }).slice(0, 30).map((t, i) => (
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

      {/* KPI Drilldown Drawer — slides in from the right, shows rows backing the clicked KPI.
          Click outside (the dark backdrop) or the × button to close. */}
      {activeDrawer && (
        <div className="fixed inset-0 z-40" onClick={() => setActiveDrawer(null)}
          style={{ background: 'rgba(0,0,0,0.35)' }}>
          <div onClick={(e) => e.stopPropagation()}
            className="fixed top-0 right-0 h-full w-full md:w-[640px] overflow-y-auto shadow-2xl"
            style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
            <div className="px-5 py-4 flex items-center justify-between sticky top-0 z-10"
              style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              <div>
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {activeDrawer === 'balance'  && 'Recent EPS Transactions'}
                  {activeDrawer === 'postage'  && 'Upcoming Drops (Next 8 Weeks)'}
                  {activeDrawer === 'pastdue'  && 'Past-Due Drops'}
                  {activeDrawer === 'deposits' && 'Projected Deposits'}
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {activeDrawer === 'balance'  && `Last ${recentTransactions.length} USPS transactions, newest first`}
                  {activeDrawer === 'postage'  && `${postageDrilldown.length} drop${postageDrilldown.length === 1 ? '' : 's'} contributing to the total`}
                  {activeDrawer === 'pastdue'  && `${pastDueDrops.length} drop${pastDueDrops.length === 1 ? '' : 's'} scheduled before today without an actual drop date`}
                  {activeDrawer === 'deposits' && `${projectedDeposits.length} active projected deposit${projectedDeposits.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <button onClick={() => setActiveDrawer(null)}
                className="text-lg px-2 py-0.5 rounded"
                style={{ color: 'var(--text-muted)', background: 'var(--surface2)' }}>×</button>
            </div>

            <div className="p-5">
              {/* EPS Balance → recent transactions */}
              {activeDrawer === 'balance' && (
                <table className="w-full text-xs">
                  <thead style={{ color: 'var(--text-muted)' }}>
                    <tr>
                      <th className="text-left py-1.5">Date</th>
                      <th className="text-left py-1.5">Bucket</th>
                      <th className="text-right py-1.5">Amount</th>
                      <th className="text-right py-1.5">Balance</th>
                      <th className="text-left py-1.5 pl-2">Drop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTransactions.map(t => (
                      <tr key={t.transaction_number} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(t.transaction_date)}</td>
                        <td className="py-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded"
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
                        <td className="text-right py-1.5" style={{ color: Number(t.amount) >= 0 ? 'var(--status-ok)' : 'var(--status-critical)' }}>
                          {fmt$(t.amount)}
                        </td>
                        <td className="text-right py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>{fmt$(t.ending_balance)}</td>
                        <td className="py-1.5 pl-2" style={{ color: 'var(--text-muted)' }}>
                          {t.osprey_mail_drop_id || (t.is_dmm ? 'DMM' : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Postage Needed → upcoming drops */}
              {activeDrawer === 'postage' && (
                <table className="w-full text-xs">
                  <thead style={{ color: 'var(--text-muted)' }}>
                    <tr>
                      <th className="text-left py-1.5">Est Date</th>
                      <th className="text-left py-1.5">Customer</th>
                      <th className="text-left py-1.5">Product</th>
                      <th className="text-right py-1.5">Qty</th>
                      <th className="text-right py-1.5">Postage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {postageDrilldown.map(d => (
                      <tr key={d.mail_drop_id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.drop_est_date || '—'}</td>
                        <td className="py-1.5" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                        <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                        <td className="text-right py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_quantity?.toLocaleString() || '—'}</td>
                        <td className="text-right py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>
                          {fmt$(d._postage)}
                          {isEstimatedPostage(d) && d._postage > 0 && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(est)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Past-Due → each overdue drop */}
              {activeDrawer === 'pastdue' && (
                pastDueDrops.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No past-due drops. 🎉</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead style={{ color: 'var(--text-muted)' }}>
                      <tr>
                        <th className="text-left py-1.5">Est Date</th>
                        <th className="text-left py-1.5">Days Late</th>
                        <th className="text-left py-1.5">Customer</th>
                        <th className="text-left py-1.5">Product</th>
                        <th className="text-right py-1.5">Postage</th>
                        <th className="text-left py-1.5 pl-2">EPS?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...pastDueDrops]
                        .sort((a, b) => (a.drop_est_date || '').localeCompare(b.drop_est_date || ''))
                        .map(d => {
                          const daysLate = Math.floor((new Date(today + 'T12:00:00') - new Date((d.drop_est_date || today) + 'T12:00:00')) / 86400000);
                          const matched = !!epsDeductedMap[d.mail_drop_id];
                          return (
                            <tr key={d.mail_drop_id} style={{ borderTop: '1px solid var(--border)' }}>
                              <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.drop_est_date || '—'}</td>
                              <td className="py-1.5" style={{ color: daysLate > 7 ? 'var(--status-critical)' : 'var(--status-warn)' }}>{daysLate}d</td>
                              <td className="py-1.5" style={{ color: 'var(--text-primary)' }}>{d.customer_name || '—'}</td>
                              <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                              <td className="text-right py-1.5 font-medium"
                                style={{ color: matched ? 'var(--text-muted)' : 'var(--text-primary)',
                                         textDecoration: matched ? 'line-through' : 'none' }}>
                                {fmt$(effectivePostage(d))}
                                {isEstimatedPostage(d) && effectivePostage(d) > 0 && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(est)</span>}
                              </td>
                              <td className="py-1.5 pl-2 text-[10px]" style={{ color: matched ? 'var(--status-ok)' : 'var(--text-muted)' }}>
                                {matched ? `✓ #${epsDeductedMap[d.mail_drop_id]}` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                )
              )}

              {/* Projected Deposits → each scheduled deposit */}
              {activeDrawer === 'deposits' && (
                projectedDeposits.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No projected deposits.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead style={{ color: 'var(--text-muted)' }}>
                      <tr>
                        <th className="text-left py-1.5">Date</th>
                        <th className="text-right py-1.5">Amount</th>
                        <th className="text-left py-1.5 pl-2">Note</th>
                        <th className="text-left py-1.5 pl-2">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projectedDeposits.map(p => (
                        <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(p.deposit_date)}</td>
                          <td className="text-right py-1.5 font-medium" style={{ color: 'var(--status-ok)' }}>{fmt$(p.amount)}</td>
                          <td className="py-1.5 pl-2" style={{ color: 'var(--text-muted)' }}>{p.note || '—'}</td>
                          <td className="py-1.5 pl-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{p.created_by || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
