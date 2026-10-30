import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  dark,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  dark?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-12 text-center',
        dark ? 'border-white/15' : 'border-cream-300 bg-cream-50/60',
        className,
      )}
    >
      <span
        className={cn(
          'mb-4 flex h-11 w-11 items-center justify-center rounded-2xl',
          dark ? 'bg-white/10 text-accent' : 'bg-cream-200 text-ink-600',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <p className={cn('text-[15px] font-semibold', dark && 'text-cream-100')}>{title}</p>
      {description && (
        <p className={cn('mt-1 max-w-sm text-sm', dark ? 'text-muted-dark' : 'text-muted')}>{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
