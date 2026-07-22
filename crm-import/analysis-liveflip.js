/**
 * One-off analysis: when do drops flip to a LIVE status relative to their
 * SCHEDULED date, and how far ahead of a scheduled week are drops live?
 * Uses drop_status_history + drop_date_history (per-drop-per-snapshot series),
 * downsampled to the latest snapshot per day. Read-only; prints a report.
 */
const C = require('./common');

const isLive = (s) => /production|outsourced|pending ship/i.test(String(s || ''));
const daysBetween = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);

async function pageAll(table, cols, snapIds, log) {
  const out = [];
  // Query per snapshot_id chunk to keep result sets small + paginate each.
  for (let c = 0; c < snapIds.length; c += 20) {
    const chunk = snapIds.slice(c, c + 20);
    let from = 0;
    for (;;) {
      const { data, error } = await C.supabase.from(table).select(cols).in('snapshot_id', chunk).range(from, from + 999);
      if (error) throw new Error(`${table} fetch: ${error.message}`);
      if (!data.length) break;
      out.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    if (c % 40 === 0) log(`  ${table}: ${out.length} rows (${c}/${snapIds.length} snaps)`);
  }
  return out;
}

async function main() {
  // 1. latest snapshot per day
  const snaps = [];
  { let from = 0; for (;;) { const { data } = await C.supabase.from('osprey_snapshots').select('id, captured_at').order('captured_at', { ascending: true }).range(from, from + 999); if (!data.length) break; snaps.push(...data); if (data.length < 1000) break; from += 1000; } }
  const perDay = {};
  for (const s of snaps) { const d = s.captured_at.slice(0, 10); perDay[d] = s.id; } // last wins (sorted asc)
  const dayId = perDay;                       // day -> snapshot_id
  const idDay = Object.fromEntries(Object.entries(perDay).map(([d, id]) => [id, d]));
  const snapIds = Object.values(perDay);
  console.log(`snapshots: ${snaps.length} total, ${snapIds.length} daily used (${Object.keys(perDay)[0]} -> ${Object.keys(perDay).slice(-1)[0]})`);

  // 2. pull status + date series for those snapshots
  const statusRows = await pageAll('drop_status_history', 'mail_drop_id, snapshot_id, status', snapIds, console.log);
  const dateRows = await pageAll('drop_date_history', 'mail_drop_id, snapshot_id, scheduled_date', snapIds, console.log);
  console.log(`pulled ${statusRows.length} status obs, ${dateRows.length} date obs`);

  // 3. join on (mail_drop_id, snapshot_id): obs = {mid, day, sched, live}
  const sched = new Map();
  for (const r of dateRows) sched.set(r.mail_drop_id + '|' + r.snapshot_id, r.scheduled_date);
  const obs = [];
  for (const r of statusRows) {
    const day = idDay[r.snapshot_id]; if (!day) continue;
    const s = sched.get(r.mail_drop_id + '|' + r.snapshot_id); if (!s) continue;
    obs.push({ mid: r.mail_drop_id, day, sched: s, live: isLive(r.status) });
  }
  console.log(`joined observations: ${obs.length}`);

  // 4a. Coverage curve: P(live) at N weeks before scheduled date.
  //     Per (drop, weeks_out) keep the latest-day observation's live flag.
  const cell = new Map(); // mid|wo -> {day, live}
  for (const o of obs) {
    const wo = Math.round(daysBetween(o.sched, o.day) / 7);
    if (wo < -2 || wo > 10) continue;
    const k = o.mid + '|' + wo;
    const prev = cell.get(k);
    if (!prev || o.day > prev.day) cell.set(k, { day: o.day, live: o.live, wo });
  }
  const cov = {};
  for (const v of cell.values()) { const b = cov[v.wo] || (cov[v.wo] = { n: 0, live: 0 }); b.n++; if (v.live) b.live++; }
  console.log('\n=== Coverage: at N weeks before scheduled date, fraction of drops already LIVE ===');
  console.log('weeks_out | drops | %live');
  for (const wo of Object.keys(cov).map(Number).sort((a, b) => b - a)) {
    const b = cov[wo]; console.log(`  ${String(wo).padStart(3)} | ${String(b.n).padStart(5)} | ${(100 * b.live / b.n).toFixed(0)}%`);
  }

  // 4b. Flip lead time: per drop, first day live -> scheduled_date then; lead = sched - flipDay.
  const byDrop = new Map();
  for (const o of obs) { if (!byDrop.has(o.mid)) byDrop.set(o.mid, []); byDrop.get(o.mid).push(o); }
  const leads = []; let flippedLate = 0, flippedEarly = 0, schedMovedAtFlip = 0, everLive = 0;
  for (const arr of byDrop.values()) {
    arr.sort((a, b) => a.day.localeCompare(b.day));
    const firstLiveIdx = arr.findIndex((o) => o.live);
    if (firstLiveIdx < 0) continue;
    everLive++;
    const f = arr[firstLiveIdx];
    const lead = daysBetween(f.sched, f.day);
    leads.push(lead);
    if (lead >= 0) flippedEarly++; else flippedLate++;
    // scheduled date change right around the flip (prev obs sched vs flip sched)
    if (firstLiveIdx > 0 && arr[firstLiveIdx - 1].sched !== f.sched) schedMovedAtFlip++;
  }
  leads.sort((a, b) => a - b);
  const q = (p) => leads[Math.floor((leads.length - 1) * p)];
  console.log('\n=== Flip-to-live timing vs scheduled date ===');
  console.log(`drops that ever went live: ${everLive}`);
  console.log(`lead days (scheduled - flip day): median ${q(0.5)}, p25 ${q(0.25)}, p75 ${q(0.75)}, min ${leads[0]}, max ${leads[leads.length - 1]}`);
  console.log(`flipped ON/BEFORE scheduled date: ${flippedEarly} (${(100 * flippedEarly / everLive).toFixed(0)}%) | flipped AFTER (late): ${flippedLate} (${(100 * flippedLate / everLive).toFixed(0)}%)`);
  console.log(`scheduled date CHANGED at the flip snapshot: ${schedMovedAtFlip} (${(100 * schedMovedAtFlip / everLive).toFixed(0)}%)`);
}

main().catch((e) => { console.error('ANALYSIS FAILED:', e.message); process.exit(1); });
