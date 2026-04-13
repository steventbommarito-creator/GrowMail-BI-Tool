import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer';

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code       = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type       = searchParams.get('type') ?? 'email';

  const supabase = await createClient();

  // token_hash flow — works cross-browser (no PKCE verifier cookie required)
  if (token_hash) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (!error && data?.user) {
      if (data.user.email?.endsWith('@growmail.com')) {
        return NextResponse.redirect(`${origin}/cashflow`);
      }
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=unauthorized`);
    }
  }

  // PKCE code flow — requires code_verifier cookie from same browser session
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data?.user) {
      if (data.user.email?.endsWith('@growmail.com')) {
        return NextResponse.redirect(`${origin}/cashflow`);
      }
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=unauthorized`);
    }
    // Exchange failed — likely opened in a different browser than where link was requested
    return NextResponse.redirect(`${origin}/login?error=expired`);
  }

  return NextResponse.redirect(`${origin}/login?error=expired`);
}
