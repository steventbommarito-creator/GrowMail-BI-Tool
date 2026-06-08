// POST /api/crm/test-connection — hit Freshworks with the saved API URL/Key
// and report success/failure. Writes the result back to crm_settings so the
// Integrations page can show "✓ Connected · 6/8 12:14 PM" without re-testing
// on every page load.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
const fw = require('../../../../../lib/freshworks');

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const res = await fw.testConnection(supabase);
  await supabase.from('crm_settings').update({
    last_test_at: new Date().toISOString(),
    last_test_ok: res.ok,
    last_test_message: res.ok ? 'Connected' : (res.error || 'Failed'),
  }).eq('id', 1);

  await supabase.from('crm_events').insert({
    event_type: 'test_connection',
    status: res.ok ? 'success' : 'error',
    title: res.ok ? 'CRM connection test succeeded' : 'CRM connection test failed',
    body: res.ok ? `Tested by ${user.email}` : `${res.error} (HTTP ${res.status})`,
    created_by: user.email,
  });

  return NextResponse.json({ ok: res.ok, error: res.error, status: res.status });
}
