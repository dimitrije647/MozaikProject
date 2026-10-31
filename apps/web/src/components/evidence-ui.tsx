'use client';

import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { EvidenceStatus, Statement } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const EVIDENCE: Record<EvidenceStatus, { label: string; className: string; hint: string }> = {
  verified: { label: 'Verified', className: 'bg-emerald-100 text-emerald-800', hint: 'Confirmed against a live source retrieved during this run (the website or the repository), with a verbatim excerpt.' },
  claimed: { label: 'Claimed', className: 'bg-amber-100 text-amber-800', hint: 'Stated by you in the input. Not independently verified.' },
  inferred: { label: 'Inferred', className: 'bg-indigo-100 text-indigo-800', hint: 'An AI conclusion drawn from what you supplied.' },
  disputed: { label: 'Disputed', className: 'bg-red-100 text-red-700', hint: 'Conflicting information was found.' },
  unknown: { label: 'Unknown', className: 'bg-cream-200 text-ink-600', hint: 'Cannot be determined from the supplied text.' },
};

export function EvidenceBadge({ status }: { status: EvidenceStatus }) {
  const e = EVIDENCE[status] ?? EVIDENCE.unknown;
  return (
    <Badge className={cn('shrink-0', e.className)} title={e.hint}>
      {e.label}
    </Badge>
  );
}

export function EvidenceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-cream-100 px-4 py-3 text-xs text-muted">
      <span className="font-medium text-ink-600">How to read the labels:</span>
      {(['verified', 'claimed', 'inferred', 'disputed', 'unknown'] as EvidenceStatus[]).map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <EvidenceBadge status={s} /> {EVIDENCE[s].hint}
        </span>
      ))}
    </div>
  );
}

export function Section({ title, icon: Icon, children, className }: { title: string; icon: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-cream-300/80 bg-cream-50 p-5', className)}>
      <h3 className="mb-3 flex items-center gap-2 font-sans text-[15px] font-semibold">
        <Icon className="h-4 w-4 text-accent" /> {title}
      </h3>
      {children}
    </section>
  );
}

export function Statements({ items, empty = 'Nothing identified from the supplied text.' }: { items: Statement[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-3 text-sm">
          <EvidenceBadge status={s.status} />
          <span className="min-w-0">
            <span className="block">{s.text}</span>
            {s.basis && <span className="block text-xs text-muted">Basis: {s.basis}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm marker:text-accent">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

