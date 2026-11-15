import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { applyPaletteOption, editPaletteRole, newDesign } from '../collections/design';
import { suggestPalette } from '../brand/suggest';
import { InMemoryAssetStore } from './assets';
import type { CreativeInput } from './context';
import { buildCampaignZip } from './export';
import { CreativeRenderSpec, applyCreativeRevision, editDiagnostics, editorFields, renderEdit, renderSpec, restoreOriginalRevision, sha256Of } from './editor';
import type { CampaignPackage } from './schemas';
import type { RecordedEvent } from '../factory/state';
import { analyzeImage } from '../imagery/analysis';
import { attestRights, candidateRights, uploadRights } from '../imagery/rights';
import { capOutputTokens } from '../ai/pricing';
import { defaultCopy, defaultCopyRevision } from '../testing/fake-creative';
import type { CopyOutput } from './schemas';
import { mergeHybrid } from '../hybrid/settings';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { BrandImage } from '../runtime/programs/f4/env';
import type { CreativeReportMeta, CreativeRunConfig } from '../runtime/programs/f4-program';
import { buildChain, type Chain } from '../testing/chain';
import { FakeOpenAI, type FakeOpenAIOptions } from '../testing/fake-openai';

// V4 F4 with the real Mozaik runtime: the four creative agents, a fake text API over real HTTP, no image model anywhere. Nothing is billed.

const KEY = 'sk-test-V4F41234567890abcdefghijklmn';

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  packages: { pkg: CampaignPackage; meta: CreativeReportMeta }[];
  store: InMemoryAssetStore;
  fake: FakeOpenAI;
}

async function photo(seed: number): Promise<BrandImage> {
  const hue = (seed * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="100%" height="100%" fill="hsl(${hue},55%,40%)"/><circle cx="${400 + seed * 90}" cy="500" r="260" fill="hsl(${(hue + 120) % 360},60%,60%)"/></svg>`;
  const data = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  return { id: `asset-${seed}`, name: `photo-${seed}.jpg`, data, library: { rights: uploadRights(), analysis: await analyzeImage(data), text: 'diving school reef ocean', width: 1600, height: 1200, pageUrl: null, via: 'library' } };
}

describe('F4 Creative Production (V4: one workflow, four agents, no AI images)', () => {
  let chain: Chain;
  const servers: { close(): Promise<void> }[] = [];
  before(async () => {
    chain = await buildChain();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const input = (): CreativeInput => ({ projectName: 'Blue Reef Diving School', language: 'en', websiteUrl: null, channels: ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'], concepts: 3 });

  async function run(o: { images?: BrandImage[]; config?: Partial<CreativeRunConfig>; openai?: FakeOpenAIOptions; design?: ReturnType<typeof newDesign> } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const design = o.design ?? { ...editPaletteRole(newDesign('premium_editorial'), 'primary', '#0b6e4f'), confirmed: true, confirmedAt: '2026-11-03T10:00:00.000Z' };
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: 'v4-f4-1',
      projectId: 'project-1',
      userId: 'user-1',
      mode: 'creative_production',
      manifest: { productName: 'Blue Reef Diving School' },
      credentials: { provider: 'openai', apiKey: KEY },
      creative: {
        campaignId: 'campaign-1',
        projectId: 'project-1',
        f1: chain.f1,
        f3: chain.f3,
        input: input(),
        model: 'gpt-test-mini',
        design: mergeHybrid({ design }),
        brandImages: o.images ?? [],
        assets: store,
        maxModelCalls: 12,
        visionReviews: 0,
        agentTimeoutMs: 8000,
        reviewTimeoutMs: 5000,
        repairTimeoutMs: 6000,
        timeoutMs: 90_000,
        retryBaseDelayMs: 5,
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

  it('PALETTE OPTION + MOBILE DENSITY: the palette option the user picked is stored, used by every creative and exported; TikTok covers show no empty cards or placeholder pictures', async () => {
    const s = suggestPalette({ collectionId: 'modern_corporate', readings: [] });
    const picked = applyPaletteOption(newDesign('modern_corporate'), s, { id: 'contrast', all: true });
    const o = await run({ design: { ...picked, confirmed: true, confirmedAt: '2026-11-14T10:00:00.000Z' } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const { pkg } = o.packages[0];
    const used = pkg.hybrid!.settings.design!;
    assert.equal(used.paletteVariant, 'contrast');
    assert.deepEqual(used.palette, s.variants.find((v) => v.id === 'contrast')!.palette);
    assert.equal(pkg.hybrid!.direction!.colors.primary, used.palette.primary, 'the creatives are drawn with the chosen palette');
    const { zip } = await buildCampaignZip(pkg, o.store, {});
    const brand = JSON.parse(await (await JSZip.loadAsync(zip)).file('campaign/brand/brand.json')!.async('string'));
    assert.equal(brand.paletteOption, 'contrast');
    assert.deepEqual(brand.palette, used.palette);
    const tiktok = pkg.hybrid!.creatives.filter((c) => c.channel === 'tiktok' && c.status === 'rendered');
    assert.ok(tiktok.length > 0);
    for (const c of tiktok) for (const id of ['empty_structure', 'placeholder_picture']) assert.notEqual(c.design?.checks.find((x) => x.id === id)?.status, 'fail', `${c.slotId} (${c.templateId}): ${id}`);
    // CONTENT-AWARE SPACING runs on every rendered creative (deterministic, inside the existing repair loop): billboards keep their space
    const rendered = pkg.hybrid!.creatives.filter((c) => c.status === 'rendered');
    for (const c of rendered) assert.ok(c.design?.checks.some((x) => x.id === 'content_spacing'), `${c.slotId}: no content_spacing check`);
    for (const c of rendered.filter((x) => x.format === 'billboard')) assert.equal(c.design?.checks.find((x) => x.id === 'content_spacing')?.status, 'pass');
    assert.equal(o.fake.imageCalls().length, 0);
    assert.ok(o.fake.calls().every((r) => r.agent === 'copywriter' || r.agent === 'creviewer'), 'the spacing adds no model request');
  });

  it('CREATIVE EDITOR: every new creative stores a render specification that reproduces it exactly; an edit re-renders it locally and the ZIP exports the edited file', async () => {
    const images = await Promise.all([1, 2, 3, 4].map(photo));
    const o = await run({ images });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    let { pkg } = o.packages[0];
    const rendered = pkg.hybrid!.creatives.filter((c) => c.status === 'rendered' && c.assetId);
    assert.ok(rendered.length > 5);
    const byId = new Map(images.map((i) => [i.id, i.data]));
    const callsBefore = o.fake.calls().length;
    // the specification of EVERY rendered creative is stored with its asset and reproduces the delivered PNG byte for byte
    for (const c of rendered) {
      const raw = o.store.specs.get(c.assetId!);
      assert.ok(raw, `${c.slotId}: no render specification stored`);
      const spec = CreativeRenderSpec.parse(raw);
      assert.equal(spec.slotId, c.slotId);
      assert.equal(spec.templateId, c.templateId);
      const again = await renderSpec(spec, { hero: spec.hero ? byId.get(spec.hero.id) : null, secondary: spec.secondary ? byId.get(spec.secondary.id) : null });
      assert.ok(again.ok);
      if (again.ok) assert.equal(sha256Of(again.png), sha256Of(await o.store.load(c.assetId!)), `${c.slotId} (${c.templateId}:${spec.variant}) is not reproduced exactly`);
      if (spec.hero) assert.equal(spec.hero.sha256, sha256Of(byId.get(spec.hero.id)!), 'pictures are referenced by id + checksum, never copied');
      assert.ok(!JSON.stringify(spec).includes('base64'), 'no picture bytes inside the specification');
    }
    // edit the headline of one Instagram creative: same palette, same pictures, same composition; the ZIP carries exactly the saved bytes
    const target = rendered.find((c) => c.channel === 'instagram') ?? rendered[0];
    const spec = CreativeRenderSpec.parse(o.store.specs.get(target.assetId!));
    const fields = editorFields(spec);
    assert.ok(fields.some((f) => f.id === 'headline'));
    assert.ok(!fields.some((f) => (f.id as string) === 'brand'), 'the business name is protected');
    const inputs = { hero: spec.hero ? byId.get(spec.hero.id) : null, secondary: spec.secondary ? byId.get(spec.secondary.id) : null };
    const edited = await renderEdit(spec, { headline: 'Dive with us this summer' }, inputs);
    assert.ok(edited.ok, JSON.stringify(!edited.ok && edited.errors));
    if (!edited.ok) return;
    assert.equal(edited.spec.palette.join(), spec.palette.join());
    assert.deepEqual(edited.spec.hero, spec.hero);
    assert.equal(edited.spec.content.headline, 'Dive with us this summer');
    const asset = await o.store.save({ ...o.store.records.get(target.assetId!)!, version: 2, parentAssetId: target.assetId, data: edited.png, renderSpec: edited.spec });
    pkg = applyCreativeRevision(pkg, { slotId: target.slotId, previousAssetId: target.assetId!, asset, design: editDiagnostics(edited, target.design), flags: edited.flags, fields: { headline: 'Dive with us this summer' }, original: spec.original, at: '2026-11-15T10:00:00.000Z' });
    const zip1 = await JSZip.loadAsync((await buildCampaignZip(pkg, o.store, {})).zip);
    const manifest = JSON.parse(await zip1.file('campaign/manifest.json')!.async('string'));
    const entry = manifest.files.find((f: { assetId?: string }) => f.assetId === asset.id);
    assert.ok(entry, 'the edited image is in the ZIP');
    const bytes = await zip1.file(entry.path)!.async('nodebuffer');
    assert.equal(sha256Of(bytes), sha256Of(edited.png), 'the ZIP holds the very bytes of the preview');
    assert.equal(entry.sha256, sha256Of(edited.png));
    assert.ok(!manifest.files.some((f: { assetId?: string }) => f.assetId === target.assetId), 'the old image is not exported');
    // unrelated creatives keep their files
    for (const c of rendered.filter((x) => x.slotId !== target.slotId)) assert.ok(manifest.files.some((f: { assetId?: string }) => f.assetId === c.assetId), `${c.slotId} lost its file`);
    const item = pkg.deliverables!.items.find((i) => i.id === target.slotId)!;
    assert.equal(item.assetId, asset.id);
    const texts = await Promise.all(Object.keys(zip1.files).filter((p) => p.endsWith('.txt')).map((p) => zip1.file(p)!.async('string')));
    const copy = texts.find((t) => t.includes('edited by the owner'));
    assert.ok(copy, 'a copy file says the visual was edited');
    assert.match(copy!, /Headline: Dive with us this summer/);
    assert.match(await zip1.file('campaign/README.md')!.async('string'), /Edited by the owner/);
    // restore: the original file again, exported again
    pkg = restoreOriginalRevision(pkg, { slotId: target.slotId, previousAssetId: asset.id, original: o.store.records.get(target.assetId!)!, at: '2026-11-15T10:05:00.000Z' });
    const zip2 = await JSZip.loadAsync((await buildCampaignZip(pkg, o.store, {})).zip);
    const m2 = JSON.parse(await zip2.file('campaign/manifest.json')!.async('string'));
    assert.ok(m2.files.some((f: { assetId?: string }) => f.assetId === target.assetId) && !m2.files.some((f: { assetId?: string }) => f.assetId === asset.id));
    assert.equal(o.fake.calls().length, callsBefore, 'editing makes no model request');
    assert.equal(o.fake.imageCalls().length, 0);
  });

  it('one campaign: posts for all five platforms, ads, TWO billboards and TWO flyers, drawn from the approved pictures, with zero image requests', async () => {
    const o = await run({ images: await Promise.all([1, 2, 3, 4, 5, 6].map(photo)) });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const { pkg, meta } = o.packages[0];
    assert.equal(o.fake.imageCalls().length, 0, 'no image request reached the provider');
    // adaptive composition is local: every model request comes from the Content Writer or the Quality Reviewer, none from the designer
    assert.ok(o.fake.calls().length > 0 && o.fake.calls().every((r) => r.agent === 'copywriter' || r.agent === 'creviewer'), [...new Set(o.fake.calls().map((r) => r.agent))].join(','));
    assert.equal(pkg.schemaVersion, 2);
    assert.equal(pkg.f2ReportId, null, 'no marketing audit is part of a V4 campaign');
    assert.equal(pkg.landingContent, null, 'no landing page');
    assert.equal(pkg.cost?.imageUsd, 0);
    assert.deepEqual(meta.plan.activated.map((a) => a.agent).sort(), ['Content Writer', 'Creative Designer', 'Quality Reviewer', 'Visual Researcher']);
    const posts = pkg.copyVariants.filter((v) => v.placement === 'social_post');
    for (const p of ['x', 'tiktok', 'facebook', 'instagram', 'linkedin']) assert.equal(posts.filter((v) => v.channel === p).length, 3, `${p}: one post per concept`);
    assert.ok(posts.filter((v) => v.channel === 'tiktok').every((v) => v.videoScript), 'TikTok posts carry a video script');
    const d = pkg.deliverables!;
    assert.ok(d.counts.delivered > 0);
    // print: FOUR billboards (2 designs x 2 texts) and two flyers, delivered; the two flyers are different layouts
    const flyers = d.items.filter((i) => i.kind === 'flyer');
    assert.equal(flyers.length, 2, 'flyer: two planned');
    assert.ok(flyers.every((i) => i.status === 'delivered'), `flyer: both delivered (${flyers.map((i) => i.reason).join(' | ')})`);
    const ftpl = flyers.map((i) => pkg.hybrid!.creatives.find((c) => c.assetId === i.assetId)!.templateId);
    assert.notEqual(ftpl[0], ftpl[1], `flyer: the two use different layouts (${ftpl.join(', ')})`);
    // the advertising variation matrix: billboard, web banner and display ad as D1/D2 x T1/T2
    for (const k of ['billboard', 'web_ad', 'display_ad'] as const) {
      const items = d.items.filter((i) => i.kind === k);
      if (!items.length) {
        // the collection cannot draw this format: reported as not planned, never faked
        assert.ok(d.notPlanned.some((n) => n.kind === k), `${k}: neither planned nor reported`);
        continue;
      }
      assert.equal(items.length, 4, `${k}: 2 designs x 2 texts planned`);
      assert.deepEqual(items.map((i) => `D${i.matrix!.design}T${i.matrix!.copy}`).sort(), ['D1T1', 'D1T2', 'D2T1', 'D2T2']);
      assert.ok(items.every((i) => i.status === 'delivered'), `${k}: all four delivered (${items.map((i) => i.reason).join(' | ')})`);
      const tplOf = (dn: number, cn: number) => pkg.hybrid!.creatives.find((c) => c.assetId === items.find((i) => i.matrix!.design === dn && i.matrix!.copy === cn)!.assetId)!;
      const [d1t1, d1t2, d2t1, d2t2] = [tplOf(1, 1), tplOf(1, 2), tplOf(2, 1), tplOf(2, 2)];
      // two DIFFERENT designs (another template, never the first one mirrored), each carrying both texts when the collection allows it
      assert.notEqual(d1t1.templateId, d2t1.templateId, `${k}: D1 and D2 are different templates`);
      if (d1t2.design?.matrix?.shared) assert.equal(d1t2.templateId, d1t1.templateId, `${k}: D1 carries T2 with the same design`);
      if (d2t2.design?.matrix?.shared) assert.equal(d2t2.templateId, d2t1.templateId);
    }
    assert.equal(d.counts.planned + d.notPlanned.length, 15 + 4 * 3 + 2, 'social 15 + three matrices of 4 + two flyers (planned or reported)');
    // every rendered creative went through the design preflight and records its checks, repairs and the templates tried
    const rendered = pkg.hybrid!.creatives.filter((c) => c.status === 'rendered');
    assert.ok(rendered.length > 0);
    for (const c of rendered) {
      assert.ok(c.design, `${c.slotId}: design diagnostics recorded`);
      const ids = c.design!.checks.map((x) => x.id);
      for (const id of ['face_occlusion', 'subject_visibility', 'logo_visibility', 'text_safe_area', 'text_fit', 'headline_readability', 'final_asset_purity', 'duplicate_layout']) assert.ok(ids.includes(id), `${c.slotId}: ${id} checked`);
      assert.ok(c.design!.renders >= 1 && c.design!.templatesTried.some((t) => t.split(':')[0] === c.templateId));
      // the adaptive composition is recorded: template, variant, why, and an honest quality-gate status
      assert.equal(c.design!.composition?.templateId, c.templateId);
      assert.ok(c.design!.composition!.considered >= 1 && c.design!.composition!.reasons.length > 0);
      assert.ok(['passed', 'warnings', 'unresolved'].includes(c.design!.status!));
      assert.ok(!c.design!.checks.some((x) => x.id === 'final_asset_purity' && x.status === 'fail'), `${c.slotId}: no editor elements`);
    }
    for (const i of d.items) {
      if (i.status === 'delivered') assert.ok(pkg.imageAssets.some((a) => a.id === i.assetId && a.source === 'template_render'));
      else assert.ok(i.reason, 'a missing deliverable says why');
    }
    assert.ok(d.counts.withPicture > 0, 'approved pictures reach the templates');
    // PHOTO FIRST + TEXT DENSITY (Giardino 2026-11-14): a TikTok cover shows the approved photograph and carries only its headline and button
    const tiktok = d.items.filter((i) => i.channel === 'tiktok' && i.status === 'delivered');
    assert.ok(tiktok.length > 0 && tiktok.every((i) => i.withPicture), `TikTok covers are photo-first: ${tiktok.map((i) => `${i.id}=${i.withPicture}`).join(', ')}`);
    for (const it of pkg.hybrid!.selection!.items.filter((x) => x.channel === 'tiktok')) {
      assert.equal(it.content.support, null, `${it.slotId}: no supporting line on a TikTok cover`);
      assert.equal(it.content.eyebrow, null, `${it.slotId}: no eyebrow on a TikTok cover`);
    }
    assert.ok(!pkg.imageAssets.some((a) => a.source === 'ai_image'));
    // the ONE download
    const { zip, manifest } = await buildCampaignZip(pkg, o.store, { strategy: chain.f3.report });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files);
    assert.ok(names.includes('campaign/README.md'));
    assert.ok(names.includes('campaign/strategy/campaign-strategy.md'));
    assert.ok(names.some((n) => n.startsWith('campaign/social/x/') && n.endsWith('.png')));
    assert.ok(names.some((n) => n.startsWith('campaign/social/tiktok/') && n.endsWith('-video-script.md')));
    assert.ok(names.some((n) => n.startsWith('campaign/social/instagram/') && n.endsWith('-post.txt')));
    assert.ok(names.includes('campaign/sources/rights.json'));
    assert.ok(names.includes('campaign/brand/brand.json'));
    assert.ok(names.includes('campaign/manifest.json') && names.includes('campaign/campaign.json'));
    // advertising and print: every delivered ad/print deliverable is a real file in its V4 folder
    const delivered = (k: string) => d.items.some((i) => i.kind === k && i.status === 'delivered');
    if (delivered('billboard')) assert.ok(names.some((n) => n.startsWith('campaign/print/billboards/') && n.endsWith('.png')));
    if (delivered('flyer')) assert.ok(names.some((n) => n.startsWith('campaign/print/flyers/') && n.endsWith('.png')));
    if (delivered('web_ad')) assert.ok(names.some((n) => n.startsWith('campaign/ads/web/') && n.endsWith('.png')));
    if (delivered('display_ad')) assert.ok(names.some((n) => n.startsWith('campaign/ads/display/') && n.endsWith('.png')));
    assert.ok(names.every((n) => n.startsWith('campaign/')), 'the V4 layout has one root folder');
    assert.ok(!names.some((n) => /landing|seo|geo/i.test(n)), 'no landing page, SEO or GEO output in a V4 ZIP');
    assert.equal(names.filter((n) => n.startsWith('campaign/print/billboards/') && n.endsWith('.png')).length, 4, 'four billboards: 2 designs x 2 texts, each its own file');
    assert.equal(names.filter((n) => n.startsWith('campaign/print/flyers/') && n.endsWith('.png')).length, 2, 'two flyer designs');
    // the design diagnostics travel with the campaign
    const checks = JSON.parse(await z.file('campaign/review/design-checks.json')!.async('string'));
    assert.equal(checks.creatives.length, rendered.length);
    assert.ok(checks.creatives.every((c: { file: string; checks: unknown[] }) => names.includes(`campaign/${c.file}`) && c.checks.length > 0));
    assert.ok(checks.creatives.every((c: { status: string; composition: { templateId: string; variant: string } }) => ['passed', 'warnings', 'unresolved'].includes(c.status) && c.composition.templateId && c.composition.variant));
    assert.equal(checks.summary.passed + checks.summary.warnings + checks.summary.unresolved, checks.creatives.length);
    // ZIP integrity: every file the manifest lists is in the archive with exactly the recorded bytes and hash
    const { createHash } = await import('node:crypto');
    for (const f of manifest.files) {
      const entry = z.file(f.path);
      assert.ok(entry, `${f.path} is in the archive`);
      const bytes = await entry!.async('nodebuffer');
      assert.equal(bytes.length, f.bytes, f.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256, f.path);
    }
    assert.equal(manifest.assetsMissing.length, 0);
    for (const f of manifest.files) assert.ok(f.bytes > 0, `${f.path} is not an empty placeholder`);
  });

  it('GET CONTENT: the approved logo and photographs reach the creatives, the Visual Researcher records them and the ZIP carries the logo', async () => {
    const logo = await sharp({ create: { width: 640, height: 220, channels: 4, background: '#0b3d91' } }).png().toBuffer();
    const brand = { logo: { approved: true as const, assetId: 'asset-logo', source: 'website', fileName: 'site-logo.png', width: 640, height: 220 }, approvedPhotos: 3, approvedAt: '2026-11-03T10:00:00.000Z' };
    const images = await Promise.all([1, 2, 3].map(photo));
    const o = await run({ images, config: { logo, brand } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.fake.imageCalls().length, 0);
    const { pkg } = o.packages[0];
    const h = pkg.hybrid!;
    assert.equal(h.brand?.logo?.assetId, 'asset-logo');
    assert.equal(h.brand?.approvedPhotos, 3);
    assert.ok(h.brand!.withLogo > 0, 'the approved logo is drawn on creatives');
    for (const c of h.creatives.filter((x) => x.status === 'rendered')) assert.ok(c.logo, `${c.slotId}: the logo outcome is recorded`);
    const approved = new Set(images.map((i) => i.id));
    const used = h.creatives.flatMap((c) => c.sourceAssetIds ?? []).map((x) => x.replace('brand:', ''));
    assert.ok(used.length > 0, 'approved photographs are used');
    assert.ok(used.every((x) => approved.has(x)), 'only approved pictures are drawn');
    const finding = o.events.filter((e) => e.type === 'finding.posted' && e.participant === 'Visual Researcher').map((e) => JSON.stringify(e.payload)).join(' ');
    assert.match(finding, /Approved brand content: the official logo and 3 approved photograph/);
    const z = await JSZip.loadAsync((await buildCampaignZip(pkg, o.store, { logo: { fileName: 'site-logo.png', data: logo, rights: 'Rights confirmed by the project owner' } })).zip);
    assert.ok(Object.keys(z.files).some((n) => n.startsWith('campaign/brand/logo-')));
  });

  it('IMAGE LIBRARY: at most 10 pictures per campaign, photographs before brand graphics, and the creatives spread over the library', async () => {
    // twelve clearly different approved pictures (no two are near-duplicates); two of them are brand graphics (share cards), not photographs
    const varied = async (seed: number): Promise<BrandImage> => {
      let x = seed * 7919;
      const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647);
      const rects = Array.from({ length: 6 }, () => `<rect x="${Math.round(rnd() * 1400)}" y="${Math.round(rnd() * 1000)}" width="${200 + Math.round(rnd() * 600)}" height="${150 + Math.round(rnd() * 500)}" fill="hsl(${Math.round(rnd() * 360)},60%,${30 + Math.round(rnd() * 40)}%)"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="100%" height="100%" fill="hsl(${(seed * 47) % 360},40%,${25 + (seed % 5) * 10}%)"/>${rects}</svg>`;
      const data = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
      return { id: `asset-v${seed}`, name: `picture-${seed}.jpg`, data, library: { rights: uploadRights(), analysis: await analyzeImage(data), text: 'diving school reef ocean', width: 1600, height: 1200, pageUrl: null, via: 'library', category: seed <= 2 ? 'brand_graphic' : 'people' } };
    };
    const images = await Promise.all(Array.from({ length: 12 }, (_, i) => varied(i + 1)));
    const o = await run({ images });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const h = o.packages[0].pkg.hybrid!;
    const lib = h.imagery!.library;
    assert.ok(lib.length <= 10, `the campaign library holds ${lib.length}`);
    assert.equal(lib.length, 10, 'twelve distinct approved pictures: the best ten form the library');
    const graphics = new Set(['asset-v1', 'asset-v2']);
    const firstGraphic = lib.findIndex((l) => graphics.has(l.id));
    assert.ok(firstGraphic === -1 || lib.slice(firstGraphic).every((l) => graphics.has(l.id)), 'brand graphics come after every photograph');
    assert.ok(h.imagery!.notes.some((n) => /12 approved pictures exist; the 10 best/.test(n)), h.imagery!.notes.join(' | '));
    const used = new Set(h.creatives.filter((c) => c.status === 'rendered').flatMap((c) => c.sourceAssetIds ?? []).map((x) => x.replace('brand:', '')));
    assert.ok(used.size >= 4, `the creatives use ${used.size} different pictures, not one picture everywhere`);
    assert.ok([...used].every((id) => lib.some((l) => l.id === id)), 'only pictures of the campaign library are drawn');
    assert.ok(!used.has('asset-v1') && !used.has('asset-v2'), 'a brand graphic is never drawn as a creative picture (no text over text, no second logo)');
    assert.ok(lib.filter((l) => graphics.has(l.id)).every((l) => l.usedBySlots.length === 0 && /graphic/.test(l.assetKind ?? '')));
  });

  // ---- MVP creative quality: the defects of the 23 reviewed creatives, end to end (fake text API, no image model, nothing billed) ----
  const longCta = (cta: string, ctaShort: string) => (req: { agent: string; userText: string }) => {
    if (req.agent !== 'copywriter' || req.userText.includes('Revise ONLY the listed copy')) return undefined;
    const out: CopyOutput = defaultCopy(req.userText);
    for (const x of [...out.posts, ...out.ads, ...out.print]) Object.assign(x, { cta, ctaShort });
    return { text: JSON.stringify(out) };
  };
  const site = { ...input(), websiteUrl: 'https://acme-consult.example' };
  const shield = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M256 20 L470 110 L440 380 L256 492 L72 380 L42 110 Z" fill="#0b6e4f"/></svg>')).png().toBuffer();

  it('MVP QUALITY: a long call to action is never cut; print has no buttons and names the business; concepts do not repeat inside a channel', async () => {
    const cta = 'Start the free Management and Risk Check';
    const o = await run({ images: await Promise.all([1, 2, 3, 4, 5, 6].map(photo)), config: { input: site, logo: await shield() }, openai: { reply: longCta(cta, 'Start the free check') } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    assert.equal(o.fake.imageCalls().length, 0);
    const { pkg } = o.packages[0];
    const h = pkg.hybrid!;
    const rendered = h.creatives.filter((c) => c.status === 'rendered');
    const current = pkg.imageAssets.filter((a) => a.status !== 'superseded');
    // 1) no essential text was cut in any final asset; every shortening is one of the approved wordings
    assert.ok(current.every((a) => !a.flags.some((f) => f.startsWith('text_trimmed'))), current.filter((a) => a.flags.some((f) => f.startsWith('text_trimmed'))).map((a) => `${a.id}: ${a.flags.join(',')}`).join(' | '));
    const allowed = new Set(['Start the free check', 'Start the free Risk Check', 'Start the Management and Risk Check', 'Start the Risk Check', 'Start the Check']);
    for (const c of rendered) for (const s of c.design?.shortened ?? []) {
      assert.ok(!/\u2026|\.\.\.$/.test(s.to), `${c.slotId}: ${s.to}`);
      if (s.slot === 'cta' && s.from === cta) assert.ok(allowed.has(s.to), `${c.slotId}: "${s.to}" is not an approved shorter wording`);
    }
    // 2) print: no button on billboards or flyers, the business named in full next to the shield, a written next step with the verified address
    for (const c of rendered.filter((x) => /billboard|flyer/.test(x.slotId))) {
      const st = (id: string) => c.design!.checks.find((x) => x.id === id)?.status;
      assert.equal(st('media_button'), 'pass', `${c.slotId}: no button in print`);
      if (/billboard/.test(c.slotId)) assert.equal(st('brand_identity'), 'pass', `${c.slotId}: the business is named`);
      if (/flyer/.test(c.slotId)) assert.equal(st('flyer_next_step'), 'pass', `${c.slotId}: a next step`);
    }
    // 3) creative concepts: recorded per creative; inside ONE channel no template twice unless the review reports it; across channels reuse is allowed
    assert.ok(rendered.every((c) => c.design?.concept?.key && c.design.concept.channel));
    const byChannel = new Map<string, string[]>();
    for (const c of rendered) byChannel.set(c.design!.concept!.channel, [...(byChannel.get(c.design!.concept!.channel) ?? []), c.templateId]);
    const repeats = (h.quality?.issues ?? []).filter((i) => i.kind === 'repeated_concept');
    for (const [ch, ids] of byChannel) {
      if (ch.startsWith('social:') && new Set(ids).size < ids.length) assert.ok(repeats.length > 0, `${ch} repeats a design and the review must say so`);
    }
    const social = rendered.filter((c) => c.design!.concept!.channel.startsWith('social:'));
    const crossReuse = social.some((a) => social.some((b) => b.templateId === a.templateId && b.design!.concept!.channel !== a.design!.concept!.channel));
    if (crossReuse) assert.ok(!repeats.some((r) => social.some((s) => s.slotId === r.slotId && !social.some((t) => t !== s && t.templateId === s.templateId && t.design!.concept!.channel === s.design!.concept!.channel))), 'reuse across channels is never reported as a repeat');
    // 4) quality states: produced is not "ready"; the README and design-checks.json say how many are ready to publish
    const d = pkg.deliverables!;
    assert.ok(d.items.filter((i) => i.status === 'delivered').every((i) => i.quality && typeof i.publishReady === 'boolean'));
    assert.ok(d.items.filter((i) => i.quality === 'unresolved').every((i) => i.publishReady === false && (i.blockers ?? []).length > 0));
    assert.equal(d.counts.publishReady! + d.counts.needsReview!, d.counts.delivered);
    const z = await JSZip.loadAsync((await buildCampaignZip(pkg, o.store)).zip);
    const readme = await z.file('campaign/README.md')!.async('string');
    assert.match(readme, /Ready to publish: \d+ of \d+/);
    if (d.items.some((i) => i.matrix)) assert.match(readme, /Advertising variation matrix/);
    const checks = JSON.parse(await z.file('campaign/review/design-checks.json')!.async('string'));
    assert.equal(checks.summary.publishReady, d.counts.publishReady);
  });

  it('REPAIR LOOP: findings are routed to the part that can fix them, only the affected creatives are rendered again, retries are bounded and nothing cut is approved', async () => {
    // one word of 70 letters: no drop-word shortening exists; the adaptive layout must avoid cutting it (or the review routes it to the writer)
    const word = 'Unternehmenssteuerungsrisikocheckanfrageformularbestaetigungsverfahren';
    const o = await run({ images: await Promise.all([1, 2, 3].map(photo)), openai: { reply: longCta(word, '') } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const { pkg } = o.packages[0];
    const current = pkg.imageAssets.filter((a) => a.status !== 'superseded');
    // nothing cut is ever presented as ready: a creative that still has cut text is not publish-ready
    for (const a of current.filter((x) => x.flags.some((f) => f.startsWith('text_trimmed')))) {
      const item = pkg.deliverables!.items.find((i) => i.assetId === a.id);
      if (item) assert.equal(item.publishReady, false, `${item.id}: cut text is never ready to publish`);
    }
    // a cut call to action / headline goes to the Content Writer as well (ONE revision call for the round)
    for (const f of pkg.reviewFindings.filter((x) => x.kind === 'text_overflow' && /call to action|headline/.test(x.finding) && x.source === 'deterministic')) assert.ok(pkg.revisions.some((r) => r.findingId === f.id && r.operation === 'revise_copy'), `${f.id} was routed to the writer`);
    assert.ok(o.fake.calls('copywriter').filter((r) => r.userText.includes('Revise ONLY the listed copy')).length <= 1);
    // targeted: only the creatives named by findings were rendered again (earlier versions kept), never the whole campaign
    const superseded = pkg.imageAssets.filter((a) => a.status === 'superseded');
    const layoutFindings = new Set(pkg.revisions.filter((r) => r.operation === 'rerender_layout').map((r) => r.findingId));
    assert.ok(superseded.length <= current.length, 'not every creative was redone');
    if (layoutFindings.size) assert.ok(superseded.length > 0, 'a layout finding led to a new version');
    // bounded: at most maxRepairRounds (1) repair round, then the result is reported honestly
    assert.ok(Math.max(0, ...pkg.reviewFindings.map((f) => f.round)) <= 2);
    assert.ok(['approved', 'approved_with_notes', 'unresolved'].includes(pkg.approval.status));
    if (pkg.reviewFindings.some((f) => f.status === 'unresolved' && (f.severity === 'major' || f.severity === 'blocker'))) assert.equal(pkg.approval.status, 'unresolved');
  });

  it('PROVENANCE: website pictures keep their page, address and rights basis from the library to the exported creative', async () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const images = await Promise.all([1, 2, 3, 4].map(async (n) => {
      const b = await photo(n);
      return { ...b, library: { ...b.library!, rights: attestRights(candidateRights('website', { firstParty: true }), { at }), pageUrl: 'https://acme-consult.example/en/team', originalUrl: `https://acme-consult.example/_next/image?url=%2Fmedia%2Fteam-${n}.webp&w=3840`, category: 'team' } };
    }));
    const o = await run({ images });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const { pkg } = o.packages[0];
    const lib = pkg.hybrid!.imagery!.library;
    assert.ok(lib.length > 0 && lib.every((l) => l.source === 'website' && l.pageUrl && l.originalUrl?.startsWith('https://acme-consult.example/') && l.verification));
    assert.ok(!(pkg.hybrid!.quality?.issues ?? []).some((i) => i.kind === 'missing_provenance'));
    const z = await JSZip.loadAsync((await buildCampaignZip(pkg, o.store)).zip);
    const rights = JSON.parse(await z.file('campaign/sources/rights.json')!.async('string'));
    const withPics = rights.creatives.filter((c: { pictures: unknown[] }) => c.pictures.length);
    assert.ok(withPics.length > 0);
    assert.ok(withPics.every((c: { pictures: { source: string; verification: string }[] }) => c.pictures.every((p) => p.source === 'website' && p.verification)));
  });

  // ---- the Content Writer's clock (incident 2026-11-14, Giardino): test-sized clocks, nothing waits 90 s ----
  const slowWriter = (delayMs: number, text?: string) => (req: { agent: string; userText: string }) => (req.agent === 'copywriter' && !req.userText.includes('Revise ONLY the listed copy') ? { delayMs, ...(text !== undefined ? { text } : {}) } : undefined);
  // per-request limit 300 ms (stands for the old fixed 90 s); the writer's clock follows its cap (here the unverified test model's 4,096 tokens / 24,000 tokens/s, rounded up to 1 s, + 1 s = 2 s)
  const clocks = { callTimeoutMs: 300, generation: { tokensPerSecond: 24_000, overheadMs: 1000, maxMs: 600_000 } };

  it('WRITER CLOCK: an answer slower than the old fixed limit is accepted because the clock follows the answer size; ONE copy request, sized for the campaign (the 2x2 matrix adds none)', async () => {
    const o = await run({ images: await Promise.all([1, 2, 3].map(photo)), config: clocks, openai: { reply: slowWriter(1100) } });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const copy = o.fake.calls('copywriter').filter((r) => !r.userText.includes('Revise ONLY the listed copy'));
    assert.equal(copy.length, 1, 'all copy (posts, ads, print) in one request: the matrix reuses the ads and print copy of the two lead concepts');
    // 3 concepts x 5 platforms ask for 12,000 tokens; the test model is unverified, so the existing guard caps it at what it can safely ask for
    assert.equal(copy[0].body?.max_output_tokens, capOutputTokens('gpt-test-mini', 12000).tokens);
    assert.match(copy[0].userText, /a web_ad and a display_ad for each of the first 2 concept/);
    const d = o.packages[0].pkg.deliverables!;
    assert.ok(d.items.filter((i) => i.matrix).length >= 4, 'the matrix creatives exist without any extra copy request');
  });

  it('WRITER CLOCK: an answer later than its clock ends F4 honestly (no automatic paid retry) and the message explains it', async () => {
    const o = await run({ images: await Promise.all([1, 2].map(photo)), config: clocks, openai: { reply: slowWriter(3500) } });
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.errorMessage ?? '', /Content Writer timed out: nothing can be designed without copy/);
    assert.equal(o.fake.calls('copywriter').length, 1, 'the timed-out request was not sent again');
    const failed = o.events.find((e) => e.type === 'task.completed' && e.participant === 'Content Writer');
    assert.match(JSON.stringify(failed?.payload ?? {}), /No answer arrived within 2\.0 s \(the answer could be up to \d+ tokens long\)\. The request had been sent, so it may still have been billed; it was not repeated automatically\./);
  });

  it('WRITER: an answer that is not valid structured copy is never treated as copy: F4 stops with a clear reason, without an open-ended retry', async () => {
    const o = await run({ images: await Promise.all([1, 2].map(photo)), openai: { reply: slowWriter(0, '{"summary": "cut') } });
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.errorMessage ?? '', /Content Writer (failed|timed out)/);
    assert.ok(o.fake.calls('copywriter').length <= 2, `bounded: ${o.fake.calls('copywriter').length} request(s)`);
    assert.equal(o.packages.length, 0, 'no campaign package is built from invalid copy');
  });

  it('WITHOUT Get Content nothing about approved brand content is claimed', async () => {
    const o = await run({ images: await Promise.all([1, 2].map(photo)) });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const finding = o.events.filter((e) => e.type === 'finding.posted' && e.participant === 'Visual Researcher').map((e) => JSON.stringify(e.payload)).join(' ');
    assert.ok(finding.length > 0, 'the Visual Researcher still reports');
    assert.doesNotMatch(finding, /Approved brand content/);
  });

  it('without any approved picture every deliverable is typography-first and nothing is faked', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const d = o.packages[0].pkg.deliverables!;
    assert.equal(d.counts.withPicture, 0);
    assert.ok(o.packages[0].pkg.limitations.some((l) => /typography-first/.test(l)));
  });

  it('the Content Writer failing ends the campaign honestly (nothing is designed without copy)', async () => {
    const o = await run({ openai: { reply: (req) => (req.agent === 'copywriter' ? { status: 400 } : undefined) }, config: { maxRetries: 0 } });
    assert.notEqual(o.result.status, 'completed');
    assert.equal(o.packages.length, 0);
  });
});
