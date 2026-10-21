'use client';

// Shared Hot Job (🔥) flagging, used by Cashflow and Late Mailings.
// Clicking a grey fire opens the "why is this hot?" popup; clicking a lit fire
// asks to remove it. Both write hot_jobs and log to notifications.

export async function saveHotJob(supabase, drop, reason, userEmail) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('hot_jobs')
    .upsert({ mail_drop_id: drop.mail_drop_id, reason, set_by: userEmail, set_at: now, is_hot: true, cleared_by: null, cleared_at: null }, { onConflict: 'mail_drop_id' });
  if (error) { console.error('hot_jobs upsert failed:', error.message); return null; }
  await supabase.from('notifications').insert({
    event_type: 'hot_job_set',
    title: `🔥 Hot Job flagged — Drop ${drop.mail_drop_id}`,
    body: `${drop.customer_name || drop.mail_drop_id}${reason ? ` — "${reason}"` : ''} flagged as hot by ${userEmail || 'unknown'}`,
    severity: 'warning',
    source: 'hot_jobs',
    data_json: { mail_drop_id: drop.mail_drop_id, reason, set_by: userEmail },
  });
  return { reason, set_by: userEmail, set_at: now };
}

export async function removeHotJob(supabase, drop, userEmail) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('hot_jobs')
    .update({ is_hot: false, cleared_by: userEmail, cleared_at: now })
    .eq('mail_drop_id', drop.mail_drop_id);
  if (error) { console.error('hot_jobs clear failed:', error.message); return false; }
  await supabase.from('notifications').insert({
    event_type: 'hot_job_cleared',
    title: `Hot Job cleared — Drop ${drop.mail_drop_id}`,
    body: `${drop.customer_name || drop.mail_drop_id} removed from hot list by ${userEmail || 'unknown'}`,
    severity: 'info',
    source: 'hot_jobs',
    data_json: { mail_drop_id: drop.mail_drop_id, cleared_by: userEmail },
  });
  return true;
}

// The fire toggle itself: lit when hot (hover shows tooltip), grey otherwise.
export function HotJobButton({ drop, isHot, onSet, onClear, setHotTooltip }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); isHot ? onClear(drop) : onSet(drop); }}
      title={isHot ? undefined : 'Mark as hot job'}
      onMouseEnter={e => isHot && setHotTooltip({ dropId: drop.mail_drop_id, x: e.clientX, y: e.clientY })}
      onMouseMove={e => isHot && setHotTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
      onMouseLeave={() => setHotTooltip(null)}
      style={{ fontSize: 14, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', filter: isHot ? 'none' : 'grayscale(1) opacity(0.35)', padding: 0, verticalAlign: 'middle' }}
    >🔥</button>
  );
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 9999,
};
const card = (width) => ({
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '20px 24px',
  width,
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
});
const cancelBtn = {
  padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
  background: 'var(--surface2)', border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};

// Reason popup (setModal = { drop }) and remove confirm (clearConfirm = { drop }).
export function HotJobDialogs({ setModal, onCloseSet, onSave, clearConfirm, onCloseClear, onRemove }) {
  return (
    <>
      {setModal && (
        <div onClick={onCloseSet} style={overlay}>
          <div onClick={e => e.stopPropagation()} style={card(360)}>
            <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
              🔥 Mark as Hot Job
            </p>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
              {setModal.drop.customer_name || setModal.drop.mail_drop_id} — Drop {setModal.drop.mail_drop_id}
            </p>
            <textarea
              autoFocus
              placeholder="Why is this hot? (optional)"
              id="hot-job-reason"
              rows={3}
              defaultValue=""
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '8px 10px', fontSize: 13,
                color: 'var(--text-primary)', resize: 'vertical',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={onCloseSet} style={cancelBtn}>Cancel</button>
              <button
                onClick={() => {
                  const reason = document.getElementById('hot-job-reason')?.value?.trim() || '';
                  onSave(setModal.drop, reason);
                  onCloseSet();
                }}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                  background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
                }}>
                Save 🔥
              </button>
            </div>
          </div>
        </div>
      )}

      {clearConfirm && (
        <div onClick={onCloseClear} style={overlay}>
          <div onClick={e => e.stopPropagation()} style={card(340)}>
            <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
              Remove from Hot Jobs?
            </p>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
              {clearConfirm.drop.customer_name || clearConfirm.drop.mail_drop_id} — Drop {clearConfirm.drop.mail_drop_id}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onCloseClear} style={cancelBtn}>Cancel</button>
              <button
                onClick={() => { onRemove(clearConfirm.drop); onCloseClear(); }}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                  background: 'var(--status-critical)', border: 'none', color: '#fff', fontWeight: 600,
                }}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
