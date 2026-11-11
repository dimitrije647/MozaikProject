'use client';

import { AlertCircle, Check, Info } from 'lucide-react';
import type { InputReadinessData } from '@/lib/types';
import { cn } from '@/lib/utils';

/*
 * What LaunchPilot knows about the project and what it does about the rest. The server classifies the data (required / recommended / optional);
 * this component only displays it. Only a missing REQUIRED item can stop a campaign; everything else is advice with the fallback that is applied.
 */
export function InputReadinessCard({ inputs }: { inputs: InputReadinessData }) {
  const required = inputs.checks.filter((c) => c.level === 'required');
  const recommended = inputs.checks.filter((c) => c.level === 'recommended');
  const optional = inputs.checks.filter((c) => c.level === 'optional');
  const missingRec = recommended.filter((c) => !c.present);
  const missingOpt = optional.filter((c) => !c.present);
  return (
    <section data-testid="input-readiness" aria-label="Project information" className="space-y-3 rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Project information</p>
        <p className="text-[11px] text-muted">
          Required {inputs.counts.required.present}/{inputs.counts.required.total} · recommended {inputs.counts.recommended.present}/{inputs.counts.recommended.total} · optional {inputs.counts.optional.present}/{inputs.counts.optional.total}
        </p>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {required.map((c) => (
          <li key={c.id} data-testid={`input-${c.id}`} data-present={c.present ? 'yes' : 'no'} className={cn('flex items-start gap-2', c.present ? 'text-emerald-800' : 'text-red-700')}>
            {c.present ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              <strong>{c.label}</strong> (required){c.present ? '' : `: ${c.whenMissing}`}
            </span>
          </li>
        ))}
      </ul>
      {missingRec.length > 0 && (
        <ul data-testid="input-warnings" className="space-y-1 text-amber-900">
          {missingRec.map((c) => (
            <li key={c.id} data-testid={`input-${c.id}`} data-present="no" className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {c.whenMissing}
            </li>
          ))}
        </ul>
      )}
      {missingOpt.length > 0 && (
        <details data-testid="input-notes" className="text-muted">
          <summary className="flex cursor-pointer select-none items-center gap-1.5">
            <Info className="h-3.5 w-3.5" /> {missingOpt.length} optional item{missingOpt.length === 1 ? '' : 's'} not provided (nothing is blocked)
          </summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {missingOpt.map((c) => (
              <li key={c.id} data-testid={`input-${c.id}`} data-present="no">
                {c.whenMissing}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-[11px] text-muted">Missing recommended or optional information lowers the confidence of some analyses, never the honesty of the result: whatever the AI proposes in its place is labelled as an assumption, and nothing is invented.</p>
    </section>
  );
}
