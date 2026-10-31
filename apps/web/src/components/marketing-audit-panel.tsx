'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, ClipboardCheck, Loader2, Plus, Settings2, Square, X } from 'lucide-react';
import { AuditOverviewTab, FindingsTab, toRunAnalysis } from '@/components/audit-views';
import { AuditReportView } from '@/components/audit-report-view';
import { AgentsTab, CrossChecksTab } from '@/components/f1-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { usageFromEvents } from '@/lib/agent-progress';
import { keys, useAudit, useAuditAnalysis, useAudits, useCancelRun, useOpenAiStatus, useProjectRuns, useReports, useRunEvents, useStartAudit } from '@/lib/hooks';
import type { RunStatus, SocialDetailInput } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const RUN_STATUS: Record<RunStatus | 'NONE', { label: string; className: string }> = {
  NONE: { label: 'Not run yet', className: 'bg-cream-200 text-ink-600' },
  RUNNING: { label: 'Running', className: 'bg-accent-soft text-accent-hover' },
  COMPLETED: { label: 'Completed', className: 'bg-emerald-100 text-emerald-800' },
  FAILED: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelled', className: 'bg-cream-300 text-ink-600' },
  INTERRUPTED: { label: 'Interrupted', className: 'bg-amber-100 text-amber-800' },
};

const TABS = ['Overview', 'Agents', 'Findings', 'Cross-Checks', 'Report'] as const;
type Tab = (typeof TABS)[number];
const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x', 'youtube', 'tiktok', 'pinterest', 'reddit'];

const DEFAULT_CALLS = 14;
const DEFAULT_TOKENS = 2500;
const DEFAULT_REVIEWS = 4;

/** F2 Marketing Audit: six Mozaik agents audit the CURRENT marketing state on top of a completed F1 report. Diagnostic only. */
export function MarketingAuditPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const openai = useOpenAiStatus();
  const runs = useProjectRuns(projectId);
  const f1Reports = useReports(projectId);
  const audits = useAudits(projectId);
  const start = useStartAudit(projectId);
  const cancel = useCancelRun(projectId);

  const auditRuns = runs.data?.filter((r) => r.mode === 'marketing_audit') ?? [];
  const latest = auditRuns[0];
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const shown = auditRuns.find((r) => r.id === selectedRunId) ?? latest;
  const running = latest?.status === 'RUNNING';
  const events = useRunEvents(shown?.id, shown?.status);
  const analysis = useAuditAnalysis(shown?.id, shown?.status);
  const auditId = shown?.auditId ?? audits.data?.find((a) => a.runId === shown?.id)?.id ?? null;
  const audit = useAudit(auditId);

  const eligible = (f1Reports.data ?? []).filter((r) => r.schemaVersion >= 2);
  const [f1Id, setF1Id] = React.useState<string | null>(null);
  const selectedF1 = eligible.find((r) => r.id === f1Id) ?? eligible[0];

  const [maxCalls, setMaxCalls] = React.useState(DEFAULT_CALLS);
  const [maxTokens, setMaxTokens] = React.useState(DEFAULT_TOKENS);
  const [maxReviews, setMaxReviews] = React.useState(DEFAULT_REVIEWS);
  const [details, setDetails] = React.useState<SocialDetailInput[]>([]);
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [showLog, setShowLog] = React.useState(false);

  React.useEffect(() => {
    if (latest && latest.status !== 'RUNNING') {
      qc.invalidateQueries({ queryKey: keys.audits(projectId) });
    }
  }, [latest?.id, latest?.status, projectId, qc]);

  const status = openai.data;
  const configured = !!status?.configured;
  const hasModel = !!status?.model;
  const canRun = configured && hasModel && !running && !!selectedF1;
  const usage = usageFromEvents(events.data ?? []);
  const badge = RUN_STATUS[shown?.status ?? 'NONE'];
  const view = toRunAnalysis(analysis.data);

  function begin() {
    const ok = window.confirm(
      `Run the Marketing Audit with OpenAI model "${status?.model}"?\n\nThis uses YOUR OpenAI API credits: at most ${maxCalls} model calls (a typical audit needs about 8-10; agents without input make none), each capped at ${maxTokens} output tokens, up to ${maxReviews} cross-check reviews.\n\nIt also fetches your website and, if keys are configured, calls PageSpeed Insights / YouTube. The limits are enforced locally and are not an OpenAI spending cap.`,
    );
    if (!ok) return;
    setSelectedRunId(null);
    setTab('Agents');
    start.mutate(
      {
        f1ReportId: selectedF1?.id,
        maxModelCalls: maxCalls,
        maxOutputTokens: maxTokens,
        maxReviews,
        socialDetails: details.filter((d) => d.bio?.trim() || d.followers != null || d.postsPerMonth != null).map((d) => ({ ...d, bio: d.bio?.trim() || undefined })),
      },
      { onError: (e) => toast.error(e.message) },
    );
  }

  return (
    <Card>
      <CardHeader className="items-center">
        <div>
          <CardTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent">
              <ClipboardCheck className="h-4 w-4" />
            </span>
            Marketing Audit
          </CardTitle>
          <CardDescription>
            Six Mozaik agents (SEO, Social Media, Brand, Messaging, Presence and an Audit Synthesizer) audit your current marketing on top of a completed Product Discovery report. Diagnostic only: no ads, strategy or copy.
          </CardDescription>
        </div>
        <Badge className={cn(badge.className)}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {badge.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Prerequisite + run controls */}
        <div className="rounded-2xl bg-cream-100 p-4">
          {f1Reports.isLoading ? (
            <div className="h-10 animate-pulse rounded-lg bg-cream-200" />
          ) : eligible.length === 0 ? (
            <p role="status" className="flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Prerequisite missing: the Marketing Audit needs a completed Product Discovery (F1) report. Run Product Discovery above first. No substitute report is ever made up.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-muted">Built on F1 report</span>
                <select aria-label="F1 report" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={selectedF1?.id ?? ''} onChange={(e) => setF1Id(e.target.value)}>
                  {eligible.map((r, i) => (
                    <option key={r.id} value={r.id}>
                      {formatDate(r.createdAt)} · {r.model}
                      {r.partial ? ' · partial' : ''}
                      {i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                <span className="text-muted">Model </span>
                <strong className="font-mono">{status?.model ?? 'none selected'}</strong>
              </span>
              <Button asChild size="sm" variant="ghost" className="ml-auto">
                <Link href="/settings/providers">
                  <Settings2 className="h-3.5 w-3.5" /> AI provider settings
                </Link>
              </Button>
            </div>
          )}
          {!openai.isLoading && !configured && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Add your OpenAI API key in Settings &gt; AI providers to run the audit.
            </p>
          )}
          {configured && !hasModel && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Choose a model in Settings &gt; AI providers. LaunchPilot never picks or switches models for you.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-start gap-3">
            <Button onClick={begin} loading={start.isPending} disabled={!canRun}>
              <ClipboardCheck className="h-4 w-4" /> Start Marketing Audit
            </Button>
            {running && latest && (
              <Button variant="outline" loading={cancel.isPending} onClick={() => cancel.mutate(latest.id, { onError: (e) => toast.error(e.message) })}>
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">Cost limits and social details</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs text-muted">
                  Max model calls (3 to 30)
                  <Input type="number" min={3} max={30} value={maxCalls} onChange={(e) => setMaxCalls(clampNum(e.target.value, 3, 30, DEFAULT_CALLS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max cross-check reviews (0 to 8)
                  <Input type="number" min={0} max={8} value={maxReviews} onChange={(e) => setMaxReviews(clampNum(e.target.value, 0, 8, DEFAULT_REVIEWS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max output tokens per call
                  <Input type="number" min={800} max={6000} step={100} value={maxTokens} onChange={(e) => setMaxTokens(clampNum(e.target.value, 800, 6000, DEFAULT_TOKENS))} />
                </label>
              </div>
              <p className="mt-2 max-w-xl text-xs text-muted">Enforced by LaunchPilot per run, not an OpenAI spending cap. Token counts are measured; no price is shown.</p>

              <p className="mt-4 text-xs font-medium text-ink-600">Social profile details you can provide (optional)</p>
              <p className="max-w-xl text-xs text-muted">Social platforms are never scraped and most have no live adapter here. What you type below is used as “user provided” data: it is never labeled verified.</p>
              <ul className="mt-2 space-y-2">
                {details.map((d, i) => (
                  <li key={i} className="grid items-end gap-2 sm:grid-cols-[8rem_1fr_7rem_auto]">
                    <select aria-label="Platform" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-xs" value={d.platform} onChange={(e) => setDetails(details.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))}>
                      {PLATFORMS.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                    <Input aria-label="Profile description" placeholder="Bio / description as it appears" maxLength={600} value={d.bio ?? ''} onChange={(e) => setDetails(details.map((x, j) => (j === i ? { ...x, bio: e.target.value } : x)))} />
                    <Input aria-label="Followers" type="number" min={0} placeholder="Followers" value={d.followers ?? ''} onChange={(e) => setDetails(details.map((x, j) => (j === i ? { ...x, followers: e.target.value === '' ? undefined : clampNum(e.target.value, 0, 1_000_000_000, 0) } : x)))} />
                    <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={() => setDetails(details.filter((_, j) => j !== i))}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              {details.length < 4 && (
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setDetails([...details, { platform: 'instagram' }])}>
                  <Plus className="h-3.5 w-3.5" /> Add profile details
                </Button>
              )}
            </details>
          </div>
        </div>

        {/* Previous audits */}
        {auditRuns.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Audit
            <select aria-label="Previous audits" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={shown?.id ?? ''} onChange={(e) => setSelectedRunId(e.target.value)}>
              {auditRuns.map((r, i) => (
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
              Started {formatDate(shown.startedAt)} · {usage.calls} model call{usage.calls === 1 ? '' : 's'} · {usage.totalTokens.toLocaleString()} tokens ({usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out), measured. Everything below is read from the saved run history.
            </p>
            {shown.errorMessage && (
              <p role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {shown.errorMessage}
              </p>
            )}
          </div>
        )}

        {shown ? (
          <>
            <div role="tablist" aria-label="Marketing Audit" className="flex flex-wrap gap-1 border-b border-cream-300/80">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
                  {t}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'Overview' && <AuditOverviewTab analysis={analysis.data} />}
              {tab === 'Agents' && <AgentsTab analysis={view} events={events.data ?? []} />}
              {tab === 'Findings' && <FindingsTab analysis={analysis.data} />}
              {tab === 'Cross-Checks' && <CrossChecksTab analysis={view} />}
              {tab === 'Report' &&
                (audit.isLoading ? (
                  <div className="h-40 animate-pulse rounded-2xl bg-cream-200" />
                ) : audit.data ? (
                  <AuditReportView data={audit.data} />
                ) : (
                  <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
                    <p className="text-sm font-medium">{shown.status === 'RUNNING' ? 'The report appears when the audit finishes' : 'No report for this run'}</p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted">Finished audits are saved and stay available after you refresh or restart the app.</p>
                  </div>
                ))}
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
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
            <p className="text-sm font-medium">No audit yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted">Press “Start Marketing Audit” to run the agents. Nothing runs automatically.</p>
          </div>
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
