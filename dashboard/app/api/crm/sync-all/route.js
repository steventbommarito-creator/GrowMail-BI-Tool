// POST /api/crm/sync-all — fire the Sync All button on the Integrations page.
// Runs the full sync (ctx.force = true) and returns the stats. This is a
// blocking call by design — Sync All is rare and the user wants to see the
// result. For ongoing syncs the cron path (insertOsprey) handles it.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
const sync = require('../../../../../lib/crmSync');

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  try {
    const res = await sync.syncAll(supabase, { triggeredBy: user.email });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Long-running — give Vercel up to 5 min to complete the push.
export const maxDuration = 300;
