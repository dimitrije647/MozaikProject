import type { AuditAgentOutput, AuditReportDraft, LlmAuditFinding } from '../audit/schemas';
import { parseSources, type PromptSource } from './prompt-parse';

/**
 * Default (valid) answers of the F2 audit agents for the fake OpenAI server. Built from the prompt the
 * request actually carried, so findings cite real source ids and VERBATIM lines of the blocks they were shown.
 */
export type AuditFakeAgent = 'seo' | 'social' | 'brand' | 'messaging' | 'presence' | 'auditor';

const line = (text: string, prefix: string) => text.split('\n').find((l) => l.startsWith(prefix)) ?? null;

const F = (f: Partial<LlmAuditFinding> & Pick<LlmAuditFinding, 'area' | 'kind' | 'title' | 'statement' | 'classification'>): LlmAuditFinding => ({
  severity: 'medium',
  sourceType: 'ai_inference',
  sourceId: null,
  locator: null,
  excerpt: null,
  recommendation: null,
  confidence: 0.7,
  ...f,
});

const pageSource = (sources: PromptSource[]) => sources.find((s) => s.kind === 'website' && /^url: /m.test(s.text) && !/^Internal link check/.test(s.label));

export function defaultAuditAnalysis(agent: AuditFakeAgent, userText: string): AuditAgentOutput {
  const sources = parseSources(userText);
  const page = pageSource(sources);
  const findings: LlmAuditFinding[] = [];
  switch (agent) {
    case 'seo': {
      if (page) {
        const desc = line(page.text, 'meta_description:');
        if (desc && /\(missing\)/.test(desc)) {
          findings.push(F({ area: 'seo', kind: 'observation', title: 'No meta description', statement: 'The page has no meta description, so search engines will generate their own snippet.', classification: 'verified', severity: 'high', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: desc, recommendation: 'Add a unique meta description of about 120-160 characters that states what the page offers.' }));
        } else if (desc) {
          findings.push(F({ area: 'seo', kind: 'observation', title: 'Meta description present', statement: 'The page declares a meta description.', classification: 'verified', severity: 'info', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: desc }));
        }
        const title = line(page.text, 'title:');
        if (title) findings.push(F({ area: 'seo', kind: 'observation', title: 'Page title', statement: 'The page has a title.', classification: 'verified', severity: 'info', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: title }));
        const vp = line(page.text, 'viewport:');
        if (vp && /\(missing\)/.test(vp)) findings.push(F({ area: 'seo', kind: 'observation', title: 'No mobile viewport', statement: 'No viewport meta tag was found.', classification: 'verified', severity: 'medium', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: vp, recommendation: 'Add a responsive viewport meta tag.' }));
      }
      const robots = sources.find((s) => s.kind === 'robots');
      const rl = robots && line(robots.text, 'robots_txt:');
      if (robots && rl) findings.push(F({ area: 'seo', kind: 'observation', title: 'robots.txt status', statement: `robots.txt: ${rl}`, classification: 'verified', severity: 'info', sourceType: 'website', sourceId: robots.id, excerpt: rl }));
      const ps = sources.find((s) => s.kind === 'pagespeed');
      const pl = ps && line(ps.text, 'score_performance:');
      if (ps && pl) findings.push(F({ area: 'seo', kind: 'observation', title: 'PageSpeed performance score', statement: `PageSpeed Insights reports: ${pl}`, classification: 'verified', severity: 'info', sourceType: 'pagespeed', sourceId: ps.id, excerpt: pl }));
      return { summary: 'SEO signals of the website.', findings, missingInformation: ps ? [] : ['PageSpeed metrics are unavailable'] };
    }
    case 'messaging': {
      if (page) {
        const title = line(page.text, 'title:');
        findings.push(F({ area: 'messaging', kind: 'assessment', title: 'Headline clarity', statement: 'The page title does not state the concrete benefit for the customer.', classification: 'inferred', severity: 'medium', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: title, recommendation: 'State who the offer is for and the main outcome in the first heading.' }));
        const claim = page.text.split('\n').find((l) => /\b\d[\d,.]*\+? (customers|clients|students)/i.test(l));
        if (claim) {
          const phrase = /\b\d[\d,.]*\+? (customers|clients|students)/i.exec(claim)![0];
          findings.push(F({ area: 'messaging', kind: 'claim_on_source', title: 'Unsupported numeric claim', statement: `The website claims "${phrase}" without supporting evidence.`, classification: 'verified', severity: 'high', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: phrase, recommendation: 'Publish verifiable evidence for the number or remove the claim.' }));
        }
      }
      findings.push(F({ area: 'messaging', kind: 'assessment', title: 'Value proposition vs. website wording', statement: 'The website wording differs from the value proposition in the Product Manifest.', classification: 'inferred', severity: 'medium', sourceType: 'ai_inference' }));
      return { summary: 'How the product is communicated.', findings, missingInformation: [] };
    }
    case 'brand': {
      if (page) {
        const dl = line(page.text, 'declared_branding:');
        if (dl) findings.push(F({ area: 'brand', kind: 'observation', title: 'Declared website branding', statement: 'The website declares limited branding in its markup.', classification: 'verified', severity: 'low', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: dl.slice(0, 160), recommendation: 'Document colors and typography in a brand guideline.' }));
      }
      findings.push(F({ area: 'brand', kind: 'gap', title: 'No brand guidelines supplied', statement: 'No brand guideline was supplied, so consistency cannot be judged against rules.', classification: 'unknown', severity: 'low', sourceType: 'ai_inference' }));
      findings.push(F({ area: 'brand', kind: 'assessment', title: 'Tone of voice', statement: 'The tone of the website is friendly but does not match the formal description in F1.', classification: 'inferred', severity: 'medium', sourceType: 'ai_inference' }));
      return { summary: 'Brand consistency.', findings, missingInformation: [] };
    }
    case 'social': {
      const social = sources.filter((s) => s.kind === 'social_profile' && (s.live || /stated_by_user/.test(s.text)));
      for (const s of social) {
        const l = line(s.text, 'subscribers:') ?? line(s.text, 'followers_stated_by_user:') ?? line(s.text, 'channel:');
        if (l) findings.push(F({ area: 'social', kind: 'observation', title: `${s.label}`, statement: `Profile data: ${l}`, classification: 'verified', severity: 'info', sourceType: s.live ? 'social_api' : 'user_provided', sourceId: s.id, locator: s.label, excerpt: l }));
        const desc = line(s.text, 'description:') ?? line(s.text, 'bio_stated_by_user:');
        if (desc) findings.push(F({ area: 'social', kind: 'observation', title: 'Profile description', statement: `The profile describes the business as: ${desc.slice(0, 120)}`, classification: 'claimed', severity: 'low', sourceType: s.live ? 'social_api' : 'user_provided', sourceId: s.id, excerpt: desc.slice(0, 200) }));
      }
      return { summary: 'Social profiles.', findings, missingInformation: ['Engagement rate is unavailable'] };
    }
    case 'presence': {
      const p = sources.find((s) => /consistency_issues/.test(s.text));
      if (p) {
        const issue = p.text.split('\n').find((l) => l.startsWith('- '));
        if (issue) findings.push(F({ area: 'presence', kind: 'observation', title: 'Cross-channel inconsistency', statement: issue.slice(2), classification: 'verified', severity: 'medium', sourceType: 'website', sourceId: p.id, excerpt: issue.slice(2), recommendation: 'Align the website and the social profiles.' }));
        const ch = p.text.split('\n').find((l) => l.startsWith('channel '));
        if (ch) findings.push(F({ area: 'presence', kind: 'gap', title: 'Social channels not checked live', statement: 'Supplied social profiles could not be checked live; this is not evidence that they are weak.', classification: 'unknown', severity: 'info', sourceType: 'website', sourceId: p.id, excerpt: ch.slice(0, 120) }));
      }
      findings.push(F({ area: 'presence', kind: 'assessment', title: 'Identity consistency', statement: 'The business name is used consistently where it could be observed.', classification: 'inferred', severity: 'low', sourceType: 'ai_inference' }));
      return { summary: 'Cross-channel presence.', findings, missingInformation: [] };
    }
    default:
      return { summary: '', findings: [], missingInformation: [] };
  }
}

export function parseAuditFindingIds(text: string) {
  return [...text.matchAll(/\[(A\d{1,2}-\d+)\] \((\w+), (\w+), (\w+), (\w+)/g)].map((m) => ({ id: m[1], classification: m[2], severity: m[3], area: m[4], kind: m[5] }));
}

export function defaultAuditReport(userText: string, overrides: Partial<AuditReportDraft> = {}): AuditReportDraft {
  const ids = parseAuditFindingIds(userText);
  const of = (area: string) => ids.filter((i) => i.area === area).map((i) => i.id);
  const st = (text: string, findingIds: string[], status: AuditReportDraft['strengths'][number]['status'] = 'inferred', severity: AuditReportDraft['strengths'][number]['severity'] = null) => ({ text, status, severity, basis: findingIds.length ? `Findings ${findingIds.join(', ')}` : 'No direct finding', recommendation: null, findingIds });
  const section = (area: string, title: string) => ({ assessment: `${title} assessment based on the cited findings.`, statements: of(area).length ? [st(`${title} finding`, of(area).slice(0, 2), 'verified')] : [] });
  const top = [...ids].sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity)).slice(0, 3);
  return {
    schemaVersion: 1,
    language: 'en',
    partial: /Set partial=true/.test(userText),
    executiveSummary: 'A source-grounded diagnostic of the current marketing state.',
    seo: section('seo', 'SEO'),
    social: section('social', 'Social'),
    brand: section('brand', 'Brand'),
    messaging: section('messaging', 'Messaging'),
    presence: section('presence', 'Presence'),
    mainProblems: top.map((t) => ({ title: `Issue from ${t.id}`, area: t.area as never, severity: 'critical' as const, status: t.classification as never, description: 'See the cited finding.', impact: 'Reduces clarity for visitors.', recommendation: 'Fix as described in the finding.', findingIds: [t.id] })),
    contradictions: [],
    strengths: ids.length ? [st('A documented strength', ids.slice(0, 1).map((i) => i.id), 'verified')] : [],
    weaknesses: ids.length ? [st('A documented weakness', ids.slice(0, 1).map((i) => i.id))] : [],
    opportunities: top.map((t) => ({ title: `Address ${t.id}`, priority: 'high' as const, area: t.area as never, rationale: 'Highest severity finding.', effort: 'low' as const, findingIds: [t.id] })),
    additionalLimitations: [],
    f3Handoff: { positioningQuestions: ['What outcome should the headline promise?'], audienceHypothesesToTest: [], channelHypotheses: [], priorityThemes: ['Clarity of message'], constraints: ['No social analytics available'] },
    ...overrides,
  };
}
