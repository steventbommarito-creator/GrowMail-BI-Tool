// GET /api/crm/imports/{id}/failed-csv  — download all failed + validation-failed
// rows as a CSV the user can fix in Excel and re-upload. Columns = the
// original Excel columns + an extra "_error" column at the end.

import { createClient } from '../../../../../../lib/supabaseServer';

export const runtime = 'nodejs';

export async function GET(_request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Not authenticated', { status: 401 });

  const { id } = await params;
  const [{ data: imp }, { data: rows }] = await Promise.all([
    supabase.from('crm_imports').select('excel_columns, import_type').eq('id', id).maybeSingle(),
    supabase.from('crm_import_rows')
      .select('row_index, raw_json, status, error_message')
      .eq('import_id', id)
      .in('status', ['failed', 'validation_failed'])
      .order('row_index', { ascending: true }),
  ]);
  if (!imp) return new Response('Import not found', { status: 404 });

  const cols = imp.excel_columns || [];
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['_row', ...cols, '_status', '_error'].map(escape).join(',');
  const lines = [header];
  for (const r of rows || []) {
    const row = [r.row_index, ...cols.map(c => r.raw_json?.[c] ?? ''), r.status, r.error_message || ''];
    lines.push(row.map(escape).join(','));
  }
  const csv = lines.join('\n');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="failed-${imp.import_type}-${id}.csv"`,
    },
  });
}
