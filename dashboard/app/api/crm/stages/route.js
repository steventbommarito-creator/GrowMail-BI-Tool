// GET /api/crm/stages?pipeline_id=... — list the FS deal stages in the given
// pipeline. The Opportunities → mapping modal calls this to populate every
// dropdown with real FS stage IDs (and names like "New" / "Open" / "Won").

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
const fw = require('../../../../../lib/freshworks');

export async function GET(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const pipelineId = searchParams.get('pipeline_id');
  if (!pipelineId) return NextResponse.json({ ok: false, error: 'pipeline_id required' }, { status: 400 });

  const res = await fw.listStages(supabase, pipelineId);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 200 });
  return NextResponse.json({ ok: true, stages: res.data?.deal_stages || [] });
}
