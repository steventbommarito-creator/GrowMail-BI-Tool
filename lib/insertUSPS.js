const fs = require('fs');
const { parse } = require('csv-parse/sync');
const supabase = require('./supabase');

function parseCurrency(val) {
  if (!val || val === 'N/A') return null;
  const cleaned = String(val).replace(/[$,]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(val) {
  if (!val || val === 'N/A') return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

function parseInteger(val) {
  if (!val || val === 'N/A') return null;
  const n = parseInt(String(val).replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

// Parse job_description for osprey join keys.
// Expected format: {order_id}_XX_{mail_drop_id}  e.g. 403264_VL_273506
function parseJobDescription(desc) {
  if (!desc) return { osprey_order_id: null, osprey_mail_drop_id: null };
  const parts = desc.trim().split('_');
  if (parts.length >= 3) {
    const orderId = parts[0];
    const mailDropId = parts[parts.length - 1];
    if (/^\d+$/.test(orderId) && /^\d+$/.test(mailDropId)) {
      return { osprey_order_id: orderId, osprey_mail_drop_id: mailDropId };
    }
  }
  return { osprey_order_id: null, osprey_mail_drop_id: null };
}

// DMM transactions are bulk/standard mail postage debits with no specific job ID
function isDMMTransaction(row) {
  const desc = (row['Job Description'] || '').toUpperCase();
  const jobId = (row['Job ID'] || '').toUpperCase();
  const txType = (row['Transaction Type'] || '');
  return (
    desc.includes('DMM') ||
    jobId.includes('DMM') ||
    txType === '3602-R' // Standard USPS postage debit type
  );
}

// Deposit transactions (credits to the EPS account)
function isDepositTransaction(row) {
  const amount = parseCurrency(row['Amount']);
  return amount != null && amount > 0;
}

async function insertUSPS(filePath) {
  const fileStats = require('fs').statSync(filePath);
  const fileSizeBytes = fileStats.size;
  const content = require('fs').readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const capturedAt = new Date().toISOString();

  const rows = records.map((r) => {
    const jobDesc = r['Job Description'] || '';
    const { osprey_order_id, osprey_mail_drop_id } = parseJobDescription(jobDesc);
    const isDmm = isDMMTransaction(r);
    const isDeposit = isDepositTransaction(r);

    return {
      captured_at: capturedAt,
      transaction_number: r['Transaction #'] || null,
      account_number: r['Account #'] || null,
      permit_pub: r['Permit / Pub'] || null,
      crid: r['CRID'] || null,
      po_of_permit: r['PO of Permit'] || null,
      po_of_mailing: r['PO of Mailing'] || null,
      transaction_date: parseDate(r['Date']),
      transaction_type: r['Transaction Type'] || null,
      customer_reference_id: r['Customer Reference ID'] || null,
      eps_tran_number: r['EPS Tran #'] || null,
      beginning_balance: parseCurrency(r['Beginning Balance']),
      amount: parseCurrency(r['Amount']),
      ending_balance: parseCurrency(r['Ending Balance']),
      pieces: parseInteger(r['Pieces']),
      user_code: r['User'] || null,
      open_date: parseDate(r['Open Date']),
      mailer_mailing_date: parseDate(r['Mailer Mailing Date']),
      certification_date: parseDate(r['Certification Date']),
      mailing_group_id: r['Mailing Group ID'] || null,
      job_id: r['Job ID'] || null,
      job_description: jobDesc || null,
      containers: parseInteger(r['Containers']),
      stage: r['Stage'] || null,
      mailing_agent: r['Mailing Agent'] || null,
      osprey_order_id,
      osprey_mail_drop_id,
      is_dmm: isDmm,
      is_deposit: isDeposit,
      transaction_bucket: isDmm ? 'dmm' : isDeposit ? 'deposit' : osprey_mail_drop_id ? 'matched' : 'unmatched',
    };
  });

  // Filter out rows with no transaction_number
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

  // Auto-clear projected deposits when real deposit appears on same date
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
