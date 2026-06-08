'use client';

// CRM Overview — activity feed for every CRM event. This is the default page
// for /crm. Reads top-down from crm_events; filters are client-side over the
// last 500 rows because the table is bounded to ~90 days of data.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { createClient } from '../../lib/supabase';

const STATUS_COLORS = {
  success: { bg: 'var(--status-ok-bg)',       fg: 'var(--status-ok)'       },
  info:    { bg: 'var(--surface2)',           fg: 'var(--text-secondary)'  },
  warning: { bg: 'var(--status-warn-bg)',     fg: 'var(--status-warn)'     },
  error:   { bg: 'var(--status-critical-bg)', fg: 'var(--status-critical)' },
};

const ET = (iso) => iso
  ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Detroit', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—';

export default function CrmOverviewPage() {
  const supabase = createClient();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | success | info | warning | error
  const [typeFilter, setTypeFilter]     = useState('all');
  const [expanded, setExpanded] = useState({}); // event_id → bool

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('crm_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) console.error('Failed to load crm_events:', error.message);
    setEvents(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Build the unique event_type list for the filter dropdown.
  const types = useMemo(() => {
    const s = new Set(); for (const e of events) if (e.event_type) s.add(e.event_type);
    return [...s].sort();
  }, [events]);

  const filtered = useMemo(() => events.filter(e =>
    (statusFilter === 'all' || e.status === statusFilter) &&
    (typeFilter   === 'all' || e.event_type === typeFilter)
  ), [events, statusFilter, typeFilter]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Activity Feed ({filtered.length}{filtered.length !== events.length ? ` of ${events.length}` : ''})
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              All CRM sync activity from the last 90 days. Most recent first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              <option value="all">All statuses</option>
              <option value="success">Success</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
              <option value="all">All event types</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={load}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
              ↻ Refresh
            </button>
          </div>
        </div>

        {loading && (
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No events yet. CRM activity will appear here once you configure the integration and start syncing.
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map(e => {
              const color = STATUS_COLORS[e.status] || STATUS_COLORS.info;
              const isExp = !!expanded[e.id];
              const hasData = e.data_json && Object.keys(e.data_json).length > 0;
              return (
                <li key={e.id}
                  style={{ borderBottom: '1px solid var(--border)' }}>
                  <button
                    onClick={() => hasData && setExpanded(prev => ({ ...prev, [e.id]: !prev[e.id] }))}
                    style={{
                      width: '100%', textAlign: 'left',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      padding: '10px 16px',
                      background: 'transparent', border: 'none',
                      cursor: hasData ? 'pointer' : 'default',
                    }}>
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded mt-0.5"
                      style={{ background: color.bg, color: color.fg, whiteSpace: 'nowrap' }}>
                      {(e.status || 'info').toUpperCase()}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p className="text-sm" style={{ color: 'var(--text-primary)', margin: 0, fontWeight: 500 }}>
                        {e.title}
                      </p>
                      {e.body && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)', margin: '2px 0 0' }}>
                          {e.body}
                        </p>
                      )}
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {ET(e.created_at)} · {e.event_type} · {e.created_by || 'unknown'}
                        {e.entity_id && <> · <span style={{ fontFamily: 'monospace' }}>{e.entity_type}:{e.entity_id}</span></>}
                      </p>
                    </div>
                    {hasData && (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isExp ? '▾' : '▸'}</span>
                    )}
                  </button>
                  {isExp && hasData && (
                    <pre className="text-[10px] px-16 py-2"
                      style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', overflow: 'auto', margin: 0 }}>
                      {JSON.stringify(e.data_json, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
