import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';
import { IMAGE_QUALITIES, IMAGE_SIZES } from '../ai/openai-images';
import { AssetLineage, HybridBlock } from '../hybrid/records';

/**
 * Wire schemas for the F4 agents and the stored Campaign Package. Every field is required (absent = null / empty array) so
 * OpenAI strict structured outputs accept them. Over-length text is trimmed on parse (see parseModelJson).
 */
const text = (max: number) => z.string().max(max);
const list = (max: number, n = 5) => z.array(text(max)).max(n);
const Channel = z.enum(CHANNEL_IDS);

export const CTA_TYPES = ['book_consultation', 'request_quote', 'register', 'learn_more', 'purchase', 'contact'] as const;
export const CtaType = z.enum(CTA_TYPES);
export type CtaType = z.infer<typeof CtaType>;

export const SUPPORT = ['brief', 'f1', 'f2', 'f3', 'user', 'hypothesis'] as const;
const Claim = z.object({
  text: text(160),
  /** Where the claim comes from. "hypothesis" = not backed by the supplied material. */
  support: z.enum(SUPPORT),
  ref: text(24).nullable(),
});

// ---- A19 Copywriter ------------------------------------------------------------------------------------------------------

export const LlmConcept = z.object({
  key: z.string().min(1).max(8),
  name: z.string().min(2).max(80),
  angle: text(200),
  keyMessage: text(200),
  audience: text(120),
  ctaType: CtaType,
  ctaText: text(30),
  visualIdea: text(300),
});

export const LlmCopyVariant = z.object({
  conceptKey: z.string().max(8),
  channel: Channel,
  placement: z.enum(['paid_ad', 'organic_post', 'story']),
  length: z.enum(['short', 'long']),
  headline: z.string().min(2).max(70),
  body: z.string().min(2).max(400),
  description: text(120).nullable(),
  ctaText: text(30),
  ctaType: CtaType,
  hashtags: list(30),
  claims: z.array(Claim).max(4),
});

export const CopyOutput = z.object({
  summary: text(600),
  concepts: z.array(LlmConcept).max(5),
  variants: z.array(LlmCopyVariant).max(30),
  missingInformation: list(240, 8),
});
export type CopyOutput = z.infer<typeof CopyOutput>;

export const CopyRevisionOutput = z.object({
  revisions: z
    .array(z.object({ variantId: z.string().max(8), headline: z.string().min(2).max(70), body: z.string().min(2).max(400), ctaText: text(30), hashtags: list(30), claims: z.array(Claim).max(4) }))
    .max(10),
});
export type CopyRevisionOutput = z.infer<typeof CopyRevisionOutput>;

// ---- A20 Visual Creator (the text model plans; the image model paints) --------------------------------------------------

export const VisualDirections = z.object({
  summary: text(400),
  directions: z
    .array(
      z.object({
        conceptKey: z.string().max(8),
        subject: text(300),
        composition: text(300),
        mood: text(150),
        colors: list(20, 4),
        avoid: list(100),
        altText: text(200),
        promptDetails: text(500),
      }),
    )
    .max(5),
});
export type VisualDirections = z.infer<typeof VisualDirections>;

/**
 * Several original images per concept: the text model proposes what EACH planned image shows. The number of images, which concept
 * each belongs to and the creative seeds (role, perspective, lighting) are fixed beforehand by the deterministic allocation planner;
 * the model only fills in the picture, and its answer is never trusted for counts (an unknown or repeated slot is ignored and
 * replaced by a deterministic direction).
 */
export const VariationDirections = z.object({
  summary: text(300),
  variations: z
    .array(
      z.object({
        slotId: z.string().max(24),
        name: z.string().min(2).max(60),
        goal: text(180),
        medium: text(80),
        subject: text(260),
        setting: text(220),
        focalPoint: text(160),
        composition: text(260),
        mood: text(140),
        avoid: list(60, 3),
        altText: text(160),
        promptDetails: text(260),
      }),
    )
    .max(24),
});
export type VariationDirections = z.infer<typeof VariationDirections>;

export const VISUAL_ROLE_IDS = ['hero', 'detail', 'context', 'human', 'outcome', 'mood', 'symbol'] as const;
export const IMAGE_STAGES = ['configuration', 'budget', 'planning', 'provider', 'decoding', 'storage', 'cancelled'] as const;

// ---- concept critique (before any image is paid for) -------------------------------------------------------------------------------

export const ConceptCritique = z.object({
  summary: text(400),
  concepts: z
    .array(
      z.object({
        conceptId: z.string().max(8),
        /** 1-5 each: does it name THIS product and audience / is it unlike the other concepts / does it fit the audience / does it give a picture something concrete to show? */
        specificity: z.number().int(),
        originality: z.number().int(),
        audienceFit: z.number().int(),
        visualPotential: z.number().int(),
        verdict: z.enum(['keep', 'revise']),
        problem: text(240),
        /** Concrete direction for the Visual Creator (medium, subject, setting, what the eye should do). */
        artDirection: text(300),
        /** A stronger visual idea when the verdict is "revise", else null. */
        visualIdeaRevision: text(300).nullable(),
      }),
    )
    .max(5),
});
export type ConceptCritique = z.infer<typeof ConceptCritique>;

// ---- A22 Landing Content Builder -----------------------------------------------------------------------------------------

const Evidence = z.enum(SUPPORT);
export const LandingContent = z.object({
  seoTitle: text(70),
  metaDescription: text(170),
  hero: z.object({ headline: text(90), description: text(300), ctaText: text(30) }),
  valueProposition: text(300),
  benefits: z.array(z.object({ title: text(80), text: text(240), evidence: Evidence, ref: text(24).nullable() })).max(6),
  sections: z.array(z.object({ title: text(80), body: text(500) })).max(4),
  howItWorks: z.array(z.object({ step: text(80), text: text(240) })).max(5),
  faq: z.array(z.object({ q: text(140), a: text(320) })).max(6),
  /** Only supported evidence: no invented reviews, numbers or awards. */
  trustSignals: z.array(z.object({ text: text(200), evidence: Evidence, ref: text(24).nullable() })).max(4),
  ctas: z.array(z.object({ objective: CtaType, text: text(30) })).max(3),
  ctaObjective: CtaType,
  mobileHierarchy: list(100, 6),
});
export type LandingContent = z.infer<typeof LandingContent>;

export const LandingOutput = z.object({ summary: text(400), content: LandingContent, missingInformation: list(240, 8) });
export type LandingOutput = z.infer<typeof LandingOutput>;

export const LANDING_PATCH_PATHS = ['seoTitle', 'metaDescription', 'hero.headline', 'hero.description', 'hero.ctaText', 'valueProposition'] as const;
export const LANDING_LISTS = ['benefits', 'sections', 'faq', 'trustSignals'] as const;
export const LandingRevisionOutput = z.object({
  changes: z.array(z.object({ path: z.enum(LANDING_PATCH_PATHS), value: text(320) })).max(8),
  removals: z.array(z.object({ list: z.enum(LANDING_LISTS), index: z.number().int() })).max(8),
});
export type LandingRevisionOutput = z.infer<typeof LandingRevisionOutput>;

// ---- A23 Content & Brand Reviewer ------------------------------------------------------------------------------------------

export const ISSUE_KINDS = [
  'unsupported_claim', 'factual_error', 'strategy_mismatch', 'audience_mismatch', 'channel_mismatch', 'weak_cta', 'cta_mismatch', 'inconsistent_messaging',
  'brand_tone', 'brand_color', 'logo', 'text_overflow', 'low_contrast', 'poor_crop', 'wrong_dimensions', 'visual_irrelevant', 'visual_defect', 'layout_unavailable', 'concept_overlap', 'generic_concept', 'other',
] as const;
export const ISSUE_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;
export const RESPONSIBLE = ['copywriter', 'landing', 'layout', 'visual'] as const;

export const LlmReviewIssue = z.object({
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(ISSUE_SEVERITIES),
  /** An asset id, a copy variant id (V1..), "landing", or null. */
  assetRef: text(40).nullable(),
  finding: z.string().min(3).max(300),
  evidence: text(300),
  suggestedCorrection: text(300),
  responsibleAgent: z.enum(RESPONSIBLE),
});
/**
 * The acceptance criteria the reviewer scores 1 (unusable) to 5 (excellent); 3 is acceptable, 2 or less is weak. A score of 2 or less that
 * no specific issue explains still becomes a finding, so a weak campaign is never approved just because its JSON is valid.
 */
export const RUBRIC_CRITERIA = ['productAccuracy', 'brandConsistency', 'audienceRelevance', 'objectiveAlignment', 'originality', 'crossChannelConsistency'] as const;
export const Rubric = z.object({
  productAccuracy: z.number().int(),
  brandConsistency: z.number().int(),
  audienceRelevance: z.number().int(),
  objectiveAlignment: z.number().int(),
  originality: z.number().int(),
  crossChannelConsistency: z.number().int(),
});
export type Rubric = z.infer<typeof Rubric>;
/** `scores` is null for a review of images alone (the criteria are about the text and the concept). */
export const ReviewOutput = z.object({ summary: text(500), issues: z.array(LlmReviewIssue).max(10), scores: Rubric.nullable() });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ---- stored records ---------------------------------------------------------------------------------------------------------------

const Iso = z.string();
export const ConceptRecord = z.object({ id: z.string(), name: z.string(), angle: z.string(), keyMessage: z.string(), audience: z.string(), ctaType: CtaType, ctaText: z.string(), visualIdea: z.string() });
export type ConceptRecord = z.infer<typeof ConceptRecord>;

export const CopyVariantRecord = z.object({
  id: z.string(),
  conceptId: z.string(),
  channel: Channel,
  placement: z.string(),
  length: z.string(),
  headline: z.string(),
  body: z.string(),
  description: z.string().nullable(),
  ctaText: z.string(),
  ctaType: CtaType,
  hashtags: z.array(z.string()),
  claims: z.array(Claim),
  version: z.number(),
  /** Earlier texts, kept: a revision never overwrites the original. */
  history: z.array(z.object({ version: z.number(), headline: z.string(), body: z.string(), ctaText: z.string(), reason: z.string() })),
});
export type CopyVariantRecord = z.infer<typeof CopyVariantRecord>;

export const AssetRecord = z.object({
  id: z.string(),
  kind: z.enum(['image', 'layout']),
  conceptId: z.string(),
  channel: Channel.nullable(),
  format: z.string().nullable(),
  version: z.number(),
  parentAssetId: z.string().nullable(),
  mimeType: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  sha256: z.string(),
  /** ai_image = generated by the image model; brand_gradient = a deterministic brand-colored background (no image was generated). */
  source: z.enum(['ai_image', 'brand_gradient', 'template_render']),
  model: z.string().nullable(),
  quality: z.enum(IMAGE_QUALITIES).nullable(),
  requestedSize: z.enum(IMAGE_SIZES).nullable(),
  status: z.enum(['generated', 'rendered', 'superseded', 'failed']),
  /** Layout flags raised while rendering (clipping risk, upscaling, low contrast...). */
  flags: z.array(z.string()),
  altText: z.string().nullable(),
  /** Prompt metadata, secrets excluded. Never contains the API key. */
  promptMetadata: z.object({ promptChars: z.number(), directionSummary: z.string() }).nullable(),
  usage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  /** The planned image (variation) this original or layout belongs to. Absent on campaigns made with one image per concept. */
  variationId: z.string().nullable().optional(),
  createdAt: Iso,
  /** Hybrid Production lineage (origin, template id + version, source assets, rights). Absent on assets saved before it existed: read it through originOf. */
  ...AssetLineage.shape,
});
export type AssetRecord = z.infer<typeof AssetRecord>;

/**
 * What happened to ONE concept's original image: generated, failed (with the stage and the provider's own words) or skipped
 * (budget or configuration). This is how a brand-colored fallback is told apart from a real AI image, and why it exists.
 */
export const ImageResultRecord = z.object({
  conceptId: z.string(),
  conceptName: z.string(),
  model: z.string().nullable(),
  /** false = no request was made for this concept (budget, configuration, planning or an earlier systematic failure). */
  requestAttempted: z.boolean(),
  outcome: z.enum(['generated', 'failed', 'skipped']),
  stage: z.enum(['configuration', 'budget', 'planning', 'provider', 'decoding', 'storage', 'cancelled']).nullable(),
  errorCode: z.string().nullable(),
  providerStatus: z.number().nullable(),
  providerCode: z.string().nullable(),
  /** The provider's own (sanitized) message, or the safe generic one. */
  message: z.string().nullable(),
  /** One sentence for the user: what happened and what to do. */
  explanation: z.string().nullable(),
  /** true = the layouts use a deterministic brand-colored background instead of an AI image. */
  fallbackUsed: z.boolean(),
  /** The base image asset of this concept (the AI image, or the brand-colored fallback). */
  assetId: z.string(),
  /** true = not recorded during the run: derived afterwards from the run's recorded events (campaigns saved before results existed). */
  reconstructed: z.boolean().optional(),
});
export type ImageResultRecord = z.infer<typeof ImageResultRecord>;

export const LayoutRecord = z.object({
  id: z.string(),
  conceptId: z.string(),
  variantId: z.string(),
  assetId: z.string(),
  /** The ORIGINAL AI image (or the concept's brand-colored background) this layout was cut from. */
  baseAssetId: z.string(),
  /** The planned image (variation) of that original, when the campaign has several per concept. */
  variationId: z.string().nullable().optional(),
  format: z.string(),
  channel: Channel,
  headline: z.string(),
  ctaText: z.string(),
  flags: z.array(z.string()),
  /** Set on template creatives (Hybrid Production): the template this layout was rendered from and the planned slot it fills. */
  templateId: z.string().nullable().optional(),
  templateVersion: z.number().nullable().optional(),
  slotId: z.string().nullable().optional(),
});
export type LayoutRecord = z.infer<typeof LayoutRecord>;

// ---- several original images per concept ----------------------------------------------------------------------------------------

/** One planned image, fixed by the deterministic allocation planner (never by the model). */
export const PlannedVariation = z.object({
  variationId: z.string(),
  conceptId: z.string(),
  /** 1-based position within the concept. */
  index: z.number(),
  role: z.enum(VISUAL_ROLE_IDS),
  perspective: z.string(),
  lighting: z.string(),
  targetChannels: z.array(Channel),
  /** Layout formats cut from this original. */
  formats: z.array(z.string()),
  size: z.enum(IMAGE_SIZES),
});
export type PlannedVariation = z.infer<typeof PlannedVariation>;

export const ImageAllocationPlan = z.object({
  /** Original AI images asked for. */
  target: z.number(),
  /** Images the plan can really place (fewer than the target only when the per-concept cap does not allow more). */
  allocated: z.number(),
  maxPerConcept: z.number(),
  /** forecast = made before the concepts existed (equal weights); concepts = made from the real concepts and their channels. */
  basis: z.enum(['forecast', 'concepts']),
  perConcept: z.array(z.object({ conceptId: z.string(), name: z.string(), count: z.number(), channels: z.array(Channel), reason: z.string() })),
  variations: z.array(PlannedVariation),
  expectedLayouts: z.number(),
  rules: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ImageAllocationPlan = z.infer<typeof ImageAllocationPlan>;

/** What happened to ONE planned original image. Failed and skipped images are kept: nothing is hidden behind a brand-colored background. */
export const ImageVariationRecord = z.object({
  conceptId: z.string(),
  conceptName: z.string(),
  variationId: z.string(),
  index: z.number(),
  variationName: z.string(),
  visualGoal: z.string(),
  role: z.enum(VISUAL_ROLE_IDS),
  targetChannels: z.array(Channel),
  size: z.enum(IMAGE_SIZES),
  /** The exact prompt sent to the image model (empty when none was sent). Contains no credential. */
  imagePrompt: z.string(),
  /** model = the text model proposed this picture; deterministic = a direction built from the planner's seeds. */
  plannedBy: z.enum(['model', 'deterministic']),
  status: z.enum(['planned', 'generated', 'failed', 'skipped', 'blocked_by_budget']),
  requestAttempted: z.boolean(),
  stage: z.enum(IMAGE_STAGES).nullable(),
  generatedAssetId: z.string().nullable(),
  providerModel: z.string().nullable(),
  quality: z.string().nullable(),
  usage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  /** Known cost of this image (reported usage at the published rates, or the price-book figure). null = unknown. */
  costUsd: z.number().nullable(),
  safeError: z.object({ code: z.string(), message: z.string(), status: z.number().nullable(), providerCode: z.string().nullable() }).nullable(),
  /** One sentence for the user. */
  explanation: z.string().nullable(),
  /** Always true: these are generated marketing visuals, not photographs of a real place, product or person. */
  conceptual: z.boolean(),
});
export type ImageVariationRecord = z.infer<typeof ImageVariationRecord>;

/** The honest tally. "generated" counts genuine provider results only: never a failed attempt, a fallback gradient or a resized copy. */
export const ImageCounts = z.object({
  requested: z.number(),
  planned: z.number(),
  attempted: z.number(),
  generated: z.number(),
  failed: z.number(),
  skipped: z.number(),
  blockedByBudget: z.number(),
});
export type ImageCounts = z.infer<typeof ImageCounts>;

export const CostReport = z.object({
  currency: z.literal('USD'),
  priceBookVerifiedAt: z.string(),
  /** The amount the user approved for this run (null = none was set). An application-side limit, not an OpenAI billing cap. */
  approvedUsd: z.number().nullable(),
  /** Known cost of the finished requests. */
  spentUsd: z.number(),
  /** Requests that may have been billed although no usable result came back. */
  uncertainUsd: z.number(),
  textUsd: z.number(),
  imageUsd: z.number().nullable(),
  /** Requests sent without any known price: their cost is not in these figures unless the provider reported usage. */
  unpricedRequests: z.number(),
  /** Requests refused unsent because they would have exceeded the approved amount. */
  blockedRequests: z.number(),
  note: z.string(),
});
export type CostReport = z.infer<typeof CostReport>;

/** Where this campaign came from: a full run, or an image-only continuation of an earlier campaign (which is kept untouched). */
export const CampaignLineage = z.object({
  kind: z.enum(['full', 'image_continuation']),
  revision: z.number(),
  parentCampaignId: z.string().nullable(),
  reusedAssets: z.number(),
});
export type CampaignLineage = z.infer<typeof CampaignLineage>;

export const SkippedLayout = z.object({ conceptId: z.string(), format: z.string(), channel: Channel, reason: z.string() });
export type SkippedLayout = z.infer<typeof SkippedLayout>;

export const ReviewFindingRecord = z.object({
  id: z.string(),
  round: z.number(),
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(ISSUE_SEVERITIES),
  assetRef: z.string().nullable(),
  finding: z.string(),
  evidence: z.string(),
  suggestedCorrection: z.string(),
  responsibleAgent: z.enum(RESPONSIBLE),
  source: z.enum(['deterministic', 'llm_text', 'llm_vision']),
  status: z.enum(['open', 'fixed', 'unresolved', 'accepted']),
  resolvedInRound: z.number().nullable(),
});
export type ReviewFindingRecord = z.infer<typeof ReviewFindingRecord>;

export const RevisionRecord = z.object({
  id: z.string(),
  round: z.number(),
  findingId: z.string(),
  operation: z.enum(['revise_copy', 'revise_landing', 'align_cta', 'rerender_layout', 'regenerate_image', 'none']),
  owner: z.string(),
  status: z.enum(['applied', 'failed', 'skipped']),
  before: z.string().nullable(),
  after: z.string().nullable(),
  note: z.string(),
});
export type RevisionRecord = z.infer<typeof RevisionRecord>;

/** Where the quality work stood when the campaign was saved: what was checked, what was scored, what was repaired, what was left out. */
export const QualityDiagnostic = z.object({
  reviewRounds: z.number(),
  repairRounds: z.number(),
  conceptCritique: z
    .object({
      ran: z.boolean(),
      modelReview: z.enum(['done', 'failed', 'skipped']),
      flagged: z.number(),
      revised: z.number(),
      scores: z.array(z.object({ conceptId: z.string(), conceptName: z.string(), specificity: z.number(), originality: z.number(), audienceFit: z.number(), visualPotential: z.number(), verdict: z.string() })),
      note: z.string(),
    })
    .nullable(),
  rubric: z.object({ criteria: z.array(z.string()), latest: Rubric.nullable(), history: z.array(z.object({ round: z.number(), scores: Rubric })) }),
  findings: z.object({ total: z.number(), deterministic: z.number(), fromModel: z.number(), fixed: z.number(), open: z.number(), unresolved: z.number() }),
  /** Text requests re-sent with a larger output cap because an answer was cut off. */
  truncatedAnswersRetried: z.number(),
  /** Work that was NOT done and why (a limit, a failure, nothing to do). */
  skipped: z.array(z.object({ what: z.string(), reason: z.string() })),
  verdict: z.string(),
});
export type QualityDiagnostic = z.infer<typeof QualityDiagnostic>;

export const CAMPAIGN_SCHEMA_VERSION = 1;

export const CampaignPackage = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  f1ReportId: z.string(),
  /** The F2 Marketing Audit report id (stored as f2AuditId in the database). */
  f2ReportId: z.string(),
  f3StrategyId: z.string(),
  schemaVersion: z.number(),
  campaignName: z.string(),
  language: z.string(),
  concepts: z.array(ConceptRecord),
  copyVariants: z.array(CopyVariantRecord),
  imageAssets: z.array(AssetRecord),
  /** One entry per concept: generated, failed or skipped, with the reason. Older packages have none. */
  imageResults: z.array(ImageResultRecord).default([]),
  /** The plan of original images (several per concept) fixed before any image was requested. null on campaigns with one image per concept. */
  imageAllocation: ImageAllocationPlan.nullable().default(null),
  /** One record per planned original image, generated or not. */
  imageVariations: z.array(ImageVariationRecord).default([]),
  imageCounts: ImageCounts.nullable().default(null),
  /** Known spending of this run (text + images) next to the approved amount. */
  cost: CostReport.nullable().default(null),
  lineage: CampaignLineage.nullable().default(null),
  quality: QualityDiagnostic.nullable().default(null),
  /** Hybrid Production: the visual direction, the template selection, what happened to every template creative and the honest counters. null on every other campaign. */
  hybrid: HybridBlock.nullable().default(null),
  channelLayouts: z.array(LayoutRecord),
  skippedLayouts: z.array(SkippedLayout),
  landingContent: LandingContent.nullable(),
  reviewFindings: z.array(ReviewFindingRecord),
  revisions: z.array(RevisionRecord),
  approval: z.object({ status: z.enum(['approved', 'approved_with_notes', 'unresolved']), rounds: z.number(), unresolvedFindingIds: z.array(z.string()), note: z.string() }),
  usage: z.object({
    text: z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number(), perAgent: z.record(z.string(), z.object({ calls: z.number(), totalTokens: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().nullable().optional() })) }),
    images: z.object({ model: z.string().nullable(), quality: z.string().nullable(), size: z.string().nullable(), requested: z.number(), generated: z.number(), failed: z.number(), regenerations: z.number(), limits: z.object({ maxImages: z.number(), maxRegenerations: z.number() }), providerReportedTokens: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(), costUsd: z.number().nullable().optional(), blockedBySpend: z.number().optional(), rateLimited: z.number().optional() }),
    layouts: z.object({ rendered: z.number(), skipped: z.number() }),
  }),
  limitations: z.array(z.string()),
  createdAt: Iso,
});
export type CampaignPackage = z.infer<typeof CampaignPackage>;
