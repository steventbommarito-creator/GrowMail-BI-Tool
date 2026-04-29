const OpenAI = require('openai');
const supabase = require('./supabase');

async function aiInsights() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const in8Weeks = new Date(Date.now() + 8 * 7 * 24 * 60 * 60 * 1000).toISOString();

  // Prefer Osprey's actual_postage (real production cost) over postage_amount
  // (estimate). Mirrors dashboard/lib/postage.js — kept inline here because
  // this file is CJS while the dashboard helper is ESM.
  const eff = (r) => (r?.actual_postage && r.actual_postage > 0)
    ? r.actual_postage
    : (r?.postage_amount || 0);

  // --- Osprey: committed (not yet mailed) ---
  const { data: committed } = await supabase
    .from('osprey_mail_drops')
    .select('postage_amount, actual_postage, mail_drop_amount, fulfillment_path, product_category')
    .gte('drop_est_date', new Date().toISOString().split('T')[0])
    .in('order_status', ['DMM [ACTIVE]', 'DIGITAL [STAGING]', 'List Received', 'scheduled'])
    .gte('captured_at', since30);

  // --- USPS: actuals paid ---
  const { data: actuals } = await supabase
    .from('usps_transactions')
    .select('amount, transaction_date')
    .gte('transaction_date', since30.split('T')[0]);

  // --- Osprey: upcoming 8 weeks ---
  const { data: upcoming } = await supabase
    .from('osprey_mail_drops')
    .select('drop_est_date, postage_amount, actual_postage, product_category, fulfillment_path')
    .gte('drop_est_date', new Date().toISOString().split('T')[0])
    .lte('drop_est_date', in8Weeks.split('T')[0])
    .order('drop_est_date', { ascending: true });

  // --- Osprey: recent 30 days for variance ---
  const { data: recent } = await supabase
    .from('osprey_mail_drops')
    .select('fulfillment_path, product_category, postage_amount, actual_postage, mail_drop_amount')
    .gte('captured_at', since30);

  // Build summary
  const totalCommitted = (committed || []).reduce((s, r) => s + eff(r), 0);
  const totalPaid = (actuals || []).reduce((s, r) => s + Math.abs(r.amount || 0), 0);

  // Postage by product category
  const byCategory = {};
  for (const r of recent || []) {
    if (!r.product_category) continue;
    byCategory[r.product_category] = (byCategory[r.product_category] || 0) + eff(r);
  }

  // Quoted vs actual by fulfillment path
  const quotedByPath = {};
  for (const r of recent || []) {
    if (!r.fulfillment_path) continue;
    quotedByPath[r.fulfillment_path] = (quotedByPath[r.fulfillment_path] || 0) + eff(r);
  }

  // Upcoming drops grouped by week
  const weeklyForecast = {};
  for (const r of upcoming || []) {
    const d = new Date(r.drop_est_date);
    // ISO week label
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const label = weekStart.toISOString().split('T')[0];
    if (!weeklyForecast[label]) weeklyForecast[label] = { postage: 0, count: 0 };
    weeklyForecast[label].postage += eff(r);
    weeklyForecast[label].count += 1;
  }

  const summary = {
    as_of: now,
    total_postage_committed: totalCommitted,
    total_postage_paid_last_30d: totalPaid,
    variance_committed_vs_paid: totalCommitted - totalPaid,
    postage_by_product_category: byCategory,
    quoted_postage_by_fulfillment_path: quotedByPath,
    upcoming_8_week_forecast: weeklyForecast,
  };

  console.log('Calling GPT-4o for insights...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `Analyze this direct mail postage data and provide: 1) a plain English daily summary, 2) any anomalies worth flagging, 3) a 7-day forward postage forecast based on scheduled drops. Data: ${JSON.stringify(summary)}`,
      },
    ],
  });

  const narrative = response.choices[0].message.content;

  // Parse out three sections — best effort split
  const sections = narrative.split(/\d+\)/);
  const dailySummary = (sections[1] || narrative).trim();
  const anomaly = (sections[2] || '').trim();
  const forecast = (sections[3] || '').trim();

  const generatedAt = new Date().toISOString();
  const insights = [
    { generated_at: generatedAt, insight_type: 'daily_summary', subject: 'Daily Postage Summary', narrative: dailySummary, data_json: summary },
    { generated_at: generatedAt, insight_type: 'anomaly', subject: 'Anomalies', narrative: anomaly, data_json: summary },
    { generated_at: generatedAt, insight_type: 'forecast', subject: '7-Day Forecast', narrative: forecast, data_json: summary },
  ];

  const { error } = await supabase.from('ai_insights').insert(insights);
  if (error) throw new Error(`Failed to insert ai_insights: ${error.message}`);

  console.log('aiInsights complete — 3 insight rows written');
  return insights;
}

module.exports = { aiInsights };
