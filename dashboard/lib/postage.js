// Shared postage math. Used by cashflow / forecast / late-mailings / overview
// pages and the overview-summary API route so postage logic stays in one place.
//
// Osprey now provides BOTH an estimated postage (the forecast) and an actual
// postage (computed once production has priced the drop) on every row of the
// Gordon & Lance finance report. We prefer the actual when it's been posted
// and fall back to the estimate otherwise — no more client-side per-piece
// rate math, which was historically only accurate for LDP Postcards anyway.

// Compute the dollar postage that should be charged against the EPS balance
// for a single mail drop.
//   - actual_postage  → real cost from Osprey production. Use it whenever > 0.
//   - postage_amount  → estimated postage (the "Est. Postage" CSV column).
//                       Used as the forecast value before production has priced.
//
// Note: this does NOT know about EPS-already-deducted drops. Callers should
// check their own `epsDeductedMap` / `epsSet` and treat matched drops as $0
// in the running-balance forecast (to avoid double-counting charges that
// have already hit the EPS account).
export function effectivePostage(d) {
  if (d?.actual_postage && d.actual_postage > 0) return d.actual_postage;
  return d?.postage_amount || 0;
}
