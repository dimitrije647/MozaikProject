import { z } from 'zod';
import { BusinessType, EvidenceStatus } from '../discovery/schemas';
import { FINDING_KINDS } from '../audit/board';
import { CHANNEL_IDS } from './channels';

/**
 * Wire schemas for the F3 agents and the Campaign Strategy Report. Every field is required ("absent" is null
 * or an empty array) so OpenAI strict structured outputs accept them. Length/size bounds are enforced when the
 * answer is parsed; excess is trimmed (see parseModelJson), anything structurally wrong fails.
 */
const text = (max: number) => z.string().max(max);
const list = (max: number, items = 5) => z.array(text(max)).max(items);
const Channel = z.enum(CHANNEL_IDS);
const DateBasis = z.enum(['public_holiday_api', 'recurring_pattern', 'user_provided', 'speculative']);

// ---- typed details (one per research area; a finding carries exactly the one that matches its author) ----------------------

export const SegmentDetail = z.object({
  name: z.string().min(2).max(100),
  kind: z.enum(['b2b', 'b2c', 'mixed']),
  needs: list(160),
  painPoints: list(160),
  motivations: list(160),
  barriers: list(160),
  decisionProcess: text(300).nullable(),
  messagingPreferences: list(160, 4),
  productFit: z.enum(['strong', 'moderate', 'weak', 'unknown']),
});
export type AudienceSegment = z.infer<typeof SegmentDetail>;

export const CompetitorDetail = z.object({
  name: z.string().min(2).max(120),
  url: text(300).nullable(),
  relation: z.enum(['direct', 'indirect', 'unverified']),
  /** "confirmed" only when a page of this competitor was actually retrieved in this run. */
  existence: z.enum(['confirmed', 'unconfirmed']),
  positioning: text(300).nullable(),
  offerings: list(120, 6),
  differentiators: list(160),
  weaknesses: list(160),
  /** A positioning theme several competitors share (a crowded space). */
  crowdedTheme: text(160).nullable(),
});
export type CompetitorProfile = z.infer<typeof CompetitorDetail>;

export const ChannelDetail = z.object({
  channel: Channel,
  fit: z.enum(['strong', 'moderate', 'weak', 'unsuitable']),
  audienceFit: text(300),
  organicSuitability: z.enum(['high', 'medium', 'low']),
  paidSuitability: z.enum(['high', 'medium', 'low', 'unknown']),
  contentTypes: list(80, 6),
  complexity: z.enum(['low', 'medium', 'high']),
  constraints: list(200),
  measurement: list(160),
  risks: list(200),
  role: z.enum(['primary', 'secondary', 'test', 'skip']),
});
export type ChannelEvaluation = z.infer<typeof ChannelDetail>;

export const OpportunityDetail = z.object({
  name: z.string().min(2).max(120),
  window: text(100),
  startDate: text(10).nullable(),
  endDate: text(10).nullable(),
  dateBasis: DateBasis,
  leadTimeWeeks: z.number().int().nullable(),
  relevance: text(300),
  regionNote: text(160).nullable(),
});
export type SeasonalOpportunity = z.infer<typeof OpportunityDetail>;

export const LlmStrategyFinding = z.object({
  kind: z.enum(FINDING_KINDS),
  title: z.string().min(3).max(140),
  statement: z.string().min(3).max(600),
  classification: EvidenceStatus,
  importance: z.enum(['high', 'medium', 'low']),
  sourceType: z.enum(['website', 'search_result', 'holiday_api', 'user_provided', 'f1_finding', 'f2_finding', 'ai_inference']),
  /** Id of a <source> block (e.g. "S3"), or null. Never an F1/F2 finding id. */
  sourceId: z.string().max(12).nullable(),
  /** URL, or the F1/F2 finding id when sourceType is f1_finding / f2_finding. */
  locator: z.string().max(300).nullable(),
  /** VERBATIM line or phrase copied from the cited source. */
  excerpt: z.string().max(400).nullable(),
  /** One or two sentences: why this follows from the evidence. */
  reasoning: text(400),
  confidence: z.number().min(0).max(1).nullable(),
  recommendation: text(400).nullable(),
  segment: SegmentDetail.nullable(),
  competitor: CompetitorDetail.nullable(),
  channel: ChannelDetail.nullable(),
  opportunity: OpportunityDetail.nullable(),
});
export type LlmStrategyFinding = z.infer<typeof LlmStrategyFinding>;

export const StrategyAgentOutput = z.object({
  summary: text(1000),
  findings: z.array(LlmStrategyFinding).max(12),
  missingInformation: z.array(text(300)).max(10),
});
export type StrategyAgentOutput = z.infer<typeof StrategyAgentOutput>;

// ---- the strategy (what the Campaign Strategist writes) ---------------------------------------------------------------------

export const StrategyStatement = z.object({
  text: z.string().min(2).max(700),
  status: EvidenceStatus,
  basis: text(300),
  /** Qualification that must accompany the statement (for example: competitors use the same theme). */
  caveat: text(300).nullable(),
  findingIds: z.array(z.string().max(24)).max(8),
});
export type StrategyStatement = z.infer<typeof StrategyStatement>;

const Ids = z.array(z.string().max(24)).max(8);
const Role = z.enum(['primary', 'secondary', 'test']);

export const CreativeBriefDraft = z.object({
  objective: text(300),
  audiencePrimary: text(200),
  audienceSecondary: list(200, 3),
  messagingPriorities: list(240),
  channels: z.array(z.object({ channel: Channel, formats: list(80), notes: text(240) })).max(5),
  visualDirection: text(400).nullable(),
  brandConstraints: list(240, 6),
  claimsToAvoid: z.array(z.object({ claim: text(240), reason: text(240) })).max(8),
  requiredEvidence: list(240, 6),
  deliverables: z.array(z.object({ type: text(100), channel: Channel.nullable(), count: z.number().int() })).max(8),
  suggestedConceptCount: z.number().int(),
  toneOfVoice: text(200).nullable(),
});
export type CreativeBriefDraft = z.infer<typeof CreativeBriefDraft>;

export const STRATEGY_REPORT_VERSION = 1;

export const StrategyDraft = z.object({
  schemaVersion: z.number().int(),
  language: z.string().max(40),
  /** True when an ACTIVATED participant failed or timed out. A skipped one is not a failure. */
  partial: z.boolean(),
  executiveSummary: text(2000),
  priorityAudiences: z.array(z.object({ segmentName: z.string().max(100), priority: z.enum(['primary', 'secondary', 'later']), rationale: text(400), findingIds: Ids })).max(6),
  campaignGoals: z.array(z.object({ goal: text(200), measuredBy: text(200), rationale: text(300), findingIds: Ids })).max(5),
  valueProposition: StrategyStatement,
  positioning: z.object({ statement: StrategyStatement, differentiators: z.array(StrategyStatement).max(5), crowdedThemesToAvoid: list(160, 6) }),
  mainMessages: z.array(z.object({ message: text(240), audience: text(120), proofNeeded: list(200, 3), findingIds: Ids })).max(6),
  channels: z.array(z.object({ channel: Channel, role: Role, approach: z.enum(['organic', 'paid', 'mixed']), rationale: text(500), formats: list(80), findingIds: Ids })).max(6),
  organicPaid: z.object({ approach: text(600), paidRole: text(400), budgetNote: text(300) }),
  timing: z.array(z.object({ window: text(100), rationale: text(300), dateBasis: DateBasis, findingIds: Ids })).max(5),
  contentPillars: z.array(z.object({ name: text(100), description: text(300), channels: z.array(Channel).max(4), findingIds: Ids })).max(5),
  campaignStructure: z.array(z.object({ phase: text(100), duration: text(80), objective: text(250), activities: list(160) })).max(5),
  kpis: z.array(z.object({ kpi: text(140), channel: Channel.nullable(), measuredBy: text(200) })).max(8),
  risks: z.array(z.object({ risk: text(250), mitigation: text(250), findingIds: Ids })).max(8),
  strategicPriorities: z.array(z.object({ priority: text(200), rationale: text(300), findingIds: Ids })).max(6),
  disagreements: z.array(z.object({ topic: text(160), positions: list(300, 4), resolution: text(400), resolved: z.boolean(), findingIds: Ids })).max(6),
  openQuestions: z.array(text(260)).max(10),
  additionalLimitations: z.array(text(300)).max(8),
  creativeBrief: CreativeBriefDraft,
});
export type StrategyDraft = z.infer<typeof StrategyDraft>;

// ---- the stored report: the draft (policy-checked) plus sections the SYSTEM fills from measured/collected data ---------------------

const Metric = z.object({ label: z.string(), value: z.string() });
const Ref = z.object({ findingId: z.string(), agent: z.string(), status: EvidenceStatus, confidence: z.number().nullable(), sourceId: z.string().nullable(), locator: z.string().nullable(), crosscheck: z.string() });

export const F4CreativeBrief = CreativeBriefDraft.extend({
  /** Copied from F1/F2, never written by a model. */
  productIdentity: z.object({ name: z.string(), category: z.string(), businessType: BusinessType.or(z.string()), summary: z.string(), valueProposition: z.string().nullable() }),
  language: z.string(),
  visualPalette: z.array(z.string()),
  visualBasis: z.enum(['f1_measured_palette', 'none']),
  provenance: z.object({ f1ReportId: z.string(), f2AuditId: z.string(), strategyRunId: z.string().nullable() }),
});
export type F4CreativeBrief = z.infer<typeof F4CreativeBrief>;

export const CampaignStrategyReport = StrategyDraft.omit({ creativeBrief: true }).extend({
  /** 2. Product context from F1 (not written by a model). */
  productContext: z.object({
    f1ReportId: z.string(),
    f1SchemaVersion: z.number(),
    f1GeneratedAt: z.string().nullable(),
    name: z.string(),
    category: z.string(),
    businessType: z.string(),
    summary: z.string(),
    offering: z.string(),
    valueProposition: z.string().nullable(),
    targetCustomers: z.array(z.string()),
    geography: z.array(z.string()),
    f1Confidence: z.number(),
  }),
  /** 3. What F2 observed, with its age (an old audit is not today's reality). */
  existingMarketing: z.object({
    f2AuditId: z.string(),
    f2SchemaVersion: z.number(),
    f2GeneratedAt: z.string().nullable(),
    ageDays: z.number().nullable(),
    stale: z.boolean(),
    partial: z.boolean(),
    mainProblems: z.array(z.object({ title: z.string(), severity: z.string(), area: z.string(), status: EvidenceStatus })),
    /** F2's unresolved contradictions travel with the strategy so no later phase builds on a disputed observation (absent in older reports). */
    contradictions: z.array(z.object({ topic: z.string(), detail: z.string(), status: z.enum(['open', 'resolved']) })).max(6).default([]),
    notes: z.array(z.string()),
  }),
  /** 4/5. Segments as hypotheses with their evidence. */
  audienceResearch: z.array(z.object({ segment: SegmentDetail, status: EvidenceStatus, statement: z.string(), reasoning: z.string(), ref: Ref })),
  /** 6. Competitors, with whether their existence was confirmed from a retrieved page. */
  competitorLandscape: z.object({
    searchProvider: z.string(),
    searchUsed: z.boolean(),
    userSuppliedUrls: z.number(),
    /** The fields below have defaults so strategies stored before they existed still parse (F4 reads stored strategies). */
    userSuppliedNames: z.number().default(0),
    /** Named competitors for which no website was found (they are reported, never guessed). */
    namesNotFound: z.array(z.string()).default([]),
    pagesRetrieved: z.number().default(0),
    /** Every competitor site that was really read: how many of its pages, how, and which social networks it links to. */
    sitesRead: z.array(z.object({ name: z.string(), host: z.string().nullable(), origin: z.string(), pages: z.number(), via: z.string(), socialPlatforms: z.array(z.string()) })).default([]),
    profiles: z.array(z.object({ competitor: CompetitorDetail, status: EvidenceStatus, statement: z.string(), ref: Ref })),
    gaps: z.array(z.string()),
  }),
  /** 8. Every channel scout's evaluation and every channel that did NOT get a scout, with the reason. */
  channelEvaluation: z.object({
    evaluated: z.array(z.object({ scout: z.string(), evaluation: ChannelDetail, status: EvidenceStatus, statement: z.string(), reasoning: z.string(), ref: Ref })),
    notSelected: z.array(z.object({ channel: Channel, reason: z.string(), score: z.number() })),
    selection: z.array(z.object({ channel: Channel, selected: z.boolean(), score: z.number(), ruleHits: z.array(z.string()), reason: z.string() })),
  }),
  /** 10. Seasonal opportunities and what each one rests on. */
  seasonalOpportunities: z.object({
    holidayCalendar: z.object({ used: z.boolean(), country: z.string().nullable(), note: z.string(), holidays: z.array(z.object({ date: z.string(), name: z.string() })) }),
    opportunities: z.array(z.object({ opportunity: OpportunityDetail, status: EvidenceStatus, statement: z.string(), ref: Ref })),
  }),
  /** 18. Evidence and cross-checks. */
  evidence: z.object({
    findingCount: z.number(),
    byStatus: z.record(z.string(), z.number()),
    crosschecks: z.array(z.object({ claimId: z.string(), producer: z.string(), reviewer: z.string(), verdict: z.string().nullable(), rationale: z.string().nullable(), status: z.string() })),
    sources: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), status: z.string(), origin: z.string(), live: z.boolean(), fixture: z.boolean(), error: z.string().nullable() })),
    findings: z.array(z.object({ id: z.string(), agent: z.string(), kind: z.string(), title: z.string(), statement: z.string(), classification: EvidenceStatus, sourceId: z.string().nullable(), locator: z.string().nullable(), excerpt: z.string().nullable(), crosscheck: z.string(), at: z.string() })),
  }),
  limitations: z.array(z.string()),
  metrics: z.array(Metric),
  /** 20. The machine-readable hand-off to F4. */
  creativeBrief: F4CreativeBrief,
});
export type CampaignStrategyReport = z.infer<typeof CampaignStrategyReport>;
export type CampaignStrategy = CampaignStrategyReport;
