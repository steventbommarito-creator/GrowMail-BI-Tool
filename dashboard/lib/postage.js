// Shared postage math. Used by cashflow/forecast/overview pages and the
// overview-summary API route so the LDP rate and postage rules stay in one place.

// USPS Marketing Mail postcard rate applied to LDP Postcard product category
// when the drop has cleared the DAL gate and is in production/outsourced.
// Update this when USPS changes the rate.
export const LDP_POSTCARD_RATE = 0.244;

// Compute the dollar postage that should be charged against the EPS balance for
// a single mail drop. For LDP Postcards this is computed from the piece count;
// for everything else it's whatever Osprey reports in postage_amount.
//
// Note: this does NOT know about EPS-already-deducted drops. Callers should
// check their own `epsDeductedMap` / `epsSet` and treat matched drops as $0
// in the running-balance forecast (to avoid double-counting charges that have
// already hit the EPS account).
export function effectivePostage(d) {
  if ((d.product_category || '').toLowerCase().includes('ldp postcard')) {
    const orderOk = (d.order_status || '').toUpperCase() === 'DAL [SUBMITTED]';
    const dropOk  = ['OUTSOURCED', 'PRODUCTION'].includes((d.drop_status || '').toUpperCase());
    return (orderOk && dropOk) ? (d.mail_drop_quantity || 0) * LDP_POSTCARD_RATE : 0;
  }
  return d.postage_amount || 0;
}
