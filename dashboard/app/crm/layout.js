'use client';

// CRM Integration shared layout. Holds the sub-nav (Overview / Integrations /
// Opportunities / Leads / Accounts). The active tab is derived from the URL
// path so deep links + browser back/forward both highlight the right tab
// without us needing any client state.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SUB_NAV = [
  { href: '/crm',                label: 'Overview' },
  { href: '/crm/integrations',   label: 'Integrations' },
  { href: '/crm/opportunities',  label: 'Opportunities' },
  { href: '/crm/leads',          label: 'Leads' },
  { href: '/crm/accounts',       label: 'Accounts' },
];

export default function CrmLayout({ children }) {
  const pathname = usePathname();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>CRM Integration</h1>
      </div>

      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {SUB_NAV.map(t => {
          // Exact match for /crm (Overview); prefix match for the rest so e.g.
          // /crm/opportunities/whatever still highlights "Opportunities".
          const active = t.href === '/crm'
            ? pathname === '/crm'
            : pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <Link key={t.href} href={t.href}
              className="px-3 py-2 text-sm font-medium"
              style={{
                color:        active ? 'var(--accent)'        : 'var(--text-secondary)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,  // overlap the container border so the active tab joins cleanly
              }}>
              {t.label}
            </Link>
          );
        })}
      </div>

      {children}
    </div>
  );
}
