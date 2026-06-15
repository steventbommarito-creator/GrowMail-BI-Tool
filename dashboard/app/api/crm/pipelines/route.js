// GET /api/crm/pipelines — fetch the list of FS deal pipelines so the user
// can pick one in the Integrations page. Pure passthrough; no DB writes.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
const fw = require('../../../../lib/freshworks');

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const res = await fw.listPipelines(supabase);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 200 });

  // FS returns { deal_pipelines: [{ id, name, ... }] }
  return NextResponse.json({ ok: true, pipelines: res.data?.deal_pipelines || [] });
}
