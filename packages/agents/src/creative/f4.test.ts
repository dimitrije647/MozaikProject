import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { editPaletteRole, newDesign } from '../collections/design';
import { InMemoryAssetStore } from './assets';
import type { CreativeInput } from './context';
import { buildCampaignZip } from './export';
import type { CampaignPackage } from './schemas';
import type { RecordedEvent } from '../factory/state';
import { analyzeImage } from '../imagery/analysis';
import { uploadRights } from '../imagery/rights';
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

  async function run(o: { images?: BrandImage[]; config?: Partial<CreativeRunConfig>; openai?: FakeOpenAIOptions } = {}): Promise<Outcome> {
    const fake = await new FakeOpenAI(o.openai).start();
    servers.push(fake);
    const store = new InMemoryAssetStore();
    const events: RecordedEvent[] = [];
    const packages: Outcome['packages'] = [];
    const design = { ...editPaletteRole(newDesign('premium_editorial'), 'primary', '#0b6e4f'), confirmed: true, confirmedAt: '2026-11-03T10:00:00.000Z' };
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

  it('one campaign: posts for all five platforms, ads, billboard and flyer, drawn from the approved pictures, with zero image requests', async () => {
    const o = await run({ images: await Promise.all([1, 2, 3, 4, 5, 6].map(photo)) });
    assert.equal(o.result.status, 'completed', o.result.errorMessage ?? '');
    const { pkg, meta } = o.packages[0];
    assert.equal(o.fake.imageCalls().length, 0, 'no image request reached the provider');
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
    assert.ok(d.items.some((i) => i.kind === 'billboard') || d.notPlanned.some((n) => n.kind === 'billboard'));
    assert.ok(d.items.some((i) => i.kind === 'flyer') || d.notPlanned.some((n) => n.kind === 'flyer'));
    for (const i of d.items) {
      if (i.status === 'delivered') assert.ok(pkg.imageAssets.some((a) => a.id === i.assetId && a.source === 'template_render'));
      else assert.ok(i.reason, 'a missing deliverable says why');
    }
    assert.ok(d.counts.withPicture > 0, 'approved pictures reach the templates');
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
    assert.equal(manifest.assetsMissing.length, 0);
    for (const f of manifest.files) assert.ok(f.bytes > 0, `${f.path} is not an empty placeholder`);
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
