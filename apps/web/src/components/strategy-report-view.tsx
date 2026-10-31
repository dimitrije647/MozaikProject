'use client';

import { AlertTriangle, BarChart3, Boxes, CalendarRange, Compass, Download, FileSearch, Flag, Layers, ListChecks, Megaphone, MessagesSquare, Radio, Swords, Target, TriangleAlert, Users } from 'lucide-react';
import { EvidenceBadge, EvidenceLegend, Section } from '@/components/evidence-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { StrategyFull, StrategyStatementData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const ROLE: Record<string, string> = { primary: 'bg-accent text-white', secondary: 'bg-ink text-cream-100', test: 'bg-cream-200 text-ink-600' };
const FIT: Record<string, string> = { strong: 'bg-emerald-100 text-emerald-800', moderate: 'bg-amber-100 text-amber-800', weak: 'bg-red-100 text-red-700', unsuitable: 'bg-red-200 text-red-800' };

const Ids = ({ ids }: { ids: string[] }) => (ids.length ? <span className="font-mono text-[11px] text-muted"> · {ids.join(' ')}</span> : null);

function Statement({ s }: { s: StrategyStatementData }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <EvidenceBadge status={s.status} />
      <span className="min-w-0">
        <span className="block">{s.text}</span>
        {s.caveat && <span className="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">Caveat: {s.caveat}</span>}
        <span className="block text-xs text-muted">
          {s.basis}
          <Ids ids={s.findingIds} />
        </span>
      </span>
    </div>
  );
}

const Bullets = ({ items, empty }: { items: string[]; empty: string }) =>
  items.length ? (
    <ul className="list-disc space-y-1 pl-5 text-sm marker:text-accent">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted">{empty}</p>
  );

/** The Campaign Strategy Report: 20 sections. Sections 2-4, 6, 8, 10, 18 and 20's identity/palette/provenance are filled from collected data, not written by a model. */
export function StrategyReportView({ data }: { data: StrategyFull }) {
  const r = data.report;
  const m = data.metadata;
  const brief = r.creativeBrief;
  const download = () => {
    const blob = new Blob([JSON.stringify(brief, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `f4-creative-brief-${data.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {m.tools?.fixtureSources && <p role="status" className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">FIXTURE MODE: the external sources of this run are test data, not real evidence.</p>}
      {r.partial && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Partial strategy: {m.participants.filter((p) => p.state === 'failed' || p.state === 'timed_out').map((p) => p.agent).join(', ')} did not finish. Their areas are incomplete, not guessed.
        </p>
      )}
      {r.existingMarketing.stale && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          The Marketing Audit this strategy rests on is {r.existingMarketing.ageDays} days old and may not reflect today's website and profiles.
        </p>
      )}
      <EvidenceLegend />

      <section className="rounded-2xl bg-ink p-6 text-cream-100">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">1 · Executive summary</p>
        <h3 className="mt-2 text-3xl text-cream-100">{r.productContext.name}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-cream-100/90">{r.executiveSummary}</p>
        <p className="mt-3 text-xs text-cream-100/70">
          Strategy only: no advertisements, copy or images. Built on F1 <span className="font-mono">{r.productContext.f1ReportId}</span> and F2 <span className="font-mono">{r.existingMarketing.f2AuditId}</span>. No result is promised.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="2 · Product context (from Product Discovery)" icon={Boxes}>
          <p className="text-sm">{r.productContext.summary}</p>
          <dl className="mt-3 space-y-1 text-sm">
            <div><dt className="inline text-xs uppercase tracking-wider text-muted">Category </dt><dd className="inline">{r.productContext.category}</dd></div>
            <div><dt className="inline text-xs uppercase tracking-wider text-muted">Offering </dt><dd className="inline">{r.productContext.offering}</dd></div>
            <div><dt className="inline text-xs uppercase tracking-wider text-muted">Geography </dt><dd className="inline">{r.productContext.geography.join(', ') || 'Unknown'}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-muted">F1 confidence {Math.round(r.productContext.f1Confidence * 100)}%</p>
        </Section>

        <Section title="3 · Existing marketing situation (from the audit)" icon={FileSearch}>
          <Bullets items={r.existingMarketing.notes} empty="" />
          <ul className="mt-2 space-y-1.5 text-sm">
            {r.existingMarketing.mainProblems.map((p, i) => (
              <li key={i} className="flex items-start gap-2"><EvidenceBadge status={p.status} /><span>{p.title} <span className="text-xs text-muted">({p.severity}, {p.area})</span></span></li>
            ))}
            {r.existingMarketing.mainProblems.length === 0 && <li className="text-muted">The audit documented no main problems.</li>}
          </ul>
        </Section>

        <Section title="4 · Audience research" icon={Users}>
          {r.audienceResearch.length === 0 ? (
            <p className="text-sm text-muted">No segments were produced.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {r.audienceResearch.map((a) => (
                <li key={a.ref.findingId} className="flex items-start gap-2">
                  <EvidenceBadge status={a.status} />
                  <span><strong>{a.segment.name}</strong> <span className="text-xs uppercase text-muted">{a.segment.kind} · fit {a.segment.productFit}</span><span className="block text-xs text-muted">{a.statement}<Ids ids={[a.ref.findingId]} /></span></span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Segments are hypotheses unless the evidence says otherwise.</p>
        </Section>

        <Section title="5 · Customer segments (priorities)" icon={Target}>
          {r.priorityAudiences.length === 0 ? <p className="text-sm text-muted">No priority audiences.</p> : (
            <ul className="space-y-2 text-sm">
              {r.priorityAudiences.map((a, i) => (
                <li key={i} className="flex items-start gap-2"><Badge className={ROLE[a.priority === 'later' ? 'test' : a.priority]}>{a.priority}</Badge><span><strong>{a.segmentName}</strong><span className="block text-xs text-muted">{a.rationale}<Ids ids={a.findingIds} /></span></span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="6 · Competitor landscape" icon={Swords} className="lg:col-span-2">
          <p className="mb-2 text-xs text-muted">
            Search: {r.competitorLandscape.searchUsed ? r.competitorLandscape.searchProvider : 'not performed'} · {r.competitorLandscape.userSuppliedUrls} URL(s) and {r.competitorLandscape.userSuppliedNames ?? 0} name(s) supplied by you · {r.competitorLandscape.pagesRetrieved ?? 0} page(s) read. A competitor is confirmed only when its own page was retrieved.
          </p>
          {(r.competitorLandscape.sitesRead?.length ?? 0) > 0 && (
            <ul className="mb-3 space-y-1 text-xs text-muted">
              {r.competitorLandscape.sitesRead!.map((site) => (
                <li key={`${site.host ?? site.name}-${site.origin}`}>
                  <strong className="text-ink">{site.name}</strong>{site.host ? ` (${site.host})` : ''}: {site.pages} page(s){site.via === 'extract' ? ', read through the extraction API' : ''} · from {site.origin === 'user_supplied' ? 'your URL' : site.origin === 'user_named' ? 'your name lookup' : 'a search lead'} · links to {site.socialPlatforms.length ? site.socialPlatforms.join(', ') : 'no social network'} on its site
                </li>
              ))}
            </ul>
          )}
          {(r.competitorLandscape.namesNotFound?.length ?? 0) > 0 && <p className="mb-2 text-xs text-muted">No website was found for: {r.competitorLandscape.namesNotFound!.join(', ')}. They were not analyzed (add their URLs to include them).</p>}
          {r.competitorLandscape.profiles.length === 0 ? <p className="text-sm text-muted">No competitor could be identified from retrieved sources. None is invented.</p> : (
            <ul className="space-y-2 text-sm">
              {r.competitorLandscape.profiles.map((p) => (
                <li key={p.ref.findingId} className="flex items-start gap-2">
                  <EvidenceBadge status={p.status} />
                  <span><strong>{p.competitor.name}</strong> <Badge className={p.competitor.existence === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>{p.competitor.existence}</Badge> <span className="text-xs text-muted">{p.competitor.relation}</span>{p.competitor.crowdedTheme && <Badge className="ml-1 bg-red-100 text-red-700">crowded: {p.competitor.crowdedTheme}</Badge>}<span className="block text-xs text-muted">{p.statement}<Ids ids={[p.ref.findingId]} /></span></span>
                </li>
              ))}
            </ul>
          )}
          {r.competitorLandscape.gaps.length > 0 && <div className="mt-3"><p className="mb-1 text-xs uppercase tracking-wider text-muted">Research gaps</p><Bullets items={r.competitorLandscape.gaps} empty="" /></div>}
        </Section>

        <Section title="7 · Competitive positioning" icon={Compass} className="lg:col-span-2">
          <Statement s={r.positioning.statement} />
          {r.positioning.differentiators.length > 0 && <div className="mt-3 space-y-2"><p className="text-xs uppercase tracking-wider text-muted">Differentiators</p>{r.positioning.differentiators.map((d, i) => <Statement key={i} s={d} />)}</div>}
          {r.positioning.crowdedThemesToAvoid.length > 0 && <div className="mt-3"><p className="mb-1 text-xs uppercase tracking-wider text-muted">Crowded themes: not a unique advantage</p><Bullets items={r.positioning.crowdedThemesToAvoid} empty="" /></div>}
        </Section>

        <Section title="8 · Channel evaluation (by the Channel Scouts)" icon={Radio} className="lg:col-span-2">
          {r.channelEvaluation.evaluated.length === 0 ? <p className="text-sm text-muted">No Channel Scout evaluated a channel.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted"><tr><th className="py-1 pr-3">Scout</th><th className="pr-3">Fit</th><th className="pr-3">Role</th><th className="pr-3">Organic</th><th className="pr-3">Paid</th><th className="pr-3">Effort</th><th>Evidence</th></tr></thead>
                <tbody>
                  {r.channelEvaluation.evaluated.map((e) => (
                    <tr key={e.ref.findingId} className="border-t border-cream-300/60 align-top"><td className="py-1 pr-3 font-medium">{e.scout}</td><td className="pr-3"><Badge className={FIT[e.evaluation.fit]}>{e.evaluation.fit}</Badge></td><td className="pr-3">{e.evaluation.role}</td><td className="pr-3">{e.evaluation.organicSuitability}</td><td className="pr-3">{e.evaluation.paidSuitability}</td><td className="pr-3">{e.evaluation.complexity}</td><td><EvidenceBadge status={e.status} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.channelEvaluation.notSelected.length > 0 && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">{r.channelEvaluation.notSelected.length} channel(s) without a scout, and why</summary><ul className="mt-2 space-y-1">{r.channelEvaluation.notSelected.map((n) => <li key={n.channel}><strong className="text-ink">{n.channel}</strong>: {n.reason}</li>)}</ul></details>}
        </Section>

        <Section title="9 · Selected marketing channels" icon={Megaphone} className="lg:col-span-2">
          {r.channels.length === 0 ? <p className="text-sm text-muted">No channel is recommended (no scout evaluated one).</p> : (
            <ul className="space-y-3 text-sm">
              {r.channels.map((c) => (
                <li key={c.channel} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2"><strong className="capitalize">{c.channel.replace('_', ' ')}</strong><Badge className={ROLE[c.role]}>{c.role}</Badge><span className="text-xs text-muted">{c.approach}</span></div>
                  <p className="mt-1">{c.rationale}</p>
                  {c.formats.length > 0 && <p className="mt-1 text-xs text-muted">Formats: {c.formats.join(', ')}</p>}
                  <p className="text-xs"><Ids ids={c.findingIds} /></p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="10 · Seasonal opportunities" icon={CalendarRange}>
          <p className="mb-2 text-xs text-muted">{r.seasonalOpportunities.holidayCalendar.note}</p>
          {r.seasonalOpportunities.opportunities.length === 0 ? <p className="text-sm text-muted">No seasonal opportunity was identified.</p> : (
            <ul className="space-y-2 text-sm">
              {r.seasonalOpportunities.opportunities.map((o) => (
                <li key={o.ref.findingId} className="flex items-start gap-2"><EvidenceBadge status={o.status} /><span><strong>{o.opportunity.name}</strong> <span className="text-xs text-muted">{o.opportunity.window} · {o.opportunity.dateBasis.replace(/_/g, ' ')}{o.opportunity.leadTimeWeeks != null ? ` · plan ${o.opportunity.leadTimeWeeks} weeks ahead` : ''}</span><span className="block text-xs text-muted">{o.opportunity.relevance}<Ids ids={[o.ref.findingId]} /></span></span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="11 · Campaign goals" icon={Flag}>
          {r.campaignGoals.length === 0 ? <p className="text-sm text-muted">No goals.</p> : (
            <ul className="space-y-2 text-sm">{r.campaignGoals.map((g, i) => <li key={i}><strong>{g.goal}</strong><span className="block text-xs text-muted">Measured by: {g.measuredBy}. {g.rationale}<Ids ids={g.findingIds} /></span></li>)}</ul>
          )}
        </Section>

        <Section title="12 · Messaging direction" icon={MessagesSquare}>
          <Statement s={r.valueProposition} />
          <ul className="mt-3 space-y-2 text-sm">{r.mainMessages.map((x, i) => <li key={i}><strong>{x.message}</strong><span className="block text-xs text-muted">For: {x.audience}{x.proofNeeded.length ? ` · proof needed: ${x.proofNeeded.join('; ')}` : ''}<Ids ids={x.findingIds} /></span></li>)}</ul>
        </Section>

        <Section title="13 · Content pillars" icon={Layers}>
          {r.contentPillars.length === 0 ? <p className="text-sm text-muted">None.</p> : <ul className="space-y-2 text-sm">{r.contentPillars.map((p, i) => <li key={i}><strong>{p.name}</strong><span className="block text-xs text-muted">{p.description}{p.channels.length ? ` · ${p.channels.join(', ')}` : ''}<Ids ids={p.findingIds} /></span></li>)}</ul>}
        </Section>

        <Section title="14 · Organic and paid approach" icon={BarChart3}>
          <p className="text-sm">{r.organicPaid.approach}</p>
          <p className="mt-2 text-xs text-muted">Role of paid: {r.organicPaid.paidRole}</p>
          <p className="mt-1 text-xs text-muted">Budget: {r.organicPaid.budgetNote}</p>
        </Section>

        <Section title="15 · Suggested timeline" icon={CalendarRange} className="lg:col-span-2">
          <ul className="space-y-2 text-sm">{r.timing.map((t, i) => <li key={`t${i}`}><strong>{t.window}</strong> <span className="text-xs text-muted">{t.dateBasis.replace(/_/g, ' ')}</span><span className="block text-xs text-muted">{t.rationale}<Ids ids={t.findingIds} /></span></li>)}</ul>
          {r.campaignStructure.length > 0 && (
            <ol className="mt-3 grid gap-2 sm:grid-cols-2">
              {r.campaignStructure.map((p, i) => <li key={i} className="rounded-xl bg-cream-100 px-3 py-2 text-sm"><strong>{i + 1}. {p.phase}</strong> <span className="text-xs text-muted">{p.duration}</span><span className="block text-xs">{p.objective}</span><span className="block text-xs text-muted">{p.activities.join(' · ')}</span></li>)}
            </ol>
          )}
        </Section>

        <Section title="16 · KPIs to measure (no promised targets)" icon={ListChecks}>
          {r.kpis.length === 0 ? <p className="text-sm text-muted">None.</p> : <ul className="space-y-1.5 text-sm">{r.kpis.map((k, i) => <li key={i}><strong>{k.kpi}</strong><span className="block text-xs text-muted">{k.channel ? `${k.channel} · ` : ''}measured by {k.measuredBy}</span></li>)}</ul>}
        </Section>

        <Section title="17 · Risks and unknowns" icon={TriangleAlert}>
          <ul className="space-y-1.5 text-sm">{r.risks.map((k, i) => <li key={i}><strong>{k.risk}</strong><span className="block text-xs text-muted">Mitigation: {k.mitigation}<Ids ids={k.findingIds} /></span></li>)}</ul>
          <p className="mb-1 mt-3 text-xs uppercase tracking-wider text-muted">Open questions</p>
          <Bullets items={r.openQuestions} empty="None." />
          <p className="mb-1 mt-3 text-xs uppercase tracking-wider text-muted">Limitations</p>
          <Bullets items={[...r.limitations, ...r.additionalLimitations]} empty="None." />
        </Section>

        <Section title="18 · Evidence and cross-checks" icon={FileSearch} className="lg:col-span-2">
          <p className="text-sm">{r.evidence.findingCount} findings · {Object.entries(r.evidence.byStatus).map(([k, v]) => `${v} ${k}`).join(' · ')} · {r.evidence.crosschecks.length} claim(s) reviewed by a different participant ({r.evidence.crosschecks.filter((c) => c.verdict === 'agree').length} agreed, {r.evidence.crosschecks.filter((c) => c.verdict === 'disagree').length} disagreed).</p>
          {r.disagreements.length > 0 && (
            <ul className="mt-3 space-y-2">
              {r.disagreements.map((d, i) => (
                <li key={i} className={cn('rounded-xl border px-4 py-3 text-sm', d.resolved ? 'border-cream-300 bg-cream-50' : 'border-red-200 bg-red-50/60')}>
                  <strong>{d.topic}</strong> <Badge className={d.resolved ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}>{d.resolved ? 'resolved' : 'unresolved'}</Badge>
                  <ul className="mt-1 list-disc pl-5 text-xs text-ink-600">{d.positions.map((p, j) => <li key={j}>{p}</li>)}</ul>
                  <p className="mt-1 text-xs">{d.resolution}<Ids ids={d.findingIds} /></p>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-3"><summary className="cursor-pointer text-sm text-muted">{r.evidence.sources.length} sources with access type · {r.evidence.findings.length} findings</summary>
            <ul className="mt-2 space-y-1 text-xs">{r.evidence.sources.map((s) => <li key={s.id}><span className="font-mono">{s.id}</span> {s.kind} · {s.label} · <strong>{s.origin}</strong> · {s.status}</li>)}</ul>
          </details>
        </Section>

        <Section title="19 · Strategic priorities" icon={Flag}>
          <ol className="space-y-2 text-sm">{r.strategicPriorities.map((p, i) => <li key={i}><strong>{i + 1}. {p.priority}</strong><span className="block text-xs text-muted">{p.rationale}<Ids ids={p.findingIds} /></span></li>)}</ol>
        </Section>

        <Section title="20 · F4 Creative Brief (hand-off)" icon={Boxes} className="lg:col-span-2">
          <p className="mb-3 text-xs text-muted">Machine-readable input for the creative phase. It contains direction and constraints, no finished copy or images.</p>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs uppercase tracking-wider text-muted">Objective</dt><dd>{brief.objective}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Audience</dt><dd>{brief.audiencePrimary}{brief.audienceSecondary.length ? ` · also ${brief.audienceSecondary.join('; ')}` : ''}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Messaging priorities</dt><dd>{brief.messagingPriorities.join('; ')}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Tone</dt><dd>{brief.toneOfVoice ?? 'Not specified'}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Channels and formats</dt><dd>{brief.channels.map((c) => `${c.channel}: ${c.formats.join(', ')}`).join(' | ') || 'None'}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Deliverables</dt><dd>{brief.deliverables.map((d) => `${d.count} × ${d.type}${d.channel ? ` (${d.channel})` : ''}`).join('; ') || 'None'} · {brief.suggestedConceptCount} original concept(s)</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Visual direction</dt><dd>{brief.visualDirection ?? 'None supported by evidence'}{brief.visualPalette.length > 0 && <span className="ml-2 inline-flex gap-1 align-middle">{brief.visualPalette.map((c) => <span key={c} title={c} className="inline-block h-4 w-4 rounded border border-cream-300" style={{ background: c }} />)}</span>}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Brand constraints</dt><dd>{brief.brandConstraints.join('; ') || 'None supplied'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wider text-muted">Claims that must NOT be made</dt><dd><ul className="list-disc pl-5">{brief.claimsToAvoid.map((c, i) => <li key={i}>{c.claim} <span className="text-xs text-muted">({c.reason})</span></li>)}</ul></dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wider text-muted">Evidence required before launch</dt><dd>{brief.requiredEvidence.join('; ') || 'None'}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" onClick={download}><Download className="h-3.5 w-3.5" /> Download brief (JSON)</Button>
            <span className="text-xs text-muted">Provenance: F1 {brief.provenance.f1ReportId} · F2 {brief.provenance.f2AuditId}</span>
          </div>
          <details className="mt-3"><summary className="cursor-pointer text-xs text-muted">Show JSON</summary><pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-cream-100 p-3 text-[11px]">{JSON.stringify(brief, null, 2)}</pre></details>
        </Section>
      </div>

      <p className="text-xs text-muted">
        Generated {formatDate(data.createdAt)} with {m.model} · {m.usage.total.calls} model call{m.usage.total.calls === 1 ? '' : 's'} · {m.usage.total.totalTokens.toLocaleString()} tokens (measured; no cost shown)
      </p>
    </div>
  );
}
