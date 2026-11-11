import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { designAnchors, designBrandColors, editPaletteRole, newDesign, type CampaignDesign } from '../collections/design';
import { InMemoryAssetStore } from '../creative/assets';
import type { CreativeInput } from '../creative/context';
import { buildCampaignZip } from '../creative/export';
import type { CampaignPackage } from '../creative/schemas';
import type { RecordedEvent } from '../factory/state';
import { analyzeImage } from '../imagery/analysis';
import type { VisualDiscoveryPort } from '../imagery/discovery';
import { candidateRights, stockRights, uploadRights, type ImageRights } from '../imagery/rights';
import { pixabayVerdict, pexelsVerdict } from '../imagery/license';
import type { DiscoveryResult, ImageCandidate } from '../imagery/types';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { BrandImage, ImageAcquirePort } from '../runtime/programs/f4/env';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { FakeOpenAI, type FakeOpenAIOptions } from '../testing/fake-openai';
import { NO_AI_PRESET, mergeHybrid, type HybridSettings } from './settings';

// NO AI HYBRID with the real Mozaik runtime: real participants, a fake text API over real HTTP, no image model anywhere. Nothing is billed.

const KEY = 'sk-test-NOAI1234567890abcdefghijklmn';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}

async function jpeg(seed: number, w = 1600, h = 1200): Promise<Buffer> {
  const hue = (seed * 67) % 360;
  const shapes = Array.from({ length: 6 }, (_, i) => `<circle cx="${(seed * 131 + i * 307) % w}" cy="${(seed * 89 + i * 211) % h}" r="${70 + ((seed + i) * 37) % 200}" fill="hsl(${(hue + i * 55) % 360},70%,${28 + i * 9}%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},60%,66%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

async function libraryImage(seed: number, o: { id?: string; rights?: ImageRights; name?: string; text?: string; via?: 'library' | 'auto_stock' } = {}): Promise<BrandImage> {
  const data = await jpeg(seed);
  const analysis = await analyzeImage(data);
  return { id: o.id ?? `asset-${seed}`, name: o.name ?? `photo-${seed}.jpg`, data, library: { rights: o.rights ?? uploadRights(), analysis, text: o.text ?? 'diving school reef ocean', width: 1600, height: 1200, pageUrl: null, via: o.via ?? 'library' } };
}

describe('NO AI HYBRID (real Mozaik agents; fake text API; no image model)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const confirmed = (d: CampaignDesign): CampaignDesign => ({ ...d, confirmed: true, confirmedAt: '2026-11-03T10:00:00.000Z' });
  const design = (id: Parameters<typeof newDesign>[0] = 'premium_editorial'): CampaignDesign => confirmed(editPaletteRole(newDesign(id, { formats: ['instagram_post', 'instagram_story', 'website_banner'] }), 'primary', '#0b6e4f'));
  const input = (): CreativeInput => ({ projectName: 'Blue Reef Diving School', language: 'en', websiteUrl: null, channels: ['instagram', 'facebook'], concepts: 5, landing: true });

  async function run(o: { hybrid?: Partial<HybridSettings>; images?: BrandImage[]; discovery?: VisualDiscoveryPort | null; acquire?: ImageAcquirePort | null; config?: Partial<CreativeRunConfig>; openai?: FakeOpenAIOptions; runId?: string } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const settings = mergeHybrid({ ...NO_AI_PRESET, directionRefine: false, design: design(), ...o.hybrid });
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: o.runId ?? 'noai-1',
      projectId: 'project-1',
      userId: 'user-1',
      mode: 'creative_production',
      manifest: { productName: 'Blue Reef Diving School' },
      credentials: { provider: 'openai', apiKey: KEY },
      creative: {
        campaignId: 'campaign-1',
        projectId: 'project-1',
        f1: chain.f1,
        f2: chain.f2,
        f3: chain.f3,
        input: input(),
        model: 'gpt-test-mini',
        imageModel: null,
        maxImages: 0,
        maxModelCalls: 60,
        maxRepairRounds: 1,
        agentTimeoutMs: 8000,
        reviewTimeoutMs: 5000,
        repairTimeoutMs: 6000,
        productionTimeoutMs: 60_000,
        timeoutMs: 90_000,
        retryBaseDelayMs: 5,
        hybrid: { settings, brandImages: o.images ?? [], referencePalettes: {}, discovery: o.discovery ?? null, acquire: o.acquire ?? null, discoveredBefore: 7 },
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
  const hybridOf = (o: Outcome) => o.packages[0].pkg.hybrid!;

  it('20 template creatives from 6 approved pictures with ZERO image requests; every creative is built from an approved picture and the rights travel with it', async () => {
    const images = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => libraryImage(n)));
    const o = await run({ images });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const pkg = o.packages[0].pkg;
    const h = hybridOf(o);
    assert.equal(o.fake.imageCalls().length, 0, 'not a single image request reached the provider');
    assert.equal(pkg.usage.images.requested, 0);
    assert.equal(pkg.cost?.imageUsd, 0, 'image cost is exactly zero, not unknown');
    assert.equal(h.counts.originals.planned, 0);
    assert.equal(h.counts.templates.planned, 20);
    assert.equal(h.counts.templates.rendered, 20, h.notes.join(' | '));
    assert.equal(h.counts.total.delivered, 20);
    assert.equal(h.counts.spending.imageUsd, 0);
    assert.equal(pkg.imageVariations.length, 0, 'no AI image slots exist');
    assert.ok(!pkg.imageAssets.some((a) => a.source === 'ai_image'));
    const im = h.imagery!;
    assert.equal(im.mode, 'no_ai_hybrid');
    assert.equal(im.aiImagesGenerated, 0);
    assert.equal(im.imageRequests, 0);
    assert.equal(im.approved, 6);
    assert.equal(im.discovered, 7 + 0, 'the gallery\'s candidates are reported, not used');
    const ids = new Set(im.library.map((l) => l.id));
    for (const t of h.creatives) {
      assert.equal(t.status, 'rendered');
      assert.ok(t.sourceAssetIds.length >= 1 && t.sourceAssetIds.every((s) => ids.has(s.replace(/^brand:/, ''))), `${t.slotId}: built only from approved pictures`);
    }
    for (const c of im.perConcept) assert.ok(c.imageIds.length >= 1 && c.imageIds.length <= 3);
    for (const l of im.library) assert.ok(l.usedBySlots.length >= 0 && l.verification === 'user_owned');
    // the asset record says what it inherits
    const layout = pkg.imageAssets.find((a) => a.kind === 'layout')!;
    assert.match(layout.rights?.note ?? '', /Inherits the rights of its source picture/);
    assert.equal(layout.origin, 'TEMPLATE_RENDERED');
    assert.ok(h.quality?.complete, h.quality?.summary ?? 'no quality report');
    assert.ok(!h.quality!.issues.some((i) => i.kind === 'ineligible_source'));
    // text fits: nothing was cut off or overflowed, and nothing needed a trimmed headline
    for (const t of h.creatives) assert.ok(!t.flags.some((f) => f === 'text_overflow' || f.startsWith('text_trimmed:headline')), `${t.slotId}: ${t.flags.join(',')}`);
    // cropping: a picture that serves several creatives is centred differently each time, and the crop point travels with the plan
    const foci = new Map<string, Set<string>>();
    for (const i of h.selection!.items) {
      assert.ok(i.focus && i.focus.every((v) => v >= 0.08 && v <= 0.92), `${i.slotId}: a crop point inside the picture`);
      (foci.get(i.imageId!) ?? foci.set(i.imageId!, new Set()).get(i.imageId!)!).add(i.focus!.join(','));
    }
    for (const [id, set] of foci) assert.equal(set.size, h.selection!.items.filter((i) => i.imageId === id).length, `${id}: every reuse is cropped differently`);
    // the approved palette is applied: the creatives are made of its colors
    const d = design();
    const a = designAnchors(d.palette);
    const wanted = [...designBrandColors(d.palette), a.ink, a.paper].map((hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)));
    for (const t of h.creatives.slice(0, 6)) {
      const raw = await sharp(await o.store.load(t.assetId!)).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      let near = 0;
      for (let k = 0; k < raw.length; k += 3) if (wanted.some((w) => Math.hypot(raw[k] - w[0], raw[k + 1] - w[1], raw[k + 2] - w[2]) < 28)) near++;
      assert.ok(near / (raw.length / 3) > 0.1, `${t.slotId}: only ${((100 * near) / (raw.length / 3)).toFixed(0)}% of its pixels are palette colors`);
    }
    // limitations say the truth
    assert.ok(pkg.limitations.some((l) => /NO AI HYBRID: no AI image was generated/.test(l)));
  });

  it('the Visual Researcher and the Template Selector really collaborate: pictures are sourced BEFORE any template is chosen, and the Visual Creator generates nothing', async () => {
    const o = await run({ images: await Promise.all([1, 2, 3].map((n) => libraryImage(n))) });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const order = o.events.map((e) => e.type);
    const i = (t: string) => order.indexOf(t);
    assert.ok(i('images.sourcing.requested') >= 0 && i('images.sourced') > i('images.sourcing.requested'));
    assert.ok(i('template.selection.completed') > i('images.sourced'), 'templates are chosen after the pictures exist');
    assert.ok(order.includes('layout.completed'));
    const sourced = o.events.find((e) => e.type === 'images.sourced')!;
    assert.equal(sourced.participant, 'Visual Researcher');
    assert.ok(!o.events.some((e) => e.type === 'visual.generated'), 'no image was generated');
    const meta = o.packages[0].meta;
    const visual = meta.participants.find((p) => p.agent === 'Visual Creator');
    assert.equal(visual?.state, 'skipped');
    assert.match(visual?.reason ?? '', /NO AI HYBRID never generates images/);
    assert.equal(meta.participants.find((p) => p.agent === 'Visual Researcher')?.state, 'done');
    assert.equal(meta.images?.requestsStarted ?? 0, 0);
  });

  it('20 creatives are visually distinct although they reuse a handful of pictures', async () => {
    const o = await run({ images: await Promise.all([1, 2, 3, 4].map((n) => libraryImage(n * 5))), runId: 'noai-distinct' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    const thumbs: Uint8Array[] = [];
    const shas = new Set<string>();
    for (const t of h.creatives) {
      const png = await o.store.load(t.assetId!);
      const meta = await sharp(png).metadata();
      assert.deepEqual([meta.width, meta.height], [t.width, t.height], `${t.slotId}: the planned size`);
      shas.add((await import('node:crypto')).createHash('sha256').update(png).digest('hex'));
      thumbs.push(new Uint8Array(await sharp(png).resize(64, 64, { fit: 'fill' }).grayscale().raw().toBuffer()));
    }
    assert.equal(shas.size, 20, 'no two creatives are the same file');
    // how different two creatives look: the mean absolute difference of their 64x64 grayscale thumbnails (0..255)
    const diffs: number[] = [];
    for (let a = 0; a < thumbs.length; a++) for (let b = a + 1; b < thumbs.length; b++) {
      let d = 0;
      for (let i = 0; i < thumbs[a].length; i++) d += Math.abs(thumbs[a][i] - thumbs[b][i]);
      diffs.push(d / thumbs[a].length);
    }
    diffs.sort((x, y) => x - y);
    // two banners of the same template on different pictures differ mostly in their text (small at 64x64), so the floor is low; the SHAPE of the whole set is what matters
    assert.ok(diffs[0] >= 0.3, `the two most similar creatives differ by only ${diffs[0].toFixed(2)} of 255 on average`);
    assert.ok(diffs.filter((d) => d < 6).length <= 12, `${diffs.filter((d) => d < 6).length} of 190 pairs look nearly the same`);
    assert.ok(diffs[Math.floor(diffs.length / 2)] > 40, 'the typical pair of creatives looks clearly different');
    const pairs = h.selection!.items.map((i) => `${i.templateId}|${i.imageId}`);
    assert.ok(new Set(pairs).size >= 16, 'the same template is rarely drawn on the same picture twice');
    assert.equal(new Set(h.selection!.items.map((i) => i.templateId)).size >= 5, true);
    const sizes = new Set(h.creatives.map((t) => `${t.width}x${t.height}`));
    for (const s of sizes) assert.ok(['1080x1080', '1080x1350', '1080x1920', '1200x300', '1920x800'].includes(s), s);
  });

  it('the rights gate holds inside the run: a website candidate nobody attested, a blocked license and a reference are never used, even when handed in', async () => {
    const good = await libraryImage(1, { id: 'own-1' });
    const unattested = await libraryImage(2, { id: 'web-1', name: 'website-photo.jpg', rights: candidateRights('website') });
    const blocked = await libraryImage(3, { id: 'stock-blocked', rights: stockRights({ ...pixabayVerdict({ tags: [], title: 'x', user: null, pageUrl: '' }), status: 'blocked', commercialUse: false }, { userApproved: true }) });
    const needsReview = await libraryImage(4, { id: 'stock-review', rights: stockRights(pexelsVerdict({ tags: ['woman'], title: 'x', photographer: 'Bo' }), { userApproved: true }) });
    const o = await run({ images: [good, unattested, blocked, needsReview], runId: 'noai-rights' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    assert.deepEqual(h.imagery!.library.map((l) => l.id), ['own-1']);
    for (const t of h.creatives) assert.ok(t.sourceAssetIds.every((s) => s === 'brand:own-1'), `${t.slotId}: ${t.sourceAssetIds.join(',')}`);
    assert.ok(h.imagery!.notes.some((n) => /website-photo\.jpg.*Confirm that you hold the rights/.test(n)));
    assert.ok(h.imagery!.notes.some((n) => /stock-blocked|does not allow use in advertising|Check the license/.test(n)));
    // one picture, 20 creatives: they all use it and still differ
    assert.equal(h.imagery!.approved, 1);
  });

  it('automatic stock mode adds only CLEARED licensed pictures (never one that needs a check) and records their provenance', async () => {
    const cleared = (id: string): ImageCandidate => ({ id, provider: 'pixabay', kind: 'LICENSED_STOCK', title: `Coral reef ${id}`, pageUrl: `https://pixabay.com/photos/${id}/`, creator: `maker-${id}`, creatorUrl: null, width: 1920, height: 1280, tags: ['coral', 'reef', 'ocean'], thumbnailUrl: null, downloadUrl: `https://pixabay.com/get/${id}.jpg`, license: pixabayVerdict({ tags: ['coral'], title: id, user: `maker-${id}`, pageUrl: '' }), platform: null });
    const people: ImageCandidate = { ...cleared('p9'), id: 'p9', title: 'Diver portrait', tags: ['woman', 'portrait'], license: pexelsVerdict({ tags: ['woman', 'portrait'], title: 'x', photographer: 'Bo' }) };
    const searched: string[] = [];
    const discovery: VisualDiscoveryPort = async (c) => {
      searched.push(JSON.stringify(c.concepts?.length));
      return { intents: [], providers: [{ id: 'pixabay', label: 'Pixabay', kind: 'licensed', status: 'ok', message: null, count: 4 }], licensed: [cleared('c1'), cleared('c2'), cleared('c3'), people], references: [], notes: [], searchedAt: '2026-11-03T10:00:00.000Z' } satisfies DiscoveryResult;
    };
    const acquired: string[] = [];
    const acquire: ImageAcquirePort = async (c) => {
      acquired.push(c.id);
      const data = await jpeg(40 + acquired.length * 13);
      return { ok: true, image: { id: `stock-${c.id}`, name: `pixabay-${c.id}.jpg`, data, library: { rights: stockRights(c.license, { userApproved: true }), analysis: await analyzeImage(data), text: `${c.title} ${c.tags.join(' ')}`, width: 1600, height: 1200, pageUrl: c.pageUrl, via: 'auto_stock' } } };
    };
    const own = await libraryImage(1);
    const o = await run({ images: [own], hybrid: { imagery: { generation: 'forbidden', autoStock: true, maxSourcesPerConcept: 3, allowPaidSearch: false } }, discovery, acquire, runId: 'noai-auto' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    assert.deepEqual(acquired.sort(), ['c1', 'c2', 'c3'], 'the picture that needs a check was never acquired');
    assert.equal(h.imagery!.autoAdded, 3);
    assert.equal(h.imagery!.approved, 4);
    assert.equal(h.imagery!.library.filter((l) => l.via === 'auto_stock').length, 3);
    assert.ok(h.imagery!.library.every((l) => l.id !== 'stock-p9'));
    assert.ok(h.imagery!.notes.some((n) => /need a license check/.test(n)));
    assert.equal(searched[0], '5', 'the search was built from the 5 concepts');
    assert.equal(o.fake.imageCalls().length, 0);
    // the credits of the used stock pictures are in the archive
    const zip = await buildCampaignZip(o.packages[0].pkg, o.store, { sources: [] });
    const z = await JSZip.loadAsync(zip.zip);
    const credits = await z.file('CREDITS.txt')?.async('string');
    assert.match(credits ?? '', /Image by maker-c\d on Pixabay/);
  });

  it('without automatic mode, nothing is fetched from a provider and the run says how to get more pictures', async () => {
    let searches = 0;
    const o = await run({ images: [await libraryImage(1)], discovery: async () => (searches++, { intents: [], providers: [], licensed: [], references: [], notes: [], searchedAt: '' }), acquire: async () => ({ ok: false, message: 'x' }), runId: 'noai-manual' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(searches, 0, 'a provider is searched during the run only when the user switched automatic stock mode on');
    assert.ok(hybridOf(o).imagery!.notes.some((n) => /automatic stock mode/.test(n)));
  });

  it('with no pictures at all the creatives are text-first and honest: nothing is faked, and a shortfall is labelled PARTIAL', async () => {
    const o = await run({ images: [], runId: 'noai-none' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const pkg = o.packages[0].pkg;
    const h = hybridOf(o);
    assert.equal(h.imagery!.approved, 0);
    assert.equal(o.fake.imageCalls().length, 0);
    assert.equal(h.counts.templates.planned, 20);
    for (const t of h.creatives.filter((c) => c.status === 'rendered')) assert.deepEqual(t.sourceAssetIds, [], 'a text-first creative claims no picture');
    const delivered = h.counts.templates.rendered + h.counts.templates.fallbackRendered;
    assert.equal(h.counts.total.delivered, delivered);
    assert.ok(pkg.limitations.some((l) => /No approved picture was available/.test(l)));
    if (delivered < 20) {
      assert.ok(pkg.limitations.some((l) => /PARTIAL CAMPAIGN/.test(l)));
      const blocked = h.creatives.filter((c) => c.status === 'skipped');
      assert.equal(blocked.length, 20 - delivered, 'every undelivered creative is recorded as blocked with its reason');
      assert.ok(blocked.every((c) => /Blocked/.test(c.reason ?? '')));
      assert.equal(h.imagery!.blockedSlots.length, blocked.length);
    }
    assert.ok(h.creatives.length >= 1 && delivered >= 1, 'text-first templates of the collection still produce real creatives');
  });

  it('GET CONTENT: the approved logo reaches the creatives that can carry it, every creative says so, and the archive records it', async () => {
    const logo = await sharp({ create: { width: 640, height: 220, channels: 4, background: '#0b3d91' } }).png().toBuffer();
    const brand = { logo: { approved: true as const, assetId: 'asset-logo', source: 'website', fileName: 'site-logo.png', width: 640, height: 220 }, approvedPhotos: 3, approvedAt: '2026-11-03T10:00:00.000Z' };
    const o = await run({ images: await Promise.all([1, 2, 3].map((n) => libraryImage(n))), config: { logo, brand }, runId: 'noai-brand' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    assert.equal(h.brand?.logo?.approved, true);
    assert.equal(h.brand?.logo?.assetId, 'asset-logo');
    assert.equal(h.brand?.approvedPhotos, 3);
    assert.equal(h.brand!.withLogo + h.brand!.omitted.length, 20, 'every creative has an outcome');
    assert.ok(h.brand!.withLogo >= 18, `${h.brand!.withLogo} of 20 creatives carry the approved logo`);
    for (const c of h.creatives.filter((x) => x.status === 'rendered')) assert.ok(c.logo && (c.logo.applied || (c.logo.reason ?? '').length > 5), `${c.slotId}: ${JSON.stringify(c.logo)}`);
    for (const om of h.brand!.omitted) assert.ok(om.reason.length > 5, 'an omitted logo always has a reason');
    assert.equal(h.quality!.issues.filter((i) => i.kind === 'logo_omitted').length, h.brand!.omitted.length);
    // the Visual Researcher says what it was given (counts only: no text from the outside)
    const finding = o.events.filter((e) => e.type === 'finding.posted' && e.participant === 'Visual Researcher').map((e) => JSON.stringify(e.payload)).join(' ');
    assert.match(finding, /Approved brand content: the official logo and 3 approved photograph/);
    // the archive carries the brand metadata and the logo file
    const { zip } = await buildCampaignZip(o.packages[0].pkg, o.store, { logo: { fileName: 'site-logo.png', data: logo, rights: 'Rights confirmed by the project owner' } });
    const z = await JSZip.loadAsync(zip);
    const meta = JSON.parse(await z.file('design/brand-content.json')!.async('string')) as { logo: { file: string | null; rights: string | null; assetId: string }; creativesWithLogo: number };
    assert.equal(meta.logo.assetId, 'asset-logo');
    assert.match(meta.logo.file ?? '', /^design\/brand\/logo-site-logo\.png$/);
    assert.equal(meta.creativesWithLogo, h.brand!.withLogo);
    assert.ok(z.file('design/brand/logo-site-logo.png'));
  });

  it('WITHOUT Get Content nothing about the brand is recorded: a campaign behaves exactly as before', async () => {
    const logo = await sharp({ create: { width: 640, height: 220, channels: 4, background: '#0b3d91' } }).png().toBuffer();
    const o = await run({ images: await Promise.all([1, 2].map((n) => libraryImage(n))), config: { logo }, runId: 'noai-nobrand' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    assert.equal(h.brand, undefined, 'no brand block');
    for (const c of h.creatives) assert.equal(c.logo, undefined, `${c.slotId}: no logo outcome is recorded`);
    assert.ok(!h.quality!.issues.some((i) => i.kind === 'logo_omitted'));
    const z = await JSZip.loadAsync((await buildCampaignZip(o.packages[0].pkg, o.store, { logo: { fileName: 'x.png', data: logo, rights: null } })).zip);
    assert.equal(z.file('design/brand-content.json'), null);
    assert.ok(!Object.keys(z.files).some((n) => n.startsWith('design/brand/')));
    const finding = o.events.filter((e) => e.type === 'finding.posted' && e.participant === 'Visual Researcher').map((e) => JSON.stringify(e.payload)).join(' ');
    assert.doesNotMatch(finding, /Approved brand content/);
  });

  it('approved photographs but NO logo: the brand block says so, the creatives use the business name in the logo position (the no-logo fallback)', async () => {
    const brand = { logo: null, approvedPhotos: 2, approvedAt: '2026-11-03T10:00:00.000Z' };
    const o = await run({ images: await Promise.all([1, 2].map((n) => libraryImage(n))), config: { brand }, runId: 'noai-nologo' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = hybridOf(o);
    assert.equal(h.brand?.logo, null);
    assert.equal(h.brand?.withLogo, 0);
    assert.deepEqual(h.brand?.omitted, []);
    assert.equal(h.counts.templates.rendered, 20, 'the campaign is complete without a logo');
    for (const c of h.creatives) assert.equal(c.logo, undefined);
  });

  it('is refused before anything is sent when the run asks for an image model, image requests, an image generator or an image continuation', async () => {
    for (const config of [{ imageModel: 'gpt-image-1.5' }, { maxImages: 2 }, { maxRegenerations: 1 }]) {
      const fake = await new FakeOpenAI().start();
      servers.push(fake);
      await assert.rejects(
        () =>
          new MozaikCampaignRuntime().startRun({
            runId: 'noai-refused',
            projectId: 'p',
            userId: 'u',
            mode: 'creative_production',
            manifest: { productName: 'X' },
            credentials: { provider: 'openai', apiKey: KEY },
            creative: { campaignId: 'c', projectId: 'p', f1: chain.f1, f2: chain.f2, f3: chain.f3, input: input(), model: 'gpt-test-mini', hybrid: { settings: mergeHybrid({ ...NO_AI_PRESET, design: design() }), brandImages: [] }, assets: new InMemoryAssetStore(), baseUrl: fake.url, now: new Date(), ...config },
            onEvent: () => undefined,
            onCampaign: async () => undefined,
          }),
        /NO AI HYBRID never generates images/,
      );
      assert.equal(fake.requests.length, 0, 'nothing was sent to the provider');
    }
  });

  it('the package carries the proof, and the archive holds only authorized files: originals only where the license allows, rights and credits always', async () => {
    const own = await libraryImage(1, { id: 'own-1', name: 'my photo.jpg' });
    const stockRow = await libraryImage(2, { id: 'stock-1', name: 'pixabay-77.jpg', via: 'library', rights: stockRights(pixabayVerdict({ tags: ['ocean'], title: 'x', user: 'Ann Maker', pageUrl: '' }), { userApproved: true }) });
    stockRow.library!.pageUrl = 'https://pixabay.com/photos/77/';
    const o = await run({ images: [own, stockRow], runId: 'noai-zip' });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const pkg = o.packages[0].pkg;
    const { zip, manifest } = await buildCampaignZip(pkg, o.store, { strategy: { creativeBrief: { note: 'fixture' } }, sources: [{ id: 'own-1', fileName: 'my photo.jpg', data: own.data }, { id: 'stock-1', fileName: 'pixabay-77.jpg', data: stockRow.data }] });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files);
    assert.ok(names.some((n) => n.startsWith('images/approved-sources/') && n.includes('my-photo')), 'the user\'s own picture is included');
    assert.ok(!names.some((n) => n.includes('pixabay-77') || n.includes('stock-1')), 'a Pixabay original is NOT handed on, only the advertisements made from it');
    for (const want of ['campaign.json', 'manifest.json', 'CREDITS.txt', 'usage/sources.json', 'usage/rights.json', 'usage/README.txt', 'design/campaign-design.json']) assert.ok(names.includes(want), want);
    assert.ok(names.some((n) => n.startsWith('images/templates/')) && names.some((n) => n.startsWith('layouts/')) && names.some((n) => n.startsWith('copy/')) && names.some((n) => n.startsWith('strategy/')));
    assert.equal(names.filter((n) => n.startsWith('images/templates/')).length, 20);
    const credits = await z.file('CREDITS.txt')!.async('string');
    assert.match(credits, /Image by Ann Maker on Pixabay/);
    const sources = JSON.parse(await z.file('usage/sources.json')!.async('string')) as { sources: { id: string; originalIncluded: string | null; originalNotIncludedBecause: string | null }[] };
    assert.equal(sources.sources.find((s) => s.id === 'stock-1')!.originalIncluded, null);
    assert.match(sources.sources.find((s) => s.id === 'stock-1')!.originalNotIncludedBecause ?? '', /does not allow handing the unaltered file on/);
    assert.ok(sources.sources.find((s) => s.id === 'own-1')!.originalIncluded);
    const rights = JSON.parse(await z.file('usage/rights.json')!.async('string')) as { aiImagesGenerated: number; creatives: { slotId: string; collection: string; sourceImageIds: string[]; rightsSummary: string }[] };
    assert.equal(rights.aiImagesGenerated, 0);
    assert.equal(rights.creatives.length, 20);
    assert.ok(rights.creatives.every((c) => c.collection === 'premium_editorial' && c.rightsSummary.length > 0));
    assert.equal((manifest.hybrid as { productionMode: string }).productionMode, 'no_ai_hybrid');
    // a shareable archive carries no reference-only content
    assert.ok(!JSON.stringify(manifest).includes('REFERENCE_ONLY'));
  });
});
