import { CANVAS as C, button, circle, defineTemplate, fill, img, line, logo, pattern, patch, poly, rect, text, type CanvasHelper } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * services_corporate_announcement: a BAND composition. A full-width brand-colored band crosses the canvas and carries the headline; an
 * accent spine marks its left end and an accent strip its lower edge. The brand name and date sit above on paper, the explanation and
 * the button below it. Square and portrait stack header, band and footer; landscape and banner turn the band into a tall left block with the
 * brand, details and button in a column on the right.
 */
const servicesCorporateAnnouncement = defineTemplate({
  id: 'services_corporate_announcement',
  name: 'Corporate announcement (band)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A confident announcement: a full-width brand band carries the headline between a header with the brand and date and a footer with a short explanation and a button.',
  styles: ['modern_corporate', 'premium_editorial'],
  industries: ['consulting', 'legal', 'accounting', 'finance', 'insurance', 'b2b', 'agency', 'real estate', 'business'],
  channels: [],
  classes: ['square', 'portrait', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'Paper canvas crossed by a full-width brand band with the headline, an accent spine and strip, header above and explanation plus button below.',
  sample: {
    headline: 'We are expanding our advisory team',
    support: 'New senior advisors join us this quarter to support growing companies.',
    cta: 'Read the news',
    eyebrow: 'Company news',
    date: '12 May',
    brand: 'Northwind Partners',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    rect('band', C.square.box(0, 290, 1080, 420), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [0, 330, 1080, 520] }),
        landscape: patch(C.landscape, { box: [0, 0, 744, 628] }),
        banner: patch(C.banner, { box: [0, 0, 770, 300] }),
      },
    }),
    rect('spine', C.square.box(0, 290, 30, 420), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [0, 330, 30, 520] }),
        landscape: patch(C.landscape, { box: [0, 0, 24, 628] }),
        banner: patch(C.banner, { box: [0, 0, 16, 300] }),
      },
    }),
    rect('strip', C.square.box(0, 710, 1080, 12), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [0, 850, 1080, 12] }),
        landscape: patch(C.landscape, { box: [744, 0, 10, 628] }),
        banner: patch(C.banner, { box: [770, 0, 10, 300] }),
      },
    }),
    logo('logo', C.square.box(86, 80, 360, 46), {
      nameColor: 'ink',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 360, 46] }),
        landscape: patch(C.landscape, { box: [794, 64, 334, 36] }),
        banner: patch(C.banner, { box: [822, 36, 330, 34] }),
      },
    }),
    text('date', 'date', C.square.box(594, 84, 392, 40), {
      size: C.square.size(28, 20),
      upper: true,
      tracking: 0.1,
      weight: 600,
      color: 'muted',
      align: 'right',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [594, 103, 392, 40], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [794, 114, 334, 30], size: [20, 14], align: 'left' }),
      },
      hide: ['banner'],
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 236, 700, 30), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.18,
      weight: 700,
      color: 'ink',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 276, 700, 30], size: 22 }),
        landscape: patch(C.landscape, { box: [794, 190, 334, 24], size: 15 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(86, 322, 908, 356), {
      size: C.square.size(104, 54),
      weight: 800,
      lh: 1.03,
      tracking: -0.02,
      color: 'onPrimary',
      valign: 'middle',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 366, 908, 450], size: [116, 58] }),
        landscape: patch(C.landscape, { box: [72, 64, 636, 500], size: [80, 36], maxLines: 6 }),
        banner: patch(C.banner, { box: [48, 36, 690, 228], size: [52, 26], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(86, 760, 908, 110), {
      size: C.square.size(30, 22),
      weight: 400,
      lh: 1.34,
      color: 'ink',
      opacity: 0.86,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 910, 908, 130], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [794, 228, 334, 220], size: [22, 16], maxLines: 8 }),
        banner: patch(C.banner, { box: [822, 84, 330, 104], size: [18, 14], maxLines: 4 }),
      },
    }),
    button('cta', C.square.box(86, 892, 360, 72), {
      arrow: true,
      size: C.square.size(28, 20),
      at: {
        portrait: patch(C.portrait, { box: [86, 1090, 420, 74], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [794, 480, 334, 56], size: [20, 15] }),
        banner: patch(C.banner, { box: [822, 204, 330, 52], size: [19, 14] }),
      },
    }),
  ],
});

/** A bold check mark inside a square of `d` pixels at (x, y) of one class (the "verified" cue of the accent tile). */
const tick = (c: CanvasHelper, x: number, y: number, d: number) =>
  ([[0.2, 0.52], [0.3, 0.42], [0.44, 0.56], [0.7, 0.28], [0.8, 0.38], [0.44, 0.76]] as Array<[number, number]>).map(([u, v]) => c.pt(x + u * d, y + v * d));

/**
 * services_trust: a COLLAGE of rounded tiles (a "bento" mosaic) that builds credibility. A rounded picture, a brand-colored tile holding
 * the stat and its label, an accent tile with a check mark and an ink tile with dots sit beside each other under the message. Square and
 * portrait put the headline on top and the mosaic below; landscape puts the message left and the mosaic right.
 */
const servicesTrust = defineTemplate({
  id: 'services_trust',
  name: 'Trust and credibility (tile mosaic)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A tidy mosaic of rounded tiles (picture, a number with its label, a verified check, a dotted block) under a calm headline: credibility at a glance.',
  styles: ['modern_corporate', 'contemporary_geometric', 'soft_lifestyle'],
  industries: ['consulting', 'legal', 'accounting', 'finance', 'insurance', 'healthcare', 'real estate', 'b2b', 'agency'],
  channels: [],
  classes: ['square', 'portrait', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'collage',
  composition: 'Paper canvas, headline on top and a bento mosaic of four rounded tiles (picture, stat, check, dots) below; mosaic on the right in landscape.',
  sample: {
    headline: 'Advice you can rely on, year after year',
    support: 'A dedicated team that knows your business and answers when you call.',
    cta: 'Book a call',
    eyebrow: 'Why clients stay',
    stat: '15+',
    statLabel: 'years of experience',
    brand: 'Northwind Partners',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    logo('logo', C.square.box(86, 80, 360, 46), {
      nameColor: 'ink',
      nameWeight: 700,
      tracking: -0.01,
      at: { portrait: patch(C.portrait, { box: [86, 100, 360, 46] }), landscape: patch(C.landscape, { box: [72, 64, 300, 38] }) },
    }),
    img('photo', 'hero', C.square.box(86, 480, 440, 384), {
      mask: 'rounded',
      radius: 0.06,
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [86, 560, 440, 500] }),
        landscape: patch(C.landscape, { box: [604, 64, 524, 232], radius: 0.1 }),
      },
    }),
    rect('tile-stat', C.square.box(550, 480, 444, 184), {
      fill: 'primary',
      radius: 0.13,
      at: { portrait: patch(C.portrait, { box: [550, 560, 444, 236] }), landscape: patch(C.landscape, { box: [604, 320, 296, 244], radius: 0.1 }) },
    }),
    rect('tile-check', C.square.box(550, 688, 214, 176), {
      fill: 'accent',
      radius: 0.14,
      at: { portrait: patch(C.portrait, { box: [550, 820, 214, 240] }), landscape: patch(C.landscape, { box: [920, 320, 208, 116], radius: 0.2 }) },
    }),
    poly('check', tick(C.square, 609, 728, 96), {
      fill: 'onAccent',
      at: { portrait: { points: tick(C.portrait, 609, 892, 96) }, landscape: { points: tick(C.landscape, 975, 330, 98) } },
    }),
    rect('tile-dots', C.square.box(780, 688, 214, 176), {
      fill: 'ink',
      radius: 0.14,
      at: { portrait: patch(C.portrait, { box: [780, 820, 214, 240] }), landscape: patch(C.landscape, { box: [920, 448, 208, 116], radius: 0.2 }) },
    }),
    pattern('dots', C.square.box(808, 716, 158, 120), 'dots', 'onInk', 0.026, {
      opacity: 0.4,
      at: { portrait: patch(C.portrait, { box: [808, 848, 158, 184] }), landscape: patch(C.landscape, { box: [944, 468, 160, 76] }) },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 156, 700, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'muted',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 182, 700, 28], size: 22 }),
        landscape: patch(C.landscape, { box: [72, 134, 480, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 196, 908, 250), {
      size: C.square.size(88, 48),
      weight: 800,
      lh: 1.04,
      tracking: -0.02,
      color: 'ink',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 222, 908, 300], size: [100, 52] }),
        landscape: patch(C.landscape, { box: [72, 166, 490, 214], size: [54, 30], maxLines: 5 }),
      },
    }),
    text('stat', 'stat', C.square.box(584, 488, 376, 106), {
      size: C.square.size(92, 44),
      weight: 800,
      lh: 1,
      tracking: -0.02,
      color: 'onPrimary',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [584, 580, 376, 120], size: [116, 48] }),
        landscape: patch(C.landscape, { box: [632, 338, 240, 108], size: [92, 40] }),
      },
    }),
    text('stat-label', 'statLabel', C.square.box(584, 596, 376, 54), {
      size: C.square.size(26, 16),
      weight: 600,
      lh: 1.2,
      color: 'onPrimary',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [584, 708, 376, 70], size: [28, 16] }),
        landscape: patch(C.landscape, { box: [632, 450, 240, 90], size: [20, 14], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 894, 580, 86), {
      size: C.square.size(26, 20),
      weight: 400,
      lh: 1.34,
      color: 'ink',
      opacity: 0.85,
      lines: 3,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 1096, 580, 100], size: [27, 20] }),
        landscape: patch(C.landscape, { box: [72, 394, 490, 62], size: [20, 15], valign: 'top' }),
      },
    }),
    button('cta', C.square.box(654, 900, 340, 72), {
      fill: 'ink',
      color: 'onInk',
      arrow: true,
      size: C.square.size(28, 20),
      at: {
        portrait: patch(C.portrait, { box: [654, 1124, 340, 72], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [72, 482, 270, 56], size: [20, 15] }),
      },
    }),
  ],
});

/**
 * services_explainer: a SPLIT of two text columns, no picture. A brand-colored panel carries the brand, the label and a big headline (the
 * question or the service name); beside it, on paper, the explanation is set large and readable, closed by a hairline and a button. A
 * tonal circle bleeds off the panel and an accent strip marks the seam. Square and landscape split left/right, portrait top/bottom.
 */
const servicesExplainer = defineTemplate({
  id: 'services_explainer',
  name: 'Service explainer (split columns)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A text-first split layout: the service name as a big headline on a brand panel, a clear readable explanation beside it and a button. No picture needed.',
  styles: ['modern_corporate', 'premium_editorial', 'minimalist_tech'],
  industries: ['consulting', 'legal', 'accounting', 'finance', 'insurance', 'b2b', 'agency', 'education', 'training'],
  channels: [],
  classes: ['square', 'portrait', 'landscape'],
  requires: [],
  density: 'dense',
  family: 'split',
  composition: 'Two columns split by an accent seam: brand panel with logo, label and big headline; paper column with a large explanation, hairline and button (stacked in portrait).',
  sample: {
    headline: 'Tax planning for growing businesses',
    support: 'We review your numbers each quarter, flag savings early and prepare every filing, so deadlines never catch you by surprise.',
    cta: 'Learn more',
    eyebrow: 'Our services',
    brand: 'Northwind Partners',
  },
  tone: 'duo',
  layers: [
    fill('paper', 'paper'),
    rect('panel', C.square.box(0, 0, 520, 1080), {
      fill: 'primary',
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 660] }), landscape: patch(C.landscape, { box: [0, 0, 520, 628] }) },
    }),
    circle('deco', C.square.box(-150, 740, 600, 600), {
      fill: 'ink',
      opacity: 0.3,
      at: { portrait: patch(C.portrait, { box: [700, -230, 640, 640] }), landscape: patch(C.landscape, { box: [-110, 360, 440, 440] }) },
    }),
    rect('seam', C.square.box(520, 0, 12, 1080), {
      fill: 'accent',
      at: { portrait: patch(C.portrait, { box: [0, 660, 1080, 12] }), landscape: patch(C.landscape, { box: [520, 0, 10, 628] }) },
    }),
    logo('logo', C.square.box(86, 84, 340, 46), {
      nameColor: 'onPrimary',
      nameWeight: 700,
      tracking: -0.01,
      at: { portrait: patch(C.portrait, { box: [86, 100, 340, 46] }), landscape: patch(C.landscape, { box: [72, 64, 300, 38] }) },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 196, 400, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.18,
      weight: 700,
      color: 'onPrimary',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 214, 700, 28], size: 22 }),
        landscape: patch(C.landscape, { box: [72, 132, 400, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 242, 400, 560), {
      size: C.square.size(70, 40),
      weight: 800,
      lh: 1.04,
      tracking: -0.02,
      color: 'onPrimary',
      lines: 8,
      at: {
        portrait: patch(C.portrait, { box: [86, 262, 908, 360], size: [104, 52], maxLines: 4 }),
        landscape: patch(C.landscape, { box: [72, 168, 412, 370], size: [50, 28], maxLines: 7 }),
      },
    }),
    rect('bar', C.square.box(592, 246, 64, 8), {
      fill: 'accent',
      radius: 0.5,
      at: { portrait: patch(C.portrait, { box: [86, 744, 64, 8] }), landscape: patch(C.landscape, { box: [590, 104, 56, 6] }) },
    }),
    text('support', 'support', C.square.box(592, 288, 402, 450), {
      size: C.square.size(34, 22),
      weight: 400,
      lh: 1.34,
      color: 'ink',
      opacity: 0.9,
      lines: 8,
      at: {
        portrait: patch(C.portrait, { box: [86, 786, 908, 300], size: [40, 26], maxLines: 7 }),
        landscape: patch(C.landscape, { box: [590, 132, 538, 296], size: [32, 20], maxLines: 8 }),
      },
    }),
    line('rule', C.square.pt(592, 782), C.square.pt(994, 782), { color: 'ink', width: 0.0014 }, {
      opacity: 0.3,
      at: {
        portrait: { from: C.portrait.pt(86, 1118), to: C.portrait.pt(994, 1118) },
        landscape: { from: C.landscape.pt(590, 446), to: C.landscape.pt(1128, 446) },
      },
    }),
    button('cta', C.square.box(592, 830, 330, 72), {
      arrow: true,
      size: C.square.size(28, 20),
      at: {
        portrait: patch(C.portrait, { box: [86, 1148, 360, 72], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [590, 476, 270, 56], size: [20, 15] }),
      },
    }),
  ],
});

type Item = [number, number, number, number];
interface BadgeSpec {
  /** centre of the badge card on the canvas (pixels) and its tilt in degrees (negative = counter-clockwise) */
  cx: number;
  cy: number;
  deg: number;
  /** every element as [local centre x, local centre y, width, height] relative to the card centre, in pixels, before the tilt */
  card: Item;
  slot: Item;
  strap: Item;
  logo: Item;
  eyebrow: Item;
  headline: Item;
  /** the hairline: [local x0, local x1, local y] */
  rule: [number, number, number];
  support: Item;
  location: Item;
  cta: Item;
}

const SPECS: Record<'square' | 'portrait' | 'story', BadgeSpec> = {
  square: {
    cx: 540, cy: 590, deg: -6,
    card: [0, 0, 700, 860], slot: [0, -392, 150, 26], strap: [0, -742, 66, 700],
    logo: [-90, -322, 400, 46], eyebrow: [0, -258, 580, 28], headline: [0, -80, 580, 320], rule: [-290, 290, 112],
    support: [0, 178, 580, 96], location: [0, 258, 580, 30], cta: [-120, 340, 340, 70],
  },
  portrait: {
    cx: 540, cy: 700, deg: -6,
    card: [0, 0, 760, 1020], slot: [0, -470, 160, 28], strap: [0, -826, 70, 700],
    logo: [-100, -390, 420, 50], eyebrow: [0, -322, 640, 30], headline: [0, -110, 640, 360], rule: [-320, 320, 104],
    support: [0, 190, 640, 110], location: [0, 300, 640, 32], cta: [-130, 410, 380, 76],
  },
  story: {
    cx: 540, cy: 1000, deg: -6,
    card: [0, 0, 820, 1240], slot: [0, -580, 170, 30], strap: [0, -946, 74, 700],
    logo: [-110, -480, 440, 56], eyebrow: [0, -400, 700, 34], headline: [0, -160, 700, 430], rule: [-350, 350, 92],
    support: [0, 200, 700, 150], location: [0, 330, 700, 36], cta: [-140, 470, 420, 88],
  },
};

type Key = 'card' | 'slot' | 'strap' | 'logo' | 'eyebrow' | 'headline' | 'support' | 'location' | 'cta';

/** The canvas box of a local element (centre offset from the card centre, tilted with the card) plus its rotation. */
function put(c: CanvasHelper, s: BadgeSpec, [lx, ly, w, h]: Item) {
  const a = (s.deg * Math.PI) / 180;
  const x = s.cx + lx * Math.cos(a) - ly * Math.sin(a);
  const y = s.cy + lx * Math.sin(a) + ly * Math.cos(a);
  return { box: c.box(x - w / 2, y - h / 2, w, h), rotate: s.deg };
}
const ends = (c: CanvasHelper, s: BadgeSpec) => {
  const [x0, x1, y] = s.rule;
  const a = (s.deg * Math.PI) / 180;
  const p = (lx: number, ly: number) => c.pt(s.cx + lx * Math.cos(a) - ly * Math.sin(a), s.cy + lx * Math.sin(a) + ly * Math.cos(a));
  return { from: p(x0, y), to: p(x1, y) };
};
const base = (key: Key) => put(C.square, SPECS.square, SPECS.square[key]);
const geo = (key: Key) => ({ portrait: put(C.portrait, SPECS.portrait, SPECS.portrait[key]), story: put(C.story, SPECS.story, SPECS.story[key]) });
/** class patch for a text/button: geometry from the badge plus the size written in pixels of that class */
const geoSize = (key: Key, portrait: [number, number], story: [number, number]) => {
  const g = geo(key);
  const sz = (c: CanvasHelper, [max, min]: [number, number]) => ({ max: Number((max / c.unit).toFixed(5)), min: Number((min / c.unit).toFixed(5)) });
  return { portrait: { ...g.portrait, size: sz(C.portrait, portrait) }, story: { ...g.story, size: sz(C.story, story) } };
};

/**
 * services_recruitment: an ID BADGE on a lanyard. A brand-colored canvas with a faint dot grid; a big paper badge card hangs from an accent
 * strap, tilted a few degrees, with a punched slot at the top. On the badge: the brand name, the label, a big headline, a hairline, the
 * explanation, the location and a button, all tilted with the card. No picture needed.
 */
const servicesRecruitment = defineTemplate({
  id: 'services_recruitment',
  name: 'Recruitment badge (ID card)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A "we are hiring" post: a tilted ID badge hanging from an accent lanyard on the brand color, carrying the role message, location and a button.',
  styles: ['bold_startup', 'dynamic_events', 'contemporary_geometric', 'modern_corporate'],
  industries: ['recruitment', 'hiring', 'hr', 'consulting', 'agency', 'startup', 'b2b', 'staffing', 'finance'],
  channels: ['linkedin', 'instagram', 'facebook', 'organic_content'],
  classes: ['square', 'portrait', 'story'],
  requires: [],
  density: 'balanced',
  family: 'inset-card',
  composition: 'Brand canvas with a faint dot grid; a big tilted paper badge hangs from an accent strap and holds the logo, label, headline, details and button.',
  sample: {
    headline: 'Join our growing team',
    support: 'Open roles in consulting, finance and operations. Apply in two minutes.',
    cta: 'See open roles',
    eyebrow: 'We are hiring',
    location: 'Belgrade · Hybrid',
    brand: 'Northwind Partners',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    pattern('dots', C.square.box(0, 0, 1080, 1080), 'dots', 'onPrimary', 0.045, { opacity: 0.12 }),
    rect('strap', base('strap').box, { fill: 'accent', rotate: SPECS.square.deg, at: geo('strap') }),
    rect('badge', base('card').box, { fill: 'paper', radius: 0.05, shadow: true, rotate: SPECS.square.deg, at: geo('card') }),
    rect('slot', base('slot').box, { fill: 'ink', opacity: 0.85, radius: 0.5, rotate: SPECS.square.deg, at: geo('slot') }),
    logo('logo', base('logo').box, {
      nameColor: 'ink',
      nameWeight: 700,
      tracking: -0.01,
      rotate: SPECS.square.deg,
      at: geo('logo'),
    }),
    text('eyebrow', 'eyebrow', base('eyebrow').box, {
      size: C.square.size(24),
      upper: true,
      tracking: 0.18,
      weight: 800,
      color: 'muted',
      lines: 1,
      valign: 'middle',
      rotate: SPECS.square.deg,
      at: geoSize('eyebrow', [24, 24], [30, 30]),
    }),
    text('headline', 'headline', base('headline').box, {
      size: C.square.size(104, 50),
      family: 'display',
      weight: 800,
      lh: 1.0,
      tracking: -0.03,
      color: 'ink',
      lines: 4,
      rotate: SPECS.square.deg,
      at: geoSize('headline', [112, 54], [124, 60]),
    }),
    line('rule', ends(C.square, SPECS.square).from, ends(C.square, SPECS.square).to, { color: 'ink', width: 0.0014 }, {
      opacity: 0.3,
      at: { portrait: ends(C.portrait, SPECS.portrait), story: ends(C.story, SPECS.story) },
    }),
    text('support', 'support', base('support').box, {
      size: C.square.size(26, 20),
      weight: 400,
      lh: 1.32,
      color: 'ink',
      opacity: 0.85,
      lines: 3,
      rotate: SPECS.square.deg,
      at: geoSize('support', [28, 20], [36, 26]),
    }),
    text('location', 'location', base('location').box, {
      size: C.square.size(22),
      family: 'mono',
      upper: true,
      tracking: 0.08,
      weight: 700,
      color: 'muted',
      lines: 1,
      valign: 'middle',
      rotate: SPECS.square.deg,
      at: geoSize('location', [24, 24], [28, 28]),
    }),
    button('cta', base('cta').box, {
      fill: 'primary',
      color: 'onPrimary',
      arrow: true,
      size: C.square.size(28, 20),
      rotate: SPECS.square.deg,
      at: geoSize('cta', [30, 22], [34, 24]),
    }),
  ],
});

/**
 * services_case_study: a STAT-FOCUS layout on ink. One huge accent number is the hero of the post; its label, a short accent bar and a
 * hairline lead down to the headline (the story of the result), the explanation and the button. A tonal brand disc sits behind the number.
 * Square / portrait / story stack the blocks; landscape puts the number on the left and the story on the right across a vertical hairline.
 */
const servicesCaseStudy = defineTemplate({
  id: 'services_case_study',
  name: 'Case study (big number)',
  version: 1,
  status: 'active',
  category: 'professional_services',
  description: 'A result-first case study: one giant accent number with its label on a dark canvas, then the story headline, a short explanation and a button.',
  styles: ['modern_corporate', 'bold_startup', 'premium_editorial'],
  industries: ['consulting', 'finance', 'accounting', 'legal', 'b2b', 'saas', 'agency', 'marketing', 'logistics'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['stat'],
  density: 'balanced',
  family: 'stat-focus',
  composition: 'Ink canvas, a giant accent stat with its label and a bar, hairline, then headline, support and button; number left and story right in landscape.',
  sample: {
    headline: 'How one finance team closed its books faster',
    support: 'A new reporting routine cut the monthly close and gave managers numbers they trust.',
    cta: 'Read the story',
    eyebrow: 'Case study',
    stat: '98%',
    statLabel: 'of reports delivered on time',
    brand: 'Northwind Partners',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    circle('deco', C.square.box(560, -60, 700, 700), {
      fill: 'primary',
      opacity: 0.3,
      at: {
        portrait: patch(C.portrait, { box: [540, -40, 760, 760] }),
        story: patch(C.story, { box: [400, 330, 720, 720] }),
        landscape: patch(C.landscape, { box: [56, 36, 524, 524] }),
      },
    }),
    logo('logo', C.square.box(694, 84, 300, 46), {
      align: 'right',
      nameColor: 'onInk',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [694, 100, 300, 46] }),
        story: patch(C.story, { box: [594, 282, 400, 56] }),
        landscape: patch(C.landscape, { box: [828, 62, 300, 38] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 92, 560, 30), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.18,
      weight: 700,
      color: 'onInk',
      opacity: 0.75,
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 108, 560, 30], size: 22 }),
        story: patch(C.story, { box: [86, 294, 480, 34], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 68, 400, 26], size: 15 }),
      },
    }),
    text('stat', 'stat', C.square.box(86, 170, 908, 360), {
      size: C.square.size(320, 110),
      family: 'display',
      weight: 800,
      lh: 0.9,
      tracking: -0.04,
      color: 'accent',
      valign: 'bottom',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 210, 908, 450], size: [324, 130] }),
        story: patch(C.story, { box: [86, 440, 908, 460], size: [324, 140] }),
        landscape: patch(C.landscape, { box: [72, 120, 540, 236], size: [188, 70] }),
      },
    }),
    rect('bar', C.square.box(86, 552, 120, 10), {
      fill: 'accent',
      radius: 0.5,
      at: {
        portrait: patch(C.portrait, { box: [86, 688, 120, 10] }),
        story: patch(C.story, { box: [86, 930, 140, 12] }),
        landscape: patch(C.landscape, { box: [72, 372, 90, 8] }),
      },
    }),
    text('stat-label', 'statLabel', C.square.box(86, 584, 908, 80), {
      size: C.square.size(44, 26),
      weight: 600,
      lh: 1.12,
      tracking: -0.01,
      color: 'onInk',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [86, 724, 908, 110], size: [52, 28] }),
        story: patch(C.story, { box: [86, 964, 908, 130], size: [60, 30] }),
        landscape: patch(C.landscape, { box: [72, 394, 540, 96], size: [32, 18], maxLines: 3 }),
      },
    }),
    line('rule', C.square.pt(86, 692), C.square.pt(994, 692), { color: 'onInk', width: 0.0014 }, {
      opacity: 0.25,
      at: {
        portrait: { from: C.portrait.pt(86, 874), to: C.portrait.pt(994, 874) },
        story: { from: C.story.pt(86, 1130), to: C.story.pt(994, 1130) },
        landscape: { from: C.landscape.pt(636, 104), to: C.landscape.pt(636, 524) },
      },
    }),
    text('headline', 'headline', C.square.box(86, 718, 908, 190), {
      size: C.square.size(58, 34),
      weight: 700,
      lh: 1.06,
      tracking: -0.015,
      color: 'onInk',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 912, 908, 230], size: [68, 38] }),
        story: patch(C.story, { box: [86, 1166, 908, 250], size: [76, 42] }),
        landscape: patch(C.landscape, { box: [676, 112, 452, 250], size: [44, 26], maxLines: 5 }),
      },
    }),
    text('support', 'support', C.square.box(86, 922, 580, 70), {
      size: C.square.size(24, 19),
      weight: 400,
      lh: 1.32,
      color: 'onInk',
      opacity: 0.8,
      lines: 2,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 1160, 580, 80], size: [26, 19] }),
        story: patch(C.story, { box: [86, 1426, 908, 100], size: [32, 24], valign: 'top' }),
        landscape: patch(C.landscape, { box: [676, 372, 452, 70], size: [20, 15], maxLines: 3, valign: 'top' }),
      },
    }),
    button('cta', C.square.box(664, 922, 330, 70), {
      arrow: true,
      size: C.square.size(26, 19),
      at: {
        portrait: patch(C.portrait, { box: [664, 1166, 330, 72], size: [26, 19] }),
        story: patch(C.story, { box: [86, 1560, 480, 88], size: [32, 24] }),
        landscape: patch(C.landscape, { box: [676, 470, 330, 56], size: [20, 15] }),
      },
    }),
  ],
});

export const PROFESSIONAL_SERVICES: TemplateDef[] = [servicesCorporateAnnouncement, servicesTrust, servicesExplainer, servicesRecruitment, servicesCaseStudy];
