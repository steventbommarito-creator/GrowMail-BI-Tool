const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');

/**
 * Logs into the USPS BCG portal, navigates to the EPS Transaction History Report,
 * downloads the CSV, and returns the local file path (null when the report
 * has no transactions).
 *
 * Required environment variables:
 *   USPS_USER — BCG username
 *   USPS_PASS — BCG password
 */
async function scrapeUSPS() {
  const user = process.env.USPS_USER;
  const pass = process.env.USPS_PASS;

  if (!user || !pass) {
    throw new Error('Missing required environment variables: USPS_USER, USPS_PASS');
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Remove webdriver flag that triggers bot detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // Step 1: Load BCG gateway
    await page.goto('https://gateway.usps.com/eAdmin/view/signin');
    await page.waitForLoadState('domcontentloaded');
    console.log('Gateway page loaded');

    // Step 2: Click "Sign in to the BCG" → navigates to verified.usps.com
    await page.getByRole('button', { name: 'Sign in to the BCG' }).click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('After BCG click, URL:', page.url());

    // Step 3: Fill credentials with pressSequentially to trigger React events
    console.log('Looking for ForgeRock username field...');
    const usernameContainer = page.getByTestId('fr-field-callback_1');
    await usernameContainer.waitFor({ state: 'attached', timeout: 15000 });
    const usernameInput = usernameContainer.locator('input').first();
    await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
    await usernameInput.click();
    await usernameInput.pressSequentially(user, { delay: 80 });
    console.log('Username typed');

    const passwordInput = page.getByTestId('fr-field-callback_2').locator('input').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
    await passwordInput.click();
    await passwordInput.pressSequentially(pass, { delay: 80 });
    console.log('Password typed');

    // Step 4: Submit
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForTimeout(1000);

    // Wait for BCG dashboard
    console.log('Waiting for post-login navigation...');
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await page.waitForTimeout(3000);
    console.log('Post-login URL:', page.url());
    console.log('Logged in successfully');

    // Step 5: Navigate directly to EPS Transaction History Report
    console.log('Navigating to EPS Transaction History...');
    await page.goto('https://epay.usps.com/paymod/reports/transaction/history');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('EPS report page loaded, URL:', page.url());

    // Step 6: Click "Generate results"
    await page.getByRole('button', { name: 'Generate results' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: 'Generate results' }).click();
    console.log('Generate results clicked');

    // Step 7: Wait for the results grid. With no transactions in the report
    // window (weekends, early mornings) the grid says "No Rows To Show" and the
    // CSV button never produces a download — that's an empty result, not a
    // failure. Give rows up to 15s to load before concluding it's empty, then
    // return null so the caller logs a 0-row sync instead of the job going red.
    let hasRows = false;
    for (let i = 0; i < 15 && !hasRows; i++) {
      await page.waitForTimeout(1000);
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      hasRows = /\b[1-9]\d* to \d+ of \d+/.test(text);
      if (!hasRows && i >= 4 && !/No Rows To Show/i.test(text)) hasRows = true;  // unknown layout — try the download
    }
    if (!hasRows) {
      console.log('USPS report has no transactions (No Rows To Show)');
      return null;
    }

    // Step 8: Download CSV. Start the download wait and the click together so a
    // timeout rejects into this await (a dangling waitForEvent promise used to
    // crash the whole process before the error could be logged).
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.getByRole('button', { name: 'CSV' }).click(),
    ]);

    const filePath = path.join(os.tmpdir(), download.suggestedFilename() || 'usps_transactions.csv');
    await download.saveAs(filePath);
    console.log(`CSV downloaded to ${filePath}`);

    return filePath;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeUSPS };
