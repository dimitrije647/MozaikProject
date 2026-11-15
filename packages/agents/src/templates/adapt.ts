import { CREATIVE_FORMATS } from '../creative/formats';
import { busyIn, type SubjectMap } from '../imagery/subject';
import { overlap1, planCrop, type CropPlan } from './crop';
import { spacingIssues, type SpacingScene } from './spacing';
import { formatClassOf, layerFor, type FontFamily, type FormatClass, type Layer, type Paint, type TemplateDef, type TextSlot, type UnitBox } from './schema';

/**
 * ADAPTIVE COMPOSITION (pure, deterministic, no model, no pixels): a template is a design GUIDELINE, not a fixed composition.
 *
 * Before anything is rendered, every candidate template of the collection is turned into a few controlled LAYOUT VARIANTS of itself, and each
 * variant is checked against the real content: where the faces and the subject of the approved picture land after the crop, whether the
 * headline fits, whether text sits on calm picture areas (negative space) or on a panel, how much decoration covers the people, how large the
 * logo can be, and how the campaign's other creatives of the format already look. Critical problems are HARD failures (a face cut in half, text
 * over a face, an unreadable headline, the people shrunk into a thumbnail): no amount of colour or balance compensates for them. The best few
 * compositions are then rendered and validated by the design preflight (preflight.ts), which stays the final judge.
 *
 * Variants (each keeps the template's colours, type, decoration and spirit; only geometry changes, within limits):
 *   base     the template as designed
 *   mirror   the composition mirrored left/right (text left + picture right <-> picture left + text right)
 *   compact  panels and bands that carry the text over the picture shrink to the text; stripes are shortened to it; a veil over the whole
 *            picture becomes a local gradient behind the text (the people stay visible, the text keeps its backing)
 *   top / bottom   the text group (with its panel) moves to the top or the bottom of the picture, where the negative space is; the logo
 *            moves to the other edge when they would meet
 *   contain  the whole photograph is shown in its area, letterboxed in its own (calm) border colour: for a group that any crop of this format
 *            would cut (a wide team photo in a 9:16 story). Only for photographs of people with a calm border.
 *   photo-panel  a large coloured panel that would carry nothing (or only the logo) becomes a picture area: the approved photograph fills it
 *            (a typography-first template gets its photograph instead of an empty block of colour)
 * Combinations: mirror+compact, top+compact, bottom+compact. At most 10 variants per template; usually far fewer apply.
 *
 * Every variant also gets the TEXT REFLOW: when optional text slots of a column are empty (no date, no location), the space they leave
 * between the shown texts goes to the headline (larger type) and to the gap before the button, instead of staying an empty hole.
 */

export type VariantId = 'base' | 'mirror' | 'compact' | 'mirror+compact' | 'top' | 'bottom' | 'top+compact' | 'bottom+compact' | 'contain' | 'photo-panel';
const VARIANTS: VariantId[] = ['base', 'mirror', 'compact', 'mirror+compact', 'top', 'bottom', 'top+compact', 'bottom+compact', 'contain', 'photo-panel'];

/** What the composition has to carry. */
/**
 * WHAT A PICTURE IS, in the practical terms a layout cares about. A photograph may carry text over it; a screenshot or an illustration may be shown
 * framed (nothing written over it); a brand graphic, a text-heavy graphic or a logo is never used as a picture: it already carries its own text
 * and mark, so copy over it collides with it and the logo would be drawn twice.
 */
export const ASSET_KINDS = ['photograph', 'screenshot', 'illustration', 'brand_graphic', 'text_heavy_graphic', 'logo'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
/** Kinds that are never a creative's picture. */
export const NEVER_A_PICTURE: ReadonlySet<AssetKind> = new Set(['brand_graphic', 'text_heavy_graphic', 'logo']);

/**
 * The kind of a library picture from what is known about it: the category the Visual Researcher recorded (website discovery / the pixel check at
 * import), its words, and the local subject map (a flat graphic without a face is not a photograph). Deterministic.
 */
export function assetKindOf(o: { category?: string | null; text?: string | null; subject?: Pick<SubjectMap, 'graphic' | 'faces' | 'busy'> | null }): AssetKind {
  const words = (o.text ?? '').toLowerCase();
  if (/\b(logo|wordmark|brandmark|favicon)\b/.test(words) && !o.subject?.faces.length) return 'logo';
  if (/\b(screenshot|dashboard|screen|interface|app ui|mockup)\b/.test(words) && !o.subject?.faces.length) return 'screenshot';
  if (/\b(illustration|drawing|vector|icon set|infographic)\b/.test(words) && !o.subject?.faces.length) return 'illustration';
  // a flat graphic whose detail is spread over many small cells is mostly lettering
  const cells = o.subject?.busy.cells ?? [];
  const busyShare = cells.length ? cells.filter((c) => c > 0.25).length / cells.length : 0;
  const lettering = busyShare > 0.18 || /\b(banner|flyer|poster|og|share|card|slide)\b/.test(words);
  // the Visual Researcher (or the pixel check at import) recorded it as a brand graphic: never a picture
  if (o.category === 'brand_graphic') return lettering ? 'text_heavy_graphic' : 'brand_graphic';
  // flat pixels alone (no recorded category): lettering makes it a text-heavy graphic; otherwise it is an illustration
  if (o.subject?.graphic && !o.subject.faces.length) return lettering ? 'text_heavy_graphic' : 'illustration';
  return 'photograph';
}

export interface ContentProfile {
  width: number;
  height: number;
  /** the approved picture (null = typography only); `kind` defaults to a photograph (older callers) */
  picture: { w: number; h: number; focus?: [number, number] | null; subject: Pick<SubjectMap, 'faces' | 'subject' | 'graphic' | 'busy'> | null; kind?: AssetKind } | null;
  /** a second approved picture exists for templates with two picture areas */
  hasSecondPicture: boolean;
  /** pixel size of the logo file (null = the business name is drawn) */
  logo: { w: number; h: number } | null;
  copy: Partial<Record<TextSlot, string | null>> & { headline: string };
  /** social_post, web_ad, display_ad, billboard, flyer */
  kind?: string | null;
  /**
   * A fast-scroll format (a TikTok cover): the picture must carry the attention. A composition that leaves the approved photograph out is a hard
   * problem there, the photograph's presence weighs more and type that fills the frame is penalised.
   */
  fastScroll?: boolean;
}

export interface CompositionContext {
  /** templateId -> variants already delivered in this FORMAT (layout diversity) */
  used?: ReadonlyMap<string, ReadonlySet<string>>;
  /** families already delivered in this format */
  usedFamilies?: ReadonlySet<string>;
  /** the selector's preference order (earlier = preferred) */
  preferred?: readonly string[];
}

export interface Composition {
  templateId: string;
  family: string;
  variant: VariantId;
  /** the adapted template (flattened to the format's class) */
  template: TemplateDef;
  score: number;
  /** critical problems: a composition with any of these only wins when every candidate has them */
  hard: string[];
  /** why it scored as it did (for people) */
  reasons: string[];
  predicted: { crop: Pick<CropPlan, 'fit' | 'zoom' | 'cropLoss'> | null; facesWhole: number; facesTotal: number; textOver: 'panel' | 'picture' | 'plain'; logoPx: number | null };
}

// ---- geometry helpers ------------------------------------------------------------------------------------------------------------------------

type R = { x: number; y: number; w: number; h: number };
const area = (r: R) => Math.max(0, r.w) * Math.max(0, r.h);
const inter = (a: R, b: R) => overlap1(a.x, a.x + a.w, b.x, b.x + b.w) * overlap1(a.y, a.y + a.h, b.y, b.y + b.h);
const union = (rs: R[]): R | null => {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const boxR = (b: readonly number[]): R => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const rot = (r: R, deg?: number): R => {
  if (!deg) return r;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const a = (deg * Math.PI) / 180;
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
  return union(pts.map(([x, y]) => ({ x, y, w: 0, h: 0 })))!;
};
/** The bounding box of a layer in canvas FRACTIONS (null for layers without geometry). */
function boundsOf(l: Layer): R | null {
  switch (l.type) {
    case 'fill':
      return { x: 0, y: 0, w: 1, h: 1 };
    case 'line':
      return rot({ x: Math.min(l.from[0], l.to[0]), y: Math.min(l.from[1], l.to[1]), w: Math.abs(l.to[0] - l.from[0]), h: Math.abs(l.to[1] - l.from[1]) }, l.rotate);
    case 'polygon':
      return rot(union(l.points.map(([x, y]) => ({ x, y, w: 0, h: 0 })))!, l.rotate);
    default:
      return rot(boxR(l.box), l.rotate);
  }
}
const DECOR = new Set(['rect', 'ellipse', 'polygon', 'pattern', 'line', 'fill']);
const paintAlpha = (p: Paint | undefined) => (!p ? 0 : typeof p === 'string' ? 1 : Math.max(...p.gradient.stops.map((s) => s.opacity ?? 1)));
function opacityOf(l: Layer): number {
  const fillA = l.type === 'line' ? 1 : l.type === 'pattern' ? 0.35 : 'fill' in l ? (l.fill ? paintAlpha(l.fill as Paint) : 'stroke' in l && l.stroke ? 0.15 : 0) : 1;
  return (l.opacity ?? 1) * fillA;
}

// ---- variants --------------------------------------------------------------------------------------------------------------------------------

/** The template resolved for one format class: its layers with the class patches applied, nothing hidden, no other classes. */
export function flattenFor(t: TemplateDef, cls: FormatClass): TemplateDef {
  const layers = t.layers.map((l) => layerFor(l, cls)).filter((l): l is Layer => !!l).map((l) => {
    const { at: _a, hide: _h, ...rest } = l as Layer & { at?: unknown; hide?: unknown };
    void _a;
    void _h;
    return rest as Layer;
  });
  return { ...t, classes: [cls], layers };
}

/**
 * PRINT IS NOT A SCREEN. On a billboard or a flyer the call to action is written, not drawn as a clickable button: every button becomes a text line
 * in the same place, in the headline's colour, aligned with the headline when it sits in the headline's column (so a centred layout stays centred).
 * Other media are returned unchanged.
 */
export function mediaLayers(t: TemplateDef, kind: string | null | undefined): TemplateDef {
  if (kind !== 'billboard' && kind !== 'flyer') return t;
  if (!t.layers.some((l) => l.type === 'button')) return t;
  const head = t.layers.find((l): l is Extract<Layer, { type: 'text' }> => l.type === 'text' && l.slot === 'headline');
  const layers = t.layers.map((l): Layer => {
    if (l.type !== 'button') return l;
    const [x, y, w, h] = l.box;
    let box: [number, number, number, number] = [x, y, w, h];
    let align: 'left' | 'center' | 'right' = Math.abs(x + w / 2 - 0.5) < 0.03 ? 'center' : 'left';
    if (head) {
      const [hx, , hw] = head.box;
      // in (or overlapping) the headline's column: take its width and alignment (one group, one axis)
      if (Math.min(x + w, hx + hw) - Math.max(x, hx) > 0) {
        // the headline's width and alignment; the button's own x is kept on its anchor side (on a tilted card each line is shifted along the tilt)
        align = head.align;
        const bw = Math.min(hw, 1 - Math.max(0, align === 'center' ? x + w / 2 - hw / 2 : x));
        box = align === 'center' ? [Math.max(0, x + w / 2 - bw / 2), y, bw, h] : align === 'right' ? [Math.max(0, x + w - bw), y, bw, h] : [x, y, bw, h];
      }
    }
    // the line keeps the button's place in the composition: its rotation (a tilted card) and its group anchor
    const keep = Object.fromEntries(Object.entries(l).filter(([k]) => ['rotate', 'opacity', 'anchor', 'group', 'parent'].includes(k)));
    return { id: l.id, type: 'text', slot: 'cta', box, align, valign: 'middle', style: { ...l.style }, color: head?.color ?? l.color, size: { max: Math.min(0.3, l.size.max * 1.15), min: Math.min(l.size.min, l.size.max) }, maxLines: 2, optional: true, ...keep } as Layer;
  });
  return { ...t, layers };
}

const mirrorAngle = (a: number) => (((180 - a) % 360) + 360) % 360;
const mirrorPaint = (p: Paint | undefined): Paint | undefined => (!p || typeof p === 'string' ? p : { gradient: { ...p.gradient, angle: mirrorAngle(p.gradient.angle) } });
const mirrorBox = (b: readonly [number, number, number, number]): [number, number, number, number] => [1 - b[0] - b[2], b[1], b[2], b[3]];

function mirrorLayer(l: Layer): Layer {
  const m = { ...l, ...(l.rotate ? { rotate: -l.rotate } : {}) } as Layer;
  switch (m.type) {
    case 'fill':
      return { ...m, fill: mirrorPaint(m.fill)! };
    case 'line':
      return { ...m, from: [1 - m.from[0], m.from[1]] as [number, number], to: [1 - m.to[0], m.to[1]] as [number, number] };
    case 'polygon':
      return { ...m, points: m.points.map(([x, y]) => [1 - x, y] as [number, number]), fill: mirrorPaint(m.fill) };
    case 'image': {
      const mask = m.mask === 'cut-left' ? 'cut-right' : m.mask === 'cut-right' ? 'cut-left' : m.mask;
      const treatment = m.treatment?.scrim ? { ...m.treatment, scrim: { ...m.treatment.scrim, angle: mirrorAngle(m.treatment.scrim.angle) } } : m.treatment;
      return { ...m, box: mirrorBox(m.box), ...(m.focus ? { focus: [1 - m.focus[0], m.focus[1]] as [number, number] } : {}), ...(mask ? { mask } : {}), ...(treatment ? { treatment } : {}) };
    }
    case 'text':
      // reading flow stays left-to-right: right-aligned text that moves to the left edge becomes left-aligned
      return { ...m, box: mirrorBox(m.box), align: m.align === 'right' ? 'left' : m.align };
    case 'logo':
      return { ...m, box: mirrorBox(m.box), align: m.align === 'left' ? 'right' : m.align === 'right' ? 'left' : 'center' };
    case 'button':
      return { ...m, box: mirrorBox(m.box), fill: mirrorPaint(m.fill)! };
    default:
      return { ...m, box: mirrorBox(m.box), ...('fill' in m && m.fill ? { fill: mirrorPaint(m.fill) } : {}) } as Layer;
  }
}

const TEXTUAL = (l: Layer) => l.type === 'text' || l.type === 'button';
/** a gradient that fades out (a scrim), not a solid panel: it is never cut into a box (compact) and a text group on it does not move away from it */
const fadingPaint = (l: Layer) => {
  const p = 'fill' in l ? (l.fill as Paint | undefined) : undefined;
  return !!p && typeof p !== 'string' && Math.min(...p.gradient.stops.map((x) => x.opacity ?? 1)) < 0.5;
};

/** The smallest decorative panel that holds most (60%+) of a text box: the card or band the text is set on. */
function panelOf(layers: Layer[], idx: number): Layer | null {
  const tb = boundsOf(layers[idx]);
  if (!tb) return null;
  let best: { l: Layer; a: number } | null = null;
  for (let i = 0; i < idx; i++) {
    const l = layers[i];
    if (!DECOR.has(l.type) || l.type === 'fill' || l.type === 'line' || l.type === 'pattern' || opacityOf(l) < 0.5) continue;
    const b = boundsOf(l)!;
    if (inter(b, tb) >= area(tb) * 0.6 && (!best || area(b) < best.a)) best = { l, a: area(b) };
  }
  return best?.l ?? null;
}

/**
 * After mirroring, text set on a card keeps the SAME left inset inside its (mirrored) card: a left-aligned text box is often wider than the
 * card on its right side (harmless as designed), and a plain mirror would push that excess out over the left edge of the card.
 */
function keepTextInPanels(original: Layer[], mirrored: Layer[]): Layer[] {
  return mirrored.map((m, i) => {
    if (!TEXTUAL(m) || !('box' in m)) return m;
    const o = original[i] as Extract<Layer, { type: 'text' | 'button' }>;
    const po = panelOf(original, i);
    const pm = panelOf(mirrored, i);
    if (!po || !pm) return m;
    const pob = boundsOf(po)!;
    const pmb = boundsOf(pm)!;
    const inset = Math.max(0.02, o.box[0] - pob.x);
    const x = pmb.x + inset;
    const w = Math.min(o.box[2], pmb.x + pmb.w - x - Math.min(inset, 0.06));
    return w > 0.05 ? ({ ...m, box: [x, m.box[1], w, m.box[3]] } as Layer) : m;
  });
}

/** The parts of a flattened template the variants work with. */
function anatomy(t: TemplateDef, copy: ContentProfile['copy']) {
  const heroIdx = t.layers.findIndex((l) => l.type === 'image' && l.slot === 'hero');
  const hero = heroIdx >= 0 ? (t.layers[heroIdx] as Extract<Layer, { type: 'image' }>) : null;
  const shown = (l: Layer) => (l.type === 'text' ? !!copy[l.slot]?.trim() : l.type === 'button' ? !!copy.cta?.trim() : true);
  const texts = t.layers.filter((l) => TEXTUAL(l) && shown(l));
  const textRects = texts.map((l) => boundsOf(l)!);
  const carries = (l: Layer) => {
    const b = boundsOf(l);
    return !!b && textRects.some((tr) => inter(b, tr) >= area(tr) * 0.6);
  };
  return { heroIdx, hero, texts, textRects, carries, group: union(textRects) };
}

/** Panels and bands that carry the text shrink to it; stripes are shortened; a whole-picture veil becomes a local gradient behind the text. */
function compactLayers(t: TemplateDef, copy: ContentProfile['copy']): Layer[] | null {
  const a = anatomy(t, copy);
  if (!a.hero || !a.group) return null;
  const heroR = boundsOf(a.hero)!;
  if (inter(a.group, heroR) < area(a.group) * 0.3) return null; // the text does not sit on the picture: nothing to give back
  const pad = 0.04;
  const gx0 = Math.max(0, a.group.x - pad);
  const gx1 = Math.min(1, a.group.x + a.group.w + pad);
  let changed = false;
  const layers = t.layers.map((l, i) => {
    if (i <= a.heroIdx || !DECOR.has(l.type)) return l;
    const b = boundsOf(l)!;
    const wide = b.w >= 0.45;
    const thin = Math.min(b.w, b.h) <= 0.05;
    const carrier = a.carries(l);
    if (fadingPaint(l)) return l;
    if (l.type === 'fill' || (area(b) >= 0.6 && !carrier && l.type === 'rect')) {
      // a veil over the whole picture: kept only as a band behind the text (a local gradient), so the people show
      const g = a.group!;
      const y0 = Math.max(0, g.y - 0.12);
      const y1 = Math.min(1, g.y + g.h + 0.12);
      changed = true;
      const paint = l.type === 'fill' ? l.fill : (l as Extract<Layer, { type: 'rect' }>).fill;
      return { id: l.id, type: 'rect', box: [0, y0, 1, y1 - y0], ...(paint ? { fill: paint } : {}), ...(l.opacity !== undefined ? { opacity: l.opacity } : {}) } as Layer;
    }
    if (!(wide && (carrier || thin))) return l;
    changed = true;
    if (l.type === 'polygon') return { ...l, points: l.points.map(([x, y]) => [Math.min(gx1, Math.max(gx0, x)), y] as [number, number]) };
    if (l.type === 'line') return { ...l, from: [Math.min(gx1, Math.max(gx0, l.from[0])), l.from[1]] as [number, number], to: [Math.min(gx1, Math.max(gx0, l.to[0])), l.to[1]] as [number, number] };
    const bx = 'box' in l ? l.box : null;
    if (!bx) return l;
    const x0 = Math.max(bx[0], gx0);
    const x1 = Math.min(bx[0] + bx[2], gx1);
    return x1 - x0 > 0.02 ? ({ ...l, box: [x0, bx[1], x1 - x0, bx[3]] } as Layer) : l;
  });
  return changed ? layers : null;
}

/** The text group (with the panels that carry it and the accents next to it) moves to the top or the bottom of a picture-led layout. */
function shiftLayers(t: TemplateDef, copy: ContentProfile['copy'], to: 'top' | 'bottom', safe: { t: number; b: number }): Layer[] | null {
  const a = anatomy(t, copy);
  if (!a.hero || !a.group) return null;
  const heroR = boundsOf(a.hero)!;
  if (area(heroR) < 0.6 || a.group.h > 0.55) return null; // only for picture-led layouts with a compact text group
  // text set on a fading scrim stays on it (moving the text away would leave it on the bare picture and the scrim on nothing)
  if (t.layers.some((l, i) => i > a.heroIdx && fadingPaint(l) && a.carries(l))) return null;
  const dy = to === 'top' ? safe.t + 0.01 - a.group.y : safe.b - 0.01 - (a.group.y + a.group.h);
  if (Math.abs(dy) < 0.06) return null;
  const near = { x: a.group.x - 0.06, y: a.group.y - 0.06, w: a.group.w + 0.12, h: a.group.h + 0.12 };
  const moves = (l: Layer, i: number) => TEXTUAL(l) || (i > a.heroIdx && DECOR.has(l.type) && l.type !== 'fill' && (() => {
    const b = boundsOf(l)!;
    return area(b) < 0.6 && (a.carries(l) || inter(b, near) >= area(b) * 0.7);
  })());
  const moved = { ...a.group, y: a.group.y + dy };
  return t.layers.map((l, i) => {
    if (l.type === 'logo') {
      const b = boundsOf(l)!;
      // the logo makes way: it goes to the opposite edge when the text group would meet it
      return inter(b, moved) > 0 ? ({ ...l, box: [l.box[0], 1 - l.box[1] - l.box[3], l.box[2], l.box[3]], valign: l.valign === 'top' ? 'bottom' : l.valign === 'bottom' ? 'top' : l.valign } as Layer) : l;
    }
    if (!moves(l, i)) return l;
    if (l.type === 'polygon') return { ...l, points: l.points.map(([x, y]) => [x, y + dy] as [number, number]) };
    if (l.type === 'line') return { ...l, from: [l.from[0], l.from[1] + dy] as [number, number], to: [l.to[0], l.to[1] + dy] as [number, number] };
    if ('box' in l) return { ...l, box: [l.box[0], l.box[1] + dy, l.box[2], l.box[3]] } as Layer;
    return l;
  });
}

const PANEL_TYPES = new Set(['rect', 'polygon', 'ellipse']);
const clipUnit = (r: R): R => {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  return { x: x0, y: y0, w: Math.max(0, Math.min(1, r.x + r.w) - x0), h: Math.max(0, Math.min(1, r.y + r.h) - y0) };
};

/**
 * EMPTY PANELS: opaque coloured panels of at least 6% of the canvas that carry (almost) nothing - no shown text, no picture, no card drawn on
 * them; a logo counts for half its area. A yellow block with only a small brand name in it is the typical case. "share" is the empty part as a
 * share of the canvas. Backgrounds (85%+ of the canvas) and fills are not panels.
 */
export function emptyPanels(t: TemplateDef, copy: ContentProfile['copy']): { id: string; index: number; share: number; edge: boolean; box: R; type: string }[] {
  const a = anatomy(t, copy);
  const out: { id: string; index: number; share: number; edge: boolean; box: R; type: string }[] = [];
  t.layers.forEach((l, i) => {
    if (!PANEL_TYPES.has(l.type) || opacityOf(l) < 0.5 || fadingPaint(l)) return;
    const b = clipUnit(boundsOf(l)!);
    const A = area(b);
    if (A < 0.06 || A > 0.85) return;
    const later = t.layers.slice(i + 1);
    const cards = later.filter((x) => PANEL_TYPES.has(x.type) && opacityOf(x) >= 0.5).map((x) => clipUnit(boundsOf(x)!)).filter((r) => area(r) >= 0.01 && area(r) < A * 0.95);
    const pictures = later.filter((x) => x.type === 'image').map((x) => clipUnit(boundsOf(x)!));
    const logos = t.layers.filter((x) => x.type === 'logo').map((x) => clipUnit(boundsOf(x)!));
    const content = [...a.textRects.map(clipUnit), ...pictures, ...cards].reduce((sum, r) => sum + inter(b, r), 0) + logos.reduce((sum, r) => sum + inter(b, r) * 0.5, 0);
    const filled = Math.min(1, content / A);
    if (filled >= 0.2) return;
    const edge = b.x <= 0.005 || b.y <= 0.005 || b.x + b.w >= 0.995 || b.y + b.h >= 0.995;
    out.push({ id: l.id, index: i, share: Math.round(A * (1 - filled) * 1000) / 1000, edge, box: b, type: l.type });
  });
  return out;
}

/**
 * STRUCTURED ZONES: three or more cards of the same size set in a row or a column (steps, feature tiles, rows of a list). A card is FILLED when
 * a shown text, the button, a picture or the logo sits in it, or when it carries an icon (two or more small shapes); otherwise it is empty.
 * A group with two or more empty cards looks like an unfinished placeholder on a mobile visual.
 */
export function structuredZones(t: TemplateDef, copy: ContentProfile['copy']): { ids: string[]; empty: string[] }[] {
  const a = anatomy(t, copy);
  const cards = t.layers
    .map((l, i) => ({ l, i, b: l.type === 'rect' ? clipUnit(boundsOf(l)!) : null }))
    .filter((x): x is { l: Layer; i: number; b: R } => !!x.b && area(x.b) >= 0.004 && area(x.b) <= 0.15);
  const groups: (typeof cards)[] = [];
  for (const c of cards) {
    const g = groups.find((gr) => {
      const f = gr[0].b;
      const same = Math.abs(f.w - c.b.w) / f.w < 0.15 && Math.abs(f.h - c.b.h) / f.h < 0.15;
      const aligned = Math.abs(f.x - c.b.x) < 0.02 || Math.abs(f.y - c.b.y) < 0.02;
      return same && aligned;
    });
    if (g) g.push(c);
    else groups.push([c]);
  }
  const content = [...a.textRects, ...t.layers.filter((l) => l.type === 'image' || l.type === 'logo').map((l) => boundsOf(l)!)];
  const smalls = t.layers.filter((l) => DECOR.has(l.type) && l.type !== 'fill' && l.type !== 'line' && l.type !== 'pattern').map((l) => ({ id: l.id, b: boundsOf(l)! }));
  return groups
    .filter((g) => g.length >= 3)
    .map((g) => ({
      ids: g.map((c) => c.l.id),
      empty: g
        .filter((c) => {
          if (content.some((r) => area(r) > 0 && inter(c.b, r) >= area(r) * 0.6)) return false;
          const icon = smalls.filter((x) => x.id !== c.l.id && area(x.b) > 0 && area(x.b) < area(c.b) * 0.5 && inter(c.b, x.b) >= area(x.b) * 0.8).length;
          return icon < 2;
        })
        .map((c) => c.l.id),
    }));
}

/** A picture area that will show its fallback (a pattern or gradient) because there is no picture: a framed placeholder. Its share of the canvas. */
export function placeholderPictureShare(t: TemplateDef, profile: Pick<ContentProfile, 'picture'>): number {
  if (profile.picture) return 0;
  const hero = t.layers.find((l): l is Extract<Layer, { type: 'image' }> => l.type === 'image' && l.slot === 'hero');
  if (!hero || hero.fallback === 'none') return 0;
  const b = area(clipUnit(boundsOf(hero)!));
  return b < 0.9 ? b : 0;
}

/** The largest empty rectangular edge panel becomes a picture area (the logo and everything drawn after it stay on top). */
function photoPanelLayers(t: TemplateDef, profile: ContentProfile): Layer[] | null {
  const kind = profile.picture?.kind ?? 'photograph';
  if (!profile.picture || kind !== 'photograph' || t.layers.some((l) => l.type === 'image')) return null;
  const panel = emptyPanels(t, profile.copy).filter((x) => x.type === 'rect' && x.edge && area(x.box) >= 0.08).sort((x, y) => area(y.box) - area(x.box))[0];
  if (!panel) return null;
  const b = panel.box;
  const photo = { id: `${panel.id}-photo`.slice(0, 40), type: 'image', slot: 'hero', box: [b.x, b.y, b.w, b.h], fallback: 'none' } as Layer;
  return t.layers.map((l, i) => (i === panel.index ? photo : l));
}

/**
 * TEXT REFLOW: the space of EMPTY optional text slots (no date, no location, no support) between the shown texts of a column is given back: 70%
 * to the headline (a taller box and up to 30% larger type), the rest as air before the call to action. The first and the last shown element keep
 * their places, so the column still fits its card. Columns with rotated pieces are left as designed.
 */
export function reflowText(t: TemplateDef, copy: ContentProfile['copy'], W = 1080, H = 1080): TemplateDef {
  const hi = t.layers.findIndex((l) => l.type === 'text' && l.slot === 'headline');
  if (hi < 0) return t;
  const head = t.layers[hi] as Extract<Layer, { type: 'text' }>;
  if (head.rotate) return t;
  const hb = boundsOf(head)!;
  const shown = (l: Layer) => (l.type === 'text' ? !!copy[l.slot]?.trim() : l.type === 'button' ? !!copy.cta?.trim() : true);
  // the labels of a structured layout (point1..3) belong to their cards: they never move with the text column
  const column = t.layers
    .map((l, i) => ({ l, i, b: boundsOf(l) }))
    .filter((x) => TEXTUAL(x.l) && !(x.l.type === 'text' && /^point\d$/.test(x.l.slot)) && x.b && overlap1(x.b.x, x.b.x + x.b.w, hb.x, hb.x + hb.w) >= 0.5 * Math.min(x.b.w, hb.w));
  if (column.some((x) => x.l.rotate)) return t;
  // rows: elements that share their vertical band (a date next to a button) move together
  const sorted = [...column].sort((p, q) => p.b!.y - q.b!.y);
  const rows: { items: typeof column; y: number; h: number }[] = [];
  for (const x of sorted) {
    const row = rows.find((r) => overlap1(r.y, r.y + r.h, x.b!.y, x.b!.y + x.b!.h) > 0.5 * Math.min(r.h, x.b!.h));
    if (row) {
      row.items.push(x);
      const y1 = Math.max(row.y + row.h, x.b!.y + x.b!.h);
      row.y = Math.min(row.y, x.b!.y);
      row.h = y1 - row.y;
    } else rows.push({ items: [x], y: x.b!.y, h: x.b!.h });
  }
  const isShown = (r: (typeof rows)[number]) => r.items.some((x) => shown(x.l));
  const firstShown = rows.findIndex(isShown);
  let lastShown = -1;
  rows.forEach((r, i) => {
    if (isShown(r)) lastShown = i;
  });
  const headRow = rows.findIndex((r) => r.items.some((x) => x.i === hi));
  if (firstShown < 0 || headRow < 0 || lastShown <= headRow) return t;
  // the space of the empty rows between the headline and the last shown row (with the gap that followed each)
  let freed = 0;
  for (let i = headRow + 1; i < lastShown; i++) if (!isShown(rows[i])) freed += rows[i + 1].y - rows[i].y;
  if (freed < 0.04) return t;
  // the headline gets up to 30% larger type and only the height that type needs (estimated: greedy word wrap); the rest of the freed space goes
  // before the call to action, so the texts stay one group and the button keeps its place
  const k = Math.min(1.3, (hb.h + Math.min(freed * 0.7, panelRoom(t, hi, hb))) / hb.h);
  const sizePx = head.size.max * k * Math.min(W, H);
  const lines = linesAt(copy.headline ?? '', head, sizePx, W);
  const need = Number.isFinite(lines) ? (Math.min(lines, head.maxLines) * sizePx * (head.style.lineHeight ?? 1.15) * 1.06) / H : hb.h + freed * 0.7;
  // the headline never grows out of the panel that carries it (a headline on a colour block must not run over its edge)
  const room = panelRoom(t, hi, hb);
  const grow = Math.max(0, Math.min(freed * 0.7, need - hb.h, room));
  const air = freed - grow;
  const ctaRow = rows.findIndex((r, i) => i > headRow && r.items.some((x) => x.l.type === 'button' || (x.l.type === 'text' && x.l.slot === 'cta')));
  // the new top of each shown row after the headline: pulled up by the empty rows above it, pushed down by the headline's growth (and the air before the button)
  const shift = new Map<number, number>();
  let removed = 0;
  for (let i = headRow + 1; i <= lastShown; i++) {
    if (!isShown(rows[i])) {
      removed += rows[i + 1].y - rows[i].y;
      continue;
    }
    const dy = -removed + grow + (ctaRow >= 0 && i >= ctaRow ? air : 0);
    for (const x of rows[i].items) shift.set(x.i, dy);
  }
  const layers = t.layers.map((l, i) => {
    if (i === hi) {
      const h = l as Extract<Layer, { type: 'text' }>;
      return { ...h, box: [h.box[0], h.box[1], h.box[2], h.box[3] + grow], size: { max: Math.min(0.3, h.size.max * k), min: h.size.min } } as Layer;
    }
    const dy = shift.get(i);
    if (dy === undefined || !('box' in l)) return l;
    return { ...l, box: [l.box[0], l.box[1] + dy, l.box[2], l.box[3]] } as Layer;
  });
  return { ...t, layers };
}

const bottom = (r: R) => r.y + r.h;
/** The room below the headline inside the panel that carries it (Infinity when it is set on the canvas). */
function panelRoom(t: TemplateDef, hi: number, hb: R): number {
  const pnl = panelOf(t.layers, hi);
  return pnl ? Math.max(0, bottom(boundsOf(pnl)!) - 0.012 - (hb.y + hb.h)) : Infinity;
}

/** How many lines a text takes in a text layer at a font size (greedy word wrap, optimistic glyph width); Infinity when a word does not fit. */
function linesAt(text: string, l: Extract<Layer, { type: 'text' }>, sizePx: number, W: number): number {
  // optimistic glyph width (real fonts run narrower than the average): a box that turns out too small only makes the renderer set the type smaller
  const em = (EM[l.style.family] * (l.style.weight >= 700 ? 1.04 : 1) * (l.style.case === 'upper' ? 1.1 : 1) + (l.style.tracking ?? 0)) * 0.88;
  const per = (l.box[2] * W) / (sizePx * em);
  let lines = 1;
  let cur = 0;
  for (const w of (l.style.case === 'upper' ? text.toUpperCase() : text).split(/\s+/).filter(Boolean)) {
    if (w.length > per) return Infinity;
    if (cur === 0) cur = w.length;
    else if (cur + 1 + w.length <= per) cur += 1 + w.length;
    else {
      lines++;
      cur = w.length;
    }
  }
  return lines;
}

/** The variants of one (flattened) template that really change something for this content. */
export function variantsOf(flat: TemplateDef, profile: ContentProfile): { variant: VariantId; template: TemplateDef }[] {
  const fmt = Object.values(CREATIVE_FORMATS).find((f) => f.width === profile.width && f.height === profile.height);
  const safe = { t: fmt?.safe.top ?? 0.06, b: 1 - (fmt?.safe.bottom ?? 0.06) };
  const out: { variant: VariantId; template: TemplateDef }[] = [{ variant: 'base', template: flat }];
  const seen = new Set([JSON.stringify(flat.layers)]);
  const add = (variant: VariantId, layers: Layer[] | null) => {
    if (!layers) return;
    const key = JSON.stringify(layers);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ variant, template: { ...flat, layers } });
  };
  const mirrored = keepTextInPanels(flat.layers, flat.layers.map(mirrorLayer));
  add('mirror', mirrored);
  add('compact', compactLayers(flat, profile.copy));
  add('mirror+compact', compactLayers({ ...flat, layers: mirrored }, profile.copy));
  for (const to of ['top', 'bottom'] as const) {
    const shifted = shiftLayers(flat, profile.copy, to, safe);
    add(to, shifted);
    if (shifted) add(`${to}+compact`, compactLayers({ ...flat, layers: shifted }, profile.copy));
  }
  // the whole photograph instead of a crop: only for people photos whose border is calm (the letterbox continues it naturally)
  const s = profile.picture?.subject;
  if (s && !s.graphic && s.faces.length && calmBorder(s)) add('contain', flat.layers.map((l) => (l.type === 'image' && l.slot === 'hero' ? { ...l, fit: 'contain' as const } : l)));
  // an empty colour panel of a typography-first template: the approved photograph fills it instead
  add('photo-panel', photoPanelLayers(flat, profile));
  return out.filter((v) => VARIANTS.includes(v.variant));
}

/** The picture's outer ring of cells is calm (a studio wall, sky, a plain backdrop): a letterbox in its border colour will look continuous. */
function calmBorder(s: Pick<SubjectMap, 'busy'>): boolean {
  const { cols, rows, cells } = s.busy;
  if (!cells.length) return false;
  const ring: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) ring.push(cells[r * cols + c]);
  return ring.reduce((a, v) => a + v, 0) / ring.length < 0.18;
}

// ---- prediction and scoring ----------------------------------------------------------------------------------------------------------------

const EM: Record<FontFamily, number> = { sans: 0.54, serif: 0.52, display: 0.56, condensed: 0.46, mono: 0.6 };

/** Whether a text fits its box (greedy word wrap with an average glyph width): 1 = at a comfortable size, 0.6 = only near the minimum, 0 = no. */
export function textFitEstimate(text: string, l: Extract<Layer, { type: 'text' }>, W: number, H: number): number {
  const unit = Math.min(W, H);
  const words = (l.style.case === 'upper' ? text.toUpperCase() : text).split(/\s+/).filter(Boolean);
  const em = EM[l.style.family] * (l.style.weight >= 700 ? 1.04 : 1) * (l.style.case === 'upper' ? 1.1 : 1) + (l.style.tracking ?? 0);
  const boxW = l.box[2] * W;
  const boxH = l.box[3] * H;
  const lh = l.style.lineHeight ?? 1.15;
  const fitsAt = (size: number) => {
    const per = boxW / (size * em);
    let lines = 1;
    let cur = 0;
    for (const w of words) {
      const len = w.length;
      if (len > per) return false;
      if (cur === 0) cur = len;
      else if (cur + 1 + len <= per) cur += 1 + len;
      else {
        lines++;
        cur = len;
      }
    }
    return lines <= l.maxLines && lines * size * lh <= boxH * 1.02;
  };
  const max = l.size.max * unit;
  const min = Math.min(l.size.min, l.size.max) * unit;
  if (fitsAt((max + min) / 2)) return 1;
  if (fitsAt(min)) return 0.6;
  return 0;
}

const KIND_WEIGHT: Record<string, Partial<Record<'logo' | 'fit' | 'space' | 'faces', number>>> = {
  billboard: { logo: 1.5, fit: 1.5, space: 1.3 },
  flyer: { fit: 1.2 },
  web_ad: { fit: 1.3, logo: 1.2 },
  display_ad: { fit: 1.2 },
};

/**
 * Scores ONE composition against the content. Hard failures are listed separately; the score is a weighted sum of simple 0..1 measures:
 * subject visibility, clear faces, negative space under the text, text fit, logo size, crop quality, overlay intrusion, balance, identity and
 * layout diversity.
 */
export function scoreComposition(t: TemplateDef, variant: VariantId, profile: ContentProfile, ctx: CompositionContext = {}): Composition {
  const W = profile.width;
  const H = profile.height;
  const hard: string[] = [];
  const reasons: string[] = [];
  const kw = KIND_WEIGHT[profile.kind ?? ''] ?? {};
  const a = anatomy(t, profile.copy);
  const px = (r: R): R => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const textPx = a.textRects.map(px);
  const decorAfter = t.layers
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => a.heroIdx >= 0 && i > a.heroIdx && DECOR.has(l.type))
    .map(({ l }) => ({ id: l.id, r: px(boundsOf(l)!), op: opacityOf(l), carrier: a.carries(l) }));
  const pic = profile.picture;
  let crop: CropPlan | null = null;
  let faces: { r: R; inFrame: number; area: number }[] = [];
  let subjR: R | null = null;
  let subjInFrame = 1;
  let heroR: R | null = null;

  // ---- the picture: where the people land after the crop --------------------------------------------------------------------------------------
  if (a.hero && pic) {
    heroR = px(boxR(a.hero.box));
    const bw = Math.max(2, Math.round(heroR.w));
    const bh = Math.max(2, Math.round(heroR.h));
    const s = pic.subject;
    crop = planCrop({ imgW: pic.w, imgH: pic.h, bw, bh, focus: pic.focus ?? a.hero.focus ?? [0.5, 0.5], layerRect: heroR, canvasW: W, canvasH: H, subject: s ? { faces: s.faces, subject: s.subject, graphic: s.graphic } : undefined, fit: a.hero.fit });
    const toCanvas = (b: UnitBox): R => {
      const lx = b[0] * crop!.sw + (crop!.fit === 'contain' ? crop!.left : -crop!.left);
      const ly = b[1] * crop!.sh + (crop!.fit === 'contain' ? crop!.top : -crop!.top);
      return { x: heroR!.x + lx, y: heroR!.y + ly, w: b[2] * crop!.sw, h: b[3] * crop!.sh };
    };
    const visible = { x: Math.max(0, heroR.x), y: Math.max(0, heroR.y), w: Math.min(W, heroR.x + heroR.w) - Math.max(0, heroR.x), h: Math.min(H, heroR.y + heroR.h) - Math.max(0, heroR.y) };
    if (s) {
      faces = s.faces.map((f) => {
        const r = toCanvas(f);
        return { r, area: area(r), inFrame: area(r) ? inter(r, visible) / area(r) : 0 };
      });
      subjR = toCanvas(s.subject);
      subjInFrame = area(subjR) ? inter(subjR, visible) / area(subjR) : 1;
    }
    if (s?.graphic && crop.fit === 'cover' && crop.cropLoss > 0.04) hard.push('graphic_crop: the brand graphic would be cropped');
  } else if (a.hero && !pic && t.requires.includes('image')) hard.push('template_fit: the template needs a picture');
  if (pic && t.layers.some((l) => l.type === 'image' && l.slot === 'secondary') && !profile.hasSecondPicture) hard.push('template_fit: a second picture area would stay an empty placeholder');
  // ---- the kind of picture this composition accepts: text over a picture needs a photograph; a framed area also takes a screenshot or an illustration
  if (a.hero && pic) {
    const kind = pic.kind ?? 'photograph';
    const accepts = heroAccepts(t, profile.copy);
    if (!accepts.includes(kind)) hard.push(`asset_fit: a ${kind.replace(/_/g, ' ')} cannot be this layout's picture (${NEVER_A_PICTURE.has(kind) ? 'it carries its own text and mark' : 'text would be written over it'})`);
  }

  // ---- faces: whole, not cut, not under text or an opaque panel -----------------------------------------------------------------------------
  const maxFace = Math.max(0, ...faces.map((f) => f.area));
  const key = faces.filter((f) => f.area >= maxFace * 0.3);
  const shown = key.filter((f) => f.inFrame >= 0.5);
  let faceClear = 1;
  if (key.length) {
    if (key.some((f) => f.inFrame > 0.15 && f.inFrame < 0.85)) hard.push('face_crop: a face would be cut by the frame');
    if (!key.some((f) => f.area >= maxFace * 0.85 && f.inFrame >= 0.85)) hard.push('face_crop: none of the most prominent people would be fully in the frame');
    const logoPx = t.layers.filter((l) => l.type === 'logo').map((l) => px(boundsOf(l)!));
    if (shown.some((f) => [...textPx, ...logoPx].some((tr) => inter(tr, f.r) > f.area * 0.12))) hard.push('face_occlusion: text or the logo would sit on a face');
    if (shown.some((f) => decorAfter.some((d) => d.carrier && d.op >= 0.6 && inter(d.r, f.r) > f.area * 0.25))) hard.push('face_occlusion: a text panel would cover a face');
    const cover = shown.map((f) => Math.min(1, decorAfter.filter((d) => !d.carrier).reduce((s, d) => s + (inter(d.r, f.r) / f.area) * d.op, 0)));
    faceClear = shown.length ? 1 - cover.reduce((s, v) => s + v, 0) / shown.length : 1;
    const tallest = Math.max(...key.map((f) => f.r.h)) / H;
    const share = subjR ? (inter(subjR, { x: 0, y: 0, w: W, h: H }) * subjInFrame) / (W * H) : 0;
    if (share < 0.1 && tallest < 0.06) hard.push('subject_size: the people would be a thumbnail');
  }
  // ---- the subject: how much of it stays free of decoration and text -----------------------------------------------------------------------
  // a composition that does not draw the approved picture is neither good nor bad at showing it: its picture measures are neutral
  const drawsNoPicture = !!pic && !a.hero;
  if (drawsNoPicture) faceClear = 0.5;
  let subjVis = drawsNoPicture ? 0.5 : 1;
  if (subjR && area(subjR)) {
    const covered = Math.min(1, [...decorAfter.map((d) => (inter(d.r, subjR!) / area(subjR!)) * d.op), ...textPx.map((tr) => (inter(tr, subjR!) / area(subjR!)) * 0.8)].reduce((s, v) => s + v, 0));
    subjVis = subjInFrame * (1 - covered);
    if (subjInFrame < 0.6) reasons.push(`only ${Math.round(subjInFrame * 100)}% of the subject in the frame`);
  }

  // ---- text: does it fit, does it sit on calm picture, on a panel or on a plain field ---------------------------------------------------------
  const headline = a.texts.find((l): l is Extract<Layer, { type: 'text' }> => l.type === 'text' && l.slot === 'headline');
  const fit = headline ? textFitEstimate(profile.copy.headline, headline, W, H) : 0;
  // an adapted layout must keep every text block on its own card (the designed one may overhang on purpose)
  if (variant !== 'base') {
    for (let i = 0; i < t.layers.length; i++) {
      const l = t.layers[i];
      if (!TEXTUAL(l) || !a.texts.includes(l)) continue;
      const pnl = panelOf(t.layers, i);
      if (pnl && inter(boundsOf(pnl)!, boundsOf(l)!) < area(boundsOf(l)!) * 0.97) {
        hard.push('text_safe_area: a text block would run off its panel');
        break;
      }
    }
  }
  if (!headline) hard.push('text_fit: no headline area');
  else if (fit === 0) hard.push('text_fit: the headline would not fit without being cut');
  let space = 0.9;
  let textOver: Composition['predicted']['textOver'] = 'plain';
  if (heroR && pic?.subject && crop) {
    const scores: number[] = [];
    for (const tr of textPx) {
      if (inter(tr, heroR) < area(tr) * 0.5) continue;
      if (decorAfter.some((d) => d.op >= 0.75 && inter(d.r, tr) >= area(tr) * 0.6)) {
        scores.push(0.85);
        textOver = textOver === 'picture' ? 'picture' : 'panel';
        continue;
      }
      textOver = 'picture';
      // the text rectangle in picture fractions, through the crop
      const ox = crop.fit === 'contain' ? crop.left : -crop.left;
      const oy = crop.fit === 'contain' ? crop.top : -crop.top;
      const src: UnitBox = [(tr.x - heroR.x - ox) / crop.sw, (tr.y - heroR.y - oy) / crop.sh, tr.w / crop.sw, tr.h / crop.sh];
      const scrimHelps = decorAfter.some((d) => d.op >= 0.35 && inter(d.r, tr) >= area(tr) * 0.6);
      scores.push(Math.min(1, 1 - busyIn(pic.subject, src) + (scrimHelps ? 0.25 : 0)));
    }
    if (scores.length) space = scores.reduce((s, v) => s + v, 0) / scores.length;
  }

  // ---- logo: how large the mark can be in its box ---------------------------------------------------------------------------------------------
  const logoL = t.layers.find((l): l is Extract<Layer, { type: 'logo' }> => l.type === 'logo');
  let logoScore = 0.7;
  let logoPx: number | null = null;
  if (logoL && profile.logo) {
    const b = px(boxR(logoL.box));
    const k = Math.min(b.w / profile.logo.w, b.h / profile.logo.h);
    logoPx = Math.sqrt(profile.logo.w * k * profile.logo.h * k);
    const need = 0.07 * Math.min(W, H);
    // the preflight can enlarge a logo up to 2.6 times inside the safe area: what even that cannot reach is a hard problem
    if (logoPx * 2.6 < need) hard.push('logo_visibility: the logo area is far too small');
    logoScore = Math.min(1, logoPx / need);
  } else if (!logoL && profile.logo) {
    logoScore = 0.3;
    reasons.push('no logo area');
  }

  // ---- overlays, crop, balance ---------------------------------------------------------------------------------------------------------------
  const intrusion = heroR ? Math.min(1, decorAfter.filter((d) => d.op >= 0.4).reduce((s, d) => s + inter(d.r, heroR!) / Math.max(1, area(heroR!)), 0)) : 0;
  const cropQ = crop ? (crop.fit === 'contain' ? (pic?.subject?.graphic ? 1 : 0.6) : 1 - crop.cropLoss * 0.5) : drawsNoPicture ? 0.5 : 0.8;
  const group = union(textPx);
  let balance = 0.6;
  if (group && subjR) {
    const dx = Math.abs(group.x + group.w / 2 - (subjR.x + subjR.w / 2)) / W;
    const dy = Math.abs(group.y + group.h / 2 - (subjR.y + subjR.h / 2)) / H;
    balance = Math.min(1, (dx + dy) / 0.35);
  }
  // PRESENCE: people shown large read better than the same people small (a letterbox or a tile shrinks them)
  const presence = subjR ? Math.min(1, (inter(subjR, { x: 0, y: 0, w: W, h: H }) * subjInFrame) / (W * H) / 0.3) : drawsNoPicture ? 0.3 : 0.6;
  // the call to action must fit its button (the renderer may widen it a little into free space, never cut it)
  const btn = t.layers.find((l): l is Extract<Layer, { type: 'button' }> => l.type === 'button');
  let ctaFit = 1;
  if (btn && profile.copy.cta?.trim()) {
    const unit = Math.min(W, H);
    const need = profile.copy.cta.length * EM[btn.style.family] * btn.size.min * unit * (btn.style.case === 'upper' ? 1.1 : 1) + Math.min(btn.box[3] * H * 0.84, btn.size.max * unit * 2.2);
    ctaFit = need <= btn.box[2] * W ? 1 : need <= btn.box[2] * W * 1.5 ? 0.6 : 0;
    if (!ctaFit) reasons.push('the call to action is long for this button');
  }
  const identity = variant === 'base' ? 1 : variant === 'mirror' ? 0.92 : variant === 'contain' ? 0.8 : variant === 'photo-panel' ? 0.85 : variant.includes('compact') && variant !== 'compact' ? 0.78 : 0.85;
  const prefIdx = ctx.preferred?.indexOf(t.id) ?? -1;
  const preference = prefIdx < 0 ? 0 : Math.max(0, 0.06 - prefIdx * 0.015);
  const usedV = ctx.used?.get(t.id);
  // print is delivered twice and must look different twice: the same template counts more there than in a feed
  const print = profile.kind === 'billboard' || profile.kind === 'flyer';
  // a variant that only differs by a compacted panel LOOKS like the same layout: it counts as a repeat
  // a MIRRORED, compacted or shifted copy of a layout already used in this channel is the same creative direction, not a new one
  const repeat = !!usedV;
  const diversity = usedV ? -0.8 : ctx.usedFamilies?.has(t.family) ? (print ? -0.1 : -0.05) : 0;
  if (usedV) reasons.push(`this layout is already used in this ${print ? 'print series' : 'channel'} (a ${variant} copy of it is not a new design)`);
  void repeat;
  // PHOTO FIRST: an approved photograph that the composition leaves out costs more on a fast-scroll format, where it is a hard problem
  const isPhoto = !!pic && (pic.kind ?? 'photograph') === 'photograph';
  const photoFree = pic && !a.hero ? (profile.fastScroll && isPhoto ? -0.5 : -0.25) : 0;
  if (photoFree) reasons.push('photo-free design: the approved picture would not be shown');
  if (profile.fastScroll && isPhoto && !a.hero) hard.push('photo_first: a fast-scroll format must show its approved photograph');
  // EMPTY PANELS: a large coloured block that carries nothing (or only the logo) wastes the canvas
  const empty = emptyPanels(t, profile.copy);
  const emptyShare = empty.reduce((sum, e) => sum + e.share, 0);
  const emptyPenalty = -Math.min(0.6, emptyShare * 1.6);
  if (emptyShare >= 0.05) reasons.push(`empty panel: ${Math.round(emptyShare * 100)}% of the canvas is a coloured block with nothing on it`);
  // FAST SCROLL: the headline may lead, but type that fills the frame leaves no room for the picture to stop the thumb
  const headShare = headline ? area(clipUnit(boundsOf(headline)!)) : 0;
  const textDominance = profile.fastScroll && headShare > 0.3 ? -Math.min(0.4, (headShare - 0.3) * 1.5) : 0;
  if (textDominance) reasons.push(`the headline area covers ${Math.round(headShare * 100)}% of a fast-scroll format`);
  const presenceWeight = profile.fastScroll ? 0.3 : 0.12;
  // CONTENT DENSITY by medium: a TikTok/story/portrait social visual must look finished (empty cards, rows or steps and a picture area showing
  // only its placeholder pattern read as unfinished); a feed post is the middle ground; print and web ads may stay sparse
  const cls = formatClassOf(W, H);
  const social = (profile.kind ?? 'social_post') === 'social_post';
  const mobile = social && (cls === 'story' || cls === 'portrait');
  const densityWeight = profile.fastScroll || mobile ? 1 : social ? 0.45 : profile.kind === 'billboard' ? 0 : 0.15;
  const zones = structuredZones(t, profile.copy);
  const emptyCards = zones.reduce((n, z) => n + (z.empty.length >= 2 ? z.empty.length : 0), 0);
  const filledCards = zones.reduce((n, z) => n + (z.ids.length - z.empty.length), 0);
  let densityScore = 0;
  if (emptyCards) {
    reasons.push(`${emptyCards} card(s)/row(s) of the layout would stay empty`);
    densityScore -= Math.min(0.5, 0.15 * emptyCards) * densityWeight;
    if (profile.fastScroll || mobile) hard.push('structure_empty: the cards, rows or steps of this layout would stay empty on a mobile visual');
  } else if (filledCards >= 3 && (profile.fastScroll || mobile)) densityScore += 0.08;
  const placeholder = placeholderPictureShare(t, profile);
  if (placeholder >= 0.12) {
    reasons.push(`a picture area of ${Math.round(placeholder * 100)}% would show only its placeholder pattern`);
    densityScore -= Math.min(0.4, placeholder) * densityWeight;
    if (profile.fastScroll || mobile) hard.push('placeholder_picture: a picture area without a picture would look unfinished on a mobile visual');
  }
  // CONTENT FIT (content-aware spacing, predicted): a template drawn for more copy than the concept has leaves accidental empty space between
  // related elements. When the spacing repair can regroup it the template stays a good choice (small cost); when it cannot, another layout wins.
  const gaps = spacingIssues(predictedScene(t, profile), { kind: profile.kind ?? null, fastScroll: !!profile.fastScroll, density: t.density });
  let spacingScore = 0;
  if (gaps.length) {
    const sw = profile.fastScroll || mobile ? 1 : social ? 0.8 : 0.6;
    const fixable = gaps.every((g) => g.fix);
    spacingScore = -(fixable ? 0.03 : 0.12) * sw;
    reasons.push(`the copy leaves ${Math.round(gaps[0].gap * 100)}% of the height as accidental empty space${fixable ? ' (the spacing will be regrouped)' : ' (no regrouping fits: another layout suits this amount of content better)'}`);
  }
  // FAST SCROLL: how much of the frame the photograph fills (a full-bleed cover beats a small tilted card)
  const pictureShare = heroR ? inter(heroR, { x: 0, y: 0, w: W, h: H }) / (W * H) : 0;
  const pictureFill = profile.fastScroll && isPhoto ? 0.3 * pictureShare : 0;

  const score =
    0.2 * subjVis +
    0.15 * faceClear * (kw.faces ?? 1) +
    0.15 * space * (kw.space ?? 1) +
    0.1 * fit * (kw.fit ?? 1) +
    0.1 * logoScore * (kw.logo ?? 1) +
    0.1 * cropQ +
    0.1 * (1 - intrusion) +
    0.05 * balance +
    presenceWeight * presence +
    0.08 * (ctaFit - 1) +
    0.05 * identity +
    preference +
    diversity +
    photoFree +
    emptyPenalty +
    textDominance +
    pictureFill +
    densityScore +
    spacingScore;
  reasons.unshift(
    `subject ${Math.round(subjVis * 100)}% visible, faces ${Math.round(faceClear * 100)}% clear, text on ${textOver === 'picture' ? `calm picture ${Math.round(space * 100)}%` : textOver}, headline fit ${fit === 1 ? 'comfortable' : fit ? 'tight' : 'no'}, overlays cover ${Math.round(intrusion * 100)}% of the picture`,
  );
  return {
    templateId: t.id,
    family: t.family,
    variant,
    template: t,
    score: Math.round(score * 1000) / 1000,
    hard,
    reasons,
    predicted: { crop: crop ? { fit: crop.fit, zoom: crop.zoom, cropLoss: Math.round(crop.cropLoss * 1000) / 1000 } : null, facesWhole: key.filter((f) => f.inFrame >= 0.85).length, facesTotal: key.length, textOver, logoPx: logoPx === null ? null : Math.round(logoPx) },
  };
}

/** Where a text would be drawn in its box (greedy wrap at the largest size that fits): the PREDICTED ink, as fractions. */
function predictInk(text: string, l: Extract<Layer, { type: 'text' }>, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const unit = Math.min(W, H);
  const [bx, by, bw, bh] = l.box;
  const lh = l.style.lineHeight ?? 1.15;
  const max = l.size.max * unit;
  const min = Math.min(l.size.min, l.size.max) * unit;
  let inkH = bh;
  for (let i = 0; i <= 10; i++) {
    const size = max - ((max - min) * i) / 10;
    const lines = linesAt(text, l, size, W);
    if (Number.isFinite(lines) && lines <= l.maxLines && lines * size * lh <= bh * H * 1.02) {
      inkH = Math.min(bh, (lines * size * lh + size * 0.2) / H);
      break;
    }
  }
  const y = l.valign === 'bottom' ? by + bh - inkH : l.valign === 'middle' ? by + (bh - inkH) / 2 : by;
  return { x: bx, y, w: bw, h: inkH };
}

/** The composition as the renderer would draw it, predicted from the layers and the copy (for the spacing estimate before rendering). */
export function predictedScene(t: TemplateDef, profile: ContentProfile): SpacingScene {
  const W = profile.width;
  const H = profile.height;
  const fmt = Object.values(CREATIVE_FORMATS).find((f) => f.width === W && f.height === H);
  const items: SpacingScene['items'] = [];
  const empty: SpacingScene['empty'] = [];
  const decor: SpacingScene['decor'] = [];
  let picture: SpacingScene['picture'] = null;
  for (const l of t.layers) {
    if (l.rotate) continue;
    if (l.type === 'text') {
      const text = profile.copy[l.slot]?.trim();
      if (/^point\d$/.test(l.slot)) continue;
      if (!text) {
        if (l.optional && l.slot !== 'headline') empty.push(boxR(l.box));
        continue;
      }
      items.push({ id: l.id, kind: 'text', slot: l.slot, ink: predictInk(text, l, W, H), box: boxR(l.box), valign: l.valign });
    } else if (l.type === 'button') {
      if (profile.copy.cta?.trim()) items.push({ id: l.id, kind: 'button', ink: boxR(l.box), box: boxR(l.box) });
    } else if (l.type === 'logo') items.push({ id: l.id, kind: 'logo', ink: boxR(l.box), box: boxR(l.box) });
    else if (l.type === 'image') {
      if (l.slot === 'hero' && (profile.picture || l.fallback !== 'none')) picture = boundsOf(l);
    } else if (DECOR.has(l.type) && l.type !== 'fill') decor.push({ id: l.id, type: l.type, r: boundsOf(l)!, opacity: opacityOf(l), gradient: fadingPaint(l) });
  }
  return { width: W, height: H, items, decor, picture, empty, safe: { t: fmt?.safe.top ?? 0.06, b: 1 - (fmt?.safe.bottom ?? 0.06) } };
}

/**
 * The picture kinds a template's hero area accepts: declared on the image layer (`accepts`), else inferred - a hero that text or the button is written
 * over takes a photograph or an illustration; a framed hero (nothing written over it) also takes a screenshot. Never a brand graphic or a logo.
 */
export function heroAccepts(t: TemplateDef, copy: ContentProfile['copy']): AssetKind[] {
  const a = anatomy(t, copy);
  if (!a.hero) return [];
  if (a.hero.accepts?.length) return a.hero.accepts.filter((k) => !NEVER_A_PICTURE.has(k));
  const heroR = boundsOf(a.hero)!;
  const over = a.textRects.some((tr) => inter(tr, heroR) > area(tr) * 0.15);
  return over ? ['photograph', 'illustration'] : ['photograph', 'screenshot', 'illustration'];
}

/** Whether a template can carry this content at all (its required slots and assets exist). */
function eligible(t: TemplateDef, profile: ContentProfile): boolean {
  if (t.status !== 'active' || !t.classes.includes(formatClassOf(profile.width, profile.height))) return false;
  // print writes its next step as a line (a billboard without a verified address has none): a template that needs a call to action still prints
  const print = profile.kind === 'billboard' || profile.kind === 'flyer';
  return t.requires.every((r) => (r === 'image' ? !!profile.picture : r === 'logo' ? !!profile.logo : r === 'cta' && print ? true : !!profile.copy[r]?.trim()));
}

/**
 * All compositions of the candidate templates for this content, best first: compositions WITHOUT hard failures by score, then the others by
 * the number of hard failures and score (so the best diagnostic result is still known when nothing passes). Bounded: at most 8 variants per
 * template, scored geometrically (no rendering).
 */
export function rankCompositions(templates: readonly TemplateDef[], profile: ContentProfile, ctx: CompositionContext = {}): Composition[] {
  const cls = formatClassOf(profile.width, profile.height);
  const out: Composition[] = [];
  for (const t of templates) {
    if (!eligible(t, profile)) continue;
    const flat = reflowText(mediaLayers(flattenFor(t, cls), profile.kind), profile.copy, profile.width, profile.height);
    const mine = variantsOf(flat, profile).map((v) => scoreComposition(v.template, v.variant, profile, ctx));
    // the whole picture letterboxed shrinks the people: it is only an option when every crop of this template would cut a face
    const cropCuts = mine.filter((c) => c.variant !== 'contain').every((c) => c.hard.some((h) => h.startsWith('face_crop')));
    out.push(...mine.filter((c) => c.variant !== 'contain' || cropCuts));
  }
  return out.sort((a, b) => a.hard.length - b.hard.length || b.score - a.score);
}

/**
 * The compositions to RENDER, at most `n`: the best composition of each template in rank order first (a fallback that is a variant of the
 * same template would fail for the same reason), then further variants of the best templates when fewer templates exist.
 */
export function shortlistCompositions(ranked: readonly Composition[], n = 3): Composition[] {
  const picked: Composition[] = [];
  for (const c of ranked) if (picked.length < n && !picked.some((p) => p.templateId === c.templateId)) picked.push(c);
  for (const c of ranked) if (picked.length < n && !picked.includes(c)) picked.push(c);
  return picked;
}
