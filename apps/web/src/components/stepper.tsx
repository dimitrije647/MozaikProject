import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: readonly { title: string; hint?: string }[];
  current: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="space-y-1">
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.title}>
            <button
              type="button"
              disabled={!onSelect || i > current}
              onClick={() => onSelect?.(i)}
              className={cn(
                'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                active ? 'bg-cream-50 shadow-soft' : 'hover:bg-cream-200/60 disabled:hover:bg-transparent',
              )}
            >
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                  done && 'bg-ink text-cream-100',
                  active && 'bg-accent text-white',
                  !done && !active && 'bg-cream-200 text-muted',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium', !active && !done && 'text-muted')}>
                  {step.title}
                </span>
                {step.hint && <span className="block truncate text-xs text-muted">{step.hint}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-cream-200">
      <div
        className="h-full rounded-full bg-accent transition-all duration-500"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}
