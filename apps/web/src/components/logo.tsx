import Link from 'next/link';
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-xl bg-ink text-accent shadow-soft',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden>
        <path d="M12 2c3.2 2.4 5 5.7 5 9.2 0 1.4-.3 2.7-.8 3.8L19 18l-3.3.6L12 22l-3.7-3.4L5 18l2.8-3c-.5-1.1-.8-2.4-.8-3.8C7 7.7 8.800 4.400 12 2Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
      </svg>
    </span>
  );
}

export function Logo({ href = '/', dark = false }: { href?: string; dark?: boolean }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2.5">
      <LogoMark className={dark ? 'bg-cream-100 text-accent' : undefined} />
      <span className={cn('font-serif text-xl tracking-tight', dark ? 'text-cream-100' : 'text-ink')}>
        LaunchPilot
      </span>
    </Link>
  );
}
