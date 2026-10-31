'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EvidenceBadge } from '@/components/evidence-ui';
import type { AuditAnalysis, AuditFindingData, EvidenceStatus, RunAnalysis, Severity } from '@/lib/types';
import { cn } from '@/lib/utils';

export const SEVERITY: Record<Severity, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-600 text-white' },
  high: { label: 'High', className: 'bg-red-100 text-red-700' },
  medium: { label: 'Medium', className: 'bg-amber-100 text-amber-800' },
  low: { label: 'Low', className: 'bg-cream-200 text-ink-600' },
  info: { label: 'Info', className: 'bg-cream-100 text-muted' },
};

export const SeverityBadge = ({ severity }: { severity: Severity }) => <Badge className={cn('shrink-0', SEVERITY[severity].className)}>{SEVERITY[severity].label}</Badge>;

const ORIGIN: Record<string, { label: string; className: string }> = {
  live_api: { label: 'live API', className: 'bg-emerald-100 text-emerald-800' },
  public_page: { label: 'public page (live)', className: 'bg-emerald-100 text-emerald-800' },
  user_provided: { label: 'user provided', className: 'bg-amber-100 text-amber-800' },
  export: { label: 'user export', className: 'bg-amber-100 text-amber-800' },
  fixture: { label: 'FIXTURE (demo data)', className: 'bg-indigo-100 text-indigo-800' },
  previous_phase: { label: 'F1 result', className: 'bg-cream-200 text-ink-600' },
};
export const OriginBadge = ({ origin }: { origin?: string }) => {
  const o = ORIGIN[origin ?? ''] ?? { label: origin ?? 'unknown origin', className: 'bg-cream-200 text-ink-600' };
  return <Badge className={o.className}>{o.label}</Badge>;
};

/** Lets the shared F1 Agents / Cross-Checks views render an audit run (same events, same shape). */
export function toRunAnalysis(a: AuditAnalysis | undefined): RunAnalysis | undefined {
  if (!a) return undefined;
  return {
    runId: a.runId,
    status: a.status,
    source: a.source,
    reportId: a.reportId,
    plan: a.plan,
    participants: a.participants,
    sources: a.sources as never,
    findings: a.findings.map((f) => ({ ...f, category: `${f.area} · ${f.severity}`, importance: f.severity, sourceType: f.sourceType })) as never,
    crosschecks: a.crosschecks,
    usage: a.usage,
    aiCalls: a.aiCalls,
    notAnalyzed: a.notAnalyzed,
    tools: null,
    policyIssues: a.policyIssues,
  };
}

const AREAS = ['all', 'seo', 'social', 'brand', 'messaging', 'presence'] as const;
const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Findings of the five auditors: filter by area, severity, evidence class and text. Every row shows provenance. */
export function FindingsTab({ analysis }: { analysis: AuditAnalysis | undefined }) {
  const [area, setArea] = React.useState<(typeof AREAS)[number]>('all');
  const [sev, setSev] = React.useState<Severity | 'all'>('all');
  const [cls, setCls] = React.useState<EvidenceStatus | 'all'>('all');
  const [q, setQ] = React.useState('');
  const all = analysis?.findings ?? [];
  if (!all.length) return <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">No findings yet.</p>;
  const rows = all
    .filter((f) => (area === 'all' || f.area === area) && (sev === 'all' || f.severity === sev) && (cls === 'all' || f.classification === cls) && (!q || `${f.title} ${f.statement}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {AREAS.map((a) => (
          <button key={a} onClick={() => setArea(a)} className={cn('rounded-full border px-3 py-1 capitalize', area === a ? 'border-ink bg-ink text-cream-100' : 'border-cream-300 bg-cream-50 text-ink-600')}>
            {a === 'all' ? `All (${all.length})` : `${a} (${all.filter((f) => f.area === a).length})`}
          </button>
        ))}
        <select aria-label="Filter by severity" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1" value={sev} onChange={(e) => setSev(e.target.value as Severity | 'all')}>
          <option value="all">Any severity</option>
          {SEV_ORDER.map((s) => (
            <option key={s} value={s}>
              {SEVERITY[s].label}
            </option>
          ))}
        </select>
        <select aria-label="Filter by evidence class" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1" value={cls} onChange={(e) => setCls(e.target.value as EvidenceStatus | 'all')}>
          <option value="all">Any evidence class</option>
          {(['verified', 'claimed', 'inferred', 'disputed', 'unknown'] as const).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label className="relative ml-auto">
          <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted" />
          <input aria-label="Search findings" className="rounded-lg border border-cream-300 bg-cream-50 py-1 pl-7 pr-2" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <ul className="space-y-2">
        {rows.map((f) => (
          <AuditFindingRow key={f.id} f={f} sources={analysis!.sources} />
        ))}
      </ul>
      {rows.length === 0 && <p className="text-sm text-muted">No findings match this filter.</p>}
    </div>
  );
}

export function AuditFindingRow({ f, sources }: { f: AuditFindingData; sources: AuditAnalysis['sources'] }) {
  const src = f.sourceId ? sources.find((s) => s.id === f.sourceId) : undefined;
  return (
    <li className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <EvidenceBadge status={f.classification} />
        <span className="font-medium">{f.title}</span>
        <span className="ml-auto font-mono text-[11px] text-muted">
          {f.id} · {f.agent} · {f.kind.replace('_', ' ')}
        </span>
      </div>
      <p className="mt-1.5">{f.statement}</p>
      {f.excerpt && <p className="mt-1 border-l-2 border-accent/50 pl-2 text-xs italic text-ink-600">“{f.excerpt}”</p>}
      <p className="mt-1 text-xs text-muted">
        Source: {src ? <>{src.label} <OriginBadge origin={src.origin} /></> : f.sourceType.replace('_', ' ')}
        {f.locator ? ` · ${f.locator}` : ''}
        {f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ''}
      </p>
      {f.recommendation && <p className="mt-1 text-xs"><strong>Suggested fix:</strong> {f.recommendation}</p>}
      {f.adjustment && <p className="mt-1 text-xs text-amber-800">Adjusted by LaunchPilot: {f.adjustment}</p>}
      {f.crosscheck.status !== 'not_requested' && (
        <p className="mt-1 text-xs text-muted">
          Cross-check: {f.crosscheck.status}
          {f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : ''}
        </p>
      )}
    </li>
  );
}

/** Overview: F1 reference, plan, sources with their access type, and limitations. */
export function AuditOverviewTab({ analysis }: { analysis: AuditAnalysis | undefined }) {
  if (!analysis?.plan) return <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">The activation plan appears as soon as the audit starts.</p>;
  return (
    <div className="space-y-5">
      {analysis.f1 && (
        <p className="rounded-xl bg-cream-100 px-4 py-3 text-xs text-ink-600">
          Built on Product Discovery report <span className="font-mono">{analysis.f1.reportId}</span> (schema v{analysis.f1.schemaVersion}
          {analysis.f1.partial ? ', partial' : ''}).
        </p>
      )}
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
        <ul className="divide-y divide-cream-300/70 rounded-xl border border-cream-300/80 bg-cream-50 text-sm">
          {analysis.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <Badge className={s.status === 'retrieved' ? 'bg-emerald-100 text-emerald-800' : s.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-cream-200 text-ink-600'}>{s.status}</Badge>
              <span className="min-w-0 flex-1 truncate" title={s.url ?? s.label}>
                <span className="font-mono text-xs text-muted">{s.kind}</span> {s.label}
              </span>
              <OriginBadge origin={s.origin} />
              {s.httpStatus ? <span className="text-xs text-muted">HTTP {s.httpStatus}</span> : null}
              {s.injectionSuspected && <Badge className="bg-amber-100 text-amber-800">instructions in content ignored</Badge>}
              {(s.error || s.notes.length > 0) && <span className="basis-full text-xs text-muted">{[s.error, ...s.notes].filter(Boolean).join(' · ')}</span>}
            </li>
          ))}
        </ul>
      </div>

      {analysis.notAnalyzed.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Audit limitations</h5>
          <ul className="list-disc space-y-1 pl-5 text-sm marker:text-accent">
            {analysis.notAnalyzed.map((n, i) => (
              <li key={i}>{n.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
