import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { designAnchors, designBrandColors, editPaletteRole, newDesign, paletteKeyOf, type CampaignDesign } from '../collections/design';
import { getCollection } from '../collections/registry';
import { InMemoryAssetStore } from '../creative/assets';
import type { CreativeInput } from '../creative/context';
import { prepareContinuationSeed } from '../creative/continuation';
import { buildCampaignZip } from '../creative/export';
import type { CampaignPackage } from '../creative/schemas';
import { FACTORY_EVENT_TYPES } from '../factory/events';
import type { RecordedEvent } from '../factory/state';
import type { DiscoveryResult } from '../imagery/types';
import type { VisualDiscoveryPort } from '../imagery/discovery';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '../testing/fake-openai';
import { verifyTemplateExport } from './quality';
import { mergeHybrid, type HybridSettings } from './settings';

// The approved campaign design drives the whole Hybrid run: real Mozaik participants over a fake text and image API (real HTTP, nothing billed).

const KEY = 'sk-test-DESIGN1234567890abcdefghijkl';
const IMAGE_MODEL = 'gpt-image-1.5';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('Hybrid Production with an approved campaign design (real Mozaik agents; fake text and image APIs)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const confirmed = (d: CampaignDesign): CampaignDesign => ({ ...d, confirmed: true, confirmedAt: '2026-11-02T10:00:00.000Z' });
  const input = (o: Partial<CreativeInput> = {}): CreativeInput => ({ projectName: 'Deep Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 5, landing: true, ...o });

  async function run(o: { hybrid?: Partial<HybridSettings>; config?: Partial<CreativeRunConfig>; openai?: FakeOpenAIOptions; seedStore?: InMemoryAssetStore; runId?: string; discovery?: VisualDiscoveryPort | null } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = o.seedStore ?? new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const settings = mergeHybrid({ directionRefine: false, ...o.hybrid });
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: o.runId ?? 'design-1',
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
        input: input(),
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
        hybrid: { settings, brandImages: [], referencePalettes: {}, ...(o.discovery !== undefined ? { discovery: o.discovery } : {}) },
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
  const hybridOf = (o: Outcome) => pkg(o).hybrid!;
  const failImages = (attempts: number[]): FakeOpenAIOptions => ({
    reply: (req: FakeRequest): FakeReply | undefined => (req.kind === 'image' && attempts.includes(req.attempt) ? { status: 400, json: { error: { message: 'The request was rejected by the safety system.', type: 'invalid_request_error', code: 'moderation_blocked' } } } : undefined),
  });

  const design = (): CampaignDesign => confirmed(editPaletteRole(editPaletteRole(newDesign('premium_editorial', { formats: ['instagram_post', 'instagram_story', 'website_banner'] }), 'primary', '#0b6e4f'), 'accent', '#e4572e'));

  it('default: 5 authorized originals + 15 template creatives, all from the approved collection and drawn with the approved palette', async () => {
    const d = design();
    const o = await run({ hybrid: { design: d } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    const c = getCollection('premium_editorial')!;
    assert.equal(o.fake.imageCalls().length, 5, 'exactly the 5 requested originals; template creatives never call the image model');
    assert.deepEqual(h.counts.originals, { planned: 5, requested: 5, generated: 5, failed: 0, skipped: 0, blockedByBudget: 0 });
    assert.equal(h.counts.templates.rendered, 15);
    assert.equal(h.counts.total.delivered, 20);
    // the Template Selector stayed INSIDE the collection and says which one it used
    assert.deepEqual(h.selection!.collection, { id: c.id, version: c.version, name: c.name });
    for (const it of h.selection!.items) assert.ok(c.templateIds.includes(it.templateId), `${it.slotId}: ${it.templateId}`);
    // lineage of every creative: collection, version, palette, template version, its source assets
    for (const t of h.creatives) {
      assert.equal(t.collectionId, 'premium_editorial');
      assert.equal(t.collectionVersion, c.version);
      assert.equal(t.paletteKey, paletteKeyOf(d.palette));
      assert.equal(t.status, 'rendered');
      assert.equal(t.origin, 'TEMPLATE_RENDERED');
      assert.ok(t.sourceAssetIds.length >= 1, 'built from an original');
    }
    // only the chosen formats were produced
    const sizes = new Set(h.creatives.map((t) => `${t.width}x${t.height}`));
    for (const s of sizes) assert.ok(['1080x1080', '1080x1350', '1080x1920', '1200x300', '1920x800'].includes(s), s);
    assert.equal(h.settings.design?.collectionId, 'premium_editorial', 'the design is stored with the campaign');
    assert.equal(h.collectionsVersion?.startsWith('launchpilot-collections-'), true);
    // the Layout Designer used the approved palette: the creatives are made of its colors
    const a = designAnchors(d.palette);
    const wanted = [...designBrandColors(d.palette), a.ink, a.paper].map(rgb);
    for (const t of h.creatives.slice(0, 6)) {
      const png = await o.store.load(t.assetId!);
      const raw = await sharp(png).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      let near = 0;
      for (let i = 0; i < raw.length; i += 3) if (wanted.some((w) => dist([raw[i], raw[i + 1], raw[i + 2]], w) < 28)) near++;
      assert.ok(near / (raw.length / 3) > 0.12, `${t.slotId}: only ${(100 * near / (raw.length / 3)).toFixed(0)}% of the pixels are palette colors`);
    }
    // the Template Quality Reviewer found the creatives consistent with the design
    assert.ok(h.quality?.complete, h.quality?.summary ?? 'no quality report');
    assert.ok(!h.quality!.issues.some((i) => i.kind === 'design_mismatch'));
  });

  it('the Visual Researcher publishes a direction with the approved design LOCKED in: collection style, approved palette, no model can replace them', async () => {
    const d = design();
    const refine = await run({ hybrid: { design: d, directionRefine: true }, runId: 'design-refine' });
    assert.equal(refine.result.status, 'completed');
    const dir = hybridOf(refine).direction!;
    const c = getCollection('premium_editorial')!;
    assert.equal(dir.styleId, c.styleId);
    assert.equal(dir.colors.primary, '#0b6e4f');
    assert.equal(dir.colors.accent, '#e4572e');
    assert.equal(dir.typography.headline, c.tokens.typography.headline.family);
    assert.deepEqual(dir.secondaryStyleIds, [], 'a refinement cannot add another style');
    assert.ok(dir.references.some((r) => r.id === 'campaign-design'));
  });

  it('a different palette really changes the campaign: another primary color gives other creatives, with the same collection and templates', async () => {
    const one = await run({ hybrid: { design: design() }, runId: 'pal-1' });
    const d2 = confirmed(editPaletteRole(design(), 'primary', '#7a1fa2'));
    const two = await run({ hybrid: { design: d2 }, runId: 'pal-2' });
    const sel = (o: Outcome) => hybridOf(o).selection!.items.map((i) => i.templateId).join(',');
    assert.equal(sel(one), sel(two), 'the palette does not change the choice of templates');
    const hashes = (o: Outcome) => hybridOf(o).creatives.map((t) => pkg(o).imageAssets.find((a) => a.id === t.assetId)!.sha256);
    const h1 = hashes(one);
    const h2 = hashes(two);
    assert.ok(h2.filter((x, i) => x !== h1[i]).length >= 10, 'most creatives changed with the palette');
    assert.notEqual(hybridOf(one).creatives[0].paletteKey, hybridOf(two).creatives[0].paletteKey);
  });

  it('budget accounting is the same with or without a design: the same text calls and the same image requests', async () => {
    const withDesign = await run({ hybrid: { design: design() }, runId: 'acc-1' });
    const without = await run({ runId: 'acc-2' });
    assert.equal(pkg(withDesign).usage.images.requested, 5);
    assert.equal(pkg(without).usage.images.requested, 5);
    assert.equal(pkg(withDesign).usage.text.calls, pkg(without).usage.text.calls);
    assert.equal(hybridOf(without).settings.design, null, 'a campaign without a design keeps working as before');
    assert.equal(hybridOf(without).selection!.collection ?? null, null);
    assert.ok(hybridOf(without).creatives.every((t) => !t.collectionId));
  });

  it('REAL SemanticEvents, in a valid order: direction, then selection, then layouts, then the template quality check, then the campaign', async () => {
    const o = await run({ hybrid: { design: design() }, runId: 'events-1' });
    const known = new Set<string>(FACTORY_EVENT_TYPES);
    // every factory-level event of the creative phase is a registered semantic event (the runtime's own message events are not ours)
    for (const e of o.events) if (/^(visual|template|layout|campaign|phase|task|finding|concept|copy|landing|review|revision|fix|factory|report)\./.test(e.type)) assert.ok(known.has(e.type), `unregistered event type ${e.type}`);
    const first = (t: string) => o.events.findIndex((e) => e.type === t);
    const order = ['visual.direction.published', 'template.selection.completed', 'layout.completed', 'template.quality.completed', 'campaign.completed'].map(first);
    assert.ok(order.every((i) => i >= 0), order.join(','));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'events come in the order of the work');
    const sequences = o.events.map((e) => e.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length);
    const published = o.events.find((e) => e.type === 'visual.direction.published')!.payload as { direction: { origin: string } };
    assert.equal(published.direction.origin, 'user_approved');
  });

  it('the reviewer DETECTS an inconsistent design: another collection, a template outside the collection, another palette, missing lineage', async () => {
    const d = design();
    const o = await run({ hybrid: { design: d }, runId: 'rev-1' });
    const h = hybridOf(o);
    const c = getCollection('premium_editorial')!;
    const ok = { collectionId: c.id, collectionVersion: c.version, templateIds: c.templateIds, paletteKey: paletteKeyOf(d.palette) };
    const check = (creatives: typeof h.creatives, design: typeof ok | null = ok) => verifyTemplateExport({ design, selection: h.selection, creatives, assets: pkg(o).imageAssets, load: (id) => o.store.load(id) });
    assert.equal((await check(h.creatives)).issues.filter((i) => i.kind === 'design_mismatch').length, 0);
    const tamper = (patch: Partial<(typeof h.creatives)[number]>) => h.creatives.map((t, i) => (i === 0 ? { ...t, ...patch } : t));
    for (const patch of [{ collectionId: 'bold_startup' }, { templateId: 'tech_dark_premium' }, { paletteKey: 'ffffff-ffffff-ffffff-ffffff-ffffff' }, { collectionId: null, paletteKey: null }]) {
      const issues = (await check(tamper(patch as never))).issues.filter((i) => i.kind === 'design_mismatch');
      assert.equal(issues.length, 1, JSON.stringify(patch));
      assert.match(issues[0].message, /approved campaign design/);
    }
    // the same records are fine for a campaign without a design
    assert.equal((await check(tamper({ collectionId: 'bold_startup' }), null)).issues.filter((i) => i.kind === 'design_mismatch').length, 0);
  });

  it('a failed run can be continued safely: the design, its collection and its palette carry over; only the missing images are requested', async () => {
    const d = design();
    const first = await run({ hybrid: { design: d }, openai: failImages([2, 4]), runId: 'cont-1' });
    const p1 = pkg(first);
    assert.ok(p1.hybrid!.counts.total.delivered < 20);
    assert.equal(p1.hybrid!.settings.design?.collectionId, 'premium_editorial');
    const second = new InMemoryAssetStore();
    const seed = await prepareContinuationSeed(p1, first.store, second, 1);
    const o2 = await run({ config: { seed }, seedStore: second, runId: 'cont-2', hybrid: p1.hybrid!.settings });
    const p2 = pkg(o2);
    assert.equal(o2.fake.imageCalls().length, 2, 'only the 2 missing originals');
    assert.equal(p2.hybrid!.counts.total.delivered, 20);
    assert.equal(p2.hybrid!.settings.design?.paletteEvidence.primary?.source, 'user', 'the palette evidence survives');
    assert.ok(p2.hybrid!.creatives.every((t) => t.collectionId === 'premium_editorial' && t.paletteKey === paletteKeyOf(d.palette)));
    assert.equal(p1.hybrid!.settings.design?.collectionId, 'premium_editorial', 'the first campaign is untouched');
  });

  // ---- web visual discovery: inspiration and licensed candidates never become campaign assets -----------------------------------------------

  const discovery = (): DiscoveryResult => ({
    searchedAt: '2026-11-02T10:00:00.000Z',
    intents: [{ query: 'diving school', why: 'the business', orientation: null }],
    providers: [
      { id: 'pixabay', label: 'Pixabay', kind: 'licensed', status: 'ok', message: null, count: 1 },
      { id: 'brave_images', label: 'Web image search (reference only)', kind: 'reference', status: 'ok', message: null, count: 1 },
    ],
    licensed: [{ id: '1', provider: 'pixabay', kind: 'LICENSED_STOCK', title: 'Coral reef', pageUrl: 'https://pixabay.com/photos/coral-reef-1/', creator: 'ocean', creatorUrl: null, width: 4000, height: 3000, tags: ['reef'], thumbnailUrl: null, downloadUrl: 'https://pixabay.com/get/a_1280.jpg', license: { status: 'cleared', license: 'Pixabay Content License', licenseUrl: null, commercialUse: true, derivatives: true, attributionRequired: false, attribution: 'Image by ocean on Pixabay', reasons: [] }, platform: null }],
    references: [{ id: 'pin', provider: 'brave_images', kind: 'REFERENCE_ONLY', title: 'Diving inspiration', pageUrl: 'https://www.pinterest.com/pin/777000777/', creator: null, creatorUrl: null, width: null, height: null, tags: [], thumbnailUrl: null, downloadUrl: null, license: { status: 'blocked', license: 'No license: reference only', licenseUrl: null, commercialUse: false, derivatives: false, attributionRequired: false, attribution: null, reasons: [] }, platform: 'Pinterest: link only' }],
    notes: [],
  });

  it('the Visual Researcher records discovery as candidates and links; none of it enters the assets or the export, and no AI image is replaced', async () => {
    const o = await run({ hybrid: { design: design() }, discovery: async () => discovery(), runId: 'disc-1' });
    assert.equal(o.result.status, 'completed');
    const h = hybridOf(o);
    assert.equal(h.discovery?.usedInCampaign, false);
    assert.equal(h.discovery?.licensed.length, 1);
    assert.equal(h.discovery?.references.length, 1);
    assert.equal(o.fake.imageCalls().length, 5, 'the 5 requested AI images are still generated');
    assert.ok(pkg(o).imageAssets.every((a) => a.origin !== 'LICENSED_ASSET' && a.origin !== 'USER_UPLOADED'), 'nothing from the web is an asset');
    const built = await buildCampaignZip(pkg(o), o.store, { credits: undefined });
    const zip = await JSZip.loadAsync(built.zip);
    assert.ok(zip.file('design/campaign-design.json'), 'the approved design travels with the package');
    const manifestDesign = (built.manifest.hybrid as { design: { collectionId: string } }).design;
    assert.equal(manifestDesign.collectionId, 'premium_editorial');
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir || !/\.(json|md|txt|csv|html)$/i.test(name)) continue;
      const text = await zip.files[name].async('string');
      assert.ok(!/777000777/.test(text), `${name}: a reference-only Pinterest link is not part of the export`);
    }
  });

  it('a failing or slow search provider never blocks the campaign', async () => {
    const o = await run({ hybrid: { design: design() }, discovery: async () => { throw new Error('provider exploded SECRET-KEY'); }, runId: 'disc-2' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(hybridOf(o).counts.total.delivered, 20);
    assert.equal(hybridOf(o).discovery ?? null, null, 'no discovery is claimed when none happened');
    assert.ok(!JSON.stringify(o.events).includes('SECRET-KEY'));
  });
});
