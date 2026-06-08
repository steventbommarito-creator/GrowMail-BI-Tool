'use client';

// CRM → Opportunities. Two tabs at the top: Status Mapping (v1) and Field
// Mapping (v2 shell). Main view aggregates orders by their mapped FS stage —
// one row per category, expandable to the underlying orders.
//
// "Map Statuses" button opens a modal that lists every distinct order_status
// that's ever appeared in osprey_mail_drops, grouped by lifecycle phase, with
// a dropdown to assign each to a FS stage (or Don't Sync).

import { useEffect, useState, useMemo, useCallback } from 'react';
import { createClient } from '../../../lib/supabase';

const fmt$ = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Pre-defined buckets so the mapping modal groups the 24 G&L statuses by
// lifecycle phase. Anything in osprey_mail_drops not listed here falls to
// the "Other" bucket so we don't lose any new statuses G&L invents.
const LIFECYCLE_BUCKETS = [
  { label: 'Pre-live / Quote / Intake', match: ['QUOTE', 'INCOMPLETE', 'LIMBO', 'DESIGN [PROOF]', 'DESIGN [REUPLOAD]', 'DESIGN APPROVED', 'GRAPHICS [WIP]', 'PREPRESS [PROOF]', 'PREPRESS [REUPLOAD]'] },
  { label: 'Payment-gating',            match: ['PAYMENT REQUIRED', 'PAYMENT REQUIRED - INTERNAL'] },
  { label: 'Active / In Production',    match: ['DAL [STAGING]', 'DAL [SUBMITTED]', 'DIGITAL [STAGING]', 'DIGITAL READY', 'DMM [STAGING]', 'DMM [ACTIVE]', 'OUTSOURCED', 'OUTSOURCED [STAGING]', 'ACTIVE RUN', 'WAREHOUSE [KSCOPE]'] },
  { label: 'Terminal',                  match: ['COMPLETE', 'CANCELED', 'VOID'] },
];

// Suggested defaults applied when the user opens the modal for the first time
// and the row doesn't already have a mapping. Editable; nothing saves unless
// user clicks Save.
const DEFAULT_SUGGESTIONS = {
  'COMPLETE': 'Won',
  'CANCELED': 'Lost',
  'VOID':     'Lost',
  'QUOTE':    'New',
  'INCOMPLETE': "Don't Sync",
  'LIMBO':    "Don't Sync",
  // everything else in Active / Payment / Design → Open
};
const ACTIVE_OPEN_STATUSES = LIFECYCLE_BUCKETS[1].match.concat(LIFECYCLE_BUCKETS[2].match).concat(LIFECYCLE_BUCKETS[0].match.filter(s => !['QUOTE', 'INCOMPLETE', 'LIMBO'].includes(s)));

function bucketize(allStatuses) {
  // Returns [{ label, statuses: [...] }, ...] preserving bucket order; any
  // status not matched ends up in "Other" at the end.
  const used = new Set();
  const result = LIFECYCLE_BUCKETS.map(b => {
    const matched = b.match.filter(s => allStatuses.has(s));
    matched.forEach(s => used.add(s));
    return { label: b.label, statuses: matched };
  });
  const other = [...allStatuses].filter(s => !used.has(s)).sort();
  if (other.length) result.push({ label: 'Other / Unrecognized', statuses: other });
  return result;
}

function defaultCategoryFor(status) {
  if (DEFAULT_SUGGESTIONS[status]) return DEFAULT_SUGGESTIONS[status];
  if (ACTIVE_OPEN_STATUSES.includes(status)) return 'Open';
  return ''; // leave blank → Uncategorized
}

export default function OpportunitiesPage() {
  const supabase = createClient();
  const [tab, setTab] = useState('status'); // 'status' | 'fields'
  const [allDrops, setAllDrops] = useState([]);
  const [mappings, setMappings] = useState([]);    // crm_status_mappings rows
  const [pipelineId, setPipelineId] = useState(null);
  const [stages, setStages] = useState([]);        // FS stages — fetched from server route
  const [loading, setLoading] = useState(true);
  const [showMapping, setShowMapping] = useState(false);
  const [expanded, setExpanded] = useState({});    // category → bool
  const [userEmail, setUserEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: drops }, { data: maps }, { data: settings }, userRes] = await Promise.all([
      // Paginate to bypass 1k cap
      (async () => {
        let all = []; let from = 0; const size = 1000;
        while (true) {
          const { data } = await supabase.from('osprey_mail_drops')
            .select('mail_drop_id, captured_at, order_id, customer_name, product_category, order_status, mail_drop_amount, postage_amount, actual_postage, mail_drop_quantity')
            .range(from, from + size - 1);
          if (!data?.length) break;
          all = all.concat(data);
          if (data.length < size) break;
          from += size;
        }
        return { data: all };
      })(),
      supabase.from('crm_status_mappings').select('*'),
      supabase.from('crm_settings').select('pipeline_id, pipeline_name').eq('id', 1).single(),
      supabase.auth.getUser(),
    ]);
    setAllDrops(drops || []);
    setMappings(maps || []);
    setPipelineId(settings?.pipeline_id || null);
    setUserEmail(userRes?.data?.user?.email || '');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Fetch FS stages for the current pipeline so the mapping dropdown shows real
  // stage names + IDs. Skipped if no pipeline is set yet (user gets a warning
  // in the modal).
  useEffect(() => {
    if (!pipelineId) { setStages([]); return; }
    (async () => {
      try {
        const res = await fetch(`/api/crm/stages?pipeline_id=${encodeURIComponent(pipelineId)}`);
        const j = await res.json();
        if (j.ok) setStages(j.stages || []);
      } catch (e) { console.error('Failed to fetch stages:', e.message); }
    })();
  }, [pipelineId]);

  // ── Aggregate drops → orders → mapped category ───────────────────────────
  // 1 row per order_id (dedupe drops by mail_drop_id keeping latest captured_at)
  const ordersByCategory = useMemo(() => {
    const mapByStatus = new Map();
    for (const m of mappings) mapByStatus.set(m.order_status, m);

    // Dedupe drops by mail_drop_id (most recent captured_at wins)
    const dedup = new Map();
    for (const d of allDrops) {
      const prev = dedup.get(d.mail_drop_id);
      if (!prev || new Date(d.captured_at) > new Date(prev.captured_at)) dedup.set(d.mail_drop_id, d);
    }
    // Bucket drops by order_id
    const byOrder = new Map();
    for (const d of dedup.values()) {
      if (!d.order_id) continue;
      if (!byOrder.has(d.order_id)) byOrder.set(d.order_id, []);
      byOrder.get(d.order_id).push(d);
    }
    // Roll each order up + assign category
    const buckets = { 'New': [], 'Open': [], 'Won': [], 'Lost': [], "Don't Sync": [], 'Uncategorized': [] };
    for (const [orderId, rows] of byOrder) {
      const first = rows[0];
      const m = mapByStatus.get(first.order_status);
      let category = 'Uncategorized';
      if (m) {
        if (m.excluded) category = "Don't Sync";
        else if (m.fs_stage_category) category = m.fs_stage_category;
      }
      const totalAmount  = rows.reduce((s, r) => s + (Number(r.mail_drop_amount) || 0), 0);
      const totalPostage = rows.reduce((s, r) => s + (Number(r.actual_postage ?? r.postage_amount) || 0), 0);
      const totalQty     = rows.reduce((s, r) => s + (Number(r.mail_drop_quantity) || 0), 0);
      buckets[category].push({
        order_id: orderId,
        customer_name: first.customer_name,
        product_category: first.product_category,
        order_status: first.order_status,
        drop_count: rows.length,
        total_amount: totalAmount,
        total_postage: totalPostage,
        total_qty: totalQty,
      });
    }
    return buckets;
  }, [allDrops, mappings]);

  const distinctStatuses = useMemo(() => {
    const s = new Set();
    for (const d of allDrops) if (d.order_status) s.add(d.order_status);
    return s;
  }, [allDrops]);

  const categoriesOrder = ['New', 'Open', 'Won', 'Lost', "Don't Sync", 'Uncategorized'];
  const categoryColors = {
    'New':           { dot: '#94a3b8', label: 'var(--text-secondary)' },
    'Open':          { dot: '#2563eb', label: 'var(--text-primary)' },
    'Won':           { dot: 'var(--status-ok)',       label: 'var(--status-ok)' },
    'Lost':          { dot: 'var(--status-critical)', label: 'var(--status-critical)' },
    "Don't Sync":    { dot: 'var(--text-muted)',      label: 'var(--text-muted)' },
    'Uncategorized': { dot: 'var(--status-warn)',     label: 'var(--status-warn)' },
  };

  return (
    <div className="space-y-4">

      {/* ── Inner tabs: Status Mapping / Field Mapping ─────────────────────── */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {[
          { id: 'status', label: 'Status Mapping' },
          { id: 'fields', label: 'Field Mapping' },
        ].map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-3 py-2 text-sm font-medium"
              style={{
                color:        active ? 'var(--accent)'        : 'var(--text-secondary)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1, background: 'transparent', cursor: 'pointer',
              }}>
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'fields' && (
        <div className="rounded-xl border p-6 text-center"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          <p className="text-sm">Field Mapping configuration coming after Status Mapping is locked in.</p>
          <p className="text-xs mt-1">You'll be able to map G&L columns (mail_drop_amount, drop_est_date, etc.) to custom FS deal fields.</p>
        </div>
      )}

      {tab === 'status' && (
        <>
          {loading && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>}

          {!loading && (
            <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
              <div className="px-4 py-3 flex items-center justify-between"
                style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    Opportunities by Deal Stage
                  </h2>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Orders bucketed by the Freshsales stage they're mapped to. Click a row to expand the underlying orders.
                  </p>
                </div>
                <button onClick={() => setShowMapping(true)}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                  Map Statuses
                </button>
              </div>

              <table className="w-full text-xs">
                <thead style={{ background: 'var(--surface2)' }}>
                  <tr>
                    <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>FS Deal Stage</th>
                    <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Order Count</th>
                    <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Total Drop Amount</th>
                    <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Total Postage</th>
                    <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>Total Pieces</th>
                  </tr>
                </thead>
                <tbody>
                  {categoriesOrder.map(cat => {
                    const orders = ordersByCategory[cat] || [];
                    if (orders.length === 0) return null;
                    const color = categoryColors[cat];
                    const totalAmount  = orders.reduce((s, o) => s + o.total_amount, 0);
                    const totalPostage = orders.reduce((s, o) => s + o.total_postage, 0);
                    const totalQty     = orders.reduce((s, o) => s + o.total_qty, 0);
                    const isExp = !!expanded[cat];
                    return (
                      <ExpandableCategory key={cat} cat={cat} color={color} orders={orders}
                        totalAmount={totalAmount} totalPostage={totalPostage} totalQty={totalQty}
                        isExp={isExp} onToggle={() => setExpanded(p => ({ ...p, [cat]: !p[cat] }))} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Mapping modal ──────────────────────────────────────────────────── */}
      {showMapping && (
        <MappingModal
          onClose={() => setShowMapping(false)}
          distinctStatuses={distinctStatuses}
          existingMappings={mappings}
          stages={stages}
          pipelineId={pipelineId}
          userEmail={userEmail}
          onSaved={async () => { setShowMapping(false); await load(); }}
        />
      )}
    </div>
  );
}

// ─── Expandable category row ────────────────────────────────────────────────

function ExpandableCategory({ cat, color, orders, totalAmount, totalPostage, totalQty, isExp, onToggle }) {
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={onToggle}>
        <td className="px-4 py-2.5" style={{ color: color.label, fontWeight: 600 }}>
          <span style={{ marginRight: 6 }}>{isExp ? '▾' : '▸'}</span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color.dot, marginRight: 8, verticalAlign: 'middle' }} />
          {cat}
        </td>
        <td className="px-4 py-2.5 text-right" style={{ color: 'var(--text-primary)' }}>{orders.length}</td>
        <td className="px-4 py-2.5 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{fmt$(totalAmount)}</td>
        <td className="px-4 py-2.5 text-right" style={{ color: 'var(--text-secondary)' }}>{fmt$(totalPostage)}</td>
        <td className="px-4 py-2.5 text-right" style={{ color: 'var(--text-muted)' }}>{totalQty.toLocaleString()}</td>
      </tr>
      {isExp && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface2)', padding: 0 }}>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Order ID</th>
                  <th className="text-left px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Customer</th>
                  <th className="text-left px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Product</th>
                  <th className="text-left px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Order Status</th>
                  <th className="text-right px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Drops</th>
                  <th className="text-right px-4 py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 200).map(o => (
                  <tr key={o.order_id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-4 py-1 font-mono" style={{ color: 'var(--text-muted)' }}>{o.order_id}</td>
                    <td className="px-4 py-1" style={{ color: 'var(--text-primary)' }}>{o.customer_name || '—'}</td>
                    <td className="px-4 py-1" style={{ color: 'var(--text-secondary)' }}>{o.product_category || '—'}</td>
                    <td className="px-4 py-1" style={{ color: 'var(--text-secondary)' }}>{o.order_status}</td>
                    <td className="px-4 py-1 text-right" style={{ color: 'var(--text-muted)' }}>{o.drop_count}</td>
                    <td className="px-4 py-1 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{fmt$(o.total_amount)}</td>
                  </tr>
                ))}
                {orders.length > 200 && (
                  <tr><td colSpan={6} className="px-4 py-2 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Showing first 200 of {orders.length} orders.
                  </td></tr>
                )}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Mapping modal ──────────────────────────────────────────────────────────

function MappingModal({ onClose, distinctStatuses, existingMappings, stages, pipelineId, userEmail, onSaved }) {
  // Build the initial value map: existing mapping → current value, otherwise
  // the user's last choice for that status doesn't exist yet, so apply the
  // suggested default. The user can override anything before saving.
  const supabase = createClient();
  const [working, setWorking] = useState(() => {
    const map = {};
    const byStatus = new Map(existingMappings.map(m => [m.order_status, m]));
    for (const s of distinctStatuses) {
      const m = byStatus.get(s);
      if (m) {
        if (m.excluded) map[s] = { type: 'exclude' };
        else if (m.fs_stage_id) map[s] = { type: 'stage', stage_id: m.fs_stage_id };
        else map[s] = { type: 'unset' };
      } else {
        const suggested = defaultCategoryFor(s); // '', 'New', 'Open', 'Won', 'Lost', "Don't Sync"
        if (suggested === "Don't Sync") map[s] = { type: 'exclude' };
        else if (suggested) map[s] = { type: 'suggest', category: suggested };
        else map[s] = { type: 'unset' };
      }
    }
    return map;
  });
  const [saving, setSaving] = useState(false);

  const grouped = useMemo(() => bucketize(distinctStatuses), [distinctStatuses]);

  // Build the dropdown options: every FS stage, then a divider, then Don't Sync.
  // Each option's value is encoded: "stage:<id>" or "exclude" or "unset".
  // We also surface stage.category to map back when serializing.
  const stageOpts = stages.map(s => ({
    value: `stage:${s.id}`, label: s.name, stage: s,
  }));

  // When the user picked a "suggest" category (e.g. "Open"), try to match it
  // to the first stage in the live FS list with that category name. Falls
  // back to leaving it unset if the FS pipeline doesn't have a matching stage.
  const valueFor = (s) => {
    const w = working[s];
    if (w.type === 'stage')   return `stage:${w.stage_id}`;
    if (w.type === 'exclude') return 'exclude';
    if (w.type === 'suggest') {
      const match = stages.find(st => (st.name || '').toLowerCase() === w.category.toLowerCase());
      return match ? `stage:${match.id}` : 'unset';
    }
    return 'unset';
  };

  const onPick = (status, value) => {
    if (value === 'exclude') setWorking(prev => ({ ...prev, [status]: { type: 'exclude' } }));
    else if (value === 'unset') setWorking(prev => ({ ...prev, [status]: { type: 'unset' } }));
    else if (value.startsWith('stage:')) {
      setWorking(prev => ({ ...prev, [status]: { type: 'stage', stage_id: value.slice(6) } }));
    }
  };

  const save = async () => {
    setSaving(true);
    // Build upsert payload — one row per status.
    const rows = [];
    for (const status of distinctStatuses) {
      const w = working[status];
      const resolvedValue = valueFor(status);
      if (resolvedValue === 'unset') {
        // Remove any existing mapping to revert to "Uncategorized"
        await supabase.from('crm_status_mappings').delete().eq('order_status', status);
        continue;
      }
      if (resolvedValue === 'exclude') {
        rows.push({
          order_status: status, fs_stage_id: null, fs_stage_name: null,
          fs_stage_category: null, excluded: true,
          set_by: userEmail, set_at: new Date().toISOString(),
        });
        continue;
      }
      // stage:<id>
      const id = resolvedValue.slice(6);
      const stage = stages.find(s => String(s.id) === String(id));
      rows.push({
        order_status: status,
        fs_stage_id: id,
        fs_stage_name: stage?.name || null,
        fs_stage_category: stage?.name || null, // FS stages are named like New/Open/Won/Lost — surface as category for the bucket view
        excluded: false,
        set_by: userEmail, set_at: new Date().toISOString(),
      });
    }
    if (rows.length > 0) {
      const { error } = await supabase.from('crm_status_mappings').upsert(rows, { onConflict: 'order_status' });
      if (error) { setSaving(false); alert(`Save failed: ${error.message}`); return; }
    }
    await supabase.from('crm_events').insert({
      event_type: 'mapping_changed', status: 'info',
      title: `Status mappings updated`,
      body: `${rows.length} mappings saved by ${userEmail || 'unknown'}`,
      created_by: userEmail,
    });
    setSaving(false);
    onSaved();
  };

  return (
    <div onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        padding: 24,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          width: 720, maxWidth: '100%', maxHeight: '90vh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
            Map G&L Order Statuses → Freshsales Deal Stages
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Pre-filled defaults are suggestions — edit anything before saving.
            "Don't Sync" means we never create a deal for that status.
            Unmapped statuses (left as Uncategorized) are skipped until you decide.
          </p>
        </div>

        {!pipelineId && (
          <div className="px-5 py-3 text-sm" style={{ background: 'var(--status-warn-bg)', color: 'var(--status-warn)', borderBottom: '1px solid var(--border)' }}>
            ⚠ No pipeline selected. Go to <strong>Integrations</strong> and pick a pipeline first — the stage dropdowns can only show real FS stages once the pipeline is set.
          </div>
        )}
        {pipelineId && stages.length === 0 && (
          <div className="px-5 py-3 text-sm" style={{ background: 'var(--status-warn-bg)', color: 'var(--status-warn)', borderBottom: '1px solid var(--border)' }}>
            ⚠ Stages haven't loaded from FS yet. Check that the Test Connection on Integrations is green.
          </div>
        )}

        <div style={{ overflow: 'auto', flex: 1, padding: '8px 0' }}>
          {grouped.map(group => (
            <div key={group.label} style={{ marginBottom: 12 }}>
              <p className="px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
                style={{ background: 'var(--surface2)', color: 'var(--text-muted)', margin: 0, letterSpacing: 0.5 }}>
                {group.label}
              </p>
              {group.statuses.map(s => (
                <div key={s} className="px-5 py-2 flex items-center justify-between"
                  style={{ borderBottom: '1px solid var(--border)', gap: 12 }}>
                  <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{s}</span>
                  <select value={valueFor(s)} onChange={e => onPick(s, e.target.value)}
                    style={{
                      background: 'var(--surface2)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: '5px 8px', fontSize: 12,
                      color: 'var(--text-primary)', minWidth: 200,
                    }}>
                    <option value="unset">— Uncategorized —</option>
                    {stageOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    <option disabled>──────────────</option>
                    <option value="exclude">Don't Sync</option>
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          <button onClick={onClose}
            style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            style={{ padding: '6px 18px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
              opacity: saving ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save Mappings'}
          </button>
        </div>
      </div>
    </div>
  );
}
