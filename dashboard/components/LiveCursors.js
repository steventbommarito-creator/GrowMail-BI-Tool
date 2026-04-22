'use client';

// Renders everyone else's cursor as a colored arrow + name chip. Portals the
// overlay to document.body so cursors can use `position: absolute` against
// the document origin — combined with document-relative coordinates (see
// useLiveCursors), the cursors stay glued to content even when viewers are
// scrolled to different spots on a long page.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveCursors } from '../lib/useLiveCursors';

export default function LiveCursors({ channel }) {
  const cursors = useLiveCursors(channel);
  // document isn't defined during SSR, so defer the portal until after mount.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;

  const list = Object.values(cursors);
  if (list.length === 0) return null;

  return createPortal(
    <div style={{
      position: 'absolute',
      top: 0, left: 0,
      pointerEvents: 'none',
      zIndex: 9999,
    }}>
      {list.map(c => (
        <div key={c.user_id} style={{
          position: 'absolute',
          transform: `translate(${c.x}px, ${c.y}px)`,
          // Smooth the gap between broadcasts (we send every 50ms) so the
          // cursor glides rather than teleports.
          transition: 'transform 60ms linear',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24"
            style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.3))' }}>
            <path d="M2 2 L20 12 L12 14 L10 22 Z"
              fill={c.color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span style={{
            display: 'inline-block',
            marginLeft: 4, marginTop: -4,
            padding: '1px 6px',
            borderRadius: 3,
            fontSize: 10, fontWeight: 500, color: 'white',
            background: c.color,
            whiteSpace: 'nowrap',
          }}>
            {c.name}
          </span>
        </div>
      ))}
    </div>,
    document.body
  );
}
