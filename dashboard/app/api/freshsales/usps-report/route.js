// GET /api/freshsales/usps-report?month=YYYY-MM — the USPS Monthly Affiliate
// Report for one month (see lib/uspsAffiliateReport.js for the rules).
// Read-only. Takes about a minute: every Won deal in the month, its contacts
// and its account's contacts are read from Freshsales.

import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabaseServer';
import { buildUspsAffiliateReport } from '../../../../lib/uspsAffiliateReport';

export const maxDuration = 300;

export async function GET(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const month = new URL(request.url).searchParams.get('month') || '';
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });

  const { data: settings } = await supabase.from('crm_settings').select('api_url, api_key').eq('id', 1).single();
  if (!settings?.api_url || !settings?.api_key) return NextResponse.json({ error: 'CRM API URL or key not configured' }, { status: 500 });
  const baseUrl = `https://${settings.api_url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}/api`;

  try {
    const report = await buildUspsAffiliateReport({ month, baseUrl, apiKey: settings.api_key, supabase });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
