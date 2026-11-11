import { CANVAS as C, button, circle, defineTemplate, fill, img, logo, patch, pattern, poly, rect, text } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * events_event_promo: a TICKET. The brand color is the table, a paper ticket with two punched notches and a dotted perforation sits on it:
 * the photo above (or left of) the perforation, the stub below (right of) it carries eyebrow, headline, support, date, location and the
 * button. The logo is a small plate on the photo. Landscape and banner turn the ticket on its side.
 */
const eventsEventPromo = defineTemplate({
  id: 'events_event_promo',
  name: 'Event promo (ticket)',
  version: 1,
  status: 'active',
  category: 'events_entertainment',
  description: 'A paper ticket on the brand color: photo on one side of a dotted perforation, and a stub with headline, optional date and place, and a button on the other.',
  styles: ['dynamic_events', 'bold_startup', 'contemporary_geometric'],
  industries: ['events', 'event', 'festival', 'concert', 'music', 'conference', 'meetup', 'nightlife', 'entertainment', 'theatre', 'community'],
  channels: [],
  classes: ['square', 'portrait', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'split',
  composition: 'Brand-color table with a paper ticket: photo and stub divided by a dotted perforation with two notches, stacked in square and portrait and side by side in landscape/banner.',
  sample: {
    headline: 'Open-air music night on the square',
    support: 'Live bands, street food and good company until midnight.',
    cta: 'Get your ticket',
    eyebrow: 'Summer series',
    date: 'SAT 14 JUNE · 19:00',
    location: 'City Hall Square',
    brand: 'Lumen Events',
  },
  tone: 'brand',
  layers: [
    fill('table', 'primary'),
    rect('ticket', C.square.box(60, 60, 960, 960), {
      fill: 'paper',
      radius: 0.04,
      shadow: true,
      at: {
        portrait: patch(C.portrait, { box: [60, 60, 960, 1230] }),
        landscape: patch(C.landscape, { box: [40, 40, 1120, 548], radius: 0.05 }),
        banner: patch(C.banner, { box: [20, 16, 1160, 268], radius: 0.1 }),
      },
    }),
    img('photo', 'hero', C.square.box(96, 96, 888, 430), {
      mask: 'rounded',
      radius: 0.03,
      fallback: 'gradient',
      at: {
        portrait: patch(C.portrait, { box: [96, 96, 888, 640] }),
        landscape: patch(C.landscape, { box: [66, 66, 440, 496], radius: 0.04 }),
        banner: patch(C.banner, { box: [36, 32, 250, 236], radius: 0.08 }),
      },
    }),
    circle('notch-a', C.square.box(32, 562, 56, 56), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [32, 772, 56, 56] }),
        landscape: patch(C.landscape, { box: [518, 18, 44, 44] }),
        banner: patch(C.banner, { box: [300, -2, 36, 36] }),
      },
    }),
    circle('notch-b', C.square.box(992, 562, 56, 56), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [992, 772, 56, 56] }),
        landscape: patch(C.landscape, { box: [518, 566, 44, 44] }),
        banner: patch(C.banner, { box: [300, 266, 36, 36] }),
      },
    }),
    pattern('perforation', C.square.box(112, 582, 856, 16), 'dots', 'muted', 0.0165, {
      at: {
        portrait: patch(C.portrait, { box: [112, 792, 856, 16] }),
        landscape: patch(C.landscape, { box: [532, 78, 16, 472] }),
        banner: patch(C.banner, { box: [310, 28, 16, 244] }),
      },
    }),
    logo('logo', C.square.box(122, 120, 300, 58), {
      nameWeight: 800,
      nameColor: 'ink',
      plate: { fill: 'paper', padding: 0.01, radius: 0.5 },
      at: {
        portrait: patch(C.portrait, { box: [122, 120, 300, 58] }),
        landscape: patch(C.landscape, { box: [92, 90, 250, 44], plate: { fill: 'paper', padding: 0.009, radius: 0.5 } }),
        banner: patch(C.banner, { box: [346, 42, 300, 30], plate: { fill: 'paper', padding: 0.002, radius: 0 } }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(110, 634, 860, 24), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'muted',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [110, 844, 860, 24], size: 19 }),
        landscape: patch(C.landscape, { box: [588, 84, 520, 22], size: 14 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(110, 664, 860, 140), {
      size: C.square.size(64, 38),
      family: 'display',
      weight: 800,
      lh: 1.04,
      tracking: -0.01,
      color: 'ink',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [110, 876, 860, 190], size: [84, 44] }),
        landscape: patch(C.landscape, { box: [588, 112, 520, 170], size: [56, 28] }),
        banner: patch(C.banner, { box: [346, 80, 520, 100], size: [44, 24], maxLines: 2 }),
      },
    }),
    text('support', 'support', C.square.box(110, 812, 860, 60), {
      size: C.square.size(26, 19),
      weight: 400,
      lh: 1.35,
      color: 'ink',
      opacity: 0.82,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [110, 1074, 860, 66], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [588, 292, 520, 56], size: [20, 15] }),
      },
      hide: ['banner'],
    }),
    text('date', 'date', C.square.box(110, 896, 520, 36), {
      size: C.square.size(28, 20),
      weight: 800,
      upper: true,
      tracking: 0.04,
      color: 'ink',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [110, 1138, 520, 36], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [588, 380, 330, 30], size: [22, 15] }),
        banner: patch(C.banner, { box: [346, 196, 400, 30], size: [22, 15] }),
      },
    }),
    text('location', 'location', C.square.box(110, 936, 520, 32), {
      size: C.square.size(22, 16),
      weight: 500,
      color: 'muted',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [110, 1178, 520, 32], size: [22, 16] }),
        landscape: patch(C.landscape, { box: [588, 414, 330, 28], size: [18, 14] }),
        banner: patch(C.banner, { box: [346, 228, 400, 28], size: [20, 14] }),
      },
    }),
    button('cta', C.square.box(684, 894, 286, 74), {
      arrow: true,
      size: C.square.size(22, 16),
      at: {
        portrait: patch(C.portrait, { box: [684, 1136, 286, 74], size: [22, 16] }),
        landscape: patch(C.landscape, { box: [588, 488, 252, 54], size: [18, 14] }),
        banner: patch(C.banner, { box: [900, 104, 232, 64], size: [20, 14] }),
      },
    }),
  ],
});

/**
 * events_countdown: a CLOCK FACE. On ink, a big ring (with a small accent knob and faint concentric rings behind it) holds the DATE as the
 * hero, with an eyebrow above it and a tag ("12 days to go") below it. The headline, support and button are centered beneath the ring.
 * In stories the headline and support come first and the ring sits below them; landscape puts the ring on the left and a left-aligned text column on the right. Needs a date: it is the picture.
 */
const eventsCountdown = defineTemplate({
  id: 'events_countdown',
  name: 'Countdown (date in a ring)',
  version: 1,
  status: 'active',
  category: 'events_entertainment',
  description: 'A save-the-date countdown: the date is the hero inside a big ring on a dark field, with a tag such as days to go, then the headline and a button below.',
  styles: ['dynamic_events', 'minimalist_tech', 'contemporary_geometric'],
  industries: ['events', 'event', 'festival', 'concert', 'conference', 'webinar', 'launch', 'nightlife', 'community', 'entertainment'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['date'],
  density: 'balanced',
  family: 'centered',
  composition: 'Dark field with faint concentric rings; a bold ring (and accent knob) holds eyebrow, huge date and tag; headline, support and button centered below.',
  sample: {
    headline: 'The night market is back',
    support: 'Food, music and lights from sunset until midnight.',
    cta: 'Add to calendar',
    eyebrow: 'Save the date',
    date: 'SAT 14 JUNE',
    tag: '12 days to go',
    brand: 'City Nights',
  },
  tone: 'dark',
  layers: [
    fill('ink', 'ink'),
    // the rings are centered on the box, so each box is centered on its ring and large enough to cover the whole canvas
    pattern('echo', C.square.box(0, -200, 1080, 1280), 'rings', 'onInk', 0.075, {
      opacity: 0.12,
      at: {
        portrait: patch(C.portrait, { box: [0, -290, 1080, 1640] }),
        story: patch(C.story, { box: [0, 0, 1080, 2240] }),
        landscape: patch(C.landscape, { box: [-600, 0, 1800, 628] }),
      },
    }),
    circle('ring', C.square.box(240, 140, 600, 600), {
      stroke: { color: 'accent', width: 0.012 },
      at: {
        portrait: patch(C.portrait, { box: [190, 180, 700, 700] }),
        story: patch(C.story, { box: [110, 690, 860, 860] }),
        landscape: patch(C.landscape, { box: [65, 79, 470, 470] }),
      },
    }),
    circle('ring-inner', C.square.box(270, 170, 540, 540), {
      stroke: { color: 'onInk', width: 0.0016 },
      opacity: 0.45,
      at: {
        portrait: patch(C.portrait, { box: [225, 215, 630, 630] }),
        story: patch(C.story, { box: [155, 735, 770, 770] }),
        landscape: patch(C.landscape, { box: [95, 109, 410, 410] }),
      },
    }),
    circle('knob', C.square.box(711, 188, 44, 44), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [743, 240, 44, 44] }),
        story: patch(C.story, { box: [792, 767, 48, 48] }),
        landscape: patch(C.landscape, { box: [431, 114, 40, 40] }),
      },
    }),
    logo('logo', C.square.box(290, 76, 500, 36), {
      align: 'center',
      nameWeight: 800,
      nameColor: 'onInk',
      upper: true,
      tracking: 0.2,
      at: {
        portrait: patch(C.portrait, { box: [290, 104, 500, 40] }),
        story: patch(C.story, { box: [290, 290, 500, 44] }),
        landscape: patch(C.landscape, { box: [620, 84, 400, 34], align: 'left' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(290, 276, 500, 28), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.3,
      weight: 600,
      color: 'onInk',
      opacity: 0.8,
      align: 'center',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [290, 346, 500, 30], size: 20 }),
        story: patch(C.story, { box: [240, 926, 600, 34], size: 24 }),
        landscape: patch(C.landscape, { box: [125, 186, 350, 24], size: 14 }),
      },
    }),
    text('date', 'date', C.square.box(300, 320, 480, 240), {
      size: C.square.size(118, 56),
      family: 'display',
      weight: 800,
      upper: true,
      lh: 0.95,
      tracking: -0.01,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 3,
      optional: false,
      at: {
        portrait: patch(C.portrait, { box: [290, 410, 500, 240], size: [126, 60] }),
        story: patch(C.story, { box: [240, 990, 600, 260], size: [128, 70] }),
        landscape: patch(C.landscape, { box: [125, 224, 350, 180], size: [90, 36] }),
      },
    }),
    text('tag', 'tag', C.square.box(300, 572, 480, 36), {
      size: C.square.size(26, 18),
      upper: true,
      tracking: 0.12,
      weight: 700,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [290, 668, 500, 40], size: [28, 20] }),
        story: patch(C.story, { box: [240, 1264, 600, 44], size: [34, 22] }),
        landscape: patch(C.landscape, { box: [125, 410, 350, 28], size: [20, 14] }),
      },
    }),
    text('headline', 'headline', C.square.box(110, 764, 860, 108), {
      size: C.square.size(70, 34),
      family: 'display',
      weight: 800,
      lh: 1.04,
      tracking: -0.01,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [110, 910, 860, 130], size: [74, 38] }),
        story: patch(C.story, { box: [90, 372, 900, 220], size: [100, 46], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [620, 146, 508, 170], size: [64, 28], align: 'left', valign: 'top', maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(190, 882, 700, 56), {
      size: C.square.size(26, 18),
      weight: 400,
      lh: 1.35,
      color: 'onInk',
      opacity: 0.8,
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [170, 1050, 740, 64], size: [30, 19] }),
        story: patch(C.story, { box: [150, 602, 780, 76], size: [34, 24] }),
        landscape: patch(C.landscape, { box: [620, 330, 508, 70], size: [24, 15], align: 'left' }),
      },
    }),
    button('cta', C.square.box(390, 948, 300, 54), {
      stroke: { color: 'onInk', width: 0.003 },
      arrow: true,
      size: C.square.size(22, 16),
      at: {
        portrait: patch(C.portrait, { box: [390, 1150, 300, 66], size: [24, 17] }),
        story: patch(C.story, { box: [350, 1568, 380, 76], size: [28, 19] }),
        landscape: patch(C.landscape, { box: [620, 486, 250, 56], size: [18, 14] }),
      },
    }),
  ],
});

/**
 * events_headline_poster: a TYPE POSTER built from BANDS. An accent band across the top carries the logo and the date, a diagonal-stripe field
 * (the brand color on ink) holds one huge centered upper-case headline, a heavy rule closes it, and a footer row shows the place and the
 * button. A thin accent bar finishes the bottom edge. No picture needed; date, place, eyebrow and button are all optional.
 */
const eventsHeadlinePoster = defineTemplate({
  id: 'events_headline_poster',
  name: 'Headline poster (banded type)',
  version: 1,
  status: 'active',
  category: 'events_entertainment',
  description: 'A big-type event poster: accent header band with logo and date, one huge centered headline on a diagonal-stripe field, a heavy rule and a footer with place and button.',
  styles: ['dynamic_events', 'bold_startup', 'contemporary_geometric'],
  industries: ['events', 'event', 'festival', 'concert', 'music', 'nightlife', 'entertainment', 'conference', 'sports', 'theatre'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'band',
  composition: 'Dark poster in horizontal bands: accent header band, striped field with a huge centered headline, heavy rule, footer row and a thin accent bar.',
  sample: {
    headline: 'Three nights of live music',
    cta: 'Get tickets',
    eyebrow: 'Summer open-air series',
    date: 'JUN 12–14',
    location: 'City Park, Main Stage',
    brand: 'Open Air Co.',
  },
  tone: 'dark',
  layers: [
    fill('ink', 'ink'),
    pattern('stripes', C.square.box(0, 150, 1080, 700), 'stripes', 'primary', 0.055, {
      opacity: 0.2,
      at: {
        portrait: patch(C.portrait, { box: [0, 170, 1080, 920] }),
        story: patch(C.story, { box: [0, 350, 1080, 1180] }),
        banner: patch(C.banner, { box: [300, 0, 900, 300] }),
      },
    }),
    rect('band-top', C.square.box(0, 0, 1080, 150), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [0, 0, 1080, 170] }),
        story: patch(C.story, { box: [0, 0, 1080, 350] }),
        banner: patch(C.banner, { box: [0, 0, 300, 300] }),
      },
    }),
    rect('band-bottom', C.square.box(0, 1040, 1080, 40), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [0, 1306, 1080, 44] }),
        story: patch(C.story, { box: [0, 1860, 1080, 60] }),
      },
      hide: ['banner'],
    }),
    logo('logo', C.square.box(86, 82, 360, 52), {
      nameFamily: 'display',
      nameWeight: 800,
      nameColor: 'onAccent',
      upper: true,
      tracking: 0.08,
      at: {
        portrait: patch(C.portrait, { box: [86, 102, 360, 52] }),
        story: patch(C.story, { box: [86, 290, 400, 56] }),
        banner: patch(C.banner, { box: [48, 40, 220, 34] }),
      },
    }),
    text('date', 'date', C.square.box(574, 82, 420, 52), {
      size: C.square.size(34, 20),
      family: 'display',
      weight: 800,
      upper: true,
      tracking: 0.04,
      color: 'onAccent',
      align: 'right',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [574, 102, 420, 52], size: [34, 20] }),
        story: patch(C.story, { box: [534, 290, 460, 56], size: [38, 22] }),
        banner: patch(C.banner, { box: [48, 190, 220, 60], size: [38, 20], align: 'left', valign: 'bottom', maxLines: 2 }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 168, 908, 28), {
      size: C.square.size(21),
      upper: true,
      tracking: 0.3,
      weight: 600,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 196, 908, 30], size: 22 }),
        story: patch(C.story, { box: [86, 392, 908, 34], size: 26 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(86, 212, 908, 664), {
      size: C.square.size(172, 64),
      family: 'display',
      weight: 900,
      upper: true,
      lh: 0.92,
      tracking: -0.02,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 5,
      at: {
        portrait: patch(C.portrait, { box: [86, 242, 908, 860], size: [210, 64] }),
        story: patch(C.story, { box: [86, 440, 908, 1060], size: [230, 70], maxLines: 6 }),
        banner: patch(C.banner, { box: [330, 40, 560, 220], size: [80, 30], align: 'left', maxLines: 3 }),
      },
    }),
    rect('rule', C.square.box(86, 900, 908, 6), {
      fill: 'onInk',
      at: {
        portrait: patch(C.portrait, { box: [86, 1130, 908, 6] }),
        story: patch(C.story, { box: [86, 1528, 908, 8] }),
      },
      hide: ['banner'],
    }),
    text('location', 'location', C.square.box(86, 930, 580, 60), {
      size: C.square.size(30, 18),
      family: 'display',
      weight: 700,
      upper: true,
      tracking: 0.04,
      color: 'onInk',
      valign: 'middle',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [86, 1158, 580, 60], size: [30, 18] }),
        story: patch(C.story, { box: [86, 1566, 520, 76], size: [36, 20] }),
        banner: patch(C.banner, { box: [920, 196, 232, 56], size: [18, 12], maxLines: 2 }),
      },
    }),
    button('cta', C.square.box(704, 924, 290, 76), {
      stroke: { color: 'onInk', width: 0.003 },
      upper: true,
      tracking: 0.08,
      arrow: true,
      size: C.square.size(24, 16),
      at: {
        portrait: patch(C.portrait, { box: [704, 1152, 290, 80], size: [24, 16] }),
        story: patch(C.story, { box: [624, 1558, 370, 86], size: [28, 18] }),
        banner: patch(C.banner, { box: [920, 100, 232, 62], size: [20, 13] }),
      },
    }),
  ],
});

/**
 * events_entertainment: NIGHT-OUT ENERGY with tilted pieces. On ink, faint sound waves in the brand color; a tilted photo card with an accent
 * card tucked behind it; the date stacked big on the left; and a headline set on an accent sticker band that cuts across the canvas at
 * -4 degrees. Support and the button sit below the band. Landscape keeps the same pieces side by side.
 */
const eventsEntertainment = defineTemplate({
  id: 'events_entertainment',
  name: 'Entertainment (tilted night out)',
  version: 1,
  status: 'active',
  category: 'events_entertainment',
  description: 'A concert or night-out poster: sound-wave texture on ink, a tilted photo with an accent card behind it, the date stacked big, and the headline on a tilted accent band.',
  styles: ['dynamic_events', 'bold_startup', 'contemporary_geometric'],
  industries: ['concert', 'music', 'nightlife', 'entertainment', 'club', 'bar', 'show', 'theatre', 'festival', 'events', 'party'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'dense',
  family: 'diagonal',
  composition: 'Ink canvas with wave texture; tilted photo over a counter-tilted accent card; stacked date at the left; headline on an accent band rotated -4 degrees.',
  sample: {
    headline: 'One night. Four bands.',
    support: 'Doors open at nine. Tickets at the door or online.',
    cta: 'Book now',
    eyebrow: 'Live in concert',
    date: 'FRI 20 JUNE',
    location: 'Riverside Club, 21:00',
    brand: 'Night Shift',
  },
  tone: 'dark',
  layers: [
    fill('ink', 'ink'),
    pattern('waves', C.square.box(0, 0, 1080, 1080), 'waves', 'primary', 0.05, { opacity: 0.3 }),
    rect('card-back', C.square.box(460, 120, 500, 500), {
      fill: 'accent',
      radius: 0.03,
      rotate: -6,
      at: {
        portrait: patch(C.portrait, { box: [440, 160, 540, 640] }),
        story: patch(C.story, { box: [460, 350, 500, 580] }),
        landscape: patch(C.landscape, { box: [746, 88, 340, 420], rotate: -6 }),
      },
    }),
    img('photo', 'hero', C.square.box(490, 96, 500, 500), {
      mask: 'rounded',
      radius: 0.03,
      rotate: 4,
      border: { color: 'paper', width: 0.008 },
      shadow: true,
      fallback: 'gradient',
      at: {
        portrait: patch(C.portrait, { box: [470, 140, 540, 640] }),
        story: patch(C.story, { box: [490, 330, 500, 580] }),
        landscape: patch(C.landscape, { box: [780, 70, 340, 420] }),
      },
    }),
    rect('band', C.square.box(-60, 632, 1200, 206), {
      fill: 'accent',
      rotate: -4,
      at: {
        portrait: patch(C.portrait, { box: [-60, 850, 1200, 214] }),
        story: patch(C.story, { box: [-60, 1090, 1200, 240] }),
        landscape: patch(C.landscape, { box: [-60, 300, 760, 170], rotate: -4 }),
      },
    }),
    logo('logo', C.square.box(86, 80, 340, 44), {
      nameFamily: 'display',
      nameWeight: 800,
      nameColor: 'onInk',
      upper: true,
      tracking: 0.12,
      at: {
        portrait: patch(C.portrait, { box: [86, 104, 330, 44] }),
        story: patch(C.story, { box: [86, 286, 360, 48] }),
        landscape: patch(C.landscape, { box: [72, 66, 320, 36] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 146, 340, 26), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.2,
      weight: 600,
      color: 'onInk',
      opacity: 0.85,
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 170, 330, 28], size: 20 }),
        story: patch(C.story, { box: [86, 346, 340, 30], size: 22 }),
        landscape: patch(C.landscape, { box: [72, 112, 500, 22], size: 14 }),
      },
    }),
    text('date', 'date', C.square.box(86, 186, 340, 160), {
      size: C.square.size(80, 40),
      family: 'display',
      weight: 800,
      upper: true,
      lh: 0.96,
      tracking: -0.01,
      color: 'onInk',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 214, 330, 240], size: [108, 44] }),
        story: patch(C.story, { box: [86, 400, 340, 330], size: [112, 50] }),
        landscape: patch(C.landscape, { box: [72, 148, 560, 70], size: [70, 26], maxLines: 1 }),
      },
    }),
    text('location', 'location', C.square.box(86, 352, 340, 72), {
      size: C.square.size(24, 17),
      weight: 600,
      color: 'onInk',
      opacity: 0.9,
      lines: 2,
      lh: 1.25,
      at: {
        portrait: patch(C.portrait, { box: [86, 466, 330, 80], size: [26, 18] }),
        story: patch(C.story, { box: [86, 748, 340, 100], size: [30, 20] }),
        landscape: patch(C.landscape, { box: [72, 222, 560, 34], size: [24, 16], maxLines: 1 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 650, 908, 170), {
      size: C.square.size(88, 34),
      family: 'display',
      weight: 900,
      upper: true,
      lh: 0.94,
      tracking: -0.015,
      color: 'onAccent',
      align: 'center',
      valign: 'middle',
      rotate: -4,
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 866, 908, 182], size: [92, 36] }),
        story: patch(C.story, { box: [86, 1106, 908, 208], size: [106, 42] }),
        landscape: patch(C.landscape, { box: [72, 318, 600, 134], size: [68, 26], rotate: -4, maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(86, 906, 580, 74), {
      size: C.square.size(25, 18),
      weight: 400,
      lh: 1.35,
      color: 'onInk',
      opacity: 0.9,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [86, 1134, 580, 80], size: [26, 19] }),
        story: patch(C.story, { box: [86, 1386, 700, 100], size: [32, 22], maxLines: 3 }),
      },
      hide: ['landscape'],
    }),
    button('cta', C.square.box(704, 896, 290, 76), {
      stroke: { color: 'onInk', width: 0.003 },
      upper: true,
      tracking: 0.08,
      arrow: true,
      size: C.square.size(24, 16),
      at: {
        portrait: patch(C.portrait, { box: [704, 1126, 290, 80], size: [24, 16] }),
        story: patch(C.story, { box: [86, 1504, 380, 88], size: [28, 18] }),
        landscape: patch(C.landscape, { box: [72, 502, 250, 56], size: [19, 14] }),
      },
    }),
  ],
});

/** Nine bunting pennants hanging from the top edge (a zig-zag garland), cycling through the brand colors. `h` = pennant height in px per class. */
const BUNTING_COLORS = ['primary', 'accent', 'secondary'] as const;
const buntingPennants = (h: { square: number; portrait: number; story: number; landscape: number }) =>
  Array.from({ length: 9 }, (_, i) => {
    const pts = (c: 'square' | 'portrait' | 'story' | 'landscape') => {
      const w = C[c].width / 9;
      return [C[c].pt(i * w, 0), C[c].pt((i + 1) * w, 0), C[c].pt((i + 0.5) * w, h[c])];
    };
    return poly(`flag-${i + 1}`, pts('square'), {
      fill: BUNTING_COLORS[i % 3],
      at: { portrait: { points: pts('portrait') }, story: { points: pts('story') }, landscape: { points: pts('landscape') } },
    });
  });

/**
 * events_community: FRIENDLY AND LOCAL. A warm paper canvas with a bunting garland along the top, a left column of plain, generous
 * type (logo, eyebrow, big rounded headline, support, date, place, button) and a cluster of overlapping circles on the right around a
 * circular photo. Story and portrait stack the same pieces; landscape keeps two columns. No picture is needed (a brand pattern fills the circle).
 */
const eventsCommunity = defineTemplate({
  id: 'events_community',
  name: 'Community event (bunting and circles)',
  version: 1,
  status: 'active',
  category: 'events_entertainment',
  description: 'A warm, welcoming local-event design: bunting along the top, big friendly type, and a round photo surrounded by overlapping brand-color circles.',
  styles: ['soft_lifestyle', 'dynamic_events', 'lifestyle_photography'],
  industries: ['community', 'nonprofit', 'charity', 'volunteer', 'neighborhood', 'local', 'school', 'library', 'market', 'family', 'festival', 'events'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'collage',
  composition: 'Paper canvas with a zig-zag bunting garland; friendly left-aligned text column; circular photo with overlapping brand-color circles beside or below it.',
  sample: {
    headline: 'Neighbours day in the park',
    support: 'Games, food stalls and live music for the whole family. Everyone is welcome.',
    cta: 'Join us',
    eyebrow: 'Free community event',
    date: 'SUN 22 JUNE · 11:00',
    location: 'Linden Park',
    brand: 'Maple Street Together',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    ...buntingPennants({ square: 100, portrait: 108, story: 140, landscape: 60 }),
    circle('dot-a', C.square.box(890, 236, 160, 160), {
      fill: 'accent',
      at: {
        portrait: patch(C.portrait, { box: [890, 520, 160, 160] }),
        story: patch(C.story, { box: [770, 760, 190, 190] }),
        landscape: patch(C.landscape, { box: [1030, 80, 110, 110] }),
      },
    }),
    circle('halo', C.square.box(575, 365, 450, 450), {
      fill: 'primary',
      at: {
        portrait: patch(C.portrait, { box: [500, 580, 520, 520] }),
        story: patch(C.story, { box: [260, 810, 560, 560] }),
        landscape: patch(C.landscape, { box: [660, 90, 440, 440] }),
      },
    }),
    img('photo', 'hero', C.square.box(615, 405, 390, 390), {
      mask: 'circle',
      fallback: 'brandPattern',
      border: { color: 'paper', width: 0.01 },
      at: {
        portrait: patch(C.portrait, { box: [540, 620, 440, 440] }),
        story: patch(C.story, { box: [300, 850, 480, 480] }),
        landscape: patch(C.landscape, { box: [700, 130, 380, 380] }),
      },
    }),
    circle('dot-b', C.square.box(556, 720, 190, 190), {
      fill: 'secondary',
      at: {
        portrait: patch(C.portrait, { box: [420, 990, 200, 200] }),
        story: patch(C.story, { box: [150, 1130, 230, 230] }),
        landscape: patch(C.landscape, { box: [640, 400, 140, 140] }),
      },
    }),
    pattern('dots', C.square.box(860, 810, 147, 184), 'dots', 'accent', 0.034, {
      at: {
        portrait: { box: C.portrait.box(860, 1110, 147, 110) },
        story: { box: C.story.box(820, 1220, 147, 147) },
        landscape: { box: C.landscape.box(1040, 380, 113, 113), size: 0.06 },
      },
    }),
    logo('logo', C.square.box(86, 150, 420, 42), {
      nameWeight: 800,
      nameColor: 'ink',
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [86, 150, 420, 44] }),
        story: patch(C.story, { box: [86, 290, 440, 48] }),
        landscape: patch(C.landscape, { box: [72, 84, 360, 34] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 222, 470, 26), {
      size: C.square.size(19),
      upper: true,
      tracking: 0.14,
      weight: 700,
      color: 'muted',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 222, 700, 26], size: 20 }),
        story: patch(C.story, { box: [86, 354, 700, 30], size: 24 }),
        landscape: patch(C.landscape, { box: [72, 130, 540, 22], size: 14 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 258, 480, 350), {
      size: C.square.size(86, 38),
      weight: 800,
      lh: 1.04,
      tracking: -0.02,
      color: 'ink',
      lines: 5,
      at: {
        portrait: patch(C.portrait, { box: [86, 258, 908, 300], size: [120, 46], maxLines: 4 }),
        story: patch(C.story, { box: [86, 398, 908, 380], size: [126, 56], maxLines: 4 }),
        landscape: patch(C.landscape, { box: [72, 160, 560, 170], size: [74, 28], maxLines: 4 }),
      },
    }),
    text('support', 'support', C.square.box(86, 628, 470, 112), {
      size: C.square.size(26, 18),
      weight: 400,
      lh: 1.38,
      color: 'ink',
      opacity: 0.85,
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 590, 380, 230], size: [30, 20], maxLines: 7 }),
        story: patch(C.story, { box: [86, 1400, 908, 84], size: [30, 22], maxLines: 2 }),
        landscape: patch(C.landscape, { box: [72, 338, 540, 62], size: [20, 14], maxLines: 3 }),
      },
    }),
    text('date', 'date', C.square.box(86, 760, 470, 40), {
      size: C.square.size(28, 20),
      weight: 800,
      color: 'ink',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 860, 400, 44], size: [28, 20] }),
        story: patch(C.story, { box: [86, 1520, 520, 44], size: [32, 22] }),
        landscape: patch(C.landscape, { box: [72, 412, 330, 30], size: [22, 15] }),
      },
    }),
    text('location', 'location', C.square.box(86, 802, 470, 36), {
      size: C.square.size(25, 18),
      weight: 600,
      color: 'muted',
      valign: 'middle',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 906, 400, 38], size: [25, 18] }),
        story: patch(C.story, { box: [86, 1566, 520, 40], size: [28, 20] }),
        landscape: patch(C.landscape, { box: [72, 444, 330, 28], size: [20, 14] }),
      },
    }),
    button('cta', C.square.box(86, 880, 300, 76), {
      arrow: true,
      size: C.square.size(25, 17),
      at: {
        portrait: patch(C.portrait, { box: [86, 1140, 320, 80], size: [26, 17] }),
        story: patch(C.story, { box: [634, 1530, 360, 84], size: [30, 20] }),
        landscape: patch(C.landscape, { box: [380, 424, 232, 56], size: [19, 14] }),
      },
    }),
  ],
});

export const EVENTS_ENTERTAINMENT: TemplateDef[] = [eventsEventPromo, eventsCountdown, eventsHeadlinePoster, eventsEntertainment, eventsCommunity];
