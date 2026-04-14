'use client';

// Why a client page instead of a route handler:
// signInWithOtp with flowType:'implicit' causes Supabase's auth server to redirect here
// with tokens in the URL *hash fragment* (e.g. #access_token=xxx).
// Hash fragments are never sent to the server, so a server-side route.js can't see them.
// The raw Supabase JS client (flowType:'implicit') auto-processes the hash on init.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { flowType: 'implicit' } }
    );

    async function handleSession(session) {
      if (!session?.user) return false;
      if (session.user.email?.endsWith('@growmail.com')) {
        router.replace('/cashflow');
      } else {
        await supabase.auth.signOut();
        router.replace('/login?error=unauthorized');
      }
      return true;
    }

    // Listen for SIGNED_IN — fires when the client auto-processes the hash fragment
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN') {
        await handleSession(session);
      }
    });

    // Also check immediately in case the session was already set before the listener
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) handleSession(session);
    });

    // Fallback: if nothing resolves in 6s the link is expired or invalid
    const timer = setTimeout(() => router.replace('/login?error=expired'), 6000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Signing you in…</p>
      </div>
    </div>
  );
}
