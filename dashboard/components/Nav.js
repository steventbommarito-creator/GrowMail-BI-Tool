'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '../lib/supabase';
import { useTheme } from '../context/ThemeContext';
import PresenceAvatars from './PresenceAvatars';
import LiveCursors from './LiveCursors';

const ET_short = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Detroit', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
};

export default function Nav() {
  const pathname = usePathname();
  // Don't render Nav (or create a Supabase client) on the login page —
  // having two GoTrueClient instances on the same page causes undefined behavior.
  if (pathname === '/login') return null;
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const [triggerStatus, setTriggerStatus] = useState({});   // idle | running | done | error
  const [lastSync, setLastSync] = useState({});             // { osprey: { time, status }, usps: ... }
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeRef = useRef(null);
  const pollRefs = useRef({});

  const links = [
    { href: '/late-mailings', label: 'Late Mailings' },
    { href: '/mailing-timeliness', label: 'Mailing Timeliness' },
    { href: '/overview', label: 'Overview' },
    { href: '/forecast', label: 'Forecast' },
    { href: '/cashflow', label: 'Cashflow' },
    { href: '/actuals', label: 'Actuals' },
    { href: '/hygiene', label: 'Data Hygiene' },
    { href: '/crm', label: 'CRM Integration' },
  ];

  // Load last sync times on mount
  const loadLastSync = useCallback(async () => {
    const { data } = await supabase
      .from('sync_log')
      .select('source, completed_at, started_at, status')
      .order('started_at', { ascending: false })
      .limit(20);
    if (!data) return;
    const latest = {};
    for (const row of data) {
      if (!latest[row.source]) {
        latest[row.source] = { time: row.completed_at || row.started_at, status: row.status };
      }
    }
    setLastSync(latest);
  }, []);

  useEffect(() => { loadLastSync(); }, [loadLastSync]);

  // Poll sync_log until a new completed entry appears for this source
  function startPolling(source, triggeredAt) {
    // Clear any existing poll for this source
    if (pollRefs.current[source]) clearInterval(pollRefs.current[source]);

    pollRefs.current[source] = setInterval(async () => {
      const { data } = await supabase
        .from('sync_log')
        .select('source, completed_at, started_at, status')
        .eq('source', source)
        .gt('started_at', triggeredAt)
        .order('started_at', { ascending: false })
        .limit(1);

      const row = data?.[0];
      if (row?.completed_at) {
        clearInterval(pollRefs.current[source]);
        pollRefs.current[source] = null;
        setLastSync(s => ({ ...s, [source]: { time: row.completed_at, status: row.status } }));
        setTriggerStatus(s => ({ ...s, [source]: row.status === 'success' ? 'done' : 'error' }));
        setTimeout(() => setTriggerStatus(s => ({ ...s, [source]: 'idle' })), 5000);
      }
    }, 8000); // poll every 8s
  }

  useEffect(() => {
    function handleClick(e) {
      if (themeRef.current && !themeRef.current.contains(e.target)) setShowThemeMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      // Clear all polls on unmount
      Object.values(pollRefs.current).forEach(t => t && clearInterval(t));
    };
  }, []);

  async function triggerScraper(source) {
    const triggeredAt = new Date().toISOString();
    setTriggerStatus(s => ({ ...s, [source]: 'running' }));
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (data.ok) {
        // Stay in 'running' state and poll for job completion
        startPolling(source, triggeredAt);
      } else {
        setTriggerStatus(s => ({ ...s, [source]: 'error' }));
        console.error(`Trigger ${source} failed:`, data.error);
        alert(`Sync ${source.toUpperCase()} failed:\n${data.error}`);
      }
    } catch (err) {
      setTriggerStatus(s => ({ ...s, [source]: 'error' }));
      alert(`Sync ${source.toUpperCase()} error:\n${err.message}`);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <nav style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      className="px-4 py-2 flex items-center justify-between gap-4 flex-wrap">

      <div className="flex items-center gap-5 flex-wrap">
        <span className="font-bold text-base" style={{ color: 'var(--accent)' }}>GrowMail BI</span>
        {links.map((l) => (
          <Link key={l.href} href={l.href}
            style={{
              color: pathname === l.href ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: pathname === l.href ? '2px solid var(--accent)' : '2px solid transparent',
              paddingBottom: '2px',
            }}
            className="text-sm font-medium transition-colors whitespace-nowrap">
            {l.label}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <PresenceAvatars />
        {['osprey', 'usps'].map(source => {
          const status = triggerStatus[source] || 'idle';
          const sync = lastSync[source];
          const isRunning = status === 'running';
          const isError = status === 'error';
          const isDone = status === 'done';

          return (
            <div key={source} className="flex flex-col items-center gap-0.5">
              <button
                onClick={() => triggerScraper(source)}
                disabled={isRunning}
                className="text-xs px-2 py-1 rounded font-medium transition-all whitespace-nowrap"
                style={{
                  background: isDone ? 'var(--status-ok-bg)' : isError ? 'var(--status-critical-bg)' : 'var(--surface2)',
                  color: isDone ? 'var(--status-ok)' : isError ? 'var(--status-critical)' : 'var(--text-secondary)',
                  border: `1px solid ${isError ? 'var(--status-critical)' : 'var(--border)'}`,
                  opacity: isRunning ? 0.7 : 1,
                }}>
                {isRunning ? '⟳ Running…' : isDone ? '✓ Done' : isError ? '↺ Retry' : `Sync ${source.toUpperCase()}`}
              </button>
              {sync?.time && (
                <span className="text-xs whitespace-nowrap" style={{
                  color: sync.status === 'error' ? 'var(--status-critical)' : 'var(--text-muted)',
                  fontSize: '10px',
                }}>
                  {sync.status === 'error' ? '✗ ' : ''}{ET_short(sync.time)}
                </span>
              )}
            </div>
          );
        })}

        <div className="relative" ref={themeRef}>
          <button onClick={() => setShowThemeMenu(v => !v)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            {theme === 'light' ? '☀' : theme === 'dark' ? '🌙' : '◑'}
          </button>
          {showThemeMenu && (
            <div className="absolute right-0 top-8 z-50 rounded shadow-lg py-1 min-w-24"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              {[{ value: 'light', label: '☀ Light' }, { value: 'dark', label: '🌙 Dark' }, { value: 'mono', label: '◑ Mono' }].map(t => (
                <button key={t.value}
                  onClick={() => { setTheme(t.value); setShowThemeMenu(false); }}
                  className="block w-full text-left px-3 py-1.5 text-xs"
                  style={{
                    color: theme === t.value ? 'var(--accent)' : 'var(--text-secondary)',
                    background: theme === t.value ? 'var(--accent-light)' : 'transparent',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <Link href="/hygiene?tab=feed" className="relative text-lg" title="Activity Log">
          <span style={{ color: 'var(--text-secondary)' }}>📰</span>
        </Link>

        <button onClick={handleSignOut} className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Sign out
        </button>
      </div>

      {/* Per-page cursor overlay. Channel name is scoped by pathname so cursors
          only appear between users viewing the same page — two people on
          /cashflow see each other, one on /forecast doesn't clutter the view. */}
      <LiveCursors channel={`cursors:${pathname}`} />
    </nav>
  );
}
