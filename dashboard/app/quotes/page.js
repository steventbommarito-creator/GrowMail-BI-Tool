'use client';

// Custom quotes list. The per-quote workspace (bids, pricing, PDF) comes next;
// for now this shows what's arrived through /intake.

import { useEffect, useState } from 'react';
import { createClient } from '../../lib/supabase';
import { productLabel } from '../../lib/quoteSpecs';

const STATUS_LABELS = {
  new: 'New', rfq_sent: 'Sent to partners', bids_in: 'Bids in', awarded: 'Awarded',
  quote_sent: 'Quote sent', won: 'Won', lost: 'Lost', cancelled: 'Cancelled',
};

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Detroit', month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

export default function QuotesPage() {
  const supabase = createClient();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.from('quote_requests')
      .select('id, quote_code, status, rep_name, customer_name, product_type, quantities, in_home_date, created_at')
      .order('quote_number', { ascending: false })
      .then(({ data, error: err }) => { if (err) setError(err.message); else setRows(data); });
  }, []);

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/intake`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Custom Quotes</h1>
        <button onClick={copyLink} className="px-3 py-2 rounded-lg text-sm font-medium border"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' }}>
          {copied ? 'Copied!' : 'Copy intake form link'}
        </button>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}

      <div className="rounded-xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }} className="text-left">
              {['Quote', 'Status', 'Customer', 'Product', 'Quantities', 'Rep', 'In-home', 'Received'].map(h => (
                <th key={h} className="px-4 py-2 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === null && !error && (
              <tr><td colSpan={8} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>Loading…</td></tr>
            )}
            {rows?.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>No requests yet. Share the intake form link with sales.</td></tr>
            )}
            {rows?.map(r => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
                <td className="px-4 py-2 font-semibold whitespace-nowrap">{r.quote_code}</td>
                <td className="px-4 py-2 whitespace-nowrap">{STATUS_LABELS[r.status] || r.status}</td>
                <td className="px-4 py-2">{r.customer_name}</td>
                <td className="px-4 py-2 whitespace-nowrap">{productLabel(r.product_type)}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.quantities.map(q => q.toLocaleString()).join(' / ')}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.rep_name}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.in_home_date ? fmtDate(`${r.in_home_date}T12:00:00`) : '—'}</td>
                <td className="px-4 py-2 whitespace-nowrap">{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
