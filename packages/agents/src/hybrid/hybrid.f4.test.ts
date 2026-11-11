import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { buildCampaignZip, buildCreativesZip } from '../creative/export';
import { InMemoryAssetStore } from '../creative/assets';
import type { CreativeInput } from '../creative/context';
import { prepareContinuationSeed } from '../creative/continuation';
import { CREATIVE_FORMATS } from '../creative/formats';
import type { CampaignPackage } from '../creative/schemas';
import type { RecordedEvent } from '../factory/state';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '../testing/fake-openai';
import { defaultCopy } from '../testing/fake-creative';
import { SpendBudget } from '../ai/budget';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { mergeHybrid, type HybridSettings } from './settings';

// Hybrid Production end to end on the REAL Mozaik runtime: real participants (Visual Researcher, Template Selector, Layout Designer,
// Template Quality Reviewer...) over a fake OpenAI (text and images over real HTTP). Nothing is billed, no real image model is used,
// and no Pinterest request exists anywhere in this path.

const KEY = 'sk-test-HYBRID1234567890abcdefghijkl';
const IMAGE_MODEL = 'gpt-image-1.5';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}

describe('Hybrid Production (real Mozaik agents; fake text and image APIs)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const input = (o: Partial<CreativeInput> = {}): CreativeInput => ({ projectName: 'Deep Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 5, landing: true, ...o });

  async function run(o: { hybrid?: Partial<HybridSettings>; config?: Partial<CreativeRunConfig>; input?: Partial<CreativeInput>; openai?: FakeOpenAIOptions; seedStore?: InMemoryAssetStore; runId?: string; brandImages?: { id: string; name: string; data: Buffer }[] } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = o.seedStore ?? new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const settings = mergeHybrid({ directionRefine: false, ...o.hybrid });
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: o.runId ?? 'hybrid-1',
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
        imageQuality: 'medium',
        variations: true,
        maxImages: settings.originals,
        imageConcurrency: 3,
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
        hybrid: { settings, brandImages: o.brandImages ?? [], referencePalettes: {} },
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
  const types = (o: Outcome, t: string) => o.events.filter((e) => e.type === t);
  const hybridOf = (o: Outcome) => pkg(o).hybrid!;
  const failImages = (attempts: number[]): FakeOpenAIOptions => ({
    reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && attempts.includes(req.attempt) ? { status: 400, json: { error: { message: 'The request was rejected by the safety system.', type: 'invalid_request_error', code: 'moderation_blocked' } } } : undefined),
  });

  it('default: 5 original AI images + 15 template creatives = 20 finished creatives, and only 5 image requests are made', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const h = hybridOf(o);
    assert.equal(h.mode, 'hybrid');
    assert.equal(o.fake.imageCalls().length, 5, 'one provider request per ORIGINAL image; template creatives never call the image model');
    assert.deepEqual(h.counts.originals, { planned: 5, requested: 5, generated: 5, failed: 0, skipped: 0, blockedByBudget: 0 });
    assert.equal(h.counts.templates.planned, 15);
    assert.equal(h.counts.templates.rendered, 15, h.creatives.filter((c) => c.status !== 'rendered').map((c) => `${c.slotId}: ${c.reason}`).join(' | '));
    assert.equal(h.counts.total.planned, 20);
    assert.equal(h.counts.total.delivered, 20);
    assert.equal(p.usage.images.requested, 5);
    assert.equal(p.imageCounts?.generated, 5);
    // 3 template creatives per concept, each built from the original of its own concept
    for (const c of p.concepts) {
      assert.equal(h.creatives.filter((x) => x.conceptId === c.id).length, 3);
      assert.equal(p.imageVariations.filter((v) => v.conceptId === c.id && v.status === 'generated').length, 1);
    }
  });

  it('SPARSE PROJECT: no website, no logo, no brand colors, no social profiles, no style, no channels chosen: still 5 + 15 = 20, honest limitations, nothing invented', async () => {
    // exactly what a project with only a name and a short description has: websiteUrl null, no logo bytes, no brand palette, no references
    const o = await run({ input: { websiteUrl: null }, config: { logo: null, palette: [], hasBrandPalette: false } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const h = hybridOf(o);
    assert.deepEqual(h.counts.originals, { planned: 5, requested: 5, generated: 5, failed: 0, skipped: 0, blockedByBudget: 0 });
    assert.equal(h.counts.templates.rendered, 15);
    assert.equal(h.counts.total.delivered, 20);
    // the missing pieces are DISCLOSED, each with what was done instead
    const lim = p.limitations.join('\n');
    assert.match(lim, /No website was supplied, so no destination link appears in any creative/);
    assert.match(lim, /No logo was supplied: the business name is used as a text-based brand identity/);
    assert.match(lim, /No brand colors were available: the palette comes from the built-in style library/);
    // the brand NAME stands in for the logo on every template creative that has a logo box, and the renderer says so
    const tpl = p.imageAssets.filter((a) => a.kind === 'layout' && a.status !== 'superseded');
    assert.equal(tpl.length, 15);
    assert.ok(tpl.every((a) => a.flags.includes('logo_missing_name_used')), 'every template creative reports the text-based identity');
    // nothing a project cannot know appears in any creative text: no web or e-mail address, no calendar date, no discount, no testimonial, no price
    const all = JSON.stringify([p.copyVariants, p.landingContent]);
    assert.doesNotMatch(all, /https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(com|net|org|io|rs|app|ai)\b/i, 'no invented address');
    assert.doesNotMatch(all, /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/, 'no invented date');
    assert.doesNotMatch(all, /\d+\s?%|[$€£]\s?\d|testimonial|money[- ]back|guarantee/i, 'no invented discount, price, testimonial or guarantee');
    // fact-gated templates were not used: there is no offer, date, quote or statistic to put in them
    const gatedIds = new Set(TEMPLATE_LIBRARY.filter((t) => t.requires.some((r) => ['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag'].includes(r))).map((t) => t.id));
    assert.ok(h.creatives.every((c) => !c.templateId || !gatedIds.has(c.templateId)), 'no template that needs an invented fact was chosen');
  });

  // ---- ONE campaign budget for the whole run (text, images, reviews and repairs draw on the same ledger) ---------------------------------------

  it('ONE shared budget: text and images are paid from the same ledger, nothing exceeds it and the figures reconcile', async () => {
    const ledger = new SpendBudget(0.4, { maxImageRequests: 5 });
    ledger.setPlan({ phases: [{ label: 'F4', order: 4, projectedUsd: 0.02 }], images: { remaining: 5, unitUsd: 0.05, basis: 'published' } });
    const o = await run({ config: { model: 'gpt-4.1-mini', ledger } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const s = ledger.snapshot();
    assert.equal(s.requests.image, 5);
    assert.ok(s.requests.text > 5, `text requests: ${s.requests.text}`);
    assert.ok(s.committedUsd <= 0.4, `committed ${s.committedUsd}`);
    assert.equal(s.reservedUsd, 0, 'nothing is left held when the run is over');
    assert.equal(s.remainingBasis, 'exact', 'every request reported its usage');
    // the images cost what the provider reported (40 input + 1056 output tokens at gpt-image-1.5 rates), not what was reserved
    assert.ok(Math.abs(s.breakdown.imagesUsd - 5 * 0.033992) < 1e-5, `images ${s.breakdown.imagesUsd}`);
    assert.ok(Math.abs(s.breakdown.agentsUsd + s.breakdown.imagesUsd + s.breakdown.reviewsUsd - s.knownUsd) < 1e-5, 'the breakdown (information only) adds up to the known spend');
    assert.ok(Math.abs((s.remainingUsd ?? 0) - (0.4 - s.committedUsd)) < 1e-6);
    // the package says the same as the ledger
    const cost = pkg(o).cost!;
    assert.ok(Math.abs(cost.spentUsd - s.spentUsd) < 1e-5);
    assert.equal(cost.approvedUsd, 0.4);
  });

  it('a tight budget defers the OPTIONAL checks so the REQUIRED images are still paid for, and the deferral is recorded', async () => {
    const ledger = new SpendBudget(0.2, { maxImageRequests: 5 });
    ledger.setPlan({ phases: [{ label: 'F4', order: 4, projectedUsd: 0.02 }], images: { remaining: 5, unitUsd: 0.05, basis: 'published' } }); // the 5 required originals are projected at 0.25 (they really cost 0.17)
    const o = await run({ config: { model: 'gpt-4.1-mini', ledger } });
    const h = hybridOf(o);
    assert.equal(h.counts.originals.generated, 5, 'every required original is funded');
    assert.equal(o.fake.imageCalls().length, 5);
    assert.ok(ledger.snapshot().deferred > 0, 'optional checks were held back');
    assert.ok(ledger.snapshot().byPriority[4].usd < 0.01, 'quality checks only got what was left once the required images were funded');
    const refusal = ledger.snapshot().refusals.find((r) => r.reason === 'protected_for_required_work')!;
    assert.ok(refusal && refusal.priority >= 4, 'it names what was deferred');
    assert.ok(ledger.snapshot().committedUsd <= 0.2 + 1e-9);
    assert.ok(pkg(o).quality, 'the quality record exists: what was checked and what was skipped is not hidden');
  });

  it('when the money runs out during the images, the originals that did not fit are reported as stopped by the budget (never as done) and nothing unpaid is sent', async () => {
    const ledger = new SpendBudget(0.15, { maxImageRequests: 5 }); // no projection: text first, then images until the budget is used up
    const o = await run({ config: { model: 'gpt-4.1-mini', ledger } });
    const p = pkg(o);
    const h = hybridOf(o);
    const generated = h.counts.originals.generated;
    assert.equal(generated, 3, `generated ${generated}`); // 0.15: 3 x $0.034 + the text, and a 4th would need $0.05 more than what is left
    assert.equal(h.counts.originals.blockedByBudget, 5 - generated);
    assert.equal(o.fake.imageCalls().length, generated, 'a request that does not fit is never sent');
    assert.notEqual(p.approval.status, 'approved');
    assert.ok(p.limitations.join(' ').match(/budget|spending limit/i), 'the limitation names the budget');
    assert.ok(ledger.snapshot().committedUsd <= 0.15 + 1e-9);
    assert.ok(h.counts.total.delivered < h.counts.total.planned, 'the missing creatives are not counted as delivered');
    // the creatives of the originals that were not generated are skipped honestly, not rendered from a stand-in
    assert.equal(h.counts.templates.rendered, generated * 3);
  });

  it('a model-written web address or deadline in the copy (the project has no website) is caught by the deterministic review and repaired before export', async () => {
    const invent = (req: FakeRequest): FakeReply | undefined => {
      if (req.agent !== 'copywriter' || req.userText.includes('Revise ONLY the listed variants')) return undefined;
      const c = defaultCopy(req.userText);
      c.variants[0].body = 'Create agents for everyday tasks at jigjoy.com';
      c.variants[1].body = 'Early access until 31 May for everyone';
      return { text: JSON.stringify(c) };
    };
    const o = await run({ input: { websiteUrl: null }, openai: { reply: invent } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const found = p.reviewFindings.filter((f) => f.source === 'deterministic' && f.kind === 'unsupported_claim' && /web or e-mail address|date that appears nowhere/.test(f.finding));
    assert.ok(found.some((f) => f.severity === 'blocker' && /jigjoy\.com/.test(f.finding)), 'the invented address was found');
    assert.ok(found.some((f) => f.severity === 'major' && /31 May/.test(f.finding)), 'the invented date was found');
    assert.ok(found.every((f) => f.status === 'fixed'), `all were repaired: ${found.map((f) => f.status).join(',')}`);
    // the DELIVERED text (the current version of every variant, and the landing page); the old version stays in the history on purpose
    const delivered = JSON.stringify([p.copyVariants.map((v) => [v.headline, v.body, v.description, v.ctaText, v.hashtags]), p.landingContent]);
    assert.doesNotMatch(delivered, /jigjoy\.com|31 May/i, 'neither the address nor the deadline is in the delivered campaign');
    assert.ok(p.copyVariants.slice(0, 2).every((v) => v.version === 2 && v.history.length === 1), 'the two variants were revised once, the first version is kept in the history');
  });

  it('template creatives are real renders with lineage: never AI images, exact size, the original as source, never overwriting it', async () => {
    const o = await run();
    const p = pkg(o);
    const originals = p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image');
    assert.equal(originals.length, 5);
    assert.ok(originals.every((a) => (a.origin ?? 'AI_GENERATED') === 'AI_GENERATED'));
    const tpl = p.imageAssets.filter((a) => a.kind === 'layout');
    assert.equal(tpl.length, 15, 'no legacy per-original layouts are made in Hybrid Production');
    const ids = new Set(TEMPLATE_LIBRARY.map((t) => t.id));
    for (const a of tpl) {
      assert.equal(a.source, 'template_render', 'a template creative is not labelled as an AI image');
      assert.equal(a.origin, 'TEMPLATE_RENDERED');
      assert.ok(a.templateId && ids.has(a.templateId), `${a.templateId} is in the library`);
      assert.equal(a.templateVersion, TEMPLATE_LIBRARY.find((t) => t.id === a.templateId)!.version);
      assert.equal(a.rights?.basis, 'original_template');
      assert.ok(a.sourceAssetIds?.some((id) => originals.some((x) => x.id === id)), 'built from an original');
      assert.equal(a.model, null);
      const fmt = CREATIVE_FORMATS[a.format!];
      assert.equal(a.width, fmt.width);
      assert.equal(a.height, fmt.height);
      const meta = await sharp(await o.store.load(a.id)).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], ['png', fmt.width, fmt.height], 'a real PNG of the planned size');
    }
    // the originals are untouched and still stored
    for (const a of originals) assert.ok((await o.store.load(a.id)).length > 1000);
    assert.equal(new Set(tpl.map((a) => a.sha256)).size, tpl.length, 'no two creatives are the same file');
    // layouts of the package point at their slot and template
    for (const l of p.channelLayouts) assert.ok(l.slotId && l.templateId);
  });

  it('the real Mozaik participants ran and emitted their events (no claim of concurrency that is sequential)', async () => {
    const o = await run();
    const meta = o.packages[0].meta;
    const state = (agent: string) => meta.participants.find((x) => x.agent === agent)?.state;
    for (const a of ['Copywriter', 'Visual Creator', 'Layout Designer', 'Content & Brand Reviewer', 'Visual Researcher', 'Template Selector', 'Template Quality Reviewer']) assert.ok(meta.plan.activated.some((x) => x.agent === a), `${a} is part of the plan`);
    assert.equal(state('Visual Researcher'), 'done');
    assert.equal(state('Template Selector'), 'done');
    assert.equal(state('Layout Designer'), 'done');
    assert.equal(state('Template Quality Reviewer'), 'done');
    const dir = types(o, 'visual.direction.published');
    assert.equal(dir.length, 1);
    assert.equal(dir[0].participant, 'Visual Researcher');
    const sel = types(o, 'template.selection.completed');
    assert.equal(sel.length, 1);
    assert.equal(sel[0].participant, 'Template Selector');
    assert.ok(types(o, 'template.quality.requested').length >= 1 && types(o, 'template.quality.completed').length >= 1);
    assert.equal(types(o, 'template.quality.completed')[0].participant, 'Template Quality Reviewer');
    // ordering: the direction exists before the first picture is requested and before the selection
    const order = o.events.map((e) => e.type);
    assert.ok(order.indexOf('visual.direction.published') < order.indexOf('template.selection.completed'));
    assert.ok(order.indexOf('visual.direction.published') < order.indexOf('visual.generated'));
    assert.ok(order.indexOf('template.selection.completed') < order.lastIndexOf('layout.completed'));
    assert.ok(order.lastIndexOf('layout.completed') < order.indexOf('template.quality.requested'));
    // the template creatives report through layout.completed
    const layoutEvents = types(o, 'layout.completed').flatMap((e) => ((e.payload as { templateCreatives?: unknown[] }).templateCreatives ?? []) as { status: string }[]);
    assert.equal(layoutEvents.filter((t) => t.status === 'rendered').length, 15);
    assert.equal(types(o, 'participant.registered').length, 0, 'no Fixer was needed');
    // the model-free participants made no model call; with refinement off the Visual Researcher made none either
    assert.equal(o.fake.calls('vresearcher').length, 0);
    assert.equal(o.fake.calls('tselector').length, 0);
  });

  it('the image prompts carry the visual direction, ask for imagery without text and for crop-safe subjects', async () => {
    const o = await run();
    const prompts = o.fake.imageCalls().map((c) => String(c.body?.prompt));
    assert.equal(prompts.length, 5);
    for (const pr of prompts) {
      assert.match(pr, /VISUAL DIRECTION:/);
      assert.match(pr, /no text, letters, logos or watermarks/i);
      assert.match(pr, /re-cropped by layout templates/);
    }
    assert.equal(hybridOf(o).direction?.origin, 'deterministic');
  });

  it('the Visual Researcher may refine the direction with ONE model call; the user-chosen style cannot be overridden', async () => {
    const o = await run({ hybrid: { directionRefine: true, style: 'luxury_hospitality' } });
    assert.equal(o.fake.calls('vresearcher').length, 1);
    const d = hybridOf(o).direction!;
    assert.equal(d.origin, 'model_refined');
    assert.equal(d.styleId, 'luxury_hospitality', 'the style the user picked stays');
    assert.equal(hybridOf(o).selection!.styleId, 'luxury_hospitality');
  });

  it('assisted selection spends ONE text call and every pick comes from a validated shortlist', async () => {
    const o = await run({ hybrid: { selection: 'assisted' } });
    assert.equal(o.fake.calls('tselector').length, 1);
    const sel = hybridOf(o).selection!;
    assert.equal(sel.mode, 'assisted');
    const ids = new Set(TEMPLATE_LIBRARY.map((t) => t.id));
    assert.ok(sel.items.every((i) => ids.has(i.templateId)));
    assert.equal(hybridOf(o).counts.templates.rendered, 15);
    const quality = hybridOf(o).quality!;
    assert.ok(quality.checkedFiles >= 15);
  });

  it('a user override is applied, and an invalid one is reported (never silently swapped)', async () => {
    const any = TEMPLATE_LIBRARY.find((t) => t.status === 'active' && t.classes.includes('portrait') && t.requires.every((r) => ['image', 'logo', 'headline', 'support', 'cta', 'eyebrow', 'brand'].includes(r)))!;
    const o = await run({ hybrid: { selection: 'manual', overrides: { 'K1-T1': any.id, 'K2-T1': 'definitely_not_a_template' } } });
    const sel = hybridOf(o).selection!;
    const k1 = sel.items.find((i) => i.slotId === 'K1-T1')!;
    if (k1.formatClass && any.classes.includes(k1.formatClass)) {
      assert.equal(k1.templateId, any.id);
      assert.equal(k1.origin, 'user_override');
    }
    assert.ok(sel.warnings.some((w) => w.includes('definitely_not_a_template')), sel.warnings.join(' | '));
  });

  it('PARTIAL success: 2 of 5 images fail; the creatives of the other 3 are still rendered, the rest are left out WITH reasons and not counted', async () => {
    const o = await run({ openai: failImages([2, 4]) });
    if (process.env.HYBRID_DEBUG && o.result.status !== 'completed') console.log('RESULT', JSON.stringify(o.result).slice(0, 600), JSON.stringify(o.events.slice(-6).map((e) => [e.type, e.participant, JSON.stringify(e.payload).slice(0, 300)])));
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const p = pkg(o);
    const h = hybridOf(o);
    assert.equal(h.counts.originals.generated, 3);
    assert.equal(h.counts.originals.failed, 2);
    assert.equal(h.counts.originals.requested, 5);
    if (process.env.HYBRID_DEBUG) console.log(JSON.stringify(h.creatives.map((c) => `${c.slotId}:${c.variationId}:${c.status}:${(c.reason ?? '').slice(0, 60)}`), null, 1), JSON.stringify(p.imageVariations.map((v) => `${v.variationId}:${v.status}`)));
    const skipped = h.creatives.filter((c) => c.status === 'skipped');
    assert.equal(skipped.length, 6, 'the 3 creatives of each of the 2 failed originals');
    assert.ok(skipped.every((c) => c.assetId === null && /original image was not generated/.test(c.reason ?? '')));
    assert.equal(h.counts.templates.rendered, 9);
    assert.equal(h.counts.templates.skipped, 6);
    assert.equal(h.counts.total.planned, 20);
    assert.equal(h.counts.total.delivered, 12, '3 originals + 9 renders: failures are never counted');
    assert.notEqual(p.approval.status, 'approved', 'a campaign with missing deliverables is not "approved"');
    assert.ok(p.limitations.length > 0);
    // no stand-in picture exists for a failed original
    assert.equal(p.imageAssets.filter((a) => a.kind === 'image' && a.source === 'brand_gradient').length, 0);
    assert.equal(p.imageAssets.filter((a) => a.kind === 'layout' && a.status !== 'superseded').length, 9);
    // the quality reviewer says so too
    assert.equal(h.quality!.complete, false);
    assert.ok(h.quality!.issues.some((i) => i.kind === 'missing_render' && !i.repairable));
  });

  it('with picture-free fallback allowed, the creatives of a failed original are rendered and labelled FALLBACK (never AI or template-with-picture)', async () => {
    const o = await run({ openai: failImages([2, 4]), hybrid: { allowTemplateFallback: true } });
    const h = hybridOf(o);
    const fb = h.creatives.filter((c) => c.status === 'fallback_rendered');
    assert.ok(fb.length > 0, 'fallback creatives exist');
    assert.equal(h.counts.templates.fallbackRendered, fb.length);
    const assets = pkg(o).imageAssets;
    for (const c of fb) {
      const a = assets.find((x) => x.id === c.assetId)!;
      assert.equal(a.origin, 'FALLBACK');
      assert.equal(a.rights?.basis, 'none');
      assert.ok(!a.sourceAssetIds?.some((id) => assets.find((x) => x.id === id)?.source === 'ai_image'), 'no AI picture is claimed as its source');
    }
    assert.equal(h.counts.originals.generated, 3, 'the originals are still counted honestly');
    assert.equal(h.counts.total.delivered, 3 + h.counts.templates.rendered + fb.length);
  });

  it('brand images stand in as the picture for concepts without an original (lineage records them)', async () => {
    const brand = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3b7a57' } }).jpeg().toBuffer();
    const o = await run({ hybrid: { originals: 2, templateCreatives: 10 }, brandImages: [{ id: 'asset-brand-1', name: 'shop.jpg', data: brand }] });
    const h = hybridOf(o);
    assert.equal(h.counts.originals.planned, 2);
    assert.equal(o.fake.imageCalls().length, 2);
    const fromBrand = pkg(o).imageAssets.filter((a) => a.kind === 'layout' && a.sourceAssetIds?.includes('brand:asset-brand-1'));
    assert.ok(fromBrand.length > 0, 'concepts without an original used the brand image');
    assert.ok(fromBrand.every((a) => a.origin === 'TEMPLATE_RENDERED'));
    // a creative whose ONLY picture is the brand image has no original as parent; one that also uses an original (the brand image fills a second picture slot) keeps it
    const aiIds = new Set(pkg(o).imageAssets.filter((a) => a.source === 'ai_image').map((a) => a.id));
    const onlyBrand = fromBrand.filter((a) => !a.sourceAssetIds!.some((id) => aiIds.has(id)));
    assert.ok(onlyBrand.length > 0 && onlyBrand.every((a) => a.parentAssetId === null));
    assert.ok(fromBrand.filter((a) => a.sourceAssetIds!.some((id) => aiIds.has(id))).every((a) => a.parentAssetId !== null && aiIds.has(a.parentAssetId)));
    assert.equal(h.counts.templates.rendered, 10);
  });

  it('templates only (0 originals): no image request at all, creatives are rendered from brand assets or picture-free templates', async () => {
    const o = await run({ hybrid: { originals: 0, templateCreatives: 6 } });
    assert.equal(o.fake.imageCalls().length, 0);
    const h = hybridOf(o);
    assert.equal(h.counts.originals.planned, 0);
    assert.equal(h.counts.templates.planned, 6);
    assert.equal(h.counts.templates.rendered + h.counts.templates.skipped + h.counts.templates.failed + h.counts.templates.fallbackRendered, 6);
  });

  it('a continuation completes the missing originals and the template creatives WITHOUT running research, copy or landing again', async () => {
    const first = await run({ openai: failImages([2, 4]) });
    const p1 = pkg(first);
    assert.equal(p1.hybrid!.counts.total.delivered, 12);
    const second = new InMemoryAssetStore();
    const seed = await prepareContinuationSeed(p1, first.store, second, 1);
    assert.ok(seed.hybrid, 'the hybrid state is carried over');
    assert.equal(seed.hybrid!.creatives.length, 9, 'the creatives that were rendered with their planned picture are kept');
    const o2 = await run({ config: { seed }, seedStore: second, runId: 'hybrid-2', hybrid: p1.hybrid!.settings, openai: undefined });
    const p2 = pkg(o2);
    assert.equal(o2.fake.calls('copywriter').length, 0, 'no copy is written again');
    assert.equal(o2.fake.calls('landing').length, 0);
    assert.equal(o2.fake.calls('tselector').length + o2.fake.calls('vresearcher').length, 0);
    assert.equal(o2.fake.imageCalls().length, 2, 'only the 2 missing originals are requested');
    assert.equal(p2.hybrid!.counts.originals.generated, 5);
    assert.equal(p2.hybrid!.counts.templates.rendered, 15);
    assert.equal(p2.hybrid!.counts.total.delivered, 20);
    assert.equal(p2.lineage?.kind, 'image_continuation');
    // the kept creatives are the same files, not renders made again
    const keptHashes = new Set(p1.imageAssets.filter((a) => a.kind === 'layout').map((a) => a.sha256));
    const sameFiles = p2.imageAssets.filter((a) => a.kind === 'layout' && keptHashes.has(a.sha256));
    assert.equal(sameFiles.length, 9);
    // the first campaign is untouched
    assert.equal(p1.hybrid!.counts.total.delivered, 12);
  });

  it('a continuation with every original present only renders the missing template creatives (no image request)', async () => {
    const first = await run();
    const p1 = structuredClone(pkg(first));
    // simulate a campaign whose renders of one concept failed although its originals exist
    const victim = p1.hybrid!.creatives.filter((c) => c.conceptId === p1.concepts[0].id);
    for (const c of victim) {
      const a = p1.imageAssets.find((x) => x.id === c.assetId);
      if (a) a.status = 'superseded';
      Object.assign(c, { status: 'failed', assetId: null, origin: null, sourceAssetIds: [], reason: 'simulated render failure' });
    }
    p1.channelLayouts = p1.channelLayouts.filter((l) => !victim.some((c) => c.assetId === l.assetId));
    p1.hybrid!.counts.templates.rendered = 15 - victim.length;
    p1.hybrid!.counts.templates.failed = victim.length;
    const second = new InMemoryAssetStore();
    const seed = await prepareContinuationSeed(p1, first.store, second, 1);
    const o2 = await run({ config: { seed, maxImages: 0 }, seedStore: second, runId: 'hybrid-3', hybrid: p1.hybrid!.settings });
    assert.equal(o2.fake.imageCalls().length, 0, 'nothing is billed for rendering locally');
    assert.equal(pkg(o2).hybrid!.counts.templates.rendered, 15);
  });

  it('the ZIP has the Hybrid structure and a manifest that only points at files that exist; originals and template creatives are separated', async () => {
    const o = await run({ hybrid: { inspiration: 'references', references: [{ id: 'pin-1', kind: 'pinterest_board', label: 'Pinterest pin (link only)', url: 'https://www.pinterest.com/pin/123456789/', permission: 'platform_restricted_not_stored' }] } });
    const p = pkg(o);
    const { zip, manifest } = await buildCampaignZip(p, o.store, { strategy: { strategyId: p.f3StrategyId, creativeBrief: { objective: 'x' } } });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files);
    assert.equal(names.filter((n) => /^images\/originals\/concept-\d\d-variation-\d\d\.png$/.test(n)).length, 5);
    assert.equal(names.filter((n) => /^images\/templates\/concept-\d\d\/.+\.png$/.test(n)).length, 15);
    for (const d of ['campaign.json', 'manifest.json', 'strategy/', 'creative-brief/creative-brief.json', 'visual-direction/visual-direction.json', 'copy/', 'layouts/selection.json', 'landing/landing-content.json', 'review/findings.json', 'usage/usage.json']) assert.ok(names.some((n) => n === d || n.startsWith(d)), d);
    assert.equal(names.filter((n) => /^layouts\/k\d+-t\d+\.json$/.test(n)).length, 15, 'one layout record per template creative');
    assert.ok(!names.some((n) => /pinterest/i.test(n)), 'nothing from Pinterest');
    const cj = await z.file('campaign.json')!.async('string');
    assert.ok(!/pinterest\.com/i.test(cj), 'a Pinterest address is not copied into a shareable package');
    const hm = manifest.hybrid as { productionMode: string; counts: { total: { delivered: number } }; templateCreatives: { file: string | null; templateVersion: number; sourceFiles: (string | null)[]; deliveredAsFile: boolean }[]; imageToTemplates: { originalFile: string | null; templateCreatives: unknown[] }[] };
    assert.equal(hm.productionMode, 'hybrid_production');
    assert.equal(hm.counts.total.delivered, 20);
    assert.equal(hm.templateCreatives.length, 15);
    for (const t of hm.templateCreatives) {
      assert.ok(t.file && names.includes(t.file), `missing ${t.file}`);
      assert.ok(t.sourceFiles.every((f) => f && names.includes(f)), 'a source file is not in the archive');
      assert.ok(t.templateVersion >= 1);
    }
    assert.equal(hm.imageToTemplates.length, 5);
    assert.equal(hm.imageToTemplates.reduce((n, x) => n + x.templateCreatives.length, 0), 15);
    for (const f of manifest.files.filter((x) => x.kind === 'image' && /^images\/templates\//.test(x.path))) assert.equal(f.origin, 'TEMPLATE_RENDERED');
    for (const f of manifest.files.filter((x) => x.kind === 'image' && /^images\/originals\//.test(x.path))) assert.equal(f.origin, 'AI_GENERATED');
    assert.deepEqual(manifest.assetsMissing, []);
    // the focused downloads
    const t = await JSZip.loadAsync((await buildCreativesZip(p, o.store, 'templates')).zip);
    assert.equal(Object.keys(t.files).filter((n) => n.endsWith('.png')).length, 15);
    const all = await JSZip.loadAsync((await buildCreativesZip(p, o.store, 'all')).zip);
    assert.equal(Object.keys(all.files).filter((n) => n.endsWith('.png')).length, 20);
  });

  it('existing presets are untouched: without hybrid there is no Hybrid block, no template participant and layouts are cut from every original', async () => {
    const o = await run({ config: { hybrid: null, layoutsPerOriginal: 2 } });
    const p = pkg(o);
    assert.equal(p.hybrid, null);
    assert.ok(!o.packages[0].meta.plan.activated.some((a) => /Template|Researcher/.test(a.agent)));
    assert.ok(p.channelLayouts.length > 5, 'layouts are cut from the originals as before');
    assert.ok(p.imageAssets.filter((a) => a.kind === 'layout').every((a) => a.source === 'ai_image'));
  });
});
