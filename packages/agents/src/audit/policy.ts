import type { SourceRecord, SourceStore } from '../discovery/f1/board';
import { normalizeText } from '../discovery/input';
import type { EvidenceStatus } from '../discovery/schemas';
import { AUDIT_INFO, SEVERITIES, type AuditArea, type AuditBoard, type AuditFinding, type AuditKey, type Severity } from './board';
import type { AuditFacts, F1Context } from './context';
import type { AuditReportDraft, LlmAuditFinding, MarketingAuditReport } from './schemas';
import { AUDIT_REPORT_VERSION } from './schemas';

/**
 * The F2 evidence policy, enforced IN CODE on everything the audit agents produce.
 *
 * What the labels mean here:
 *  - verified:  an OBSERVATION of a measurable property of a live source in this run (a page's title, a missing
 *               tag, an API result), backed by a verbatim excerpt of the stored source text. It never certifies that
 *               a business claim made on a page is true: "the site says 10,000 customers" is a claim_on_source,
 *               capped at "claimed".
 *  - claimed:   a statement a source or the user made, with a verbatim excerpt or a traceable F1 finding.
 *  - inferred:  an assessment or conclusion of the model.
 *  - unknown / disputed as in F1.
 * Fixtures, user-typed data and exports can never be verified.
 */

export interface AuditPolicyIssue {
  type: 'reference_normalized' | 'unknown_source' | 'excerpt_not_found' | 'verified_downgraded' | 'claim_downgraded' | 'statement_capped' | 'severity_capped' | 'unknown_f1_finding' | 'contradiction_added';
  agent: string;
  detail: string;
}

const RANK: Record<EvidenceStatus, number> = { unknown: 0, inferred: 1, claimed: 2, verified: 3, disputed: -1 };
const BY_RANK: EvidenceStatus[] = ['unknown', 'inferred', 'claimed', 'verified'];
const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, SEVERITIES.length - i])) as Record<Severity, number>;
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface AuditPolicyContext {
  store: SourceStore;
  f1: F1Context;
  issues: AuditPolicyIssue[];
}

const LIVE_ORIGINS = new Set(['public_page', 'live_api']);
const isLive = (s: SourceRecord) => s.live && !s.fixture && !!s.origin && LIVE_ORIGINS.has(s.origin) && s.status === 'retrieved';

export function validateAuditFinding(llm: LlmAuditFinding, agent: string, key: AuditKey, ctx: AuditPolicyContext): Omit<AuditFinding, 'id' | 'crosscheck' | 'at'> {
  const { store, f1, issues } = ctx;
  let { classification, sourceType, sourceId, locator, excerpt, severity } = llm;
  let adjustment: string | null = null;
  const adjust = (type: AuditPolicyIssue['type'], why: string) => {
    adjustment = adjustment ? `${adjustment} ${why}` : why;
    issues.push({ type, agent, detail: `"${clip(llm.title)}": ${why}` });
  };

  // Models often put an F1 finding id (e.g. "A3-2") into sourceId. If that id really exists in the F1 report,
  // it IS an F1 reference: keep the provenance instead of dropping it.
  if (sourceId && !store.get(sourceId) && f1.findings.some((f) => f.id === sourceId)) {
    issues.push({ type: 'reference_normalized', agent, detail: `"${clip(llm.title)}": F1 finding ${sourceId} was cited as a source and is now an F1 reference.` });
    sourceType = 'f1_finding';
    locator = sourceId;
    sourceId = null;
  }

  const src = sourceId ? store.get(sourceId) : undefined;
  if (sourceId && !src) {
    adjust('unknown_source', `cited source ${sourceId} does not exist.`);
    sourceId = null;
  }

  // F1 references: the locator must be a real F1 finding id
  const f1Finding = sourceType === 'f1_finding' ? f1.findings.find((f) => f.id === locator) : undefined;
  if (sourceType === 'f1_finding' && !f1Finding) {
    adjust('unknown_f1_finding', `F1 finding ${locator ?? '(none)'} does not exist in the referenced F1 report.`);
    sourceType = 'ai_inference';
    locator = null;
  }

  if (excerpt) {
    const found = src ? store.contains(src.id, excerpt) : f1Finding ? normalizeText(`${f1Finding.statement} ${f1Finding.excerpt ?? ''}`).includes(normalizeText(excerpt)) && normalizeText(excerpt).length >= 6 : false;
    if (!found) {
      adjust('excerpt_not_found', 'the quoted excerpt was not found verbatim in the cited source and was removed.');
      excerpt = null;
    }
  }

  // What the cited source is
  const userProvided = src?.origin === 'user_provided' || src?.origin === 'export' || sourceType === 'user_provided' || sourceType === 'export';
  const cap = (max: EvidenceStatus, why: string, type: AuditPolicyIssue['type']) => {
    if (RANK[classification] > RANK[max]) {
      adjust(type, why);
      classification = max;
    }
  };

  // 1. by kind of statement
  if (llm.kind === 'assessment' || llm.kind === 'hypothesis') cap('inferred', `a ${llm.kind} is a judgment, not an observation, so it is at most "inferred".`, 'verified_downgraded');
  if (llm.kind === 'claim_on_source') cap('claimed', 'a claim made on a source is at most "claimed": observing the claim does not verify it is true.', 'verified_downgraded');
  if (llm.kind === 'gap' && RANK[classification] > RANK.inferred) cap('inferred', 'a gap (missing data) is not an observation of content.', 'verified_downgraded');

  // 2. verified needs a live, non-fixture, tool-observed source and a verbatim excerpt
  if (classification === 'verified') {
    const ok = !!src && isLive(src) && !!excerpt && llm.kind === 'observation';
    if (!ok) {
      classification = userProvided ? 'claimed' : 'inferred';
      adjust('verified_downgraded', src?.fixture ? 'the source is a test fixture, never real evidence.' : userProvided ? 'user-provided data cannot be verified.' : 'it needs a live source observed in this run and a verbatim excerpt.');
    }
  }

  // 3. claimed must be traceable
  if (classification === 'claimed') {
    const traceable = (!!src && !!excerpt) || (!!f1Finding && RANK[f1Finding.classification as EvidenceStatus] >= RANK.claimed) || (userProvided && !!src);
    if (!traceable) {
      classification = 'inferred';
      adjust('claim_downgraded', 'a "claimed" statement must cite a source with a verbatim excerpt or an F1 finding; downgraded to inferred.');
    }
  }

  // 4. never stronger than the F1 finding it comes from
  if (f1Finding) cap(BY_RANK[Math.max(0, RANK[f1Finding.classification as EvidenceStatus])] ?? 'inferred', `it cannot be stronger than F1 finding ${f1Finding.id} (${f1Finding.classification}).`, 'statement_capped');

  // 5. user-provided / fixture data is never 'verified' (defensive double-check)
  if (classification === 'verified' && (!src || !isLive(src))) classification = 'inferred';

  // Severity says how much a PROVEN problem hurts. A missing piece of data or an untested idea is never critical,
  // and a judgment never outranks a measurement.
  const maxSeverity: Severity = llm.kind === 'gap' || llm.kind === 'hypothesis' ? 'medium' : llm.kind === 'assessment' || llm.kind === 'claim_on_source' ? 'high' : 'critical';
  if (SEV_RANK[severity] > SEV_RANK[maxSeverity]) {
    adjust('severity_capped', `severity ${severity} -> ${maxSeverity}: a ${llm.kind} cannot be rated higher.`);
    severity = maxSeverity;
  }

  const area: AuditArea = key === 'synthesizer' ? llm.area : (AUDIT_INFO[key].area as AuditArea);
  return { agent, area, kind: llm.kind, title: llm.title, statement: llm.statement, classification, severity, sourceType, sourceId, locator, excerpt, recommendation: llm.recommendation, confidence: llm.confidence === null ? null : Math.min(1, Math.max(0, llm.confidence)), adjustment };
}

// ---- report finalization ----------------------------------------------------------------------------------

const strongest = (ids: string[], byId: Map<string, AuditFinding>): EvidenceStatus | null => {
  const found = ids.map((i) => byId.get(i)).filter((f): f is AuditFinding => !!f);
  if (!found.length) return null;
  return BY_RANK[Math.max(...found.map((f) => Math.max(0, RANK[f.classification])))];
};

const maxSeverity = (ids: string[], byId: Map<string, AuditFinding>): Severity | null => {
  const found = ids.map((i) => byId.get(i)).filter((f): f is AuditFinding => !!f);
  if (!found.length) return null;
  return found.reduce((best, f) => (SEV_RANK[f.severity] > SEV_RANK[best] ? f.severity : best), 'info' as Severity);
};

export function finalizeAuditReport(
  draft: AuditReportDraft,
  board: AuditBoard,
  args: { f1: F1Context; facts: AuditFacts; partial: boolean; websiteUrl: string | null; fixtureSources: boolean; pageSpeedNote?: string },
): { report: MarketingAuditReport; issues: AuditPolicyIssue[] } {
  const issues: AuditPolicyIssue[] = [];
  const byId = new Map(board.findings.map((f) => [f.id, f]));
  const known = (ids: string[]) => [...new Set(ids)].filter((i) => byId.has(i));
  const who = AUDIT_INFO.synthesizer.name;

  const fixStatement = <T extends { status: EvidenceStatus; findingIds: string[]; text: string }>(s: T): T => {
    const ids = known(s.findingIds);
    const top = strongest(ids, byId);
    let status = s.status;
    const limit = top ?? 'inferred';
    if (RANK[status] > RANK[limit]) {
      issues.push({ type: 'statement_capped', agent: who, detail: `"${clip(s.text)}": ${status} -> ${limit} (${top ? 'strongest cited finding' : 'no supporting finding'}).` });
      status = limit;
    }
    // A statement resting only on disputed findings stays disputed.
    if (ids.length && ids.every((i) => byId.get(i)!.classification === 'disputed')) status = 'disputed';
    return { ...s, findingIds: ids, status };
  };
  const section = (s: AuditReportDraft['seo']) => ({ ...s, statements: s.statements.map(fixStatement) });

  const mainProblems = draft.mainProblems.map((p) => {
    const ids = known(p.findingIds);
    const fixed = fixStatement({ text: p.title, status: p.status, findingIds: ids });
    const top = maxSeverity(ids, byId) ?? 'medium';
    let severity = p.severity;
    if (SEV_RANK[severity] > SEV_RANK[top]) {
      issues.push({ type: 'severity_capped', agent: who, detail: `"${clip(p.title)}": ${severity} -> ${top} (not higher than its cited findings).` });
      severity = top;
    }
    return { ...p, findingIds: ids, status: fixed.status, severity };
  });

  // Contradiction analysis is deterministic: every disputed finding must appear.
  const contradictions = draft.contradictions.map((c) => ({ ...c, findingIds: known(c.findingIds) }));
  const covered = new Set(contradictions.flatMap((c) => c.findingIds));
  for (const f of board.findings.filter((x) => x.classification === 'disputed' && !covered.has(x.id))) {
    const rec = board.crosschecks.find((c) => c.claimId === f.id && c.verdict === 'disagree');
    contradictions.push({ topic: f.title, detail: `${f.agent}: ${f.statement}${rec ? ` | ${rec.reviewer} disagrees: ${rec.rationale ?? ''}` : ''}`.slice(0, 700), findingIds: [f.id], status: 'open' });
    issues.push({ type: 'contradiction_added', agent: who, detail: `Disputed finding ${f.id} was missing from the contradictions and was added.` });
  }

  const f1 = args.f1;
  const pm = f1.report.productManifest;
  const site = args.facts.site;
  const ps = args.facts.pagespeed;
  const limitations = buildLimitations(board, args);

  const report: MarketingAuditReport = {
    ...draft,
    schemaVersion: AUDIT_REPORT_VERSION,
    partial: args.partial,
    seo: section(draft.seo),
    social: section(draft.social),
    brand: section(draft.brand),
    messaging: section(draft.messaging),
    presence: section(draft.presence),
    mainProblems,
    contradictions,
    strengths: draft.strengths.map(fixStatement),
    weaknesses: draft.weaknesses.map(fixStatement),
    opportunities: draft.opportunities.map((o) => ({ ...o, findingIds: known(o.findingIds) })),
    productContext: {
      f1ReportId: f1.reportId,
      f1SchemaVersion: f1.schemaVersion,
      f1GeneratedAt: f1.generatedAt,
      name: pm.name,
      category: pm.category,
      businessType: pm.businessType,
      summary: f1.report.identity.summary,
      offering: pm.offering.summary,
      valueProposition: pm.valueProposition,
      targetCustomers: pm.targetCustomers,
      f1Confidence: pm.overallConfidence,
      f1Partial: f1.partial,
    },
    websiteHealth: {
      websiteUrl: args.websiteUrl,
      reachable: args.websiteUrl ? !!site?.home.ok : null,
      pagesAnalyzed: site?.pages.length ?? 0,
      robots: site ? (site.robots.status === 'found' ? `found${site.robots.blocksAll ? ', blocks all crawlers' : ''}${site.robots.sitemaps.length ? `, lists ${site.robots.sitemaps.length} sitemap(s)` : ''}` : site.robots.status) : 'not checked',
      sitemap: site ? (site.sitemap.status === 'found' ? `found at ${site.sitemap.url} (${site.sitemap.urlCount} URL entries${site.sitemap.isIndex ? ', sitemap index' : ''})` : site.sitemap.status) : 'not checked',
      brokenInternalLinks: site?.home.ok ? site.broken.length : null,
      pageSpeed: ps?.ok
        ? { status: 'measured', note: `Google PageSpeed Insights (${ps.strategy}), Lighthouse lab data of a single run.`, metrics: [...[['Performance', ps.scores.performance], ['SEO', ps.scores.seo], ['Accessibility', ps.scores.accessibility], ['Best practices', ps.scores.bestPractices]].map(([label, v]) => ({ label: String(label), value: v === null ? 'unavailable' : String(v) })), ...ps.metrics.map((m) => ({ label: m.label, value: m.display ?? 'unavailable' }))] }
        : { status: 'unavailable', note: ps && !ps.ok ? ps.message : (args.pageSpeedNote ?? 'PageSpeed Insights was not used.'), metrics: [] },
      perPage: (site?.pages ?? []).map((p) => ({ url: p.finalUrl, status: p.status, title: p.title, metaDescription: p.metaDescription, h1Count: p.h1.length, canonical: p.canonical, noindex: p.noindex, viewport: !!p.viewport, structuredData: p.jsonLdTypes })),
    },
    socialPlatforms: args.facts.social,
    channels: (args.facts.presence?.channels ?? []).map((c) => ({ platform: c.platform, url: c.url, state: c.state, linkedFromWebsite: c.linkedFromWebsite })),
    limitations,
    evidenceAppendix: {
      findings: board.findings.map((f) => ({ id: f.id, agent: f.agent, area: f.area, kind: f.kind, title: f.title, statement: f.statement, classification: f.classification, severity: f.severity, sourceId: f.sourceId, locator: f.locator, excerpt: f.excerpt, recommendation: f.recommendation, crosscheck: f.crosscheck.status + (f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : ''), at: f.at })),
      sources: board.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, origin: s.origin ?? (s.fixture ? 'fixture' : s.live ? 'public_page' : 'user_provided'), live: s.live, fixture: s.fixture, error: s.error })),
    },
  };
  return { report, issues };
}

function buildLimitations(board: AuditBoard, args: { facts: AuditFacts; websiteUrl: string | null; fixtureSources: boolean; f1: F1Context }): string[] {
  const out: string[] = [];
  for (const s of board.plan?.skipped ?? []) out.push(`${s.agent} did not run: ${s.reason}.`);
  for (const p of board.participantStatuses.filter((x) => x.state === 'failed' || x.state === 'timed_out')) out.push(`${p.agent} ${p.state === 'timed_out' ? 'timed out' : 'failed'}${p.error ? `: ${p.error.message}` : ''}. Its area is incomplete.`);
  for (const s of board.sources.filter((x) => x.status !== 'retrieved')) out.push(`${s.label}: ${s.status}${s.error ? ` (${s.error})` : ''}.`);
  for (const r of args.facts.social) if (r.access === 'unavailable') out.push(`${r.platform}: ${r.note}`);
  if (args.facts.pagespeed && !args.facts.pagespeed.ok) out.push(args.facts.pagespeed.message);
  if (args.facts.site && !args.facts.site.home.ok) out.push(`The website could not be read (${args.facts.site.home.message}); SEO, messaging and branding findings about it are not possible.`);
  out.push('No claim is made about whether pages are indexed or ranked in Google: that needs Search Console, which is not connected.');
  out.push('Missing social data is not evidence of poor social performance.');
  if (args.f1.partial) out.push('The referenced F1 Product Discovery report was partial, so the product context is incomplete.');
  if (args.fixtureSources) out.push('FIXTURE MODE: external sources in this run are test data, not real evidence.');
  return [...new Set(out)];
}

export { SEV_RANK };
