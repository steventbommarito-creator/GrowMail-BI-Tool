// POST /api/quotes/intake
// Public (no login — allowed through proxy.js). The /intake page uploads any
// files straight to the quote-files bucket under intake/, then posts the form
// here. We create the request via the submit_quote_request() RPC (the only
// thing anon can do to the quote tables) and email the rep a confirmation.
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendEmail, escapeHtml, QUOTER_EMAILS } from '../../../../lib/email';
import { productLabel, specRows } from '../../../../lib/quoteSpecs';

export const runtime = 'nodejs';

function fmtDate(d) {
  if (!d) return null;
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function confirmationHtml(code, p) {
  const rows = [
    ['Customer', p.customer_name],
    ['Product', productLabel(p.product_type)],
    ['Quantities', p.quantities.map(q => Number(q).toLocaleString()).join(' / ')],
    ...specRows(p.product_type, p.specs),
    ['Artwork ready', fmtDate(p.artwork_ready_date)],
    ['Target in-home', fmtDate(p.in_home_date)],
    ['Files', (p.files || []).map(f => f.name).join(', ')],
    ['Notes', p.notes],
  ].filter(([, v]) => v);

  const tr = rows.map(([k, v]) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#5c6478;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#1a1d23;white-space:pre-wrap">${escapeHtml(v)}</td>
    </tr>`).join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;max-width:600px">
    <p>Hi ${escapeHtml(p.rep_name.split(' ')[0])},</p>
    <p>We received your custom quote request. Your quote number is
      <strong style="font-size:16px">${escapeHtml(code)}</strong> — reference it in any follow-up.</p>
    <p>Here's what you submitted:</p>
    <table style="border-collapse:collapse;border-top:1px solid #e2e5ea;width:100%">${tr}</table>
    <p style="margin-top:20px">Need to change something? Just reply to this email.</p>
    <p style="color:#9aa0b0;font-size:12px">GrowMail Quotes</p>
  </div>`;
}

export async function POST(request) {
  let p;
  try { p = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }

  // Honeypot: real users never see or fill this field.
  if (p.website) return NextResponse.json({ ok: true, quote_code: null });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } },
  );

  const payload = {
    rep_name: p.rep_name,
    rep_email: String(p.rep_email || '').trim().toLowerCase(),
    customer_name: p.customer_name,
    product_type: p.product_type,
    quantities: (p.quantities || []).filter(Boolean),
    specs: p.specs || {},
    artwork_ready_date: p.artwork_ready_date || null,
    in_home_date: p.in_home_date || null,
    notes: p.notes || null,
    files: p.files || [],
  };

  const { data, error } = await supabase.rpc('submit_quote_request', { p: payload });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const code = data?.[0]?.quote_code;

  let emailSent = true;
  try {
    await sendEmail({
      to: payload.rep_email,
      replyTo: QUOTER_EMAILS,
      subject: `${code} — custom quote request received (${payload.customer_name})`,
      html: confirmationHtml(code, payload),
    });
  } catch (e) {
    // The request is saved either way; don't make the rep resubmit.
    console.error('intake confirmation email failed', code, e.message);
    emailSent = false;
  }

  return NextResponse.json({ ok: true, quote_code: code, emailSent });
}
