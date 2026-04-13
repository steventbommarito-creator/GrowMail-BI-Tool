require('dotenv').config();
const { scrapeOsprey } = require('./scrapeOsprey');
const { scrapeUSPS } = require('./scrapeUSPS');
const { insertOsprey } = require('./lib/insertOsprey');
const { insertUSPS } = require('./lib/insertUSPS');
const { aiInsights } = require('./lib/aiInsights');
const supabase = require('./lib/supabase');

const TRIGGERED_BY = process.env.TRIGGERED_BY || 'cron';

async function logSync(source, startedAt, result) {
  const completedAt = new Date().toISOString();
  const durationSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;

  await supabase.from('sync_log').insert({
    source,
    started_at: startedAt,
    completed_at: completedAt,
    status: result.error ? 'error' : 'success',
    row_count: result.rowCount || null,
    file_size_bytes: result.fileSizeBytes || null,
    error_message: result.error || null,
    triggered_by: TRIGGERED_BY,
    duration_seconds: durationSeconds,
  });

  await supabase.from('notifications').insert({
    event_type: result.error ? 'sync_error' : 'sync_complete',
    title: result.error
      ? `${source.toUpperCase()} sync failed`
      : `${source.toUpperCase()} sync complete`,
    body: result.error
      ? `Error: ${result.error}`
      : `${result.rowCount} rows synced in ${durationSeconds.toFixed(1)}s (${((result.fileSizeBytes || 0) / 1024).toFixed(1)} KB)`,
    severity: result.error ? 'error' : 'info',
    source,
    data_json: { rowCount: result.rowCount, fileSizeBytes: result.fileSizeBytes, durationSeconds },
  });
}

async function main() {
  const start = Date.now();
  const hourUTC = new Date().getUTCHours();

  console.log(`=== BI Scraper run started at ${new Date().toISOString()} (triggered by: ${TRIGGERED_BY}) ===`);

  // --- Osprey ---
  const ospreyStart = new Date().toISOString();
  try {
    console.log('\n[Osprey] Starting scrape...');
    const ospreyPath = await scrapeOsprey();
    console.log(`[Osprey] Downloaded: ${ospreyPath}`);
    const result = await insertOsprey(ospreyPath, TRIGGERED_BY);
    await logSync('osprey', ospreyStart, result);
    console.log('[Osprey] Done.');
  } catch (err) {
    console.error('[Osprey] ERROR:', err.message);
    await logSync('osprey', ospreyStart, { error: err.message }).catch(() => {});
  }

  // --- USPS ---
  const uspsStart = new Date().toISOString();
  try {
    console.log('\n[USPS] Starting scrape...');
    const uspsPath = await scrapeUSPS();
    console.log(`[USPS] Downloaded: ${uspsPath}`);
    const result = await insertUSPS(uspsPath);
    await logSync('usps', uspsStart, result);
    console.log('[USPS] Done.');
  } catch (err) {
    console.error('[USPS] ERROR:', err.message);
    await logSync('usps', uspsStart, { error: err.message }).catch(() => {});
  }

  // --- AI Insights — only at midnight EST (5am UTC) ---
  if (hourUTC === 5) {
    try {
      console.log('\n[AI] Generating insights...');
      await aiInsights();
      console.log('[AI] Done.');
    } catch (err) {
      console.error('[AI] ERROR:', err.message);
    }
  } else {
    console.log(`\n[AI] Skipping insights (UTC hour=${hourUTC}, runs at hour 5)`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Run complete in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
