import { CANVAS as C, button, defineTemplate, fill, grad, img, line, logo, patch, rect, scrim, text } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * hospitality_restaurant_promo: a SPLIT PANEL on the brand color. Square and landscape put the text on the left and a full-height photo
 * on the right with a diagonal edge; portrait stacks the photo above the text; story centres everything under an ARCH-shaped photo.
 * A hairline accent frame, a serif headline, a short accent divider and a soft-cornered button give it a warm, editorial feel.
 */
const hospitalityRestaurantPromo = defineTemplate({
  id: 'hospitality_restaurant_promo',
  name: 'Restaurant promo (split panel)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A brand-colored panel with a warm serif headline beside a full-height photo with a diagonal edge (arch-shaped photo in stories), framed by a hairline.',
  styles: ['luxury_hospitality', 'soft_lifestyle'],
  industries: ['restaurant', 'cafe', 'bar', 'bakery', 'hotel', 'hospitality', 'food', 'catering'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'split',
  composition: 'Brand-colored text panel beside a full-height photo with a diagonal edge; stacked in portrait, arch-framed and centred in stories.',
  sample: {
    headline: 'Sunday brunch, served slow',
    support: 'Seasonal plates, fresh bread and good coffee on our sunlit terrace.',
    cta: 'Reserve a table',
    eyebrow: 'Every Sunday · 11:00–15:00',
    brand: 'Casa Verde',
  },
  tone: 'brand',
  layers: [
    fill('panel', 'primary'),
    rect('frame', C.square.box(30, 30, 1020, 1020), {
      stroke: { color: 'onPrimary', width: 0.0016 },
      opacity: 0.4,
      at: { portrait: patch(C.portrait, { box: [30, 30, 1020, 1290] }), story: patch(C.story, { box: [30, 30, 1020, 1860] }), landscape: patch(C.landscape, { box: [20, 20, 1160, 588] }) },
    }),
    img('photo', 'hero', C.square.box(560, 0, 520, 1080), {
      mask: 'cut-left',
      radius: 0.2,
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [0, 0, 1080, 700], mask: 'none' }),
        story: patch(C.story, { box: [140, 372, 800, 760], mask: 'arch' }),
        landscape: patch(C.landscape, { box: [660, 0, 540, 628], radius: 0.17 }),
      },
    }),
    logo('logo', C.square.box(86, 86, 300, 56), {
      nameFamily: 'serif',
      nameWeight: 700,
      nameColor: 'ink',
      plate: { fill: 'paper', padding: 0.012, radius: 0.5 },
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 300, 56] }),
        story: patch(C.story, { box: [86, 282, 908, 56], align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 63, 260, 44], plate: { fill: 'paper', padding: 0.016, radius: 0.5 } }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 318, 440, 30), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.18,
      weight: 600,
      color: 'onPrimary',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 752, 908, 30], size: 22 }),
        story: patch(C.story, { box: [86, 1166, 908, 34], size: 22, align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 160, 540, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 360, 440, 300), {
      size: C.square.size(70, 42),
      family: 'serif',
      weight: 700,
      lh: 1.06,
      tracking: -0.01,
      color: 'onPrimary',
      lines: 5,
      at: {
        portrait: patch(C.portrait, { box: [86, 792, 908, 220], size: [92, 52] }),
        story: patch(C.story, { box: [86, 1208, 908, 210], size: [84, 50], align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 190, 540, 190], size: [46, 32] }),
      },
    }),
    line('divider', C.square.pt(86, 712), C.square.pt(146, 712), { color: 'accent', width: 0.003 }, {
      at: {
        story: { from: C.story.pt(500, 1440), to: C.story.pt(580, 1440) },
        landscape: { from: C.landscape.pt(72, 392), to: C.landscape.pt(120, 392) },
      },
      hide: ['portrait'],
    }),
    text('support', 'support', C.square.box(86, 740, 440, 130), {
      size: C.square.size(27, 22),
      weight: 400,
      lh: 1.35,
      color: 'onPrimary',
      opacity: 0.92,
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 1036, 780, 86], size: [28, 22] }),
        story: patch(C.story, { box: [110, 1458, 860, 84], size: [30, 24], align: 'center' }),
        landscape: patch(C.landscape, { box: [72, 404, 520, 66], size: [20, 16] }),
      },
    }),
    button('cta', C.square.box(86, 900, 320, 66), {
      radius: 0.16,
      upper: true,
      tracking: 0.1,
      size: C.square.size(23, 17),
      at: {
        portrait: patch(C.portrait, { box: [86, 1156, 340, 70], size: [25, 18] }),
        story: patch(C.story, { box: [330, 1572, 420, 74], size: [29, 21] }),
        landscape: patch(C.landscape, { box: [72, 486, 260, 58], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * hospitality_cafe_atmosphere: a FRAMED PHOTO PRINT. A brand-colored band runs behind the top of the canvas and a white-bordered
 * print, tilted a few degrees with a soft shadow, rests across its lower edge like a snapshot pinned to a wall. Below it sit a
 * left-aligned serif italic headline on paper and a support line with a button on the same baseline row. Landscape moves the print
 * to the left panel; story stacks the same idea taller.
 */
const hospitalityCafeAtmosphere = defineTemplate({
  id: 'hospitality_cafe_atmosphere',
  name: 'Cafe atmosphere (framed photo print)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A white-bordered photo print tilted over a brand-colored band, with a warm serif italic headline underneath: the cosy, human look of a neighbourhood cafe.',
  styles: ['soft_lifestyle', 'lifestyle_photography'],
  industries: ['cafe', 'coffee', 'bakery', 'restaurant', 'brunch', 'tea', 'food', 'hospitality'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'frame',
  composition: 'Brand-colored band behind a tilted, white-bordered photo print that overlaps its lower edge; serif italic headline and a support + button row on paper below.',
  sample: {
    headline: 'Slow mornings start here',
    support: 'Fresh pastries, single-origin coffee and a corner table that is always yours.',
    cta: 'Visit us today',
    eyebrow: 'Open daily 7:00 to 17:00',
    brand: 'Corner Roast',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    rect('band', C.square.box(0, 0, 1080, 610), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [0, 0, 1080, 760] }),
        story: patch(C.story, { box: [0, 0, 1080, 1020] }),
        landscape: patch(C.landscape, { box: [0, 0, 500, 628] }),
      },
    }),
    img('photo', 'hero', C.square.box(400, 96, 560, 600), {
      mask: 'rounded',
      radius: 0.02,
      border: { color: 'white', width: 0.022 },
      shadow: true,
      rotate: -3,
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [400, 110, 560, 740] }),
        story: patch(C.story, { box: [210, 400, 660, 740] }),
        landscape: patch(C.landscape, { box: [96, 54, 440, 520] }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameFamily: 'serif',
      nameWeight: 700,
      nameItalic: true,
      nameColor: 'onPrimary',
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 260, 46] }),
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [640, 80, 300, 38], nameColor: 'ink' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 470, 270, 96), {
      size: C.square.size(21),
      upper: true,
      tracking: 0.14,
      weight: 600,
      lh: 1.4,
      color: 'onPrimary',
      valign: 'bottom',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 610, 270, 96] }),
        story: patch(C.story, { box: [520, 272, 474, 76], size: [20, 16], align: 'right', valign: 'middle', maxLines: 2 }),
        landscape: patch(C.landscape, { box: [640, 134, 488, 24], size: 14, color: 'muted', valign: 'top', maxLines: 1 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 730, 908, 160), {
      size: C.square.size(76, 44),
      family: 'serif',
      italic: true,
      weight: 700,
      lh: 1.04,
      tracking: -0.01,
      color: 'ink',
      lines: 3,
      valign: 'top',
      at: {
        portrait: patch(C.portrait, { box: [86, 884, 908, 224], size: [84, 46] }),
        story: patch(C.story, { box: [86, 1196, 908, 232], size: [100, 54] }),
        landscape: patch(C.landscape, { box: [640, 168, 488, 200], size: [52, 30], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 902, 560, 92), {
      size: C.square.size(26, 21),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.85,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 1122, 560, 90], size: [27, 21] }),
        story: patch(C.story, { box: [86, 1450, 908, 100], size: [32, 25] }),
        landscape: patch(C.landscape, { box: [640, 384, 488, 70], size: [19, 15] }),
      },
    }),
    button('cta', C.square.box(716, 930, 278, 66), {
      radius: 0.5,
      fill: 'primary',
      color: 'onPrimary',
      size: C.square.size(23, 17),
      at: {
        portrait: patch(C.portrait, { box: [716, 1136, 278, 70], size: [24, 18] }),
        story: patch(C.story, { box: [86, 1566, 330, 76], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [640, 478, 250, 54], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * hospitality_food_showcase: a PEEKING PLATE. A huge round photo (cropped to a circle, like a plate seen from above) is pushed up past
 * the top edge of a brand-colored canvas so only its lower dome shows; an optional second round photo overlaps its lower right as a
 * second dish. Headline, support and a paper pill button stack centred beneath; the brand sits in a paper chip on the picture.
 * Landscape pushes the plate off the right edge and left-aligns the words.
 */
const hospitalityFoodShowcase = defineTemplate({
  id: 'hospitality_food_showcase',
  name: 'Food showcase (peeking plate)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A huge round plate-style photo peeking in from the top of a brand-colored canvas with an optional second dish overlapping it, and a bold centered headline with a paper pill button.',
  styles: ['lifestyle_photography', 'bold_startup', 'soft_lifestyle'],
  industries: ['restaurant', 'food', 'bakery', 'pizza', 'burger', 'street food', 'catering', 'delivery', 'bar', 'cafe'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'centered',
  composition: 'Round hero photo cropped by the top edge of a brand-colored canvas, an optional second round photo overlapping it, centred headline, support and pill button beneath.',
  sample: {
    headline: 'Handmade pasta, fired up fresh',
    support: 'Our signature dish, made to order with seasonal ingredients.',
    cta: 'Order now',
    eyebrow: 'Chef special',
    brand: 'Forno Nero',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    img('photo', 'hero', C.square.box(170, -190, 740, 740), {
      mask: 'circle',
      border: { color: 'white', width: 0.009 },
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [150, -190, 780, 780] }),
        story: patch(C.story, { box: [40, -60, 1000, 1000] }),
        landscape: patch(C.landscape, { box: [640, -70, 640, 640] }),
      },
    }),
    img('second-photo', 'secondary', C.square.box(690, 330, 280, 280), {
      mask: 'circle',
      border: { color: 'white', width: 0.009 },
      shadow: true,
      fallback: 'none',
      at: {
        portrait: patch(C.portrait, { box: [700, 420, 290, 290] }),
        story: patch(C.story, { box: [730, 690, 300, 300] }),
        landscape: patch(C.landscape, { box: [560, 330, 220, 220] }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 66), {
      nameWeight: 800,
      nameColor: 'ink',
      tracking: -0.01,
      plate: { fill: 'paper', padding: 0.012, radius: 0.5 },
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 260, 66] }),
        story: patch(C.story, { box: [86, 285, 300, 72] }),
        landscape: patch(C.landscape, { box: [72, 62, 220, 52], plate: { fill: 'primary', padding: 0, radius: 0 }, nameColor: 'onPrimary' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(140, 652, 800, 28), {
      size: C.square.size(20),
      upper: true,
      tracking: 0.2,
      weight: 700,
      color: 'onPrimary',
      align: 'center',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [140, 770, 800, 30], size: 22 }),
        story: patch(C.story, { box: [140, 1040, 800, 36], size: 25 }),
        landscape: patch(C.landscape, { box: [72, 150, 520, 24], size: 15, align: 'left' }),
      },
    }),
    text('headline', 'headline', C.square.box(100, 684, 880, 160), {
      size: C.square.size(76, 46),
      family: 'display',
      weight: 800,
      lh: 1.03,
      tracking: -0.015,
      color: 'onPrimary',
      align: 'center',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [100, 806, 880, 200], size: [86, 50] }),
        story: patch(C.story, { box: [90, 1090, 900, 260], size: [108, 58] }),
        landscape: patch(C.landscape, { box: [72, 180, 500, 146], size: [52, 30], align: 'left', maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(190, 848, 700, 60), {
      size: C.square.size(26, 21),
      weight: 400,
      lh: 1.35,
      color: 'onPrimary',
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [170, 1022, 740, 80], size: [28, 22] }),
        story: patch(C.story, { box: [150, 1370, 780, 110], size: [34, 26] }),
        landscape: patch(C.landscape, { box: [72, 342, 460, 60], size: [19, 15], align: 'left' }),
      },
    }),
    button('cta', C.square.box(370, 924, 340, 62), {
      fill: 'paper',
      color: 'onPaper',
      size: C.square.size(26, 19),
      upper: true,
      tracking: 0.08,
      at: {
        portrait: patch(C.portrait, { box: [360, 1130, 360, 70], size: [27, 20] }),
        story: patch(C.story, { box: [330, 1550, 420, 80], size: [30, 22] }),
        landscape: patch(C.landscape, { box: [72, 430, 250, 54], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * hospitality_event_announcement: a HEADLINE BAND across a moody duotone photo. The picture is mapped between ink and muted tones and
 * veiled so any white text reads on it; a solid accent band cuts across the middle and carries the event name in huge condensed
 * capitals. Eyebrow above, support / date / place / button below. Without a picture the brand pattern takes its place. Banner turns the
 * band into a solid block on the left; landscape lays the band across the middle like a ticket stub.
 */
const hospitalityEventAnnouncement = defineTemplate({
  id: 'hospitality_event_announcement',
  name: 'Event announcement (headline band)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A moody duotone photo cut by a solid accent band that carries the event name in big condensed capitals, with date, place and a button beneath: for tasting nights, live music and openings.',
  styles: ['dynamic_events', 'bold_startup', 'lifestyle_photography'],
  industries: ['restaurant', 'bar', 'pub', 'cafe', 'hotel', 'event', 'music', 'wine', 'nightlife', 'catering'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'Full-bleed duotone photo under an ink veil; a solid accent band across the middle holds the huge condensed headline; details and button below.',
  sample: {
    headline: 'Live jazz night',
    support: 'An evening of local musicians, a short tasting menu and house wine by the glass.',
    cta: 'Book your table',
    eyebrow: 'This Friday',
    brand: 'Cellar 41',
    date: 'Fri 8 PM',
    location: 'Old Town Terrace',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { duotone: { shadow: 'ink', light: 'muted' }, fallback: 'brandPattern' }),
    rect('veil', [0, 0, 1, 1], {
      fill: grad(90, [0, 'ink', 0.4], [0.5, 'ink', 0.2], [1, 'ink', 0.82]),
      at: { banner: patch(C.banner, { box: [0, 0, 1200, 300], fill: grad(0, [0, 'ink', 0.2], [0.55, 'ink', 0.45], [1, 'ink', 0.88]) }) },
    }),
    rect('band', C.square.box(0, 318, 1080, 330), {
      fill: 'accent',
      at: {
        story: patch(C.story, { box: [0, 440, 1080, 440] }),
        landscape: patch(C.landscape, { box: [0, 166, 1200, 214] }),
        banner: patch(C.banner, { box: [0, 0, 700, 300] }),
      },
    }),
    logo('logo', C.square.box(86, 80, 260, 46), {
      nameColor: 'onInk',
      nameWeight: 800,
      tracking: -0.01,
      at: {
        story: patch(C.story, { box: [86, 285, 300, 52] }),
        landscape: patch(C.landscape, { box: [72, 72, 260, 40] }),
        banner: patch(C.banner, { box: [760, 44, 340, 34] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 268, 908, 34), {
      size: C.square.size(24),
      upper: true,
      tracking: 0.22,
      weight: 700,
      color: 'onInk',
      valign: 'bottom',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 380, 908, 44], size: 28 }),
        landscape: patch(C.landscape, { box: [72, 128, 800, 26], size: 17 }),
        banner: patch(C.banner, { box: [48, 40, 600, 24], size: 14, color: 'onAccent' }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 340, 908, 286), {
      size: C.square.size(132, 52),
      family: 'condensed',
      weight: 800,
      upper: true,
      lh: 0.96,
      tracking: 0.005,
      color: 'onAccent',
      valign: 'middle',
      lines: 4,
      at: {
        story: patch(C.story, { box: [86, 456, 908, 408], size: [190, 70], maxLines: 4 }),
        landscape: patch(C.landscape, { box: [72, 178, 1056, 190], size: [100, 40], maxLines: 3 }),
        banner: patch(C.banner, { box: [48, 70, 610, 190], size: [76, 30], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 676, 908, 80), {
      size: C.square.size(27, 21),
      weight: 400,
      lh: 1.35,
      color: 'onInk',
      opacity: 0.92,
      lines: 2,
      at: {
        story: patch(C.story, { box: [86, 912, 908, 130], size: [34, 26], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 400, 640, 60], size: [19, 15] }),
        banner: patch(C.banner, { box: [760, 84, 392, 44], size: [15, 12], maxLines: 2 }),
      },
    }),
    text('date', 'date', C.square.box(86, 800, 560, 74), {
      size: C.square.size(64, 40),
      family: 'condensed',
      weight: 800,
      upper: true,
      tracking: 0.02,
      color: 'onInk',
      valign: 'bottom',
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 1370, 908, 112], size: [88, 50] }),
        landscape: patch(C.landscape, { box: [72, 470, 520, 54], size: [44, 30] }),
        banner: patch(C.banner, { box: [760, 138, 176, 44], size: [34, 22] }),
      },
    }),
    text('location', 'location', C.square.box(86, 878, 560, 34), {
      size: C.square.size(24, 18),
      weight: 600,
      tracking: 0.04,
      color: 'onInk',
      opacity: 0.9,
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 1488, 908, 44], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [72, 526, 520, 30], size: [20, 15] }),
        banner: patch(C.banner, { box: [760, 184, 176, 28], size: [16, 12] }),
      },
    }),
    button('cta', C.square.box(674, 878, 320, 72), {
      fill: 'accent',
      color: 'onAccent',
      radius: 0.14,
      upper: true,
      tracking: 0.08,
      size: C.square.size(24, 17),
      at: {
        story: patch(C.story, { box: [86, 1562, 420, 80], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [880, 470, 248, 62], size: [19, 14] }),
        banner: patch(C.banner, { box: [944, 172, 208, 56], size: [14, 11] }),
      },
    }),
  ],
});

/**
 * hospitality_premium_dining: an INSET MENU CARD. A darkened full-bleed photo carries the mood; a cream card with a double hairline
 * frame floats in the middle (a shadowed paper menu), holding a tracked-capitals brand name, a diamond ornament, a quiet eyebrow, a
 * restrained serif headline, support copy and one square-cornered button. Landscape slides the card to the left half so the photo shows.
 */
const hospitalityPremiumDining = defineTemplate({
  id: 'hospitality_premium_dining',
  name: 'Premium dining (inset menu card)',
  version: 1,
  status: 'active',
  category: 'hospitality',
  description: 'A darkened atmosphere photo with a cream menu-style card floating on top: double hairline frame, diamond ornament and a restrained serif headline for fine dining and tasting menus.',
  styles: ['luxury_hospitality', 'premium_editorial'],
  industries: ['restaurant', 'fine dining', 'hotel', 'wine', 'bar', 'resort', 'spa', 'catering', 'hospitality'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'airy',
  family: 'inset-card',
  composition: 'Darkened full-bleed photo; a shadowed cream card with a double hairline frame centred on it (left half in landscape) holds all centred text.',
  sample: {
    headline: 'An evening of seasonal tasting',
    support: 'Seven courses by candlelight, paired with wines chosen by our sommelier.',
    cta: 'Reserve a table',
    eyebrow: 'Tasting menu',
    brand: 'Maison Aurel',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { scrim: scrim(90, 'ink', 0.5, 'ink', 0.72), fallback: 'brandPattern' }),
    rect('card', C.square.box(200, 120, 680, 840), {
      fill: 'paper',
      shadow: true,
      at: {
        portrait: patch(C.portrait, { box: [170, 130, 740, 1070] }),
        story: patch(C.story, { box: [130, 430, 820, 1060] }),
        landscape: patch(C.landscape, { box: [48, 30, 560, 568] }),
      },
    }),
    rect('frame', C.square.box(220, 140, 640, 800), {
      stroke: { color: 'ink', width: 0.0016 },
      opacity: 0.35,
      at: {
        portrait: patch(C.portrait, { box: [190, 150, 700, 1030] }),
        story: patch(C.story, { box: [150, 450, 780, 1020] }),
        landscape: patch(C.landscape, { box: [62, 44, 532, 540] }),
      },
    }),
    logo('logo', C.square.box(290, 178, 500, 40), {
      align: 'center',
      nameFamily: 'serif',
      nameWeight: 600,
      nameColor: 'ink',
      upper: true,
      tracking: 0.16,
      at: {
        portrait: patch(C.portrait, { box: [260, 190, 560, 44] }),
        story: patch(C.story, { box: [200, 510, 680, 52] }),
        landscape: patch(C.landscape, { box: [100, 78, 456, 34] }),
      },
    }),
    line('orn-left', C.square.pt(430, 262), C.square.pt(510, 262), { color: 'ink', width: 0.0016 }, {
      opacity: 0.4,
      at: {
        portrait: { from: C.portrait.pt(410, 292), to: C.portrait.pt(500, 292) },
        story: { from: C.story.pt(400, 622), to: C.story.pt(500, 622) },
        landscape: { from: C.landscape.pt(250, 130), to: C.landscape.pt(290, 130) },
      },
    }),
    rect('orn-diamond', C.square.box(530, 252, 20, 20), {
      fill: 'accent',
      rotate: 45,
      at: {
        portrait: patch(C.portrait, { box: [530, 282, 20, 20] }),
        story: patch(C.story, { box: [530, 612, 22, 22] }),
        landscape: patch(C.landscape, { box: [326, 121, 18, 18] }),
      },
    }),
    line('orn-right', C.square.pt(570, 262), C.square.pt(650, 262), { color: 'ink', width: 0.0016 }, {
      opacity: 0.4,
      at: {
        portrait: { from: C.portrait.pt(580, 292), to: C.portrait.pt(670, 292) },
        story: { from: C.story.pt(580, 622), to: C.story.pt(680, 622) },
        landscape: { from: C.landscape.pt(380, 130), to: C.landscape.pt(420, 130) },
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(250, 298, 580, 30), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.3,
      weight: 600,
      color: 'muted',
      align: 'center',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [220, 328, 640, 30], size: 20 }),
        story: patch(C.story, { box: [190, 662, 700, 36], size: 23 }),
        landscape: patch(C.landscape, { box: [90, 154, 476, 22], size: 13 }),
      },
    }),
    text('headline', 'headline', C.square.box(250, 396, 580, 270), {
      size: C.square.size(70, 40),
      family: 'serif',
      weight: 600,
      lh: 1.08,
      color: 'ink',
      align: 'center',
      valign: 'middle',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [220, 480, 640, 340], size: [80, 44] }),
        story: patch(C.story, { box: [180, 780, 720, 340], size: [88, 48] }),
        landscape: patch(C.landscape, { box: [90, 184, 476, 168], size: [44, 28] }),
      },
    }),
    text('support', 'support', C.square.box(270, 696, 540, 112), {
      size: C.square.size(25, 20),
      weight: 400,
      lh: 1.4,
      color: 'ink',
      opacity: 0.8,
      align: 'center',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [250, 852, 580, 130], size: [27, 21] }),
        story: patch(C.story, { box: [190, 1150, 700, 150], size: [32, 25] }),
        landscape: patch(C.landscape, { box: [110, 366, 436, 70], size: [17, 13] }),
      },
    }),
    button('cta', C.square.box(370, 836, 340, 66), {
      fill: 'ink',
      color: 'onInk',
      radius: 0.06,
      upper: true,
      tracking: 0.16,
      size: C.square.size(20, 15),
      at: {
        portrait: patch(C.portrait, { box: [370, 1022, 340, 68], size: [21, 15] }),
        story: patch(C.story, { box: [330, 1336, 420, 78], size: [24, 17] }),
        landscape: patch(C.landscape, { box: [176, 456, 304, 54], size: [15, 12] }),
      },
    }),
  ],
});

export const HOSPITALITY: TemplateDef[] = [hospitalityRestaurantPromo, hospitalityCafeAtmosphere, hospitalityFoodShowcase, hospitalityEventAnnouncement, hospitalityPremiumDining];
