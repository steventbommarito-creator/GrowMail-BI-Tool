// PUT /api/crm/imports/{id}/value-mapping
//   body: { value_mappings: { excel_col: { fs_field: { raw_value: target_or_null, ... } } } }
//
// Replaces the import's value_mappings_json with whatever the client sends.
// Mirror of the mapping endpoint pattern — full-state save, simple to reason
// about, easy to undo by re-saving the prior state. Null target = "skip this
// field on rows with this raw value".

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';

export async function PUT(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const value_mappings = body?.value_mappings ?? {};

  const { error } = await supabase
    .from('crm_imports')
    .update({ value_mappings_json: value_mappings })
    .eq('id', id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
