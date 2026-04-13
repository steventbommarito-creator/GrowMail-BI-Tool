const fs = require('fs');
const { parse } = require('csv-parse/sync');
const supabase = require('./supabase');

function parseCurrency(val) {
  if (!val || val === 'N/A') return null;
  const cleaned = String(val).replace(/[$,()]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(val) {
  if (!val || val === 'N/A') return null;
  const s = String(val).trim();
  if (!s) return null;
  // Handle "04/13/2026 10:58:06 AM" format — extract date part only
  const datePart = s.split(' ')[0];
  const d = new Date(datePart);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

async function insertUSPS(filePath) {
  const fileStats = fs.statSync(filePath);
  const fileSizeBytes = fileStats.size;
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`  Parsed ${records.length} rows from CSV`);
  if (records.length > 0) {
    console.log('  Columns detected:', Object.keys(records[0]).join(', '));
  }

  const capturedAt = new Date().toISOString();

  const rows = records.map((r) => {
    // EPS Transaction History Report columns:
    // Transaction ID, Date (ET), Due Date, Amount, Transaction Type, Description, Detail
    const rawAmount = r['Amount'] || '';
    const amount = parseCurrency(rawAmount);
    const txType = (r['Transaction Type'] || '').toUpperCase();
    const description = r['Description'] || '';
    const detail = r['Detail'] || '';

    const isDeposit = txType === 'DEPOSIT' || (amount != null && amount > 0);
    const isDmm = description.toUpperCase().includes('DMM') || detail.toUpperCase().includes('DMM');

    return {
      captured_at: capturedAt,
      transaction_number: r['Transaction ID'] || null,
      transaction_date: parseDate(r['Date (ET)']),
      amount,
      transaction_type: r['Transaction Type'] || null,
      job_description: description || null,   // "USPS Marketing Mail", "FEDWIRE", etc.
      job_id: detail || null,                 // "DMM_4_13_26_STND_LTR_D", etc.
      account_number: r['EPS Account Number'] || null,
      ending_balance: parseCurrency(r['Available Balance']),
      is_dmm: isDmm,
      is_deposit: isDeposit,
      transaction_bucket: isDeposit ? 'deposit' : isDmm ? 'dmm' : 'unmatched',
    };
  });

  const validRows = rows.filter((r) => r.transaction_number);
  const skipped = rows.length - validRows.length;
  if (skipped > 0) console.log(`  Skipping ${skipped} rows with no transaction_number`);

  // Upsert in batches of 500
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < validRows.length; i += BATCH) {
    const batch = validRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('usps_transactions')
      .upsert(batch, { onConflict: 'transaction_number', ignoreDuplicates: false });
    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
    upserted += batch.length;
    console.log(`  Upserted ${upserted}/${validRows.length} rows`);
  }

  // Auto-clear projected deposits when a real deposit appears on the same date
  const depositDates = validRows
    .filter(r => r.is_deposit && r.transaction_date)
    .map(r => r.transaction_date);

  if (depositDates.length > 0) {
    for (const date of depositDates) {
      const { data: proj } = await supabase
        .from('projected_deposits')
        .select('id, amount')
        .eq('deposit_date', date)
        .eq('is_active', true)
        .maybeSingle();

      if (proj) {
        await supabase
          .from('projected_deposits')
          .update({
            is_active: false,
            cleared_at: capturedAt,
            cleared_by_transaction: date,
          })
          .eq('id', proj.id);

        await supabase.from('notifications').insert({
          event_type: 'deposit_cleared',
          title: `Projected deposit cleared for ${date}`,
          body: `Projected $${proj.amount.toLocaleString()} deposit on ${date} was matched by a real EPS deposit.`,
          severity: 'info',
          source: 'usps',
          data_json: { date, projected_amount: proj.amount },
        });

        console.log(`  Cleared projected deposit for ${date}`);
      }
    }
  }

  console.log(`insertUSPS complete — ${validRows.length} rows upserted into usps_transactions`);
  return { rowCount: validRows.length, fileSizeBytes };
}

module.exports = { insertUSPS };
