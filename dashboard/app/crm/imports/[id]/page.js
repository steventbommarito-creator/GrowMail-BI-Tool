'use client';

// Import detail page — three stacked sections:
//   1. Header strip with progress bar + counts + back nav
//   2. Mapping (collapsible): Excel column → FS field. Auto-suggested by
//      best-effort name match; user overrides per dropdown. Saves on change.
//   3. Push controls: N input + presets (20/100/1000/all), Push button.
//      For Tasks, shows ETA banner when push would exceed 2 hours.
//   4. Rows preview: status filter, paginated table, click failed row to see
//      the error inline. Download Failed CSV link at the top of this section.

import { useEffect, useState, useRef, useMemo, useCallback, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';

const PRESETS = [20, 100, 1000, 'all'];
const TYPE_LABELS = {
  contacts_accounts: 'Contacts & Accounts',
  leads: 'Leads',
  opportunities: 'Opportunities',
  tasks: 'Tasks',
};
const fmtN = (n) => (n ?? 0).toLocaleString();

const STATUS_COLORS = {
  pending:           { bg: 'var(--surface2)',           fg: 'var(--text-muted)'      },
  validating:        { bg: 'var(--accent-light)',       fg: 'var(--accent)'          },
  validation_failed: { bg: 'var(--status-warn-bg)',     fg: 'var(--status-warn)'     },
  sent:              { bg: 'var(--status-ok-bg)',       fg: 'var(--status-ok)'       },
  failed:            { bg: 'var(--status-critical-bg)', fg: 'var(--status-critical)' },
  skipped:           { bg: 'var(--surface2)',           fg: 'var(--text-muted)'      },
};

export default function ImportDetailPage({ params }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showMapping, setShowMapping] = useState(true);
  const [pushCount, setPushCount] = useState(100);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null);
  const [schema, setSchema] = useState([]);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);

  const load = useCallback(async (statusOverride) => {
    setLoading(true);
    const s = statusOverride ?? statusFilter;
    const sParam = s !== 'all' ? `?status=${s}` : '';
    const res = await fetch(`/api/crm/imports/${id}${sParam}`);
    const j = await res.json();
    if (j.ok) setData(j);
    setLoading(false);
  }, [id, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Fetch FS schema once on mount so the mapping dropdowns are populated.
  useEffect(() => {
    (async () => {
      setSchemaLoading(true);
      try {
        const res = await fetch(`/api/crm/imports/${id}/schema`);
        const j = await res.json();
        if (j.ok) setSchema(j.fields || []);
      } catch (e) { console.error('schema fetch failed:', e.message); }
      setSchemaLoading(false);
    })();
  }, [id]);

  if (loading && !data) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  if (!data) return <div className="text-sm" style={{ color: 'var(--status-critical)' }}>Import not found.</div>;

  const imp = data.import;
  const counts = data.counts || {};
  const totalSent = counts.sent || 0;
  const totalFailed = (counts.failed || 0) + (counts.validation_failed || 0);
  const totalPending = counts.pending || 0;
  const pct = imp.total_rows ? Math.round((totalSent / imp.total_rows) * 100) : 0;
  const mapping = imp.mapping_json || {};

  const onMappingChange = async (excelCol, fsField) => {
    const next = { ...mapping };
    if (fsField === '__skip__' || !fsField) delete next[excelCol];
    else next[excelCol] = fsField;
    setData(d => ({ ...d, import: { ...d.import, mapping_json: next } }));
    await fetch(`/api/crm/imports/${id}/mapping`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping: next }),
    });
  };

  // ── Multi-field mapping helpers ─────────────────────────────────────────
  // mapping[col] can be a string (old) or array of strings (new). These
  // helpers always operate on the array form; persistence keeps the array
  // shape too — the engine accepts either, so old mappings still work.
  const getMappedFields = (excelCol) => {
    const v = mapping[excelCol];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  };
  const setMappedFields = async (excelCol, fields) => {
    const next = { ...mapping };
    const clean = (fields || []).filter(Boolean).filter(f => f !== '__skip__');
    if (clean.length === 0) delete next[excelCol];
    else next[excelCol] = clean;
    setData(d => ({ ...d, import: { ...d.import, mapping_json: next } }));
    await fetch(`/api/crm/imports/${id}/mapping`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping: next }),
    });
  };

  // Auto-suggest a default field per Excel column based on a normalized
  // name match. Only applies if the user hasn't set one yet for that column.
  const suggestField = (excelCol) => {
    if (mapping[excelCol]) return Array.isArray(mapping[excelCol]) ? mapping[excelCol][0] : mapping[excelCol];
    const norm = excelCol.toLowerCase().replace(/[^a-z]/g, '');
    const hit = schema.find(f => f.name.toLowerCase().replace(/[^a-z]/g, '') === norm);
    return hit ? hit.name : '';
  };

  const resolvedCount = pushCount === 'all' ? totalPending : Number(pushCount) || 0;
  const tasksEtaHours = (imp.import_type === 'tasks' && resolvedCount > 1000)
    ? Math.ceil(resolvedCount / 1000)
    : null;

  const doPush = async () => {
    if (tasksEtaHours && !confirm(`This push will take roughly ${tasksEtaHours} hour(s) at the 1,000/hour Freshworks rate limit. Continue?`)) return;
    if (resolvedCount === 0) return;
    setPushing(true); setPushResult(null);
    try {
      const res = await fetch(`/api/crm/imports/${id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: resolvedCount }),
      });
      const j = await res.json();
      setPushResult(j);
      await load();
    } catch (e) {
      setPushResult({ ok: false, error: e.message });
    }
    setPushing(false);
  };

  return (
    <div className="space-y-4">
      {/* ── Header strip ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div>
              <button onClick={() => router.push('/crm/imports')}
                className="text-xs mb-1" style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                ← All imports
              </button>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {imp.original_filename || '(no filename)'}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {TYPE_LABELS[imp.import_type]} · {fmtN(imp.total_rows)} rows · uploaded by {imp.uploaded_by || 'unknown'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <a href={`/api/crm/imports/${id}/failed-csv`} download
                className="text-xs px-2 py-1 rounded"
                style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                Download failed CSV ({fmtN(totalFailed)})
              </a>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ marginTop: 12, height: 8, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--status-ok)', transition: 'width 0.3s' }} />
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <Stat label="Sent"      value={totalSent}     color="var(--status-ok)" />
            <Stat label="Pending"   value={totalPending}  color="var(--text-secondary)" />
            <Stat label="Failed"    value={totalFailed}   color={totalFailed > 0 ? 'var(--status-critical)' : 'var(--text-muted)'} />
            <Stat label="Validating" value={counts.validating || 0} color="var(--accent)" />
          </div>
        </div>
      </div>

      {/* ── Mapping ──────────────────────────────────────────────────────── */}
      <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <button onClick={() => setShowMapping(s => !s)}
          className="w-full text-left px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--surface)', borderBottom: showMapping ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Column Mapping
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Map each Excel column to a Freshworks field. Auto-suggestions appear where the names match.
              {schemaLoading && ' · Loading FS fields…'}
            </p>
          </div>
          <span style={{ color: 'var(--text-muted)' }}>{showMapping ? '▾' : '▸'}</span>
        </button>
        {showMapping && (
          <div style={{ overflow: 'auto', maxHeight: 480 }}>
            {(imp.excel_columns || []).map(col => {
              const selected = getMappedFields(col);
              const suggested = suggestField(col);
              return (
                <div key={col} className="px-4 py-3"
                  style={{ borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, alignItems: 'start' }}>
                  <span className="text-sm font-mono" style={{ color: 'var(--text-primary)', paddingTop: 6 }}>{col}</span>
                  <MappingCombobox
                    schema={schema}
                    selected={selected}
                    suggested={suggested}
                    onChange={(nextFields) => setMappedFields(col, nextFields)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Push controls ────────────────────────────────────────────────── */}
      <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Push to Freshworks
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {fmtN(totalPending)} rows pending. Push them in batches of any size — start small to validate, then ramp up.
          </p>
        </div>
        <div className="px-4 py-3">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Push next</span>
            <input type="number" min="1" value={pushCount === 'all' ? '' : pushCount}
              onChange={e => setPushCount(e.target.value === '' ? 0 : Number(e.target.value))}
              style={{ width: 100, background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '5px 8px', fontSize: 13, color: 'var(--text-primary)' }} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>rows</span>
            <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
              {PRESETS.map(p => (
                <button key={p} onClick={() => setPushCount(p)}
                  className="text-xs px-2 py-1 rounded"
                  style={{
                    background: pushCount === p ? 'var(--accent)' : 'var(--surface2)',
                    color:      pushCount === p ? '#fff'          : 'var(--text-secondary)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                  }}>
                  {p === 'all' ? `All (${fmtN(totalPending)})` : fmtN(p)}
                </button>
              ))}
            </div>
            <button onClick={doPush} disabled={pushing || resolvedCount === 0 || totalPending === 0}
              className="text-xs px-4 py-1.5 rounded font-medium"
              style={{ background: 'var(--accent)', color: '#fff', border: 'none',
                cursor: (pushing || resolvedCount === 0 || totalPending === 0) ? 'not-allowed' : 'pointer',
                opacity: (pushing || resolvedCount === 0 || totalPending === 0) ? 0.5 : 1, marginLeft: 'auto' }}>
              {pushing ? 'Pushing…' : `Push ${fmtN(resolvedCount)}`}
            </button>
          </div>
          {tasksEtaHours !== null && (
            <p className="text-xs mt-3 px-3 py-2 rounded"
              style={{ background: 'var(--status-warn-bg)', color: 'var(--status-warn)', border: '1px solid var(--border)' }}>
              ⚠ Tasks have no bulk endpoint in Freshworks. {fmtN(resolvedCount)} tasks at the 1,000/hour rate limit will take roughly <strong>{tasksEtaHours} hour{tasksEtaHours !== 1 ? 's' : ''}</strong>. Consider smaller batches.
            </p>
          )}
          {pushResult && (
            <div className="text-sm p-3 rounded mt-3"
              style={{
                background: pushResult.ok ? 'var(--status-ok-bg)' : 'var(--status-critical-bg)',
                color:      pushResult.ok ? 'var(--status-ok)'    : 'var(--status-critical)',
                border: '1px solid var(--border)',
              }}>
              {pushResult.ok
                ? <>Sent <strong>{pushResult.sent}</strong>, failed <strong>{pushResult.failed}</strong>{pushResult.errors?.length ? ` · ${pushResult.errors[0]}${pushResult.errors.length > 1 ? ` (+${pushResult.errors.length - 1} more)` : ''}` : ''}</>
                : <>Push failed: {pushResult.error}</>}
            </div>
          )}
        </div>
      </div>

      {/* ── Rows preview ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Rows ({fmtN(data.rows?.length || 0)} shown)
          </h2>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); load(e.target.value); }}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="validation_failed">Validation failed</option>
          </select>
        </div>
        <div style={{ overflow: 'auto', maxHeight: 600 }}>
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)', position: 'sticky', top: 0 }}>
              <tr>
                <th className="px-3 py-2 text-left font-medium" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="px-3 py-2 text-left font-medium" style={{ color: 'var(--text-muted)' }}>Status</th>
                {(imp.excel_columns || []).slice(0, 6).map(c => (
                  <th key={c} className="px-3 py-2 text-left font-medium" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c}</th>
                ))}
                <th className="px-3 py-2 text-left font-medium" style={{ color: 'var(--text-muted)' }}>FS ID</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows || []).map(r => {
                const c = STATUS_COLORS[r.status] || STATUS_COLORS.pending;
                const isExp = expandedRow === r.id;
                return (
                  <>
                    <tr key={r.id}
                      onClick={() => r.error_message && setExpandedRow(isExp ? null : r.id)}
                      style={{ borderTop: '1px solid var(--border)', cursor: r.error_message ? 'pointer' : 'default' }}>
                      <td className="px-3 py-1 font-mono" style={{ color: 'var(--text-muted)' }}>{r.row_index}</td>
                      <td className="px-3 py-1">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: c.bg, color: c.fg }}>
                          {r.status.toUpperCase()}
                        </span>
                      </td>
                      {(imp.excel_columns || []).slice(0, 6).map(col => (
                        <td key={col} className="px-3 py-1" style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {r.raw_json?.[col] != null ? String(r.raw_json[col]) : '—'}
                        </td>
                      ))}
                      <td className="px-3 py-1 font-mono" style={{ color: 'var(--text-muted)' }}>{r.fs_id || '—'}</td>
                    </tr>
                    {isExp && r.error_message && (
                      <tr>
                        <td colSpan={9} className="px-3 py-2"
                          style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)', fontSize: 12 }}>
                          <strong>Error:</strong> {r.error_message}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: 10, color: 'var(--text-muted)' }}>{label}</p>
      <p style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {(value ?? 0).toLocaleString()}
      </p>
    </div>
  );
}

// ─── Searchable multi-select for column → FS field mapping ───────────────────
// Typeahead input with a fixed-height dropdown panel so 100+ FS fields stay
// manageable. Selected fields display as removable chips above the search.
// Click outside to close. Keyboard: ArrowDown/Up + Enter to pick, Esc to close.
// Same column can be mapped to multiple FS fields (e.g. Excel "Phone" →
// {mobile_number, work_number}); engine fans the value out to all targets.
function MappingCombobox({ schema, selected, suggested, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);                          // highlighted-row index
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Close when clicking outside.
  useEffect(() => {
    const onDoc = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Filter to fields not already selected, ranked by best match (label/name
  // includes query). Case-insensitive. Limit to 200 rows for render perf —
  // the dropdown itself is scrollable so even more wouldn't help UX.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selSet = new Set(selected);
    const list = schema.filter(f => !selSet.has(f.name));
    if (!q) return list.slice(0, 200);
    const scored = [];
    for (const f of list) {
      const label = (f.label || '').toLowerCase();
      const name  = (f.name  || '').toLowerCase();
      const group = (f.group || '').toLowerCase();
      let score = -1;
      if (label.startsWith(q) || name.startsWith(q))  score = 0;        // best — prefix
      else if (label.includes(q) || name.includes(q)) score = 1;
      else if (group.includes(q))                      score = 2;
      if (score >= 0) scored.push([score, f]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 200).map(p => p[1]);
  }, [schema, selected, query]);

  // Clamp the highlight when the result list shrinks.
  useEffect(() => { if (hi >= results.length) setHi(Math.max(0, results.length - 1)); }, [results.length, hi]);

  const addField = (name) => {
    if (!name || selected.includes(name)) return;
    onChange([...selected, name]);
    setQuery('');
    setHi(0);
    // Keep focus so the user can add multiple fields in a row.
    inputRef.current?.focus();
  };
  const removeField = (name) => onChange(selected.filter(s => s !== name));

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter')  { e.preventDefault(); if (results[hi]) addField(results[hi].name); }
    else if (e.key === 'Backspace' && !query && selected.length > 0) { removeField(selected[selected.length - 1]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  const fieldByName = useMemo(() => {
    const m = new Map(); for (const f of schema) m.set(f.name, f); return m;
  }, [schema]);

  const isEmpty = selected.length === 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', minWidth: 0 }}>
      {/* Selected chips + inline search */}
      <div
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
        style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 6px',
          minHeight: 30, cursor: 'text',
        }}>
        {selected.map(name => {
          const f = fieldByName.get(name);
          const label = f?.label || name;
          const group = f?.group;
          return (
            <span key={name}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'var(--accent-light)', color: 'var(--accent)',
                borderRadius: 4, padding: '2px 4px 2px 7px',
                fontSize: 11, fontWeight: 600,
              }}>
              {label}{group ? <span style={{ fontWeight: 400, opacity: 0.7 }}> ({group})</span> : null}
              <button onClick={(e) => { e.stopPropagation(); removeField(name); }}
                title="Remove this mapping"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 13, lineHeight: 1, padding: '0 3px' }}>×</button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={isEmpty
            ? (suggested ? `Suggested: ${suggested} — type to search…` : 'Search Freshworks fields…')
            : 'Add another field…'}
          style={{
            flex: '1 1 120px', minWidth: 100,
            background: 'transparent', border: 'none', outline: 'none',
            fontSize: 12, color: 'var(--text-primary)',
            padding: '4px 2px',
          }}
        />
      </div>

      {/* Dropdown panel */}
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            zIndex: 50,
            maxHeight: 280, overflowY: 'auto',
          }}>
          {results.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              {query ? `No fields match "${query}"` : 'All fields are already mapped'}
            </div>
          ) : results.map((f, i) => {
            const isHi = i === hi;
            return (
              <div key={f.name}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => { e.preventDefault(); addField(f.name); }}
                style={{
                  padding: '6px 12px', cursor: 'pointer', fontSize: 12,
                  background: isHi ? 'var(--surface2)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                    {f.label}{f.required ? ' *' : ''}
                  </span>
                  {f.name !== f.label && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontFamily: 'monospace', fontSize: 11 }}>
                      {f.name}
                    </span>
                  )}
                </div>
                {f.group && (
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    color: 'var(--text-muted)',
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 3, padding: '1px 5px',
                    whiteSpace: 'nowrap',
                  }}>
                    {f.group}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
