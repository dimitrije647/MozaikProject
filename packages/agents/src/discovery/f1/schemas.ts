import { z } from 'zod';
import { BusinessType, EvidenceStatus } from '../schemas';
import { FINDING_CATEGORIES } from './board';

/**
 * Wire schemas (strict structured outputs) for the F1 agents. Every field is required; "absent" is
 * `null` or an empty array. Length/size bounds here are enforced by zod when the answer is parsed
 * (OpenAI strict mode does not accept them, see toWireSchema).
 */

const text = (max: number) => z.string().max(max);

// ---- Analysts (A1 to A6) -----------------------------------------------------------------------

export const LlmFinding = z.object({
  category: z.enum(FINDING_CATEGORIES),
  statement: z.string().min(3).max(700),
  classification: EvidenceStatus,
  sourceType: z.enum(['intake_field', 'user_input', 'website', 'search_result', 'repository', 'uploaded_file', 'image', 'ai_inference']),
  /** Id of a <source> block this finding rests on (e.g. "S2"), or null. */
  sourceId: z.string().max(12).nullable(),
  /** Field path (intake.shortDescription), URL, repository file or "page N". */
  locator: z.string().max(300).nullable(),
  /** VERBATIM excerpt from the source supporting the statement (max 300 chars). */
  excerpt: z.string().max(400).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  importance: z.enum(['high', 'medium', 'low']),
});
export type LlmFinding = z.infer<typeof LlmFinding>;

export const AgentOutput = z.object({
  summary: text(1200),
  findings: z.array(LlmFinding).max(18),
  missingInformation: z.array(text(300)).max(12),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

// ---- Cross-check answers -----------------------------------------------------------------------

export const CrosscheckAnswer = z.object({
  answers: z
    .array(
      z.object({
        claimId: z.string().max(20),
        verdict: z.enum(['agree', 'disagree', 'correct', 'insufficient_evidence']),
        rationale: text(500),
        /** Only for verdict "correct": the corrected statement. */
        correction: text(500).nullable(),
      }),
    )
    .max(8),
});
export type CrosscheckAnswer = z.infer<typeof CrosscheckAnswer>;

// ---- Synthesizer: report v2 + Product Manifest --------------------------------------------------

export const ReportStatement = z.object({
  text: z.string().min(2).max(700),
  status: EvidenceStatus,
  basis: text(400),
  /** Ids of board findings this statement rests on (e.g. "A3-2"). Provenance. */
  findingIds: z.array(z.string().max(20)).max(10),
});
export type ReportStatement = z.infer<typeof ReportStatement>;

export const ProductManifest = z.object({
  name: z.string().max(200),
  tagline: z.string().max(200).nullable(),
  category: z.string().max(200),
  industry: z.string().max(200).nullable(),
  businessType: BusinessType,
  offering: z.object({ summary: text(700), items: z.array(text(200)).max(14) }),
  problem: text(500).nullable(),
  valueProposition: text(500).nullable(),
  targetCustomers: z.array(text(240)).max(10),
  geography: z.array(text(100)).max(10),
  languages: z.array(text(60)).max(8),
  goals: z.array(text(260)).max(10),
  differentiators: z.array(text(260)).max(10),
  /** Only present when images were actually analyzed. */
  brand: z.object({ style: text(300).nullable(), palette: z.array(text(20)).max(6), notes: text(400).nullable() }).nullable(),
  onlinePresence: z.object({ website: text(300).nullable(), repository: text(300).nullable(), socialProfiles: z.array(text(300)).max(10) }),
  openQuestions: z.array(text(260)).max(12),
  overallConfidence: z.number().min(0).max(1),
  confidenceNotes: text(500),
  evidenceFindingIds: z.array(z.string().max(20)).max(40),
});
export type ProductManifest = z.infer<typeof ProductManifest>;

export const REPORT_V2_VERSION = 2;

export const ProductDiscoveryReportV2 = z.object({
  schemaVersion: z.number().int(),
  language: z.string().max(40),
  /** True when some activated agent failed or timed out. */
  partial: z.boolean(),
  executiveSummary: text(2400),
  identity: z.object({ name: z.string().max(200), category: z.string().max(200), industry: z.string().max(200).nullable(), businessType: BusinessType, summary: text(1500) }),
  problemAndSolution: z.object({ problem: ReportStatement, solution: ReportStatement }),
  offerings: z.array(ReportStatement).max(18),
  valueProposition: ReportStatement,
  targetCustomers: z.array(ReportStatement).max(12),
  differentiation: z.array(ReportStatement).max(12),
  websiteFindings: z.array(ReportStatement).max(14),
  repositoryFindings: z.array(ReportStatement).max(14),
  documentFindings: z.array(ReportStatement).max(14),
  visualFindings: z.array(ReportStatement).max(14),
  strengths: z.array(ReportStatement).max(12),
  weaknessesRisksUnknowns: z.array(ReportStatement).max(16),
  evidenceSummary: z.object({
    narrative: text(1500),
    contradictions: z
      .array(z.object({ topic: z.string().max(200), detail: text(700), findingIds: z.array(z.string().max(20)).max(8), status: z.enum(['open', 'resolved']) }))
      .max(12),
  }),
  missingInformation: z.array(text(320)).max(24),
  recommendedInvestigations: z.array(z.object({ action: z.string().min(2).max(320), priority: z.enum(['high', 'medium', 'low']), rationale: text(450) })).min(1).max(12),
  productManifest: ProductManifest,
});
export type ProductDiscoveryReportV2 = z.infer<typeof ProductDiscoveryReportV2>;
