import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Two-column settings block: title/description on the left, controls on the right. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="grid gap-6 p-6 md:grid-cols-[240px_1fr] md:gap-10">
        <div>
          <h3 className="font-sans text-[15px] font-semibold">{title}</h3>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        <div className="space-y-5">{children}</div>
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t border-cream-300/80 bg-cream-100/60 px-6 py-3.5">
          {footer}
        </div>
      )}
    </Card>
  );
}
