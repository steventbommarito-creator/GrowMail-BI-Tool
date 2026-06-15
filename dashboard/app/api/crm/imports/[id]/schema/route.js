// GET /api/crm/imports/{id}/schema — fetch FS field schema for the import's
// type. The mapping UI populates its right-side dropdown from this list, so
// the user picks real FS field names instead of guessing.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../../lib/supabaseServer';
const fw = require('../../../../../../lib/freshworks');

export async function GET(_request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const { id } = await params;
  const { data: imp } = await supabase.from('crm_imports').select('import_type').eq('id', id).maybeSingle();
  if (!imp) return NextResponse.json({ ok: false, error: 'Import not found' }, { status: 404 });

  // Choose the FS endpoint per entity type. For contacts_accounts we fetch
  // both contact and account fields and merge with a prefix so the user can
  // map "account.name" vs "first_name" without ambiguity.
  let res;
  let fields = [];

  if (imp.import_type === 'contacts_accounts') {
    const [c, a] = await Promise.all([fw.getContactFields(supabase), fw.getAccountFields(supabase)]);
    if (c.ok) fields.push(...flattenForm(c.data, 'contact'));
    if (a.ok) fields.push(...flattenForm(a.data, 'account'));
    // virtual field — required for our dedup table
    fields.push({ name: 'account_external_id', label: 'Account External ID (REQUIRED)', type: 'string', required: true, group: 'account' });
  } else if (imp.import_type === 'leads') {
    res = await fw.getContactFields(supabase);
    if (res.ok) fields = flattenForm(res.data, 'contact');
  } else if (imp.import_type === 'opportunities') {
    res = await fw.getDealFields(supabase);
    if (res.ok) fields = flattenForm(res.data, 'deal');
  } else if (imp.import_type === 'tasks') {
    res = await fw.getTaskFields(supabase);
    if (res.ok) fields = flattenForm(res.data, 'task');
  }

  if (fields.length === 0) {
    return NextResponse.json({ ok: false, error: res?.error || 'No fields returned from FS' });
  }
  return NextResponse.json({ ok: true, fields });
}

// FS /api/settings/{entity}/fields returns { fields: [...] } — a flat array
// of every default + custom field. We expose all of them as mappable, with
// the group (contact|account|deal|task) prefixed to the label so the user
// can tell which entity each field belongs to in the merged dropdown.
function flattenForm(data, group) {
  const list = data?.fields || data?.form?.fields || [];
  return list
    // Skip relationship/lookup placeholders that aren't directly mappable
    // — auto_complete = a contact/account picker, not a value-carrying field
    .filter(f => f?.name && f.type !== 'auto_complete')
    .map(f => ({
      name: f.name,
      label: f.label || f.name,
      type: f.type || 'string',
      required: !!f.required,
      group,
      // expose dropdown choices so a future "preview value" UI can validate
      choices: Array.isArray(f.choices) ? f.choices.map(c => c.value || c.label).filter(Boolean) : null,
    }));
}
