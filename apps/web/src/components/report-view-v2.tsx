'use client';

import { Boxes, CheckCircle2, CircleHelp, FileText, Globe, GitBranch, Image as ImageIcon, Lightbulb, Palette, Sparkles, Swords, Target, TriangleAlert, Users } from 'lucide-react';
import { Bullets, EvidenceLegend, Section, Statements } from '@/components/evidence-ui';
import type { ProductDiscoveryReportV2Data, ReportFull, ReportMetadataV2 } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const PRIORITY: Record<string, string> = { high: 'bg-accent text-white', medium: 'bg-ink text-cream-100', low: 'bg-cream-200 text-ink-600' };

/**
 * F1 report (schemaVersion 2). Only sections that were actually analyzed are shown: a text-only idea
 * has no website/repository/document/visual section, instead of an empty or invented one.
 */
export function ReportViewV2({ data }: { data: ReportFull }) {
  const r = data.report as ProductDiscoveryReportV2Data;
  const m = data.metadata as ReportMetadataV2;
  const skipped = m.plan?.skipped ?? [];
  const pm = r.productManifest;

  return (
    <div className="space-y-4">
      {r.partial && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Partial report: some agents failed or timed out ({m.participants.filter((p) => p.state === 'failed' || p.state === 'timed_out').map((p) => p.agent).join(', ') || 'see Agents tab'}). Sections they would have written are missing, not guessed.
        </p>
      )}
      <EvidenceLegend />

      <section className="rounded-2xl bg-ink p-6 text-cream-100">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Executive summary</p>
        <h3 className="mt-2 text-3xl text-cream-100">{r.identity.name}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-cream-100/90">{r.executiveSummary}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-white/10 px-3 py-1">{r.identity.category}</span>
          <span className="rounded-full bg-white/10 px-3 py-1 capitalize">{r.identity.businessType.replace('_', ' ')}</span>
          {r.identity.industry && <span className="rounded-full bg-white/10 px-3 py-1">{r.identity.industry}</span>}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Product / business identity" icon={Target}>
          <p className="text-sm leading-relaxed">{r.identity.summary}</p>
        </Section>
        <Section title="Value proposition" icon={Sparkles}>
          <Statements items={[r.valueProposition]} />
        </Section>
        <Section title="Problem & solution" icon={Lightbulb} className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">Problem</p>
              <Statements items={[r.problemAndSolution.problem]} />
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">Solution</p>
              <Statements items={[r.problemAndSolution.solution]} />
            </div>
          </div>
        </Section>
        <Section title="Products / services offered" icon={Boxes}>
          <Statements items={r.offerings} />
        </Section>
        <Section title="Target customers" icon={Users}>
          <Statements items={r.targetCustomers} />
        </Section>
        <Section title="Differentiation" icon={Swords}>
          <Statements items={r.differentiation} />
        </Section>
        <Section title="Strengths" icon={CheckCircle2}>
          <Statements items={r.strengths} />
        </Section>

        {m.analyzed?.website && (
          <Section title="Website & online presence" icon={Globe} className="lg:col-span-2">
            <Statements items={r.websiteFindings} empty="The website was read, but no findings could be stated from it." />
          </Section>
        )}
        {m.analyzed?.repository && (
          <Section title="Repository / technical" icon={GitBranch} className="lg:col-span-2">
            <Statements items={r.repositoryFindings} empty="The repository was read, but no findings could be stated from it." />
          </Section>
        )}
        {m.analyzed?.documents && (
          <Section title="Uploaded documents" icon={FileText} className="lg:col-span-2">
            <Statements items={r.documentFindings} empty="The documents were read, but no findings could be stated from them." />
          </Section>
        )}
        {m.analyzed?.visual && (
          <Section title="Visual identity" icon={ImageIcon} className="lg:col-span-2">
            <Statements items={r.visualFindings} empty="The images were viewed, but no findings could be stated from them." />
          </Section>
        )}

        <Section title="Weaknesses, risks and unknowns" icon={TriangleAlert} className="lg:col-span-2">
          <Statements items={r.weaknessesRisksUnknowns} />
        </Section>

        <Section title="Evidence & contradictions" icon={CheckCircle2} className="lg:col-span-2">
          <p className="text-sm leading-relaxed">{r.evidenceSummary.narrative}</p>
          {r.evidenceSummary.contradictions.length > 0 && (
            <ul className="mt-3 space-y-2">
              {r.evidenceSummary.contradictions.map((c, i) => (
                <li key={i} className="rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-sm">
                  <span className="font-medium">{c.topic}</span> <span className="text-xs text-muted">({c.status})</span>
                  <p className="mt-1 text-ink-600">{c.detail}</p>
                  {c.findingIds.length > 0 && <p className="mt-1 font-mono text-[11px] text-muted">{c.findingIds.join(' · ')}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Missing information" icon={CircleHelp}>
          <Bullets items={r.missingInformation} empty="Nothing flagged as missing." />
        </Section>
        <Section title="Recommended investigations" icon={Lightbulb}>
          <ul className="space-y-2.5">
            {r.recommendedInvestigations.map((n, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase', PRIORITY[n.priority])}>{n.priority}</span>
                <span>
                  <span className="block font-medium">{n.action}</span>
                  <span className="block text-xs text-muted">{n.rationale}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="Product Manifest" icon={Boxes}>
        <p className="mb-3 text-xs text-muted">The structured summary the later marketing stages will start from. Confidence {Math.round(pm.overallConfidence * 100)}%: {pm.confidenceNotes}</p>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <Row k="Name" v={pm.name} />
          <Row k="Tagline" v={pm.tagline} />
          <Row k="Category / industry" v={[pm.category, pm.industry].filter(Boolean).join(' / ')} />
          <Row k="Offering" v={pm.offering.summary} />
          <Row k="Offer items" v={pm.offering.items.join(', ')} />
          <Row k="Problem" v={pm.problem} />
          <Row k="Value proposition" v={pm.valueProposition} />
          <Row k="Target customers" v={pm.targetCustomers.join('; ')} />
          <Row k="Geography" v={pm.geography.join(', ')} />
          <Row k="Languages" v={pm.languages.join(', ')} />
          <Row k="Goals" v={pm.goals.join('; ')} />
          <Row k="Differentiators" v={pm.differentiators.join('; ')} />
          <Row k="Website" v={pm.onlinePresence.website} />
          <Row k="Repository" v={pm.onlinePresence.repository} />
          <Row k="Social profiles" v={pm.onlinePresence.socialProfiles.join(', ')} />
          <Row k="Open questions" v={pm.openQuestions.join('; ')} />
        </dl>
        {pm.brand && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-cream-300/70 pt-4 text-sm">
            <Palette className="h-4 w-4 text-accent" />
            {pm.brand.palette.map((c) => (
              <span key={c} className="flex items-center gap-1.5 font-mono text-xs" title="Measured from the uploaded image, not guessed">
                <span className="h-4 w-4 rounded border border-cream-300" style={{ background: c }} />
                {c}
              </span>
            ))}
            <span className="text-xs text-muted">{pm.brand.style}</span>
          </div>
        )}
        {pm.evidenceFindingIds.length > 0 && <p className="mt-3 font-mono text-[11px] text-muted">Evidence: {pm.evidenceFindingIds.join(' · ')}</p>}
      </Section>

      {(m.notAnalyzed?.length > 0 || skipped.length > 0) && (
        <Section title="What was not analyzed" icon={CircleHelp}>
          <ul className="space-y-1.5 text-sm">
            {m.notAnalyzed.map((n, i) => (
              <li key={`n${i}`}>
                <strong>{n.label}</strong> <span className="text-muted">{n.reason}</span>
              </li>
            ))}
            {skipped.map((s) => (
              <li key={s.key}>
                <strong>{s.agent}</strong> <span className="text-muted">skipped: {s.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p className="text-xs text-muted">
        Generated {formatDate(data.createdAt)} with {m.model} · {m.usage.total.calls} model call{m.usage.total.calls === 1 ? '' : 's'} · {m.usage.total.totalTokens.toLocaleString()} tokens
        {m.tools?.fixtureSources && ' · FIXTURE SOURCES (test data, not real evidence)'}
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted">{k}</dt>
      <dd className="mt-0.5">{v && v.trim() ? v : <span className="text-muted">Unknown</span>}</dd>
    </div>
  );
}
