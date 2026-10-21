// POST /api/osprey/balances — { orderIds: [...] } → live Balance Due per
// order straight from Osprey. The Late Mailings page calls this in small
// chunks on load so cells fill in progressively. Failed lookups come back as
// null so one bad order doesn't sink the chunk.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
import { getOrderBalance } from '../../../../lib/ospreyApi';

const MAX_IDS = 50;
const CONCURRENCY = 8;

export async function POST(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const ids = [...new Set((body.orderIds || []).map(String).filter(id => /^\d+$/.test(id)))];
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `Max ${MAX_IDS} orderIds per request` }, { status: 400 });

  const balances = {};
  let next = 0;
  let firstError = null;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        balances[id] = await getOrderBalance(id);
      } catch (e) {
        balances[id] = null;
        firstError ||= e.message;
      }
    }
  }));

  return NextResponse.json({ balances, error: firstError });
}
