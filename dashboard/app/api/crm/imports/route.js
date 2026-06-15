// GET /api/crm/imports?type=contacts_accounts — list imports, optionally
// filtered by type. Includes row-count progress per import so the list page
// can show "12,400 / 50,000 sent · 12 failed" without a follow-up query.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';

export async function GET(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  let q = supabase.from('crm_imports')
    .select('id, import_type, original_filename, total_rows, status, uploaded_by, uploaded_at, completed_at')
    .order('uploaded_at', { ascending: false })
    .limit(100);
  if (type) q = q.eq('import_type', type);
  const { data: imports, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Bulk-fetch row counts per import + status. Group in memory.
  const ids = (imports || []).map(i => i.id);
  let counts = {};
  if (ids.length) {
    const { data: rows } = await supabase.from('crm_import_rows')
      .select('import_id, status')
      .in('import_id', ids);
    for (const r of rows || []) {
      if (!counts[r.import_id]) counts[r.import_id] = { pending: 0, sent: 0, failed: 0, validation_failed: 0, skipped: 0 };
      counts[r.import_id][r.status] = (counts[r.import_id][r.status] || 0) + 1;
    }
  }

  const result = (imports || []).map(i => ({ ...i, counts: counts[i.id] || {} }));
  return NextResponse.json({ ok: true, imports: result });
}
