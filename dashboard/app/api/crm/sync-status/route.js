// GET /api/crm/sync-status — headline counts for the Osprey→Freshworks syncs
// (deals + leads) and the one-time SFDC imports (opportunities + activities),
// read straight from the state tables the cloud jobs write to.
import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';

const STAGE = { won: 127003582559, quoted: 127003582554, lost: 127003582560 };

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const countWhere = async (table, filters) => {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    for (const [col, val] of filters) q = q.eq(col, val);
    const { count } = await q;
    return count || 0;
  };
  const maxTime = async (table, col) => {
    const { data } = await supabase.from(table).select(col).order(col, { ascending: false }).limit(1);
    return data?.[0]?.[col] || null;
  };

  const [dealsTotal, won, quoted, lost, excluded, dealsLast] = await Promise.all([
    countWhere('osprey_deal_sync', [['excluded', false]]),
    countWhere('osprey_deal_sync', [['excluded', false], ['last_stage_id', STAGE.won]]),
    countWhere('osprey_deal_sync', [['excluded', false], ['last_stage_id', STAGE.quoted]]),
    countWhere('osprey_deal_sync', [['excluded', false], ['last_stage_id', STAGE.lost]]),
    countWhere('osprey_deal_sync', [['excluded', true]]),
    maxTime('osprey_deal_sync', 'updated_at'),
  ]);

  const [leadsCreated, leadsExists, leadsNoEmail, leadsLast] = await Promise.all([
    countWhere('osprey_lead_sync', [['outcome', 'created']]),
    countWhere('osprey_lead_sync', [['outcome', 'exists']]),
    countWhere('osprey_lead_sync', [['outcome', 'no_email']]),
    maxTime('osprey_lead_sync', 'synced_at'),
  ]);

  const importStats = async (type) => {
    const { data } = await supabase.from('crm_imports')
      .select('id, status, total_rows, completed_at')
      .eq('import_type', type).order('uploaded_at', { ascending: false }).limit(1);
    const imp = data?.[0];
    if (!imp) return null;
    const [pending, sent, failed, validation_failed] = await Promise.all(
      ['pending', 'sent', 'failed', 'validation_failed'].map((st) =>
        countWhere('crm_import_rows', [['import_id', imp.id], ['status', st]])));
    return { status: imp.status, total: imp.total_rows, completedAt: imp.completed_at, pending, sent, failed, validation_failed };
  };
  const [opportunities, tasks] = await Promise.all([importStats('opportunities'), importStats('tasks')]);

  return NextResponse.json({
    ok: true,
    deals: { total: dealsTotal, won, quoted, lost, excluded, lastSync: dealsLast },
    leads: { created: leadsCreated, exists: leadsExists, noEmail: leadsNoEmail,
      total: leadsCreated + leadsExists + leadsNoEmail, lastSync: leadsLast },
    imports: { opportunities, tasks },
  });
}
