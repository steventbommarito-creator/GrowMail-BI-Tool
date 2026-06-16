// GET /api/crm/imports/{id}/unique-values?column=<excel_col>
// Returns the distinct values for one Excel column across all the rows in
// this import, plus a row count per value. Used by the Value Mapping modal
// so the user sees every unique source value they need to assign a target
// to (or skip).
//
// SQL-side aggregation so we don't drag thousands of rows over the wire.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';

export async function GET(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const column = searchParams.get('column');
  if (!column) return NextResponse.json({ ok: false, error: 'column required' }, { status: 400 });

  // Postgres JSONB → text extraction + group + count. We rely on the
  // import_id index for the WHERE filter; this query stays fast even on
  // 100k-row imports because we never project the JSONB itself.
  const { data, error } = await supabase.rpc('crm_import_unique_values', {
    p_import_id: id,
    p_column: column,
  });

  if (error) {
    // Fall back to a JS-side aggregate if the RPC isn't deployed yet. Slower
    // (paginates the rows, dedups in memory) but correct.
    const counts = new Map();
    let from = 0; const size = 1000;
    while (true) {
      const { data: rows } = await supabase
        .from('crm_import_rows')
        .select('raw_json')
        .eq('import_id', id)
        .range(from, from + size - 1);
      if (!rows?.length) break;
      for (const r of rows) {
        const v = r.raw_json?.[column];
        if (v == null || v === '') continue;
        const k = String(v);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      if (rows.length < size) break;
      from += size;
    }
    const list = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    return NextResponse.json({ ok: true, values: list });
  }

  return NextResponse.json({ ok: true, values: data || [] });
}
