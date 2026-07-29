/**
 * Win-back call plan (review spreadsheet stage — creates NOTHING in FW).
 *
 * Pool: SFDC contacts with LastOrderDate < 2025-10-04 (10mo before campaign
 * start) and a phone. Excluded: DNC-nomenclature Preferred Communication
 * (Do Not Contact / No Dialer Activity / Email Only / No Longer With Company),
 * accounts with recent Osprey mail-drop activity (SFDC LastOrderDate is going
 * stale as usage winds down), owners who are active non-roster reps.
 *
 * Routing: owner in the core-8 roster → own book; owner departed / integration
 * / Customer Service → redistributed round-robin by recency. One contact per
 * account (most recent orderer). Each seller: newest-lapsed first, 15 calls
 * per weekday 2026-08-04 → 2026-10-30, skipping Labor Day 2026-09-07.
 *
 *   node crm-import/call-plan.js   # writes call-plan.json to CALL_PLAN_OUT dir
 */
const fsNode = require('fs');
const S = require('./sfdc');
const C = require('./common');
const E = require('./sync-enrich');

const OUT = (process.env.CALL_PLAN_OUT || '.') + '/call-plan.json';
const CUTOFF = '2025-10-04';
const ROSTER = ['Chris Franks', 'Danielle Dennis', 'David Waldman', 'Eric Rice', 'Mark Swan', 'Nick Krutko'];
// display name in FW (task owner) for SFDC owner names that differ
const FW_NAME = { 'Danielle Dennis': 'Dani Dennis', 'Nick Krutko': 'Nicholas Krutko' };
// active humans NOT on the roster — their book is theirs; excluded entirely
const ACTIVE_NON_ROSTER = new Set(['anthony cangemi', 'christian cabrera', 'dean locascio', 'david pantin', 'jennifer torres', 'kate cooper', 'liam oliver', 'mark hurt', 'matthew hurt', 'mihai ban', 'sergio rodriguez', 'stephanie hanna', 'steve bommarito', 'michelle donadio', 'rhianna lau'].map((s) => s.toLowerCase()));
const DNC = new Set(['do not contact', 'no dialer activity', 'email only', 'no longer with company']);
const PER_DAY = 15;

function weekdays() {
  const out = [];
  const d = new Date(Date.UTC(2026, 7, 4));       // Aug 4 2026
  const end = Date.UTC(2026, 9, 30);              // Oct 30 2026
  while (d.getTime() <= end) {
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow >= 1 && dow <= 5 && iso !== '2026-09-07') out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  console.log('Pulling lapsed purchasers from SFDC…');
  const rows = await S.queryAll(
    `SELECT Id, Name, Email, Phone, AccountId, Account.Name, Owner.Name, LastOrderDate__c, NumberOfOrders__c, TotalOrderAmount__c, Preferred_Communication__c
     FROM Contact WHERE LastOrderDate__c != null AND LastOrderDate__c < ${CUTOFF} AND Phone != null`, (m) => console.log(m));

  console.log('Building recent-Osprey-activity guard…');
  const recentCust = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await C.supabase.from('osprey_mail_drops')
      .select('customer_name, drop_est_date, drop_act_date').range(f, f + 999);
    if (!data || !data.length) break;
    for (const r of data) {
      const dt = r.drop_act_date || r.drop_est_date;
      if (dt && dt >= CUTOFF) recentCust.add(E.normName(r.customer_name));
    }
    if (data.length < 1000) break;
  }
  console.log(`accounts with Osprey drops since ${CUTOFF}: ${recentCust.size}`);

  const stats = { pool: rows.length, dnc: 0, recentOsprey: 0, activeNonRoster: 0, dupAccount: 0, kept: 0 };
  const rosterSet = new Set(ROSTER.map((s) => s.toLowerCase()));
  const byAccount = new Map();   // account key -> best contact
  for (const r of rows) {
    const pc = String(r.Preferred_Communication__c || '').toLowerCase();
    if (DNC.has(pc)) { stats.dnc++; continue; }
    const acctName = r.Account?.Name || '';
    if (recentCust.has(E.normName(acctName))) { stats.recentOsprey++; continue; }
    const owner = String(r.Owner?.Name || '').trim();
    const ol = owner.toLowerCase();
    const own = rosterSet.has(ol);
    if (!own && ACTIVE_NON_ROSTER.has(ol)) { stats.activeNonRoster++; continue; }
    const rec = {
      sfId: r.Id, name: r.Name, email: r.Email || '', phone: r.Phone,
      account: acctName, lastOrder: r.LastOrderDate__c, orders: r.NumberOfOrders__c || 0,
      total: r.TotalOrderAmount__c || 0, sfOwner: owner || '(none)',
      source: own ? 'own book' : 'reassigned (departed/CS)', rep: own ? (FW_NAME[owner] || owner) : null,
    };
    const key = E.normName(acctName) || 'contact:' + r.Id;
    const prev = byAccount.get(key);
    if (!prev) byAccount.set(key, rec);
    else { stats.dupAccount++; if (rec.lastOrder > prev.lastOrder) byAccount.set(key, rec); }
  }
  const pool = [...byAccount.values()];
  stats.kept = pool.length;
  console.log('filter stats:', JSON.stringify(stats));

  // Routing: own book to each rep; departed pool round-robin by recency.
  const reps = ROSTER.map((r) => FW_NAME[r] || r);
  const lists = Object.fromEntries(reps.map((r) => [r, []]));
  for (const p of pool.filter((p) => p.rep)) lists[p.rep].push(p);
  const floating = pool.filter((p) => !p.rep).sort((a, b) => (a.lastOrder < b.lastOrder ? 1 : -1));
  const days = weekdays();
  const target = days.length * PER_DAY;
  let ri = 0;
  for (const p of floating) {           // round-robin, skipping full lists
    let hops = 0;
    while (lists[reps[ri % reps.length]].length >= target && hops++ < reps.length) ri++;
    if (hops >= reps.length) break;     // everyone full
    p.rep = reps[ri % reps.length];
    lists[p.rep].push(p);
    ri++;
  }

  // Schedule: per rep, newest-lapsed first, 15/day.
  const plan = [];
  for (const rep of reps) {
    const list = lists[rep].sort((a, b) => (a.lastOrder < b.lastOrder ? 1 : -1)).slice(0, target);
    list.forEach((p, i) => plan.push({ ...p, rep, callDate: days[Math.floor(i / PER_DAY)] }));
    console.log(`${rep}: ${list.length} calls (${Math.ceil(list.length / PER_DAY)} days covered)`);
  }
  fsNode.writeFileSync(OUT, JSON.stringify({ days: days.length, perDay: PER_DAY, stats, plan }));
  console.log(`\n${plan.length} scheduled calls → ${OUT}`);
}

main().catch((e) => { console.error('CALL-PLAN FAILED:', e.message); process.exit(1); });
