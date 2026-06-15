'use client';

// CRM → Imports list. Inner tabs per import type (Contacts+Accounts, Leads,
// Opportunities, Tasks). Each tab shows every upload of that type with a
// progress bar (sent / total) and quick stats. New Upload button opens a
// modal: pick file + type, submit, navigate to the detail page on success.

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const TYPES = [
  { id: 'contacts_accounts', label: 'Contacts & Accounts' },
  { id: 'leads',             label: 'Leads' },
  { id: 'opportunities',     label: 'Opportunities' },
  { id: 'tasks',             label: 'Tasks' },
];

const fmtTS = (iso) => iso
  ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Detroit', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—';

const STATUS_COLORS = {
  mapping:  { bg: 'var(--surface2)',          fg: 'var(--text-muted)'      },
  ready:    { bg: 'var(--status-warn-bg)',    fg: 'var(--status-warn)'     },
  pushing:  { bg: 'var(--accent-light)',      fg: 'var(--accent)'          },
  complete: { bg: 'var(--status-ok-bg)',      fg: 'var(--status-ok)'       },
};

export default function ImportsListPage() {
  const router = useRouter();
  const [tab, setTab] = useState(TYPES[0].id);
  const [imports, setImports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/crm/imports?type=${tab}`);
    const j = await res.json();
    if (j.ok) setImports(j.imports || []);
    setLoading(false);
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Type tabs */}
      <div className="flex items-center justify-between border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex gap-1">
          {TYPES.map(t => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="px-3 py-2 text-sm font-medium"
                style={{
                  color:        active ? 'var(--accent)' : 'var(--text-secondary)',
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1, background: 'transparent', cursor: 'pointer',
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
        <button onClick={() => setShowUpload(true)}
          className="text-xs px-3 py-1.5 rounded font-medium mb-2"
          style={{ background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
          + New Upload
        </button>
      </div>

      {loading && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {!loading && imports.length === 0 && (
        <div className="rounded-xl border p-12 text-center" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            No {TYPES.find(t => t.id === tab)?.label.toLowerCase()} uploads yet
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Click "New Upload" to add an Excel file. Rows are stored here in batches you control before any data is sent to Freshworks.
          </p>
        </div>
      )}

      {!loading && imports.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--surface2)' }}>
              <tr>
                <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>File</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Status</th>
                <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Total</th>
                <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Sent</th>
                <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Pending</th>
                <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Failed</th>
                <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {imports.map(imp => {
                const c = imp.counts || {};
                const sent = c.sent || 0;
                const pending = c.pending || 0;
                const failed = (c.failed || 0) + (c.validation_failed || 0);
                const pct = imp.total_rows ? Math.round((sent / imp.total_rows) * 100) : 0;
                const sCol = STATUS_COLORS[imp.status] || STATUS_COLORS.mapping;
                return (
                  <tr key={imp.id}
                    onClick={() => router.push(`/crm/imports/${imp.id}`)}
                    style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                    <td className="px-4 py-2">
                      <p style={{ color: 'var(--text-primary)', margin: 0, fontWeight: 500 }}>{imp.original_filename || '(no filename)'}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)', margin: '2px 0 0' }}>
                        by {imp.uploaded_by || 'unknown'}
                      </p>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded"
                        style={{ background: sCol.bg, color: sCol.fg }}>
                        {imp.status.toUpperCase()}
                      </span>
                      {imp.status === 'pushing' && (
                        <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right" style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                      {imp.total_rows?.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right" style={{ color: sent > 0 ? 'var(--status-ok)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {sent.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right" style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {pending.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right" style={{ color: failed > 0 ? 'var(--status-critical)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {failed.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {fmtTS(imp.uploaded_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showUpload && <UploadModal type={tab} onClose={() => setShowUpload(false)}
        onUploaded={(id) => { setShowUpload(false); router.push(`/crm/imports/${id}`); }} />}
    </div>
  );
}

// ─── Upload modal ───────────────────────────────────────────────────────────

function UploadModal({ type, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [type2, setType2] = useState(type);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Reject anything that isn't an Excel or CSV — same constraint as the
  // bucket's allowedMimeTypes. We check by extension because some browsers
  // mis-report the MIME for .xlsx as application/octet-stream.
  const acceptFile = (f) => {
    if (!f) return;
    const ok = /\.(xlsx|xls|csv)$/i.test(f.name);
    if (!ok) { setError('Only .xlsx, .xls, or .csv files are supported'); return; }
    setError(null);
    setFile(f);
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    acceptFile(f);
  };

  const submit = async () => {
    if (!file) { setError('Pick a file first'); return; }
    setUploading(true); setError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('type', type2);
    try {
      const res = await fetch('/api/crm/imports/upload', { method: 'POST', body: form });
      const j = await res.json();
      if (!j.ok) { setError(j.error); setUploading(false); return; }
      onUploaded(j.import_id);
    } catch (e) {
      setError(e.message); setUploading(false);
    }
  };

  return (
    <div onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          padding: '24px 28px', width: 460, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
        <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
          New Import
        </p>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text-muted)' }}>
          Upload an Excel (.xlsx) or CSV. Rows will be stored here for mapping and review before anything goes to Freshworks.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Type</label>
            <select value={type2} onChange={e => setType2(e.target.value)}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 10px', fontSize: 13, color: 'var(--text-primary)' }}>
              {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>File</label>

            {/* Hidden native input — driven by the drop zone's click handler */}
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
              onChange={e => acceptFile(e.target.files?.[0] || null)}
              style={{ display: 'none' }} />

            {/* Drop zone — drag over to highlight, click anywhere to browse,
                shows the chosen file name (with a Change button) once selected. */}
            <div
              onClick={() => !file && fileInputRef.current?.click()}
              onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
              onDrop={onDrop}
              style={{
                border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
                background: dragOver ? 'var(--accent-light)' : 'var(--surface2)',
                borderRadius: 8,
                padding: file ? '14px 16px' : '28px 16px',
                textAlign: 'center',
                cursor: file ? 'default' : 'pointer',
                transition: 'border-color 0.15s, background 0.15s, padding 0.15s',
              }}>
              {file ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ textAlign: 'left', minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {file.name}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                      {(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFile(null); fileInputRef.current && (fileInputRef.current.value = ''); }}
                    style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                      background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {dragOver ? 'Drop file to upload' : 'Drag and drop your file here'}
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                    or <span style={{ color: 'var(--accent)', textDecoration: 'underline' }}>click to browse</span> — .xlsx, .xls, or .csv (up to 50 MB)
                  </p>
                </>
              )}
            </div>
          </div>
          {error && <p className="text-xs" style={{ color: 'var(--status-critical)' }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} disabled={uploading}
            style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button onClick={submit} disabled={uploading || !file}
            style={{ padding: '6px 18px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
              opacity: (uploading || !file) ? 0.5 : 1 }}>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
