import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { MIN_OPTION_DISTANCE, MAX_OPTION_DISTANCE, TOO_SIMILAR, paletteDistance, paletteVariantIssues, paletteVariants } from '../brand/variants';
import { suggestPalette } from '../brand/suggest';
import { colorDistance } from '../brand/color-parse';
import { applyPaletteOption, designAnchors, designBrandColors, newDesign, parseDesign } from '../collections/design';
import { getCollection, themedTemplates } from '../collections/registry';
import { PALETTE_ROLES } from '../collections/schema';
import { contentForSlot, groundedPoints, renderContent } from '../hybrid/content';
import type { CopyVariantRecord } from '../creative/schemas';
import { contrast } from './color';
import { flattenFor, placeholderPictureShare, rankCompositions, scoreComposition, structuredZones, type ContentProfile } from './adapt';
import { preflight } from './preflight';
import { renderTemplate } from './render';

// MOBILE CONTENT DENSITY + PALETTE OPTIONS (Jigjoy, 2026-11-14: a TikTok cover with three empty step rows, a story with an empty picture window).
// Local renders only: no model, no network, no paid call.

const LIB = themedTemplates(getCollection('minimal_tech')!);
const byId = (id: string) => LIB.find((t) => t.id === id)!;
const PALETTE = ['#1f2937', '#f3f4f6', '#14b8a6'];
const COPY = { headline: 'Bring a beta question', support: 'Know what you want to find out.', cta: 'Review beta entry', brand: 'Jigjoy' };
const POINTS = { point1: 'Plain-language tasks', point2: 'Scheduled agent runs', point3: 'Beta entry review' };
const profile = (copy: Record<string, string>, W: number, H: number, kind: string, fastScroll: boolean): ContentProfile => ({ width: W, height: H, picture: null, hasSecondPicture: false, logo: null, copy: copy as ContentProfile['copy'], kind, fastScroll });

async function render(tplId: string, cls: 'story' | 'banner' | 'square', W: number, H: number, copy: Record<string, string>, kind: string, fastScroll: boolean, palette = PALETTE) {
  const t = rankCompositions([byId(tplId)], profile(copy, W, H, kind, fastScroll))[0]?.template ?? flattenFor(byId(tplId), cls);
  const res = await renderTemplate({ template: t, width: W, height: H, content: copy as never, palette, styleId: 'minimalist_tech', brandName: 'Jigjoy', images: {}, logo: null });
  assert.ok(res.ok);
  if (!res.ok) throw new Error('render');
  const pre = preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: false, templateHasImage: t.layers.some((l) => l.type === 'image'), media: { kind, logoSpellsName: false, fastScroll } });
  return { res, pre, check: (id: string) => pre.checks.find((c) => c.id === id) };
}

// ---- A. mobile content density -----------------------------------------------------------------------------------------------------------

describe('A. TikTok/mobile visuals do not show empty cards, rows or steps', () => {
  it('the step rows of the workflow layout are a structured zone: empty without labels, filled with them', () => {
    const story = flattenFor(byId('tech_workflow_steps'), 'story');
    const empty = structuredZones(story, COPY);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].empty.length, 3);
    assert.equal(structuredZones(story, { ...COPY, ...POINTS })[0].empty.length, 0);
  });
  it('TikTok with the labels: the workflow layout is chosen and its steps carry the words; without them another layout is chosen', () => {
    const withPoints = rankCompositions(LIB, profile({ ...COPY, ...POINTS }, 1080, 1920, 'social_post', true));
    assert.equal(withPoints[0].templateId, 'tech_workflow_steps', withPoints.slice(0, 3).map((c) => `${c.templateId} ${c.score}`).join(', '));
    const without = rankCompositions(LIB, profile(COPY, 1080, 1920, 'social_post', true));
    assert.notEqual(without[0].templateId, 'tech_workflow_steps');
    const wf = without.find((c) => c.templateId === 'tech_workflow_steps')!;
    assert.ok(wf.hard.some((h) => h.startsWith('structure_empty')), wf.hard.join(' | '));
  });
  it('the rendered TikTok cover shows the labels in its steps and passes the empty-structure check; without them it fails', async () => {
    const full = await render('tech_workflow_steps', 'story', 1080, 1920, { ...COPY, ...POINTS }, 'social_post', true);
    assert.deepEqual(full.res.report.texts.filter((t) => t.slot.startsWith('point')).map((t) => t.text), ['Plain-language tasks', 'Scheduled agent runs', 'Beta entry review']);
    assert.equal(full.check('empty_structure')?.status, 'pass');
    assert.equal(full.check('alignment')?.status, 'pass', 'the labels sit in their cards, the button keeps the column');
    assert.equal(full.check('text_density'), undefined, 'no budget given here');
    const bare = await render('tech_workflow_steps', 'story', 1080, 1920, COPY, 'social_post', true);
    assert.equal(bare.check('empty_structure')?.status, 'fail', bare.check('empty_structure')?.detail ?? '');
  });
  it('a BILLBOARD may stay sparse: the same empty steps are not a failure and not a hard problem there', async () => {
    const r = rankCompositions([byId('tech_workflow_steps')], profile(COPY, 2400, 800, 'billboard', false))[0];
    assert.ok(!r.hard.some((h) => h.startsWith('structure_empty')));
    const bb = await render('tech_workflow_steps', 'banner', 2400, 800, COPY, 'billboard', false);
    assert.equal(bb.check('empty_structure')?.status, 'pass');
  });
  it('the empty-box penalty works in layout selection, and a mobile visual is held to a denser standard than a feed post', () => {
    const t = flattenFor(byId('tech_workflow_steps'), 'story');
    const emptyMobile = scoreComposition(t, 'base', profile(COPY, 1080, 1920, 'social_post', false));
    const filledMobile = scoreComposition(t, 'base', profile({ ...COPY, ...POINTS }, 1080, 1920, 'social_post', false));
    assert.ok(filledMobile.score > emptyMobile.score + 0.3, `${filledMobile.score} vs ${emptyMobile.score}`);
    const sq = flattenFor(byId('tech_workflow_steps'), 'square');
    const feed = scoreComposition(sq, 'base', profile(COPY, 1080, 1080, 'social_post', false));
    const feedFilled = scoreComposition(sq, 'base', profile({ ...COPY, ...POINTS }, 1080, 1080, 'social_post', false));
    const billboard = scoreComposition(flattenFor(byId('tech_workflow_steps'), 'banner'), 'base', profile(COPY, 2400, 800, 'billboard', false));
    assert.ok(feedFilled.score - feed.score < filledMobile.score - emptyMobile.score, 'a feed post is penalised less than a mobile visual');
    assert.ok(!feed.hard.some((h) => h.startsWith('structure_empty')) && emptyMobile.hard.some((h) => h.startsWith('structure_empty')));
    assert.ok(!billboard.reasons.some((r) => /would stay empty/.test(r)) || billboard.hard.length === 0);
  });
  it('a picture window that would show only its placeholder pattern is a hard problem on a mobile visual', () => {
    const t = flattenFor(byId('tech_feature_highlight'), 'story');
    assert.ok(placeholderPictureShare(t, { picture: null }) > 0.12);
    const c = scoreComposition(t, 'base', profile(COPY, 1080, 1920, 'social_post', true));
    assert.ok(c.hard.some((h) => h.startsWith('placeholder_picture')), c.hard.join(' | '));
  });
});

// ---- the labels: only words of the approved copy --------------------------------------------------------------------------------------------

describe('A. the card labels come only from the approved copy (no invented facts)', () => {
  const v = (o: Partial<CopyVariantRecord>): CopyVariantRecord => ({ id: 'V1', conceptId: 'K1', channel: 'tiktok', placement: 'social_post', length: 'short', headline: 'Bring a beta question', body: 'Describe tasks in plain language. Jigjoy schedules the agent runs and you review the beta entry.', description: null, ctaText: 'Review beta entry', ctaType: 'learn_more', hashtags: [], claims: [], version: 1, history: [], ...o }) as CopyVariantRecord;
  it('keeps grounded labels (inflected forms count) and drops invented ones, numbers and promises', () => {
    const got = groundedPoints({ name: 'Plain words', points: ['Plain-language tasks', 'Scheduled agent runs', '50% faster delivery'] }, [v({})]);
    assert.deepEqual(got, ['Plain-language tasks', 'Scheduled agent runs']);
    assert.deepEqual(groundedPoints({ name: 'Plain words', points: ['Award-winning support', 'Guaranteed results'] }, [v({})]), []);
  });
  it('a TikTok slot carries the labels; a billboard never does', () => {
    const concepts = [{ id: 'K1', name: 'Plain words', points: ['Plain-language tasks', 'Scheduled agent runs', 'Beta entry review'] }];
    const tt = contentForSlot({ conceptId: 'K1', channel: 'tiktok', kind: 'social_post' }, concepts, [v({})])!;
    assert.deepEqual(tt.points, ['Plain-language tasks', 'Scheduled agent runs', 'Beta entry review']);
    assert.deepEqual(Object.entries(renderContent(tt, 'Jigjoy', {})).filter(([k]) => k.startsWith('point')).map(([, x]) => x), tt.points);
    const bb = contentForSlot({ conceptId: 'K1', channel: 'organic_content', kind: 'billboard' }, concepts, [v({ id: 'V2', channel: 'organic_content', placement: 'billboard' })])!;
    assert.equal(bb.points, undefined);
  });
});

// ---- B. three palette options ------------------------------------------------------------------------------------------------------------

describe('B. three close palette options', () => {
  const brand = { primary: '#3f6013', secondary: '#048543', accent: '#ffe14d', background: '#0e0b1f', text: '#ffffff' };
  it('three options, similar to the detected palette but not identical, readable, with the primary and accent apart', () => {
    const v = paletteVariants(brand);
    assert.deepEqual(v.map((x) => x.id), ['closest', 'contrast', 'emphasis']);
    assert.equal(v.filter((x) => x.recommended).length, 1);
    for (const x of v) {
      assert.ok(paletteDistance(x.palette, brand) <= MAX_OPTION_DISTANCE, `${x.id} stays close`);
      assert.ok(contrast(x.palette.text, x.palette.background) >= 4.5, `${x.id} text reads`);
      assert.ok(colorDistance(x.palette.primary, x.palette.accent) >= TOO_SIMILAR);
      assert.ok(x.check.ok);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(paletteDistance(v[i].palette, v[j].palette) >= MIN_OPTION_DISTANCE, `${v[i].id} vs ${v[j].id}`);
    assert.deepEqual(paletteVariantIssues(v), []);
    assert.deepEqual(v[0].palette, brand, 'the closest option of a good palette is the palette itself');
  });
  it('a weak palette (accent nearly the primary, grey text that does not read) becomes three usable options', () => {
    const weak = { primary: '#2f5bff', secondary: '#eef1f6', accent: '#3360ff', background: '#ffffff', text: '#b4bac4' };
    assert.ok(paletteVariantIssues([{ id: 'closest', palette: weak }]).length >= 2, 'the raw palette has both problems');
    const v = paletteVariants(weak);
    assert.deepEqual(paletteVariantIssues(v), []);
    assert.ok(v.every((x) => x.check.ok));
    assert.ok(v[0].changes.some((c) => c.role === 'accent') && v[0].changes.some((c) => c.role === 'text'), 'the corrections are recorded');
  });
  it('colors the user set by hand stay in every option', () => {
    const v = paletteVariants(brand, { locked: ['accent', 'background'] });
    for (const x of v) {
      assert.equal(x.palette.accent, brand.accent);
      assert.equal(x.palette.background, brand.background);
    }
  });
  it('the palette analysis returns the options and the recommended one', () => {
    const s = suggestPalette({ collectionId: 'dynamic_events', readings: [] });
    assert.equal(s.variants.length, 3);
    assert.equal(s.variants.find((x) => x.recommended)!.id, s.recommendedVariant);
  });
  it('the user\'s pick is stored with the design; without a pick the recommended option is used', () => {
    const s = suggestPalette({ collectionId: 'dynamic_events', readings: [] });
    const d0 = newDesign('dynamic_events');
    const auto = applyPaletteOption(d0, s);
    assert.equal(auto.paletteVariant, s.recommendedVariant);
    assert.deepEqual(auto.palette, s.variants.find((x) => x.id === s.recommendedVariant)!.palette);
    const picked = applyPaletteOption(d0, s, { id: 'contrast', all: true });
    assert.equal(picked.paletteVariant, 'contrast');
    assert.deepEqual(picked.palette, s.variants.find((x) => x.id === 'contrast')!.palette);
    // stored and read back (the design of the campaign keeps the option)
    const back = parseDesign(JSON.parse(JSON.stringify({ ...picked, confirmed: true, confirmedAt: '2026-11-14T10:00:00.000Z' })));
    assert.ok(back.ok && back.design.paletteVariant === 'contrast');
    // a later analysis keeps the chosen option
    assert.equal(applyPaletteOption(picked, s).paletteVariant, 'contrast');
    // older designs without the field still parse
    const { paletteVariant: _omit, ...older } = d0 as typeof d0 & { paletteVariant?: unknown };
    void _omit;
    assert.ok(parseDesign(older).ok);
  });
  it('the same campaign with another chosen palette: another look, the same structure and content', async () => {
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [] });
    const looks = await Promise.all(['closest', 'emphasis'].map(async (id) => {
      const d = applyPaletteOption(newDesign('minimal_tech'), s, { id: id as 'closest' | 'emphasis', all: true });
      const r = await render('tech_workflow_steps', 'story', 1080, 1920, { ...COPY, ...POINTS }, 'social_post', true, designBrandColors(d.palette));
      return { r, anchors: designAnchors(d.palette) };
    }));
    const [a, b] = looks;
    assert.notEqual(createHash('sha256').update(a.r.res.png).digest('hex'), createHash('sha256').update(b.r.res.png).digest('hex'), 'another palette gives another picture');
    assert.deepEqual(a.r.res.layers, b.r.res.layers, 'the same layers');
    assert.deepEqual(a.r.res.report.texts.map((t) => t.text), b.r.res.report.texts.map((t) => t.text), 'the same words');
    assert.ok(PALETTE_ROLES.some((r) => s.variants[0].palette[r] !== s.variants[2].palette[r]));
  });
});
