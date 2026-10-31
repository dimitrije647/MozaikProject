'use client';

import { AlertOctagon, BadgeCheck, CircleHelp, FileSearch, Globe, Layers, Link2, ListChecks, Palette, Share2, Sparkles, Swords, Target, TriangleAlert } from 'lucide-react';
import { EvidenceBadge, EvidenceLegend, Section } from '@/components/evidence-ui';
import { SeverityBadge } from '@/components/audit-views';
import { Badge } from '@/components/ui/badge';
import type { AuditFull, AuditStatementData, MarketingAuditReportData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const ACCESS: Record<string, { label: string; className: string }> = {
  live_api: { label: 'Live API data', className: 'bg-emerald-100 text-emerald-800' },
  user_provided: { label: 'Typed in by you (not verified)', className: 'bg-amber-100 text-amber-800' },
  export: { label: 'Your export (historical)', className: 'bg-amber-100 text-amber-800' },
  fixture: { label: 'FIXTURE (demo data)', className: 'bg-indigo-100 text-indigo-800' },
  unavailable: { label: 'Unavailable', className: 'bg-cream-200 text-ink-600' },
  not_supplied: { label: 'Not supplied', className: 'bg-cream-100 text-muted' },
  invalid: { label: 'Invalid URL', className: 'bg-red-100 text-red-700' },
};

function Statements({ items, empty }: { items: AuditStatementData[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-3 text-sm">
          <span className="flex shrink-0 flex-col items-start gap-1">
            <EvidenceBadge status={s.status} />
            {s.severity && s.severity !== 'info' && <SeverityBadge severity={s.severity} />}
          </span>
          <span className="min-w-0">
            <span className="block">{s.text}</span>
            {s.recommendation && <span className="block text-xs"><strong>Fix:</strong> {s.recommendation}</span>}
            <span className="block text-xs text-muted">
              {s.basis}
              {s.findingIds.length > 0 && <span className="font-mono"> · {s.findingIds.join(' ')}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
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

const Metrics = ({ rows }: { rows: { label: string; value: string }[] }) =>
  rows.length ? (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
      {rows.map((m) => (
        <div key={m.label}>
          <dt className="text-muted">{m.label}</dt>
          <dd className="font-medium">{m.value}</dd>
        </div>
      ))}
    </dl>
  ) : null;

/** The Marketing Audit Report: 15 sections. Measured values come from tools; unavailable stays "unavailable". */
export function AuditReportView({ data }: { data: AuditFull }) {
  const r: MarketingAuditReportData = data.report;
  const m = data.metadata;
  const h = r.websiteHealth;
  const c = r.productContext;
  const fixture = m.tools?.fixtureSources;

  return (
    <div className="space-y-4">
      {fixture && <p role="status" className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">FIXTURE MODE: the external sources of this audit are test data, not real evidence.</p>}
      {r.partial && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Partial audit: {m.participants.filter((p) => p.state === 'failed' || p.state === 'timed_out').map((p) => p.agent).join(', ')} did not finish. Their areas are incomplete, not guessed.
        </p>
      )}
      <EvidenceLegend />

      {/* 1 */}
      <section className="rounded-2xl bg-ink p-6 text-cream-100">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">1 · Executive summary</p>
        <h3 className="mt-2 text-3xl text-cream-100">{c.name}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-cream-100/90">{r.executiveSummary}</p>
        <p className="mt-3 text-xs text-cream-100/70">Diagnostic only: no campaign, no copy, no strategy. Built on Product Discovery report <span className="font-mono">{c.f1ReportId}</span>.</p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 2 */}
        <Section title="2 · Product context (from Product Discovery)" icon={Target} className="lg:col-span-2">
          <p className="text-sm">{c.summary}</p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs uppercase tracking-wider text-muted">Category</dt><dd>{c.category} · {c.businessType.replace('_', ' ')}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Offering</dt><dd>{c.offering}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Value proposition (as understood in F1)</dt><dd>{c.valueProposition ?? 'Unknown'}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-muted">Target customers</dt><dd>{c.targetCustomers.join('; ') || 'Unknown'}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">F1 confidence {Math.round(c.f1Confidence * 100)}%{c.f1Partial ? ' · the F1 report was partial' : ''} · generated {c.f1GeneratedAt ? formatDate(c.f1GeneratedAt) : 'n/a'}</p>
        </Section>

        {/* 3 */}
        <Section title="3 · Website and SEO health" icon={Globe} className="lg:col-span-2">
          <p className="mb-3 text-sm">{r.seo.assessment}</p>
          <dl className="mb-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted">Website</dt><dd className="truncate">{h.websiteUrl ?? 'not supplied'}{h.reachable === false ? ' (not reachable)' : ''}</dd></div>
            <div><dt className="text-xs text-muted">Pages analyzed</dt><dd>{h.pagesAnalyzed}</dd></div>
            <div><dt className="text-xs text-muted">Broken internal links</dt><dd>{h.brokenInternalLinks ?? 'not checked'}</dd></div>
            <div><dt className="text-xs text-muted">robots.txt</dt><dd>{h.robots}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted">Sitemap</dt><dd>{h.sitemap}</dd></div>
          </dl>
          <div className="mb-3 rounded-xl bg-cream-100 px-4 py-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">PageSpeed Insights · {h.pageSpeed.status === 'measured' ? 'measured' : 'unavailable'}</p>
            <p className="mb-2 text-xs text-muted">{h.pageSpeed.note}</p>
            <Metrics rows={h.pageSpeed.metrics} />
          </div>
          {h.perPage.length > 0 && (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted"><tr><th className="py-1 pr-3">Page</th><th className="pr-3">HTTP</th><th className="pr-3">Title</th><th className="pr-3">Meta description</th><th className="pr-3">H1</th><th className="pr-3">Canonical</th><th>Viewport</th></tr></thead>
                <tbody>
                  {h.perPage.map((p) => (
                    <tr key={p.url} className="border-t border-cream-300/60 align-top">
                      <td className="max-w-[16rem] truncate py-1 pr-3" title={p.url}>{p.url}</td>
                      <td className="pr-3">{p.status}</td>
                      <td className="pr-3">{p.title ?? <span className="text-red-700">missing</span>}</td>
                      <td className="pr-3">{p.metaDescription ?? <span className="text-red-700">missing</span>}</td>
                      <td className="pr-3">{p.h1Count}</td>
                      <td className="pr-3">{p.canonical ? 'yes' : 'no'}{p.noindex ? ' · NOINDEX' : ''}</td>
                      <td>{p.viewport ? 'yes' : <span className="text-red-700">missing</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Statements items={r.seo.statements} empty="No SEO findings (the website was not audited)." />
        </Section>

        {/* 4 */}
        <Section title="4 · Social media presence" icon={Share2} className="lg:col-span-2">
          <p className="mb-3 text-sm">{r.social.assessment}</p>
          <ul className="mb-3 grid gap-2 sm:grid-cols-2">
            {r.socialPlatforms.filter((p) => p.access !== 'not_supplied').map((p) => (
              <li key={p.platform} className="rounded-xl border border-cream-300/80 bg-cream-50 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2"><strong className="capitalize">{p.platform}</strong><Badge className={ACCESS[p.access]?.className}>{ACCESS[p.access]?.label ?? p.access}</Badge></div>
                <p className="mt-1 text-xs text-muted">{p.note}</p>
                <div className="mt-1"><Metrics rows={p.metrics} /></div>
              </li>
            ))}
          </ul>
          {r.socialPlatforms.some((p) => p.access === 'not_supplied') && <p className="mb-3 text-xs text-muted">Not supplied: {r.socialPlatforms.filter((p) => p.access === 'not_supplied').map((p) => p.platform).join(', ')}. That is not evidence the business has no presence there.</p>}
          <Statements items={r.social.statements} empty="No social findings." />
        </Section>

        {/* 5 */}
        <Section title="5 · Brand consistency" icon={Palette}>
          <p className="mb-3 text-sm">{r.brand.assessment}</p>
          <Statements items={r.brand.statements} empty="The brand was not audited or nothing could be stated." />
        </Section>

        {/* 6 */}
        <Section title="6 · Messaging quality" icon={Sparkles}>
          <p className="mb-3 text-sm">{r.messaging.assessment}</p>
          <Statements items={r.messaging.statements} empty="No messaging findings." />
        </Section>

        {/* 7 */}
        <Section title="7 · Overall digital presence" icon={Link2} className="lg:col-span-2">
          <p className="mb-3 text-sm">{r.presence.assessment}</p>
          {r.channels.length > 0 && (
            <ul className="mb-3 flex flex-wrap gap-2 text-xs">
              {r.channels.map((ch) => (
                <li key={ch.platform} className="rounded-full border border-cream-300 bg-cream-50 px-3 py-1">
                  <span className="capitalize">{ch.platform}</span>: {ch.state}
                  {ch.linkedFromWebsite === true ? ' · linked from website' : ch.linkedFromWebsite === false ? ' · not linked from website' : ''}
                  <span className="text-muted"> · not checked live</span>
                </li>
              ))}
            </ul>
          )}
          <Statements items={r.presence.statements} empty="No presence findings." />
        </Section>

        {/* 8 */}
        <Section title="8 · Main problems" icon={AlertOctagon} className="lg:col-span-2">
          {r.mainProblems.length === 0 ? (
            <p className="text-sm text-muted">No major problems were documented by the evidence.</p>
          ) : (
            <ol className="space-y-3">
              {r.mainProblems.map((p, i) => (
                <li key={i} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={p.severity} /><EvidenceBadge status={p.status} /><strong>{p.title}</strong><span className="ml-auto text-xs capitalize text-muted">{p.area}</span></div>
                  <p className="mt-1">{p.description}</p>
                  <p className="mt-1 text-xs text-muted">Impact: {p.impact}</p>
                  <p className="mt-1 text-xs"><strong>Fix:</strong> {p.recommendation}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">{p.findingIds.join(' ')}</p>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* 9 */}
        <Section title="9 · Contradictions and cross-checks" icon={Swords} className="lg:col-span-2">
          {r.contradictions.length === 0 ? <p className="text-sm text-muted">No contradictions were found between agents or sources.</p> : (
            <ul className="space-y-2">
              {r.contradictions.map((x, i) => (
                <li key={i} className="rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-sm"><strong>{x.topic}</strong> <span className="text-xs text-muted">({x.status})</span><p className="mt-1">{x.detail}</p><p className="font-mono text-[11px] text-muted">{x.findingIds.join(' ')}</p></li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">{m.crosschecks.length} claim(s) were reviewed by a different agent: {m.crosschecks.filter((x) => x.verdict === 'agree').length} agreed, {m.crosschecks.filter((x) => x.verdict === 'disagree').length} disagreed, {m.crosschecks.filter((x) => x.verdict === 'correct').length} corrected. Details in the Cross-Checks tab.</p>
        </Section>

        {/* 10 / 11 */}
        <Section title="10 · Strengths" icon={BadgeCheck}>
          <Statements items={r.strengths} empty="No strengths documented." />
        </Section>
        <Section title="11 · Weaknesses" icon={TriangleAlert}>
          <Statements items={r.weaknesses} empty="No weaknesses documented." />
        </Section>

        {/* 12 */}
        <Section title="12 · Prioritized improvement opportunities" icon={ListChecks} className="lg:col-span-2">
          {r.opportunities.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <ol className="space-y-2.5">
              {[...r.opportunities].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority)).map((o, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase', o.priority === 'high' ? 'bg-accent text-white' : o.priority === 'medium' ? 'bg-ink text-cream-100' : 'bg-cream-200 text-ink-600')}>{o.priority}</span>
                  <span><span className="block font-medium">{o.title}</span><span className="block text-xs text-muted">{o.rationale} · effort: {o.effort} · {o.area}</span></span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* 13 */}
        <Section title="13 · Missing data and audit limitations" icon={CircleHelp} className="lg:col-span-2">
          <Bullets items={[...r.limitations, ...r.additionalLimitations]} empty="None." />
        </Section>

        {/* 14 */}
        <Section title="14 · Evidence appendix" icon={FileSearch} className="lg:col-span-2">
          <details>
            <summary className="cursor-pointer text-sm text-muted">{r.evidenceAppendix.findings.length} findings · {r.evidenceAppendix.sources.length} sources</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted"><tr><th className="py-1 pr-2">Id</th><th className="pr-2">Agent</th><th className="pr-2">Severity</th><th className="pr-2">Class</th><th className="pr-2">Finding</th><th className="pr-2">Source</th><th>Cross-check</th></tr></thead>
                <tbody>
                  {r.evidenceAppendix.findings.map((f) => (
                    <tr key={f.id} className="border-t border-cream-300/60 align-top"><td className="py-1 pr-2 font-mono">{f.id}</td><td className="pr-2">{f.agent}</td><td className="pr-2">{f.severity}</td><td className="pr-2">{f.classification}</td><td className="pr-2">{f.title}: {f.statement}{f.excerpt ? <span className="block italic text-muted">“{f.excerpt}”</span> : null}</td><td className="pr-2">{f.sourceId ?? f.locator ?? '-'}</td><td>{f.crosscheck}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Section>

        {/* 15 */}
        <Section title="15 · F3 strategy handoff" icon={Layers} className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><p className="mb-1 text-xs uppercase tracking-wider text-muted">Positioning questions</p><Bullets items={r.f3Handoff.positioningQuestions} empty="None." /></div>
            <div><p className="mb-1 text-xs uppercase tracking-wider text-muted">Audience hypotheses to test</p><Bullets items={r.f3Handoff.audienceHypothesesToTest} empty="None." /></div>
            <div><p className="mb-1 text-xs uppercase tracking-wider text-muted">Channel hypotheses</p><Bullets items={r.f3Handoff.channelHypotheses} empty="None." /></div>
            <div><p className="mb-1 text-xs uppercase tracking-wider text-muted">Priority themes</p><Bullets items={r.f3Handoff.priorityThemes} empty="None." /></div>
            <div className="sm:col-span-2"><p className="mb-1 text-xs uppercase tracking-wider text-muted">Constraints</p><Bullets items={r.f3Handoff.constraints} empty="None." /></div>
          </div>
        </Section>
      </div>

      <p className="text-xs text-muted">
        Generated {formatDate(data.createdAt)} with {m.model} · {m.usage.total.calls} model call{m.usage.total.calls === 1 ? '' : 's'} · {m.usage.total.totalTokens.toLocaleString()} tokens (measured; no cost shown)
      </p>
    </div>
  );
}
