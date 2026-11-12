import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';

/**
 * READ-ONLY schemas of campaign packages saved before V4 (AI originals, image continuations, landing pages). New campaigns never produce
 * these parts: LaunchPilot V4 generates no AI image and no landing page. They stay here only so that historical campaigns keep parsing,
 * showing and exporting exactly as they were saved.
 */
const Channel = z.enum(CHANNEL_IDS);
const text = (max: number) => z.string().max(max);
const list = (max: number, n = 5) => z.array(text(max)).max(n);

/** Image sizes and qualities older campaigns were generated with (kept for reading their records). */
export const LEGACY_IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export const LEGACY_IMAGE_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export const VISUAL_ROLE_IDS = ['hero', 'detail', 'context', 'human', 'outcome', 'mood', 'symbol'] as const;
export const IMAGE_STAGES = ['configuration', 'budget', 'planning', 'provider', 'decoding', 'storage', 'cancelled'] as const;

export const CTA_TYPES = ['book_consultation', 'request_quote', 'register', 'learn_more', 'purchase', 'contact'] as const;
const CtaType = z.enum(CTA_TYPES);
const SUPPORT = ['brief', 'f1', 'f2', 'f3', 'user', 'hypothesis'] as const;
const Evidence = z.enum(SUPPORT);

/** LEGACY: the landing page content of campaigns made before V4. */
export const LandingContent = z.object({
  seoTitle: text(70),
  metaDescription: text(170),
  hero: z.object({ headline: text(90), description: text(300), ctaText: text(30) }),
  valueProposition: text(300),
  benefits: z.array(z.object({ title: text(80), text: text(240), evidence: Evidence, ref: text(24).nullable() })).max(6),
  sections: z.array(z.object({ title: text(80), body: text(500) })).max(4),
  howItWorks: z.array(z.object({ step: text(80), text: text(240) })).max(5),
  faq: z.array(z.object({ q: text(140), a: text(320) })).max(6),
  trustSignals: z.array(z.object({ text: text(200), evidence: Evidence, ref: text(24).nullable() })).max(4),
  ctas: z.array(z.object({ objective: CtaType, text: text(30) })).max(3),
  ctaObjective: CtaType,
  mobileHierarchy: list(100, 6),
});
export type LandingContent = z.infer<typeof LandingContent>;

/** LEGACY: what happened to one concept's original AI image. */
export const ImageResultRecord = z.object({
  conceptId: z.string(),
  conceptName: z.string(),
  model: z.string().nullable(),
  requestAttempted: z.boolean(),
  outcome: z.enum(['generated', 'failed', 'skipped']),
  stage: z.enum(IMAGE_STAGES).nullable(),
  errorCode: z.string().nullable(),
  providerStatus: z.number().nullable(),
  providerCode: z.string().nullable(),
  message: z.string().nullable(),
  explanation: z.string().nullable(),
  fallbackUsed: z.boolean(),
  assetId: z.string(),
  reconstructed: z.boolean().optional(),
});
export type ImageResultRecord = z.infer<typeof ImageResultRecord>;

/** LEGACY: one planned original AI image. */
export const PlannedVariation = z.object({
  variationId: z.string(),
  conceptId: z.string(),
  index: z.number(),
  role: z.enum(VISUAL_ROLE_IDS),
  perspective: z.string(),
  lighting: z.string(),
  targetChannels: z.array(Channel),
  formats: z.array(z.string()),
  size: z.enum(LEGACY_IMAGE_SIZES),
});
export type PlannedVariation = z.infer<typeof PlannedVariation>;

/** LEGACY: the plan of original AI images. */
export const ImageAllocationPlan = z.object({
  target: z.number(),
  allocated: z.number(),
  maxPerConcept: z.number(),
  basis: z.enum(['forecast', 'concepts']),
  perConcept: z.array(z.object({ conceptId: z.string(), name: z.string(), count: z.number(), channels: z.array(Channel), reason: z.string() })),
  variations: z.array(PlannedVariation),
  expectedLayouts: z.number(),
  rules: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ImageAllocationPlan = z.infer<typeof ImageAllocationPlan>;

/** LEGACY: what happened to one planned original AI image. */
export const ImageVariationRecord = z.object({
  conceptId: z.string(),
  conceptName: z.string(),
  variationId: z.string(),
  index: z.number(),
  variationName: z.string(),
  visualGoal: z.string(),
  role: z.enum(VISUAL_ROLE_IDS),
  targetChannels: z.array(Channel),
  size: z.enum(LEGACY_IMAGE_SIZES),
  imagePrompt: z.string(),
  plannedBy: z.enum(['model', 'deterministic']),
  status: z.enum(['planned', 'generated', 'failed', 'skipped', 'blocked_by_budget']),
  requestAttempted: z.boolean(),
  stage: z.enum(IMAGE_STAGES).nullable(),
  generatedAssetId: z.string().nullable(),
  providerModel: z.string().nullable(),
  quality: z.string().nullable(),
  usage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  costUsd: z.number().nullable(),
  safeError: z.object({ code: z.string(), message: z.string(), status: z.number().nullable(), providerCode: z.string().nullable() }).nullable(),
  explanation: z.string().nullable(),
  conceptual: z.boolean(),
});
export type ImageVariationRecord = z.infer<typeof ImageVariationRecord>;

/** LEGACY: the tally of original AI images. */
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

/** LEGACY: a full run or an image-only continuation of an earlier campaign. */
export const CampaignLineage = z.object({
  kind: z.enum(['full', 'image_continuation']),
  revision: z.number(),
  parentCampaignId: z.string().nullable(),
  reusedAssets: z.number(),
});
export type CampaignLineage = z.infer<typeof CampaignLineage>;

/** LEGACY: the image usage block of older packages (new packages record zeros: no image is ever requested). */
export const LegacyImageUsage = z.object({
  model: z.string().nullable(),
  quality: z.string().nullable(),
  size: z.string().nullable(),
  requested: z.number(),
  generated: z.number(),
  failed: z.number(),
  regenerations: z.number(),
  limits: z.object({ maxImages: z.number(), maxRegenerations: z.number() }),
  providerReportedTokens: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
  costUsd: z.number().nullable().optional(),
  blockedBySpend: z.number().optional(),
  rateLimited: z.number().optional(),
});
export const NO_IMAGE_USAGE: z.infer<typeof LegacyImageUsage> = { model: null, quality: null, size: null, requested: 0, generated: 0, failed: 0, regenerations: 0, limits: { maxImages: 0, maxRegenerations: 0 }, providerReportedTokens: null, costUsd: 0 };
