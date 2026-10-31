import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';
import { IMAGE_QUALITIES, IMAGE_SIZES } from '../ai/openai-images';

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
  variants: z.array(LlmCopyVariant).max(14),
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
  'brand_tone', 'brand_color', 'logo', 'text_overflow', 'low_contrast', 'poor_crop', 'wrong_dimensions', 'visual_irrelevant', 'visual_defect', 'layout_unavailable', 'other',
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
export const ReviewOutput = z.object({ summary: text(500), issues: z.array(LlmReviewIssue).max(10) });
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
  source: z.enum(['ai_image', 'brand_gradient']),
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
  createdAt: Iso,
});
export type AssetRecord = z.infer<typeof AssetRecord>;

export const LayoutRecord = z.object({ id: z.string(), conceptId: z.string(), variantId: z.string(), assetId: z.string(), baseAssetId: z.string(), format: z.string(), channel: Channel, headline: z.string(), ctaText: z.string(), flags: z.array(z.string()) });
export type LayoutRecord = z.infer<typeof LayoutRecord>;

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
  operation: z.enum(['revise_copy', 'revise_landing', 'rerender_layout', 'regenerate_image', 'none']),
  owner: z.string(),
  status: z.enum(['applied', 'failed', 'skipped']),
  before: z.string().nullable(),
  after: z.string().nullable(),
  note: z.string(),
});
export type RevisionRecord = z.infer<typeof RevisionRecord>;

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
  channelLayouts: z.array(LayoutRecord),
  skippedLayouts: z.array(SkippedLayout),
  landingContent: LandingContent.nullable(),
  reviewFindings: z.array(ReviewFindingRecord),
  revisions: z.array(RevisionRecord),
  approval: z.object({ status: z.enum(['approved', 'approved_with_notes', 'unresolved']), rounds: z.number(), unresolvedFindingIds: z.array(z.string()), note: z.string() }),
  usage: z.object({
    text: z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number(), perAgent: z.record(z.string(), z.object({ calls: z.number(), totalTokens: z.number() })) }),
    images: z.object({ model: z.string().nullable(), quality: z.string().nullable(), size: z.string().nullable(), requested: z.number(), generated: z.number(), failed: z.number(), regenerations: z.number(), limits: z.object({ maxImages: z.number(), maxRegenerations: z.number() }), providerReportedTokens: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable() }),
    layouts: z.object({ rendered: z.number(), skipped: z.number() }),
  }),
  limitations: z.array(z.string()),
  createdAt: Iso,
});
export type CampaignPackage = z.infer<typeof CampaignPackage>;
