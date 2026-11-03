import { CANVAS as C, button, circle, defineTemplate, ellipse, fill, img, line, logo, pattern, patch, poly, rect, text, type ButtonOptions, type CanvasHelper, type ImgOptions, type LogoOptions, type TextOptions } from '../dsl';
import type { Box, Color, FormatClass, Layer, Paint, TemplateDef, TextSlot } from '../schema';

/**
 * Templates authored for the template collections (see ../../collections). Collection D: organic_blob_hero, organic_leaf_benefit and
 * organic_wave_promo (Soft & Organic) and corp_story_panel (Modern Corporate).
 *
 * The helpers below only keep the per-class pixel geometry readable: every value of a `Spec` is written in PIXELS of that class's reference
 * canvas; the first class listed is the layer's base and the others become `at` patches (a `null` class hides the layer there).
 */

type PxBox = [number, number, number, number];
type Spec<T> = Partial<Record<FormatClass, T | null>>;
type At = Partial<Record<FormatClass, Record<string, unknown>>>;
type Pt = [number, number];

function geo<T>(spec: Spec<T>, make: (c: CanvasHelper, v: T) => Record<string, unknown>) {
  const keys = Object.keys(spec) as FormatClass[];
  const live = keys.filter((k) => spec[k] !== null && spec[k] !== undefined);
  const hide = keys.filter((k) => spec[k] === null);
  const base = make(C[live[0]], spec[live[0]] as T);
  const at: At = {};
  for (const k of live.slice(1)) at[k] = make(C[k], spec[k] as T);
  return { base, at, hide: hide.length ? hide : undefined };
}

const sz = (s: number | [number, number]): [number, number] => (typeof s === 'number' ? [s, s] : s);

function rectL(id: string, spec: Spec<PxBox>, o: { fill?: Paint; radius?: number; opacity?: number; rotate?: number; stroke?: { color: Color; width: number } } = {}) {
  const g = geo(spec, (c, v) => ({ box: c.box(...v) }));
  return rect(id, g.base.box as Box, { ...o, at: g.at, hide: g.hide });
}

/** An ellipse (or a true circle) with an optional rotation per class: [x, y, w, h, rotateDeg]. */
function blobL(id: string, spec: Spec<[number, number, number, number, number?]>, o: { fill?: Color; opacity?: number; circle?: boolean; stroke?: { color: Color; width: number } }) {
  const g = geo(spec, (c, v) => ({ box: c.box(v[0], v[1], v[2], v[3]), rotate: v[4] ?? 0 }));
  const { circle: isCircle, ...rest } = o;
  return (isCircle ? circle : ellipse)(id, g.base.box as Box, { ...rest, rotate: g.base.rotate as number, at: g.at, hide: g.hide });
}

function patternL(id: string, spec: Spec<PxBox>, kind: 'grid' | 'waves', color: Color, size: number, o: { opacity?: number } = {}) {
  const g = geo(spec, (c, v) => ({ box: c.box(...v) }));
  return pattern(id, g.base.box as Box, kind, color, size, { ...o, at: g.at, hide: g.hide });
}

function lineL(id: string, spec: Spec<[number, number, number, number]>, stroke: { color: Color; width: number }, o: { opacity?: number } = {}) {
  const g = geo(spec, (c, v) => ({ from: c.pt(v[0], v[1]), to: c.pt(v[2], v[3]) }));
  return line(id, g.base.from as Pt, g.base.to as Pt, stroke, { ...o, at: g.at, hide: g.hide });
}

function imgL(id: string, spec: Spec<PxBox>, o: ImgOptions) {
  const g = geo(spec, (c, v) => ({ box: c.box(...v) }));
  return img(id, 'hero', g.base.box as Box, { ...o, at: g.at, hide: g.hide });
}

interface TextSpec {
  b: PxBox;
  s: number | [number, number];
  l?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  color?: Color;
}

function textL(id: string, slot: TextSlot, spec: Spec<TextSpec>, o: Omit<TextOptions, 'size' | 'lines' | 'at' | 'hide'>) {
  const g = geo(spec, (c, v) => patch(c, { box: v.b, size: sz(v.s), ...(v.l ? { maxLines: v.l } : {}), ...(v.align ? { align: v.align } : {}), ...(v.valign ? { valign: v.valign } : {}), ...(v.color ? { color: v.color } : {}) }));
  const size = g.base.size as { max: number; min: number };
  return text(id, slot, g.base.box as Box, { ...o, size: [size.max, size.min], lines: (g.base.maxLines as number | undefined) ?? 3, align: (g.base.align as TextSpec['align']) ?? o.align, valign: (g.base.valign as TextSpec['valign']) ?? o.valign, color: (g.base.color as Color | undefined) ?? o.color, at: g.at, hide: g.hide });
}

function buttonL(id: string, spec: Spec<{ b: PxBox; s: number | [number, number] }>, o: Omit<ButtonOptions, 'size' | 'at' | 'hide'> = {}) {
  const g = geo(spec, (c, v) => patch(c, { box: v.b, size: sz(v.s) }));
  const size = g.base.size as { max: number; min: number };
  return button(id, g.base.box as Box, { ...o, size: [size.max, size.min], at: g.at, hide: g.hide });
}

function logoL(id: string, spec: Spec<{ b: PxBox; align?: 'left' | 'center' | 'right' }>, o: Omit<LogoOptions, 'at' | 'hide'> = {}) {
  const g = geo(spec, (c, v) => ({ box: c.box(...v.b), ...(v.align ? { align: v.align } : {}) }));
  return logo(id, g.base.box as Box, { ...o, align: (g.base.align as 'left' | 'center' | 'right' | undefined) ?? o.align, at: g.at, hide: g.hide });
}

// ---- leaf and petal motifs (rotated ellipses) ------------------------------------------------------------------------------------------------

/** An ellipse whose long axis points along `ang` (degrees, clockwise from +x, so up-right is negative), written as a box plus a rotation in -45..45. */
function leafBox(c: CanvasHelper, cx: number, cy: number, len: number, wid: number, ang: number) {
  let a = ((ang % 180) + 180) % 180;
  if (a > 90) a -= 180;
  if (Math.abs(a) <= 45) return { box: c.box(cx - len / 2, cy - wid / 2, len, wid), rotate: Number(a.toFixed(2)) };
  return { box: c.box(cx - wid / 2, cy - len / 2, wid, len), rotate: Number((a > 0 ? a - 90 : a + 90).toFixed(2)) };
}

const dir = (deg: number): Pt => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

/** A sprig: a straight stem from (x, y) in direction `ang` and `len` px long, with `n` leaves alternating along it and one at the tip. `leaf` = leaf length in px. */
interface Sprig {
  x: number;
  y: number;
  ang: number;
  len: number;
  leaf: number;
}

function sprigL(prefix: string, spec: Spec<Sprig>, o: { stem: Color; leaves: Color[]; opacity?: number; wid?: number; n?: number; stemWidth?: number }): Layer[] {
  const n = o.n ?? 4;
  const wid = o.wid ?? 0.44;
  const out: Layer[] = [];
  const stem = geo(spec, (c, s) => {
    const d = dir(s.ang);
    return { from: c.pt(s.x, s.y), to: c.pt(s.x + d[0] * s.len, s.y + d[1] * s.len) };
  });
  out.push(line(`${prefix}-stem`, stem.base.from as Pt, stem.base.to as Pt, { color: o.stem, width: o.stemWidth ?? 0.006 }, { opacity: o.opacity, at: stem.at, hide: stem.hide }));
  for (let i = 0; i <= n; i++) {
    const g = geo(spec, (c, s) => {
      const tip = i === n;
      const t = tip ? 1 : 0.22 + (0.62 * i) / Math.max(1, n - 1);
      const side = i % 2 ? 1 : -1;
      const la = tip ? s.ang : s.ang + side * 46;
      const L = tip ? s.leaf * 0.78 : s.leaf * (1 - 0.32 * t);
      const d = dir(s.ang);
      const ld = dir(la);
      const px = s.x + d[0] * s.len * t;
      const py = s.y + d[1] * s.len * t;
      return leafBox(c, px + (ld[0] * L) / 2, py + (ld[1] * L) / 2, L, L * wid, la);
    });
    out.push(ellipse(`${prefix}-leaf-${i + 1}`, g.base.box as Box, { fill: o.leaves[i % o.leaves.length], rotate: g.base.rotate as number, opacity: o.opacity, at: g.at, hide: g.hide }));
  }
  return out;
}

/** A tiny two-leaf sprout (the badge icon): (cx, cy) is its centre and `s` the leaf length, in px of each class. */
function sproutL(prefix: string, spec: Spec<{ cx: number; cy: number; s: number }>, color: Color): Layer[] {
  const out: Layer[] = [];
  const stem = geo(spec, (c, v) => ({ from: c.pt(v.cx, v.cy + v.s * 0.62), to: c.pt(v.cx, v.cy + v.s * 0.02) }));
  out.push(line(`${prefix}-stem`, stem.base.from as Pt, stem.base.to as Pt, { color, width: 0.0045 }, { at: stem.at, hide: stem.hide }));
  for (const [i, a] of [-138, -42].entries()) {
    const g = geo(spec, (c, v) => {
      const d = dir(a);
      const L = v.s * 0.86;
      return leafBox(c, v.cx + (d[0] * L) / 2, v.cy + v.s * 0.1 + (d[1] * L) / 2, L, L * 0.46, a);
    });
    out.push(ellipse(`${prefix}-leaf-${i + 1}`, g.base.box as Box, { fill: color, rotate: g.base.rotate as number, at: g.at, hide: g.hide }));
  }
  return out;
}

// ---- wavy band (organic_wave_promo) ------------------------------------------------------------------------------------------------------------

/**
 * A band with sinuous top and bottom edges (a flowing ribbon of one thickness): a rectangle plus one polygon per half wave on each edge. A
 * half wave is a sine arch sampled in seven points; on the top edge the even arches are band-coloured (the band bulges up) and the odd ones are
 * paper-coloured (cut into the band), the bottom edge is the opposite, so the thickness stays constant. Six half waves span the width.
 * `y0`/`y1` are the mean edge lines in px, `amp` the wave height. The area right above and below the band must be plain paper (the cuts are
 * painted with it). Each polygon (seven points on the sine and one wedge point) reaches a few px past its mean line so no seam shows between it and the band.
 */
function wavyBand(prefix: string, spec: Spec<{ y0: number; y1: number; amp: number }>, o: { color: Color; paper: Color }): Layer[] {
  const out: Layer[] = [];
  const band = geo(spec, (c, v) => ({ box: c.box(0, v.y0, c.width, v.y1 - v.y0) }));
  out.push(rect(`${prefix}-body`, band.base.box as Box, { fill: o.color, at: band.at, hide: band.hide }));
  for (const edge of ['top', 'bottom'] as const) {
    for (let j = 0; j < 6; j++) {
      const g = geo(spec, (c, v) => {
        const hw = c.width / 6;
        const y = edge === 'top' ? v.y0 : v.y1;
        const up = j % 2 === 0 ? 1 : -1;
        const pts: Pt[] = [];
        for (let i = 0; i <= 6; i++) pts.push(c.pt(j * hw + (hw * i) / 6, y - up * v.amp * Math.sin((Math.PI * i) / 6)));
        const bandSide = (edge === 'top') === (up === 1);
        // band-coloured arches reach into the band (down from the top line, up from the bottom line); paper arches reach away from it
        const reach = (edge === 'top' ? 1 : -1) * (bandSide ? 4 : -4);
        pts.push(c.pt((j + 0.5) * hw, y + reach));
        return { points: pts };
      });
      const bandSide = (edge === 'top') === (j % 2 === 0);
      out.push(poly(`${prefix}-${edge}-${j + 1}`, g.base.points as Pt[], { fill: bandSide ? o.color : o.paper, at: g.at, hide: g.hide }));
    }
  }
  return out;
}

// =================================================================================================================================================
// 1. organic_blob_hero
// =================================================================================================================================================

/**
 * organic_blob_hero: a CENTERED hero on warm paper. A cluster of big overlapping blobs (secondary, accent and primary ellipses) sits above the
 * message; a picture in a circular frame with a paper ring is the heart of the cluster (without a picture the brand pattern fills the circle).
 * Under it a short kind headline, a quiet support line and a pill button, all centered. Banner: the cluster on the left, text in the middle.
 */
const organicBlobHero = defineTemplate({
  id: 'organic_blob_hero',
  name: 'Soft blobs (centered hero)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'Warm paper with big overlapping organic blobs around a round picture, then a short kind headline, a support line and a pill button, all centered.',
  styles: ['soft_lifestyle', 'lifestyle_photography'],
  industries: ['wellness', 'yoga', 'bakery', 'cafe', 'florist', 'organic food', 'childcare', 'community', 'natural products', 'family services'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'airy',
  family: 'centered',
  composition: 'Centered: overlapping blobs behind a circular picture, headline, support line and pill button below; in the banner the blobs and picture sit left of the text.',
  sample: {
    headline: 'Slow mornings start here',
    support: 'Fresh pastries, single-origin coffee and a corner table that is always yours.',
    cta: 'Visit us today',
    eyebrow: 'Open every day',
    brand: 'Corner Roast',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    blobL('blob-a', { square: [-190, 230, 600, 330, -16], portrait: [-200, 250, 680, 400, -16], story: [-260, 560, 800, 520, -16], banner: [-170, 50, 440, 240, -14] }, { fill: 'secondary' }),
    blobL('blob-b', { square: [650, 190, 540, 330, 14], portrait: [650, 200, 560, 380, 14], story: [620, 470, 700, 460, 14], banner: [170, 190, 170, 150, 10] }, { fill: 'accent', opacity: 0.92 }),
    blobL('blob-c', { square: [590, 370, 280, 160, -10], portrait: [590, 470, 330, 190, -10], story: [700, 830, 360, 200, -10], banner: null }, { fill: 'primary', opacity: 0.9 }),
    blobL('blob-d', { square: [-170, 880, 400, 300, 18], portrait: [-180, 1060, 440, 340, 18], story: [-220, 1500, 520, 420, 18], banner: null }, { fill: 'secondary' }),
    blobL('blob-e', { square: [840, 900, 360, 260, -22], portrait: [840, 1090, 380, 300, -22], story: [800, 1560, 440, 360, -22], banner: null }, { fill: 'primary', opacity: 0.9 }),
    blobL('blob-f', { square: null, portrait: null, story: [-210, -170, 640, 420, 12], banner: null }, { fill: 'accent', opacity: 0.9 }),
    blobL('blob-g', { square: null, portrait: null, story: [700, -140, 560, 380, -14], banner: null }, { fill: 'secondary' }),
    blobL('dot-a', { square: [262, 150, 52, 52], portrait: [236, 170, 58, 58], story: [240, 430, 70, 70], banner: null }, { fill: 'primary', circle: true }),
    blobL('dot-b', { square: [806, 120, 30, 30], portrait: [820, 150, 34, 34], story: [800, 400, 40, 40], banner: null }, { fill: 'accent', circle: true }),
    patternL('waves', { square: null, portrait: null, story: null, banner: [940, 98, 212, 84] }, 'waves', 'accent', 0.045, { opacity: 0.7 }),
    blobL('ring', { square: [340, 148, 400, 400], portrait: [290, 170, 500, 500], story: [255, 435, 570, 570], banner: [52, 24, 252, 252] }, { fill: 'paper', circle: true }),
    imgL('photo', { square: [360, 168, 360, 360], portrait: [310, 190, 460, 460], story: [280, 460, 520, 520], banner: [66, 38, 224, 224] }, { mask: 'circle', fallback: 'brandPattern', focus: [0.5, 0.5] }),
    logoL('logo', { square: { b: [340, 80, 400, 44], align: 'center' }, portrait: { b: [340, 98, 400, 46], align: 'center' }, story: { b: [340, 290, 400, 52], align: 'center' }, banner: { b: [940, 40, 212, 36], align: 'right' } }, { nameColor: 'ink' }),
    textL('eyebrow', 'eyebrow', { square: { b: [140, 570, 800, 34], s: 24, l: 1, align: 'center' }, portrait: { b: [140, 702, 800, 34], s: 25, l: 1, align: 'center' }, story: { b: [140, 1058, 800, 40], s: 30, l: 1, align: 'center' }, banner: null }, { color: 'muted', align: 'center' }),
    textL('headline', 'headline', { square: { b: [100, 608, 880, 214], s: [90, 52], l: 2, align: 'center' }, portrait: { b: [100, 742, 880, 244], s: [104, 56], l: 2, align: 'center' }, story: { b: [90, 1104, 900, 320], s: [128, 64], l: 3, align: 'center' }, banner: { b: [350, 36, 560, 112], s: [46, 28], l: 2, align: 'left', valign: 'bottom' } }, { color: 'ink', weight: 600, lh: 1.14, align: 'center' }),
    textL('support', 'support', { square: { b: [170, 834, 740, 86], s: [28, 22], l: 2, align: 'center' }, portrait: { b: [160, 996, 760, 90], s: [30, 22], l: 2, align: 'center' }, story: { b: [150, 1440, 780, 100], s: [34, 26], l: 2, align: 'center' }, banner: { b: [350, 158, 560, 66], s: [22, 16], l: 2, align: 'left' } }, { color: 'ink', weight: 400, opacity: 0.8, lh: 1.34, align: 'center' }),
    buttonL('cta', { square: { b: [380, 940, 320, 62], s: [28, 21] }, portrait: { b: [370, 1112, 340, 70], s: [30, 22] }, story: { b: [330, 1560, 420, 80], s: [34, 24] }, banner: { b: [930, 196, 222, 56], s: [21, 15] } }),
  ],
});

// =================================================================================================================================================
// 2. organic_leaf_benefit
// =================================================================================================================================================

/**
 * organic_leaf_benefit: a PANEL composition. One large soft card on a tinted background; sprigs of leaves (rotated ellipses on a stem) grow out
 * from behind its corners and fill its lower right, the headline, support and pill button sit on the left of the card and a round badge with a
 * leaf sits top right (a short tag, when there is one, goes beside it).
 */
const organicLeafBenefit = defineTemplate({
  id: 'organic_leaf_benefit',
  name: 'Leaf card (benefit panel)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A large soft card on a tinted background with leaf sprigs growing out of its corners, a round leaf badge, a kind headline, short explanation and a pill button.',
  styles: ['soft_lifestyle', 'lifestyle_photography'],
  industries: ['wellness', 'yoga', 'organic food', 'natural products', 'florist', 'family services', 'education', 'childcare', 'community', 'cafe'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'airy',
  family: 'panel',
  composition: 'A big rounded paper card on a tinted canvas, leaf sprigs behind and inside its corners, badge top right, left-aligned headline, support and pill button.',
  sample: {
    headline: 'Gentle care, grown naturally',
    support: 'Plant-based products made in small batches, kind to your skin and to the planet.',
    cta: 'Shop the range',
    tag: 'Plant based',
    brand: 'Fern & Field',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    rectL('tint', { square: [0, 0, 1080, 1080], portrait: [0, 0, 1080, 1350], story: [0, 0, 1080, 1920], landscape: [0, 0, 1200, 628] }, { fill: 'primary', opacity: 0.22 }),
    ...sprigL('back-a', { square: { x: 930, y: 150, ang: -62, len: 120, leaf: 150 }, portrait: { x: 930, y: 160, ang: -62, len: 130, leaf: 160 }, story: { x: 930, y: 380, ang: -62, len: 150, leaf: 190 }, landscape: { x: 1070, y: 70, ang: -50, len: 80, leaf: 120 } }, { stem: 'primary', leaves: ['primary', 'accent', 'primary'], n: 3 }),
    ...sprigL('back-b', { square: { x: 170, y: 950, ang: 118, len: 110, leaf: 140 }, portrait: { x: 170, y: 1210, ang: 118, len: 120, leaf: 150 }, story: { x: 170, y: 1620, ang: 118, len: 140, leaf: 180 }, landscape: { x: 120, y: 560, ang: 130, len: 70, leaf: 110 } }, { stem: 'primary', leaves: ['accent', 'primary', 'accent'], n: 3 }),
    rectL('card', { square: [70, 100, 940, 880], portrait: [70, 100, 940, 1140], story: [60, 330, 960, 1320], landscape: [40, 36, 1120, 556] }, { fill: 'paper', radius: 0.14 }),
    ...sprigL('front', { square: { x: 935, y: 962, ang: -97, len: 470, leaf: 175 }, portrait: { x: 935, y: 1202, ang: -97, len: 600, leaf: 200 }, story: { x: 925, y: 1625, ang: -97, len: 800, leaf: 260 }, landscape: { x: 1042, y: 566, ang: -98, len: 330, leaf: 140 } }, { stem: 'primary', leaves: ['secondary', 'primary', 'accent', 'primary', 'accent'], n: 4 }),
    blobL('badge', { square: [846, 140, 104, 104], portrait: [846, 140, 104, 104], story: [846, 410, 110, 110], landscape: [1010, 70, 84, 84] }, { fill: 'accent', circle: true }),
    ...sproutL('badge-sprout', { square: { cx: 898, cy: 190, s: 56 }, portrait: { cx: 898, cy: 190, s: 56 }, story: { cx: 901, cy: 465, s: 60 }, landscape: { cx: 1052, cy: 110, s: 46 } }, 'onAccent'),
    logoL('logo', { square: { b: [130, 148, 320, 46] }, portrait: { b: [130, 150, 320, 46] }, story: { b: [130, 420, 340, 50] }, landscape: { b: [92, 70, 280, 40] } }, { nameColor: 'ink' }),
    textL('tag', 'tag', { square: { b: [480, 166, 340, 56], s: 24, l: 1, align: 'right', valign: 'middle' }, portrait: { b: [480, 168, 340, 56], s: 24, l: 1, align: 'right', valign: 'middle' }, story: { b: [460, 436, 360, 60], s: 28, l: 1, align: 'right', valign: 'middle' }, landscape: { b: [790, 88, 190, 48], s: 20, l: 1, align: 'right', valign: 'middle' } }, { color: 'muted', align: 'right', valign: 'middle' }),
    textL('headline', 'headline', { square: { b: [130, 316, 620, 300], s: [84, 48], l: 4 }, portrait: { b: [130, 390, 640, 480], s: [96, 52], l: 5 }, story: { b: [130, 680, 640, 580], s: [104, 58], l: 5 }, landscape: { b: [92, 130, 660, 200], s: [58, 34], l: 3 } }, { color: 'ink', weight: 600, lh: 1.14 }),
    textL('support', 'support', { square: { b: [130, 630, 520, 130], s: [30, 22], l: 3 }, portrait: { b: [130, 880, 540, 160], s: [31, 22], l: 4 }, story: { b: [130, 1300, 540, 190], s: [36, 26], l: 4 }, landscape: { b: [92, 352, 560, 70], s: [21, 16], l: 2 } }, { color: 'ink', weight: 400, opacity: 0.8, lh: 1.38 }),
    buttonL('cta', { square: { b: [130, 790, 330, 76], s: [30, 22] }, portrait: { b: [130, 1070, 350, 80], s: [32, 22] }, story: { b: [130, 1470, 420, 90], s: [36, 26] }, landscape: { b: [92, 450, 250, 56], s: [21, 16] } }),
  ],
});

// =================================================================================================================================================
// 3. organic_wave_promo
// =================================================================================================================================================

/**
 * organic_wave_promo: a BAND composition. A wide accent band with soft sinuous edges crosses the paper; the headline (and in the wide formats the
 * support line and the button) sit on it, a round picture overlaps its edge and, in the tall formats, the support line and button sit on the paper
 * below. The banner turns the band into the whole banner: wavy paper margins above and below, logo, headline, button and picture on it.
 */
const organicWavePromo = defineTemplate({
  id: 'organic_wave_promo',
  name: 'Wave band (promo)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'An accent-colored band with soft wavy edges carries the headline across the frame; a round picture overlaps the band and a pill button invites the click.',
  styles: ['soft_lifestyle', 'lifestyle_photography'],
  industries: ['bakery', 'cafe', 'florist', 'organic food', 'wellness', 'community', 'childcare', 'education', 'natural products', 'restaurant'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'A wavy accent band across the paper with the headline on it, a round picture overlapping its edge and a pill button; in the banner the band fills the frame.',
  sample: {
    headline: 'Fresh baskets for every spring table',
    support: 'Seasonal treats, baked and packed by hand every single morning.',
    cta: 'Order a basket',
    eyebrow: 'Spring offer',
    brand: 'Meadow & Co',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    blobL('blob-a', { square: [-120, 146, 380, 120, -8], story: [680, -150, 580, 400, -14], landscape: null, banner: null }, { fill: 'secondary' }),
    blobL('blob-b', { square: [800, 880, 420, 300, -20], story: [-210, -130, 540, 360, 10], landscape: null, banner: null }, { fill: 'primary', opacity: 0.9 }),
    blobL('blob-c', { square: null, story: [-170, 1740, 560, 320, 12], landscape: null, banner: null }, { fill: 'secondary' }),
    blobL('blob-d', { square: null, story: [690, 1730, 520, 360, -14], landscape: null, banner: null }, { fill: 'accent', opacity: 0.9 }),
    ...wavyBand('band', { square: { y0: 300, y1: 760, amp: 22 }, story: { y0: 590, y1: 1290, amp: 26 }, landscape: { y0: 150, y1: 520, amp: 20 }, banner: { y0: 24, y1: 276, amp: 12 } }, { color: 'accent', paper: 'paper' }),
    imgL('photo', { square: [620, 130, 380, 380], story: [540, 1130, 450, 450], landscape: [770, 100, 380, 380], banner: [930, 36, 228, 228] }, { mask: 'circle', fallback: 'brandPattern', border: { color: 'paper', width: 0.012 } }),
    logoL('logo', { square: { b: [86, 84, 320, 44] }, story: { b: [86, 290, 340, 52] }, landscape: { b: [72, 70, 260, 40] }, banner: { b: [56, 40, 240, 30] } }, { nameColor: 'ink' }),
    textL('eyebrow', 'eyebrow', { square: { b: [86, 368, 480, 32], s: 24, l: 1 }, story: { b: [86, 650, 700, 40], s: 30, l: 1 }, landscape: { b: [72, 160, 500, 28], s: 19, l: 1 }, banner: null }, { color: 'onAccent', weight: 600 }),
    textL('headline', 'headline', { square: { b: [86, 410, 520, 320], s: [80, 48], l: 4 }, story: { b: [86, 706, 908, 400], s: [112, 60], l: 4 }, landscape: { b: [72, 194, 660, 150], s: [58, 34], l: 2 }, banner: { b: [56, 68, 590, 106], s: [42, 26], l: 2, valign: 'bottom' } }, { color: 'onAccent', weight: 600, lh: 1.12 }),
    textL('support', 'support', { square: { b: [86, 822, 660, 80], s: [28, 22], l: 2 }, story: { b: [86, 1380, 420, 160], s: [34, 26], l: 4 }, landscape: { b: [72, 350, 600, 62], s: [21, 16], l: 2, color: 'onAccent' }, banner: { b: [56, 184, 590, 56], s: [19, 14], l: 2, color: 'onAccent' } }, { color: 'ink', weight: 400, lh: 1.34 }),
    buttonL('cta', { square: { b: [86, 920, 320, 70], s: [28, 21] }, story: { b: [86, 1566, 400, 80], s: [34, 24] }, landscape: { b: [72, 430, 240, 54], s: [21, 16] }, banner: { b: [680, 112, 220, 58], s: [21, 15] } }, { fill: 'ink', color: 'onInk' }),
  ],
});

// =================================================================================================================================================
// 4. corp_story_panel
// =================================================================================================================================================

/**
 * corp_story_panel: a POSTER-TYPE vertical structure for a tall frame. A primary panel carries the logo, a hairline, a small uppercase label and
 * the headline set large on a faint grid whose columns are marked by thin rules; below it a paper footer (support line and a compact
 * button on a three-column grid) and a full-width picture band that bleeds off the bottom edge (a gradient when there is no picture).
 */
const corpStoryPanel = defineTemplate({
  id: 'corp_story_panel',
  name: 'Story panel (corporate poster)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A disciplined vertical layout: a primary panel with logo, label and a large headline on a faint grid, a paper footer with the support line and a compact button, and a picture band at the foot.',
  styles: ['modern_corporate', 'minimalist_tech'],
  industries: ['consulting', 'finance', 'legal', 'accounting', 'b2b services', 'insurance', 'logistics', 'real estate', 'recruitment', 'engineering'],
  channels: [],
  classes: ['story', 'portrait', 'square'],
  requires: [],
  density: 'balanced',
  family: 'poster-type',
  composition: 'Top primary panel (logo, hairline, label, large headline on a grid), a paper footer with support line and compact button, a full-width picture band bleeding off the bottom.',
  sample: {
    headline: 'Clear advice for companies that plan to last',
    support: 'Independent finance and risk consulting for growing businesses, delivered by a team you meet in person.',
    cta: 'Book a call',
    eyebrow: 'Advisory services',
    brand: 'Northwind Partners',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'paper'),
    rectL('panel', { story: [0, 0, 1080, 1100], portrait: [0, 0, 1080, 820], square: [0, 0, 1080, 600] }, { fill: 'primary' }),
    patternL('grid', { story: [0, 0, 1080, 1100], portrait: [0, 0, 1080, 820], square: [0, 0, 1080, 600] }, 'grid', 'onPrimary', 0.06, { opacity: 0.12 }),
    lineL('col-1', { story: [384, 470, 384, 1100], portrait: [384, 246, 384, 820], square: [384, 216, 384, 600] }, { color: 'onPrimary', width: 0.0014 }, { opacity: 0.16 }),
    lineL('col-2', { story: [696, 470, 696, 1100], portrait: [696, 246, 696, 820], square: [696, 216, 696, 600] }, { color: 'onPrimary', width: 0.0014 }, { opacity: 0.16 }),
    rectL('strip', { story: [0, 1100, 1080, 12], portrait: [0, 820, 1080, 10], square: [0, 600, 1080, 10] }, { fill: 'accent' }),
    imgL('photo', { story: [0, 1420, 1080, 500], portrait: [0, 1070, 1080, 280], square: [0, 820, 1080, 260] }, { fallback: 'gradient', focus: [0.5, 0.4] }),
    logoL('logo', { story: { b: [86, 290, 360, 50] }, portrait: { b: [86, 100, 340, 46] }, square: { b: [86, 80, 320, 44] } }, { nameColor: 'onPrimary' }),
    lineL('rule-top', { story: [86, 384, 994, 384], portrait: [86, 170, 994, 170], square: [86, 146, 994, 146] }, { color: 'onPrimary', width: 0.0016 }, { opacity: 0.55 }),
    lineL('rule-accent', { story: [86, 384, 226, 384], portrait: [86, 170, 206, 170], square: [86, 146, 196, 146] }, { color: 'accent', width: 0.0048 }),
    textL('eyebrow', 'eyebrow', { story: { b: [86, 408, 800, 34], s: 26, l: 1 }, portrait: { b: [86, 194, 800, 30], s: 22, l: 1 }, square: { b: [86, 168, 800, 30], s: 20, l: 1 } }, { color: 'onPrimary', upper: true, weight: 600, tracking: 0.08 }),
    textL('headline', 'headline', { story: { b: [86, 470, 908, 590], s: [124, 66], l: 5, valign: 'bottom' }, portrait: { b: [86, 250, 908, 510], s: [100, 54], l: 5, valign: 'bottom' }, square: { b: [86, 200, 908, 350], s: [84, 48], l: 4, valign: 'bottom' } }, { color: 'onPrimary', weight: 700, lh: 1.06 }),
    textL('support', 'support', { story: { b: [86, 1176, 575, 140], s: [32, 24], l: 4 }, portrait: { b: [86, 886, 575, 140], s: [30, 22], l: 4 }, square: { b: [86, 656, 575, 120], s: [27, 20], l: 4 } }, { color: 'ink', weight: 400, lh: 1.34 }),
    buttonL('cta', { story: { b: [726, 1212, 268, 70], s: [30, 22] }, portrait: { b: [726, 922, 268, 66], s: [28, 21] }, square: { b: [726, 678, 268, 64], s: [26, 20] } }, { radius: 0.1 }),
  ],
});

export const COLLECTION_TEMPLATES_D: TemplateDef[] = [organicBlobHero, organicLeafBenefit, organicWavePromo, corpStoryPanel];
