import { CANVAS as C, button, circle, defineTemplate, fill, img, line, logo, patch, pattern, poly, rect, text } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * editorial_minimal: a TYPOGRAPHIC POSTER, no picture. Paper background, a header row (serif brand name, small caps tag) over a hairline
 * rule, one huge serif headline, a single brand-colored disc bleeding off the bottom corner and a quiet support + outlined button below.
 * Banner turns it into two columns: headline on the left, a hairline, then brand / support / button on the right.
 */
const editorialMinimal = defineTemplate({
  id: 'editorial_minimal',
  name: 'Editorial minimal (typographic poster)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A typographic poster on paper: huge serif headline, hairline rules, one brand-colored disc off the corner and an outlined button. No picture needed.',
  styles: ['premium_editorial', 'modern_corporate'],
  industries: ['*'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'airy',
  family: 'poster-type',
  composition: 'Paper background, header row over a hairline, oversized serif headline, one brand disc off the corner, outlined button.',
  sample: {
    headline: 'The quiet power of good design',
    support: 'Notes on craft, typography and building brands that last.',
    cta: 'Read the story',
    tag: 'Issue 12 · Spring',
    brand: 'Atelier North',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    rect('rule-top', C.square.box(86, 152, 908, 2), {
      fill: 'ink',
      at: { portrait: patch(C.portrait, { box: [86, 172, 908, 2] }), story: patch(C.story, { box: [86, 356, 908, 2] }) },
      hide: ['banner'],
    }),
    logo('logo', C.square.box(86, 84, 420, 52), {
      nameFamily: 'serif',
      nameWeight: 700,
      nameItalic: true,
      nameColor: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 420, 52] }),
        story: patch(C.story, { box: [86, 280, 420, 60] }),
        banner: patch(C.banner, { box: [790, 40, 362, 36] }),
      },
    }),
    text('tag', 'tag', C.square.box(560, 84, 434, 52), {
      size: C.square.size(21),
      upper: true,
      tracking: 0.14,
      weight: 600,
      color: 'muted',
      align: 'right',
      valign: 'middle',
      lines: 1,
      at: { portrait: patch(C.portrait, { box: [560, 100, 434, 52] }), story: patch(C.story, { box: [560, 280, 434, 60], size: 23 }) },
      hide: ['banner'],
    }),
    rect('accent-bar', C.square.box(86, 226, 110, 12), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [86, 250, 110, 12] }),
        story: patch(C.story, { box: [86, 470, 130, 14] }),
        banner: patch(C.banner, { box: [48, 40, 8, 220] }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 262, 908, 470), {
      size: C.square.size(138, 70),
      family: 'serif',
      weight: 800,
      lh: 0.98,
      tracking: -0.02,
      color: 'ink',
      lines: 5,
      at: {
        portrait: patch(C.portrait, { box: [86, 290, 908, 640], size: [148, 76] }),
        story: patch(C.story, { box: [86, 516, 908, 780], size: [156, 80], maxLines: 6 }),
        banner: patch(C.banner, { box: [76, 36, 650, 228], size: [70, 38], valign: 'middle', maxLines: 4 }),
      },
    }),
    circle('disc', C.square.box(720, 760, 400, 400), {
      fill: 'primary',
      at: { portrait: patch(C.portrait, { box: [700, 960, 440, 440] }), story: patch(C.story, { box: [700, 1380, 480, 480] }) },
      hide: ['banner'],
    }),
    rect('rule-mid', C.square.box(86, 770, 560, 2), {
      fill: 'ink',
      at: { portrait: patch(C.portrait, { box: [86, 968, 560, 2] }), story: patch(C.story, { box: [86, 1340, 540, 2] }), banner: patch(C.banner, { box: [756, 48, 2, 204] }) },
    }),
    text('support', 'support', C.square.box(86, 794, 560, 130), {
      size: C.square.size(29, 22),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.88,
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 992, 560, 140], size: [29, 22] }),
        story: patch(C.story, { box: [86, 1366, 540, 190], size: [33, 26], maxLines: 5 }),
        banner: patch(C.banner, { box: [790, 92, 362, 104], size: [21, 17], maxLines: 4 }),
      },
    }),
    button('cta', C.square.box(86, 934, 300, 64), {
      fill: 'paper',
      stroke: { color: 'ink', width: 0.002 },
      radius: 0,
      color: 'ink',
      upper: true,
      tracking: 0.1,
      arrow: true,
      size: C.square.size(21, 16),
      at: {
        portrait: patch(C.portrait, { box: [86, 1156, 300, 64], size: [21, 16] }),
        story: patch(C.story, { box: [86, 1572, 320, 70], size: [23, 17] }),
        banner: patch(C.banner, { box: [790, 208, 250, 48], size: [16, 13] }),
      },
    }),
  ],
});

/**
 * editorial_bold_typography: TYPE AS THE PICTURE. A solid brand-colored field filled edge to edge by a huge condensed, upper-case,
 * tightly-leaded headline, closed by an ink band at the bottom that carries the support line and the button. No picture needed.
 * Banner turns it into one big headline on the brand color with an ink end-block (logo + button) on the right.
 */
const editorialBoldTypography = defineTemplate({
  id: 'editorial_bold_typography',
  name: 'Bold typography (type as the picture)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A solid brand-color field filled by a huge condensed upper-case headline, with an ink band below for the support line and a button. No picture needed.',
  styles: ['bold_startup', 'contemporary_geometric', 'premium_editorial'],
  industries: ['*'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'poster-type',
  composition: 'Brand-color field filled by an edge-to-edge condensed upper-case headline, a thin accent stripe on top and an ink band at the bottom.',
  sample: {
    headline: 'Make some noise with great design',
    support: 'Bold ideas deserve bold type. See what we are building next.',
    cta: 'See the work',
    eyebrow: 'Vol. 08',
    brand: 'Studio Nord',
  },
  tone: 'brand',
  layers: [
    fill('field', 'primary'),
    rect('stripe', C.square.box(0, 0, 1080, 18), {
      fill: 'accent',
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 18] }), story: patch(C.story, { box: [0, 0, 1080, 22] }), banner: patch(C.banner, { box: [0, 0, 1200, 10] }) },
    }),
    rect('band', C.square.box(0, 888, 1080, 192), {
      fill: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [0, 1128, 1080, 222] }),
        story: patch(C.story, { box: [0, 1478, 1080, 442] }),
        banner: patch(C.banner, { box: [846, 0, 354, 300] }),
      },
    }),
    rect('band-mark', C.square.box(86, 888, 110, 9), {
      fill: 'accent',
      at: { portrait: patch(C.portrait, { box: [86, 1128, 110, 9] }), story: patch(C.story, { box: [86, 1478, 130, 10] }) },
      hide: ['banner'],
    }),
    logo('logo', C.square.box(86, 80, 380, 44), {
      nameWeight: 800,
      nameColor: 'onPrimary',
      upper: true,
      tracking: 0.12,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 380, 44] }),
        story: patch(C.story, { box: [86, 290, 380, 48] }),
        banner: patch(C.banner, { box: [878, 42, 274, 34], nameColor: 'onInk' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(540, 80, 454, 44), {
      size: C.square.size(21),
      upper: true,
      tracking: 0.1,
      weight: 600,
      color: 'onPrimary',
      align: 'right',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [540, 100, 454, 44] }),
        story: patch(C.story, { box: [540, 290, 454, 48], size: 24 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(86, 156, 908, 704), {
      size: C.square.size(168, 64),
      family: 'condensed',
      weight: 900,
      upper: true,
      lh: 0.9,
      tracking: -0.005,
      color: 'onPrimary',
      valign: 'middle',
      lines: 6,
      at: {
        portrait: patch(C.portrait, { box: [86, 176, 908, 920], size: [180, 64], valign: 'bottom', maxLines: 6 }),
        story: patch(C.story, { box: [86, 366, 908, 1070], size: [190, 64], valign: 'bottom', maxLines: 6 }),
        banner: patch(C.banner, { box: [48, 40, 760, 220], size: [86, 34], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(86, 912, 560, 92), {
      size: C.square.size(26, 20),
      weight: 400,
      lh: 1.3,
      color: 'onInk',
      valign: 'middle',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 1152, 560, 80], size: [27, 21] }),
        story: patch(C.story, { box: [86, 1508, 540, 130], size: [31, 24], maxLines: 4 }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(674, 920, 320, 76), {
      fill: 'onInk',
      color: 'ink',
      upper: true,
      tracking: 0.08,
      arrow: true,
      size: C.square.size(23, 16),
      at: {
        portrait: patch(C.portrait, { box: [674, 1150, 320, 76], size: [23, 16] }),
        story: patch(C.story, { box: [664, 1534, 330, 84], size: [26, 18] }),
        banner: patch(C.banner, { box: [878, 190, 274, 56], size: [20, 14] }),
      },
    }),
  ],
});

/**
 * editorial_premium_luxury: a FRAMED, CENTERED invitation on ink. A hairline accent frame, a tracked serif brand name, a photo window with
 * an offset hairline outline, an italic serif headline, a short accent rule and an outlined button. Landscape moves the photo to the left.
 */
const editorialPremiumLuxury = defineTemplate({
  id: 'editorial_premium_luxury',
  name: 'Premium luxury (framed invitation)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A dark, framed invitation: tracked serif brand name, a photo window with an offset hairline outline, a calm italic serif headline and an outlined button.',
  styles: ['luxury_hospitality', 'premium_editorial'],
  industries: ['luxury', 'fashion', 'jewelry', 'beauty', 'perfume', 'hotel', 'interior', 'design', 'art', 'wine'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'airy',
  family: 'frame',
  composition: 'Ink canvas inside a hairline frame; centered stack of brand name, offset-outlined photo window, italic serif headline, accent rule and outlined button.',
  sample: {
    headline: 'Crafted for those who notice',
    support: 'A small collection of timeless pieces, made slowly and made to last.',
    cta: 'Discover more',
    eyebrow: 'The new collection',
    brand: 'Maison Alder',
  },
  tone: 'dark',
  layers: [
    fill('ink', 'ink'),
    rect('frame', C.square.box(44, 44, 992, 992), {
      stroke: { color: 'onInk', width: 0.0016 },
      opacity: 0.5,
      at: { portrait: patch(C.portrait, { box: [44, 44, 992, 1262] }), story: patch(C.story, { box: [44, 44, 992, 1832] }), landscape: patch(C.landscape, { box: [28, 28, 1144, 572] }) },
    }),
    rect('outline', C.square.box(258, 168, 600, 400), {
      stroke: { color: 'onInk', width: 0.0016 },
      opacity: 0.5,
      at: {
        portrait: patch(C.portrait, { box: [228, 198, 660, 560] }),
        story: patch(C.story, { box: [190, 410, 740, 700] }),
        landscape: patch(C.landscape, { box: [100, 100, 400, 460] }),
      },
    }),
    img('photo', 'hero', C.square.box(240, 150, 600, 400), {
      fallback: 'gradient',
      at: {
        portrait: patch(C.portrait, { box: [210, 180, 660, 560] }),
        story: patch(C.story, { box: [170, 390, 740, 700] }),
        landscape: patch(C.landscape, { box: [84, 84, 400, 460] }),
      },
    }),
    logo('logo', C.square.box(290, 84, 500, 40), {
      align: 'center',
      nameFamily: 'serif',
      nameWeight: 600,
      nameColor: 'onInk',
      upper: true,
      tracking: 0.3,
      at: {
        portrait: patch(C.portrait, { box: [290, 104, 500, 40] }),
        story: patch(C.story, { box: [290, 290, 500, 44] }),
        landscape: patch(C.landscape, { box: [560, 84, 540, 34], align: 'left' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(190, 600, 700, 28), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.3,
      weight: 500,
      color: 'onInk',
      opacity: 0.75,
      align: 'center',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [190, 790, 700, 30], size: 20 }),
        story: patch(C.story, { box: [190, 1160, 700, 32], size: 22 }),
        landscape: patch(C.landscape, { box: [560, 156, 540, 24], size: 14, align: 'left' }),
      },
    }),
    text('headline', 'headline', C.square.box(140, 636, 800, 180), {
      size: C.square.size(66, 40),
      family: 'serif',
      weight: 500,
      italic: true,
      lh: 1.08,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [120, 830, 840, 210], size: [78, 44] }),
        story: patch(C.story, { box: [110, 1206, 860, 220], size: [92, 48] }),
        landscape: patch(C.landscape, { box: [560, 190, 540, 176], size: [62, 30], align: 'left', valign: 'top' }),
      },
    }),
    line('rule', C.square.pt(500, 836), C.square.pt(580, 836), { color: 'accent', width: 0.002 }, {
      at: {
        portrait: { from: C.portrait.pt(500, 1058), to: C.portrait.pt(580, 1058) },
        story: { from: C.story.pt(500, 1452), to: C.story.pt(580, 1452) },
        landscape: { from: C.landscape.pt(560, 136), to: C.landscape.pt(620, 136) },
      },
    }),
    text('support', 'support', C.square.box(190, 856, 700, 66), {
      size: C.square.size(23, 18),
      weight: 400,
      lh: 1.4,
      color: 'onInk',
      opacity: 0.8,
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [190, 1078, 700, 68], size: [24, 19] }),
        story: patch(C.story, { box: [170, 1476, 740, 80], size: [28, 22], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [560, 384, 540, 60], size: [18, 15], align: 'left' }),
      },
    }),
    button('cta', C.square.box(390, 938, 300, 58), {
      fill: 'ink',
      stroke: { color: 'onInk', width: 0.0022 },
      color: 'onInk',
      radius: 0,
      upper: true,
      tracking: 0.2,
      size: C.square.size(18, 14),
      at: {
        portrait: patch(C.portrait, { box: [390, 1162, 300, 58], size: [18, 14] }),
        story: patch(C.story, { box: [360, 1580, 360, 64], size: [21, 16] }),
        landscape: patch(C.landscape, { box: [560, 486, 270, 50], size: [14, 12] }),
      },
    }),
  ],
});

/**
 * editorial_lifestyle_story: PHOTO-LED STORYTELLING. The picture runs full-bleed and a paper CARD sits on it, anchored to the lower right:
 * brand name, a short accent bar, eyebrow, serif headline and support. The call to action is a pill on the photo next to the card (it
 * straddles the card's top edge in stories). Landscape turns the card into a tall column on the right.
 */
const editorialLifestyleStory = defineTemplate({
  id: 'editorial_lifestyle_story',
  name: 'Lifestyle story (photo with story card)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A full-bleed lifestyle photo with a paper story card in the lower right: brand name, eyebrow, serif headline and a short story, plus a pill button on the photo.',
  styles: ['lifestyle_photography', 'soft_lifestyle', 'premium_editorial'],
  industries: ['lifestyle', 'home', 'wellness', 'travel', 'food', 'fashion', 'magazine', 'blog', 'craft', 'brand'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'inset-card',
  composition: 'Full-bleed photo with a soft-shadowed paper card inset in the lower right and a pill button beside it.',
  sample: {
    headline: 'Where slow mornings begin',
    support: 'A small-batch ritual for the days you want to remember.',
    cta: 'Read the story',
    eyebrow: 'Chapter 04 · Spring',
    brand: 'Juniper Lane',
  },
  tone: 'light',
  layers: [
    img('photo', 'hero', [0, 0, 1, 1], { focus: [0.5, 0.45] }),
    rect('card', C.square.box(354, 548, 640, 456), {
      fill: 'paper',
      radius: 0.02,
      shadow: true,
      at: {
        portrait: patch(C.portrait, { box: [334, 760, 660, 482] }),
        story: patch(C.story, { box: [86, 1118, 908, 533] }),
        landscape: patch(C.landscape, { box: [628, 150, 500, 415] }),
      },
    }),
    logo('logo', C.square.box(394, 580, 340, 34), {
      nameWeight: 800,
      nameColor: 'ink',
      upper: true,
      tracking: 0.14,
      at: {
        portrait: patch(C.portrait, { box: [374, 794, 340, 34] }),
        story: patch(C.story, { box: [134, 1156, 400, 40] }),
        landscape: patch(C.landscape, { box: [664, 178, 300, 30] }),
      },
    }),
    rect('accent-bar', C.square.box(394, 640, 56, 5), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [374, 856, 56, 5] }),
        story: patch(C.story, { box: [134, 1226, 70, 6] }),
        landscape: patch(C.landscape, { box: [664, 232, 48, 5] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(394, 660, 560, 24), {
      size: C.square.size(18),
      upper: true,
      tracking: 0.16,
      weight: 600,
      color: 'muted',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [374, 876, 580, 24], size: 19 }),
        story: patch(C.story, { box: [134, 1250, 812, 30], size: 22 }),
        landscape: patch(C.landscape, { box: [664, 250, 428, 22], size: 14 }),
      },
    }),
    text('headline', 'headline', C.square.box(394, 694, 560, 152), {
      size: C.square.size(68, 36),
      family: 'serif',
      weight: 700,
      lh: 1.06,
      tracking: -0.01,
      color: 'ink',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [374, 910, 580, 170], size: [70, 38] }),
        story: patch(C.story, { box: [134, 1300, 812, 200], size: [90, 46] }),
        landscape: patch(C.landscape, { box: [664, 282, 428, 132], size: [50, 30], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(394, 858, 560, 108), {
      size: C.square.size(26, 19),
      weight: 400,
      lh: 1.38,
      color: 'ink',
      opacity: 0.82,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [374, 1092, 580, 120], size: [27, 20] }),
        story: patch(C.story, { box: [134, 1512, 812, 112], size: [32, 24] }),
        landscape: patch(C.landscape, { box: [664, 424, 428, 112], size: [18, 14], maxLines: 4 }),
      },
    }),
    button('cta', C.square.box(86, 940, 240, 64), {
      arrow: true,
      size: C.square.size(21, 16),
      at: {
        portrait: patch(C.portrait, { box: [86, 1178, 232, 64], size: [19, 15] }),
        story: patch(C.story, { box: [664, 1084, 330, 70], size: [26, 18] }),
        landscape: patch(C.landscape, { box: [72, 505, 248, 60], size: [19, 14] }),
      },
    }),
  ],
});

/**
 * editorial_modern_geometric: SHAPES AND COLOR BLOCKS. A flat grid of solid blocks: a tall primary block carries the logo and the headline,
 * a right-hand column stacks an accent block (with a cut corner), a circle photo on a secondary block and an ink block of concentric rings;
 * support and the button sit on paper below. Landscape makes it a 2 x 2 grid on the right of a primary text block.
 */
const editorialModernGeometric = defineTemplate({
  id: 'editorial_modern_geometric',
  name: 'Modern geometric (color blocks)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A bold grid of flat color blocks: a primary text block, an accent block with a cut corner, a circle photo and a ring-pattern block, with support and a button on paper.',
  styles: ['contemporary_geometric', 'bold_startup', 'modern_corporate'],
  industries: ['design', 'agency', 'architecture', 'creative', 'education', 'startup', 'technology', 'portfolio', 'magazine'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'collage',
  composition: 'Flat color-block grid: tall primary text block, right column of accent block, circle photo and ink ring block, paper strip with support and button.',
  sample: {
    headline: 'Shapes that make ideas stand out',
    support: 'We design clear, confident brands built from simple forms and honest color.',
    cta: 'View our work',
    eyebrow: 'Design studio',
    brand: 'Form & Field',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    rect('block-primary', C.square.box(0, 0, 640, 720), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [0, 0, 640, 900] }),
        story: patch(C.story, { box: [0, 0, 640, 1360] }),
        landscape: patch(C.landscape, { box: [0, 0, 640, 628] }),
      },
    }),
    rect('block-accent', C.square.box(640, 0, 440, 360), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [640, 0, 440, 450] }),
        story: patch(C.story, { box: [640, 0, 440, 450] }),
        landscape: patch(C.landscape, { box: [640, 0, 280, 314] }),
      },
    }),
    poly('cut-corner', [C.square.pt(1080, 0), C.square.pt(1080, 360), C.square.pt(720, 360)], {
      fill: 'paper',
      at: {
        portrait: { points: [C.portrait.pt(1080, 0), C.portrait.pt(1080, 450), C.portrait.pt(700, 450)] },
        story: { points: [C.story.pt(1080, 0), C.story.pt(1080, 450), C.story.pt(700, 450)] },
        landscape: { points: [C.landscape.pt(920, 0), C.landscape.pt(920, 314), C.landscape.pt(740, 314)] },
      },
    }),
    rect('block-photo', C.square.box(640, 360, 440, 360), {
      fill: 'secondary',
      at: {
        portrait: patch(C.portrait, { box: [640, 450, 440, 450] }),
        story: patch(C.story, { box: [640, 450, 440, 455] }),
        landscape: patch(C.landscape, { box: [920, 0, 280, 314] }),
      },
    }),
    img('photo', 'hero', C.square.box(670, 380, 380, 320), {
      mask: 'circle',
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [665, 475, 390, 400] }),
        story: patch(C.story, { box: [665, 478, 390, 400] }),
        landscape: patch(C.landscape, { box: [940, 20, 240, 274] }),
      },
    }),
    rect('block-ink', C.square.box(640, 720, 440, 360), {
      fill: 'ink',
      at: {
        portrait: patch(C.portrait, { box: [640, 900, 440, 450] }),
        story: patch(C.story, { box: [640, 905, 440, 455] }),
        landscape: patch(C.landscape, { box: [640, 314, 280, 314] }),
      },
    }),
    pattern('rings', C.square.box(640, 720, 440, 360), 'rings', 'onInk', 0.05, {
      opacity: 0.22,
      at: {
        portrait: patch(C.portrait, { box: [640, 900, 440, 450] }),
        story: patch(C.story, { box: [640, 905, 440, 455] }),
        landscape: { box: C.landscape.box(640, 314, 280, 314), size: 0.07 },
      },
    }),
    poly('corner', [C.landscape.pt(920, 628), C.landscape.pt(1200, 628), C.landscape.pt(1200, 380)], {
      fill: 'primary',
      hide: ['square', 'portrait', 'story'],
    }),
    logo('logo', C.square.box(86, 84, 320, 40), {
      nameWeight: 800,
      nameColor: 'onPrimary',
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [86, 104, 320, 40] }),
        story: patch(C.story, { box: [86, 290, 320, 44] }),
        landscape: patch(C.landscape, { box: [72, 84, 320, 34] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 138, 500, 26), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.16,
      weight: 600,
      color: 'onPrimary',
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 158, 500, 26], size: 19 }),
        story: patch(C.story, { box: [86, 348, 500, 30], size: 22 }),
        landscape: patch(C.landscape, { box: [72, 128, 500, 22], size: 14 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 214, 510, 476), {
      size: C.square.size(88, 44),
      family: 'display',
      weight: 800,
      lh: 1.02,
      tracking: -0.015,
      color: 'onPrimary',
      valign: 'bottom',
      lines: 6,
      at: {
        portrait: patch(C.portrait, { box: [86, 236, 510, 624], size: [96, 48], maxLines: 7 }),
        story: patch(C.story, { box: [86, 420, 510, 890], size: [104, 52], maxLines: 8 }),
        landscape: patch(C.landscape, { box: [72, 170, 540, 230], size: [64, 30], valign: 'top', maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 764, 520, 100), {
      size: C.square.size(26, 19),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 950, 520, 130], size: [27, 20] }),
        story: patch(C.story, { box: [86, 1424, 908, 126], size: [36, 26], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 410, 500, 70], size: [18, 14], color: 'onPrimary', maxLines: 3 }),
      },
    }),
    button('cta', C.square.box(86, 900, 300, 68), {
      arrow: true,
      size: C.square.size(23, 16),
      at: {
        portrait: patch(C.portrait, { box: [86, 1148, 300, 72], size: [23, 16] }),
        story: patch(C.story, { box: [86, 1566, 360, 80], size: [30, 20] }),
        landscape: patch(C.landscape, { box: [72, 494, 250, 56], size: [18, 14], fill: 'paper', color: 'ink', stroke: { color: 'onPrimary', width: 0.003 } }),
      },
    }),
  ],
});

export const EDITORIAL_BRAND: TemplateDef[] = [editorialMinimal, editorialBoldTypography, editorialPremiumLuxury, editorialLifestyleStory, editorialModernGeometric];
