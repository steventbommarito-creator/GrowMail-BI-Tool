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
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

function parseInteger(val) {
  if (!val || val === 'N/A') return null;
  const n = parseInt(String(val).replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseBoolean(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();
  if (s === 'yes') return true;
  if (s === 'no') return false;
  return null;
}

async function insertOsprey(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const capturedAt = new Date().toISOString();
  const captureDate = capturedAt.split('T')[0];

  // Create snapshot record
  const { data: snapshot, error: snapErr } = await supabase
    .from('osprey_snapshots')
    .insert({ captured_at: capturedAt, row_count: records.length, is_backfill: false })
    .select()
    .single();

  if (snapErr) throw new Error(`Failed to create snapshot: ${snapErr.message}`);
  console.log(`Created snapshot ${snapshot.id} for ${records.length} rows`);

  const rows = records.map((r) => {
    const printLocation = (r['Print Location'] || '').trim();
    const mailLocation = (r['Mail Location'] || '').trim();
    const fulfillmentPath =
      printLocation && mailLocation
        ? `${printLocation} > ${mailLocation}`
        : printLocation || mailLocation || null;

    const mailDropAmount = parseCurrency(r['Mail Drop Amount']);
    const postageAmount = parseCurrency(r['Postage Amount']);
    const postagePct =
      mailDropAmount && mailDropAmount !== 0 && postageAmount !== null
        ? postageAmount / mailDropAmount
        : null;

    return {
      snapshot_id: snapshot.id,
      captured_at: capturedAt,
      capture_date: captureDate,
      customer_id: r['Customer ID'] || null,
      customer_name: r['Customer'] || null,
      order_id: r['Order ID'] || null,
      product_category: r['Product Category'] || null,
      order_quantity: parseInteger(r['Order Quantity']),
      order_amount: parseCurrency(r['Order Amount']),
      order_status: r['Order Status'] || null,
      payment_amount_applied: parseCurrency(r['Payment Amount Applied to Order']),
      mail_drop_id: r['Mail Drop ID'] || null,
      drop_number: parseInteger(r['Drop Number']),
      total_drops: parseInteger(r['Total Drops']),
      drop_est_date: parseDate(r['Drop Est. Date']),
      drop_act_date: parseDate(r['Drop Act. Date']),
      mail_drop_quantity: parseInteger(r['Mail Drop Quantity']),
      mail_drop_amount: mailDropAmount,
      postage_amount: postageAmount,
      postage_pct_of_drop: postagePct,
      fulfillment_path: fulfillmentPath,
      print_location: printLocation || null,
      mail_location: mailLocation || null,
      seller: r['Seller'] || null,
      is_subscription: parseBoolean(r['Is Subscription']),
      web_id: r['Web ID'] || null,
    };
  });

  // Upsert in batches of 500
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('osprey_mail_drops')
      .upsert(batch, { onConflict: 'mail_drop_id,capture_date', ignoreDuplicates: false });
    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
    inserted += batch.length;
    console.log(`  Upserted ${inserted}/${rows.length} rows`);
  }

  console.log(`insertOsprey complete — ${rows.length} rows upserted into osprey_mail_drops`);
  return rows.length;
}

module.exports = { insertOsprey };
