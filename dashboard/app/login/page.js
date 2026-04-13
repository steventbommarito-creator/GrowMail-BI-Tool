'use client';

import { useState, useEffect } from 'react';
import { createClient } from '../../lib/supabase';
import { createClient as createBaseClient } from '@supabase/supabase-js';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';

// Plain client without PKCE — magic links use token_hash instead of code,
// so they work when opened in a different browser than where they were requested.
const supabaseNoPKCE = createBaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { flowType: 'implicit' } }
);

function LoginForm() {
  const [username, setUsername] = useState('');
  const [message, setMessage]   = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [checking, setChecking] = useState(true);

  const searchParams = useSearchParams();
  const router       = useRouter();
  const supabase     = createClient();
  const authError    = searchParams.get('error');

  // If already logged in, go straight to /cashflow
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email?.endsWith('@growmail.com')) {
        router.replace('/cashflow');
      } else {
        setChecking(false);
      }
    });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setMessage('');

    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      setError('Please enter your username.');
      return;
    }
    // Block if someone pastes a full email or adds @
    if (trimmed.includes('@')) {
      setError('Just enter the part before @growmail.com.');
      return;
    }

    const email = `${trimmed}@growmail.com`;
    setLoading(true);
    const { error: otpError } = await supabaseNoPKCE.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setLoading(false);

    if (otpError) {
      setError(otpError.message);
    } else {
      setMessage(`Magic link sent to ${email} — check your inbox.`);
    }
  }

  if (checking) return null; // brief flash prevention

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div className="rounded-xl shadow-lg p-8 w-full max-w-sm border"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>

        {/* Logo / title */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>GrowMail BI</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Sign in with your GrowMail account</p>
        </div>

        {authError === 'unauthorized' && (
          <div className="mb-4 rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)' }}>
            Access restricted to @growmail.com accounts.
          </div>
        )}
        {authError === 'expired' && (
          <div className="mb-4 rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--status-warning-bg, #fef3c7)', color: 'var(--status-warning, #92400e)' }}>
            That link has expired or was opened in a different browser. Request a new one below.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Email
            </label>
            {/* Split input: username + fixed domain */}
            <div className="flex items-center rounded-lg border overflow-hidden"
              style={{ borderColor: error ? 'var(--status-critical)' : 'var(--border)', background: 'var(--surface2)' }}>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value.replace(/[@\s]/g, ''))}
                placeholder="yourname"
                autoComplete="username"
                autoFocus
                required
                className="flex-1 px-3 py-2.5 text-sm bg-transparent outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
              <span className="px-3 py-2.5 text-sm select-none whitespace-nowrap border-l"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--surface)' }}>
                @growmail.com
              </span>
            </div>
          </div>

          {error   && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}
          {message && <p className="text-sm" style={{ color: 'var(--status-ok)' }}>{message}</p>}

          <button
            type="submit"
            disabled={loading || !!message}
            className="w-full py-2.5 rounded-lg text-sm font-semibold"
            style={{
              background: loading || message ? 'var(--surface2)' : 'var(--accent)',
              color: loading || message ? 'var(--text-muted)' : 'var(--accent-text)',
              border: '1px solid var(--border)',
              cursor: loading || message ? 'not-allowed' : 'pointer',
            }}>
            {loading ? 'Sending…' : message ? '✓ Link sent' : 'Send Magic Link'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
