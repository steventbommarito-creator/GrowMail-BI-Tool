import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer';

export async function POST(request) {
  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { source } = await request.json();
  if (!['osprey', 'usps', 'both'].includes(source)) {
    return NextResponse.json({ ok: false, error: 'Invalid source' }, { status: 400 });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER || 'steventbommarito-creator';
  const repo = process.env.GITHUB_REPO_NAME || 'GrowMail-BI-Tool';

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/scrape.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { source },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  // Log to news feed
  await supabase.from('notifications').insert({
    event_type: 'manual_trigger',
    title: `Manual sync triggered: ${source.toUpperCase()}`,
    body: `Triggered by ${user.email}`,
    severity: 'info',
    source,
    data_json: { triggered_by: user.email, source },
  });

  return NextResponse.json({ ok: true });
}
