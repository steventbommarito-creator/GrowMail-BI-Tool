'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '../../lib/supabase';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const fmt = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

function weekLabel(dateStr) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ForecastPage() {
  const supabase = createClient();
  const [weeklyData, setWeeklyData] = useState([]);
  const [rateData, setRateData] = useState([]);
  const [avgPerPiece, setAvgPerPiece] = useState([]);
  const [aiForecast, setAiForecast] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];
    const in8Weeks = new Date(Date.now() + 8 * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    // Upcoming 8 weeks of scheduled drops
    const { data: upcoming } = await supabase
      .from('osprey_mail_drops')
      .select('drop_est_date, postage_amount, mail_drop_quantity')
      .gte('drop_est_date', today)
      .lte('drop_est_date', in8Weeks)
      .order('drop_est_date', { ascending: true });

    // Group by week
    const weekMap = {};
    for (const r of upcoming || []) {
      const d = new Date(r.drop_est_date);
      const ws = new Date(d);
      ws.setDate(d.getDate() - d.getDay());
      const label = ws.toISOString().split('T')[0];
      if (!weekMap[label]) weekMap[label] = { postage: 0, pieces: 0 };
      weekMap[label].postage += r.postage_amount || 0;
      weekMap[label].pieces += r.mail_drop_quantity || 0;
    }
    setWeeklyData(
      Object.entries(weekMap).map(([week, v]) => ({
        week: weekLabel(week),
        Postage: +v.postage.toFixed(2),
        Pieces: v.pieces,
      }))
    );

    // Postage rate trend by fulfillment path (last 90d, grouped by capture_date)
    const { data: rateRows } = await supabase
      .from('osprey_mail_drops')
      .select('capture_date, fulfillment_path, postage_amount')
      .gte('capture_date', since90)
      .not('fulfillment_path', 'is', null)
      .order('capture_date', { ascending: true });

    // Group by date + path, sum postage
    const rateMap = {};
    const pathSet = new Set();
    for (const r of rateRows || []) {
      const d = r.capture_date;
      const p = r.fulfillment_path;
      pathSet.add(p);
      if (!rateMap[d]) rateMap[d] = { date: d };
      rateMap[d][p] = (rateMap[d][p] || 0) + (r.postage_amount || 0);
    }
    setRateData(Object.values(rateMap).slice(-30)); // last 30 snapshots
    const paths = [...pathSet].filter(Boolean);

    // Avg postage per piece by category over time
    const { data: pieceCatRows } = await supabase
      .from('osprey_mail_drops')
      .select('capture_date, product_category, postage_amount, mail_drop_quantity')
      .gte('capture_date', since90)
      .not('product_category', 'is', null)
      .order('capture_date', { ascending: true });

    const pcMap = {};
    for (const r of pieceCatRows || []) {
      const d = r.capture_date;
      const c = r.product_category;
      if (!pcMap[d]) pcMap[d] = { date: d };
      if (!pcMap[d][`_s_${c}`]) pcMap[d][`_s_${c}`] = { postage: 0, pieces: 0 };
      pcMap[d][`_s_${c}`].postage += r.postage_amount || 0;
      pcMap[d][`_s_${c}`].pieces += r.mail_drop_quantity || 0;
    }
    const catSet = new Set(
      (pieceCatRows || []).map((r) => r.product_category).filter(Boolean)
    );
    const avgData = Object.values(pcMap).map((row) => {
      const out = { date: row.date };
      for (const c of catSet) {
        const agg = row[`_s_${c}`];
        out[c] = agg && agg.pieces ? +(agg.postage / agg.pieces).toFixed(4) : null;
      }
      return out;
    });
    setAvgPerPiece(avgData.slice(-30));

    // AI forecast
    const { data: insight } = await supabase
      .from('ai_insights')
      .select('narrative, generated_at')
      .eq('insight_type', 'forecast')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setAiForecast(insight?.narrative || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="text-gray-500 p-4">Loading...</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Postage Forecast</h1>

      {/* 8-week forecast bar chart */}
      <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          Scheduled Postage Liability — Next 8 Weeks
        </h2>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={weeklyData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="week" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={(v) => '$' + (v / 1000).toFixed(0) + 'k'} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, name) => (name === 'Postage' ? fmt(v) : v.toLocaleString())} />
            <Legend />
            <Bar dataKey="Postage" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Avg postage per piece by category */}
      <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          Avg Postage per Piece by Category (last 30 snapshots)
        </h2>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={avgPerPiece}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={(v) => '$' + v.toFixed(3)} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => v != null ? '$' + Number(v).toFixed(4) : '—'} />
            <Legend />
            {avgPerPiece.length > 0 &&
              Object.keys(avgPerPiece[0])
                .filter((k) => k !== 'date')
                .map((cat, i) => (
                  <Line
                    key={cat}
                    type="monotone"
                    dataKey={cat}
                    stroke={COLORS[i % COLORS.length]}
                    dot={false}
                    connectNulls
                  />
                ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* AI forecast */}
      {aiForecast && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-purple-800 mb-2">AI 7-Day Forecast</h2>
          <p className="text-sm text-purple-900 whitespace-pre-wrap">{aiForecast}</p>
        </div>
      )}
    </div>
  );
}
