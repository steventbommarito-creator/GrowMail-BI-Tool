import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer';

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data?.user?.email?.endsWith('@growmail.com')) {
      return NextResponse.redirect(`${origin}/cashflow`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=unauthorized`);
}
