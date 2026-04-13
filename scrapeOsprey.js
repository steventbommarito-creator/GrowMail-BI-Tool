const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');

/**
 * Logs into Osprey directly, navigates to the finance report, downloads the CSV,
 * and returns the local file path of the downloaded file.
 *
 * Required environment variables:
 *   OSPREY_URL  — base URL (e.g. https://osprey.onebrand.io)
 *   OSPREY_USER — account email
 *   OSPREY_PASS — account password
 */
async function scrapeOsprey() {
  const baseUrl = process.env.OSPREY_URL || 'https://osprey.onebrand.io';
  const user = process.env.OSPREY_USER;
  const pass = process.env.OSPREY_PASS;

  if (!user || !pass) {
    throw new Error('Missing required environment variables: OSPREY_USER, OSPREY_PASS');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // Log in directly
    await page.goto(`${baseUrl}/login`);
    await page.getByRole('textbox', { name: 'Email' }).fill(user);
    await page.getByRole('textbox', { name: 'Email' }).press('Tab');
    await page.getByRole('textbox', { name: 'Password' }).fill(pass);
    await page.getByRole('textbox', { name: 'Password' }).press('Enter');
    await page.waitForLoadState('networkidle');
    console.log('Logged in successfully');

    // Navigate to the finance report
    await page.goto(`${baseUrl}/reports/gordon-lance-finance-report?filter_id=6077`);
    console.log('Navigated to finance report');
    await page.waitForTimeout(30000);

    // Download the CSV
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download segment as CSV' }).click();
    const download = await downloadPromise;

    const filePath = path.join(os.tmpdir(), download.suggestedFilename());
    await download.saveAs(filePath);
    console.log(`CSV downloaded to ${filePath}`);

    return filePath;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeOsprey };
