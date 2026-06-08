'use client';

// Integrations page — Freshworks/Freshsales API config + sync controls.
//   • API URL + API Key form (saved to crm_settings singleton row id=1)
//   • Test Connection — hits the API server-side via /api/crm/test-connection
//   • Pipeline picker — once test succeeds, list pipelines from FS and let
//     the user pick which one our deals live in
//   • Sync All button — triggers /api/crm/sync-all (POST)
//   • Live Sync toggle — flips crm_settings.live_sync_enabled
//   • Last-full-sync display so user can see when the last big push ran

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '../../../lib/supabase';

const fmtTS = (iso) => iso
  ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Detroit' })
  : '—';

export default function IntegrationsPage() {
  const supabase = createClient();
  const [settings, setSettings] = useState(null);
  const [userEmail, setUserEmail] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pipelines, setPipelines] = useState([]);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const [syncResult, setSyncResult] = useState(null); // last sync result message

  const load = useCallback(async () => {
    const [{ data }, userRes] = await Promise.all([
      supabase.from('crm_settings').select('*').eq('id', 1).single(),
      supabase.auth.getUser(),
    ]);
    setSettings(data);
    setApiUrl(data?.api_url || '');
    setApiKey(data?.api_key || '');
    setUserEmail(userRes?.data?.user?.email || '');
  }, []);

  useEffect(() => { load(); }, [load]);

  // Persist API URL + API Key. We auto-prepend https:// if the user typed a
  // bare hostname like "acme.myfreshworks.com/crm/sales" — Node fetch needs a
  // protocol or it errors with "Failed to parse URL". Strip trailing slashes
  // too so we don't end up with double-slashes when paths get appended.
  const normalizeUrl = (s) => {
    const t = String(s || '').trim().replace(/\/+$/, '');
    if (!t) return '';
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  };
  const save = async () => {
    setSaving(true);
    const cleanedUrl = normalizeUrl(apiUrl);
    const { error } = await supabase.from('crm_settings').update({
      api_url: cleanedUrl || null,
      api_key: apiKey.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: userEmail || null,
    }).eq('id', 1);
    setSaving(false);
    if (error) { alert(`Save failed: ${error.message}`); return; }
    // Reflect the normalized URL back in the input so the user sees the fix
    if (cleanedUrl !== apiUrl) setApiUrl(cleanedUrl);
    await supabase.from('crm_events').insert({
      event_type: 'settings_changed', status: 'info',
      title: 'CRM settings updated',
      body: `API URL/Key saved by ${userEmail || 'unknown'}`,
      created_by: userEmail,
    });
    await load();
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/crm/test-connection', { method: 'POST' });
      const j = await res.json();
      await load();   // re-read last_test_ok / last_test_message
      if (j.ok) await fetchPipelines();
    } catch (e) {
      alert(`Test failed: ${e.message}`);
    }
    setTesting(false);
  };

  const fetchPipelines = async () => {
    setLoadingPipelines(true);
    try {
      const res = await fetch('/api/crm/pipelines');
      const j = await res.json();
      if (j.ok) setPipelines(j.pipelines || []);
      else console.error('Pipelines fetch failed:', j.error);
    } catch (e) {
      console.error('Pipelines fetch error:', e.message);
    }
    setLoadingPipelines(false);
  };

  // Once test passes, auto-fetch pipelines so the dropdown is ready.
  useEffect(() => {
    if (settings?.last_test_ok && pipelines.length === 0) fetchPipelines();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.last_test_ok]);

  const pickPipeline = async (id) => {
    const p = pipelines.find(pp => String(pp.id) === String(id));
    await supabase.from('crm_settings').update({
      pipeline_id: id || null,
      pipeline_name: p?.name || null,
      updated_at: new Date().toISOString(),
      updated_by: userEmail,
    }).eq('id', 1);
    await supabase.from('crm_events').insert({
      event_type: 'settings_changed', status: 'info',
      title: `Pipeline set to "${p?.name || id}"`,
      created_by: userEmail,
    });
    await load();
  };

  const toggleLiveSync = async () => {
    const next = !settings?.live_sync_enabled;
    await supabase.from('crm_settings').update({
      live_sync_enabled: next,
      updated_at: new Date().toISOString(),
      updated_by: userEmail,
    }).eq('id', 1);
    await supabase.from('crm_events').insert({
      event_type: 'live_sync_toggled',
      status: next ? 'warning' : 'info',
      title: `Live Sync turned ${next ? 'ON' : 'OFF'}`,
      body: `Set by ${userEmail || 'unknown'}`,
      created_by: userEmail,
    });
    await load();
  };

  const syncAll = async () => {
    if (!confirm('Sync All will push every mapped order to Freshsales. Continue?')) return;
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/crm/sync-all', { method: 'POST' });
      const j = await res.json();
      setSyncResult(j);
      await load();
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
    }
    setSyncing(false);
  };

  if (!settings) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  const configured = !!(settings.api_url && settings.api_key);
  const testOk     = !!settings.last_test_ok;

  return (
    <div className="space-y-4">

      {/* ── API credentials ────────────────────────────────────────────────── */}
      <Section title="Freshworks API Credentials"
        subtitle="The URL + key from your Freshsales admin → API Settings.">
        <div className="space-y-3">
          <Field label="API URL">
            <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)}
              placeholder="https://yourdomain.myfreshworks.com/crm/sales"
              style={inputStyle} />
          </Field>
          <Field label="API Key">
            <div style={{ display: 'flex', gap: 6 }}>
              <input type={showKey ? 'text' : 'password'} value={apiKey}
                onChange={e => setApiKey(e.target.value)} placeholder="••••••••••••••••"
                style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => setShowKey(s => !s)} style={ghostBtn}>{showKey ? 'Hide' : 'Show'}</button>
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={primaryBtn}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={testConnection} disabled={testing || !configured} style={ghostBtn}>
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {settings.last_test_at && (
              <span style={{ alignSelf: 'center', fontSize: 12,
                color: testOk ? 'var(--status-ok)' : 'var(--status-critical)' }}>
                {testOk ? '✓ ' : '✗ '}
                {settings.last_test_message || (testOk ? 'Connected' : 'Failed')}
                {' · '}{fmtTS(settings.last_test_at)}
              </span>
            )}
          </div>
        </div>
      </Section>

      {/* ── Pipeline picker — only meaningful after a successful test ──────── */}
      <Section title="Pipeline"
        subtitle="Freshsales supports multiple deal pipelines. Pick the one our deals should live in.">
        {!testOk ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Save credentials and click Test Connection first — the pipeline list comes from your FS account.
          </p>
        ) : loadingPipelines ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading pipelines…</p>
        ) : pipelines.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No pipelines returned. <button onClick={fetchPipelines} style={ghostBtn}>Retry</button>
          </p>
        ) : (
          <Field label="Active pipeline">
            <select value={settings.pipeline_id || ''} onChange={e => pickPipeline(e.target.value)}
              style={inputStyle}>
              <option value="">— Select a pipeline —</option>
              {pipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
      </Section>

      {/* ── Live Sync toggle ───────────────────────────────────────────────── */}
      <Section title="Live Sync"
        subtitle="When ON, every Osprey sync run also pushes diffs to Freshsales. Leave OFF while you're staging mappings.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <span onClick={toggleLiveSync}
              style={{
                display: 'inline-flex', alignItems: 'center',
                width: 38, height: 22, borderRadius: 11, padding: 2,
                background: settings.live_sync_enabled ? 'var(--accent)' : 'var(--border)',
                transition: 'background 0.2s', cursor: 'pointer',
              }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                transform: settings.live_sync_enabled ? 'translateX(16px)' : 'translateX(0)',
                transition: 'transform 0.2s', display: 'block',
              }} />
            </span>
            <span onClick={toggleLiveSync} style={{
              fontSize: 14, fontWeight: settings.live_sync_enabled ? 600 : 400,
              color: settings.live_sync_enabled ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
              {settings.live_sync_enabled ? 'Live Sync ON — Osprey runs push to FS' : 'Live Sync OFF — staging mode'}
            </span>
          </label>
        </div>
      </Section>

      {/* ── Sync All ───────────────────────────────────────────────────────── */}
      <Section title="Sync All"
        subtitle="One-shot full push. Use this once after mappings are configured. After that, Live Sync handles ongoing updates.">
        <div className="space-y-3">
          <button onClick={syncAll}
            disabled={syncing || !configured || !testOk || !settings.pipeline_id}
            style={{
              ...primaryBtn,
              background: 'var(--status-ok)',
              opacity: (syncing || !configured || !testOk || !settings.pipeline_id) ? 0.5 : 1,
              cursor:  (syncing || !configured || !testOk || !settings.pipeline_id) ? 'not-allowed' : 'pointer',
            }}>
            {syncing ? 'Syncing…' : 'Sync All'}
          </button>
          {!settings.pipeline_id && testOk && (
            <p className="text-xs" style={{ color: 'var(--status-warn)' }}>
              ⚠ Pick a pipeline first.
            </p>
          )}
          {syncResult && (
            <div className="text-sm p-3 rounded"
              style={{
                background: syncResult.ok ? 'var(--status-ok-bg)' : 'var(--status-critical-bg)',
                color:      syncResult.ok ? 'var(--status-ok)'    : 'var(--status-critical)',
                border: '1px solid var(--border)',
              }}>
              {syncResult.ok
                ? <>Sync complete · {syncResult.stats?.created || 0} created · {syncResult.stats?.updated || 0} updated · {syncResult.stats?.skipped || 0} skipped · {syncResult.stats?.conflict || 0} conflicts · {syncResult.stats?.error || 0} errors</>
                : <>Sync failed: {syncResult.error}</>}
            </div>
          )}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Last full sync: {fmtTS(settings.last_full_sync_at)}{settings.last_full_sync_by ? ` · by ${settings.last_full_sync_by}` : ''}
          </p>
        </div>
      </Section>
    </div>
  );
}

// ─── tiny presentational helpers (kept inline so they don't bleed elsewhere)─

function Section({ title, subtitle, children }) {
  return (
    <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
      <div className="px-4 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>{title}</h2>
        {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--text-primary)',
  outline: 'none',
};

const primaryBtn = {
  padding: '6px 16px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
  background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
};

const ghostBtn = {
  padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
  background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
};
