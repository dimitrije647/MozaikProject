import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { SpendBudget } from '../ai/budget';
import { IMAGE_MODEL_INFO, imageModelWarning, imageQualityProblem, pickImageModel, pickImageModelFor } from '../ai/image-models';
import { imageCostEstimate } from '../ai/pricing';
import type { RecordedEvent } from '../factory/state';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { defaultConceptCritique, defaultCreativeReview, defaultLanding } from '../testing/fake-creative';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '../testing/fake-openai';
import { InMemoryAssetStore } from './assets';
import { conceptFindings, scoreFindings } from './checks';
import type { CreativeInput } from './context';
import type { CampaignPackage } from './schemas';
import { variationImagePrompt, type SlotBrief } from './prompts';
import type { VisualBrief } from './visual-brief';

// Image-model strategies, the visual brief and the prompt, the concept critique before the images, the rubric, the deterministic
// call-to-action repair and the recovery from cut-off answers. Real Mozaik runtime; a fake OpenAI over real HTTP. Nothing is billed.

describe('image model strategies (pure)', () => {
  const key = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08', 'chatgpt-image-latest'];
  const now = new Date('2026-11-02T00:00:00Z');

  it('economy keeps the old cheapest-first order; quality puts the most capable current model first, ahead of price', () => {
    assert.equal(pickImageModel(key, now), 'gpt-image-1-mini', 'the default call is unchanged');
    assert.equal(pickImageModelFor(key, 'economy', now)?.model, 'gpt-image-1-mini');
    assert.equal(pickImageModelFor(key, 'balanced', now)?.model, 'gpt-image-2');
    const q = pickImageModelFor(key, 'quality', now)!;
    assert.equal(q.model, 'gpt-image-2.5-sunburst');
    assert.match(q.reason, /most capable model for image generation and editing/);
    assert.deepEqual(q.alternatives.slice(0, 3), ['gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5']);
    assert.ok(!q.alternatives.includes('gpt-image-1'), 'a retired model is never offered');
    assert.ok(!q.alternatives.includes('gpt-image-2.5-sunburst-2026-09-08'), 'dated snapshots are not offered');
  });

  it('quality follows the models the key really lists and never hands a retired or unsupported id back', () => {
    assert.equal(pickImageModelFor(['gpt-image-1.5', 'gpt-image-1-mini'], 'quality', now)?.model, 'gpt-image-1.5');
    assert.equal(pickImageModelFor(['gpt-image-1', 'chatgpt-image-latest'], 'quality', now), null, 'nothing usable: no model, not a silent downgrade to a retired one');
    // a newer, undocumented id is used only when nothing documented is listed, and is flagged as undocumented
    const unknown = pickImageModelFor(['gpt-image-3'], 'quality', now)!;
    assert.equal(unknown.model, 'gpt-image-3');
    assert.equal(unknown.unknownModel, true);
    assert.equal(pickImageModelFor(['gpt-image-3', 'gpt-image-1.5'], 'quality', now)?.model, 'gpt-image-1.5');
  });

  it('a model whose shutdown is near moves behind a longer-lived one for balanced and quality, never for economy', () => {
    assert.ok(imageModelWarning('gpt-image-1-mini', now));
    assert.equal(pickImageModelFor(['gpt-image-1-mini', 'gpt-image-1.5'], 'economy', now)?.model, 'gpt-image-1-mini');
    assert.equal(pickImageModelFor(['gpt-image-1-mini', 'gpt-image-1.5'], 'balanced', now)?.model, 'gpt-image-1.5');
    assert.equal(pickImageModelFor(['gpt-image-1-mini'], 'quality', now)?.model, 'gpt-image-1-mini', 'when it is the only one, it is still offered (with its warning)');
  });

  it('quality values are checked against the model documentation and never replaced silently', () => {
    assert.equal(imageQualityProblem('gpt-image-2.5-sunburst', 'xhigh'), null);
    assert.match(imageQualityProblem('gpt-image-1.5', 'xhigh') ?? '', /does not list the quality "xhigh"/);
    assert.equal(imageQualityProblem('gpt-image-9', 'xhigh'), null, 'an undocumented model is not refused on guesswork');
    assert.ok(IMAGE_MODEL_INFO['gpt-image-2.5-flare'].customSizes);
  });

  it('GPT Image 2.5 has no published per-image price: honest "unavailable" for the budget, with the real cost computed after each image', () => {
    assert.equal(imageCostEstimate('gpt-image-2.5-sunburst', 'high', '1536x1024').usd, null);
    assert.equal(imageCostEstimate('gpt-image-2.5-sunburst', 'xhigh', '1536x1024').usd, null);
    assert.ok(imageCostEstimate('gpt-image-2', 'high', '1536x1024').usd! > 0.1);
  });
});

describe('deterministic concept checks and the rubric (pure)', () => {
  const c = (id: string, angle: string, key: string, visual: string) => ({ id, name: id, angle, keyMessage: key, audience: 'a', ctaType: 'contact' as const, ctaText: 'Go', visualIdea: visual });

  it('two nearly identical concepts are flagged; a thin or cliché visual idea is flagged; distinct concrete concepts are not', () => {
    const same = conceptFindings({ concepts: [c('K1', 'Check the task before the agent', 'Define input and expected output', 'Sorted wooden blocks on a workbench beside a handwritten checklist'), c('K2', 'Check the task before the agent', 'Define input and expected output first', 'Sorted wooden blocks on a workbench beside a handwritten checklist')] });
    assert.ok(same.some((f) => f.kind === 'concept_overlap' && f.severity === 'major' && f.assetRef === 'K2'));
    const thin = conceptFindings({ concepts: [c('K1', 'a', 'b', 'team working at a laptop on a desk')] });
    assert.ok(thin.some((f) => f.kind === 'generic_concept' && f.assetRef === 'K1'));
    const fine = conceptFindings({ concepts: [c('K1', 'Check the task before the agent', 'Define input and expected output', 'Sorted wooden blocks on a workbench beside a handwritten checklist'), c('K2', 'Ask the technical questions first', 'Confirm access, permissions and supervision', 'A closed laptop and an external drive side by side on a clean oak table at dusk')] });
    assert.deepEqual(fine, []);
  });

  it('a rubric score of 2 or less becomes a finding unless a specific issue already explains it; scores are clamped', () => {
    const s = { productAccuracy: 5, brandConsistency: 4, audienceRelevance: 2, objectiveAlignment: 1, originality: 2, crossChannelConsistency: 3 };
    const out = scoreFindings(s, [{ kind: 'audience_mismatch' }]);
    assert.deepEqual(out.map((f) => f.kind).sort(), ['generic_concept', 'strategy_mismatch']);
    assert.ok(out.every((f) => f.severity === 'major' && f.assetRef === null && f.source === 'llm_text'));
    assert.deepEqual(scoreFindings({ ...s, audienceRelevance: 4, objectiveAlignment: 4, originality: 9 }, []), []);
    assert.deepEqual(scoreFindings(null, []), []);
  });
});

describe('the image prompt is a professional creative brief (pure)', () => {
  const brief: VisualBrief = {
    business: 'JigJoy',
    offering: 'A service that lets AI agents finish defined programming tasks',
    valueProposition: 'Tasks done and checked, not promised',
    campaignGoal: 'Get young developers to request a small trial task',
    audience: { primary: 'Early-career developers who distrust AI hype', secondary: ['Team leads'], segments: ['Developers (primary)'] },
    brand: { tone: 'plain and precise', visualDirection: 'Honest workbench photography, no futuristic gloss', constraints: ['No robot imagery'], palette: ['#1f2937'], observed: [] },
    locale: { geography: ['Serbia'], language: 'sr' },
    channels: [{ channel: 'youtube', role: 'primary', formats: [] }],
    avoid: ['guaranteed results'],
  };
  const slot: SlotBrief = { slotId: 'K1-V2', conceptId: 'K1', index: 2, role: { id: 'detail', label: 'Close detail', brief: 'a close, tactile detail' }, perspective: 'close-up macro', lighting: 'soft natural daylight', targetChannels: ['youtube', 'google_search'], size: '1536x1024' };
  const dir = { name: 'Checklist close-up', goal: 'Show the verification step', medium: 'documentary-style photograph', subject: 'A hand ticking a handwritten checklist', setting: 'a cluttered oak workbench', focalPoint: 'the pen tip on the last box', composition: 'tight crop from above', mood: 'calm, exact', avoid: ['glossy gadgets'], altText: 'x', promptDetails: 'worn pencil' };

  it('carries goal, audience, brand, concept, role, medium, subject, setting, focal point, camera, light, placement, siblings and constraints', () => {
    const p = variationImagePrompt(dir, 'JigJoy', { name: 'Task first', keyMessage: 'Define input and output', angle: 'Check before you trust' }, slot, ['#1f2937'], 'bottom', brief, ['Wide bench: a long bench seen from the door']);
    for (const part of ['CAMPAIGN GOAL: Get young developers', 'AUDIENCE: Early-career developers', 'BRAND IDENTITY:', 'CREATIVE CONCEPT "Task first"', 'THIS IMAGE: Close detail', 'MEDIUM AND STYLE: documentary-style photograph', 'SUBJECT: A hand ticking', 'SETTING: a cluttered oak workbench', 'locale cues: Serbia', 'FOCAL POINT: the pen tip', 'Camera: close-up macro', 'LIGHT AND MOOD: soft natural daylight', 'PLACEMENT: youtube, google_search; landscape frame', 'MUST LOOK DIFFERENT FROM', 'CONSTRAINTS: no text', 'stock-photo']) assert.ok(p.includes(part), `missing: ${part}`);
    assert.match(p, /not a photograph of a real place, product or person/);
    assert.match(p, /Strategy says to stay away from: guaranteed results/);
    assert.ok(p.length <= 3900);
  });

  it('two images of one concept with different directions give clearly different prompts', () => {
    const a = variationImagePrompt(dir, 'JigJoy', { name: 'T', keyMessage: 'k' }, slot, [], 'bottom', brief);
    const b = variationImagePrompt({ ...dir, subject: 'A closed laptop beside an external drive', setting: 'a dusk-lit kitchen table', focalPoint: 'the unplugged cable' }, 'JigJoy', { name: 'T', keyMessage: 'k' }, { ...slot, index: 3, perspective: 'overhead top-down', lighting: 'warm evening ambient light' }, [], 'bottom', brief);
    assert.notEqual(a, b);
    assert.ok(a.includes('close-up macro') && b.includes('overhead top-down'));
  });
});

// ---- F4 end to end ------------------------------------------------------------------------------------------------------------

const KEY = 'sk-test-QUALITY1234567890abcdefghij';
interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  fake: FakeOpenAI;
}

describe('F4 quality work (real Mozaik agents; fake text and image APIs)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  const input = (o: Partial<CreativeInput> = {}): CreativeInput => ({ projectName: 'Deep Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 3, landing: true, ...o });

  async function run(o: { config?: Partial<CreativeRunConfig>; input?: Partial<CreativeInput>; openai?: FakeOpenAIOptions } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: 'f4-q-1',
      projectId: 'project-1',
      userId: 'user-1',
      mode: 'creative_production',
      manifest: { productName: 'Deep Diving School' },
      credentials: { provider: 'openai', apiKey: KEY },
      creative: {
        campaignId: 'campaign-1',
        projectId: 'project-1',
        f1: chain.f1,
        f2: chain.f2,
        f3: chain.f3,
        input: input(o.input),
        model: 'gpt-test-mini',
        imageModel: 'gpt-image-test',
        imageQuality: 'low',
        maxModelCalls: 30,
        maxRepairRounds: 2,
        agentTimeoutMs: 8000,
        visualTimeoutMs: 30_000,
        reviewTimeoutMs: 5000,
        repairTimeoutMs: 6000,
        productionTimeoutMs: 50_000,
        timeoutMs: 80_000,
        imageRetryBaseDelayMs: 5,
        retryBaseDelayMs: 5,
        assets: new InMemoryAssetStore(),
        baseUrl: fake.url,
        now: new Date('2026-06-15T00:00:00Z'),
        ...o.config,
      },
      onEvent: (e) => void events.push(e),
      onCampaign: async (p, m) => void packages.push({ pkg: p, meta: m }),
    });
    const result = await handle.done;
    return { result, events, packages, fake };
  }
  const pkg = (o: Outcome) => o.packages[0].pkg;
  const evIndex = (o: Outcome, type: string) => o.events.findIndex((e) => e.type === type);
  const isCritique = (r: FakeRequest) => r.agent === 'creviewer' && r.lastUserText.includes('<concepts_to_critique>');

  it('without depth nothing changes: no concept critique runs and the diagnostic says so', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(evIndex(o, 'concept.review.requested'), -1);
    assert.equal(pkg(o).quality?.conceptCritique, null);
    assert.ok(pkg(o).quality?.skipped.some((s) => /concept critique/.test(s.what)));
    assert.ok(pkg(o).quality?.skipped.some((s) => /vision review/.test(s.what)));
  });

  it('depth: the concepts are critiqued BEFORE any image; a weak visual idea is rewritten, art direction reaches the Visual Creator, and it is all recorded', async () => {
    const better = 'A worn pencil ticking the last box of a handwritten checklist on a cluttered oak workbench, late afternoon light';
    const o = await run({
      config: { depth: true },
      openai: {
        reply: (req: FakeRequest): FakeReply | undefined => {
          if (!isCritique(req)) return undefined;
          const c = defaultConceptCritique(req.lastUserText);
          c.concepts[0] = { ...c.concepts[0], originality: 2, verdict: 'revise', problem: 'The picture idea could describe any company.', visualIdeaRevision: better, artDirection: 'Documentary photograph from above, the pencil tip is the focal point.' };
          return { text: JSON.stringify(c) };
        },
      },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    // order: critique requested and completed, then the Visual Creator is assigned and images are generated
    assert.ok(evIndex(o, 'concept.review.requested') >= 0);
    assert.ok(evIndex(o, 'concept.review.completed') > evIndex(o, 'concept.review.requested'));
    const visualAssigned = o.events.findIndex((e) => e.type === 'task.assigned' && (e.payload as { agent: string }).agent === 'Visual Creator');
    assert.ok(visualAssigned > evIndex(o, 'concept.review.completed'), 'no image is planned before the critique is in');
    assert.ok(evIndex(o, 'visual.generated') > evIndex(o, 'concept.review.completed'));
    // the weak concept was rewritten; the others kept; the history is in the diagnostic
    assert.equal(p.concepts[0].visualIdea, better);
    assert.notEqual(p.concepts[1].visualIdea, better);
    assert.equal(p.quality?.conceptCritique?.ran, true);
    assert.equal(p.quality?.conceptCritique?.modelReview, 'done');
    assert.equal(p.quality?.conceptCritique?.revised, 1);
    assert.equal(p.quality?.conceptCritique?.scores.length, 3);
    // a finding for it, fixed before the images
    const f = p.reviewFindings.find((x) => x.round === 0);
    assert.ok(f && f.status === 'fixed' && f.kind === 'generic_concept', JSON.stringify(f));
    // the art direction and the rewritten idea reached the Visual Creator
    const plan = o.fake.requests.find((r) => r.agent === 'vcreator' && r.kind === 'analysis');
    assert.ok(plan?.lastUserText.includes('artDirectionNote'), 'the Visual Creator was told the art direction');
    assert.ok(plan?.lastUserText.includes('worn pencil ticking'));
    // one critique call, accounted
    assert.equal(o.fake.requests.filter(isCritique).length, 1);
  });

  it('depth: when the critique cannot be produced the images are still made, and the omission is visible', async () => {
    const o = await run({
      config: { depth: true },
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (isCritique(req) ? { status: 400, json: { error: { code: 'bad_request', message: 'no' } } } : undefined) },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.fake.imageCalls().length, 3);
    assert.equal(pkg(o).quality?.conceptCritique?.modelReview, 'failed');
    assert.ok(pkg(o).quality?.skipped.some((s) => /concept critique before the images/.test(s.what)));
  });

  it('a weak rubric score that no issue explains becomes an unresolved finding: valid JSON never approves a weak campaign', async () => {
    const o = await run({
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.agent === 'creviewer' && !isCritique(req) && req.lastUserText.includes('<variants>') ? { text: JSON.stringify({ ...defaultCreativeReview(), scores: { productAccuracy: 4, brandConsistency: 4, audienceRelevance: 4, objectiveAlignment: 4, originality: 2, crossChannelConsistency: 4 } }) } : undefined) },
    });
    const p = pkg(o);
    assert.equal(p.quality?.rubric.latest?.originality, 2);
    assert.ok(p.quality!.rubric.history.length >= 1);
    const f = p.reviewFindings.find((x) => x.kind === 'generic_concept' && x.source === 'llm_text');
    assert.ok(f, 'the low score became a finding');
    assert.equal(f!.status, 'unresolved');
    assert.equal(p.approval.status, 'unresolved');
    assert.ok(p.quality!.findings.unresolved >= 1);
  });

  it('the text review gets the call to action as {text, type}: the internal type is no longer shown as visible text', async () => {
    const o = await run();
    const review = o.fake.requests.find((r) => r.agent === 'creviewer' && r.lastUserText.includes('<variants>'));
    assert.ok(review);
    assert.match(review!.lastUserText, /"cta": \{\s*"text":/);
    assert.doesNotMatch(review!.lastUserText, /"cta": "[^"]*\(learn_more\)"/);
  });

  it('a landing call to action that differs from the ads is aligned by a deterministic repair, without another model call or reworded text', async () => {
    const o = await run({
      openai: {
        reply: (req: FakeRequest): FakeReply | undefined => {
          if (req.agent !== 'landing' || req.kind !== 'analysis' || req.lastUserText.includes('Fix the landing page content findings')) return undefined;
          const l = defaultLanding(req.lastUserText);
          return { text: JSON.stringify({ ...l, content: { ...l.content, ctaObjective: 'register' } }) };
        },
      },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const f = p.reviewFindings.find((x) => x.kind === 'cta_mismatch' && x.severity === 'major');
    assert.ok(f, 'the mismatch was found');
    assert.equal(f!.status, 'fixed');
    assert.equal(p.landingContent?.ctaObjective, 'learn_more', 'the landing page now asks for what the ads ask for');
    const rev = p.revisions.find((r) => r.findingId === f!.id);
    assert.equal(rev?.operation, 'align_cta');
    assert.equal(rev?.status, 'applied');
    assert.equal(o.fake.requests.filter((r) => r.agent === 'landing' && r.lastUserText.includes('Fix the landing page content findings')).length, 0, 'no landing revision request: the alignment needed no model call');
  });

  it('an answer cut off by the output cap is asked again with a larger cap instead of failing the agent', async () => {
    const cut = (cap: number) => ({ json: { id: 'resp_cut', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, model: 'x', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"summary": "cut' }] }], usage: { input_tokens: 500, output_tokens: cap, total_tokens: 500 + cap, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    const o = await run({
      config: { maxOutputTokens: 800 },
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.agent === 'copywriter' && req.kind === 'analysis' && Number(req.body?.max_output_tokens) < 1600 ? cut(Number(req.body?.max_output_tokens)) : undefined) },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const asks = o.fake.requests.filter((r) => r.agent === 'copywriter' && r.kind === 'analysis').map((r) => Number(r.body?.max_output_tokens));
    assert.deepEqual(asks.slice(0, 2), [800, 1600], 'the same request again, with twice the cap');
    assert.ok((pkg(o).quality?.truncatedAnswersRetried ?? 0) >= 1);
    assert.equal(o.fake.requests.filter((r) => r.agent === 'copywriter').some((r) => r.body?.max_output_tokens === undefined), false);
    // the Copywriter delivered: the campaign has its concepts
    assert.equal(pkg(o).concepts.length, 3);
  });

  it('cut-off answers are never retried without bound', async () => {
    const cut = { json: { id: 'resp_cut', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, model: 'x', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"summary": "cut' }] }], usage: { input_tokens: 500, output_tokens: 800, total_tokens: 1300, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } };
    const o = await run({ config: { maxOutputTokens: 800 }, openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.agent === 'copywriter' && req.kind === 'analysis' ? cut : undefined) } });
    // original + two larger asks + the one repair attempt the agent makes (which escalates the same way): a small, fixed number
    assert.ok(o.fake.requests.filter((r) => r.agent === 'copywriter' && r.kind === 'analysis').length <= 6);
    assert.notEqual(o.result.status, 'completed', 'no copy could be produced, and that is reported, not hidden');
  });

  it('the spend controller is ONE shared budget for text and images (no separate pools)', () => {
    const b = new SpendBudget(5);
    assert.ok(b.tryReserve('text', 1.5));
    assert.ok(b.tryReserve('text', 0.6), 'text may use more than any fixed "text pool"');
    assert.ok(b.tryReserve('image', 2.9), 'and the images may use everything the text left');
    assert.equal(b.tryReserve('image', 0.2), null, 'the one total of 5.00 is what limits both');
    assert.equal(b.snapshot().remainingUsd, 0);
    assert.equal(b.snapshot().blocked, 1);
  });
});
