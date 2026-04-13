'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { createClient } from '../lib/supabase';
import { useTheme } from '../context/ThemeContext';

export default function Nav() {
  const pathname = usePathname();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const [triggerStatus, setTriggerStatus] = useState({});
  const [triggerError, setTriggerError] = useState({});
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeRef = useRef(null);

  const links = [
    { href: '/', label: 'Overview' },
    { href: '/forecast', label: 'Forecast' },
    { href: '/cashflow', label: 'Cashflow' },
    { href: '/actuals', label: 'Actuals' },
    { href: '/hygiene', label: 'Data Hygiene' },
  ];


  useEffect(() => {
    function handleClick(e) {
      if (themeRef.current && !themeRef.current.contains(e.target)) {
        setShowThemeMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  async function triggerScraper(source) {
    setTriggerStatus(s => ({ ...s, [source]: 'running' }));
    setTriggerError(s => ({ ...s, [source]: null }));
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (data.ok) {
        setTriggerStatus(s => ({ ...s, [source]: 'done' }));
      } else {
        setTriggerStatus(s => ({ ...s, [source]: 'error' }));
        setTriggerError(s => ({ ...s, [source]: data.error || 'Unknown error' }));
        console.error(`Trigger ${source} failed:`, data.error);
        alert(`Sync ${source.toUpperCase()} failed:\n${data.error}`);
      }
    } catch (err) {
      setTriggerStatus(s => ({ ...s, [source]: 'error' }));
      setTriggerError(s => ({ ...s, [source]: err.message }));
      alert(`Sync ${source.toUpperCase()} error:\n${err.message}`);
    }
    setTimeout(() => setTriggerStatus(s => ({ ...s, [source]: 'idle' })), 4000);
  }

  function triggerLabel(source) {
    const s = triggerStatus[source];
    if (s === 'running') return '⟳ Running…';
    if (s === 'done') return '✓ Triggered';
    if (s === 'error') return '✗ Error';
    return `Sync ${source.toUpperCase()}`;
  }

  return (
    <nav style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      className="px-4 py-2 flex items-center justify-between gap-4 flex-wrap">

      <div className="flex items-center gap-5 flex-wrap">
        <span className="font-bold text-base" style={{ color: 'var(--accent)' }}>
          GrowMail BI
        </span>
        {links.map((l) => (
          <Link key={l.href} href={l.href}
            style={{
              color: pathname === l.href ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: pathname === l.href ? '2px solid var(--accent)' : '2px solid transparent',
              paddingBottom: '2px',
            }}
            className="text-sm font-medium transition-colors whitespace-nowrap"
          >
            {l.label}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {['osprey', 'usps'].map(source => (
          <button key={source}
            onClick={() => triggerScraper(source)}
            disabled={triggerStatus[source] === 'running'}
            className="text-xs px-2 py-1 rounded font-medium transition-all whitespace-nowrap"
            style={{
              background: triggerStatus[source] === 'done' ? 'var(--status-ok-bg)' :
                          triggerStatus[source] === 'error' ? 'var(--status-critical-bg)' : 'var(--surface2)',
              color: triggerStatus[source] === 'done' ? 'var(--status-ok)' :
                     triggerStatus[source] === 'error' ? 'var(--status-critical)' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              opacity: triggerStatus[source] === 'running' ? 0.7 : 1,
            }}
          >
            {triggerLabel(source)}
          </button>
        ))}

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
    </nav>
  );
}
