import { CANVAS as C, button, circle, defineTemplate, fill, grad, img, line, logo, patch, pattern, poly, rect, text, type CanvasHelper } from '../dsl';
import type { Color, FormatClass, TemplateDef } from '../schema';

/** (centre x, centre y, side) in pixels of one class: where a sticker seal sits. */
type SealSpot = [number, number, number];

/**
 * A rotated sticker SEAL drawn from shapes: an eight-point star (two squares turned 45 degrees against each other, as hard-edged polygons so
 * no collection shadow or corner radius is applied), a ring inside it and the optional `tag` text inside the ring, turned with the seal.
 * Without a tag the seal is still a finished stamp-like badge (star and ring). `spots` gives the seal per class in pixels of that class (a
 * class without a spot has no seal). `rot` is the tilt in degrees. Used by the bold_startup templates.
 */
function seal(rot: number, spots: Partial<Record<FormatClass, SealSpot>> & { square: SealSpot }, colors: { star: Color; ring: Color; label: Color }) {
  const corners = (c: CanvasHelper, cx: number, cy: number, s: number, deg: number): Array<[number, number]> => {
    const a = (deg * Math.PI) / 180;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => c.pt(cx + (u * Math.cos(a) - v * Math.sin(a)) * (s / 2), cy + (u * Math.sin(a) + v * Math.cos(a)) * (s / 2)));
  };
  const geo = (c: CanvasHelper, [cx, cy, s]: SealSpot) => ({
    starA: corners(c, cx, cy, s, rot),
    starB: corners(c, cx, cy, s, rot + 45),
    ring: c.box(cx - s * 0.36, cy - s * 0.36, s * 0.72, s * 0.72),
    tag: [cx - s * 0.34, cy - s * 0.2, s * 0.68, s * 0.4] as [number, number, number, number],
    max: s * 0.24,
    min: s * 0.13,
  });
  const others = ['portrait', 'story', 'landscape', 'banner'] as const;
  const classes = others.filter((k) => spots[k]);
  const hidden = others.filter((k) => !spots[k]);
  const sq = geo(C.square, spots.square);
  const at = (pick: (g: ReturnType<typeof geo>) => unknown, key: string) => Object.fromEntries(classes.map((k) => [k, { [key]: pick(geo(C[k], spots[k]!)) }]));
  return [
    poly('seal-a', sq.starA, { fill: colors.star, at: at((g) => g.starA, 'points'), hide: hidden }),
    poly('seal-b', sq.starB, { fill: colors.star, at: at((g) => g.starB, 'points'), hide: hidden }),
    circle('seal-ring', sq.ring, { stroke: { color: colors.ring, width: 0.004 }, at: at((g) => g.ring, 'box'), hide: hidden }),
    text('seal-tag', 'tag', C.square.box(...sq.tag), {
      size: [sq.max / C.square.unit, sq.min / C.square.unit],
      upper: true,
      weight: 800,
      color: colors.label,
      align: 'center',
      valign: 'middle',
      lines: 2,
      lh: 1.0,
      rotate: rot,
      at: Object.fromEntries(classes.map((k) => [k, patch(C[k], { box: geo(C[k], spots[k]!).tag, size: [geo(C[k], spots[k]!).max, geo(C[k], spots[k]!).min] })])),
      hide: hidden,
    }),
  ];
}

/**
 * mtech_release_notice (Minimal Tech): a RELEASE NOTICE set like a changelog entry. One heavy vertical rule runs down the left edge with a
 * single small accent square at its head, like a node on a timeline; everything hangs off that column: a mono label row (label left, version
 * right), a bottom-anchored headline, one support line, an outlined button and the brand at the foot of the rule. Nothing else: no picture,
 * no shapes, most of the frame is empty on purpose. Banner turns the rule into a short bar and puts brand and button in a right column.
 */
const mtechReleaseNotice = defineTemplate({
  id: 'mtech_release_notice',
  name: 'Release notice (changelog rule)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A quiet release announcement: a heavy vertical rule with one accent node, a mono label row, a big left-aligned headline, one support line and an outlined button.',
  styles: ['minimalist_tech', 'modern_corporate'],
  industries: ['saas', 'software', 'technology', 'ai', 'devtools', 'fintech', 'startup', 'b2b'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'airy',
  family: 'poster-type',
  composition: 'Paper canvas, a heavy vertical rule with one accent node, mono label row, bottom-anchored headline, support line, outlined button and brand at the foot of the rule.',
  sample: {
    headline: 'Reports now refresh in real time',
    support: 'Live dashboards, shared views and no more manual exports.',
    cta: 'Read the notes',
    eyebrow: 'Release notes',
    tag: 'v2.4',
    brand: 'Northwind',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    rect('rule', C.square.box(86, 100, 5, 884), {
      fill: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [86, 108, 5, 1128] }),
        story: patch(C.story, { box: [86, 296, 6, 664] }),
        banner: patch(C.banner, { box: [48, 44, 4, 212] }),
      },
    }),
    rect('node', C.square.box(77, 88, 24, 24), {
      fill: 'accent',
      stroke: { color: 'ink', width: 0.0015 },
      at: {
        portrait: patch(C.portrait, { box: [77, 96, 24, 24] }),
        story: patch(C.story, { box: [77, 284, 26, 26] }),
        banner: patch(C.banner, { box: [41, 38, 18, 18] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(150, 84, 470, 32), {
      size: C.square.size(21),
      family: 'mono',
      upper: true,
      tracking: 0.1,
      weight: 600,
      color: 'muted',
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [150, 96, 470, 26], size: 21 }),
        story: patch(C.story, { box: [150, 278, 450, 38], size: 24 }),
        banner: patch(C.banner, { box: [96, 36, 520, 26], size: 14 }),
      },
    }),
    text('tag', 'tag', C.square.box(634, 84, 360, 32), {
      size: C.square.size(21),
      family: 'mono',
      upper: true,
      tracking: 0.1,
      weight: 600,
      color: 'muted',
      align: 'right',
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [634, 96, 360, 26], size: 21 }),
        story: patch(C.story, { box: [614, 278, 380, 38], size: 24 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(150, 176, 844, 480), {
      size: C.square.size(124, 60),
      weight: 600,
      lh: 1.0,
      tracking: -0.03,
      color: 'ink',
      lines: 4,
      valign: 'bottom',
      at: {
        portrait: patch(C.portrait, { box: [150, 220, 844, 620], size: [128, 64] }),
        story: patch(C.story, { box: [150, 400, 844, 760], size: [140, 72], maxLines: 5, valign: 'top' }),
        banner: patch(C.banner, { box: [96, 76, 740, 170], size: [64, 30], maxLines: 3, valign: 'middle' }),
      },
    }),
    text('support', 'support', C.square.box(150, 700, 520, 110), {
      size: C.square.size(28, 22),
      weight: 400,
      lh: 1.34,
      color: 'ink',
      opacity: 0.8,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [150, 872, 520, 110], size: [29, 22] }),
        story: patch(C.story, { box: [86, 1212, 800, 130], size: [36, 26] }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(700, 706, 294, 64), {
      fill: 'paper',
      stroke: { color: 'ink', width: 0.002 },
      color: 'ink',
      arrow: true,
      size: C.square.size(25, 19),
      at: {
        portrait: patch(C.portrait, { box: [700, 880, 294, 66], size: [25, 19] }),
        story: patch(C.story, { box: [86, 1384, 400, 80], size: [30, 22] }),
        banner: patch(C.banner, { box: [900, 198, 252, 52], size: [19, 14] }),
      },
    }),
    logo('logo', C.square.box(150, 928, 400, 52), {
      nameColor: 'ink',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [150, 1182, 400, 52] }),
        story: patch(C.story, { box: [86, 1566, 440, 58] }),
        banner: patch(C.banner, { box: [900, 38, 252, 34], align: 'right' }),
      },
    }),
  ],
});

/**
 * bold_big_claim (Bold Startup): ONE OVERSIZED CLAIM on the solid brand color. The headline sits on an accent slab, tilted a few degrees,
 * with a hard ink block offset behind it (a chunky shadow), a rotated sticker seal (star, disc and the optional tag) overlapping its corner,
 * the brand top-left, an optional support line and a pill button with its own hard shadow. Everything is centered on the slab.
 */
const boldBigClaim = defineTemplate({
  id: 'bold_big_claim',
  name: 'Big claim (tilted slab and sticker)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'The brand color as a solid field and one huge claim on a tilted accent slab with a hard offset shadow, a rotated sticker seal and a pill button.',
  styles: ['bold_startup', 'contemporary_geometric'],
  industries: ['startup', 'saas', 'app', 'ecommerce', 'fintech', 'marketplace', 'consumer', 'launch'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'centered',
  composition: 'Solid brand field, a tilted accent slab with a hard ink offset block carrying the huge centered claim, a rotated sticker seal on its corner, pill button below.',
  sample: {
    headline: 'Ship it before lunch',
    support: 'Go from idea to live product in a single afternoon.',
    cta: 'Start building',
    tag: 'New',
    brand: 'Northwind',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    pattern('dots', C.square.box(640, 760, 440, 320), 'dots', 'onPrimary', 0.04, {
      opacity: 0.2,
      at: {
        portrait: patch(C.portrait, { box: [600, 1010, 480, 340] }),
        story: patch(C.story, { box: [560, 1560, 520, 360] }),
        landscape: patch(C.landscape, { box: [780, 440, 420, 188] }),
      },
    }),
    rect('slab-shadow', C.square.box(68, 223, 980, 500), {
      fill: 'ink',
      rotate: -3,
      at: {
        portrait: patch(C.portrait, { box: [68, 328, 980, 610] }),
        story: patch(C.story, { box: [68, 508, 980, 820] }),
        landscape: patch(C.landscape, { box: [56, 126, 1030, 340] }),
      },
    }),
    rect('slab', C.square.box(50, 205, 980, 500), {
      fill: 'accent',
      rotate: -3,
      at: {
        portrait: patch(C.portrait, { box: [50, 310, 980, 610] }),
        story: patch(C.story, { box: [50, 490, 980, 820] }),
        landscape: patch(C.landscape, { box: [40, 112, 1030, 340] }),
      },
    }),
    ...seal(-12, { square: [915, 150, 150], portrait: [915, 245, 160], story: [905, 370, 190], landscape: [1068, 126, 140] }, { star: 'paper', ring: 'ink', label: 'ink' }),
    logo('logo', C.square.box(86, 84, 360, 56), {
      nameColor: 'onPrimary',
      nameWeight: 800,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 360, 56] }),
        story: patch(C.story, { box: [86, 290, 400, 60] }),
        landscape: patch(C.landscape, { box: [72, 64, 300, 44] }),
      },
    }),
    text('headline', 'headline', C.square.box(96, 241, 888, 428), {
      size: C.square.size(146, 70),
      weight: 800,
      lh: 0.94,
      tracking: -0.03,
      color: 'onAccent',
      align: 'center',
      valign: 'middle',
      lines: 4,
      rotate: -3,
      at: {
        portrait: patch(C.portrait, { box: [96, 346, 888, 538], size: [160, 76] }),
        story: patch(C.story, { box: [96, 540, 888, 720], size: [190, 90], maxLines: 5 }),
        landscape: patch(C.landscape, { box: [90, 128, 930, 308], size: [112, 48], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(190, 804, 700, 80), {
      size: C.square.size(29, 22),
      weight: 600,
      lh: 1.28,
      color: 'onPrimary',
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [190, 1020, 700, 84], size: [30, 22] }),
        story: patch(C.story, { box: [150, 1390, 780, 110], size: [38, 28] }),
      },
      hide: ['landscape'],
    }),
    rect('cta-shadow', C.square.box(334, 922, 420, 62), {
      fill: 'ink',
      radius: 0.5,
      at: {
        portrait: patch(C.portrait, { box: [324, 1160, 460, 66] }),
        story: patch(C.story, { box: [310, 1552, 460, 68] }),
      },
      hide: ['landscape'],
    }),
    button('cta', C.square.box(320, 910, 420, 62), {
      fill: 'paper',
      color: 'onPaper',
      stroke: { color: 'ink', width: 0.004 },
      arrow: true,
      size: C.square.size(28, 20),
      at: {
        portrait: patch(C.portrait, { box: [310, 1148, 460, 66], size: [30, 21] }),
        story: patch(C.story, { box: [296, 1540, 460, 68], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [420, 508, 270, 52], size: [22, 15] }),
      },
    }),
  ],
});

type Pt = [number, number];

/** A polygon written in pixels of one class (points as pixel pairs). */
const px = (c: CanvasHelper, pts: Pt[]): Pt[] => pts.map(([x, y]) => c.pt(x, y));

/**
 * bold_split_pop (Bold Startup): TWO HARD COLOR BLOCKS with a slanted seam. The brand color holds the headline, support and a pill button;
 * an accent block (cut with an angled edge, an ink stripe along the seam) holds a tilted picture in a thick border, and a rotated sticker seal
 * sits on the seam. Square and landscape split left / right, story splits top / bottom, banner is a slim left / right split.
 */
const boldSplitPop = defineTemplate({
  id: 'bold_split_pop',
  name: 'Split pop (angled color blocks)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'Two hard color blocks with an angled seam: the headline and button on the brand color, a tilted picture in a thick border on the accent block and a rotated sticker.',
  styles: ['bold_startup', 'contemporary_geometric'],
  industries: ['startup', 'saas', 'app', 'ecommerce', 'consumer', 'events', 'education', 'marketplace'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'split',
  composition: 'Brand-color block with the headline, support and pill button; accent block with an angled seam, ink stripe, a tilted bordered picture and a rotated sticker seal.',
  sample: {
    headline: 'Launch day is finally here',
    support: 'Be one of the first teams to try it, free for 30 days.',
    cta: 'Join the launch',
    tag: 'Live',
    brand: 'Northwind',
  },
  tone: 'duo',
  layers: [
    fill('bg', 'primary'),
    poly('block', px(C.square, [[650, 0], [1080, 0], [1080, 1080], [480, 1080]]), {
      fill: 'accent',
      at: {
        story: { points: px(C.story, [[0, 1150], [1080, 1020], [1080, 1920], [0, 1920]]) },
        landscape: { points: px(C.landscape, [[700, 0], [1200, 0], [1200, 628], [620, 628]]) },
        banner: { points: px(C.banner, [[820, 0], [1200, 0], [1200, 300], [760, 300]]) },
      },
    }),
    poly('stripe', px(C.square, [[650, 0], [694, 0], [524, 1080], [480, 1080]]), {
      fill: 'ink',
      at: {
        story: { points: px(C.story, [[0, 1150], [1080, 1020], [1080, 1064], [0, 1194]]) },
        landscape: { points: px(C.landscape, [[700, 0], [738, 0], [658, 628], [620, 628]]) },
        banner: { points: px(C.banner, [[820, 0], [850, 0], [790, 300], [760, 300]]) },
      },
    }),
    img('photo', 'hero', C.square.box(668, 150, 360, 500), {
      mask: 'rounded',
      radius: 0.05,
      border: { color: 'ink', width: 0.01 },
      rotate: 3,
      fallback: 'brandPattern',
      at: {
        story: patch(C.story, { box: [150, 1236, 780, 404] }),
        landscape: patch(C.landscape, { box: [770, 74, 370, 440] }),
        banner: patch(C.banner, { box: [905, 30, 240, 240] }),
      },
    }),
    ...seal(-10, { square: [650, 700, 150], story: [190, 1210, 190], landscape: [736, 500, 130], banner: [872, 236, 88] }, { star: 'paper', ring: 'ink', label: 'ink' }),
    logo('logo', C.square.box(86, 84, 320, 52), {
      nameColor: 'onPrimary',
      nameWeight: 800,
      at: {
        story: patch(C.story, { box: [86, 290, 400, 60] }),
        landscape: patch(C.landscape, { box: [72, 66, 280, 40] }),
        banner: patch(C.banner, { box: [48, 36, 240, 30] }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 190, 430, 470), {
      size: C.square.size(110, 54),
      weight: 800,
      lh: 0.98,
      tracking: -0.03,
      color: 'onPrimary',
      lines: 5,
      valign: 'bottom',
      at: {
        story: patch(C.story, { box: [86, 372, 908, 450], size: [140, 70], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 118, 500, 292], size: [78, 34], maxLines: 3 }),
        banner: patch(C.banner, { box: [48, 76, 700, 112], size: [54, 28], maxLines: 3, valign: 'middle' }),
      },
    }),
    text('support', 'support', C.square.box(86, 690, 410, 100), {
      size: C.square.size(28, 21),
      weight: 600,
      lh: 1.3,
      color: 'onPrimary',
      lines: 3,
      at: { story: patch(C.story, { box: [86, 850, 760, 100], size: [36, 26], maxLines: 2 }) },
      hide: ['landscape', 'banner'],
    }),
    button('cta', C.square.box(86, 858, 340, 66), {
      fill: 'accent',
      color: 'onAccent',
      arrow: true,
      size: C.square.size(28, 20),
      at: {
        story: patch(C.story, { box: [86, 966, 420, 80], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [72, 450, 260, 56], size: [22, 15] }),
        banner: patch(C.banner, { box: [48, 204, 240, 50], size: [20, 14] }),
      },
    }),
  ],
});

type Row = [number, number, number];

/** A horizontal hairline written in pixels of each class as (y, x1, x2); a class without an entry has no line. */
const hairline = (id: string, color: Color, opacity: number, per: Partial<Record<'portrait' | 'story' | 'landscape' | 'banner', Row>> & { square: Row }, width = 0.0016) => {
  const mk = (c: CanvasHelper, [y, x1, x2]: Row) => ({ from: c.pt(x1, y), to: c.pt(x2, y) });
  const others = ['portrait', 'story', 'landscape', 'banner'] as const;
  return line(id, mk(C.square, per.square).from, mk(C.square, per.square).to, { color, width }, {
    opacity,
    at: Object.fromEntries(others.filter((k) => per[k]).map((k) => [k, mk(C[k], per[k]!)])),
    hide: others.filter((k) => !per[k]),
  });
};

/**
 * editorial_cover_story (Premium Editorial): A MAGAZINE COVER. The picture runs full-bleed under a soft scrim; the brand name is the masthead,
 * set between two hairlines at the top with a small issue line (eyebrow left, tag right) under it. The headline is a large serif anchored
 * low on the left, and a hairline closes the page over a footer row: one short support line and a plain square button.
 */
const editorialCoverStory = defineTemplate({
  id: 'editorial_cover_story',
  name: 'Cover story (magazine cover)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A full-bleed picture as a magazine cover: masthead between two hairlines, an issue line, a large serif headline low on the left and a quiet footer row with a square button.',
  styles: ['premium_editorial', 'luxury_hospitality'],
  industries: ['publishing', 'fashion', 'design', 'interior', 'architecture', 'lifestyle', 'travel', 'jewelry', 'photography'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'full-bleed',
  composition: 'Full-bleed picture with soft scrims, the brand as a masthead between two hairlines with an issue line, a large serif headline anchored low-left, hairline and footer row (support, square button).',
  sample: {
    headline: 'Inside the house that was never rushed',
    support: 'A season with the makers who still work by hand.',
    cta: 'Read the story',
    eyebrow: 'The craft issue',
    tag: 'No. 12 · Spring',
    brand: 'Atelier North',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { focus: [0.5, 0.45] }),
    rect('scrim-top', C.square.box(0, 0, 1080, 400), {
      fill: grad(90, [0, 'ink', 0.92], [0.6, 'ink', 0.84], [1, 'ink', 0]),
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 440] }), story: patch(C.story, { box: [0, 0, 1080, 760] }), landscape: patch(C.landscape, { box: [0, 0, 1200, 280] }) },
    }),
    rect('scrim-bottom', C.square.box(0, 330, 1080, 750), {
      fill: grad(90, [0, 'ink', 0], [0.3, 'ink', 0.58], [0.62, 'ink', 0.84], [1, 'ink', 0.93]),
      at: { portrait: patch(C.portrait, { box: [0, 420, 1080, 930] }), story: patch(C.story, { box: [0, 640, 1080, 1280] }), landscape: patch(C.landscape, { box: [0, 130, 1200, 498] }) },
    }),
    hairline('mast-top', 'onInk', 0.8, { square: [84, 86, 994], portrait: [100, 86, 994], story: [282, 86, 994], landscape: [68, 72, 1128] }),
    hairline('mast-bottom', 'onInk', 0.8, { square: [178, 86, 994], portrait: [196, 86, 994], story: [398, 86, 994], landscape: [128, 72, 1128] }),
    logo('logo', C.square.box(86, 96, 908, 70), {
      align: 'center',
      nameFamily: 'serif',
      nameWeight: 600,
      nameColor: 'onInk',
      at: {
        portrait: patch(C.portrait, { box: [86, 114, 908, 70] }),
        story: patch(C.story, { box: [86, 296, 908, 90] }),
        landscape: patch(C.landscape, { box: [72, 76, 1056, 44] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 194, 520, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.14,
      weight: 600,
      color: 'onInk',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 212, 520, 28], size: 20 }),
        story: patch(C.story, { box: [86, 414, 520, 34], size: 24 }),
        landscape: patch(C.landscape, { box: [72, 138, 520, 24], size: 15 }),
      },
    }),
    text('tag', 'tag', C.square.box(594, 194, 400, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.14,
      weight: 600,
      color: 'onInk',
      align: 'right',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [594, 212, 400, 28], size: 20 }),
        story: patch(C.story, { box: [534, 414, 460, 34], size: 24 }),
        landscape: patch(C.landscape, { box: [628, 138, 500, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 440, 800, 410), {
      size: C.square.size(104, 54),
      family: 'serif',
      weight: 500,
      lh: 1.04,
      tracking: -0.015,
      color: 'onInk',
      lines: 4,
      valign: 'bottom',
      at: {
        portrait: patch(C.portrait, { box: [86, 630, 820, 460], size: [116, 58] }),
        story: patch(C.story, { box: [86, 760, 908, 560], size: [138, 70], maxLines: 5 }),
        landscape: patch(C.landscape, { box: [72, 176, 840, 252], size: [72, 38], maxLines: 3 }),
      },
    }),
    hairline('foot-rule', 'onInk', 0.7, { square: [884, 86, 994], portrait: [1114, 86, 994], story: [1350, 86, 994], landscape: [482, 72, 1128] }),
    text('support', 'support', C.square.box(86, 906, 590, 80), {
      size: C.square.size(26, 20),
      weight: 400,
      lh: 1.34,
      color: 'onInk',
      opacity: 0.92,
      lines: 2,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 1138, 600, 84], size: [27, 20] }),
        story: patch(C.story, { box: [86, 1372, 908, 100], size: [32, 24], valign: 'top' }),
        landscape: patch(C.landscape, { box: [72, 498, 660, 60], size: [20, 15] }),
      },
    }),
    button('cta', C.square.box(734, 912, 260, 60), {
      fill: 'paper',
      color: 'onPaper',
      size: C.square.size(20, 15),
      at: {
        portrait: patch(C.portrait, { box: [734, 1146, 260, 62], size: [20, 15] }),
        story: patch(C.story, { box: [86, 1500, 340, 76], size: [24, 17] }),
        landscape: patch(C.landscape, { box: [868, 498, 260, 56], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * editorial_pull_quote (Premium Editorial): A PULL QUOTE without any quotation copy. The headline is set large in serif beside a thick vertical
 * rule, vertically centered in its zone; a small tracked eyebrow sits above, the support line below it as a byline-style caption, then a
 * hairline and a footer row with a square button and the brand. A faint large disc in the brand color replaces a quotation glyph.
 * Banner keeps the rule and the headline and moves caption, button and brand into a right column.
 */
const editorialPullQuote = defineTemplate({
  id: 'editorial_pull_quote',
  name: 'Pull quote (rule and serif)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'The headline set like a magazine pull quote: large serif beside a thick vertical rule, a tracked eyebrow above, a byline-style caption below and a square button on warm paper.',
  styles: ['premium_editorial', 'modern_corporate'],
  industries: ['*'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'airy',
  family: 'quote-focus',
  composition: 'Paper canvas, faint brand disc off the top-right corner, a thick vertical rule with the serif headline centered beside it, eyebrow above, caption below, hairline and footer row.',
  sample: {
    headline: 'Good design is mostly what you leave out',
    support: 'From the studio journal, on editing and restraint.',
    cta: 'Read the essay',
    eyebrow: 'From the journal',
    brand: 'Atelier North',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    circle('disc', C.square.box(560, -330, 840, 840), {
      fill: 'primary',
      opacity: 0.12,
      at: {
        portrait: patch(C.portrait, { box: [540, -300, 880, 880] }),
        story: patch(C.story, { box: [480, -440, 920, 920] }),
        banner: patch(C.banner, { box: [840, -130, 440, 440] }),
      },
    }),
    rect('rule', C.square.box(86, 190, 10, 480), {
      fill: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [86, 200, 10, 660] }),
        story: patch(C.story, { box: [86, 420, 908, 10] }),
        banner: patch(C.banner, { box: [48, 44, 8, 212] }),
      },
    }),
    rect('rule-bottom', C.story.box(86, 1228, 908, 2), {
      fill: 'ink',
      opacity: 0.5,
      hide: ['square', 'portrait', 'banner'],
    }),
    rect('rule-accent', C.square.box(86, 190, 10, 96), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [86, 200, 10, 110] }),
        story: patch(C.story, { box: [486, 420, 108, 10] }),
        banner: patch(C.banner, { box: [48, 44, 8, 56] }),
      },
    }),
    line('divider', C.banner.pt(872, 56), C.banner.pt(872, 244), { color: 'ink', width: 0.0016 }, { opacity: 0.3, hide: ['square', 'portrait', 'story'] }),
    text('eyebrow', 'eyebrow', C.square.box(86, 96, 700, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.16,
      weight: 600,
      color: 'ink',
      opacity: 0.86,
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 112, 700, 28], size: 20 }),
        story: patch(C.story, { box: [86, 340, 908, 34], size: 24, align: 'center' }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(150, 190, 844, 480), {
      size: C.square.size(124, 54),
      family: 'serif',
      weight: 500,
      lh: 1.08,
      tracking: -0.01,
      color: 'ink',
      lines: 6,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [150, 200, 844, 660], size: [140, 56], maxLines: 7 }),
        story: patch(C.story, { box: [110, 470, 860, 740], size: [150, 64], maxLines: 8, align: 'center' }),
        banner: patch(C.banner, { box: [96, 48, 700, 204], size: [60, 28], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(150, 704, 780, 84), {
      size: C.square.size(27, 20),
      weight: 400,
      lh: 1.34,
      color: 'ink',
      opacity: 0.78,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [150, 900, 780, 90], size: [28, 20] }),
        story: patch(C.story, { box: [150, 1272, 780, 120], size: [34, 25], align: 'center' }),
        banner: patch(C.banner, { box: [896, 96, 256, 84], size: [17, 13], maxLines: 4 }),
      },
    }),
    hairline('foot-rule', 'ink', 0.3, { square: [858, 86, 994], portrait: [1112, 86, 994] }),
    button('cta', C.square.box(150, 890, 290, 62), {
      fill: 'ink',
      color: 'onInk',
      size: C.square.size(20, 15),
      at: {
        portrait: patch(C.portrait, { box: [150, 1146, 290, 64], size: [20, 15] }),
        story: patch(C.story, { box: [370, 1440, 340, 76], size: [24, 17] }),
        banner: patch(C.banner, { box: [896, 200, 256, 50], size: [16, 12] }),
      },
    }),
    logo('logo', C.square.box(594, 892, 400, 56), {
      align: 'right',
      nameFamily: 'serif',
      nameWeight: 600,
      nameColor: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [594, 1148, 400, 56] }),
        story: patch(C.story, { box: [340, 1560, 400, 60], align: 'center' }),
        banner: patch(C.banner, { box: [896, 40, 256, 40], align: 'left' }),
      },
    }),
  ],
});

/**
 * editorial_index_card (Premium Editorial): A CATALOGUE INDEX CARD. A double hairline frames the whole card on paper; a narrow picture strip
 * runs along one side (the left edge, the top edge in story) and a numbered eyebrow, a serif headline, a short support line, a hairline and a
 * footer row (square button, brand) fill the text column. Without a picture the strip is a quiet brand-colored gradient, so the card is
 * finished either way.
 */
const editorialIndexCard = defineTemplate({
  id: 'editorial_index_card',
  name: 'Index card (framed panel and picture strip)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A catalogue index card on paper: a double hairline frame, a narrow picture strip along one side, a numbered eyebrow, a serif headline, a short caption and a square button.',
  styles: ['premium_editorial', 'modern_corporate'],
  industries: ['*'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'panel',
  composition: 'Paper canvas with a double hairline frame, a narrow picture strip along the left (top in story) and a text column: numbered eyebrow, hairline, serif headline, caption, hairline, button and brand.',
  sample: {
    headline: 'Slow furniture for well-made rooms',
    support: 'Eleven new pieces, made to order in small workshops.',
    cta: 'View the catalogue',
    eyebrow: 'No. 07 · Spring catalogue',
    brand: 'Atelier North',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    img('strip', 'hero', C.square.box(64, 64, 250, 952), {
      fallback: 'gradient',
      focus: [0.5, 0.5],
      at: {
        portrait: patch(C.portrait, { box: [64, 64, 250, 1222] }),
        story: patch(C.story, { box: [64, 64, 952, 640] }),
        landscape: patch(C.landscape, { box: [42, 42, 250, 544] }),
      },
    }),
    rect('frame-outer', C.square.box(48, 48, 984, 984), {
      stroke: { color: 'ink', width: 0.002 },
      opacity: 0.85,
      at: {
        portrait: patch(C.portrait, { box: [48, 48, 984, 1254] }),
        story: patch(C.story, { box: [48, 48, 984, 1824] }),
        landscape: patch(C.landscape, { box: [28, 28, 1144, 572] }),
      },
    }),
    rect('frame-inner', C.square.box(64, 64, 952, 952), {
      stroke: { color: 'ink', width: 0.0011 },
      opacity: 0.6,
      at: {
        portrait: patch(C.portrait, { box: [64, 64, 952, 1222] }),
        story: patch(C.story, { box: [64, 64, 952, 1792] }),
        landscape: patch(C.landscape, { box: [42, 42, 1116, 544] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(372, 112, 608, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.16,
      weight: 600,
      color: 'ink',
      opacity: 0.86,
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [372, 112, 608, 28], size: 20 }),
        story: patch(C.story, { box: [120, 748, 840, 34], size: 24 }),
        landscape: patch(C.landscape, { box: [340, 76, 788, 24], size: 15 }),
      },
    }),
    hairline('head-rule', 'ink', 0.4, { square: [162, 372, 980], portrait: [162, 372, 980], story: [808, 120, 960], landscape: [114, 340, 1128] }),
    text('headline', 'headline', C.square.box(372, 190, 608, 430), {
      size: C.square.size(94, 46),
      family: 'serif',
      weight: 500,
      lh: 1.08,
      tracking: -0.01,
      color: 'ink',
      lines: 5,
      valign: 'bottom',
      at: {
        portrait: patch(C.portrait, { box: [372, 190, 608, 650], size: [108, 48], maxLines: 6 }),
        story: patch(C.story, { box: [120, 836, 840, 430], size: [126, 60], maxLines: 5 }),
        landscape: patch(C.landscape, { box: [340, 126, 788, 254], size: [76, 36], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(372, 648, 608, 110), {
      size: C.square.size(27, 20),
      weight: 400,
      lh: 1.36,
      color: 'ink',
      opacity: 0.8,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [372, 868, 608, 130], size: [28, 20] }),
        story: patch(C.story, { box: [120, 1312, 840, 140], size: [34, 25] }),
        landscape: patch(C.landscape, { box: [340, 394, 788, 56], size: [20, 15], maxLines: 2 }),
      },
    }),
    hairline('foot-rule', 'ink', 0.4, { square: [868, 372, 980], portrait: [1116, 372, 980], story: [1520, 120, 960], landscape: [470, 340, 1128] }),
    button('cta', C.square.box(372, 898, 290, 60), {
      fill: 'ink',
      color: 'onInk',
      size: C.square.size(19, 14),
      at: {
        portrait: patch(C.portrait, { box: [372, 1146, 290, 62], size: [19, 14] }),
        story: patch(C.story, { box: [120, 1552, 360, 76], size: [24, 17] }),
        landscape: patch(C.landscape, { box: [340, 490, 250, 52], size: [16, 12] }),
      },
    }),
    logo('logo', C.square.box(680, 898, 300, 60), {
      align: 'right',
      nameFamily: 'serif',
      nameWeight: 600,
      nameColor: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [680, 1146, 300, 62] }),
        story: patch(C.story, { box: [560, 1552, 400, 76] }),
        landscape: patch(C.landscape, { box: [828, 490, 300, 52] }),
      },
    }),
  ],
});

export const COLLECTION_TEMPLATES_A: TemplateDef[] = [mtechReleaseNotice, boldBigClaim, boldSplitPop, editorialCoverStory, editorialPullQuote, editorialIndexCard];
