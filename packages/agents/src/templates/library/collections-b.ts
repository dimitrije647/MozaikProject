import { CANVAS as C, type CanvasHelper, button, circle, defineTemplate, ellipse, fill, grad, img, line, logo, patch, poly, rect, text } from '../dsl';
import type { TemplateDef } from '../schema';

/** Templates authored for the template collections (see ../../collections). Luxury hospitality, lifestyle and clean e-commerce compositions. */

/**
 * lux_invitation: an INVITATION CARD. A deep ink canvas with a faint warm glow from the top, a double hairline border and everything
 * centred inside it on one axis: brand, a widely tracked eyebrow, a restrained serif headline, a small ornamental rule (two hairlines
 * around a diamond), one support line and a square-cornered gold button. No picture. The banner is the same card laid out as ONE ROW:
 * brand, a hairline divider with the diamond, eyebrow over headline, and the button.
 */
const luxInvitation = defineTemplate({
  id: 'lux_invitation',
  name: 'Invitation (double hairline card)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A dark invitation card: double hairline border, brand, tracked eyebrow, serif headline, an ornamental rule with a diamond, one support line and a square gold button. No picture needed.',
  styles: ['luxury_hospitality', 'premium_editorial'],
  industries: ['hotel', 'fine dining', 'restaurant', 'spa', 'resort', 'wine', 'wedding', 'event', 'hospitality'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'airy',
  family: 'centered',
  composition: 'Ink canvas with a double hairline border; brand, eyebrow, serif headline, diamond ornament, support and a square button centred on one axis (a single row in the banner).',
  sample: {
    headline: 'An evening of seasonal tasting',
    support: 'Seven courses by candlelight, paired with wines chosen by our sommelier.',
    cta: 'Reserve your seat',
    eyebrow: 'You are invited',
    brand: 'Maison Aurel',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    rect('glow', C.square.box(0, 0, 1080, 1080), {
      fill: grad(90, [0, 'accent', 0.16], [0.6, 'accent', 0]),
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 1350] }), story: patch(C.story, { box: [0, 0, 1080, 1920] }), banner: patch(C.banner, { box: [0, 0, 1200, 300], fill: grad(0, [0, 'accent', 0.12], [0.5, 'accent', 0], [1, 'accent', 0.12]) }) },
    }),
    rect('frame-outer', C.square.box(40, 40, 1000, 1000), {
      stroke: { color: 'accent', width: 0.002 },
      opacity: 0.8,
      at: { portrait: patch(C.portrait, { box: [40, 40, 1000, 1270] }), story: patch(C.story, { box: [40, 40, 1000, 1840] }), banner: patch(C.banner, { box: [12, 12, 1176, 276] }) },
    }),
    rect('frame-inner', C.square.box(58, 58, 964, 964), {
      stroke: { color: 'accent', width: 0.0014 },
      opacity: 0.45,
      at: { portrait: patch(C.portrait, { box: [58, 58, 964, 1234] }), story: patch(C.story, { box: [58, 58, 964, 1804] }), banner: patch(C.banner, { box: [22, 22, 1156, 256] }) },
    }),
    logo('logo', C.square.box(290, 128, 500, 52), {
      align: 'center',
      nameFamily: 'serif',
      nameWeight: 500,
      nameColor: 'onInk',
      upper: true,
      tracking: 0.2,
      at: {
        portrait: patch(C.portrait, { box: [290, 164, 500, 56] }),
        story: patch(C.story, { box: [290, 306, 500, 62] }),
        banner: patch(C.banner, { box: [56, 126, 262, 48] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(240, 296, 600, 30), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.28,
      weight: 500,
      color: 'onInk',
      opacity: 0.8,
      align: 'center',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [240, 380, 600, 32], size: 20 }),
        story: patch(C.story, { box: [200, 676, 680, 38], size: 23 }),
        banner: patch(C.banner, { box: [406, 66, 480, 26], size: 13, align: 'left' }),
      },
    }),
    text('headline', 'headline', C.square.box(150, 346, 780, 290), {
      size: C.square.size(84, 46),
      family: 'serif',
      weight: 400,
      lh: 1.1,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [130, 440, 820, 350], size: [94, 50] }),
        story: patch(C.story, { box: [100, 740, 880, 440], size: [108, 58] }),
        banner: patch(C.banner, { box: [406, 96, 480, 140], size: [50, 28], align: 'left', valign: 'top', maxLines: 2 }),
      },
    }),
    line('orn-left', C.square.pt(400, 676), C.square.pt(508, 676), { color: 'accent', width: 0.0016 }, {
      opacity: 0.8,
      at: {
        portrait: { from: C.portrait.pt(400, 842), to: C.portrait.pt(508, 842) },
        story: { from: C.story.pt(390, 1252), to: C.story.pt(506, 1252) },
      },
      hide: ['banner'],
    }),
    poly('orn-diamond', [C.square.pt(540, 664), C.square.pt(552, 676), C.square.pt(540, 688), C.square.pt(528, 676)], {
      fill: 'accent',
      at: {
        portrait: { points: [C.portrait.pt(540, 830), C.portrait.pt(552, 842), C.portrait.pt(540, 854), C.portrait.pt(528, 842)] },
        story: { points: [C.story.pt(540, 1239), C.story.pt(553, 1252), C.story.pt(540, 1265), C.story.pt(527, 1252)] },
        banner: { points: [C.banner.pt(358, 143), C.banner.pt(365, 150), C.banner.pt(358, 157), C.banner.pt(351, 150)] },
      },
    }),
    line('orn-right', C.square.pt(572, 676), C.square.pt(680, 676), { color: 'accent', width: 0.0016 }, {
      opacity: 0.8,
      at: {
        portrait: { from: C.portrait.pt(572, 842), to: C.portrait.pt(680, 842) },
        story: { from: C.story.pt(574, 1252), to: C.story.pt(690, 1252) },
      },
      hide: ['banner'],
    }),
    line('divider-top', C.banner.pt(358, 62), C.banner.pt(358, 134), { color: 'accent', width: 0.0016 }, { opacity: 0.8, hide: ['square', 'portrait', 'story'] }),
    line('divider-bottom', C.banner.pt(358, 166), C.banner.pt(358, 238), { color: 'accent', width: 0.0016 }, { opacity: 0.8, hide: ['square', 'portrait', 'story'] }),
    text('support', 'support', C.square.box(210, 724, 660, 110), {
      size: C.square.size(27, 21),
      weight: 300,
      lh: 1.4,
      color: 'onInk',
      opacity: 0.8,
      align: 'center',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [200, 892, 680, 130], size: [29, 22] }),
        story: patch(C.story, { box: [170, 1304, 740, 160], size: [34, 26] }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(370, 876, 340, 68), {
      radius: 0,
      upper: true,
      tracking: 0.14,
      weight: 500,
      size: C.square.size(21, 15),
      at: {
        portrait: patch(C.portrait, { box: [360, 1090, 360, 72], size: [22, 15] }),
        story: patch(C.story, { box: [320, 1520, 440, 86], size: [27, 18] }),
        banner: patch(C.banner, { box: [900, 118, 244, 64], size: [16, 11] }),
      },
    }),
  ],
});

/**
 * lux_arch_portrait: an ARCH-SHAPED PICTURE WINDOW that rises from the bottom edge of the brand-colored canvas, wrapped by a hairline
 * outline offset a few pixels (the outline is a pill-shaped rect whose lower half is cut away by the canvas edge). A quiet text column
 * (brand, eyebrow, serif headline, a short rule, support, square button) sits beside it; in stories the text stacks above the window.
 */
const luxArchPortrait = defineTemplate({
  id: 'lux_arch_portrait',
  name: 'Arch portrait (picture window)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A tall arch-shaped picture window rising from the bottom edge with a hairline offset outline, and a quiet column of serif text beside it (above it in stories).',
  styles: ['luxury_hospitality', 'premium_editorial'],
  industries: ['hotel', 'fine dining', 'restaurant', 'spa', 'resort', 'wine', 'wedding venue', 'boutique', 'hospitality'],
  channels: [],
  classes: ['portrait', 'square', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'panel',
  composition: 'Brand-colored canvas; a tall arch picture window with an offset hairline outline rises from the bottom edge beside a quiet serif text column (stacked above it in stories).',
  sample: {
    headline: 'Where the evening slows down',
    support: 'Candlelit tables, a quiet terrace and a menu built around the season.',
    cta: 'Reserve a table',
    eyebrow: 'Spring menu',
    brand: 'Maison Aurel',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    // the offset outline: a pill whose lower half lies below the canvas edge, so only the arch is seen
    rect('arch-outline', C.portrait.box(508, 148, 504, 1470), {
      radius: 0.5,
      stroke: { color: 'accent', width: 0.0016 },
      opacity: 0.85,
      at: {
        square: patch(C.square, { box: [582, 98, 444, 1230] }),
        story: patch(C.story, { box: [164, 1064, 752, 1250] }),
        landscape: patch(C.landscape, { box: [770, 38, 372, 790] }),
      },
    }),
    img('photo', 'hero', C.portrait.box(530, 170, 460, 1240), {
      mask: 'arch',
      focus: [0.5, 0.45],
      at: {
        square: patch(C.square, { box: [604, 120, 400, 1000] }),
        story: patch(C.story, { box: [190, 1090, 700, 880] }),
        landscape: patch(C.landscape, { box: [786, 54, 340, 620] }),
      },
    }),
    logo('logo', C.portrait.box(86, 118, 360, 44), {
      nameFamily: 'serif',
      nameWeight: 500,
      nameColor: 'onPrimary',
      upper: true,
      tracking: 0.2,
      at: {
        square: patch(C.square, { box: [86, 96, 360, 42] }),
        story: patch(C.story, { box: [290, 290, 500, 56], align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 62, 340, 34] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.portrait.box(86, 548, 400, 26), {
      size: C.portrait.size(19),
      upper: true,
      tracking: 0.28,
      weight: 500,
      color: 'onPrimary',
      lines: 1,
      at: {
        square: patch(C.square, { box: [86, 392, 470, 26], size: 18 }),
        story: patch(C.story, { box: [200, 424, 680, 36], size: 23, align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 154, 600, 22], size: 13 }),
      },
    }),
    text('headline', 'headline', C.portrait.box(86, 594, 410, 330), {
      size: C.portrait.size(70, 40),
      family: 'serif',
      weight: 400,
      lh: 1.1,
      color: 'onPrimary',
      lines: 4,
      at: {
        square: patch(C.square, { box: [86, 432, 470, 290], size: [66, 38] }),
        story: patch(C.story, { box: [110, 488, 860, 250], size: [96, 54], align: 'center', maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 184, 600, 150], size: [54, 32], maxLines: 3 }),
      },
    }),
    line('rule', C.portrait.pt(86, 960), C.portrait.pt(146, 960), { color: 'accent', width: 0.0024 }, {
      at: {
        square: { from: C.square.pt(86, 748), to: C.square.pt(146, 748) },
        story: { from: C.story.pt(510, 772), to: C.story.pt(570, 772) },
        landscape: { from: C.landscape.pt(72, 352), to: C.landscape.pt(120, 352) },
      },
    }),
    text('support', 'support', C.portrait.box(86, 990, 410, 130), {
      size: C.portrait.size(26, 20),
      weight: 300,
      lh: 1.4,
      color: 'onPrimary',
      opacity: 0.92,
      lines: 4,
      at: {
        square: patch(C.square, { box: [86, 776, 440, 110], size: [24, 19] }),
        story: patch(C.story, { box: [170, 804, 740, 90], size: [31, 24], align: 'center', maxLines: 2 }),
        landscape: patch(C.landscape, { box: [72, 372, 540, 60], size: [19, 15], maxLines: 3 }),
      },
    }),
    button('cta', C.portrait.box(86, 1160, 340, 68), {
      radius: 0,
      fill: 'accent',
      color: 'onAccent',
      upper: true,
      tracking: 0.14,
      weight: 500,
      size: C.portrait.size(21, 15),
      at: {
        square: patch(C.square, { box: [86, 910, 320, 64], size: [20, 14] }),
        story: patch(C.story, { box: [320, 934, 440, 80], size: [26, 17] }),
        landscape: patch(C.landscape, { box: [72, 468, 250, 54], size: [16, 12] }),
      },
    }),
  ],
});

/**
 * life_story_note: a WARM POSTER of type and soft shapes. A large sun-like circle bleeds off the top-right corner of the paper canvas,
 * two soft shapes overlap it (a tinted circle and a tilted oval), and an optional picture sits in a softly rounded frame in front of
 * them (without a picture the frame shows the brand pattern, so the poster is finished either way). A big friendly sentence-case
 * headline, one short line and a pill button sit on the left. The banner keeps the sun, the shapes and the frame on the right and sets
 * headline, button and support in one tidy block on the left.
 */
const lifeStoryNote = defineTemplate({
  id: 'life_story_note',
  name: 'Story note (sun and soft shapes)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A warm paper poster: a big sunny circle, two overlapping soft shapes, a friendly sentence-case headline, a pill button and an optional picture in a softly rounded frame.',
  styles: ['lifestyle_photography', 'soft_lifestyle'],
  industries: ['cafe', 'restaurant', 'community', 'wellness', 'family services', 'education', 'nonprofit', 'coaching', 'food', 'travel'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'poster-type',
  composition: 'Warm paper poster: a big sun circle bleeding off the top-right, two overlapping soft shapes, an optional rounded picture in front, a big friendly headline, support and a pill button on the left.',
  sample: {
    headline: 'Good days start around a table',
    support: 'Warm food, easy company and a seat saved for you.',
    cta: 'Come and say hello',
    eyebrow: 'Open every day',
    brand: 'Fennel & Fig',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    circle('sun', C.square.box(540, -90, 620, 620), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [470, -120, 700, 700] }),
        story: patch(C.story, { box: [380, -170, 860, 860] }),
        banner: patch(C.banner, { box: [800, -140, 420, 420] }),
      },
    }),
    circle('soft-a', C.square.box(560, 290, 310, 310), {
      fill: 'primary',
      opacity: 0.45,
      at: {
        portrait: patch(C.portrait, { box: [590, 360, 340, 340] }),
        story: patch(C.story, { box: [270, 470, 480, 480] }),
        banner: patch(C.banner, { box: [740, 120, 190, 190] }),
      },
    }),
    ellipse('soft-b', C.square.box(820, 330, 330, 230), {
      fill: 'secondary',
      opacity: 0.35,
      rotate: 24,
      at: {
        portrait: patch(C.portrait, { box: [800, 450, 400, 280] }),
        story: patch(C.story, { box: [790, 500, 460, 320] }),
        banner: patch(C.banner, { box: [1030, 160, 200, 140] }),
      },
    }),
    img('photo', 'hero', C.square.box(610, 450, 370, 470), {
      mask: 'rounded',
      radius: 0.07,
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [610, 560, 384, 540] }),
        story: patch(C.story, { box: [300, 520, 680, 540] }),
        banner: patch(C.banner, { box: [800, 36, 300, 228] }),
      },
    }),
    logo('logo', C.square.box(86, 80, 320, 50), {
      nameColor: 'ink',
      nameWeight: 700,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 320, 52] }),
        story: patch(C.story, { box: [86, 290, 360, 60] }),
        banner: patch(C.banner, { box: [48, 40, 260, 30] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 330, 440, 30), {
      size: C.square.size(23),
      weight: 600,
      color: 'ink',
      opacity: 0.75,
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 440, 450, 32], size: 25 }),
        story: patch(C.story, { box: [86, 1118, 800, 38], size: 28 }),
        banner: patch(C.banner, { box: [48, 76, 400, 22], size: 15 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(86, 372, 468, 330), {
      size: C.square.size(76, 50),
      family: 'display',
      weight: 700,
      lh: 1.08,
      color: 'ink',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 482, 470, 400], size: [82, 50], maxLines: 3 }),
        story: patch(C.story, { box: [86, 1166, 908, 250], size: [112, 62], maxLines: 3 }),
        banner: patch(C.banner, { box: [48, 84, 680, 112], size: [48, 28], maxLines: 2, valign: 'middle' }),
      },
    }),
    text('support', 'support', C.square.box(86, 722, 440, 100), {
      size: C.square.size(27, 21),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.85,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 910, 440, 120], size: [28, 22], maxLines: 4 }),
        story: patch(C.story, { box: [86, 1440, 908, 100], size: [35, 26], maxLines: 2 }),
        banner: patch(C.banner, { box: [300, 206, 440, 50], size: [18, 14], maxLines: 2, valign: 'middle' }),
      },
    }),
    button('cta', C.square.box(86, 860, 340, 74), {
      fill: 'primary',
      color: 'onPrimary',
      size: C.square.size(28, 20),
      at: {
        portrait: patch(C.portrait, { box: [86, 1070, 360, 76], size: [30, 21] }),
        story: patch(C.story, { box: [86, 1556, 420, 84], size: [34, 24] }),
        banner: patch(C.banner, { box: [48, 208, 230, 50], size: [19, 14] }),
      },
    }),
  ],
});

/**
 * life_photo_caption: THE PICTURE IS THE STORY. A full-bleed photo carries the whole canvas, a light scrim darkens only the side where the
 * words sit, and a soft rounded paper CAPTION CARD with a gentle shadow rests in the lower left: eyebrow, a friendly headline, one
 * support line and a pill button. The brand sits on the picture in a small paper chip. Landscape slides the card to the left edge at
 * mid height so the picture stays open on the right.
 */
const lifePhotoCaption = defineTemplate({
  id: 'life_photo_caption',
  name: 'Photo caption (soft card)',
  version: 1,
  status: 'active',
  category: 'editorial_brand',
  description: 'A full-bleed photograph with a light scrim and a soft rounded caption card in the lower left: eyebrow, friendly headline, support line and a pill button.',
  styles: ['lifestyle_photography', 'soft_lifestyle'],
  industries: ['cafe', 'restaurant', 'fitness', 'wellness', 'travel', 'education', 'nonprofit', 'community', 'food', 'family services'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'full-bleed',
  composition: 'Full-bleed photo with a light scrim on the text side and a soft rounded paper caption card (eyebrow, headline, support, pill button) in the lower left; the brand in a chip on the picture.',
  sample: {
    headline: 'Slow mornings, good company',
    support: 'Fresh bread, good coffee and a table by the window, waiting for you.',
    cta: 'Plan your visit',
    eyebrow: 'Saturdays and Sundays',
    brand: 'Fennel & Fig',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { focus: [0.5, 0.4] }),
    rect('scrim', C.square.box(0, 380, 1080, 700), {
      fill: grad(90, [0, 'ink', 0], [1, 'ink', 0.5]),
      at: {
        portrait: patch(C.portrait, { box: [0, 520, 1080, 830] }),
        story: patch(C.story, { box: [0, 840, 1080, 1080] }),
        landscape: patch(C.landscape, { box: [0, 0, 760, 628], fill: grad(0, [0, 'ink', 0.5], [1, 'ink', 0]) }),
      },
    }),
    logo('logo', C.square.box(86, 80, 250, 52), {
      nameColor: 'ink',
      nameWeight: 700,
      plate: { fill: 'paper', padding: 0.012, radius: 0.5 },
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 250, 52] }),
        story: patch(C.story, { box: [86, 290, 340, 64] }),
        landscape: patch(C.landscape, { box: [878, 66, 250, 42], align: 'right' }),
      },
    }),
    rect('card', C.square.box(86, 560, 620, 444), {
      fill: 'paper',
      radius: 0.07,
      shadow: true,
      at: {
        portrait: patch(C.portrait, { box: [86, 700, 620, 542] }),
        story: patch(C.story, { box: [86, 960, 640, 691] }),
        landscape: patch(C.landscape, { box: [72, 200, 500, 365] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(130, 602, 532, 28), {
      size: C.square.size(22),
      weight: 600,
      color: 'onPaper',
      opacity: 0.84,
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [130, 744, 532, 30], size: 24 }),
        story: patch(C.story, { box: [140, 1010, 540, 36], size: 27 }),
        landscape: patch(C.landscape, { box: [112, 238, 420, 22], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(130, 640, 532, 150), {
      size: C.square.size(52, 36),
      family: 'display',
      weight: 700,
      lh: 1.08,
      color: 'onPaper',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [130, 786, 532, 210], size: [56, 40] }),
        story: patch(C.story, { box: [140, 1062, 540, 290], size: [80, 40], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [112, 266, 420, 100], size: [40, 26], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(130, 796, 532, 72), {
      size: C.square.size(24, 19),
      weight: 400,
      lh: 1.35,
      color: 'onPaper',
      opacity: 0.85,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [130, 1008, 532, 76], size: [26, 20] }),
        story: patch(C.story, { box: [140, 1374, 540, 110], size: [30, 24], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [112, 378, 420, 60], size: [18, 14], maxLines: 3 }),
      },
    }),
    button('cta', C.square.box(130, 890, 300, 68), {
      fill: 'primary',
      color: 'onPrimary',
      size: C.square.size(25, 18),
      at: {
        portrait: patch(C.portrait, { box: [130, 1112, 320, 72], size: [27, 19] }),
        story: patch(C.story, { box: [140, 1520, 400, 84], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [112, 468, 240, 56], size: [19, 14] }),
      },
    }),
  ],
});

type Pt2 = [number, number];

/** A price-tag glyph (a pentagon pointing left, with a punched hole) turned by `deg`, centred on (cx, cy) with half-width `u`, in pixels of one class. */
function tagGlyph(c: CanvasHelper, cx: number, cy: number, u: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const turn = ([px, py]: Pt2): Pt2 => c.pt(cx + (px * Math.cos(a) - py * Math.sin(a)) * u, cy + (px * Math.sin(a) + py * Math.cos(a)) * u);
  const body: Pt2[] = [[-0.74, 0], [-0.26, -0.5], [0.74, -0.5], [0.74, 0.5], [-0.26, 0.5]];
  const hole = turn([-0.36, 0]);
  const r = u * 0.13;
  return { points: body.map(turn), holeBox: c.box(hole[0] * c.width - r, hole[1] * c.height - r, r * 2, r * 2) };
}

type GridGeo = { x: number; y: number; w: number; h: number; gap: number; d: number };
type GridClass = 'square' | 'portrait' | 'story' | 'landscape';

/**
 * Three equal rounded feature tiles drawn as pure graphics (no text): a check badge, a target circle and a price tag. Each class gives the
 * first tile's corner, the tile size, the gap and the badge diameter in pixels; the tiles run left to right. The (optional) picture of
 * the middle tile is added by the template AFTER these layers, so it covers that tile's graphic when a picture exists.
 */
function featureTiles(spec: Record<GridClass, GridGeo>) {
  const CLS: GridClass[] = ['square', 'portrait', 'story', 'landscape'];
  const geo = (c: CanvasHelper, g: GridGeo, i: number) => {
    const x = g.x + i * (g.w + g.gap);
    const cx = x + g.w / 2;
    const cy = g.y + g.h * 0.5;
    const disc = [cx - g.d / 2, cy - g.d / 2, g.d, g.d] as const;
    const tick = ([[0.22, 0.52], [0.31, 0.43], [0.44, 0.56], [0.69, 0.3], [0.78, 0.39], [0.44, 0.74]] as Pt2[]).map(([u, v]) => c.pt(disc[0] + u * g.d, disc[1] + v * g.d));
    const tag = tagGlyph(c, cx, cy, g.d * 0.42, -32);
    return {
      tile: c.box(x, g.y, g.w, g.h),
      disc: c.box(...disc),
      core: c.box(cx - g.d * 0.21, cy - g.d * 0.21, g.d * 0.42, g.d * 0.42),
      tick,
      tag: tag.points,
      hole: tag.holeBox,
    };
  };
  const G = Object.fromEntries(CLS.map((k) => [k, [0, 1, 2].map((i) => geo(C[k], spec[k], i))])) as Record<GridClass, ReturnType<typeof geo>[]>;
  const boxAt = (part: 'tile' | 'disc' | 'core' | 'hole', i: number) => ({
    portrait: { box: G.portrait[i][part] },
    story: { box: G.story[i][part] },
    landscape: { box: G.landscape[i][part] },
  });
  const ptsAt = (part: 'tick' | 'tag', i: number) => ({ portrait: { points: G.portrait[i][part] }, story: { points: G.story[i][part] }, landscape: { points: G.landscape[i][part] } });
  const out = [];
  for (let i = 0; i < 3; i++) out.push(rect(`tile-${i + 1}`, G.square[i].tile, { fill: 'white', radius: 0.06, shadow: true, at: boxAt('tile', i) }));
  out.push(
    circle('badge-1', G.square[0].disc, { fill: 'accent', at: boxAt('disc', 0) }),
    poly('badge-1-check', G.square[0].tick, { fill: 'onAccent', at: ptsAt('tick', 0) }),
    circle('badge-2', G.square[1].disc, { stroke: { color: 'ink', width: 0.011 }, at: boxAt('disc', 1) }),
    circle('badge-2-core', G.square[1].core, { fill: 'accent', at: boxAt('core', 1) }),
    circle('badge-3', G.square[2].disc, { fill: 'ink', at: boxAt('disc', 2) }),
    poly('badge-3-tag', G.square[2].tag, { fill: 'onInk', at: ptsAt('tag', 2) }),
    circle('badge-3-hole', G.square[2].hole, { fill: 'ink', at: boxAt('hole', 2) }),
  );
  return out;
}

/**
 * shop_feature_grid: a CLEAN CENTRED SHOP PAGE. A centred brand, a bold headline and support line on paper, a row of three equal rounded white
 * tiles with soft shadows (a check badge, a target and a price tag, drawn as graphics only: nothing is written inside them), and one large
 * accent button with an arrow. The middle tile can carry the product picture; without it the target badge stays. Story stretches the tiles
 * tall; landscape puts the words on the left and the tiles on the right.
 */
const shopFeatureGrid = defineTemplate({
  id: 'shop_feature_grid',
  name: 'Feature grid (three tiles)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'A clean white shop layout: centred headline and support line, three equal rounded tiles drawn as check, target and tag graphics (the middle one can show the product) and a large button with an arrow.',
  styles: ['clean_ecommerce', 'modern_corporate'],
  industries: ['ecommerce', 'retail', 'consumer goods', 'electronics', 'beauty', 'home goods', 'apparel', 'subscription box'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'centered',
  composition: 'Paper canvas: centred brand, headline and support, three equal rounded graphic tiles (the middle one can hold the product) and a large arrow button; words left, tiles right in landscape.',
  sample: {
    headline: 'Everything you love, delivered fast',
    support: 'Free returns, secure checkout and a fair price on every single order.',
    cta: 'Shop the collection',
    brand: 'Alder & Co',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    ...featureTiles({
      square: { x: 86, y: 500, w: 280, h: 290, gap: 34, d: 118 },
      portrait: { x: 86, y: 620, w: 280, h: 360, gap: 34, d: 130 },
      story: { x: 86, y: 940, w: 280, h: 500, gap: 34, d: 150 },
      landscape: { x: 636, y: 136, w: 156, h: 356, gap: 18, d: 100 },
    }),
    img('product', 'hero', C.square.box(400, 500, 280, 290), {
      mask: 'rounded',
      radius: 0.04,
      fallback: 'none',
      at: {
        portrait: patch(C.portrait, { box: [400, 620, 280, 360] }),
        story: patch(C.story, { box: [400, 940, 280, 500] }),
        landscape: patch(C.landscape, { box: [810, 136, 156, 356] }),
      },
    }),
    logo('logo', C.square.box(340, 84, 400, 48), {
      align: 'center',
      nameColor: 'ink',
      nameWeight: 800,
      at: {
        portrait: patch(C.portrait, { box: [340, 104, 400, 50] }),
        story: patch(C.story, { box: [340, 290, 400, 60] }),
        landscape: patch(C.landscape, { box: [72, 66, 260, 38], align: 'left' }),
      },
    }),
    text('headline', 'headline', C.square.box(110, 168, 860, 190), {
      size: C.square.size(82, 46),
      weight: 800,
      lh: 1.04,
      color: 'ink',
      align: 'center',
      valign: 'middle',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [100, 208, 880, 250], size: [94, 52], maxLines: 3 }),
        story: patch(C.story, { box: [90, 400, 900, 350], size: [112, 60], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 126, 520, 190], size: [50, 30], align: 'left', maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(170, 372, 740, 90), {
      size: C.square.size(28, 22),
      weight: 500,
      lh: 1.35,
      color: 'ink',
      opacity: 0.78,
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [150, 478, 780, 96], size: [30, 22] }),
        story: patch(C.story, { box: [120, 770, 840, 130], size: [36, 26], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 326, 520, 80], size: [20, 15], align: 'left', maxLines: 3 }),
      },
    }),
    button('cta', C.square.box(270, 856, 540, 100), {
      arrow: true,
      size: C.square.size(36, 24),
      at: {
        portrait: patch(C.portrait, { box: [250, 1070, 580, 112], size: [38, 24] }),
        story: patch(C.story, { box: [86, 1520, 908, 116], size: [44, 28] }),
        landscape: patch(C.landscape, { box: [72, 436, 340, 84], size: [24, 16] }),
      },
    }),
  ],
});

/**
 * shop_banner_strip: a WIDE PROMOTIONAL STRIP built from two bands. One band is brand-colored and holds the (optional) product picture in a
 * soft rounded frame; the other is paper and holds a small tag line (a price-tag glyph and the optional tag text), a bold headline, one
 * support line and a large accent button with an arrow, with the brand tucked in the corner. Banner and landscape put the picture band on
 * the left; the square stacks it on top. Without a picture the frame shows a brand gradient, so the strip is finished either way.
 */
const shopBannerStrip = defineTemplate({
  id: 'shop_banner_strip',
  name: 'Promo strip (picture band)',
  version: 1,
  status: 'active',
  category: 'ecommerce',
  description: 'A wide promo strip: a brand-colored band with the product in a rounded frame, then a tag line, a bold headline, one support line and a large arrow button on paper. Reads at banner size.',
  styles: ['clean_ecommerce', 'bold_startup'],
  industries: ['ecommerce', 'retail', 'consumer goods', 'electronics', 'beauty', 'home goods', 'apparel', 'accessories', 'food products'],
  channels: [],
  classes: ['banner', 'landscape', 'square'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'Two bands: a brand-colored band with the product in a rounded frame beside (above, in the square) a paper band with a tag line, bold headline, support line and a large arrow button.',
  sample: {
    headline: 'Spring sale: up to 40% off',
    support: 'Fresh arrivals and bestsellers at their lowest prices of the season.',
    cta: 'Shop now',
    brand: 'Alder & Co',
    tag: 'Limited time',
  },
  tone: 'light',
  layers: [
    fill('bg', 'paper'),
    rect('band', C.banner.box(0, 0, 420, 300), {
      fill: 'primary',
      at: { landscape: patch(C.landscape, { box: [0, 0, 540, 628] }), square: patch(C.square, { box: [0, 0, 1080, 540] }) },
    }),
    img('product', 'hero', C.banner.box(28, 28, 364, 244), {
      mask: 'rounded',
      radius: 0.04,
      fallback: 'gradient',
      at: { landscape: patch(C.landscape, { box: [40, 40, 460, 548] }), square: patch(C.square, { box: [48, 48, 984, 444] }) },
    }),
    poly('tag-glyph', tagGlyph(C.banner, 480, 52, 18, 0).points, {
      fill: 'ink',
      at: {
        landscape: { points: tagGlyph(C.landscape, 606, 152, 21, 0).points },
        square: { points: tagGlyph(C.square, 112, 604, 25, 0).points },
      },
    }),
    circle('tag-hole', tagGlyph(C.banner, 480, 52, 18, 0).holeBox, {
      fill: 'paper',
      at: {
        landscape: { box: tagGlyph(C.landscape, 606, 152, 21, 0).holeBox },
        square: { box: tagGlyph(C.square, 112, 604, 25, 0).holeBox },
      },
    }),
    text('tag', 'tag', C.banner.box(512, 38, 300, 28), {
      size: C.banner.size(15, 12),
      color: 'ink',
      valign: 'middle',
      lines: 1,
      at: {
        landscape: patch(C.landscape, { box: [646, 138, 440, 28], size: [17, 13] }),
        square: patch(C.square, { box: [150, 586, 500, 36], size: [22, 16] }),
      },
    }),
    logo('logo', C.banner.box(920, 40, 232, 30), {
      align: 'right',
      nameColor: 'ink',
      nameWeight: 800,
      at: {
        landscape: patch(C.landscape, { box: [590, 70, 260, 36], align: 'left' }),
        square: patch(C.square, { box: [694, 584, 300, 40] }),
      },
    }),
    text('headline', 'headline', C.banner.box(464, 80, 430, 104), {
      size: C.banner.size(46, 28),
      weight: 800,
      lh: 1.04,
      color: 'ink',
      valign: 'middle',
      lines: 2,
      at: {
        landscape: patch(C.landscape, { box: [590, 182, 538, 170], size: [60, 34], maxLines: 3, valign: 'top' }),
        square: patch(C.square, { box: [86, 640, 908, 170], size: [80, 44], maxLines: 2, valign: 'top' }),
      },
    }),
    text('support', 'support', C.banner.box(464, 192, 430, 56), {
      size: C.banner.size(20, 15),
      weight: 500,
      lh: 1.3,
      color: 'ink',
      opacity: 0.78,
      lines: 2,
      at: {
        landscape: patch(C.landscape, { box: [590, 364, 538, 70], size: [22, 16] }),
        square: patch(C.square, { box: [86, 822, 908, 66], size: [28, 22], maxLines: 2 }),
      },
    }),
    button('cta', C.banner.box(920, 100, 232, 100), {
      arrow: true,
      size: C.banner.size(22, 16),
      at: {
        landscape: patch(C.landscape, { box: [590, 456, 330, 84], size: [30, 20] }),
        square: patch(C.square, { box: [86, 906, 440, 84], size: [36, 24] }),
      },
    }),
  ],
});

export const COLLECTION_TEMPLATES_B: TemplateDef[] = [luxInvitation, luxArchPortrait, lifeStoryNote, lifePhotoCaption, shopFeatureGrid, shopBannerStrip];
