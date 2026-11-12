'use client';

import { Badge } from '@/components/ui/badge';
import type { LibraryProvider } from '@/lib/images';
import { cn } from '@/lib/utils';

/** Which licensed providers are configured on this server and what to do about the ones that are not. A "paid" provider bills per request and is used only when the user allowed it. */
export function ProviderList({ providers, testId = 'image-providers' }: { providers: LibraryProvider[]; testId?: string }) {
  if (providers.length === 0) return <p className="text-xs text-muted">No image provider is known to this server.</p>;
  return (
    <ul data-testid={testId} className="space-y-1 text-xs">
      {providers.map((p) => (
        <li key={p.id} data-provider={p.id} data-configured={p.configured ? 'yes' : 'no'} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="text-ink">{p.label}</strong>
          <Badge className={cn('px-2 py-0.5 text-[10px]', p.kind === 'licensed' ? 'bg-sky-100 text-sky-800' : 'bg-cream-200 text-ink-600')}>{p.kind === 'licensed' ? 'licensed' : 'reference only'}</Badge>
          {p.paid && <Badge className="bg-amber-100 px-2 py-0.5 text-[10px] text-amber-900">paid: bills per request</Badge>}
          <span className={p.configured ? 'text-emerald-800' : 'text-muted'}>{p.configured ? 'configured' : `not configured${p.setup ? ` — ${p.setup}` : ''}`}</span>
        </li>
      ))}
    </ul>
  );
}
