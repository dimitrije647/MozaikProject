import sharp from 'sharp';
import { CREATIVE_FORMATS, MAX_UPSCALE } from '../creative/formats';
import { hexToRgb, luminanceRatio, mix, rgbLuminance } from './color';
import { resolvePalette, type PaletteAnchors } from './palette';
import {
  formatClassOf,
  layerFor,
  validateTemplate,
  type FormatClass,
  type Layer,
  type StyleId,
  type TemplateDef,
  type TemplateRenderInput,
  type TemplateRenderResult,
  type TextSlot,
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
 */

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
  brandName: string;
  hero: ImageInfo | null;
  secondary: ImageInfo | null;
  logo: ImageInfo | null;
  heroFocus?: [number, number];
  logoAdapt?: boolean;
  canvas: Buffer;
  ops: sharp.OverlayOptions[];
  defs: Defs;
  body: string[];
  dirty: boolean;
  flags: string[];
  drawn: TextSlot[];
  painted: string[];
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
  if (capped.cut) flag(S, `text_trimmed:${layer.slot}`);
  const raw = capped.text;
  const { rect, moved } = clampToSafe(S, boxPx(S, layer.box));
  if (moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const text = layer.style.case === 'upper' ? raw.toUpperCase() : raw;
  const font = fontOf(layer.style);
  const lineHeight = layer.style.lineHeight ?? 1.15;
  const rtl = hasRtl(text);
  const align: Align = rtl && layer.align !== 'center' ? (layer.align === 'left' ? 'right' : 'left') : layer.align;
  const maxPx = layer.size.max * S.unit;
  const fit = await fitText({ text, font, lineHeight, boxW: rect.w, boxH: rect.h, maxPx, minPx: Math.min(layer.size.min, layer.size.max) * S.unit, maxLines: layer.maxLines, align, valign: layer.valign });
  if (!fit) return;
  if (fit.shrunk) flag(S, `text_shrunk:${layer.slot}`);
  if (fit.trimmed) flag(S, `text_trimmed:${layer.slot}`);
  if (fit.hyphenated) flag(S, `text_hyphenated:${layer.slot}`);

  if (S.dirty) await flush(S);
  const spec = { boxX: rect.x, boxY: rect.y, boxW: rect.w, boxH: rect.h, size: fit.size, lineHeight, align, valign: layer.valign, font, fill: '#000000', underline: layer.underline };
  const probe = textBlockSvg(fit.lines, spec).block;
  const widest = Math.max(...fit.widths, 1);
  const bx = align === 'left' ? rect.x : align === 'center' ? rect.x + (rect.w - widest) / 2 : rect.x + rect.w - widest;
  const samples = sampleBackdrop(S, { x: bx - fit.size * 0.1, y: probe.y - fit.size * 0.1, w: widest + fit.size * 0.2, h: probe.h + fit.size * 0.2 });
  const base = resolveColor(layer.color, S.roles);
  const color = readableColor(S, layer.id, base, samples, layer.opacity ?? 1, fit.size, font.weight);
  const { svg } = textBlockSvg(fit.lines, { ...spec, fill: color });
  addVector(S, svg, layer, [rect.x + rect.w / 2, rect.y + rect.h / 2], true);
  S.painted.push(layer.id);
  if (!S.drawn.includes(layer.slot)) S.drawn.push(layer.slot);
}

async function drawButton(S: Scene, layer: L<'button'>) {
  const full = contentFor(S, 'cta');
  if (!full) return;
  const capped = capLength(full, 80);
  if (capped.cut) flag(S, 'text_trimmed:cta');
  const cta = capped.text;
  const { rect, moved } = clampToSafe(S, boxPx(S, layer.box));
  if (moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const sw = layer.stroke ? Math.max(1, layer.stroke.width * S.unit) : 0;
  const inner: Rect = { x: rect.x + sw / 2, y: rect.y + sw / 2, w: Math.max(2, rect.w - sw), h: Math.max(2, rect.h - sw) };
  const rad = layer.radius;
  const fill = paintFill(layer.fill, rect, S.roles, S.defs);
  const strokeAttr = layer.stroke ? ` stroke="${resolveColor(layer.stroke.color, S.roles)}" stroke-width="${n2(sw)}"` : '';
  let markup = `<path d="${shapePath('rect', inner, rad)}" fill="${fill}"${strokeAttr}/>`;

  const font = fontOf({ ...layer.style });
  const text = layer.style.case === 'upper' ? cta.toUpperCase() : cta;
  const padX = rect.h * 0.42;
  const maxPx = Math.min(layer.size.max * S.unit, rect.h * 0.48);
  const minPx = Math.min(layer.size.min * S.unit, maxPx);
  // the arrow is a drawn glyph (font independent): its width is reserved before the label is fitted
  const arrowGap = (size: number) => size * 0.7;
  const arrowW = (size: number) => size * 0.95;
  const reserve = layer.arrow ? arrowGap(maxPx) + arrowW(maxPx) : 0;
  const fit = await fitText({ text, font, lineHeight: 1.1, boxW: Math.max(8, rect.w - padX * 2 - reserve), boxH: rect.h * 0.92, maxPx, minPx, maxLines: 1, align: 'left', valign: 'middle' });
  if (!fit) return;
  if (fit.shrunk) flag(S, `text_shrunk:cta`);
  if (fit.trimmed) flag(S, `text_trimmed:cta`);
  const textW = Math.max(...fit.widths, 1);
  const extra = layer.arrow ? arrowGap(fit.size) + arrowW(fit.size) : 0;
  const x0 = rect.x + (rect.w - (textW + extra)) / 2;
  const colors = paintColors(layer.fill, S.roles);
  const color = readableColor(S, layer.id, resolveColor(layer.color, S.roles), toSamples(colors), 1, fit.size, font.weight);
  const { svg } = textBlockSvg(fit.lines, { boxX: x0, boxY: rect.y, boxW: textW + 2, boxH: rect.h, size: fit.size, lineHeight: 1.1, align: 'left', valign: 'middle', font, fill: color });
  markup += svg;
  if (layer.arrow) {
    const aw = arrowW(fit.size);
    const ax = x0 + textW + arrowGap(fit.size);
    const cy = rect.y + rect.h / 2;
    const t = Math.max(1.5, fit.size * 0.11);
    markup += `<path d="M${n2(ax)} ${n2(cy)}H${n2(ax + aw)}M${n2(ax + aw * 0.6)} ${n2(cy - aw * 0.32)}L${n2(ax + aw)} ${n2(cy)}L${n2(ax + aw * 0.6)} ${n2(cy + aw * 0.32)}" fill="none" stroke="${color}" stroke-width="${n2(t)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  addVector(S, markup, layer, [rect.x + rect.w / 2, rect.y + rect.h / 2], true);
  S.painted.push(layer.id);
  if (!S.drawn.includes('cta')) S.drawn.push('cta');
}

// ---- images ----------------------------------------------------------------------------------------------------------------------------

async function coverCrop(info: ImageInfo, bw: number, bh: number, focus: [number, number], treatment: L<'image'>['treatment'], S: Scene, slot: string, roles: Roles): Promise<Buffer> {
  const scale = Math.max(bw / info.w, bh / info.h);
  if (scale > MAX_UPSCALE) flag(S, `image_low_resolution:${slot}`);
  const sw = Math.max(bw, Math.ceil(info.w * scale));
  const sh = Math.max(bh, Math.ceil(info.h * scale));
  const left = clamp(Math.round(focus[0] * sw - bw / 2), 0, sw - bw);
  const top = clamp(Math.round(focus[1] * sh - bh / 2), 0, sh - bh);
  try {
    let p = sharp(info.buf, SHARP_IN).rotate().resize(sw, sh, { fit: 'fill' }).extract({ left, top, width: bw, height: bh });
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
  if (info) {
    const focus: [number, number] = layer.slot === 'hero' && S.heroFocus ? S.heroFocus : (layer.focus ?? [0.5, 0.5]);
    rgba = await coverCrop(info, bw, bh, [clamp(focus[0], 0, 1), clamp(focus[1], 0, 1)], layer.treatment, S, layer.slot, S.roles);
  } else {
    flag(S, layer.slot === 'hero' ? 'hero_missing_fallback' : 'secondary_missing_fallback');
    if (!layer.fallback || layer.fallback === 'none') return;
    photo = false;
    rgba = await fallbackArt(layer.fallback, bw, bh, S);
  }

  const rect: Rect = { x: 0, y: 0, w: bw, h: bh };
  const kind = shapeKindOf(layer.mask);
  const rad = layer.mask === 'rounded' ? (layer.radius ?? 0.06) : (layer.radius ?? 0);
  const path = shapePath(layer.mask === 'rounded' ? 'rect' : kind, rect, rad);
  const t = layer.treatment;
  const defs = new Defs();
  let overlay = '';
  if (photo && t?.tint) overlay += `<rect width="${bw}" height="${bh}" fill="${resolveColor(t.tint.color, S.roles)}" fill-opacity="${n2(t.tint.opacity)}"/>`;
  if (t?.scrim) {
    const gid = defs.id('s');
    const a = (t.scrim.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const len = Math.abs(bw * dx) + Math.abs(bh * dy);
    defs.add(
      `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n2(bw / 2 - (dx * len) / 2)}" y1="${n2(bh / 2 - (dy * len) / 2)}" x2="${n2(bw / 2 + (dx * len) / 2)}" y2="${n2(bh / 2 + (dy * len) / 2)}"><stop offset="0" stop-color="${resolveColor(t.scrim.from, S.roles)}" stop-opacity="${n2(t.scrim.fromOpacity)}"/><stop offset="1" stop-color="${resolveColor(t.scrim.to, S.roles)}" stop-opacity="${n2(t.scrim.toOpacity)}"/></linearGradient>`,
    );
    overlay += `<rect width="${bw}" height="${bh}" fill="url(#${gid})"/>`;
  }
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

async function drawLogo(S: Scene, layer: L<'logo'>) {
  const { rect, moved } = clampToSafe(S, boxPx(S, layer.box));
  if (moved) flag(S, `moved_into_safe_area:${layer.id}`);
  const pad = layer.plate ? layer.plate.padding * S.unit : 0;
  const innerW = Math.max(4, rect.w - pad * 2);
  const innerH = Math.max(4, rect.h - pad * 2);
  const place = (gw: number, gh: number) => ({
    x: layer.align === 'left' ? rect.x : layer.align === 'center' ? rect.x + (rect.w - gw) / 2 : rect.x + rect.w - gw,
    y: layer.valign === 'top' ? rect.y : layer.valign === 'middle' ? rect.y + (rect.h - gh) / 2 : rect.y + rect.h - gh,
  });
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
    if (S.logoAdapt && !layer.plate) {
      if (S.dirty) await flush(S);
      const at = place(lw, lh);
      const back = sampleBackdrop(S, { x: at.x, y: at.y, w: lw, h: lh });
      const lg = logoLuminance(logo.data, logo.w, logo.h);
      const bl = back.length ? back.reduce((sum, p) => sum + lum3(p), 0) / back.length : 0.5;
      if ((Math.max(lg, bl) + 0.05) / (Math.min(lg, bl) + 0.05) < 2.2) {
        adaptFill = lg < 0.45 ? '#ffffff' : '#101010';
        adaptPad = Math.max(4, Math.round(Math.min(lw, lh) * 0.22));
        const shrink = Math.min(1, (rect.w - adaptPad * 2) / lw, (rect.h - adaptPad * 2) / lh);
        if (shrink > 0 && shrink < 1) {
          lw = Math.max(1, Math.round(lw * shrink));
          lh = Math.max(1, Math.round(lh * shrink));
        }
        flag(S, 'logo_plate_added');
      }
    }
    const resized = await sharp(logo.data, rawOpts(logo.w, logo.h)).resize(lw, lh, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    // plate + logo are composed into one bitmap so opacity and rotation apply to the whole mark
    const gpad = layer.plate ? pad : adaptFill ? adaptPad : 0;
    const gw = lw + Math.round(gpad * 2);
    const gh = lh + Math.round(gpad * 2);
    const g = place(gw, gh);
    const parts: sharp.OverlayOptions[] = [];
    if (layer.plate) parts.push({ input: svgDoc(gw, gh, `<path d="${shapePath('rect', { x: 0, y: 0, w: gw, h: gh }, layer.plate.radius)}" fill="${resolveColor(layer.plate.fill, S.roles)}"/>`), left: 0, top: 0 });
    else if (adaptFill) parts.push({ input: svgDoc(gw, gh, `<path d="${shapePath('rect', { x: 0, y: 0, w: gw, h: gh }, Math.round(adaptPad * 0.6))}" fill="${adaptFill}"/>`), left: 0, top: 0 });
    parts.push({ input: resized, raw: { width: lw, height: lh, channels: 4 }, left: Math.round(gpad), top: Math.round(gpad) });
    const group = await sharp({ create: { width: gw, height: gh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).raw().toBuffer();
    if (layer.opacity !== undefined && layer.opacity < 1) for (let i = 3; i < group.length; i += 4) group[i] = Math.round(group[i] * layer.opacity);
    await placeRgba(S, group, gw, gh, g.x, g.y, layer.rotate);
    S.painted.push(layer.id);
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
  const fit = await fitText({ text, font, lineHeight, boxW: innerW, boxH: innerH, maxPx, minPx: maxPx * 0.4, maxLines: 1, align: 'left', valign: 'middle' });
  if (!fit) return;
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
}

// ---- vector layers ---------------------------------------------------------------------------------------------------------------------

function drawVector(S: Scene, layer: Layer) {
  const { W, H, unit, roles, defs } = S;
  switch (layer.type) {
    case 'fill': {
      const whole: Rect = { x: 0, y: 0, w: W, h: H };
      addVector(S, `<rect width="${W}" height="${H}" fill="${paintFill(layer.fill, whole, roles, defs)}"/>`, layer, null);
      break;
    }
    case 'rect': {
      const r = boxPx(S, layer.box);
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
  const logo = await inspectImage(input.logo ?? undefined, 'logo');

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
    brandName: typeof input.brandName === 'string' ? input.brandName : '',
    hero,
    secondary,
    logo,
    heroFocus: hf,
    logoAdapt: input.logoAdapt === true,
    canvas,
    ops: [],
    defs: new Defs(),
    body: [],
    dirty: false,
    flags: [],
    drawn: [],
    painted: [],
  };

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
  const png = await sharp(S.canvas, rawOpts(width, height)).removeAlpha().png().toBuffer();
  return { ok: true, png, width, height, flags: S.flags, drawn: S.drawn, layers: S.painted };
}

