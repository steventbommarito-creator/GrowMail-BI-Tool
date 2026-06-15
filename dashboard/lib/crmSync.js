/**
 * CRM sync engine — pushes Osprey orders to Freshsales as Deals.
 *
 * Core invariants (locked in with the user before building):
 *   • 1 FS Deal per Osprey Order ID (drops rolled up to the order level).
 *   • order_status drives the FS deal stage via crm_status_mappings.
 *   • Live Sync OFF by default → these functions are no-ops on the cron path.
 *   • Conflict policy = "skip and flag" — if FS-side updated_at is newer than
 *     our stored value, we don't push; we log a conflict_detected event.
 *   • Payload-hash optimization — if the outbound payload SHA256 matches the
 *     last one we sent, skip the network call.
 *
 * Public surface:
 *   buildPayload(order)               — pure, testable, no I/O
 *   syncOrder(supabase, order, ctx)   — single-order pipeline
 *   syncAll(supabase, ctx)            — full push (Sync All button)
 *   syncChanged(supabase, ctx)        — incremental (cron path)
 *   logEvent(supabase, fields)        — helper
 */

const crypto = require('crypto');
const fw = require('./freshworks');

// ─── helpers ────────────────────────────────────────────────────────────────

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function logEvent(supabase, e) {
  // Fire-and-forget; we never want event logging to break a sync run.
  try {
    await supabase.from('crm_events').insert({
      event_type:  e.event_type,
      entity_type: e.entity_type ?? null,
      entity_id:   e.entity_id ?? null,
      status:      e.status ?? 'info',
      title:       e.title,
      body:        e.body ?? null,
      data_json:   e.data_json ?? null,
      created_by:  e.created_by ?? 'cron',
    });
  } catch (err) {
    console.error('crm_events insert failed:', err.message);
  }
}

/**
 * Roll up the drops of an order into a single FS-bound payload. Pure function —
 * easy to unit-test or re-run in dry-run mode without touching the API.
 */
function buildPayload(orderRows, stageMap, pipelineId) {
  const first = orderRows[0];
  const totalDropAmount = orderRows.reduce((s, r) => s + (Number(r.mail_drop_amount) || 0), 0);
  const totalPostage    = orderRows.reduce((s, r) => s + (Number(r.actual_postage ?? r.postage_amount) || 0), 0);
  const totalQuantity   = orderRows.reduce((s, r) => s + (Number(r.mail_drop_quantity) || 0), 0);

  const orderStatus = first.order_status;
  const mapping = stageMap.get(orderStatus); // { fs_stage_id, fs_stage_name, fs_stage_category, excluded }

  return {
    order_id: first.order_id,
    customer_name: first.customer_name,
    order_status: orderStatus,
    deal_pipeline_id: pipelineId,
    deal_stage_id: mapping?.fs_stage_id ?? null,
    deal_stage_category: mapping?.fs_stage_category ?? null,
    excluded: !!mapping?.excluded,
    name: `${first.customer_name || 'Unknown'} · Order ${first.order_id}`,
    amount: +totalDropAmount.toFixed(2),
    custom: {
      cf_order_id:       first.order_id,
      cf_order_status:   orderStatus,
      cf_drop_count:     orderRows.length,
      cf_total_quantity: totalQuantity,
      cf_total_postage:  +totalPostage.toFixed(2),
      cf_product_category: first.product_category || null,
      cf_web_id:         first.web_id || null,
      // Earliest drop_est_date in the order = the deal's "expected" date
      cf_earliest_drop:  orderRows
        .map(r => r.drop_est_date)
        .filter(Boolean)
        .sort()[0] || null,
    },
  };
}

// What we hash to decide "did anything change since last push". Stage,
// amount, status, drop count, postage — the fields the user cares about.
function payloadHash(p) {
  return sha256(JSON.stringify({
    s: p.deal_stage_id,
    a: p.amount,
    n: p.name,
    os: p.order_status,
    dc: p.custom.cf_drop_count,
    tp: p.custom.cf_total_postage,
    tq: p.custom.cf_total_quantity,
    ed: p.custom.cf_earliest_drop,
  }));
}

async function loadStageMap(supabase) {
  const { data, error } = await supabase
    .from('crm_status_mappings')
    .select('order_status, fs_stage_id, fs_stage_name, fs_stage_category, excluded');
  if (error) throw new Error(`Failed to load status mappings: ${error.message}`);
  const m = new Map();
  for (const r of data || []) m.set(r.order_status, r);
  return m;
}

async function loadSettings(supabase) {
  const { data, error } = await supabase
    .from('crm_settings')
    .select('pipeline_id, live_sync_enabled')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Failed to load crm_settings: ${error.message}`);
  return data;
}

// ─── single-order sync ──────────────────────────────────────────────────────

/**
 * Sync one order. Returns { status: 'created'|'updated'|'skipped'|'conflict'|'error', ... }
 *
 * ctx = { triggeredBy: 'cron'|'sync-all'|email, force?: boolean }
 *   force = true bypasses the payload-hash short-circuit (used by Sync All).
 */
async function syncOrder(supabase, orderRows, ctx, settings, stageMap) {
  const payload = buildPayload(orderRows, stageMap, settings.pipeline_id);

  // Skip: status not configured at all
  if (!stageMap.has(payload.order_status)) {
    await logEvent(supabase, {
      event_type: 'deal_skipped_unmapped',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'info',
      title: `Skipped — order_status "${payload.order_status}" not mapped`,
      body: `Configure this status in CRM → Opportunities → Mapping to sync.`,
      created_by: ctx.triggeredBy,
    });
    return { status: 'skipped', reason: 'unmapped' };
  }

  // Skip: explicitly excluded ("Don't Sync")
  if (payload.excluded) {
    await logEvent(supabase, {
      event_type: 'deal_skipped_excluded',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'info',
      title: `Excluded — "${payload.order_status}" set to Don't Sync`,
      created_by: ctx.triggeredBy,
    });
    return { status: 'skipped', reason: 'excluded' };
  }

  // Has mapping but with NULL fs_stage_id (treated as Don't Sync — UI safety)
  if (!payload.deal_stage_id) {
    await logEvent(supabase, {
      event_type: 'deal_skipped_unmapped',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'warning',
      title: `Skipped — "${payload.order_status}" has no FS stage assigned`,
      created_by: ctx.triggeredBy,
    });
    return { status: 'skipped', reason: 'no_stage' };
  }

  const hash = payloadHash(payload);

  // Find our local record (if any)
  const { data: existing } = await supabase
    .from('crm_synced_deals')
    .select('*')
    .eq('order_id', payload.order_id)
    .maybeSingle();

  // ── CREATE path ─────────────────────────────────────────────────────────
  if (!existing) {
    const dealBody = {
      name: payload.name,
      amount: payload.amount,
      deal_stage_id: payload.deal_stage_id,
      deal_pipeline_id: payload.deal_pipeline_id,
      custom_field: payload.custom,
    };
    const res = await fw.createDeal(supabase, dealBody);
    if (!res.ok) {
      await logEvent(supabase, {
        event_type: 'deal_create_failed',
        entity_type: 'order', entity_id: payload.order_id,
        status: 'error',
        title: `Failed to create FS deal for ${payload.order_id}`,
        body: res.error,
        data_json: { http_status: res.status, request: dealBody, response: res.data },
        created_by: ctx.triggeredBy,
      });
      return { status: 'error', error: res.error };
    }
    const fsDeal = res.data?.deal || {};
    await supabase.from('crm_synced_deals').insert({
      order_id: payload.order_id,
      fs_deal_id: String(fsDeal.id),
      fs_stage_id: payload.deal_stage_id,
      fs_updated_at: fsDeal.updated_at || null,
      last_payload_hash: hash,
      last_synced_by: ctx.triggeredBy,
      last_status: 'ok',
    });
    await logEvent(supabase, {
      event_type: 'deal_created',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'success',
      title: `Created deal "${payload.name}" in ${payload.deal_stage_category || 'mapped stage'}`,
      data_json: { fs_deal_id: fsDeal.id, amount: payload.amount },
      created_by: ctx.triggeredBy,
    });
    return { status: 'created', fs_deal_id: fsDeal.id };
  }

  // ── UPDATE path ─────────────────────────────────────────────────────────
  // Short-circuit if nothing changed since last push.
  if (!ctx.force && existing.last_payload_hash === hash) {
    return { status: 'skipped', reason: 'unchanged' };
  }

  // Conflict detection: GET the FS deal and compare updated_at.
  const live = await fw.getDeal(supabase, existing.fs_deal_id);
  if (!live.ok) {
    await logEvent(supabase, {
      event_type: 'deal_update_failed',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'error',
      title: `Couldn't fetch FS deal ${existing.fs_deal_id} for update`,
      body: live.error,
      data_json: { http_status: live.status },
      created_by: ctx.triggeredBy,
    });
    return { status: 'error', error: live.error };
  }
  const liveUpdatedAt = live.data?.deal?.updated_at;
  if (existing.fs_updated_at && liveUpdatedAt && new Date(liveUpdatedAt) > new Date(existing.fs_updated_at)) {
    // FS-side edit detected — skip and flag.
    await supabase.from('crm_synced_deals')
      .update({ last_status: 'conflict_skipped', last_synced_at: new Date().toISOString(), last_synced_by: ctx.triggeredBy })
      .eq('order_id', payload.order_id);
    await logEvent(supabase, {
      event_type: 'conflict_detected',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'warning',
      title: `Skipped — deal edited in FS since last sync`,
      body: `FS updated_at ${liveUpdatedAt} is newer than our last sync ${existing.fs_updated_at}. Resolve in FS or manually re-sync.`,
      data_json: { fs_deal_id: existing.fs_deal_id },
      created_by: ctx.triggeredBy,
    });
    return { status: 'conflict' };
  }

  // No conflict — push the update.
  const dealBody = {
    name: payload.name,
    amount: payload.amount,
    deal_stage_id: payload.deal_stage_id,
    custom_field: payload.custom,
  };
  const upd = await fw.updateDeal(supabase, existing.fs_deal_id, dealBody);
  if (!upd.ok) {
    await logEvent(supabase, {
      event_type: 'deal_update_failed',
      entity_type: 'order', entity_id: payload.order_id,
      status: 'error',
      title: `Failed to update FS deal ${existing.fs_deal_id}`,
      body: upd.error,
      data_json: { http_status: upd.status, request: dealBody, response: upd.data },
      created_by: ctx.triggeredBy,
    });
    return { status: 'error', error: upd.error };
  }
  const newFsUpdatedAt = upd.data?.deal?.updated_at || new Date().toISOString();
  await supabase.from('crm_synced_deals')
    .update({
      fs_stage_id: payload.deal_stage_id,
      fs_updated_at: newFsUpdatedAt,
      last_payload_hash: hash,
      last_synced_at: new Date().toISOString(),
      last_synced_by: ctx.triggeredBy,
      last_status: 'ok',
      last_error: null,
    })
    .eq('order_id', payload.order_id);
  await logEvent(supabase, {
    event_type: 'deal_updated',
    entity_type: 'order', entity_id: payload.order_id,
    status: 'success',
    title: `Updated deal "${payload.name}"`,
    data_json: { fs_deal_id: existing.fs_deal_id, stage_id: payload.deal_stage_id, amount: payload.amount },
    created_by: ctx.triggeredBy,
  });
  return { status: 'updated' };
}

// ─── batch sync ─────────────────────────────────────────────────────────────

/**
 * Group osprey_mail_drops rows by order_id. The latest sync state of each
 * drop wins (dedupe by mail_drop_id keeping the most recent captured_at).
 */
function groupByOrder(rows) {
  // Dedupe by mail_drop_id (keep highest captured_at).
  const dedup = new Map();
  for (const r of rows) {
    const prev = dedup.get(r.mail_drop_id);
    if (!prev || new Date(r.captured_at) > new Date(prev.captured_at)) dedup.set(r.mail_drop_id, r);
  }
  // Bucket by order_id.
  const byOrder = new Map();
  for (const r of dedup.values()) {
    if (!r.order_id) continue;
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push(r);
  }
  return byOrder;
}

async function fetchAllDrops(supabase) {
  // Paginate around the 1k default cap. CRM cares about ALL statuses, not
  // just the cashflow/late-mailings active filter.
  const cols = 'mail_drop_id, order_id, captured_at, customer_id, customer_name, '
    + 'product_category, order_status, mail_drop_amount, postage_amount, actual_postage, '
    + 'mail_drop_quantity, drop_est_date, web_id, mail_location';
  let all = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await supabase.from('osprey_mail_drops').select(cols).range(from, from + size - 1);
    if (error) throw new Error(`Failed to fetch drops: ${error.message}`);
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

/**
 * Sync All — Iterate every order. ctx.force = true bypasses payload-hash
 * short-circuiting so the FS account gets a fresh push of every mapped deal.
 */
async function syncAll(supabase, ctx) {
  await logEvent(supabase, {
    event_type: 'sync_started',
    status: 'info',
    title: `Sync All started`,
    body: `Triggered by ${ctx.triggeredBy}`,
    created_by: ctx.triggeredBy,
  });

  const [settings, stageMap, rows] = await Promise.all([
    loadSettings(supabase),
    loadStageMap(supabase),
    fetchAllDrops(supabase),
  ]);

  if (!settings.pipeline_id) {
    await logEvent(supabase, {
      event_type: 'sync_failed', status: 'error',
      title: 'Sync All aborted — no pipeline selected',
      body: 'Pick a pipeline on the Integrations page first.',
      created_by: ctx.triggeredBy,
    });
    return { ok: false, error: 'no_pipeline' };
  }

  const byOrder = groupByOrder(rows);
  const stats = { created: 0, updated: 0, skipped: 0, conflict: 0, error: 0 };
  for (const [, orderRows] of byOrder) {
    const r = await syncOrder(supabase, orderRows, { ...ctx, force: true }, settings, stageMap);
    stats[r.status] = (stats[r.status] || 0) + 1;
  }

  await supabase.from('crm_settings').update({
    last_full_sync_at: new Date().toISOString(),
    last_full_sync_by: ctx.triggeredBy,
  }).eq('id', 1);

  await logEvent(supabase, {
    event_type: 'sync_completed',
    status: stats.error > 0 ? 'warning' : 'success',
    title: `Sync All complete — ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped`,
    body: `${stats.conflict} conflicts skipped, ${stats.error} errors. ${byOrder.size} orders scanned.`,
    data_json: stats,
    created_by: ctx.triggeredBy,
  });

  // Prune old events; keeps the table bounded without a separate cron.
  await supabase.rpc('prune_crm_events').catch(() => {});

  return { ok: true, stats, orderCount: byOrder.size };
}

/**
 * Cron-path sync — called from insertOsprey after upserts. Honors the
 * live_sync_enabled toggle and uses the payload-hash short-circuit so only
 * orders whose payload actually changed make an FS call.
 */
async function syncChanged(supabase, ctx) {
  const settings = await loadSettings(supabase);
  if (!settings.live_sync_enabled) return { ok: true, skipped: true, reason: 'live_sync_off' };
  if (!settings.pipeline_id) return { ok: false, error: 'no_pipeline' };

  const stageMap = await loadStageMap(supabase);
  const rows = await fetchAllDrops(supabase);
  const byOrder = groupByOrder(rows);

  const stats = { created: 0, updated: 0, skipped: 0, conflict: 0, error: 0 };
  for (const [, orderRows] of byOrder) {
    const r = await syncOrder(supabase, orderRows, { ...ctx, force: false }, settings, stageMap);
    stats[r.status] = (stats[r.status] || 0) + 1;
  }

  // Only log a sync_completed if anything actually moved — otherwise the
  // feed gets noisy from every Osprey run that resulted in no diffs.
  const changed = stats.created + stats.updated + stats.error + stats.conflict;
  if (changed > 0) {
    await logEvent(supabase, {
      event_type: 'sync_completed',
      status: stats.error > 0 ? 'warning' : 'success',
      title: `Incremental sync — ${stats.created} created, ${stats.updated} updated`,
      body: `${stats.conflict} conflicts, ${stats.error} errors. Triggered by ${ctx.triggeredBy}.`,
      data_json: stats,
      created_by: ctx.triggeredBy,
    });
  }

  await supabase.rpc('prune_crm_events').catch(() => {});

  return { ok: true, stats, orderCount: byOrder.size };
}

module.exports = {
  buildPayload,
  payloadHash,
  syncOrder,
  syncAll,
  syncChanged,
  logEvent,
};
