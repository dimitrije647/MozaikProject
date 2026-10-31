'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Loader2, Microscope, Settings2, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { ReportView } from '@/components/report-view';
import { AgentsTab, CrossChecksTab, EvidenceTab, OverviewTab } from '@/components/f1-views';
import { usageFromEvents } from '@/lib/agent-progress';
import { keys, useCancelRun, useOpenAiStatus, useProjectRuns, useReport, useReports, useRunAnalysis, useRunEvents, useStartDiscovery } from '@/lib/hooks';
import type { RunStatus } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const RUN_STATUS: Record<RunStatus | 'NONE', { label: string; className: string }> = {
  NONE: { label: 'Not run yet', className: 'bg-cream-200 text-ink-600' },
  RUNNING: { label: 'Running', className: 'bg-accent-soft text-accent-hover' },
  COMPLETED: { label: 'Completed', className: 'bg-emerald-100 text-emerald-800' },
  FAILED: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelled', className: 'bg-cream-300 text-ink-600' },
  INTERRUPTED: { label: 'Interrupted', className: 'bg-amber-100 text-amber-800' },
};

const TABS = ['Overview', 'Agents', 'Evidence', 'Cross-Checks', 'Report'] as const;
type Tab = (typeof TABS)[number];

const DEFAULT_CALLS = 16;
const DEFAULT_TOKENS = 3000;
const DEFAULT_REVIEWS = 4;

/** Product Discovery (F1): seven real Mozaik agents on the user's own OpenAI key. */
export function ProductDiscoveryPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const openai = useOpenAiStatus();
  const runs = useProjectRuns(projectId);
  const latest = runs.data?.find((r) => r.mode === 'product_discovery');
  const running = latest?.status === 'RUNNING';
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const shown = runs.data?.find((r) => r.id === selectedRunId) ?? latest;
  const events = useRunEvents(shown?.id, shown?.status);
  const analysis = useRunAnalysis(shown?.id, shown?.status);
  const reports = useReports(projectId);
  const start = useStartDiscovery(projectId);
  const cancel = useCancelRun(projectId);

  const [maxCalls, setMaxCalls] = React.useState(DEFAULT_CALLS);
  const [maxTokens, setMaxTokens] = React.useState(DEFAULT_TOKENS);
  const [maxReviews, setMaxReviews] = React.useState(DEFAULT_REVIEWS);
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [selectedReportId, setSelectedReportId] = React.useState<string | null>(null);
  const [showLog, setShowLog] = React.useState(false);

  // A finished run may have produced a report: refresh the list once its status leaves RUNNING.
  React.useEffect(() => {
    if (latest && latest.status !== 'RUNNING') qc.invalidateQueries({ queryKey: keys.reports(projectId) });
  }, [latest?.id, latest?.status, projectId, qc]);

  const activeReportId = selectedReportId ?? reports.data?.[0]?.id ?? null;
  const report = useReport(activeReportId);

  const status = openai.data;
  const configured = !!status?.configured;
  const hasModel = !!status?.model;
  const canRun = configured && hasModel && !running;
  const usage = usageFromEvents(events.data ?? []);
  const badge = RUN_STATUS[shown?.status ?? 'NONE'];

  function analyze() {
    const ok = window.confirm(
      `Analyze this idea with OpenAI model "${status?.model}"?\n\n` +
        `This uses YOUR OpenAI API credits. LaunchPilot will make at most ${maxCalls} model calls (a text-only idea needs about 5; each extra source adds one analysis), ` +
        `each capped at ${maxTokens} output tokens.\n\nThe limits are enforced locally and are not an OpenAI spending cap.`,
    );
    if (!ok) return;
    setSelectedReportId(null);
    setSelectedRunId(null);
    setTab('Agents');
    start.mutate({ maxModelCalls: maxCalls, maxOutputTokens: maxTokens, maxReviews }, { onError: (e) => toast.error(e.message) });
  }

  return (
    <Card>
      <CardHeader className="items-center">
        <div>
          <CardTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent">
              <Microscope className="h-4 w-4" />
            </span>
            Product Discovery: AI Analysis
          </CardTitle>
          <CardDescription>
            Up to seven Mozaik agents read your idea, website, public GitHub repository, uploaded documents and images, check each other's claims and write an evidence-aware report. Agents without input are skipped. Social profiles are listed but not read.
          </CardDescription>
        </div>
        <Badge className={cn(badge.className)}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {badge.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Provider / model + run controls */}
        <div className="rounded-2xl bg-cream-100 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>
              <span className="text-muted">Provider </span>
              <strong>OpenAI</strong>
            </span>
            <span>
              <span className="text-muted">Model </span>
              <strong className="font-mono">{status?.model ?? 'none selected'}</strong>
            </span>
            {configured && hasModel && (
              <Badge className={status?.ready ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>
                {status?.ready ? 'Connection verified' : 'Not verified'}
              </Badge>
            )}
            <Button asChild size="sm" variant="ghost" className="ml-auto">
              <Link href="/settings/providers">
                <Settings2 className="h-3.5 w-3.5" /> AI provider settings
              </Link>
            </Button>
          </div>

          {!openai.isLoading && !configured && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Add your OpenAI API key in Settings &gt; AI providers to run the analysis.
            </p>
          )}
          {configured && !hasModel && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Choose a model in Settings &gt; AI providers. LaunchPilot never picks or switches models for you.
            </p>
          )}
          {configured && hasModel && !status?.ready && (
            <p className="mt-3 text-xs text-muted">Tip: press “Test connection” in settings first to confirm this key can use this model before spending credits on a full analysis.</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={analyze} loading={start.isPending} disabled={!canRun}>
              <Microscope className="h-4 w-4" /> Analyze Idea
            </Button>
            {running && latest && (
              <Button variant="outline" loading={cancel.isPending} onClick={() => cancel.mutate(latest.id, { onError: (e) => toast.error(e.message) })}>
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">Cost limits</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted">
                  Max model calls (3 to 40)
                  <Input type="number" min={3} max={40} value={maxCalls} onChange={(e) => setMaxCalls(clampNum(e.target.value, 3, 40, DEFAULT_CALLS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max cross-check reviews (0 to 8)
                  <Input type="number" min={0} max={8} value={maxReviews} onChange={(e) => setMaxReviews(clampNum(e.target.value, 0, 8, DEFAULT_REVIEWS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max output tokens per call (800 to 8000)
                  <Input type="number" min={800} max={8000} step={100} value={maxTokens} onChange={(e) => setMaxTokens(clampNum(e.target.value, 800, 8000, DEFAULT_TOKENS))} />
                </label>
              </div>
              <p className="mt-2 max-w-md text-xs text-muted">Enforced by LaunchPilot per run. This is not an OpenAI account spending cap; set one on platform.openai.com too.</p>
            </details>
          </div>
        </div>

        {/* Previous analyses */}
        {(runs.data?.filter((r) => r.mode === 'product_discovery').length ?? 0) > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Analysis
            <select
              aria-label="Previous analyses"
              className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink"
              value={shown?.id ?? ''}
              onChange={(e) => {
                setSelectedRunId(e.target.value);
                const rr = runs.data?.find((r) => r.id === e.target.value);
                setSelectedReportId(rr?.reportId ?? null);
              }}
            >
              {runs.data!.filter((r) => r.mode === 'product_discovery').map((r, i) => (
                <option key={r.id} value={r.id}>
                  {formatDate(r.startedAt)} · {r.status.toLowerCase()}
                  {i === 0 ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {shown && (
          <div>
            <p className="mb-3 text-xs text-muted">
              Started {formatDate(shown.startedAt)} · {usage.calls} model call{usage.calls === 1 ? '' : 's'} · {usage.totalTokens.toLocaleString()} tokens ({usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out). Everything below is read from the saved run history.
            </p>
            {shown.errorMessage && (
              <p role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {shown.errorMessage}
              </p>
            )}
          </div>
        )}

        <div role="tablist" aria-label="Product Discovery" className="flex flex-wrap gap-1 border-b border-cream-300/80">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}
            >
              {t}
            </button>
          ))}
        </div>

        <div role="tabpanel">
          {tab === 'Overview' && <OverviewTab analysis={analysis.data} />}
          {tab === 'Agents' && <AgentsTab analysis={analysis.data} events={events.data ?? []} />}
          {tab === 'Evidence' && <EvidenceTab analysis={analysis.data} />}
          {tab === 'Cross-Checks' && <CrossChecksTab analysis={analysis.data} />}
          {tab === 'Report' && (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h4 className="font-sans text-sm font-semibold">Report</h4>
                {(reports.data?.length ?? 0) > 1 && (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Previous reports
                    <select
                      className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink"
                      value={activeReportId ?? ''}
                      onChange={(e) => setSelectedReportId(e.target.value)}
                    >
                      {reports.data!.map((r, i) => (
                        <option key={r.id} value={r.id}>
                          {formatDate(r.createdAt)} · {r.model}
                          {r.partial ? ' · partial' : ''}
                          {i === 0 ? ' (latest)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {reports.isLoading || (activeReportId && report.isLoading) ? (
                <div className="h-40 animate-pulse rounded-2xl bg-cream-200" />
              ) : report.data ? (
                <ReportView data={report.data} />
              ) : (
                <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
                  <p className="text-sm font-medium">No report yet</p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-muted">Press “Analyze Idea” to run the agents. The finished report is saved and stays available after you refresh or restart the app.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <button onClick={() => setShowLog((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:text-ink">
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showLog && 'rotate-180')} />
          {showLog ? 'Hide' : 'Show'} event log ({events.data?.length ?? 0})
        </button>
        {showLog && (
          <ol className="max-h-64 space-y-1 overflow-auto rounded-xl bg-cream-100/70 p-3 font-mono text-[11px]">
            {(events.data ?? []).map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-6 shrink-0 text-muted">{e.sequence}</span>
                <span>{e.eventType}</span>
                <span className="truncate text-muted">{e.participant}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function clampNum(raw: string, min: number, max: number, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}
