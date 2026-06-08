'use client';

// Placeholder — Accounts sync becomes real once the accounts report is wired
// into the Osprey sync. Kept here so the sub-nav has the slot reserved.

export default function AccountsPage() {
  return (
    <div className="rounded-xl border p-8 text-center" style={{ borderColor: 'var(--border)' }}>
      <p className="text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
        Accounts sync — coming after the accounts report lands
      </p>
      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
        Will sync customer accounts from G&L into Freshsales Sales Accounts so deals link to the right org records.
      </p>
    </div>
  );
}
