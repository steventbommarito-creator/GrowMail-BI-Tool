/**
 * USPS Monthly Affiliate Report from the command line — read-only. The same
 * report as the dashboard's USPS Reporting page; the rules live in
 * dashboard/lib/uspsAffiliateReport.js.
 *
 *   node crm-import/usps-affiliate-report.js 2026-10 [out.json]
 *   python3 crm-import/usps-affiliate-xlsx.py out.json template.xlsx report.xlsx
 */
require('dotenv').config({ quiet: true });
const fsx = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const supabase = require('../lib/supabase');

async function main() {
  const month = process.argv[2];
  const { buildUspsAffiliateReport } = await import(pathToFileURL(path.join(__dirname, '../dashboard/lib/uspsAffiliateReport.js')).href);
  const domain = String(process.env.FRESHSALES_DOMAIN || '').replace(/^https?:\/\//, '').split('/')[0];
  const report = await buildUspsAffiliateReport({
    month, baseUrl: `https://${domain}/crm/sales/api`, apiKey: process.env.FRESHSALES_API_KEY, supabase,
  });
  fsx.writeFileSync(process.argv[3] || `usps-affiliate-${month}.json`, JSON.stringify(report, null, 1));
  const { rows, ...rest } = report;
  console.log(JSON.stringify({ ...rest, orders: rows.length }, null, 1));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
