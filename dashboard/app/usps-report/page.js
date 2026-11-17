'use client';

// USPS Reporting — the monthly USPS affiliate report. Pick a month and the
// report runs live against Freshsales (about a minute). Only first-order (New)
// business is reported and earns the 15% share; existing USPS customers show
// for reference. Rules live in lib/uspsAffiliateReport.js. "Download Excel"
// produces the USPS template layout plus an Orders sheet.

import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { OspreyOrderLink } from '../../lib/ospreyLinks';
import { SUMMARY_LINES, REV_SHARE_PCT } from '../../lib/uspsAffiliateReport';

const AFFILIATE_NAME = 'Growmail LLC';
const CONTACT_NAME = 'Steve Bommarito';

const fmt$ = (n) => (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtN = (n) => (n ?? 0).toLocaleString('en-US');
const fmtDate = (d) => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

// The last 24 months, newest first; the default is last month (the one you report on).
function monthOptions() {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ value, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }) });
  }
  return out;
}

function downloadExcel(report) {
  const s = report.summary;
  const aoa = [
    ['Monthly Affiliate Report'], [],
    ['Affiliate Name', AFFILIATE_NAME],
    ['Contact Person Name', CONTACT_NAME],
    ['Month / Year', s.monthLabel], [],
    ['USPS / Affiliate Reporting'],
    ...SUMMARY_LINES.map(([label, key]) => [label, s[key]]),
  ];
  const sum = XLSX.utils.aoa_to_sheet(aoa);
  sum['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }, { s: { r: 6, c: 0 }, e: { r: 6, c: 1 } }];
  sum['!cols'] = [{ wch: 34 }, { wch: 18 }];
  SUMMARY_LINES.forEach(([, , f], i) => {
    const cell = sum[XLSX.utils.encode_cell({ r: 7 + i, c: 1 })];
    if (cell) cell.z = f === '$' ? '$#,##0.00' : '#,##0';
  });

  const cols = [['Account', 'account'], ['Order #', 'order'], ['Close Date', 'closed'], ['Account First Order', 'firstOrder'],
    ['New / Existing', 'type'], ['Production', 'production'], ['Postage', 'postage'], ['Pieces', 'pieces'],
    ['Revenue From', 'source'], ['USPS Attribution', 'why'], ['Deal', 'deal']];
  const orderRows = report.rows.length
    ? report.rows.map((r) => cols.map(([, k]) => r[k]))
    : [[`No USPS-attributed Won orders closed ${report.from} to ${report.to} (${report.wonDealsInMonth} Won deals and ${report.contactsChecked} contacts checked).`]];
  const od = XLSX.utils.aoa_to_sheet([cols.map(([l]) => l), ...orderRows]);
  od['!cols'] = [32, 10, 12, 18, 14, 13, 12, 10, 26, 60, 50].map((wch) => ({ wch }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sum, 'Monthly Affiliate Report');
  XLSX.utils.book_append_sheet(wb, od, 'Orders');
  XLSX.writeFile(wb, `USPS_Monthly_Affiliate_Report_${report.month}.xlsx`);
}

// Shown while the report builds (about a minute): a mail truck doing its
// route, with a rotating status line so the wait reads as work in progress.
const LOADING_LINES = [
  'Sorting the mail by hand…',
  'Asking Freshsales very nicely…',
  'Licking 5,000 stamps…',
  'Dodging the neighborhood dog…',
  'Checking every mailbox on the route…',
  'Neither snow nor rain nor slow APIs…',
  'Counting postcards. Twice.',
  'Looking for the one deal that fell behind the sorter…',
];

function MailTruckLoader() {
  const [line, setLine] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLine((i) => (i + 1) % LOADING_LINES.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rounded-xl border p-6 text-center" role="status" aria-live="polite"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <style>{`
        @keyframes usps-drive { 0% { left: -12%; } 100% { left: 104%; } }
        @keyframes usps-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
        @keyframes usps-fly { 0% { opacity: 0; transform: translate(0, 0) rotate(0deg); } 15% { opacity: 1; }
          100% { opacity: 0; transform: translate(-70px, -34px) rotate(-200deg); } }
        @keyframes usps-road { to { background-position: -40px 0; } }
        .usps-truck { position: absolute; bottom: 2px; animation: usps-drive 5s linear infinite; }
        .usps-truck-body { display: block; animation: usps-bounce 0.45s ease-in-out infinite; }
        .usps-letter { position: absolute; left: -6px; bottom: 20px; font-size: 16px; opacity: 0; animation: usps-fly 1.5s ease-out infinite; }
        .usps-road { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; animation: usps-road 0.5s linear infinite;
          background-image: repeating-linear-gradient(90deg, var(--border) 0 20px, transparent 20px 40px); }
        @media (prefers-reduced-motion: reduce) {
          .usps-truck { animation: none; left: 46%; }
          .usps-truck-body, .usps-letter, .usps-road { animation: none; }
        }
      `}</style>
      <div className="relative mx-auto overflow-hidden" style={{ height: 64, maxWidth: 520 }} aria-hidden="true">
        <div className="usps-truck">
          <span className="usps-letter">✉️</span>
          <span className="usps-letter" style={{ animationDelay: '0.5s' }}>📨</span>
          <span className="usps-letter" style={{ animationDelay: '1s' }}>✉️</span>
          <svg className="usps-truck-body" width="74" height="44" viewBox="0 0 74 44" role="img" aria-label="Mail truck">
            {/* boxy white delivery truck, facing right */}
            <path d="M3 6 Q3 3 6 3 H50 Q54 3 56 6 L62 17 H68 Q71 17 71 20 V33 H3 Z" fill="#ffffff" stroke="#374151" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M47 7 H53.5 L58.5 17 H47 Z" fill="#bfdbfe" stroke="#374151" strokeWidth="1.2" strokeLinejoin="round" />
            <rect x="3.8" y="20" width="66.4" height="3" fill="#1d4ed8" />
            <rect x="3.8" y="23" width="66.4" height="2" fill="#dc2626" />
            <rect x="9" y="8" width="16" height="9" rx="1" fill="none" stroke="#9ca3af" strokeWidth="1" />
            <path d="M9 8.5 L17 13.5 L25 8.5" fill="none" stroke="#9ca3af" strokeWidth="1" />
            <rect x="69" y="26" width="3" height="3" rx="1" fill="#fbbf24" />
            <circle cx="17" cy="34" r="6" fill="#1f2937" /><circle cx="17" cy="34" r="2.4" fill="#d1d5db" />
            <circle cx="56" cy="34" r="6" fill="#1f2937" /><circle cx="56" cy="34" r="2.4" fill="#d1d5db" />
          </svg>
        </div>
        <div className="usps-road" />
      </div>
      <p className="mt-3 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{LOADING_LINES[line]}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        Building the report from Freshsales. Every Won deal in the month and its contacts are checked, so it takes a minute or two.
      </p>
    </div>
  );
}

export default function UspsReportPage() {
  const months = useMemo(monthOptions, []);
  const [month, setMonth] = useState(months[0].value);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setReport(null); setError(''); setLoading(true);
    fetch(`/api/freshsales/usps-report?month=${month}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month]);

  const inputStyle = { borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' };
  const card = { background: 'var(--surface)', borderColor: 'var(--border)' };
  const s = report?.summary;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>USPS Reporting</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Monthly affiliate report: Closed Won orders in the month from customers attributed to USPS, first orders only.
          </p>
        </div>
        <div className="flex gap-2 items-center text-sm">
          <select value={month} onChange={(e) => setMonth(e.target.value)} disabled={loading}
            className="px-3 py-2 rounded-lg border" style={inputStyle}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button onClick={() => downloadExcel(report)} disabled={!report} className="px-3 py-2 rounded-lg font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)', opacity: report ? 1 : 0.5 }}>
            Download Excel
          </button>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--status-critical)' }}>Could not build the report: {error}</p>}
      {loading && <MailTruckLoader />}

      {s && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,24rem)_1fr]">
          <div className="rounded-xl border p-4 text-sm" style={card}>
            <div className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Monthly Affiliate Report · {s.monthLabel}</div>
            <table className="w-full">
              <tbody>
                <tr><td className="py-1" style={{ color: 'var(--text-muted)' }}>Affiliate Name</td><td className="py-1 text-right" style={{ color: 'var(--text-primary)' }}>{AFFILIATE_NAME}</td></tr>
                <tr><td className="py-1" style={{ color: 'var(--text-muted)' }}>Contact Person Name</td><td className="py-1 text-right" style={{ color: 'var(--text-primary)' }}>{CONTACT_NAME}</td></tr>
                {SUMMARY_LINES.map(([label, key, f]) => (
                  <tr key={key} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1" style={{ color: key.startsWith('existing') ? 'var(--text-muted)' : 'var(--text-secondary)' }}>{label}</td>
                    <td className="py-1 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{f === '$' ? fmt$(s[key]) : fmtN(s[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border p-4 text-sm space-y-2" style={{ ...card, color: 'var(--text-secondary)' }}>
            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>How this is counted</div>
            <p>Orders are Freshsales deals in Won with a close date in {s.monthLabel}. The lead&apos;s age doesn&apos;t matter.</p>
            <p>A deal counts as USPS when USPS is its source, or the lead source of any contact on the deal or on its account.</p>
            <p>Only first orders are reported: the account&apos;s first ever Won deal closed this month. Any more orders it places in the same month count too.
              Existing USPS customers are shown for reference and aren&apos;t in the revenue totals.</p>
            <p>Revenue share is {Math.round(REV_SHARE_PCT * 100)}% of production. Total USPS Revenue is postage plus the share. Revenue and pieces come from the order&apos;s drops in Osprey.</p>
            <p style={{ color: 'var(--text-muted)' }}>Checked {fmtN(report.wonDealsInMonth)} Won deals and {fmtN(report.contactsChecked)} contacts.</p>
          </div>
        </div>
      )}

      {report && (
        <div className="rounded-xl border overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }} className="text-left">
                {['Account', 'Order', 'Closed', 'First Order', 'Type', 'Production', 'Postage', 'Pieces', 'Why USPS'].map((h, i) => (
                  <th key={h} className={`px-4 py-2 font-medium whitespace-nowrap ${i >= 5 && i <= 7 ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-6" style={{ color: 'var(--text-muted)' }}>No USPS sales in {s.monthLabel}.</td></tr>
              )}
              {report.rows.map((r) => (
                <tr key={r.dealId} className="border-t" style={{ borderColor: 'var(--border)', color: r.type === 'New' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  <td className="px-4 py-2">{r.account}</td>
                  <td className="px-4 py-2 whitespace-nowrap"><OspreyOrderLink id={r.order} /></td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmtDate(r.closed)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmtDate(r.firstOrder)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="text-xs px-2 py-0.5 rounded font-medium"
                      style={r.type === 'New' ? { background: 'var(--status-ok-bg)', color: 'var(--status-ok)' } : { background: 'var(--surface2)', color: 'var(--text-muted)' }}>
                      {r.type}
                    </span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-right" title={r.source}>{fmt$(r.production)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right">{fmt$(r.postage)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right">{fmtN(r.pieces)}</td>
                  <td className="px-4 py-2 text-xs">{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
