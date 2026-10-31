import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import { InMemoryAssetStore } from './assets';
import type { CreativeInput } from './context';
import { CREATIVE_FORMATS } from './formats';
import type { CampaignPackage } from './schemas';
import type { RecordedEvent } from '../factory/state';
import { MozaikCampaignRuntime, RuntimeInitError, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, makeF1, makeF2, type Chain } from '../testing/chain';
import { defaultCopy, sanitize } from '../testing/fake-creative';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '../testing/fake-openai';
import { makePng } from '../testing/fixtures';

// F4 Creative Production end to end: the REAL Mozaik runtime, participants, dynamic registration of the Fixer and the review/repair
// loop. Only the outside world is faked (the OpenAI text API and the OpenAI image API, both served by a local fake over real HTTP).
// No image in this file comes from a real model, and nothing is billed.

const KEY = 'sk-test-F4RUNKEY1234567890abcdefghij';
const IMAGE_MODEL = 'gpt-image-test';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}
const names = (o: Outcome, type: string) => o.events.filter((e) => e.type === type).map((e) => e.payload as Record<string, any>);
const events = (o: Outcome, type: string) => o.events.filter((e) => e.type === type);
const pkg = (o: Outcome) => o.packages[0].pkg;
const meta = (o: Outcome) => o.packages[0].meta;
const state = (o: Outcome, agent: string) => meta(o).participants.find((p) => p.agent === agent)?.state;
const textCalls = (o: Outcome) => o.fake.requests.filter((r) => r.path.endsWith('/responses'));

describe('F4 Creative Production (real Mozaik agents; fake text and image APIs)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  let unhandled = 0;
  const onUnhandled = () => void unhandled++;
  const sharedRuntime = () => new MozaikCampaignRuntime();

  before(async () => {
    chain = await buildChain();
  });
  beforeEach(() => {
    unhandled = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  after(() => undefined);

  const input = (o: Partial<CreativeInput> = {}): CreativeInput => ({ projectName: 'Deep Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 3, landing: true, ...o });

  async function run(
    o: {
      chain?: Chain;
      input?: Partial<CreativeInput>;
      config?: Partial<CreativeRunConfig>;
      openai?: FakeOpenAIOptions;
      fake?: FakeOpenAI;
      store?: InMemoryAssetStore;
      key?: string;
      runId?: string;
      cancelWhen?: (events: RecordedEvent[]) => boolean;
      /** Cancel the run as soon as the fake receives a matching request (e.g. the first image request). */
      cancelOnRequest?: (req: FakeRequest) => boolean;
      runtime?: MozaikCampaignRuntime;
    } = {},
  ): Promise<Outcome> {
    const c = o.chain ?? chain;
    let cancel: (() => void) | null = null;
    const inner = o.openai?.reply;
    const openai: FakeOpenAIOptions | undefined = o.cancelOnRequest
      ? {
          ...o.openai,
          reply: (req) => {
            if (o.cancelOnRequest!(req) && cancel) {
              const c2 = cancel;
              cancel = null;
              setTimeout(c2, 30);
            }
            return inner?.(req);
          },
        }
      : o.openai;
    const fake = o.fake ?? (await new FakeOpenAI(openai).start());
    if (!o.fake) servers.push(fake);
    const store = o.store ?? new InMemoryAssetStore();
    const runtime = o.runtime ?? sharedRuntime();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const handle = await runtime.startRun({
      runId: o.runId ?? 'f4-run-1',
      projectId: 'project-1',
      userId: 'user-1',
      mode: 'creative_production',
      manifest: { productName: 'Deep Diving School' },
      credentials: { provider: 'openai', apiKey: o.key ?? KEY },
      creative: {
        campaignId: 'campaign-1',
        projectId: 'project-1',
        f1: c.f1,
        f2: c.f2,
        f3: c.f3,
        input: input(o.input),
        model: 'gpt-test-mini',
        imageModel: IMAGE_MODEL,
        imageQuality: 'low',
        maxModelCalls: 20,
        agentTimeoutMs: 6000,
        visualTimeoutMs: 15_000,
        reviewTimeoutMs: 4000,
        repairTimeoutMs: 6000,
        productionTimeoutMs: 25_000,
        imageRetryBaseDelayMs: 5,
        retryBaseDelayMs: 5,
        assets: store,
        baseUrl: fake.url,
        now: new Date('2026-06-15T00:00:00Z'),
        ...o.config,
      },
      onEvent: (e) => {
        events.push(e);
        if (o.cancelWhen?.(events) && cancel) {
          const c2 = cancel;
          cancel = null;
          queueMicrotask(c2);
        }
      },
      onCampaign: async (p, m) => void packages.push({ pkg: p, meta: m }),
    });
    cancel = () => void handle.cancel();
    const result = await handle.done;
    return { result, events, packages, store, fake };
  }

  const bad = (text: string) => ({ text: JSON.stringify(text) });
  /** Copywriter answer whose first variant makes a promise the material does not support. */
  const badCopyReply = (req: FakeRequest): FakeReply | undefined => {
    if (req.agent !== 'copywriter' || req.kind !== 'analysis' || req.lastUserText.includes('Revise ONLY')) return undefined;
    const copy = defaultCopy(req.lastUserText);
    copy.variants[0].body = `${copy.variants[0].body} Guaranteed results for everyone.`;
    return { text: JSON.stringify(copy) };
  };

  /** Asset ids the vision review was shown (parsed from the prompt the reviewer actually received). */
  const shownAssets = (req: FakeRequest): string[] => {
    const m = /"assets": (\[[\s\S]*?\n {2}\])/.exec(req.lastUserText);
    return m ? (JSON.parse(m[1]) as { assetId: string }[]).map((a) => a.assetId) : [];
  };

  // ------------------------------------------------------------------------------------------------------------------------------

  it('1. the full chain: six participants, real image requests, layouts rendered from the base images, a valid package', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.packages.length, 1);
    const p = pkg(o);
    assert.equal(p.f1ReportId, chain.f1.reportId);
    assert.equal(p.f2ReportId, chain.f2.auditId);
    assert.equal(p.f3StrategyId, chain.f3.strategyId);
    assert.equal(p.concepts.length, 3);
    assert.ok(p.copyVariants.length >= 3);
    assert.ok(p.landingContent);
    // one image request per concept; layouts do not call the image model
    assert.equal(o.fake.imageCalls().length, 3);
    const bases = p.imageAssets.filter((a) => a.kind === 'image');
    const layouts = p.imageAssets.filter((a) => a.kind === 'layout');
    assert.equal(bases.length, 3);
    assert.ok(bases.every((a) => a.source === 'ai_image' && a.model === IMAGE_MODEL));
    assert.equal(layouts.length, p.channelLayouts.length);
    assert.ok(layouts.length >= 6, `expected several layouts, got ${layouts.length}`);
    // every layout is a real PNG of exactly its format size, stored under its asset id
    for (const a of layouts) {
      const bytes = await o.store.load(a.id);
      const m = await sharp(bytes).metadata();
      const f = CREATIVE_FORMATS[a.format!];
      assert.deepEqual([m.width, m.height], [f.width, f.height]);
      assert.equal(a.sha256.length, 64);
    }
    assert.equal(state(o, 'Copywriter'), 'done');
    assert.equal(state(o, 'Visual Creator'), 'done');
    assert.equal(state(o, 'Layout Designer'), 'done');
    assert.equal(state(o, 'Landing Content Builder'), 'done');
    assert.equal(p.approval.status, 'approved');
    assert.equal(unhandled, 0);
  });

  it('2. genuine Mozaik collaboration: real participants, no Fixer when nothing needs repair, ordered events', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const types = o.events.map((e) => e.type);
    const who = (type: string) => [...new Set(events(o, type).map((e) => e.participant))];
    assert.deepEqual(who('copy.proposed'), ['Copywriter']);
    assert.deepEqual(who('landing.proposed'), ['Landing Content Builder']);
    assert.deepEqual(who('visual.generated'), ['Visual Creator']);
    assert.deepEqual(who('layout.completed'), ['Layout Designer']);
    assert.deepEqual(who('review.completed'), ['Content & Brand Reviewer']);
    assert.deepEqual(who('campaign.completed'), ['Creative Coordinator']);
    // Landing <-> Copywriter and Visual Creator -> Copywriter cross-checks, answered by the right participant
    const reqs = names(o, 'crosscheck.requested').map((r) => `${r.producer}>${r.reviewer}`);
    assert.ok(reqs.includes('Landing Content Builder>Copywriter'), reqs.join(','));
    assert.ok(reqs.includes('Copywriter>Landing Content Builder'), reqs.join(','));
    assert.ok(reqs.includes('Visual Creator>Copywriter'), reqs.join(','));
    assert.equal(names(o, 'crosscheck.answered').length, reqs.length);
    // fan-in: the review starts only after copy, landing and every concept's layouts exist
    const reviewAt = types.indexOf('review.requested');
    assert.ok(reviewAt > types.lastIndexOf('copy.proposed') && reviewAt > types.lastIndexOf('landing.proposed') && reviewAt > types.lastIndexOf('layout.completed'));
    assert.equal(events(o, 'review.requested').length, 1);
    // no problem found -> no Fixer is created and the product says so
    assert.equal(names(o, 'participant.registered').length, 0);
    assert.ok(names(o, 'participant.idle').some((p) => p.agent === 'Fixer'));
    assert.equal(state(o, 'Fixer'), 'skipped');
    assert.deepEqual(pkg(o).revisions, []);
    // the run ends with exactly one campaign.completed followed by phase.completed and factory.completed
    assert.equal(events(o, 'campaign.completed').length, 1);
    assert.deepEqual(types.slice(-2), ['phase.completed', 'factory.completed']);
    assert.ok(o.events.length < 400, `event count ${o.events.length}`);
    assert.ok(o.events.every((e, i) => e.sequence === i + 1));
  });

  it('3. nothing binary travels in events, the package or the database JSON; assets are only referenced by id', async () => {
    const o = await run();
    const blob = JSON.stringify([o.events, pkg(o), meta(o)]);
    assert.ok(!blob.includes('iVBORw0KGgo'), 'a base64 PNG leaked into an event or the package');
    assert.ok(!blob.includes('b64_json'));
    for (const a of pkg(o).imageAssets) {
      assert.match(a.id, /^ast_/);
      assert.ok(o.store.files.has(a.id));
      assert.equal(a.bytes, (await o.store.load(a.id)).length);
    }
    // the prompt text itself is not kept (only its size and a short direction summary)
    assert.ok(pkg(o).imageAssets.filter((a) => a.kind === 'image').every((a) => a.promptMetadata && a.promptMetadata.promptChars > 100 && !JSON.stringify(a.promptMetadata).includes('Strict rules')));
  });

  it("4. the image request uses the user's own key, the selected model/quality/size, one image per call, and states no text in the picture", async () => {
    const o = await run({ config: { imageQuality: 'medium' } });
    const calls = o.fake.imageCalls();
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.authorization, `Bearer ${KEY}`);
      assert.equal(c.body?.model, IMAGE_MODEL);
      assert.equal(c.body?.quality, 'medium');
      assert.equal(c.body?.n, 1);
      assert.ok(['1024x1024', '1024x1536', '1536x1024'].includes(c.body?.size));
      assert.match(String(c.body?.prompt), /no text, no letters/i);
      assert.doesNotMatch(String(c.body?.prompt), /sk-test/);
    }
    // the text model is never asked to paint
    assert.ok(textCalls(o).every((r) => r.body?.model === 'gpt-test-mini'));
    assert.equal(pkg(o).usage.images.requested, 3);
    assert.equal(pkg(o).usage.images.generated, 3);
    assert.deepEqual(pkg(o).usage.images.providerReportedTokens, { input: 120, output: 3168, total: 3288 });
  });

  it('5. prerequisites: a missing F3, a broken chain, a missing text model, sink or asset store refuse to start (nothing is fabricated)', async () => {
    const rt = new MozaikCampaignRuntime();
    const base = { runId: 'x', projectId: 'p', userId: 'u', mode: 'creative_production' as const, manifest: { productName: 'x' }, credentials: { provider: 'openai' as const, apiKey: KEY } };
    const cfg = { campaignId: 'c', projectId: 'p', f1: chain.f1, f2: chain.f2, f3: chain.f3, input: input(), model: 'gpt-test-mini', assets: new InMemoryAssetStore() };
    const sink = async () => undefined;
    await assert.rejects(rt.startRun({ ...base, creative: { ...cfg, f3: undefined as never }, onCampaign: sink }), RuntimeInitError);
    await assert.rejects(rt.startRun({ ...base, creative: { ...cfg, f2: makeF2('some-other-f1') }, onCampaign: sink }), /same chain/);
    await assert.rejects(rt.startRun({ ...base, creative: { ...cfg, f1: makeF1({ id: 'f1-other' }) }, onCampaign: sink }), /same chain/);
    await assert.rejects(rt.startRun({ ...base, creative: { ...cfg, model: ' ' }, onCampaign: sink }), /text model/);
    await assert.rejects(rt.startRun({ ...base, creative: { ...cfg, assets: undefined as never }, onCampaign: sink }), /asset store/);
    await assert.rejects(rt.startRun({ ...base, creative: cfg }), /sink/);
    await assert.rejects(rt.startRun({ ...base, credentials: undefined, creative: cfg, onCampaign: sink }), /credentials/);
  });

  it('6. Copywriter: structured concepts and channel copy; unknown channels and near-identical variants are dropped; claims are typed', async () => {
    const o = await run({
      openai: {
        reply: (req) => {
          if (req.agent !== 'copywriter' || req.lastUserText.includes('Revise ONLY')) return undefined;
          const copy = defaultCopy(req.lastUserText);
          const v0 = copy.variants[0];
          copy.variants.push({ ...v0, headline: v0.headline });
          copy.variants.push({ ...v0, channel: 'tiktok', headline: 'A channel the user did not select' });
          return { text: JSON.stringify(copy) };
        },
      },
    });
    const p = pkg(o);
    assert.equal(p.concepts.length, 3);
    assert.ok(p.copyVariants.every((v) => ['instagram', 'facebook'].includes(v.channel)));
    assert.equal(new Set(p.copyVariants.map((v) => v.headline.toLowerCase())).size, p.copyVariants.length, 'no duplicate headlines');
    assert.ok(p.copyVariants.every((v) => v.headline.length <= 70 && v.claims.every((c) => ['brief', 'f1', 'f2', 'f3', 'user', 'hypothesis'].includes(c.support))));
    assert.ok(p.limitations.some((l) => /near-identical/i.test(l)));
  });

  it('7. image model unavailable: no image, honest brand-colored backgrounds, the layouts and the package are still produced', async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'image' ? { status: 404, json: { error: { code: 'model_not_found', message: 'sk-secret-should-not-appear' } } } : undefined) } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.ok(p.imageAssets.filter((a) => a.kind === 'image').every((a) => a.source === 'brand_gradient'));
    assert.ok(p.channelLayouts.length >= 6);
    assert.equal(p.usage.images.generated, 0);
    assert.ok(p.limitations.some((l) => /could not be generated|brand-colored/i.test(l)));
    assert.ok(p.reviewFindings.some((f) => f.kind === 'visual_irrelevant' && f.severity === 'info'));
    assert.ok(names(o, 'visual.generated').every((v) => v.failed === true && v.error?.code === 'model_unavailable'));
    assert.doesNotMatch(JSON.stringify(o.events), /sk-secret-should-not-appear/);
    assert.equal(o.fake.imageCalls().length, 3, 'one attempt per concept, no retry storm for a missing model');
  });

  it('8. quota exceeded during image generation: no retries, graceful fallback, the key and provider text never leak', async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'image' ? { status: 429, json: { error: { code: 'insufficient_quota', message: `You exceeded your quota ${KEY}` } } } : undefined) } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.ok(names(o, 'visual.generated').every((v) => v.error?.code === 'insufficient_quota'));
    assert.equal(o.fake.imageCalls().length, 3);
    assert.doesNotMatch(JSON.stringify([o.events, pkg(o)]), new RegExp(KEY));
    assert.ok(pkg(o).channelLayouts.length > 0);
  });

  it('9. no image model selected: no image request at all; the Visual Creator is skipped; layouts use the brand palette', async () => {
    const o = await run({ config: { imageModel: null } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.fake.imageCalls().length, 0);
    assert.equal(textCalls(o).filter((r) => r.agent === 'vcreator').length, 0);
    assert.equal(state(o, 'Visual Creator'), 'skipped');
    assert.ok(pkg(o).imageAssets.filter((a) => a.kind === 'image').every((a) => a.source === 'brand_gradient'));
    assert.ok(pkg(o).channelLayouts.length >= 6);
    assert.ok(pkg(o).limitations.some((l) => /No image model/i.test(l)));
  });

  it('10. image budget: at most maxImages requests are made; the remaining concepts say so instead of silently paying more', async () => {
    const o = await run({ config: { maxImages: 2 } });
    assert.equal(o.fake.imageCalls().length, 2);
    assert.equal(pkg(o).imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image').length, 2);
    assert.equal(pkg(o).usage.images.limits.maxImages, 2);
    assert.equal(pkg(o).concepts.length, 3);
    assert.ok(pkg(o).channelLayouts.some((l) => l.conceptId === pkg(o).concepts[2].id), 'the third concept still gets layouts from a brand-colored base');
  });

  it('11. layouts adapt to every format without extra image calls; a format that cannot be cut cleanly is skipped with a reason', async () => {
    const o = await run({ input: { channels: ['instagram', 'youtube'], concepts: 2 }, config: { imageSize: '1024x1024', maxLayoutsPerConcept: 4 } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.equal(o.fake.imageCalls().length, 2, '2 images, however many layouts');
    assert.ok(p.channelLayouts.length + p.skippedLayouts.length >= 4);
    // 16:9 from a 1024 square would need ~1.9x upscaling: skipped, with the reason, never stretched
    const skip = p.skippedLayouts.find((s) => s.format === 'promo_16x9');
    assert.ok(skip, 'promo_16x9 should be skipped from a square base');
    assert.match(skip!.reason, /blurry|enlarge/i);
    for (const a of p.imageAssets.filter((x) => x.kind === 'layout')) {
      const f = CREATIVE_FORMATS[a.format!];
      assert.deepEqual([a.width, a.height], [f.width, f.height]);
    }
    // the same layouts are derived from the same two images: base assets are the parents
    const baseIds = new Set(p.imageAssets.filter((a) => a.kind === 'image').map((a) => a.id));
    assert.ok(p.channelLayouts.every((l) => baseIds.has(l.baseAssetId)));
  });

  it('12. a supplied logo is placed on every layout and recorded; the reviewer does not complain about it', async () => {
    const logo = await makePng(300, 120, '#ff6600');
    const o = await run({ config: { logo, hasBrandPalette: true, palette: ['#0a5c8c', '#0f172a'] } });
    const layouts = pkg(o).imageAssets.filter((a) => a.kind === 'layout');
    assert.ok(layouts.length > 0 && layouts.every((a) => a.flags.includes('logo_applied')));
    assert.ok(!pkg(o).reviewFindings.some((f) => f.kind === 'logo'));
  });

  it('13. landing content: structured, no invented trust signals; the same call to action as the ads', async () => {
    const o = await run();
    const l = pkg(o).landingContent!;
    assert.ok(l.hero.headline && l.ctaObjective);
    assert.deepEqual(l.trustSignals, []);
    assert.ok(pkg(o).copyVariants.every((v) => v.ctaType === l.ctaObjective));
    assert.ok(!pkg(o).reviewFindings.some((f) => f.kind === 'cta_mismatch'));
  });

  it('14. an unsupported promise ("guaranteed results") is caught by the deterministic review; the Fixer is CREATED at run time and repairs it', async () => {
    const o = await run({ openai: { reply: badCopyReply } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    // the Fixer did not exist at the start; it is registered after the first review
    const types = o.events.map((e) => e.type);
    const regAt = types.indexOf('participant.registered');
    assert.ok(regAt > types.indexOf('review.completed'), 'registered after the first review');
    assert.equal(names(o, 'participant.registered')[0].agent, 'Fixer');
    assert.equal(o.events.find((e) => e.type === 'participant.registered')!.participant, 'Creative Coordinator');
    // the Fixer received the real finding ids and asked the Copywriter (the owner) to revise exactly the named variant
    const finding = p.reviewFindings.find((f) => f.kind === 'unsupported_claim' && f.severity === 'blocker');
    assert.ok(finding, JSON.stringify(p.reviewFindings.map((f) => f.finding)));
    const fix = names(o, 'fix.requested')[0];
    assert.ok(fix.findingIds.includes(finding!.id));
    const rev = events(o, 'revision.requested').find((e) => (e.payload as any).agent === 'Copywriter')!;
    assert.equal(rev.participant, 'Fixer');
    assert.ok((rev.payload as any).operations[0].findingIds.includes(finding!.id));
    assert.deepEqual((rev.payload as any).operations[0].variantIds, [finding!.assetRef]);
    // the Copywriter's revision prompt carried the actual finding text
    const revisionPrompt = textCalls(o).find((r) => r.agent === 'copywriter' && r.lastUserText.includes('Revise ONLY'));
    assert.ok(revisionPrompt);
    assert.ok(revisionPrompt!.lastUserText.includes(finding!.finding.slice(0, 60)));
    // the original text is preserved in history, the new text no longer contains the promise
    const v = p.copyVariants.find((x) => x.id === finding!.assetRef)!;
    assert.equal(v.version, 2);
    assert.match(v.history[0].body, /Guaranteed results/);
    assert.doesNotMatch(v.body, /guarantee/i);
    // the layouts of that variant were re-rendered with the new text (a new version; the old one is kept and superseded)
    const lay = p.channelLayouts.filter((l) => l.variantId === v.id);
    assert.ok(lay.length > 0);
    for (const l of lay) {
      const a = p.imageAssets.find((x) => x.id === l.assetId)!;
      assert.equal(a.version, 2);
      assert.equal(a.status, 'rendered');
      assert.ok(p.imageAssets.some((x) => x.kind === 'layout' && x.status === 'superseded' && x.format === a.format && x.conceptId === a.conceptId && x.version === 1));
    }
    // verified by a second review that looked ONLY at what changed, and nothing else was regenerated
    assert.equal(events(o, 'review.requested').length, 2);
    assert.deepEqual((events(o, 'review.requested')[1].payload as any).scope.variantIds, [v.id]);
    assert.equal(p.reviewFindings.find((f) => f.id === finding!.id)!.status, 'fixed');
    assert.equal(p.approval.status, 'approved');
    // two deterministic findings pointed at the same variant: ONE revision request, one record per finding
    assert.equal(events(o, 'revision.requested').filter((e) => (e.payload as any).agent === 'Copywriter').length, 1);
    assert.equal(p.revisions.length, fix.findingIds.length);
    assert.ok(p.revisions.every((r) => r.operation === 'revise_copy' && r.status === 'applied'));
    assert.equal(o.fake.imageCalls().length, 3, 'a text repair never regenerates an image');
    assert.equal(state(o, 'Fixer'), 'done');
  });

  it('15. bounded repair loop: copy that keeps the promise is retried at most maxRepairRounds times, then reported honestly as unresolved', async () => {
    const stubborn = (req: FakeRequest): FakeReply | undefined => {
      if (req.agent !== 'copywriter') return undefined;
      if (req.lastUserText.includes('Revise ONLY')) {
        const variants = JSON.parse(/<variants>\n([\s\S]*?)\n<\/variants>/.exec(req.lastUserText)![1]);
        return { text: JSON.stringify({ revisions: variants.map((v: any) => ({ variantId: v.id, headline: v.headline, body: v.body, ctaText: v.ctaText, hashtags: [], claims: [] })) }) };
      }
      return badCopyReply(req);
    };
    const o = await run({ openai: { reply: stubborn }, config: { maxRepairRounds: 2 } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.equal(events(o, 'fix.requested').length, 2);
    assert.equal(events(o, 'review.requested').length, 3);
    assert.equal(textCalls(o).filter((r) => r.agent === 'copywriter' && r.lastUserText.includes('Revise ONLY')).length, 2);
    const blocker = p.reviewFindings.find((f) => f.severity === 'blocker')!;
    assert.equal(blocker.status, 'unresolved');
    assert.equal(p.approval.status, 'unresolved');
    assert.ok(p.approval.unresolvedFindingIds.includes(blocker.id));
    assert.match(p.approval.note, /could not be repaired/);
    // one revision record per finding and round, every one honestly 'applied' (the text came back, it just was not better)
    assert.deepEqual([...new Set(p.revisions.map((r) => r.round))], [1, 2]);
    assert.ok(p.revisions.every((r) => r.operation === 'revise_copy' && r.status === 'applied'));
    assert.ok(textCalls(o).length <= 20);
    assert.equal(o.fake.imageCalls().length, 3);
    assert.equal(unhandled, 0);
  });

  it('16. regeneration is off by default: a visual defect found by the vision review is NOT silently re-bought; it stays visible as unresolved', async () => {
    let n = 0;
    const o = await run({
      config: { visionReviews: 1 },
      openai: {
        reply: (req) => {
          if (req.agent !== 'creviewer' || req.images === 0) return undefined;
          n++;
          return { text: JSON.stringify({ summary: 'One picture looks wrong.', issues: [{ kind: 'visual_defect', severity: 'major', assetRef: shownAssets(req)[0], finding: 'The picture has a visible artifact.', evidence: 'Looked at the exported asset.', suggestedCorrection: 'Generate a cleaner picture.', responsibleAgent: 'visual' }] }) };
        },
      },
    });
    assert.equal(n, 1);
    assert.equal(o.fake.imageCalls().length, 3, 'no regeneration request');
    const f = pkg(o).reviewFindings.find((x) => x.kind === 'visual_defect')!;
    assert.equal(f.source, 'llm_vision');
    assert.equal(f.status, 'unresolved');
    const r = pkg(o).revisions.find((x) => x.findingId === f.id)!;
    assert.equal(r.operation, 'none');
    assert.match(r.note, /regeneration is switched off/i);
  });

  it('17. with regeneration enabled the Visual Creator regenerates ONCE (budgeted), the original is kept, and the layouts use the new version', async () => {
    let first = true;
    const o = await run({
      config: { visionReviews: 1, maxRegenerations: 1 },
      openai: {
        reply: (req) => {
          if (req.agent !== 'creviewer' || req.images === 0 || !first) return undefined;
          first = false;
          return { text: JSON.stringify({ summary: 'x', issues: [{ kind: 'visual_defect', severity: 'major', assetRef: shownAssets(req)[0], finding: 'The picture has a visible artifact.', evidence: 'e', suggestedCorrection: 'Generate a cleaner picture.', responsibleAgent: 'visual' }] }) };
        },
      },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.fake.imageCalls().length, 4, '3 originals + exactly 1 regeneration');
    const p = pkg(o);
    assert.equal(p.usage.images.regenerations, 1);
    const bases = p.imageAssets.filter((a) => a.kind === 'image');
    assert.equal(bases.filter((a) => a.status === 'superseded').length, 1);
    const fresh = bases.find((a) => a.version === 2)!;
    assert.ok(fresh.parentAssetId);
    assert.ok(o.store.files.has(fresh.parentAssetId!), 'the original image file is preserved');
    assert.ok(p.channelLayouts.filter((l) => l.conceptId === fresh.conceptId).every((l) => l.baseAssetId === fresh.id));
    assert.equal(p.reviewFindings.find((f) => f.kind === 'visual_defect')!.status, 'fixed');
  });

  it('18. a layout problem found by the reviewer is repaired by the Layout Designer (deterministically, no model call) and verified again', async () => {
    let first = true;
    const o = await run({
      config: { visionReviews: 1 },
      openai: {
        reply: (req) => {
          if (req.agent !== 'creviewer' || req.images === 0 || !first) return undefined;
          first = false;
          return { text: JSON.stringify({ summary: 'x', issues: [{ kind: 'low_contrast', severity: 'major', assetRef: shownAssets(req)[0], finding: 'The headline is hard to read on this picture.', evidence: 'Looked at the exported asset.', suggestedCorrection: 'Add a stronger scrim behind the text.', responsibleAgent: 'layout' }] }) };
        },
      },
    });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const f = p.reviewFindings.find((x) => x.kind === 'low_contrast')!;
    assert.equal(p.revisions.find((r) => r.findingId === f.id)!.operation, 'rerender_layout');
    assert.equal(f.status, 'fixed');
    assert.equal(p.imageAssets.filter((a) => a.kind === 'layout' && a.version === 2).length, 1);
    assert.equal(p.imageAssets.filter((a) => a.kind === 'layout' && a.status === 'superseded').length, 1);
    assert.equal(textCalls(o).filter((r) => r.agent === 'copywriter' && r.lastUserText.includes('Revise ONLY')).length, 0, 'no model call was needed to re-render a layout');
    assert.equal(o.fake.imageCalls().length, 3);
  });

  it('19. a partial failure is a partial result: when the landing page fails the campaign still completes, with the gap named', async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'landing' ? { status: 400, json: { error: { code: 'invalid_request', message: 'nope' } } } : undefined) } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.equal(p.landingContent, null);
    assert.equal(state(o, 'Landing Content Builder'), 'failed');
    assert.equal(meta(o).partial, true);
    assert.equal(p.approval.status, 'approved_with_notes');
    assert.ok(p.limitations.some((l) => /landing/i.test(l)));
    assert.ok(p.channelLayouts.length > 0);
  });

  it('20. without copy there is no campaign: a failed Copywriter fails the run cleanly (no package, key never leaks)', async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'copywriter' ? { status: 401, json: { error: { code: 'invalid_api_key', message: `bad ${KEY}` } } } : undefined) } });
    assert.equal(o.result.status, 'failed');
    assert.equal(o.packages.length, 0);
    assert.doesNotMatch(JSON.stringify([o.events, o.result]), new RegExp(KEY));
  });

  it('21. cancellation during image generation aborts the in-flight request, stops further ones and ends the run as cancelled', async () => {
    const o = await run({
      openai: { reply: (req) => (req.agent === 'image' ? { hang: true } : undefined) },
      cancelOnRequest: (req) => req.agent === 'image',
      config: { visualTimeoutMs: 30_000, productionTimeoutMs: 40_000, imageTimeoutMs: 30_000 },
    });
    assert.equal(o.result.status, 'cancelled');
    assert.equal(o.packages.length, 0);
    await new Promise((r) => setTimeout(r, 200));
    const calls = o.fake.imageCalls();
    assert.ok(calls.length >= 1 && calls.length <= 2, `at most two image requests were in flight, saw ${calls.length}`);
    assert.ok(calls.every((c) => c.aborted));
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(o.fake.imageCalls().length, n, 'nothing is requested after the cancel');
  });

  it("22. a hung image request times out on the Visual Creator's own deadline; the run still completes with brand-colored backgrounds", async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'image' ? { hang: true } : undefined) }, config: { imageTimeoutMs: 300, visualTimeoutMs: 5000 } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.ok(pkg(o).imageAssets.filter((a) => a.kind === 'image').every((a) => a.source === 'brand_gradient'));
    assert.ok(names(o, 'visual.generated').every((v) => v.error?.code === 'timeout'));
  });

  it('23. the text-model budget is enforced by the backend and never exceeded; the campaign still completes', async () => {
    const o = await run({ config: { maxModelCalls: 5 } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.ok(textCalls(o).length <= 5, `saw ${textCalls(o).length}`);
    assert.equal(pkg(o).usage.text.calls <= 5, true);
  });

  it('24. per-agent accounting: model-free participants say so, others report their own calls; totals add up', async () => {
    const o = await run();
    const u = pkg(o).usage.text;
    assert.ok(u.perAgent['Copywriter'].calls >= 1);
    assert.ok(u.perAgent['Landing Content Builder'].calls >= 1);
    assert.ok(u.perAgent['Visual Creator'].calls >= 1);
    assert.ok(u.perAgent['Content & Brand Reviewer'].calls >= 1);
    assert.equal(u.perAgent['Layout Designer']?.calls ?? 0, 0);
    assert.equal(u.perAgent['Fixer']?.calls ?? 0, 0);
    assert.equal(Object.values(u.perAgent).reduce((n, a) => n + a.calls, 0), u.calls);
    assert.equal(u.calls, textCalls(o).length);
  });

  it('25. concurrent campaigns stay isolated: separate keys, separate asset stores, separate packages', async () => {
    const a = await new FakeOpenAI().start();
    const b = await new FakeOpenAI().start();
    servers.push(a, b);
    const runtime = sharedRuntime();
    const [x, y] = await Promise.all([
      run({ fake: a, key: 'sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', runId: 'conc-a', runtime }),
      run({ fake: b, key: 'sk-test-BBBBBBBBBBBBBBBBBBBBBBBBBBBB', runId: 'conc-b', runtime }),
    ]);
    assert.equal(x.result.status, 'completed');
    assert.equal(y.result.status, 'completed');
    assert.ok(a.requests.every((r) => r.authorization.includes('AAAA')));
    assert.ok(b.requests.every((r) => r.authorization.includes('BBBB')));
    assert.notEqual(x.store, y.store);
    assert.ok(x.events.every((e) => e.runId === 'conc-a') && y.events.every((e) => e.runId === 'conc-b'));
    assert.doesNotMatch(JSON.stringify([x.events, pkg(x)]), /BBBB/);
  });

  it('26. nothing starts by itself: creating the runtime makes no request; the key never reaches a prompt', async () => {
    const fake = await new FakeOpenAI().start();
    servers.push(fake);
    new MozaikCampaignRuntime();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.requests.length, 0);
    const o = await run({ fake });
    assert.ok(textCalls(o).every((r) => !r.userText.includes(KEY) && !JSON.stringify(r.body).includes(KEY)));
  });

  it('27. one concept, one channel, no landing: the smallest campaign (1 image, a few layouts) still works end to end', async () => {
    const o = await run({ input: { concepts: 1, channels: ['instagram'], landing: false } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    assert.equal(p.concepts.length, 1);
    assert.equal(p.landingContent, null);
    assert.equal(o.fake.imageCalls().length, 1);
    assert.equal(textCalls(o).filter((r) => r.agent === 'landing').length, 0);
    assert.equal(state(o, 'Landing Content Builder'), 'skipped');
  });
});
