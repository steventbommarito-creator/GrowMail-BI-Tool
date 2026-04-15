import { createBrowserClient } from '@supabase/ssr';

// Singleton — one GoTrueClient instance per browser session.
// Multiple instances sharing the same storage key corrupt each other's
// PKCE code verifiers, causing verifyOtp to return 403.
let _client = null;

export function createClient() {
  if (typeof window === 'undefined') {
    // Server-side: always create fresh (no global state on server)
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }
  return _client;
}
