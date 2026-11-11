import { CANVAS as C, button, circle, defineTemplate, fill, grad, img, logo, patch, pattern, poly, rect, text } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * ecommerce_product_spotlight: a NOTCH PANEL. A big product photo fills the top right of the canvas and a paper-colored text panel with a
 * rounded corner is cut into its lower-left, flowing into the paper below so the picture reads as one stepped shape with a notch. A
 * brand-colored block peeks out behind the panel like a stacked card, the brand name sits on the paper at the top left and the button
 * anchors the lower-right corner (inside the panel in landscape and story).
 */
const ecommerceProductSpotlight = defineTemplate({
  id: 'ecommerce_product_spotlight',
  name: 'Product spotlight (notch panel)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'A large product photo at the top right with a paper text panel notched into its lower-left over an offset brand-colored block: clean headline, support line and a button.',
  styles: ['clean_ecommerce', 'minimalist_tech', 'modern_corporate'],
  industries: ['e-commerce', 'retail', 'shop', 'fashion', 'cosmetics', 'accessories', 'home', 'lifestyle', 'electronics'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'panel',
  composition: 'Large product photo at the top right with a rounded paper text panel notched into its lower-left over an offset brand-colored block; brand name on paper top left.',
  sample: {
    headline: 'Meet the everyday tote',
    support: 'Handmade from recycled canvas and built to carry your whole day.',
    cta: 'Shop now',
    eyebrow: 'New arrival',
    brand: 'Linen & Co',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    img('photo', 'hero', C.square.box(360, 0, 720, 800), {
      focus: [0.5, 0.45],
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [360, 0, 720, 960] }),
        story: patch(C.story, { box: [380, 0, 700, 1260] }),
        landscape: patch(C.landscape, { box: [440, 0, 760, 628] }),
      },
    }),
    rect('offset', C.square.box(-58, 478, 720, 640), {
      fill: 'primary',
      radius: 0.09,
      at: {
        portrait: patch(C.portrait, { box: [-58, 588, 760, 780] }),
        story: patch(C.story, { box: [-58, 878, 900, 1200] }),
        landscape: patch(C.landscape, { box: [-58, 134, 700, 620], radius: 0.07 }),
      },
    }),
    rect('panel', C.square.box(-80, 500, 720, 640), {
      fill: 'paper',
      radius: 0.09,
      at: {
        portrait: patch(C.portrait, { box: [-80, 610, 760, 780] }),
        story: patch(C.story, { box: [-80, 900, 900, 1200] }),
        landscape: patch(C.landscape, { box: [-80, 156, 700, 620], radius: 0.07 }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameFamily: 'sans',
      nameWeight: 800,
      nameColor: 'ink',
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 260, 46] }),
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [72, 70, 260, 36] }),
      },
    }),
    rect('accent-bar', C.square.box(86, 566, 64, 7), {
      fill: 'accent',
      radius: 0.5,
      at: {
        portrait: patch(C.portrait, { box: [86, 690, 64, 7] }),
        story: patch(C.story, { box: [86, 978, 72, 8] }),
        landscape: patch(C.landscape, { box: [72, 192, 56, 6] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 590, 520, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'muted',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 714, 600, 30], size: 22 }),
        story: patch(C.story, { box: [86, 1002, 700, 36], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 212, 460, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 624, 520, 212), {
      size: C.square.size(66, 40),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'ink',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 750, 600, 260], size: [80, 46] }),
        story: patch(C.story, { box: [86, 1044, 720, 330], size: [96, 54] }),
        landscape: patch(C.landscape, { box: [72, 242, 470, 170], size: [50, 28], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 846, 540, 72), {
      size: C.square.size(25, 20),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.8,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [86, 1024, 600, 90], size: [27, 21], maxLines: 3 }),
        story: patch(C.story, { box: [86, 1388, 720, 120], size: [32, 25], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 418, 470, 56], size: [18, 14] }),
      },
    }),
    button('cta', C.square.box(694, 920, 300, 70), {
      fill: 'ink',
      color: 'onInk',
      arrow: true,
      size: C.square.size(26, 19),
      at: {
        portrait: patch(C.portrait, { box: [694, 1138, 300, 72], size: [26, 19] }),
        story: patch(C.story, { box: [86, 1546, 360, 80], size: [30, 22] }),
        landscape: patch(C.landscape, { box: [72, 494, 230, 54], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * ecommerce_seasonal_promo: a TILTED RIBBON. A veiled full-bleed photo is crossed by a brand-colored ribbon, turned a few degrees, that
 * carries the headline in bold capitals (the text is tilted with it), with a thin accent stripe running along its lower edge. Below,
 * a support line and a footer row: button on the left, the offer (when the user gave one) in big capitals on the right.
 */
const ecommerceSeasonalPromo = defineTemplate({
  id: 'ecommerce_seasonal_promo',
  name: 'Seasonal promo (tilted ribbon)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'A full-bleed photo crossed by a tilted brand-colored ribbon with a bold capitals headline and an accent stripe; button and optional offer in a footer row.',
  styles: ['dynamic_events', 'bold_startup', 'contemporary_geometric'],
  industries: ['e-commerce', 'retail', 'shop', 'fashion', 'gifts', 'home', 'seasonal', 'cosmetics', 'toys', 'food'],
  channels: [],
  classes: ['square', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'diagonal',
  composition: 'Veiled full-bleed photo; one tilted ribbon with a tilted capitals headline and an accent stripe; footer row with button left and offer right.',
  sample: {
    headline: 'Autumn collection is here',
    support: 'Warm layers and cosy basics for the cooler days ahead.',
    cta: 'Shop the edit',
    eyebrow: 'Seasonal edit',
    brand: 'Maple Row',
    offer: 'Up to 30% off',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { focus: [0.5, 0.4], fallback: 'brandPattern' }),
    rect('veil', [0, 0, 1, 1], {
      fill: grad(90, [0, 'ink', 0.62], [0.3, 'ink', 0.5], [0.5, 'ink', 0.15], [1, 'ink', 0.9]),
      at: { story: { fill: grad(90, [0, 'ink', 0.62], [0.36, 'ink', 0.55], [0.5, 'ink', 0.2], [1, 'ink', 0.9]) } },
    }),
    rect('ribbon', C.square.box(-130, 320, 1340, 300), {
      fill: 'primary',
      rotate: -7,
      shadow: true,
      at: {
        story: patch(C.story, { box: [-130, 770, 1340, 340] }),
        landscape: patch(C.landscape, { box: [-100, 190, 1400, 190] }),
      },
    }),
    rect('stripe', C.square.box(-108, 633, 1340, 26), {
      fill: 'accent',
      rotate: -7,
      at: {
        story: patch(C.story, { box: [-106, 1124, 1340, 28] }),
        landscape: patch(C.landscape, { box: [-92, 390, 1400, 14], rotate: -4 }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameColor: 'onInk',
      nameWeight: 800,
      tracking: -0.01,
      at: {
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [72, 66, 260, 36] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 262, 700, 32), {
      size: C.square.size(24),
      upper: true,
      tracking: 0.2,
      weight: 700,
      color: 'onInk',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 640, 800, 40], size: 28 }),
        landscape: patch(C.landscape, { box: [72, 112, 600, 26], size: 16 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 360, 908, 220), {
      size: C.square.size(84, 50),
      family: 'display',
      weight: 800,
      upper: true,
      lh: 0.98,
      tracking: -0.01,
      color: 'onPrimary',
      valign: 'middle',
      lines: 3,
      rotate: -7,
      at: {
        story: patch(C.story, { box: [86, 800, 908, 280], size: [90, 52], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 195, 1056, 180], size: [78, 36], maxLines: 2, rotate: -4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 752, 700, 100), {
      size: C.square.size(28, 22),
      weight: 400,
      lh: 1.35,
      color: 'onInk',
      lines: 3,
      at: {
        story: patch(C.story, { box: [86, 1236, 908, 140], size: [34, 26] }),
        landscape: patch(C.landscape, { box: [322, 456, 320, 88], size: [16, 13], maxLines: 4 }),
      },
    }),
    button('cta', C.square.box(86, 906, 300, 74), {
      size: C.square.size(27, 20),
      arrow: true,
      at: {
        story: patch(C.story, { box: [86, 1530, 380, 84], size: [30, 22] }),
        landscape: patch(C.landscape, { box: [72, 478, 230, 56], size: [19, 14] }),
      },
    }),
    text('offer', 'offer', C.square.box(440, 878, 554, 124), {
      size: C.square.size(66, 36),
      family: 'display',
      weight: 900,
      upper: true,
      lh: 1,
      tracking: -0.02,
      color: 'onInk',
      align: 'right',
      valign: 'middle',
      lines: 1,
      at: {
        story: patch(C.story, { box: [486, 1510, 508, 104], size: [70, 36] }),
        landscape: patch(C.landscape, { box: [660, 452, 468, 84], size: [50, 28] }),
      },
    }),
  ],
});

/**
 * ecommerce_discount: a STAT-FOCUS offer poster. The offer the user supplied ("-30%", "20% OFF", a price) is the hero: a giant display
 * figure on the brand color, with its detail line, the headline and a button stacked beneath. A round product picture sits in an
 * accent halo among faint concentric rings at the lower right (without a picture the halo stays as a plain disc). The banner turns
 * it into a typographic strip: figure on the left, message in the middle, button on the right.
 */
const ecommerceDiscount = defineTemplate({
  id: 'ecommerce_discount',
  name: 'Discount (giant offer figure)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'The offer itself is the hero: a giant display figure on the brand color with its detail, a short headline, a button and a round product picture in an accent halo.',
  styles: ['bold_startup', 'clean_ecommerce', 'dynamic_events', 'contemporary_geometric'],
  industries: ['e-commerce', 'retail', 'shop', 'fashion', 'electronics', 'cosmetics', 'furniture', 'sale', 'food', 'delivery'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: ['offer'],
  density: 'balanced',
  family: 'stat-focus',
  composition: 'Brand-colored canvas dominated by a giant offer figure; detail, headline and button beneath; round picture in an accent halo with faint rings at the lower right.',
  sample: {
    headline: 'Winter sale on every coat',
    support: 'Free returns on all orders until the end of the month.',
    cta: 'Shop the sale',
    eyebrow: 'Weekend only',
    brand: 'Fjord & Pine',
    offer: '-30%',
    offerDetail: 'On all outerwear',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    pattern('rings', C.square.box(410, 400, 800, 800), 'rings', 'onPrimary', 0.05, {
      opacity: 0.14,
      at: {
        story: patch(C.story, { box: [274, 750, 1000, 1000] }),
        landscape: patch(C.landscape, { box: [560, 90, 700, 700] }),
      },
      hide: ['banner'],
    }),
    circle('halo', C.square.box(586, 576, 448, 448), {
      fill: 'accent',
      at: {
        story: patch(C.story, { box: [520, 996, 508, 508] }),
        landscape: patch(C.landscape, { box: [736, 62, 448, 448] }),
      },
      hide: ['banner'],
    }),
    img('photo', 'hero', C.square.box(610, 600, 400, 400), {
      mask: 'circle',
      border: { color: 'onPrimary', width: 0.006 },
      fallback: 'none',
      at: {
        story: patch(C.story, { box: [544, 1020, 460, 460] }),
        landscape: patch(C.landscape, { box: [760, 86, 400, 400] }),
      },
      hide: ['banner'],
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameColor: 'onPrimary',
      nameWeight: 800,
      tracking: -0.01,
      at: {
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [72, 66, 260, 36] }),
        banner: patch(C.banner, { box: [940, 40, 212, 34], align: 'right' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 176, 700, 32), {
      size: C.square.size(24),
      upper: true,
      tracking: 0.22,
      weight: 700,
      color: 'onPrimary',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 388, 800, 40], size: 28 }),
        landscape: patch(C.landscape, { box: [72, 118, 640, 26], size: 16 }),
        banner: patch(C.banner, { box: [48, 38, 372, 24], size: 14 }),
      },
    }),
    text('offer', 'offer', C.square.box(86, 214, 908, 330), {
      size: C.square.size(320, 100),
      family: 'display',
      weight: 900,
      upper: true,
      lh: 0.9,
      tracking: -0.04,
      color: 'onPrimary',
      valign: 'middle',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 440, 908, 420], size: [320, 130] }),
        landscape: patch(C.landscape, { box: [72, 142, 640, 196], size: [188, 70] }),
        banner: patch(C.banner, { box: [48, 66, 372, 122], size: [90, 40] }),
      },
    }),
    text('offer-detail', 'offerDetail', C.square.box(86, 552, 700, 46), {
      size: C.square.size(32, 22),
      weight: 700,
      upper: true,
      tracking: 0.08,
      color: 'onPrimary',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 876, 908, 60], size: [44, 28] }),
        landscape: patch(C.landscape, { box: [72, 342, 640, 34], size: [22, 15] }),
        banner: patch(C.banner, { box: [48, 192, 372, 34], size: [20, 14] }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 628, 480, 220), {
      size: C.square.size(60, 36),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'onPrimary',
      lines: 4,
      at: {
        story: patch(C.story, { box: [86, 1000, 424, 330], size: [76, 36], maxLines: 8 }),
        landscape: patch(C.landscape, { box: [72, 384, 620, 96], size: [38, 24], maxLines: 2 }),
        banner: patch(C.banner, { box: [450, 62, 450, 150], size: [42, 20], maxLines: 3, valign: 'middle' }),
      },
    }),
    button('cta', C.square.box(86, 886, 320, 74), {
      fill: 'onPrimary',
      color: 'primary',
      arrow: true,
      size: C.square.size(27, 20),
      at: {
        story: patch(C.story, { box: [86, 1380, 380, 86], size: [31, 22] }),
        landscape: patch(C.landscape, { box: [72, 496, 240, 56], size: [19, 14] }),
        banner: patch(C.banner, { box: [940, 120, 212, 62], size: [18, 13] }),
      },
    }),
  ],
});

/**
 * ecommerce_new_collection: a BENTO COLLAGE. A tall hero picture, a second picture and one solid ink tile that holds all the words sit in
 * a gapped, rounded grid (hero left; second picture above the text tile on the right; stacked in story, three columns in landscape and
 * in the banner strip). With no second picture a brand-colored pattern tile takes its place, so the grid always looks complete.
 */
const ecommerceNewCollection = defineTemplate({
  id: 'ecommerce_new_collection',
  name: 'New collection (bento collage)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'A gapped grid of rounded tiles: tall hero picture, a second picture and a dark text tile with serif headline, support and button, like a lookbook page.',
  styles: ['premium_editorial', 'clean_ecommerce', 'soft_lifestyle'],
  industries: ['fashion', 'e-commerce', 'retail', 'shop', 'cosmetics', 'jewelry', 'home', 'furniture', 'lifestyle', 'accessories'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: ['image'],
  density: 'balanced',
  family: 'collage',
  composition: 'Rounded bento grid with 16px gaps: tall hero picture, second picture, and a solid ink tile holding eyebrow, serif headline, support and button.',
  sample: {
    headline: 'The new collection has landed',
    support: 'Soft textures and earthy tones, designed to be worn all year round.',
    cta: 'Explore the collection',
    eyebrow: 'Just in',
    brand: 'Oak & Thread',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    img('hero-photo', 'hero', C.square.box(86, 150, 440, 830), {
      mask: 'rounded',
      radius: 0.03,
      fallback: 'brandPattern',
      at: {
        story: patch(C.story, { box: [86, 360, 908, 560], radius: 0.025 }),
        landscape: patch(C.landscape, { box: [72, 63, 380, 502], radius: 0.03 }),
        banner: patch(C.banner, { box: [48, 36, 330, 228], radius: 0.05 }),
      },
    }),
    img('second-photo', 'secondary', C.square.box(542, 150, 452, 330), {
      mask: 'rounded',
      radius: 0.04,
      fallback: 'brandPattern',
      at: {
        story: patch(C.story, { box: [86, 936, 360, 715], radius: 0.04 }),
        landscape: patch(C.landscape, { box: [468, 63, 270, 502], radius: 0.04 }),
        banner: patch(C.banner, { box: [394, 36, 330, 228], radius: 0.05 }),
      },
    }),
    rect('text-tile', C.square.box(542, 496, 452, 484), {
      fill: 'ink',
      radius: 0.03,
      at: {
        story: patch(C.story, { box: [462, 936, 532, 715], radius: 0.03 }),
        landscape: patch(C.landscape, { box: [754, 63, 374, 502], radius: 0.03 }),
        banner: patch(C.banner, { box: [740, 36, 412, 228], radius: 0.06 }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameFamily: 'serif',
      nameWeight: 700,
      nameColor: 'ink',
      at: {
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [782, 88, 220, 34], nameColor: 'onInk' }),
        banner: patch(C.banner, { box: [990, 196, 134, 40], nameColor: 'onInk', align: 'right' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(570, 530, 396, 26), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.2,
      weight: 700,
      color: 'onInk',
      opacity: 0.75,
      lines: 1,
      at: {
        story: patch(C.story, { box: [490, 976, 476, 32], size: 22 }),
        landscape: patch(C.landscape, { box: [782, 138, 318, 22], size: 13 }),
        banner: patch(C.banner, { box: [768, 52, 356, 20], size: 13 }),
      },
    }),
    text('headline', 'headline', C.square.box(570, 568, 396, 236), {
      size: C.square.size(58, 32),
      family: 'serif',
      weight: 600,
      lh: 1.06,
      tracking: -0.01,
      color: 'onInk',
      lines: 5,
      at: {
        story: patch(C.story, { box: [490, 1020, 476, 330], size: [84, 44], maxLines: 5 }),
        landscape: patch(C.landscape, { box: [782, 168, 318, 196], size: [44, 26], maxLines: 5 }),
        banner: patch(C.banner, { box: [768, 76, 356, 106], size: [34, 20], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(570, 812, 396, 70), {
      size: C.square.size(22, 17),
      weight: 400,
      lh: 1.35,
      color: 'onInk',
      opacity: 0.8,
      lines: 3,
      at: {
        story: patch(C.story, { box: [490, 1366, 476, 130], size: [28, 21], maxLines: 4 }),
        landscape: patch(C.landscape, { box: [782, 372, 318, 64], size: [16, 12], maxLines: 4 }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(570, 896, 300, 62), {
      fill: 'onInk',
      color: 'ink',
      radius: 0.5,
      size: C.square.size(22, 16),
      at: {
        story: patch(C.story, { box: [490, 1530, 380, 76], size: [27, 20] }),
        landscape: patch(C.landscape, { box: [782, 484, 250, 54], size: [17, 13] }),
        banner: patch(C.banner, { box: [768, 196, 210, 48], size: [14, 11] }),
      },
    }),
  ],
});

/**
 * ecommerce_comparison: a SPLIT COMPARISON. Two pictures (the hero and the secondary one) meet on a centre seam, side by side in square
 * and landscape and stacked in story, with a round paper badge holding two outward chevrons on the seam. The words sit on paper
 * beneath (square, story) or in a column on the right (landscape). With only one picture the second half shows a brand-colored
 * pattern, so the layout never has a hole. No labels are invented: the headline carries the comparison.
 */
const ecommerceComparison = defineTemplate({
  id: 'ecommerce_comparison',
  name: 'Comparison (split pictures)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'Two pictures side by side (stacked in stories) joined by a round compare badge, with a clean headline, support line and button on paper: for before/after and this-or-that posts.',
  styles: ['clean_ecommerce', 'modern_corporate', 'minimalist_tech'],
  industries: ['e-commerce', 'retail', 'shop', 'cosmetics', 'skincare', 'fashion', 'electronics', 'furniture', 'home', 'fitness'],
  channels: [],
  classes: ['square', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'split',
  composition: 'Two pictures meeting at a centre seam with a round compare badge; text on paper below (right column in landscape); thin brand-colored footer rule.',
  sample: {
    headline: 'Two weeks, one clear difference',
    support: 'See what a simple daily routine can do for your skin.',
    cta: 'See the results',
    brand: 'Clearly',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    img('photo-a', 'hero', C.square.box(0, 0, 538, 740), {
      fallback: 'brandPattern',
      at: {
        story: patch(C.story, { box: [0, 0, 1080, 620] }),
        landscape: patch(C.landscape, { box: [0, 0, 390, 628] }),
      },
    }),
    img('photo-b', 'secondary', C.square.box(542, 0, 538, 740), {
      fallback: 'brandPattern',
      at: {
        story: patch(C.story, { box: [0, 632, 1080, 620] }),
        landscape: patch(C.landscape, { box: [394, 0, 390, 628] }),
      },
    }),
    rect('footer-bar', C.square.box(0, 1056, 1080, 24), {
      fill: 'primary',
      at: {
        story: patch(C.story, { box: [0, 1896, 1080, 24] }),
        landscape: patch(C.landscape, { box: [788, 0, 12, 628] }),
      },
    }),
    circle('badge', C.square.box(490, 320, 100, 100), {
      fill: 'paper',
      stroke: { color: 'ink', width: 0.0016 },
      at: {
        story: patch(C.story, { box: [490, 576, 100, 100] }),
        landscape: patch(C.landscape, { box: [348, 270, 88, 88] }),
      },
    }),
    poly('chevron-1', [C.square.pt(512, 370), C.square.pt(528, 355), C.square.pt(528, 385)], {
      fill: 'ink',
      at: {
        story: { points: [C.story.pt(540, 598), C.story.pt(525, 614), C.story.pt(555, 614)] },
        landscape: { points: [C.landscape.pt(370, 314), C.landscape.pt(383, 301), C.landscape.pt(383, 327)] },
      },
    }),
    poly('chevron-2', [C.square.pt(568, 370), C.square.pt(552, 355), C.square.pt(552, 385)], {
      fill: 'ink',
      at: {
        story: { points: [C.story.pt(540, 654), C.story.pt(525, 638), C.story.pt(555, 638)] },
        landscape: { points: [C.landscape.pt(414, 314), C.landscape.pt(401, 301), C.landscape.pt(401, 327)] },
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 66), {
      nameWeight: 800,
      nameColor: 'ink',
      plate: { fill: 'paper', padding: 0.012, radius: 0.5 },
      at: {
        story: patch(C.story, { box: [86, 285, 300, 72] }),
        landscape: patch(C.landscape, { box: [820, 76, 300, 36], plate: { fill: 'paper', padding: 0, radius: 0 } }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 786, 620, 140), {
      size: C.square.size(58, 34),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'ink',
      lines: 3,
      at: {
        story: patch(C.story, { box: [86, 1290, 908, 180], size: [76, 40], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [820, 150, 308, 196], size: [42, 24], maxLines: 7 }),
      },
    }),
    text('support', 'support', C.square.box(86, 936, 620, 66), {
      size: C.square.size(24, 18),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.8,
      lines: 2,
      at: {
        story: patch(C.story, { box: [86, 1480, 908, 70], size: [30, 22], maxLines: 2 }),
        landscape: patch(C.landscape, { box: [820, 352, 308, 70], size: [17, 13], maxLines: 4 }),
      },
    }),
    button('cta', C.square.box(724, 800, 270, 66), {
      fill: 'ink',
      color: 'onInk',
      arrow: true,
      size: C.square.size(24, 17),
      at: {
        story: patch(C.story, { box: [86, 1566, 360, 78], size: [29, 21] }),
        landscape: patch(C.landscape, { box: [820, 454, 250, 56], size: [18, 14] }),
      },
    }),
  ],
});

export const ECOMMERCE: TemplateDef[] = [ecommerceProductSpotlight, ecommerceSeasonalPromo, ecommerceDiscount, ecommerceNewCollection, ecommerceComparison];
