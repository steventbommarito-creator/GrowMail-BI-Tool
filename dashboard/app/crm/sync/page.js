'use client';

// Sync Status — at-a-glance counts for the Osprey→Freshworks syncs and the
// one-time SFDC imports. Reads /api/crm/sync-status (state tables the cloud
// jobs write to). Stat tiles for headline numbers; one proportion bar for deal
// stages using the app's reserved status colors (Won=ok, Quoted=warn, Lost=critical).
import { useEffect, useState, useCallback } from 'react';

const ET = (iso) => iso ? new Date(iso).toLocaleString('en-US', {
  timeZone: 'America/Detroit', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
}) : '—';
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

function Tile({ label, value, tone }) {
  const color = tone ? `var(--status-${tone})` : 'var(--text-primary)';
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
      <div className="text-2xl font-semibold" style={{ color }}>{value}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

function Card({ title, subtitle, lastSync, children }) {
  return (
    <section style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>{title}</h2>
          {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
        </div>
        {lastSync !== undefined && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>last sync&nbsp;·&nbsp;{ET(lastSync)}</span>
        )}
      </div>
      {children}
    </section>
  );
}

// Proportion bar: Won / Quoted / Lost, status colors, 2px surface gaps, hover titles.
function StageBar({ won, quoted, lost }) {
  const total = won + quoted + lost || 1;
  const segs = [
    { key: 'Won', n: won, tone: 'ok' },
    { key: 'Quoted', n: quoted, tone: 'warn' },
    { key: 'Lost', n: lost, tone: 'critical' },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--surface)' }}>
        {segs.map((s) => s.n > 0 && (
          <div key={s.key} title={`${s.key}: ${fmt(s.n)} (${Math.round((s.n / total) * 100)}%)`}
            style={{ width: `${(s.n / total) * 100}%`, background: `var(--status-${s.tone})`, borderRadius: 3 }} />
        ))}
      </div>
      <div className="flex gap-4 mt-2 flex-wrap">
        {segs.map((s) => (
          <span key={s.key} className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: `var(--status-${s.tone})`, display: 'inline-block' }} />
            {s.key} <b style={{ color: 'var(--text-primary)' }}>{fmt(s.n)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function ImportRow({ label, imp }) {
  if (!imp) return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}: not started</div>;
  const done = imp.status === 'complete';
  return (
    <div className="flex items-center justify-between py-1.5" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="text-xs px-1.5 py-0.5 rounded" style={{
          background: done ? 'var(--status-ok-bg)' : 'var(--surface)', color: done ? 'var(--status-ok)' : 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}>{imp.status}</span>
      </div>
      <div className="flex gap-4 text-xs">
        <span style={{ color: 'var(--status-ok)' }}>{fmt(imp.sent)} sent</span>
        {imp.pending > 0 && <span style={{ color: 'var(--text-muted)' }}>{fmt(imp.pending)} pending</span>}
        {(imp.failed + imp.validation_failed) > 0 && <span style={{ color: 'var(--status-critical)' }}>{fmt(imp.failed + imp.validation_failed)} failed</span>}
        <span style={{ color: 'var(--text-muted)' }}>of {fmt(imp.total)}</span>
      </div>
    </div>
  );
}

export default function SyncStatusPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/crm/sync-status');
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      setData(j); setErr(null);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // refresh every 30s
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Sync Status</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Osprey → Freshworks syncs & SFDC imports · auto-refreshes every 30s</p>
        </div>
        <button onClick={load} className="text-xs px-2 py-1 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          {loading ? '⟳' : '↻'} Refresh
        </button>
      </div>

      {err && <div className="text-sm" style={{ color: 'var(--status-critical)' }}>Error: {err}</div>}
      {!data && !err && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {data && (
        <>
          <Card title="Osprey → Freshworks · Deals" subtitle="One deal per order, from the Gordon & Lance report" lastSync={data.deals.lastSync}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Tile label="Deals synced" value={fmt(data.deals.total)} />
              <Tile label="Won" value={fmt(data.deals.won)} tone="ok" />
              <Tile label="Quoted (open)" value={fmt(data.deals.quoted)} tone="warn" />
              <Tile label="Lost" value={fmt(data.deals.lost)} tone="critical" />
            </div>
            <StageBar won={data.deals.won} quoted={data.deals.quoted} lost={data.deals.lost} />
            <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>{fmt(data.deals.excluded)} INCOMPLETE orders tracked but excluded (no deal).</p>
          </Card>

          <Card title="Osprey → Freshworks · Leads" subtitle="New Osprey users → Freshworks leads, deduped by email" lastSync={data.leads.lastSync}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tile label="Leads created" value={fmt(data.leads.created)} tone="ok" />
              <Tile label="Already existed" value={fmt(data.leads.exists)} />
              <Tile label="No email" value={fmt(data.leads.noEmail)} />
              <Tile label="Users evaluated" value={fmt(data.leads.total)} />
            </div>
          </Card>

          <Card title="One-time SFDC Imports">
            <ImportRow label="Opportunities → Deals" imp={data.imports.opportunities} />
            <ImportRow label="Activities → Tasks" imp={data.imports.tasks} />
          </Card>
        </>
      )}
    </div>
  );
}
