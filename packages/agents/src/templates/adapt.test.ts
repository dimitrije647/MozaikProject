import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { getCollection, themedTemplates } from '../collections/registry';
import { CREATIVE_FORMATS } from '../creative/formats';
import { DeliverableRecord } from '../creative/schemas';
import { DesignDiagnostics, TemplateCreativeRecord } from '../hybrid/records';
import { analyzeSubject, type SubjectMap } from '../imagery/subject';
import { brandGraphic, personScene, productScene, skinColouredSurfaces, type Person, type SkinTone } from '../testing/photo-fixtures';
import { flattenFor, rankCompositions, scoreComposition, shortlistCompositions, textFitEstimate, variantsOf, type ContentProfile } from './adapt';
import { planCrop } from './crop';
import { repairLoop } from './design-loop';
import { designStatus, preflight } from './preflight';
import { renderTemplate } from './render';
import { formatClassOf, validateTemplate, type Layer, type TemplateDef } from './schema';

// ADAPTIVE COMPOSITION: content analysis -> scored layout variants -> render -> preflight. Photograph-like local scenes (see
// testing/photo-fixtures.ts: drawn people of seven skin tones under five lights, no real person, no download), deterministic, no model.

const TEXT = { family: 'sans' as const, weight: 700 };
const COPY = { headline: 'Which risk needs whose decision?', support: 'Review visibility alongside responsibility.', cta: 'Explore the approach', brand: 'Acme Group' };
const PALETTE = ['#12305a', '#d3232a', '#f4f5f7'];

function tpl(id: string, layers: Layer[], classes: TemplateDef['classes'] = ['square', 'landscape', 'banner', 'portrait', 'story']): TemplateDef {
  const raw = { id, name: `Test ${id}`, version: 1, status: 'active', category: 'professional_services', description: 'A synthetic template for the adaptive tests.', styles: ['modern_corporate'], industries: ['*'], channels: [], classes, requires: [], density: 'balanced', family: 'full-bleed', composition: 'A synthetic composition for the tests.', sample: { headline: 'Sample' }, tone: 'dark', layers };
  const v = validateTemplate(raw);
  assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
  return (v as { template: TemplateDef }).template;
}
const photo = (box: [number, number, number, number] = [0, 0, 1, 1]): Layer => ({ id: 'photo', type: 'image', slot: 'hero', box });
const headline = (box: [number, number, number, number], extra: Partial<Extract<Layer, { type: 'text' }>> = {}): Layer => ({ id: 'headline', type: 'text', slot: 'headline', box, align: 'left', valign: 'middle', style: TEXT, color: 'white', size: { max: 0.07, min: 0.035 }, maxLines: 3, ...extra });

const people = (xs: [number, number][], size: number, tones: SkinTone[] = ['light', 'deep', 'medium', 'dark', 'olive']): Person[] => xs.map(([x, y], i) => ({ x, y, size, tone: tones[i % tones.length] }));

async function content(pic: Buffer, W: number, H: number, kind: string | null = 'social_post', copy: ContentProfile['copy'] = COPY): Promise<{ profile: ContentProfile; map: SubjectMap }> {
  const m = (await analyzeSubject(pic))!;
  const meta = await sharp(pic).metadata();
  return { map: m, profile: { width: W, height: H, picture: { w: meta.width!, h: meta.height!, subject: m }, hasSecondPicture: false, logo: { w: 400, h: 100 }, copy, kind } };
}
const subjectOf = (m: SubjectMap) => ({ faces: m.faces, subject: m.subject, graphic: m.graphic });
const render = (t: TemplateDef, W: number, H: number, hero: Buffer, m: SubjectMap, extra: Record<string, unknown> = {}) =>
  renderTemplate({ template: t, width: W, height: H, content: COPY, palette: PALETTE, brandName: 'Acme Group', images: { hero }, subject: subjectOf(m), ...extra });
const check = (res: Extract<Awaited<ReturnType<typeof renderTemplate>>, { ok: true }>, hasLogo = false) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo, hasPicture: true, templateHasImage: true });
const ok = async (p: ReturnType<typeof renderTemplate>) => {
  const r = await p;
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r as Extract<typeof r, { ok: true }>;
};
const whiteLogo = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect x="4" y="10" width="392" height="80" rx="8" fill="#ffffff"/></svg>')).png().toBuffer();

describe('subject analysis across skin tones and light (local heuristic, drawn scenes)', () => {
  it('finds the faces of people of every tone in neutral light, and of dark and deep skin also in cool and dim light; skin-coloured surfaces give none', async () => {
    const tones: SkinTone[] = ['very_light', 'light', 'medium', 'olive', 'brown', 'dark', 'deep'];
    for (const tone of tones) {
      const m = (await analyzeSubject(await personScene({ width: 1200, height: 800, people: people([[0.25, 0.35], [0.5, 0.35], [0.75, 0.35]], 0.16, [tone]) })))!;
      assert.ok(m.faces.length >= 3, `${tone}, neutral light: ${m.faces.length} faces`);
    }
    for (const tone of ['dark', 'deep'] as SkinTone[]) {
      for (const lighting of ['cool', 'dim'] as const) {
        const m = (await analyzeSubject(await personScene({ width: 1200, height: 800, people: people([[0.25, 0.35], [0.5, 0.35], [0.75, 0.35]], 0.16, [tone]), lighting })))!;
        assert.ok(m.faces.length >= 2, `${tone}, ${lighting} light: ${m.faces.length} faces`);
      }
    }
    const { wall, wood } = await skinColouredSurfaces(1200, 800);
    assert.equal((await analyzeSubject(wall))!.faces.length, 0, 'a beige wall is not a face');
    assert.equal((await analyzeSubject(wood))!.faces.length, 0, 'wood grain is not a face');
  });

  it('a picture without people has no faces and still gets a subject box and a busy map; a brand graphic is recognised as a graphic', async () => {
    const m = (await analyzeSubject(await productScene(1200, 900)))!;
    assert.equal(m.faces.length, 0);
    assert.equal(m.graphic, false, 'a photograph of a product is not a flat graphic');
    assert.ok(m.subject[0] <= 0.62 && m.subject[0] + m.subject[2] >= 0.8, `the subject box contains the product on the right (${m.subject})`);
    assert.ok(m.busy.cells.length > 0);
    assert.equal((await analyzeSubject(await brandGraphic(1200, 630)))!.graphic, true);
  });
});

describe('dynamic cropping', () => {
  it('a portrait whose face is near the edge keeps the whole head in a square box', async () => {
    const pic = await personScene({ width: 1800, height: 1000, people: people([[0.08, 0.4]], 0.3, ['brown']), backdrop: 'studio' });
    const { map } = await content(pic, 1080, 1080);
    const r = await ok(render(tpl('t_full', [photo(), headline([0.55, 0.75, 0.4, 0.15])]), 1080, 1080, pic, map));
    assert.ok(r.report.hero!.faces.length >= 1);
    assert.ok(r.report.hero!.faces.every((f) => f.inFrame >= 0.95), JSON.stringify(r.report.hero!.faces.map((f) => f.inFrame)));
  });

  it('a distant person in a wide picture is framed closer (bounded zoom) without cutting the head', async () => {
    const pic = await personScene({ width: 2400, height: 1600, people: people([[0.5, 0.45]], 0.09, ['medium']), backdrop: 'studio' });
    const m = (await analyzeSubject(pic))!;
    const plan = planCrop({ imgW: 2400, imgH: 1600, bw: 1080, bh: 1080, focus: [0.5, 0.5], layerRect: { x: 0, y: 0, w: 1080, h: 1080 }, canvasW: 1080, canvasH: 1080, subject: subjectOf(m) });
    assert.ok(plan.zoom > 1 && plan.zoom <= 1.5, `zoom ${plan.zoom}`);
    const f = m.faces[0];
    const x0 = f[0] * plan.sw - plan.left;
    const y0 = f[1] * plan.sh - plan.top;
    assert.ok(x0 >= 0 && x0 + f[2] * plan.sw <= 1080 && y0 >= 0 && y0 + f[3] * plan.sh <= 1080, 'the face stays whole');
  });

  it('a wide group photo in a VERTICAL story: no composition with a cut face is chosen while a clean one exists, and the choice is a different adaptation', async () => {
    const pic = await personScene({ width: 2400, height: 1200, people: people([[0.12, 0.35], [0.3, 0.33], [0.5, 0.35], [0.7, 0.33], [0.88, 0.35]], 0.18), backdrop: 'studio' });
    const { profile } = await content(pic, 1080, 1920);
    const ranked = rankCompositions(themedTemplates(getCollection('modern_corporate')!), profile);
    assert.ok(ranked.length > 0);
    const best = ranked[0];
    const clean = ranked.filter((c) => !c.hard.length);
    if (clean.length) assert.equal(best.hard.length, 0, 'a clean composition wins over a better-scored one with a critical problem');
    // whatever wins never cuts a face: it shows people whole, shows the whole picture, or (labelled) shows no picture
    assert.ok(!best.hard.some((h) => h.startsWith('face_crop')), best.hard.join(' | '));
    if (best.predicted.crop) assert.ok(best.predicted.facesWhole >= 1 || best.predicted.crop.fit === 'contain');
    else assert.ok(best.reasons.some((r) => /photo-free/.test(r)), 'a photo-free choice says so');
  });

  it('a VERTICAL photo for a BILLBOARD keeps the person whole', async () => {
    const pic = await personScene({ width: 1000, height: 1500, people: people([[0.5, 0.3]], 0.18, ['dark']), backdrop: 'studio' });
    const { map } = await content(pic, 2400, 800, 'billboard');
    const r = await ok(render(tpl('t_bill', [photo([0.55, 0, 0.45, 1]), headline([0.05, 0.3, 0.45, 0.4])], ['banner']), 2400, 800, pic, map));
    assert.equal(check(r).checks.find((c) => c.id === 'face_crop')!.status, 'pass');
  });

  it('a brand graphic with embedded text is shown WHOLE in every composition (predicted and rendered)', async () => {
    const g = await brandGraphic(1200, 630);
    const { profile, map } = await content(g, 1080, 1350);
    for (const c of rankCompositions(themedTemplates(getCollection('premium_editorial')!), profile)) if (c.predicted.crop) assert.notEqual(c.predicted.crop.fit === 'cover' && c.predicted.crop.cropLoss > 0.04, true, `${c.templateId}:${c.variant}`);
    const r = await ok(render(tpl('t_graphic', [photo(), headline([0.06, 0.82, 0.88, 0.12])]), 1080, 1350, g, map));
    assert.equal(r.report.hero!.fit, 'contain');
  });
});

describe('layout variants and negative space', () => {
  // people on the LEFT of a calm studio picture; the template sets its headline on the left, directly on the picture
  const leftHeadline = () => tpl('t_left', [photo(), headline([0.06, 0.25, 0.4, 0.3])], ['square']);

  it('text moves to the free side of the picture (mirror) instead of covering the people; the rendered pixels confirm it', async () => {
    const pic = await personScene({ width: 1600, height: 1600, people: people([[0.2, 0.32], [0.36, 0.34]], 0.15), backdrop: 'studio' });
    const { profile, map } = await content(pic, 1080, 1080);
    const t = leftHeadline();
    const base = scoreComposition(flattenFor(t, 'square'), 'base', profile);
    assert.ok(base.hard.some((h) => h.startsWith('face_occlusion')), base.hard.join(' | '));
    const ranked = rankCompositions([t], profile);
    assert.equal(ranked[0].variant, 'mirror');
    assert.equal(ranked[0].hard.length, 0);
    assert.equal(ranked[0].predicted.textOver, 'picture');
    const r = await ok(render(ranked[0].template, 1080, 1080, pic, map));
    const pre = check(r);
    assert.equal(pre.checks.find((c) => c.id === 'face_occlusion')!.status, 'pass', pre.failures.map((f) => f.detail).join(' | '));
    const h = r.report.texts.find((x) => x.slot === 'headline')!;
    assert.ok(h.rect.x > 1080 * 0.45, 'the headline sits on the right, the people stay free on the left');
    assert.ok(h.busy < 0.1 && h.contrast >= 0.9, `on calm picture with full contrast (busy ${h.busy}, contrast ${h.contrast})`);
  });

  it('a band that carries the headline across the picture shrinks to the text (compact) so the person beside it is uncovered', async () => {
    // one person on the right at the height of the band, the headline on the left part of a full-width band
    const pic = await personScene({ width: 1600, height: 1600, people: people([[0.8, 0.6]], 0.16, ['olive']), backdrop: 'studio' });
    const { profile, map } = await content(pic, 1080, 1080);
    const t = tpl('t_band', [photo(), { id: 'band', type: 'rect', box: [0, 0.5, 1, 0.22], fill: '#0b1530' }, { id: 'stripe', type: 'rect', box: [0, 0.73, 1, 0.012], fill: '#d3232a' }, headline([0.06, 0.53, 0.42, 0.16])], ['square']);
    const variants = variantsOf(flattenFor(t, 'square'), profile).map((v) => v.variant);
    assert.ok(variants.includes('compact'), variants.join(','));
    const ranked = rankCompositions([t], profile);
    assert.ok(ranked[0].variant.includes('compact'), `${ranked[0].variant}: ${ranked[0].hard.join(' | ')}`);
    const band = ranked[0].template.layers.find((l) => l.id === 'band') as Extract<Layer, { type: 'rect' }>;
    assert.ok(band.box[2] < 0.6, `the band shrank to ${band.box[2]}`);
    const before = await ok(render(t, 1080, 1080, pic, map));
    const after = await ok(render(ranked[0].template, 1080, 1080, pic, map));
    const vis = (r: typeof before) => Math.min(...r.report.hero!.faces.map((f) => f.visibility ?? 1));
    assert.ok(vis(after) > vis(before) + 0.3, `the face is uncovered: ${vis(before)} -> ${vis(after)}`);
    // the headline itself keeps full colour on its (smaller) band
    assert.ok(after.report.texts[0].contrast >= 0.9);
  });

  it('with no negative space at all (people fill the frame), every band composition is a hard failure and a split layout of the collection wins', async () => {
    const crowd = people([[0.15, 0.25], [0.38, 0.22], [0.62, 0.24], [0.85, 0.22], [0.27, 0.58], [0.5, 0.6], [0.73, 0.58]], 0.13);
    const pic = await personScene({ width: 1600, height: 1600, people: crowd, backdrop: 'studio' });
    const { profile } = await content(pic, 1200, 1200, 'display_ad');
    const lib = themedTemplates(getCollection('clean_ecommerce')!);
    const ranked = rankCompositions(lib, profile);
    const band = ranked.filter((c) => c.templateId === 'ecommerce_seasonal_promo');
    assert.ok(band.length > 0 && band.every((c) => c.hard.length > 0), 'the diagonal band over the crowd is never acceptable');
    assert.notEqual(ranked[0].templateId, 'ecommerce_seasonal_promo');
    assert.equal(ranked[0].hard.length, 0, `${ranked[0].templateId}:${ranked[0].variant} ${ranked[0].hard.join(' | ')}`);
  });

  it('a mirrored layout keeps text on its own card (never over the edge of it)', () => {
    const t = tpl('t_card', [photo([0.35, 0, 0.65, 0.7]), { id: 'card', type: 'rect', box: [0, 0.45, 0.6, 0.55], fill: 'paper' }, headline([0.07, 0.5, 0.7, 0.2], { color: 'ink' })], ['square']);
    const profile: ContentProfile = { width: 1080, height: 1080, picture: null, hasSecondPicture: false, logo: null, copy: COPY };
    const mirror = variantsOf(flattenFor(t, 'square'), profile).find((v) => v.variant === 'mirror')!;
    const card = mirror.template.layers.find((l) => l.id === 'card') as Extract<Layer, { type: 'rect' }>;
    const h = mirror.template.layers.find((l) => l.id === 'headline') as Extract<Layer, { type: 'text' }>;
    assert.ok(h.box[0] >= card.box[0] && h.box[0] + h.box[2] <= card.box[0] + card.box[2] + 1e-9, `text ${h.box} on card ${card.box}`);
  });
});

describe('text fit and copy length', () => {
  it('a long headline in a small box is a hard failure; the ranking prefers compositions with room for it', async () => {
    const small = tpl('t_small', [{ id: 'bg', type: 'fill', fill: 'ink' }, headline([0.06, 0.06, 0.3, 0.1], { maxLines: 2 })], ['square']);
    const roomy = tpl('t_roomy', [{ id: 'bg', type: 'fill', fill: 'ink' }, headline([0.06, 0.3, 0.88, 0.4], { maxLines: 4 })], ['square']);
    const long = 'Every risk in a growing business needs one person who owns the decision and answers for it';
    assert.equal(textFitEstimate(long, small.layers[1] as Extract<Layer, { type: 'text' }>, 1080, 1080), 0);
    assert.ok(textFitEstimate('Short and clear', small.layers[1] as Extract<Layer, { type: 'text' }>, 1080, 1080) > 0);
    const profile: ContentProfile = { width: 1080, height: 1080, picture: null, hasSecondPicture: false, logo: null, copy: { headline: long } };
    const ranked = rankCompositions([small, roomy], profile);
    assert.equal(ranked[0].templateId, 't_roomy');
    assert.ok(ranked.find((c) => c.templateId === 't_small')!.hard.some((h) => h.startsWith('text_fit')));
    // and the renderer never cuts it silently: the roomy composition renders the whole headline
    const r = await ok(renderTemplate({ template: ranked[0].template, width: 1080, height: 1080, content: { headline: long }, palette: PALETTE, brandName: 'Acme' }));
    assert.ok(!r.report.texts[0].trimmed);
  });
});

describe('logo-aware composition', () => {
  it('an approved white logo that would vanish on a light area moves to a corner where it reads, instead of getting a plate; it stays in the safe area', async () => {
    const t = tpl('t_logo', [{ id: 'bg', type: 'fill', fill: '#f4f5f7' }, { id: 'foot', type: 'rect', box: [0, 0.7, 1, 0.3], fill: '#12305a' }, headline([0.06, 0.35, 0.88, 0.2], { color: 'ink' }), { id: 'logo', type: 'logo', box: [0.06, 0.06, 0.3, 0.08], align: 'left', valign: 'top', nameStyle: TEXT, nameColor: 'ink' }], ['square']);
    const r = await ok(renderTemplate({ template: t, width: 1080, height: 1080, content: COPY, palette: PALETTE, brandName: 'Acme', logo: await whiteLogo(), logoAdapt: true }));
    assert.ok(r.flags.includes('logo_moved'), r.flags.join(','));
    assert.ok(!r.flags.includes('logo_plate_added'), 'no unnecessary plate');
    assert.ok(r.report.logo!.contrast >= 2.2 && r.report.logo!.rect.y > 1080 * 0.7, 'it reads on the dark foot');
    const s = r.report.safe;
    const l = r.report.logo!.rect;
    assert.ok(l.x >= s.l - 1 && l.y >= s.t - 1 && l.x + l.w <= s.r + 1 && l.y + l.h <= s.b + 1);
    // the pixels: the mark is really drawn there (white on navy), not on the light top
    const raw = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => raw.data[(Math.round(y) * 1080 + Math.round(x)) * raw.info.channels];
    assert.ok(px(l.x + l.w / 2, l.y + l.h / 2) > 230, 'white mark at the new spot');
  });
});

describe('layout diversity and the quality gate', () => {
  it('a layout already used in the channel is not repeated while another clean TEMPLATE exists (a mirrored or compacted copy is the same design)', async () => {
    const pic = await personScene({ width: 1600, height: 1600, people: people([[0.7, 0.35]], 0.16), backdrop: 'studio' });
    for (const [w, h, kind] of [[1240, 1748, 'flyer'], [1080, 1080, 'social_post']] as const) {
      const { profile } = await content(pic, w, h, kind);
      const lib = themedTemplates(getCollection('clean_ecommerce')!);
      const all = rankCompositions(lib, profile);
      const first = all[0];
      const ranked = rankCompositions(lib, profile, { used: new Map([[first.templateId, new Set([first.variant])]]) });
      const second = ranked[0];
      const otherClean = all.some((c) => c.templateId !== first.templateId && !c.hard.length);
      if (otherClean) assert.notEqual(second.templateId, first.templateId, `${kind}: ${first.templateId}:${first.variant} then ${second.templateId}:${second.variant}`);
      // every variant of the used template carries the repeat penalty: mirroring does not escape it
      for (const c of ranked.filter((x) => x.templateId === first.templateId)) assert.ok(c.reasons.some((r) => /already used/.test(r)), `${c.variant} is marked as a repeat`);
    }
  });

  it('the shortlist renders at most n compositions and prefers different templates', async () => {
    const pic = await personScene({ width: 1600, height: 1600, people: people([[0.3, 0.35], [0.6, 0.35]], 0.14), backdrop: 'office' });
    const { profile } = await content(pic, 1080, 1080);
    const ranked = rankCompositions(themedTemplates(getCollection('lifestyle_human')!), profile);
    const short = shortlistCompositions(ranked, 3);
    assert.ok(short.length <= 3);
    assert.equal(new Set(short.map((c) => c.templateId)).size, short.length);
  });

  it('a creative with a face covered by text is UNRESOLVED (not approved) even though a PNG exists; only non-critical issues give "warnings"', async () => {
    const pic = await personScene({ width: 1600, height: 1600, people: people([[0.3, 0.4]], 0.2), backdrop: 'studio' });
    const { map } = await content(pic, 1080, 1080);
    const t = tpl('t_onface', [photo(), headline([0.15, 0.3, 0.4, 0.2])], ['square']);
    const run = await repairLoop('t_onface', (tune) => render(t, 1080, 1080, pic, map, { tune }), (res) => check(res), 3);
    assert.ok(run.best!.res.png.length > 1000, 'the file exists');
    assert.equal(designStatus(run.best!.pre), 'unresolved');
    assert.equal(designStatus({ failures: [{ id: 'overlay_dominance', category: 'occlusion', status: 'fail', detail: '' }], checks: [] }), 'warnings');
    assert.equal(designStatus({ failures: [], checks: [] }), 'passed');
  });
});

describe('historical compatibility of the stored records', () => {
  it('diagnostics, creatives and deliverables saved before adaptive composition still parse', () => {
    assert.ok(DesignDiagnostics.safeParse({ passed: true, checks: [], repairs: [], renders: 1, templatesTried: ['x'], templateChanged: false }).success);
    assert.ok(TemplateCreativeRecord.safeParse({ slotId: 's', conceptId: 'K1', templateId: 't', templateName: 'T', templateVersion: 1, variationId: null, channel: 'instagram', format: 'instagram_square', width: 1080, height: 1080, status: 'rendered', assetId: 'a', sourceAssetIds: [], origin: 'TEMPLATE_RENDERED', flags: [], reason: null }).success);
    assert.ok(DeliverableRecord.safeParse({ id: 's', kind: 'billboard', label: 'Billboard', conceptId: 'K1', channel: 'organic_content', format: 'billboard', width: 2400, height: 800, folder: 'print/billboards', status: 'delivered', assetId: 'a', variantId: null, withPicture: true, reason: null }).success);
  });

  it('every format the deliverables use has at least one composition in the reference collection', async () => {
    const lib = themedTemplates(getCollection('modern_corporate')!);
    for (const fid of ['x_post', 'story', 'facebook_feed', 'instagram_portrait', 'linkedin_feed', 'web_banner', 'display_square', 'billboard', 'flyer']) {
      const f = CREATIVE_FORMATS[fid];
      const profile: ContentProfile = { width: f.width, height: f.height, picture: null, hasSecondPicture: false, logo: null, copy: COPY };
      assert.ok(rankCompositions(lib, profile).length > 0, `${fid} (${formatClassOf(f.width, f.height)})`);
    }
  });
});
