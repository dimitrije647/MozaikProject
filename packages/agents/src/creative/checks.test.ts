import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CreativeBoardStore } from './board';
import { assetFindings, channelFindings, claimFindings, consistencyFindings, dedupe } from './checks';
import { foldDiacritics, promiseMatches } from './lexicon';
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
  const claims = (variants: CopyVariantRecord[], l: LandingContent | null = landing, language = 'en') => claimFindings({ board: board(variants, l), f1: chain.f1, f3: chain.f3, language });

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

  it('a concept without any exported layout is reported against the concept; a brand-gradient fallback is only an info note', () => {
    const b = board([variant()]);
    b.assets.push({ ...layoutAsset({ id: 'base', kind: 'image', channel: null, format: null, source: 'brand_gradient', status: 'rendered', parentAssetId: null, width: 1024, height: 1024 }) });
    const out = assetFindings({ board: b, hasLogo: false, hasPalette: true, imageGeneration: true });
    assert.ok(out.some((f) => f.kind === 'layout_unavailable' && f.assetRef === 'K1' && f.severity === 'major'));
    assert.ok(out.some((f) => f.kind === 'visual_irrelevant' && f.severity === 'info'));
    assert.ok(!out.some((f) => f.kind === 'brand_color'));
  });

  it('promise words are recognized in the campaign language (Serbian, Croatian, German, Spanish...), English words still count, diacritics do not matter', () => {
    const sr: [string, 'blocker' | 'major'][] = [
      ['Garantujemo rezultate svima.', 'blocker'],
      ['Nagrađivani instruktori vas vode.', 'blocker'],
      ['Nagradivani instruktori vas vode.', 'blocker'],
      ['Besplatna prva lekcija za sve.', 'major'],
      ['Najbolja škola ronjenja u gradu.', 'major'],
      ['Pridružite se 2.500 zadovoljnih polaznika.', 'major'],
      ['Popust 20% ovog meseca.', 'major'],
      ['We guarantee results.', 'blocker'],
    ];
    for (const [body, severity] of sr) {
      const out = claims([variant({ body })], landing, 'sr');
      const f = out.find((x) => x.kind === 'unsupported_claim' && /promise or proof claim/.test(x.finding));
      assert.ok(f, body);
      assert.equal(f!.severity, severity, body);
    }
    assert.match(claims([variant({ body: 'Nagrađivani instruktori vas vode.' })], landing, 'sr')[0].finding, /"Nagrađivani"/, 'the phrase is quoted as written, with its diacritics');
    for (const [language, body] of [['hr', 'Jamčimo rezultate.'], ['de', 'Wir garantieren Erfolg.'], ['es', 'Garantizamos resultados.'], ['fr', 'Résultats garantis.'], ['it', 'Risultati garantiti.']] as const) {
      assert.equal(claims([variant({ body })], landing, language).find((x) => /promise or proof claim/.test(x.finding))?.severity, 'blocker', `${language}: ${body}`);
    }
    for (const [language, body] of [['de', 'Kostenlose Probestunde.'], ['es', 'Clase gratis para empezar.'], ['hr', 'Popust za rane prijave.']] as const) {
      assert.equal(claims([variant({ body })], landing, language).find((x) => /promise or proof claim/.test(x.finding))?.severity, 'major', `${language}: ${body}`);
    }
    // plain Serbian copy without promises raises nothing; an unknown language falls back to the English list
    assert.deepEqual(claims([variant({ body: 'Naučite da ronite polako, sa sertifikovanim instruktorima.' })], landing, 'sr').filter((x) => /promise or proof/.test(x.finding)), []);
    assert.equal(claims([variant({ body: 'Garantujemo rezultate.' })], landing, 'xx').length, 0, 'an unknown language has no local list');
    assert.equal(foldDiacritics('Škola Đaka ÄÖÜ é').length, 'Škola Đaka ÄÖÜ é'.length);
    assert.equal(foldDiacritics('Škola Đaka'), 'skola daka');
    assert.deepEqual(promiseMatches('Garancija i besplatno', 'sr').map((m) => [m.phrase, m.hard]), [['Garancija', true], ['besplatno', false]]);
  });

  it('channel limits: platform maximums are major, recommendations minor, channels without limits raise nothing', () => {
    const long = 'x'.repeat(60);
    const none = channelFindings(board([variant({ channel: 'organic_content', headline: long, body: 'y'.repeat(400) })]));
    assert.deepEqual(none, []);
    const google = channelFindings(board([variant({ channel: 'google_search', placement: 'paid_ad', headline: 'Learn to dive with certified instructors today', body: 'z'.repeat(95) })]));
    assert.equal(google.length, 2);
    assert.ok(google.every((f) => f.kind === 'channel_mismatch' && f.severity === 'major' && f.assetRef === 'V1' && f.responsibleAgent === 'copywriter' && f.source === 'deterministic'));
    assert.match(google[0].finding, /headline of 46 characters; the channel allows at most 30/);
    assert.match(google[0].suggestedCorrection, /30 characters/);
    const fb = channelFindings(board([variant({ channel: 'facebook', placement: 'paid_ad', headline: long, body: 'short enough' })]));
    assert.equal(fb.length, 1);
    assert.equal(fb[0].severity, 'minor');
    assert.match(fb[0].finding, /works best with up to 40/);
    const tags = channelFindings(board([variant({ channel: 'instagram', placement: 'organic_post', hashtags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })]));
    assert.equal(tags.length, 1);
    assert.match(tags[0].finding, /7 hashtags/);
    assert.deepEqual(channelFindings(board([variant({ channel: 'instagram', placement: 'paid_ad', headline: 'Take the first step', body: 'Learn to dive safely.' })])), []);
  });

  it('dedupe keeps one finding per kind, asset and opening words', () => {
    const f = claims([variant({ body: 'We guarantee results. We guarantee results.' })]);
    const twice = dedupe([...f, ...f]);
    assert.equal(twice.length, f.length);
  });
});
