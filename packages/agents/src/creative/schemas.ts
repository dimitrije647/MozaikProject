import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';
import { AssetLineage, HybridBlock } from '../hybrid/records';
import { COPY_PURPOSES, PRINCIPLE_IDS } from '../copywriting/principles';
import { CopyPlan } from '../copywriting/plan';
import { CTA_TYPES, CampaignLineage, ImageAllocationPlan, ImageCounts, ImageResultRecord, ImageVariationRecord, LandingContent, LEGACY_IMAGE_QUALITIES, LEGACY_IMAGE_SIZES, LegacyImageUsage, NO_IMAGE_USAGE } from './legacy-schemas';

/**
 * Wire schemas for the F4 agents and the stored Campaign Package. Every field the model writes is required (absent = null / empty array) so
 * strict structured outputs accept them. Over-length text is trimmed on parse (see parseModelJson).
 *
 * V4 (schema version 2): ONE marketing package per campaign. Concepts built on the strategy, platform posts for X, TikTok, Facebook, Instagram
 * and LinkedIn (TikTok with a video concept/script: no video is ever generated), web and display ad copy, billboard and flyer copy, and the
 * template creatives of the deliverables plan. No AI image, no landing page. Packages of earlier versions still parse (see legacy-schemas.ts).
 */
const text = (max: number) => z.string().max(max);
const list = (max: number, n = 5) => z.array(text(max)).max(n);
const Channel = z.enum(CHANNEL_IDS);
/** The copywriting principles a piece applies (ids of copywriting/principles.ts): a few that fit, never all. */
const Principles = z.array(z.enum(PRINCIPLE_IDS)).max(5);

export { CTA_TYPES };
export const CtaType = z.enum(CTA_TYPES);
export type CtaType = z.infer<typeof CtaType>;

/** The five social platforms every campaign writes for. */
export const CAMPAIGN_PLATFORMS = ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'] as const;
export type CampaignPlatform = (typeof CAMPAIGN_PLATFORMS)[number];
export const isCampaignPlatform = (c: string): c is CampaignPlatform => (CAMPAIGN_PLATFORMS as readonly string[]).includes(c);

/** What a deliverable is. The placement of a V4 copy variant uses the same words (older packages use paid_ad / organic_post / story). */
export const DELIVERABLE_KINDS = ['social_post', 'web_ad', 'display_ad', 'billboard', 'flyer'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const SUPPORT = ['brief', 'f1', 'f2', 'f3', 'user', 'hypothesis'] as const;
const Claim = z.object({
  text: text(160),
  /** Where the claim comes from. "hypothesis" = not backed by the supplied material. ("f2" only appears in campaigns made before V4.) */
  support: z.enum(SUPPORT),
  ref: text(24).nullable(),
});

// ---- A3 Content Writer -------------------------------------------------------------------------------------------------------

export const LlmConcept = z.object({
  key: z.string().min(1).max(8),
  name: z.string().min(2).max(80),
  /** The strategy's main message or content pillar this concept is built on (the strategy is not reinvented). */
  basis: text(200),
  angle: text(200),
  keyMessage: text(200),
  audience: text(120),
  ctaType: CtaType,
  ctaText: text(30),
  /** What an approved photograph should show for this concept (used to match real pictures; no picture is generated). */
  visualIdea: text(300),
  /** The communication purpose of this concept and, in one sentence, which principles it uses and why (internal, for review and debugging). */
  purpose: z.enum(COPY_PURPOSES),
  principleNote: text(240),
});

/** A short TikTok video concept. LaunchPilot does NOT make videos: this is a script for the owner to film. */
export const VideoScript = z.object({
  hook: text(150),
  durationSeconds: z.number().int(),
  scenes: z.array(z.object({ seconds: text(20), visual: text(220), onScreenText: text(100), voiceover: text(220) })).max(6),
  soundNote: text(160),
});
export type VideoScript = z.infer<typeof VideoScript>;

export const LlmPost = z.object({
  conceptKey: z.string().max(8),
  platform: z.enum(CAMPAIGN_PLATFORMS),
  /** The hook / headline shown on the visual and as the first line. */
  hook: z.string().min(2).max(90),
  /** The post text as it is published on the platform. */
  text: z.string().min(2).max(1500),
  /** The short supporting line shown ON the rendered visual next to the hook (not a cut-off caption). */
  visualLine: text(110),
  cta: text(40),
  /** The same call to action in at most 22 characters (words of "cta" only; no new offer, number or service). Empty when "cta" is already that short. */
  ctaShort: text(30).default(''),
  ctaType: CtaType,
  hashtags: list(40, 8),
  /** How to publish it: e.g. "Single image post, 4:5, carousel optional". */
  postingFormat: text(160),
  /** TikTok only: the short video concept and script; null for the other platforms. */
  videoScript: VideoScript.nullable(),
  claims: z.array(Claim).max(4),
  principles: Principles,
});

export const LlmAdCopy = z.object({
  conceptKey: z.string().max(8),
  kind: z.enum(['web_ad', 'display_ad']),
  headline: z.string().min(2).max(60),
  /** The same headline in at most 6 words (no new claim). */
  headlineShort: text(60).default(''),
  description: text(120),
  cta: text(30),
  ctaShort: text(30).default(''),
  ctaType: CtaType,
  claims: z.array(Claim).max(3),
  principles: Principles,
});

export const LlmPrintCopy = z.object({
  conceptKey: z.string().max(8),
  kind: z.enum(['billboard', 'flyer']),
  /** Billboard: at most about seven words. */
  headline: z.string().min(2).max(80),
  /** Flyer body; a billboard leaves it empty. */
  body: text(400),
  /** Flyer: the short supporting line on the visual; a billboard leaves it empty. */
  visualLine: text(110),
  /** The same headline in at most 6 words (no new claim). */
  headlineShort: text(60).default(''),
  cta: text(40),
  ctaShort: text(30).default(''),
  ctaType: CtaType,
  claims: z.array(Claim).max(3),
  principles: Principles,
});

export const CopyOutput = z.object({
  summary: text(600),
  concepts: z.array(LlmConcept).max(5),
  posts: z.array(LlmPost).max(25),
  ads: z.array(LlmAdCopy).max(10),
  print: z.array(LlmPrintCopy).max(6),
  missingInformation: list(240, 8),
});
export type CopyOutput = z.infer<typeof CopyOutput>;

export const CopyRevisionOutput = z.object({
  revisions: z
    .array(z.object({ variantId: z.string().max(8), headline: z.string().min(2).max(90), body: z.string().max(1500), visualLine: text(110), ctaText: text(40), ctaShort: text(30).default(''), hashtags: list(40, 8), claims: z.array(Claim).max(4) }))
    .max(12),
});
export type CopyRevisionOutput = z.infer<typeof CopyRevisionOutput>;

// ---- A6 Quality Reviewer ------------------------------------------------------------------------------------------------------

export const ISSUE_KINDS = [
  'unsupported_claim', 'factual_error', 'strategy_mismatch', 'audience_mismatch', 'channel_mismatch', 'weak_cta', 'cta_mismatch', 'inconsistent_messaging',
  'brand_tone', 'brand_color', 'logo', 'text_overflow', 'low_contrast', 'poor_crop', 'wrong_dimensions', 'visual_irrelevant', 'visual_defect', 'layout_unavailable', 'concept_overlap', 'generic_concept', 'repetitive', 'source_rights', 'other',
  // copywriting quality (V4 principles)
  'generic_copy', 'weak_headline', 'false_urgency', 'unclear_copy', 'principle_misuse',
] as const;
export const ISSUE_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;
/** Who repairs a finding: copywriter = the Content Writer, layout = the Creative Designer, visual = the Visual Researcher. ("landing" only in older campaigns.) */
export const RESPONSIBLE = ['copywriter', 'landing', 'layout', 'visual'] as const;

export const LlmReviewIssue = z.object({
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(ISSUE_SEVERITIES),
  /** An asset id, a copy variant id (V1..), a concept id (K1..) or null. */
  assetRef: text(40).nullable(),
  finding: z.string().min(3).max(300),
  evidence: text(300),
  suggestedCorrection: text(300),
  responsibleAgent: z.enum(RESPONSIBLE),
});
/**
 * Scored 1 (unusable) to 5 (excellent); 3 is acceptable, 2 or less is weak and becomes a finding when no issue explains it. The first six
 * criteria exist since V3; the copywriting criteria (headline strength, specificity, clarity, CTA quality, platform fit, principle fit) were added
 * with the principle framework, so they are optional in STORED rubrics (older campaigns) and required in the model's answer.
 */
export const RUBRIC_CRITERIA = ['productAccuracy', 'brandConsistency', 'audienceRelevance', 'objectiveAlignment', 'originality', 'crossChannelConsistency', 'headlineStrength', 'specificity', 'clarity', 'ctaQuality', 'platformFit', 'principleFit'] as const;
const score = z.number().int();
export const LlmRubric = z.object({
  productAccuracy: score,
  brandConsistency: score,
  audienceRelevance: score,
  objectiveAlignment: score,
  originality: score,
  crossChannelConsistency: score,
  headlineStrength: score,
  specificity: score,
  clarity: score,
  ctaQuality: score,
  platformFit: score,
  principleFit: score,
});
export const Rubric = LlmRubric.partial({ headlineStrength: true, specificity: true, clarity: true, ctaQuality: true, platformFit: true, principleFit: true });
export type Rubric = z.infer<typeof Rubric>;
/** `scores` is null for a review of images alone. */
export const ReviewOutput = z.object({ summary: text(500), issues: z.array(LlmReviewIssue).max(10), scores: LlmRubric.nullable() });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ---- stored records ---------------------------------------------------------------------------------------------------------------

const Iso = z.string();
export const ConceptRecord = z.object({
  id: z.string(),
  name: z.string(),
  angle: z.string(),
  keyMessage: z.string(),
  audience: z.string(),
  ctaType: CtaType,
  ctaText: z.string(),
  visualIdea: z.string(),
  basis: z.string().nullable().optional(),
  /** copywriting framework (absent in older campaigns) */
  purpose: z.enum(COPY_PURPOSES).nullable().optional(),
  principleNote: z.string().nullable().optional(),
});
export type ConceptRecord = z.infer<typeof ConceptRecord>;

/**
 * One piece of copy. V4 placements: social_post (channel = the platform), web_ad / display_ad (channel = google_search, the nominal ad
 * channel), billboard / flyer (channel = organic_content, the nominal print channel). Older packages use paid_ad / organic_post / story.
 */
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
  postingFormat: z.string().nullable().optional(),
  videoScript: VideoScript.nullable().optional(),
  /** the line shown on the visual; absent = a trimmed body (older campaigns) */
  visualLine: z.string().nullable().optional(),
  /** the copywriting principles this piece applies (absent in older campaigns) */
  principles: z.array(z.string()).optional(),
  /** a shorter wording of the call to action / the headline by the Content Writer, used only when the full one does not fit (absent in older campaigns) */
  ctaShort: z.string().nullable().optional(),
  headlineShort: z.string().nullable().optional(),
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
  /** template_render = every V4 creative. ai_image / brand_gradient only appear in campaigns made before V4. */
  source: z.enum(['ai_image', 'brand_gradient', 'template_render']),
  model: z.string().nullable(),
  quality: z.enum(LEGACY_IMAGE_QUALITIES).nullable(),
  requestedSize: z.enum(LEGACY_IMAGE_SIZES).nullable(),
  status: z.enum(['generated', 'rendered', 'superseded', 'failed']),
  flags: z.array(z.string()),
  altText: z.string().nullable(),
  promptMetadata: z.object({ promptChars: z.number(), directionSummary: z.string() }).nullable(),
  usage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  variationId: z.string().nullable().optional(),
  createdAt: Iso,
  ...AssetLineage.shape,
});
export type AssetRecord = z.infer<typeof AssetRecord>;

export const LayoutRecord = z.object({
  id: z.string(),
  conceptId: z.string(),
  variantId: z.string(),
  assetId: z.string(),
  /** LEGACY: the original AI image a layout was cut from. Empty for template creatives. */
  baseAssetId: z.string(),
  variationId: z.string().nullable().optional(),
  format: z.string(),
  channel: Channel,
  headline: z.string(),
  ctaText: z.string(),
  flags: z.array(z.string()),
  templateId: z.string().nullable().optional(),
  templateVersion: z.number().nullable().optional(),
  slotId: z.string().nullable().optional(),
});
export type LayoutRecord = z.infer<typeof LayoutRecord>;

export const CostReport = z.object({
  currency: z.literal('USD'),
  priceBookVerifiedAt: z.string(),
  approvedUsd: z.number().nullable(),
  spentUsd: z.number(),
  uncertainUsd: z.number(),
  textUsd: z.number(),
  imageUsd: z.number().nullable(),
  unpricedRequests: z.number(),
  blockedRequests: z.number(),
  note: z.string(),
});
export type CostReport = z.infer<typeof CostReport>;

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

export const QualityDiagnostic = z.object({
  reviewRounds: z.number(),
  repairRounds: z.number(),
  /** LEGACY: the concept critique of older campaigns (null in V4). */
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
  truncatedAnswersRetried: z.number(),
  skipped: z.array(z.object({ what: z.string(), reason: z.string() })),
  verdict: z.string(),
});
export type QualityDiagnostic = z.infer<typeof QualityDiagnostic>;

// ---- the deliverables of a V4 campaign ---------------------------------------------------------------------------------------------

export const DeliverableRecord = z.object({
  /** The slot id of the creative (also the id of the planned deliverable). */
  id: z.string(),
  kind: z.enum(DELIVERABLE_KINDS),
  /** e.g. "Instagram post", "Billboard". */
  label: z.string(),
  conceptId: z.string(),
  channel: Channel,
  format: z.string(),
  width: z.number(),
  height: z.number(),
  /** Where it goes in the ZIP, e.g. social/instagram, ads/web, print/billboards. */
  folder: z.string(),
  status: z.enum(['delivered', 'missing']),
  /** The design quality gate of a delivered creative: passed, warnings (non-critical) or unresolved (a critical layout problem: review it). Absent before V4.2. */
  design: z.enum(['passed', 'warnings', 'unresolved']).nullable().optional(),
  assetId: z.string().nullable(),
  variantId: z.string().nullable(),
  /** true = an approved real picture is drawn in it; false = typography-first. */
  withPicture: z.boolean(),
  reason: z.string().nullable(),
  /**
   * QUALITY STATE (V4.3): produced (the file exists, nothing more is claimed), passed, passed_with_warnings (non-critical problems only) or unresolved
   * (a critical design problem or an open blocker/major review finding). `publishReady` is true only for passed / passed_with_warnings; `blockers`
   * says why not. Absent in older campaigns.
   */
  quality: z.enum(['produced', 'passed', 'passed_with_warnings', 'unresolved']).nullable().optional(),
  publishReady: z.boolean().optional(),
  blockers: z.array(z.string()).max(8).optional(),
  /** the variation matrix cell (design x copy) of an ad or billboard */
  matrix: z.object({ group: z.string(), design: z.number().int(), copy: z.number().int(), shared: z.boolean() }).nullable().optional(),
});
export type DeliverableRecord = z.infer<typeof DeliverableRecord>;

export const DeliverablesBlock = z.object({
  version: z.literal(1),
  platforms: z.array(Channel),
  items: z.array(DeliverableRecord),
  /** Deliverables the plan could not include at all (the collection cannot draw the format, there is no copy...), with the reason. */
  notPlanned: z.array(z.object({ kind: z.enum(DELIVERABLE_KINDS), label: z.string(), format: z.string(), conceptId: z.string().nullable(), reason: z.string() })),
  rules: z.array(z.string()),
  counts: z.object({ planned: z.number(), delivered: z.number(), missing: z.number(), withPicture: z.number(), typographyFirst: z.number(), publishReady: z.number().optional(), needsReview: z.number().optional() }),
});
export type DeliverablesBlock = z.infer<typeof DeliverablesBlock>;

/** 2 = V4 (one workflow, deliverables, no AI images, no landing page). 1 = earlier campaigns. */
export const CAMPAIGN_SCHEMA_VERSION = 2;

export const CampaignPackage = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string(),
  f1ReportId: z.string(),
  /** LEGACY: the F2 Marketing Audit of campaigns made before V4; null for V4 campaigns (no audit is run). */
  f2ReportId: z.string().nullable().default(null),
  f3StrategyId: z.string(),
  schemaVersion: z.number(),
  campaignName: z.string(),
  language: z.string(),
  concepts: z.array(ConceptRecord),
  copyVariants: z.array(CopyVariantRecord),
  imageAssets: z.array(AssetRecord),
  /** V4: the deliverables plan and what became of every planned deliverable. null on campaigns made before V4. */
  deliverables: DeliverablesBlock.nullable().default(null),
  /** The copywriting plan (purpose, principles, Brand Voice Profile) the copy was written and reviewed against. null on older campaigns. */
  copywriting: CopyPlan.nullable().default(null),
  cost: CostReport.nullable().default(null),
  quality: QualityDiagnostic.nullable().default(null),
  /** The template side: visual direction, template selection, every template creative, pictures and their rights, brand content. */
  hybrid: HybridBlock.nullable().default(null),
  channelLayouts: z.array(LayoutRecord),
  skippedLayouts: z.array(SkippedLayout),
  reviewFindings: z.array(ReviewFindingRecord),
  revisions: z.array(RevisionRecord),
  approval: z.object({ status: z.enum(['approved', 'approved_with_notes', 'unresolved']), rounds: z.number(), unresolvedFindingIds: z.array(z.string()), note: z.string() }),
  usage: z.object({
    text: z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number(), perAgent: z.record(z.string(), z.object({ calls: z.number(), totalTokens: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().nullable().optional() })) }),
    /** LEGACY: image requests of older campaigns. Always zero in V4. */
    images: LegacyImageUsage.default(NO_IMAGE_USAGE),
    layouts: z.object({ rendered: z.number(), skipped: z.number() }),
  }),
  limitations: z.array(z.string()),
  createdAt: Iso,
  // ---- LEGACY, read-only (campaigns made before V4) ----
  imageResults: z.array(ImageResultRecord).default([]),
  imageAllocation: ImageAllocationPlan.nullable().default(null),
  imageVariations: z.array(ImageVariationRecord).default([]),
  imageCounts: ImageCounts.nullable().default(null),
  lineage: CampaignLineage.nullable().default(null),
  landingContent: LandingContent.nullable().default(null),
});
export type CampaignPackage = z.infer<typeof CampaignPackage>;

export { CampaignLineage, ImageAllocationPlan, ImageCounts, ImageResultRecord, ImageVariationRecord, LandingContent };
