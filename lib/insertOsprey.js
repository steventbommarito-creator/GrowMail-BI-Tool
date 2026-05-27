const fs = require('fs');
const { parse } = require('csv-parse/sync');
const supabase = require('./supabase');

/**
 * Osprey sometimes exports customer names with unescaped inner double-quotes
 * (e.g. Dulce "Maggy" Santibanez). csv-parse rejects those with
 * "Invalid Closing Quote". This pre-pass escapes any bare " inside a quoted
 * field before handing off to the parser.
 */
function repairCsvQuotes(content) {
  return content.split('\n').map((line) => {
    if (!line.includes('"')) return line;
    let out = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], next = line[i + 1];
      if (!inQuotes) {
        out += c;
        if (c === '"') inQuotes = true;
      } else if (c === '"') {
        if (next === '"') { out += '""'; i++; }                                          // already escaped
        else if (next === ',' || next === '\r' || next === undefined || i === line.length - 1) { out += '"'; inQuotes = false; } // closing quote
        else { out += '""'; }                                                             // unescaped interior — fix it
      } else { out += c; }
    }
    return out;
  }).join('\n');
}

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

// Live drop statuses that indicate postage is needed
const LIVE_STATUSES = ['outsourced', 'production', 'pending ship'];

function isLiveStatus(status) {
  if (!status) return false;
  return LIVE_STATUSES.some(s => status.toLowerCase().includes(s));
}

async function insertOsprey(filePath, triggeredBy = 'cron') {
  const fileStats = fs.statSync(filePath);
  const fileSizeBytes = fileStats.size;
  const content = repairCsvQuotes(fs.readFileSync(filePath, 'utf8'));
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
    // Osprey renamed "Postage Amount" → "Est. Postage" on the Gordon & Lance
    // report. Read the new header but keep the old as a fallback so this
    // works against any older CSVs lying around (and silently survived the
    // gap before this fix landed).
    const postageAmount = parseCurrency(r['Est. Postage'] ?? r['Postage Amount']);
    // New columns on the Gordon & Lance report — Actual Postage is the real
    // production cost once Osprey has priced the drop. Mail Method is the
    // categorical mail class (EDDM / Saturation / Targeted Mail / etc.).
    const actualPostage = parseCurrency(r['Actual Postage']);
    const mailMethod = (r['Mail Method'] || '').trim() || null;
    const dropAmount = parseCurrency(r['Mail Drop Amount']);
    const productionAmount = (dropAmount != null && postageAmount != null)
      ? dropAmount - postageAmount
      : null;
    const postagePct =
      mailDropAmount && mailDropAmount !== 0 && postageAmount !== null
        ? postageAmount / mailDropAmount
        : null;

    const dropStatus = (r['Mail Drop Status'] || r['Order Status'] || '').trim();
    const dropEstDate = parseDate(r['Drop Est. Date']);
    const dropActDate = parseDate(r['Drop Act. Date']);

    // On Time / Late flag
    let deliveryFlag = null;
    if (dropActDate && dropEstDate) {
      deliveryFlag = dropActDate <= dropEstDate ? 'on_time' : 'late';
    }

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
      drop_est_date: dropEstDate,
      drop_act_date: dropActDate,
      mail_drop_quantity: parseInteger(r['Mail Drop Quantity']),
      mail_drop_amount: mailDropAmount,
      postage_amount: postageAmount,         // estimated postage (Est. Postage on the report)
      actual_postage: actualPostage,         // real cost once production has priced the drop
      mail_method: mailMethod,                // EDDM / Saturation / Targeted Mail / etc.
      production_amount: productionAmount,
      postage_pct_of_drop: postagePct,
      fulfillment_path: fulfillmentPath,
      print_location: printLocation || null,
      mail_location: mailLocation || null,
      seller: r['Seller'] || null,
      is_subscription: parseBoolean(r['Is Subscription']),
      web_id: r['Web ID'] || null,
      drop_status: dropStatus || null,
      is_live_status: isLiveStatus(dropStatus),
      delivery_flag: deliveryFlag,
    };
  });

  // Upsert mail drops in batches of 500 — one row per mail_drop_id, updated in place.
  // onConflict: 'mail_drop_id' ensures re-syncing updates the existing row rather than
  // inserting duplicates. capture_date / captured_at / snapshot_id are updated to reflect
  // the most recent sync, so status always reflects current Osprey state.
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('osprey_mail_drops')
      .upsert(batch, { onConflict: 'mail_drop_id', ignoreDuplicates: false });
    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
    inserted += batch.length;
    console.log(`  Upserted ${inserted}/${rows.length} rows`);
  }

  // Log status history — only insert new status observations
  const statusRows = rows
    .filter(r => r.mail_drop_id && r.drop_status)
    .map(r => ({
      mail_drop_id: r.mail_drop_id,
      order_id: r.order_id,
      status: r.drop_status,
      observed_at: capturedAt,
      snapshot_id: snapshot.id,
    }));

  // Fetch last known status per drop to detect changes
  const dropIds = [...new Set(statusRows.map(r => r.mail_drop_id))];
  const { data: lastStatuses } = await supabase
    .from('drop_status_history')
    .select('mail_drop_id, status')
    .in('mail_drop_id', dropIds)
    .order('observed_at', { ascending: false });

  const lastStatusMap = {};
  for (const s of lastStatuses || []) {
    if (!lastStatusMap[s.mail_drop_id]) lastStatusMap[s.mail_drop_id] = s.status;
  }

  const newStatusRows = statusRows.filter(r =>
    lastStatusMap[r.mail_drop_id] !== r.status
  );

  if (newStatusRows.length > 0) {
    for (let i = 0; i < newStatusRows.length; i += BATCH) {
      const { error } = await supabase
        .from('drop_status_history')
        .insert(newStatusRows.slice(i, i + BATCH));
      if (error) console.error('Status history insert error:', error.message);
    }
    console.log(`  Logged ${newStatusRows.length} new status changes`);
  }

  // Log date history — detect scheduled date changes
  const dateRows = rows
    .filter(r => r.mail_drop_id && r.drop_est_date)
    .map(r => ({
      mail_drop_id: r.mail_drop_id,
      order_id: r.order_id,
      scheduled_date: r.drop_est_date,
      actual_date: r.drop_act_date,
      snapshot_id: snapshot.id,
    }));

  const { data: lastDates } = await supabase
    .from('drop_date_history')
    .select('mail_drop_id, scheduled_date')
    .in('mail_drop_id', dropIds)
    .order('changed_at', { ascending: false });

  const lastDateMap = {};
  for (const d of lastDates || []) {
    if (!lastDateMap[d.mail_drop_id]) lastDateMap[d.mail_drop_id] = d.scheduled_date;
  }

  const newDateRows = dateRows.filter(r =>
    lastDateMap[r.mail_drop_id] !== r.scheduled_date
  );

  if (newDateRows.length > 0) {
    for (let i = 0; i < newDateRows.length; i += BATCH) {
      const { error } = await supabase
        .from('drop_date_history')
        .insert(newDateRows.slice(i, i + BATCH).map(r => ({
          ...r,
          first_seen_at: capturedAt,
          changed_at: capturedAt,
        })));
      if (error) console.error('Date history insert error:', error.message);
    }
    console.log(`  Logged ${newDateRows.length} scheduled date changes`);
  }

  // Emit notification if anomaly detected (row count drops >20% vs last sync)
  const { data: lastSync } = await supabase
    .from('sync_log')
    .select('row_count')
    .eq('source', 'osprey')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastSync?.row_count && records.length < lastSync.row_count * 0.8) {
    await supabase.from('notifications').insert({
      event_type: 'data_anomaly',
      title: 'Osprey row count anomaly',
      body: `Expected ~${lastSync.row_count} rows, got ${records.length}. Possible incomplete download.`,
      severity: 'warning',
      source: 'osprey',
      data_json: { expected: lastSync.row_count, actual: records.length },
    });
  }

  console.log(`insertOsprey complete — ${rows.length} rows upserted into osprey_mail_drops`);
  return { rowCount: rows.length, fileSizeBytes };
}

module.exports = { insertOsprey };
