/**
 * Update customer_terms from a NetSuite "Customers" export.
 *
 *   node crm-import/customer-terms-update.js [--dry-run]
 *
 * Matches on customer ID (the CSV "ID" column) with any trailing "-GM" stripped
 * (the DB has no -GM). Maps the CSV "Terms" to the DB term_label; blank Terms ->
 * "Undefined". Upserts every CSV customer (onConflict customer_id), so new
 * customers are inserted and existing ones updated. Last-one-wins on duplicate
 * IDs. Reports the full before/after transition breakdown.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse/sync');
const C = require('./common');

const CSV = process.env.CUSTOMERS_CSV || path.join(os.homedir(), 'Downloads', 'Customers555.csv');
const BLANK_LABEL = 'Undefined';
const MAP = {
  'cash in advance': 'PrePay',
  'net 30': 'NET30', 'net 45': 'NET45', 'net 15': 'NET15',
  'net 10': 'NET10', 'net 7': 'NET7', 'cod': 'COD',
  'net 1 - auto pay': 'NET1 - Auto pay',
};

function mapTerm(raw) {
  const t = String(raw || '').trim();
  if (!t) return BLANK_LABEL;
  return MAP[t.toLowerCase()] || t;   // pass unknown values through unchanged
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const rows = parse(fs.readFileSync(CSV), { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });

  // Build customer_id -> term_label (last wins).
  const want = {};
  let hadGM = 0, blankTerms = 0;
  for (const r of rows) {
    let id = String(r['ID'] || '').trim();
    if (id.toUpperCase().endsWith('-GM')) { id = id.slice(0, -3); hadGM++; }
    if (!id) continue;
    if (!String(r['Terms'] || '').trim()) blankTerms++;
    want[id] = mapTerm(r['Terms']);
  }
  const ids = Object.keys(want);

  // Fetch current DB labels for the report.
  const cur = {};
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await C.supabase.from('customer_terms').select('customer_id, term_label').in('customer_id', ids.slice(i, i + 500));
    if (error) throw new Error(`fetch current failed: ${error.message}`);
    for (const d of data || []) cur[d.customer_id] = d.term_label;
  }

  // Categorize.
  const stat = { total: ids.length, noChange: 0, termsToPrepay: 0, prepayToTerms: 0, termsToTerms: 0,
    toUndefined_fromPrepay: 0, toUndefined_fromTerms: 0, newInserts: 0, newUndefined: 0 };
  for (const id of ids) {
    const nw = want[id], c = cur[id];
    if (c === undefined) { stat.newInserts++; if (nw === BLANK_LABEL) stat.newUndefined++; continue; }
    if (c === nw) { stat.noChange++; continue; }
    if (nw === BLANK_LABEL) { c === 'PrePay' ? stat.toUndefined_fromPrepay++ : stat.toUndefined_fromTerms++; continue; }
    if (c !== 'PrePay' && nw === 'PrePay') stat.termsToPrepay++;
    else if (c === 'PrePay' && nw !== 'PrePay') stat.prepayToTerms++;
    else stat.termsToTerms++;
  }

  console.log(`CSV: ${rows.length} rows -> ${ids.length} unique IDs (${hadGM} had -GM, ${blankTerms} blank Terms)`);
  console.log('Transition breakdown vs current customer_terms:');
  console.log(JSON.stringify(stat, null, 2));
  const changed = stat.termsToPrepay + stat.prepayToTerms + stat.termsToTerms + stat.toUndefined_fromPrepay + stat.toUndefined_fromTerms + stat.newInserts;
  console.log(`Rows that will change or be inserted: ${changed} (of ${ids.length}); ${stat.noChange} unchanged.`);

  // Blank Terms only sets "Undefined" for NEW customers; existing customers with
  // a blank in the file keep their current status (never downgrade to Undefined).
  const skipExistingBlank = ids.filter((id) => want[id] === BLANK_LABEL && cur[id] !== undefined);
  console.log(`Skipping ${skipExistingBlank.length} existing customers whose file Terms is blank (status left as-is).`);

  if (dryRun) { console.log('\nDRY RUN — nothing written.'); return; }

  // Upsert everything except existing-blank customers.
  const now = new Date().toISOString();
  const payload = ids
    .filter((id) => !(want[id] === BLANK_LABEL && cur[id] !== undefined))
    .map((id) => ({ customer_id: id, term_label: want[id], updated_at: now }));
  let done = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await C.supabase.from('customer_terms').upsert(payload.slice(i, i + 500), { onConflict: 'customer_id' });
    if (error) throw new Error(`upsert failed @${i}: ${error.message}`);
    done += Math.min(500, payload.length - i);
  }
  console.log(`\nUpserted ${done} customer_terms rows.`);
}

main().catch((e) => { console.error('CUSTOMER TERMS UPDATE FAILED:', e.message); process.exit(1); });
