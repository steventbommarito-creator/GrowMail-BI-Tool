'use client';

// Secret cursor easter egg. Toggle a custom cursor across the whole app with:
//   • Cmd + Ctrl + R   (macOS)
//   • Ctrl + Alt + R   (Windows / Linux)
// State persists in localStorage so it survives reloads + navigation.
//
// No UI — fully secret, only the shortcut reveals it. The actual cursor
// styling lives in globals.css under `html.custom-cursor` so it can use
// !important to override element-specific cursors (buttons, inputs, links).
//
// We deliberately avoid any shortcut involving Q: Cmd+Q quits the browser at
// the OS level (JS can't intercept it) and Ctrl+Cmd+Q locks the Mac screen.

import { useEffect } from 'react';

const STORAGE_KEY = 'gm_custom_cursor';
const CLASS_NAME  = 'custom-cursor';

export default function SecretCursor() {
  useEffect(() => {
    const root = document.documentElement;

    // Restore persisted state on mount.
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') root.classList.add(CLASS_NAME);
    } catch { /* localStorage blocked — ignore */ }

    const onKeyDown = (e) => {
      // Match Cmd+Ctrl+R (mac) OR Ctrl+Alt+R (win/linux). Require Ctrl plus
      // one of (Meta | Alt) so a plain Cmd+R reload never trips it.
      const isR = (e.key === 'r' || e.key === 'R' || e.code === 'KeyR');
      const combo = e.ctrlKey && (e.metaKey || e.altKey);
      if (!isR || !combo) return;

      e.preventDefault();
      e.stopPropagation();

      const on = root.classList.toggle(CLASS_NAME);
      try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;  // renders nothing
}
