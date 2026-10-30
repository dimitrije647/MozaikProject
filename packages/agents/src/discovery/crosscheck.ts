import { INPUT_FIELD_PATHS, inputCorpus, normalizeText, type DiscoveryInput } from './input';
import {
  REPORT_SCHEMA_VERSION,
  type EvidenceItem,
  type InputAnalysis,
  type Labeled,
  type ProductDiscoveryReport,
  type TextAnalysis,
} from './schemas';

export interface CrossCheckIssue {
  type: 'verified_not_allowed' | 'unverifiable_source' | 'business_type_mismatch' | 'status_conflict';
  severity: 'low' | 'medium' | 'high';
  detail: string;
  agents: string[];
}

export interface Findings {
  input_analysis: InputAnalysis | null;
  text_analysis: TextAnalysis | null;
}

// ---- Grounding: is a "claimed" fact really traceable to what the user supplied? ---------------

function fieldValue(input: DiscoveryInput, path: string): string | null {
  const map: Record<string, string | null | undefined> = {
    'project.name': input.project.name,
    'project.description': input.project.description,
    'intake.productName': input.intake?.productName,
    'intake.shortDescription': input.intake?.shortDescription,
    'intake.targetMarket': input.intake?.targetMarket,
    'intake.targetAudience': input.intake?.targetAudience,
    'intake.marketingGoal': input.intake?.marketingGoal,
    'intake.campaignDuration': input.intake?.campaignDuration,
    'intake.stylePreference': input.intake?.stylePreference,
  };
  const note = /^notes\[(\d+)\]/.exec(path);
  if (note) {
    const n = input.notes[Number(note[1])];
    return n ? `${n.title} ${n.content}` : null;
  }
  return map[path] ?? null;
}

/**
 * A reference is grounded when it names a supplied, non-empty input field, or contains a quoted /
 * bare snippet that appears VERBATIM in the supplied text. Quotes stay in the input's language, so
 * the check works even when the report is written in a different language.
 */
export function isGroundedReference(ref: string | null | undefined, input: DiscoveryInput): boolean {
  if (!ref) return false;
  const paths = [...INPUT_FIELD_PATHS, ...input.notes.map((_, i) => `notes[${i}]`)];
  for (const p of paths) {
    if (ref.includes(p) && fieldValue(input, p)) return true;
  }
  const corpus = inputCorpus(input);
  const quoted = [...ref.matchAll(/["“„'«]([^"”“'»]{6,})["”'»]/g)].map((m) => m[1]);
  const candidates = quoted.length ? quoted : [ref];
  return candidates.some((q) => normalizeText(q).length >= 6 && corpus.includes(normalizeText(q)));
}

// ---- Evidence policy ------------------------------------------------------------------------

const USER_SOURCES = ['intake_field', 'user_input'];

/** Applies the evidence policy to a full evidence item. */
export function applyEvidencePolicy(item: EvidenceItem, input: DiscoveryInput, agent: string, issues: CrossCheckIssue[]): EvidenceItem {
  if (item.status === 'verified') {
    // Nothing can be independently verified in this iteration (no crawling or external sources).
    const status = USER_SOURCES.includes(item.sourceType) ? 'claimed' : 'inferred';
    issues.push({ type: 'verified_not_allowed', severity: 'medium', detail: `"${clip(item.statement)}" was labeled verified, but no independent source exists. Downgraded to ${status}.`, agents: [agent] });
    return applyEvidencePolicy({ ...item, status }, input, agent, issues);
  }
  if (item.status === 'claimed' && !(USER_SOURCES.includes(item.sourceType) && isGroundedReference(item.sourceReference, input))) {
    issues.push({ type: 'unverifiable_source', severity: 'medium', detail: `"${clip(item.statement)}" was labeled as stated by the user, but its source could not be traced to the supplied text. Downgraded to inferred.`, agents: [agent] });
    return { ...item, status: 'inferred', explanation: item.explanation ?? 'Downgraded: could not be traced to the supplied input.' };
  }
  return item;
}

/** Applies the evidence policy to a labeled statement (status + basis). */
export function applyLabeledPolicy(item: Labeled, input: DiscoveryInput, agent: string, issues: CrossCheckIssue[]): Labeled {
  if (item.status === 'verified') {
    issues.push({ type: 'verified_not_allowed', severity: 'medium', detail: `"${clip(item.text)}" was labeled verified, but no independent source exists. Downgraded to inferred.`, agents: [agent] });
    return { ...item, status: 'inferred' };
  }
  if (item.status === 'claimed' && !isGroundedReference(item.basis, input)) {
    issues.push({ type: 'unverifiable_source', severity: 'low', detail: `"${clip(item.text)}" was labeled as stated by the user, but its basis could not be traced to the supplied text. Downgraded to inferred.`, agents: [agent] });
    return { ...item, status: 'inferred' };
  }
  return item;
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---- Cross-check between the two analyzers --------------------------------------------------

const tokens = (s: string) => new Set(normalizeText(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter((t) => t.length > 3));
const similarity = (a: string, b: string) => {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
};

/**
 * Deterministic reconciliation of the analyzers' outputs: enforces the evidence policy on every
 * item, then flags disagreements between the two agents. Returns normalized findings plus issues.
 * No LLM is involved: this is the code-level safety net against unsupported conclusions.
 */
export function crossCheck(input: DiscoveryInput, findings: Findings): { findings: Findings; issues: CrossCheckIssue[] } {
  const issues: CrossCheckIssue[] = [];
  const A = findings.input_analysis;
  const B = findings.text_analysis;

  const a = A && {
    ...A,
    knownFacts: A.knownFacts.map((i) => applyEvidencePolicy(i, input, 'Input Analyzer', issues)),
    assumptions: A.assumptions.map((i) => applyEvidencePolicy(i, input, 'Input Analyzer', issues)),
  };
  const lab = (xs: Labeled[]) => xs.map((x) => applyLabeledPolicy(x, input, 'Text Analyzer', issues));
  const b = B && {
    ...B,
    featuresOrOfferings: lab(B.featuresOrOfferings),
    customerNeeds: lab(B.customerNeeds),
    differentiators: lab(B.differentiators),
    strengths: lab(B.strengths),
    weaknesses: lab(B.weaknesses),
    messagingOpportunities: lab(B.messagingOpportunities),
    evidence: B.evidence.map((i) => applyEvidencePolicy(i, input, 'Text Analyzer', issues)),
  };

  if (a && b) {
    const ta = a.businessType;
    const tb = b.businessType;
    if (ta !== tb && ta !== 'unclear' && tb !== 'unclear') {
      issues.push({ type: 'business_type_mismatch', severity: 'medium', detail: `The analyzers classified the business differently: Input Analyzer says "${ta}", Text Analyzer says "${tb}".`, agents: ['Input Analyzer', 'Text Analyzer'] });
    }
    for (const x of [...a.knownFacts, ...a.assumptions]) {
      for (const y of b.evidence) {
        if (x.status !== y.status && similarity(x.statement, y.statement) >= 0.7) {
          issues.push({ type: 'status_conflict', severity: 'low', detail: `Both analyzers discuss "${clip(x.statement)}" but classify it differently (${x.status} vs ${y.status}).`, agents: ['Input Analyzer', 'Text Analyzer'] });
        }
      }
    }
  }
  return { findings: { input_analysis: a, text_analysis: b }, issues };
}

// ---- Final report post-processing -----------------------------------------------------------

/**
 * Last deterministic pass over the Synthesizer's report: enforces the evidence policy, stamps the
 * system-controlled fields, and guarantees that cross-check disagreements are visible in the report
 * as contradictions / disputed evidence even if the model glossed over them.
 */
export function finalizeReport(
  report: ProductDiscoveryReport,
  input: DiscoveryInput,
  crossIssues: CrossCheckIssue[],
  partial: boolean,
): { report: ProductDiscoveryReport; issues: CrossCheckIssue[] } {
  const issues: CrossCheckIssue[] = [];
  const st = (xs: Labeled[]) => xs.map((x) => applyLabeledPolicy(x, input, 'Product Synthesizer', issues));

  const out: ProductDiscoveryReport = {
    ...report,
    schemaVersion: REPORT_SCHEMA_VERSION,
    language: input.language,
    partial,
    problemAndSolution: {
      problem: applyLabeledPolicy(report.problemAndSolution.problem, input, 'Product Synthesizer', issues),
      solution: applyLabeledPolicy(report.problemAndSolution.solution, input, 'Product Synthesizer', issues),
    },
    valueProposition: applyLabeledPolicy(report.valueProposition, input, 'Product Synthesizer', issues),
    audienceHypotheses: st(report.audienceHypotheses),
    featuresServices: st(report.featuresServices),
    differentiators: st(report.differentiators),
    strengths: st(report.strengths),
    weaknessesAndRisks: st(report.weaknessesAndRisks),
    marketingOpportunities: st(report.marketingOpportunities),
    evidenceAndAssumptions: report.evidenceAndAssumptions.map((i) => applyEvidencePolicy(i, input, 'Product Synthesizer', issues)),
  };

  // Surface analyzer disagreements that the report does not already mention.
  let n = 0;
  for (const issue of crossIssues.filter((i) => i.type === 'business_type_mismatch' || i.type === 'status_conflict')) {
    const mentioned = out.contradictions.some((c) => similarity(c.detail, issue.detail) >= 0.5);
    if (mentioned) continue;
    out.contradictions = [...out.contradictions, { topic: issue.type === 'business_type_mismatch' ? 'Business classification' : 'Evidence status', detail: issue.detail, sources: issue.agents }].slice(0, 10);
    if (out.evidenceAndAssumptions.length < 30) {
      out.evidenceAndAssumptions = [...out.evidenceAndAssumptions, { id: `xc-${++n}`, statement: issue.detail, status: 'disputed', sourceType: 'ai_inference', sourceReference: null, confidence: null, explanation: 'Raised by the deterministic cross-check between analyzers.' }];
    }
  }
  return { report: out, issues };
}
