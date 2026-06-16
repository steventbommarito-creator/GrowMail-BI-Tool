// PUT /api/crm/imports/{id}/static-values
//   body: { static_values: { fs_field: value, ... } }
//
// Replaces the import's static_values_json. Each entry sets a single FS
// field to a fixed value for every row in this import. Empty / missing
// entries are ignored. The engine applies these AFTER the per-row mapping
// and value-mapping pass, so they always win.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';

export async function PUT(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const static_values = body?.static_values ?? {};

  const { error } = await supabase
    .from('crm_imports')
    .update({ static_values_json: static_values })
    .eq('id', id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
