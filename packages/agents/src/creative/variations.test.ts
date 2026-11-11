import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { buildCampaignZip } from './export';
import { SpendBudget } from '../ai/budget';
import { capOutputTokens, cheaperImageModels, imageActualCostUsd, imageCostEstimate, maxOutputTokensFor, textCostUsd, textPrice, textReserveUsd } from '../ai/pricing';
import { imageModelWarning, retiredImageModel } from '../ai/image-models';
import type { RecordedEvent } from '../factory/state';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '../testing/fake-openai';
import { InMemoryAssetStore } from './assets';
import type { CreativeInput } from './context';
import { prepareContinuationSeed } from './continuation';
import { apportion, planImageAllocation, forecastAllocation, HARD_MAX_IMAGES } from './image-allocation';
import type { CampaignPackage } from './schemas';

// Pricing, the spend controller, the deterministic image allocation, and the 20-original-image production flow end to end on the REAL
// Mozaik runtime with a fake OpenAI (text and images over real HTTP). Nothing here is billed and no image comes from a real model.

describe('price book', () => {
  it('prices come from the verified book; an unknown model has NO price instead of an invented one', () => {
    assert.deepEqual(textPrice('gpt-4.1-mini'), { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 });
    assert.equal(textPrice('gpt-4.1-mini-2025-04-14')?.outputPerM, 1.6, 'a dated snapshot is priced like its family');
    assert.equal(textPrice('some-future-model'), null);
    assert.equal(textCostUsd('some-future-model', { inputTokens: 10, outputTokens: 10 }), null);
    // 1M fresh input + 1M output on gpt-4.1-mini = 0.40 + 1.60
    assert.equal(textCostUsd('gpt-4.1-mini', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 2);
    // cached input is priced at the cached rate
    assert.equal(textCostUsd('gpt-4.1-mini', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }), 0.1);
    assert.ok((textReserveUsd('gpt-4.1-mini', 30_000, 6000) ?? 0) > 0);
  });

  it('image prices: per-image tables, "auto" as an upper bound, GPT Image 2.5 honestly unavailable', () => {
    assert.deepEqual(imageCostEstimate('gpt-image-1-mini', 'medium', '1024x1024'), { usd: 0.011, basis: 'per_image_table', note: imageCostEstimate('gpt-image-1-mini', 'medium', '1024x1024').note });
    assert.equal(imageCostEstimate('gpt-image-1.5', 'low', '1024x1536').usd, 0.013);
    assert.equal(imageCostEstimate('gpt-image-2', 'high', '1536x1024').usd, 0.165);
    assert.equal(imageCostEstimate('gpt-image-1-mini', 'auto', '1024x1024').basis, 'upper_bound_auto');
    assert.equal(imageCostEstimate('gpt-image-1-mini', 'auto', '1024x1024').usd, 0.036);
    for (const m of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-9']) {
      const e = imageCostEstimate(m, 'medium', '1024x1024');
      assert.equal(e.usd, null, m);
      assert.equal(e.basis, 'unavailable');
    }
    assert.match(imageCostEstimate('gpt-image-2.5-flare', 'medium', '1024x1024').note, /billed by tokens/);
    // the real cost of a finished 2.5 image is still computed from what OpenAI reports: 1056 output tokens at $30 per 1M, 40 input at $5 per 1M
    assert.equal(imageActualCostUsd('gpt-image-2.5-flare', { input: 40, output: 1056 }), (40 * 5 + 1056 * 30) / 1_000_000);
    assert.equal(imageActualCostUsd('gpt-image-9', { input: 1, output: 1 }), null);
    assert.equal(cheaperImageModels('medium', '1024x1024')[0].model, 'gpt-image-1-mini');
  });

  it('never submits an output limit the model may not support', () => {
    assert.deepEqual(maxOutputTokensFor('gpt-4.1-mini'), { limit: 32_768, verified: true });
    assert.deepEqual(capOutputTokens('gpt-4.1-mini', 12_000), { tokens: 12_000, capped: false });
    assert.deepEqual(capOutputTokens('gpt-4.1-mini', 99_999), { tokens: 32_768, capped: true });
    assert.deepEqual(capOutputTokens('an-unverified-model', 12_000), { tokens: 4096, capped: true });
    assert.deepEqual(capOutputTokens('an-unverified-model', 3000), { tokens: 3000, capped: false });
  });

  it('gpt-image-1-mini works until its announced shutdown on 2026-12-01 and is warned about before', () => {
    assert.equal(retiredImageModel('gpt-image-1-mini', new Date('2026-11-30T00:00:00Z')), null);
    assert.ok(retiredImageModel('gpt-image-1-mini', new Date('2026-12-01T00:00:00Z')));
    assert.match(imageModelWarning('gpt-image-1-mini', new Date('2026-10-31T00:00:00Z')) ?? '', /shut down gpt-image-1-mini on 2026-12-01 \(in 31 days\)/);
    assert.equal(imageModelWarning('gpt-image-1.5', new Date('2026-10-31T00:00:00Z')), null);
  });
});

describe('spend controller', () => {
  it('reserves before a request, refuses what would exceed the approved amount and never raises it', () => {
    const b = new SpendBudget(1);
    const a = b.tryReserve('image', 0.4)!;
    const c = b.tryReserve('image', 0.4)!;
    assert.ok(a && c);
    assert.equal(b.tryReserve('image', 0.4), null, 'the third request would exceed 1.00');
    assert.equal(b.snapshot().blocked, 1);
    assert.equal(b.snapshot().reservedUsd, 0.8);
    b.settle(a, 0.3); // the real cost is lower than the reservation
    b.release(c); // a request the provider rejected: nothing billed
    assert.equal(b.snapshot().spentUsd, 0.3);
    assert.equal(b.snapshot().reservedUsd, 0);
    assert.ok(b.tryReserve('image', 0.6), 'released money is available again');
    assert.equal(b.approvedUsd, 1, 'the approved amount never changes');
  });

  it('a request that timed out stays counted as uncertain spend', () => {
    const b = new SpendBudget(1);
    const r = b.tryReserve('image', 0.25)!;
    b.markUncertain(r);
    const s = b.snapshot();
    assert.equal(s.uncertainUsd, 0.25);
    assert.equal(s.committedUsd, 0.25);
    assert.equal(b.remainingUsd, 0.75);
  });

  it('an unpriced request cannot be bounded: it is allowed, counted as unpriced, and never silently priced', () => {
    const b = new SpendBudget(0.01);
    const r = b.tryReserve('text', null)!;
    assert.ok(r);
    b.settle(r, null);
    assert.equal(b.snapshot().unpriced, 1);
    assert.equal(b.snapshot().spentUsd, 0);
    assert.equal(new SpendBudget(null).tryReserve('image', 999) !== null, true, 'no cap, no refusal');
  });
});

describe('image allocation planner', () => {
  const concepts = (n: number, channels: ('instagram' | 'facebook' | 'linkedin' | 'youtube')[] = ['instagram', 'facebook']) => Array.from({ length: n }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels }));

  it('apportions exactly the target, at least one per concept, never above the cap, ties to the earlier concept', () => {
    assert.deepEqual(apportion(20, [1, 1, 1, 1, 1], 8), [4, 4, 4, 4, 4]);
    assert.deepEqual(apportion(20, [5, 5, 4, 3, 3], 8).reduce((a, b) => a + b, 0), 20);
    assert.equal(apportion(3, [1, 1, 1, 1, 1], 8).reduce((a, b) => a + b, 0), 3);
    const capped = apportion(20, [10, 1, 1], 5);
    assert.ok(capped.every((c) => c <= 5));
    assert.equal(capped.reduce((a, b) => a + b, 0), 15, 'only what the cap allows is placed');
  });

  it('20 images over 5 concepts: exactly 20, every concept served, same input = same plan', () => {
    const input = { target: 20, concepts: concepts(5), channelPriority: ['instagram' as const, 'facebook' as const], fixedSize: null, layoutsPerOriginal: 3 };
    const plan = planImageAllocation(input);
    assert.equal(plan.target, 20);
    assert.equal(plan.allocated, 20);
    assert.equal(plan.variations.length, 20);
    assert.ok(plan.perConcept.every((c) => c.count >= 1 && c.count <= plan.maxPerConcept));
    assert.equal(new Set(plan.variations.map((v) => v.variationId)).size, 20, 'every image has its own identity');
    assert.deepEqual(planImageAllocation(input), plan, 'deterministic');
  });

  it('the strategy decides: a concept covering more / better ranked channels gets more images', () => {
    const plan = planImageAllocation({
      target: 12,
      concepts: [
        { id: 'K1', name: 'Broad', channels: ['instagram', 'facebook', 'linkedin'] },
        { id: 'K2', name: 'Narrow', channels: ['youtube'] },
      ],
      channelPriority: ['instagram', 'facebook', 'linkedin', 'youtube'],
      fixedSize: null,
      layoutsPerOriginal: 3,
    });
    const [k1, k2] = plan.perConcept;
    assert.ok(k1.count > k2.count, `${k1.count} vs ${k2.count}`);
    assert.equal(k1.count + k2.count, 12);
  });

  it('images of one concept differ in role, camera perspective and lighting; layouts are planned per original', () => {
    const plan = planImageAllocation({ target: 20, concepts: concepts(5), channelPriority: ['instagram', 'facebook'], fixedSize: null, layoutsPerOriginal: 3 });
    for (const c of plan.perConcept) {
      const mine = plan.variations.filter((v) => v.conceptId === c.conceptId);
      assert.equal(new Set(mine.map((v) => `${v.role}|${v.perspective}|${v.lighting}`)).size, mine.length, `${c.conceptId}: seeds repeat`);
      assert.equal(new Set(mine.map((v) => v.perspective)).size, mine.length);
    }
    assert.ok(plan.variations.every((v) => v.formats.length >= 1 && v.formats.length <= 3 && v.targetChannels.length >= 1));
    assert.equal(plan.expectedLayouts, plan.variations.reduce((n, v) => n + v.formats.length, 0));
    assert.ok(plan.expectedLayouts > plan.variations.length, '20 originals produce more than 20 layouts');
  });

  it('is honest when the target cannot be placed, and limits one campaign to the hard maximum', () => {
    const small = planImageAllocation({ target: 20, concepts: concepts(1), channelPriority: ['instagram'], fixedSize: null, layoutsPerOriginal: 2, maxPerConcept: 8 });
    assert.equal(small.allocated, 8);
    assert.match(small.warnings.join(' '), /Only 8 of the 20/);
    assert.equal(planImageAllocation({ target: 500, concepts: concepts(5), channelPriority: [], fixedSize: null, layoutsPerOriginal: 2 }).target, HARD_MAX_IMAGES);
    assert.equal(forecastAllocation({ target: 20, conceptCount: 5, channels: ['instagram', 'facebook'], fixedSize: null, layoutsPerOriginal: 3 }).basis, 'forecast');
  });
});

// ---- the production flow ----------------------------------------------------------------------------------------------------------

const KEY = 'sk-test-VARIATIONS1234567890abcdefghij';
const IMAGE_MODEL = 'gpt-image-1.5';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}

describe('F4 with 20 original AI images (real Mozaik agents; fake text and image APIs)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const input = (o: Partial<CreativeInput> = {}): CreativeInput => ({ projectName: 'Deep Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 5, landing: true, ...o });

  async function run(o: { config?: Partial<CreativeRunConfig>; input?: Partial<CreativeInput>; openai?: FakeOpenAIOptions; seedStore?: InMemoryAssetStore } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = o.seedStore ?? new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: 'f4-var-1',
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
        imageModel: IMAGE_MODEL,
        imageQuality: 'low',
        variations: true,
        maxImages: 20,
        imageConcurrency: 3,
        layoutsPerOriginal: 2,
        maxModelCalls: 60,
        maxRepairRounds: 1,
        agentTimeoutMs: 8000,
        visualTimeoutMs: 40_000,
        reviewTimeoutMs: 5000,
        repairTimeoutMs: 6000,
        productionTimeoutMs: 60_000,
        timeoutMs: 90_000,
        imageRetryBaseDelayMs: 5,
        retryBaseDelayMs: 5,
        assets: store,
        baseUrl: fake.url,
        now: new Date('2026-06-15T00:00:00Z'),
        ...o.config,
      },
      onEvent: (e) => void events.push(e),
      onCampaign: async (p, m) => void packages.push({ pkg: p, meta: m }),
    });
    const result = await handle.done;
    return { result, events, packages, store, fake };
  }
  const pkg = (o: Outcome) => o.packages[0].pkg;
  const subjectLine = (prompt: string) => /SUBJECT: (.*)/.exec(prompt)?.[1] ?? '';

  it('exactly 20 images are planned, requested, generated and stored as 20 distinct originals', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.equal(p.concepts.length, 5);
    assert.equal(p.imageAllocation?.target, 20);
    assert.equal(p.imageAllocation?.allocated, 20);
    assert.equal(p.imageAllocation?.basis, 'concepts');
    assert.deepEqual(p.imageCounts, { requested: 20, planned: 20, attempted: 20, generated: 20, failed: 0, skipped: 0, blockedByBudget: 0 });
    // one provider request per image: 20 requests, 20 different prompts
    const calls = o.fake.imageCalls();
    assert.equal(calls.length, 20);
    const prompts = calls.map((c) => String(c.body?.prompt));
    assert.equal(new Set(prompts).size, 20, 'no duplicate prompt was sent');
    assert.equal(new Set(prompts.map(subjectLine)).size, 20, 'every picture has its own subject');
    assert.ok(prompts.every((x) => /CONCEPTUAL MARKETING VISUAL/.test(x) && /not a photograph of a real place, product or person/.test(x)), 'labelled as conceptual imagery');
    // 20 variation records with their own identity, prompt and asset
    assert.equal(p.imageVariations.length, 20);
    assert.equal(new Set(p.imageVariations.map((v) => v.variationId)).size, 20);
    assert.equal(new Set(p.imageVariations.map((v) => v.generatedAssetId)).size, 20);
    assert.ok(p.imageVariations.every((v) => v.status === 'generated' && v.requestAttempted && v.providerModel === IMAGE_MODEL && v.quality === 'low' && v.imagePrompt.length > 50 && v.conceptual));
    assert.equal(new Set(p.imageVariations.map((v) => v.imagePrompt)).size, 20);
    // the stored originals: 20 distinct AI files (different bytes), each tied to its concept and variation
    const originals = p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image');
    assert.equal(originals.length, 20);
    assert.equal(new Set(originals.map((a) => a.id)).size, 20);
    assert.equal(new Set(originals.map((a) => a.sha256)).size, 20, 'the 20 files are different pictures');
    assert.equal(p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'brand_gradient').length, 0, 'no stand-in picture exists');
    for (const v of p.imageVariations) {
      const a = originals.find((x) => x.id === v.generatedAssetId)!;
      assert.equal(a.conceptId, v.conceptId);
      assert.equal(a.variationId, v.variationId);
      assert.equal(p.imageAllocation!.variations.find((s) => s.variationId === v.variationId)!.conceptId, v.conceptId, 'the original belongs to the planned concept');
    }
    // the allocation really spread the images over the concepts
    for (const c of p.imageAllocation!.perConcept) assert.equal(p.imageVariations.filter((v) => v.conceptId === c.conceptId).length, c.count);
    assert.ok(p.imageAllocation!.perConcept.every((c) => c.count >= 1));
  });

  it('layouts are cut locally from the originals and every layout names its source image', async () => {
    const o = await run();
    const p = pkg(o);
    assert.equal(o.fake.imageCalls().length, 20, 'layouts never call the image model');
    const originals = new Map(p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image').map((a) => [a.id, a]));
    assert.ok(p.channelLayouts.length > 20, `${p.channelLayouts.length} layouts from 20 originals`);
    for (const l of p.channelLayouts) {
      const base = originals.get(l.baseAssetId);
      assert.ok(base, `layout ${l.id} has no original`);
      assert.equal(l.variationId, base!.variationId);
      assert.equal(l.conceptId, base!.conceptId);
      const asset = p.imageAssets.find((a) => a.id === l.assetId)!;
      assert.equal(asset.parentAssetId, base!.id);
      assert.equal(asset.variationId, base!.variationId);
    }
    // every original that has layouts only got the formats planned for it
    for (const slot of p.imageAllocation!.variations) {
      const v = p.imageVariations.find((x) => x.variationId === slot.variationId)!;
      const mine = p.channelLayouts.filter((l) => l.baseAssetId === v.generatedAssetId);
      assert.ok(mine.length >= 1 && mine.length <= slot.formats.length, `${slot.variationId}: ${mine.length} of ${slot.formats.length}`);
    }
    assert.equal(p.cost?.approvedUsd, null);
  });

  it('the ZIP holds all 20 originals under images/originals and a manifest that only points at files that exist', async () => {
    const o = await run();
    const p = pkg(o);
    const { zip, manifest } = await buildCampaignZip(p, o.store, { strategy: { strategyId: p.f3StrategyId } });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files);
    const originals = names.filter((n) => /^images\/originals\/concept-\d\d-variation-\d\d\.png$/.test(n));
    assert.equal(originals.length, 20);
    for (const dir of ['campaign.json', 'strategy/strategy.json', 'strategy/image-allocation.json', 'copy/', 'images/layouts/', 'landing/landing-content.json', 'review/findings.json', 'usage/usage.json', 'images/asset-manifest.json']) assert.ok(names.some((n) => n === dir || n.startsWith(dir)), dir);
    const am = JSON.parse(await z.file('images/asset-manifest.json')!.async('string')) as { entries: { concept: { id: string }; variation: { id: string } | null; original: { file: string | null; status: string; model: string | null }; layouts: { file: string }[] }[] };
    assert.equal(am.entries.length, 20);
    assert.equal(new Set(am.entries.map((e) => e.original.file)).size, 20);
    for (const e of am.entries) {
      assert.ok(e.original.file && names.includes(e.original.file), `missing ${e.original.file}`);
      assert.equal(e.original.model, IMAGE_MODEL);
      assert.ok(e.layouts.length >= 1 && e.layouts.every((l) => names.includes(l.file)), 'a layout points at a file that is not in the archive');
    }
    // the files are real, different pictures
    const hashes = new Set<string>();
    for (const n of originals) {
      const buf = await z.file(n)!.async('nodebuffer');
      assert.equal((await sharp(buf).metadata()).format, 'png');
      hashes.add(createHash('sha256').update(buf).digest('hex'));
    }
    assert.equal(hashes.size, 20);
    assert.deepEqual(manifest.assetsMissing, []);
    // no layout file name is shared between two originals
    const layoutFiles = names.filter((n) => n.startsWith('images/layouts/') && n.endsWith('.png'));
    assert.equal(new Set(layoutFiles).size, layoutFiles.length);
  });

  it('a campaign with failed images exports only the images that exist and says so in the manifest', async () => {
    const o = await run({
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && /SUBJECT: [^\n]*image 3\b/.test(String(req.body?.prompt)) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Rejected.' } } } : undefined) },
    });
    const p = pkg(o);
    const { zip } = await buildCampaignZip(p, o.store);
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files);
    assert.equal(names.filter((n) => /^images\/originals\//.test(n)).length, p.imageCounts!.generated);
    const am = JSON.parse(await z.file('images/asset-manifest.json')!.async('string')) as { entries: { original: { file: string | null; status: string } }[] };
    const failed = am.entries.filter((e) => e.original.status === 'failed');
    assert.equal(failed.length, p.imageCounts!.failed);
    assert.ok(failed.every((e) => e.original.file === null), 'a failed image has no file and is not pointed at');
    assert.equal(names.filter((n) => /brand|gradient/.test(n)).length, 0, 'no fake image is exported as a generated one');
  });

  it('records the cost of what really ran next to the approved amount', async () => {
    const o = await run({ config: { spendCapUsd: 5 } });
    const p = pkg(o);
    assert.equal(p.cost?.approvedUsd, 5);
    // 20 images x (40 input at $5 + 1056 output at $32 per 1M) = 20 x 0.034
    assert.ok(Math.abs((p.cost?.imageUsd ?? 0) - 20 * ((40 * 5 + 1056 * 32) / 1_000_000)) < 1e-6, String(p.cost?.imageUsd));
    assert.ok((p.cost?.spentUsd ?? 0) >= (p.cost?.imageUsd ?? 1) - 1e-9);
    assert.equal(p.cost?.blockedRequests, 0);
    assert.ok(p.usage.images.costUsd && p.usage.images.costUsd > 0);
    assert.match(p.cost?.note ?? '', /not an OpenAI invoice/);
  });

  it('a failed image is recorded with the provider reason, successful images stay, and the campaign is not "complete"', async () => {
    const o = await run({
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && /SUBJECT: [^\n]*image 3\b/.test(String(req.body?.prompt)) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } } } : undefined) },
    });
    const p = pkg(o);
    const failed = p.imageVariations.filter((v) => v.status === 'failed');
    assert.ok(failed.length >= 1);
    assert.equal(p.imageCounts!.generated + p.imageCounts!.failed, 20);
    for (const v of failed) {
      assert.equal(v.generatedAssetId, null);
      assert.equal(v.safeError?.providerCode, 'moderation_blocked');
      assert.equal(v.safeError?.status, 400);
      assert.match(v.explanation ?? '', /safety system declined/);
    }
    // no stand-in asset and no layout for a failed image; the originals that worked keep theirs
    assert.equal(p.imageAssets.filter((a) => a.source === 'brand_gradient').length, 0);
    assert.equal(p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image').length, p.imageCounts!.generated);
    assert.equal(p.approval.status === 'approved', false, 'an incomplete image set is never plain "approved"');
    assert.ok(p.limitations.some((l) => new RegExp(`${p.imageCounts!.generated} of the 20 requested original AI images were generated`).test(l)));
    // a failed request is never retried without authorization (400 is not retryable)
    assert.equal(o.fake.imageCalls().length, 20);
  });

  it('a systematic error stops further paid image requests and explains why', async () => {
    const o = await run({
      config: { imageConcurrency: 1 },
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' ? { status: 403, json: { error: { code: 'permission_denied', message: 'Your organization must be verified to use this model.' } } } : undefined) },
    });
    const p = pkg(o);
    assert.equal(o.fake.imageCalls().length, 1, 'one request, then the rest were not sent');
    assert.equal(p.imageCounts?.generated, 0);
    assert.equal(p.imageCounts?.attempted, 1);
    assert.equal(p.imageVariations.length, 20);
    assert.ok(p.imageVariations.slice(1).every((v) => !v.requestAttempted && /Not attempted/.test(v.explanation ?? '')));
    assert.match(p.imageVariations[0].explanation ?? '', /organization verification/);
  });

  it('the approved spending limit stops new requests before they are sent: the shortfall is "blocked by budget", not hidden', async () => {
    const o = await run({ config: { spendCapUsd: 0.1, imageConcurrency: 2 } });
    const p = pkg(o);
    const n = o.fake.imageCalls().length;
    assert.ok(n >= 1 && n < 20, `${n} requests`);
    assert.equal(p.imageCounts?.attempted, n);
    assert.equal(p.imageCounts!.generated + p.imageCounts!.blockedByBudget + p.imageCounts!.failed, 20);
    assert.ok(p.imageCounts!.blockedByBudget > 0);
    assert.ok(p.imageVariations.filter((v) => v.status === 'blocked_by_budget').every((v) => v.stage === 'budget' && !v.requestAttempted && /spending limit/.test(v.explanation ?? '')));
    assert.ok((p.cost?.spentUsd ?? 0) <= 0.1 + 1e-9, `spent ${p.cost?.spentUsd}`);
    assert.ok((p.cost?.blockedRequests ?? 0) >= 1);
    assert.equal(p.approval.status === 'approved', false);
  });

  it('a rate limit is waited out for the provider Retry-After and the image is then generated: one retry, not a storm', async () => {
    const started = Date.now();
    const o = await run({
      config: { maxImages: 4, imageConcurrency: 2 },
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && req.attempt === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: { error: { code: 'rate_limit_exceeded', message: 'Slow down.' } } } : undefined) },
    });
    const p = pkg(o);
    assert.equal(p.imageCounts?.generated, 4);
    assert.equal(o.fake.imageCalls().length, 5, 'one rate-limited attempt plus four images');
    assert.equal(p.usage.images.rateLimited, 1);
    assert.ok(Date.now() - started >= 900, 'Retry-After was honored');
    const rejected = o.fake.imageCalls()[0];
    const later = o.fake.imageCalls().slice(1);
    assert.ok(rejected && later.length === 4);
  });

  it('a provider that keeps rate-limiting is never hammered: a hard attempt cap per image, no endless retries', async () => {
    const o = await run({
      config: { maxImages: 6, imageConcurrency: 3 },
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' ? { status: 429, headers: { 'retry-after': '0' }, json: { error: { code: 'rate_limit_exceeded', message: 'Slow down.' } } } : undefined) },
    });
    const p = pkg(o);
    // 6 images x (1 attempt + 1 retry) at most; none of them became a picture and each says why
    assert.ok(o.fake.imageCalls().length <= 12, `${o.fake.imageCalls().length} image requests`);
    assert.equal(p.imageCounts?.generated, 0);
    assert.equal(p.imageCounts?.failed, 6);
    assert.ok(p.imageVariations.every((v) => v.status === 'failed' && /rate limit/i.test(v.explanation ?? '')));
    assert.equal(p.cost?.imageUsd ?? 0, 0, 'a rate-limited request is not billed');
    assert.ok((p.usage.images.rateLimited ?? 0) >= 6);
  });

  it('an image model without a published per-image price is learned from its first image (one at a time under a spending limit)', async () => {
    const o = await run({ config: { imageModel: 'gpt-image-2.5-flare', maxImages: 6, imageConcurrency: 3, spendCapUsd: 5 } });
    const p = pkg(o);
    assert.equal(p.imageCounts?.generated, 6);
    // actual cost per image from the reported usage: (40 x $5 + 1056 x $30) per 1M
    assert.ok(Math.abs((p.cost?.imageUsd ?? 0) - 6 * ((40 * 5 + 1056 * 30) / 1_000_000)) < 1e-6);
    // the planning step is honest about that model having no estimate
    assert.equal(imageCostEstimate('gpt-image-2.5-flare', 'low', '1024x1024').usd, null);
  });

  it('text requests are budgeted too: with a verified price and a limit that cannot cover the first request, nothing is sent', async () => {
    const o = await run({ config: { model: 'gpt-4.1-mini', spendCapUsd: 0.0001 } });
    assert.equal(o.fake.requests.filter((r) => r.path.endsWith('/responses')).length, 0, 'no text request left the process');
    assert.equal(o.fake.imageCalls().length, 0);
    const failed = o.events.filter((e) => e.type === 'task.completed').map((e) => e.payload as { agent: string; outcome: string; error?: { code: string } }).find((p) => p.agent === 'Copywriter');
    assert.equal(failed?.outcome, 'failed');
    assert.equal(failed?.error?.code, 'spend_limit');
    assert.equal(o.result.status === 'completed', false);
  });

  it('image-only continuation: only the missing images are requested, copy and strategy are not repeated, the earlier campaign is untouched', async () => {
    const first = await run({
      openai: { reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && /SUBJECT: [^\n]*image 3\b/.test(String(req.body?.prompt)) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Rejected.' } } } : undefined) },
    });
    const p1 = pkg(first);
    const missing = p1.imageVariations.filter((v) => v.status !== 'generated').length;
    assert.ok(missing >= 1 && missing < 20, `${missing} missing`);
    const before = JSON.stringify([...first.store.records.values()].map((r) => [r.id, r.status, r.sha256]));
    const to = new InMemoryAssetStore();
    const seed = await prepareContinuationSeed(p1, first.store, to);
    assert.equal(seed.parentCampaignId, p1.id);
    assert.equal(seed.assets.filter((a) => a.kind === 'image').length, 20 - missing);

    const second = await run({ seedStore: to, config: { seed, maxImages: missing } });
    assert.equal(second.result.status, 'completed', second.result.errorMessage ?? '');
    const p2 = pkg(second);
    // only the missing images were requested; no research, copy, landing or picture-planning request was made again
    assert.equal(second.fake.imageCalls().length, missing);
    const agentsSeen = new Set(second.fake.requests.filter((r) => r.path.endsWith('/responses')).map((r) => r.agent));
    assert.equal(agentsSeen.has('copywriter'), false);
    assert.equal(agentsSeen.has('landing'), false);
    assert.equal(agentsSeen.has('vcreator'), false);
    // the finished campaign has all 20 originals (earlier ones copied, the rest new), each with layouts, none counted twice
    // the tally describes the campaign's 20 images (each was attempted at some point); what THIS run sent is in usage.images.requested
    assert.deepEqual(p2.imageCounts, { requested: 20, planned: 20, attempted: 20, generated: 20, failed: 0, skipped: 0, blockedByBudget: 0 });
    assert.equal(p2.usage.images.requested, missing);
    const originals = p2.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded');
    assert.equal(originals.length, 20);
    assert.equal(new Set(originals.map((a) => a.sha256)).size, 20);
    assert.equal(new Set(p2.imageVariations.map((v) => v.generatedAssetId)).size, 20);
    for (const l of p2.channelLayouts) assert.ok(originals.some((a) => a.id === l.baseAssetId && a.variationId === l.variationId));
    assert.deepEqual(p2.lineage, { kind: 'image_continuation', revision: 2, parentCampaignId: p1.id, reusedAssets: seed.reusedAssets });
    assert.equal(p2.copyVariants.length, p1.copyVariants.length);
    assert.deepEqual(p2.landingContent, p1.landingContent);
    assert.equal(p2.approval.status === 'unresolved', false);
    // the earlier campaign and its files were not changed
    assert.equal(JSON.stringify([...first.store.records.values()].map((r) => [r.id, r.status, r.sha256])), before);
    assert.equal(p1.imageCounts?.generated, 20 - missing);
  });

  it('a campaign made with one image per concept cannot be continued', async () => {
    const o = await run({ config: { variations: false, maxImages: 3 }, input: { concepts: 3 } });
    await assert.rejects(() => prepareContinuationSeed(pkg(o), o.store, new InMemoryAssetStore()), /one image per concept/);
  });

  it('First Test and Demo behavior is unchanged: one image per concept and no variation records', async () => {
    const o = await run({ config: { variations: false, maxImages: 3 }, input: { concepts: 3 } });
    const p = pkg(o);
    assert.equal(o.fake.imageCalls().length, 3);
    assert.equal(p.imageAllocation, null);
    assert.deepEqual(p.imageVariations, []);
    assert.equal(p.imageCounts, null);
    assert.equal(p.imageResults.length, 3);
  });
});
