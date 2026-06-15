// POST /api/crm/imports/upload  — multipart/form-data { file, type }
//   1. Upload the file blob to Supabase Storage (bucket: crm-imports)
//   2. Parse it with xlsx, insert crm_imports + crm_import_rows
//   3. Return the new import_id so the UI can navigate to the detail page
//
// Body shape: FormData with fields:
//   file — the .xlsx / .csv / .xls
//   type — 'contacts_accounts' | 'leads' | 'opportunities' | 'tasks'

import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabaseServer';
const importer = require('../../../../../lib/crmImport');

export const runtime = 'nodejs';        // xlsx + buffers need Node, not Edge
export const maxDuration = 60;          // parsing 100k+ rows can take time

export async function POST(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let form;
  try { form = await request.formData(); }
  catch (e) { return NextResponse.json({ ok: false, error: 'Bad form data' }, { status: 400 }); }

  const file = form.get('file');
  const type = String(form.get('type') || '');
  const VALID = ['contacts_accounts', 'leads', 'opportunities', 'tasks'];
  if (!file || typeof file === 'string') return NextResponse.json({ ok: false, error: 'file required' }, { status: 400 });
  if (!VALID.includes(type))             return NextResponse.json({ ok: false, error: 'invalid type' }, { status: 400 });

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // ── parse first so we can fail fast on bad spreadsheets ────────────────────
  let parsed;
  try { parsed = importer.parseExcel(buffer); }
  catch (e) { return NextResponse.json({ ok: false, error: `Parse failed: ${e.message}` }, { status: 400 }); }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'Spreadsheet has no data rows' }, { status: 400 });
  }

  // ── upload original file to Storage (best-effort; not strictly required) ──
  const storagePath = `${type}/${Date.now()}_${file.name || 'upload.xlsx'}`;
  const { error: upErr } = await supabase.storage.from('crm-imports').upload(storagePath, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) console.warn('Storage upload failed (continuing):', upErr.message);

  // ── insert crm_imports row ─────────────────────────────────────────────────
  const { data: imp, error: impErr } = await supabase.from('crm_imports').insert({
    import_type: type,
    original_filename: file.name || null,
    storage_path: upErr ? null : storagePath,
    total_rows: parsed.rows.length,
    sheet_name: parsed.sheetName,
    excel_columns: parsed.columns,
    mapping_json: {},
    status: 'mapping',
    uploaded_by: user.email,
  }).select().single();
  if (impErr) return NextResponse.json({ ok: false, error: `Insert import failed: ${impErr.message}` }, { status: 500 });

  // ── insert crm_import_rows in chunks (Supabase has payload limits) ────────
  const CHUNK = 500;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const slice = parsed.rows.slice(i, i + CHUNK).map((r, j) => ({
      import_id: imp.id,
      row_index: i + j + 1,
      raw_json: r,
      status: 'pending',
    }));
    const { error: rErr } = await supabase.from('crm_import_rows').insert(slice);
    if (rErr) {
      await supabase.from('crm_imports').delete().eq('id', imp.id);
      return NextResponse.json({ ok: false, error: `Row insert failed at ${i}: ${rErr.message}` }, { status: 500 });
    }
  }

  await supabase.from('crm_events').insert({
    event_type: 'import_uploaded', status: 'info',
    entity_type: 'import', entity_id: imp.id,
    title: `Uploaded ${parsed.rows.length} ${type.replace('_', ' ')} rows`,
    body: `File: ${file.name || 'unnamed'} · sheet: ${parsed.sheetName}`,
    data_json: { import_id: imp.id, type, total_rows: parsed.rows.length },
    created_by: user.email,
  });

  return NextResponse.json({ ok: true, import_id: imp.id, total_rows: parsed.rows.length, columns: parsed.columns });
}
