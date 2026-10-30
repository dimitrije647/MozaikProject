'use client';

import { CheckCircle2, CircleDashed, Loader2, Play, Square, TriangleAlert, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useCancelRun, useProjectRuns, useRunEvents, useStartSmokeTest } from '@/lib/hooks';
import type { RunStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS: Record<RunStatus | 'NONE', { label: string; className: string }> = {
  NONE: { label: 'Not tested', className: 'bg-cream-200 text-ink-600' },
  RUNNING: { label: 'Running', className: 'bg-accent-soft text-accent-hover' },
  COMPLETED: { label: 'Passed', className: 'bg-emerald-100 text-emerald-800' },
  FAILED: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelled', className: 'bg-cream-300 text-ink-600' },
  INTERRUPTED: { label: 'Interrupted', className: 'bg-amber-100 text-amber-800' },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Developer-facing check that API <-> Mozaik runtime <-> PostgreSQL are wired up.
 * It runs a deterministic participant: no AI model is called and no campaign content is generated.
 */
export function RuntimeTestPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const runs = useProjectRuns(projectId);
  const latest = runs.data?.[0];
  const running = latest?.status === 'RUNNING';
  const events = useRunEvents(latest?.id, latest?.status);
  const start = useStartSmokeTest(projectId);
  const cancel = useCancelRun(projectId);
  const status = STATUS[latest?.status ?? 'NONE'];

  return (
    <Card>
      <CardHeader className="items-center">
        <div>
          <CardTitle className="flex items-center gap-2.5">
            Mozaik Runtime: Infrastructure
            <Badge className="bg-ink text-cream-100">Developer</Badge>
          </CardTitle>
          <CardDescription>
            Checks that the API, the Mozaik runtime and the database are connected. It does not run agents or generate any
            campaign content.
          </CardDescription>
        </div>
        <Badge className={cn(status.className)}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {status.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={() =>
              start.mutate(undefined, {
                onError: (e) => toast.error(e.message),
              })
            }
            loading={start.isPending}
            disabled={running}
          >
            <Play className="h-3.5 w-3.5" /> Run Infrastructure Test
          </Button>
          {running && latest && (
            <Button
              size="sm"
              variant="outline"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(latest.id, { onError: (e) => toast.error(e.message) })}
            >
              <Square className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {latest && (
            <dl className="ml-auto flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
              <div>
                <dt className="inline">Run ID: </dt>
                <dd className="inline font-mono text-ink-600">{latest.id}</dd>
              </div>
              <div>
                <dt className="inline">Started: </dt>
                <dd className="inline text-ink-600">{time(latest.startedAt)}</dd>
              </div>
              {latest.completedAt && (
                <div>
                  <dt className="inline">Finished: </dt>
                  <dd className="inline text-ink-600">{time(latest.completedAt)}</dd>
                </div>
              )}
            </dl>
          )}
        </div>

        {latest?.errorMessage && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {latest.errorMessage}
          </p>
        )}
        {runs.isError && <p className="text-sm text-red-600">Could not load runs: {runs.error.message}</p>}

        {!latest ? (
          <p className="text-sm text-muted">No test has been run for this project yet.</p>
        ) : (
          <ol className="space-y-1.5" aria-label="Event timeline">
            {(events.data ?? []).map((e) => {
              const infra = e.eventType.startsWith('participant.');
              return (
                <li key={e.id} className="flex items-center gap-3 rounded-lg bg-cream-100/70 px-3 py-2 text-sm">
                  {e.eventType === 'factory.failed' ? (
                    <XCircle className="h-4 w-4 shrink-0 text-red-600" />
                  ) : e.eventType === 'factory.completed' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <CircleDashed className={cn('h-4 w-4 shrink-0', infra ? 'text-muted-dark' : 'text-accent')} />
                  )}
                  <span className={cn('font-mono text-xs', infra && 'text-muted')}>{e.eventType}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">{e.participant ?? ''}</span>
                  <span className="font-mono text-[11px] text-muted">{time(e.createdAt)}</span>
                </li>
              );
            })}
            {running && (
              <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the next event…
              </li>
            )}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
