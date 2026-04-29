// Shared postage math. Used by cashflow / forecast / late-mailings / overview
// pages and the overview-summary API route so postage logic stays in one place.
//
// Source-of-truth priority (per-drop):
//   1. mail_method === "LDP" → drop is handled and paid for by LDP, not by us.
//      Excluded entirely from postage math (returns $0 here, and callers also
//      drop these rows from their lists so they don't clutter the views).
//   2. actual_postage > 0  → real cost from Osprey production. Use it.
//   3. postage_amount > 0  → estimated postage ("Est. Postage" CSV column).
//   4. Last-resort fallback: if the product is "LDP Postcard" and we have
//      neither actual nor estimate, compute as quantity × LDP_POSTCARD_RATE.
//      For everything else, $0.
//
// Whether the returned value is an estimate or actual is a separate concern —
// see isEstimatedPostage(d) below for the (est) suffix the UI shows on
// row-level renderings.

// USPS Marketing Mail postcard rate. Only used as a last-resort fallback when
// an LDP Postcard drop has no actual_postage AND no postage_amount populated.
// In practice this should be rare — Osprey reliably populates Est. Postage
// and Actual Postage on live LDP Postcard drops.
export const LDP_POSTCARD_RATE = 0.244;

// Whether this drop's mail method is "LDP" — the third-party LDP service
// handles and pays for the postage, so we exclude these everywhere.
export function isLdpMailMethod(d) {
  return (d?.mail_method || '').toUpperCase() === 'LDP';
}

export function effectivePostage(d) {
  if (!d) return 0;
  if (isLdpMailMethod(d)) return 0;
  if (d.actual_postage && d.actual_postage > 0) return d.actual_postage;
  if (d.postage_amount  && d.postage_amount  > 0) return d.postage_amount;
  if ((d.product_category || '').toLowerCase().includes('ldp postcard')) {
    return (d.mail_drop_quantity || 0) * LDP_POSTCARD_RATE;
  }
  return 0;
}

// True when effectivePostage(d) returns an estimate (or rate-based fallback)
// rather than the real Osprey actual_postage. The UI uses this to append an
// "(est)" suffix to per-drop postage displays. Aggregates / totals deliberately
// don't use this — totals are shown as a single number with no breakout.
export function isEstimatedPostage(d) {
  if (!d) return false;
  if (isLdpMailMethod(d)) return false;          // excluded entirely, not estimated
  if (d.actual_postage && d.actual_postage > 0) return false;
  return effectivePostage(d) > 0;                // we're using estimate or rate fallback
}
