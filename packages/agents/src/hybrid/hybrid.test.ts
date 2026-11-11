import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { InMemoryAssetStore } from '../creative/assets';
import { CREATIVE_FORMATS } from '../creative/formats';
import type { AssetRecord } from '../creative/schemas';
import { CAMPAIGN_SCHEMA_VERSION, CampaignPackage } from '../creative/schemas';
import { CANVAS as C, button, defineTemplate, fill, img, logo, text } from '../templates/dsl';
import type { TemplateDef, StyleId } from '../templates/schema';
import { formatClassOf } from '../templates/schema';
import { buildVisualDirection } from '../templates/visual-direction';
import { renderContent, supportingTextOf } from './content';
import { directionFor } from './direction';
import { HYBRID_FORMATS, evenThenWeighted, planHybrid, slotsFromSelection } from './plan';
import { ASSET_ORIGINS, RIGHTS_BY_ORIGIN, originOf, type TemplateCreativeRecord } from './records';
import { hybridCounts } from './report';
import { verifyTemplateExport } from './quality';
import { mergeHybrid, HYBRID_DEFAULTS } from './settings';
import { applyAssisted, availableFor, blockers, hasWord, objectiveKind, selectTemplates, stableHash, type SelectorContext } from './selector';
import type { TemplateContent } from './records';

// Pure planning, selection and verification of Hybrid Production. No model, no network, no files.

const concepts = (n: number, channels: ('instagram' | 'facebook' | 'linkedin')[] = ['instagram', 'facebook']) => Array.from({ length: n }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels }));
const base = { channelPriority: ['instagram', 'facebook', 'linkedin'] as ('instagram' | 'facebook' | 'linkedin')[], fixedSize: null, brandImages: 0, basis: 'concepts' as const };

/** A minimal valid template with a hero picture, a headline and a logo; the options change what it requires and where it works. */
function tpl(id: string, o: { classes?: TemplateDef['classes']; requires?: TemplateDef['requires']; styles?: StyleId[]; family?: TemplateDef['family']; image?: boolean; industries?: string[]; channels?: TemplateDef['channels']; sample?: string } = {}): TemplateDef {
  const classes = o.classes ?? ['square', 'portrait', 'story', 'landscape'];
  const layers = [
    fill('bg', 'paper'),
    ...(o.image === false ? [] : [img('photo', 'hero', [0, 0, 1, 0.6], { fallback: 'brandPattern' })]),
    text('headline', 'headline', [0.08, 0.64, 0.84, 0.2], { size: [0.07, 0.04], lines: 3, weight: 800 }),
    ...(o.requires?.includes('offer') ? [text('offer', 'offer', [0.08, 0.5, 0.4, 0.1], { size: [0.05, 0.03], lines: 1 })] : []),
    button('cta', [0.08, 0.86, 0.4, 0.07]),
    logo('logo', [0.08, 0.04, 0.3, 0.07]),
  ];
  return defineTemplate({
    id,
    name: `Template ${id}`,
    version: 1,
    status: 'active',
    category: 'tech_saas',
    description: `Synthetic test template ${id} for the selector.`,
    styles: o.styles ?? ['minimalist_tech'],
    industries: o.industries ?? ['*'],
    channels: o.channels ?? [],
    classes,
    requires: o.requires ?? (o.image === false ? [] : ['image']),
    density: 'balanced',
    family: o.family ?? 'full-bleed',
    composition: 'A synthetic composition used only by the tests.',
    sample: { headline: o.sample ?? 'A sample headline', cta: 'Go' },
    tone: 'light',
    layers,
  });
}

const direction = (style: StyleId = 'minimalist_tech') => buildVisualDirection({ projectName: 'Test', channels: ['instagram'], brandPalette: ['#3157d5'], userStyleId: style });
const ctxOf = (library: TemplateDef[], o: Partial<SelectorContext> = {}): SelectorContext => ({ direction: direction(), industryText: 'saas software', objectiveText: 'sign up', palette: ['#3157d5', '#14213d'], hasLogo: false, brandName: 'Test', facts: {}, library, preferred: [], overrides: {}, mode: 'automatic', basis: 'concepts', ...o });
const contentOf = (headline = 'A clear headline'): TemplateContent => ({ headline, support: 'A supporting line', cta: 'Go', eyebrow: null, variantId: 'V1' });

describe('Hybrid settings', () => {
  it('the defaults are 5 originals + 15 template creatives for 5 concepts', () => {
    const h = mergeHybrid({});
    assert.equal(h.originals, 5);
    assert.equal(h.templateCreatives, 15);
    assert.deepEqual(HYBRID_DEFAULTS, { originals: 5, templateCreatives: 15, concepts: 5 });
    assert.equal(h.allowTemplateFallback, false, 'a picture-free fallback is never silent');
    assert.equal(h.selection, 'automatic');
  });
  it('rejects out-of-range values with a message instead of clamping them silently', () => {
    assert.throws(() => mergeHybrid({ originals: 99 }), /originals/);
    assert.throws(() => mergeHybrid({ templateCreatives: -1 }), /templateCreatives/);
    assert.throws(() => mergeHybrid({ style: 'not-a-style' }), /style/);
  });
  it('facts keep only non-empty text and unknown keys are ignored', () => {
    const h = mergeHybrid({ facts: { offer: ' 20% off ', date: '   ' }, bogus: 1 } as never);
    assert.deepEqual(h.facts, { offer: '20% off' });
  });
});

describe('Hybrid quota planning', () => {
  it('default: 5 concepts x (1 original + 3 template creatives) = exactly 5 + 15 = 20', () => {
    const p = planHybrid({ ...base, concepts: concepts(5), originals: 5, templateCreatives: 15 });
    assert.equal(p.allocation.allocated, 5);
    assert.equal(p.slots.length, 15);
    for (const c of p.perConcept) {
      assert.equal(c.originals, 1);
      assert.equal(c.templates, 3);
    }
    assert.equal(p.allocation.allocated + p.slots.length, 20);
    // every creative is built from the original of ITS OWN concept
    for (const s of p.slots) assert.equal(p.allocation.variations.find((v) => v.variationId === s.variationId)?.conceptId, s.conceptId);
    assert.equal(new Set(p.slots.map((s) => s.slotId)).size, 15, 'slot ids are unique');
    assert.equal(p.allocation.expectedLayouts, 15);
  });
  it('is configurable: other counts are honoured exactly, never silently reduced', () => {
    for (const [o, t] of [[8, 12], [3, 20], [10, 30], [0, 6], [5, 0], [1, 1]] as const) {
      const p = planHybrid({ ...base, concepts: concepts(5), originals: o, templateCreatives: t });
      assert.equal(p.allocation.allocated, o, `originals ${o}`);
      assert.equal(p.slots.length, t, `templates ${t}`);
    }
  });
  it('fewer originals than concepts: the concepts without an original use brand images or no picture, and the plan says so', () => {
    const p = planHybrid({ ...base, concepts: concepts(5), originals: 2, templateCreatives: 15 });
    const without = p.slots.filter((s) => !s.variationId);
    assert.ok(without.length > 0);
    assert.ok(without.every((s) => s.source === 'none'));
    assert.ok(p.warnings.some((w) => /no AI original/.test(w)));
    const withBrand = planHybrid({ ...base, concepts: concepts(5), originals: 2, templateCreatives: 15, brandImages: 3 });
    assert.ok(withBrand.slots.filter((s) => !s.variationId).every((s) => s.source === 'brand_image'));
  });
  it('the remainder goes to the concepts with the best channels, the total stays exact', () => {
    assert.deepEqual(evenThenWeighted(14, [3, 2, 2, 2, 1], 6), [3, 3, 3, 3, 2]);
    assert.equal(evenThenWeighted(7, [1, 1, 1], 10).reduce((a, b) => a + b, 0), 7);
    assert.deepEqual(evenThenWeighted(0, [1, 2], 3), [0, 0]);
  });
  it('channels and formats take turns inside a concept and every format belongs to its channel', () => {
    const p = planHybrid({ ...base, concepts: concepts(2, ['instagram', 'linkedin']), originals: 2, templateCreatives: 8 });
    for (const c of ['K1', 'K2']) {
      const mine = p.slots.filter((s) => s.conceptId === c);
      assert.ok(new Set(mine.map((s) => s.channel)).size >= 2, 'both channels are served');
      assert.ok(new Set(mine.slice(0, 3).map((s) => s.formatId)).size === 3, 'the first three creatives of a concept use three different formats');
    }
    for (const s of p.slots) {
      assert.ok(HYBRID_FORMATS[s.channel].includes(s.formatId));
      assert.equal(s.width, CREATIVE_FORMATS[s.formatId].width);
      assert.equal(s.formatClass, formatClassOf(s.width, s.height));
    }
  });
  it('an original is sized for the formats built from it (a story/portrait creative asks for a tall picture)', () => {
    const p = planHybrid({ ...base, concepts: concepts(1, ['instagram']), originals: 1, templateCreatives: 3 });
    const v = p.allocation.variations[0];
    assert.deepEqual([...v.formats].sort(), [...new Set(p.slots.map((s) => s.formatId))].sort());
    assert.ok(['1024x1536', '1024x1024'].includes(v.size));
    const fixed = planHybrid({ ...base, concepts: concepts(1, ['instagram']), originals: 1, templateCreatives: 3, fixedSize: '1536x1024' });
    assert.equal(fixed.allocation.variations[0].size, '1536x1024', 'a size the user chose is kept');
  });
  it('is deterministic', () => {
    const a = planHybrid({ ...base, concepts: concepts(5), originals: 5, templateCreatives: 15 });
    const b = planHybrid({ ...base, concepts: concepts(5), originals: 5, templateCreatives: 15 });
    assert.deepEqual(a, b);
  });
  it('slotsFromSelection restores the slots of an earlier plan (used by a continuation)', () => {
    const p = planHybrid({ ...base, concepts: concepts(2), originals: 2, templateCreatives: 4 });
    const lib = [tpl('lib_a'), tpl('lib_b'), tpl('lib_c', { family: 'split' }), tpl('lib_d', { family: 'band' })];
    const sel = selectTemplates({ slots: p.slots, contents: new Map(p.slots.map((s) => [s.slotId, contentOf()])), ctx: ctxOf(lib) });
    assert.deepEqual(slotsFromSelection(sel.plan.items).map((s) => s.slotId), p.slots.map((s) => s.slotId));
  });
});

describe('Template selector', () => {
  const plan = planHybrid({ ...base, concepts: concepts(3), originals: 3, templateCreatives: 9 });
  const contents = new Map(plan.slots.map((s) => [s.slotId, contentOf()]));
  const library = [tpl('t_a'), tpl('t_b', { family: 'split' }), tpl('t_c', { family: 'band' }), tpl('t_d', { family: 'frame' }), tpl('t_e', { family: 'centered' }), tpl('t_f', { family: 'diagonal' }), tpl('t_g', { family: 'panel' }), tpl('t_h', { family: 'collage' }), tpl('t_i', { family: 'poster-type' }), tpl('t_j', { family: 'stat-focus' })];

  it('is deterministic: the same inputs give the same plan', () => {
    const a = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(library) });
    const b = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(library) });
    assert.deepEqual(a.plan, b.plan);
    assert.equal(a.plan.items.length, 9);
    assert.equal(stableHash('x'), stableHash('x'));
  });
  it('only uses templates of the library and only ones designed for the slot\'s format class', () => {
    const lib = [tpl('wide_only', { classes: ['landscape'] }), tpl('tall_only', { classes: ['story', 'portrait'] }), tpl('square_one', { classes: ['square'] }), tpl('any')];
    const r = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(lib) });
    const ids = new Set(lib.map((t) => t.id));
    for (const it of r.plan.items) {
      assert.ok(ids.has(it.templateId));
      const t = lib.find((x) => x.id === it.templateId)!;
      assert.ok(t.classes.includes(it.formatClass), `${it.templateId} is not designed for ${it.formatClass}`);
    }
  });
  it('a template that needs content only the user can give (an offer) is not chosen without it, and is chosen with it', () => {
    const offerTpl = tpl('offer_card', { requires: ['image', 'offer'], styles: ['minimalist_tech'] });
    const lib = [offerTpl, tpl('plain_a'), tpl('plain_b', { family: 'split' }), tpl('plain_c', { family: 'band' })];
    const without = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(lib) });
    assert.ok(!without.plan.items.some((i) => i.templateId === 'offer_card'));
    const withOffer = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(lib, { facts: { offer: '20% off' }, objectiveText: 'increase sales' }) });
    assert.ok(withOffer.plan.items.some((i) => i.templateId === 'offer_card'));
  });
  it('a slot without a picture never gets a template that requires one', () => {
    const p = planHybrid({ ...base, concepts: concepts(2), originals: 0, templateCreatives: 4 });
    const c = new Map(p.slots.map((s) => [s.slotId, contentOf()]));
    const lib = [tpl('needs_pic'), tpl('no_pic_a', { image: false, family: 'poster-type' }), tpl('no_pic_b', { image: false, family: 'centered' })];
    const r = selectTemplates({ slots: p.slots, contents: c, ctx: ctxOf(lib) });
    assert.ok(r.plan.items.length === 4);
    assert.ok(r.plan.items.every((i) => i.templateId !== 'needs_pic'));
  });
  it('repetition is penalized: with enough templates the campaign does not repeat a template', () => {
    const r = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(library) });
    const counts = Object.values(r.plan.byTemplate);
    assert.ok(counts.every((n) => n === 1), JSON.stringify(r.plan.byTemplate));
    assert.equal(Object.values(r.plan.byTemplate).reduce((a, b) => a + b, 0), 9);
  });
  it('with too few templates a repeat is allowed but reported', () => {
    const r = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf([tpl('only_one')]) });
    assert.equal(r.plan.items.length, 9);
    assert.ok(r.plan.warnings.some((w) => /more than once/.test(w)));
  });
  it('the style matters: a template of the chosen style wins over an equal one of another style', () => {
    const lib = [tpl('wrong', { styles: ['luxury_hospitality'] }), tpl('right', { styles: ['minimalist_tech'] })];
    const one = planHybrid({ ...base, concepts: concepts(1), originals: 1, templateCreatives: 1 });
    const r = selectTemplates({ slots: one.slots, contents: new Map([[one.slots[0].slotId, contentOf()]]), ctx: ctxOf(lib) });
    assert.equal(r.plan.items[0].templateId, 'right');
    assert.match(r.plan.items[0].rationale, /style/i);
  });
  it('a valid manual override wins; an invalid one is reported and the automatic choice is used', () => {
    const slot = plan.slots[0].slotId;
    const ok = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(library, { overrides: { [slot]: 't_j' }, mode: 'manual' }) });
    const it = ok.plan.items.find((i) => i.slotId === slot)!;
    assert.equal(it.templateId, 't_j');
    assert.equal(it.origin, 'user_override');
    const lib = [...library, tpl('story_only', { classes: ['story'] })];
    const squareSlot = plan.slots.find((s) => s.formatClass !== 'story')!;
    const bad = selectTemplates({ slots: plan.slots, contents, ctx: ctxOf(lib, { overrides: { [squareSlot.slotId]: 'story_only', K9: 'nope' } }) });
    const item = bad.plan.items.find((i) => i.slotId === squareSlot.slotId)!;
    assert.notEqual(item.templateId, 'story_only');
    assert.equal(item.origin, 'deterministic');
    assert.ok(bad.plan.warnings.some((w) => w.includes('story_only') && /not designed for/.test(w)), bad.plan.warnings.join('|'));
  });
  it('assisted mode: a model\'s picks are accepted only from the slot\'s shortlist and never override the user', () => {
    const slots = plan.slots;
    const sel = selectTemplates({ slots, contents, ctx: ctxOf(library, { overrides: { [slots[0].slotId]: 't_j' } }) });
    const s1 = slots[1].slotId;
    const shortlist = sel.shortlists.get(s1)!;
    const alt = shortlist.find((c) => c.template.id !== sel.plan.items.find((i) => i.slotId === s1)!.templateId)!;
    const r = applyAssisted(sel, [
      { slotId: s1, templateId: alt.template.id, reason: 'fits the concept' },
      { slotId: slots[0].slotId, templateId: 't_a', reason: 'ignored: the user chose this one' },
      { slotId: slots[2].slotId, templateId: 'invented_template', reason: 'not in the library' },
      { slotId: 'K9-T9', templateId: 't_a', reason: 'unknown slot' },
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.plan.items.find((i) => i.slotId === s1)!.templateId, alt.template.id);
    assert.equal(r.plan.items.find((i) => i.slotId === s1)!.origin, 'assisted');
    assert.equal(r.plan.items.find((i) => i.slotId === slots[0].slotId)!.templateId, 't_j', 'the user\'s choice is kept');
    assert.ok(r.rejected.length >= 2);
    assert.equal(r.plan.mode, 'assisted');
  });
  it('availability and blockers say exactly what is missing', () => {
    const t = tpl('offer_t', { requires: ['image', 'offer'] });
    const slot = plan.slots[0];
    const have = availableFor(slot, contentOf(), { hasLogo: false, brandName: 'B', facts: {} });
    assert.deepEqual(blockers(t, slot, have), ['needs offer']);
    const withFact = availableFor(slot, contentOf(), { hasLogo: false, brandName: 'B', facts: { offer: '10%' } });
    assert.deepEqual(blockers(t, slot, withFact), []);
    assert.deepEqual(blockers({ ...t, status: 'draft' }, slot, withFact), ['status is draft']);
  });
  it('industry keywords match whole words only, so unrelated words do not count as a hit', () => {
    assert.equal(hasWord('scuba diving school teaches beginners', 'tea'), false);
    assert.equal(hasWord('training for beginners', 'ai'), false);
    assert.equal(hasWord('a tea shop', 'tea'), true);
    assert.equal(hasWord('cafes and bakeries', 'cafe'), true, 'a plural s is accepted');
    assert.equal(hasWord('online e-commerce store', 'e-commerce'), true);
    assert.equal(hasWord('our ai assistant', 'ai'), true);
  });
  it('objective keywords are read in English and Serbian', () => {
    assert.equal(objectiveKind('Increase online sales'), 'conversion');
    assert.equal(objectiveKind('Povećati prodaju'), 'conversion');
    assert.equal(objectiveKind('Brand awareness for the launch'), 'awareness');
    assert.equal(objectiveKind('hello'), null);
  });
  it('directionFor builds a valid brief from the strategy and keeps Pinterest and link references out of it', () => {
    const d = directionFor({
      visualBrief: { business: 'Café Aroma', offering: 'specialty coffee and cakes', valueProposition: '', campaignGoal: 'more visits', audience: { primary: 'locals', secondary: [], segments: [] }, brand: { tone: 'warm', visualDirection: 'natural light', constraints: [], palette: [], observed: [] }, locale: { geography: [], language: 'en' }, channels: [], avoid: [] },
      projectName: 'Café Aroma',
      channels: ['instagram'],
      palette: ['#6b4423'],
      hasBrandPalette: true,
      settings: { style: 'auto', inspiration: 'references', references: [{ id: 'pin-1', kind: 'pinterest_board', label: 'Pinterest pin (link only)', url: 'https://www.pinterest.com/pin/123/', permission: 'platform_restricted_not_stored' }, { id: 'link-1', kind: 'user_link', label: 'Link: example.com', url: 'https://example.com/x', permission: 'link_only_not_analyzed' }] },
      referencePalettes: { 'pin-1': ['#ff0000'], 'link-1': ['#00ff00'] },
    });
    assert.ok(d.references.some((r) => r.kind === 'pinterest_board' && /Not analyzed/.test(r.used)));
    assert.ok(!JSON.stringify(d.colors).includes('#ff0000') && !JSON.stringify(d.colors).includes('#00ff00'), 'no color of a restricted reference is used');
  });
});

describe('Content shown on a template creative', () => {
  it('uses the approved copy, the brand name and ONLY the facts the user supplied', () => {
    const c = renderContent({ headline: 'Fresh bread daily', support: 'Baked at dawn', cta: 'Visit us', eyebrow: 'Bakery', variantId: 'V1' }, 'Mill Bakery', { offer: '2 for 1' });
    assert.deepEqual(c, { headline: 'Fresh bread daily', support: 'Baked at dawn', cta: 'Visit us', eyebrow: 'Bakery', brand: 'Mill Bakery', offer: '2 for 1' });
    assert.equal('quote' in c, false, 'nothing is invented');
    assert.equal('support' in renderContent({ headline: 'H', support: 'S', cta: null, eyebrow: null, variantId: null }, 'B', {}, true), false);
  });
  it('trims a long supporting line at a word boundary', () => {
    const s = supportingTextOf({ description: null, body: 'word '.repeat(60) });
    assert.ok(s.length <= 110 && s.endsWith('…'));
  });
});

describe('Lineage and counters', () => {
  it('origins: a template render is never an AI image; old assets are read correctly', () => {
    assert.equal(originOf({ kind: 'image', source: 'ai_image' }), 'AI_GENERATED');
    assert.equal(originOf({ kind: 'image', source: 'brand_gradient' }), 'FALLBACK');
    assert.equal(originOf({ kind: 'layout', source: 'template_render' }), 'TEMPLATE_RENDERED');
    assert.equal(originOf({ kind: 'layout', source: 'ai_image' }), 'TEMPLATE_RENDERED', 'a layout is never "AI generated", even when its picture was');
    assert.equal(originOf({ kind: 'layout', source: 'template_render', origin: 'FALLBACK' }), 'FALLBACK');
    for (const o of ASSET_ORIGINS) assert.ok(RIGHTS_BY_ORIGIN[o].note.length > 10);
  });
  it('failed and skipped renders are never counted as delivered', () => {
    const rec = (slotId: string, status: TemplateCreativeRecord['status']): TemplateCreativeRecord => ({ slotId, conceptId: 'K1', templateId: 't', templateName: 'T', templateVersion: 1, variationId: 'K1-V1', channel: 'instagram', format: 'instagram_square', width: 1080, height: 1080, status, assetId: status === 'rendered' ? `a-${slotId}` : null, sourceAssetIds: [], origin: status === 'rendered' ? 'TEMPLATE_RENDERED' : null, flags: [], reason: status === 'rendered' ? null : 'because' });
    const board = {
      allocation: { allocated: 5 } as never,
      variations: [
        { status: 'generated' }, { status: 'generated' }, { status: 'generated' }, { status: 'failed' }, { status: 'blocked_by_budget' },
      ] as never,
      hybridPlan: { slots: Array.from({ length: 15 }, (_, i) => ({ slotId: `s${i}` })) } as never,
      templateCreatives: [...Array.from({ length: 10 }, (_, i) => rec(`s${i}`, 'rendered')), rec('s10', 'failed'), rec('s11', 'skipped'), rec('s12', 'fallback_rendered')],
    };
    const c = hybridCounts({ board, imageRequests: 4, text: { calls: 3, inputTokens: 10, outputTokens: 5 }, cost: null });
    assert.deepEqual(c.originals, { planned: 5, requested: 4, generated: 3, failed: 1, skipped: 0, blockedByBudget: 1 });
    assert.deepEqual(c.templates, { planned: 15, rendered: 10, fallbackRendered: 1, failed: 1, skipped: 3 });
    assert.equal(c.total.planned, 20);
    assert.equal(c.total.delivered, 3 + 10 + 1, 'only real files are delivered');
  });
});

describe('Template quality verification', () => {
  const png = async (w: number, h: number, c = '#445566') => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
  const sel = (n: number) => ({
    mode: 'automatic' as const,
    basis: 'concepts' as const,
    styleId: 'minimalist_tech' as const,
    libraryCount: 3,
    eligibleCount: 3,
    byTemplate: {},
    byCategory: {},
    rules: [],
    warnings: [],
    items: Array.from({ length: n }, (_, i) => ({ slotId: `K1-T${i + 1}`, conceptId: 'K1', conceptName: 'C', index: i + 1, templateId: 't', templateName: 'T', templateVersion: 1, category: 'tech_saas' as const, family: 'split', variationId: 'K1-V1', sourceKind: 'ai_original' as const, channel: 'instagram' as const, format: 'instagram_square', formatClass: 'square' as const, width: 1080, height: 1080, content: contentOf(), rationale: 'r', score: 1, alternatives: [], origin: 'deterministic' as const })),
  });
  const asset = async (store: InMemoryAssetStore, o: Partial<AssetRecord> & { w?: number; h?: number; color?: string } = {}) =>
    store.save({ kind: 'layout', conceptId: 'K1', channel: 'instagram', format: 'instagram_square', version: 1, parentAssetId: 'orig', mimeType: 'image/png', width: o.w ?? 1080, height: o.h ?? 1080, source: 'template_render', model: null, quality: null, requestedSize: null, status: 'rendered', flags: [], altText: null, promptMetadata: null, usage: null, data: await png(o.w ?? 1080, o.h ?? 1080, o.color), origin: 'TEMPLATE_RENDERED', templateId: 't', templateVersion: 1, sourceAssetIds: ['orig'], ...o });
  const rec = (slotId: string, a: AssetRecord | null, status: TemplateCreativeRecord['status'] = 'rendered', reason: string | null = null): TemplateCreativeRecord => ({ slotId, conceptId: 'K1', templateId: 't', templateName: 'T', templateVersion: 1, variationId: 'K1-V1', channel: 'instagram', format: 'instagram_square', width: 1080, height: 1080, status, assetId: a?.id ?? null, sourceAssetIds: a?.sourceAssetIds ?? [], origin: a ? 'TEMPLATE_RENDERED' : null, flags: [], reason });

  it('a complete, honest export passes', async () => {
    const store = new InMemoryAssetStore();
    const a = await asset(store, { color: '#112233' });
    const b = await asset(store, { color: '#332211' });
    const r = await verifyTemplateExport({ selection: sel(2), creatives: [rec('K1-T1', a), rec('K1-T2', b)], assets: [a, b], load: (id) => store.load(id) });
    assert.equal(r.complete, true, r.summary);
    assert.equal(r.checkedFiles, 2);
    assert.deepEqual(r.issues, []);
  });
  it('reports a failed render, a missing outcome, a wrong size, missing lineage, a duplicate and a wrong label', async () => {
    const store = new InMemoryAssetStore();
    const ok = await asset(store, { color: '#112233' });
    const wrong = await asset(store, { w: 500, h: 500, color: '#223344' });
    const twin = await asset(store, { color: '#112233' });
    const noLineage = await asset(store, { color: '#556677', templateId: undefined, sourceAssetIds: undefined });
    const mislabeled = await asset(store, { color: '#778899', origin: 'AI_GENERATED' });
    const r = await verifyTemplateExport({
      selection: sel(8),
      creatives: [rec('K1-T1', ok), rec('K1-T2', wrong), rec('K1-T3', twin), rec('K1-T4', noLineage), rec('K1-T5', mislabeled), rec('K1-T6', null, 'failed', 'renderer refused'), rec('K1-T7', null, 'skipped', 'its original does not exist')],
      assets: [ok, wrong, twin, noLineage, mislabeled],
      load: (id) => store.load(id),
    });
    const kinds = r.issues.map((i) => `${i.slotId}:${i.kind}`);
    assert.ok(kinds.includes('K1-T2:wrong_dimensions'));
    assert.ok(kinds.includes('K1-T3:duplicate_output'));
    assert.ok(kinds.includes('K1-T4:missing_lineage'));
    assert.ok(kinds.includes('K1-T5:missing_lineage'));
    assert.ok(kinds.includes('K1-T6:missing_render'));
    assert.ok(kinds.includes('K1-T7:missing_render'));
    assert.ok(kinds.includes('K1-T8:missing_render'), 'a planned creative with no outcome is reported');
    assert.equal(r.complete, false);
    assert.equal(r.failed, 1);
    assert.ok(r.issues.find((i) => i.slotId === 'K1-T7')!.repairable === false, 'a missing original cannot be repaired by a layout');
    assert.ok(r.issues.find((i) => i.slotId === 'K1-T6')!.repairable === true);
  });
  it('an unreadable stored file is a blocker', async () => {
    const store = new InMemoryAssetStore();
    const a = await asset(store);
    store.files.set(a.id, Buffer.from('not an image'));
    const r = await verifyTemplateExport({ selection: sel(1), creatives: [rec('K1-T1', a)], assets: [a], load: (id) => store.load(id) });
    assert.ok(r.issues.some((i) => i.kind === 'unreadable_file' && i.severity === 'blocker'));
  });
});

describe('Campaign package compatibility', () => {
  it('a package saved before Hybrid Production (no hybrid, no lineage) still parses', () => {
    const old = { id: 'c', projectId: 'p', runId: 'r', f1ReportId: 'a', f2ReportId: 'b', f3StrategyId: 'c', schemaVersion: CAMPAIGN_SCHEMA_VERSION, campaignName: 'Old', language: 'en', concepts: [], copyVariants: [], imageAssets: [], channelLayouts: [], skippedLayouts: [], landingContent: null, reviewFindings: [], revisions: [], approval: { status: 'approved', rounds: 0, unresolvedFindingIds: [], note: '' }, usage: { text: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, perAgent: {} }, images: { model: null, quality: null, size: null, requested: 0, generated: 0, failed: 0, regenerations: 0, limits: { maxImages: 0, maxRegenerations: 0 }, providerReportedTokens: null }, layouts: { rendered: 0, skipped: 0 } }, limitations: [], createdAt: new Date().toISOString() };
    const parsed = CampaignPackage.safeParse(old);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));
    assert.equal(parsed.data!.hybrid, null);
  });
});
