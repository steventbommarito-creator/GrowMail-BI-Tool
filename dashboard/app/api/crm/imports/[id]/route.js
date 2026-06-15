// GET /api/crm/imports/{id} — full import detail.
//   import metadata + paginated rows + recent batches + row count by status.
//
// DELETE /api/crm/imports/{id} — cascade-delete the import + all rows + the
// storage file. Used by the trash button on the list page.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabaseServer';

export async function GET(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const offset = parseInt(searchParams.get('offset') || '0', 10);
  const limit  = Math.min(parseInt(searchParams.get('limit') || '200', 10), 1000);
  const status = searchParams.get('status'); // optional filter

  // Per-status counts — separate head-only count queries instead of fetching
  // all status values and tallying in JS. The fetch approach hit the 1k
  // PostgREST row cap, so a 2k import showed only 1k pending. With
  // count='exact', head=true we get a true COUNT(*) and no row payload.
  const STATUSES = ['pending', 'sent', 'failed', 'validation_failed', 'validating', 'skipped'];
  const countOne = (status) => supabase
    .from('crm_import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', id)
    .eq('status', status);

  const [{ data: imp }, batchesRes, ...countResults] = await Promise.all([
    supabase.from('crm_imports').select('*').eq('id', id).maybeSingle(),
    supabase.from('crm_import_batches').select('*').eq('import_id', id).order('started_at', { ascending: false }).limit(20),
    ...STATUSES.map(countOne),
  ]);
  if (!imp) return NextResponse.json({ ok: false, error: 'Import not found' }, { status: 404 });

  const counts = Object.fromEntries(STATUSES.map((s, i) => [s, countResults[i]?.count ?? 0]));

  // Page through rows
  let q = supabase.from('crm_import_rows')
    .select('id, row_index, raw_json, normalized_json, status, fs_id, fs_account_id, error_message, attempt_count, batch_id, attempted_at')
    .eq('import_id', id)
    .order('row_index', { ascending: true })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq('status', status);
  const { data: rows } = await q;

  return NextResponse.json({
    ok: true,
    import: imp,
    rows: rows || [],
    counts,
    batches: batchesRes.data || [],
  });
}

export async function DELETE(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { data: imp } = await supabase.from('crm_imports').select('storage_path').eq('id', id).maybeSingle();
  if (imp?.storage_path) {
    await supabase.storage.from('crm-imports').remove([imp.storage_path]).catch(() => {});
  }
  // crm_import_rows + crm_import_batches cascade via FK ON DELETE CASCADE.
  const { error } = await supabase.from('crm_imports').delete().eq('id', id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
