'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { createClient } from '../../lib/supabase';

const ET = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Detroit', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};

const fmtBytes = (b) => {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const severityStyle = (s) => {
  const map = { error: 'var(--status-critical)', warning: 'var(--status-warn)', info: 'var(--status-ok)', success: 'var(--status-ok)' };
  const bgMap = { error: 'var(--status-critical-bg)', warning: 'var(--status-warn-bg)', info: 'var(--status-ok-bg)', success: 'var(--status-ok-bg)' };
  return { color: map[s] || 'var(--text-secondary)', background: bgMap[s] || 'var(--surface2)' };
};

function HygieneContent() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') === 'feed' ? 'feed' : 'hygiene');
  const supabase = createClient();

  // Hygiene state
  const [syncLogs, setSyncLogs] = useState({});
  const [loading, setLoading] = useState(true);

  // Feed state
  const [notifications, setNotifications] = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedPage, setFeedPage] = useState(0);
  const PAGE_SIZE = 30;

  const loadHygiene = useCallback(async () => {
    setLoading(true);
    // Get last 10 syncs per source
    const { data } = await supabase
      .from('sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50);

    const grouped = {};
    for (const row of data || []) {
      if (!grouped[row.source]) grouped[row.source] = [];
      if (grouped[row.source].length < 10) grouped[row.source].push(row);
    }
    setSyncLogs(grouped);
    setLoading(false);
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true);
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .range(feedPage * PAGE_SIZE, (feedPage + 1) * PAGE_SIZE - 1);
    setNotifications(prev => feedPage === 0 ? (data || []) : [...prev, ...(data || [])]);
    setFeedLoading(false);
  }, [feedPage]);

  useEffect(() => { loadHygiene(); }, [loadHygiene]);
  useEffect(() => { if (tab === 'feed') loadFeed(); }, [tab, loadFeed]);

  const sources = ['osprey', 'usps'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {tab === 'hygiene' ? 'Data Hygiene' : 'Activity Log'}
        </h1>
        <div className="flex gap-2">
          {['hygiene', 'feed'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className="text-sm px-3 py-1 rounded font-medium"
              style={{
                background: tab === t ? 'var(--accent)' : 'var(--surface2)',
                color: tab === t ? 'var(--accent-text)' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}>
              {t === 'hygiene' ? 'Data Sources' : '📰 Activity Log'}
            </button>
          ))}
        </div>
      </div>

      {/* DATA HYGIENE TAB */}
      {tab === 'hygiene' && (
        <div className="space-y-6">
          {sources.map(source => {
            const logs = syncLogs[source] || [];
            const latest = logs[0];
            const rowCounts = logs.map(l => l.row_count).filter(Boolean);
            const avgRows = rowCounts.length ? Math.round(rowCounts.reduce((a, b) => a + b, 0) / rowCounts.length) : null;
            const isStale = latest ? (Date.now() - new Date(latest.completed_at || latest.started_at).getTime()) > 8 * 60 * 60 * 1000 : true;
            const hasAnomaly = latest && avgRows && latest.row_count < avgRows * 0.8;

            return (
              <div key={source} className="rounded-xl p-4 border"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
                      {source.toUpperCase()}
                    </h2>
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={severityStyle(latest?.status === 'success' && !isStale ? 'success' : isStale ? 'warning' : 'error')}>
                      {latest?.status === 'success' && !isStale ? 'OK' : isStale ? 'STALE' : 'ERROR'}
                    </span>
                    {hasAnomaly && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={severityStyle('warning')}>
                        ROW ANOMALY
                      </span>
                    )}
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Last sync: {latest ? ET(latest.completed_at || latest.started_at) : 'Never'}
                  </span>
                </div>

                {/* Latest sync stats */}
                {latest && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {[
                      { label: 'Rows', value: latest.row_count?.toLocaleString() || '—' },
                      { label: 'File Size', value: fmtBytes(latest.file_size_bytes) },
                      { label: 'Duration', value: latest.duration_seconds ? `${latest.duration_seconds.toFixed(1)}s` : '—' },
                      { label: 'Triggered By', value: latest.triggered_by || '—' },
                    ].map(k => (
                      <div key={k.label} className="rounded p-2"
                        style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
                        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{k.value}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Sync history table */}
                {logs.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          {['Time (ET)', 'Status', 'Rows', 'File Size', 'Duration', 'By'].map(h => (
                            <th key={h} className="text-left py-1 px-2 font-medium"
                              style={{ color: 'var(--text-muted)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {logs.map((l, i) => (
                          <tr key={l.id} style={{
                            borderBottom: '1px solid var(--border)',
                            background: i % 2 === 0 ? 'transparent' : 'var(--surface2)',
                          }}>
                            <td className="py-1 px-2" style={{ color: 'var(--text-secondary)' }}>{ET(l.started_at)}</td>
                            <td className="py-1 px-2">
                              <span className="px-1.5 py-0.5 rounded text-xs font-medium"
                                style={severityStyle(l.status === 'success' ? 'success' : 'error')}>
                                {l.status?.toUpperCase() || '—'}
                              </span>
                            </td>
                            <td className="py-1 px-2" style={{ color: 'var(--text-secondary)' }}>
                              {l.row_count?.toLocaleString() || '—'}
                              {avgRows && l.row_count && Math.abs(l.row_count - avgRows) / avgRows > 0.15 && (
                                <span className="ml-1" style={{ color: 'var(--status-warn)' }}>⚠</span>
                              )}
                            </td>
                            <td className="py-1 px-2" style={{ color: 'var(--text-secondary)' }}>{fmtBytes(l.file_size_bytes)}</td>
                            <td className="py-1 px-2" style={{ color: 'var(--text-secondary)' }}>
                              {l.duration_seconds ? `${l.duration_seconds.toFixed(1)}s` : '—'}
                            </td>
                            <td className="py-1 px-2" style={{ color: 'var(--text-muted)' }}>{l.triggered_by || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {logs.length === 0 && !loading && (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No sync history yet.</p>
                )}
                {latest?.error_message && (
                  <div className="mt-3 p-2 rounded text-xs" style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)' }}>
                    Last error: {latest.error_message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* NEWS FEED TAB */}
      {tab === 'feed' && (
        <div>
          <div className="space-y-2">
            {notifications.map(n => (
              <div key={n.id} className="rounded-lg p-3 border flex gap-3"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="flex-shrink-0 mt-0.5">
                  <span className="w-2 h-2 rounded-full block mt-1"
                    style={{ background: 'var(--border)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold px-1.5 py-0.5 rounded"
                      style={severityStyle(n.severity)}>
                      {n.severity?.toUpperCase()}
                    </span>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {n.title}
                    </span>
                    <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
                      {ET(n.created_at)}
                    </span>
                  </div>
                  {n.body && (
                    <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{n.body}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {!feedLoading && notifications.length === 0 && (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No notifications yet.</p>
          )}

          {!feedLoading && notifications.length >= (feedPage + 1) * PAGE_SIZE && (
            <button onClick={() => setFeedPage(p => p + 1)}
              className="mt-4 w-full text-sm py-2 rounded"
              style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function HygienePage() {
  return (
    <Suspense>
      <HygieneContent />
    </Suspense>
  );
}
