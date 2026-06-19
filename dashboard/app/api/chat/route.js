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
import fs from 'fs';
import path from 'path';
import { createClient } from '../../../lib/supabaseServer';

// Allowlist — easy to extend. Anyone not in here gets 403 even if signed in.
const CHAT_ALLOWED_EMAILS = new Set([
  'steveb@growmail.com',
  'steven.t.bommarito@gmail.com',  // also allow Steven's personal account for testing
]);

// Model: default to OpenAI's flagship reasoning ("thinking") model. Override
// with OPENAI_CHAT_MODEL env var (e.g. 'o3-pro', 'o4-mini', a future GPT-5) —
// no code change needed. Reasoning models (o-series) reject the temperature
// param and run slower, so we branch on the name below.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'o3';
const IS_REASONING_MODEL = /^o\d/i.test(CHAT_MODEL);

// The agent's domain context lives in OPENAI_CONTEXT.md (single source of
// truth, human-editable). Read it once at module load. next.config.mjs
// force-includes it in this route's serverless bundle so the read works on
// Vercel. If the file can't be read for any reason, fall back to a minimal
// prompt so the agent still functions (degraded but not broken).
function loadSystemPrompt() {
  const candidates = [
    path.join(process.cwd(), 'OPENAI_CONTEXT.md'),
    path.join(process.cwd(), 'dashboard', 'OPENAI_CONTEXT.md'),
  ];
  for (const f of candidates) {
    try {
      const md = fs.readFileSync(f, 'utf8');
      if (md && md.length > 100) return md;
    } catch { /* try next */ }
  }
  return [
    'You are a PostgreSQL analyst for the GrowMail BI dashboard.',
    'Answer questions by generating ONE read-only SELECT (or WITH … SELECT) query.',
    'Return JSON only: { "explanation": "...", "sql": "SELECT ..." }.',
    'Single statement, no semicolons, starts with SELECT or WITH, LIMIT 100 by default.',
    'Main table: osprey_mail_drops (one row per mail_drop_id). A drop is COMPLETED when',
    'drop_act_date is set; LIVE when is_live_status and not yet mailed; FORECASTED when',
    'unmailed with a future drop_est_date. Exclude CANCELED/VOID/QUOTE/INCOMPLETE/LIMBO',
    'from operational answers. Postage = COALESCE(actual_postage, postage_amount).',
  ].join(' ');
}

const SYSTEM_PROMPT = loadSystemPrompt();

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
  // Build the payload. Reasoning models reject `temperature` (only the default
  // is allowed), so we only set it for non-reasoning models.
  const payload = {
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ],
    response_format: { type: 'json_object' },
  };
  if (!IS_REASONING_MODEL) payload.temperature = 0.1;

  let llmRes;
  try {
    llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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

// Reasoning models "think" before answering, so allow more wall-clock than a
// standard completion would need. 120s comfortably covers o3 on a SQL-gen task.
export const maxDuration = 120;
