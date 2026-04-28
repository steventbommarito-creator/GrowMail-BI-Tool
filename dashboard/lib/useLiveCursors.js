'use client';

// Live cursor hook. Broadcasts this user's cursor position on a per-page
// channel and returns a map of everyone else's cursors keyed by user id.
//
// Coordinates are stored in DOCUMENT space (clientX + scrollX) so cursors
// stay pinned to content — if you're scrolled to the cashflow table and I'm
// looking at the chart up top, you see my cursor sitting on the chart rather
// than jumping into your viewport.

import { useEffect, useRef, useState } from 'react';
import { createClient } from './supabase';
import { emailPrefix, hslFromId } from './presenceColor';

const BROADCAST_MS = 50;    // upper bound: 20 updates/sec per user
const STALE_MS     = 4000;  // drop a cursor we haven't heard from in this long

export function useLiveCursors(channelName) {
  const [cursors, setCursors] = useState({});
  const meRef = useRef(null);
  const channelRef = useRef(null);
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (!channelName) return;
    const supabase = createClient();
    let mounted = true;

    (async () => {
      // Use getSession() not getUser() — getSession reads from local cookie/
      // storage cache (instant) while getUser hits the network to validate
      // the JWT (can take several seconds, blocking the channel subscribe
      // and dropping every mousemove until it finally resolves).
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user || !mounted) return;

      meRef.current = {
        user_id: user.id,
        name: emailPrefix(user.email),
        color: hslFromId(user.id),
      };

      const channel = supabase.channel(channelName, {
        // self:false prevents Supabase from echoing my own broadcasts back
        // to me — otherwise I'd render my own cursor on top of the native one.
        config: { broadcast: { self: false } },
      });
      channelRef.current = channel;

      channel.on('broadcast', { event: 'cursor' }, ({ payload }) => {
        setCursors(prev => ({
          ...prev,
          [payload.user_id]: { ...payload, lastSeen: Date.now() },
        }));
      });

      channel.on('broadcast', { event: 'leave' }, ({ payload }) => {
        setCursors(prev => {
          if (!prev[payload.user_id]) return prev;
          const next = { ...prev };
          delete next[payload.user_id];
          return next;
        });
      });

      channel.subscribe();
    })();

    function handleMove(e) {
      const now = Date.now();
      if (now - lastSentRef.current < BROADCAST_MS) return;
      // Don't burn broadcast quota while the tab is in the background.
      if (document.hidden) return;
      const me = meRef.current;
      const ch = channelRef.current;
      if (!me || !ch) return;
      lastSentRef.current = now;
      ch.send({
        type: 'broadcast',
        event: 'cursor',
        payload: {
          user_id: me.user_id,
          name: me.name,
          color: me.color,
          x: e.clientX + window.scrollX,
          y: e.clientY + window.scrollY,
        },
      });
    }

    window.addEventListener('mousemove', handleMove);

    // Sweep out cursors we haven't heard from recently. Covers cases where a
    // client disconnected without sending a leave event (network blip, crash).
    const gc = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      setCursors(prev => {
        let changed = false;
        const next = {};
        for (const [id, c] of Object.entries(prev)) {
          if (c.lastSeen > cutoff) next[id] = c;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 2000);

    return () => {
      mounted = false;
      window.removeEventListener('mousemove', handleMove);
      clearInterval(gc);
      if (channelRef.current) {
        // Announce departure so others remove our cursor immediately rather
        // than waiting for the stale-sweep timer to catch up.
        channelRef.current.send({
          type: 'broadcast',
          event: 'leave',
          payload: { user_id: meRef.current?.user_id },
        });
        channelRef.current.unsubscribe();
      }
    };
  }, [channelName]);

  return cursors;
}
