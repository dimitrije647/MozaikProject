'use client';

import * as React from 'react';
import { AlertCircle, Brain, Check, CircleDashed, Download, FileSearch, Compass, Loader2, Lock, MinusCircle, OctagonX, Palette, XCircle, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePipeline } from '@/lib/hooks';
import type { PhaseKey, PhaseState, PipelineData, PipelinePhaseData, PipelineSummaryData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * Everything here is rendered from GET /projects/:id/pipeline (saved CampaignRun rows and saved results). A phase is only shown
 * as completed when its result was saved; a failed rerun never hides an earlier result; nothing is a static placeholder.
 */

const STATE: Record<PhaseState, { label: string; badge: string; dot: string; icon: LucideIcon; spin?: boolean }> = {
  completed: { label: 'Completed', badge: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500', icon: Check },
  running: { label: 'Running', badge: 'bg-accent-soft text-accent-hover', dot: 'bg-accent animate-pulse', icon: Loader2, spin: true },
  failed: { label: 'Failed', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500', icon: XCircle },
  cancelled: { label: 'Cancelled', badge: 'bg-cream-300 text-ink-600', dot: 'bg-amber-500', icon: MinusCircle },
  interrupted: { label: 'Interrupted', badge: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500', icon: OctagonX },
  not_started: { label: 'Not started', badge: 'bg-cream-200 text-ink-600', dot: 'bg-cream-300', icon: CircleDashed },
  blocked: { label: 'Waiting', badge: 'bg-cream-200 text-muted', dot: 'bg-cream-300', icon: Lock },
};

const ICON: Record<PhaseKey, LucideIcon> = { discovery: Brain, audit: FileSearch, strategy: Compass, creative: Palette };
const ANCHOR: Record<PhaseKey, string> = { discovery: 'phase-f1', audit: 'phase-f2', strategy: 'phase-f3', creative: 'phase-f4' };
const CODE: Record<PhaseKey, string> = { discovery: 'F1', audit: 'F2', strategy: 'F3', creative: 'F4' };
const PHASE_ORDER: PhaseKey[] = ['discovery', 'audit', 'strategy', 'creative'];

const label = (p: PipelinePhaseData) => (p.state === 'blocked' ? `Waiting for ${CODE[PHASE_ORDER[PHASE_ORDER.indexOf(p.phase) - 1]]}` : STATE[p.state].label);
const when = (iso: string | null | undefined) => (iso ? formatDate(iso) : '');

export function StateBadge({ phase }: { phase: PipelinePhaseData }) {
  const s = STATE[phase.state];
  return (
    <Badge className={cn(s.badge)}>
      <s.icon className={cn('h-3 w-3', s.spin && 'animate-spin')} />
      {label(phase)}
    </Badge>
  );
}

const APPROVAL: Record<string, string> = { approved: 'bg-emerald-100 text-emerald-800', approved_with_notes: 'bg-amber-100 text-amber-800', unresolved: 'bg-red-100 text-red-700' };

function Body({ p, briefNote }: { p: PipelinePhaseData; briefNote?: string | null }) {
  const o = p.output;
  return (
    <div className="space-y-3 text-sm">
      {o ? (
        <>
          {o.summary && <p className="line-clamp-4 text-ink-700">{o.summary}</p>}
          {o.stats.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {o.stats.map((s) => (
                <li key={s.label} className="rounded-full bg-cream-100 px-2.5 py-0.5 text-xs text-ink-600">
                  <span className="text-muted">{s.label} </span>
                  <strong className="font-semibold">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>Saved {when(o.createdAt)}</span>
            {o.model && <span>· {o.model}</span>}
            {o.partial && <Badge className="bg-amber-100 text-amber-800">partial</Badge>}
            {o.approvalStatus && <Badge className={APPROVAL[o.approvalStatus] ?? 'bg-cream-200 text-ink-600'}>{o.approvalStatus.replace(/_/g, ' ')}</Badge>}
            <span>
              · {p.runs} run{p.runs === 1 ? '' : 's'}
            </span>
          </p>
          {o.outdated && <p className="text-xs text-amber-800">{o.outdated}</p>}
        </>
      ) : p.state === 'running' ? (
        <p className="flex items-center gap-2 text-ink-700">
          <Loader2 className="h-4 w-4 animate-spin text-accent" /> Running since {when(p.latestRun?.startedAt)}. The result appears here when it is saved.
        </p>
      ) : p.state === 'blocked' ? (
        <p className="text-muted">{p.blockedBy}</p>
      ) : p.state === 'not_started' ? (
        <p className="text-muted">Ready to run. Start it from the {p.code} panel below; nothing runs automatically.</p>
      ) : (
        <p role="alert" className="flex items-start gap-2 text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {p.state === 'failed' ? 'The run failed' : p.state === 'cancelled' ? 'The run was cancelled' : 'The run was interrupted'}
            {p.latestRun?.completedAt ? ` (${when(p.latestRun.completedAt)})` : ''}.{p.latestRun?.errorMessage ? ` ${p.latestRun.errorMessage}` : ''}
          </span>
        </p>
      )}
      {o && p.state !== 'completed' && p.state !== 'running' && p.latestRun && (
        <p role="alert" className="flex items-start gap-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Latest run {p.latestRun.status.toLowerCase()} ({when(p.latestRun.completedAt ?? p.latestRun.startedAt)}).{p.latestRun.errorMessage ? ` ${p.latestRun.errorMessage}` : ''}
          </span>
        </p>
      )}
      {o && p.state !== 'completed' && p.state !== 'running' && p.latestRun && <p className="text-xs text-muted">The result above is from an earlier completed run and is still available.</p>}
      {p.note && !(o && p.state !== 'completed' && p.latestRun) && <p className="text-xs text-muted">{p.note}</p>}
      {briefNote && <p className="text-xs text-muted">{briefNote}</p>}
    </div>
  );
}

const jump = (id: string) => `#${id}`;

/** The five workspace cards: Product Intelligence, Audit, Strategy, Creative Output and Export, all from persisted state. */
export function PipelineCards({ pipeline, loading, flags }: { pipeline: PipelineData | undefined; loading: boolean; flags: Record<string, boolean> | null }) {
  if (loading && !pipeline) return <div className="grid gap-4 sm:grid-cols-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-cream-200" />)}</div>;
  if (!pipeline) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">The saved state of the phases could not be loaded. Reload the page; nothing was changed.</p>;
  const by = Object.fromEntries(pipeline.phases.map((p) => [p.phase, p])) as Record<PhaseKey, PipelinePhaseData>;
  const creative = by.creative;
  const campaignId = creative.output?.id;
  const driveNote = flags?.enableGoogleDriveExport ? 'Google Drive hand-off is on in the brief but is not implemented; download the ZIP instead.' : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PHASE_ORDER.map((k) => {
        const p = by[k];
        const Icon = ICON[k];
        const auditOff = k === 'audit' && flags && flags.enableSeoAudit === false && !p.output && p.state === 'not_started';
        return (
          <Card key={k} data-phase={k} data-state={p.state}>
            <CardHeader className="items-center">
              <CardTitle className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="mr-1.5 font-mono text-[11px] font-normal text-muted">{p.code}</span>
                  {p.title}
                </span>
              </CardTitle>
              <StateBadge phase={p} />
            </CardHeader>
            <CardContent className="space-y-3">
              <Body p={p} briefNote={auditOff ? 'The SEO audit is switched off in the project brief; you can still run the audit.' : null} />
              <Button asChild size="sm" variant="ghost">
                <a href={jump(ANCHOR[k])}>{p.state === 'blocked' ? `Go to ${p.code} panel` : p.output ? `Open ${p.code} results` : `Open ${p.code} panel`}</a>
              </Button>
            </CardContent>
          </Card>
        );
      })}
      <Card data-phase="export" data-state={campaignId ? 'completed' : creative.state === 'running' ? 'running' : 'not_started'}>
        <CardHeader className="items-center">
          <CardTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent">
              <Download className="h-4 w-4" />
            </span>
            Export
          </CardTitle>
          <Badge className={cn((campaignId ? STATE.completed : creative.state === 'running' ? STATE.running : STATE.not_started).badge)}>{campaignId ? 'Package ready' : creative.state === 'running' ? 'Producing' : 'Not available yet'}</Badge>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {campaignId ? (
            <>
              <p className="text-ink-700">The campaign package from F4 is saved: image binaries, campaign.json, copy, landing content and preview, review and a manifest.</p>
              <p className="text-xs text-muted">
                Saved {when(creative.output?.createdAt)}
                {creative.output?.outdated ? ` · ${creative.output.outdated}` : ''}
              </p>
              <Button asChild size="sm">
                <a href={`/api/campaigns/${campaignId}/export`} download>
                  <Download className="h-3.5 w-3.5" /> Download package (ZIP)
                </a>
              </Button>
            </>
          ) : (
            <p className="text-muted">{creative.state === 'running' ? 'The package is assembled when F4 finishes.' : 'The downloadable package is produced by F4 Creative Production, which needs a completed strategy. Nothing is exported before then.'}</p>
          )}
          {driveNote && <p className="text-xs text-muted">{driveNote}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

/** The hero strip: one tile per phase with the real state. */
export function PipelineStrip({ pipeline }: { pipeline: PipelineData | undefined }) {
  return (
    <ol className="relative mt-10 grid gap-3 sm:grid-cols-5">
      {[...PHASE_ORDER, 'export' as const].map((k, i) => {
        const p = k === 'export' ? null : pipeline?.phases.find((x) => x.phase === k);
        const exported = k === 'export' ? !!pipeline?.phases.find((x) => x.phase === 'creative')?.output : false;
        const state: PhaseState | null = k === 'export' ? (!pipeline ? null : exported ? 'completed' : 'not_started') : (p?.state ?? null);
        const s = state ? STATE[state] : null;
        const Icon = k === 'export' ? Download : ICON[k];
        const title = k === 'export' ? 'Export' : p?.title ?? '';
        return (
          <li key={k} data-state={state ?? 'loading'} className="flex items-center gap-3 rounded-2xl bg-white/[0.06] px-4 py-3 ring-1 ring-white/10">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-accent">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] uppercase tracking-wider text-muted-dark">Stage {i + 1}</span>
              <span className="block truncate text-sm text-cream-100">{title}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-dark">
                <span className={cn('h-1.5 w-1.5 rounded-full', s ? s.dot : 'bg-cream-300/40')} />
                {k === 'export' ? (exported ? 'Package ready' : 'Not available yet') : p ? label(p) : '…'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The light summary of a full pipeline (what the project list carries). */
export function toSummary(pipeline: PipelineData | undefined): PipelineSummaryData | null {
  if (!pipeline) return null;
  return {
    completed: pipeline.completed,
    running: pipeline.running,
    next: pipeline.next,
    states: Object.fromEntries(pipeline.phases.map((p) => [p.phase, p.state])) as Record<PhaseKey, PhaseState>,
    hasOutput: Object.fromEntries(pipeline.phases.map((p) => [p.phase, !!p.output])) as Record<PhaseKey, boolean>,
  };
}

/** The badge for one project, read from its persisted state. */
export function ProjectPipelineBadge({ projectId, dark = false }: { projectId: string; dark?: boolean }) {
  const pipeline = usePipeline(projectId);
  return <PipelineBadge dark={dark} summary={toSummary(pipeline.data)} />;
}

/** Compact F1..F4 progress for lists and headers. `dark` is for the dark hero panels. */
export function PipelineBadge({ summary, dark = false, className }: { summary: PipelineSummaryData | null | undefined; dark?: boolean; className?: string }) {
  if (!summary) return null;
  const title = PHASE_ORDER.map((k) => `${CODE[k]}: ${summary.states[k] === 'blocked' ? 'waiting' : summary.states[k].replace('_', ' ')}${summary.hasOutput[k] && summary.states[k] !== 'completed' ? ' (earlier result saved)' : ''}`).join(' · ');
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={title} data-testid="pipeline-badge">
      {PHASE_ORDER.map((k) => {
        const st = summary.states[k];
        const done = summary.hasOutput[k];
        const tone = st === 'running' ? 'bg-accent text-white' : st === 'failed' ? 'bg-red-100 text-red-700' : st === 'cancelled' || st === 'interrupted' ? 'bg-amber-100 text-amber-800' : done ? 'bg-emerald-100 text-emerald-800' : dark ? 'bg-white/10 text-muted-dark' : 'bg-cream-200 text-muted';
        return (
          <span key={k} data-state={st} className={cn('inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold', tone)}>
            {st === 'running' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : done && st === 'completed' ? <Check className="h-2.5 w-2.5" /> : null}
            {CODE[k]}
          </span>
        );
      })}
      <span className={cn('text-[11px]', dark ? 'text-muted-dark' : 'text-muted')}>{summary.running ? `${CODE[summary.running]} running` : `${summary.completed} of 4 phases saved`}</span>
    </span>
  );
}
