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

  // Per-import per-status counts via head-only count queries. The earlier
  // approach selected status+import_id for every row across every import
  // and tallied in JS — that hit the 1k row cap (and would be wasteful at
  // 87k-row scale). With count='exact',head=true we get true COUNT(*)
  // per (import, status) with no row payload. KEY_STATUSES limits this to
  // the ones we actually display on the list cards.
  const ids = (imports || []).map(i => i.id);
  const KEY_STATUSES = ['pending', 'sent', 'failed'];
  const counts = {};
  if (ids.length) {
    const queries = [];
    for (const id of ids) {
      counts[id] = { pending: 0, sent: 0, failed: 0 };
      for (const status of KEY_STATUSES) {
        queries.push(
          supabase.from('crm_import_rows')
            .select('id', { count: 'exact', head: true })
            .eq('import_id', id)
            .eq('status', status)
            .then(r => ({ id, status, count: r?.count ?? 0 }))
        );
      }
    }
    const results = await Promise.all(queries);
    for (const r of results) counts[r.id][r.status] = r.count;
  }

  const result = (imports || []).map(i => ({ ...i, counts: counts[i.id] || {} }));
  return NextResponse.json({ ok: true, imports: result });
}
