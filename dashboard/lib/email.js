// Outbound app email via Resend's HTTP API (auth emails go through Supabase's
// own Resend SMTP config; this is separate and needs RESEND_API_KEY).

export const QUOTES_FROM = 'GrowMail Quotes <quotes@growmail.com>';
export const QUOTER_EMAILS = ['katec@growmail.com', 'stephanieg@growmail.com'];

export async function sendEmail({ to, replyTo, subject, html, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: QUOTES_FROM,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      html,
      attachments,   // [{ filename, content: base64 }]
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message || JSON.stringify(body)}`);
  return body.id;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
