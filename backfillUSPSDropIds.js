// Backfill osprey_mail_drop_id on existing usps_transactions rows by parsing
// the job_id (EPS "Detail") column. Safe to re-run — only updates rows where
// osprey_mail_drop_id is NULL and a drop id can be parsed.
//
// Run with: node backfillUSPSDropIds.js

const supabase = require('./lib/supabase');

function parseDropId(detail) {
  if (!detail) return null;
  const s = String(detail).trim();
  if (!s) return null;
  const trailing = s.match(/_(\d{4,})$/);
  if (trailing) return trailing[1];
  if (/^\d{4,}$/.test(s)) return s;
  return null;
}

async function main() {
  console.log('Fetching usps_transactions rows with NULL osprey_mail_drop_id...');
  const { data, error } = await supabase
    .from('usps_transactions')
    .select('transaction_number, job_id, is_dmm')
    .is('osprey_mail_drop_id', null);

  if (error) throw new Error(`Fetch failed: ${error.message}`);
  console.log(`  ${data.length} candidate rows`);

  const updates = [];
  for (const row of data) {
    // Don't gate on is_dmm — PURCHASE-type rows like "402278_GM_271239" also
    // encode a drop id that the actuals + cashflow pages need to match on.
    // parseDropId returns null on detail strings without trailing digits, so
    // deposits and fee rows stay correctly unmatched.
    const dropId = parseDropId(row.job_id);
    if (!dropId) continue;
    updates.push({ transaction_number: row.transaction_number, osprey_mail_drop_id: dropId });
  }

  console.log(`  ${updates.length} rows to update`);
  if (updates.length === 0) {
    console.log('Nothing to backfill. Done.');
    return;
  }

  // Upsert in batches of 500
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    // Use upsert on transaction_number — only the osprey_mail_drop_id field is changed
    // (any other columns are left untouched because we only send these two keys).
    const { error: upsertErr } = await supabase
      .from('usps_transactions')
      .upsert(batch, { onConflict: 'transaction_number', ignoreDuplicates: false });
    if (upsertErr) throw new Error(`Upsert failed at batch ${i}: ${upsertErr.message}`);
    done += batch.length;
    console.log(`  Updated ${done}/${updates.length}`);
  }

  console.log('Backfill complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
