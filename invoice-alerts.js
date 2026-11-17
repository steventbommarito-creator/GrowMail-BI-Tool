require('dotenv').config();
const supabase = require('./lib/supabase');

/**
 * "Create Invoice Alert" emails — one per mail drop that has reached Osprey
 * status 700 (COMPLETE, tax processed) for a customer on terms.
 *
 *   node invoice-alerts.js              # email new drops (daily job, 9am ET)
 *   node invoice-alerts.js --backfill   # record them for the dashboard, no email
 *   node invoice-alerts.js --dry-run    # print what would be sent, write nothing
 *
 * Candidates come from osprey_mail_drops (completed, mailed on/after
 * REPORT_START — same window as the dashboard's Invoicing Report). Only
 * customers whose customer_terms.term_label is something other than PrePay
 * qualify; no terms row means no alert. Valassis is excluded (separate
 * process). Status 700 and the invoice line items are read live from Osprey's
 * NetSuite check report, one row per line item.
 *
 * Each drop is claimed in invoice_alerts before its email goes out, so a drop
 * is never emailed twice; a failed send leaves email_sent_at null and is
 * retried on the next run.
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, OSPREY_USER, OSPREY_PASS, and
 * RESEND_API_KEY (not needed for --backfill / --dry-run).
 */

const REPORT_START = '2026-10-20';
const COMPLETE_STATUS_CODE = 700;
const RECIPIENTS = ['steveb@growmail.com', 'chrise@growmail.com', 'kathil@growmail.com', 'katec@growmail.com'];
const FROM = 'GrowMail Invoicing <invoicing@growmail.com>';
const REPLY_TO = 'steveb@growmail.com';
const EXCLUDED_CUSTOMERS = /^valassis/i;
const MAX_EMAILS_PER_RUN = 60;   // flood guard; anything past this waits for the next run
const OSPREY_API = 'https://api.onebrand.io/api/v1';
const OSPREY_ORDER_URL = 'https://osprey.onebrand.io/orders/';
const DASHBOARD_URL = 'https://tools.growmail.com/invoicing';

const BACKFILL = process.argv.includes('--backfill');
const DRY_RUN = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt$ = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isPrepayOrUnknown = (label) => ['', 'PREPAY', 'UNDEFINED'].includes(String(label || '').toUpperCase().trim());

async function fetchAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

let ospreyToken = null;
async function ospreyGet(path) {
  if (!ospreyToken) {
    const res = await fetch(`${OSPREY_API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: process.env.OSPREY_USER, password: process.env.OSPREY_PASS, tenantId: process.env.OSPREY_TENANT_ID || 'osprey-3wyx0' }),
    });
    if (!res.ok) throw new Error(`Osprey login failed: HTTP ${res.status}`);
    ospreyToken = (await res.json()).sessionCookie;
    if (!ospreyToken) throw new Error('Osprey login returned no session');
  }
  const res = await fetch(`${OSPREY_API}${path}`, { headers: { authorization: `Bearer ${ospreyToken}` } });
  if (!res.ok) throw new Error(`Osprey ${path}: HTTP ${res.status}`);
  return res.json();
}

// The drop's rows from the NetSuite check report. `search` is a text match, so
// keep only rows for this exact mail ID.
async function reportRows(mailDropId) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const j = await ospreyGet(`/reports/netsuite-check-report-dev?search=${encodeURIComponent(mailDropId)}&limit=100&page=${page}`);
    rows.push(...(j.data || []));
    if (!j.meta || j.meta.isLastPage !== false) break;
  }
  return rows
    .filter((r) => String(r.mail_order_id) === String(mailDropId))
    .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0));
}

function emailHtml(a) {
  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;';
  const lines = a.line_items.map((l) => `
    <tr><td style="${cell}">${esc(l.product)}</td>
        <td style="${cell}text-align:right;">${Number(l.quantity || 0).toLocaleString('en-US')}</td>
        <td style="${cell}text-align:right;">${fmt$(l.amount)}</td></tr>`).join('');
  const detail = (label, value) => `<tr><td style="padding:3px 16px 3px 0;color:#6b7280;">${label}</td><td style="padding:3px 0;"><strong>${value}</strong></td></tr>`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:640px;">
    <h2 style="margin:0 0 4px;">Create Invoice Alert</h2>
    <p style="margin:0 0 16px;color:#6b7280;">This drop is complete and tax has processed (status 700). It needs an invoice.</p>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      ${detail('Client', `${esc(a.customer_name)} (ID ${esc(a.customer_id)})`)}
      ${detail('Terms', esc(a.term_label))}
      ${detail('Order #', `<a href="${OSPREY_ORDER_URL}${encodeURIComponent(a.order_id)}">${esc(a.order_id)}</a>`)}
      ${detail('Mail ID', esc(a.mail_drop_id))}
      ${detail('Invoice #', `${esc(a.order_id)}-${esc(a.mail_drop_id)}`)}
      ${a.order_label ? detail('Job', esc(a.order_label)) : ''}
      ${a.mail_method ? detail('Mail method', esc(a.mail_method)) : ''}
      ${a.brand ? detail('Brand', esc(a.brand)) : ''}
      ${detail('Mailed', esc(a.drop_act_date || '—'))}
    </table>
    <p style="margin:0 0 6px;"><strong>Invoice line items</strong></p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
      <tr style="background:#f3f4f6;text-align:left;">
        <th style="padding:6px 10px;">Item</th><th style="padding:6px 10px;text-align:right;">Quantity</th><th style="padding:6px 10px;text-align:right;">Amount</th>
      </tr>
      ${lines}
      <tr><td style="padding:8px 10px;" colspan="2"><strong>Total</strong></td><td style="padding:8px 10px;text-align:right;"><strong>${fmt$(a.total_amount)}</strong></td></tr>
    </table>
    <p style="margin:0 0 6px;"><a href="${OSPREY_ORDER_URL}${encodeURIComponent(a.order_id)}">Open order ${esc(a.order_id)} in Osprey</a></p>
    <p style="margin:0;"><a href="${DASHBOARD_URL}">Open the Invoicing Report</a> to mark it invoiced in QuickBooks.</p>
  </div>`;
}

async function sendEmail(a) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: RECIPIENTS,
      reply_to: REPLY_TO,
      subject: `Create Invoice Alert: ${a.customer_name} — Order ${a.order_id}, Mail ID ${a.mail_drop_id}`,
      html: emailHtml(a),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message || JSON.stringify(body)}`);
  return body.id;
}

async function main() {
  // Scheduled runs fire at both 13:00 and 14:00 UTC so one of them is 9am
  // Eastern year-round; the other exits here.
  if (process.env.REQUIRE_ET_HOUR) {
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    if (hour !== Number(process.env.REQUIRE_ET_HOUR)) {
      console.log(`[invoice-alerts] It is ${hour}:00 Eastern, not ${process.env.REQUIRE_ET_HOUR}:00 — skipping.`);
      return;
    }
  }
  if (!BACKFILL && !DRY_RUN && !process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const drops = await fetchAll(() => supabase
    .from('osprey_mail_drops')
    .select('mail_drop_id, order_id, customer_id, customer_name, drop_act_date')
    .ilike('drop_status', 'complete%')
    .gte('drop_act_date', REPORT_START)
    .order('mail_drop_id'));

  const customerIds = [...new Set(drops.map((d) => d.customer_id).filter(Boolean))];
  const terms = {};
  for (let i = 0; i < customerIds.length; i += 200) {
    const { data, error } = await supabase.from('customer_terms').select('customer_id, term_label').in('customer_id', customerIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const t of data) terms[t.customer_id] = t.term_label;
  }

  // Done = emailed, or loaded by the backfill. Unsent live rows get retried.
  const existing = await fetchAll(() => supabase.from('invoice_alerts').select('mail_drop_id, source, email_sent_at').order('mail_drop_id'));
  const done = new Set(existing.filter((e) => e.source === 'backfill' || e.email_sent_at).map((e) => e.mail_drop_id));

  const pending = drops.filter((d) =>
    !isPrepayOrUnknown(terms[d.customer_id]) &&
    !EXCLUDED_CUSTOMERS.test((d.customer_name || '').trim()) &&
    !done.has(d.mail_drop_id));
  console.log(`[invoice-alerts] ${pending.length} completed terms drop(s) to check (${BACKFILL ? 'backfill' : DRY_RUN ? 'dry run' : 'live'}).`);

  let sent = 0, recorded = 0, notReady = 0, failed = 0;
  for (const d of pending) {
    if (!BACKFILL && sent >= MAX_EMAILS_PER_RUN) { console.log(`[invoice-alerts] Reached ${MAX_EMAILS_PER_RUN} emails; the rest wait for the next run.`); break; }
    let rows;
    try { rows = await reportRows(d.mail_drop_id); }
    catch (e) { failed++; console.error(`  ${d.mail_drop_id}: ${e.message}`); continue; }
    if (!rows.length || rows[0].status_code !== COMPLETE_STATUS_CODE) { notReady++; continue; }

    const line_items = rows.map((r) => ({ product: r.product_name, quantity: r.osprey_quantity, amount: r.osprey_amount }));
    const alert = {
      mail_drop_id: d.mail_drop_id,
      order_id: String(d.order_id),
      customer_id: d.customer_id,
      customer_name: (d.customer_name || '').trim(),
      term_label: String(terms[d.customer_id]).trim(),
      brand: rows[0].web_code || null,
      order_label: rows[0].order_label || null,
      mail_method: rows[0].mail_method_name || null,
      drop_act_date: d.drop_act_date,
      line_items,
      total_amount: Math.round(line_items.reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100,
      source: BACKFILL ? 'backfill' : 'live',
    };

    if (DRY_RUN) {
      console.log(`  would alert ${alert.order_id}-${alert.mail_drop_id} ${alert.customer_name} (${alert.term_label}) ${fmt$(alert.total_amount)}: ${line_items.map((l) => `${l.product} ${fmt$(l.amount)}`).join(' | ')}`);
      continue;
    }

    const { error: claimErr } = await supabase.from('invoice_alerts').upsert(alert, { onConflict: 'mail_drop_id' });
    if (claimErr) { failed++; console.error(`  ${d.mail_drop_id}: could not record alert: ${claimErr.message}`); continue; }
    recorded++;
    if (BACKFILL) continue;

    try {
      const emailId = await sendEmail(alert);
      await supabase.from('invoice_alerts').update({ email_sent_at: new Date().toISOString(), email_id: emailId, email_error: null }).eq('mail_drop_id', d.mail_drop_id);
      await supabase.from('notifications').insert({
        event_type: 'invoice_alert',
        title: `🧾 Create Invoice Alert — ${alert.order_id}-${alert.mail_drop_id}`,
        body: `${alert.customer_name} (${alert.term_label}) drop ${alert.mail_drop_id} is complete — ${fmt$(alert.total_amount)} to invoice`,
        severity: 'info',
        source: 'invoice_alerts',
        data_json: { mail_drop_id: alert.mail_drop_id, order_id: alert.order_id, total_amount: alert.total_amount },
      });
      sent++;
      console.log(`  emailed ${alert.order_id}-${alert.mail_drop_id} ${alert.customer_name} ${fmt$(alert.total_amount)}`);
    } catch (e) {
      failed++;
      await supabase.from('invoice_alerts').update({ email_error: e.message }).eq('mail_drop_id', d.mail_drop_id);
      console.error(`  ${d.mail_drop_id}: email failed: ${e.message}`);
    }
    await sleep(600);   // Resend allows 2 requests/second
  }

  console.log(`[invoice-alerts] Done: ${sent} emailed, ${recorded} recorded, ${notReady} not at status ${COMPLETE_STATUS_CODE} yet, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[invoice-alerts] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { emailHtml };
