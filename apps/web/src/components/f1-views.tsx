'use client';

import * as React from 'react';
import { AlertCircle, Check, CircleDashed, Loader2, MinusCircle, OctagonX, Search, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EvidenceBadge } from '@/components/evidence-ui';
import type { EvidenceStatus, F1Crosscheck, F1Finding, F1Participant, F1Source, RunAnalysis, RunEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATE: Record<F1Participant['state'], { label: string; icon: React.ReactNode; className: string }> = {
  waiting: { label: 'Waiting', icon: <CircleDashed className="h-4 w-4 text-muted-dark" />, className: '' },
  working: { label: 'Working…', icon: <Loader2 className="h-4 w-4 animate-spin text-accent" />, className: 'text-accent-hover' },
  done: { label: 'Done', icon: <Check className="h-4 w-4 text-emerald-600" />, className: 'text-emerald-700' },
  failed: { label: 'Failed', icon: <XCircle className="h-4 w-4 text-red-600" />, className: 'text-red-600' },
  timed_out: { label: 'Timed out', icon: <OctagonX className="h-4 w-4 text-amber-600" />, className: 'text-amber-700' },
  skipped: { label: 'Skipped', icon: <MinusCircle className="h-4 w-4 text-muted-dark" />, className: 'text-muted' },
};

const SOURCE_STATUS: Record<F1Source['status'], string> = {
  retrieved: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-cream-200 text-ink-600',
  unsupported: 'bg-amber-100 text-amber-800',
};

const VERDICT: Record<string, { label: string; className: string }> = {
  agree: { label: 'Agrees', className: 'bg-emerald-100 text-emerald-800' },
  disagree: { label: 'Disagrees', className: 'bg-red-100 text-red-700' },
  correct: { label: 'Corrects', className: 'bg-amber-100 text-amber-800' },
  insufficient_evidence: { label: 'Not enough evidence', className: 'bg-cream-200 text-ink-600' },
};

const total = (a: RunAnalysis | undefined, agent: string) => a?.usage?.perAgent?.[agent];

/** Overview: plan (activated/skipped with reasons), sources and totals. All from the persisted run. */
export function OverviewTab({ analysis }: { analysis: RunAnalysis | undefined }) {
  if (!analysis?.plan) return <Empty text="The activation plan appears as soon as the run starts." />;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Activated ({analysis.plan.activated.length})</h5>
          <ul className="space-y-1.5 text-sm">
            {analysis.plan.activated.map((a) => (
              <li key={a.key} className="rounded-lg bg-emerald-50 px-3 py-2">
                <strong>{a.agent}</strong>
                <span className="block text-xs text-muted">{a.reason}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Skipped ({analysis.plan.skipped.length})</h5>
          {analysis.plan.skipped.length === 0 ? (
            <p className="text-sm text-muted">Nothing skipped: every source type was available.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {analysis.plan.skipped.map((a) => (
                <li key={a.key} className="rounded-lg bg-cream-100 px-3 py-2">
                  <strong>{a.agent}</strong>
                  <span className="block text-xs text-muted">{a.reason}. This is not a failure.</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Sources ({analysis.sources.length})</h5>
        {analysis.sources.length === 0 ? (
          <p className="text-sm text-muted">No external sources were retrieved (text-only idea).</p>
        ) : (
          <ul className="divide-y divide-cream-300/70 rounded-xl border border-cream-300/80 bg-cream-50 text-sm">
            {analysis.sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Badge className={SOURCE_STATUS[s.status]}>{s.status}</Badge>
                <span className="min-w-0 flex-1 truncate" title={s.url ?? s.label}>
                  <span className="font-mono text-xs text-muted">{s.kind}</span> {s.label}
                </span>
                <span className="text-xs text-muted">
                  {s.fixture ? 'FIXTURE (test data)' : s.live ? 'live' : 'not live'}
                  {s.httpStatus ? ` · HTTP ${s.httpStatus}` : ''}
                </span>
                {s.injectionSuspected && <Badge className="bg-amber-100 text-amber-800">instructions in content ignored</Badge>}
                {(s.error || s.notes.length > 0) && <span className="basis-full text-xs text-muted">{[s.error, ...s.notes].filter(Boolean).join(' · ')}</span>}
              </li>
            ))}
          </ul>
        )}
        {analysis.tools && !analysis.tools.searchConfigured && (
          <p className="mt-2 text-xs text-muted">No web search provider configured (TAVILY_API_KEY): only your own website, repository and uploads were read, no general web search.</p>
        )}
      </div>

      {analysis.notAnalyzed.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Not analyzed</h5>
          <ul className="space-y-1 text-sm">
            {analysis.notAnalyzed.map((n, i) => (
              <li key={i}>
                <strong>{n.label}</strong> <span className="text-muted">{n.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Agents: who did what, whether each made AI calls, tokens per agent, and the findings each posted. */
export function AgentsTab({ analysis, events }: { analysis: RunAnalysis | undefined; events: RunEvent[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const names = analysis?.plan ? [...analysis.plan.activated.map((a) => a.agent), ...analysis.plan.skipped.map((a) => a.agent)] : [];
  if (!names.length) return <Empty text="Agents appear when the run starts." />;
  const state = (n: string) => analysis!.participants.find((p) => p.agent === n);
  const skippedReason = (n: string) => analysis!.plan!.skipped.find((a) => a.agent === n)?.reason;
  return (
    <ol className="space-y-2">
      {names.map((n) => {
        const p = state(n) ?? { agent: n, state: skippedReason(n) ? 'skipped' : 'waiting' };
        const ui = STATE[p.state as F1Participant['state']] ?? STATE.waiting;
        const u = total(analysis, n);
        const findings = analysis!.findings.filter((f) => f.agent === n);
        const calls = analysis!.aiCalls[n] ?? 0;
        const isOpen = open === n;
        return (
          <li key={n} className="rounded-xl border border-cream-300/80 bg-cream-50">
            <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(isOpen ? null : n)} aria-expanded={isOpen}>
              {ui.icon}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{n}</span>
                <span className="block truncate text-xs text-muted">
                  {p.state === 'skipped' ? skippedReason(n) ?? p.reason : p.error?.message ?? `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
                </span>
              </span>
              <span className="hidden text-xs text-muted sm:block">
                {calls > 0 ? `${calls} AI call${calls === 1 ? '' : 's'} · ${(u?.totalTokens ?? 0).toLocaleString()} tokens` : p.state === 'skipped' ? 'no AI call' : 'tool / no AI call'}
              </span>
              <span className={cn('text-xs font-medium', ui.className)}>{ui.label}</span>
            </button>
            {isOpen && (
              <div className="space-y-3 border-t border-cream-300/70 px-4 py-3 text-sm">
                {u && (
                  <p className="text-xs text-muted">
                    {u.calls} call{u.calls === 1 ? '' : 's'} · {u.inputTokens.toLocaleString()} in / {u.outputTokens.toLocaleString()} out
                    {u.reasoningTokens ? ` · ${u.reasoningTokens.toLocaleString()} reasoning` : ''}
                  </p>
                )}
                {analysis!.sources.filter((s) => s.agent === n).map((s) => (
                  <p key={s.id} className="text-xs">
                    <Badge className={SOURCE_STATUS[s.status]}>{s.status}</Badge> <span className="ml-1">{s.label}</span>
                  </p>
                ))}
                {findings.length === 0 ? (
                  <p className="text-xs text-muted">No findings posted by this agent.</p>
                ) : (
                  <ul className="space-y-2">
                    {findings.map((f) => (
                      <FindingRow key={f.id} f={f} />
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-muted">
                  Events by this agent: {events.filter((e) => e.participant === n).map((e) => e.eventType).join(', ') || 'none'}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function FindingRow({ f }: { f: F1Finding }) {
  return (
    <li className="rounded-lg bg-cream-100/70 px-3 py-2">
      <div className="flex items-start gap-2">
        <EvidenceBadge status={f.classification} />
        <span className="min-w-0 flex-1">
          <span className="block">{f.statement}</span>
          <span className="block font-mono text-[11px] text-muted">
            {f.id} · {f.category} · {f.sourceType}
            {f.locator ? ` · ${f.locator}` : ''}
            {f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ''}
          </span>
          {f.excerpt && <span className="mt-1 block border-l-2 border-accent/50 pl-2 text-xs italic text-ink-600">“{f.excerpt}”</span>}
          {f.adjustment && <span className="mt-1 block text-xs text-amber-800">Adjusted by LaunchPilot: {f.adjustment}</span>}
          {f.crosscheck.status !== 'not_requested' && (
            <span className="mt-1 block text-xs text-muted">
              Cross-check: {f.crosscheck.status}
              {f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : ''}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

/** Evidence: all findings, filterable by class and agent. Every row shows provenance. */
export function EvidenceTab({ analysis }: { analysis: RunAnalysis | undefined }) {
  const [cls, setCls] = React.useState<EvidenceStatus | 'all'>('all');
  const [agent, setAgent] = React.useState('all');
  const [q, setQ] = React.useState('');
  const all = analysis?.findings ?? [];
  if (!all.length) return <Empty text="No findings yet." />;
  const agents = [...new Set(all.map((f) => f.agent))];
  const counts = (c: EvidenceStatus) => all.filter((f) => f.classification === c).length;
  const rows = all.filter((f) => (cls === 'all' || f.classification === cls) && (agent === 'all' || f.agent === agent) && (!q || f.statement.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(['all', 'verified', 'claimed', 'inferred', 'disputed', 'unknown'] as const).map((c) => (
          <button key={c} onClick={() => setCls(c)} className={cn('rounded-full border px-3 py-1', cls === c ? 'border-ink bg-ink text-cream-100' : 'border-cream-300 bg-cream-50 text-ink-600')}>
            {c === 'all' ? `All (${all.length})` : `${c} (${counts(c)})`}
          </button>
        ))}
        <select aria-label="Filter by agent" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <label className="relative ml-auto">
          <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted" />
          <input aria-label="Search findings" className="rounded-lg border border-cream-300 bg-cream-50 py-1 pl-7 pr-2" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <ul className="space-y-2">
        {rows.map((f) => (
          <FindingRow key={f.id} f={f} />
        ))}
      </ul>
      {rows.length === 0 && <p className="text-sm text-muted">No findings match this filter.</p>}
      {analysis!.policyIssues.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Automatic corrections by LaunchPilot ({analysis!.policyIssues.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {analysis!.policyIssues.map((p, i) => (
              <li key={i}>
                {p.type}: {p.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Cross-checks: each claim, who produced it, who reviewed it and the reviewer's verdict. */
export function CrossChecksTab({ analysis }: { analysis: RunAnalysis | undefined }) {
  const list: F1Crosscheck[] = analysis?.crosschecks ?? [];
  if (!list.length) return <Empty text="No cross-checks were run (disabled, no model-call budget left, or too little to check)." />;
  const claim = (id: string) => analysis!.findings.find((f) => f.id === id);
  return (
    <ul className="space-y-2">
      {list.map((c, i) => {
        const f = claim(c.claimId);
        const v = c.verdict ? VERDICT[c.verdict] : null;
        return (
          <li key={`${c.requestId}-${c.claimId}-${i}`} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted">{c.claimId}</span>
              <span className="text-xs">
                <strong>{c.reviewer}</strong> reviewed a claim by <strong>{c.producer}</strong>
              </span>
              {v ? <Badge className={v.className}>{v.label}</Badge> : <Badge className="bg-cream-200 text-ink-600">{c.status.replace('_', ' ')}</Badge>}
            </div>
            {f && <p className="mt-1.5">{f.statement}</p>}
            {c.rationale && <p className="mt-1 text-xs text-muted">Reviewer: {c.rationale}</p>}
            {c.correction && <p className="mt-1 text-xs text-amber-800">Suggested correction: {c.correction}</p>}
            {c.error && (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                <AlertCircle className="h-3 w-3" /> {c.error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">{text}</p>;
}
