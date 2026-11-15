import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { paletteVariants } from '../brand/variants';
import { getCollection, themedTemplates } from '../collections/registry';
import { CREATIVE_FORMATS } from '../creative/formats';
import { flattenFor, mediaLayers, predictedScene, rankCompositions, reflowText, scoreComposition, type ContentProfile } from './adapt';
import { repairLoop } from './design-loop';
import { CANVAS as C, button, fill, rect, text } from './dsl';
import { TEMPLATE_LIBRARY } from './library';
import { designStatus, preflight } from './preflight';
import { renderTemplate } from './render';
import { formatClassOf, type RenderReport, type TemplateDef, type TemplateRenderResult } from './schema';
import { mergeMoves, sceneFromReport, spacingIssues, spacingLimits, type SpacingScene } from './spacing';

// CONTENT-AWARE SPACING: negative space must be intentional, not a side effect of missing content (a short sentence in a body area made for
// seven lines left a large empty white panel between the explanation and its button). Local renders only: no model, no network, no paid call.

type Fmt = keyof typeof CREATIVE_FORMATS;
type Ok = Extract<TemplateRenderResult, { ok: true }>;
const PALETTE = ['#16a249', '#1c1a17', '#b08d57'];
const SHORT = { headline: 'Tax planning for growing businesses', support: 'We review your numbers each quarter.', cta: 'Learn more', brand: 'Northwind Partners' };
const LONG = {
  ...SHORT,
  support: 'We review your numbers every quarter, flag savings early, prepare each filing on time and explain every step in plain words, so deadlines, audits and surprises never catch your growing team unprepared again.',
};
const byId = (id: string) => TEMPLATE_LIBRARY.find((t) => t.id === id)!;

async function design(t0: TemplateDef, fmtId: Fmt, kind: string, content: Record<string, string>, o: { photo?: Buffer; palette?: string[]; fastScroll?: boolean } = {}) {
  const fmt = CREATIVE_FORMATS[fmtId];
  const W = fmt.width;
  const H = fmt.height;
  const template = reflowText(mediaLayers(flattenFor(t0, formatClassOf(W, H)), kind), content as never, W, H);
  const hasImg = template.layers.some((l) => l.type === 'image');
  const render = (tune: object) => renderTemplate({ template, width: W, height: H, content: content as { headline: string }, palette: o.palette ?? PALETTE, brandName: content.brand ?? 'Brand', images: o.photo && hasImg ? { hero: o.photo } : {}, logo: null, tune });
  const check = (res: Ok) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: !!o.photo, templateHasImage: hasImg, media: { kind, logoSpellsName: false, fastScroll: !!o.fastScroll }, layout: { density: template.density } });
  const first = (await render({})) as Ok;
  assert.ok(first.ok);
  const pre0 = check(first);
  const run = await repairLoop(t0.id, render, check, 4);
  assert.ok(run.best);
  const best = run.best!;
  const spacing = (p: typeof pre0) => p.checks.find((c) => c.id === 'content_spacing')?.status;
  const why = (p: typeof pre0) => p.checks.find((c) => c.id === 'content_spacing')?.detail ?? '';
  return { W, H, template, first, pre0, best, after: best.res, renders: run.renders, before: spacing(pre0), now: spacing(best.pre), why: why(pre0) };
}
const textOf = (r: RenderReport, slot: string) => r.texts.find((t) => t.slot === slot)!;
const ctaRect = (r: RenderReport) => (r.buttons[0] ?? textOf(r, 'cta')).rect;
/** the empty distance between the explanation and the call to action, as a share of the height */
const supportToCta = (r: RenderReport) => {
  const s = textOf(r, 'support').rect;
  return (ctaRect(r).y - (s.y + s.h)) / r.height;
};
const decorRect = (r: RenderReport, id: string) => r.decor.find((d) => d.layerId === id)?.rect;
async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const near = (p: [number, number, number], hex: string) => {
  const q = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return p.every((v, i) => Math.abs(v - q[i]) < 18);
};
/** 12. never clipped: every text and button whole, inside the canvas, nothing cut or squeezed by the regrouping */
function assertNothingClipped(d: Awaited<ReturnType<typeof design>>) {
  const r = d.after.report;
  for (const t of [...r.texts, ...r.buttons]) {
    assert.ok(!t.trimmed, `${t.layerId} trimmed`);
    assert.ok(t.rect.x >= -1 && t.rect.y >= -1 && t.rect.x + t.rect.w <= r.width + 1 && t.rect.y + t.rect.h <= r.height + 1, `${t.layerId} leaves the canvas`);
  }
  for (const id of ['text_fit', 'text_safe_area', 'text_collision']) assert.equal(d.best.pre.checks.find((c) => c.id === id)?.status, 'pass', `${id}: ${d.best.pre.checks.find((c) => c.id === id)?.detail}`);
  const shrunk = (flags: string[]) => flags.filter((f) => /^text_(trimmed|shrunk):/.test(f)).sort();
  for (const f of shrunk(d.after.flags)) assert.ok(shrunk(d.first.flags).includes(f), `the regrouping made ${f}`);
  assert.notEqual(designStatus(d.best.pre), 'unresolved');
}

describe('content-aware spacing: accidental empty space is detected and regrouped', () => {
  it('1. a short explanation in a large information panel: the panel above grows, the explanation joins its button (rendered geometry and pixels)', async () => {
    const d = await design(byId('services_explainer'), 'instagram_portrait', 'social_post', SHORT);
    assert.equal(d.before, 'fail', d.why);
    assert.match(d.pre0.checks.find((c) => c.id === 'content_spacing')!.detail, /separates support from cta/);
    assert.equal(d.now, 'pass');
    assert.ok(supportToCta(d.first.report) > 0.18, `before: ${supportToCta(d.first.report)}`);
    assert.ok(supportToCta(d.after.report) < 0.08, `after: ${supportToCta(d.after.report)}`);
    // the colour panel took the space: a pixel that was paper below the panel is now the brand colour
    const p0 = decorRect(d.first.report, 'panel')!;
    const p1 = decorRect(d.after.report, 'panel')!;
    assert.ok(p1.h > p0.h * 1.2, `${p0.h} -> ${p1.h}`);
    const probeY = p0.y + p0.h + 40;
    assert.ok(!near(await pixel(d.first.png, 30, probeY), PALETTE[0]), 'before: paper below the panel');
    assert.ok(near(await pixel(d.after.png, 30, probeY), PALETTE[0]), 'after: the panel continues there');
    assert.ok(d.after.flags.includes('content_spacing_adjusted'));
    assertNothingClipped(d);
  });

  it('2. the same template with a long explanation keeps its designed geometry (nothing to correct)', async () => {
    const d = await design(byId('services_explainer'), 'instagram_portrait', 'social_post', LONG);
    assert.equal(d.before, 'pass', d.why);
    assert.equal(d.best.tune.move, undefined);
    assert.ok(!d.after.flags.includes('content_spacing_adjusted'));
  });

  it('3. a call to action far below its explanation (landscape split) is brought to it; 5. the left-aligned column keeps its axis', async () => {
    const d = await design(byId('services_explainer'), 'x_post', 'social_post', SHORT);
    assert.equal(d.before, 'fail');
    assert.equal(d.now, 'pass');
    assert.ok(supportToCta(d.first.report) > 0.3, `before: ${supportToCta(d.first.report)}`);
    assert.ok(supportToCta(d.after.report) < 0.1, `after: ${supportToCta(d.after.report)}`);
    // horizontal geometry never changes: the shared left edge of the explanation and the button stays where it was
    assert.equal(Math.round(textOf(d.after.report, 'support').rect.x), Math.round(textOf(d.first.report, 'support').rect.x));
    assert.equal(Math.round(ctaRect(d.after.report).x), Math.round(ctaRect(d.first.report).x));
    assert.ok(Math.abs(ctaRect(d.after.report).x - textOf(d.after.report, 'support').rect.x) < d.W * 0.02, 'one left axis');
    // the button stays in its own column (the alignment check judges a split layout per column)
    assert.equal(d.best.pre.checks.find((c) => c.id === 'alignment')?.status, 'pass');
    assertNothingClipped(d);
  });

  it('4. a centred composition stays centred while its content is regrouped', async () => {
    const base = byId('services_explainer');
    const centred: TemplateDef = {
      ...base,
      id: 'test_centered_card',
      classes: ['square'],
      layers: [
        fill('bg', 'paper'),
        rect('card', C.square.box(140, 140, 800, 800), { fill: 'primary' }),
        text('headline', 'headline', C.square.box(200, 200, 680, 220), { size: C.square.size(64, 40), weight: 800, align: 'center', color: 'onPrimary', lines: 3 }),
        text('support', 'support', C.square.box(200, 450, 680, 330), { size: C.square.size(30, 22), weight: 400, align: 'center', color: 'onPrimary', lines: 8 }),
        button('cta', C.square.box(390, 840, 300, 72), { size: C.square.size(26, 18) }),
      ],
    };
    const d = await design(centred, 'instagram_square', 'social_post', SHORT);
    assert.equal(d.before, 'fail');
    assert.equal(d.now, 'pass');
    assert.ok(supportToCta(d.after.report) < supportToCta(d.first.report) / 2);
    const cx = (r: { x: number; w: number }) => r.x + r.w / 2;
    for (const slot of ['headline', 'support']) assert.ok(Math.abs(cx(textOf(d.after.report, slot).rect) - d.W / 2) < d.W * 0.01, `${slot} off centre`);
    assert.ok(Math.abs(cx(ctaRect(d.after.report)) - d.W / 2) < d.W * 0.01, 'button off centre');
    // one group, centred where the two halves were (not pushed to the top of the card)
    const g0 = textOf(d.after.report, 'headline').rect.y;
    const g1 = ctaRect(d.after.report).y + ctaRect(d.after.report).h;
    const card = decorRect(d.after.report, 'card')!;
    assert.ok(Math.abs(g0 - card.y - (card.y + card.h - g1)) < card.h * 0.12, 'the group sits in the middle of its card');
    assertNothingClipped(d);
  });

  it('8. an optional text left out: the section it leaves behind is given to the panel (the headline stays inside it, its orphan accent goes)', async () => {
    const d = await design(byId('services_explainer'), 'instagram_portrait', 'social_post', { headline: SHORT.headline, cta: SHORT.cta, brand: SHORT.brand });
    assert.equal(d.before, 'fail');
    assert.match(d.pre0.checks.find((c) => c.id === 'content_spacing')!.detail, /between panel/);
    assert.equal(d.now, 'pass');
    const panel = decorRect(d.after.report, 'panel')!;
    const head = textOf(d.after.report, 'headline').rect;
    assert.ok(head.y + head.h <= panel.y + panel.h, 'the headline does not run over the edge of its panel');
    // the reflow of the left-out explanation no longer lets the headline grow out of its panel (before the regrouping either)
    const head0 = textOf(d.first.report, 'headline').rect;
    const panel0 = decorRect(d.first.report, 'panel')!;
    assert.ok(head0.y + head0.h <= panel0.y + panel0.h);
    assert.ok(d.after.flags.includes('layer_hidden:bar'), 'the accent of the missing explanation is left out');
    assert.ok((ctaRect(d.after.report).y - (panel.y + panel.h)) / d.H < 0.08);
    assertNothingClipped(d);
  });

  it('11. a flyer keeps its information hierarchy and type sizes when its section is regrouped', async () => {
    const d = await design(byId('services_explainer'), 'flyer', 'flyer', { ...SHORT, eyebrow: 'Our services' });
    assert.equal(d.before, 'fail');
    assert.equal(d.now, 'pass');
    const r0 = d.first.report;
    const r1 = d.after.report;
    // reading order: eyebrow, headline, explanation, next step; the headline remains the largest type
    const order = ['eyebrow', 'headline', 'support', 'cta'].map((s) => textOf(r1, s).rect.y);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(textOf(r1, 'headline').size > textOf(r1, 'support').size * 1.5);
    for (const s of ['eyebrow', 'headline', 'support', 'cta']) assert.equal(textOf(r1, s).size, textOf(r0, s).size, `${s}: type size changed`);
    // readable margins: nothing moved into the edge
    assert.ok(ctaRect(r1).y + ctaRect(r1).h <= r1.safe.b + 1);
    assertNothingClipped(d);
  });
});

describe('content-aware spacing: intentional negative space stays as designed', () => {
  it('6. an asymmetric editorial layout (a pull quote with an evenly airy rhythm) is left unchanged', async () => {
    const t = byId('editorial_pull_quote');
    const d = await design(t, 'instagram_portrait', 'social_post', t.sample as Record<string, string>);
    assert.equal(d.before, 'pass', d.why);
    assert.equal(d.best.tune.move, undefined);
    const short = await design(t, 'instagram_portrait', 'social_post', { headline: 'Where will you gather?', support: 'Find a place for the party.', cta: 'Visit us', brand: 'Atelier North' });
    assert.equal(short.before, 'pass', short.why);
  });

  it('7. a minimalist poster (headline and a far button, nothing else) keeps its purposeful whitespace', async () => {
    for (const fmt of ['instagram_portrait', 'story'] as const) {
      const d = await design(byId('editorial_minimal'), fmt, 'social_post', { headline: 'Slow furniture', cta: 'Visit the studio', brand: 'Atelier North' });
      assert.equal(d.before, 'pass', `${fmt}: ${d.why}`);
      assert.equal(d.best.tune.move, undefined);
    }
  });

  it('9. a photo-first TikTok cover keeps its picture area: the photograph is content, never a gap', async () => {
    const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#6d7f91' } }).jpeg().toBuffer();
    const lib = themedTemplates(getCollection('dynamic_events')!);
    const profile: ContentProfile = { width: 1080, height: 1920, picture: { w: 1600, h: 1200, subject: null, kind: 'photograph' }, hasSecondPicture: false, logo: null, copy: { headline: 'Friday on the roof', support: 'Live music from nine.', cta: 'See the program' }, kind: 'social_post', fastScroll: true };
    const top = rankCompositions(lib, profile).find((c) => c.template.layers.some((l) => l.type === 'image'))!;
    const res = (await renderTemplate({ template: top.template, width: 1080, height: 1920, content: { ...profile.copy, brand: 'Rooftop' } as never, palette: PALETTE, brandName: 'Rooftop', images: { hero: photo }, logo: null })) as Ok;
    assert.ok(res.ok && res.report.hero);
    const pre = preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: true, templateHasImage: true, media: { kind: 'social_post', logoSpellsName: false, fastScroll: true, pictureIsPhoto: true }, layout: { density: top.template.density } });
    assert.equal(pre.checks.find((c) => c.id === 'content_spacing')?.status, 'pass', `${top.templateId}: ${pre.checks.find((c) => c.id === 'content_spacing')?.detail}`);
    assert.equal(pre.spacing, undefined);
    const hero = res.report.hero!.rect;
    assert.ok((hero.w * hero.h) / (1080 * 1920) >= 0.35, 'the photograph keeps a large area');
    // the planner itself: a gap filled by the picture is not a gap
    const scene: SpacingScene = {
      width: 1080,
      height: 1920,
      safe: { t: 0.14, b: 0.86 },
      picture: { x: 0, y: 0.3, w: 1, h: 0.4 },
      empty: [],
      decor: [],
      items: [
        { id: 'support', kind: 'text', slot: 'support', ink: { x: 0.1, y: 0.2, w: 0.8, h: 0.03 }, box: { x: 0.1, y: 0.2, w: 0.8, h: 0.4 } },
        { id: 'cta', kind: 'button', ink: { x: 0.1, y: 0.75, w: 0.4, h: 0.04 }, box: { x: 0.1, y: 0.75, w: 0.4, h: 0.04 } },
      ],
    };
    assert.deepEqual(spacingIssues(scene, { kind: 'social_post', fastScroll: true }), []);
    assert.equal(spacingIssues({ ...scene, picture: null }, { kind: 'social_post', fastScroll: true }).length, 1, 'without the picture the same gap is accidental');
  });

  it('10. a billboard keeps generous negative space: the same short copy that is regrouped on a feed post is not penalised', async () => {
    const social = await design(byId('services_explainer'), 'x_post', 'social_post', SHORT);
    assert.equal(social.before, 'fail');
    const t = byId('services_explainer');
    const fmt = CREATIVE_FORMATS.x_post;
    const tpl = reflowText(mediaLayers(flattenFor(t, 'landscape'), 'billboard'), SHORT as never, fmt.width, fmt.height);
    const res = (await renderTemplate({ template: tpl, width: fmt.width, height: fmt.height, content: SHORT, palette: PALETTE, brandName: SHORT.brand, images: {}, logo: null })) as Ok;
    const pre = preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: false, templateHasImage: false, media: { kind: 'billboard', logoSpellsName: false }, layout: { density: tpl.density } });
    const c = pre.checks.find((x) => x.id === 'content_spacing')!;
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /billboard/i);
    assert.equal(pre.spacing, undefined);
    assert.equal(spacingLimits({ kind: 'billboard' }, 'banner'), null);
    // an airy template earns more room before space counts as accidental
    assert.ok(spacingLimits({ kind: 'social_post', density: 'airy' }, 'portrait')!.abs > spacingLimits({ kind: 'social_post', density: 'dense' }, 'portrait')!.abs);
  });
});

describe('content-aware spacing: template choice and the existing quality rules', () => {
  it('7b. before rendering, a template drawn for more copy than the concept has is recognised (a small cost when it can be regrouped)', () => {
    const t = byId('services_explainer');
    const prof = (copy: Record<string, string>): ContentProfile => ({ width: 1080, height: 1350, picture: null, hasSecondPicture: false, logo: null, copy: copy as ContentProfile['copy'], kind: 'social_post' });
    const flat = flattenFor(t, 'portrait');
    const short = scoreComposition(flat, 'base', prof(SHORT));
    const long = scoreComposition(flat, 'base', prof(LONG));
    assert.ok(short.reasons.some((r) => /accidental empty space.*regrouped/.test(r)), short.reasons.join(' | '));
    assert.ok(!long.reasons.some((r) => /accidental empty space/.test(r)), long.reasons.join(' | '));
    // the predicted scene sees the same gap the renderer will draw
    const issues = spacingIssues(predictedScene(flat, prof(SHORT)), { kind: 'social_post', density: t.density });
    assert.equal(issues[0]?.above[0], 'support');
    assert.ok(issues[0]?.fix);
  });

  it('12. text and buttons are never clipped by a regrouping, in any medium', async () => {
    const cases: [string, Fmt, string][] = [
      ['services_explainer', 'display_square', 'display_ad'],
      ['services_corporate_announcement', 'web_banner', 'web_ad'],
      ['editorial_index_card', 'flyer', 'flyer'],
      ['services_explainer', 'facebook_feed', 'social_post'],
      ['services_explainer', 'instagram_square', 'social_post'],
    ];
    for (const [id, fmt, kind] of cases) {
      const d = await design(byId(id), fmt, kind, SHORT);
      assert.ok(d.renders <= 4);
      if (d.before === 'fail') assert.equal(d.now, 'pass', `${id} ${fmt}: ${d.best.pre.checks.find((c) => c.id === 'content_spacing')?.detail}`);
      assertNothingClipped(d);
    }
  });

  it('13. the palette option the user picked still applies: another palette gives another look with the same regrouped structure', async () => {
    const opts = paletteVariants({ primary: '#16a249', secondary: '#1c1a17', accent: '#b08d57', background: '#ffffff', text: '#171717' });
    const pal = (id: string) => {
      const p = opts.find((v) => v.id === id)!.palette;
      return [p.primary, p.secondary, p.accent];
    };
    const a = await design(byId('services_explainer'), 'instagram_portrait', 'social_post', SHORT, { palette: pal('closest') });
    const b = await design(byId('services_explainer'), 'instagram_portrait', 'social_post', SHORT, { palette: pal('emphasis') });
    assert.equal(a.now, 'pass');
    assert.equal(b.now, 'pass');
    assert.deepEqual(Object.keys(a.best.tune.move ?? {}).sort(), Object.keys(b.best.tune.move ?? {}).sort());
    const hash = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    assert.notEqual(hash(a.after.png), hash(b.after.png));
    assert.ok(near(await pixel(a.after.png, 30, 30), pal('closest')[0]));
    assert.ok(near(await pixel(b.after.png, 30, 30), pal('emphasis')[0]));
  });

  it('14. creative diversity still works: a layout already used in the channel is still penalised next to the spacing estimate', () => {
    const t = byId('services_explainer');
    const prof: ContentProfile = { width: 1080, height: 1350, picture: null, hasSecondPicture: false, logo: null, copy: SHORT as ContentProfile['copy'], kind: 'social_post' };
    const fresh = rankCompositions([t], prof)[0];
    const used = rankCompositions([t], prof, { used: new Map([[t.id, new Set(['base'])]]) })[0];
    assert.ok(used.score < fresh.score - 0.5, `${fresh.score} -> ${used.score}`);
    assert.ok(used.reasons.some((r) => /already used/.test(r)));
    assert.ok(used.reasons.some((r) => /accidental empty space/.test(r)));
  });

  it('15. deterministic and local: no model, no network, no paid provider in the spacing code', () => {
    const src = fs.readFileSync(path.join(__dirname, 'spacing.ts'), 'utf8');
    assert.ok(!/from '\.\.\/(providers|llm|runtime)|fetch\(|openai|anthropic|http/i.test(src.replace(/^\s*(\*|\/\/).*$/gm, '')));
    // the moves merge: relative moves add up, an absolute box replaces, a hidden accent stays hidden
    assert.deepEqual(mergeMoves({ a: { dy: 0.1 }, b: { y: 0.2, h: 0.1 }, c: { hide: true } }, { a: { dy: 0.05, dh: 0.02 }, b: { dy: 0.1 }, c: { dy: 0.3 } }), { a: { dy: 0.15, dh: 0.02 }, b: { y: 0.3, h: 0.1 }, c: { hide: true } });
  });

  it('the scene of a rendered creative carries the designed boxes and the empty optional slots', async () => {
    const t = byId('services_explainer');
    const tpl = flattenFor(t, 'portrait');
    const res = (await renderTemplate({ template: tpl, width: 1080, height: 1350, content: { headline: SHORT.headline, cta: SHORT.cta }, palette: PALETTE, brandName: 'Northwind', images: {}, logo: null })) as Ok;
    assert.ok(res.report.texts.every((x) => x.box && x.valign));
    assert.ok(res.report.emptySlots?.some((e) => e.slot === 'support'));
    const sc = sceneFromReport(res.report);
    assert.ok(sc.empty.length >= 1 && sc.items.some((i) => i.kind === 'button'));
  });
});
