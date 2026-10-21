'use client';

// Invoicing Report — drops marked complete for customers on terms (anything
// but PrePay), so they can be invoiced. LDP drops are included on purpose
// (they're excluded elsewhere only because they don't hit our EPS).
// A customer with no customer_terms row counts as PrePay and is left out.
// Invoice number = order number-drop number.
//
// Each drop can be marked "Invoiced in QuickBooks" (qb_invoiced_drops, one row
// per drop; unmarking flips is_invoiced off). Every mark/unmark is logged to
// notifications so it shows in the activity feed.

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '../../lib/supabase';

const fmtDate = (d) => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';
const fmtStamp = (iso) => iso
  ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Detroit', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—';

const VIEWS = [
  { key: 'open', label: 'To invoice' },
  { key: 'invoiced', label: 'Invoiced in QB' },
  { key: 'all', label: 'All' },
];

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
  const [invoiced, setInvoiced] = useState(new Map()); // mail_drop_id → { invoiced_by, invoiced_at }
  const [userEmail, setUserEmail] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState('open');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [busy, setBusy] = useState(null);              // mail_drop_id currently saving

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data?.user?.email || ''));
    (async () => {
      try {
        // drop_status casing is mixed: COMPLETE, complete, complete_tax_*.
        const drops = await fetchAll(() => supabase
          .from('osprey_mail_drops')
          .select('customer_id, customer_name, order_id, mail_drop_id, drop_number, drop_act_date, mail_method')
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

        const qb = await fetchAll(() => supabase
          .from('qb_invoiced_drops')
          .select('mail_drop_id, invoiced_by, invoiced_at')
          .eq('is_invoiced', true)
          .order('mail_drop_id'));
        setInvoiced(new Map(qb.map(q => [q.mail_drop_id, { invoiced_by: q.invoiced_by, invoiced_at: q.invoiced_at }])));

        setRows(drops
          .map(d => ({ ...d, term: terms[d.customer_id] || 'PrePay', invoice: `${d.order_id}-${d.drop_number}` }))
          .filter(d => d.term !== 'PrePay')
          .sort((a, b) => (b.drop_act_date || '').localeCompare(a.drop_act_date || '') || a.invoice.localeCompare(b.invoice)));
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  async function markInvoiced(r) {
    setBusy(r.mail_drop_id);
    const now = new Date().toISOString();
    const { error: err } = await supabase.from('qb_invoiced_drops').upsert({
      mail_drop_id: r.mail_drop_id, invoice_number: r.invoice, invoiced_by: userEmail, invoiced_at: now,
      is_invoiced: true, cleared_by: null, cleared_at: null,
    }, { onConflict: 'mail_drop_id' });
    if (err) { setBusy(null); alert(`Couldn't mark invoiced: ${err.message}`); return; }
    await supabase.from('notifications').insert({
      event_type: 'qb_invoiced',
      title: `🧾 Invoiced in QuickBooks — ${r.invoice}`,
      body: `${(r.customer_name || '').trim() || r.mail_drop_id} invoice ${r.invoice} marked invoiced in QuickBooks by ${userEmail || 'unknown'}`,
      severity: 'info',
      source: 'qb_invoicing',
      data_json: { mail_drop_id: r.mail_drop_id, invoice_number: r.invoice, invoiced_by: userEmail },
    });
    setInvoiced(prev => new Map(prev).set(r.mail_drop_id, { invoiced_by: userEmail, invoiced_at: now }));
    setBusy(null);
  }

  async function unmarkInvoiced(r) {
    if (!confirm(`Unmark invoice ${r.invoice} as invoiced in QuickBooks?`)) return;
    setBusy(r.mail_drop_id);
    const { error: err } = await supabase.from('qb_invoiced_drops')
      .update({ is_invoiced: false, cleared_by: userEmail, cleared_at: new Date().toISOString() })
      .eq('mail_drop_id', r.mail_drop_id);
    if (err) { setBusy(null); alert(`Couldn't unmark: ${err.message}`); return; }
    await supabase.from('notifications').insert({
      event_type: 'qb_invoice_cleared',
      title: `QuickBooks invoice unmarked — ${r.invoice}`,
      body: `${(r.customer_name || '').trim() || r.mail_drop_id} invoice ${r.invoice} unmarked as invoiced by ${userEmail || 'unknown'}`,
      severity: 'info',
      source: 'qb_invoicing',
      data_json: { mail_drop_id: r.mail_drop_id, invoice_number: r.invoice, cleared_by: userEmail },
    });
    setInvoiced(prev => { const m = new Map(prev); m.delete(r.mail_drop_id); return m; });
    setBusy(null);
  }

  // Search + date filter first, so the view tabs can show counts for each.
  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      (!fromDate || (r.drop_act_date || '') >= fromDate) &&
      (!toDate || (r.drop_act_date || '') <= toDate) &&
      (!q || [r.customer_name, r.order_id, r.invoice].some(v => String(v || '').toLowerCase().includes(q))));
  }, [rows, search, fromDate, toDate]);

  const counts = useMemo(() => {
    if (!filtered) return {};
    const inv = filtered.filter(r => invoiced.has(r.mail_drop_id)).length;
    return { open: filtered.length - inv, invoiced: inv, all: filtered.length };
  }, [filtered, invoiced]);

  const shown = useMemo(() => filtered && filtered.filter(r =>
    view === 'all' || (view === 'invoiced') === invoiced.has(r.mail_drop_id)), [filtered, invoiced, view]);

  function handleExport() {
    const header = ['Client', 'Terms', 'Order Number', 'Drop Number', 'Invoice Number', 'Actual Mail Date', 'Invoiced in QB', 'Invoiced By', 'Invoiced At'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map(r => {
      const q = invoiced.get(r.mail_drop_id);
      return [r.customer_name?.trim(), r.term, r.order_id, r.drop_number, r.invoice, r.drop_act_date,
        q ? 'Yes' : 'No', q?.invoiced_by, q?.invoiced_at].map(esc).join(',');
    });
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `invoicing-report-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const inputStyle = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' };
  const headers = ['Client', 'Terms', 'Order Number', 'Drop Number', 'Invoice Number', 'Actual Mail Date', 'QuickBooks'];

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

      <div className="flex gap-1 text-sm">
        {VIEWS.map(v => (
          <button key={v.key} onClick={() => setView(v.key)} className="px-3 py-1.5 rounded-lg font-medium border"
            style={{
              borderColor: view === v.key ? 'var(--accent)' : 'var(--border)',
              background: view === v.key ? 'var(--accent-light)' : 'var(--surface)',
              color: view === v.key ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
            {v.label}{counts[v.key] != null ? ` (${counts[v.key].toLocaleString()})` : ''}
          </button>
        ))}
      </div>

      <div className="rounded-xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }} className="text-left">
              {headers.map(h => <th key={h} className="px-4 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown === null && !error && (
              <tr><td colSpan={headers.length} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>Loading…</td></tr>
            )}
            {shown?.length === 0 && (
              <tr><td colSpan={headers.length} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>
                {view === 'invoiced' ? 'Nothing marked invoiced in QuickBooks yet.' : 'No completed drops to invoice.'}
              </td></tr>
            )}
            {shown?.map(r => {
              const q = invoiced.get(r.mail_drop_id);
              return (
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
                  <td className="px-4 py-2 whitespace-nowrap">
                    {q ? (
                      <div className="flex items-center gap-2">
                        <span title={`${q.invoiced_by || 'unknown'} · ${fmtStamp(q.invoiced_at)}`}
                          className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ background: 'var(--status-ok-bg)', color: 'var(--status-ok)' }}>
                          ✓ Invoiced in QB
                        </span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {(q.invoiced_by || '').split('@')[0]} · {fmtStamp(q.invoiced_at)}
                        </span>
                        <button onClick={() => unmarkInvoiced(r)} disabled={busy === r.mail_drop_id}
                          className="text-xs underline" style={{ color: 'var(--text-muted)' }}>
                          Undo
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => markInvoiced(r)} disabled={busy === r.mail_drop_id}
                        className="text-xs px-2 py-1 rounded font-medium border"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface2)', color: 'var(--text-secondary)', opacity: busy === r.mail_drop_id ? 0.6 : 1 }}>
                        {busy === r.mail_drop_id ? 'Saving…' : 'Mark invoiced in QB'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
