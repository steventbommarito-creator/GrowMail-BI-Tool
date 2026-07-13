/**
 * Mark stale open deals Lost: every deal currently in the OPEN "Quoted" stage
 * with an expected close date before CUTOFF (default 2026-06-13) is set to Lost.
 * Won and already-Lost deals are never touched (the filter only matches Quoted).
 *
 *   node crm-import/lost-cleanup.js            # do it
 *   DRY_RUN=1 node crm-import/lost-cleanup.js  # just count, change nothing
 *   LIMIT=2 node crm-import/lost-cleanup.js    # only flip N (for a live test)
 *
 * Resumable + idempotent: once a deal is flipped it leaves the Quoted filter, so
 * re-running only ever picks up what's left. Paced under the 2000/hr FS cap.
 */
const C = require('./common');

const QUOTED = C.STAGE_IDS.Quoted;
const LOST = C.STAGE_IDS.Lost;
const CUTOFF = process.env.CUTOFF || '2026-06-13';
const DRY_RUN = !!process.env.DRY_RUN;
const LIMIT = Number(process.env.LIMIT || 0);
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || (process.env.CI ? 50 * 60 * 1000 : 0));

async function search(page) {
  return C.fs('POST', `/filtered_search/deal?per_page=100&page=${page}`, {
    filter_rule: [
      { attribute: 'deal_stage_id', operator: 'is_in', value: [QUOTED] },
      { attribute: 'expected_close', operator: 'is_before', value: CUTOFF },
    ],
  });
}

async function main() {
  const first = await search(1);
  if (!first.ok) throw new Error(`filtered_search failed: ${first.error}`);
  const total = first.data?.meta?.total;
  console.log(`Open (Quoted) deals with expected_close before ${CUTOFF}: ${total}`);
  if (DRY_RUN) { console.log('DRY_RUN — nothing changed.'); return; }

  const started = Date.now();
  const failed = new Set();
  let flipped = 0, errors = 0;

  // Always re-fetch page 1: flipping a deal removes it from the Quoted filter,
  // so the match set shrinks and page 1 keeps surfacing the remaining work.
  for (;;) {
    if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) {
      console.log('Runtime budget reached — exiting (resumable).'); break;
    }
    const res = await search(1);
    if (!res.ok) { console.error('search error:', res.error); break; }
    const deals = (res.data?.deals || []).filter((d) => !failed.has(d.id));
    if (!deals.length) break;

    let progressed = false;
    for (const d of deals) {
      const put = await C.fs('PUT', `/deals/${d.id}`, { deal: { deal_stage_id: LOST } });
      if (put.ok && put.data?.deal?.deal_stage_id === LOST) {
        flipped++; progressed = true;
      } else {
        failed.add(d.id); errors++;
        console.error(`  deal ${d.id} failed: HTTP ${put.status} ${(put.error || '').slice(0, 120)}`);
      }
      if (LIMIT && flipped >= LIMIT) { console.log(`LIMIT ${LIMIT} reached.`); return finish(flipped, errors, failed); }
      if (MAX_RUNTIME_MS && Date.now() - started >= MAX_RUNTIME_MS) break;
    }
    if (flipped % 100 === 0 && flipped) {
      const rate = flipped / Math.max((Date.now() - started) / 3600000, 1e-9);
      console.log(`  flipped ${flipped} (~${Math.round(rate)}/hr), ${errors} failed`);
    }
    if (!progressed) { console.log('No progress this pass (remaining failed) — stopping.'); break; }
  }
  finish(flipped, errors, failed);
}

function finish(flipped, errors, failed) {
  console.log(`\nDone: ${flipped} deals set to Lost, ${errors} failed.`);
  if (failed.size) console.log('Failed deal ids:', [...failed].slice(0, 50).join(', '));
}

main().catch((e) => { console.error('LOST-CLEANUP FAILED:', e.message); process.exit(1); });
