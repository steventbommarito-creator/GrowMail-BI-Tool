/**
 * Osprey new-users -> Freshworks leads.
 *
 * Logs into Osprey (same Playwright flow as the Gordon & Lance scrape), reads the
 * users list from api.onebrand.io/api/v1/users (newest-first), and creates a
 * Freshworks lead (a contact with lifecycle stage "Lead") for each NEW user —
 * skipping any whose email already exists in Freshworks.
 *
 *   node crm-import/osprey-lead-sync.js [--limit N] [--dry-run]
 *
 * Scope: first run seeds users created in the last LEAD_SEED_DAYS (default 30)
 * days, then watermarks at the newest user_id. Every later run only processes
 * user_ids above the watermark (genuine new signups). State in osprey_lead_sync;
 * processed oldest-first so an interrupted run resumes cleanly.
 */
const { chromium } = require('@playwright/test');
const C = require('./common');

const LEAD_LIFECYCLE_ID = 128081818855;   // "Lead"
const NEW_STATUS_ID = 127004203345;        // "New"
const SEED_DAYS = Number(process.env.LEAD_SEED_DAYS || 30);
const USERS_API = 'https://api.onebrand.io/api/v1/users';

async function scrapeNewUsers(watermark, cutoffISO) {
  const baseUrl = process.env.OSPREY_URL || 'https://osprey.onebrand.io';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let token = null;
  page.on('request', (req) => { if (/\/api\/v1\/users\?/.test(req.url()) && !token) token = req.headers()['authorization']; });
  try {
    await page.goto(`${baseUrl}/login`);
    await page.getByRole('textbox', { name: 'Email' }).fill(process.env.OSPREY_USER);
    await page.getByRole('textbox', { name: 'Email' }).press('Tab');
    await page.getByRole('textbox', { name: 'Password' }).fill(process.env.OSPREY_PASS);
    await page.getByRole('textbox', { name: 'Password' }).press('Enter');
    await page.waitForLoadState('networkidle');
    await page.goto(`${baseUrl}/users`);
    await page.waitForTimeout(6000);
    if (!token) throw new Error('failed to capture Osprey API token');

    const out = [];
    for (let pg = 1; pg <= 2000; pg++) {
      const r = await ctx.request.get(`${USERS_API}?page=${pg}&orderBy=user_id&order=desc&limit=100&search=&includePageCount=false`, { headers: { authorization: token } });
      if (!r.ok()) throw new Error(`users API page ${pg}: HTTP ${r.status()}`);
      const data = (await r.json()).data || [];
      if (!data.length) break;
      let stop = false;
      for (const u of data) {
        if (watermark != null) { if (Number(u.user_id) <= watermark) { stop = true; break; } }
        else if (u.created_at && u.created_at < cutoffISO) { stop = true; break; }
        out.push(u);
      }
      if (stop) break;
    }
    return out;
  } finally { await browser.close(); }
}

async function emailExists(email) {
  const r = await C.fs('GET', `/lookup?q=${encodeURIComponent(email)}&f=email&entities=contact`);
  if (!r.ok) return false; // treat lookup error as "not found" but we log via failure elsewhere
  const list = (r.data?.contacts?.contacts) || [];
  return list.length > 0;
}

async function record(u, outcome, fwId) {
  await C.supabase.from('osprey_lead_sync').upsert({
    user_id: u.user_id, email: String(u.email || '').toLowerCase(), fw_contact_id: fwId,
    outcome, osprey_created_at: u.created_at || null, synced_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
  const dryRun = process.argv.includes('--dry-run');

  const { data: wm } = await C.supabase.from('osprey_lead_sync').select('user_id').order('user_id', { ascending: false }).limit(1);
  const watermark = wm && wm.length ? Number(wm[0].user_id) : null;
  const cutoff = new Date(Date.now() - SEED_DAYS * 86400 * 1000).toISOString();
  console.log(`watermark: ${watermark ?? '(none — first run)'} | first-run cutoff: ${watermark ? 'n/a' : cutoff}`);

  const users = (await scrapeNewUsers(watermark, cutoff)).sort((a, b) => Number(a.user_id) - Number(b.user_id)); // oldest-first (resumable)
  console.log(`new users to consider: ${users.length}`);

  const stats = { created: 0, exists: 0, no_email: 0, failed: 0 };
  const started = Date.now();
  const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || (process.env.CI ? 300 * 60 * 1000 : 0));
  for (const u of users) {
    if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const email = String(u.email || '').trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { if (!dryRun) await record(u, 'no_email', null); stats.no_email++; continue; }
    if (await emailExists(email)) { if (!dryRun) await record(u, 'exists', null); stats.exists++; continue; }
    const contact = {
      first_name: String(u.first_name || u.name || '').slice(0, 100) || 'Unknown',
      last_name: String(u.last_name || '').slice(0, 100),
      emails: [{ value: email, is_primary: true }],
      lifecycle_stage_id: LEAD_LIFECYCLE_ID, contact_status_id: NEW_STATUS_ID,
    };
    if (u.user_phone) contact.mobile_number = String(u.user_phone);
    if (u.company) contact.job_title = String(u.company).slice(0, 100); // no plain company field; keep it visible
    if (dryRun) { stats.created++; if (stats.created <= 3) console.log('CREATE', JSON.stringify(contact)); continue; }
    const res = await C.fs('POST', '/contacts', { contact });
    if (res.ok && res.data?.contact?.id) { await record(u, 'created', String(res.data.contact.id)); stats.created++; }
    else { stats.failed++; console.error(`create failed ${email}: ${res.status} ${res.error}`); }
    if (limit && stats.created >= limit) { console.log(`--limit ${limit} reached`); break; }
  }
  console.log(`\n${dryRun ? 'DRY RUN ' : ''}done:`, JSON.stringify(stats));
}

main().catch((e) => { console.error('OSPREY LEAD SYNC FAILED:', e.message); process.exit(1); });
