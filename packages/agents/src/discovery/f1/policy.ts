import { isGroundedReference } from '../grounding';
import type { DiscoveryInput } from '../input';
import { inputCorpus, normalizeText } from '../input';
import type { EvidenceStatus } from '../schemas';
import { AGENT_INFO, type AgentKey, type F1Board, type Finding, type FindingSourceType, type SourceKind, type SourceStore } from './board';
import type { LlmFinding, ProductDiscoveryReportV2, ReportStatement } from './schemas';
import { REPORT_V2_VERSION } from './schemas';

/**
 * The evidence policy, enforced IN CODE on everything agents produce.
 *
 * `verified` means: the statement is directly supported by a verbatim excerpt of a source that was
 * really retrieved from the live web or the GitHub API in this run (not a fixture, not a search
 * snippet, not user-supplied text). It certifies "this source says so", never real-world truth.
 * Only the Web and Repo analyzers can produce it; every other `verified` label is downgraded.
 * `claimed` must trace to the user's text, or to a verbatim excerpt of the cited source.
 */
export interface PolicyIssue {
  type: 'unknown_source' | 'excerpt_not_found' | 'verified_downgraded' | 'claim_downgraded' | 'statement_capped' | 'section_cleared';
  agent: string;
  detail: string;
}

const RANK: Record<EvidenceStatus, number> = { unknown: 0, inferred: 1, claimed: 2, verified: 3, disputed: -1 };
const NAME_BY_RANK: EvidenceStatus[] = ['unknown', 'inferred', 'claimed', 'verified'];
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

const TYPE_BY_KIND: Record<SourceKind, FindingSourceType> = {
  user_input: 'user_input',
  website: 'website',
  search_result: 'search_result',
  repository: 'repository',
  document: 'uploaded_file',
  image: 'image',
  robots: 'website',
  sitemap: 'website',
  pagespeed: 'website',
  social_profile: 'user_input',
  f1_report: 'user_input',
  holiday_calendar: 'website',
  f2_audit: 'user_input',
};
const USER_SUPPLIED: ReadonlySet<SourceKind> = new Set(['user_input', 'document', 'image']);

export interface PolicyContext {
  input: DiscoveryInput;
  store: SourceStore;
  issues: PolicyIssue[];
}

/** Validates one finding produced by an agent and returns the version the board stores. */
export function validateFinding(llm: LlmFinding, agent: string, key: AgentKey, ctx: PolicyContext): Omit<Finding, 'id' | 'crosscheck' | 'at'> {
  const { input, store, issues } = ctx;
  let { classification, sourceType, sourceId, locator, excerpt } = llm;
  let adjustment: string | null = null;
  const adjust = (type: PolicyIssue['type'], why: string) => {
    adjustment = adjustment ? `${adjustment} ${why}` : why;
    issues.push({ type, agent, detail: `"${clip(llm.statement)}": ${why}` });
  };

  const src = sourceId ? store.get(sourceId) : undefined;
  if (sourceId && !src) {
    adjust('unknown_source', `cited source ${sourceId} does not exist.`);
    sourceId = null;
  }
  if (src) sourceType = TYPE_BY_KIND[src.kind];
  if (src && excerpt && !store.contains(src.id, excerpt)) {
    adjust('excerpt_not_found', 'the quoted excerpt was not found verbatim in the cited source and was removed.');
    excerpt = null;
  }

  const userSource = !src ? sourceType === 'intake_field' || sourceType === 'user_input' : USER_SUPPLIED.has(src.kind);

  if (classification === 'verified') {
    const ok = !!src && (src.kind === 'website' || src.kind === 'repository') && src.live && !src.fixture && !!excerpt && (key === 'web' || key === 'repo');
    if (!ok) {
      classification = userSource ? 'claimed' : 'inferred';
      adjust(
        'verified_downgraded',
        src?.fixture
          ? 'the source is a test fixture, which is never evidence about the real world.'
          : 'verified needs a verbatim excerpt from a live website or repository retrieved in this run; downgraded.',
      );
    }
  }

  if (classification === 'claimed') {
    let grounded = false;
    if (!src) grounded = (sourceType === 'intake_field' || sourceType === 'user_input') && (isGroundedReference(locator, input) || isGroundedReference(excerpt, input));
    else if (src.kind === 'user_input') grounded = isGroundedReference(locator, input) || isGroundedReference(excerpt, input) || (!!excerpt && inputCorpus(input).includes(normalizeText(excerpt)));
    else if (src.kind === 'image') grounded = false; // what a model "sees" is an interpretation, not a quotable claim
    else grounded = !!excerpt; // excerpt (if any survived) is verbatim in the cited source
    if (!grounded) {
      classification = 'inferred';
      adjust('claim_downgraded', 'it could not be traced to the supplied text or to a verbatim excerpt of its source; treated as an inference.');
    }
  }

  // What a vision model reads out of an image is never better than an inference.
  if (key === 'visual' && (classification === 'claimed' || classification === 'verified')) classification = 'inferred';

  return {
    agent,
    category: llm.category,
    statement: llm.statement.trim(),
    classification,
    sourceType: sourceType as FindingSourceType,
    sourceId,
    locator,
    excerpt,
    confidence: llm.confidence,
    importance: llm.importance,
    adjustment,
  };
}

// ---- final report ---------------------------------------------------------------------------

export interface AnalyzedSections {
  website: boolean;
  repository: boolean;
  documents: boolean;
  visual: boolean;
}

/** An analysis section counts as analyzed only if its agent actually contributed findings. */
export function analyzedSections(board: F1Board): AnalyzedSections {
  const has = (name: string) => board.findings.some((f) => f.agent === name);
  return { website: has(AGENT_INFO.web.name), repository: has(AGENT_INFO.repo.name), documents: has(AGENT_INFO.files.name), visual: has(AGENT_INFO.visual.name) };
}

/**
 * Deterministic final pass over the Synthesizer's report:
 *  - a statement can never be stronger than the strongest finding it cites, and a statement citing a
 *    disputed finding is disputed; statements without valid provenance are at most inferences;
 *  - sections for sources that were not analyzed are emptied (no invented website/repo/document/visual findings);
 *  - every cross-check disagreement appears as an open contradiction;
 *  - system-controlled manifest fields (links, measured palette) are set from real data, not by the model.
 */
export function finalizeReportV2(
  report: ProductDiscoveryReportV2,
  board: F1Board,
  input: DiscoveryInput,
  opts: { partial: boolean; palette: string[] },
): { report: ProductDiscoveryReportV2; issues: PolicyIssue[]; analyzed: AnalyzedSections } {
  const issues: PolicyIssue[] = [];
  const byId = new Map(board.findings.map((f) => [f.id, f]));
  const agent = AGENT_INFO.synthesizer.name;
  const analyzed = analyzedSections(board);

  const fix = (s: ReportStatement): ReportStatement => {
    const ids = [...new Set(s.findingIds)].filter((id) => byId.has(id));
    const supports = ids.map((id) => byId.get(id)!);
    let status = s.status;
    if (status === 'verified' && !supports.some((f) => f.classification === 'verified')) status = supports.length ? 'claimed' : 'inferred';
    if (!supports.length) {
      if (status === 'claimed' || status === 'verified') {
        issues.push({ type: 'statement_capped', agent, detail: `"${clip(s.text)}" cites no board finding; shown as an inference.` });
        status = 'inferred';
      }
    } else if (supports.some((f) => f.classification === 'disputed' || f.crosscheck.status === 'disputed')) {
      status = 'disputed';
    } else {
      const ceiling = Math.max(...supports.map((f) => RANK[f.classification]));
      if (RANK[status] > ceiling) {
        issues.push({ type: 'statement_capped', agent, detail: `"${clip(s.text)}" was stronger than its supporting findings; capped to ${NAME_BY_RANK[Math.max(ceiling, 0)]}.` });
        status = NAME_BY_RANK[Math.max(ceiling, 0)];
      }
    }
    return { ...s, status, findingIds: ids };
  };
  const fixAll = (xs: ReportStatement[]) => xs.map(fix);
  const clear = (flag: boolean, xs: ReportStatement[], label: string) => {
    if (flag) return fixAll(xs);
    if (xs.length) issues.push({ type: 'section_cleared', agent, detail: `${label} section was emptied: that source was not analyzed.` });
    return [];
  };

  const out: ProductDiscoveryReportV2 = {
    ...report,
    schemaVersion: REPORT_V2_VERSION,
    language: input.language,
    partial: opts.partial,
    problemAndSolution: { problem: fix(report.problemAndSolution.problem), solution: fix(report.problemAndSolution.solution) },
    offerings: fixAll(report.offerings),
    valueProposition: fix(report.valueProposition),
    targetCustomers: fixAll(report.targetCustomers),
    differentiation: fixAll(report.differentiation),
    websiteFindings: clear(analyzed.website, report.websiteFindings, 'Website'),
    repositoryFindings: clear(analyzed.repository, report.repositoryFindings, 'Repository'),
    documentFindings: clear(analyzed.documents, report.documentFindings, 'Document'),
    visualFindings: clear(analyzed.visual, report.visualFindings, 'Visual identity'),
    strengths: fixAll(report.strengths),
    weaknessesRisksUnknowns: fixAll(report.weaknessesRisksUnknowns),
  };

  // Every open disagreement must be visible.
  const mentioned = new Set(out.evidenceSummary.contradictions.flatMap((c) => c.findingIds));
  const contradictions = [...out.evidenceSummary.contradictions];
  for (const f of board.findings.filter((x) => x.crosscheck.status === 'disputed' && !mentioned.has(x.id))) {
    if (contradictions.length >= 12) break;
    contradictions.push({ topic: 'Cross-check disagreement', detail: `${f.agent} stated: "${clip(f.statement, 220)}". A reviewing agent disagreed.`, findingIds: [f.id], status: 'open' });
  }
  out.evidenceSummary = { ...out.evidenceSummary, contradictions };

  // System-controlled manifest fields.
  const m = out.productManifest;
  out.productManifest = {
    ...m,
    onlinePresence: {
      website: input.availableSources.websiteUrl,
      repository: input.availableSources.githubUrl,
      socialProfiles: input.availableSources.socialProfiles.map((s) => s.url).slice(0, 10),
    },
    brand: analyzed.visual ? { style: m.brand?.style ?? null, notes: m.brand?.notes ?? null, palette: opts.palette.length ? opts.palette : (m.brand?.palette ?? []) } : null,
    evidenceFindingIds: [...new Set(m.evidenceFindingIds)].filter((id) => byId.has(id)),
    overallConfidence: Math.min(m.overallConfidence, opts.partial ? 0.7 : 0.9), // never claim near-certainty from text analysis
  };
  return { report: out, issues, analyzed };
}
