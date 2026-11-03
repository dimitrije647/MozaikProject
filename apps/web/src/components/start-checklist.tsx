'use client';

import { AlertCircle, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * "Why can't I press Start?" Every condition that keeps Start disabled is listed here, with what to do about it. There is no invisible
 * blocker: the Start button's enabled state is computed from exactly these items (the caller derives it from `items`), and the server
 * enforces the same rules (a request that skips one is refused with a clear message). Missing OPTIONAL project data never appears here.
 */

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** What to do (shown while the item is open). */
  hint?: string;
  testId?: string;
}

export function StartChecklist({ items }: { items: ChecklistItem[] }) {
  const open = items.filter((i) => !i.done);
  if (items.length === 0) return null;
  return (
    <div data-testid="start-checklist" data-ready={open.length === 0 ? 'yes' : 'no'} className={cn('rounded-xl border px-4 py-3 text-xs', open.length === 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900')}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        {open.length === 0 ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        {open.length === 0 ? 'Everything required is done: Start is enabled.' : `Before you can start (${open.length} to do):`}
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((i) => (
          <li key={i.id} data-testid={i.testId ?? `check-${i.id}`} data-state={i.done ? 'done' : 'todo'} className="flex items-start gap-2">
            {i.done ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span className={cn(i.done && 'text-ink-600 line-through decoration-emerald-400/70')}>
              <span className={cn(!i.done && 'font-medium')}>{i.label}</span>
              {!i.done && i.hint ? <span className="block font-normal">{i.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
