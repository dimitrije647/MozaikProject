'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, Compass, Loader2, Settings2, Square } from 'lucide-react';
import { AgentsTab, CrossChecksTab } from '@/components/f1-views';
import { StrategyReportView } from '@/components/strategy-report-view';
import { AudienceTab, ChannelsTab, CompetitorsTab, StrategyOverviewTab, toRunAnalysis } from '@/components/strategy-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { usageFromEvents } from '@/lib/agent-progress';
import { keys, useAudits, useCancelRun, useOpenAiStatus, useProjectRuns, useReports, useRunEvents, useStartStrategy, useStrategies, useStrategy, useStrategyAnalysis } from '@/lib/hooks';
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

const TABS = ['Overview', 'Agents', 'Audience', 'Competitors', 'Channels', 'Cross-Checks', 'Strategy'] as const;
type Tab = (typeof TABS)[number];

const DEFAULT_CALLS = 24;
const DEFAULT_SCOUTS = 4;
const DEFAULT_REVIEWS = 6;
const DEFAULT_TOKENS = 2500;

/** F3 Market Research & Strategy: three researchers, then Channel Scouts created at run time, then the Campaign Strategist. */
export function MarketStrategyPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const openai = useOpenAiStatus();
  const runs = useProjectRuns(projectId);
  const f1Reports = useReports(projectId);
  const audits = useAudits(projectId);
  const strategies = useStrategies(projectId);
  const start = useStartStrategy(projectId);
  const cancel = useCancelRun(projectId);

  const stratRuns = runs.data?.filter((r) => r.mode === 'market_strategy') ?? [];
  const latest = stratRuns[0];
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const shown = stratRuns.find((r) => r.id === selectedRunId) ?? latest;
  const running = latest?.status === 'RUNNING';
  const events = useRunEvents(shown?.id, shown?.status);
  const analysis = useStrategyAnalysis(shown?.id, shown?.status);
  const strategyId = shown?.strategyId ?? strategies.data?.find((s) => s.runId === shown?.id)?.id ?? null;
  const strategy = useStrategy(strategyId);

  const eligible = audits.data ?? [];
  const [auditId, setAuditId] = React.useState<string | null>(null);
  const selectedAudit = eligible.find((a) => a.id === auditId) ?? eligible[0];
  const f1Ref = f1Reports.data?.find((r) => r.id === selectedAudit?.f1ReportId);

  const [maxCalls, setMaxCalls] = React.useState(DEFAULT_CALLS);
  const [maxScouts, setMaxScouts] = React.useState(DEFAULT_SCOUTS);
  const [maxReviews, setMaxReviews] = React.useState(DEFAULT_REVIEWS);
  const [maxTokens, setMaxTokens] = React.useState(DEFAULT_TOKENS);
  const [competitors, setCompetitors] = React.useState('');
  const [competitorNames, setCompetitorNames] = React.useState('');
  const [goal, setGoal] = React.useState('');
  const [calendar, setCalendar] = React.useState<'project' | 'yes' | 'no'>('project');
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [showLog, setShowLog] = React.useState(false);

  React.useEffect(() => {
    if (latest && latest.status !== 'RUNNING') qc.invalidateQueries({ queryKey: keys.strategies(projectId) });
  }, [latest?.id, latest?.status, projectId, qc]);

  const status = openai.data;
  const configured = !!status?.configured;
  const hasModel = !!status?.model;
  const canRun = configured && hasModel && !running && !!selectedAudit;
  const usage = usageFromEvents(events.data ?? []);
  const badge = RUN_STATUS[shown?.status ?? 'NONE'];
  const view = toRunAnalysis(analysis.data);
  const urls = competitors.split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const names = competitorNames.split(/\n/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 5);

  function begin() {
    const ok = window.confirm(
      `Run Market Research & Strategy with OpenAI model "${status?.model}"?\n\nThis uses YOUR OpenAI API credits: at most ${maxCalls} model calls (a typical run needs about 12-16), up to ${maxScouts} Channel Scouts created at run time and ${maxReviews} cross-check reviews, each call capped at ${maxTokens} output tokens.\n\nIt may also fetch competitor websites and, if configured, call a search provider or the public holiday calendar. The limits are enforced locally and are not an OpenAI spending cap.`,
    );
    if (!ok) return;
    setSelectedRunId(null);
    setTab('Overview');
    start.mutate(
      {
        auditId: selectedAudit?.id,
        maxModelCalls: maxCalls,
        maxScouts,
        maxReviews,
        maxOutputTokens: maxTokens,
        competitorUrls: urls.length ? urls : undefined,
        competitorNames: names.length ? names : undefined,
        goal: goal.trim() || undefined,
        useHolidayCalendar: calendar === 'project' ? undefined : calendar === 'yes',
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
              <Compass className="h-4 w-4" />
            </span>
            F3 · Market Research &amp; Strategy
          </CardTitle>
          <CardDescription>
            An Audience Researcher, Competitor Researcher and Seasonal Intelligence work first. Then the coordinator creates only the Channel Scouts your project needs, they challenge each other's findings, and the Campaign Strategist writes the strategy and the creative brief for the next phase. No ads, copy or images are produced.
          </CardDescription>
        </div>
        <Badge className={cn(badge.className)}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {badge.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="rounded-2xl bg-cream-100 p-4">
          {audits.isLoading || f1Reports.isLoading ? (
            <div className="h-10 animate-pulse rounded-lg bg-cream-200" />
          ) : eligible.length === 0 ? (
            <p role="status" className="flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Prerequisite missing: F3 needs a completed Product Discovery (F1) report and a completed Marketing Audit (F2). {(f1Reports.data?.length ?? 0) === 0 ? 'Run Product Discovery first, then the Marketing Audit.' : 'Run the Marketing Audit first.'} Nothing is made up in their place.
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="flex items-center gap-2">
                  <span className="text-muted">Built on F2 audit</span>
                  <select aria-label="F2 audit" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={selectedAudit?.id ?? ''} onChange={(e) => setAuditId(e.target.value)}>
                    {eligible.map((a, i) => (
                      <option key={a.id} value={a.id}>
                        {formatDate(a.createdAt)} · {a.model}
                        {a.partial ? ' · partial' : ''}
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
              <p className="text-xs text-muted">
                F1 report <span className="font-mono">{selectedAudit?.f1ReportId}</span>
                {f1Ref ? ` (${formatDate(f1Ref.createdAt)}${f1Ref.partial ? ', partial' : ''})` : ''} → F2 audit <span className="font-mono">{selectedAudit?.id}</span> ({formatDate(selectedAudit!.createdAt)}). An older audit may not reflect today's website and profiles; the report shows its age.
              </p>
            </div>
          )}
          {!openai.isLoading && !configured && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Add your OpenAI API key in Settings &gt; AI providers to run the strategy.
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
              <Compass className="h-4 w-4" /> Start Research &amp; Strategy
            </Button>
            {running && latest && (
              <Button variant="outline" loading={cancel.isPending} onClick={() => cancel.mutate(latest.id, { onError: (e) => toast.error(e.message) })}>
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">Cost limits and research inputs</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <label className="space-y-1 text-xs text-muted">
                  Max model calls (6 to 40)
                  <Input type="number" min={6} max={40} value={maxCalls} onChange={(e) => setMaxCalls(clampNum(e.target.value, 6, 40, DEFAULT_CALLS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max Channel Scouts (0 to 6)
                  <Input type="number" min={0} max={6} value={maxScouts} onChange={(e) => setMaxScouts(clampNum(e.target.value, 0, 6, DEFAULT_SCOUTS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max cross-checks (0 to 10)
                  <Input type="number" min={0} max={10} value={maxReviews} onChange={(e) => setMaxReviews(clampNum(e.target.value, 0, 10, DEFAULT_REVIEWS))} />
                </label>
                <label className="space-y-1 text-xs text-muted">
                  Max output tokens per call
                  <Input type="number" min={800} max={6000} step={100} value={maxTokens} onChange={(e) => setMaxTokens(clampNum(e.target.value, 800, 6000, DEFAULT_TOKENS))} />
                </label>
              </div>
              <p className="mt-2 max-w-xl text-xs text-muted">Enforced by LaunchPilot per run, not an OpenAI spending cap. Each scout, review and repair counts as a call. Token counts are measured; no price is shown.</p>
              <label className="mt-4 block max-w-xl space-y-1 text-xs text-muted">
                Competitor websites you know (one per line, up to 5; analyzed first, never invented)
                <textarea aria-label="Competitor URLs" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm text-ink" rows={3} placeholder="https://competitor.example" value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
              </label>
              <label className="mt-3 block max-w-xl space-y-1 text-xs text-muted">
                Competitor names you know (one per line, up to 5; each is looked up with one search and read only if its own website is found)
                <textarea aria-label="Competitor names" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm text-ink" rows={2} placeholder="Blue Depths Academy" value={competitorNames} onChange={(e) => setCompetitorNames(e.target.value)} />
              </label>
              <label className="mt-3 block max-w-xl space-y-1 text-xs text-muted">
                Campaign goal for this strategy (optional; defaults to the project's marketing goal)
                <Input maxLength={300} value={goal} onChange={(e) => setGoal(e.target.value)} />
              </label>
              <label className="mt-3 flex max-w-xl items-center gap-2 text-xs text-muted">
                Free public-holiday calendar (date.nager.at, no key)
                <select aria-label="Holiday calendar" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={calendar} onChange={(e) => setCalendar(e.target.value as typeof calendar)}>
                  <option value="project">Use the project setting</option>
                  <option value="yes">Ask the calendar</option>
                  <option value="no">Do not ask</option>
                </select>
              </label>
              <p className="mt-2 max-w-xl text-xs text-muted">Web search and name lookups need <code>TAVILY_API_KEY</code> on the server; the same key lets JavaScript-rendered and bot-protected competitor pages be read through the Tavily Extract API. Without it (and without URLs above) the Competitor Researcher reports insufficient research instead of guessing. Each competitor site is read up to 3 pages deep (home, pricing, about, services).</p>
            </details>
          </div>
        </div>

        {stratRuns.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Run
            <select aria-label="Previous strategy runs" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={shown?.id ?? ''} onChange={(e) => setSelectedRunId(e.target.value)}>
              {stratRuns.map((r, i) => (
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
            <div role="tablist" aria-label="Market Strategy" className="flex flex-wrap gap-1 border-b border-cream-300/80">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
                  {t}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'Overview' && <StrategyOverviewTab analysis={analysis.data} running={shown.status === 'RUNNING'} />}
              {tab === 'Agents' && <AgentsTab analysis={view} events={events.data ?? []} />}
              {tab === 'Audience' && <AudienceTab analysis={analysis.data} />}
              {tab === 'Competitors' && <CompetitorsTab analysis={analysis.data} />}
              {tab === 'Channels' && <ChannelsTab analysis={analysis.data} />}
              {tab === 'Cross-Checks' && <CrossChecksTab analysis={view} />}
              {tab === 'Strategy' &&
                (strategy.isLoading ? (
                  <div className="h-40 animate-pulse rounded-2xl bg-cream-200" />
                ) : strategy.data ? (
                  <StrategyReportView data={strategy.data} />
                ) : (
                  <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
                    <p className="text-sm font-medium">{shown.status === 'RUNNING' ? 'The strategy appears when the run finishes' : 'No strategy for this run'}</p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted">Finished strategies are saved and stay available after you refresh or restart the app.</p>
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
                    <span className={cn(e.eventType === 'participant.registered' && 'font-semibold text-accent')}>{e.eventType}</span>
                    <span className="truncate text-muted">{e.participant}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
            <p className="text-sm font-medium">No strategy yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted">Press “Start Research &amp; Strategy” to run the agents. Nothing runs automatically.</p>
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
