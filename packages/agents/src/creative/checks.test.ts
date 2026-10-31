import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CreativeBoardStore } from './board';
import { assetFindings, claimFindings, consistencyFindings, dedupe } from './checks';
import type { AssetRecord, CopyVariantRecord, LandingContent } from './schemas';
import { buildChain, type Chain } from '../testing/chain';
import { defaultLanding } from '../testing/fake-creative';

// The Reviewer's deterministic first pass: what code can PROVE about copy, landing content and exported assets. No model.

const variant = (o: Partial<CopyVariantRecord> = {}): CopyVariantRecord => ({ id: 'V1', conceptId: 'K1', channel: 'instagram', placement: 'paid_ad', length: 'short', headline: 'Take the first step calmly', body: 'Learn to dive safely with certified instructors.', description: null, ctaText: 'Learn more', ctaType: 'learn_more', hashtags: [], claims: [{ text: 'certified instructors', support: 'f1', ref: null }], version: 1, history: [], ...o });
const layoutAsset = (o: Partial<AssetRecord> = {}): AssetRecord => ({ id: 'ast_l1', kind: 'layout', conceptId: 'K1', channel: 'instagram', format: 'instagram_square', version: 1, parentAssetId: 'ast_b1', mimeType: 'image/png', width: 1080, height: 1080, bytes: 1000, sha256: 'x'.repeat(64), source: 'ai_image', model: 'gpt-image-test', quality: 'low', requestedSize: null, status: 'rendered', flags: [], altText: null, promptMetadata: null, usage: null, createdAt: '2026-06-15T00:00:00Z', ...o });

describe('deterministic creative checks', () => {
  let chain: Chain;
  let landing: LandingContent;
  before(async () => {
    chain = await buildChain();
    landing = defaultLanding(`"valueProposition": "${chain.report.valueProposition.text}"`).content;
  });
  const board = (variants: CopyVariantRecord[], l: LandingContent | null = landing) => {
    const b = new CreativeBoardStore();
    b.concepts.push({ id: 'K1', name: 'Start with confidence', angle: 'a', keyMessage: 'k', audience: 'beginners', ctaType: 'learn_more', ctaText: 'Learn more', visualIdea: 'v' });
    b.variants.push(...variants);
    b.landing = l;
    return b;
  };
  const claims = (variants: CopyVariantRecord[], l: LandingContent | null = landing) => claimFindings({ board: board(variants, l), f1: chain.f1, f3: chain.f3 });

  it('clean copy that only states what the material supports raises nothing', () => {
    assert.deepEqual(claims([variant()]), []);
  });

  it('a guarantee, an award, a testimonial or a customer count the material does not support is a BLOCKER pointing at the variant', () => {
    for (const body of ['We guarantee results for everyone.', 'Our award-winning instructors.', 'Risk-free: try it today.', 'Join 2,500 happy students.']) {
      const out = claims([variant({ body })]);
      const f = out.find((x) => x.kind === 'unsupported_claim');
      assert.ok(f, body);
      assert.equal(f!.assetRef, 'V1');
      assert.equal(f!.responsibleAgent, 'copywriter');
      assert.equal(f!.source, 'deterministic');
      assert.ok(f!.severity === 'blocker' || f!.severity === 'major', `${body}: ${f!.severity}`);
      assert.ok(f!.suggestedCorrection.length > 10 && f!.evidence.length > 10);
    }
    assert.equal(claims([variant({ body: 'We guarantee results.' })])[0].severity, 'blocker');
  });

  it('a claim the strategy explicitly forbids (claimsToAvoid) is a blocker even without a promise word', () => {
    const avoid = chain.f3.report.creativeBrief.claimsToAvoid[0];
    assert.ok(avoid, 'the fixture strategy lists claims to avoid');
    const out = claims([variant({ body: `Honestly: ${avoid.claim}.` })]);
    assert.ok(out.some((f) => f.severity === 'blocker' && f.finding.includes(avoid.claim.slice(0, 40))));
  });

  it('a price or percentage that appears nowhere in the material is flagged; a figure that IS in the material passes', () => {
    const invented = claims([variant({ body: 'Save 37% this month.' })]);
    assert.ok(invented.some((f) => f.kind === 'unsupported_claim' && /37%/.test(f.finding)));
    const known = chain.f1.report.productManifest.name; // a word from the material, no figures
    assert.deepEqual(claims([variant({ body: `Courses by ${known}.` })]), []);
  });

  it('landing trust signals without support are blockers for the Landing Content Builder; discounts in the hero are caught too', () => {
    const bad: LandingContent = { ...landing, trustSignals: [{ text: 'Rated 5 stars by 300 customers', evidence: 'hypothesis', ref: null }], hero: { ...landing.hero, description: 'Limited-time 20% off for new students.' } };
    const out = claims([variant()], bad);
    const trust = out.find((f) => /trust signal/i.test(f.finding));
    assert.ok(trust && trust.severity === 'blocker' && trust.responsibleAgent === 'landing' && trust.assetRef === 'landing');
    assert.ok(out.some((f) => f.responsibleAgent === 'landing' && /20%|off|limited/i.test(f.finding)));
  });

  it('consistency: the landing page must ask for the same next step as the ads', () => {
    const ok = consistencyFindings(board([variant()], landing));
    assert.deepEqual(ok, []);
    const mismatch = consistencyFindings(board([variant()], { ...landing, ctaObjective: 'purchase' }));
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].kind, 'cta_mismatch');
    assert.equal(mismatch[0].severity, 'major');
    assert.equal(mismatch[0].responsibleAgent, 'landing');
    const noCta = consistencyFindings(board([variant({ ctaText: '  ' })], landing));
    assert.ok(noCta.some((f) => f.kind === 'weak_cta' && f.assetRef === 'V1'));
  });

  it('assets: wrong dimensions are a blocker, measured flags become findings, a supplied logo must be on every layout, brand colors are reported honestly', () => {
    const b = board([variant()]);
    b.assets.push(layoutAsset({ id: 'ok', flags: ['logo_applied'] }));
    b.assets.push(layoutAsset({ id: 'wrong', width: 1000, flags: ['logo_applied'] }));
    b.assets.push(layoutAsset({ id: 'flags', flags: ['text_overflow', 'low_contrast_2.9', 'logo_collides_with_text', 'upscaled_1.55x', 'logo_applied'] }));
    b.assets.push(layoutAsset({ id: 'nologo' }));
    b.assets.push(layoutAsset({ id: 'old', status: 'superseded', width: 5 })); // superseded assets are never reviewed
    b.layouts.push({ id: 'l', conceptId: 'K1', variantId: 'V1', assetId: 'ok', baseAssetId: 'ast_b1', format: 'instagram_square', channel: 'instagram', headline: 'h', ctaText: 'c', flags: [] });
    const out = assetFindings({ board: b, hasLogo: true, hasPalette: false, imageGeneration: true });
    const by = (ref: string, kind: string) => out.find((f) => f.assetRef === ref && f.kind === kind);
    assert.equal(by('wrong', 'wrong_dimensions')?.severity, 'blocker');
    assert.equal(by('flags', 'text_overflow')?.severity, 'major');
    assert.match(by('flags', 'low_contrast')!.finding, /2\.9:1/);
    assert.equal(by('flags', 'logo')?.severity, 'major');
    assert.equal(by('flags', 'poor_crop')?.responsibleAgent, 'visual');
    assert.equal(by('nologo', 'logo')?.finding, 'A logo was supplied but is not on this asset.');
    assert.ok(!out.some((f) => f.assetRef === 'ok' || f.assetRef === 'old'));
    assert.ok(out.some((f) => f.kind === 'brand_color' && f.severity === 'info'));
    assert.ok(out.every((f) => f.responsibleAgent === 'layout' || f.responsibleAgent === 'visual'));
  });

  it('a concept without any exported layout is reported against the concept; a failed AI image is a major finding with its reason', () => {
    const b = board([variant()]);
    b.assets.push({ ...layoutAsset({ id: 'base', kind: 'image', channel: null, format: null, source: 'brand_gradient', status: 'rendered', parentAssetId: null, width: 1024, height: 1024 }) });
    b.imageResults.push({ conceptId: 'K1', conceptName: 'Concept', model: 'gpt-image-test', requestAttempted: true, outcome: 'failed', stage: 'provider', errorCode: 'model_unavailable', providerStatus: 404, providerCode: 'model_not_found', message: 'The model does not exist', explanation: 'OpenAI rejected the selected image model for this account.', fallbackUsed: true, assetId: 'base' });
    const out = assetFindings({ board: b, hasLogo: false, hasPalette: true, imageGeneration: true });
    assert.ok(out.some((f) => f.kind === 'layout_unavailable' && f.assetRef === 'K1' && f.severity === 'major'));
    const img = out.find((f) => f.kind === 'visual_irrelevant');
    assert.equal(img?.severity, 'major', 'a failed image request is a defect of the campaign, not an info note');
    assert.match(img?.evidence ?? '', /rejected the selected image model/);
    assert.ok(!out.some((f) => f.kind === 'brand_color'));
  });

  it('a concept left without an AI image only because of the image limit is a minor limitation, never hidden', () => {
    const b = board([variant()]);
    b.assets.push({ ...layoutAsset({ id: 'base', kind: 'image', channel: null, format: null, source: 'brand_gradient', status: 'rendered', parentAssetId: null, width: 1024, height: 1024 }) });
    b.imageResults.push({ conceptId: 'K1', conceptName: 'Concept', model: 'gpt-image-test', requestAttempted: false, outcome: 'skipped', stage: 'budget', errorCode: null, providerStatus: null, providerCode: null, message: null, explanation: 'Image generation was skipped because the configured maximum is 1 image for 3 concepts.', fallbackUsed: true, assetId: 'base' });
    const f = assetFindings({ board: b, hasLogo: false, hasPalette: true, imageGeneration: true }).find((x) => x.kind === 'visual_irrelevant');
    assert.equal(f?.severity, 'minor');
    assert.match(f?.evidence ?? '', /configured maximum is 1 image for 3 concepts/);
  });

  it('dedupe keeps one finding per kind, asset and opening words', () => {
    const f = claims([variant({ body: 'We guarantee results. We guarantee results.' })]);
    const twice = dedupe([...f, ...f]);
    assert.equal(twice.length, f.length);
  });
});
