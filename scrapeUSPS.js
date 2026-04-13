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
    // Log in
    await page.goto('https://gateway.usps.com/eAdmin/view/signin');
    await page.getByRole('button', { name: 'Sign in to the BCG' }).click();
    await page.getByTestId('fr-field-callback_1').getByTestId('input-').fill(user);
    await page.getByTestId('fr-field-callback_2').getByTestId('input-').fill(pass);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait for login to complete — either the dashboard loads or an error appears
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    const currentUrl = page.url();
    console.log('Post-login URL:', currentUrl);

    // Check for login errors
    const errorText = await page.locator('.error, .alert, [class*="error"], [class*="alert"]').first().textContent({ timeout: 2000 }).catch(() => null);
    if (errorText) console.warn('Possible login error on page:', errorText.trim());

    console.log('Logged in successfully');

    // Navigate to Mailing Reports
    await page.getByText('Manage Account', { timeout: 60000 }).click();
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
