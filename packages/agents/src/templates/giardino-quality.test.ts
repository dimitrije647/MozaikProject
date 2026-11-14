import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { getCollection, themedTemplates } from '../collections/registry';
import { copyCraftFindings, isPlaceholderCopy, refusedRevision, unnaturalPhrases } from '../copywriting/checks';
import { assetFindings } from '../creative/checks';
import { CREATIVE_INSTRUCTIONS, REVISION_RULES } from '../creative/prompts';
import type { CopyVariantRecord } from '../creative/schemas';
import { contentForSlot, renderContent, VISUAL_TEXT_BUDGET, withTextBudget } from '../hybrid/content';
import { DESIGN_ISSUE } from '../hybrid/quality';
import { allocateImages, motifFit, motifsOf, pixelMotifs } from '../imagery/allocate';
import { analyzeSubject } from '../imagery/subject';
import { productScene } from '../testing/photo-fixtures';
import { emptyPanels, flattenFor, rankCompositions, reflowText, scoreComposition, type ContentProfile } from './adapt';
import { isBetter, repairLoop } from './design-loop';
import { designStatus, preflight, type PreflightResult } from './preflight';
import { monochromeLogo, renderTemplate } from './render';
import type { Layer, TemplateDef } from './schema';

// GIARDINO (2026-11-14, a real venue campaign on the Dynamic Events collection): TikTok covers were huge type with no photograph, a yellow
// panel held only a tiny "Giardino", a white logo sat on a dark box, stub cards kept big holes around small text, the copy said "Punoletni ste i
// planirate izlazak?" and a revision printed "Izostavljeno iz kampanje" as a headline. These tests pin the MVP rules that fix it.
// Local renders and synthetic pictures only: no model, no network, no paid call.

const LIB = themedTemplates(getCollection('dynamic_events')!);
const byId = (id: string) => LIB.find((t) => t.id === id)!;
const PALETTE = ['#3f6013', '#048543', '#ffe14d'];
const ANCHORS = { ink: '#0e0b1f', paper: '#ffffff' };

const variant = (o: Partial<CopyVariantRecord> & Pick<CopyVariantRecord, 'id' | 'channel' | 'headline'>): CopyVariantRecord => ({
  conceptId: 'K1',
  placement: 'social_post',
  length: 'short',
  body: `${o.headline}\nNa krovu TC Bazar u Novom Sadu.`,
  description: null,
  ctaText: 'Pogledaj Instagram profil @giardinoclub.',
  ctaType: 'follow',
  hashtags: [],
  claims: [],
  version: 1,
  history: [],
  visualLine: 'Upoznaj prostor na krovu TC Bazar u Novom Sadu.',
  ctaShort: 'Pogledaj @giardinoclub',
  ...o,
} as CopyVariantRecord);

const words = (c: { headline: string; support?: string | null; eyebrow?: string | null; cta?: string | null }) => [c.headline, c.support, c.eyebrow, c.cta].filter(Boolean).join(' ').split(/\s+/).length;

async function whiteLogo(): Promise<Buffer> {
  // a white single-colour wordmark on transparency (like LOGO-WHITE.png)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect x="40" y="60" width="520" height="24" fill="#ffffff"/><rect x="40" y="110" width="380" height="24" fill="#ffffff"/><circle cx="520" cy="130" r="30" fill="#ffffff"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function colourLogo(): Promise<Buffer> {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect x="40" y="50" width="240" height="100" fill="#e3342f"/><rect x="300" y="50" width="240" height="100" fill="#3490dc"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const flat = async (hex: string, W: number, H: number) => sharp({ create: { width: W, height: H, channels: 3, background: hex } }).jpeg().toBuffer();

async function photoProfile(W: number, H: number, copy: ContentProfile['copy'], kind = 'social_post', fastScroll = false): Promise<{ profile: ContentProfile; pic: Buffer }> {
  const pic = await productScene(1600, 1066);
  const m = await analyzeSubject(pic);
  return { pic, profile: { width: W, height: H, picture: { w: 1600, h: 1066, subject: m, kind: 'photograph' }, hasSecondPicture: false, logo: { w: 600, h: 200 }, copy, kind, fastScroll } };
}

async function design(tpl: TemplateDef, W: number, H: number, copy: Record<string, string>, o: { hero?: Buffer; logo?: Buffer; fastScroll?: boolean; budget?: { maxWords: number; maxBlocks: number } | null; photo?: boolean } = {}) {
  const templateHasImage = tpl.layers.some((l) => l.type === 'image');
  const run = await repairLoop(
    tpl.id,
    (tune) => renderTemplate({ template: tpl, width: W, height: H, content: copy as never, palette: PALETTE, styleId: 'dynamic_events', anchors: ANCHORS, brandName: 'Giardino', images: { hero: o.hero }, logo: o.logo ?? null, logoAdapt: true, tune }),
    (res) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: !!o.logo, hasPicture: templateHasImage && !!o.hero, templateHasImage, media: { kind: 'social_post', logoSpellsName: false, fastScroll: !!o.fastScroll, textBudget: o.budget ?? null, pictureIsPhoto: !!o.photo } }),
    4,
  );
  assert.ok(run.best, 'rendered');
  return run.best!;
}
const check = (pre: PreflightResult, id: string) => pre.checks.find((c) => c.id === id);

// ---- 1. platform-aware text density ------------------------------------------------------------------------------------------------------

describe('1. TikTok and other fast-scroll formats carry less text than before', () => {
  const concepts = [{ id: 'K1', name: 'Dogovor je na krovu' }];
  const v = [
    variant({ id: 'V1', channel: 'tiktok', headline: 'Evo gde je Giardino. Na krovu TC Bazar, usred Novog Sada.' }),
    variant({ id: 'V2', channel: 'facebook', headline: 'Ti biraš mesto za društvo?' }),
    variant({ id: 'V3', channel: 'instagram', headline: 'Ti predloži krov.', visualLine: 'Giardino je na krovu TC Bazar, u samom centru Novog Sada, sa pogledom na ceo grad.' }),
  ];
  it('the TikTok cover shows ONE short headline and the short call to action: no eyebrow, no supporting line', () => {
    const tt = contentForSlot({ conceptId: 'K1', channel: 'tiktok', kind: 'social_post' }, concepts, v)!;
    assert.equal(tt.eyebrow, null);
    assert.equal(tt.support, null);
    assert.equal(tt.headline, 'Evo gde je Giardino.', 'the first sentence of the writer\'s own headline, nothing invented');
    assert.equal(tt.cta, 'Pogledaj @giardinoclub', 'the short call to action');
    // the same copy without the budget (the old behaviour) carried far more words
    const before = withTextBudget({ ...tt, headline: v[0].headline, support: v[0].visualLine!, eyebrow: 'Dogovor je na krovu', cta: v[0].ctaText }, null);
    assert.ok(words(tt) * 2 < words(before), `${words(tt)} words now, ${words(before)} before`);
    assert.ok(words(tt) <= VISUAL_TEXT_BUDGET.tiktok.maxWords);
  });
  it('Facebook keeps its eyebrow and supporting line; Instagram drops a supporting line longer than its budget', () => {
    const fb = contentForSlot({ conceptId: 'K1', channel: 'facebook', kind: 'social_post' }, concepts, v)!;
    assert.equal(fb.eyebrow, 'Dogovor je na krovu');
    assert.ok(fb.support);
    const ig = contentForSlot({ conceptId: 'K1', channel: 'instagram', kind: 'social_post' }, concepts, v)!;
    assert.equal(ig.eyebrow, null);
    assert.equal(ig.support, null, 'longer than 70 characters: left out, never cut');
    assert.ok(VISUAL_TEXT_BUDGET.tiktok.maxWords < VISUAL_TEXT_BUDGET.instagram.maxWords && VISUAL_TEXT_BUDGET.instagram.maxWords < VISUAL_TEXT_BUDGET.facebook.maxWords);
  });
  it('ads and print keep their own media rules (no social budget)', () => {
    const ad = contentForSlot({ conceptId: 'K1', channel: 'google_search', kind: 'web_ad' }, concepts, [variant({ id: 'V9', channel: 'google_search', placement: 'web_ad', headline: 'Društvo za stolom?' })])!;
    assert.equal(ad.eyebrow, 'Dogovor je na krovu');
  });
  it('the Content Writer is told the hook limits per platform', () => {
    assert.match(CREATIVE_INSTRUCTIONS.writer, /tiktok "hook" at most 5 words/);
    assert.match(CREATIVE_INSTRUCTIONS.writer, /instagram "hook" at most 7 words/);
  });
});

// ---- 2. empty panels ---------------------------------------------------------------------------------------------------------------------

describe('2. a large coloured panel that carries nothing is corrected or penalised', () => {
  const copy = { headline: 'Gde se nalazimo? Na krovu.', cta: 'Pogledaj Instagram', brand: 'Giardino' };
  it('the headline poster banner: its yellow block holds only the logo -> detected as an empty panel and penalised in the score', async () => {
    const banner = flattenFor(byId('events_headline_poster'), 'banner');
    const empty = emptyPanels(banner, copy);
    assert.ok(empty.some((e) => e.id === 'band-top' && e.share > 0.15), JSON.stringify(empty));
    const { profile } = await photoProfile(1200, 300, copy, 'web_ad');
    const base = scoreComposition(banner, 'base', { ...profile, picture: null });
    assert.ok(base.reasons.some((r) => r.startsWith('empty panel')), base.reasons.join(' | '));
    const clean = scoreComposition({ ...banner, layers: banner.layers.filter((l) => l.id !== 'band-top') }, 'base', { ...profile, picture: null });
    assert.ok(clean.score > base.score + 0.2, `${clean.score} vs ${base.score}`);
  });
  it('with an approved photograph the empty block becomes the picture (photo-panel), ranked above the empty version', async () => {
    const { profile } = await photoProfile(1200, 300, copy, 'web_ad');
    const ranked = rankCompositions([byId('events_headline_poster')], profile);
    const pp = ranked.find((c) => c.variant === 'photo-panel');
    assert.ok(pp, ranked.map((c) => c.variant).join(','));
    const photoLayer = pp!.template.layers.find((l) => l.type === 'image')!;
    assert.deepEqual((photoLayer as Extract<Layer, { type: 'image' }>).box.map((x) => Math.round(x * 100)), [0, 0, 25, 100]);
    assert.ok(pp!.score > ranked.find((c) => c.variant === 'base')!.score);
    assert.equal(emptyPanels(pp!.template, copy).length, 0);
  });
  it('the design preflight fails a rendered creative with an empty panel (and passes the photo-panel version)', async () => {
    const empty = await design(flattenFor(byId('events_headline_poster'), 'banner'), 1200, 300, copy);
    assert.equal(check(empty.pre, 'empty_panel')?.status, 'fail', String(check(empty.pre, 'empty_panel')?.detail));
    const { profile, pic } = await photoProfile(1200, 300, copy, 'web_ad');
    const pp = rankCompositions([byId('events_headline_poster')], profile).find((c) => c.variant === 'photo-panel')!;
    const filled = await design(pp.template, 1200, 300, copy, { hero: pic, photo: true });
    assert.equal(check(filled.pre, 'empty_panel')?.status, 'pass');
  });
  it('the space of empty text slots goes to the headline instead of staying a hole (text reflow)', () => {
    const t = flattenFor(byId('events_event_promo'), 'landscape');
    const c = { headline: 'Ti biraš mesto za društvo?', support: 'Sledeći susret može da bude na krovu.', cta: 'Pogledaj @giardinoclub' };
    const r = reflowText(t, c, 1200, 628);
    const h0 = t.layers.find((l) => l.id === 'headline') as Extract<Layer, { type: 'text' }>;
    const h1 = r.layers.find((l) => l.id === 'headline') as Extract<Layer, { type: 'text' }>;
    assert.ok(h1.size.max > h0.size.max * 1.2, 'larger headline type');
    const cta0 = t.layers.find((l) => l.id === 'cta') as Extract<Layer, { type: 'button' }>;
    const cta1 = r.layers.find((l) => l.id === 'cta') as Extract<Layer, { type: 'button' }>;
    assert.ok(Math.abs(cta1.box[1] - cta0.box[1]) < 1e-6, 'the button keeps its place');
    // with a date and a place there is no hole: nothing changes
    assert.deepEqual(reflowText(t, { ...c, date: 'SUB 14. JUN', location: 'Krov TC Bazar' } as never, 1200, 628).layers, t.layers);
  });
});

// ---- 3. photo first --------------------------------------------------------------------------------------------------------------------------

describe('3. photo first: an approved photograph fills the fast-scroll frame', () => {
  const copy = { headline: 'Evo gde je Giardino.', cta: 'Pogledaj @giardinoclub', brand: 'Giardino' };
  it('on a TikTok cover every photo-free composition is a hard problem; the full-bleed photo cover ranks first', async () => {
    const { profile } = await photoProfile(1080, 1920, copy, 'social_post', true);
    const ranked = rankCompositions(LIB, profile);
    const top = ranked[0];
    assert.ok(top.template.layers.some((l) => l.type === 'image' && l.slot === 'hero'), `${top.templateId}:${top.variant}`);
    assert.equal(top.templateId, 'events_photo_cover');
    const poster = ranked.find((c) => c.templateId === 'events_headline_poster' && c.variant === 'base')!;
    assert.ok(poster.hard.some((h) => h.startsWith('photo_first')), poster.hard.join(' | '));
  });
  it('the photograph weighs more on a fast-scroll format than in a feed', async () => {
    const { profile } = await photoProfile(1080, 1920, copy, 'social_post', false);
    const feed = scoreComposition(flattenFor(byId('events_photo_cover'), 'story'), 'base', profile);
    const fast = scoreComposition(flattenFor(byId('events_photo_cover'), 'story'), 'base', { ...profile, fastScroll: true });
    assert.ok(fast.score > feed.score);
    const posterFeed = scoreComposition(flattenFor(byId('events_headline_poster'), 'story'), 'base', profile);
    const posterFast = scoreComposition(flattenFor(byId('events_headline_poster'), 'story'), 'base', { ...profile, fastScroll: true });
    assert.ok(posterFast.score < posterFeed.score, 'type filling a fast-scroll frame without the photo costs more');
  });
  it('a typography-only TikTok cover while a photograph exists fails the photo_use check; the photo cover passes it', async () => {
    const budget = { maxWords: VISUAL_TEXT_BUDGET.tiktok.maxWords, maxBlocks: VISUAL_TEXT_BUDGET.tiktok.maxBlocks };
    const poster = await design(flattenFor(byId('events_headline_poster'), 'story'), 1080, 1920, copy, { fastScroll: true, budget, photo: true });
    assert.equal(check(poster.pre, 'photo_use')?.status, 'fail');
    const cover = await design(flattenFor(byId('events_photo_cover'), 'story'), 1080, 1920, copy, { hero: (await photoProfile(1, 1, copy)).pic, fastScroll: true, budget, photo: true });
    assert.equal(check(cover.pre, 'photo_use')?.status, 'pass', String(check(cover.pre, 'photo_use')?.detail));
    assert.notEqual(designStatus(cover.pre), 'unresolved');
  });
  it('an attempt without a critical failure beats one with it (a photo design with a warning is not discarded for a "clean" photo-free one)', () => {
    const att = (failures: { id: string; category: string }[]) => ({ templateId: 't', res: { report: { hero: null } } as never, tune: {}, actions: [], pre: { passed: !failures.length, checks: [], failures: failures.map((f) => ({ ...f, status: 'fail', detail: '' })) } as never });
    assert.equal(isBetter(att([{ id: 'subject_visibility', category: 'occlusion' }]), att([{ id: 'face_crop', category: 'crop' }])), true);
    assert.equal(isBetter(att([{ id: 'face_crop', category: 'crop' }]), att([{ id: 'subject_visibility', category: 'occlusion' }])), false);
  });
});

// ---- 4. logo treatment -------------------------------------------------------------------------------------------------------------------

describe('4. the logo is not put on an ugly box when a better option exists', () => {
  const copy = { headline: 'Ti predloži krov.', support: 'Giardino je na krovu TC Bazar.', cta: 'Pogledaj @giardinoclub', brand: 'Giardino' };
  it('a white single-colour wordmark is recognised as recolourable; a two-colour logo is not', async () => {
    const w = await sharp(await whiteLogo()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(monochromeLogo(w.data, w.info.width, w.info.height), true);
    const c = await sharp(await colourLogo()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(monochromeLogo(c.data, c.info.width, c.info.height), false);
  });
  it('the ticket template has a white plate behind the logo: a white logo on a dark photo is drawn directly (the plate is left out, no dark box)', async () => {
    const res = await renderTemplate({ template: flattenFor(byId('events_event_promo'), 'square'), width: 1080, height: 1080, content: copy, palette: PALETTE, styleId: 'dynamic_events', anchors: ANCHORS, brandName: 'Giardino', images: { hero: await flat('#1b1d24', 1600, 1066) }, logo: await whiteLogo(), logoAdapt: true });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.report.logo?.treatment, 'direct');
    assert.ok(res.flags.includes('logo_plate_dropped'), res.flags.join(' '));
    assert.ok(!res.flags.includes('logo_plate_recoloured'));
    assert.ok(res.report.logo!.contrast >= 2.2);
  });
  it('a white logo on a bright photo is recoloured to the dark brand tone (not boxed)', async () => {
    const res = await renderTemplate({ template: flattenFor(byId('events_event_promo'), 'square'), width: 1080, height: 1080, content: copy, palette: PALETTE, styleId: 'dynamic_events', anchors: ANCHORS, brandName: 'Giardino', images: { hero: await flat('#e9eef2', 1600, 1066) }, logo: await whiteLogo(), logoAdapt: true });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.report.logo?.treatment, 'recoloured');
    assert.ok(!res.flags.some((f) => f === 'logo_plate_recoloured' || f === 'logo_plate_added'), res.flags.join(' '));
    assert.ok(res.report.logo!.contrast >= 2.2);
  });
  it('a box is the last resort (a multi-colour logo on a mid-grey picture) and the QA reports it', async () => {
    const tpl = flattenFor(byId('events_photo_cover'), 'square');
    const best = await design(tpl, 1080, 1080, copy, { hero: await flat('#7f7f86', 1600, 1066), logo: await colourLogo(), photo: true });
    const lg = best.res.report.logo!;
    if (lg.treatment === 'plate_added') assert.equal(check(best.pre, 'logo_treatment')?.status, 'warn');
    else assert.ok(['direct', 'recoloured'].includes(lg.treatment!), String(lg.treatment));
  });
});

// ---- 5. natural venue copy ---------------------------------------------------------------------------------------------------------------

describe('5. nightlife / venue copy avoids stiff promotional language', () => {
  it('catches the TYPE of bad line, not one sentence: age-limit hooks, strategy words, stiff verbs, clichés', () => {
    const types = (s: string) => unnaturalPhrases(s).map((h) => h.type).sort();
    assert.deepEqual(types('Punoletni ste i planirate izlazak?'), ['age_hook', 'bureaucratic']);
    assert.deepEqual(types('Ako ste stariji od 18, ovo je za vas.'), ['age_hook']);
    assert.deepEqual(types('Tu komunikaciju usmeravamo isključivo punoletnoj publici.'), ['age_hook', 'strategy']);
    assert.deepEqual(types('Giardino navodi salate, italijanske klasike i jela od mesa.'), ['bureaucratic']);
    assert.deepEqual(types('Nezaboravno iskustvo na savršenom mestu za izlazak.'), ['cliche']);
    assert.deepEqual(types('If you are of legal age, this is the perfect place to unwind.'), ['age_hook', 'cliche']);
    // natural local copy passes
    for (const ok of ['Petak uveče? Vidimo se na krovu.', 'Ručak s društvom, pogled na grad.', 'Ti predloži krov.', 'Giardino je na krovu TC Bazar.', 'Friday night on the roof. See you there.']) assert.deepEqual(unnaturalPhrases(ok), [], ok);
  });
  it('the Quality Reviewer\'s copy checks report an unnatural hook as a major tone finding (the repair loop rewrites it)', () => {
    const out = copyCraftFindings({ variants: [variant({ id: 'V12', channel: 'tiktok', headline: 'Punoletni ste i planirate izlazak?' }), variant({ id: 'V2', channel: 'facebook', headline: 'Petak uveče? Vidimo se na krovu.' })], plan: null, corpus: 'Punoletnoj publici predstaviti vikend program.' });
    const tone = out.filter((f) => f.kind === 'brand_tone');
    assert.equal(tone.length, 1, JSON.stringify(tone));
    assert.equal(tone[0].assetRef, 'V12');
    assert.equal(tone[0].severity, 'major');
  });
  it('the writer is told how a venue speaks (an age limit is a note, never the hook) and the revision may never write a placeholder', () => {
    assert.match(CREATIVE_INSTRUCTIONS.writer, /An age limit \(18\+, adults only\) is a legal note, never the hook/);
    assert.match(CREATIVE_INSTRUCTIONS.writer, /social, urban, local and inviting/);
    assert.match(REVISION_RULES, /never replace a headline, text or call to action with a note or placeholder/);
  });
  it('"Izostavljeno iz kampanje" is a placeholder: refused as a revision and never printed on a visual', () => {
    for (const p of ['Izostavljeno iz kampanje', 'Izostavljeno', 'Omitted from the campaign', 'N/A', 'Not applicable']) assert.equal(isPlaceholderCopy(p), true, p);
    for (const ok of ['Ručak sa kolegama? Kreni od ponude.', 'Nema bolje terase u gradu.', 'Na krovu.']) assert.equal(isPlaceholderCopy(ok), false, ok);
    assert.equal(refusedRevision({ ctaText: 'Pogledaj @giardinoclub' }, { headline: 'Izostavljeno iz kampanje', body: 'x', ctaText: '' }), true);
    assert.equal(refusedRevision({ ctaText: 'Pogledaj @giardinoclub' }, { headline: 'Ručak sa kolegama?', body: 'x', ctaText: '' }), true, 'the call to action may not disappear');
    assert.equal(refusedRevision({ ctaText: 'Pogledaj @giardinoclub' }, { headline: 'Ručak sa kolegama?', body: 'x', ctaText: 'Pogledaj meni' }), false);
    assert.equal(contentForSlot({ conceptId: 'K1', channel: 'linkedin', kind: 'social_post' }, [{ id: 'K1', name: 'K' }], [variant({ id: 'V5', channel: 'linkedin', headline: 'Izostavljeno iz kampanje' })]), null);
  });
});

// ---- 6. relevant pictures ----------------------------------------------------------------------------------------------------------------

describe('6. pictures are matched to the concept\'s motif (rooftop, night, food, people, city)', () => {
  it('motifs are read from Serbian and English words and from the pixels', () => {
    assert.ok(motifsOf('Dogovor je na krovu').has('rooftop'));
    assert.ok(motifsOf('Kad je plan izlazak: vikend klupski program').has('night'));
    assert.ok(motifsOf('Druženje počinje za stolom: ručak').has('food'));
    assert.ok(motifsOf('rooftop-terrace_view.jpg').has('rooftop'));
    assert.ok(pixelMotifs({ brightness: 0.12, colors: ['#15000a'] } as never).has('night'));
    assert.ok(pixelMotifs({ brightness: 0.48, colors: ['#bacfec', '#040809'] } as never).has('rooftop'));
  });
  it('a rooftop concept gets the sky picture and a night-out concept the dark club picture, although both files are called DSC....jpg', () => {
    const sky = { id: 'sky', score: 0.5, text: 'DSC04346', width: 1620, height: 1080, analysis: { brightness: 0.48, colors: ['#bacfec', '#040809', '#1f1819'] } as never };
    const club = { id: 'club', score: 0.5, text: 'DSC04156', width: 1620, height: 1080, analysis: { brightness: 0.08, colors: ['#15000a', '#54000c'] } as never };
    assert.ok(motifFit(sky, ['Dogovor je na krovu']) > motifFit(club, ['Dogovor je na krovu']));
    const a = allocateImages({ concepts: [{ id: 'K1', words: ['Dogovor je na krovu', 'pogled na grad'] }, { id: 'K3', words: ['Kad je plan izlazak', 'vikend klupski program'] }], slots: [{ slotId: 'K1-x', conceptId: 'K1', index: 1, formatClass: 'landscape' }, { slotId: 'K3-x', conceptId: 'K3', index: 1, formatClass: 'landscape' }], images: [club, sky], maxPerConcept: 1 });
    assert.equal(a.slots.find((s) => s.slotId === 'K1-x')!.imageId, 'sky');
    assert.equal(a.slots.find((s) => s.slotId === 'K3-x')!.imageId, 'club');
  });
});

// ---- 7. QA ----------------------------------------------------------------------------------------------------------------------------

describe('7. the QA reports these problems', () => {
  it('too much text on a TikTok cover fails text_density; the composition checks are reported as composition issues', async () => {
    const copy = { headline: 'Punoletni ste i planirate izlazak? Upoznajte i večernju stranu Giardina na krovu', eyebrow: 'Kad je plan izlazak', support: 'Giardino ima i vikend klupski program za punoletne goste.', cta: 'Pogledaj Instagram profil @giardinoclub.', brand: 'Giardino' };
    const best = await design(flattenFor(byId('events_headline_poster'), 'story'), 1080, 1920, copy, { fastScroll: true, budget: { maxWords: VISUAL_TEXT_BUDGET.tiktok.maxWords, maxBlocks: VISUAL_TEXT_BUDGET.tiktok.maxBlocks }, photo: true });
    const td = check(best.pre, 'text_density')!;
    assert.equal(td.status, 'fail', td.detail);
    assert.match(td.detail, /Too much text for this platform/);
    assert.equal(DESIGN_ISSUE.composition, 'composition_issue');
  });
  it('a colour the renderer already corrected is not reported as low contrast; a contrast that stays low still is', () => {
    const asset = (flags: string[]) => ({ id: `a-${flags.join('-')}`, kind: 'layout', status: 'rendered', format: 'instagram_square', width: 1080, height: 1080, flags });
    const out = assetFindings({ board: { assets: [asset(['low_contrast_adjusted:cta', 'low_contrast_adjusted:logo:name']), asset(['low_contrast_unresolved:headline']), asset(['low_contrast_3.1'])], concepts: [], layouts: [], variants: [] } as never, hasLogo: true, hasPalette: true }).filter((f) => f.kind === 'low_contrast');
    assert.deepEqual(out.map((f) => f.assetRef), ['a-low_contrast_unresolved:headline', 'a-low_contrast_3.1']);
  });
  it('a TikTok cover made by the new rules stays inside its budget', async () => {
    const c = renderContent(withTextBudget({ headline: 'Evo gde je Giardino.', support: 'Upoznaj prostor na krovu TC Bazar.', eyebrow: 'Dogovor je na krovu', cta: 'Pogledaj Instagram profil @giardinoclub.', variantId: 'V2', ctaOptions: ['Pogledaj @giardinoclub'] }, VISUAL_TEXT_BUDGET.tiktok, 'Pogledaj @giardinoclub'), 'Giardino', {});
    const best = await design(flattenFor(byId('events_photo_cover'), 'story'), 1080, 1920, c as never, { hero: (await photoProfile(1, 1, { headline: 'x' })).pic, fastScroll: true, budget: { maxWords: VISUAL_TEXT_BUDGET.tiktok.maxWords, maxBlocks: VISUAL_TEXT_BUDGET.tiktok.maxBlocks }, photo: true });
    assert.equal(check(best.pre, 'text_density')?.status, 'pass', String(check(best.pre, 'text_density')?.detail));
    assert.equal(check(best.pre, 'empty_panel')?.status, 'pass');
  });
});
