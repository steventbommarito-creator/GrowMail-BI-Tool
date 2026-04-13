const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');

/**
 * Logs into the USPS BCG portal, navigates to mailing reports,
 * downloads the transactions CSV, and returns the local file path.
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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // Step 1: Load the BCG gateway page
    await page.goto('https://gateway.usps.com/eAdmin/view/signin');
    await page.waitForLoadState('domcontentloaded');
    console.log('Gateway page loaded, URL:', page.url());

    // Step 2: Click "Sign in to the BCG" — this navigates to verified.usps.com
    await page.getByRole('button', { name: 'Sign in to the BCG' }).click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('After BCG click, URL:', page.url());

    // Step 3: Fill in credentials on verified.usps.com
    // Try multiple selector strategies for the username/password fields
    const usernameField = page.locator('input[name="IDToken1"], input[type="text"][id*="user"], input[autocomplete="username"], #username').first();
    const passwordField = page.locator('input[name="IDToken2"], input[type="password"][id*="pass"], input[autocomplete="current-password"], #password').first();

    await usernameField.waitFor({ state: 'visible', timeout: 15000 });
    await usernameField.fill(user);
    console.log('Username filled');

    await passwordField.fill(pass);
    console.log('Password filled');

    // Step 4: Submit login
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait for redirect back to gateway
    console.log('Waiting for post-login navigation...');
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log('Post-login URL:', currentUrl);
    console.log('Post-login title:', pageTitle);

    // Wait for the post-login dashboard — "Manage Account" appears once logged in
    console.log('Waiting for Manage Account...');
    await page.getByText('Manage Account').waitFor({ state: 'visible', timeout: 30000 });
    console.log('Logged in successfully');

    // Navigate to Mailing Reports
    await page.getByText('Manage Account').click();
    await page.getByRole('link', { name: 'Mailing Reports image of side' }).click();
    console.log('Navigated to Mailing Reports');

    // Navigate to View Transactions inside the iframe
    await page.waitForLoadState('networkidle');
    const mainFrame = page.frame({ name: 'portal_main' });
    if (!mainFrame) throw new Error('Could not find portal_main frame');
    await mainFrame.getByRole('link', { name: 'View Transactions' }).click();
    console.log('Opened View Transactions');

    // Run the search
    await mainFrame.getByRole('button', { name: 'SEARCH' }).click();
    await mainFrame.getByRole('link', { name: 'DOWNLOAD' }).waitFor({ state: 'visible' });
    await mainFrame.waitForLoadState('networkidle');
    console.log('Search executed, results loaded');

    // Click Download and handle the popup
    const popupPromise = page.waitForEvent('popup');
    await mainFrame.getByRole('link', { name: 'DOWNLOAD' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('networkidle');
    console.log('Download popup opened');

    // Select CSV format and download
    await popup.getByRole('cell', { name: 'Comma Separated Values (CSV)' }).click();
    await popup.getByRole('row', { name: 'Comma Separated Values (CSV)' }).getByRole('radio').check();

    const downloadPromise = popup.waitForEvent('download');
    await popup.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;

    const filePath = path.join(os.tmpdir(), download.suggestedFilename());
    await download.saveAs(filePath);
    console.log(`CSV downloaded to ${filePath}`);

    return filePath;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeUSPS };
