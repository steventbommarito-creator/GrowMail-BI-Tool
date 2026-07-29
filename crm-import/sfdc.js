/**
 * Minimal Salesforce REST client (OAuth client-credentials flow).
 * Env: SFDC_INSTANCE_URL, SFDC_CLIENT_ID, SFDC_CLIENT_SECRET.
 *
 *   const S = require('./sfdc');
 *   const rows = await S.queryAll('SELECT Id, Name FROM Account WHERE ...');
 */
require('dotenv').config();

let _tok = null, _tokAt = 0;
async function token() {
  if (_tok && Date.now() - _tokAt < 50 * 60 * 1000) return _tok;   // ~1h token, refresh at 50m
  const base = String(process.env.SFDC_INSTANCE_URL || '').replace(/\/+$/, '');
  const r = await fetch(base + '/services/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SFDC_CLIENT_ID, client_secret: process.env.SFDC_CLIENT_SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`SFDC token failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  _tok = j; _tokAt = Date.now();
  return j;
}

async function query(soql) {
  const t = await token();
  const r = await fetch(t.instance_url + '/services/data/v61.0/query?q=' + encodeURIComponent(soql), { headers: { Authorization: 'Bearer ' + t.access_token } });
  const j = await r.json();
  if (!r.ok) throw new Error(`SOQL failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function queryMore(nextUrl) {
  const t = await token();
  const r = await fetch(t.instance_url + nextUrl, { headers: { Authorization: 'Bearer ' + t.access_token } });
  const j = await r.json();
  if (!r.ok) throw new Error(`queryMore failed: ${r.status}`);
  return j;
}

// Full result set across pagination (SFDC pages ~2000 records).
async function queryAll(soql, log = () => {}) {
  const out = [];
  let j = await query(soql);
  for (;;) {
    out.push(...(j.records || []));
    log(`  sfdc: ${out.length}/${j.totalSize}`);
    if (j.done || !j.nextRecordsUrl) break;
    j = await queryMore(j.nextRecordsUrl);
  }
  return out;
}

module.exports = { token, query, queryAll };
