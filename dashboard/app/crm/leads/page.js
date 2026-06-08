'use client';

// Placeholder — Leads sync becomes real once the contacts/leads report is
// wired into the Osprey sync. Kept as its own page so the sub-nav is stable.

export default function LeadsPage() {
  return (
    <div className="rounded-xl border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
      <p className="text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
        Leads sync — coming after the contacts report lands
      </p>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
        Once we add a contacts/leads report to the Osprey pipeline, this page will mirror Opportunities:
        aggregated by lead status, status mapping modal, push to Freshsales Leads.
      </p>
    </div>
  );
}
