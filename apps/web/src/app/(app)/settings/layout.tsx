'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SectionHeader } from '@/components/section-header';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/providers', label: 'AI providers' },
  { href: '/settings/billing', label: 'Billing' },
  { href: '/settings/appearance', label: 'Appearance' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Settings" title="Settings" description="Manage your profile, security, integrations and AI providers." />
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-cream-300/80 px-1 pb-px">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                active ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
