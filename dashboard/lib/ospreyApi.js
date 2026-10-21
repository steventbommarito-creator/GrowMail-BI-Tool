// Server-only client for the Osprey (OneBrand) API. Logs in with the same
// OSPREY_USER / OSPREY_PASS the scrapers use, but over plain HTTP — no
// browser. Login returns a Firebase session cookie (~14 day life) that works
// as a Bearer token, so we cache it per server instance and only re-login on
// a 401. Never import this from a 'use client' file: the token must stay
// server-side.

const API = 'https://api.onebrand.io/api/v1';
const TENANT_ID = process.env.OSPREY_TENANT_ID || 'osprey-3wyx0';

let token = null;
let loginPromise = null;   // dedupes concurrent logins on a cold instance

async function login() {
  const user = process.env.OSPREY_USER;
  const pass = process.env.OSPREY_PASS;
  if (!user || !pass) throw new Error('OSPREY_USER / OSPREY_PASS not configured');
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user, password: pass, tenantId: TENANT_ID }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Osprey login failed: HTTP ${res.status}`);
  const json = await res.json();
  if (!json.sessionCookie) throw new Error('Osprey login returned no session');
  return json.sessionCookie;
}

async function getToken(force = false) {
  if (token && !force) return token;
  if (!loginPromise) {
    loginPromise = login()
      .then(t => { token = t; return t; })
      .finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

async function ospreyGet(path) {
  let res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await getToken()}` }, cache: 'no-store' });
  if (res.status === 401) {
    res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await getToken(true)}` }, cache: 'no-store' });
  }
  if (!res.ok) throw new Error(`Osprey ${path}: HTTP ${res.status}`);
  return res.json();
}

// Same numbers the Osprey order page shows in its "Balance Due" box.
export async function getOrderBalance(orderId) {
  const j = await ospreyGet(`/order-lines/balance/${encodeURIComponent(orderId)}`);
  return {
    balance: Math.round((Number(j.balance) || 0) * 100) / 100,
    charges: Math.round((Number(j.order_charges) || 0) * 100) / 100,
  };
}
