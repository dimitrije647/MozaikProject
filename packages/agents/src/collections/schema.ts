import { z } from 'zod';
import { FONT_FAMILIES, STYLE_IDS, TEMPLATE_CATEGORIES } from '../templates/schema';

/**
 * TEMPLATE COLLECTIONS. A collection is a cohesive DESIGN SYSTEM; a template is one rendering COMPOSITION. A collection never copies a
 * template: it names the templates that belong to it and carries the design TOKENS (typography, shape, button, image treatment, motif)
 * that are applied to every one of them at render time (./theme.ts). The same template can therefore sit in two collections and look
 * different in each, while every template of one collection shares the same type, corners, call-to-action, picture treatment and motif.
 *
 * Collection ids are stable API: they are stored with campaigns. Never rename one; add a new id instead.
 */

export const COLLECTION_IDS = ['minimal_tech', 'bold_startup', 'premium_editorial', 'modern_corporate', 'luxury_hospitality', 'lifestyle_human', 'clean_ecommerce', 'dynamic_events', 'contemporary_geometric', 'soft_organic'] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];
export const isCollectionId = (v: unknown): v is CollectionId => typeof v === 'string' && (COLLECTION_IDS as readonly string[]).includes(v);

/** The message roles a complete campaign needs. story / feed / banner are not listed: they follow from the format classes of the templates. */
export const COLLECTION_ROLES = ['hero', 'highlight', 'benefit', 'promo'] as const;
export type CollectionRole = (typeof COLLECTION_ROLES)[number];
export const ROLE_LABELS: Record<CollectionRole, string> = { hero: 'Hero / main announcement', highlight: 'Product or service highlight', benefit: 'Benefit / feature', promo: 'Promotional message' };

export const DESIGN_CATEGORIES = ['technology', 'startup', 'editorial', 'corporate', 'hospitality', 'lifestyle', 'commerce', 'events', 'geometric', 'organic'] as const;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TypeToken = z.object({
  family: z.enum(FONT_FAMILIES),
  weight: z.number().int().min(300).max(900),
  italic: z.boolean().optional(),
  case: z.enum(['none', 'upper']),
  tracking: z.number().min(-0.05).max(0.3).optional(),
  lineHeight: z.number().min(0.85).max(1.8).optional(),
});
export type TypeToken = z.infer<typeof TypeToken>;

const Role = z.enum(['primary', 'secondary', 'accent', 'ink', 'paper', 'muted', 'white', 'black']);

export const CollectionTokens = z.object({
  typography: z.object({
    /** headline, stat, offer, quote */
    headline: TypeToken,
    /** support, offer detail, stat label, attribution */
    body: TypeToken,
    /** eyebrow, tag, date, location */
    label: TypeToken,
    /** the label on a call-to-action button */
    button: TypeToken,
    /** the brand name drawn when there is no logo file */
    brand: TypeToken,
    /** multiplies every headline size (max and min). 1 = as the template was drawn. */
    headlineScale: z.number().min(0.85).max(1.2),
  }),
  shape: z.object({
    /** corner radius of inset cards and panels (fraction of their shorter side); 0 = square corners */
    cardRadius: z.number().min(0).max(0.5),
    cardShadow: z.boolean(),
    /** fraction of the button's shorter side: 0 square, 0.5 pill */
    buttonRadius: z.number().min(0).max(0.5),
    buttonArrow: z.boolean(),
    /** hairline weight multiplier for rules and strokes */
    lineWeight: z.number().min(0.4).max(2.5),
    /** the plate behind a logo, same unit as buttonRadius */
    logoPlateRadius: z.number().min(0).max(0.5),
  }),
  image: z.object({
    /** the mask of a picture that sits INSIDE the layout (full-bleed pictures are never masked) */
    mask: z.enum(['none', 'rounded', 'arch', 'cut-right', 'cut-left']),
    radius: z.number().min(0).max(0.5),
    saturation: z.number().min(0.4).max(1.6),
    /** multiplies the opacity of every readability scrim (1 = as drawn) */
    scrim: z.number().min(0.5).max(1.3),
    tint: z.object({ color: Role, opacity: z.number().min(0).max(0.4) }).nullable(),
    border: z.object({ color: Role, width: z.number().min(0).max(0.02) }).nullable(),
    shadow: z.boolean(),
  }),
  decor: z.object({
    /** 'hide' removes pattern layers; an object replaces their kind and scales their opacity */
    patterns: z.union([z.literal('hide'), z.literal('keep'), z.object({ kind: z.enum(['dots', 'grid', 'stripes', 'rings', 'waves', 'checks']), opacity: z.number().min(0.2).max(1.6) })]),
  }),
});
export type CollectionTokens = z.infer<typeof CollectionTokens>;

export const DesignPaletteSchema = z.object({ primary: Hex, secondary: Hex, accent: Hex, background: Hex, text: Hex });
export type DesignPalette = z.infer<typeof DesignPaletteSchema>;
export const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

export const TemplateCollection = z.object({
  id: z.enum(COLLECTION_IDS),
  /** "01" .. "10": the order of the gallery */
  number: z.number().int().min(1).max(10),
  name: z.string().min(3).max(40),
  tagline: z.string().min(10).max(90),
  description: z.string().min(40).max(360),
  designCategory: z.enum(DESIGN_CATEGORIES),
  /** The library style this collection builds on (advice for the visual direction and the style matcher). */
  styleId: z.enum(STYLE_IDS),
  /** The template categories its templates come from (informational). */
  categories: z.array(z.enum(TEMPLATE_CATEGORIES)).min(1).max(6),
  industrySuitability: z.array(z.string().min(2).max(40)).min(3).max(14),
  audienceSuitability: z.array(z.string().min(3).max(60)).min(2).max(6),
  /** Ordered. A template listed here must exist in the library; it can also belong to another collection. */
  templateIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_]{2,48}$/)).min(5).max(30),
  /** Which of these templates play which message role. Every role needs at least one template. */
  roles: z.record(z.enum(COLLECTION_ROLES), z.array(z.string()).min(1).max(8)),
  typographySystem: z.string().min(20).max(300),
  layoutPrinciples: z.array(z.string().min(10).max(140)).min(3).max(5),
  imageTreatment: z.string().min(20).max(300),
  decorativeSystem: z.string().min(20).max(300),
  tokens: CollectionTokens,
  defaultPalette: DesignPaletteSchema,
  recommendedPaletteRules: z.object({
    background: z.enum(['light', 'dark', 'either']),
    /** how many hues the palette should use at most */
    hues: z.number().int().min(1).max(3),
    saturation: z.enum(['muted', 'balanced', 'vivid']),
    minTextContrast: z.number().min(3).max(7),
    notes: z.array(z.string().min(10).max(160)).min(1).max(4),
  }),
  /** Real renders of these (template, class) pairs make the collection card; nothing here is a stock picture. */
  previewAssets: z.array(z.object({ templateId: z.string(), class: z.enum(['square', 'portrait', 'story', 'landscape', 'banner']) })).min(3).max(6),
  version: z.number().int().min(1),
  enabled: z.boolean(),
});
export type TemplateCollection = z.infer<typeof TemplateCollection>;
