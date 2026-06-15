// POST /api/crm/imports/{id}/push  body: { count }
// User clicked "Push next N rows". Hands off to lib/crmImport.pushBatch which
// claims the rows, normalizes, calls FS bulk_upsert, polls jobs, writes back.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';
const importer = require('../../../../../../../lib/crmImport');

export const runtime = 'nodejs';
export const maxDuration = 300;        // up to 5 min for a single batch push

export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const count = Math.max(1, Math.min(parseInt(body.count, 10) || 0, 5000));
  // 5000 hard cap per single request — bigger jobs should be split client-side.

  try {
    const result = await importer.pushBatch(supabase, id, count, { triggeredBy: user.email });
    await supabase.from('crm_events').insert({
      event_type: 'import_batch_pushed',
      status: result.failed > 0 ? 'warning' : 'success',
      entity_type: 'import', entity_id: id,
      title: `Pushed ${result.sent} rows · ${result.failed} failed`,
      body: `By ${user.email} (requested ${count})`,
      data_json: result,
      created_by: user.email,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
