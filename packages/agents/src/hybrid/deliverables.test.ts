import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCollection, listCollections, themedTemplates } from '../collections/registry';
import { channelFindings, consistencyFindings } from '../creative/checks';
import { CreativeBoardStore } from '../creative/board';
import { CopyOutput, CampaignPackage } from '../creative/schemas';
import { contentForSlot } from './content';
import { MAX_DELIVERABLES, planDeliverables } from './deliverables';

// V4: the deliverables plan replaces the creative quotas. Pure and local: no model, no network, nothing billed.

const concepts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}` }));

describe('the deliverables plan', () => {
  it('every concept gets a post visual for each of the five platforms; ads and billboards as a 2 x 2 variation matrix; TWO flyers', () => {
    const c = getCollection('modern_corporate')!;
    const plan = planDeliverables({ concepts: concepts(3), library: themedTemplates(c), hasPicture: true, facts: {} });
    const social = plan.slots.filter((s) => s.kind === 'social_post');
    for (const p of ['x', 'tiktok', 'facebook', 'instagram', 'linkedin']) assert.equal(social.filter((s) => s.channel === p).length + plan.notPlanned.filter((n) => n.kind === 'social_post' && n.label.toLowerCase().includes(p === 'x' ? 'x post' : p)).length, 3, `${p}: planned or reported for every concept`);
    const kinds = (k: string) => plan.slots.filter((s) => s.kind === k).length + plan.notPlanned.filter((n) => n.kind === k).length;
    assert.equal(kinds('web_ad'), 4);
    assert.equal(kinds('display_ad'), 4);
    assert.equal(kinds('billboard'), 4);
    assert.equal(kinds('flyer'), 2);
    // the matrix: design 1 and design 2, each with the copy of the two lead concepts (T1 = K1, T2 = K2)
    const bb = plan.slots.filter((s) => s.kind === 'billboard');
    assert.deepEqual(bb.map((s) => `${s.conceptId}:D${s.matrix!.design}T${s.matrix!.copy}`).sort(), ['K1:D1T1', 'K1:D2T1', 'K2:D1T2', 'K2:D2T2']);
    assert.deepEqual(bb.map((s) => s.slotId).sort(), ['K1-billboard-d1', 'K1-billboard-d2', 'K2-billboard-d1', 'K2-billboard-d2']);
    assert.ok(plan.slots.filter((s) => s.kind === 'flyer').every((s) => !s.matrix), 'flyers are not a matrix');
    assert.deepEqual(plan.slots.filter((s) => s.kind === 'flyer').map((s) => s.conceptId), ['K1', 'K2']);
    assert.ok(plan.slots.length <= MAX_DELIVERABLES);
    assert.equal(new Set(plan.slots.map((s) => s.slotId)).size, plan.slots.length, 'slot ids are unique');
    for (const s of plan.slots.filter((x) => x.kind !== 'social_post')) assert.equal(s.fixedFormat, true, 'print and ads never change shape');
    assert.ok(plan.slots.every((s) => s.folder && s.label));
  });

  it('a campaign with ONE concept gets a 2 x 1 matrix (two designs, one text: reported) and two flyers: a second layout of the same concept, with its own slot id', () => {
    const plan = planDeliverables({ concepts: concepts(1), library: themedTemplates(getCollection('modern_corporate')!), hasPicture: true, facts: {} });
    const ids = (k: string) => plan.slots.filter((s) => s.kind === k).map((s) => s.slotId);
    assert.deepEqual(ids('billboard'), ['K1-billboard-d1', 'K1-billboard-d2']);
    assert.ok(plan.warnings.some((w) => /2 designs x 1 text/.test(w)), 'the smaller matrix is reported, not hidden');
    assert.deepEqual(ids('flyer'), ['K1-flyer', 'K1-flyer-2']);
    assert.equal(new Set(plan.slots.map((s) => s.slotId)).size, plan.slots.length);
    // the second slot shows the same approved print copy (nothing is invented for it)
    assert.deepEqual(plan.slots.filter((s) => s.kind === 'billboard').map((s) => s.conceptId), ['K1', 'K1']);
  });

  it('a format the collection cannot draw is reported with its reason, never replaced by another shape', () => {
    for (const c of listCollections()) {
      const plan = planDeliverables({ concepts: concepts(2), library: themedTemplates(c), hasPicture: false, facts: {} });
      for (const s of plan.slots.filter((x) => x.kind === 'billboard')) assert.equal(s.formatId, 'billboard');
      for (const s of plan.slots.filter((x) => x.kind === 'flyer')) assert.equal(s.formatId, 'flyer');
      for (const n of plan.notPlanned) assert.ok(n.reason.length > 10);
    }
  });

  it('the upper limit keeps the print and ad deliverables and reports the posts that do not fit', () => {
    const plan = planDeliverables({ concepts: concepts(5), library: themedTemplates(getCollection('bold_startup')!), hasPicture: true, facts: {} });
    assert.ok(plan.slots.length <= MAX_DELIVERABLES);
    if (plan.notPlanned.some((n) => /upper limit/.test(n.reason))) assert.ok(plan.slots.some((s) => s.kind === 'billboard' || s.kind === 'flyer'));
  });

  it('a deliverable without copy is not planned', () => {
    const plan = planDeliverables({ concepts: concepts(1), library: themedTemplates(getCollection('modern_corporate')!), hasPicture: true, facts: {}, hasCopy: (_c, kind, channel) => !(kind === 'social_post' && channel === 'x') });
    assert.ok(!plan.slots.some((s) => s.channel === 'x'));
    assert.ok(plan.notPlanned.some((n) => n.label === 'X post' && /no copy/i.test(n.reason)));
  });
});

describe('copy of the deliverables', () => {
  const board = () => {
    const b = new CreativeBoardStore();
    b.concepts = [{ id: 'K1', name: 'Fresh bread', angle: 'a', keyMessage: 'k', audience: 'au', ctaType: 'learn_more', ctaText: 'Visit us', visualIdea: 'A baker pulling bread from a wood-fired oven at dawn' }];
    const base = { conceptId: 'K1', length: 'short', description: null, ctaText: 'Visit us', ctaType: 'learn_more' as const, hashtags: [], claims: [], version: 1, history: [] };
    b.variants = [
      { ...base, id: 'V1', channel: 'instagram', placement: 'social_post', headline: 'Bread at dawn', body: 'Our sourdough is baked every morning in a wood-fired oven.' },
      { ...base, id: 'V2', channel: 'x', placement: 'social_post', headline: 'Warm bread, early', body: 'x'.repeat(300) },
      { ...base, id: 'V3', channel: 'facebook', placement: 'social_post', headline: 'Bread at dawn', body: 'Our sourdough is baked every morning in a wood-fired oven.' },
      { ...base, id: 'V4', channel: 'organic_content', placement: 'billboard', headline: 'Bread worth getting up early for, every single morning here', body: '' },
    ];
    return b;
  };

  it('a slot shows the copy of its own deliverable (platform post, billboard headline only)', () => {
    const b = board();
    assert.equal(contentForSlot({ conceptId: 'K1', channel: 'x', kind: 'social_post' }, b.concepts, b.variants)?.variantId, 'V2');
    const bb = contentForSlot({ conceptId: 'K1', channel: 'organic_content', kind: 'billboard' }, b.concepts, b.variants)!;
    assert.equal(bb.variantId, 'V4');
    assert.equal(bb.support, null, 'a billboard carries its headline only');
    assert.equal(contentForSlot({ conceptId: 'K1', channel: 'linkedin', kind: 'social_post' }, b.concepts, b.variants), null, 'no copy: nothing is invented');
  });

  it('X posts over 280 characters, long billboard headlines and the same post copied to another platform are findings', () => {
    const b = board();
    const ch = channelFindings(b);
    assert.ok(ch.some((f) => f.assetRef === 'V2' && f.severity === 'major' && /280/.test(f.finding)));
    assert.ok(ch.some((f) => f.assetRef === 'V4' && /billboard/.test(f.finding)));
    assert.ok(consistencyFindings(b).some((f) => f.kind === 'repetitive' && f.assetRef === 'V3'));
  });
});

describe('schemas', () => {
  it('the Content Writer answer has posts, ads and print; a TikTok post may carry a video script', () => {
    const ok = CopyOutput.safeParse({ summary: 's', concepts: [], posts: [{ conceptKey: 'c1', platform: 'tiktok', hook: 'Hook', text: 'Caption text', visualLine: 'A short line for the cover', cta: 'Visit', ctaType: 'learn_more', hashtags: [], postingFormat: '9:16', videoScript: { hook: 'h', durationSeconds: 20, scenes: [], soundNote: '' }, claims: [], principles: ['P1', 'P6'] }], ads: [], print: [], missingInformation: [] });
    assert.equal(ok.success, true);
  });

  it('a package saved before V4 (F2 audit, landing page, no deliverables) still parses', () => {
    const old = { id: 'c', projectId: 'p', runId: 'r', f1ReportId: 'f1', f2ReportId: 'f2', f3StrategyId: 'f3', schemaVersion: 1, campaignName: 'n', language: 'en', concepts: [], copyVariants: [], imageAssets: [], channelLayouts: [], skippedLayouts: [], landingContent: null, reviewFindings: [], revisions: [], approval: { status: 'approved', rounds: 0, unresolvedFindingIds: [], note: '' }, usage: { text: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, perAgent: {} }, images: { model: 'gpt-image-1', quality: 'low', size: '1024x1024', requested: 1, generated: 1, failed: 0, regenerations: 0, limits: { maxImages: 1, maxRegenerations: 0 }, providerReportedTokens: null }, layouts: { rendered: 0, skipped: 0 } }, limitations: [], createdAt: '2026-11-01T00:00:00Z' };
    const r = CampaignPackage.safeParse(old);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues[0]));
    assert.equal(r.success && r.data.deliverables, null);
    assert.equal(r.success && r.data.f2ReportId, 'f2');
  });
});
