'use client';

import { CheckCircle2, CircleDashed, GitFork, Sparkles, UserPlus } from 'lucide-react';
import { OriginBadge } from '@/components/audit-views';
import { EvidenceBadge } from '@/components/evidence-ui';
import { Badge } from '@/components/ui/badge';
import type { RunAnalysis, StrategyAnalysis, StrategyFindingData } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Lets the shared F1/F2 Agents and Cross-Checks views render an F3 run (same events, same shape). */
export function toRunAnalysis(a: StrategyAnalysis | undefined): RunAnalysis | undefined {
  if (!a) return undefined;
  return {
    runId: a.runId,
    status: a.status,
    source: a.source,
    reportId: a.reportId,
    plan: a.plan as never,
    participants: a.participants,
    sources: a.sources as never,
    findings: a.findings.map((f) => ({ ...f, category: `${f.area}${f.channel ? ` · ${f.channel}` : ''}`, importance: f.importance, sourceType: f.sourceType })) as never,
    crosschecks: a.crosschecks,
    usage: a.usage,
    aiCalls: a.aiCalls,
    notAnalyzed: a.notAnalyzed,
    tools: null,
    policyIssues: a.policyIssues,
  };
}

const Empty = ({ text }: { text: string }) => <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">{text}</p>;

const Chips = ({ items, className }: { items: string[]; className?: string }) =>
  items.length ? (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <li key={i} className={cn('rounded-full bg-cream-100 px-2.5 py-0.5 text-xs text-ink-600', className)}>
          {t}
        </li>
      ))}
    </ul>
  ) : null;

const FIT: Record<string, string> = { strong: 'bg-emerald-100 text-emerald-800', moderate: 'bg-amber-100 text-amber-800', weak: 'bg-red-100 text-red-700', unsuitable: 'bg-red-200 text-red-800', unknown: 'bg-cream-200 text-ink-600' };
const ROLE: Record<string, string> = { primary: 'bg-accent text-white', secondary: 'bg-ink text-cream-100', test: 'bg-cream-200 text-ink-600', skip: 'bg-cream-100 text-muted' };

const crosscheckLine = (f: StrategyFindingData) =>
  f.crosscheck.status === 'not_requested' ? null : (
    <p className="mt-1 text-xs text-muted">
      Cross-check: {f.crosscheck.status}
      {f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : ''}
    </p>
  );

function Provenance({ f, a }: { f: StrategyFindingData; a: StrategyAnalysis }) {
  const src = f.sourceId ? a.sources.find((s) => s.id === f.sourceId) : undefined;
  return (
    <p className="mt-1 text-xs text-muted">
      <span className="font-mono">{f.id}</span> · {f.agent} · {f.kind.replace('_', ' ')} · source: {src ? <>{src.label} <OriginBadge origin={src.origin} /></> : f.sourceType.replace('_', ' ')}
      {f.locator ? ` · ${f.locator}` : ''}
      {f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ''}
    </p>
  );
}

// ---- Overview: the prerequisite chain and the DYNAMIC Mozaik participants ----------------------------------------------------------------

export function StrategyOverviewTab({ analysis, running }: { analysis: StrategyAnalysis | undefined; running: boolean }) {
  if (!analysis?.plan) return <Empty text="The activation plan appears as soon as the run starts." />;
  const base = analysis.plan.activated.filter((a) => !a.dynamic);
  const registered = analysis.scoutDecisions.filter((d) => d.selected);
  const notCreated = analysis.scoutDecisions.filter((d) => !d.selected);
  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap items-stretch gap-2 text-xs">
        {[
          { label: 'F1 Product Discovery', id: analysis.f1?.reportId, extra: analysis.f1 ? `${analysis.f1.ageDays ?? '?'} d old${analysis.f1.partial ? ' · partial' : ''}` : null },
          { label: 'F2 Marketing Audit', id: analysis.f2?.auditId, extra: analysis.f2 ? `${analysis.f2.ageDays ?? '?'} d old${analysis.f2.partial ? ' · partial' : ''}` : null },
          { label: 'F3 Market Research & Strategy', id: analysis.reportId, extra: analysis.status.toLowerCase() },
        ].map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            {i > 0 && <span className="text-muted">→</span>}
            <span className="rounded-lg border border-cream-300 bg-cream-50 px-3 py-2">
              <strong className="block text-[13px]">{s.label}</strong>
              <span className="font-mono text-[10px] text-muted">{s.id ?? 'in progress'}</span>
              {s.extra && <span className="block text-[11px] text-muted">{s.extra}</span>}
            </span>
          </li>
        ))}
      </ol>

      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Base participants ({base.length})</h5>
        <ul className="grid gap-2 sm:grid-cols-2">
          {base.map((a) => (
            <li key={a.key} className="rounded-lg bg-emerald-50 px-3 py-2 text-sm">
              <strong>{a.agent}</strong>
              <span className="block text-xs text-muted">{a.reason}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-2xl border border-accent/30 bg-accent-soft/20 p-4">
        <h5 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <GitFork className="h-4 w-4 text-accent" /> Channel Scouts created at run time ({registered.length})
        </h5>
        <p className="mb-3 text-xs text-muted">
          These participants did not exist when the run started. After the research, the Strategy Coordinator evaluated every channel with transparent rules, created only the relevant scouts and joined them to the live Mozaik runtime (<code>participant.registered</code>).
        </p>
        {registered.length === 0 ? (
          <p className="text-sm text-muted">{running ? 'Waiting for the three researchers to finish: then the coordinator decides which scouts to create.' : 'No scout was created for this run.'}</p>
        ) : (
          <ul className="space-y-2">
            {registered.map((d) => (
              <li key={d.channel} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <UserPlus className="h-4 w-4 text-emerald-600" />
                  <strong>{d.name}</strong>
                  <Badge className="bg-emerald-100 text-emerald-800">registered · score {d.score}</Badge>
                  <span className="ml-auto text-xs text-muted">{analysis.participants.find((p) => p.agent === d.name)?.state ?? 'working'}</span>
                </div>
                <Chips items={d.ruleHits} className="mt-2" />
              </li>
            ))}
          </ul>
        )}
        {notCreated.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted">Not created ({notCreated.length}) and why</summary>
            <ul className="mt-2 space-y-1.5 text-sm">
              {notCreated.map((d) => (
                <li key={d.channel} className="rounded-lg bg-cream-100 px-3 py-2">
                  <strong>{d.name}</strong> <span className="text-xs text-muted">score {d.score}</span>
                  <span className="block text-xs text-muted">{d.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
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
              {s.injectionSuspected && <Badge className="bg-amber-100 text-amber-800">instructions in content ignored</Badge>}
              {(s.error || s.notes.length > 0) && <span className="basis-full text-xs text-muted">{[s.error, ...s.notes].filter(Boolean).join(' · ')}</span>}
            </li>
          ))}
        </ul>
      </div>

      {analysis.notAnalyzed.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Limitations</h5>
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

// ---- Audience ---------------------------------------------------------------------------------------------------------------------------

export function AudienceTab({ analysis }: { analysis: StrategyAnalysis | undefined }) {
  const rows = (analysis?.findings ?? []).filter((f) => f.area === 'audience');
  if (!analysis || !rows.length) return <Empty text="No audience findings yet." />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Segments are hypotheses unless a source supports them. No interviews, surveys or market sizes are invented.</p>
      <ul className="space-y-3">
        {rows.map((f) =>
          f.segment ? (
            <li key={f.id} className="rounded-2xl border border-cream-300/80 bg-cream-50 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-base">{f.segment.name}</strong>
                <Badge className="bg-indigo-100 text-indigo-800 uppercase">{f.segment.kind}</Badge>
                <Badge className={FIT[f.segment.productFit]}>product fit: {f.segment.productFit}</Badge>
                <span className="ml-auto"><EvidenceBadge status={f.classification} /></span>
              </div>
              <p className="mt-2">{f.statement}</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {([['Needs', f.segment.needs], ['Pain points', f.segment.painPoints], ['Motivations', f.segment.motivations], ['Barriers to buying', f.segment.barriers], ['How they like to be addressed', f.segment.messagingPreferences]] as [string, string[]][]).map(([k, v]) =>
                  v.length ? (
                    <div key={k}>
                      <dt className="mb-1 text-xs uppercase tracking-wider text-muted">{k}</dt>
                      <dd><Chips items={v} /></dd>
                    </div>
                  ) : null,
                )}
                {f.segment.decisionProcess && (
                  <div className="sm:col-span-2">
                    <dt className="mb-1 text-xs uppercase tracking-wider text-muted">Decision process</dt>
                    <dd>{f.segment.decisionProcess}</dd>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-xs text-ink-600"><strong>Why:</strong> {f.reasoning}</p>
              <Provenance f={f} a={analysis} />
              {crosscheckLine(f)}
            </li>
          ) : (
            <li key={f.id} className="rounded-xl bg-cream-100/70 px-4 py-3 text-sm">
              <div className="flex items-center gap-2"><EvidenceBadge status={f.classification} /><strong>{f.title}</strong></div>
              <p className="mt-1">{f.statement}</p>
              {f.recommendation && <p className="mt-1 text-xs"><strong>Suggested:</strong> {f.recommendation}</p>}
              <Provenance f={f} a={analysis} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ---- Competitors --------------------------------------------------------------------------------------------------------------------------

export function CompetitorsTab({ analysis }: { analysis: StrategyAnalysis | undefined }) {
  const rows = (analysis?.findings ?? []).filter((f) => f.area === 'competitor');
  if (!analysis || !rows.length) return <Empty text="No competitor findings yet." />;
  const search = analysis.sources.filter((s) => s.kind === 'search_result');
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        A competitor is <strong>confirmed</strong> only when one of its own pages was retrieved in this run. Search results are leads. {search.length === 0 ? 'No search results were used.' : `${search.filter((s) => s.status === 'retrieved').length} search lead(s) were retrieved.`}
      </p>
      <ul className="space-y-3">
        {rows.map((f) =>
          f.competitor ? (
            <li key={f.id} className="rounded-2xl border border-cream-300/80 bg-cream-50 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-base">{f.competitor.name}</strong>
                <Badge className={f.competitor.existence === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>{f.competitor.existence === 'confirmed' ? 'confirmed from a retrieved page' : 'unconfirmed lead'}</Badge>
                <Badge className="bg-cream-200 text-ink-600">{f.competitor.relation}</Badge>
                {f.competitor.crowdedTheme && <Badge className="bg-red-100 text-red-700">crowded theme: {f.competitor.crowdedTheme}</Badge>}
                <span className="ml-auto"><EvidenceBadge status={f.classification} /></span>
              </div>
              {f.competitor.url && <p className="mt-1 truncate font-mono text-[11px] text-muted">{f.competitor.url}</p>}
              <p className="mt-2">{f.statement}</p>
              {f.competitor.positioning && <p className="mt-1 text-xs"><strong>Positioning:</strong> {f.competitor.positioning}</p>}
              {f.excerpt && <p className="mt-1 border-l-2 border-accent/50 pl-2 text-xs italic text-ink-600">“{f.excerpt}”</p>}
              <Chips items={f.competitor.offerings} className="mt-2" />
              <p className="mt-2 text-xs text-ink-600"><strong>Why:</strong> {f.reasoning}</p>
              <Provenance f={f} a={analysis} />
              {crosscheckLine(f)}
            </li>
          ) : (
            <li key={f.id} className="rounded-xl bg-cream-100/70 px-4 py-3 text-sm">
              <div className="flex items-center gap-2"><EvidenceBadge status={f.classification} /><strong>{f.title}</strong></div>
              <p className="mt-1">{f.statement}</p>
              {f.recommendation && <p className="mt-1 text-xs"><strong>Suggested:</strong> {f.recommendation}</p>}
              <Provenance f={f} a={analysis} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ---- Channels (the scouts) -----------------------------------------------------------------------------------------------------------------

export function ChannelsTab({ analysis }: { analysis: StrategyAnalysis | undefined }) {
  const rows = (analysis?.findings ?? []).filter((f) => f.channelEval);
  if (!analysis || (!rows.length && !analysis.scoutDecisions.length)) return <Empty text="Channel scouts are created after the research finishes." />;
  return (
    <div className="space-y-5">
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-cream-300/80 bg-cream-50">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr><th className="px-3 py-2">Scout</th><th className="px-2">Fit</th><th className="px-2">Role</th><th className="px-2">Organic</th><th className="px-2">Paid</th><th className="px-2">Effort</th><th className="px-2">Evidence</th></tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="border-t border-cream-300/60 align-top">
                  <td className="px-3 py-2 font-medium">{f.agent}</td>
                  <td className="px-2"><Badge className={FIT[f.channelEval!.fit]}>{f.channelEval!.fit}</Badge></td>
                  <td className="px-2"><Badge className={ROLE[f.channelEval!.role]}>{f.channelEval!.role}</Badge></td>
                  <td className="px-2">{f.channelEval!.organicSuitability}</td>
                  <td className="px-2">{f.channelEval!.paidSuitability}</td>
                  <td className="px-2">{f.channelEval!.complexity}</td>
                  <td className="px-2"><EvidenceBadge status={f.classification} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="grid gap-3 lg:grid-cols-2">
        {rows.map((f) => (
          <li key={f.id} className="rounded-2xl border border-cream-300/80 bg-cream-50 p-4 text-sm">
            <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" /><strong>{f.agent}</strong></div>
            <p className="mt-2">{f.statement}</p>
            <p className="mt-1 text-xs text-muted">Audience fit: {f.channelEval!.audienceFit}</p>
            {([['Content types', f.channelEval!.contentTypes], ['Constraints', f.channelEval!.constraints], ['How to measure', f.channelEval!.measurement], ['Risks', f.channelEval!.risks]] as [string, string[]][]).map(([k, v]) =>
              v.length ? (
                <div key={k} className="mt-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wider text-muted">{k}</p>
                  <Chips items={v} />
                </div>
              ) : null,
            )}
            <p className="mt-2 text-xs text-ink-600"><strong>Why:</strong> {f.reasoning}</p>
            <Provenance f={f} a={analysis} />
            {crosscheckLine(f)}
          </li>
        ))}
      </ul>
      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Why these channels (eligibility rules for all {analysis.scoutDecisions.length})</h5>
        <ul className="space-y-1.5 text-sm">
          {analysis.scoutDecisions.map((d) => (
            <li key={d.channel} className={cn('rounded-lg px-3 py-2', d.selected ? 'bg-emerald-50' : 'bg-cream-100')}>
              <div className="flex items-center gap-2">
                {d.selected ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleDashed className="h-4 w-4 text-muted-dark" />}
                <strong>{d.name}</strong>
                <span className="text-xs text-muted">score {d.score}</span>
              </div>
              <p className="text-xs text-muted">{d.reason}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
