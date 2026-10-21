'use client';

// Invoicing Report — drops marked complete for customers on terms (anything
// but PrePay), so they can be invoiced in NetSuite. LDP drops are included on
// purpose (they're excluded elsewhere only because they don't hit our EPS).
// A customer with no customer_terms row counts as PrePay and is left out.
// Invoice number = order number-drop number.

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '../../lib/supabase';

const fmtDate = (d) => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';
const fmtMoney = (n) => (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function fetchAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

export default function InvoicingPage() {
  const supabase = createClient();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // drop_status casing is mixed: COMPLETE, complete, complete_tax_*.
        const drops = await fetchAll(() => supabase
          .from('osprey_mail_drops')
          .select('customer_id, customer_name, order_id, mail_drop_id, drop_number, drop_act_date, mail_drop_amount, mail_method')
          .ilike('drop_status', 'complete%')
          .order('mail_drop_id'));

        const ids = [...new Set(drops.map(d => d.customer_id).filter(Boolean))];
        const terms = {};
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error: err } = await supabase.from('customer_terms')
            .select('customer_id, term_label').in('customer_id', ids.slice(i, i + 200));
          if (err) throw err;
          for (const t of data) terms[t.customer_id] = t.term_label;
        }

        setRows(drops
          .map(d => ({ ...d, term: terms[d.customer_id] || 'PrePay', invoice: `${d.order_id}-${d.drop_number}` }))
          .filter(d => d.term !== 'PrePay')
          .sort((a, b) => (b.drop_act_date || '').localeCompare(a.drop_act_date || '') || a.invoice.localeCompare(b.invoice)));
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!fromDate || (r.drop_act_date || '') >= fromDate) &&
      (!toDate || (r.drop_act_date || '') <= toDate) &&
      (!q || [r.customer_name, r.order_id, r.invoice].some(v => String(v || '').toLowerCase().includes(q))));
  }, [rows, search, fromDate, toDate]);

  function handleExport() {
    const header = ['Client', 'Terms', 'Order Number', 'Drop Number', 'Invoice Number', 'Actual Mail Date', 'Drop Amount'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map(r => [r.customer_name?.trim(), r.term, r.order_id, r.drop_number, r.invoice, r.drop_act_date, r.mail_drop_amount].map(esc).join(','));
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `invoicing-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const total = shown?.reduce((s, r) => s + (r.mail_drop_amount || 0), 0) || 0;
  const inputStyle = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Invoicing Report</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Completed drops for clients on terms (not PrePay), including LDP.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search client, order, invoice"
            className="px-3 py-2 rounded-lg border" style={inputStyle} />
          <label style={{ color: 'var(--text-muted)' }}>Mailed</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="px-2 py-2 rounded-lg border" style={inputStyle} />
          <span style={{ color: 'var(--text-muted)' }}>to</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="px-2 py-2 rounded-lg border" style={inputStyle} />
          <button onClick={handleExport} disabled={!shown?.length} className="px-3 py-2 rounded-lg font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: shown?.length ? 1 : 0.5 }}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}

      {shown && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {shown.length.toLocaleString()} drops · {fmtMoney(total)}
        </p>
      )}

      <div className="rounded-xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }} className="text-left">
              {['Client', 'Terms', 'Order Number', 'Drop Number', 'Invoice Number', 'Actual Mail Date', 'Drop Amount'].map(h => (
                <th key={h} className={`px-4 py-2 font-medium whitespace-nowrap ${h === 'Drop Amount' ? 'text-right' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown === null && !error && (
              <tr><td colSpan={7} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>Loading…</td></tr>
            )}
            {shown?.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>No completed drops to invoice.</td></tr>
            )}
            {shown?.map(r => (
              <tr key={r.mail_drop_id} className="border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
                <td className="px-4 py-2">
                  {r.customer_name}
                  {/ldp/i.test(r.mail_method || '') && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-muted)' }}>LDP</span>
                  )}
                </td>
                <td className="px-4 py-2 whitespace-nowrap">{r.term}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.order_id}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.drop_number}</td>
                <td className="px-4 py-2 font-semibold whitespace-nowrap">{r.invoice}</td>
                <td className="px-4 py-2 whitespace-nowrap">{fmtDate(r.drop_act_date)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right">{fmtMoney(r.mail_drop_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
