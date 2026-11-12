import { z } from 'zod';
import { CampaignDesign, parseDesign } from '../collections/design';
import { getCollection } from '../collections/registry';
import { REFERENCE_KINDS, PERMISSION_STATUS, STYLE_IDS } from '../templates/schema';

/**
 * The visual settings of a campaign: the approved campaign design (template collection and palette), the facts only the user can give,
 * the references the user attached and how pictures are sourced. There is ONE production workflow and it NEVER generates an image: every
 * creative is rendered locally from a collection template, the approved palette and approved real pictures (or typography). The number of
 * creatives is not set here: it follows from the deliverables plan (hybrid/deliverables.ts).
 *
 * The name "HybridSettings" is historical (campaigns saved before V4 store these settings under `hybrid`); older stored settings still parse:
 * fields that no longer exist (originals, templateCreatives, allowTemplateFallback, directionRefine...) are ignored when read.
 */
export const ImagerySettings = z.object({
  /** Always "forbidden" for new campaigns. "allowed" only appears in campaigns saved before V4. */
  generation: z.enum(['allowed', 'forbidden']),
  /** fully automatic authorized-stock mode: pictures whose license is CLEARED by the provider are added during the run without a click */
  autoStock: z.boolean(),
  /** 1..3 source pictures per concept at most (a picture may serve several creatives; they are cropped differently) */
  maxSourcesPerConcept: z.number().int().min(1).max(3),
  /** paid search providers (they bill per request) may be used by the Visual Researcher. Default false. */
  allowPaidSearch: z.boolean(),
});
export type ImagerySettings = z.infer<typeof ImagerySettings>;
export const DEFAULT_IMAGERY: ImagerySettings = { generation: 'forbidden', autoStock: false, maxSourcesPerConcept: 3, allowPaidSearch: false };

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
  /**
   * LEGACY. Used only when no design exists (campaigns made before collections): 'auto' lets the deterministic matcher choose from the style
   * library. With a design it is rewritten to the style of the design's collection.
   */
  style: z.union([z.literal('auto'), z.enum(STYLE_IDS)]),
  /** THE CAMPAIGN DESIGN: the ONE approved visual configuration (template collection, palette, picture sourcing). */
  design: CampaignDesign.nullable(),
  /** automatic = deterministic scoring; manual = the user's overrides, the rest automatic. ("assisted" only in older campaigns; read as automatic.) */
  selection: z.enum(['automatic', 'assisted', 'manual']),
  /** slotId -> templateId. Validated against availability and compatibility; an invalid override is reported, never silently swapped. */
  overrides: z.record(z.string(), z.string()),
  /** Template ids the user starred: a soft preference in the scoring. */
  preferredTemplates: z.array(z.string()).max(60),
  inspiration: z.enum(['style_library', 'brand_assets', 'references']),
  references: z.array(HybridReference).max(12),
  facts: HybridFacts,
  imagery: ImagerySettings.default(DEFAULT_IMAGERY),
});
export type HybridSettings = z.infer<typeof HybridSettings>;

/** The visual settings of a new campaign before the user changes anything. */
export const DEFAULT_HYBRID_SETTINGS: HybridSettings = {
  style: 'auto',
  design: null,
  selection: 'automatic',
  overrides: {},
  preferredTemplates: [],
  inspiration: 'style_library',
  references: [],
  facts: {},
  imagery: { ...DEFAULT_IMAGERY },
};

/**
 * Merges a partial user patch into the defaults; unknown keys are ignored. Image generation is ALWAYS forbidden in the result, whatever the
 * patch says (there is no image generator in the pipeline any more). Throws a plain Error with a user-facing message when a value is invalid.
 */
export function mergeHybrid(patch: unknown, base: HybridSettings = DEFAULT_HYBRID_SETTINGS): HybridSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const start = structuredClone(base);
  const merged = { ...start, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => k in start && v !== undefined && v !== null)) };
  // a reference sent by a client has an id, a kind and maybe a link; its label and permission are filled in here and decided by the server later
  if (Array.isArray(p.references)) {
    merged.references = (p.references as Record<string, unknown>[]).map((r) => ({ id: r?.id, kind: r?.kind, label: typeof r?.label === 'string' ? r.label : '', url: typeof r?.url === 'string' ? r.url : null, permission: typeof r?.permission === 'string' ? r.permission : 'link_only_not_analyzed' })) as never;
  }
  // the design is validated on its own (it carries its own rules); an invalid one is refused, never repaired or replaced
  if (p.design !== undefined && p.design !== null) {
    const d = parseDesign(p.design);
    if (!d.ok) throw new Error(`Campaign design is not valid: ${d.message}`);
    merged.design = d.design;
  }
  if (p.imagery !== undefined && p.imagery !== null && typeof p.imagery === 'object') merged.imagery = { ...start.imagery, ...Object.fromEntries(Object.entries(p.imagery as Record<string, unknown>).filter(([k, v]) => k in start.imagery && v !== undefined && v !== null)) } as never;
  merged.facts = { ...start.facts, ...(typeof p.facts === 'object' && p.facts ? Object.fromEntries(Object.entries(p.facts as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.trim())) : {}) };
  const parsed = HybridSettings.safeParse(merged);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`Campaign settings are not valid: ${i?.path.join('.') || 'value'} ${i?.message ?? ''}`.trim());
  }
  const out = parsed.data;
  out.imagery = { ...out.imagery, generation: 'forbidden' };
  if (out.selection === 'assisted') out.selection = 'automatic';
  // the design is the ONE place the automatic stock choice is made
  if (out.design) {
    out.style = getCollection(out.design.collectionId)!.styleId;
    out.imagery = { ...out.imagery, autoStock: out.design.autoStock === true };
  }
  return out;
}
