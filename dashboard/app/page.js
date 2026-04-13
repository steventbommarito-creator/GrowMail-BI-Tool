'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '../lib/supabase';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const fmt = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function OverviewPage() {
  const supabase = createClient();
  const [kpis, setKpis] = useState(null);
  const [categoryData, setCategoryData] = useState([]);
  const [pathData, setPathData] = useState([]);
  const [aiSummary, setAiSummary] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    const [{ data: committed }, { data: actuals }] = await Promise.all([
      supabase
        .from('osprey_mail_drops')
        .select('postage_amount, mail_drop_quantity')
        .gte('drop_est_date', today),
      supabase
        .from('usps_transactions')
        .select('amount')
        .gte('transaction_date', since30),
    ]);

    const totalCommitted = (committed || []).reduce((s, r) => s + (r.postage_amount || 0), 0);
    const totalPaid = (actuals || []).reduce((s, r) => s + Math.abs(r.amount || 0), 0);
    const piecesScheduled = (committed || []).reduce((s, r) => s + (r.mail_drop_quantity || 0), 0);

    setKpis({
      committed: totalCommitted,
      paid: totalPaid,
      variance: totalCommitted - totalPaid,
      pieces: piecesScheduled,
    });

    // Postage by category (last 30d)
    const { data: byCategory } = await supabase
      .from('osprey_mail_drops')
      .select('product_category, postage_amount')
      .gte('capture_date', since30);

    const catMap = {};
    for (const r of byCategory || []) {
      if (!r.product_category) continue;
      catMap[r.product_category] = (catMap[r.product_category] || 0) + (r.postage_amount || 0);
    }
    setCategoryData(
      Object.entries(catMap).map(([name, postage]) => ({ name, postage: +postage.toFixed(2) }))
    );

    // Quoted postage by fulfillment path
    const { data: byPath } = await supabase
      .from('osprey_mail_drops')
      .select('fulfillment_path, postage_amount')
      .gte('capture_date', since30)
      .not('fulfillment_path', 'is', null);

    const pathMap = {};
    for (const r of byPath || []) {
      const p = r.fulfillment_path;
      pathMap[p] = (pathMap[p] || 0) + (r.postage_amount || 0);
    }
    setPathData(
      Object.entries(pathMap).map(([name, quoted]) => ({
        name,
        Quoted: +quoted.toFixed(2),
      }))
    );

    // AI summary
    const { data: insight } = await supabase
      .from('ai_insights')
      .select('narrative, generated_at')
      .eq('insight_type', 'daily_summary')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setAiSummary(insight?.narrative || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <p className="text-gray-500 p-4">Loading...</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Postage Overview</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Postage Committed', value: fmt(kpis?.committed) },
          { label: 'Postage Paid (30d)', value: fmt(kpis?.paid) },
          {
            label: 'Overall Variance',
            value: fmt(kpis?.variance),
            color: kpis?.variance > 0 ? 'text-red-600' : 'text-green-600',
          },
          { label: 'Pieces Scheduled', value: Number(kpis?.pieces || 0).toLocaleString() },
        ].map((k) => (
          <div key={k.label} className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
            <p className="text-xs text-gray-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color || 'text-gray-900'}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Postage by Product Category (30d)</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={categoryData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => '$' + (v / 1000).toFixed(0) + 'k'} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmt(v)} />
              <Bar dataKey="postage" fill="#3b82f6" name="Postage" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Quoted Postage by Fulfillment Path (30d)</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={pathData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={(v) => '$' + (v / 1000).toFixed(0) + 'k'} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmt(v)} />
              <Bar dataKey="Quoted" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* AI Summary */}
      {aiSummary && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-blue-800 mb-2">AI Daily Summary</h2>
          <p className="text-sm text-blue-900 whitespace-pre-wrap">{aiSummary}</p>
        </div>
      )}
    </div>
  );
}
