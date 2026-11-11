import { z } from 'zod';
import { CampaignDesign, parseDesign } from '../collections/design';
import { getCollection } from '../collections/registry';
import { REFERENCE_KINDS, PERMISSION_STATUS, STYLE_IDS } from '../templates/schema';

/**
 * Settings of the Hybrid Production preset: a small number of ORIGINAL AI images plus many template-rendered creatives built from them.
 * Everything here is chosen by the user (or defaulted by the preset) and echoed back in the campaign package; nothing changes silently.
 */
export const HYBRID_DEFAULTS = {
  originals: 5,
  templateCreatives: 15,
  concepts: 5,
} as const;

export const HYBRID_LIMITS = { maxOriginals: 40, maxTemplateCreatives: 60, maxConcepts: 5 } as const;

/** NO AI HYBRID: 5 concepts x 4 template creatives = 20 finished creatives, no AI image at all. */
export const NO_AI_DEFAULTS = { originals: 0, templateCreatives: 20, concepts: 5 } as const;

/**
 * Where the pictures of a campaign come from and what may be requested. `generation: 'forbidden'` is NO AI HYBRID: no image-generation request of
 * any kind is ever made (enforced at the API, in the factory plan, in the F4 program, in the Visual Creator and in the OpenAI client itself).
 */
export const ImagerySettings = z.object({
  generation: z.enum(['allowed', 'forbidden']),
  /** fully automatic authorized-stock mode: pictures whose license is CLEARED by the provider are added during the run without a click */
  autoStock: z.boolean(),
  /** 1..3 source pictures per concept at most (a picture may serve several creatives; they are cropped differently) */
  maxSourcesPerConcept: z.number().int().min(1).max(3),
  /** paid search providers (they bill per request) may be used by the Visual Researcher. Default false. */
  allowPaidSearch: z.boolean(),
});
export type ImagerySettings = z.infer<typeof ImagerySettings>;
export const DEFAULT_IMAGERY: ImagerySettings = { generation: 'allowed', autoStock: false, maxSourcesPerConcept: 3, allowPaidSearch: false };

/** true = this campaign never generates images */
export const isNoAi = (h: { imagery?: { generation?: string } } | null | undefined): boolean => h?.imagery?.generation === 'forbidden';

/** Facts only the USER can provide. A template that needs one (an offer, a date, a quote...) is simply not chosen without it: nothing is invented. */
export const HybridFacts = z.object({
  offer: z.string().trim().max(20).optional(),
  offerDetail: z.string().trim().max(60).optional(),
  date: z.string().trim().max(30).optional(),
  location: z.string().trim().max(40).optional(),
  quote: z.string().trim().max(160).optional(),
  attribution: z.string().trim().max(60).optional(),
  stat: z.string().trim().max(12).optional(),
  statLabel: z.string().trim().max(50).optional(),
  tag: z.string().trim().max(30).optional(),
});
export type HybridFacts = z.infer<typeof HybridFacts>;

/** A reference the user attached for inspiration. Pinterest and links are LINK-ONLY: LaunchPilot never fetches, stores or analyzes them. */
export const HybridReference = z.object({
  id: z.string().min(1).max(60),
  kind: z.enum(REFERENCE_KINDS),
  label: z.string().max(120),
  url: z.string().max(300).nullable().default(null),
  permission: z.enum(PERMISSION_STATUS),
});
export type HybridReference = z.infer<typeof HybridReference>;

export const HybridSettings = z.object({
  /** Original AI images (one provider request each). Default 5. */
  originals: z.number().int().min(0).max(HYBRID_LIMITS.maxOriginals),
  /** Template-rendered creatives built locally from the originals and the brand assets (no provider request). Default 15. */
  templateCreatives: z.number().int().min(0).max(HYBRID_LIMITS.maxTemplateCreatives),
  /**
   * LEGACY. The visual style used to be chosen here. It is now decided by the campaign design below; when a design exists this field is
   * rewritten to the style of the design's collection (so nothing downstream can see a second, contradicting choice). Without a design
   * (campaigns made before collections) it keeps its old meaning: 'auto' lets the deterministic matcher choose from the style library.
   */
  style: z.union([z.literal('auto'), z.enum(STYLE_IDS)]),
  /**
   * THE CAMPAIGN DESIGN: the ONE approved visual configuration (template collection, palette, formats, picture sourcing). null = the campaign
   * was configured before collections existed and keeps the older behaviour.
   */
  design: CampaignDesign.nullable(),
  /** automatic = deterministic scoring; assisted = the same, then ONE text-model call may re-rank a shortlist (validated); manual = only the user's overrides, the rest automatic. */
  selection: z.enum(['automatic', 'assisted', 'manual']),
  /** slotId -> templateId. Validated against availability and compatibility; an invalid override is reported, never silently swapped. */
  overrides: z.record(z.string(), z.string()),
  /** Template ids the user starred: a soft preference in the scoring. */
  preferredTemplates: z.array(z.string()).max(60),
  /** When an original image could not be generated: true = render the concept's creatives with image-less templates (labelled FALLBACK); false = leave them out and say so. */
  allowTemplateFallback: z.boolean(),
  /** One text-model call that may refine the visual direction (validated; the deterministic brief is the fallback). */
  directionRefine: z.boolean(),
  /** The user wants to review the visual direction before the run (the start request then must confirm it). Never blocks a running campaign. */
  reviewDirection: z.boolean(),
  directionApproved: z.boolean(),
  inspiration: z.enum(['style_library', 'brand_assets', 'references']),
  references: z.array(HybridReference).max(12),
  facts: HybridFacts,
  /** Image sourcing and the NO AI HYBRID guarantee. Campaigns saved before it existed read as `allowed` with the earlier behaviour. */
  imagery: ImagerySettings.default(DEFAULT_IMAGERY),
});
export type HybridSettings = z.infer<typeof HybridSettings>;

export const HYBRID_PRESET: HybridSettings = {
  originals: HYBRID_DEFAULTS.originals,
  templateCreatives: HYBRID_DEFAULTS.templateCreatives,
  style: 'auto',
  design: null,
  selection: 'automatic',
  overrides: {},
  preferredTemplates: [],
  allowTemplateFallback: false,
  directionRefine: true,
  reviewDirection: false,
  directionApproved: false,
  inspiration: 'style_library',
  references: [],
  facts: {},
  imagery: { ...DEFAULT_IMAGERY },
};

/** NO AI HYBRID: the Hybrid settings with the guarantee switched on (originals 0, 20 template creatives). */
export const NO_AI_PRESET: HybridSettings = {
  ...HYBRID_PRESET,
  originals: NO_AI_DEFAULTS.originals,
  templateCreatives: NO_AI_DEFAULTS.templateCreatives,
  imagery: { ...DEFAULT_IMAGERY, generation: 'forbidden' },
};

/** Merges a partial user patch into the defaults, clamping numbers; unknown keys are ignored. Throws a plain Error with a user-facing message when a value is invalid. */
export function mergeHybrid(patch: unknown, preset: HybridSettings = HYBRID_PRESET): HybridSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  // a patch that says "no image generation" starts from NO AI HYBRID's own defaults (0 originals, 20 creatives), not from Hybrid Production's
  const base = structuredClone(preset === HYBRID_PRESET && isNoAi(p as { imagery?: { generation?: string } }) ? NO_AI_PRESET : preset);
  const merged = { ...base, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => k in base && v !== undefined && v !== null)) };
  // a reference sent by a client has an id, a kind and maybe a link; its label and permission are filled in here and decided by the server later
  if (Array.isArray(p.references)) {
    merged.references = (p.references as Record<string, unknown>[]).map((r) => ({ id: r?.id, kind: r?.kind, label: typeof r?.label === 'string' ? r.label : '', url: typeof r?.url === 'string' ? r.url : null, permission: typeof r?.permission === 'string' ? r.permission : 'link_only_not_analyzed' })) as never;
  }
  // the design is validated on its own (it carries its own rules); an invalid one is refused, never repaired or replaced
  if (p.design !== undefined && p.design !== null) {
    const d = parseDesign(p.design);
    if (!d.ok) throw new Error(`Hybrid settings are not valid: ${d.message}`);
    merged.design = d.design;
  }
  // imagery is merged field by field so a client may send only what it changes; an unknown value is refused by the schema below
  if (p.imagery !== undefined && p.imagery !== null && typeof p.imagery === 'object') merged.imagery = { ...base.imagery, ...Object.fromEntries(Object.entries(p.imagery as Record<string, unknown>).filter(([k, v]) => k in base.imagery && v !== undefined && v !== null)) } as never;
  merged.facts = { ...base.facts, ...(typeof p.facts === 'object' && p.facts ? Object.fromEntries(Object.entries(p.facts as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.trim())) : {}) };
  const parsed = HybridSettings.safeParse(merged);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`Hybrid settings are not valid: ${i?.path.join('.') || 'value'} ${i?.message ?? ''}`.trim());
  }
  const out = parsed.data;
  // THE GUARANTEE: a campaign that never generates images cannot also ask for generated ones. Refused, never silently changed.
  if (out.imagery.generation === 'forbidden' && out.originals > 0) throw new Error('Hybrid settings are not valid: NO AI HYBRID makes no AI images, so originals must be 0.');
  // one choice only: with a design, the old style field simply mirrors the collection's style
  if (out.design) out.style = getCollection(out.design.collectionId)!.styleId;
  return out;
}
