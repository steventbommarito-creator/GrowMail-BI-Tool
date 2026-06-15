// PUT /api/crm/imports/{id}/mapping  body: { mapping: { ExcelCol: fs_field, ... } }
// Saves the column→field mapping for an import. Idempotent; called every
// time the user changes a dropdown in the Mapping UI. Also flips the import
// status to 'ready' once a mapping is saved (so the Push button enables).

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';

export async function PUT(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const mapping = body?.mapping ?? {};
  if (typeof mapping !== 'object' || Array.isArray(mapping)) {
    return NextResponse.json({ ok: false, error: 'mapping must be an object' }, { status: 400 });
  }

  // Only flip to 'ready' if we still have pending rows; otherwise leave the
  // existing status (e.g. 'complete') alone.
  const { count: pending } = await supabase.from('crm_import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', id).eq('status', 'pending');
  const newStatus = pending > 0 ? 'ready' : undefined;

  const patch = { mapping_json: mapping };
  if (newStatus) patch.status = newStatus;

  const { error } = await supabase.from('crm_imports').update(patch).eq('id', id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
