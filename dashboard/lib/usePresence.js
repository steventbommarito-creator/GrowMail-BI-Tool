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
    console.log('[Presence] hook mounted, channel =', channelName);
    const supabase = createClient();
    let channel;
    let mounted = true;

    (async () => {
      // Use getSession() not getUser() — getSession reads from local cookie/
      // storage cache (instant, sync-ish) while getUser hits the network to
      // validate the JWT (can take several seconds, blocking the channel
      // subscribe). For presence we only need user.id + email; if the cached
      // session is stale the Realtime subscribe will fail downstream.
      const { data: { session }, error } = await supabase.auth.getSession();
      const user = session?.user;
      console.log('[Presence] getSession result:', { user_id: user?.id, email: user?.email, error });
      if (!user || !mounted) {
        console.log('[Presence] BAILING — no user or unmounted', { hasUser: !!user, mounted });
        return;
      }

      channel = supabase.channel(channelName, {
        config: { presence: { key: user.id } },
      });

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        console.log('[Presence] sync event, raw state:', state);
        const seen = new Map();
        for (const entry of Object.values(state).flat()) {
          if (!seen.has(entry.user_id)) seen.set(entry.user_id, entry);
        }
        const list = [...seen.values()];
        console.log('[Presence] deduped users:', list.length, list.map(u => u.name));
        setUsers(list);
      });

      channel.subscribe(async (status) => {
        console.log('[Presence] subscribe status:', status);
        if (status !== 'SUBSCRIBED') return;
        const trackResult = await channel.track({
          user_id: user.id,
          name: emailPrefix(user.email),
          email: user.email,
        });
        console.log('[Presence] track result:', trackResult);
      });
    })();

    return () => {
      console.log('[Presence] cleanup, unsubscribing');
      mounted = false;
      if (channel) channel.unsubscribe();
    };
  }, [channelName]);

  return users;
}
