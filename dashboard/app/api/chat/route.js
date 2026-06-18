// POST /api/chat — natural-language → SQL analyst for the BI dashboard.
//
// Pipeline:
//   1. Auth check via Supabase session, then a hardcoded email allowlist
//      (one user for now — easy to expand).
//   2. Build a system prompt that teaches the LLM our schema + idioms.
//   3. Call OpenAI in JSON mode. The model returns { explanation, sql }.
//   4. Validate the SQL is a single SELECT/WITH statement.
//   5. Run it via exec_chat_sql (READ ONLY transaction; 30s statement_timeout).
//   6. Return { ok, explanation, sql, rows }.
//
// The widget renders rows as a table. We never include free-text data values
// in the system prompt — only schema — so the model can't be poisoned by
// dashboard content into emitting malicious queries.

import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer';

// Allowlist — easy to extend. Anyone not in here gets 403 even if signed in.
const CHAT_ALLOWED_EMAILS = new Set([
  'steveb@growmail.com',
  'steven.t.bommarito@gmail.com',  // also allow Steven's personal account for testing
]);

const SYSTEM_PROMPT = `
You are a PostgreSQL analyst for the GrowMail BI dashboard. The user asks
questions in plain English. You answer by generating a single SELECT (or WITH
… SELECT) query against the schema below. The query runs in a READ ONLY
transaction so no writes are possible — focus on accurate retrieval.

# Schema

## osprey_mail_drops — every mail drop from the Gordon & Lance report
- mail_drop_id (text)        unique ID for the drop
- order_id (text)            parent order (1 order → 1+ drops)
- customer_id (text)
- customer_name (text)
- product_category (text)    e.g. 'EDDM', 'Saturation Postcard', 'Custom Product'
- mail_location (text)       fulfillment facility ('Kaleidoscope', '4Over', 'Las Vegas Color', etc.)
- print_location (text)      may differ from mail_location
- fulfillment_path (text)    derived: print_location || ' > ' || mail_location
- mail_method (text)         e.g. 'EDDM', 'Saturation', 'Targeted Mail', 'LDP'
- order_status (text)        24 distinct values inc. 'COMPLETE', 'CANCELED', 'DAL [SUBMITTED]', 'DIGITAL READY', 'DMM [ACTIVE]', 'OUTSOURCED', 'QUOTE', etc.
- drop_status (text)
- is_live_status (bool)      TRUE = currently in production. Use this for "live" / "in flight" filters.
- drop_est_date (date)       scheduled mail date
- drop_act_date (date)       actual mail date (NULL = not yet mailed)
- mail_drop_quantity (int)
- mail_drop_amount (numeric) customer billing amount for this drop
- postage_amount (numeric)   estimated postage
- actual_postage (numeric)   posted postage once known
- production_amount (numeric)
- order_amount (numeric)     total order revenue
- payment_amount_applied (numeric)
- web_id (text)
- captured_at (timestamptz)  snapshot timestamp (latest wins per mail_drop_id)
- capture_date (date)

NOTE: there are multiple snapshots per mail_drop_id. To get the current state
of each drop, use the latest captured_at per mail_drop_id:
    WITH latest AS (
      SELECT DISTINCT ON (mail_drop_id) *
      FROM osprey_mail_drops
      ORDER BY mail_drop_id, captured_at DESC
    )

## customer_terms — payment terms per customer
- customer_id (text)
- term_label (text)          'PrePay' | 'NET30' | 'NET45' | 'Other'

## usps_transactions — EPS charges
- transaction_number (text)
- transaction_date (date)
- amount (numeric)
- osprey_mail_drop_id (text) — joins to osprey_mail_drops.mail_drop_id when this charge corresponds to a drop

## planned_drops — user-set "plan to mail" dates
- mail_drop_id (text)
- planned_date (date)
- planned_by (text)
- is_active (bool)

## hot_jobs — user-flagged "hot" drops
- mail_drop_id (text)
- reason (text)
- set_by (text)
- is_hot (bool)

# Domain idioms

- "Late mail" / "past due" = is_live_status = TRUE AND drop_est_date < CURRENT_DATE AND drop_act_date IS NULL
- "Live order statuses" the dashboard treats as in-flight:
    ('DAL [SUBMITTED]', 'DIGITAL READY', 'DIGITAL [STAGING]', 'OUTSOURCED', 'OUTSOURCED [STAGING]')
- "Required postage" for a drop = COALESCE(actual_postage, postage_amount)
- "PrePay open balance" on an order = (order_amount - payment_amount_applied) > 0  (only meaningful for term_label = 'PrePay')
- "Fulfillment location" = mail_location (the facility shipping the mail)
- LDP drops are typically excluded from postage-funding views: mail_method != 'LDP' OR mail_method IS NULL
- "EPS-deducted" = drop has a matching row in usps_transactions on osprey_mail_drop_id

# Output rules

Return ONLY a JSON object — no markdown, no extra text. Shape:
{
  "explanation": "1–2 sentence friendly summary of what the result shows",
  "sql": "SELECT ..."
}

The SQL MUST:
- Be a single statement (no semicolons)
- Start with SELECT or WITH
- Use the dedup CTE pattern shown above when querying current drop state
- LIMIT 100 by default (unless the user explicitly asks for more or wants aggregates)
- Use lowercase identifiers; cast to numeric and round to 2 decimal places for currency
- ORDER intelligently (usually DESC by the main metric the user asked for)
- For "by location" / "by facility" / "by X" requests, GROUP BY that column and aggregate counts + sums
`;

export async function POST(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!CHAT_ALLOWED_EMAILS.has(user.email)) {
    return NextResponse.json({ ok: false, error: 'Not authorized for chat' }, { status: 403 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: 'OPENAI_API_KEY not configured on server' }, { status: 500 });
  }

  const body = await request.json();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return NextResponse.json({ ok: false, error: 'No messages' }, { status: 400 });

  // ── Call OpenAI ────────────────────────────────────────────────────────
  let llmRes;
  try {
    llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages,
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Network error reaching OpenAI: ${e.message}` }, { status: 502 });
  }
  if (!llmRes.ok) {
    const err = await llmRes.text();
    return NextResponse.json({ ok: false, error: `OpenAI ${llmRes.status}: ${err.slice(0, 400)}` }, { status: 502 });
  }
  const llmJson = await llmRes.json();
  const raw = llmJson?.choices?.[0]?.message?.content;
  if (!raw) return NextResponse.json({ ok: false, error: 'LLM returned empty content' }, { status: 502 });

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return NextResponse.json({ ok: false, error: 'LLM returned non-JSON', raw }, { status: 502 }); }

  const explanation = String(parsed?.explanation || '').trim();
  let sql = String(parsed?.sql || '').trim();
  // Strip a single trailing semicolon if present, then re-validate.
  sql = sql.replace(/;\s*$/, '');

  // ── Safety checks ──────────────────────────────────────────────────────
  if (!sql) return NextResponse.json({ ok: false, error: 'LLM did not return a SQL query', explanation });
  if (!/^(select|with)\b/i.test(sql)) {
    return NextResponse.json({ ok: false, error: 'Only SELECT/WITH queries allowed', sql });
  }
  if (sql.includes(';')) {
    return NextResponse.json({ ok: false, error: 'Multiple statements not allowed', sql });
  }
  // Belt-and-suspenders keyword block — the read-only transaction at the DB
  // layer also rejects these, but bouncing early gives a cleaner error.
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i.test(sql)) {
    return NextResponse.json({ ok: false, error: 'Write keywords not allowed in chat queries', sql });
  }

  // ── Execute ────────────────────────────────────────────────────────────
  const { data: rows, error: sqlErr } = await supabase.rpc('exec_chat_sql', { p_sql: sql });
  if (sqlErr) return NextResponse.json({ ok: false, error: sqlErr.message, sql });

  return NextResponse.json({
    ok: true,
    explanation,
    sql,
    rows: rows || [],
  });
}

// Allow up to 60s for slow LLM responses + query execution.
export const maxDuration = 60;
