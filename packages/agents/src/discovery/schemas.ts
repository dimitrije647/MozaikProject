import { z } from 'zod';

/**
 * Evidence classification used across the Product Discovery pipeline.
 *  - claimed:  asserted by the user or a supplied source, NOT independently verified
 *  - inferred: an AI conclusion derived from the supplied information
 *  - disputed: conflicting evidence
 *  - unknown:  cannot be determined from what was supplied
 *  - verified: independently checked against an identifiable source. NOTHING can be `verified` in this
 *              iteration (no crawling/search/verification exists), so the policy downgrades any such label.
 */
export const EVIDENCE_STATUSES = ['verified', 'claimed', 'inferred', 'disputed', 'unknown'] as const;
export const EvidenceStatus = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

export const SOURCE_TYPES = ['intake_field', 'user_input', 'ai_inference', 'not_available'] as const;

export const EvidenceItem = z.object({
  id: z.string().min(1).max(40),
  statement: z.string().min(1).max(600),
  status: EvidenceStatus,
  sourceType: z.enum(SOURCE_TYPES),
  /** For `claimed`: a field path from the input (e.g. "intake.shortDescription") or a short VERBATIM quote. */
  sourceReference: z.string().max(300).nullable(),
  /** 0..1, how sure the author is that the statement is right. */
  confidence: z.number().min(0).max(1).nullable(),
  explanation: z.string().max(600).nullable(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const BUSINESS_TYPES = [
  'software',
  'physical_product',
  'service',
  'local_business',
  'education',
  'agency',
  'ecommerce',
  'other',
  'unclear',
] as const;
export const BusinessType = z.enum(BUSINESS_TYPES);

// ---- Agent A: Input Analyzer ----------------------------------------------------------------

export const InputAnalysis = z.object({
  summary: z.string().min(1).max(1500),
  category: z.string().min(1).max(200),
  businessType: BusinessType,
  problem: z.string().max(800).nullable(),
  solution: z.string().max(800).nullable(),
  valueProposition: z.string().max(600).nullable(),
  businessGoals: z.array(z.string().max(300)).max(10),
  knownFacts: z.array(EvidenceItem).max(25),
  missingInformation: z.array(z.string().max(300)).max(20),
  assumptions: z.array(EvidenceItem).max(15),
  confidence: z.number().min(0).max(1),
});
export type InputAnalysis = z.infer<typeof InputAnalysis>;

// ---- Agent B: Text Analyzer -----------------------------------------------------------------

const Labeled = z.object({ text: z.string().min(1).max(500), status: EvidenceStatus, basis: z.string().max(400) });
export type Labeled = z.infer<typeof Labeled>;

export const TextAnalysis = z.object({
  explanation: z.string().min(1).max(1800),
  businessType: BusinessType,
  featuresOrOfferings: z.array(Labeled).max(15),
  customerNeeds: z.array(Labeled).max(12),
  differentiators: z.array(Labeled).max(10),
  strengths: z.array(Labeled).max(10),
  weaknesses: z.array(Labeled).max(10),
  ambiguities: z.array(z.string().max(300)).max(12),
  validationQuestions: z.array(z.string().max(300)).max(12),
  messagingOpportunities: z.array(Labeled).max(10),
  evidence: z.array(EvidenceItem).max(20),
});
export type TextAnalysis = z.infer<typeof TextAnalysis>;

// ---- Agent C: Product Synthesizer (final report) ---------------------------------------------

const Statement = Labeled;
const Contradiction = z.object({
  topic: z.string().max(200),
  detail: z.string().max(600),
  sources: z.array(z.string().max(80)).max(4),
});
const NextStep = z.object({
  action: z.string().min(1).max(300),
  priority: z.enum(['high', 'medium', 'low']),
  rationale: z.string().max(400),
});

export const REPORT_SCHEMA_VERSION = 1;

export const ProductDiscoveryReport = z.object({
  schemaVersion: z.number().int(),
  language: z.string().max(40),
  /** True when one analyzer failed and the report is based on a single analysis. */
  partial: z.boolean(),
  executiveSummary: z.string().min(1).max(2000),
  overview: z.object({
    name: z.string().max(200),
    category: z.string().max(200),
    businessType: BusinessType,
    summary: z.string().max(1500),
  }),
  problemAndSolution: z.object({ problem: Statement, solution: Statement }),
  valueProposition: Statement,
  audienceHypotheses: z.array(Statement).max(10),
  featuresServices: z.array(Statement).max(15),
  differentiators: z.array(Statement).max(10),
  strengths: z.array(Statement).max(10),
  weaknessesAndRisks: z.array(Statement).max(12),
  missingInformation: z.array(z.string().max(300)).max(20),
  evidenceAndAssumptions: z.array(EvidenceItem).max(30),
  contradictions: z.array(Contradiction).max(10),
  marketingOpportunities: z.array(Statement).max(10),
  nextSteps: z.array(NextStep).min(1).max(10),
  followUpQuestions: z.array(z.string().max(300)).max(12),
});
export type ProductDiscoveryReport = z.infer<typeof ProductDiscoveryReport>;

// ---- JSON Schema for OpenAI structured outputs ------------------------------------------------

const UNSUPPORTED_KEYWORDS = ['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format', 'default', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];

/**
 * Converts a zod schema to the JSON Schema subset OpenAI's strict structured outputs accepts:
 * every object has all keys required and `additionalProperties: false`; bounds keywords (which strict
 * mode rejects) are removed here and still enforced by zod when the answer is parsed.
 */
export function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = { ...(node as Record<string, unknown>) };
    for (const k of UNSUPPORTED_KEYWORDS) delete obj[k];
    for (const [k, v] of Object.entries(obj)) obj[k] = walk(v);
    if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
      obj.required = Object.keys(obj.properties as object);
      obj.additionalProperties = false;
    }
    return obj;
  };
  return walk(raw) as Record<string, unknown>;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Parses a model answer as JSON (tolerating a markdown fence) and validates it against `schema`. */
/**
 * Length bounds are removed from the wire schema (OpenAI strict mode rejects them), so a model cannot
 * know them and regularly overshoots a limit by a few characters or one list item. Trimming that excess is
 * safe (a trimmed excerpt is still a verbatim prefix) and far cheaper than a repair call. Only
 * `too_big` problems on strings and arrays are trimmed; every other problem still fails the answer.
 */
function trimExcess(json: unknown, issues: z.core.$ZodIssue[]): boolean {
  let changed = false;
  for (const i of issues) {
    if (i.code !== 'too_big' || (i.origin !== 'string' && i.origin !== 'array')) return false;
    const max = Number(i.maximum);
    if (!Number.isFinite(max)) return false;
    let parent: any = json;
    for (const key of i.path.slice(0, -1)) parent = parent?.[key as never];
    const last = i.path[i.path.length - 1];
    if (parent === undefined || parent === null || last === undefined) {
      return false;
    }
    const value = parent[last as never];
    if (typeof value === 'string' && i.origin === 'string') {
      parent[last as never] = value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
      changed = true;
    } else if (Array.isArray(value) && i.origin === 'array') {
      parent[last as never] = value.slice(0, max);
      changed = true;
    } else return false;
  }
  return changed;
}

export function parseModelJson<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return { ok: false, issues: ['The answer was not valid JSON (it may have been cut off by the output limit).'] };
  }
  let result = schema.safeParse(json);
  for (let pass = 0; pass < 3 && !result.success && trimExcess(json, result.error.issues); pass++) result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
