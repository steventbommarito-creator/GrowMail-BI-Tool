/**
 * Update customer_terms from a "customer assignment terms report" CSV
 * (columns: customer_id, customer_name, customer_email, sales_rep, payment_term, notes).
 *
 *   node crm-import/customer-terms-report-update.js [--dry-run]
 *
 * - Every CSV customer is upserted with its payment_term (normalized, e.g.
 *   "NET 60" -> "NET60"); a blank payment_term -> PrePay.
 * - Missing terms default to PrePay: existing "Undefined"/blank rows not in the
 *   CSV, and any osprey_mail_drops customer with no customer_terms row at all.
 * - Existing rows that aren't in the CSV and already have a real term are left alone.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse/sync');
const C = require('./common');

const CSV = process.env.TERMS_CSV || path.join(os.homedir(), 'Downloads', 'customer assignment terms report v3 (2).csv');
const DEFAULT_LABEL = 'PrePay';
const MISSING = new Set(['', 'undefined', 'null']);

function mapTerm(raw) {
  const t = String(raw || '').trim();
  if (MISSING.has(t.toLowerCase())) return DEFAULT_LABEL;
  if (t.toLowerCase() === 'prepay') return 'PrePay';
  const m = t.match(/^net\s*(\d+)(\s*days)?$/i);   // "NET 60", "NET 20 DAYS" -> NET60, NET20
  if (m) return `NET${m[1]}`;
  return t;                                        // pass unusual terms through unchanged
}

async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await C.supabase.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`fetch ${table} failed: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const rows = parse(fs.readFileSync(CSV), { columns: true, bom: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });

  const want = {};
  for (const r of rows) {
    const id = String(r['customer_id'] || '').trim();
    if (id) want[id] = mapTerm(r['payment_term']);
  }

  const cur = {};
  for (const d of await fetchAll('customer_terms', 'customer_id, term_label')) cur[d.customer_id] = d.term_label;

  // Missing terms -> PrePay: Undefined rows outside the CSV, and drop customers with no row.
  for (const [id, label] of Object.entries(cur)) {
    if (!(id in want) && MISSING.has(String(label || '').trim().toLowerCase())) want[id] = DEFAULT_LABEL;
  }
  let newFromDrops = 0;
  for (const d of await fetchAll('osprey_mail_drops', 'customer_id')) {
    const id = String(d.customer_id || '').trim();
    if (id && !(id in want) && !(id in cur)) { want[id] = DEFAULT_LABEL; newFromDrops++; }
  }

  const stat = { noChange: 0, inserts: 0, undefinedToPrepay: 0, termsToPrepay: 0, prepayToTerms: 0, termsToTerms: 0 };
  const transitions = {};
  const payload = [];
  const now = new Date().toISOString();
  for (const [id, nw] of Object.entries(want)) {
    const c = cur[id];
    if (c === nw) { stat.noChange++; continue; }
    payload.push({ customer_id: id, term_label: nw, updated_at: now });
    if (c === undefined) stat.inserts++;
    else if (MISSING.has(String(c).trim().toLowerCase())) stat.undefinedToPrepay++;
    else if (nw === 'PrePay') stat.termsToPrepay++;
    else if (c === 'PrePay') stat.prepayToTerms++;
    else stat.termsToTerms++;
    if (c !== undefined) { const k = `${c} -> ${nw}`; transitions[k] = (transitions[k] || 0) + 1; }
  }
  const untouched = Object.keys(cur).filter((id) => !(id in want)).length;

  console.log(`CSV: ${rows.length} rows; DB: ${Object.keys(cur).length} rows; ${newFromDrops} drop customers had no terms row`);
  console.log(JSON.stringify(stat, null, 2));
  console.log('Transitions on existing rows:', JSON.stringify(transitions, null, 2));
  console.log(`Writing ${payload.length} rows; ${untouched} existing rows not in CSV left as-is.`);

  if (dryRun) { console.log('\nDRY RUN — nothing written.'); return; }

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await C.supabase.from('customer_terms').upsert(payload.slice(i, i + 500), { onConflict: 'customer_id' });
    if (error) throw new Error(`upsert failed @${i}: ${error.message}`);
  }
  console.log(`\nUpserted ${payload.length} customer_terms rows.`);
}

main().catch((e) => { console.error('CUSTOMER TERMS UPDATE FAILED:', e.message); process.exit(1); });
