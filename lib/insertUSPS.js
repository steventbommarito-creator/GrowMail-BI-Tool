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
// Split on '_', first segment = osprey_order_id, last segment = osprey_mail_drop_id
function parseJobDescription(desc) {
  if (!desc) return { osprey_order_id: null, osprey_mail_drop_id: null };
  const parts = desc.trim().split('_');
  if (parts.length >= 3) {
    const orderId = parts[0];
    const mailDropId = parts[parts.length - 1];
    // Basic validation: both segments should be numeric
    if (/^\d+$/.test(orderId) && /^\d+$/.test(mailDropId)) {
      return { osprey_order_id: orderId, osprey_mail_drop_id: mailDropId };
    }
  }
  return { osprey_order_id: null, osprey_mail_drop_id: null };
}

async function insertUSPS(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const capturedAt = new Date().toISOString();

  const rows = records.map((r) => {
    const jobDesc = r['Job Description'] || '';
    const { osprey_order_id, osprey_mail_drop_id } = parseJobDescription(jobDesc);

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
    };
  });

  // Filter out rows with no transaction_number (required unique key)
  const validRows = rows.filter((r) => r.transaction_number);
  const skipped = rows.length - validRows.length;
  if (skipped > 0) {
    console.log(`  Skipping ${skipped} rows with no transaction_number`);
  }

  // Upsert in batches of 500 — conflict on transaction_number
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

  console.log(`insertUSPS complete — ${validRows.length} rows upserted into usps_transactions`);
  return validRows.length;
}

module.exports = { insertUSPS };
