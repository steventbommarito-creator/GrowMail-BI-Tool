// POST /api/webhooks/unbounce-lead
// Middleware endpoint for Unbounce (via Zapier "Webhooks by Zapier -> POST"):
// Zapier just posts the raw form fields here; we translate to a Freshworks lead
// (contact, lifecycle "Lead"), dedupe by email, and create it server-side using
// the app's existing Freshworks client (creds from crm_settings). Auth via a
// shared secret in the ?secret= query (or x-webhook-secret header).
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fw from '../../../../lib/freshworks';

export const runtime = 'nodejs';

const LEAD_LIFECYCLE_ID = 128081818855;   // "Lead"
const NEW_STATUS_ID = 127004203345;        // "New"
const DEFAULT_SOURCE_ID = 127007145728;    // "Web" — default lead source for Unbounce

function supa() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY,
  );
}

// Flexible field pick: match on a normalized key (lowercased, no spaces/_/-).
function pick(obj, candidates) {
  for (const k of Object.keys(obj || {})) {
    const norm = k.toLowerCase().replace(/[\s_-]/g, '');
    if (candidates.includes(norm)) {
      const v = obj[k];
      return Array.isArray(v) ? v[0] : v;   // Unbounce/Zapier can send arrays
    }
  }
  return undefined;
}

export async function POST(request) {
  const secret = process.env.UNBOUNCE_WEBHOOK_SECRET;
  const provided = request.headers.get('x-webhook-secret')
    || new URL(request.url).searchParams.get('secret');
  if (!secret) return NextResponse.json({ ok: false, error: 'endpoint not configured (set UNBOUNCE_WEBHOOK_SECRET)' }, { status: 503 });
  if (provided !== secret) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // Parse JSON or form-encoded body.
  let body = {};
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) body = await request.json();
    else { const fd = await request.formData(); fd.forEach((v, k) => { body[k] = v; }); }
  } catch {
    try { body = await request.json(); } catch { body = {}; }
  }

  const email = String(pick(body, ['email', 'emailaddress', 'emails']) || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'missing or invalid email', received_keys: Object.keys(body) }, { status: 400 });
  }
  const first = String(pick(body, ['firstname', 'fname', 'first']) || '').trim();
  const last = String(pick(body, ['lastname', 'lname', 'last', 'surname']) || '').trim();
  const phone = String(pick(body, ['phone', 'phonenumber', 'mobile', 'mobilenumber']) || '').trim();
  const srcName = String(pick(body, ['leadsource', 'source', 'campaign', 'page']) || '').trim();

  const supabase = supa();

  // Dedupe by email — skip if a contact already exists.
  const lk = await fw.call(supabase, 'GET', `/lookup?q=${encodeURIComponent(email)}&f=email&entities=contact`);
  const existing = (lk.data?.contacts?.contacts) || [];
  if (existing.length) {
    return NextResponse.json({ ok: true, skipped: 'exists', contact_id: existing[0].id });
  }

  // Optional: map a provided source name to a Freshworks lead source; else default to Web.
  let leadSourceId = DEFAULT_SOURCE_ID;
  if (srcName) {
    const ls = await fw.call(supabase, 'GET', '/selector/lead_sources');
    const hit = (ls.data?.lead_sources || []).find((s) => String(s.name || '').trim().toLowerCase() === srcName.toLowerCase());
    if (hit) leadSourceId = hit.id;
  }

  const contact = {
    first_name: (first || email.split('@')[0]).slice(0, 100),
    last_name: last.slice(0, 100),
    email,
    lifecycle_stage_id: LEAD_LIFECYCLE_ID,
    contact_status_id: NEW_STATUS_ID,
    lead_source_id: leadSourceId,
  };
  if (phone) contact.mobile_number = phone.replace(/[^\d+]/g, '');

  const res = await fw.call(supabase, 'POST', '/contacts', { contact });
  if (res.ok && res.data?.contact?.id) {
    return NextResponse.json({ ok: true, created: true, contact_id: res.data.contact.id });
  }
  return NextResponse.json({ ok: false, error: res.error || 'freshworks create failed', status: res.status }, { status: 502 });
}

// Health check (no secret needed) so you can confirm the route is live.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'unbounce-lead', method: 'POST', configured: !!process.env.UNBOUNCE_WEBHOOK_SECRET });
}
