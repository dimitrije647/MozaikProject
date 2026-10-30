import { Badge } from '@/components/ui/badge';
import { PROJECT_STATUS } from '@/lib/constants';
import type { ProjectStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const s = PROJECT_STATUS[status];
  return (
    <Badge className={cn(s.className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {s.label}
    </Badge>
  );
}
