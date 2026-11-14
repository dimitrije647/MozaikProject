import sharp from 'sharp';
import { CREATIVE_FORMATS, MAX_UPSCALE } from '../creative/formats';
import { hexToRgb, luminanceRatio, mix, relativeLuminance, rgbLuminance, rgbToHex } from './color';
import { headOf, mapToLayer, planCrop, type CropPlan } from './crop';
import { resolvePalette, type PaletteAnchors } from './palette';
import {
  formatClassOf,
  layerFor,
  validateTemplate,
  type FormatClass,
  type Layer,
  type Paint,
  type PxRect,
  type RenderReport,
  type RenderSubject,
  type RenderTune,
  type StyleId,
  type TemplateDef,
  type TemplateRenderInput,
  type TemplateRenderResult,
  type TextSlot,
  type UnitBox,
} from './schema';
import { Defs, n2, paintColors, paintFill, patternMarkup, resolveColor, shadowMarkup, shapePath, type Rect, type Roles, type ShapeKind } from './svg';
import { capLength, fitText, hasRtl, normalizeText, textBlockSvg, type Align, type FontSpec } from './text-fit';

/**
 * The deterministic TEMPLATE RENDERER. A template (pure data) + brand colors + content + optional images -> one PNG of exactly the
 * requested size. No model, no network, no template code is ever executed: every number and color that reaches the SVG is validated
 * and every string is XML-escaped. Images are only READ (never modified) and only raster formats are accepted.
 *
 * Flags the renderer can emit (honest notes, never empty):
 *   text_shrunk:<slot>              text had to be set smaller than the template's size.max
 *   text_trimmed:<slot>             text was cut at a word boundary and ends with an ellipsis (still did not fit at size.min)
 *   text_hyphenated:<slot>          a word wider than its box was split with a hyphen (only at size.min)
 *   moved_into_safe_area:<layerId>  a text/button/logo box reached outside the safe area and was moved/shrunk back in
 *   low_contrast_adjusted:<layerId> the text color failed the contrast target against what is behind it and was replaced
 *   low_contrast_unresolved:<id>    even the best alternative stays below the contrast target (e.g. a very busy photo)
 *   image_low_resolution:<slot>     the picture is enlarged more than MAX_UPSCALE to fill its box (still rendered)
 *   hero_missing_fallback           no hero picture: the layer's fallback (brandPattern / gradient / none) was used
 *   secondary_missing_fallback      same for the secondary picture
 *   logo_missing_name_used          no logo bytes: the brand name was drawn in the logo box
 *   logo_unreadable                 the logo decoded to nothing visible (fully transparent): the brand name was used instead
 *   logo_low_resolution             the logo is enlarged to fit its box more than it should be
 *   logo_missing_no_name            neither a logo nor a brand name exists: the logo layer is omitted
 *   text_slot_empty:<slot>          a non-optional text layer had no content (not listed in `requires`): omitted
 *   image_fitted:<slot>             a flat graphic (logo banner, text on colour) was fitted whole instead of cropped (cropping would cut its letters)
 *   crop_subject_aware:<slot>       the crop was placed to keep the faces whole and the subject inside the frame
 *   button_widened:<layerId>        the call to action did not fit its button: the button was widened inside the safe area instead of cutting the text
 *   button_arrow_dropped:<layerId>  the button's arrow was left out so the whole call to action fits
 *   text_toned:<layerId>            a secondary text layer asked for transparency: it is drawn as a solid, toned colour instead (text is never see-through)
 *   text_backed:<layerId>           the preflight asked for a tight solid backing behind this text
 *   layer_hidden:<layerId>          the preflight left out a decorative layer
 *   layer_lightened:<layerId>       the preflight drew a decorative layer (or a picture's scrim) lighter
 *   layer_shrunk:<layerId>          the preflight drew a decorative layer smaller
 *   logo_enlarged                   the preflight enlarged the logo box
 *
 * TEXT IS NEVER TRANSPARENT: a template's opacity on a text layer becomes a solid colour toned towards a calm background, or full colour on a
 * picture, so letters always stay sharp and whole. To show more of a picture, decorative panels and scrims are made lighter, never the text.
 */

/** Flags that describe HOW something was drawn (not a problem): a toned secondary line, a subject-aware crop, a graphic fitted whole. */
const INFO_FLAG_PREFIXES = ['text_toned:', 'crop_subject_aware:', 'image_fitted:', 'image_zoomed:', 'logo_moved'];
export const isInfoFlag = (f: string) => INFO_FLAG_PREFIXES.some((p) => f.startsWith(p));

const MAX_TEXT_CHARS = 400;
const MAX_LAYER_PIXELS = 50_000_000;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'tiff', 'heif']);
const SHARP_IN = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const };

type L<T extends Layer['type']> = Extract<Layer, { type: T }>;
type Safe = { l: number; t: number; r: number; b: number };

class RenderError extends Error {
  constructor(
    readonly reason: 'unsupported_format' | 'missing_required' | 'image_unreadable' | 'render_failed',
    message: string,
  ) {
    super(message);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- public entry ----------------------------------------------------------------------------------------------------------------------

export async function renderTemplate(input: TemplateRenderInput): Promise<TemplateRenderResult> {
  try {
    return await renderInner(input);
  } catch (e) {
    if (e instanceof RenderError) return { ok: false, reason: e.reason, message: e.message };
    return { ok: false, reason: 'render_failed', message: `The template could not be rendered: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
}

const validatedCache = new Map<string, TemplateDef>();
/** Validates (and thereby sanitizes: unknown keys are dropped) a template. Cached by content, so editing a template object is always seen. */
function validated(t: TemplateDef): TemplateDef {
  let key: string;
  try {
    key = JSON.stringify(t);
  } catch {
    throw new RenderError('render_failed', 'The template is not valid: it cannot be serialized.');
  }
  const hit = validatedCache.get(key);
  if (hit) return hit;
  const r = validateTemplate(JSON.parse(key));
  if (!r.ok) throw new RenderError('render_failed', `The template is not valid: ${r.issues[0]?.message ?? 'unknown issue'}`);
  if (validatedCache.size >= 300) validatedCache.clear();
  validatedCache.set(key, r.template);
  return r.template;
}

/** The visual style's own ink/paper anchors, via a guarded call so a missing or broken style module never breaks rendering. */
function styleAnchors(styleId?: StyleId): PaletteAnchors {
  if (!styleId) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./styles') as typeof import('./styles');
    const c = mod.getStyle(styleId).color;
    return { ink: c.ink, paper: c.paper };
  } catch {
    return {};
  }
}

/** Safe margins: the matching CREATIVE_FORMATS entry (same size, or the same aspect ratio), else 6% on every side. */
export function safeAreaFor(width: number, height: number): Safe {
  const fmts = Object.values(CREATIVE_FORMATS);
  const exact = fmts.find((f) => f.width === width && f.height === height);
  const byRatio = exact ?? fmts.find((f) => Math.abs(f.width / f.height / (width / height) - 1) < 0.005);
  const s = byRatio?.safe ?? { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 };
  return { l: width * s.left, r: width * (1 - s.right), t: height * s.top, b: height * (1 - s.bottom) };
}

// ---- images ----------------------------------------------------------------------------------------------------------------------------

interface ImageInfo {
  buf: Buffer;
  w: number;
  h: number;
}

async function inspectImage(input: Buffer | Uint8Array | null | undefined, label: string): Promise<ImageInfo | null> {
  if (input === undefined || input === null) return null;
  const buf = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!buf || buf.length === 0) throw new RenderError('image_unreadable', `The ${label} image is empty or not a byte buffer.`);
  if (buf.length > MAX_INPUT_BYTES) throw new RenderError('image_unreadable', `The ${label} image is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  try {
    const meta = await sharp(buf, SHARP_IN).metadata();
    const okFormat = !!meta.format && ALLOWED_FORMATS.has(meta.format) && (meta.format !== 'heif' || meta.compression === 'av1');
    if (!okFormat) throw new RenderError('image_unreadable', `The ${label} image is not a supported raster picture (${meta.format ?? 'unknown'}). Use PNG, JPEG, WebP, GIF, AVIF or TIFF.`);
    if (!meta.width || !meta.height) throw new RenderError('image_unreadable', `The ${label} image has no dimensions.`);
    const swap = (meta.orientation ?? 1) >= 5;
    return { buf, w: swap ? meta.height : meta.width, h: swap ? meta.width : meta.height };
  } catch (e) {
    if (e instanceof RenderError) throw e;
    throw new RenderError('image_unreadable', `The ${label} image could not be read (${e instanceof Error ? e.message : 'decode error'}).`.slice(0, 240));
  }
}

const rawOpts = (w: number, h: number) => ({ raw: { width: w, height: h, channels: 4 as const } });

// ---- the scene -------------------------------------------------------------------------------------------------------------------------

interface Scene {
  W: number;
  H: number;
  unit: number;
  roles: Roles;
  safe: Safe;
  cls: FormatClass;
  content: Partial<Record<TextSlot, string>>;
  /** shorter approved wordings of essential text, longest first */
  alt: Partial<Record<'cta' | 'headline', string[]>>;
  brandName: string;
  hero: ImageInfo | null;
  secondary: ImageInfo | null;
  logo: ImageInfo | null;
  heroFocus?: [number, number];
  logoAdapt?: boolean;
  subject?: RenderSubject;
  tune: RenderTune;
  canvas: Buffer;
  ops: sharp.OverlayOptions[];
  defs: Defs;
  body: string[];
  dirty: boolean;
  flags: string[];
  drawn: TextSlot[];
  painted: string[];
  report: RenderReport;
  /** The hero picture as drawn (before anything was laid over it), to measure later how visible its faces and subject stay. */
  heroTrack: HeroTrack | null;
}

interface HeroTrack {
  layerId: string;
  /** top-left of the layer bitmap on the canvas (may be negative: the bitmap is clipped by the canvas) */
  x: number;
  y: number;
  bw: number;
  bh: number;
  /** the picture pixels of the layer (crop + treatment, before scrim/tint), RGBA */
  photo: Buffer;
  /** the alpha of the finished layer (mask and opacity): where the picture really shows */
  alpha: Buffer;
  /** source-fraction box -> layer bitmap pixels */
  map: (b: UnitBox) => PxRect;
  rotated: boolean;
}

/** Text that is never toned or made lighter in any way. */
const MAIN_TEXT = new Set<TextSlot>(['headline', 'offer', 'stat', 'quote', 'cta']);

/** Decorative layer types the preflight may make lighter, smaller or leave out. Text, buttons, logos and pictures are never among them. */
const DECOR_TYPES = new Set(['rect', 'ellipse', 'line', 'pattern', 'polygon']);

function rotatedBBox(r: PxRect, deg: number | undefined, center?: [number, number]): PxRect {
  if (!deg) return r;
  const [cx, cy] = center ?? [r.x + r.w / 2, r.y + r.h / 2];
  const a = (deg * Math.PI) / 180;
  const pts = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The strongest opacity a paint lays down (a gradient's most opaque stop). */
function paintAlpha(p: Paint | undefined): number {
  if (!p) return 0;
  if (typeof p === 'string') return 1;
  return Math.max(...p.gradient.stops.map((s) => s.opacity ?? 1));
}

const lumOf = (p: RGB3) => (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;

/** Standard deviation of the luminance of samples (0 = flat, ~0.3+ = very busy). */
function busyness(samples: RGB3[]): number {
  if (!samples.length) return 0;
  const ls = samples.map(lumOf);
  const m = ls.reduce((s, v) => s + v, 0) / ls.length;
  return Math.sqrt(ls.reduce((s, v) => s + (v - m) ** 2, 0) / ls.length);
}

function meanHex(samples: RGB3[]): string {
  if (!samples.length) return '#808080';
  const s = samples.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return rgbToHex(s[0] / samples.length, s[1] / samples.length, s[2] / samples.length);
}

function flag(S: Scene, f: string) {
  if (!S.flags.includes(f)) S.flags.push(f);
}

function commitSegment(S: Scene) {
  if (!S.body.length) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S.W}" height="${S.H}" viewBox="0 0 ${S.W} ${S.H}"><defs>${S.defs.take()}</defs>${S.body.join('')}</svg>`;
  S.ops.push({ input: Buffer.from(svg), left: 0, top: 0 });
  S.body = [];
}

async function flush(S: Scene) {
  commitSegment(S);
  if (S.ops.length) {
    S.canvas = await sharp(S.canvas, rawOpts(S.W, S.H)).composite(S.ops).raw().toBuffer();
    S.ops = [];
  }
  S.dirty = false;
}

/** Adds SVG markup for a layer (wrapped for opacity and rotation). `ink` layers (text) do not invalidate the sampled backdrop. */
function addVector(S: Scene, markup: string, layer: Layer, center: [number, number] | null, ink = false) {
  const attrs: string[] = [];
  if (layer.opacity !== undefined && layer.opacity < 1) attrs.push(`opacity="${n2(layer.opacity)}"`);
  if (layer.rotate && center) attrs.push(`transform="rotate(${n2(layer.rotate)} ${n2(center[0])} ${n2(center[1])})"`);
  S.body.push(attrs.length ? `<g ${attrs.join(' ')}>${markup}</g>` : markup);
  if (!ink) S.dirty = true;
}

function boxPx(S: Scene, b: readonly [number, number, number, number]): Rect {
  return { x: b[0] * S.W, y: b[1] * S.H, w: b[2] * S.W, h: b[3] * S.H };
}

/** Keeps a text/button/logo box inside the safe area; reports whether it had to move. */
function clampToSafe(S: Scene, r: Rect): { rect: Rect; moved: boolean } {
  const sw = S.safe.r - S.safe.l;
  const sh = S.safe.b - S.safe.t;
  let { x, y, w, h } = r;
  let moved = false;
  if (w > sw + 1) ((w = sw), (moved = true));
  if (h > sh + 1) ((h = sh), (moved = true));
  const nx = clamp(x, S.safe.l, Math.max(S.safe.l, S.safe.r - w));
  const ny = clamp(y, S.safe.t, Math.max(S.safe.t, S.safe.b - h));
  if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) moved = true;
  x = nx;
  y = ny;
  return { rect: { x, y, w, h }, moved };
}

// ---- contrast --------------------------------------------------------------------------------------------------------------------------

type RGB3 = [number, number, number];

/** A coarse grid of the pixels currently behind `r` (the composited canvas so far). */
function sampleBackdrop(S: Scene, r: Rect): RGB3[] {
  const x0 = clamp(Math.floor(r.x), 0, S.W - 1);
  const y0 = clamp(Math.floor(r.y), 0, S.H - 1);
  const x1 = clamp(Math.ceil(r.x + r.w), x0 + 1, S.W);
  const y1 = clamp(Math.ceil(r.y + r.h), y0 + 1, S.H);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 900)));
  const out: RGB3[] = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * S.W + x) * 4;
      out.push([S.canvas[i], S.canvas[i + 1], S.canvas[i + 2]]);
    }
  }
  return out;
}

function passStats(samples: RGB3[], fg: string, opacity: number, min: number): { frac: number; mean: number } {
  const [fr, fgc, fb] = hexToRgb(fg);
  let pass = 0;
  let sum = 0;
  for (const [r, g, b] of samples) {
    const er = r + (fr - r) * opacity;
    const eg = g + (fgc - g) * opacity;
    const eb = b + (fb - b) * opacity;
    const ratio = luminanceRatio(rgbLuminance(er, eg, eb), rgbLuminance(r, g, b));
    if (ratio >= min) pass++;
    sum += Math.log(ratio);
  }
  return { frac: samples.length ? pass / samples.length : 1, mean: samples.length ? sum / samples.length : 0 };
}

const PASS_FRACTION = 0.85;

/** Keeps `color` when it reads on what is behind it; otherwise picks the best of onInk / onPaper / white / black and says so. */
function readableColor(S: Scene, id: string, color: string, samples: RGB3[], opacity: number, sizePx: number, weight: number): string {
  const large = sizePx >= S.unit * 0.04 || (weight >= 700 && sizePx >= S.unit * 0.032);
  const min = large ? 3 : 4.5;
  const base = passStats(samples, color, opacity, min);
  if (base.frac >= PASS_FRACTION) return color;
  const cands = [...new Set([S.roles.onInk, S.roles.onPaper, '#ffffff', '#000000'])];
  let best = { color, frac: base.frac, mean: base.mean };
  for (const c of cands) {
    const s = passStats(samples, c, opacity, min);
    if (s.frac > best.frac + 1e-9 || (Math.abs(s.frac - best.frac) < 1e-9 && s.mean > best.mean + 1e-9 && c !== color)) best = { color: c, frac: s.frac, mean: s.mean };
  }
  if (best.color !== color) flag(S, `low_contrast_adjusted:${id}`);
  if (best.frac < PASS_FRACTION) flag(S, `low_contrast_unresolved:${id}`);
  return best.color;
}

const toSamples = (colors: string[]): RGB3[] => colors.map((c) => hexToRgb(c));

// ---- text ------------------------------------------------------------------------------------------------------------------------------

function fontOf(style: L<'text'>['style']): FontSpec {
  return { family: style.family, weight: style.weight, italic: !!style.italic, tracking: style.tracking ?? 0 };
}

function contentFor(S: Scene, slot: TextSlot): string {
  const v = S.content[slot];
  return typeof v === 'string' ? normalizeText(v) : '';
}

async function drawText(S: Scene, layer: L<'text'>) {
  const full = contentFor(S, layer.slot);
  if (!full) {
    if (!layer.optional) flag(S, `text_slot_empty:${layer.slot}`);
    return;
  }
  const capped = capLength(full, MAX_TEXT_CHARS);
  const raw = capped.text;
  const { rect, moved } = clampToSafe(S, boxPx(S, layer.box));
  if (moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const text = layer.style.case === 'upper' ? raw.toUpperCase() : raw;
  const font = fontOf(layer.style);
  const lineHeight = layer.style.lineHeight ?? 1.15;
  const rtl = hasRtl(text);
  const align: Align = rtl && layer.align !== 'center' ? (layer.align === 'left' ? 'right' : 'left') : layer.align;
  const maxPx = layer.size.max * S.unit;
  const fitOf = (t: string) => fitText({ text: layer.style.case === 'upper' ? t.toUpperCase() : t, font, lineHeight, boxW: rect.w, boxH: rect.h, maxPx, minPx: Math.min(layer.size.min, layer.size.max) * S.unit, maxLines: layer.maxLines, align, valign: layer.valign });
  let fit = await fitOf(raw);
  if (!fit) return;
  let drawnText = raw;
  // essential text that does not fit is replaced by the longest SHORTER APPROVED wording that fits completely, never cut with an ellipsis
  const options = layer.slot === 'cta' || layer.slot === 'headline' ? (S.alt[layer.slot] ?? []) : [];
  if ((fit.trimmed || capped.cut) && options.length) {
    for (const o of options) {
      if (o === raw) continue;
      const f = await fitOf(o);
      if (f && !f.trimmed) {
        S.report.shortened!.push({ slot: layer.slot, from: raw, to: o });
        flag(S, `text_shortened:${layer.slot}`);
        fit = f;
        drawnText = o;
        capped.cut = false;
        break;
      }
    }
  }
  if (fit.shrunk) flag(S, `text_shrunk:${layer.slot}`);
  if (fit.trimmed || capped.cut) flag(S, `text_trimmed:${layer.slot}`);
  if (fit.hyphenated) flag(S, `text_hyphenated:${layer.slot}`);

  if (S.dirty) await flush(S);
  const spec = { boxX: rect.x, boxY: rect.y, boxW: rect.w, boxH: rect.h, size: fit.size, lineHeight, align, valign: layer.valign, font, fill: '#000000', underline: layer.underline };
  const probe = textBlockSvg(fit.lines, spec).block;
  const widest = Math.max(...fit.widths, 1);
  const bx = align === 'left' ? rect.x : align === 'center' ? rect.x + (rect.w - widest) / 2 : rect.x + rect.w - widest;
  const ink: PxRect = { x: bx - fit.size * 0.1, y: probe.y - fit.size * 0.1, w: widest + fit.size * 0.2, h: probe.h + fit.size * 0.2 };
  const center: [number, number] = [rect.x + rect.w / 2, rect.y + rect.h / 2];
  const base = resolveColor(layer.color, S.roles);
  // a tight solid backing asked for by the preflight: the text keeps its full colour and opacity, only what is behind it gets calmer
  const backed = !!S.tune.textBacking?.includes(layer.id);
  if (backed) {
    const pad = fit.size * 0.38;
    const plate: PxRect = { x: ink.x - pad, y: ink.y - pad * 0.7, w: ink.w + pad * 2, h: ink.h + pad * 1.4 };
    const dark = relativeLuminance(base) > 0.4;
    const fillHex = dark ? (relativeLuminance(S.roles.ink) < 0.08 ? S.roles.ink : '#111111') : S.roles.paper;
    addVector(S, `<path d="${shapePath('rect', plate, 0.12)}" fill="${fillHex}" fill-opacity="0.8"/>`, { ...layer, opacity: undefined }, center);
    await flush(S);
    flag(S, `text_backed:${layer.id}`);
  }
  const samples = sampleBackdrop(S, ink);
  // text is never see-through: a template's opacity tones a secondary line towards a calm background as a SOLID colour; on a picture it is full colour
  let wanted = base;
  const busy = busyness(samples);
  if (layer.opacity !== undefined && layer.opacity < 1) {
    // the MAIN text (headline, offer, figure, quote) always keeps its full colour; only a secondary line may be toned, and only on a calm background
    if (busy < 0.06 && !MAIN_TEXT.has(layer.slot)) wanted = mix(base, meanHex(samples), 1 - layer.opacity);
    flag(S, `text_toned:${layer.id}`);
  }
  const color = readableColor(S, layer.id, wanted, samples, 1, fit.size, font.weight);
  const large = fit.size >= S.unit * 0.04 || (font.weight >= 700 && fit.size >= S.unit * 0.032);
  const contrastFrac = passStats(samples, color, 1, large ? 3 : 4.5).frac;
  const { svg } = textBlockSvg(fit.lines, { ...spec, fill: color });
  addVector(S, svg, { ...layer, opacity: undefined }, center, true);
  S.painted.push(layer.id);
  if (!S.drawn.includes(layer.slot)) S.drawn.push(layer.slot);
  S.report.texts.push({ layerId: layer.id, slot: layer.slot, rect: rotatedBBox(ink, layer.rotate, center), size: fit.size, contrast: Math.round(contrastFrac * 1000) / 1000, busy: Math.round(busy * 1000) / 1000, trimmed: fit.trimmed || capped.cut, backed, lum: Math.round(relativeLuminance(color) * 1000) / 1000, text: drawnText, align: layer.align });
}

async function drawButton(S: Scene, layer: L<'button'>) {
  const full = contentFor(S, 'cta');
  if (!full) return;
  const capped = capLength(full, 80);
  let cta = capped.text;
  const placed = clampToSafe(S, boxPx(S, layer.box));
  let rect = placed.rect;
  if (placed.moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const ax = S.tune.alignX?.[layer.id];
  if (ax) {
    const x = ax.mode === 'center' ? ax.x * S.W - rect.w / 2 : ax.mode === 'left' ? ax.x * S.W : ax.x * S.W - rect.w;
    rect = clampToSafe(S, { ...rect, x }).rect;
    flag(S, `aligned:${layer.id}`);
  }
  // a button box much taller than its label (a banner patch reused at billboard size) is drawn as a normal button, centred in its box:
  // a giant slab with tiny text, and side padding that grows with that height, would leave no room for the words
  const capH = layer.size.max * S.unit * 2.4;
  if (rect.h > capH * 1.05) rect = { x: rect.x, y: rect.y + (rect.h - capH) / 2, w: rect.w, h: capH };
  const font = fontOf({ ...layer.style });
  let text = layer.style.case === 'upper' ? cta.toUpperCase() : cta;
  const padX = Math.min(rect.h * 0.42, layer.size.max * S.unit * 1.1);
  const maxPx = Math.min(layer.size.max * S.unit, rect.h * 0.48);
  const minPx = Math.min(layer.size.min * S.unit, maxPx);
  // the arrow is a drawn glyph (font independent): its width is reserved before the label is fitted
  const arrowGap = (size: number) => size * 0.7;
  const arrowW = (size: number) => size * 0.95;
  let arrow = layer.arrow === true;
  const fitIn = (r: Rect, withArrow: boolean) => fitText({ text, font, lineHeight: 1.1, boxW: Math.max(8, r.w - padX * 2 - (withArrow ? arrowGap(maxPx) + arrowW(maxPx) : 0)), boxH: r.h * 0.92, maxPx, minPx, maxLines: 1, align: 'left', valign: 'middle' });
  let fit = await fitIn(rect, arrow);
  if (!fit) return;
  // a call to action is never cut ("Explore the…"): the button grows inside the safe area first, then it gives up its arrow
  let widened = false;
  let arrowDropped = false;
  if (fit.trimmed) {
    const natural = await fitText({ text, font, lineHeight: 1.1, boxW: S.safe.r - S.safe.l, boxH: rect.h * 0.92, maxPx: minPx, minPx, maxLines: 1, align: 'left', valign: 'middle' });
    const need = natural ? Math.max(...natural.widths, 1) * 1.04 + padX * 2 + (arrow ? arrowGap(minPx) + arrowW(minPx) : 0) : rect.w;
    if (need > rect.w) {
      // it grows only into FREE space: to the right, to the left or both ways, never over text or the logo that is already drawn
      const w = Math.min(need, S.safe.r - S.safe.l);
      const taken = [...S.report.texts.map((t) => t.rect), ...(S.report.logo ? [S.report.logo.rect] : [])];
      const hits = (c: Rect) => taken.some((t) => Math.max(0, Math.min(c.x + c.w, t.x + t.w) - Math.max(c.x, t.x)) * Math.max(0, Math.min(c.y + c.h, t.y + t.h) - Math.max(c.y, t.y)) > 1);
      // a button that sits on the canvas axis (a centred layout) grows evenly to both sides first, so it stays on the axis of its group
      const centred = Math.abs(rect.x + rect.w / 2 - S.W / 2) < S.W * 0.03;
      const xs = centred ? [rect.x - (w - rect.w) / 2, rect.x, rect.x - (w - rect.w)] : [rect.x, rect.x - (w - rect.w), rect.x - (w - rect.w) / 2];
      const options = xs.map((x) => clampToSafe(S, { x, y: rect.y, w, h: rect.h }).rect);
      const free = options.find((c) => !hits(c));
      if (free) {
        rect = free;
        widened = true;
        flag(S, `button_widened:${layer.id}`);
        fit = (await fitIn(rect, arrow)) ?? fit;
      }
    }
    if (fit.trimmed && arrow) {
      arrow = false;
      arrowDropped = true;
      flag(S, `button_arrow_dropped:${layer.id}`);
      fit = (await fitIn(rect, false)) ?? fit;
    }
  }
  // still too long: the longest SHORTER APPROVED call to action that fits completely (never "Start the free Management and Risk Chec…")
  if ((fit.trimmed || capped.cut) && S.alt.cta?.length) {
    for (const o of S.alt.cta) {
      if (o === cta) continue;
      const t = layer.style.case === 'upper' ? o.toUpperCase() : o;
      const f = await fitText({ text: t, font, lineHeight: 1.1, boxW: Math.max(8, rect.w - padX * 2 - (arrow ? arrowGap(maxPx) + arrowW(maxPx) : 0)), boxH: rect.h * 0.92, maxPx, minPx, maxLines: 1, align: 'left', valign: 'middle' });
      if (f && !f.trimmed) {
        S.report.shortened!.push({ slot: 'cta', from: cta, to: o });
        flag(S, 'text_shortened:cta');
        fit = f;
        text = t;
        cta = o;
        capped.cut = false;
        break;
      }
    }
  }
  if (capped.cut) flag(S, 'text_trimmed:cta');
  if (fit.shrunk) flag(S, `text_shrunk:cta`);
  if (fit.trimmed) flag(S, `text_trimmed:cta`);
  const sw = layer.stroke ? Math.max(1, layer.stroke.width * S.unit) : 0;
  const inner: Rect = { x: rect.x + sw / 2, y: rect.y + sw / 2, w: Math.max(2, rect.w - sw), h: Math.max(2, rect.h - sw) };
  const rad = layer.radius;
  const fill = paintFill(layer.fill, rect, S.roles, S.defs);
  const strokeAttr = layer.stroke ? ` stroke="${resolveColor(layer.stroke.color, S.roles)}" stroke-width="${n2(sw)}"` : '';
  let markup = `<path d="${shapePath('rect', inner, rad)}" fill="${fill}"${strokeAttr}/>`;
  const textW = Math.max(...fit.widths, 1);
  const extra = arrow ? arrowGap(fit.size) + arrowW(fit.size) : 0;
  const x0 = rect.x + (rect.w - (textW + extra)) / 2;
  const colors = paintColors(layer.fill, S.roles);
  const color = readableColor(S, layer.id, resolveColor(layer.color, S.roles), toSamples(colors), 1, fit.size, font.weight);
  const { svg } = textBlockSvg(fit.lines, { boxX: x0, boxY: rect.y, boxW: textW + 2, boxH: rect.h, size: fit.size, lineHeight: 1.1, align: 'left', valign: 'middle', font, fill: color });
  markup += svg;
  if (arrow) {
    const aw = arrowW(fit.size);
    const ax = x0 + textW + arrowGap(fit.size);
    const cy = rect.y + rect.h / 2;
    const t = Math.max(1.5, fit.size * 0.11);
    markup += `<path d="M${n2(ax)} ${n2(cy)}H${n2(ax + aw)}M${n2(ax + aw * 0.6)} ${n2(cy - aw * 0.32)}L${n2(ax + aw)} ${n2(cy)}L${n2(ax + aw * 0.6)} ${n2(cy + aw * 0.32)}" fill="none" stroke="${color}" stroke-width="${n2(t)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  addVector(S, markup, layer, [rect.x + rect.w / 2, rect.y + rect.h / 2], true);
  S.painted.push(layer.id);
  if (!S.drawn.includes('cta')) S.drawn.push('cta');
  S.report.buttons.push({ layerId: layer.id, rect: rotatedBBox(rect, layer.rotate), trimmed: fit.trimmed || capped.cut, widened, arrowDropped, text: cta });
}

// ---- images ----------------------------------------------------------------------------------------------------------------------------

/** The mean colour of a picture's border (the letterbox of a fitted graphic continues it). */
async function borderColour(info: ImageInfo): Promise<{ r: number; g: number; b: number }> {
  const { data, info: i } = await sharp(info.buf, SHARP_IN).rotate().flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < i.height; y++) {
    for (let x = 0; x < i.width; x++) {
      if (x > 1 && y > 1 && x < i.width - 2 && y < i.height - 2) continue;
      const k = (y * i.width + x) * 3;
      r += data[k];
      g += data[k + 1];
      b += data[k + 2];
      n++;
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

async function coverCrop(info: ImageInfo, bw: number, bh: number, plan: CropPlan, treatment: L<'image'>['treatment'], S: Scene, slot: string, roles: Roles): Promise<Buffer> {
  const { sw, sh, left, top } = plan;
  const scale = sw / info.w;
  if (scale > MAX_UPSCALE) flag(S, `image_low_resolution:${slot}`);
  try {
    let p =
      plan.fit === 'contain'
        ? sharp(await sharp(info.buf, SHARP_IN).rotate().flatten({ background: await borderColour(info) }).resize(sw, sh, { fit: 'fill' }).toBuffer()).extend({ left, top, right: bw - sw - left, bottom: bh - sh - top, background: await borderColour(info) })
        : sharp(info.buf, SHARP_IN).rotate().resize(sw, sh, { fit: 'fill' }).extract({ left, top, width: bw, height: bh });
    if (treatment?.saturation !== undefined && treatment.saturation !== 1) p = p.modulate({ saturation: treatment.saturation });
    const out = await p.toColourspace('srgb').ensureAlpha().raw().toBuffer();
    if (treatment?.duotone) {
      // luminance -> a ramp from the shadow color to the light color
      const [sr, sg, sb] = hexToRgb(resolveColor(treatment.duotone.shadow, roles));
      const [lr, lg, lb] = hexToRgb(resolveColor(treatment.duotone.light, roles));
      for (let i = 0; i < out.length; i += 4) {
        const t = (0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]) / 255;
        out[i] = sr + (lr - sr) * t;
        out[i + 1] = sg + (lg - sg) * t;
        out[i + 2] = sb + (lb - sb) * t;
      }
    }
    return out;
  } catch (e) {
    throw new RenderError('image_unreadable', `The ${slot} image could not be decoded (${e instanceof Error ? e.message : 'decode error'}).`.slice(0, 240));
  }
}

/** What fills an image box when no picture exists. */
async function fallbackArt(kind: 'brandPattern' | 'gradient', bw: number, bh: number, S: Scene): Promise<Buffer> {
  const defs = new Defs();
  const { primary, ink, onPrimary } = S.roles;
  const dark = mix(primary, ink, 0.55);
  const g = defs.id('g');
  defs.add(`<linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${primary}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`);
  let body = `<rect width="${bw}" height="${bh}" fill="url(#${g})"/>`;
  if (kind === 'brandPattern') {
    const cell = Math.max(10, Math.min(bw, bh) * 0.05);
    body += `<g opacity="0.16">${patternMarkup('dots', { x: 0, y: 0, w: bw, h: bh }, onPrimary, cell, defs)}</g>`;
    const r = defs.id('r');
    defs.add(`<radialGradient id="${r}" cx="0.75" cy="0.2" r="0.7"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`);
    body += `<rect width="${bw}" height="${bh}" fill="url(#${r})"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}"><defs>${defs.take()}</defs>${body}</svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}

const svgDoc = (w: number, h: number, inner: string, defs = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${inner}</svg>`);

function shapeKindOf(mask: L<'image'>['mask']): ShapeKind {
  return mask === 'circle' || mask === 'arch' || mask === 'cut-left' || mask === 'cut-right' ? mask : 'rect';
}

/** Places a finished RGBA picture on the canvas, rotated and clipped to the canvas bounds. */
async function placeRgba(S: Scene, rgba: Buffer, bw: number, bh: number, x: number, y: number, rotate: number | undefined) {
  let data = rgba;
  let w = bw;
  let h = bh;
  let left = Math.round(x);
  let top = Math.round(y);
  if (rotate) {
    const r = await sharp(data, rawOpts(w, h)).rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    left = Math.round(x + bw / 2 - r.info.width / 2);
    top = Math.round(y + bh / 2 - r.info.height / 2);
    data = r.data;
    w = r.info.width;
    h = r.info.height;
  }
  const cl = Math.max(0, left);
  const ct = Math.max(0, top);
  const cr = Math.min(S.W, left + w);
  const cb = Math.min(S.H, top + h);
  if (cr <= cl || cb <= ct) return;
  if (cl !== left || ct !== top || cr !== left + w || cb !== top + h) {
    const cropped = await sharp(data, rawOpts(w, h)).extract({ left: cl - left, top: ct - top, width: cr - cl, height: cb - ct }).raw().toBuffer();
    commitSegment(S);
    S.ops.push({ input: cropped, raw: { width: cr - cl, height: cb - ct, channels: 4 }, left: cl, top: ct });
  } else {
    commitSegment(S);
    S.ops.push({ input: data, raw: { width: w, height: h, channels: 4 }, left: cl, top: ct });
  }
  S.dirty = true;
}

async function drawImage(S: Scene, layer: L<'image'>) {
  const r = boxPx(S, layer.box);
  const bw = Math.round(r.w);
  const bh = Math.round(r.h);
  if (bw < 2 || bh < 2) return;
  if (bw * bh > MAX_LAYER_PIXELS) throw new RenderError('render_failed', `The picture layer "${layer.id}" is ${bw}x${bh}px, more than ${MAX_LAYER_PIXELS / 1e6} megapixels.`);
  const info = layer.slot === 'hero' ? S.hero : S.secondary;
  let rgba: Buffer;
  let photo = true;
  let plan: CropPlan | null = null;
  const tracked = layer.slot === 'hero' && !S.heroTrack && !!info;
  if (info) {
    const focus: [number, number] = layer.slot === 'hero' && S.heroFocus ? S.heroFocus : (layer.focus ?? [0.5, 0.5]);
    plan = planCrop({ imgW: info.w, imgH: info.h, bw, bh, focus: [clamp(focus[0], 0, 1), clamp(focus[1], 0, 1)], layerRect: r, canvasW: S.W, canvasH: S.H, subject: layer.slot === 'hero' ? S.subject : undefined, avoid: S.tune.avoid, fit: layer.fit });
    if (plan.fit === 'contain') flag(S, `image_fitted:${layer.slot}`);
    if (plan.zoom > 1) flag(S, `image_zoomed:${layer.slot}`);
    if (plan.fit === 'cover' && plan.subjectAware) flag(S, `crop_subject_aware:${layer.slot}`);
    rgba = await coverCrop(info, bw, bh, plan, layer.treatment, S, layer.slot, S.roles);
  } else {
    flag(S, layer.slot === 'hero' ? 'hero_missing_fallback' : 'secondary_missing_fallback');
    if (!layer.fallback || layer.fallback === 'none') return;
    photo = false;
    rgba = await fallbackArt(layer.fallback, bw, bh, S);
    // the area shows a pattern or gradient INSTEAD of a picture: reported so the preflight can tell a placeholder from a design element
    S.report.decor.push({ layerId: `${layer.id}:placeholder`, type: 'placeholder', rect: { x: r.x, y: r.y, w: bw, h: bh }, opacity: 1, area: Math.round(((bw * bh) / (S.W * S.H)) * 1000) / 1000, afterHero: !!S.heroTrack, lum: null });
  }

  const rect: Rect = { x: 0, y: 0, w: bw, h: bh };
  const kind = shapeKindOf(layer.mask);
  const rad = layer.mask === 'rounded' ? (layer.radius ?? 0.06) : (layer.radius ?? 0);
  const path = shapePath(layer.mask === 'rounded' ? 'rect' : kind, rect, rad);
  const t = layer.treatment;
  const defs = new Defs();
  let overlay = '';
  const photoPixels = tracked ? Buffer.from(rgba) : null;
  // the preflight may ask for a lighter scrim or tint so the people in the picture stay visible (the text above keeps its full colour)
  const tintK = clamp(S.tune.layerOpacity?.[`${layer.id}:tint`] ?? 1, 0, 1);
  const scrimK = clamp(S.tune.layerOpacity?.[`${layer.id}:scrim`] ?? 1, 0, 1);
  if (tintK < 1 && t?.tint) flag(S, `layer_lightened:${layer.id}:tint`);
  if (scrimK < 1 && t?.scrim) flag(S, `layer_lightened:${layer.id}:scrim`);
  if (photo && t?.tint) overlay += `<rect width="${bw}" height="${bh}" fill="${resolveColor(t.tint.color, S.roles)}" fill-opacity="${n2(t.tint.opacity * tintK)}"/>`;
  if (t?.scrim) {
    const gid = defs.id('s');
    const a = (t.scrim.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const len = Math.abs(bw * dx) + Math.abs(bh * dy);
    defs.add(
      `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n2(bw / 2 - (dx * len) / 2)}" y1="${n2(bh / 2 - (dy * len) / 2)}" x2="${n2(bw / 2 + (dx * len) / 2)}" y2="${n2(bh / 2 + (dy * len) / 2)}"><stop offset="0" stop-color="${resolveColor(t.scrim.from, S.roles)}" stop-opacity="${n2(t.scrim.fromOpacity * scrimK)}"/><stop offset="1" stop-color="${resolveColor(t.scrim.to, S.roles)}" stop-opacity="${n2(t.scrim.toOpacity * scrimK)}"/></linearGradient>`,
    );
    overlay += `<rect width="${bw}" height="${bh}" fill="url(#${gid})"/>`;
    if (photo) S.report.decor.push({ layerId: `${layer.id}:scrim`, type: 'scrim', rect: { x: r.x, y: r.y, w: bw, h: bh }, opacity: Math.max(t.scrim.fromOpacity, t.scrim.toOpacity) * scrimK, area: (bw * bh) / (S.W * S.H), afterHero: true, lum: relativeLuminance(resolveColor(t.scrim.from, S.roles)) });
  }
  if (photo && t?.tint) S.report.decor.push({ layerId: `${layer.id}:tint`, type: 'tint', rect: { x: r.x, y: r.y, w: bw, h: bh }, opacity: t.tint.opacity * tintK, area: (bw * bh) / (S.W * S.H), afterHero: true, lum: relativeLuminance(resolveColor(t.tint.color, S.roles)) });
  const comps: sharp.OverlayOptions[] = [];
  if (overlay) comps.push({ input: svgDoc(bw, bh, overlay, defs.take()), left: 0, top: 0 });
  const masked = layer.mask && layer.mask !== 'none';
  if (masked) comps.push({ input: svgDoc(bw, bh, `<path d="${path}" fill="#ffffff"/>`), left: 0, top: 0, blend: 'dest-in' });
  if (layer.border && layer.border.width > 0) {
    const sw = Math.max(1, layer.border.width * S.unit);
    const inset: Rect = { x: sw / 2, y: sw / 2, w: bw - sw, h: bh - sw };
    comps.push({ input: svgDoc(bw, bh, `<path d="${shapePath(layer.mask === 'rounded' ? 'rect' : kind, inset, rad)}" fill="none" stroke="${resolveColor(layer.border.color, S.roles)}" stroke-width="${n2(sw)}"/>`), left: 0, top: 0 });
  }
  if (layer.opacity !== undefined && layer.opacity < 1) comps.push({ input: svgDoc(bw, bh, `<rect width="${bw}" height="${bh}" fill="#fff" fill-opacity="${n2(layer.opacity)}"/>`), left: 0, top: 0, blend: 'dest-in' });
  if (comps.length) rgba = await sharp(rgba, rawOpts(bw, bh)).composite(comps).ensureAlpha().raw().toBuffer();

  if (layer.shadow) {
    const sp = shapePath(layer.mask === 'rounded' ? 'rect' : kind, r, rad);
    addVector(S, shadowMarkup(sp, r, S.unit, S.defs), { ...layer, opacity: undefined }, [r.x + r.w / 2, r.y + r.h / 2]);
  }
  await placeRgba(S, rgba, bw, bh, r.x, r.y, layer.rotate);
  S.painted.push(layer.id);
  if (tracked && plan && photoPixels && info) {
    const alpha = Buffer.alloc(bw * bh);
    for (let i = 0; i < bw * bh; i++) alpha[i] = rgba[i * 4 + 3];
    const p = plan;
    // source fractions -> pixels of the layer bitmap (cover: minus the crop offset; contain: plus the letterbox offset)
    const map = (b: UnitBox): PxRect => mapToLayer(p, b);
    S.heroTrack = { layerId: layer.id, x: Math.round(r.x), y: Math.round(r.y), bw, bh, photo: photoPixels, alpha, map, rotated: !!layer.rotate };
    S.report.hero = { layerId: layer.id, rect: { x: r.x, y: r.y, w: bw, h: bh }, fit: p.fit, zoom: p.zoom, graphic: !!S.subject?.graphic, rotated: !!layer.rotate, cropLoss: Math.round(p.cropLoss * 1000) / 1000, subjectInFrame: 1, subjectShare: 0, subjectVisibility: null, pictureVisibility: null, faces: [] };
  }
}

/**
 * How visible the hero picture's faces and subject stayed in the FINISHED canvas: every sampled pixel is compared with the picture as it was
 * drawn (crop and treatment, before any scrim, tint, panel, band or text was laid over it). 1 = untouched, 0 = completely covered or changed.
 */
function measureHero(S: Scene) {
  const T = S.heroTrack;
  const rep = S.report.hero;
  if (!T || !rep) return;
  const sim = (lx: number, ly: number): number | null => {
    if (lx < 0 || ly < 0 || lx >= T.bw || ly >= T.bh) return null;
    if (T.alpha[ly * T.bw + lx] < 128) return null;
    const cx = T.x + lx;
    const cy = T.y + ly;
    if (cx < 0 || cy < 0 || cx >= S.W || cy >= S.H) return null;
    if (T.rotated) return 1;
    const i = (cy * S.W + cx) * 4;
    const j = (ly * T.bw + lx) * 4;
    const d = Math.sqrt((S.canvas[i] - T.photo[j]) ** 2 + (S.canvas[i + 1] - T.photo[j + 1]) ** 2 + (S.canvas[i + 2] - T.photo[j + 2]) ** 2) / 441.7;
    return clamp(1 - d / 0.45, 0, 1);
  };
  /** samples a layer-pixel rect: the share of it that is visible at all, and how unchanged the visible part is */
  const probe = (r: PxRect, target = 400): { inFrame: number; visibility: number | null } => {
    const step = Math.max(1, Math.sqrt((r.w * r.h) / target));
    let total = 0;
    let seen = 0;
    let sum = 0;
    for (let y = r.y + step / 2; y < r.y + r.h; y += step) {
      for (let x = r.x + step / 2; x < r.x + r.w; x += step) {
        total++;
        const s = sim(Math.floor(x), Math.floor(y));
        if (s === null) continue;
        seen++;
        sum += s;
      }
    }
    return { inFrame: total ? seen / total : 0, visibility: seen ? sum / seen : null };
  };
  const rd = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  const toCanvas = (r: PxRect): PxRect => ({ x: T.x + r.x, y: T.y + r.y, w: r.w, h: r.h });
  if (S.subject) {
    for (const f of S.subject.faces) {
      const lr = T.map(f);
      const m = probe(lr, 200);
      rep.faces.push({ rect: toCanvas(lr), area: lr.w * lr.h, inFrame: rd(m.inFrame)!, visibility: T.rotated ? null : rd(m.visibility) });
    }
    const sr = T.map(S.subject.subject);
    const sm = probe(sr, 900);
    rep.subjectInFrame = rd(sm.inFrame)!;
    rep.subjectShare = rd((sm.inFrame * sr.w * sr.h) / (S.W * S.H))!;
    rep.subjectVisibility = T.rotated ? null : rd(sm.visibility);
  }
  const whole = probe({ x: 0, y: 0, w: T.bw, h: T.bh }, 1600);
  rep.pictureVisibility = T.rotated ? null : rd(whole.visibility);
}

// ---- logo ------------------------------------------------------------------------------------------------------------------------------

/** Decodes a logo, crops its transparent margins and returns RGBA (largest side <= 1024). Null when it cannot be read. */
async function prepareLogo(info: ImageInfo): Promise<{ data: Buffer; w: number; h: number } | null> {
  try {
    const { data, info: i } = await sharp(info.buf, SHARP_IN).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = i.width;
    let minY = i.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < i.height; y++) {
      for (let x = 0; x < i.width; x++) {
        if (data[(y * i.width + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    if (minX === 0 && minY === 0 && maxX === i.width - 1 && maxY === i.height - 1) return { data, w: i.width, h: i.height };
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const cropped = await sharp(data, rawOpts(i.width, i.height)).extract({ left: minX, top: minY, width: w, height: h }).raw().toBuffer();
    return { data: cropped, w, h };
  } catch {
    return null;
  }
}

/** Relative luminance (0..1) of one sRGB color. */
const lum3 = (c: [number, number, number]): number => {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};

/**
 * A SINGLE-COLOUR logo (a white, black or one-colour wordmark on transparency): nearly all of its visible pixels share one tone and carry no
 * colour. Such a logo can take the light or the dark brand tone without changing the mark; a multi-colour logo is never recoloured.
 */
export function monochromeLogo(data: Buffer, w: number, h: number): boolean {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 6000)));
  const lums: number[] = [];
  let transparent = 0;
  let total = 0;
  let colourful = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      total++;
      if (data[i + 3] < 128) {
        transparent++;
        continue;
      }
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.16) colourful++;
      lums.push(lum3([r, g, b]));
    }
  }
  // a logo without transparency is a picture of a logo (with its own background): never recoloured
  if (!lums.length || transparent / Math.max(1, total) < 0.05) return false;
  lums.sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)];
  const near = lums.filter((l) => Math.abs(l - median) <= 0.12).length;
  return colourful / lums.length < 0.08 && near / lums.length >= 0.9;
}

/** The logo's visible pixels in one colour (its alpha, i.e. its shape and antialiasing, unchanged). */
function tintRgba(rgba: Buffer, hex: string): Buffer {
  const [r, g, b] = hexToRgb(hex);
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return out;
}

/** Mean luminance of the visible pixels of a logo (alpha-weighted, sampled). */
function logoLuminance(data: Buffer, w: number, h: number): number {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
  let sum = 0;
  let weight = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.1) continue;
      sum += a * lum3([data[i], data[i + 1], data[i + 2]]);
      weight += a;
    }
  }
  return weight ? sum / weight : 0.5;
}

/**
 * The business NAME beside its logo mark (print: a shield or a symbol alone does not say who is advertising). To the right of a left/centre mark,
 * to the left of a right-aligned one, else under it; never over text that is already drawn; readable or not drawn at all (flagged).
 */
async function drawBrandBeside(S: Scene, layer: L<'logo'>, mark: PxRect) {
  const name = normalizeText(S.brandName);
  if (!name) return;
  const font = fontOf({ ...layer.nameStyle, weight: Math.max(600, layer.nameStyle.weight ?? 700) } as typeof layer.nameStyle);
  const text = layer.nameStyle.case === 'upper' ? name.toUpperCase() : name;
  const size = clamp(mark.h * 0.5, S.unit * 0.026, S.unit * 0.07);
  const gap = size * 0.5;
  const taken = [...S.report.texts.map((t) => t.rect), ...S.report.buttons.map((b) => b.rect)];
  const free = (r: Rect) => r.x >= S.safe.l - 1 && r.x + r.w <= S.safe.r + 1 && r.y >= S.safe.t - 1 && r.y + r.h <= S.safe.b + 1 && !taken.some((t) => Math.max(0, Math.min(r.x + r.w, t.x + t.w) - Math.max(r.x, t.x)) * Math.max(0, Math.min(r.y + r.h, t.y + t.h) - Math.max(r.y, t.y)) > 1);
  const tries: { box: Rect; align: Align }[] = [];
  const h = size * 1.3;
  if (layer.align !== 'right') tries.push({ box: { x: mark.x + mark.w + gap, y: mark.y + mark.h / 2 - h / 2, w: S.safe.r - (mark.x + mark.w + gap), h }, align: 'left' });
  if (layer.align !== 'left') tries.push({ box: { x: S.safe.l, y: mark.y + mark.h / 2 - h / 2, w: mark.x - gap - S.safe.l, h }, align: 'right' });
  tries.push({ box: { x: S.safe.l, y: mark.y + mark.h + gap * 0.6, w: S.safe.r - S.safe.l, h }, align: layer.align === 'center' ? 'center' : layer.align });
  for (const t of tries) {
    if (t.box.w < size * 3) continue;
    const fit = await fitText({ text, font, lineHeight: 1.15, boxW: t.box.w, boxH: t.box.h, maxPx: size, minPx: S.unit * 0.022, maxLines: 1, align: t.align, valign: 'middle' });
    if (!fit || fit.trimmed) continue;
    const tw = Math.max(...fit.widths, 1);
    const x = t.align === 'left' ? t.box.x : t.align === 'right' ? t.box.x + t.box.w - tw : t.box.x + (t.box.w - tw) / 2;
    const ink: Rect = { x, y: t.box.y, w: tw, h: t.box.h };
    if (!free(ink)) continue;
    if (S.dirty) await flush(S);
    const samples = sampleBackdrop(S, ink);
    const color = readableColor(S, `${layer.id}:name`, resolveColor(layer.nameColor, S.roles), samples, 1, fit.size, font.weight);
    const { svg } = textBlockSvg(fit.lines, { boxX: x, boxY: t.box.y, boxW: tw + 2, boxH: t.box.h, size: fit.size, lineHeight: 1.15, align: 'left', valign: 'middle', font, fill: color });
    addVector(S, svg, { ...layer, opacity: undefined, rotate: undefined } as unknown as L<'logo'>, [x + tw / 2, t.box.y + t.box.h / 2], true);
    if (S.report.logo) S.report.logo.name = true;
    S.report.texts.push({ layerId: `${layer.id}:name`, slot: 'brand', rect: ink, size: fit.size, contrast: 1, busy: 0, trimmed: false, backed: false, lum: Math.round(relativeLuminance(color) * 1000) / 1000, text: name, align: t.align });
    flag(S, 'brand_name_added');
    return;
  }
  flag(S, 'brand_name_no_room');
}

async function drawLogo(S: Scene, layer: L<'logo'>) {
  let box = boxPx(S, layer.box);
  const k0 = clamp(S.tune.logoScale ?? 1, 1, 3);
  if (k0 > 1) {
    // enlarged around its own anchor (a top-left logo grows to the right and down), then kept inside the safe area
    const w = box.w * k0;
    const h = box.h * k0;
    box = { x: layer.align === 'left' ? box.x : layer.align === 'center' ? box.x - (w - box.w) / 2 : box.x - (w - box.w), y: layer.valign === 'top' ? box.y : layer.valign === 'middle' ? box.y - (h - box.h) / 2 : box.y - (h - box.h), w, h };
    flag(S, 'logo_enlarged');
  }
  const placed = clampToSafe(S, box);
  let rect = placed.rect;
  if (placed.moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const adapt = S.logoAdapt || S.tune.logoPlate === true;
  const pad = layer.plate ? layer.plate.padding * S.unit : 0;
  const innerW = Math.max(4, rect.w - pad * 2);
  const innerH = Math.max(4, rect.h - pad * 2);
  let al = layer.align;
  let va = layer.valign;
  const placeIn = (r: Rect, a: typeof al, v: typeof va, gw: number, gh: number) => ({
    x: a === 'left' ? r.x : a === 'center' ? r.x + (r.w - gw) / 2 : r.x + r.w - gw,
    y: v === 'top' ? r.y : v === 'middle' ? r.y + (r.h - gh) / 2 : r.y + r.h - gh,
  });
  const place = (gw: number, gh: number) => placeIn(rect, al, va, gw, gh);
  const plateMarkup = (g: Rect) => {
    if (!layer.plate) return '';
    return `<path d="${shapePath('rect', g, layer.plate.radius)}" fill="${resolveColor(layer.plate.fill, S.roles)}"/>`;
  };

  const logo = S.logo ? await prepareLogo(S.logo) : null;
  if (S.logo && !logo) flag(S, 'logo_unreadable');
  if (logo) {
    let k = Math.min(innerW / logo.w, innerH / logo.h);
    if (k > MAX_UPSCALE) {
      k = MAX_UPSCALE;
      flag(S, 'logo_low_resolution');
    }
    let lw = Math.max(1, Math.round(logo.w * k));
    let lh = Math.max(1, Math.round(logo.h * k));
    // the APPROVED logo must read: a mark that would vanish into what is behind it gets a quiet plate (never stretched: the size only shrinks)
    let adaptFill: string | null = null;
    let adaptPad = 0;
    if (S.dirty) await flush(S);
    const lg = logoLuminance(logo.data, logo.w, logo.h);
    // LOGO-AWARE PLACEMENT: where the approved logo would vanish against what is behind it, or would sit on text, a face or a region the
    // preflight asked to keep free, the template's own mirrored corners are tried before a plate is drawn (a plate is the last resort)
    if ((adapt || S.tune.logoAvoid?.length) && !layer.plate && !layer.rotate) {
      const T = S.heroTrack;
      const faces = T && S.subject ? S.subject.faces.map((f) => T.map(headOf(f))).map((r) => ({ x: T.x + r.x, y: T.y + r.y, w: r.w, h: r.h })) : [];
      const obstacles: Rect[] = [...S.report.texts.map((t) => t.rect), ...S.report.buttons.map((b) => b.rect), ...faces, ...(S.tune.logoAvoid ?? []).map((a) => ({ x: a[0] * S.W, y: a[1] * S.H, w: a[2] * S.W, h: a[3] * S.H }))];
      const flipA = (a: typeof al): typeof al => (a === 'left' ? 'right' : a === 'right' ? 'left' : a);
      const flipV = (v: typeof va): typeof va => (v === 'top' ? 'bottom' : v === 'bottom' ? 'top' : v);
      const spots = [
        { r: rect, a: al, v: va },
        { r: { ...rect, x: S.W - rect.x - rect.w }, a: flipA(al), v: va },
        { r: { ...rect, y: S.H - rect.y - rect.h }, a: al, v: flipV(va) },
        { r: { ...rect, x: S.W - rect.x - rect.w, y: S.H - rect.y - rect.h }, a: flipA(al), v: flipV(va) },
      ].map((sp) => ({ ...sp, r: clampToSafe(S, sp.r).rect }));
      const judge = (sp: (typeof spots)[number]) => {
        const at = placeIn(sp.r, sp.a, sp.v, lw, lh);
        const mark = { x: at.x, y: at.y, w: lw, h: lh };
        const hit = obstacles.some((o) => Math.max(0, Math.min(o.x + o.w, mark.x + mark.w) - Math.max(o.x, mark.x)) * Math.max(0, Math.min(o.y + o.h, mark.y + mark.h) - Math.max(o.y, mark.y)) > 4);
        const back = sampleBackdrop(S, mark);
        const bl = back.length ? back.reduce((sum, p) => sum + lum3(p), 0) / back.length : 0.5;
        return { sp, hit, contrast: luminanceRatio(lg, bl) };
      };
      const judged = spots.map(judge);
      const pick = judged.find((j) => !j.hit && j.contrast >= 2.2) ?? judged.find((j) => !j.hit) ?? judged[0];
      if (pick !== judged[0]) {
        rect = pick.sp.r;
        al = pick.sp.a;
        va = pick.sp.v;
        flag(S, 'logo_moved');
      }
    }
    const at0 = place(lw, lh);
    const back0 = sampleBackdrop(S, { x: at0.x, y: at0.y, w: lw, h: lh });
    const bl0 = back0.length ? back0.reduce((sum, p) => sum + lum3(p), 0) / back0.length : 0.5;
    // a dark plate uses the brand's own dark surface (a quiet brand badge, not a black UI chip)
    const darkPlate = relativeLuminance(S.roles.ink) < 0.06 ? S.roles.ink : '#101010';
    let plateFill = layer.plate ? resolveColor(layer.plate.fill, S.roles) : null;
    let logoContrast = plateFill ? luminanceRatio(lg, relativeLuminance(plateFill)) : luminanceRatio(lg, bl0);
    /**
     * LOGO TREATMENT, in a fixed order (a box behind the logo is the LAST resort, never the default):
     *   1. the logo as it is, directly on the creative (where it reads, the template's own plate is left out when that plate would hide it)
     *   2. a single-colour logo (a white or a black wordmark) is recoloured to the light or dark brand tone that reads on what is behind it
     *   3. only then a plate: the template's own plate with the recoloured logo, else a discreet, softly rounded, slightly see-through plate
     */
    let plate = layer.plate ?? null;
    let plateOverride: string | null = null;
    let tint: string | null = null;
    let treatment: 'direct' | 'template_plate' | 'recoloured' | 'plate_recoloured' | 'plate_added' = plate ? 'template_plate' : 'direct';
    const mono = adapt ? monochromeLogo(logo.data, logo.w, logo.h) : false;
    const tones = [...new Set([S.roles.ink, '#ffffff', darkPlate, S.roles.paper].filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)))];
    const bestTone = (bgLum: number) => tones.map((c) => ({ c, k: luminanceRatio(relativeLuminance(c), bgLum) })).sort((a, b) => b.k - a.k)[0];
    if (adapt && plateFill && logoContrast < 2.2) {
      const onBack = luminanceRatio(lg, bl0);
      const toneBack = mono ? bestTone(bl0) : null;
      if (onBack >= 3 || (onBack >= 2.2 && !(toneBack && toneBack.k > onBack * 1.5))) {
        // 1. the logo reads on the creative itself: the plate that would hide it is left out (a recoloured logo is preferred only when it reads clearly better)
        plate = null;
        plateFill = null;
        logoContrast = onBack;
        treatment = 'direct';
        flag(S, 'logo_plate_dropped');
      } else if (toneBack && toneBack.k >= 2.2) {
        // 2. recoloured to the brand tone that reads on the creative, without a plate
        plate = null;
        plateFill = null;
        tint = toneBack.c;
        logoContrast = toneBack.k;
        treatment = 'recoloured';
        flag(S, 'logo_recoloured');
      } else if (mono) {
        // 3a. the template's own (designed) plate stays and the logo takes the tone that reads on it
        const onPlate = bestTone(relativeLuminance(plateFill));
        tint = onPlate.c;
        logoContrast = onPlate.k;
        treatment = 'recoloured';
        flag(S, 'logo_recoloured');
      } else {
        // 3b. a multi-colour logo: the plate is recoloured so the logo reads on it
        plateOverride = lg < 0.45 ? '#ffffff' : darkPlate;
        logoContrast = luminanceRatio(lg, relativeLuminance(plateOverride));
        treatment = 'plate_recoloured';
        flag(S, 'logo_plate_recoloured');
      }
    }
    if (adapt && !layer.plate && treatment === 'direct' && luminanceRatio(lg, bl0) < 2.2) {
      const tone = mono ? bestTone(bl0) : null;
      if (tone && tone.k >= 2.2) {
        // 2. recoloured to the light or dark brand tone (no box behind it)
        tint = tone.c;
        logoContrast = tone.k;
        treatment = 'recoloured';
        flag(S, 'logo_recoloured');
      } else {
        // the last resort: a discreet plate (softly rounded, slightly see-through) in the tone that makes the logo read
        adaptFill = lg < 0.45 ? '#ffffff' : darkPlate;
        if (mono) tint = bestTone(relativeLuminance(adaptFill)).c;
        adaptPad = Math.max(4, Math.round(Math.min(lw, lh) * 0.22));
        const shrink = Math.min(1, (rect.w - adaptPad * 2) / lw, (rect.h - adaptPad * 2) / lh);
        if (shrink > 0 && shrink < 1) {
          lw = Math.max(1, Math.round(lw * shrink));
          lh = Math.max(1, Math.round(lh * shrink));
        }
        flag(S, 'logo_plate_added');
        const plateLum = 0.82 * relativeLuminance(adaptFill) + 0.18 * bl0;
        logoContrast = luminanceRatio(tint ? relativeLuminance(tint) : lg, plateLum);
        treatment = 'plate_added';
      }
    }
    let resized = await sharp(logo.data, rawOpts(logo.w, logo.h)).resize(lw, lh, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    if (tint) resized = tintRgba(resized, tint);
    // plate + logo are composed into one bitmap so opacity and rotation apply to the whole mark
    const gpad = plate ? pad : adaptFill ? adaptPad : 0;
    const gw = lw + Math.round(gpad * 2);
    const gh = lh + Math.round(gpad * 2);
    const g = place(gw, gh);
    const parts: sharp.OverlayOptions[] = [];
    if (plate) parts.push({ input: svgDoc(gw, gh, `<path d="${shapePath('rect', { x: 0, y: 0, w: gw, h: gh }, plate.radius)}" fill="${plateOverride ?? resolveColor(plate.fill, S.roles)}"/>`), left: 0, top: 0 });
    else if (adaptFill) parts.push({ input: svgDoc(gw, gh, `<path d="${shapePath('rect', { x: 0, y: 0, w: gw, h: gh }, Math.round(Math.min(gw, gh) * 0.3))}" fill="${adaptFill}" fill-opacity="0.82"/>`), left: 0, top: 0 });
    parts.push({ input: resized, raw: { width: lw, height: lh, channels: 4 }, left: Math.round(gpad), top: Math.round(gpad) });
    const group = await sharp({ create: { width: gw, height: gh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).raw().toBuffer();
    if (layer.opacity !== undefined && layer.opacity < 1) for (let i = 3; i < group.length; i += 4) group[i] = Math.round(group[i] * layer.opacity);
    await placeRgba(S, group, gw, gh, g.x, g.y, layer.rotate);
    S.painted.push(layer.id);
    // the report measures the MARK itself (the plate around it is not the logo)
    S.report.logo = { layerId: layer.id, rect: rotatedBBox({ x: g.x + gpad, y: g.y + gpad, w: lw, h: lh }, layer.rotate, [g.x + gw / 2, g.y + gh / 2]), mode: 'logo', contrast: Math.round(logoContrast * 100) / 100, plate: !!plate || !!adaptFill, treatment };
    if (S.tune.brandName) await drawBrandBeside(S, layer, S.report.logo.rect);
    return;
  }

  // no logo bytes: the brand NAME in the same box
  const name = capLength(normalizeText(S.brandName), 80).text;
  if (!name) {
    flag(S, 'logo_missing_no_name');
    return;
  }
  flag(S, 'logo_missing_name_used');
  const font = fontOf({ ...layer.nameStyle });
  const text = layer.nameStyle.case === 'upper' ? name.toUpperCase() : name;
  const lineHeight = layer.nameStyle.lineHeight ?? 1.1;
  const maxPx = Math.max(6, (innerH / lineHeight) * 0.92);
  let fit = await fitText({ text, font, lineHeight, boxW: innerW, boxH: innerH, maxPx, minPx: maxPx * 0.4, maxLines: 1, align: 'left', valign: 'middle' });
  if (!fit) return;
  // the business name is essential: when the logo area is too narrow for it, it may run on into the free width of the safe area (up to 3x the box)
  if (fit.trimmed) {
    const room = layer.align === 'right' ? rect.x + rect.w - S.safe.l : layer.align === 'center' ? Math.min(rect.x + rect.w / 2 - S.safe.l, S.safe.r - rect.x - rect.w / 2) * 2 : S.safe.r - rect.x;
    const wider = await fitText({ text, font, lineHeight, boxW: Math.min(room - pad * 2, innerW * 3), boxH: innerH, maxPx, minPx: maxPx * 0.4, maxLines: 1, align: 'left', valign: 'middle' });
    if (wider && !wider.trimmed) {
      fit = wider;
      flag(S, 'logo_name_widened');
    }
  }
  if (fit.trimmed) flag(S, 'text_trimmed:logo');
  const tw = Math.max(...fit.widths, 1);
  const gw = tw + pad * 2;
  const gh = Math.min(rect.h, fit.size * lineHeight + pad * 2);
  const g = place(gw, gh);
  if (S.dirty) await flush(S);
  const samples = layer.plate ? toSamples([resolveColor(layer.plate.fill, S.roles)]) : sampleBackdrop(S, { x: g.x, y: g.y, w: gw, h: gh });
  const color = readableColor(S, layer.id, resolveColor(layer.nameColor, S.roles), samples, layer.opacity ?? 1, fit.size, font.weight);
  const { svg } = textBlockSvg(fit.lines, { boxX: g.x + pad, boxY: g.y + pad, boxW: tw + 2, boxH: gh - pad * 2, size: fit.size, lineHeight, align: 'left', valign: 'middle', font, fill: color });
  addVector(S, plateMarkup({ x: g.x, y: g.y, w: gw, h: gh }) + svg, layer, [g.x + gw / 2, g.y + gh / 2], true);
  S.painted.push(layer.id);
  const backL = samples.length ? samples.reduce((s, p) => s + rgbLuminance(p[0], p[1], p[2]), 0) / samples.length : 0.5;
  S.report.logo = { layerId: layer.id, rect: rotatedBBox({ x: g.x + pad, y: g.y + pad, w: tw, h: gh - pad * 2 }, layer.rotate, [g.x + gw / 2, g.y + gh / 2]), mode: 'name', contrast: Math.round(luminanceRatio(relativeLuminance(color), backL) * 100) / 100, plate: !!layer.plate };
}

// ---- vector layers ---------------------------------------------------------------------------------------------------------------------

/** A decorative layer drawn smaller around its own centre (the preflight's "shrink the graphic element" repair). */
function shrunk(layer: Layer, k: number): Layer {
  const sbox = (b: readonly [number, number, number, number]): [number, number, number, number] => [b[0] + (b[2] * (1 - k)) / 2, b[1] + (b[3] * (1 - k)) / 2, b[2] * k, b[3] * k];
  if (layer.type === 'rect' || layer.type === 'ellipse' || layer.type === 'pattern') return { ...layer, box: sbox(layer.box) };
  if (layer.type === 'polygon') {
    const cx = layer.points.reduce((s, p) => s + p[0], 0) / layer.points.length;
    const cy = layer.points.reduce((s, p) => s + p[1], 0) / layer.points.length;
    return { ...layer, points: layer.points.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number]) };
  }
  if (layer.type === 'line') {
    const cx = (layer.from[0] + layer.to[0]) / 2;
    const cy = (layer.from[1] + layer.to[1]) / 2;
    return { ...layer, from: [cx + (layer.from[0] - cx) * k, cy + (layer.from[1] - cy) * k], to: [cx + (layer.to[0] - cx) * k, cy + (layer.to[1] - cy) * k] };
  }
  return layer;
}

/** The pixel bounding box (rotation included) of a decorative layer. */
function decorRect(S: Scene, layer: Layer): PxRect | null {
  switch (layer.type) {
    case 'fill':
      return { x: 0, y: 0, w: S.W, h: S.H };
    case 'rect':
    case 'ellipse':
    case 'pattern':
      return rotatedBBox(boxPx(S, layer.box), layer.rotate);
    case 'line': {
      const x0 = Math.min(layer.from[0], layer.to[0]) * S.W;
      const y0 = Math.min(layer.from[1], layer.to[1]) * S.H;
      const r = { x: x0, y: y0, w: Math.abs(layer.to[0] - layer.from[0]) * S.W, h: Math.abs(layer.to[1] - layer.from[1]) * S.H };
      return rotatedBBox(r, layer.rotate);
    }
    case 'polygon': {
      const xs = layer.points.map((p) => p[0] * S.W);
      const ys = layer.points.map((p) => p[1] * S.H);
      return rotatedBBox({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, layer.rotate);
    }
    default:
      return null;
  }
}

function drawVector(S: Scene, input: Layer) {
  let layer = input;
  if (DECOR_TYPES.has(layer.type)) {
    if (S.tune.hide?.includes(layer.id)) {
      flag(S, `layer_hidden:${layer.id}`);
      return;
    }
    const k = S.tune.shrinkDecor?.[layer.id];
    if (k !== undefined && k < 1) {
      layer = shrunk(layer, clamp(k, 0.4, 1));
      flag(S, `layer_shrunk:${layer.id}`);
    }
    const m = S.tune.layerOpacity?.[layer.id];
    if (m !== undefined && m < 1) {
      layer = { ...layer, opacity: (layer.opacity ?? 1) * clamp(m, 0, 1) };
      flag(S, `layer_lightened:${layer.id}`);
    }
  }
  const dr = decorRect(S, layer);
  if (dr) {
    const fillA = layer.type === 'line' ? 1 : layer.type === 'pattern' ? 0.35 : 'fill' in layer ? (layer.fill ? paintAlpha(layer.fill as Paint) : 'stroke' in layer && layer.stroke ? 0.15 : 0) : 1;
    const fillPaint = 'fill' in layer ? (layer.fill as Paint | undefined) : undefined;
    const cols = fillPaint ? paintColors(fillPaint, S.roles) : [];
    const lum = cols.length ? cols.reduce((sum, c) => sum + relativeLuminance(c), 0) / cols.length : null;
    S.report.decor.push({ layerId: layer.id, type: layer.type, rect: dr, opacity: Math.round((layer.opacity ?? 1) * fillA * 1000) / 1000, area: Math.round(((dr.w * dr.h) / (S.W * S.H)) * 1000) / 1000, afterHero: !!S.heroTrack, lum: lum === null ? null : Math.round(lum * 1000) / 1000, ...(fillPaint && typeof fillPaint !== 'string' ? { gradient: true } : {}) });
  }
  const { W, H, unit, roles, defs } = S;
  switch (layer.type) {
    case 'fill': {
      const whole: Rect = { x: 0, y: 0, w: W, h: H };
      addVector(S, `<rect width="${W}" height="${H}" fill="${paintFill(layer.fill, whole, roles, defs)}"/>`, layer, null);
      break;
    }
    case 'rect': {
      const r = boxPx(S, layer.box);
      // a large panel that stops a hair short of the canvas edge leaves an accidental uncovered strip: it is extended to the edge
      if (!layer.rotate && !layer.stroke && !layer.radius && (r.w >= S.W * 0.3 || r.h >= S.H * 0.3)) {
        const tol = (d: number) => d * 0.02;
        let snapped = false;
        if (r.x > 0.5 && r.x <= tol(S.W)) { r.w += r.x; r.x = 0; snapped = true; }
        if (S.W - (r.x + r.w) > 0.5 && S.W - (r.x + r.w) <= tol(S.W)) { r.w = S.W - r.x; snapped = true; }
        if (r.y > 0.5 && r.y <= tol(S.H)) { r.h += r.y; r.y = 0; snapped = true; }
        if (S.H - (r.y + r.h) > 0.5 && S.H - (r.y + r.h) <= tol(S.H)) { r.h = S.H - r.y; snapped = true; }
        if (snapped) flag(S, `panel_snapped:${layer.id}`);
      }
      const sw = layer.stroke ? Math.max(1, layer.stroke.width * unit) : 0;
      const inner: Rect = { x: r.x + sw / 2, y: r.y + sw / 2, w: Math.max(1, r.w - sw), h: Math.max(1, r.h - sw) };
      const path = shapePath('rect', inner, layer.radius ?? 0);
      const fill = layer.fill ? paintFill(layer.fill, r, roles, defs) : 'none';
      const stroke = layer.stroke ? ` stroke="${resolveColor(layer.stroke.color, roles)}" stroke-width="${n2(sw)}"` : '';
      const shadow = layer.shadow ? shadowMarkup(shapePath('rect', r, layer.radius ?? 0), r, unit, defs) : '';
      addVector(S, `${shadow}<path d="${path}" fill="${fill}"${stroke}/>`, layer, [r.x + r.w / 2, r.y + r.h / 2]);
      break;
    }
    case 'ellipse': {
      const r = boxPx(S, layer.box);
      const sw = layer.stroke ? Math.max(1, layer.stroke.width * unit) : 0;
      const fill = layer.fill ? paintFill(layer.fill, r, roles, defs) : 'none';
      const stroke = layer.stroke ? ` stroke="${resolveColor(layer.stroke.color, roles)}" stroke-width="${n2(sw)}"` : '';
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const shape = layer.circle
        ? `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(Math.max(0.5, Math.min(r.w, r.h) / 2 - sw / 2))}" fill="${fill}"${stroke}/>`
        : `<ellipse cx="${n2(cx)}" cy="${n2(cy)}" rx="${n2(Math.max(0.5, r.w / 2 - sw / 2))}" ry="${n2(Math.max(0.5, r.h / 2 - sw / 2))}" fill="${fill}"${stroke}/>`;
      addVector(S, shape, layer, [cx, cy]);
      break;
    }
    case 'line': {
      const [x1, y1] = [layer.from[0] * W, layer.from[1] * H];
      const [x2, y2] = [layer.to[0] * W, layer.to[1] * H];
      const sw = Math.max(1, layer.stroke.width * unit);
      addVector(S, `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" stroke="${resolveColor(layer.stroke.color, roles)}" stroke-width="${n2(sw)}"/>`, layer, [(x1 + x2) / 2, (y1 + y2) / 2]);
      break;
    }
    case 'pattern': {
      const r = boxPx(S, layer.box);
      addVector(S, patternMarkup(layer.kind, r, resolveColor(layer.color, roles), layer.size * unit, defs), layer, [r.x + r.w / 2, r.y + r.h / 2]);
      break;
    }
    case 'polygon': {
      const pts = layer.points.map(([x, y]) => [x * W, y * H] as const);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const bbox: Rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const sw = layer.stroke ? Math.max(1, layer.stroke.width * unit) : 0;
      const fill = layer.fill ? paintFill(layer.fill, bbox, roles, defs) : 'none';
      const stroke = layer.stroke ? ` stroke="${resolveColor(layer.stroke.color, roles)}" stroke-width="${n2(sw)}" stroke-linejoin="miter"` : '';
      addVector(S, `<polygon points="${pts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}" fill="${fill}"${stroke}/>`, layer, [bbox.x + bbox.w / 2, bbox.y + bbox.h / 2]);
      break;
    }
    default:
      return;
  }
  S.painted.push(layer.id);
}

// ---- orchestration ---------------------------------------------------------------------------------------------------------------------

async function renderInner(input: TemplateRenderInput): Promise<TemplateRenderResult> {
  const { width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    throw new RenderError('unsupported_format', `The size ${String(width)}x${String(height)} is not valid: whole pixels between ${MIN_SIDE} and ${MAX_SIDE} are supported.`);
  }
  const template = validated(input.template);
  const cls = formatClassOf(width, height);
  if (!template.classes.includes(cls)) {
    throw new RenderError('unsupported_format', `The template "${template.id}" is designed for ${template.classes.join(', ')} and is not stretched into ${cls} (${width}x${height}).`);
  }
  const content = (input.content ?? {}) as Partial<Record<TextSlot, string>>;
  const has = (slot: TextSlot) => normalizeText(typeof content[slot] === 'string' ? (content[slot] as string) : '').length > 0;
  const missing: string[] = [];
  if (!has('headline')) missing.push('headline');
  for (const r of template.requires) {
    if (r === 'image') {
      if (!input.images?.hero) missing.push('image');
    } else if (r === 'logo') {
      if (!input.logo) missing.push('logo');
    } else if (!has(r)) missing.push(r);
  }
  if (missing.length) throw new RenderError('missing_required', `The template "${template.id}" needs ${[...new Set(missing)].join(', ')}, which was not provided.`);

  const hero = await inspectImage(input.images?.hero, 'hero');
  const secondary = await inspectImage(input.images?.secondary, 'secondary');
  // an unreadable logo (for example an SVG upload, which is never rasterized here) must not fail the creative: it is drawn as the brand name
  // and flagged `logo_unreadable`, exactly like a logo that decodes to nothing visible
  let logoUnreadable = false;
  const logo = await inspectImage(input.logo ?? undefined, 'logo').catch((e) => {
    if (!(e instanceof RenderError)) throw e;
    logoUnreadable = true;
    return null;
  });

  const roles = resolvePalette(Array.isArray(input.palette) ? input.palette : [], input.anchors ? { ...input.anchors, exact: true } : styleAnchors(input.styleId));
  const hf = input.heroFocus && Number.isFinite(input.heroFocus[0]) && Number.isFinite(input.heroFocus[1]) ? ([clamp(input.heroFocus[0], 0, 1), clamp(input.heroFocus[1], 0, 1)] as [number, number]) : undefined;

  const base = hexToRgb(roles.paper);
  const canvas = Buffer.alloc(width * height * 4);
  canvas.fill(Buffer.from([base[0], base[1], base[2], 255]));
  const S: Scene = {
    W: width,
    H: height,
    unit: Math.min(width, height),
    roles,
    safe: safeAreaFor(width, height),
    cls,
    content,
    alt: { cta: (input.alternatives?.cta ?? []).map(normalizeText).filter(Boolean).slice(0, 6), headline: (input.alternatives?.headline ?? []).map(normalizeText).filter(Boolean).slice(0, 4) },
    brandName: typeof input.brandName === 'string' ? input.brandName : '',
    hero,
    secondary,
    logo,
    heroFocus: hf,
    logoAdapt: input.logoAdapt === true,
    subject: validSubject(input.subject),
    tune: input.tune ?? {},
    canvas,
    ops: [],
    defs: new Defs(),
    body: [],
    dirty: false,
    flags: [],
    drawn: [],
    painted: [],
    report: { width, height, safe: { l: 0, t: 0, r: width, b: height }, hero: null, texts: [], buttons: [], logo: null, decor: [], shortened: [] },
    heroTrack: null,
  };
  S.report.safe = { ...S.safe };
  if (logoUnreadable && template.layers.some((l) => l.type === 'logo')) flag(S, 'logo_unreadable');

  for (const raw of template.layers) {
    const layer = layerFor(raw, cls);
    if (!layer) continue;
    switch (layer.type) {
      case 'text':
        await drawText(S, layer);
        break;
      case 'button':
        await drawButton(S, layer);
        break;
      case 'image':
        await drawImage(S, layer);
        break;
      case 'logo':
        await drawLogo(S, layer);
        break;
      default:
        drawVector(S, layer);
    }
  }
  await flush(S);
  measureHero(S);
  const png = await sharp(S.canvas, rawOpts(width, height)).removeAlpha().png().toBuffer();
  return { ok: true, png, width, height, flags: S.flags, drawn: S.drawn, layers: S.painted, report: S.report };
}

/** Only well-formed boxes (finite fractions) reach the crop; anything else is ignored rather than trusted. */
function validSubject(s: RenderSubject | undefined): RenderSubject | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const ok = (b: unknown): b is UnitBox => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[2] > 0 && b[3] > 0;
  if (!ok(s.subject)) return undefined;
  return { faces: (Array.isArray(s.faces) ? s.faces : []).filter(ok).slice(0, 24), subject: s.subject, graphic: s.graphic === true };
}
