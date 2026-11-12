import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CopyVariantRecord } from '../creative/schemas';
import { CampaignPackage, CopyOutput, ReviewOutput, Rubric } from '../creative/schemas';
import { scoreFindings } from '../creative/checks';
import { F4CreativeBrief } from '../strategy/schemas';
import { copyCraftFindings } from './checks';
import { CopyDirection } from './direction';
import { planCopywriting, purposeOf } from './plan';
import { COMBINATIONS, COPY_PURPOSES, PRINCIPLE_IDS, PRINCIPLES, principleGuide } from './principles';
import { inferBrandVoice, type VoiceInput } from './voice';

/**
 * The copywriting framework: principles, combinations, the Brand Voice Profile, the plan and the copy-craft checks. Pure, no model call.
 * FIRMENFELS GRUPPE is the reference case of a serious, regulated professional audience (independent Swiss asset managers and trustees);
 * the diving school is the contrast case. Neither is a default: the same code must generalize to any brand.
 */
const firmenfels: VoiceInput = {
  language: 'en',
  audience: 'Independent Swiss asset managers and trustees',
  industry: 'Governance and risk oversight for asset managers',
  category: 'Professional services',
  businessType: 'service',
  offering: 'Governance and risk oversight in practice for independent asset managers and trustees',
  brandStyle: null,
  brandNotes: null,
  toneOfVoice: 'Serious, trustworthy and restrained',
  researchConfidence: 0.8,
  collectionId: 'premium_editorial',
};
const diving: VoiceInput = { ...firmenfels, audience: 'Beginners aged 20-40 who want to learn to dive', industry: 'Diving school', category: 'Leisure and sport courses', businessType: 'local_business', offering: 'Beginner diving courses in the lake', toneOfVoice: 'Friendly and encouraging', collectionId: 'premium_editorial' };

const direction = (o: Partial<CopyDirection> = {}): CopyDirection => ({
  purpose: 'leadership',
  mainProblem: 'Governance is documented, but nobody knows whether it works in practice.',
  practicalBenefit: 'A clear view of how oversight works day to day.',
  emotionalBenefit: 'Being the one who sees the risk before it becomes everyone else\'s problem.',
  desiredAction: 'Book an introductory call',
  proofPoints: [],
  urgency: null,
  limitation: null,
  principles: ['P3', 'P7', 'P9', 'P12'],
  rationale: 'A professional audience that trusts insight over claims.',
  ...o,
});

const variant = (o: Partial<CopyVariantRecord>): CopyVariantRecord => ({
  id: 'V1', conceptId: 'K1', channel: 'linkedin', placement: 'social_post', length: 'short', headline: 'Your compliance is documented. But does it work?', body: 'A policy on paper is not oversight.', description: null,
  ctaText: 'Book an introductory call', ctaType: 'book_consultation', hashtags: [], claims: [], version: 1, history: [], ...o,
});

describe('copywriting principles', () => {
  it('defines the twelve principles plus optional humor, and every combination uses known ids', () => {
    assert.equal(PRINCIPLE_IDS.length, 13);
    for (const p of COPY_PURPOSES) for (const id of [...COMBINATIONS[p].primary, ...COMBINATIONS[p].optional]) assert.ok(PRINCIPLES[id], `${p}: ${id}`);
    assert.deepEqual(COMBINATIONS.awareness.primary, ['P1', 'P3', 'P6']);
    assert.deepEqual(COMBINATIONS.leadership.primary, ['P3', 'P7', 'P9', 'P12']);
  });
  it('has ONE canonical guide (full for the writer, short for the reviewer)', () => {
    const full = principleGuide('full');
    const review = principleGuide('review');
    for (const id of PRINCIPLE_IDS) assert.ok(full.includes(`${id} `) && review.includes(`${id} `));
    assert.ok(review.length < full.length);
    assert.ok(!/FIRMENFELS/i.test(full), 'no brand language in the universal guidance');
  });
});

describe('brand voice profile', () => {
  it('FIRMENFELS GRUPPE: regulated professional audience, restrained, no humor, and not turned into a luxury brand by its collection', () => {
    const v = inferBrandVoice(firmenfels);
    assert.equal(v.sensitivity, 'regulated');
    assert.equal(v.humor, 'off');
    assert.equal(v.tone, 'professional');
    assert.notEqual(v.tone, 'premium');
    assert.equal(v.formality, 'formal');
  });
  it('a diving school sounds different with the same collection', () => {
    const v = inferBrandVoice(diving);
    assert.equal(v.tone, 'conversational');
    assert.equal(v.sensitivity, 'standard');
    assert.equal(v.humor, 'light');
  });
  it('the user override wins, and humor stays off in a regulated industry', () => {
    const v = inferBrandVoice({ ...firmenfels, override: { tone: 'technical', humor: true, avoid: ['cheap'] } });
    assert.equal(v.tone, 'technical');
    assert.equal(v.humor, 'off');
    assert.ok(v.forbiddenExpressions.includes('cheap'));
  });
  it('without evidence it is a cautious default and says so', () => {
    const v = inferBrandVoice({ ...diving, toneOfVoice: null, researchConfidence: 0.2, collectionId: null });
    assert.equal(v.evidenceConfidence, 'low');
    assert.ok(v.basis.some((b) => /default/i.test(b)));
  });
});

describe('copywriting plan', () => {
  const voice = inferBrandVoice(firmenfels);
  it('excludes urgency, admissions and humor without evidence, and keeps the strategist purpose', () => {
    const p = planCopywriting({ objective: null, direction: direction(), voice, platforms: ['linkedin', 'x'], hasWebsite: false });
    assert.equal(p.purpose, 'leadership');
    assert.equal(p.purposeBasis, 'strategist');
    assert.deepEqual(p.excluded.map((e) => e.id).sort(), ['P13', 'P5', 'P8']);
    for (const pl of p.placements) for (const id of ['P5', 'P8', 'P13']) assert.ok(!pl.principles.includes(id as never), `${pl.key} uses ${id}`);
    assert.deepEqual(p.placements.map((x) => x.key), ['social:linkedin', 'social:x', 'web_ad', 'display_ad', 'billboard', 'flyer']);
    assert.ok(p.notes.some((n) => /no website|No destination/i.test(n)));
  });
  it('a billboard gets at most two principles and the length limits come from limits.ts', () => {
    const p = planCopywriting({ objective: null, direction: direction(), voice, platforms: ['x'], hasWebsite: true });
    const bb = p.placements.find((x) => x.key === 'billboard')!;
    assert.ok(bb.principles.length <= 2);
    assert.match(p.placements.find((x) => x.key === 'social:x')!.limits, /post <= 280/);
  });
  it('real urgency (cited by the strategist, or an offer the user entered) unlocks P8', () => {
    const cited = planCopywriting({ objective: null, direction: direction({ purpose: 'conversion', urgency: { text: 'Registration closes on 30 June', findingId: 'A1-4' } }), voice, platforms: [], hasWebsite: true });
    assert.ok(!cited.excluded.some((e) => e.id === 'P8'));
    const user = planCopywriting({ objective: 'More bookings', direction: null, voice, platforms: [], hasWebsite: true, userFacts: { offer: '-20%' } });
    assert.ok(!user.excluded.some((e) => e.id === 'P8'));
    assert.equal(user.purpose, 'conversion');
  });
  it('reads the purpose from the objective in English and German', () => {
    assert.equal(purposeOf('More sign-ups for the summer course'), 'conversion');
    assert.equal(purposeOf('Mehr Anfragen von Vermögensverwaltern'), 'conversion');
    assert.equal(purposeOf('Become known as the expert for governance'), 'leadership');
    assert.equal(purposeOf(''), null);
  });
});

describe('copy-craft checks', () => {
  const plan = planCopywriting({ objective: null, direction: direction(), voice: inferBrandVoice(firmenfels), platforms: ['linkedin'], hasWebsite: true });
  it('FIRMENFELS GRUPPE reference copy passes: specific, restrained, no fake urgency', () => {
    const v = variant({ body: 'FIRMENFELS GRUPPE looks at how governance and risk oversight work in practice, not only whether the documents exist. Where does a decision get checked, and by whom?', principles: ['P1', 'P3', 'P9'] });
    assert.deepEqual(copyCraftFindings({ variants: [v], plan }), []);
  });
  it('flags generic slogans, fake urgency and excluded principles', () => {
    const v = variant({ body: 'FIRMENFELS GRUPPE offers innovative solutions. Only 3 spots left, act now!', principles: ['P8'] });
    const kinds = copyCraftFindings({ variants: [v], plan }).map((f) => f.kind);
    assert.ok(kinds.includes('generic_copy'));
    assert.ok(kinds.includes('false_urgency'));
    assert.ok(kinds.includes('principle_misuse'));
  });
  it('keeps a billboard to one short idea', () => {
    const v = variant({ placement: 'billboard', channel: 'organic_content', headline: 'Governance that works in practice for every asset manager in Switzerland', body: 'More text' });
    const f = copyCraftFindings({ variants: [v], plan });
    assert.ok(f.some((x) => x.kind === 'channel_mismatch' && x.severity === 'major'));
  });
  it('finds repeated openings and one CTA everywhere', () => {
    const posts = ['x', 'facebook', 'instagram', 'linkedin', 'tiktok', 'x'].map((c, i) => variant({ id: `V${i + 1}`, conceptId: `K${i}`, channel: c as never, body: `Discover our new course today. Part ${i}.`, ctaText: 'Learn more' }));
    const kinds = copyCraftFindings({ variants: posts, plan: null }).map((f) => f.kind);
    assert.ok(kinds.filter((k) => k === 'repetitive').length >= 1);
    assert.ok(kinds.includes('weak_cta'));
  });
  it('does not flag the business\'s own wording', () => {
    const v = variant({ body: 'Seamless Dive Center runs beginner courses in the lake.' });
    assert.deepEqual(copyCraftFindings({ variants: [v], plan, corpus: 'Seamless Dive Center' }), []);
  });
});

describe('schemas stay compatible', () => {
  it('older strategies (no copy direction) and older rubrics still parse; unscored criteria are no weakness', () => {
    const brief = F4CreativeBrief.shape.copyDirection.parse(undefined);
    assert.equal(brief, null);
    const old = Rubric.parse({ productAccuracy: 4, brandConsistency: 4, audienceRelevance: 4, objectiveAlignment: 4, originality: 4, crossChannelConsistency: 4 });
    assert.deepEqual(scoreFindings(old, []), []);
  });
  it('the model must answer the new fields (strict schemas)', () => {
    assert.ok(!ReviewOutput.safeParse({ summary: 's', issues: [], scores: { productAccuracy: 4, brandConsistency: 4, audienceRelevance: 4, objectiveAlignment: 4, originality: 4, crossChannelConsistency: 4 } }).success);
    assert.ok(!CopyOutput.safeParse({ summary: 's', concepts: [{ key: 'c1', name: 'Name', basis: '', angle: '', keyMessage: '', audience: '', ctaType: 'learn_more', ctaText: 'Go', visualIdea: '' }], posts: [], ads: [], print: [], missingInformation: [] }).success);
    assert.equal(CampaignPackage.shape.copywriting.parse(undefined), null);
  });
});
