'use client';

// Postage Actuals — three-way reconciliation per drop:
//   - Est Postage    = osprey_mail_drops.postage_amount    (forecast at order time)
//   - Actual Postage = osprey_mail_drops.actual_postage    (Osprey production-priced cost)
//   - EPS Postage    = SUM(usps_transactions.amount) matched by mail_drop_id
//                      (real money out the door)
//
// Variance       = Actual − EPS  (does Osprey's calculated cost match the real USPS charge?)
// Postage Profit = Est    − EPS  (forecast vs reality — what we charged the customer minus what we paid USPS)
//
// Date window defaults to the last 30 days through 15 days into the future.
// Filter operates on drop_act_date when present, falling back to drop_est_date,
// so this view spans recent actuals + near-future scheduled drops in one frame.

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';
import { isLdpMailMethod } from '../../lib/postage';
import { OspreyOrderLink, OspreyDropLink } from '../../lib/ospreyLinks';

const fmt = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

const TODAY = () => new Date().toISOString().split('T')[0];

// Osprey emits drop_status with inconsistent casing — "COMPLETE" / "complete" /
// "Complete" all appear in the same dataset. Normalize to title case so they
// merge into one pill / one comparable value. Returns null when the input is
// blank.
function normalizeStatus(s) {
  if (!s) return null;
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Statuses we default the filter to on first load — drops that have actually
// completed (with or without an outstanding payment-required marker). The
// user can manually toggle other statuses on after the page renders.
const DEFAULT_STATUSES = ['Complete', 'Complete Pymt Req'];

export default function ActualsPage() {
  const supabase = createClient();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('drop_date');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPath, setFilterPath] = useState('All');
  const [filterCat, setFilterCat] = useState('All');
  // Default window: last 30 days through today, evaluated against
  // drop_act_date (or drop_est_date when no act has happened yet). The user
  // can manually extend the To date out into the future and the load will
  // refetch — see the load callback's deps below.
  const [dateFrom, setDateFrom] = useState(addDays(TODAY(), -30));
  const [dateTo,   setDateTo]   = useState(TODAY());
  // Multi-select drop_status filter. null = all statuses pass through (default
  // before rows load). Once rows load we seed the Set with every status seen
  // so all pills start active; clicking a pill toggles its membership.
  const [selectedStatuses, setSelectedStatuses] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const fetchFrom = dateFrom;
    const fetchTo   = dateTo;
    if (!fetchFrom || !fetchTo) { setLoading(false); return; }

    // We want every drop whose effective date (act if present, else est) falls
    // in the window. Postgrest can't express COALESCE in a filter, so we OR
    // two conditions:
    //   1) drop_act_date in [fetchFrom, fetchTo]              ← past drops with an actual
    //   2) drop_act_date IS NULL AND drop_est_date in window  ← unmailed (future or stalled) drops
    const { data: drops } = await supabase
      .from('osprey_mail_drops')
      .select(
        'mail_drop_id, order_id, customer_name, product_category, mail_method, drop_status, fulfillment_path, drop_act_date, drop_est_date, postage_amount, actual_postage, mail_drop_quantity'
      )
      .or(
        `and(drop_act_date.gte.${fetchFrom},drop_act_date.lte.${fetchTo}),` +
        `and(drop_act_date.is.null,drop_est_date.gte.${fetchFrom},drop_est_date.lte.${fetchTo})`
      )
      .limit(1000);

    if (!drops?.length) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Dedupe by mail_drop_id (defensive — one row per drop) plus three
    // exclusions specific to this page:
    //   1. mail_method = "LDP"           — handled and paid for by LDP, not us
    //   2. product_category "New Mover"  — out of scope for this view
    //   3. LDP product without actual    — drops where Osprey hasn't priced
    //      the LDP postcard yet are noise on the actuals view; show them only
    //      once production has posted a real actual_postage value.
    const seen = new Map();
    for (const d of drops) seen.set(d.mail_drop_id, d);
    const cleaned = [...seen.values()]
      .filter(d => !isLdpMailMethod(d))
      .filter(d => {
        const cat = (d.product_category || '').toLowerCase();
        if (cat.includes('new mover')) return false;
        if (cat.includes('ldp') && !(d.actual_postage > 0)) return false;
        return true;
      });

    // Sum EPS transactions by mail_drop_id for the drops we kept.
    const dropIds = cleaned.map(d => d.mail_drop_id).filter(Boolean);
    const epsMap = {};
    if (dropIds.length) {
      const { data: usps } = await supabase
        .from('usps_transactions')
        .select('osprey_mail_drop_id, amount')
        .in('osprey_mail_drop_id', dropIds);
      for (const u of (usps || [])) {
        const id = u.osprey_mail_drop_id;
        epsMap[id] = (epsMap[id] || 0) + Math.abs(u.amount || 0);
      }
    }

    const combined = cleaned.map(d => {
      const estPostage    = d.postage_amount || 0;
      const actualPostage = d.actual_postage || 0;
      const epsPostage    = epsMap[d.mail_drop_id] || null;

      // Variance: how close did Osprey's actual price track USPS reality?
      // Null until both sides exist.
      const variance    = (epsPostage != null && actualPostage)
        ? actualPostage - epsPostage
        : null;
      const variancePct = (epsPostage != null && actualPostage)
        ? (actualPostage - epsPostage) / actualPostage
        : null;

      // Postage profit: customer's est postage minus what we actually paid
      // USPS. Positive = profit, negative = loss. Null until EPS is charged.
      const postageProfit = (epsPostage != null && estPostage)
        ? estPostage - epsPostage
        : null;

      return {
        mail_drop_id: d.mail_drop_id,
        order_id: d.order_id,
        customer: d.customer_name,
        product: d.product_category,
        mail_method: d.mail_method,
        drop_status: normalizeStatus(d.drop_status),
        drop_date: d.drop_act_date || d.drop_est_date,
        is_acted: !!d.drop_act_date,
        fulfillment_path: d.fulfillment_path,
        estPostage,
        actualPostage,
        epsPostage,
        variance,
        variancePct,
        postageProfit,
      };
    });

    setRows(combined);
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // List of distinct drop_status values present in the loaded rows. Sorted so
  // the pills render in stable order across re-fetches.
  const allStatuses = useMemo(() =>
    [...new Set(rows.map(r => r.drop_status).filter(Boolean))].sort(),
    [rows]
  );

  // Once rows arrive for the first time, seed the selection to the default
  // "completed" statuses (Complete, Complete Pymt Req) if any are present.
  // Falls back to "all selected" if neither default exists in the data so the
  // user doesn't see an empty table on first load. We only seed once — manual
  // changes survive subsequent refetches.
  useEffect(() => {
    if (selectedStatuses === null && allStatuses.length > 0) {
      const matching = DEFAULT_STATUSES.filter(s => allStatuses.includes(s));
      setSelectedStatuses(new Set(matching.length > 0 ? matching : allStatuses));
    }
  }, [allStatuses, selectedStatuses]);

  function toggleStatus(s) {
    setSelectedStatuses(prev => {
      const base = prev ?? new Set(allStatuses);
      const next = new Set(base);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  const filtered = useMemo(() => {
    return rows
      .filter((r) => filterPath === 'All' || r.fulfillment_path === filterPath)
      .filter((r) => filterCat === 'All' || r.product === filterCat)
      .filter((r) => !dateFrom || r.drop_date >= dateFrom)
      .filter((r) => !dateTo || r.drop_date <= dateTo)
      // Status multi-select: null means "show all", otherwise only rows whose
      // drop_status is in the selected Set. Rows with no drop_status only
      // appear when no status filter is in effect.
      .filter((r) => !selectedStatuses || (r.drop_status && selectedStatuses.has(r.drop_status)))
      .sort((a, b) => {
        const av = a[sortCol] ?? '';
        const bv = b[sortCol] ?? '';
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });
  }, [rows, filterPath, filterCat, dateFrom, dateTo, selectedStatuses, sortCol, sortDir]);

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  }

  // Roll-up totals across the visible (filtered) rows.
  const totals = useMemo(() => {
    return filtered.reduce((acc, r) => ({
      est:    acc.est    + (r.estPostage    || 0),
      actual: acc.actual + (r.actualPostage || 0),
      eps:    acc.eps    + (r.epsPostage    || 0),
      profit: acc.profit + (r.postageProfit || 0),
    }), { est: 0, actual: 0, eps: 0, profit: 0 });
  }, [filtered]);

  const cols = [
    { key: 'customer',         label: 'Customer' },
    { key: 'product',          label: 'Product' },
    { key: 'order_id',         label: 'Order ID' },
    { key: 'mail_drop_id',     label: 'Drop ID' },
    { key: 'mail_method',      label: 'Mail Method' },
    { key: 'drop_status',      label: 'Drop Status' },
    { key: 'drop_date',        label: 'Drop Date' },
    { key: 'fulfillment_path', label: 'Fulfillment Path' },
    { key: 'estPostage',       label: 'Est Postage',    align: 'right' },
    { key: 'actualPostage',    label: 'Actual Postage', align: 'right' },
    { key: 'epsPostage',       label: 'EPS Postage',    align: 'right' },
    { key: 'variance',         label: 'Variance $',     align: 'right' },
    { key: 'variancePct',      label: 'Variance %',     align: 'right' },
    { key: 'postageProfit',    label: 'Postage Profit', align: 'right' },
  ];

  const paths = ['All', ...new Set(rows.map((r) => r.fulfillment_path).filter(Boolean))];
  const cats  = ['All', ...new Set(rows.map((r) => r.product).filter(Boolean))];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Postage Actuals</h1>
      <p className="text-xs text-gray-500">
        Est (Osprey forecast) → Actual (Osprey production-priced) → EPS (real USPS charge). Variance compares Actual vs EPS.
        Postage Profit = Est − EPS. Default window is the last 30 days, scoped to drops marked Complete or Complete Pymt Req — adjust filters below to widen.
      </p>

      {/* Roll-up tiles — moved to the top so the headline numbers are the
          first thing you see when the page loads. They reflect the active
          filters, so as you toggle pills below, these update in lockstep. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-0.5">Est Postage</p>
          <p className="text-lg font-bold text-gray-900">{fmt(totals.est)}</p>
        </div>
        <div className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-0.5">Actual Postage</p>
          <p className="text-lg font-bold text-gray-900">{fmt(totals.actual)}</p>
        </div>
        <div className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-0.5">EPS Postage</p>
          <p className="text-lg font-bold text-gray-900">{fmt(totals.eps)}</p>
        </div>
        <div className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-0.5">Postage Profit (Est − EPS)</p>
          <p className={`text-lg font-bold ${totals.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {fmt(totals.profit)}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
        <div>
          <label className="text-xs text-gray-500 block mb-1">From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Fulfillment Path</label>
          <select value={filterPath} onChange={(e) => setFilterPath(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm">
            {paths.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Product Category</label>
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm">
            {cats.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <span className="text-xs text-gray-500">{filtered.length} rows</span>
        </div>
      </div>

      {/* Drop Status multi-select — toggleable pills, one per distinct status
          present in the loaded rows. Clicking a pill flips its membership;
          All / None reset the selection in bulk. */}
      {allStatuses.length > 0 && (
        <div className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex items-center flex-wrap gap-2">
            <span className="text-xs text-gray-500 mr-1">Drop Status:</span>
            <button
              onClick={() => setSelectedStatuses(new Set(allStatuses))}
              className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
              All
            </button>
            <button
              onClick={() => setSelectedStatuses(new Set())}
              className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
              None
            </button>
            <span className="w-px h-4 bg-gray-200 mx-1" />
            {allStatuses.map(s => {
              const active = !selectedStatuses || selectedStatuses.has(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-300 bg-white text-gray-400'
                  }`}>
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl border border-gray-100 shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className={`px-3 py-2 text-xs font-semibold text-gray-600 cursor-pointer whitespace-nowrap select-none ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {c.label}
                    {sortCol === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                // Highlight rows where Actual diverges meaningfully from EPS — that's
                // the "Osprey said one thing, USPS charged another" signal.
                const highVariance = r.variancePct != null && Math.abs(r.variancePct) > 0.05;
                return (
                  <tr
                    key={r.mail_drop_id || i}
                    className={`border-b border-gray-50 ${highVariance ? 'bg-red-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}
                  >
                    <td className="px-3 py-2 text-gray-800">{r.customer || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.product || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs whitespace-nowrap">
                      <OspreyOrderLink id={r.order_id} />
                    </td>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs whitespace-nowrap">
                      <OspreyDropLink id={r.mail_drop_id} />
                    </td>
                    <td className="px-3 py-2 text-gray-600">{r.mail_method || '—'}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.drop_status || '—'}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                      {r.drop_date || '—'}
                      {!r.is_acted && r.drop_date && (
                        <span className="ml-1 text-[10px] text-gray-400">(est)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{r.fulfillment_path || '—'}</td>
                    <td className="px-3 py-2 text-right">{fmt(r.estPostage)}</td>
                    <td className="px-3 py-2 text-right">{r.actualPostage > 0 ? fmt(r.actualPostage) : '—'}</td>
                    <td className="px-3 py-2 text-right">{fmt(r.epsPostage)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${r.variance > 0 ? 'text-red-600' : r.variance < 0 ? 'text-green-600' : 'text-gray-600'}`}>
                      {fmt(r.variance)}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${highVariance ? 'text-red-700' : 'text-gray-600'}`}>
                      {fmtPct(r.variancePct)}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${r.postageProfit > 0 ? 'text-green-600' : r.postageProfit < 0 ? 'text-red-600' : 'text-gray-600'}`}>
                      {fmt(r.postageProfit)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={cols.length} className="px-3 py-6 text-center text-gray-400">No data</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
