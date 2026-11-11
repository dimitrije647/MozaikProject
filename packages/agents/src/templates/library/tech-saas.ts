import { CANVAS as C, button, circle, defineTemplate, fill, grad, img, line, logo, pattern, patch, poly, rect, text, type CanvasHelper } from '../dsl';
import type { TemplateDef } from '../schema';

/**
 * tech_product_launch: a FULL-BLEED PHOTO with a bottom scrim. The picture carries the mood; a dark gradient rises from the bottom edge
 * and holds a left-aligned stack: accent bar, eyebrow, headline, support, pill button. The logo sits top-left on a light top scrim.
 * Square / portrait / story stack the text at the bottom; landscape turns the scrim sideways and keeps the text in the left column.
 */
const techProductLaunch = defineTemplate({
  id: 'tech_product_launch',
  name: 'Product launch (full-bleed photo)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A full-bleed photo with a dark gradient rising from the bottom and a left-aligned launch message: eyebrow, bold headline, support line and a pill button.',
  styles: ['minimalist_tech', 'bold_startup'],
  industries: ['saas', 'software', 'technology', 'ai', 'app', 'startup', 'fintech'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['image'],
  density: 'balanced',
  family: 'full-bleed',
  composition: 'Full-bleed hero photo, bottom scrim, left-aligned text stack with an accent bar and a pill button.',
  sample: {
    headline: 'Ship your product in half the time',
    support: 'One workspace for planning, building and launching.',
    cta: 'Start free trial',
    eyebrow: 'New release',
    brand: 'Northwind',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    img('photo', 'hero', [0, 0, 1, 1], { focus: [0.5, 0.45] }),
    // readability: a long soft gradient from the bottom edge, plus a lighter one under the logo
    rect('scrim-bottom', C.square.box(0, 260, 1080, 820), {
      fill: grad(90, [0, 'ink', 0], [0.3, 'ink', 0.55], [0.58, 'ink', 0.86], [1, 'ink', 0.95]),
      at: {
        portrait: patch(C.portrait, { box: [0, 500, 1080, 850] }),
        story: patch(C.story, { box: [0, 700, 1080, 1220] }),
        landscape: patch(C.landscape, { box: [0, 0, 936, 628], fill: grad(0, [0, 'ink', 0.94], [0.55, 'ink', 0.72], [1, 'ink', 0]) }),
      },
    }),
    rect('scrim-top', C.square.box(0, 0, 1080, 230), {
      fill: grad(90, [0, 'ink', 0.78], [0.6, 'ink', 0.62], [1, 'ink', 0]),
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 250] }), story: patch(C.story, { box: [0, 0, 1080, 560] }) },
      hide: ['landscape'],
    }),
    logo('logo', C.square.box(86, 80, 340, 56), {
      nameColor: 'onInk',
      nameWeight: 700,
      tracking: -0.01,
      at: { portrait: patch(C.portrait, { box: [86, 100, 340, 56] }), story: patch(C.story, { box: [86, 285, 360, 60] }), landscape: patch(C.landscape, { box: [72, 66, 320, 44] }) },
    }),
    rect('accent-bar', C.square.box(86, 478, 72, 7), {
      fill: 'accent',
      radius: 0.5,
      at: { portrait: patch(C.portrait, { box: [86, 740, 72, 7] }), story: patch(C.story, { box: [86, 1020, 72, 8] }), landscape: patch(C.landscape, { box: [72, 172, 56, 6] }) },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 496, 907, 34), {
      size: C.square.size(24),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'onInk',
      opacity: 0.9,
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 758, 907, 34], size: 24 }),
        story: patch(C.story, { box: [86, 1040, 907, 38], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 188, 640, 26], size: 17 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 540, 907, 270), {
      size: C.square.size(95, 56),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'onInk',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [86, 802, 907, 250], size: [100, 58] }),
        story: patch(C.story, { box: [86, 1090, 907, 350], size: [108, 64] }),
        landscape: patch(C.landscape, { box: [72, 222, 640, 190], size: [54, 34] }),
      },
    }),
    text('support', 'support', C.square.box(86, 822, 907, 86), {
      size: C.square.size(32, 24),
      valign: 'bottom',
      weight: 400,
      color: 'onInk',
      opacity: 0.88,
      lines: 2,
      lh: 1.3,
      at: {
        portrait: patch(C.portrait, { box: [86, 1062, 907, 90], size: [33, 24] }),
        story: patch(C.story, { box: [86, 1452, 907, 100], size: [36, 28] }),
        landscape: patch(C.landscape, { box: [72, 420, 560, 62], size: [21, 17] }),
      },
    }),
    button('cta', C.square.box(86, 922, 400, 70), {
      arrow: true,
      size: C.square.size(30, 22),
      at: {
        portrait: patch(C.portrait, { box: [86, 1170, 420, 70], size: [30, 22] }),
        story: patch(C.story, { box: [86, 1566, 470, 76], size: [33, 24] }),
        landscape: patch(C.landscape, { box: [72, 498, 300, 58], size: [20, 15] }),
      },
    }),
  ],
});

type Spot = [number, number, number];

/** A small floating "UI chip" (a check badge and two skeleton bars) written in pixels of one class: the cue that this is a FEATURE callout. */
function featureChip(spot: { square: Spot; portrait: Spot; story: Spot; landscape: Spot }) {
  const geo = (c: CanvasHelper, [x, y, h]: Spot) => {
    const w = Math.round(h * 3.1);
    const pad = h * 0.2;
    const d = h - pad * 2;
    const x0 = x + pad + d + pad * 0.9;
    const barW = x + w - pad - x0;
    const tick = ([[0.22, 0.52], [0.31, 0.43], [0.44, 0.56], [0.69, 0.3], [0.78, 0.39], [0.44, 0.74]] as Array<[number, number]>).map(([u, v]) => c.pt(x + pad + u * d, y + pad + v * d));
    return {
      card: c.box(x, y, w, h),
      disc: c.box(x + pad, y + pad, d, d),
      tick,
      bar1: c.box(x0, y + h * 0.3, barW, h * 0.13),
      bar2: c.box(x0, y + h * 0.56, barW * 0.62, h * 0.13),
    };
  };
  const g = { square: geo(C.square, spot.square), portrait: geo(C.portrait, spot.portrait), story: geo(C.story, spot.story), landscape: geo(C.landscape, spot.landscape) };
  const at = (k: 'card' | 'disc' | 'bar1' | 'bar2') => ({ portrait: { box: g.portrait[k] }, story: { box: g.story[k] }, landscape: { box: g.landscape[k] } });
  return [
    rect('chip', g.square.card, { fill: 'paper', radius: 0.3, shadow: true, at: at('card') }),
    circle('chip-disc', g.square.disc, { fill: 'accent', at: at('disc') }),
    poly('chip-tick', g.square.tick, { fill: 'onAccent', at: { portrait: { points: g.portrait.tick }, story: { points: g.story.tick }, landscape: { points: g.landscape.tick } } }),
    rect('chip-bar1', g.square.bar1, { fill: 'ink', radius: 0.5, opacity: 0.72, at: at('bar1') }),
    rect('chip-bar2', g.square.bar2, { fill: 'ink', radius: 0.5, opacity: 0.22, at: at('bar2') }),
  ];
}

/** The three dots of an application window's title bar: (x, y, bar) = the window's top-left corner and the title bar height, in pixels of one class. */
function windowDots(spot: { square: Spot; portrait: Spot; story: Spot; landscape: Spot }) {
  const geo = (c: CanvasHelper, [x, y, bar]: Spot) => [0, 1, 2].map((i) => c.box(x + bar * 0.62 + i * bar * 0.5, y + bar * 0.5 - bar * 0.15, bar * 0.3, bar * 0.3));
  const g = { square: geo(C.square, spot.square), portrait: geo(C.portrait, spot.portrait), story: geo(C.story, spot.story), landscape: geo(C.landscape, spot.landscape) };
  return [0, 1, 2].map((i) =>
    circle(`dot-${i + 1}`, g.square[i], {
      fill: i === 0 ? 'accent' : 'ink',
      opacity: i === 0 ? 1 : 0.2,
      at: { portrait: { box: g.portrait[i] }, story: { box: g.story[i] }, landscape: { box: g.landscape[i] } },
    }),
  );
}

/**
 * tech_feature_highlight: a PRODUCT WINDOW peeking up from the bottom edge. The canvas is the brand color with a soft shade towards the
 * bottom; the message sits on it (brand name, label, headline, then explanation and button in one row) and an application window (title
 * bar with three dots, the picture or screenshot below it) rises from the bottom edge with a floating check chip over its corner.
 * Landscape puts the text on the left and lets the window bleed off the right and bottom edges.
 */
const techFeatureHighlight = defineTemplate({
  id: 'tech_feature_highlight',
  name: 'Feature highlight (product window)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'The message on the brand color with an app window that rises from the bottom edge: a screenshot or photo under a title bar and a floating check chip.',
  styles: ['minimalist_tech', 'bold_startup', 'contemporary_geometric'],
  industries: ['saas', 'software', 'technology', 'app', 'platform', 'startup', 'b2b', 'ai'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'balanced',
  family: 'inset-card',
  composition: 'Brand-colored canvas with the headline on top and an app window (title bar, screenshot, floating chip) rising from the bottom edge; window bleeds off the right in landscape.',
  sample: {
    headline: 'Plan every release in one view',
    support: 'See owners, dates and blockers on a single shared timeline.',
    cta: 'Try it free',
    eyebrow: 'New feature',
    brand: 'Northwind',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    rect('shade', C.square.box(0, 0, 1080, 1080), { fill: grad(90, [0, 'ink', 0], [0.45, 'ink', 0], [1, 'ink', 0.26]) }),
    rect('window', C.square.box(96, 586, 888, 640), {
      fill: 'paper',
      radius: 0.045,
      shadow: true,
      at: {
        portrait: patch(C.portrait, { box: [96, 664, 888, 760] }),
        story: patch(C.story, { box: [96, 1060, 888, 1000] }),
        landscape: patch(C.landscape, { box: [604, 96, 700, 640], radius: 0.05 }),
      },
    }),
    img('photo', 'hero', C.square.box(96, 640, 888, 540), {
      fallback: 'brandPattern',
      at: {
        portrait: patch(C.portrait, { box: [96, 722, 888, 700] }),
        story: patch(C.story, { box: [96, 1124, 888, 940] }),
        landscape: patch(C.landscape, { box: [604, 144, 700, 560] }),
      },
    }),
    ...windowDots({ square: [96, 586, 54], portrait: [96, 664, 58], story: [96, 1060, 64], landscape: [604, 96, 48] }),
    ...featureChip({ square: [52, 880, 88], portrait: [52, 1060, 96], story: [52, 1500, 108], landscape: [556, 470, 72] }),
    logo('logo', C.square.box(86, 80, 280, 44), {
      nameColor: 'onPrimary',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [86, 100, 280, 44] }),
        story: patch(C.story, { box: [86, 290, 320, 56] }),
        landscape: patch(C.landscape, { box: [72, 66, 240, 38] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 164, 700, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'onPrimary',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 188, 700, 28], size: 22 }),
        story: patch(C.story, { box: [86, 394, 700, 34], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 130, 480, 24], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 198, 908, 240), {
      size: C.square.size(94, 48),
      weight: 800,
      lh: 1.03,
      tracking: -0.02,
      color: 'onPrimary',
      lines: 3,
      at: {
        portrait: patch(C.portrait, { box: [86, 224, 908, 280], size: [104, 52] }),
        story: patch(C.story, { box: [86, 440, 908, 330], size: [100, 58], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 164, 500, 220], size: [58, 30], maxLines: 5 }),
      },
    }),
    text('support', 'support', C.square.box(86, 452, 560, 74), {
      size: C.square.size(27, 20),
      weight: 400,
      lh: 1.32,
      color: 'onPrimary',
      lines: 2,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 530, 560, 80], size: [28, 20] }),
        story: patch(C.story, { box: [86, 790, 908, 100], size: [36, 26], valign: 'top' }),
        landscape: patch(C.landscape, { box: [72, 394, 480, 60], size: [20, 15], valign: 'top' }),
      },
    }),
    button('cta', C.square.box(694, 452, 290, 72), {
      size: C.square.size(30, 22),
      arrow: true,
      at: {
        portrait: patch(C.portrait, { box: [694, 530, 290, 72], size: [30, 22] }),
        story: patch(C.story, { box: [86, 920, 400, 88], size: [34, 24] }),
        landscape: patch(C.landscape, { box: [72, 476, 260, 56], size: [20, 15] }),
      },
    }),
  ],
});

type PxBox = [number, number, number, number];
/** 'col' cards are tall (disc on top, bars below) and sit side by side; 'row' cards are wide (disc left, bars right) and are stacked. */
interface FlowGeo {
  kind: 'col' | 'row';
  cards: PxBox[];
}

const across = (x: number, y: number, w: number, h: number, gap: number): PxBox[] => [0, 1, 2].map((i) => [x + i * (w + gap), y, w, h]);
const stacked = (x: number, y: number, w: number, h: number, gap: number): PxBox[] => [0, 1, 2].map((i) => [x, y + i * (h + gap), w, h]);

/** A 3-step flow diagram (three skeleton "step cards" joined by arrows), written in pixels of each class. Pure geometry: no text. */
function workflowFlow(spec: { square: FlowGeo; story: FlowGeo; landscape: FlowGeo; banner: FlowGeo }) {
  const geo = (c: CanvasHelper, g: FlowGeo) => {
    const cards = g.cards.map(([x, y, w, h]) => {
      if (g.kind === 'col') {
        const pad = Math.round(h * 0.11);
        const d = Math.round(h * 0.27);
        const bh = Math.max(9, Math.round(h * 0.065));
        const iw = w - pad * 2;
        return {
          card: c.box(x, y, w, h),
          disc: c.box(x + pad, y + pad, d, d),
          bar1: c.box(x + pad, y + h - pad - bh * 2.9, iw, bh),
          bar2: c.box(x + pad, y + h - pad - bh, iw * 0.6, bh),
        };
      }
      const pad = Math.round(h * 0.22);
      const d = h - pad * 2;
      const x0 = x + pad + d + pad;
      const bw = x + w - pad - x0;
      const bh = Math.max(9, Math.round(h * 0.12));
      return {
        card: c.box(x, y, w, h),
        disc: c.box(x + pad, y + pad, d, d),
        bar1: c.box(x0, y + h / 2 - bh * 1.35, bw, bh),
        bar2: c.box(x0, y + h / 2 + bh * 0.35, bw * 0.6, bh),
      };
    });
    const links = [0, 1].map((j) => {
      const [x, y, w, h] = g.cards[j];
      const [nx, ny] = g.cards[j + 1];
      const hl = Math.max(11, Math.round(Math.min(w, h) * 0.07));
      const hw = Math.round(hl * 0.7);
      if (g.kind === 'col') {
        const cy = y + h / 2;
        const x1 = x + w + 9;
        const x2 = nx - 9;
        return { from: c.pt(x1, cy), to: c.pt(x2 - hl + 2, cy), head: [c.pt(x2, cy), c.pt(x2 - hl, cy - hw), c.pt(x2 - hl, cy + hw)] };
      }
      const pad = Math.round(h * 0.22);
      const cx = x + pad + (h - pad * 2) / 2;
      const y1 = y + h + 8;
      const y2 = ny - 8;
      return { from: c.pt(cx, y1), to: c.pt(cx, y2 - hl + 2), head: [c.pt(cx, y2), c.pt(cx - hw, y2 - hl), c.pt(cx + hw, y2 - hl)] };
    });
    return { cards, links };
  };
  const g = { square: geo(C.square, spec.square), story: geo(C.story, spec.story), landscape: geo(C.landscape, spec.landscape), banner: geo(C.banner, spec.banner) };
  const out = [];
  for (let i = 0; i < 3; i++) {
    const last = i === 2;
    const k = (cls: keyof typeof g, part: 'card' | 'disc' | 'bar1' | 'bar2') => ({ box: g[cls].cards[i][part] });
    const at = (part: 'card' | 'disc' | 'bar1' | 'bar2') => ({ story: k('story', part), landscape: k('landscape', part), banner: k('banner', part) });
    const n = i + 1;
    out.push(
      rect(`step-${n}`, g.square.cards[i].card, { fill: last ? 'accent' : 'onInk', opacity: last ? 1 : 0.09, radius: 0.14, at: at('card') }),
      circle(`step-${n}-dot`, g.square.cards[i].disc, { fill: last ? 'onAccent' : 'accent', at: at('disc') }),
      rect(`step-${n}-bar1`, g.square.cards[i].bar1, { fill: last ? 'onAccent' : 'onInk', radius: 0.5, opacity: last ? 0.8 : 0.5, at: at('bar1') }),
      rect(`step-${n}-bar2`, g.square.cards[i].bar2, { fill: last ? 'onAccent' : 'onInk', radius: 0.5, opacity: last ? 0.4 : 0.22, at: at('bar2') }),
    );
  }
  for (let j = 0; j < 2; j++) {
    const n = j + 1;
    const lk = (cls: keyof typeof g) => ({ from: g[cls].links[j].from, to: g[cls].links[j].to });
    out.push(
      line(`link-${n}`, g.square.links[j].from, g.square.links[j].to, { color: 'onInk', width: 0.0035 }, { opacity: 0.55, at: { story: lk('story'), landscape: lk('landscape'), banner: lk('banner') } }),
      poly(`link-${n}-head`, g.square.links[j].head, { fill: 'onInk', opacity: 0.55, at: { story: { points: g.story.links[j].head }, landscape: { points: g.landscape.links[j].head }, banner: { points: g.banner.links[j].head } } }),
    );
  }
  return out;
}

/**
 * tech_workflow_steps: a PANEL on ink with a drawn 3-step PROCESS DIAGRAM. Three skeleton step cards (a dot and two bars each) are joined
 * by arrows and the last one is filled with the accent: "step, step, result". The headline, support and button sit above (or beside) the
 * diagram. Square runs the cards across, story and landscape stack them with a timeline of arrows, banner shrinks them into a strip.
 */
const techWorkflowSteps = defineTemplate({
  id: 'tech_workflow_steps',
  name: 'Workflow steps (process diagram)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A dark panel with a clean three-step flow diagram that ends in an accent card, plus a bold headline, short explanation and button. Explains how it works without a picture.',
  styles: ['minimalist_tech', 'bold_startup', 'modern_corporate'],
  industries: ['saas', 'software', 'technology', 'automation', 'ai', 'startup', 'b2b', 'platform', 'consulting'],
  channels: [],
  classes: ['square', 'story', 'landscape', 'banner'],
  requires: [],
  density: 'balanced',
  family: 'panel',
  composition: 'Ink panel: text block on top, a three-step card diagram joined by arrows below (stacked beside the text in landscape, a strip in banner).',
  sample: {
    headline: 'From idea to launch in three steps',
    support: 'Connect your tools, set the rules once and let the workflow run itself.',
    cta: 'See how it works',
    eyebrow: 'How it works',
    brand: 'Northwind',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    pattern('grid', C.square.box(0, 0, 1080, 1080), 'grid', 'onInk', 0.06, { opacity: 0.06 }),
    rect('wash', C.square.box(0, 0, 1080, 1080), {
      fill: grad(40, [0, 'primary', 0], [0.55, 'primary', 0], [1, 'primary', 0.38]),
    }),
    logo('logo', C.square.box(86, 84, 300, 46), {
      nameColor: 'onInk',
      nameWeight: 700,
      tracking: -0.01,
      at: { story: patch(C.story, { box: [86, 290, 320, 56] }), landscape: patch(C.landscape, { box: [72, 66, 260, 38] }), banner: patch(C.banner, { box: [48, 36, 240, 28] }) },
    }),
    ...workflowFlow({
      square: { kind: 'col', cards: across(86, 606, 268, 232, 52) },
      story: { kind: 'row', cards: stacked(86, 944, 908, 150, 54) },
      landscape: { kind: 'row', cards: stacked(660, 78, 468, 124, 56) },
      banner: { kind: 'col', cards: across(692, 74, 124, 152, 44) },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 160, 908, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'onInk',
      opacity: 0.72,
      lines: 1,
      at: {
        story: patch(C.story, { box: [86, 392, 908, 34], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 126, 540, 24], size: 16 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(86, 198, 908, 250), {
      size: C.square.size(92, 50),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'onInk',
      lines: 3,
      at: {
        story: patch(C.story, { box: [86, 440, 908, 330], size: [104, 58], maxLines: 4 }),
        landscape: patch(C.landscape, { box: [72, 160, 540, 200], size: [50, 30], maxLines: 5 }),
        banner: patch(C.banner, { box: [48, 76, 580, 116], size: [42, 24], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(86, 452, 800, 80), {
      size: C.square.size(28, 22),
      weight: 400,
      lh: 1.34,
      color: 'onInk',
      opacity: 0.82,
      lines: 2,
      at: {
        story: patch(C.story, { box: [86, 792, 908, 110], size: [34, 26], maxLines: 2 }),
        landscape: patch(C.landscape, { box: [72, 374, 540, 60], size: [20, 16], maxLines: 3 }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(86, 900, 400, 72), {
      arrow: true,
      size: C.square.size(30, 22),
      at: {
        story: patch(C.story, { box: [86, 1546, 440, 88], size: [34, 24] }),
        landscape: patch(C.landscape, { box: [72, 468, 270, 56], size: [20, 15] }),
        banner: patch(C.banner, { box: [48, 204, 270, 52], size: [20, 15] }),
      },
    }),
  ],
});

type At3 = [number, number, number];

/** A geometric opening quotation mark (two balls with a rising stem), drawn from shapes. `d` is the ball diameter in pixels of that class. */
function quoteMark(spot: { square: At3; portrait: At3; story: At3; landscape: At3 }) {
  const geo = (c: CanvasHelper, [x, y, d]: At3) => {
    const one = (ox: number) => ({
      ball: c.box(ox, y + d * 0.62, d, d),
      stem: [c.pt(ox + d * 0.5, y + d * 1.05), c.pt(ox, y + d * 1.0), c.pt(ox, y + d * 0.3), c.pt(ox + d * 0.7, y - d * 0.06)] as Array<[number, number]>,
    });
    return [one(x), one(x + d * 1.5)];
  };
  const g = { square: geo(C.square, spot.square), portrait: geo(C.portrait, spot.portrait), story: geo(C.story, spot.story), landscape: geo(C.landscape, spot.landscape) };
  const out = [];
  for (let i = 0; i < 2; i++) {
    out.push(
      circle(`mark-ball-${i + 1}`, g.square[i].ball, { fill: 'primary', at: { portrait: { box: g.portrait[i].ball }, story: { box: g.story[i].ball }, landscape: { box: g.landscape[i].ball } } }),
      poly(`mark-stem-${i + 1}`, g.square[i].stem, { fill: 'primary', at: { portrait: { points: g.portrait[i].stem }, story: { points: g.story[i].stem }, landscape: { points: g.landscape[i].stem } } }),
    );
  }
  return out;
}

/**
 * tech_testimonial: a QUOTE-FOCUS layout on the brand color. The customer's words sit in a big paper SPEECH BUBBLE (rounded, with a tail
 * pointing down to the name) topped by a geometric quote mark; the headline is the claim above it, the logo top-left and a button bottom
 * right. Square / portrait / story stack everything; landscape puts claim and button left and the bubble right.
 */
const techTestimonial = defineTemplate({
  id: 'tech_testimonial',
  name: 'Testimonial (speech bubble)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A customer quote in a large speech bubble on the brand color, with the claim as the headline, the customer name under the tail and a button.',
  styles: ['bold_startup', 'modern_corporate', 'contemporary_geometric'],
  industries: ['saas', 'software', 'technology', 'app', 'b2b', 'startup', 'platform', 'consulting', 'agency'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: ['quote'],
  density: 'balanced',
  family: 'quote-focus',
  composition: 'Brand-colored canvas, a big paper speech bubble holding the quote under a geometric quote mark, the name under its tail, claim headline above.',
  sample: {
    headline: 'Teams ship faster with Northwind',
    quote: 'We replaced three tools with one and our weekly planning now takes minutes, not hours.',
    attribution: 'Customer Name, Head of Product',
    cta: 'Read the story',
    eyebrow: 'Customer story',
    brand: 'Northwind',
  },
  tone: 'brand',
  layers: [
    fill('bg', 'primary'),
    circle('deco', C.square.box(620, -330, 840, 840), {
      fill: 'ink',
      opacity: 0.22,
      at: { portrait: patch(C.portrait, { box: [620, -330, 840, 840] }), story: patch(C.story, { box: [560, -300, 900, 900] }), landscape: patch(C.landscape, { box: [740, -300, 700, 700] }) },
    }),
    logo('logo', C.square.box(714, 80, 280, 46), {
      align: 'right',
      nameColor: 'onPrimary',
      nameWeight: 700,
      tracking: -0.01,
      at: { portrait: patch(C.portrait, { box: [714, 100, 280, 46] }), story: patch(C.story, { box: [594, 282, 400, 56] }), landscape: patch(C.landscape, { box: [72, 66, 240, 38], align: 'left' }) },
    }),
    rect('bubble', C.square.box(86, 352, 908, 452), {
      fill: 'paper',
      radius: 0.08,
      at: {
        portrait: patch(C.portrait, { box: [86, 470, 908, 620] }),
        story: patch(C.story, { box: [86, 730, 908, 660] }),
        landscape: patch(C.landscape, { box: [500, 64, 628, 372], radius: 0.08 }),
      },
    }),
    poly('bubble-tail', [C.square.pt(150, 798), C.square.pt(262, 798), C.square.pt(150, 870)], {
      fill: 'paper',
      at: {
        portrait: { points: [C.portrait.pt(150, 1084), C.portrait.pt(262, 1084), C.portrait.pt(150, 1156)] },
        story: { points: [C.story.pt(150, 1384), C.story.pt(262, 1384), C.story.pt(150, 1456)] },
        landscape: { points: [C.landscape.pt(556, 430), C.landscape.pt(650, 430), C.landscape.pt(556, 492)] },
      },
    }),
    ...quoteMark({ square: [136, 392, 52], portrait: [136, 514, 56], story: [136, 780, 60], landscape: [544, 100, 36] }),
    text('quote', 'quote', C.square.box(136, 500, 808, 262), {
      size: C.square.size(54, 30),
      weight: 600,
      lh: 1.22,
      tracking: -0.01,
      color: 'ink',
      lines: 7,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [136, 640, 808, 390], size: [62, 32], maxLines: 8 }),
        story: patch(C.story, { box: [136, 920, 808, 420], size: [66, 34], maxLines: 8 }),
        landscape: patch(C.landscape, { box: [544, 168, 540, 238], size: [32, 20], maxLines: 7 }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(86, 91, 560, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.16,
      weight: 700,
      color: 'onPrimary',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [86, 111, 560, 28], size: 22 }),
        story: patch(C.story, { box: [86, 293, 500, 34], size: 26 }),
        landscape: patch(C.landscape, { box: [72, 128, 400, 22], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(86, 152, 908, 176), {
      size: C.square.size(72, 40),
      weight: 800,
      lh: 1.04,
      tracking: -0.015,
      color: 'onPrimary',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [86, 180, 908, 250], size: [90, 46], maxLines: 3 }),
        story: patch(C.story, { box: [86, 360, 908, 330], size: [100, 56], maxLines: 3 }),
        landscape: patch(C.landscape, { box: [72, 160, 400, 270], size: [54, 26], maxLines: 6 }),
      },
    }),
    text('attribution', 'attribution', C.square.box(86, 888, 580, 44), {
      size: C.square.size(28, 20),
      weight: 700,
      color: 'onPrimary',
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [86, 1172, 580, 48], size: [30, 20] }),
        story: patch(C.story, { box: [86, 1476, 908, 56], size: [36, 22] }),
        landscape: patch(C.landscape, { box: [500, 500, 628, 40], size: [22, 15] }),
      },
    }),
    button('cta', C.square.box(664, 892, 330, 66), {
      size: C.square.size(28, 20),
      arrow: true,
      at: {
        portrait: patch(C.portrait, { box: [664, 1172, 330, 66], size: [28, 20] }),
        story: patch(C.story, { box: [86, 1560, 400, 80], size: [32, 24] }),
        landscape: patch(C.landscape, { box: [72, 480, 250, 56], size: [20, 15] }),
      },
    }),
  ],
});

type Px4 = [number, number, number, number];
type Per<T> = { square: T; portrait: T; landscape: T; banner: T };
const CLASSES = ['square', 'portrait', 'landscape', 'banner'] as const;
const atOf = <T>(per: Per<T>, make: (c: CanvasHelper, v: T) => Record<string, unknown>) => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const k of CLASSES) if (k !== 'square') out[k] = make(C[k], per[k]);
  return out as Partial<Record<(typeof CLASSES)[number], Record<string, unknown>>>;
};

/** A thin selection frame with four square handles (the design-tool "selected" look), written in pixels of each class. */
function selectionFrame(per: Per<Px4>) {
  const corner = (k: 0 | 1 | 2 | 3) => (c: CanvasHelper, [x, y, w, h]: Px4) => {
    const handle = c.height < 400 ? 11 : c.width > 1100 && c.height < 700 ? 14 : 18;
    return { box: c.box(x + (k % 2 ? w : 0) - handle / 2, y + (k > 1 ? h : 0) - handle / 2, handle, handle) };
  };
  return [
    rect('frame', C.square.box(...per.square), { stroke: { color: 'ink', width: 0.0016 }, opacity: 0.5, at: atOf(per, (c, v) => ({ box: c.box(...v) })) }),
    ...([0, 1, 2, 3] as const).map((k) => rect(`handle-${k + 1}`, corner(k)(C.square, per.square).box, { fill: 'primary', at: atOf(per, corner(k)) })),
  ];
}

/** Concentric "orbit" rings with one dot on the outer ring and a small core: the single graphic idea of this template. Pixels (cx, cy, r) per class. */
function orbit(per: Per<[number, number, number]>) {
  const ring = (f: number) => (c: CanvasHelper, [cx, cy, r]: [number, number, number]) => ({ box: c.box(cx - r * f, cy - r * f, r * f * 2, r * f * 2) });
  const dot = (c: CanvasHelper, [cx, cy, r]: [number, number, number]) => {
    const d = Math.max(14, r * 0.14);
    const a = (-38 * Math.PI) / 180;
    return { box: c.box(cx + Math.cos(a) * r - d / 2, cy + Math.sin(a) * r - d / 2, d, d) };
  };
  const core = (c: CanvasHelper, [cx, cy, r]: [number, number, number]) => ({ box: c.box(cx - r * 0.05, cy - r * 0.05, r * 0.1, r * 0.1) });
  return [
    circle('orbit-outer', ring(1)(C.square, per.square).box, { stroke: { color: 'ink', width: 0.0016 }, opacity: 0.4, at: atOf(per, ring(1)) }),
    circle('orbit-inner', ring(0.5)(C.square, per.square).box, { stroke: { color: 'ink', width: 0.0016 }, opacity: 0.4, at: atOf(per, ring(0.5)) }),
    circle('orbit-dot', dot(C.square, per.square).box, { fill: 'primary', at: atOf(per, dot) }),
    circle('orbit-core', core(C.square, per.square).box, { fill: 'ink', at: atOf(per, core) }),
  ];
}

/**
 * tech_minimalist: a FRAME composition, mostly empty on purpose. A hairline selection frame with square handles encloses a mono tag top-left,
 * the brand top-right, one orbit graphic (rings and a dot) and a bottom-anchored headline that sits over a hairline rule with the support
 * line and an outlined button underneath. Banner keeps the frame, the headline, the button and a small orbit.
 */
const techMinimalist = defineTemplate({
  id: 'tech_minimalist',
  name: 'Minimalist tech (selection frame)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A quiet light layout: a hairline selection frame with corner handles, one orbit graphic, a bottom-anchored headline and an outlined button. No picture needed.',
  styles: ['minimalist_tech', 'modern_corporate'],
  industries: ['saas', 'software', 'technology', 'ai', 'devtools', 'cybersecurity', 'fintech', 'startup', 'b2b'],
  channels: [],
  classes: ['square', 'portrait', 'landscape', 'banner'],
  requires: [],
  density: 'airy',
  family: 'frame',
  composition: 'Paper background, hairline frame with corner handles, an orbit graphic top-right, headline anchored to the bottom above a hairline, outlined button.',
  sample: {
    headline: 'Software that stays out of your way',
    support: 'Fast, focused tools for teams who value their time.',
    cta: 'Get started',
    eyebrow: 'v2.0 · Now available',
    brand: 'Northwind',
  },
  tone: 'light',
  layers: [
    fill('paper', 'paper'),
    ...selectionFrame({
      square: [40, 40, 1000, 1000],
      portrait: [40, 40, 1000, 1270],
      landscape: [24, 24, 1152, 580],
      banner: [16, 16, 1168, 268],
    }),
    ...orbit({
      square: [740, 380, 230],
      portrait: [740, 500, 240],
      landscape: [930, 300, 190],
      banner: [1000, 150, 108],
    }),
    logo('logo', C.square.box(684, 92, 300, 40), {
      align: 'right',
      nameColor: 'ink',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [684, 100, 300, 40] }),
        landscape: patch(C.landscape, { box: [828, 66, 300, 34] }),
        banner: patch(C.banner, { box: [48, 36, 240, 28], align: 'left' }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(96, 98, 560, 28), {
      size: C.square.size(20),
      family: 'mono',
      upper: true,
      tracking: 0.1,
      weight: 600,
      color: 'muted',
      lines: 1,
      valign: 'middle',
      at: {
        portrait: patch(C.portrait, { box: [96, 106, 560, 28], size: 20 }),
        landscape: patch(C.landscape, { box: [72, 70, 520, 24], size: 14 }),
      },
      hide: ['banner'],
    }),
    text('headline', 'headline', C.square.box(96, 590, 888, 270), {
      size: C.square.size(96, 52),
      weight: 600,
      lh: 1.04,
      tracking: -0.025,
      color: 'ink',
      lines: 3,
      valign: 'bottom',
      at: {
        portrait: patch(C.portrait, { box: [96, 790, 888, 320], size: [104, 56] }),
        landscape: patch(C.landscape, { box: [72, 130, 620, 232], size: [58, 32], maxLines: 4 }),
        banner: patch(C.banner, { box: [48, 76, 700, 112], size: [46, 26], maxLines: 3, valign: 'top' }),
      },
    }),
    line('rule', C.square.pt(96, 902), C.square.pt(984, 902), { color: 'ink', width: 0.0014 }, {
      opacity: 0.3,
      at: {
        portrait: { from: C.portrait.pt(96, 1146), to: C.portrait.pt(984, 1146) },
      },
      hide: ['landscape', 'banner'],
    }),
    text('support', 'support', C.square.box(96, 924, 580, 66), {
      size: C.square.size(26, 19),
      weight: 400,
      lh: 1.32,
      color: 'ink',
      opacity: 0.82,
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [96, 1168, 580, 62], size: [26, 19] }),
        landscape: patch(C.landscape, { box: [72, 380, 520, 60], size: [20, 16], maxLines: 2 }),
      },
      hide: ['banner'],
    }),
    button('cta', C.square.box(704, 924, 280, 62), {
      fill: 'paper',
      stroke: { color: 'ink', width: 0.002 },
      color: 'ink',
      arrow: true,
      size: C.square.size(24, 18),
      at: {
        portrait: patch(C.portrait, { box: [704, 1168, 280, 62], size: [24, 18] }),
        landscape: patch(C.landscape, { box: [72, 480, 240, 54], size: [19, 14] }),
        banner: patch(C.banner, { box: [48, 206, 230, 50], size: [19, 14] }),
      },
    }),
  ],
});

/**
 * tech_dark_premium: a CENTERED, glowing dark layout. Deep ink canvas, a faint grid that fades out downward, a soft brand wash from the top
 * and a luminous HORIZON DOME rising from the bottom edge. Everything is centered: logo, small tracked eyebrow, a big headline, a quiet
 * support line and an accent pill button, all above the horizon. No picture needed.
 */
const techDarkPremium = defineTemplate({
  id: 'tech_dark_premium',
  name: 'Dark premium (horizon glow)',
  version: 1,
  status: 'active',
  category: 'tech_saas',
  description: 'A premium dark SaaS look: ink canvas, fading grid, a glowing horizon dome at the bottom and a fully centered headline stack with an accent pill button.',
  styles: ['minimalist_tech', 'bold_startup', 'contemporary_geometric'],
  industries: ['saas', 'software', 'technology', 'ai', 'fintech', 'cybersecurity', 'devtools', 'startup', 'crypto'],
  channels: [],
  classes: ['square', 'portrait', 'story', 'landscape'],
  requires: [],
  density: 'airy',
  family: 'centered',
  composition: 'Dark canvas with a fading grid, brand wash from the top and a glowing dome at the bottom edge; centered logo, eyebrow, headline, support and pill button.',
  sample: {
    headline: 'The calm way to run your business',
    support: 'Everything your team needs, finally in one beautiful place.',
    cta: 'Get early access',
    eyebrow: 'Introducing Northwind',
    brand: 'Northwind',
  },
  tone: 'dark',
  layers: [
    fill('bg', 'ink'),
    pattern('grid', C.square.box(0, 0, 1080, 760), 'grid', 'onInk', 0.065, {
      opacity: 0.08,
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 960] }), landscape: patch(C.landscape, { box: [0, 0, 1200, 470] }) },
      hide: ['story'],
    }),
    rect('grid-fade', C.square.box(0, 0, 1080, 780), {
      fill: grad(90, [0, 'ink', 0.1], [1, 'ink', 1]),
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 980] }), landscape: patch(C.landscape, { box: [0, 0, 1200, 480] }) },
      hide: ['story'],
    }),
    rect('wash', C.square.box(0, 0, 1080, 560), {
      fill: grad(90, [0, 'primary', 0.3], [1, 'primary', 0]),
      at: { portrait: patch(C.portrait, { box: [0, 0, 1080, 700] }), story: patch(C.story, { box: [0, 1240, 1080, 680], fill: grad(90, [0, 'primary', 0], [1, 'primary', 0.34]) }), landscape: patch(C.landscape, { box: [0, 0, 1200, 380] }) },
    }),
    circle('dome-ring', C.square.box(-470, 770, 2020, 2020), {
      stroke: { color: 'onInk', width: 0.0016 },
      opacity: 0.16,
      at: {
        portrait: patch(C.portrait, { box: [-470, 1030, 2020, 2020] }),
        story: patch(C.story, { box: [-470, -900, 2020, 1480], circle: false }),
        landscape: patch(C.landscape, { box: [-420, 516, 2040, 1256], circle: false }),
      },
    }),
    circle('dome', C.square.box(-400, 830, 1880, 1880), {
      fill: grad(90, [0, 'accent', 0.95], [0.035, 'primary', 0.75], [0.2, 'primary', 0.22], [0.6, 'ink', 0]),
      at: {
        portrait: patch(C.portrait, { box: [-400, 1090, 1880, 1880] }),
        story: patch(C.story, { box: [-400, -840, 1880, 1400], circle: false, fill: grad(270, [0, 'accent', 0.95], [0.035, 'primary', 0.75], [0.2, 'primary', 0.22], [0.6, 'ink', 0]) }),
        landscape: patch(C.landscape, { box: [-360, 548, 1920, 1256], circle: false }),
      },
    }),
    logo('logo', C.square.box(340, 84, 400, 48), {
      align: 'center',
      nameColor: 'onInk',
      nameWeight: 700,
      tracking: -0.01,
      at: {
        portrait: patch(C.portrait, { box: [340, 104, 400, 48] }),
        story: patch(C.story, { box: [340, 640, 400, 58] }),
        landscape: patch(C.landscape, { box: [400, 64, 400, 38] }),
      },
    }),
    text('eyebrow', 'eyebrow', C.square.box(140, 196, 800, 28), {
      size: C.square.size(22),
      upper: true,
      tracking: 0.2,
      weight: 600,
      color: 'onInk',
      opacity: 0.9,
      align: 'center',
      lines: 1,
      at: {
        portrait: patch(C.portrait, { box: [140, 250, 800, 28], size: 22 }),
        story: patch(C.story, { box: [140, 770, 800, 34], size: 26 }),
        landscape: patch(C.landscape, { box: [200, 126, 800, 22], size: 15 }),
      },
    }),
    text('headline', 'headline', C.square.box(100, 244, 880, 310), {
      size: C.square.size(98, 54),
      weight: 800,
      lh: 1.03,
      tracking: -0.03,
      color: 'onInk',
      align: 'center',
      valign: 'middle',
      lines: 4,
      at: {
        portrait: patch(C.portrait, { box: [100, 300, 880, 400], size: [112, 60] }),
        story: patch(C.story, { box: [90, 816, 900, 440], size: [124, 66] }),
        landscape: patch(C.landscape, { box: [130, 158, 940, 180], size: [60, 34], maxLines: 3 }),
      },
    }),
    text('support', 'support', C.square.box(170, 572, 740, 80), {
      size: C.square.size(28, 22),
      weight: 400,
      lh: 1.34,
      color: 'onInk',
      opacity: 0.78,
      align: 'center',
      lines: 2,
      at: {
        portrait: patch(C.portrait, { box: [160, 724, 760, 90], size: [30, 22] }),
        story: patch(C.story, { box: [130, 1276, 820, 110], size: [36, 26] }),
        landscape: patch(C.landscape, { box: [230, 352, 740, 56], size: [21, 16] }),
      },
    }),
    button('cta', C.square.box(350, 678, 380, 72), {
      arrow: true,
      size: C.square.size(30, 22),
      at: {
        portrait: patch(C.portrait, { box: [330, 850, 420, 80], size: [32, 22] }),
        story: patch(C.story, { box: [300, 1440, 480, 92], size: [38, 26] }),
        landscape: patch(C.landscape, { box: [450, 436, 300, 58], size: [22, 16] }),
      },
    }),
  ],
});

export const TECH_SAAS: TemplateDef[] = [techProductLaunch, techFeatureHighlight, techWorkflowSteps, techTestimonial, techMinimalist, techDarkPremium];
