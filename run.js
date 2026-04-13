require('dotenv').config();
const { scrapeOsprey } = require('./scrapeOsprey');
const { scrapeUSPS } = require('./scrapeUSPS');
const { insertOsprey } = require('./lib/insertOsprey');
const { insertUSPS } = require('./lib/insertUSPS');
const { aiInsights } = require('./lib/aiInsights');

async function main() {
  const start = Date.now();
  const hourUTC = new Date().getUTCHours();

  console.log(`=== BI Scraper run started at ${new Date().toISOString()} ===`);

  // --- Osprey ---
  try {
    console.log('\n[Osprey] Starting scrape...');
    const ospreyPath = await scrapeOsprey();
    console.log(`[Osprey] Downloaded: ${ospreyPath}`);
    await insertOsprey(ospreyPath);
    console.log('[Osprey] Done.');
  } catch (err) {
    console.error('[Osprey] ERROR:', err.message);
  }

  // --- USPS ---
  try {
    console.log('\n[USPS] Starting scrape...');
    const uspsPath = await scrapeUSPS();
    console.log(`[USPS] Downloaded: ${uspsPath}`);
    await insertUSPS(uspsPath);
    console.log('[USPS] Done.');
  } catch (err) {
    console.error('[USPS] ERROR:', err.message);
  }

  // --- AI Insights — only at midnight UTC (cron 0 5 * * * = midnight EST) ---
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
