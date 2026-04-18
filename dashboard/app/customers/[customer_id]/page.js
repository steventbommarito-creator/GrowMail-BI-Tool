'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '../../../lib/supabase';
import { effectivePostage } from '../../../lib/postage';
import { exportToCSV } from '../../../lib/export';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ET = (iso) => {
  if (!iso) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Detroit' });
};

export default function CustomerDrillPage() {
  const params = useParams();
  const customerId = decodeURIComponent(params.customer_id || '');
  const supabase = createClient();

  const [drops, setDrops] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [term, setTerm] = useState('Other');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: dropData }, { data: txnData }, { data: termData }] = await Promise.all([
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_id, customer_name, product_category, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, mail_drop_quantity, mail_drop_amount, order_amount, payment_amount_applied, web_id, captured_at')
        .eq('customer_id', customerId)
        .order('drop_est_date', { ascending: false }),
      // Fetch transactions for this customer's drops — we filter client-side since we
      // don't know which drop ids are ours yet until the drops query returns.
      supabase.from('usps_transactions')
        .select('transaction_number, transaction_date, amount, osprey_mail_drop_id, job_description, job_id, is_dmm')
        .not('osprey_mail_drop_id', 'is', null)
        .order('transaction_date', { ascending: false }),
      supabase.from('customer_terms')
        .select('term_label')
        .eq('customer_id', customerId)
        .maybeSingle(),
    ]);

    // Deduplicate drops by mail_drop_id — keep most recent captured_at.
    const seen = new Map();
    for (const d of (dropData || [])) {
      const prev = seen.get(d.mail_drop_id);
      if (!prev || (d.captured_at || '') > (prev.captured_at || '')) seen.set(d.mail_drop_id, d);
    }
    const dedupedDrops = [...seen.values()];
    const dropIds = new Set(dedupedDrops.map(d => d.mail_drop_id));

    // Only keep transactions that map to one of this customer's drops.
    const customerTxns = (txnData || []).filter(t => dropIds.has(t.osprey_mail_drop_id));

    setDrops(dedupedDrops);
    setTransactions(customerTxns);
    setTerm(termData?.term_label || 'Other');
    setLoading(false);
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  // Index EPS txns by drop id so each drop knows whether it's already charged.
  const epsByDropId = useMemo(() => {
    const m = {};
    for (const t of transactions) {
      if (t.osprey_mail_drop_id && !m[t.osprey_mail_drop_id]) m[t.osprey_mail_drop_id] = t;
    }
    return m;
  }, [transactions]);

  const today = new Date().toISOString().split('T')[0];

  // Split drops into "Upcoming / In flight" vs "Completed / Past"
  const { upcoming, completed } = useMemo(() => {
    const up = [], done = [];
    for (const d of drops) {
      const isDone = !!d.drop_act_date || (d.drop_est_date && d.drop_est_date < today && !d.is_live_status);
      if (isDone) done.push(d);
      else up.push(d);
    }
    // Upcoming: soonest first. Completed: most recent first.
    up.sort((a, b) => (a.drop_est_date || '').localeCompare(b.drop_est_date || ''));
    done.sort((a, b) => (b.drop_act_date || b.drop_est_date || '').localeCompare(a.drop_act_date || a.drop_est_date || ''));
    return { upcoming: up, completed: done };
  }, [drops, today]);

  // KPI totals (upcoming only — completed already billed/mailed)
  const totals = useMemo(() => {
    let upcomingPostage = 0, upcomingBilling = 0;
    for (const d of upcoming) {
      const eps = epsByDropId[d.mail_drop_id];
      upcomingPostage += eps ? 0 : effectivePostage(d);
      upcomingBilling += term === 'PrePay'
        ? Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0))
        : (d.mail_drop_amount || 0);
    }
    const lifetimeDrops = drops.length;
    return { upcomingPostage, upcomingBilling, lifetimeDrops };
  }, [upcoming, drops, epsByDropId, term]);

  const customerName = drops[0]?.customer_name || customerId;

  if (loading) return <p style={{ color: 'var(--text-muted)' }} className="p-4">Loading…</p>;
  if (drops.length === 0) {
    return (
      <div className="p-4 space-y-2">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Customer not found</h1>
        <p style={{ color: 'var(--text-muted)' }}>No drops on file for customer_id <span className="font-mono">{customerId}</span>.</p>
        <Link href="/cashflow" className="text-sm" style={{ color: 'var(--accent)' }}>← Back to Cashflow</Link>
      </div>
    );
  }

  const exportCustomerCSV = () => {
    const rows = drops.map(d => {
      const eps = epsByDropId[d.mail_drop_id];
      return {
        'Drop ID': d.mail_drop_id || '',
        'Order ID': d.order_id || '',
        'Web ID': d.web_id || '',
        'Product': d.product_category || '',
        'Sched. Date': d.drop_est_date || '',
        'Actual Date': d.drop_act_date || '',
        'Order Status': d.order_status || '',
        'Drop Status': d.drop_status || '',
        'Postage (effective)': effectivePostage(d).toFixed(2),
        'EPS Transaction': eps?.transaction_number || '',
        'EPS Date': eps?.transaction_date || '',
        'Pieces': d.mail_drop_quantity || 0,
        'Drop Amount': (d.mail_drop_amount || 0).toFixed(2),
      };
    });
    exportToCSV(rows, `customer-${customerId}`);
  };

  return (
    <div className="p-4 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href="/cashflow" style={{ color: 'var(--accent)' }}>Cashflow</Link>
        <span>/</span>
        <span>Customer</span>
        <span>/</span>
        <span className="font-mono">{customerId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{customerName}</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Customer ID <span className="font-mono">{customerId}</span> ·{' '}
            Terms <span className="font-semibold" style={{ color: term === 'PrePay' ? 'var(--accent)' : 'var(--text-secondary)' }}>{term}</span>
            {' '}({term === 'PrePay' ? 'billed via Stripe' : 'billed via NetSuite'})
          </p>
        </div>
        <button onClick={exportCustomerCSV}
          className="text-xs px-3 py-1.5 rounded"
          style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          Export All Drops (CSV)
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Upcoming / In flight', value: upcoming.length },
          { label: 'Upcoming Postage', value: fmt$(totals.upcomingPostage), title: 'Sum of expected postage for upcoming drops. Drops already charged to EPS are excluded.' },
          { label: 'Upcoming Billing', value: fmt$(totals.upcomingBilling), title: term === 'PrePay' ? 'Remaining card balance to charge across upcoming drops.' : 'Total of mail_drop_amount that will be invoiced.' },
          { label: 'Lifetime Drops', value: totals.lifetimeDrops },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" title={k.title}
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Upcoming drops */}
      <DropsTable title={`Upcoming / In flight (${upcoming.length})`} drops={upcoming} epsByDropId={epsByDropId} term={term} emptyLabel="No upcoming drops." />

      {/* Completed drops */}
      <DropsTable title={`Completed / Past (${completed.length})`} drops={completed} epsByDropId={epsByDropId} term={term} emptyLabel="No completed drops yet." dim />
    </div>
  );
}

function DropsTable({ title, drops, epsByDropId, term, emptyLabel, dim = false }) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', opacity: dim ? 0.9 : 1 }}>
      <div className="px-4 py-2" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>{title}</h2>
      </div>
      {drops.length === 0 ? (
        <p className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                {['Drop ID', 'Product', 'Sched.', 'Actual', 'Order Status', 'Drop Status', 'Pieces', 'Postage', 'EPS', 'Billing'].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drops.map((d, i) => {
                const eps = epsByDropId[d.mail_drop_id];
                const postage = effectivePostage(d);
                const billing = term === 'PrePay'
                  ? Math.max(0, (d.order_amount || 0) - (d.payment_amount_applied || 0))
                  : (d.mail_drop_amount || 0);
                return (
                  <tr key={d.mail_drop_id || i} style={{
                    background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                    borderTop: '1px solid var(--border)',
                  }}>
                    <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_id || '—'}</td>
                    <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{d.product_category || '—'}</td>
                    <td className="px-3 py-1.5" style={{ color: 'var(--text-secondary)' }}>{ET(d.drop_est_date)}</td>
                    <td className="px-3 py-1.5" style={{ color: d.drop_act_date ? 'var(--status-ok)' : 'var(--text-muted)' }}>{d.drop_act_date ? ET(d.drop_act_date) : '—'}</td>
                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.order_status || '—'}</td>
                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.drop_status || '—'}</td>
                    <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{d.mail_drop_quantity?.toLocaleString() || '—'}</td>
                    <td className="px-3 py-1.5 font-medium"
                      style={{ color: 'var(--text-primary)', textDecoration: eps ? 'line-through' : 'none', opacity: eps ? 0.45 : 1 }}>
                      {fmt$(postage)}
                    </td>
                    <td className="px-3 py-1.5">
                      {eps ? (
                        <span className="font-mono px-1.5 py-0.5 rounded"
                          title={`Charged to EPS on ${eps.transaction_date}`}
                          style={{ background: 'var(--status-ok-bg)', color: 'var(--status-ok)', border: '1px solid var(--status-ok)', fontSize: '0.7rem' }}>
                          EPS {eps.transaction_number}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-bold" style={{ color: billing > 0 ? 'var(--status-ok)' : 'var(--text-muted)' }}>
                      {billing > 0 ? fmt$(billing) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
