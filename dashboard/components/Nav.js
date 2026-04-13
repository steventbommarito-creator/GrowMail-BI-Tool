'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '../lib/supabase';

export default function Nav() {
  const pathname = usePathname();
  const supabase = createClient();

  const links = [
    { href: '/', label: 'Overview' },
    { href: '/forecast', label: 'Forecast' },
    { href: '/actuals', label: 'Actuals vs Quoted' },
  ];

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <span className="font-bold text-gray-900 text-lg">BI Dashboard</span>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`text-sm font-medium ${
              pathname === l.href
                ? 'text-blue-600 border-b-2 border-blue-600 pb-1'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {l.label}
          </Link>
        ))}
      </div>
      <button
        onClick={handleSignOut}
        className="text-sm text-gray-500 hover:text-gray-800"
      >
        Sign out
      </button>
    </nav>
  );
}
