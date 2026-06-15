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

// Smart delete: behavior depends on whether anything has been sent to FS.
//   • Nothing sent → full nuke: drop the Excel file from storage, delete the
//     import row, cascade-delete every row + batch.
//   • Some sent  → partial delete: only remove pending + validating rows
//     (the unprocessed ones). Keep the import record, the sent/failed/skipped
//     rows, and the original file — so the user retains an audit trail of
//     what made it to FS and what failed.
//   • ?force=true → always full nuke regardless of sent count (escape hatch).
export async function DELETE(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === 'true';

  const { data: imp } = await supabase.from('crm_imports').select('storage_path, original_filename, import_type').eq('id', id).maybeSingle();
  if (!imp) return NextResponse.json({ ok: false, error: 'Import not found' }, { status: 404 });

  // Count sent rows to decide which path to take.
  const { count: sentCount } = await supabase.from('crm_import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', id)
    .eq('status', 'sent');

  // ── Full delete ──────────────────────────────────────────────────────────
  if (force || (sentCount || 0) === 0) {
    if (imp.storage_path) {
      await supabase.storage.from('crm-imports').remove([imp.storage_path]).catch(() => {});
    }
    // crm_import_rows + crm_import_batches cascade via FK ON DELETE CASCADE.
    const { error } = await supabase.from('crm_imports').delete().eq('id', id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    await supabase.from('crm_events').insert({
      event_type: 'import_deleted', status: 'info',
      title: `Import deleted — ${imp.original_filename || id}`,
      body: `${imp.import_type} import fully removed (no rows had been sent to FS).`,
      created_by: user.email,
    });
    return NextResponse.json({ ok: true, mode: 'full' });
  }

  // ── Partial delete ──────────────────────────────────────────────────────
  // Drop pending + validating rows (the unprocessed ones). Keep everything
  // else so audit history is preserved. The original Excel file stays in
  // storage — it's the source of the sent records, useful for reference.
  const { count: removed } = await supabase.from('crm_import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', id)
    .in('status', ['pending', 'validating']);
  const { error: delErr } = await supabase.from('crm_import_rows')
    .delete()
    .eq('import_id', id)
    .in('status', ['pending', 'validating']);
  if (delErr) return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });

  await supabase.from('crm_events').insert({
    event_type: 'import_partially_cleared', status: 'info',
    title: `Unprocessed rows removed — ${imp.original_filename || id}`,
    body: `${removed ?? 0} pending/validating rows dropped. ${sentCount} sent rows preserved for audit.`,
    created_by: user.email,
  });
  return NextResponse.json({ ok: true, mode: 'partial', removed: removed ?? 0, sent: sentCount });
}
