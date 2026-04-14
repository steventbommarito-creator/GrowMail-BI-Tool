import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer';
import OpenAI from 'openai';
import { createHash } from 'crypto';

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().split('T')[0];
}

function effectivePostage(d) {
  if ((d.product_category || '').toLowerCase().includes('ldp postcard')) {
    const orderOk = (d.order_status || '').toUpperCase() === 'DAL [SUBMITTED]';
    const dropOk  = ['OUTSOURCED', 'PRODUCTION'].includes((d.drop_status || '').toUpperCase());
    return (orderOk && dropOk) ? (d.mail_drop_quantity || 0) * 0.244 : 0;
  }
  return d.postage_amount || 0;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const today   = new Date().toISOString().split('T')[0];
    const in14d   = addDays(today, 14);
    const since90 = addDays(today, -90);

    const [{ data: txns }, { data: drops }, { data: deposits }] = await Promise.all([
      supabase.from('usps_transactions').select('*').gte('transaction_date', since90).order('transaction_date', { ascending: true }),
      supabase.from('osprey_mail_drops')
        .select('mail_drop_id, order_id, customer_name, product_category, drop_est_date, drop_act_date, drop_status, order_status, is_live_status, postage_amount, mail_drop_quantity')
        .in('order_status', ['DAL [SUBMITTED]', 'DIGITAL READY', 'DIGITAL [STAGING]', 'OUTSOURCED', 'OUTSOURCED [STAGING]'])
        .eq('is_live_status', true)
        .lte('drop_est_date', in14d),
      supabase.from('projected_deposits').select('*').eq('is_active', true).lte('deposit_date', in14d).order('deposit_date'),
    ]);

    // Deduplicate drops by mail_drop_id — keep last record
    const seenDrops = new Map();
    for (const d of (drops || [])) seenDrops.set(d.mail_drop_id, d);
    const dedupedDrops = [...seenDrops.values()];

    // Current EPS balance
    const sortedTxns = [...(txns || [])].sort((a, b) => {
      const dd = new Date(b.transaction_date) - new Date(a.transaction_date);
      if (dd !== 0) return dd;
      return Number(b.transaction_number) - Number(a.transaction_number);
    });
    const currentBalance = sortedTxns[0]?.ending_balance ?? 0;

    // Past-due drops
    const pastDue = dedupedDrops.filter(d => d.is_live_status && d.drop_est_date < today && !d.drop_act_date);
    const pastDuePostage = pastDue.reduce((s, d) => s + effectivePostage(d), 0);
    const pastDueCount = pastDue.length;

    // Day-by-day cashflow: build map of date → { postage, deposits }
    const dayMap = {};
    const ensure = (date) => { if (!dayMap[date]) dayMap[date] = { postage: 0, deposits: 0, dropCount: 0 }; };

    // Today's drops only (est date === today)
    for (const d of dedupedDrops) {
      if (!d.is_live_status || d.drop_act_date || d.drop_est_date !== today) continue;
      ensure(today);
      dayMap[today].postage += effectivePostage(d);
      dayMap[today].dropCount += 1;
    }

    // Future drops (after today)
    for (const d of dedupedDrops) {
      if (!d.is_live_status || d.drop_act_date || d.drop_est_date <= today) continue;
      const date = d.drop_est_date;
      if (!date) continue;
      ensure(date);
      dayMap[date].postage += effectivePostage(d);
      dayMap[date].dropCount += 1;
    }

    // Projected deposits
    for (const p of (deposits || [])) {
      const date = p.deposit_date;
      ensure(date);
      dayMap[date].deposits += p.amount;
    }

    const dayData = [];
    let balance = currentBalance;

    // Single past-due row — all overdue drops as one line
    if (pastDueCount > 0) {
      const pastDuePostageTotal = pastDue.reduce((s, d) => s + effectivePostage(d), 0);
      const startBalance = balance;
      balance = +(balance - pastDuePostageTotal).toFixed(2);
      dayData.push({
        date: 'past-due',
        startBalance: +startBalance.toFixed(2),
        postage: +pastDuePostageTotal.toFixed(2),
        deposits: 0,
        dropCount: pastDueCount,
        endBalance: balance,
        isGap: balance < 0,
        isPastDue: true,
      });
    }

    // Today + forward rows
    const sortedDates = Object.keys(dayMap).filter(d => d >= today && d <= in14d).sort();
    if (!sortedDates.includes(today)) sortedDates.unshift(today);

    for (const date of sortedDates) {
      const day = dayMap[date] || { postage: 0, deposits: 0, dropCount: 0 };
      const startBalance = balance;
      balance = +(balance + day.deposits - day.postage).toFixed(2);
      dayData.push({
        date,
        startBalance: +startBalance.toFixed(2),
        postage: +day.postage.toFixed(2),
        deposits: +day.deposits.toFixed(2),
        dropCount: day.dropCount,
        endBalance: balance,
        isGap: balance < 0,
        isPastDue: false,
      });
    }

    // Find first real date (not past-due synthetic row) where balance goes negative
    const runOutDay = dayData.find(d => !d.isPastDue && d.endBalance < 0);

    // Next incoming deposit
    const nextDeposit = (deposits || []).find(p => p.deposit_date >= today);

    // Summary stats object
    const stats = {
      today,
      currentBalance,
      pastDueCount,
      pastDuePostage,
      todayPostage: dayMap[today]?.postage ?? 0,
      todayDropCount: dayMap[today]?.dropCount ?? 0,
      totalFuturePostage: dayData.reduce((s, d) => s + d.postage, 0),
      totalFutureDrops: dedupedDrops.filter(d => !d.drop_act_date && d.drop_est_date >= today).length,
      nextDeposit: nextDeposit ? { date: nextDeposit.deposit_date, amount: nextDeposit.amount, note: nextDeposit.note } : null,
      runOutDate: runOutDay?.date ?? null,
      dayData: dayData.slice(0, 14),
    };

    // Hash the key data points — if unchanged, return cached summary
    const dataHash = createHash('sha256').update(JSON.stringify({
      today,
      currentBalance,
      pastDueCount,
      pastDuePostage: +pastDuePostage.toFixed(2),
      dayData: dayData.map(d => ({ date: d.date, postage: d.postage, deposits: d.deposits })),
      deposits: (deposits || []).map(d => ({ date: d.deposit_date, amount: d.amount })),
    })).digest('hex');

    // Check cache
    const { data: cached } = await supabase
      .from('ai_summary_cache')
      .select('summary, data_hash, generated_at')
      .eq('id', 1)
      .maybeSingle();

    if (cached?.data_hash === dataHash) {
      // Data unchanged — return cached summary
      return NextResponse.json({ summary: cached.summary, stats, dayData, cached: true, generatedAt: cached.generated_at });
    }

    // Data changed — call OpenAI and store result
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `You are a financial analyst for GrowMail, a direct mail company. Write a concise 2-3 sentence plain-text executive summary of the current postage cashflow situation. Be specific with numbers. Use natural language like you're briefing a manager. Do not use bullet points or headers. Here is the data:

Today: ${stats.today}
Current EPS (postage account) balance: $${stats.currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Late/past-due drops: ${stats.pastDueCount} drops totaling $${stats.pastDuePostage.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in postage
Postage needed today: $${stats.todayPostage.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} across ${stats.todayDropCount} drops
Total postage needed across all upcoming drops: $${stats.totalFuturePostage.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} across ${stats.totalFutureDrops} drops
${stats.nextDeposit ? `Next projected deposit: $${stats.nextDeposit.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} on ${stats.nextDeposit.date}${stats.nextDeposit.note ? ` (${stats.nextDeposit.note})` : ''}` : 'No projected deposits scheduled.'}
${stats.runOutDate ? `Projected balance runs negative on: ${stats.runOutDate}` : 'Balance stays positive through all scheduled drops.'}

Day-by-day breakdown (next 14 days):
${stats.dayData.map(d => `  ${d.date}: start $${d.startBalance.toLocaleString()}, postage -$${d.postage.toLocaleString()}, deposits +$${d.deposits.toLocaleString()}, end $${d.endBalance.toLocaleString()}`).join('\n')}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.4,
    });

    const summary = completion.choices[0]?.message?.content?.trim() ?? 'Unable to generate summary.';
    const generatedAt = new Date().toISOString();

    // Upsert into cache (single row, id=1)
    await supabase.from('ai_summary_cache').upsert({
      id: 1,
      summary,
      data_hash: dataHash,
      generated_at: generatedAt,
    }, { onConflict: 'id' });

    return NextResponse.json({ summary, stats, dayData, cached: false, generatedAt });
  } catch (err) {
    console.error('overview-summary error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
