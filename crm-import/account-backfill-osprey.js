/**
 * Batch 1 backfill: give every Osprey-sync deal an account. Targets
 * osprey_deal_sync rows with fw_account_id = null (~491): match the customer to
 * an existing FW account (create it if none), link the deal to that account,
 * and attach the account's existing contact to the deal. Records fw_account_id
 * back into state so the run is resumable (fixed rows are skipped next time).
 *
 * Does NOT touch Customer status — that is Batch 2 (customer-status-backfill.js).
 *
 *   node crm-import/account-backfill-osprey.js [--limit N]
 */
const C = require('./common');
const E = require('./sync-enrich');

async function matchAccount(name) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const r = await C.fs('POST', '/filtered_search/sales_account', { filter_rule: [{ attribute: 'name', operator: 'is', value: nm }] });
  if (!r.ok) return null;
  const list = r.data?.sales_accounts || [];
  const hit = list.find((a) => String(a.name || '').trim().toLowerCase() === nm.toLowerCase()) || list[0];
  return hit ? hit.id : null;
}

async function main() {
  const limArg = process.argv.indexOf('--limit');
  const limit = limArg > -1 ? Number(process.argv[limArg + 1]) : 0;
  const started = Date.now();
  const MAX = Number(process.env.MAX_RUNTIME_MS || 0);

  const stats = { matched: 0, created: 0, linked: 0, contactLinked: 0, gaps: 0, failed: 0 };
  let done = 0;
  for (;;) {
    if (MAX && Date.now() - started >= MAX) { console.log('Runtime budget reached — exiting (resumable).'); break; }
    const { data: rows } = await C.supabase.from('osprey_deal_sync')
      .select('order_id, fw_deal_id, customer_id, customer_name')
      .is('fw_account_id', null).not('fw_deal_id', 'is', null).limit(100);
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const order = { order_id: row.order_id, customer_id: row.customer_id, customer_name: row.customer_name };
      let acctId = await matchAccount(row.customer_name);
      if (acctId) stats.matched++;
      else { acctId = await E.createAccount(order); if (acctId) stats.created++; }
      if (!acctId) { stats.failed++; done++; continue; }   // no name → cannot make an account

      const contacts = await E.accountContacts(acctId);
      const contactId = contacts[0]?.id || null;
      const patch = { sales_account_id: acctId };
      if (contactId) patch.contacts_added_list = [contactId];
      const p = await C.fs('PUT', `/deals/${row.fw_deal_id}`, { deal: patch });
      if (!p.ok) { stats.failed++; done++; continue; }
      stats.linked++;
      if (contactId) stats.contactLinked++; else { stats.gaps++; await E.logContactGap(order, acctId); }
      await C.supabase.from('osprey_deal_sync').update({ fw_account_id: String(acctId), updated_at: new Date().toISOString() }).eq('order_id', row.order_id);
      done++;
      if (done % 50 === 0) console.log(`  ${done} — ${JSON.stringify(stats)}`);
      if (limit && done >= limit) break;
    }
    if (limit && done >= limit) break;
  }
  console.log(`\nAccount backfill done: ${done} deals — ${JSON.stringify(stats)}`);
}

main().catch((e) => { console.error('ACCOUNT-BACKFILL FAILED:', e.message); process.exit(1); });
