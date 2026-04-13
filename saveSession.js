const { chromium } = require('@playwright/test');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'osprey-auth.json');
const baseUrl = process.env.OSPREY_URL || 'https://osprey.onebrand.io';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${baseUrl}/login?redirect=/`);

  console.log('Log in manually in the browser window.');
  console.log(`Waiting until you reach ${baseUrl}/...`);

  await page.waitForURL(`${baseUrl}/`, { timeout: 120_000 });

  await context.storageState({ path: SESSION_FILE });
  console.log(`Session saved to ${SESSION_FILE}`);

  await browser.close();
})();
