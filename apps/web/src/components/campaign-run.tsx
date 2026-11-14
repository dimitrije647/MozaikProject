'use client';

import * as React from 'react';
import { AlertCircle, Check, CircleDashed, Download, Loader2, MinusCircle, OctagonX, Play, Recycle, Square, UserPlus, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { otherParticipants, teamProgress, type StepState } from '@/lib/agent-progress';
import { campaignZipUrl } from '@/lib/campaign';
import { useCancelFactory, useFactoryEvents } from '@/lib/hooks';
import type { FactoryActivityItem, FactoryFailureData, FactoryOutcome, FactoryPhaseData, FactoryPhaseStatus, FactoryRunData, FactoryUsage } from '@/lib/types';
import { cn, fmtUsd, formatDate } from '@/lib/utils';

/*
 * The live (and saved) view of one campaign run: outcome, why it stopped, the three stages, the Mozaik team and its recorded activity, the one
 * budget. Everything is read from the persisted run and its recorded events; nothing is simulated. Historical runs (four phases, presets, AI
 * images) render with the same code: their extra phases and agents are shown as they were recorded.
 */

export const isActive = (s: string | undefined) => s === 'queued' || s === 'running';

const PHASE_STATUS: Record<FactoryPhaseStatus, { label: string; badge: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending', badge: 'bg-cream-200 text-ink-600', icon: <CircleDashed className="h-3 w-3" /> },
  reused: { label: 'Reused', badge: 'bg-sky-100 text-sky-800', icon: <Recycle className="h-3 w-3" /> },
  running: { label: 'Running', badge: 'bg-accent-soft text-accent-hover', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  completed: { label: 'Completed', badge: 'bg-emerald-100 text-emerald-800', icon: <Check className="h-3 w-3" /> },
  failed: { label: 'Failed', badge: 'bg-red-100 text-red-700', icon: <XCircle className="h-3 w-3" /> },
  cancelled: { label: 'Cancelled', badge: 'bg-cream-300 text-ink-600', icon: <MinusCircle className="h-3 w-3" /> },
  skipped: { label: 'Not run', badge: 'bg-cream-200 text-muted', icon: <MinusCircle className="h-3 w-3" /> },
};

const BANNER: Record<FactoryOutcome, { tone: string; title: string; text: string }> = {
  in_progress: { tone: 'border-accent/40 bg-accent-soft/50 text-ink', title: 'Generating the campaign', text: 'Business Research, Marketing Strategy and Creative Production run one after another. Each result is saved before the next stage starts.' },
  approved: { tone: 'border-emerald-300 bg-emerald-50 text-emerald-900', title: 'Campaign ready', text: 'The marketing package is saved and the Quality Reviewer left no open issue.' },
  approved_with_notes: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Campaign ready, with notes', text: 'The package is saved. Minor issues or limitations remain; read the review notes before publishing.' },
  unresolved: { tone: 'border-red-300 bg-red-50 text-red-800', title: 'Campaign saved with unresolved issues', text: 'Blocker or major issues could not be corrected. It is NOT ready to publish.' },
  partial: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Partial campaign', text: 'The package is saved, but some deliverables could not be produced or an agent failed. The reasons are listed with the campaign.' },
  failed: { tone: 'border-red-300 bg-red-50 text-red-800', title: 'Campaign failed', text: 'A required stage failed, so the run stopped. Saved results are untouched and nothing was retried automatically.' },
  cancelled: { tone: 'border-cream-300 bg-cream-100 text-ink', title: 'Campaign cancelled', text: 'The active stage was stopped and the remaining stages were not started.' },
  interrupted: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Campaign interrupted', text: 'The server stopped while this run was in progress. Nothing was resumed or repeated, so no further paid request was made.' },
};

const STEP_TONE: Record<StepState, string> = {
  waiting: 'border-cream-300 bg-cream-50 text-muted',
  working: 'border-accent bg-accent-soft/40 text-ink',
  done: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  failed: 'border-red-300 bg-red-50 text-red-800',
  skipped: 'border-cream-300 bg-cream-100 text-muted',
};

function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const usd = (n: number | null | undefined) => (n === undefined ? '—' : n === null ? 'unknown' : fmtUsd(n));

export function OutcomeBanner({ run }: { run: FactoryRunData }) {
  const b = BANNER[run.outcome];
  const current = run.phases.find((p) => p.phase === run.currentPhase);
  return (
    <div role="status" data-outcome={run.outcome} className={cn('flex items-start gap-3 rounded-2xl border px-5 py-4', b.tone)}>
      {isActive(run.status) ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" /> : run.outcome === 'approved' ? <Check className="mt-0.5 h-5 w-5 shrink-0" /> : run.outcome === 'interrupted' ? <OctagonX className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />}
      <div>
        <p className="font-semibold">
          {b.title}
          {isActive(run.status) && current ? `: ${current.title}` : ''}
        </p>
        <p className="text-sm">{b.text}</p>
        {run.errorMessage && run.outcome !== 'approved' && <p data-testid="run-error" className="mt-1 text-sm">{run.failure?.restated?.summary ?? run.errorMessage}</p>}
      </div>
    </div>
  );
}

/** WHY the campaign stopped: where, which agent, the safe reason, what was spent and what to do. Nothing here starts paid work. */
function FailureCard({ failure: f, onRestart }: { failure: FactoryFailureData; onRestart?: () => void }) {
  const row = (k: string, v: React.ReactNode) => (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
  return (
    <section data-testid="failure-card" data-kind={f.kind} data-code={f.code ?? ''} aria-label="Why the campaign stopped" className="space-y-3 rounded-2xl border border-red-200 bg-red-50/60 px-5 py-4 text-red-950">
      <p className="font-semibold">{f.headline}</p>
      <dl className="space-y-2">
        {f.agent && row('Agent', f.agent)}
        {row('Reason', <>{f.reason}{f.detail ? <span className="text-red-900/80"> {f.detail}</span> : null}</>)}
        {row('Known spending', usd(f.spending.knownUsd))}
        {row('Uncertain charges', f.spending.uncertainUsd ? `${usd(f.spending.uncertainUsd)} (requests that may have been billed)` : 'none')}
        {row('Remaining budget', usd(f.spending.remainingUsd))}
        {f.saved.length > 0 && row('Saved work', `${f.saved.map((s) => s.title).join(' · ')} (kept; reused when it is still current)`)}
      </dl>
      <p className="text-xs text-red-900/80">{f.spending.note}</p>
      <p className="text-sm"><strong>Recommended next action:</strong> {f.nextAction}</p>
      {onRestart && f.canContinue && (
        <Button variant="outline" onClick={onRestart}>
          <Play className="h-3.5 w-3.5" /> Set up the campaign again
        </Button>
      )}
    </section>
  );
}

function PhaseCard({ p, current, note }: { p: FactoryPhaseData; current: boolean; note?: string }) {
  const s = PHASE_STATUS[p.status];
  return (
    <li data-phase={p.phase} data-status={p.status} className={cn('rounded-2xl border px-4 py-3 text-sm', current ? 'border-accent bg-accent-soft/40' : p.status === 'reused' ? 'border-sky-200 bg-sky-50/60' : 'border-cream-300/80 bg-cream-50')}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-tight">{p.title}</p>
        <Badge className={s.badge}>
          {s.icon}
          {s.label}
        </Badge>
      </div>
      <p className="mt-2 text-xs text-muted">
        {p.status === 'reused' && p.reused ? `Saved ${formatDate(p.reused.createdAt)}${p.reused.partial ? ' (partial)' : ''}; reused at no cost.` : null}
        {p.status === 'completed' ? `Saved ${p.completedAt ? formatDate(p.completedAt) : ''}${p.startedAt && p.completedAt ? ` · took ${fmtDuration(Date.parse(p.completedAt) - Date.parse(p.startedAt))}` : ''}` : null}
        {p.status === 'running' ? `Started ${p.startedAt ? formatDate(p.startedAt) : ''}` : null}
        {p.status === 'pending' ? 'Waits for the previous stage to be saved.' : null}
        {p.status === 'skipped' ? 'Not started because an earlier stage did not complete.' : null}
      </p>
      {p.error && <p role="alert" className="mt-1 text-xs text-red-700">{note ?? p.error}</p>}
    </li>
  );
}

function TeamPanel({ items, active }: { items: FactoryActivityItem[]; active: boolean }) {
  const team = teamProgress(items, active);
  const others = otherParticipants(items);
  return (
    <section data-testid="mozaik-team" aria-label="Mozaik team" className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">The Mozaik team</h4>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {team.map((m) => (
          <li key={m.code} data-agent={m.name} data-state={m.state} className={cn('rounded-xl border px-3 py-2 text-xs', STEP_TONE[m.state])}>
            <p className="flex items-center justify-between gap-2 text-sm font-medium">
              <span>
                <span className="mr-1 font-mono text-[11px] text-muted">{m.code}</span>
                {m.name}
              </span>
              {m.state === 'working' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : m.state === 'done' ? <Check className="h-3.5 w-3.5" /> : m.state === 'failed' ? <XCircle className="h-3.5 w-3.5" /> : null}
            </p>
            <p>{m.role}</p>
            <p className="mt-0.5 text-[11px] opacity-80">{m.usesModel ? 'Uses your text model' : 'Deterministic: no model call, no cost'}</p>
          </li>
        ))}
      </ol>
      {others.length > 0 && <p className="text-xs text-muted">Earlier agents recorded in this (historical) run: {others.join(', ')}.</p>}
    </section>
  );
}

function ActivityFeed({ items, active }: { items: FactoryActivityItem[]; active: boolean }) {
  const [minor, setMinor] = React.useState(false);
  const box = React.useRef<HTMLOListElement>(null);
  const shown = items.filter((i) => minor || i.importance !== 'minor');
  React.useEffect(() => {
    if (active && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, active]);
  return (
    <details open={active} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3">
      <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-muted">How it was made: recorded Mozaik events ({items.length})</summary>
      <label className="mt-2 flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={minor} onChange={(e) => setMinor(e.target.checked)} /> Show assignments and unused agents
      </label>
      {shown.length === 0 ? (
        <p className="mt-2 text-center text-sm text-muted">{active ? 'Waiting for the first agent event…' : 'No agent activity was recorded.'}</p>
      ) : (
        <ol ref={box} aria-label="Agent activity" className="mt-2 max-h-[26rem] space-y-1 overflow-auto rounded-xl bg-cream-100/70 p-3 text-xs">
          {shown.map((e) => (
            <li key={e.id} data-type={e.type} className="grid grid-cols-[3rem_1fr] gap-2">
              <span className="font-mono text-muted">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="min-w-0">
                {e.type === 'participant.registered' && <UserPlus className="mr-1 inline h-3 w-3 text-accent" />}
                <span className="font-mono text-[11px] text-muted">{e.type}</span> <strong>{e.participant ?? ''}</strong> <span className="text-ink-700">{e.summary}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** The ONE campaign budget: approved, known, held, uncertain and remaining. Unknown stays "unknown", never 0. */
function RunBudget({ u }: { u: FactoryUsage }) {
  const b = u.budget;
  if (!b) return null;
  const cell = (k: string, v: React.ReactNode, hint?: string) => (
    <div className="rounded-lg bg-white/70 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="text-base font-semibold">{v}</dd>
      {hint && <dd className="text-[11px] text-muted">{hint}</dd>}
    </div>
  );
  return (
    <section data-testid="run-budget" data-source={b.source} className="space-y-2 rounded-xl bg-cream-100 px-4 py-3 text-xs">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Campaign budget (one budget for every text-model call)</p>
      <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cell('Approved', b.approvedUsd === null ? 'no limit' : fmtUsd(b.approvedUsd))}
        {cell('Known spending', usd(b.knownUsd), 'from the usage the provider reported')}
        {cell('Held now', usd(b.reservedUsd), 'requests in flight')}
        {cell('Uncertain', usd(b.uncertainUsd), 'may have been billed (timeout or cancel)')}
        {cell('Remaining', b.remainingUsd === null ? (b.approvedUsd === null ? '—' : 'unknown') : fmtUsd(b.remainingUsd))}
      </dl>
      <p>
        Text-model calls: <strong>{u.textCalls}</strong>
        {u.providerRequests && u.providerRequests > u.textCalls ? <> (provider requests: <strong>{u.providerRequests}</strong>, including answers cut off by their limit and requests that timed out)</> : null} · tokens of completed answers <strong>{u.totalTokens.toLocaleString()}</strong>
        {u.imagesGenerated > 0 ? ` · AI images (historical run): ${u.imagesGenerated}` : ' · AI images: 0'}
      </p>
      {[...b.notes, ...b.refusals].map((n, i) => (
        <p key={i} className="flex items-start gap-2 text-amber-900">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {n}
        </p>
      ))}
      <p className="text-[11px] text-muted">An application-side figure from provider-reported usage at published prices, not an invoice and not a billing cap.</p>
    </section>
  );
}

export function FactoryRunView({ projectId, run, onRestart }: { projectId: string; run: FactoryRunData; onRestart?: () => void }) {
  const toast = useToast();
  const events = useFactoryEvents(run.id, run.status);
  const cancel = useCancelFactory(projectId);
  const active = isActive(run.status);
  const now = useNow(active);
  const elapsed = run.startedAt ? fmtDuration((run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.startedAt)) : '—';
  const items = events.data?.items ?? [];
  const legacy = run.config.workflow !== 'campaign_production';
  return (
    <div data-testid="factory-run" data-status={run.status} className="space-y-5">
      <OutcomeBanner run={run} />
      {legacy && <p className="text-xs text-muted">Historical run{run.config.legacyPreset ? ` (made with the earlier "${run.config.legacyPreset}" setup)` : ''}: shown as it was recorded.</p>}
      {run.failure && <FailureCard failure={run.failure} onRestart={onRestart} />}
      <ol className={cn('grid gap-3', run.phases.length > 3 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3')} aria-label="Stages">
        {run.phases.map((p) => (
          <PhaseCard key={p.phase} p={p} current={run.currentPhase === p.phase} note={run.failure?.restated && run.failure.phase?.code === p.code ? run.failure.restated.phaseNote : undefined} />
        ))}
      </ol>
      <p className="text-xs text-muted">
        Elapsed {elapsed}
        {run.config.textModel ? ` · text model ${run.config.textModel}` : ''}
        {run.deliverables ? ` · ${run.deliverables.delivered} of ${run.deliverables.planned} deliverables produced` : ''}
      </p>
      {run.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-900">
          {run.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <TeamPanel items={items} active={active} />
      {run.usage && <RunBudget u={run.usage} />}
      <div className="flex flex-wrap items-center gap-3">
        {active && (
          <Button variant="danger" loading={cancel.isPending} onClick={() => window.confirm('Cancel the campaign? The active stage is stopped and later stages are not started. Paid calls already made stay billed; saved results are kept.') && cancel.mutate(run.id, { onError: (e) => toast.error(e.message) })}>
            <Square className="h-3.5 w-3.5" /> Cancel campaign
          </Button>
        )}
        {run.campaignId && (
          <Button asChild>
            <a href={campaignZipUrl(run.campaignId)} download>
              <Download className="h-4 w-4" /> Download ZIP
            </a>
          </Button>
        )}
      </div>
      <ActivityFeed items={items} active={active} />
    </div>
  );
}
