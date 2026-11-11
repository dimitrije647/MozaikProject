import { CANVAS as C, button, circle, defineTemplate, fill, img, logo, pattern, patch, poly, rect, text, type ButtonOptions, type CanvasHelper, type ImgOptions, type LogoOptions, type TextOptions } from '../dsl';
import type { Color, FormatClass, Paint, TemplateDef, TextSlot } from '../schema';

/**
 * Templates authored for the template collections (see ../../collections). This file holds the CONTEMPORARY GEOMETRIC additions: four
 * compositions with square corners, hard diagonal cuts, checks and heavy rules, each with a different idea (a tile mosaic, stacked arches,
 * a chevron field crossed by a band, a hard vertical split). Everything is written in pixels of each class's reference canvas.
 */

type K = FormatClass;
type Px = [number, number, number, number];
type Pt = [number, number];
type Spec<T> = Partial<Record<K, T>>;
type At = Partial<Record<K, Record<string, unknown>>>;
type Extra = Spec<Record<string, unknown>>;
type Ink = { color: Color; width: number };
type TextSpec = { box: Px; size: number | [number, number]; lines?: number; align?: 'left' | 'center' | 'right'; valign?: 'top' | 'middle' | 'bottom' };
type ButtonSpec = { box: Px; size: number | [number, number] };
type PatSpec = { box: Px; cell: number };

/** The options of a layer without the per-class extras (`x`), which the builders turn into patches. */
const plain = <T extends { x?: Extra }>(o: T): Omit<T, 'x'> => {
  const { x: _x, ...rest } = o;
  void _x;
  return rest;
};

const sizeIn = (c: CanvasHelper, v: number | [number, number]) => (typeof v === 'number' ? c.size(v) : c.size(v[0], v[1]));

/**
 * Layer builders bound to the classes one template is designed for. Every layer is written as a per-class spec in pixels of that class's
 * reference canvas (the first class listed in the spec is the base, the others become patches; a class missing from the spec hides the
 * layer there). `x` adds extra patch keys (a colour, a fill) for the classes after the first.
 */
function kit(classes: readonly K[]) {
  const first = <T>(s: Spec<T>): K => {
    const f = classes.find((k) => s[k] !== undefined);
    if (!f) throw new Error('empty class spec');
    return f;
  };
  const hide = <T>(s: Spec<T>) => {
    const h = classes.filter((k) => s[k] === undefined);
    return h.length ? h : undefined;
  };
  const at = <T>(s: Spec<T>, make: (c: CanvasHelper, v: T) => Record<string, unknown>, x?: Extra): At => {
    const f = first(s);
    const out: At = {};
    for (const k of classes) if (k !== f && s[k] !== undefined) out[k] = { ...make(C[k], s[k] as T), ...(x?.[k] ?? {}) };
    return out;
  };
  const geo = (s: Spec<Px>, x?: Extra) => {
    const f = first(s);
    return { box: C[f].box(...(s[f] as Px)), at: at(s, (c, b) => ({ box: c.box(...b) }), x), hide: hide(s) };
  };
  return {
    rect: (id: string, s: Spec<Px>, o: { fill?: Paint; stroke?: Ink; opacity?: number; rotate?: number; x?: Extra } = {}) => {
      const g = geo(s, o.x);
      const rest = plain(o);
      return rect(id, g.box, { ...rest, at: g.at, hide: g.hide });
    },
    circle: (id: string, s: Spec<Px>, o: { fill?: Paint; stroke?: Ink; opacity?: number; x?: Extra } = {}) => {
      const g = geo(s, o.x);
      const rest = plain(o);
      return circle(id, g.box, { ...rest, at: g.at, hide: g.hide });
    },
    pattern: (id: string, s: Spec<PatSpec>, color: Color, o: { opacity?: number; kind?: 'checks' | 'stripes' | 'grid' | 'dots'; x?: Extra } = {}) => {
      const f = first(s);
      const v = s[f] as PatSpec;
      return pattern(id, C[f].box(...v.box), o.kind ?? 'checks', color, Number((v.cell / C[f].unit).toFixed(5)), {
        opacity: o.opacity,
        at: at(s, (c, p) => ({ box: c.box(...p.box), size: Number((p.cell / c.unit).toFixed(5)) }), o.x),
        hide: hide(s),
      });
    },
    poly: (id: string, s: Spec<Pt[]>, o: { fill?: Paint; stroke?: Ink; opacity?: number; x?: Extra } = {}) => {
      const f = first(s);
      const rest = plain(o);
      return poly(id, (s[f] as Pt[]).map(([x, y]) => C[f].pt(x, y)), { ...rest, at: at(s, (c, p) => ({ points: p.map(([x, y]) => c.pt(x, y)) }), o.x), hide: hide(s) });
    },
    img: (id: string, s: Spec<Px>, o: ImgOptions & { x?: Extra } = {}) => {
      const g = geo(s, o.x);
      const rest = plain(o);
      return img(id, 'hero', g.box, { ...rest, at: g.at, hide: g.hide });
    },
    text: (id: string, slot: TextSlot, s: Spec<TextSpec>, o: Omit<TextOptions, 'size' | 'at' | 'hide'> & { x?: Extra }) => {
      const f = first(s);
      const v = s[f] as TextSpec;
      const rest = plain(o);
      return text(id, slot, C[f].box(...v.box), {
        ...rest,
        size: sizeIn(C[f], v.size),
        lines: v.lines ?? o.lines,
        align: v.align ?? o.align,
        valign: v.valign ?? o.valign,
        at: at(
          s,
          (c, p) => patch(c, { box: p.box, size: typeof p.size === 'number' ? [p.size, p.size] : p.size, ...(p.lines ? { maxLines: p.lines } : {}), ...(p.align ? { align: p.align } : {}), ...(p.valign ? { valign: p.valign } : {}) }),
          o.x,
        ),
        hide: hide(s),
      });
    },
    button: (id: string, s: Spec<ButtonSpec>, o: Omit<ButtonOptions, 'size' | 'at' | 'hide'> & { x?: Extra } = {}) => {
      const f = first(s);
      const v = s[f] as ButtonSpec;
      const rest = plain(o);
      return button(id, C[f].box(...v.box), { ...rest, size: sizeIn(C[f], v.size), at: at(s, (c, p) => patch(c, { box: p.box, size: typeof p.size === 'number' ? [p.size, p.size] : p.size }), o.x), hide: hide(s) });
    },
    logo: (id: string, s: Spec<Px>, o: LogoOptions & { x?: Extra } = {}) => {
      const g = geo(s, o.x);
      const rest = plain(o);
      return logo(id, g.box, { ...rest, at: g.at, hide: g.hide });
    },
  };
}

/** A solid arch (a circle on top of a rectangle) as two layer specs, in pixels. */
const archSpec = (v: Spec<Px>): { top: Spec<Px>; body: Spec<Px> } => {
  const top: Spec<Px> = {};
  const body: Spec<Px> = {};
  for (const k of Object.keys(v) as K[]) {
    const [x, y, w, h] = v[k] as Px;
    top[k] = [x, y, w, w];
    body[k] = [x, y + w / 2, w, h - w / 2];
  }
  return { top, body };
};

// ---------------------------------------------------------------------------------------------------------------------------------
// geo_tiles_hero
// ---------------------------------------------------------------------------------------------------------------------------------

const TILES: readonly K[] = ['square', 'portrait', 'story', 'landscape'];
const t1 = kit(TILES);
const TILE_LINE: Ink = { color: 'ink', width: 0.004 };

/**
 * geo_tiles_hero: a MODULAR MOSAIC of flat tiles with heavy ink rules between them. The headline sits in the largest tile (primary); the
 * others are a picture tile whose diagonal cut shows a solid triangle behind it, an accent tile with a quarter disc, a checks tile, a paper
 * tile for the logo and the support copy, and an ink tile that carries the square arrow button. Landscape keeps one big text tile and
 * stacks the small tiles beside it; story runs the tiles as bands.
 */
const geoTilesHero = defineTemplate({
  id: 'geo_tiles_hero',
  name: 'Tile mosaic (geometric hero)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A mosaic of flat, square-cornered tiles with heavy rules: the headline fills the largest tile, a picture tile is cut on a diagonal, and a checks tile, a quarter disc and a square button complete the grid.',
  styles: ['contemporary_geometric', 'bold_startup'],
  industries: ['design', 'agency', 'architecture', 'creative', 'education', 'startup', 'technology', 'fashion', 'portfolio'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'poster-type',
  composition: 'Edge-to-edge tile mosaic: a large primary tile with the headline, a diagonal-cut picture tile, an accent tile with a quarter disc, checks and ink tiles, support on paper and the button on ink.',
  sample: {
    headline: 'Modular thinking for bold brands',
    support: 'Clear systems, confident colour and a studio that ships on time.',
    cta: 'Start a project',
    eyebrow: 'Design studio',
    brand: 'Atlas Studio',
  },
  tone: 'duo',
  layers: [
    fill('paper', 'paper'),
    // ---- tiles (back to front) ----
    t1.rect('tile-ink', { square: [0, 0, 270, 270], portrait: [0, 0, 270, 270], story: [0, 0, 540, 300], landscape: [700, 350, 250, 278] }, { fill: 'ink', stroke: TILE_LINE }),
    t1.pattern('tile-checks', { square: { box: [0, 0, 270, 270], cell: 45 }, portrait: { box: [0, 0, 270, 270], cell: 45 }, story: { box: [0, 0, 540, 300], cell: 60 }, landscape: { box: [700, 350, 250, 278], cell: 31 } }, 'onInk', { opacity: 0.32 }),
    t1.rect('tile-paper', { square: [270, 0, 270, 270], portrait: [270, 0, 270, 270], story: [0, 300, 1080, 170] }, { fill: 'paper', stroke: TILE_LINE }),
    t1.rect('tile-picture-back', { square: [540, 0, 540, 540], portrait: [540, 0, 540, 540], story: [0, 470, 1080, 540], landscape: [700, 0, 500, 350] }, { fill: 'secondary', stroke: TILE_LINE }),
    t1.img('photo', { square: [540, 0, 540, 540], portrait: [540, 0, 540, 540], story: [0, 470, 1080, 540], landscape: [700, 0, 500, 350] }, { mask: 'cut-left', radius: 0.3, fallback: 'brandPattern', focus: [0.5, 0.45] }),
    t1.rect('tile-accent', { square: [0, 270, 540, 270], portrait: [0, 270, 540, 270], story: [540, 0, 270, 300], landscape: [950, 350, 250, 278] }, { fill: 'accent', stroke: TILE_LINE }),
    t1.circle('quarter-disc', { square: [-270, 270, 540, 540], portrait: [-270, 270, 540, 540], story: [540, -270, 540, 540], landscape: [1000, 428, 400, 400] }, { fill: 'ink' }),
    t1.rect('tile-headline', { square: [0, 540, 810, 330], portrait: [0, 540, 810, 520], story: [0, 1010, 1080, 642], landscape: [0, 0, 700, 628] }, { fill: 'primary', stroke: TILE_LINE }),
    t1.rect('tile-secondary', { square: [810, 540, 270, 330], portrait: [810, 540, 270, 520], story: [810, 0, 270, 300] }, { fill: 'secondary', stroke: TILE_LINE }),
    t1.poly('wedge', { square: [[810, 870], [1080, 870], [1080, 630]], portrait: [[810, 1060], [1080, 1060], [1080, 760]], story: [[810, 300], [1080, 300], [1080, 40]] }, { fill: 'accent' }),
    t1.rect('tile-support', { square: [0, 870, 540, 210], portrait: [0, 1060, 540, 290], story: [0, 1652, 540, 268] }, { fill: 'paper', stroke: TILE_LINE, x: { story: { fill: 'accent' } } }),
    t1.rect('tile-button', { square: [540, 870, 540, 210], portrait: [540, 1060, 540, 290], story: [540, 1652, 540, 268] }, { fill: 'ink', stroke: TILE_LINE }),
    // ---- content ----
    t1.logo('logo', { square: [300, 100, 210, 70], portrait: [300, 100, 210, 70], story: [86, 340, 420, 70], landscape: [72, 63, 320, 40] }, { nameColor: 'onPaper', x: { landscape: { nameColor: 'onPrimary' } } }),
    t1.text(
      'eyebrow',
      'eyebrow',
      { square: { box: [300, 298, 210, 64], size: [21, 15], lines: 2 }, portrait: { box: [300, 298, 210, 64], size: [21, 15], lines: 2 }, story: { box: [560, 352, 434, 40], size: 26 }, landscape: { box: [72, 114, 580, 26], size: 17 } },
      { color: 'onAccent', align: 'left', lines: 1, x: { story: { color: 'onPaper' }, landscape: { color: 'onPrimary' } } },
    ),
    t1.text(
      'headline',
      'headline',
      {
        square: { box: [90, 566, 670, 282], size: [92, 52], lines: 3, valign: 'middle' },
        portrait: { box: [90, 576, 660, 450], size: [104, 56], lines: 4, valign: 'middle' },
        story: { box: [90, 1036, 900, 356], size: [120, 64], lines: 4 },
        landscape: { box: [72, 146, 590, 250], size: [76, 38], lines: 4, valign: 'middle' },
      },
      { family: 'display', weight: 700, color: 'onPrimary', lh: 1.0 },
    ),
    t1.text(
      'support',
      'support',
      {
        square: { box: [90, 916, 410, 88], size: [26, 17], lines: 3, valign: 'middle' },
        portrait: { box: [90, 1100, 410, 130], size: [28, 18], lines: 4, valign: 'middle' },
        story: { box: [90, 1436, 900, 100], size: [36, 24], lines: 2 },
        landscape: { box: [72, 408, 580, 60], size: [21, 15], lines: 3 },
      },
      { weight: 500, lh: 1.3, color: 'onPaper', x: { story: { color: 'onPrimary' }, landscape: { color: 'onPrimary' } } },
    ),
    t1.button(
      'cta',
      { square: { box: [590, 914, 400, 90], size: [28, 20] }, portrait: { box: [590, 1100, 400, 100], size: [30, 20] }, story: { box: [90, 1556, 460, 88], size: [32, 22] }, landscape: { box: [72, 492, 280, 62], size: [20, 15] } },
      { arrow: true, fill: 'accent', color: 'onAccent', upper: true },
    ),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------
// geo_arc_highlight
// ---------------------------------------------------------------------------------------------------------------------------------

const ARCS: readonly K[] = ['square', 'portrait', 'story', 'landscape'];
const t2 = kit(ARCS);
const RING = archSpec({ square: [520, 166, 500, 840], portrait: [516, 230, 504, 1000], story: [190, 1040, 700, 880], landscape: [764, 56, 392, 500] });

/**
 * geo_arc_highlight: the picture stands in a tall ARCH that rises off the bottom edge, with a solid accent arch stepped behind it, a big
 * primary quarter disc in the top-right corner and a checks block under its foot. Headline, support and the square button sit on the
 * opposite side (below the arch in story). The picture is essential: it is the one thing that tells the arches apart.
 */
const geoArcHighlight = defineTemplate({
  id: 'geo_arc_highlight',
  name: 'Arc window (stepped arches)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A picture in a tall arch with a thick ink border, a solid arch stepped behind it, a quarter disc and a checks block; headline, support and a square arrow button on the opposite side.',
  styles: ['contemporary_geometric', 'premium_editorial'],
  industries: ['design', 'architecture', 'interiors', 'furniture', 'fashion', 'product', 'creative', 'studio', 'real estate', 'lifestyle'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'frame',
  composition: 'Paper canvas; the picture in a tall bordered arch rising off the bottom edge over a stepped accent arch, a primary quarter disc top-right and a checks block; text column opposite.',
  sample: {
    headline: 'The new collection, built on curves',
    support: 'Hand-finished pieces in four colours, made to order in small batches.',
    cta: 'Shop the range',
    eyebrow: 'New arrival',
    brand: 'Atlas Studio',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    t2.circle('disc', { square: [560, -520, 1040, 1040], portrait: [520, -560, 1120, 1120], story: [660, -420, 840, 840], landscape: [886, -314, 628, 628] }, { fill: 'primary' }),
    t2.rect('block', { square: [790, 330, 290, 600], portrait: [790, 420, 290, 800], story: [760, 1200, 320, 620], landscape: [1000, 140, 200, 380] }, { fill: 'secondary' }),
    t2.circle('ring-top', RING.top, { fill: 'accent' }),
    t2.rect('ring-body', RING.body, { fill: 'accent' }),
    t2.img('photo', { square: [560, 206, 420, 724], portrait: [556, 270, 424, 900], story: [242, 1092, 596, 718], landscape: [800, 92, 320, 408] }, { mask: 'arch', focus: [0.5, 0.45] }),
    t2.rect('plinth', { square: [520, 930, 560, 150], portrait: [516, 1170, 564, 180], story: [0, 1810, 1080, 110], landscape: [700, 500, 500, 128] }, { fill: 'ink' }),
    t2.pattern('plinth-checks', { square: { box: [520, 930, 560, 150], cell: 30 }, portrait: { box: [516, 1170, 564, 180], cell: 30 }, story: { box: [0, 1810, 1080, 110], cell: 36 }, landscape: { box: [700, 500, 500, 128], cell: 21 } }, 'accent', { opacity: 1 }),
    t2.rect('rule', { square: [90, 214, 96, 14], portrait: [90, 236, 96, 14], story: [90, 412, 96, 14], landscape: [72, 112, 72, 10] }, { fill: 'ink' }),
    t2.logo('logo', { square: [90, 80, 300, 44], portrait: [90, 100, 300, 44], story: [90, 284, 300, 44], landscape: [72, 63, 300, 36] }, { nameColor: 'ink' }),
    t2.text(
      'eyebrow',
      'eyebrow',
      { square: { box: [90, 244, 420, 28], size: 21 }, portrait: { box: [90, 266, 420, 28], size: 21 }, story: { box: [90, 442, 900, 32], size: 24 }, landscape: { box: [72, 132, 420, 24], size: 16 } },
      { color: 'ink', lines: 1 },
    ),
    t2.text(
      'headline',
      'headline',
      {
        square: { box: [90, 292, 420, 360], size: [84, 48], lines: 5 },
        portrait: { box: [90, 314, 410, 470], size: [88, 50], lines: 6 },
        story: { box: [90, 490, 900, 250], size: [104, 56], lines: 3 },
        landscape: { box: [72, 164, 560, 220], size: [66, 34], lines: 4 },
      },
      { family: 'display', weight: 700, color: 'ink', lh: 1.0 },
    ),
    t2.text(
      'support',
      'support',
      {
        square: { box: [90, 676, 420, 110], size: [26, 18], lines: 4 },
        portrait: { box: [90, 806, 420, 140], size: [28, 19], lines: 5 },
        story: { box: [90, 760, 900, 92], size: [34, 22], lines: 2 },
        landscape: { box: [72, 392, 540, 70], size: [20, 15], lines: 3 },
      },
      { weight: 500, lh: 1.3, color: 'ink' },
    ),
    t2.button(
      'cta',
      { square: { box: [90, 900, 372, 86], size: [26, 19] }, portrait: { box: [90, 1130, 372, 90], size: [26, 19] }, story: { box: [90, 884, 430, 84], size: [28, 20] }, landscape: { box: [72, 486, 270, 62], size: [20, 15] } },
      { arrow: true, fill: 'ink', color: 'onInk', upper: true },
    ),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------
// geo_stripe_promo
// ---------------------------------------------------------------------------------------------------------------------------------

const STRIPES: readonly K[] = ['square', 'story', 'landscape', 'banner'];
const t3 = kit(STRIPES);
/** Chevron geometry per class: thickness, pitch, how far the apex is shifted, the first one's x and how many are drawn (all in pixels). */
const CHEVRON: Record<'square' | 'story' | 'landscape' | 'banner', { t: number; p: number; a: number; x0: number; n: number }> = {
  square: { t: 110, p: 220, a: 300, x0: -340, n: 8 },
  story: { t: 125, p: 250, a: 480, x0: -520, n: 7 },
  landscape: { t: 100, p: 200, a: 190, x0: -300, n: 9 },
  banner: { t: 70, p: 140, a: 90, x0: -200, n: 11 },
};
const chevron = (i: number): Spec<Pt[]> => {
  const out: Spec<Pt[]> = {};
  for (const k of STRIPES as readonly ('square' | 'story' | 'landscape' | 'banner')[]) {
    const { t, p, a, x0, n } = CHEVRON[k];
    if (i >= n) continue;
    const x = x0 + i * p;
    const h = C[k].height;
    out[k] = [[x, 0], [x + t, 0], [x + t + a, h / 2], [x + t, h], [x, h], [x + a, h / 2]];
  }
  return out;
};

/**
 * geo_stripe_promo: a CHEVRON FIELD. Bold right-pointing chevrons in the accent colour run across the primary canvas; a solid paper band
 * with heavy ink rules crosses them and carries the headline (and the support line), an ink tab on its top rule holds the optional tag,
 * and a square arrow button sits below. The logo sits on a paper plate over the stripes. Landscape and banner move the button into the band.
 */
const geoStripePromo = defineTemplate({
  id: 'geo_stripe_promo',
  name: 'Chevron band (promo)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'Bold chevron stripes in two colours with a solid headline band crossing them, heavy rules, a tag tab and a square arrow button. A loud, flat promotional message that needs no picture.',
  styles: ['contemporary_geometric', 'bold_startup'],
  industries: ['saas', 'software', 'technology', 'startup', 'agency', 'education', 'events', 'retail', 'fashion', 'app'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'Primary canvas crossed by accent chevron stripes; a paper band with heavy rules carries the headline, an ink tab holds the tag, a square arrow button below (in the band when wide).',
  sample: {
    headline: 'Big launch week. Bolder prices.',
    support: 'Three days only, on every plan.',
    cta: 'Claim yours',
    tag: 'Limited time',
    brand: 'Atlas Studio',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    ...Array.from({ length: 11 }, (_, i) => t3.poly(`chevron-${i + 1}`, chevron(i), { fill: 'accent' })),
    t3.rect('band', { square: [0, 430, 1080, 400], story: [0, 640, 1080, 500], landscape: [0, 150, 1200, 330], banner: [0, 52, 1200, 196] }, { fill: 'paper', stroke: { color: 'ink', width: 0.011 } }),
    t3.rect('tab', { square: [90, 398, 280, 64], story: [90, 602, 300, 70], landscape: [72, 118, 250, 56], banner: [48, 36, 190, 40] }, { fill: 'ink' }),
    t3.logo('logo', { square: [100, 90, 320, 60], story: [100, 292, 380, 72], landscape: [868, 70, 250, 46], banner: [880, 66, 272, 44] }, {
      nameColor: 'onPaper',
      plate: { fill: 'paper', padding: 0.014, radius: 0 },
      x: { landscape: { align: 'right' }, banner: { align: 'right' } },
    }),
    t3.text(
      'tag',
      'tag',
      { square: { box: [100, 398, 260, 64], size: [22, 14], lines: 1 }, story: { box: [100, 602, 280, 70], size: [24, 15], lines: 1 }, landscape: { box: [80, 118, 234, 56], size: [18, 12], lines: 1 }, banner: { box: [54, 36, 178, 40], size: [16, 11], lines: 1 } },
      { color: 'onInk', align: 'center', valign: 'middle' },
    ),
    t3.text(
      'headline',
      'headline',
      {
        square: { box: [90, 490, 900, 210], size: [104, 56], lines: 3 },
        story: { box: [90, 706, 900, 250], size: [112, 58], lines: 3, valign: 'middle' },
        landscape: { box: [72, 192, 1020, 172], size: [84, 40], lines: 2 },
        banner: { box: [48, 84, 780, 146], size: [56, 30], lines: 2, valign: 'middle' },
      },
      { family: 'display', weight: 700, color: 'onPaper', lh: 1.0 },
    ),
    t3.text(
      'support',
      'support',
      { square: { box: [90, 720, 760, 76], size: [30, 20], lines: 2 }, story: { box: [90, 990, 900, 100], size: [38, 24], lines: 2 }, landscape: { box: [72, 384, 700, 66], size: [24, 16], lines: 2 } },
      { weight: 500, lh: 1.3, color: 'onPaper' },
    ),
    t3.button(
      'cta',
      { square: { box: [90, 886, 380, 90], size: [30, 20] }, story: { box: [90, 1240, 480, 100], size: [34, 22] }, landscape: { box: [880, 376, 248, 76], size: [22, 15] }, banner: { box: [880, 134, 272, 72], size: [24, 15] } },
      { arrow: true, fill: 'ink', color: 'onInk', upper: true },
    ),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------
// geo_split_banner
// ---------------------------------------------------------------------------------------------------------------------------------

const SPLITS: readonly K[] = ['banner', 'landscape', 'square', 'portrait'];
const t4 = kit(SPLITS);

/**
 * geo_split_banner: a HARD VERTICAL SPLIT, the collection's wide format. The left block is the brand colour and carries the logo, the
 * headline and the square arrow button; a heavy ink rule separates it from the right block, a geometric composition on paper: a checks
 * strip, a circle (the optional picture, with a brand pattern when there is none) over an offset accent disc, and an ink triangle in the
 * corner. Banner keeps only logo, headline and button on the left so it reads at 1200 x 300.
 */
const geoSplitBanner = defineTemplate({
  id: 'geo_split_banner',
  name: 'Hard split (geometric banner)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A hard vertical split: the message and a square arrow button on the brand colour, a circle with an optional picture, a checks strip and a corner triangle on the other side. Reads well as a wide banner.',
  styles: ['contemporary_geometric', 'bold_startup', 'modern_corporate'],
  industries: ['saas', 'software', 'technology', 'startup', 'agency', 'education', 'consulting', 'platform', 'b2b', 'design'],
  channels: [],
  classes: ['banner', 'landscape', 'square', 'portrait'],
  requires: [],
  density: 'balanced',
  family: 'split',
  composition: 'Brand-colour block with logo, headline and button on the left, a heavy ink rule, and a paper block with a checks strip, a circle over an offset disc and a corner triangle on the right.',
  sample: {
    headline: 'One platform, zero guesswork',
    support: 'Every tool your team needs, in a single clear workspace.',
    cta: 'See how it works',
    eyebrow: 'Why teams switch',
    brand: 'Atlas Studio',
  },
  tone: 'duo',
  layers: [
    fill('paper', 'paper'),
    t4.rect('block-left', { banner: [0, 0, 700, 300], landscape: [0, 0, 660, 628], square: [0, 0, 580, 1080], portrait: [0, 0, 580, 1350] }, { fill: 'primary' }),
    t4.pattern('checks', { banner: { box: [706, 0, 96, 300], cell: 24 }, landscape: { box: [666, 0, 100, 628], cell: 25 }, square: { box: [586, 0, 100, 1080], cell: 25 }, portrait: { box: [586, 0, 100, 1350], cell: 25 } }, 'ink', { opacity: 1 }),
    t4.rect('split-rule', { banner: [694, 0, 12, 300], landscape: [654, 0, 12, 628], square: [574, 0, 12, 1080], portrait: [574, 0, 12, 1350] }, { fill: 'ink' }),
    t4.rect('block-top', { square: [686, 0, 394, 320], portrait: [686, 0, 394, 470] }, { fill: 'secondary' }),
    t4.circle('disc', { banner: [832, 56, 200, 200], landscape: [830, 126, 330, 330], square: [740, 236, 336, 336], portrait: [740, 396, 336, 336] }, { fill: 'accent' }),
    t4.img('photo', { banner: [816, 40, 200, 200], landscape: [806, 100, 330, 330], square: [716, 212, 336, 336], portrait: [716, 372, 336, 336] }, { mask: 'circle', fallback: 'brandPattern' }),
    t4.poly('triangle', { banner: [[1000, 300], [1200, 300], [1200, 60]], landscape: [[960, 628], [1200, 628], [1200, 300]], square: [[760, 1080], [1080, 1080], [1080, 640]], portrait: [[760, 1350], [1080, 1350], [1080, 900]] }, { fill: 'ink' }),
    t4.logo('logo', { banner: [48, 36, 300, 36], landscape: [72, 63, 320, 44], square: [90, 80, 320, 56], portrait: [90, 100, 320, 56] }, { nameColor: 'onPrimary' }),
    t4.text(
      'eyebrow',
      'eyebrow',
      { landscape: { box: [72, 124, 520, 24], size: 16, lines: 1 }, square: { box: [90, 300, 440, 28], size: 21, lines: 1 }, portrait: { box: [90, 372, 440, 28], size: 21, lines: 1 } },
      { color: 'onPrimary' },
    ),
    t4.text(
      'headline',
      'headline',
      {
        banner: { box: [48, 82, 610, 112], size: [52, 28], lines: 2, valign: 'middle' },
        landscape: { box: [72, 160, 540, 210], size: [70, 36], lines: 4 },
        square: { box: [90, 340, 450, 330], size: [80, 46], lines: 5 },
        portrait: { box: [90, 412, 450, 430], size: [86, 48], lines: 6 },
      },
      { family: 'display', weight: 700, color: 'onPrimary', lh: 1.0 },
    ),
    t4.text(
      'support',
      'support',
      { landscape: { box: [72, 384, 520, 70], size: [22, 15], lines: 3 }, square: { box: [90, 696, 430, 120], size: [27, 18], lines: 4 }, portrait: { box: [90, 862, 430, 130], size: [28, 19], lines: 4 } },
      { weight: 500, lh: 1.3, color: 'onPrimary' },
    ),
    t4.button(
      'cta',
      { banner: { box: [48, 206, 300, 54], size: [22, 15] }, landscape: { box: [72, 486, 300, 62], size: [22, 15] }, square: { box: [90, 870, 400, 88], size: [26, 18] }, portrait: { box: [90, 1120, 400, 90], size: [26, 18] } },
      { arrow: true, fill: 'accent', color: 'onAccent', upper: true, stroke: { color: 'ink', width: 0.003 } },
    ),
  ],
});

export const COLLECTION_TEMPLATES_C: TemplateDef[] = [geoTilesHero, geoArcHighlight, geoStripePromo, geoSplitBanner];
