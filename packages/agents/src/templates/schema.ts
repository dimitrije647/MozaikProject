import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';

/**
 * THE TEMPLATE LANGUAGE. A template is DATA: an ordered list of declarative layers in unit coordinates (fractions of the canvas), plus
 * per-format-class patches. It contains no code, no HTML and no URLs, so a template can be validated, previewed, selected and rendered
 * by the same deterministic renderer everywhere (API, Mozaik agents, web preview, export). Nothing in a template can execute.
 *
 * Coordinates: every `box` is [x, y, w, h] as fractions of the canvas width/height (0..1). `size` of text is a fraction of the SHORTER
 * canvas side. Colors are ROLES resolved from the brand palette and the visual style (so one template looks right in any brand) or an
 * explicit #rrggbb.
 */

// ---- format classes ----------------------------------------------------------------------------------------------------------------

/** A template is designed for aspect-ratio CLASSES, not for one pixel size. */
export const FORMAT_CLASSES = ['square', 'portrait', 'story', 'landscape', 'banner'] as const;
export type FormatClass = (typeof FORMAT_CLASSES)[number];

/** square ~1:1, portrait ~4:5, story ~9:16, landscape 1.2..2.6 (feed, 16:9, hero), banner >= 3:1. */
export function formatClassOf(width: number, height: number): FormatClass {
  const r = width / height;
  if (r >= 3) return 'banner';
  if (r >= 1.2) return 'landscape';
  if (r >= 0.9) return 'square';
  if (r >= 0.65) return 'portrait';
  return 'story';
}

// ---- colors and paints -------------------------------------------------------------------------------------------------------------

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'ink', 'paper', 'muted', 'onPrimary', 'onAccent', 'onInk', 'onPaper', 'white', 'black'] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Color = z.union([z.enum(COLOR_ROLES), Hex]);
export type Color = z.infer<typeof Color>;

const Stop = z.object({ at: z.number().min(0).max(1), color: Color, opacity: z.number().min(0).max(1).optional() });
export const Paint = z.union([
  Color,
  z.object({ gradient: z.object({ angle: z.number().min(0).max(360), stops: z.array(Stop).min(2).max(4) }) }),
]);
export type Paint = z.infer<typeof Paint>;

const Frac = z.number().min(-0.5).max(1.5);
export const Box = z.tuple([Frac, Frac, z.number().min(0).max(2), z.number().min(0).max(2)]);
export type Box = z.infer<typeof Box>;

// ---- text -----------------------------------------------------------------------------------------------------------------------------

/** What a text layer shows. headline/support/cta come from the copy; the rest only from content the user or the strategy really gave. */
/** point1..point3: SHORT labels (a feature, a step, a menu category, a service) that fill the cards, rows or steps of a structured layout */
export const TEXT_SLOTS = ['headline', 'support', 'cta', 'eyebrow', 'brand', 'quote', 'attribution', 'stat', 'statLabel', 'date', 'location', 'offer', 'offerDetail', 'tag', 'point1', 'point2', 'point3'] as const;
export type TextSlot = (typeof TEXT_SLOTS)[number];

export const FONT_FAMILIES = ['sans', 'serif', 'display', 'condensed', 'mono'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const TextStyle = z.object({
  family: z.enum(FONT_FAMILIES),
  weight: z.number().int().min(300).max(900),
  italic: z.boolean().optional(),
  case: z.enum(['none', 'upper']).optional(),
  /** Letter spacing in em (-0.05 .. 0.3). */
  tracking: z.number().min(-0.05).max(0.3).optional(),
  lineHeight: z.number().min(0.85).max(1.8).optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

// ---- layers ---------------------------------------------------------------------------------------------------------------------------

const base = { id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), hide: z.array(z.enum(FORMAT_CLASSES)).optional(), opacity: z.number().min(0).max(1).optional(), rotate: z.number().min(-45).max(45).optional(), at: z.partialRecord(z.enum(FORMAT_CLASSES), z.record(z.string(), z.unknown())).optional() };

const Stroke = z.object({ color: Color, width: z.number().min(0).max(0.05) });

export const FillLayer = z.object({ ...base, type: z.literal('fill'), fill: Paint });
export const RectLayer = z.object({ ...base, type: z.literal('rect'), box: Box, fill: Paint.optional(), stroke: Stroke.optional(), radius: z.number().min(0).max(0.5).optional(), shadow: z.boolean().optional() });
export const EllipseLayer = z.object({ ...base, type: z.literal('ellipse'), box: Box, circle: z.boolean().optional(), fill: Paint.optional(), stroke: Stroke.optional() });
export const LineLayer = z.object({ ...base, type: z.literal('line'), from: z.tuple([Frac, Frac]), to: z.tuple([Frac, Frac]), stroke: Stroke });
/** A small set of safe, deterministic decorative patterns. */
export const PatternLayer = z.object({ ...base, type: z.literal('pattern'), box: Box, kind: z.enum(['dots', 'grid', 'stripes', 'rings', 'waves', 'checks']), color: Color, size: z.number().min(0.005).max(0.2) });
/** A closed polygon of points (unit coordinates): triangles, parallelograms, diagonal cuts. */
export const PolygonLayer = z.object({ ...base, type: z.literal('polygon'), points: z.array(z.tuple([Frac, Frac])).min(3).max(8), fill: Paint.optional(), stroke: Stroke.optional() });
export const ImageLayer = z.object({
  ...base,
  type: z.literal('image'),
  slot: z.enum(['hero', 'secondary']),
  box: Box,
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  mask: z.enum(['none', 'circle', 'rounded', 'arch', 'cut-left', 'cut-right']).optional(),
  radius: z.number().min(0).max(0.5).optional(),
  treatment: z
    .object({
      /** A gradient laid over the picture to keep text readable. angle in degrees (0 = left to right, 90 = top to bottom). */
      scrim: z.object({ angle: z.number().min(0).max(360), from: Color, fromOpacity: z.number().min(0).max(1), to: Color, toOpacity: z.number().min(0).max(1) }).optional(),
      duotone: z.object({ shadow: Color, light: Color }).optional(),
      tint: z.object({ color: Color, opacity: z.number().min(0).max(1) }).optional(),
      saturation: z.number().min(0).max(2).optional(),
    })
    .optional(),
  border: Stroke.optional(),
  shadow: z.boolean().optional(),
  /** What is drawn in the box when no image exists (the template is only chosen without an image when this is set). */
  fallback: z.enum(['brandPattern', 'gradient', 'none']).optional(),
  /** cover (default) crops the picture to fill the box; contain shows the WHOLE picture letterboxed in its own border colour (set by the
   *  adaptive composition when any crop would cut people; flat graphics are always fitted). */
  fit: z.enum(['cover', 'contain']).optional(),
  /** the picture kinds this area takes (default inferred: a photograph when text is written over it, else also a screenshot or an illustration) */
  accepts: z.array(z.enum(['photograph', 'screenshot', 'illustration'])).optional(),
});
export const TextLayer = z.object({
  ...base,
  type: z.literal('text'),
  slot: z.enum(TEXT_SLOTS),
  box: Box,
  align: z.enum(['left', 'center', 'right']),
  valign: z.enum(['top', 'middle', 'bottom']),
  style: TextStyle,
  color: Color,
  /** Font size as a fraction of the SHORTER canvas side: the renderer starts at `max` and shrinks to `min` until the text fits its box. */
  size: z.object({ max: z.number().min(0.01).max(0.3), min: z.number().min(0.01).max(0.3) }),
  maxLines: z.number().int().min(1).max(8),
  /** true = the layer is simply omitted when the slot has no content (otherwise the template must list the slot in `requires`). */
  optional: z.boolean().optional(),
  underline: z.boolean().optional(),
});
export const ButtonLayer = z.object({ ...base, type: z.literal('button'), box: Box, fill: Paint, radius: z.number().min(0).max(0.5), stroke: Stroke.optional(), style: TextStyle, color: Color, size: z.object({ max: z.number().min(0.01).max(0.1), min: z.number().min(0.01).max(0.1) }), arrow: z.boolean().optional() });
/** The brand logo; when none exists the brand NAME is drawn in the same box (so a template never has a hole). */
export const LogoLayer = z.object({ ...base, type: z.literal('logo'), box: Box, align: z.enum(['left', 'center', 'right']), valign: z.enum(['top', 'middle', 'bottom']), plate: z.object({ fill: Color, padding: z.number().min(0).max(0.05), radius: z.number().min(0).max(0.5) }).optional(), nameStyle: TextStyle, nameColor: Color });

export const Layer = z.discriminatedUnion('type', [FillLayer, RectLayer, EllipseLayer, LineLayer, PatternLayer, PolygonLayer, ImageLayer, TextLayer, ButtonLayer, LogoLayer]);
export type Layer = z.infer<typeof Layer>;

// ---- the template ---------------------------------------------------------------------------------------------------------------------

export const STYLE_IDS = ['minimalist_tech', 'premium_editorial', 'bold_startup', 'modern_corporate', 'luxury_hospitality', 'lifestyle_photography', 'clean_ecommerce', 'dynamic_events', 'soft_lifestyle', 'contemporary_geometric'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const TEMPLATE_CATEGORIES = ['tech_saas', 'hospitality', 'ecommerce', 'professional_services', 'editorial_brand', 'events_entertainment'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Content a template may ask for. 'image' and 'logo' are assets; the rest are text slots. */
export const REQUIREMENTS = ['image', 'logo', ...TEXT_SLOTS] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export const TemplateDef = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]{2,48}$/),
  name: z.string().min(3).max(60),
  version: z.number().int().min(1),
  status: z.enum(['active', 'draft', 'deprecated']),
  category: z.enum(TEMPLATE_CATEGORIES),
  description: z.string().min(10).max(240),
  /** Visual styles this template belongs to (the style library lists the same ids). */
  styles: z.array(z.enum(STYLE_IDS)).min(1).max(4),
  /** Lower-case industry keywords this template suits ('*' = any industry). */
  industries: z.array(z.string().min(1).max(40)).min(1).max(12),
  /** Channels it is meant for (empty = any). */
  channels: z.array(z.enum(CHANNEL_IDS)).max(9),
  /** The format classes this template is DESIGNED for. A format of another class is refused, never stretched into it. */
  classes: z.array(z.enum(FORMAT_CLASSES)).min(1).max(5),
  /** Slots/assets that MUST have content for the template to be chosen (a testimonial needs a quote, an offer card needs an offer). Never invented. */
  requires: z.array(z.enum(REQUIREMENTS)).max(6),
  density: z.enum(['airy', 'balanced', 'dense']),
  /** The compositional family: used to keep a campaign from repeating the same layout idea. */
  family: z.enum(['full-bleed', 'split', 'inset-card', 'poster-type', 'frame', 'collage', 'band', 'centered', 'diagonal', 'stat-focus', 'quote-focus', 'panel']),
  /** One sentence describing the composition (for people). */
  composition: z.string().min(10).max(200),
  /** Sample content for previews (clearly marked as an example wherever shown). */
  sample: z.object({ headline: z.string().max(80), support: z.string().max(160).optional(), cta: z.string().max(30).optional(), eyebrow: z.string().max(40).optional(), brand: z.string().max(30).optional(), quote: z.string().max(160).optional(), attribution: z.string().max(60).optional(), stat: z.string().max(12).optional(), statLabel: z.string().max(50).optional(), date: z.string().max(30).optional(), location: z.string().max(40).optional(), offer: z.string().max(20).optional(), offerDetail: z.string().max(60).optional(), tag: z.string().max(30).optional() }),
  /** Background tone this template assumes: 'brand' uses the primary color, 'dark'/'light' use the style's ink/paper. */
  tone: z.enum(['brand', 'dark', 'light', 'duo']),
  layers: z.array(Layer).min(2).max(40),
});
export type TemplateDef = z.infer<typeof TemplateDef>;

/** Merges a class patch into a layer (a patch may change geometry, size, alignment, visibility; never `type` or `id`). */
export function layerFor(layer: Layer, cls: FormatClass): Layer | null {
  if (layer.hide?.includes(cls)) return null;
  const patch = layer.at?.[cls];
  if (!patch) return layer;
  const { type: _t, id: _i, at: _a, hide: _h, ...rest } = patch as Record<string, unknown>;
  void _t;
  void _i;
  void _a;
  void _h;
  return { ...layer, ...rest } as Layer;
}

export interface TemplateIssue {
  templateId: string;
  message: string;
}

/**
 * Full validation of a template: its schema, unique layer ids, every class it declares resolves to VALID layers (patches included),
 * every required text slot has a layer, a hero image layer exists when 'image' is required, and text sizes are sane.
 */
export function validateTemplate(raw: unknown): { ok: true; template: TemplateDef } | { ok: false; issues: TemplateIssue[] } {
  const parsed = TemplateDef.safeParse(raw);
  const id = (raw as { id?: string } | null)?.id ?? '?';
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 8).map((i) => ({ templateId: id, message: `${i.path.join('.')}: ${i.message}` })) };
  const t = parsed.data;
  const issues: TemplateIssue[] = [];
  const say = (message: string) => issues.push({ templateId: t.id, message });
  const ids = new Set<string>();
  for (const l of t.layers) {
    if (ids.has(l.id)) say(`duplicate layer id "${l.id}"`);
    ids.add(l.id);
  }
  for (const cls of t.classes) {
    const resolved = t.layers.map((l) => layerFor(l, cls)).filter((l): l is Layer => !!l);
    for (const l of resolved) {
      const ok = Layer.safeParse(l);
      if (!ok.success) say(`layer "${l.id}" is invalid in class ${cls}: ${ok.error.issues[0]?.path.join('.')} ${ok.error.issues[0]?.message}`);
      if (l.type === 'text' && l.size.min > l.size.max) say(`text "${l.id}" has min > max size in class ${cls}`);
    }
    const slots = new Set(resolved.filter((l): l is z.infer<typeof TextLayer> => l.type === 'text').map((l) => l.slot));
    if (!slots.has('headline')) say(`class ${cls} has no headline text layer`);
    for (const r of t.requires) if (r !== 'image' && r !== 'logo' && !slots.has(r as TextSlot)) say(`requires "${r}" but class ${cls} has no text layer for it`);
    if (t.requires.includes('image') && !resolved.some((l) => l.type === 'image' && l.slot === 'hero')) say(`requires "image" but class ${cls} has no hero image layer`);
  }
  return issues.length ? { ok: false, issues } : { ok: true, template: t };
}

// ---- styles and the visual direction ---------------------------------------------------------------------------------------------------

export const StyleDef = z.object({
  id: z.enum(STYLE_IDS),
  name: z.string().min(3).max(40),
  description: z.string().min(20).max(300),
  typography: z.object({
    headline: z.object({ family: z.enum(FONT_FAMILIES), weight: z.number().int(), case: z.enum(['none', 'upper']), tracking: z.number() }),
    body: z.object({ family: z.enum(FONT_FAMILIES), weight: z.number().int() }),
    hierarchy: z.string().min(10).max(240),
  }),
  color: z.object({
    /** dark = ink background, light = paper background, brand = primary background. */
    background: z.enum(['dark', 'light', 'brand', 'mixed']),
    accent: z.enum(['complement', 'analogous', 'mono', 'neutral']),
    logic: z.string().min(10).max(240),
    /** Neutral anchors used when the brand gives too few colors. */
    ink: Hex,
    paper: Hex,
  }),
  composition: z.array(z.string().min(5).max(120)).min(2).max(6),
  photography: z.object({ subjects: z.array(z.string().max(80)).min(1).max(6), treatment: z.array(z.string().max(80)).min(1).max(5), avoid: z.array(z.string().max(80)).max(5) }),
  density: z.enum(['airy', 'balanced', 'dense']),
  decorative: z.array(z.string().min(5).max(120)).max(5),
  channels: z.array(z.enum(CHANNEL_IDS)).max(9),
  templateCategories: z.array(z.enum(TEMPLATE_CATEGORIES)).min(1).max(6),
  industries: z.array(z.string().max(40)).min(1).max(14),
  /** Words in a brief that point to this style (used by the deterministic matcher). */
  keywords: z.array(z.string().max(30)).min(3).max(20),
});
export type StyleDef = z.infer<typeof StyleDef>;

export const REFERENCE_KINDS = ['brand_asset', 'user_upload', 'user_link', 'style_library', 'licensed_asset', 'pinterest_board'] as const;
export const PERMISSION_STATUS = ['owned_by_user', 'user_provided', 'original_to_launchpilot', 'licensed', 'link_only_not_analyzed', 'platform_restricted_not_stored'] as const;

/** The Visual Direction Brief: what the campaign should LOOK like, with where every piece of that came from. */
export const VisualDirectionBrief = z.object({
  styleId: z.enum(STYLE_IDS),
  secondaryStyleIds: z.array(z.enum(STYLE_IDS)).max(2),
  rationale: z.string().max(400),
  colors: z.object({ primary: Hex, secondary: Hex, accent: Hex, ink: Hex, paper: Hex, notes: z.string().max(240) }),
  typography: z.object({ headline: z.enum(FONT_FAMILIES), body: z.enum(FONT_FAMILIES), notes: z.string().max(200) }),
  composition: z.array(z.string().max(140)).max(5),
  mood: z.array(z.string().max(40)).max(5),
  imageSubjects: z.array(z.string().max(120)).max(6),
  imageTreatment: z.array(z.string().max(100)).max(5),
  channelNotes: z.array(z.object({ channel: z.enum(CHANNEL_IDS), note: z.string().max(160) })).max(9),
  /** Every reference that influenced this brief, with its permission status. Pinterest items are link-level only unless Pinterest's rules allow more. */
  references: z.array(z.object({ id: z.string().max(60), kind: z.enum(REFERENCE_KINDS), label: z.string().max(120), url: z.string().max(300).nullable(), permission: z.enum(PERMISSION_STATUS), used: z.string().max(160) })).max(24),
  origin: z.enum(['deterministic', 'model_refined', 'user_approved']),
  confidence: z.enum(['low', 'medium', 'high']),
  limitations: z.array(z.string().max(200)).max(8),
});
export type VisualDirectionBrief = z.infer<typeof VisualDirectionBrief>;

// ---- the render contract -----------------------------------------------------------------------------------------------------------

/** Text a template may show. headline is always required; the rest are optional and are never invented. */
export type CreativeContent = Partial<Record<TextSlot, string>> & { headline: string };

export type TemplateRenderFailure = 'unsupported_format' | 'missing_required' | 'image_unreadable' | 'render_failed';

export interface TemplateRenderInput {
  template: TemplateDef;
  /** Output pixels. Must belong to one of the template's declared classes (formatClassOf), otherwise the render is refused, never stretched. */
  width: number;
  height: number;
  content: CreativeContent;
  /** Brand colors (hex), most important first. May be empty: the visual style's own anchors are used. */
  palette: string[];
  styleId?: StyleId;
  /** The approved surfaces of a campaign design (ink = the darker, paper = the lighter), used exactly instead of the style's own anchors. */
  anchors?: { ink: string; paper: string };
  brandName: string;
  /** Raw image bytes (anything sharp reads). Never modified on disk; the renderer only reads them. */
  images?: { hero?: Buffer; secondary?: Buffer };
  logo?: Buffer | null;
  /** Where the subject of the hero image is (0..1), used when cropping. Default centre. */
  heroFocus?: [number, number];
  /**
   * The logo is the company's APPROVED logo (Get Content): when it would not read against what is behind it (a dark mark on a dark photograph...), a quiet
   * plate is drawn behind it. Off by default: a campaign without an approved logo renders exactly as before.
   */
  logoAdapt?: boolean;
  /**
   * Where the people, the faces and the subject of the HERO picture are (imagery/subject.ts, fractions of the picture). With it the crop keeps
   * faces whole and the subject inside the frame, a flat graphic (logo banner, text on colour) is fitted instead of cropped, and the report
   * measures how visible every face stays in the finished creative.
   */
  subject?: RenderSubject;
  /** Deterministic adjustments asked for by the design preflight after an earlier render of the same creative failed a check. */
  tune?: RenderTune;
  /**
   * SHORTER APPROVED WORDINGS of essential text, longest first (the Content Writer's short call to action / headline, or a shortening that only
   * drops words of the original). When the full text does not fit even after the layout adjustments, the first one that fits COMPLETELY is drawn;
   * a cut text ("Start the free Management and Risk Chec…") is never the answer.
   */
  alternatives?: Partial<Record<'cta' | 'headline', string[]>>;
}

/** [x, y, w, h] as fractions (0..1). */
export type UnitBox = [number, number, number, number];

export interface RenderSubject {
  faces: UnitBox[];
  subject: UnitBox;
  graphic: boolean;
}

/**
 * Repairs the preflight may ask for. Text never gets transparency: only decorative layers are made lighter, smaller or hidden.
 *   layerOpacity  multiplies the opacity of decorative layers (rect, polygon, ellipse, pattern, line) and of a picture's scrim/tint (`<imageLayerId>:scrim`, `:tint`)
 *   hide          decorative layers that are left out (never text, button, logo or picture)
 *   avoid         canvas regions (fractions) the crop keeps the faces and the subject out of (under a panel, a band, a text block)
 *   logoScale     the logo box is enlarged by this factor, anchored at its alignment, inside the safe area
 *   logoPlate     a quiet plate is drawn behind the logo when it would not read against what is behind it
 *   textBacking   text layers that get a tight solid backing (the text itself stays fully opaque)
 *   shrinkDecor   decorative layers that are drawn smaller around their own centre (factor 0.4..1)
 */
export interface RenderTune {
  layerOpacity?: Record<string, number>;
  hide?: string[];
  avoid?: UnitBox[];
  logoScale?: number;
  logoPlate?: boolean;
  textBacking?: string[];
  shrinkDecor?: Record<string, number>;
  /** canvas regions (fractions) the logo keeps out of: it moves to another corner of its template (text it collided with, a face) */
  logoAvoid?: UnitBox[];
  /** draw the business NAME next to a logo mark that does not spell it (a shield, a symbol): print must say who is advertising */
  brandName?: boolean;
  /** buttons put back on the axis of their group: centre / left edge / right edge at x (fraction of the width) */
  alignX?: Record<string, { mode: 'center' | 'left' | 'right'; x: number }>;
  /**
   * CONTENT-AWARE SPACING (templates/spacing.ts): vertical changes of layer geometry, as fractions - relative (dy: move, dh: grow) or the new
   * absolute top/height of a box (y/h). Only vertical: the alignment axes of the composition never change.
   */
  move?: Record<string, { dy?: number; dh?: number; y?: number; h?: number; hide?: boolean }>;
}

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the renderer really drew, in canvas pixels: the input of the deterministic design preflight. */
export interface RenderReport {
  width: number;
  height: number;
  safe: { l: number; t: number; r: number; b: number };
  hero: null | {
    layerId: string;
    rect: PxRect;
    fit: 'cover' | 'contain';
    /** 1 = the smallest scale that covers the box; > 1 zoomed in on the people */
    zoom: number;
    graphic: boolean;
    rotated: boolean;
    /** share of the picture's area that the crop left out (0 = the whole picture is shown) */
    cropLoss: number;
    /** share of the subject box inside the visible frame */
    subjectInFrame: number;
    /** visible subject area as a share of the canvas */
    subjectShare: number;
    /** 0..1 how unchanged the subject area looks in the finished creative (1 = nothing is drawn over it) */
    subjectVisibility: number | null;
    /** 0..1 how unchanged the whole visible picture looks (panels, scrims and bands lower it) */
    pictureVisibility: number | null;
    faces: { rect: PxRect; area: number; inFrame: number; visibility: number | null }[];
  };
  texts: { layerId: string; slot: TextSlot; rect: PxRect; size: number; contrast: number; busy: number; trimmed: boolean; backed: boolean; /** relative luminance of the text colour */ lum: number; /** the words really drawn */ text?: string; align?: 'left' | 'center' | 'right'; /** the designed area the text was set in (rect = the ink) */ box?: PxRect; valign?: 'top' | 'middle' | 'bottom'; /** set at an angle (a tilted card) */ rotated?: boolean }[];
  /** designed areas of OPTIONAL text slots left empty (no date, no support line): the room a missing text leaves behind */
  emptySlots?: { layerId: string; slot: TextSlot; rect: PxRect }[];
  buttons: { layerId: string; rect: PxRect; trimmed: boolean; widened: boolean; arrowDropped: boolean; text?: string; rotated?: boolean }[];
  logo: null | {
    layerId: string;
    rect: PxRect;
    mode: 'logo' | 'name';
    contrast: number;
    plate: boolean;
    /** the business name was drawn next to the mark */
    name?: boolean;
    /** how the logo was set: directly, on the template's own plate, recoloured (single-colour logo), on a recoloured plate, on an added plate */
    treatment?: 'direct' | 'template_plate' | 'recoloured' | 'plate_recoloured' | 'plate_added';
  };
  /** essential text replaced by a shorter approved wording because the full one did not fit */
  shortened?: { slot: TextSlot; from: string; to: string }[];
  decor: { layerId: string; type: string; rect: PxRect; opacity: number; area: number; afterHero: boolean; /** relative luminance of its fill (null: no solid fill) */ lum: number | null; /** filled with a gradient (a scrim fading out, not a solid panel) */ gradient?: boolean }[];
}

export type TemplateRenderResult =
  | {
      ok: true;
      png: Buffer;
      width: number;
      height: number;
      /** Honest notes about what the renderer had to do: 'text_shrunk:headline', 'text_trimmed:support', 'logo_missing_name_used', 'hero_missing_fallback', 'low_contrast_adjusted:cta', ... Never empty strings. */
      flags: string[];
      /** Text slots that were really drawn (an optional slot without content is absent). */
      drawn: TextSlot[];
      /** The layers that were drawn, in painting order (layer ids). */
      layers: string[];
      /** The geometry and measurements of what was drawn (for the design preflight). */
      report: RenderReport;
    }
  | { ok: false; reason: TemplateRenderFailure; message: string };
