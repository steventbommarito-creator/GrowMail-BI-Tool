'use client';

// Compact avatar stack for the Nav. Each circle is a 2-letter initial tinted
// with a deterministic color derived from user id, so the same person is the
// same color every time. Hover shows full email. Caps at 4 avatars + "+N".

import { usePresence } from '../lib/usePresence';
import { hslFromId } from '../lib/presenceColor';

export default function PresenceAvatars() {
  const users = usePresence();
  if (users.length === 0) return null;

  const shown = users.slice(0, 4);
  const extra = users.length - shown.length;

  return (
    <div className="flex items-center -space-x-1.5" title={`${users.length} online`}>
      {shown.map(u => (
        <div key={u.user_id}
          title={u.email || u.name}
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2 select-none"
          style={{
            background: hslFromId(u.user_id),
            color: 'white',
            borderColor: 'var(--surface)',
          }}>
          {u.name.slice(0, 2).toUpperCase()}
        </div>
      ))}
      {extra > 0 && (
        <div
          title={`${extra} more online`}
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2 select-none"
          style={{
            background: 'var(--surface2)',
            color: 'var(--text-muted)',
            borderColor: 'var(--surface)',
          }}>
          +{extra}
        </div>
      )}
    </div>
  );
}
