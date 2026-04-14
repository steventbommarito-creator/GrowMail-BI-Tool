'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtK = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return (n < 0 ? '-' : '') + '$' + (abs / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
};

const dayLabel = (dateStr) => {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
};

// Custom tooltip for the chart
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-lg shadow-lg p-3 text-xs space-y-1"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 180 }}>
      <p className="font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{dayLabel(data.date)}</p>
      <p style={{ color: 'var(--text-muted)' }}>Start Balance: <span style={{ color: data.startBalance >= 0 ? 'var(--status-ok)' : 'var(--status-critical)', fontWeight: 600 }}>{fmt$(data.startBalance)}</span></p>
      {data.deposits > 0 && <p style={{ color: 'var(--accent)' }}>+ Deposit: {fmt$(data.deposits)}</p>}
      {data.postage > 0 && <p style={{ color: 'var(--status-warn)' }}>− Postage: {fmt$(data.postage)} ({data.dropCount} drop{data.dropCount !== 1 ? 's' : ''})</p>}
      <p style={{ color: data.endBalance >= 0 ? 'var(--status-ok)' : 'var(--status-critical)', fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
        End Balance: {fmt$(data.endBalance)}
      </p>
    </div>
  );
}

export default function OverviewPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/overview-summary');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = data?.stats;
  const dayData = data?.dayData || [];

  // Determine runway status color
  const runOutDate = stats?.runOutDate;
  const daysUntilRunOut = runOutDate
    ? Math.ceil((new Date(runOutDate + 'T12:00:00') - new Date()) / (1000 * 60 * 60 * 24))
    : null;
  const runwayColor = daysUntilRunOut == null ? 'var(--status-ok)'
    : daysUntilRunOut <= 3 ? 'var(--status-critical)'
    : daysUntilRunOut <= 7 ? 'var(--status-warn)'
    : 'var(--status-ok)';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Overview</h1>
          {lastUpdated && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Updated {lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Detroit' })} ET
            </p>
          )}
        </div>
        <button onClick={load} disabled={loading}
          className="text-sm px-3 py-1.5 rounded font-medium flex items-center gap-1.5"
          style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: loading ? 'not-allowed' : 'pointer' }}>
          {loading ? (
            <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>↻</span> Refreshing…</>
          ) : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)', border: '1px solid var(--status-critical)' }}>
          {error.includes('OPENAI') || error.includes('openai') || error.includes('API key')
            ? 'OpenAI API key not configured. Add OPENAI_API_KEY to your environment variables.'
            : `Error loading summary: ${error}`}
        </div>
      )}

      {/* AI Summary card */}
      <div className="rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-semibold px-2 py-0.5 rounded"
            style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>AI Summary</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Updates on each data refresh</span>
        </div>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-4 rounded animate-pulse" style={{ background: 'var(--surface2)', width: i === 3 ? '60%' : '100%' }} />
            ))}
          </div>
        ) : (
          <p className="text-base leading-relaxed" style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>
            "{data?.summary}"
          </p>
        )}
      </div>

      {/* KPI strip */}
      {stats && (
        <div className="grid grid-cols-2 gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {[
            { label: 'EPS Balance', value: fmt$(stats.currentBalance), color: stats.currentBalance >= 0 ? 'var(--status-ok)' : 'var(--status-critical)' },
            { label: 'Late Drops', value: `${stats.pastDueCount} drops`, sub: fmt$(stats.pastDuePostage), color: stats.pastDueCount > 0 ? 'var(--status-warn)' : 'var(--status-ok)' },
            { label: 'Postage Needed Today', value: fmt$(stats.todayPostage), color: 'var(--text-primary)' },
            { label: 'Balance Runs Out', value: runOutDate ? dayLabel(runOutDate) : 'Stays positive', color: runwayColor },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="text-xl font-bold" style={{ color }}>{loading ? '—' : value}</p>
              {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub} in postage</p>}
            </div>
          ))}
        </div>
      )}

      {/* Cashflow burn chart */}
      <div className="rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>EPS Cashflow — Next 14 Days</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Running balance after daily postage and projected deposits</p>
          </div>
          {runOutDate && (
            <span className="text-xs font-semibold px-2 py-1 rounded"
              style={{ background: daysUntilRunOut <= 3 ? 'var(--status-critical-bg)' : 'var(--status-warn-bg)', color: runwayColor, border: `1px solid ${runwayColor}` }}>
              ⚠ Runs out {dayLabel(runOutDate)}
            </span>
          )}
        </div>

        {loading ? (
          <div className="h-72 rounded animate-pulse" style={{ background: 'var(--surface2)' }} />
        ) : dayData.length === 0 ? (
          <p className="text-sm text-center py-12" style={{ color: 'var(--text-muted)' }}>No upcoming drop data.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={dayData.filter(d => !d.isPastDue)} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => {
                  const dt = new Date(d + 'T12:00:00');
                  return dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
                }}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              />
              <YAxis
                tickFormatter={fmtK}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                width={52}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                formatter={(value) => ({
                  postage: 'Postage Due',
                  deposits: 'Projected Deposit',
                  endBalance: 'End Balance',
                }[value] || value)}
                wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }}
              />
              <ReferenceLine y={0} stroke="var(--status-critical)" strokeDasharray="4 4" strokeWidth={1.5} />
              {/* Postage bars — negative direction */}
              <Bar dataKey="postage" name="postage" fill="var(--status-warn)" opacity={0.75} radius={[2, 2, 0, 0]} />
              {/* Deposit bars */}
              <Bar dataKey="deposits" name="deposits" fill="var(--accent)" opacity={0.8} radius={[2, 2, 0, 0]} />
              {/* Running end balance line */}
              <Line
                type="monotone"
                dataKey="endBalance"
                name="endBalance"
                stroke="var(--accent)"
                strokeWidth={2.5}
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  const color = payload.endBalance < 0 ? 'var(--status-critical)' : 'var(--accent)';
                  return <circle key={`dot-${payload.date}`} cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />;
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Day breakdown table */}
      {!loading && dayData.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Day-by-Day Breakdown — Next 14 Days</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: 'var(--surface2)' }}>
                <tr>
                  {['Date', 'Start Balance', '+ Deposit', '− Postage', 'Drops', 'End Balance'].map(h => (
                    <th key={h} className="text-left px-4 py-2 text-xs font-semibold"
                      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dayData.map((row, i) => {
                  const isPastDue = row.isPastDue;
                  const stripeIdx = dayData.filter((r, ri) => !r.isPastDue && ri <= i).length - 1;
                  return (
                    <>
                      {/* Past-due row */}
                      {isPastDue && (
                        <tr key="past-due" style={{
                          background: 'var(--status-warn-bg)',
                          borderBottom: '1px solid var(--border)',
                          borderLeft: '3px solid var(--status-warn)',
                        }}>
                          <td className="px-4 py-2.5 font-semibold" style={{ color: 'var(--status-warn)' }}>
                            ⚠ Past Due ({row.dropCount} drops)
                          </td>
                          <td className="px-4 py-2.5" style={{ color: row.startBalance < 0 ? 'var(--status-critical)' : 'var(--text-secondary)' }}>{fmt$(row.startBalance)}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>—</td>
                          <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--status-warn)' }}>−{fmt$(row.postage)}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>{row.dropCount}</td>
                          <td className="px-4 py-2.5 font-semibold" style={{ color: row.isGap ? 'var(--status-critical)' : 'var(--status-warn)' }}>{fmt$(row.endBalance)}</td>
                        </tr>
                      )}

                      {/* Divider before first non-past-due row */}
                      {!isPastDue && i > 0 && dayData[i - 1]?.isPastDue && (
                        <tr key="divider">
                          <td colSpan={6} className="px-4 py-1 text-xs font-semibold uppercase tracking-wide"
                            style={{ background: 'var(--surface2)', color: 'var(--text-muted)', borderTop: '2px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                            Today & Forward
                          </td>
                        </tr>
                      )}

                      {/* Regular date row */}
                      {!isPastDue && (
                        <tr key={row.date} style={{
                          background: row.isGap ? 'var(--status-critical-bg)' : stripeIdx % 2 === 0 ? 'var(--surface)' : 'var(--surface2)',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--text-primary)' }}>{dayLabel(row.date)}</td>
                          <td className="px-4 py-2.5" style={{ color: row.startBalance < 0 ? 'var(--status-critical)' : 'var(--text-secondary)' }}>{fmt$(row.startBalance)}</td>
                          <td className="px-4 py-2.5" style={{ color: row.deposits > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {row.deposits > 0 ? `+${fmt$(row.deposits)}` : '—'}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: row.postage > 0 ? 'var(--status-warn)' : 'var(--text-muted)' }}>
                            {row.postage > 0 ? `−${fmt$(row.postage)}` : '—'}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>{row.dropCount || '—'}</td>
                          <td className="px-4 py-2.5 font-semibold" style={{ color: row.isGap ? 'var(--status-critical)' : 'var(--status-ok)' }}>{fmt$(row.endBalance)}</td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
