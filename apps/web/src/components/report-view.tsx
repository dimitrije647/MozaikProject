'use client';

import { AlertTriangle, Ban, CheckCircle2, CircleHelp, FileQuestion, Lightbulb, Link2, Sparkles, Swords, Target, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Bullets, EvidenceBadge, EvidenceLegend, Section, Statements } from '@/components/evidence-ui';
import { ReportViewV2 } from '@/components/report-view-v2';
import type { EvidenceItem, ProductDiscoveryReportData, ReportFull, ReportMetadata } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

export { EvidenceBadge, EvidenceLegend };

const PRIORITY: Record<string, string> = { high: 'bg-accent text-white', medium: 'bg-ink text-cream-100', low: 'bg-cream-200 text-ink-600' };

/** Routes by schema: v2 = F1 seven-agent report, v1 = legacy text-only report (older saved runs). */
export function ReportView({ data }: { data: ReportFull }) {
  return data.schemaVersion >= 2 ? <ReportViewV2 data={data} /> : <LegacyReportView data={data} />;
}

function LegacyReportView({ data }: { data: ReportFull }) {
  const r = data.report as ProductDiscoveryReportData;
  const m = data.metadata as ReportMetadata;
  const notAnalyzed = m.inputSnapshot.availableNotAnalyzed;
  const notAnalyzedItems = [
    notAnalyzed.websiteUrl && `Website: ${notAnalyzed.websiteUrl}`,
    notAnalyzed.githubUrl && `GitHub: ${notAnalyzed.githubUrl}`,
    ...notAnalyzed.socialProfiles.map((s) => `${s.platform}: ${s.url}`),
    ...notAnalyzed.uploads.map((u) => `Upload: ${u.name} (${u.type})`),
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      {r.partial && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Partial report.</strong> One of the analysis agents failed
            {m.agents.filter((a) => a.status === 'failed').map((a) => ` (${a.name}: ${a.error?.message ?? 'failed'})`)}, so this report rests on a single analysis.
          </span>
        </p>
      )}

      <EvidenceLegend />

      {/* 1. Executive summary */}
      <section className="panel-dark grain relative overflow-hidden p-6 sm:p-8">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Executive summary</p>
        <h3 className="mt-2 text-3xl text-cream-100">{r.overview.name || m.inputSnapshot.project.name}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-cream-100/90">{r.executiveSummary}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-white/10 px-3 py-1 text-cream-100">{r.overview.category}</span>
          <span className="rounded-full bg-white/10 px-3 py-1 capitalize text-cream-100">{r.overview.businessType.replace('_', ' ')}</span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Product / business overview" icon={Target}>
          <p className="text-sm leading-relaxed">{r.overview.summary}</p>
        </Section>
        <Section title="Value proposition" icon={Sparkles}>
          <Statements items={[r.valueProposition]} />
        </Section>
        <Section title="Problem & proposed solution" icon={Lightbulb} className="lg:col-span-2">
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
        <Section title="Target audience hypotheses" icon={Target}>
          <Statements items={r.audienceHypotheses} />
        </Section>
        <Section title="Main features / services" icon={CheckCircle2}>
          <Statements items={r.featuresServices} />
        </Section>
        <Section title="Potential differentiators" icon={Swords}>
          <Statements items={r.differentiators} />
        </Section>
        <Section title="Strengths" icon={CheckCircle2}>
          <Statements items={r.strengths} />
        </Section>
        <Section title="Weaknesses & risks" icon={AlertTriangle} className="lg:col-span-2">
          <Statements items={r.weaknessesAndRisks} />
        </Section>
      </div>

      <Section title="Missing information" icon={FileQuestion}>
        <Bullets items={r.missingInformation} empty="No gaps were identified." />
      </Section>

      <Section title="Evidence & assumptions" icon={Link2}>
        {r.evidenceAndAssumptions.length === 0 ? (
          <p className="text-sm text-muted">No evidence items listed.</p>
        ) : (
          <ul className="space-y-3">
            {r.evidenceAndAssumptions.map((e: EvidenceItem) => (
              <li key={e.id} className="flex items-start gap-3 text-sm">
                <EvidenceBadge status={e.status} />
                <span className="min-w-0">
                  <span className="block">{e.statement}</span>
                  <span className="block text-xs text-muted">
                    Source: {e.sourceType.replace('_', ' ')}
                    {e.sourceReference ? ` · ${e.sourceReference}` : ''}
                    {e.confidence != null ? ` · confidence ${Math.round(e.confidence * 100)}%` : ''}
                    {e.explanation ? ` · ${e.explanation}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {r.contradictions.length > 0 && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-800">
              <Ban className="h-4 w-4" /> Contradictions found
            </p>
            <ul className="space-y-2 text-sm text-red-900">
              {r.contradictions.map((c, i) => (
                <li key={i}>
                  <strong>{c.topic}:</strong> {c.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Marketing opportunities" icon={Sparkles}>
        <Statements items={r.marketingOpportunities} />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Recommended next steps" icon={Target}>
          <ol className="space-y-3">
            {r.nextSteps.map((s, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <Badge className={cn('shrink-0 capitalize', PRIORITY[s.priority])}>{s.priority}</Badge>
                <span>
                  <span className="block font-medium">{s.action}</span>
                  <span className="block text-xs text-muted">{s.rationale}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>
        <Section title="Follow-up questions" icon={CircleHelp}>
          <Bullets items={r.followUpQuestions} empty="No follow-up questions." />
        </Section>
      </div>

      {/* What was and was not analyzed */}
      <Section title="What this analysis did and did not look at" icon={FileQuestion}>
        <p className="text-sm text-muted">
          This is a <strong className="text-ink">text-only</strong> assessment of the project description, intake form and notes. Nothing below was opened, crawled or analyzed.
        </p>
        {notAnalyzedItems.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-600">
            {notAnalyzedItems.map((t, i) => (
              <li key={i} className="break-all">{t}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No links or uploads were listed.</p>
        )}
        {m.inputSnapshot.truncated && <p className="mt-3 text-xs text-amber-800">Some long text was shortened before analysis.</p>}
      </Section>

      {/* Run details */}
      <Section title="Run details" icon={Link2}>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Meta k="Model" v={data.model} />
          <Meta k="Language" v={data.language} />
          <Meta k="Generated" v={formatDate(data.createdAt)} />
          <Meta k="Model calls" v={`${m.usage.total.calls} (limit ${m.budget.maxModelCalls})`} />
          <Meta k="Input tokens" v={m.usage.total.inputTokens.toLocaleString()} />
          <Meta k="Output tokens" v={m.usage.total.outputTokens.toLocaleString()} />
          <Meta k="Total tokens" v={m.usage.total.totalTokens.toLocaleString()} />
          <Meta k="Reasoning tokens" v={m.usage.total.reasoningTokens.toLocaleString()} />
        </dl>
        <p className="mt-3 text-xs text-muted">Token counts come from OpenAI. No price is shown because LaunchPilot has no reliable pricing source; check your usage on platform.openai.com.</p>
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {m.agents.map((a) => (
            <li key={a.name} className={cn('rounded-full px-3 py-1', a.status === 'succeeded' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700')}>
              {a.name}: {a.status}
            </li>
          ))}
        </ul>
        {m.crosscheckIssues.length + m.reportPolicyIssues.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted">
              {m.crosscheckIssues.length + m.reportPolicyIssues.length} automatic evidence-policy adjustment(s)
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-600">
              {[...m.crosscheckIssues, ...m.reportPolicyIssues].map((i, k) => (
                <li key={k}>{i.detail}</li>
              ))}
            </ul>
          </details>
        )}
      </Section>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted">{k}</dt>
      <dd className="mt-0.5 font-medium">{v}</dd>
    </div>
  );
}
