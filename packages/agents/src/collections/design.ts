import { z } from 'zod';
import { CREATIVE_FORMATS } from '../creative/formats';
import { contrast, hexToHsl, normalizeHex } from '../templates/color';
import { formatClassOf, type FormatClass } from '../templates/schema';
import { COLLECTIONS } from './library';
import { PALETTE_ROLES, COLLECTION_IDS, DesignPaletteSchema, type CollectionId, type DesignPalette, type PaletteRole } from './schema';
import { getCollection } from './registry';

/**
 * THE CAMPAIGN DESIGN: the ONE place where a campaign's look is decided. It names the collection, holds the approved palette (with where
 * every color came from and which ones the user changed by hand), the output formats and how pictures are sourced. It is stored with the
 * campaign (inside the Hybrid settings of the factory run, and as a per-project draft until the run starts); every agent and the renderer
 * read this and nothing else. The older per-project "style preference" and the older Hybrid `style` field are only SUGGESTIONS that may
 * seed it; they never compete with it.
 */

export const DESIGN_VERSION = 1;

/** Where a color came from. `user` = typed or picked by the user. */
export const PALETTE_SOURCES = ['user', 'brand_guidelines', 'logo', 'website', 'repository', 'uploaded_image', 'collection_default'] as const;
export type PaletteSource = (typeof PALETTE_SOURCES)[number];
export const SOURCE_LABELS: Record<PaletteSource, string> = {
  user: 'Chosen by you',
  brand_guidelines: 'Brand guidelines',
  logo: 'Logo',
  website: 'Website',
  repository: 'Repository',
  uploaded_image: 'Uploaded image',
  collection_default: 'Collection default',
};

export const IMAGE_SOURCING_MODES = ['prefer_existing', 'balanced', 'prefer_ai'] as const;
export type ImageSourcingMode = (typeof IMAGE_SOURCING_MODES)[number];

export const PaletteEvidence = z.object({
  source: z.enum(PALETTE_SOURCES),
  confidence: z.enum(['high', 'medium', 'low']),
  /** A short, safe sentence such as "Primary color suggested from frontend/src/styles/theme.css". Never page content. */
  evidence: z.string().max(240),
});
export type PaletteEvidence = z.infer<typeof PaletteEvidence>;

export const FORMAT_OPTION_KEYS = ['instagram_post', 'instagram_story', 'facebook_post', 'linkedin_post', 'website_banner', 'flyer', 'billboard', 'other'] as const;
export type FormatOptionKey = (typeof FORMAT_OPTION_KEYS)[number];

/** The formats the user chooses by name (the same keys the project stores as defaults) and the creative formats each one means. */
export const FORMAT_OPTIONS: Record<FormatOptionKey, { label: string; formatIds: string[] }> = {
  instagram_post: { label: 'Instagram post', formatIds: ['instagram_square', 'instagram_portrait'] },
  instagram_story: { label: 'Instagram story', formatIds: ['story'] },
  facebook_post: { label: 'Facebook post', formatIds: ['facebook_feed'] },
  linkedin_post: { label: 'LinkedIn post', formatIds: ['linkedin_feed'] },
  website_banner: { label: 'Website banner', formatIds: ['web_banner', 'landing_hero'] },
  flyer: { label: 'Flyer', formatIds: ['flyer'] },
  billboard: { label: 'Billboard', formatIds: ['billboard'] },
  other: { label: 'Other (16:9 promotional graphic)', formatIds: ['promo_16x9'] },
};

export const CampaignDesign = z.object({
  version: z.literal(DESIGN_VERSION),
  collectionId: z.enum(COLLECTION_IDS),
  /** The version of the collection the campaign was designed with (a later change to the collection never alters a stored campaign silently). */
  collectionVersion: z.number().int().min(1),
  palette: DesignPaletteSchema,
  paletteEvidence: z.partialRecord(z.enum(PALETTE_ROLES), PaletteEvidence),
  /** The roles the user changed by hand: a new analysis or another collection never overwrites them. */
  overridden: z.array(z.enum(PALETTE_ROLES)).max(5),
  /** Format option keys. Empty = the formats follow the strategy's channels (the earlier behaviour). */
  formats: z.array(z.enum(FORMAT_OPTION_KEYS)).max(8),
  /** Templates the user starred inside the collection: a soft preference in the selector. */
  preferredTemplates: z.array(z.string().regex(/^[a-z0-9][a-z0-9_]{2,48}$/)).max(40),
  imageSourcing: z.enum(IMAGE_SOURCING_MODES),
  /**
   * NO AI HYBRID: fully automatic authorized-stock mode. The Visual Researcher may add pictures from the configured licensed providers during the
   * run, only when their license is CLEARED (never one that needs a check). Off by default; the user switches it on explicitly.
   */
  autoStock: z.boolean().default(false),
  /** The user pressed "use this design". A design that is not confirmed is a draft and starts nothing. */
  confirmed: z.boolean(),
  confirmedAt: z.string().max(40).nullable(),
});
export type CampaignDesign = z.infer<typeof CampaignDesign>;

export function defaultPaletteOf(id: CollectionId): DesignPalette {
  return { ...COLLECTIONS.find((c) => c.id === id)!.defaultPalette };
}

/** A fresh design for a collection: its default palette, no overrides, the given formats. */
export function newDesign(collectionId: CollectionId, o: { formats?: FormatOptionKey[]; imageSourcing?: ImageSourcingMode } = {}): CampaignDesign {
  const c = getCollection(collectionId)!;
  const evidence = Object.fromEntries(PALETTE_ROLES.map((r) => [r, { source: 'collection_default', confidence: 'low', evidence: `${c.name} default ${r} color` }])) as CampaignDesign['paletteEvidence'];
  return { version: DESIGN_VERSION, collectionId, collectionVersion: c.version, palette: defaultPaletteOf(collectionId), paletteEvidence: evidence, overridden: [], formats: o.formats ?? [], preferredTemplates: [], imageSourcing: o.imageSourcing ?? 'balanced', autoStock: false, confirmed: false, confirmedAt: null };
}

export type DesignParse = { ok: true; design: CampaignDesign } | { ok: false; message: string };

/** Validates a stored or submitted design. The palette hexes are normalized to lower case; an unknown collection is refused (never replaced). */
export function parseDesign(raw: unknown): DesignParse {
  const withHex = (() => {
    if (!raw || typeof raw !== 'object') return raw;
    const r = raw as { palette?: Record<string, unknown> };
    if (!r.palette || typeof r.palette !== 'object') return raw;
    const palette = Object.fromEntries(Object.entries(r.palette).map(([k, v]) => [k, typeof v === 'string' ? (normalizeHex(v) ?? v) : v]));
    return { ...r, palette };
  })();
  const p = CampaignDesign.safeParse(withHex);
  if (!p.success) {
    const i = p.error.issues[0];
    return { ok: false, message: `The campaign design is not valid: ${i?.path.join('.') || 'value'} ${i?.message ?? ''}`.trim() };
  }
  const c = getCollection(p.data.collectionId);
  if (!c || !c.enabled) return { ok: false, message: `The template collection "${p.data.collectionId}" is not available.` };
  return { ok: true, design: { ...p.data, overridden: [...new Set(p.data.overridden)] } };
}

// ---- palette checks -----------------------------------------------------------------------------------------------------------------------

export interface PaletteCheck {
  ok: boolean;
  /** Problems that make the output unreadable: the design cannot be confirmed with them. */
  errors: string[];
  /** Things to look at that do not stop anything. */
  warnings: string[];
  ratios: { textOnBackground: number; textOnPrimary: number | null; accentOnBackground: number };
}

/** The most readable of white and black on a color, with its ratio. */
function bestOn(bg: string): { color: string; ratio: number } {
  const w = contrast('#ffffff', bg);
  const b = contrast('#000000', bg);
  return w >= b ? { color: '#ffffff', ratio: w } : { color: '#000000', ratio: b };
}

/**
 * Text must read on the background at the collection's minimum. A button or a panel in any color can always carry a readable label (the renderer picks white or
 * black by contrast), so those colors are only compared with the background: a color nearly equal to the background is reported, not refused.
 */
export function checkPalette(palette: DesignPalette, minTextContrast = 4.5): PaletteCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = contrast(palette.text, palette.background);
  if (text < minTextContrast) errors.push(`The text color has a contrast of ${text.toFixed(1)}:1 against the background; at least ${minTextContrast}:1 is needed to be readable.`);
  const primary = bestOn(palette.primary);
  const accentBg = contrast(palette.accent, palette.background);
  if (accentBg < 1.5) warnings.push('The accent color is very close to the background color and will barely stand out.');
  if (contrast(palette.primary, palette.background) < 1.3) warnings.push('The primary color is very close to the background color.');
  return { ok: errors.length === 0, errors, warnings, ratios: { textOnBackground: Number(text.toFixed(2)), textOnPrimary: Number(primary.ratio.toFixed(2)), accentOnBackground: Number(accentBg.toFixed(2)) } };
}

/**
 * What the renderer takes: up to four brand colors in importance order (primary, secondary, accent, then the background and text colors
 * that decide the neutral surfaces). The renderer's palette resolver keeps the first three exactly as given and derives ink and paper from
 * the rest; see `designAnchors` for how background and text become those surfaces.
 */
export function designBrandColors(p: DesignPalette): string[] {
  return [p.primary, p.secondary, p.accent];
}

/**
 * The neutral surfaces of the design. The darker of background/text is the INK of the render, the lighter is the PAPER (templates paint
 * dark panels with ink and light panels with paper, and choose text colors by contrast). A dark-theme brand (light text on a dark
 * background) therefore gets a dark ink = its background and a light paper = its text color.
 */
export function designAnchors(p: DesignPalette): { ink: string; paper: string; backgroundMode: 'light' | 'dark' } {
  const bgIsDark = contrast(p.background, '#000000') < contrast(p.background, '#ffffff');
  const ink = bgIsDark ? p.background : p.text;
  const paper = bgIsDark ? p.text : p.background;
  return { ink, paper, backgroundMode: bgIsDark ? 'dark' : 'light' };
}

// ---- formats ------------------------------------------------------------------------------------------------------------------------------

/** The creative format ids the chosen option keys mean (deduplicated, in order). */
export function formatIdsOf(keys: readonly FormatOptionKey[]): string[] {
  const out: string[] = [];
  for (const k of keys) for (const id of FORMAT_OPTIONS[k]?.formatIds ?? []) if (CREATIVE_FORMATS[id] && !out.includes(id)) out.push(id);
  return out;
}

export const formatClassOfId = (id: string): FormatClass | null => {
  const f = CREATIVE_FORMATS[id];
  return f ? formatClassOf(f.width, f.height) : null;
};

/** Project formats stored as defaults (older projects used these same keys) turned into valid option keys. */
export function formatKeysFromProject(stored: readonly string[] | null | undefined): FormatOptionKey[] {
  return [...new Set((stored ?? []).filter((k): k is FormatOptionKey => (FORMAT_OPTION_KEYS as readonly string[]).includes(k)))];
}

/** A short stable key of a palette: records say which palette a creative was drawn with, and the reviewer compares it with the approved one. */
export const paletteKeyOf = (p: DesignPalette): string => PALETTE_ROLES.map((r) => p[r].replace('#', '').toLowerCase()).join('-');

// ---- changing the collection and the fit of a palette ----------------------------------------------------------------------------------------

export interface PaletteFit {
  ok: boolean;
  notes: string[];
}

/**
 * How well a palette suits a collection, in words. It never blocks anything except unreadable text (see checkPalette): a collection that
 * prefers muted colors still renders a vivid palette, and the user is told what to expect.
 */
export function paletteFit(collectionId: CollectionId, palette: DesignPalette): PaletteFit {
  const c = getCollection(collectionId);
  if (!c) return { ok: false, notes: [`The collection "${collectionId}" does not exist.`] };
  const rules = c.recommendedPaletteRules;
  const notes: string[] = [];
  const bgDark = contrast(palette.background, '#000000') < contrast(palette.background, '#ffffff');
  if (rules.background === 'light' && bgDark) notes.push(`${c.name} is drawn for light backgrounds: its templates will look heavier on your dark background.`);
  if (rules.background === 'dark' && !bgDark) notes.push(`${c.name} is drawn for dark backgrounds: its templates will look flatter on your light background.`);
  const hsl = [palette.primary, palette.secondary, palette.accent].map(hexToHsl);
  const hues: number[] = [];
  for (const h of hsl.filter((x) => x.s > 0.25 && x.l > 0.1 && x.l < 0.92)) if (hues.every((u) => Math.min(Math.abs(u - h.h), 360 - Math.abs(u - h.h)) > 35)) hues.push(h.h);
  if (hues.length > rules.hues) notes.push(`${c.name} works best with at most ${rules.hues} hue${rules.hues === 1 ? '' : 's'}; your palette uses ${hues.length}.`);
  if (rules.saturation === 'muted' && hsl.some((x) => x.s > 0.75 && x.l > 0.25 && x.l < 0.75)) notes.push(`${c.name} prefers muted colors; a strongly saturated color in your palette will stand out sharply.`);
  const chk = checkPalette(palette, rules.minTextContrast);
  notes.push(...chk.errors);
  return { ok: chk.ok, notes };
}

export interface CollectionSwitch {
  design: CampaignDesign;
  /** What the change did to the palette, in words. */
  notes: string[];
  fit: PaletteFit;
}

/**
 * Chooses another collection for a design. The palette is NOT reset: the colors the user edited stay, colors that came from the brand stay,
 * and only colors that were nothing but the old collection's defaults take the new collection's defaults. The selected templates (stars)
 * that the new collection does not list are dropped, and the format choice stays.
 */
export function switchCollection(design: CampaignDesign, collectionId: CollectionId): CollectionSwitch {
  const next = getCollection(collectionId);
  if (!next || !next.enabled) throw new Error(`The template collection "${collectionId}" is not available.`);
  const fresh = defaultPaletteOf(collectionId);
  const palette = { ...design.palette };
  const evidence = { ...design.paletteEvidence };
  const notes: string[] = [];
  const replaced: PaletteRole[] = [];
  for (const role of PALETTE_ROLES) {
    const ev = design.paletteEvidence[role];
    const isDefault = !design.overridden.includes(role) && (!ev || ev.source === 'collection_default');
    if (isDefault) {
      palette[role] = fresh[role];
      evidence[role] = { source: 'collection_default', confidence: 'low', evidence: `${next.name} default ${role} color` };
      if (design.palette[role] !== fresh[role]) replaced.push(role);
    }
  }
  if (replaced.length) notes.push(`${replaced.join(', ')} changed to the ${next.name} defaults because they were only defaults.`);
  const kept = PALETTE_ROLES.filter((r) => !replaced.includes(r));
  if (kept.length) notes.push(`${kept.join(', ')} kept: they came from your brand or your own edits.`);
  const preferred = design.preferredTemplates.filter((id) => next.templateIds.includes(id));
  const out: CampaignDesign = { ...design, collectionId, collectionVersion: next.version, palette, paletteEvidence: evidence, preferredTemplates: preferred, confirmed: false, confirmedAt: null };
  return { design: out, notes, fit: paletteFit(collectionId, palette) };
}

/** A palette edit by the user: the role becomes `user` evidence and is remembered as overridden. */
export function editPaletteRole(design: CampaignDesign, role: PaletteRole, hex: string): CampaignDesign {
  const h = normalizeHex(hex);
  if (!h) throw new Error('That is not a valid color (use #rrggbb).');
  return {
    ...design,
    palette: { ...design.palette, [role]: h.toLowerCase() },
    paletteEvidence: { ...design.paletteEvidence, [role]: { source: 'user', confidence: 'high', evidence: 'Chosen by you' } },
    overridden: [...new Set([...design.overridden, role])],
    confirmed: false,
    confirmedAt: null,
  };
}

/** Back to the colors the analysis detected (or to the collection defaults): clears the overrides of the given roles (all by default). */
export function resetPalette(design: CampaignDesign, detected: { palette: DesignPalette; evidence: CampaignDesign['paletteEvidence'] } | null, roles: readonly PaletteRole[] = PALETTE_ROLES): CampaignDesign {
  const src = detected ?? { palette: defaultPaletteOf(design.collectionId), evidence: newDesign(design.collectionId).paletteEvidence };
  const palette = { ...design.palette };
  const evidence = { ...design.paletteEvidence };
  for (const r of roles) {
    palette[r] = src.palette[r];
    evidence[r] = src.evidence[r];
  }
  return { ...design, palette, paletteEvidence: evidence, overridden: design.overridden.filter((r) => !roles.includes(r)), confirmed: false, confirmedAt: null };
}

/** The suggestion of a new analysis applied to a design: roles the user edited by hand are never overwritten. */
export function applyDetectedPalette(design: CampaignDesign, detected: { palette: DesignPalette; evidence: CampaignDesign['paletteEvidence'] }): CampaignDesign {
  const palette = { ...design.palette };
  const evidence = { ...design.paletteEvidence };
  for (const r of PALETTE_ROLES) {
    if (design.overridden.includes(r)) continue;
    palette[r] = detected.palette[r];
    evidence[r] = detected.evidence[r];
  }
  return { ...design, palette, paletteEvidence: evidence, confirmed: false, confirmedAt: null };
}

export type { CollectionId, DesignPalette, PaletteRole };
