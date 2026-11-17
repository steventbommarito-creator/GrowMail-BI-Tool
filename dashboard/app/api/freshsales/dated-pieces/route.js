// POST /api/freshsales/dated-pieces — { orderIds: [...] } → { dates: { orderId: 'YYYY-MM-DD' } }
// The "Dated Piece Date" (cf_dated_piece_dated) from each order's Freshsales
// deal, matched on the deal's Order Number (cf_order_number). Orders with no
// deal or no date are simply absent from the result. Read-only: one
// filtered_search per 100 orders finds the deals that have a date, then each
// of those is fetched because search results don't include custom fields.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';

const MAX_IDS = 500;
const CONCURRENCY = 6;
// The date is stored as midnight Eastern; read it back in Eastern.
const toDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export async function POST(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const ids = [...new Set((body.orderIds || []).map(String).filter(id => /^\d+$/.test(id)))];
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `Max ${MAX_IDS} orderIds per request` }, { status: 400 });

  const { data: settings } = await supabase.from('crm_settings').select('api_url, api_key').eq('id', 1).single();
  if (!settings?.api_url || !settings?.api_key) return NextResponse.json({ error: 'CRM API URL or key not configured' }, { status: 500 });
  const base = `https://${settings.api_url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}/api`;
  const headers = { Authorization: `Token token=${settings.api_key}`, 'Content-Type': 'application/json' };

  try {
    const dealIds = [];
    for (let i = 0; i < ids.length; i += 100) {
      for (let page = 1; page <= 10; page++) {
        const res = await fetch(`${base}/filtered_search/deal`, {
          method: 'POST', headers, cache: 'no-store',
          body: JSON.stringify({
            filter_rule: [
              { attribute: 'cf_order_number', operator: 'is_in', value: ids.slice(i, i + 100).map(Number) },
              { attribute: 'cf_dated_piece_dated', operator: 'is_in_the_range', value: ['2000-01-01', '2100-01-01'] },
            ],
            page, per_page: 100,
          }),
        });
        if (!res.ok) throw new Error(`Freshsales search: HTTP ${res.status}`);
        const deals = (await res.json()).deals || [];
        dealIds.push(...deals.map(d => d.id));
        if (deals.length < 100) break;
      }
    }

    const dates = {};
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dealIds.length) }, async () => {
      while (next < dealIds.length) {
        const id = dealIds[next++];
        const res = await fetch(`${base}/deals/${id}`, { headers, cache: 'no-store' });
        if (!res.ok) continue;
        const cf = (await res.json()).deal?.custom_field || {};
        if (cf.cf_order_number && cf.cf_dated_piece_dated) dates[String(cf.cf_order_number)] = toDate(cf.cf_dated_piece_dated);
      }
    }));
    return NextResponse.json({ dates });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
