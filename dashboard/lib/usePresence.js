'use client';

// Realtime presence hook. Joins a shared Supabase channel and returns the list
// of currently-connected authenticated users. Supabase evicts disconnected
// clients automatically, so closing a tab removes the user from everyone
// else's list within a few seconds.

import { useEffect, useState } from 'react';
import { createClient } from './supabase';
import { emailPrefix } from './presenceColor';

export function usePresence(channelName = 'dashboard-presence') {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    const supabase = createClient();
    let channel;
    let mounted = true;

    (async () => {
      // Use getSession() not getUser() — getSession reads from local cookie/
      // storage cache (instant) while getUser hits the network to validate
      // the JWT (can take several seconds, blocking the channel subscribe).
      // For presence we only need user.id + email; if the cached session is
      // stale the Realtime subscribe will fail downstream and we'll bail.
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user || !mounted) return;

      channel = supabase.channel(channelName, {
        config: { presence: { key: user.id } },
      });

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        // presenceState() returns { [key]: Array<entry> } — multiple tabs from
        // the same user show up as multiple entries under the same key, so we
        // dedupe by user_id before surfacing to the UI.
        const seen = new Map();
        for (const entry of Object.values(state).flat()) {
          if (!seen.has(entry.user_id)) seen.set(entry.user_id, entry);
        }
        setUsers([...seen.values()]);
      });

      channel.subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        await channel.track({
          user_id: user.id,
          name: emailPrefix(user.email),
          email: user.email,
        });
      });
    })();

    return () => {
      mounted = false;
      if (channel) channel.unsubscribe();
    };
  }, [channelName]);

  return users;
}
