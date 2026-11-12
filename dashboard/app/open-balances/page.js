'use client';

// Open Balances — every order (not a quote / incomplete / canceled / void)
// whose live Osprey Balance Due is more than zero. The balance is the same
// number as the "Balance Due" box on the Osprey order page and the orange
// Balance Due column on Late Mailings (/api/osprey/balances), looked up per
// order in chunks so rows fill in progressively. Orders Supabase already shows
// as unpaid are checked first, so nearly every row appears within the first few
// chunks; the rest (mostly paid in full) finish in the background. The table
// shows PAGE_SIZE rows per page.
//
// Terms come from customer_terms.term_label; a customer with no row (or
// "Undefined") shows as Unknown. "All drops complete" ignores canceled /
// discarded drops: an order qualifies when every remaining drop is complete.

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '../../lib/supabase';
import { OspreyOrderLink } from '../../lib/ospreyLinks';

const fmt$ = (n) => (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d) => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

const PAGE_SIZE = 50;
const EXCLUDED_ORDER_STATUSES = ['QUOTE', 'INCOMPLETE', 'CANCELED', 'VOID'];
const isComplete = (d) => /^complete/i.test(d.drop_status || '') || !!d.drop_act_date;
const isCanceled = (d) => /^(canceled|discard)$/i.test(d.drop_status || '');

function termLabel(label) {
  const t = (label || '').toUpperCase().trim();
  if (t === '' || t === 'UNDEFINED') return 'Unknown';
  if (t === 'PREPAY') return 'PrePay';
  return t;
}

const COMPLETE_VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'yes', label: 'All drops complete' },
  { key: 'no', label: 'Drops still open' },
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

export default function OpenBalancesPage() {
  const supabase = createClient();
  const [orders, setOrders] = useState(null);
  const [balances, setBalances] = useState({});   // order_id → { balance, charges } | null (lookup failed)
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [terms, setTerms] = useState([]);         // selected term labels; empty = all
  const [completeView, setCompleteView] = useState('all');
  const [minBalance, setMinBalance] = useState('');
  const [sort, setSort] = useState({ key: 'balance', dir: -1 });
  const [page, setPage] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const drops = await fetchAll(() => supabase
          .from('osprey_mail_drops')
          .select('customer_id, customer_name, order_id, order_status, order_amount, payment_amount_applied, seller, mail_drop_id, drop_status, drop_est_date, drop_act_date')
          .not('order_status', 'in', `(${EXCLUDED_ORDER_STATUSES.join(',')})`)
          .order('mail_drop_id'));

        const ids = [...new Set(drops.map(d => d.customer_id).filter(Boolean))];
        const termByCustomer = {};
        for (let i = 0; i < ids.length; i += 200) {
          const { data, error: err } = await supabase.from('customer_terms')
            .select('customer_id, term_label').in('customer_id', ids.slice(i, i + 200));
          if (err) throw err;
          for (const t of data) termByCustomer[t.customer_id] = t.term_label;
        }

        const byOrder = new Map();
        for (const d of drops) {
          if (!d.order_id) continue;
          let o = byOrder.get(d.order_id);
          if (!o) {
            o = {
              order_id: String(d.order_id), customer_name: (d.customer_name || '').trim(), order_status: d.order_status,
              order_amount: Number(d.order_amount) || 0, paidAtScrape: Number(d.payment_amount_applied) || 0, seller: d.seller, term: termLabel(termByCustomer[d.customer_id]),
              drops: 0, dropsComplete: 0, lastDrop: null,
            };
            byOrder.set(d.order_id, o);
          }
          if (isCanceled(d)) continue;
          o.drops++;
          if (isComplete(d)) o.dropsComplete++;
          const date = d.drop_act_date || d.drop_est_date;
          if (date && (!o.lastDrop || date > o.lastDrop)) o.lastDrop = date;
        }
        const list = [...byOrder.values()].map(o => ({ ...o, allComplete: o.drops > 0 && o.dropsComplete === o.drops }));
        setOrders(list);

        // Live Balance Due per order: chunks of 50, 3 chunks at a time, orders
        // that looked unpaid at the last scrape first.
        const likelyOwing = (o) => o.order_amount - o.paidAtScrape > 0.005;
        const orderIds = [...list].sort((a, b) => likelyOwing(b) - likelyOwing(a)).map(o => o.order_id);
        const chunks = [];
        for (let i = 0; i < orderIds.length; i += 50) chunks.push(orderIds.slice(i, i + 50));
        let next = 0;
        const worker = async () => {
          while (next < chunks.length) {
            const chunk = chunks[next++];
            let result;
            try {
              const res = await fetch('/api/osprey/balances', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ orderIds: chunk }),
              });
              result = res.ok ? (await res.json()).balances : null;
            } catch { result = null; }
            setBalances(prev => {
              const out = { ...prev };
              for (const id of chunk) out[id] = result?.[id] ?? null;
              return out;
            });
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  const checked = Object.keys(balances).length;
  const failed = useMemo(() => Object.values(balances).filter(b => b === null).length, [balances]);
  const loading = orders !== null && checked < orders.length;

  // Orders whose balance has loaded and is owed.
  const owing = useMemo(() => (orders || [])
    .map(o => ({ ...o, balance: balances[o.order_id]?.balance, paid: balances[o.order_id]?.charges }))
    .filter(o => o.balance > 0), [orders, balances]);

  const termOptions = useMemo(() => {
    const counts = {};
    for (const o of owing) counts[o.term] = (counts[o.term] || 0) + 1;
    const rank = (t) => (t === 'PrePay' ? 0 : t === 'Unknown' ? 1 : 2);
    return Object.keys(counts).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(t => ({ term: t, count: counts[t] }));
  }, [owing]);

  // Everything but the complete filter, so its tabs can show counts.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minBalance === '' ? 0 : Number(minBalance);
    return owing.filter(o =>
      (!terms.length || terms.includes(o.term)) &&
      o.balance >= min &&
      (!q || [o.customer_name, o.order_id, o.seller, o.order_status].some(v => String(v || '').toLowerCase().includes(q))));
  }, [owing, terms, search, minBalance]);

  const counts = useMemo(() => {
    const yes = filtered.filter(o => o.allComplete).length;
    return { all: filtered.length, yes, no: filtered.length - yes };
  }, [filtered]);

  const shown = useMemo(() => filtered
    .filter(o => completeView === 'all' || (completeView === 'yes') === o.allComplete)
    .sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      const cmp = typeof x === 'number' || typeof y === 'number' ? (x || 0) - (y || 0) : String(x || '').localeCompare(String(y || ''));
      return cmp * sort.dir || b.balance - a.balance;
    }), [filtered, completeView, sort]);

  const total = useMemo(() => shown.reduce((s, o) => s + o.balance, 0), [shown]);

  // Back to the first page whenever the filters or sort change.
  useEffect(() => { setPage(0); }, [search, terms, completeView, minBalance, sort]);
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => shown.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE), [shown, pageIndex]);

  const toggleTerm = (t) => setTerms(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  const sortBy = (key) => setSort(prev => ({ key, dir: prev.key === key ? -prev.dir : (['balance', 'order_amount', 'paid', 'lastDrop'].includes(key) ? -1 : 1) }));

  function handleExport() {
    const header = ['Client', 'Terms', 'Order Number', 'Order Status', 'Seller', 'Order Amount', 'Paid (Osprey)', 'Balance Due (Osprey)', 'Drops Complete', 'Drops', 'All Drops Complete', 'Last Drop Date'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map(o => [o.customer_name, o.term, o.order_id, o.order_status, o.seller, o.order_amount.toFixed(2),
      (o.paid ?? 0).toFixed(2), o.balance.toFixed(2), o.dropsComplete, o.drops, o.allComplete ? 'Yes' : 'No', o.lastDrop].map(esc).join(','));
    const blob = new Blob([[header.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `open-balances-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const inputStyle = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' };
  const chip = (active) => ({
    borderColor: active ? 'var(--accent)' : 'var(--border)',
    background: active ? 'var(--accent-light)' : 'var(--surface)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
  });
  const headers = [
    { key: 'customer_name', label: 'Client' },
    { key: 'term', label: 'Terms' },
    { key: 'order_id', label: 'Order Number' },
    { key: 'order_status', label: 'Order Status' },
    { key: 'order_amount', label: 'Order Amount', align: 'right' },
    { key: 'paid', label: 'Paid', align: 'right' },
    { key: 'balance', label: 'Balance Due', align: 'right' },
    { key: 'dropsComplete', label: 'Drops' },
    { key: 'lastDrop', label: 'Last Drop' },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Open Balances</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Orders with a live Osprey Balance Due above zero. Quotes, incomplete, canceled and void orders are left out.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search client, order, seller"
            className="px-3 py-2 rounded-lg border" style={inputStyle} />
          <label style={{ color: 'var(--text-muted)' }}>Min balance $</label>
          <input type="number" min="0" value={minBalance} onChange={e => setMinBalance(e.target.value)} placeholder="0"
            className="px-2 py-2 rounded-lg border w-24" style={inputStyle} />
          <button onClick={handleExport} disabled={!shown.length} className="px-3 py-2 rounded-lg font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: shown.length ? 1 : 0.5 }}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}
      {(orders === null && !error) && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading orders…</p>}
      {loading && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Checking balances in Osprey: {checked.toLocaleString()} of {orders.length.toLocaleString()} orders. Orders most likely to owe are checked first.
        </p>
      )}
      {!loading && failed > 0 && (
        <p className="text-sm" style={{ color: 'var(--status-warn)' }}>
          Could not load the balance for {failed.toLocaleString()} order{failed === 1 ? '' : 's'}; they are not listed. Reload to retry.
        </p>
      )}

      <div className="flex gap-1 text-sm flex-wrap items-center">
        <span className="mr-1" style={{ color: 'var(--text-muted)' }}>Terms</span>
        <button onClick={() => setTerms([])} className="px-3 py-1.5 rounded-lg font-medium border" style={chip(!terms.length)}>All</button>
        {termOptions.map(t => (
          <button key={t.term} onClick={() => toggleTerm(t.term)} className="px-3 py-1.5 rounded-lg font-medium border" style={chip(terms.includes(t.term))}>
            {t.term} ({t.count.toLocaleString()})
          </button>
        ))}
      </div>

      <div className="flex gap-1 text-sm flex-wrap items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {COMPLETE_VIEWS.map(v => (
            <button key={v.key} onClick={() => setCompleteView(v.key)} className="px-3 py-1.5 rounded-lg font-medium border" style={chip(completeView === v.key)}>
              {v.label} ({counts[v.key].toLocaleString()})
            </button>
          ))}
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          {shown.length.toLocaleString()} order{shown.length === 1 ? '' : 's'} · <span className="font-semibold" style={{ color: 'var(--status-warn)' }}>{fmt$(total)}</span> owed
        </div>
      </div>

      <div className="rounded-xl border overflow-x-auto" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }} className="text-left">
              {headers.map(h => (
                <th key={h.key} onClick={() => sortBy(h.key)}
                  className={`px-4 py-2 font-medium whitespace-nowrap cursor-pointer select-none ${h.align === 'right' ? 'text-right' : ''}`}>
                  {h.label}{sort.key === h.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders !== null && !loading && shown.length === 0 && (
              <tr><td colSpan={headers.length} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>No orders with an open balance match these filters.</td></tr>
            )}
            {pageRows.map(o => (
              <tr key={o.order_id} className="border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
                <td className="px-4 py-2">{o.customer_name}</td>
                <td className="px-4 py-2 whitespace-nowrap">{o.term}</td>
                <td className="px-4 py-2 whitespace-nowrap"><OspreyOrderLink id={o.order_id} /></td>
                <td className="px-4 py-2 whitespace-nowrap">{o.order_status}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right">{fmt$(o.order_amount)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right">{fmt$(o.paid)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right font-medium" style={{ color: 'var(--status-warn)' }}>{fmt$(o.balance)}</td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <span className="text-xs px-2 py-0.5 rounded font-medium"
                    style={o.allComplete
                      ? { background: 'var(--status-ok-bg)', color: 'var(--status-ok)' }
                      : { background: 'var(--surface2)', color: 'var(--text-muted)' }}>
                    {o.allComplete ? '✓ All complete' : `${o.dropsComplete} of ${o.drops} complete`}
                  </span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">{fmtDate(o.lastDrop?.slice(0, 10))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>
            Showing {(pageIndex * PAGE_SIZE + 1).toLocaleString()}–{Math.min((pageIndex + 1) * PAGE_SIZE, shown.length).toLocaleString()} of {shown.length.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(pageIndex - 1)} disabled={pageIndex === 0}
              className="px-3 py-1.5 rounded-lg font-medium border" style={{ ...chip(false), opacity: pageIndex === 0 ? 0.5 : 1 }}>
              Previous
            </button>
            <span>Page {pageIndex + 1} of {pageCount}</span>
            <button onClick={() => setPage(pageIndex + 1)} disabled={pageIndex >= pageCount - 1}
              className="px-3 py-1.5 rounded-lg font-medium border" style={{ ...chip(false), opacity: pageIndex >= pageCount - 1 ? 0.5 : 1 }}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
