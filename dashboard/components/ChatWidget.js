'use client';

// AI chat widget — natural-language analyst over our Supabase schema.
//
// Behavior
// --------
// • Floats bottom-right. Collapsed: a circular pill button. Expanded: a panel.
// • Email-gated: only renders for the allowlist (see CHAT_ALLOWED_EMAILS).
// • Resizable from the upper-left corner — the panel's right + bottom edges
//   stay anchored to the page's bottom-right, so dragging up/left grows it
//   toward the user's natural mouse target.
// • Persists size + collapsed state in localStorage so it survives nav.
//
// Each turn:
//   - User types a question, hits Enter / Send.
//   - We POST the full message history to /api/chat.
//   - The reply may contain: explanation (markdown-light), sql, rows (array).
//   - We render the explanation, then the rows as a table.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '../lib/supabase';

const CHAT_ALLOWED_EMAILS = new Set([
  'steveb@growmail.com',
  'steven.t.bommarito@gmail.com',
]);

const STORAGE_KEY = 'chat-widget-state-v1';

const DEFAULTS = {
  width: 420,
  height: 580,
  open: false,
};

const MIN = { w: 320, h: 360 };
const MAX = { w: 1100, h: 900 };

export default function ChatWidget() {
  const supabase = createClient();
  const [userEmail, setUserEmail] = useState(null); // null = unknown yet
  const [open, setOpen] = useState(DEFAULTS.open);
  const [size, setSize] = useState({ w: DEFAULTS.width, h: DEFAULTS.height });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef(null);
  const resizingRef = useRef(null);   // { startX, startY, startW, startH }

  // Email check — render nothing if not authorized. Done client-side; the API
  // route enforces server-side too so this is just to avoid showing the icon.
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUserEmail(data?.user?.email || '');
    });
    return () => { cancelled = true; };
  }, [supabase]);

  // Restore persisted state on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.width && s.height) setSize({ w: s.width, h: s.height });
        if (typeof s.open === 'boolean') setOpen(s.open);
      }
    } catch {}
  }, []);

  // Persist on change.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: size.w, height: size.h, open }));
    } catch {}
  }, [size, open]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, sending]);

  // ── Resize from upper-left corner ──────────────────────────────────────
  // The panel is anchored bottom: 24px, right: 24px. We grow up/left by
  // increasing width/height. dx is positive when the mouse moves LEFT (so
  // the panel grows wider), same idea for dy + UP.
  const onResizeStart = (e) => {
    e.preventDefault(); e.stopPropagation();
    resizingRef.current = {
      startX: e.clientX, startY: e.clientY,
      startW: size.w,   startH: size.h,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';
  };
  useEffect(() => {
    const onMove = (e) => {
      const r = resizingRef.current;
      if (!r) return;
      const dx = r.startX - e.clientX;    // mouse moved left → positive
      const dy = r.startY - e.clientY;    // mouse moved up → positive
      const w = Math.min(MAX.w, Math.max(MIN.w, r.startW + dx));
      const h = Math.min(MAX.h, Math.max(MIN.h, r.startH + dy));
      setSize({ w, h });
    };
    const onUp = () => {
      if (resizingRef.current) {
        resizingRef.current = null;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Send message ──────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setSending(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const j = await res.json();
      if (!j.ok) {
        setMessages(m => [...m, { role: 'assistant', error: j.error || 'Unknown error', sql: j.sql }]);
      } else {
        setMessages(m => [...m, {
          role: 'assistant',
          content: j.explanation || '',
          sql: j.sql,
          rows: j.rows || [],
        }]);
      }
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', error: e.message }]);
    }
    setSending(false);
  }, [draft, sending, messages]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Bail before rendering if user isn't authorized.
  if (userEmail === null) return null;           // auth still loading
  if (!CHAT_ALLOWED_EMAILS.has(userEmail)) return null;

  // ── Collapsed: just the trigger button ────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask the data agent"
        aria-label="Open data chat"
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9000,
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--accent)',
          color: '#fff', border: 'none', cursor: 'pointer',
          fontSize: 22, lineHeight: 1,
          boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        💬
      </button>
    );
  }

  // ── Expanded: panel ────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9000,
      width: size.w, height: size.h,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 10px 32px rgba(0,0,0,0.4)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Upper-left resize handle. Visible diagonal grip so users know it's draggable. */}
      <div
        onMouseDown={onResizeStart}
        title="Drag to resize"
        style={{
          position: 'absolute', top: 0, left: 0,
          width: 18, height: 18,
          cursor: 'nwse-resize',
          zIndex: 2,
          background: 'transparent',
        }}>
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ position: 'absolute', top: 2, left: 2, opacity: 0.5 }}>
          <path d="M1 13 L13 1 M5 13 L13 5 M9 13 L13 9" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
      </div>

      {/* Header */}
      <div style={{
        padding: '10px 14px 10px 28px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Data Agent</p>
          <p style={{ margin: '1px 0 0', fontSize: 10, color: 'var(--text-muted)' }}>Ask in plain English — answers come back as tables</p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {messages.length > 0 && (
            <button onClick={() => setMessages([])}
              title="Clear conversation"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: '4px 8px' }}>
              ↺
            </button>
          )}
          <button onClick={() => setOpen(false)}
            title="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: '0 6px' }}>
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={bodyRef} style={{
        flex: 1, overflowY: 'auto', padding: 12,
        background: 'var(--bg)',
      }}>
        {messages.length === 0 && !sending && (
          <Welcome onPick={(q) => setDraft(q)} />
        )}
        {messages.map((m, i) => <Message key={i} msg={m} />)}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '8px 0' }}>
            <div style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              padding: '8px 12px', borderRadius: 12, fontSize: 12, color: 'var(--text-muted)',
            }}>
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{
        padding: 10, borderTop: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0,
        display: 'flex', gap: 6, alignItems: 'flex-end',
      }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder='e.g. "Late PrePay drops with open balances grouped by mail location"'
          disabled={sending}
          rows={1}
          style={{
            flex: 1, resize: 'none',
            background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '8px 10px', fontSize: 13, color: 'var(--text-primary)',
            outline: 'none', minHeight: 36, maxHeight: 120,
            fontFamily: 'inherit',
          }}
        />
        <button onClick={send} disabled={!draft.trim() || sending}
          style={{
            padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
            background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
            opacity: (!draft.trim() || sending) ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}>
          Send
        </button>
      </div>
    </div>
  );
}

// ─── sub-components ─────────────────────────────────────────────────────────

function Welcome({ onPick }) {
  const samples = [
    'For all late mail list the order numbers that are PrePay and have open balances. List these by fulfillment location and list the required postage for each.',
    'Top 10 customers by total late postage right now',
    'Which mail locations have the most past-due drops?',
    'Show me drops scheduled this week that haven\'t mailed yet, by customer',
  ];
  return (
    <div style={{ padding: '8px 4px', color: 'var(--text-secondary)' }}>
      <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>What do you want to know?</p>
      <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        Ask anything about late mail, postage, customers, fulfillment facilities, EPS charges, hot jobs, planned drops, or order status.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {samples.map(s => (
          <button key={s} onClick={() => onPick(s)}
            style={{
              textAlign: 'left', padding: '8px 10px',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)',
              cursor: 'pointer', lineHeight: 1.4,
            }}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ msg }) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0' }}>
        <div style={{
          background: 'var(--accent)', color: '#fff',
          padding: '8px 12px', borderRadius: 12, fontSize: 13,
          maxWidth: '90%', whiteSpace: 'pre-wrap', wordWrap: 'break-word',
        }}>
          {msg.content}
        </div>
      </div>
    );
  }
  // assistant
  if (msg.error) {
    return (
      <div style={{ margin: '8px 0' }}>
        <div style={{
          background: 'var(--status-critical-bg)', color: 'var(--status-critical)',
          border: '1px solid var(--border)',
          padding: '8px 12px', borderRadius: 12, fontSize: 12,
        }}>
          <p style={{ margin: 0, fontWeight: 600 }}>⚠ Error</p>
          <p style={{ margin: '4px 0 0' }}>{msg.error}</p>
          {msg.sql && <SqlDetails sql={msg.sql} />}
        </div>
      </div>
    );
  }
  return (
    <div style={{ margin: '8px 0' }}>
      {msg.content && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          padding: '8px 12px', borderRadius: 12, fontSize: 13,
          color: 'var(--text-primary)', marginBottom: 6,
        }}>
          {msg.content}
        </div>
      )}
      {Array.isArray(msg.rows) && <ResultTable rows={msg.rows} />}
      {msg.sql && <SqlDetails sql={msg.sql} />}
    </div>
  );
}

// Render the row array as a sortable-looking compact table. First row's keys
// become the column order. Numeric values get tabular-nums + right-align.
function ResultTable({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <div style={{
        background: 'var(--surface2)', border: '1px solid var(--border)',
        padding: '10px 12px', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)',
      }}>
        No rows.
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, overflow: 'hidden',
    }}>
      <div style={{
        padding: '6px 10px', fontSize: 10, color: 'var(--text-muted)',
        background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
      }}>
        {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'}
      </div>
      <div style={{ overflow: 'auto', maxHeight: 320 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              {cols.map(c => (
                <th key={c} style={{
                  textAlign: 'left', padding: '6px 8px',
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontWeight: 600,
                  fontFamily: 'monospace', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface2)',
                }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                {cols.map(c => {
                  const v = r[c];
                  const isNum = typeof v === 'number';
                  return (
                    <td key={c} style={{
                      padding: '4px 8px',
                      color: v == null ? 'var(--text-muted)' : 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      textAlign: isNum ? 'right' : 'left',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {v == null ? '—' : isNum ? formatNum(v) : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 200 && (
          <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            Showing first 200 of {rows.length.toLocaleString()} rows
          </div>
        )}
      </div>
    </div>
  );
}

// Format numbers with up to 2 decimal places, comma-grouped. Currency stays
// nicely aligned because the table cells are tabular-nums.
function formatNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Collapsible "show SQL" disclosure — helps the user verify the model did the
// right thing and learn what's possible.
function SqlDetails({ sql }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, padding: 0 }}>
        {open ? '▾' : '▸'} SQL
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 0', padding: '8px 10px',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, fontSize: 10, color: 'var(--text-secondary)',
          overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{sql}</pre>
      )}
    </div>
  );
}
