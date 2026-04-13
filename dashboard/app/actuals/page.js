'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '../../lib/supabase';

const fmt = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');

const FULFILLMENT_PATHS = ['All', 'Kaleidoscope > Kaleidoscope', 'Unspecified > Unspecified'];
const CATEGORIES = ['All', 'EDDM', 'LDP', 'Saturation', 'DM Postcard', 'New Mover Postcard'];

export default function ActualsPage() {
  const supabase = createClient();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('drop_act_date');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPath, setFilterPath] = useState('All');
  const [filterCat, setFilterCat] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    // Get Osprey drops with actuals (where drop has occurred)
    const { data: drops } = await supabase
      .from('osprey_mail_drops')
      .select(
        'customer_name, product_category, drop_act_date, drop_est_date, fulfillment_path, postage_amount, mail_drop_id, order_id'
      )
      .not('drop_act_date', 'is', null)
      .gte('drop_act_date', since90)
      .order('drop_act_date', { ascending: false })
      .limit(500);

    if (!drops?.length) {
      setRows([]);
      setLoading(false);
      return;
    }

    // Get matching USPS transactions by osprey_mail_drop_id
    const dropIds = [...new Set(drops.map((d) => d.mail_drop_id).filter(Boolean))];
    let uspsMap = {};
    if (dropIds.length) {
      const { data: usps } = await supabase
        .from('usps_transactions')
        .select('osprey_mail_drop_id, amount')
        .in('osprey_mail_drop_id', dropIds);

      for (const u of usps || []) {
        const id = u.osprey_mail_drop_id;
        uspsMap[id] = (uspsMap[id] || 0) + Math.abs(u.amount || 0);
      }
    }

    const combined = drops.map((d) => {
      const quoted = d.postage_amount || 0;
      const actual = uspsMap[d.mail_drop_id] || null;
      const varDollar = actual != null ? actual - quoted : null;
      const varPct = actual != null && quoted ? (actual - quoted) / quoted : null;
      return {
        customer: d.customer_name,
        product: d.product_category,
        drop_date: d.drop_act_date || d.drop_est_date,
        fulfillment_path: d.fulfillment_path,
        quoted,
        actual,
        var_dollar: varDollar,
        var_pct: varPct,
      };
    });

    setRows(combined);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    return rows
      .filter((r) => filterPath === 'All' || r.fulfillment_path === filterPath)
      .filter((r) => filterCat === 'All' || r.product === filterCat)
      .filter((r) => !dateFrom || r.drop_date >= dateFrom)
      .filter((r) => !dateTo || r.drop_date <= dateTo)
      .sort((a, b) => {
        const av = a[sortCol] ?? '';
        const bv = b[sortCol] ?? '';
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });
  }, [rows, filterPath, filterCat, dateFrom, dateTo, sortCol, sortDir]);

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  }

  const cols = [
    { key: 'customer', label: 'Customer' },
    { key: 'product', label: 'Product' },
    { key: 'drop_date', label: 'Drop Date' },
    { key: 'fulfillment_path', label: 'Fulfillment Path' },
    { key: 'quoted', label: 'Quoted Postage' },
    { key: 'actual', label: 'Actual Postage' },
    { key: 'var_dollar', label: 'Variance $' },
    { key: 'var_pct', label: 'Variance %' },
  ];

  const paths = ['All', ...new Set(rows.map((r) => r.fulfillment_path).filter(Boolean))];
  const cats = ['All', ...new Set(rows.map((r) => r.product).filter(Boolean))];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Actuals vs Quoted</h1>

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
                    className="px-3 py-2 text-left text-xs font-semibold text-gray-600 cursor-pointer whitespace-nowrap select-none"
                  >
                    {c.label}
                    {sortCol === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const highVariance = r.var_pct != null && Math.abs(r.var_pct) > 0.05;
                return (
                  <tr
                    key={i}
                    className={`border-b border-gray-50 ${highVariance ? 'bg-red-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}`}
                  >
                    <td className="px-3 py-2 text-gray-800">{r.customer || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.product || '—'}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.drop_date || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.fulfillment_path || '—'}</td>
                    <td className="px-3 py-2 text-right">{fmt(r.quoted)}</td>
                    <td className="px-3 py-2 text-right">{fmt(r.actual)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${r.var_dollar > 0 ? 'text-red-600' : r.var_dollar < 0 ? 'text-green-600' : 'text-gray-600'}`}>
                      {fmt(r.var_dollar)}
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${highVariance ? 'text-red-700' : 'text-gray-600'}`}>
                      {fmtPct(r.var_pct)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">No data</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
