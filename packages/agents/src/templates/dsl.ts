import { validateTemplate, type Box, type Color, type FontFamily, type FormatClass, type Layer, type Paint, type TemplateDef, type TextSlot } from './schema';

/**
 * TEMPLATE AUTHORING DSL. Tiny typed helpers that return the PLAIN DATA objects the template schema describes, so a template
 * reads as a compact, declarative list of layers. Nothing here runs at render time and nothing returned can execute: a template is
 * data only (no code, no HTML, no URLs). The renderer (./render.ts) paints it; `tools/sheet.ts` lets you LOOK at the result.
 *
 * ---------------------------------------------------------------------------------------------------------------------------------
 * CONVENTIONS EVERY TEMPLATE AUTHOR MUST KNOW
 * ---------------------------------------------------------------------------------------------------------------------------------
 * UNITS
 *   box = [x, y, w, h], all FRACTIONS of the canvas (0..1; x,w of the width, y,h of the height; they may bleed past 0..1).
 *   A box that is 0.5 wide on a 1080x1350 canvas is 540px wide and one that is 0.5 tall is 675px: fractions are NOT square.
 *   Text `size` and all stroke widths are fractions of the SHORTER canvas side ("unit"): on 1080x1920 the unit is 1080, so
 *   size 0.08 = 86px. Typical sizes: headline 0.055..0.10, support 0.026..0.036, button label 0.024..0.032, eyebrow/tag 0.018..0.024.
 *   `radius` is a fraction of the SHORTER side of the thing it rounds (0.5 = a pill/circle). Pattern `size` is the cell size.
 *   Gradient/scrim `angle`: 0 = left to right, 90 = top to bottom, 180 = right to left, 270 = bottom to top.
 *
 *   PIXEL AUTHORING: `CANVAS.square.box(86, 80, 320, 60)` turns pixels of the reference canvas (square 1080x1080, portrait 1080x1350,
 *   story 1080x1920, landscape 1200x628, banner 1200x300) into the stored fractions; `CANVAS.story.size(96, 56)` gives a [max, min] text
 *   size from pixels. Author each class in its own pixels and write its patch with `patch`:
 *   `at: { story: patch(CANVAS.story, { box: [86, 1040, 907, 38], size: [26] }) }` (box in px, size = [maxPx, minPx] or one number).
 *
 * COLORS ARE ROLES (so one template looks right in every brand): primary / secondary / accent (the brand's own colors, derived when the
 *   brand gave fewer), ink (deep neutral) and paper (light neutral) tuned by the visual style, muted (quiet text between them), white,
 *   black, and onPrimary / onAccent / onInk / onPaper = the text color that reads best ON that surface. Use `onX` for text laid on X.
 *   A dark brand makes `primary` and `ink` nearly the same color: do not paint primary shapes ON ink (use accent / secondary / onInk there),
 *   and do not paint accent text on a photo scrim (it cannot be guaranteed to read): use onInk for text, accent for bars and buttons.
 *   A literal '#rrggbb' is allowed for rare fixed colors, but it will NOT follow the brand. The canvas starts as `paper`.
 *   The renderer measures contrast behind every text and button label: below 3:1 (large) / 4.5:1 (small) it swaps the color for the
 *   best of onInk/onPaper/white/black and flags `low_contrast_adjusted:<id>`. Design for the right contrast anyway: it is a safety net.
 *
 * Z-ORDER = ARRAY ORDER. Painting order is the order of `layers`. Backgrounds first, picture, scrims/panels, then text, button, logo.
 *
 * FORMAT CLASSES AND PATCHES
 *   `classes` lists the aspect-ratio classes the template is DESIGNED for: square (~1:1), portrait (~4:5), story (~9:16),
 *   landscape (1.2..2.6: feed, 16:9, hero), banner (>= 3:1). A format of another class is REFUSED, never stretched. Declare only
 *   classes you really composed; 2 to 4 is normal. Every class needs a headline text layer (validateTemplate checks it).
 *   Per-class changes go in a layer's `at: { story: { box: [...], size: { max, min } } }`. A patch REPLACES whole top-level keys of the layer
 *   (give a complete `size`/`style`/`box`, not a fragment). `hide: ['banner']` removes the layer in that class. The base values of a
 *   layer are used for every class without a patch, so make the base the class you care about most and patch the rest.
 *   Compose banner (1200x300, 4:1) and story (1080x1920) separately: they are different layouts, not scaled ones.
 *
 * SAFE AREA (text, buttons and logos are clamped inside it; decoration and pictures may bleed to the edge)
 *   exact size / ratio of a CREATIVE_FORMATS entry, else 6% each side:
 *     square 1080x1080      top .07 bottom .07 left .08 right .08     portrait 1080x1350   top .07 bottom .08 left .08 right .08
 *     story 1080x1920       top .14 bottom .14 left .08 right .08     landscape 1200x628   top .10 bottom .10 left .06 right .06
 *     16:9 1920x1080        top .08 bottom .08 left .06 right .06     banner 1200x300      top .12 bottom .12 left .04 right .04
 *     landing hero 1920x800 top .10 bottom .10 left .06 right .06
 *   Keep text boxes inside the STRICTEST margin of the class (e.g. story: y 0.14..0.86, x 0.08..0.92) so nothing is moved. A moved
 *   box is flagged `moved_into_safe_area:<layerId>`: a finished template should render its `sample` without that flag.
 *
 * TEXT
 *   The renderer starts at size[0] (max) and shrinks toward size[1] (min) until the wrapped text fits the box in `lines` lines, then
 *   (only at min) hyphenates a too-long word and trims with an ellipsis. Size the box for the LONGEST realistic copy (headlines up to
 *   ~80 characters, support up to ~160). Lines sit in line boxes of size*lh: at lh 1.0 the cap tops sit ~0.13em below the box top.
 *   valign 'bottom' anchors the LAST line to the box bottom (good for text growing up from a scrim); 'top' anchors the first line.
 *   Multi-line text is BALANCED automatically (same number of lines, evenly filled: no one-word last line), so a box is a maximum width,
 *   not the exact line length. The brand-name fallback of a logo layer is one line, fitted to the box height and width.
 *   Fonts are system font stacks (no bundled fonts): sans, serif, display (bold geometric), condensed, mono. Right-to-left text is
 *   mirrored automatically (a left-aligned layer becomes right-aligned). Copy longer than 400 characters is cut with an ellipsis.
 *   `optional: true` (the default here for every slot but the headline) omits the layer when the slot has no copy; anything that must
 *   exist for the layout to make sense goes in `requires` instead. NEVER make a slot required just to avoid designing without it:
 *   a template whose optional slots are missing must still look finished (give the headline room to breathe).
 *
 * REQUIRES (honest): list 'image' only when the design is meaningless without a picture (the hero layer then needs no fallback);
 *   list 'logo' only when a real logo file must be shown (the logo layer otherwise falls back to the brand NAME in its box); list text
 *   slots the design cannot do without (a testimonial needs 'quote', an offer card needs 'offer'). Never invent content.
 *
 * IMAGES: `img(id, 'hero', box, ...)` cover-crops the picture to the box (never stretches), around `focus` (0..1, default centre).
 *   Without a picture the layer draws its `fallback` ('brandPattern' | 'gradient' | 'none') and the render flags `hero_missing_fallback`.
 *   Masks: none, circle (a true circle, diameter = shorter side), rounded (radius), arch, cut-left / cut-right (diagonal edge; `radius`
 *   = size of the cut as a fraction of the shorter side). Treatments: scrim (gradient for readable text), duotone, tint, saturation.
 *
 * RENDER FLAGS you may see in the sheet captions (red = something to fix in the template): moved_into_safe_area:<id>, low_contrast_adjusted:<id>,
 *   text_shrunk:<slot> (the box is too small for the typical copy), text_trimmed:<slot> (way too small), text_hyphenated:<slot>,
 *   hero_missing_fallback, logo_missing_name_used (normal in previews), image_low_resolution:<slot>. Render the `sample` copy without any red flag.
 *
 * LOGO: the logo is fitted INSIDE its box (never stretched) and placed by align/valign; an optional plate (a rounded chip behind it)
 *   hugs it with `padding`. With no logo file the brand name is drawn in the same box with nameStyle/nameColor.
 *
 * GOOD TEMPLATES: pick ONE clear composition idea, 2 to 3 type sizes, aligned edges on a few shared margins, generous space, a headline
 *   that is readable at thumbnail size, a button/offer that is obvious, and decoration that supports (never fights) the text.
 *   Run `node --import tsx src/templates/tools/sheet.ts <outDir> <id>` and LOOK at every class with two different palettes
 *   (a dark saturated one and a pastel one) before you call it done.
 */

// ---- shared option types ---------------------------------------------------------------------------------------------------------------

export interface Common {
  /** Classes in which the layer is not drawn. */
  hide?: FormatClass[];
  opacity?: number;
  /** degrees, -45..45, around the centre of the layer */
  rotate?: number;
  /** Per-class patches: top-level keys of the layer replaced for that class (box, size, align, style, ...). */
  at?: Partial<Record<FormatClass, Record<string, unknown>>>;
}

type Stroke = { color: Color; width: number };
type Pt = [number, number];

/** Removes `undefined` keys so the resulting objects are clean JSON. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const common = (c: Common = {}) => compact({ hide: c.hide, opacity: c.opacity, rotate: c.rotate, at: c.at });

// ---- pixel helpers ---------------------------------------------------------------------------------------------------------------------

export interface CanvasHelper {
  width: number;
  height: number;
  /** the shorter side (the unit text sizes are fractions of) */
  unit: number;
  /** a box from PIXELS (x, y, w, h) on this canvas */
  box: (x: number, y: number, w: number, h: number) => Box;
  /** a point from pixels */
  pt: (x: number, y: number) => [number, number];
  /** [max, min] text size from pixels (or a fixed size from one number) */
  size: (maxPx: number, minPx?: number) => [number, number];
}

/** Lets a template be written in pixels of a reference canvas and stored as fractions: `const SQ = canvas(1080, 1080); SQ.box(86, 80, 320, 60)`. */
export function canvas(width: number, height: number): CanvasHelper {
  const unit = Math.min(width, height);
  const r = (v: number) => Number(v.toFixed(5));
  return {
    width,
    height,
    unit,
    box: (x, y, w, h) => [r(x / width), r(y / height), r(w / width), r(h / height)],
    pt: (x, y) => [r(x / width), r(y / height)],
    size: (maxPx, minPx = maxPx) => [r(maxPx / unit), r(minPx / unit)],
  };
}

/**
 * A class patch written in PIXELS of that class's reference canvas: `at: { story: patch(CANVAS.story, { box: [86, 1040, 907, 38], size: [26] }) }`.
 * `box` is [x, y, w, h] in px, `size` is [maxPx, minPx] (or one number) for text/buttons; every other key (align, valign, fill, ...) is copied as is.
 * For a `from`/`to`/`points` patch use `canvas.pt()` yourself.
 */
export function patch(c: CanvasHelper, spec: { box?: [number, number, number, number]; size?: number | [number, number] } & Record<string, unknown>): Record<string, unknown> {
  const { box, size, ...rest } = spec;
  const out: Record<string, unknown> = { ...rest };
  if (box) out.box = c.box(box[0], box[1], box[2], box[3]);
  if (size !== undefined) {
    const [max, min] = typeof size === 'number' ? [size, size] : size;
    out.size = { max: Number((max / c.unit).toFixed(5)), min: Number((min / c.unit).toFixed(5)) };
  }
  return out;
}

/** The reference canvas of each format class (the sizes `preview.ts` and `tools/sheet.ts` render at). */
export const CANVAS: Record<FormatClass, CanvasHelper> = {
  square: canvas(1080, 1080),
  portrait: canvas(1080, 1350),
  story: canvas(1080, 1920),
  landscape: canvas(1200, 628),
  banner: canvas(1200, 300),
};

// ---- paints ----------------------------------------------------------------------------------------------------------------------------

/** grad(90, [0, 'ink', 0], [1, 'ink', 0.85]): a linear gradient; each stop is [position 0..1, color, opacity 0..1 (default 1)]. */
export function grad(angle: number, ...stops: Array<[number, Color, number?]>): Paint {
  return { gradient: { angle, stops: stops.map(([at, color, opacity]) => compact({ at, color, opacity })) } } as Paint;
}

/** An image scrim treatment: a gradient laid over the picture so text on it stays readable. */
export const scrim = (angle: number, from: Color, fromOpacity: number, to: Color, toOpacity: number) => ({ angle, from, fromOpacity, to, toOpacity });

// ---- layers ----------------------------------------------------------------------------------------------------------------------------

/** The whole canvas painted with a color or gradient (usually the first layer). */
export const fill = (id: string, paint: Paint, c?: Common) => ({ id, type: 'fill', fill: paint, ...common(c) } as Extract<Layer, { type: 'fill' }>);

export const rect = (id: string, box: Box, o: { fill?: Paint; stroke?: Stroke; radius?: number; shadow?: boolean } & Common = {}) =>
  ({ id, type: 'rect', box, ...compact({ fill: o.fill, stroke: o.stroke, radius: o.radius, shadow: o.shadow }), ...common(o) } as Extract<Layer, { type: 'rect' }>);

export const ellipse = (id: string, box: Box, o: { circle?: boolean; fill?: Paint; stroke?: Stroke } & Common = {}) =>
  ({ id, type: 'ellipse', box, ...compact({ circle: o.circle, fill: o.fill, stroke: o.stroke }), ...common(o) } as Extract<Layer, { type: 'ellipse' }>);

/** A true circle (diameter = the shorter side of the box, centred in it). */
export const circle = (id: string, box: Box, o: { fill?: Paint; stroke?: Stroke } & Common = {}) => ellipse(id, box, { ...o, circle: true });

export const line = (id: string, from: Pt, to: Pt, stroke: Stroke, c?: Common) => ({ id, type: 'line', from, to, stroke, ...common(c) } as Extract<Layer, { type: 'line' }>);

export const pattern = (id: string, box: Box, kind: 'dots' | 'grid' | 'stripes' | 'rings' | 'waves' | 'checks', color: Color, size: number, c?: Common) =>
  ({ id, type: 'pattern', box, kind, color, size, ...common(c) } as Extract<Layer, { type: 'pattern' }>);

/** A closed polygon (3..8 points, unit coordinates): triangles, parallelograms, diagonal cuts. */
export const poly = (id: string, points: Pt[], o: { fill?: Paint; stroke?: Stroke } & Common = {}) =>
  ({ id, type: 'polygon', points, ...compact({ fill: o.fill, stroke: o.stroke }), ...common(o) } as Extract<Layer, { type: 'polygon' }>);

export interface ImgOptions extends Common {
  focus?: Pt;
  mask?: 'none' | 'circle' | 'rounded' | 'arch' | 'cut-left' | 'cut-right';
  radius?: number;
  scrim?: ReturnType<typeof scrim>;
  duotone?: { shadow: Color; light: Color };
  tint?: { color: Color; opacity: number };
  saturation?: number;
  border?: Stroke;
  shadow?: boolean;
  fallback?: 'brandPattern' | 'gradient' | 'none';
}

export const img = (id: string, slot: 'hero' | 'secondary', box: Box, o: ImgOptions = {}) => {
  const treatment = compact({ scrim: o.scrim, duotone: o.duotone, tint: o.tint, saturation: o.saturation });
  return ({
    id,
    type: 'image',
    slot,
    box,
    ...compact({ focus: o.focus, mask: o.mask, radius: o.radius, border: o.border, shadow: o.shadow, fallback: o.fallback }),
    ...(Object.keys(treatment).length ? { treatment } : {}),
    ...common(o),
  } as Extract<Layer, { type: 'image' }>);
};

export interface TextOptions extends Common {
  /** [max, min] as fractions of the shorter canvas side (or one number for a fixed size). */
  size: [number, number] | number;
  /** maximum number of lines (default 3) */
  lines?: number;
  family?: FontFamily;
  weight?: number;
  italic?: boolean;
  upper?: boolean;
  /** letter spacing in em (-0.05..0.3) */
  tracking?: number;
  /** line height multiplier (0.85..1.8) */
  lh?: number;
  color?: Color;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** default true except for the headline */
  optional?: boolean;
  underline?: boolean;
}

const sizeOf = (s: [number, number] | number) => (typeof s === 'number' ? { max: s, min: s } : { max: s[0], min: s[1] });

export const text = (id: string, slot: TextSlot, box: Box, o: TextOptions) =>
  ({
    id,
    type: 'text',
    slot,
    box,
    align: o.align ?? 'left',
    valign: o.valign ?? 'top',
    style: compact({ family: o.family ?? 'sans', weight: o.weight ?? 600, italic: o.italic, case: o.upper ? 'upper' : undefined, tracking: o.tracking, lineHeight: o.lh }),
    color: o.color ?? 'ink',
    size: sizeOf(o.size),
    maxLines: o.lines ?? 3,
    optional: o.optional ?? slot !== 'headline',
    ...compact({ underline: o.underline }),
    ...common(o),
  } as Extract<Layer, { type: 'text' }>);

export interface ButtonOptions extends Common {
  /** default 'accent' */
  fill?: Paint;
  /** fraction of the shorter side of the button (default 0.5 = pill) */
  radius?: number;
  stroke?: Stroke;
  /** default [0.03, 0.02] */
  size?: [number, number];
  family?: FontFamily;
  weight?: number;
  upper?: boolean;
  tracking?: number;
  /** label color (default 'onAccent'; use the matching onX for the fill you chose) */
  color?: Color;
  arrow?: boolean;
}

/** The call to action. Shows the `cta` copy; omitted when there is none. The label is fitted to the box (single line). */
export const button = (id: string, box: Box, o: ButtonOptions = {}) =>
  ({
    id,
    type: 'button',
    box,
    fill: o.fill ?? 'accent',
    radius: o.radius ?? 0.5,
    ...compact({ stroke: o.stroke }),
    style: compact({ family: o.family ?? 'sans', weight: o.weight ?? 700, case: o.upper ? 'upper' : undefined, tracking: o.tracking }),
    color: o.color ?? 'onAccent',
    size: sizeOf(o.size ?? [0.03, 0.02]),
    ...compact({ arrow: o.arrow }),
    ...common(o),
  } as Extract<Layer, { type: 'button' }>);

export interface LogoOptions extends Common {
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** a rounded chip behind the logo (padding = fraction of the shorter canvas side, radius = fraction of the chip's shorter side) */
  plate?: { fill: Color; padding: number; radius: number };
  /** the brand name's look when no logo file exists */
  nameFamily?: FontFamily;
  nameWeight?: number;
  nameColor?: Color;
  upper?: boolean;
  tracking?: number;
  nameItalic?: boolean;
}

export const logo = (id: string, box: Box, o: LogoOptions = {}) =>
  ({
    id,
    type: 'logo',
    box,
    align: o.align ?? 'left',
    valign: o.valign ?? 'middle',
    ...compact({ plate: o.plate }),
    nameStyle: compact({ family: o.nameFamily ?? 'sans', weight: o.nameWeight ?? 700, italic: o.nameItalic, case: o.upper ? 'upper' : undefined, tracking: o.tracking }),
    nameColor: o.nameColor ?? 'ink',
    ...common(o),
  } as Extract<Layer, { type: 'logo' }>);

// ---- templates -------------------------------------------------------------------------------------------------------------------------

function strict(): boolean {
  const e = process.env;
  return !!e.NODE_TEST_CONTEXT || e.NODE_ENV === 'test' || e.LAUNCHPILOT_VALIDATE_TEMPLATES === '1';
}

/**
 * Identity for a template definition that, in tests (NODE_TEST_CONTEXT / NODE_ENV=test) or with LAUNCHPILOT_VALIDATE_TEMPLATES=1,
 * validates it and THROWS with every issue, so a broken template fails loudly where it is written. Outside tests it never throws
 * (the registry and `tools/sheet.ts` report issues instead).
 */
export function defineTemplate(def: TemplateDef): TemplateDef {
  if (strict()) {
    const r = validateTemplate(def);
    if (!r.ok) throw new Error(`Invalid template "${def.id}": ${r.issues.map((i) => i.message).join('; ')}`);
  }
  return def;
}
