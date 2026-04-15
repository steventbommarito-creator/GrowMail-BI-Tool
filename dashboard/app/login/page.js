'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient as createBaseClient } from '@supabase/supabase-js';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';

// flowType: 'implicit' prevents the client from trying to attach a PKCE
// code challenge to verifyOtp — we never started a PKCE flow so there's
// nothing in storage, which causes the default PKCE client to send a
// malformed request. Implicit bypasses that entirely.
const supabase = createBaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { flowType: 'implicit' } }
);

function LoginForm() {
  const [username, setUsername]   = useState('');
  const [otp, setOtp]             = useState('');
  const [step, setStep]           = useState('email');   // 'email' | 'otp'
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpRef  = useRef(null);
  const router  = useRouter();
  const searchParams = useSearchParams();
  const authError    = searchParams.get('error');

  // Already logged in → skip straight to cashflow
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email?.endsWith('@growmail.com')) router.replace('/cashflow');
    });
  }, []);

  // Focus OTP input when it appears
  useEffect(() => {
    if (step === 'otp') otpRef.current?.focus();
  }, [step]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function sendOtp(email) {
    // signInWithOtp without emailRedirectTo → Supabase sends a 6-digit code (not a magic link)
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    return err;
  }

  async function handleSendCode(e) {
    e.preventDefault();
    setError('');
    const trimmed = username.trim().toLowerCase().replace(/[@\s]/g, '');
    if (!trimmed) { setError('Enter your username.'); return; }
    const email = `${trimmed}@growmail.com`;
    setLoading(true);
    const err = await sendOtp(email);
    setLoading(false);
    if (err) { setError(err.message); return; }
    setStep('otp');
    setResendCooldown(60);
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    const code = otp.trim();
    if (code.length < 6) { setError('Enter the full code.'); return; }
    const email = `${username.trim().toLowerCase().replace(/[@\s]/g, '')}@growmail.com`;
    setLoading(true);
    const { data, error: err } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    setLoading(false);
    if (err) { setError(`${err.message} (status: ${err.status})`); return; }
    if (!data?.user?.email?.endsWith('@growmail.com')) {
      await supabase.auth.signOut();
      setError('Access restricted to @growmail.com accounts.');
      return;
    }
    router.replace('/cashflow');
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    setError('');
    setOtp('');
    const email = `${username.trim().toLowerCase().replace(/[@\s]/g, '')}@growmail.com`;
    setLoading(true);
    const err = await sendOtp(email);
    setLoading(false);
    if (err) { setError(err.message); return; }
    setResendCooldown(60);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div className="rounded-xl shadow-lg p-8 w-full max-w-sm border"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>

        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>GrowMail BI</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {step === 'email' ? 'Sign in with your GrowMail account' : `Code sent to ${username}@growmail.com`}
          </p>
        </div>

        {authError === 'unauthorized' && (
          <div className="mb-4 rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)' }}>
            Access restricted to @growmail.com accounts.
          </div>
        )}

        {/* ── Step 1: Email ── */}
        {step === 'email' && (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Username
              </label>
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
            {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 rounded-lg text-sm font-semibold"
              style={{
                background: loading ? 'var(--surface2)' : 'var(--accent)',
                color: loading ? 'var(--text-muted)' : 'var(--accent-text)',
                border: '1px solid var(--border)',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}>
              {loading ? 'Sending…' : 'Send Code'}
            </button>
          </form>
        )}

        {/* ── Step 2: OTP ── */}
        {step === 'otp' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                Sign-in code
              </label>
              <input
                ref={otpRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="123456"
                autoComplete="one-time-code"
                className="w-full px-3 py-2.5 text-sm rounded-lg border outline-none text-center tracking-widest font-mono"
                style={{
                  background: 'var(--surface2)',
                  color: 'var(--text-primary)',
                  borderColor: error ? 'var(--status-critical)' : 'var(--border)',
                  fontSize: '1.4rem',
                  letterSpacing: '0.4em',
                }}
              />
            </div>
            {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>{error}</p>}
            <button type="submit" disabled={loading || otp.length < 6}
              className="w-full py-2.5 rounded-lg text-sm font-semibold"
              style={{
                background: (loading || otp.length < 6) ? 'var(--surface2)' : 'var(--accent)',
                color: (loading || otp.length < 6) ? 'var(--text-muted)' : 'var(--accent-text)',
                border: '1px solid var(--border)',
                cursor: (loading || otp.length < 6) ? 'not-allowed' : 'pointer',
              }}>
              {loading ? 'Verifying…' : 'Sign In'}
            </button>
            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
              <button type="button" onClick={() => { setStep('email'); setError(''); setOtp(''); }}
                style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                ← Change email
              </button>
              <button type="button" onClick={handleResend} disabled={resendCooldown > 0}
                style={{
                  color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--accent)',
                  background: 'none', border: 'none',
                  cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer',
                }}>
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
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
