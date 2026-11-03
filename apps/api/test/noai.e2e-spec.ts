import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { OpenverseAdapter, PixabayAdapter, type RepoImageDiscovery, type WebsiteImageDiscovery } from '@launchpilot/agents';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { IMAGE_ADAPTERS, IMAGE_DOWNLOADER, BRAND_READERS } from '../src/visual/visual.service';
import { IMAGE_SOURCES } from '../src/visual/image-library.service';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';

// sharp belongs to the agents package; the API reaches the very same copy through that package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: any = require(require.resolve('sharp', { paths: [require.resolve('@launchpilot/agents')] }));

// NO AI HYBRID end to end with mocked providers: the preset, the image gallery with rights (website / repository / social / licensed stock), the free
// plan, the zero-image-request guarantee at every layer, a full mocked run, the archive, tenant isolation and continuation. OpenAI is faked over real
// HTTP and no external website, repository or image provider is ever contacted. Nothing is billed.
jest.setTimeout(900_000);

const KEY = 'sk-test-NOAIE2E1234567890abcdefghijkl';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1.5';

async function picture(seed: number, w = 1600, h = 1200): Promise<Buffer> {
  const hue = (seed * 67) % 360;
  const shapes = Array.from({ length: 6 }, (_, i) => `<circle cx="${(seed * 131 + i * 307) % w}" cy="${(seed * 89 + i * 211) % h}" r="${70 + ((seed + i) * 37) % 200}" fill="hsl(${(hue + i * 55) % 360},70%,${28 + i * 9}%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},60%,66%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

// ---- mocked sources ------------------------------------------------------------------------------------------------------------------------------

const calls = { website: [] as string[], repo: [] as string[], fetchWebsite: [] as string[], fetchRepo: [] as string[], download: [] as string[], fetch: [] as string[] };
let files: Record<string, Buffer> = {};

const WEBSITE: WebsiteImageDiscovery = {
  site: 'https://reef.example',
  pages: [{ url: 'https://reef.example/', status: 'read', message: null, images: 4 }],
  candidates: [
    { url: 'https://reef.example/img/hero.jpg', pageUrl: 'https://reef.example/', alt: 'Divers over a coral reef', title: null, width: 1600, height: 1200, where: 'open_graph', context: 'Learn to dive', prominence: 1, firstParty: true },
    { url: 'https://reef.example/img/instructor.jpg', pageUrl: 'https://reef.example/', alt: 'Instructor teaching a dive class', title: null, width: 1600, height: 1200, where: 'img', context: '', prominence: 0.7, firstParty: true },
    { url: 'https://reef.example/img/instructor-copy.jpg', pageUrl: 'https://reef.example/', alt: 'Instructor again', title: null, width: 1600, height: 1200, where: 'img', context: '', prominence: 0.5, firstParty: true },
    { url: 'https://cdn.photos-elsewhere.example/boat.jpg', pageUrl: 'https://reef.example/', alt: 'A boat', title: null, width: 1600, height: 1200, where: 'schema_org', context: '', prominence: 0.4, firstParty: false },
  ],
  rejected: [{ url: 'https://reef.example/img/logo.png', reason: 'A logo, icon or interface graphic, not campaign imagery.' }],
  socialLinks: [{ platform: 'instagram', url: 'https://www.instagram.com/bluereef/' }],
  notes: ['No picture was downloaded: these are candidates.'],
};
const REPO: RepoImageDiscovery = {
  ok: true,
  repo: { owner: 'acme', repo: 'reef', ref: 'main', license: 'MIT' },
  candidates: [{ path: 'public/screenshots/dashboard.png', size: 420_000, kind: 'screenshot', priority: 4, pageUrl: 'https://github.com/acme/reef/blob/main/public/screenshots/dashboard.png', owner: 'acme', repo: 'reef', ref: 'main' }],
  rejected: [],
  notes: ['The repository license (MIT) covers its source code.'],
};
const sources = {
  website: async (url: string) => (calls.website.push(url), WEBSITE),
  repository: async (url: string) => (calls.repo.push(url), REPO),
  fetchWebsiteImage: async (url: string) => (calls.fetchWebsite.push(url), files[url] ? { ok: true as const, data: files[url], contentType: 'image/jpeg' } : { ok: false as const, message: 'not found' }),
  fetchRepositoryImage: async (o: { path: string }) => (calls.fetchRepo.push(o.path), files[`repo:${o.path}`] ? { ok: true as const, data: files[`repo:${o.path}`], contentType: 'image/jpeg' } : { ok: false as const, message: 'not found' }),
};

const PIXABAY = {
  hits: [
    { id: 11, pageURL: 'https://pixabay.com/photos/coral-11/', tags: 'coral, reef, underwater', user: 'ocean_pic', user_id: 9, webformatURL: 'https://pixabay.com/get/a_640.jpg', largeImageURL: 'https://pixabay.com/get/a_1280.jpg', imageWidth: 4000, imageHeight: 2667 },
    { id: 12, pageURL: 'https://pixabay.com/photos/diver-12/', tags: 'woman, diver, portrait', user: 'someone', user_id: 5, webformatURL: 'https://pixabay.com/get/b_640.jpg', largeImageURL: 'https://pixabay.com/get/b_1280.jpg', imageWidth: 3000, imageHeight: 2000 },
  ],
};
const OPENVERSE = { results: [{ id: 'nc1', title: 'Fish', url: 'https://live.staticflickr.com/b.jpg', foreign_landing_url: 'https://flickr.com/b', creator: 'Cy', license: 'by-nc', license_version: '2.0', tags: [] }] };
const mockFetch = ((input: string | URL) => {
  const u = new URL(String(input));
  calls.fetch.push(u.hostname);
  const body = u.hostname === 'pixabay.com' ? PIXABAY : u.hostname === 'api.openverse.org' ? OPENVERSE : {};
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}) as typeof fetch;
const stockFiles: Record<string, Buffer> = {};
const downloader = () => ({
  fetchAsset: async (url: string) => {
    calls.download.push(url);
    return { ok: true as const, finalUrl: url, contentType: 'image/jpeg', body: stockFiles[url] ?? stockFiles['default'], truncated: false };
  },
});

describe('NO AI HYBRID', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, IMAGE, 'gpt-image-1-mini', 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));

  async function readyUser(label: string, o: { withKey?: boolean; intake?: Record<string, unknown> } = {}) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, 'Blue Reef Diving School');
    await user.agent
      .put(`/projects/${projectId}/intake`)
      .send({ productName: 'Blue Reef Diving School', shortDescription: 'Scuba diving courses and reef trips for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners and adventure seekers', marketingGoal: 'sign_ups', preferredLanguage: 'en', ...o.intake })
      .expect(200);
    if (o.withKey !== false) await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }
  const upload = async (u: TestUser, projectId: string, seed: number, name = `photo-${seed}.jpg`) => (await u.agent.post(`/projects/${projectId}/assets`).field('type', 'image').attach('files', await picture(seed), { filename: name, contentType: 'image/jpeg' }).expect(201)).body[0];
  const gallery = async (u: TestUser, projectId: string) => (await u.agent.get(`/projects/${projectId}/images`).expect(200)).body;
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const waitF = async (u: TestUser, id: string, ms = 600_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
      if (!['queued', 'running'].includes(v.status)) return v;
      if (Date.now() > end) throw new Error(`Factory run ${id} still ${v.status}`);
      await sleep(150);
    }
  };
  const buf = (r: any, cb: any) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const newDesign = async (u: TestUser, projectId: string, collectionId = 'premium_editorial') => (await u.agent.post(`/projects/${projectId}/design/new`).send({ collectionId }).expect(200)).body.design;
  const confirmed = (d: any, over: Record<string, unknown> = {}) => ({ ...d, formats: ['instagram_post', 'instagram_story', 'website_banner'], confirmed: true, ...over });
  const NO_AI = { preset: 'no_ai_hybrid', mode: 'fresh', approvedBudgetUsd: 3, confirmCost: true };

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    stockFiles['default'] = await picture(777);
    stockFiles['https://pixabay.com/get/a_1280.jpg'] = await picture(131);
    stockFiles['https://pixabay.com/get/b_1280.jpg'] = await picture(151);
    app = await createApp((b) =>
      b
        .overrideProvider(IMAGE_SOURCES)
        .useValue(sources)
        .overrideProvider(BRAND_READERS)
        .useValue({ website: async () => ({ source: 'website', label: 'Website', status: 'unavailable', message: 'mock', candidates: [] }), repository: async () => ({ source: 'repository', label: 'Repository', status: 'unavailable', message: 'mock', candidates: [] }) })
        .overrideProvider(IMAGE_ADAPTERS)
        .useValue([new PixabayAdapter('test-key', { fetch: mockFetch }), new OpenverseAdapter({ enabled: true, fetch: mockFetch })])
        .overrideProvider(IMAGE_DOWNLOADER)
        .useValue(() => downloader()),
    );
    db = new PrismaClient();
  });
  beforeEach(async () => {
    await useFake();
    for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
    files = {};
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  // ---- the preset -------------------------------------------------------------------------------------------------------------------------------------

  it('PRESET: NO AI HYBRID appears with 0 AI images and 20 template creatives; the existing presets are unchanged', async () => {
    const { user } = await readyUser('noai-presets', { withKey: false });
    const p = (await user.agent.get('/factory/presets').expect(200)).body;
    expect(Object.keys(p.presets)).toEqual(['first_test', 'demo', 'full_production', 'hybrid_production', 'no_ai_hybrid']);
    const n = p.presets.no_ai_hybrid;
    expect(n.f4).toMatchObject({ imageModel: null, maxImages: 0, maxRegenerations: 0, concepts: 5, variations: false });
    expect(n.hybrid).toMatchObject({ originals: 0, templateCreatives: 20, imagery: { generation: 'forbidden', autoStock: false, allowPaidSearch: false } });
    expect(p.presets.hybrid_production.hybrid).toMatchObject({ originals: 5, templateCreatives: 15, imagery: { generation: 'allowed' } });
    expect(p.presets.hybrid_production.f4.imageModel).toBe('auto');
    expect(p.presets.full_production.f4.maxImages).toBe(20);
    expect(p.presets.first_test.f4.maxImages).toBe(1);
    expect(p.presets.demo.f4.maxImages).toBe(3);
    expect(paid()).toHaveLength(0);
  });

  // ---- the guarantee ----------------------------------------------------------------------------------------------------------------------------------

  it('GUARANTEE: every way of asking NO AI HYBRID for an image is refused before anything is sent; Hybrid Production still accepts them', async () => {
    const { user, projectId } = await readyUser('noai-refuse');
    const before = fake.requests.length;
    const asks: [string, object][] = [
      ['an image model', { f4: { imageModel: IMAGE } }],
      ['image requests', { f4: { maxImages: 3 } }],
      ['regeneration', { f4: { maxRegenerations: 1 } }],
      ['original AI images', { hybrid: { originals: 2 } }],
      ['allowed generation', { hybrid: { imagery: { generation: 'allowed' } } }],
      ['variations', { f4: { variations: true } }],
    ];
    for (const [what, body] of asks) {
      for (const call of [preflight, startF]) {
        const r = await call(user, projectId, { ...NO_AI, ...body });
        expect([422]).toContain(r.status);
        expect(r.body.message).toMatch(/NO AI HYBRID never generates images/);
      }
      void what;
    }
    // the same request is fine for Hybrid Production (the guarantee belongs to NO AI HYBRID only)
    const ok = await preflight(user, projectId, { preset: 'hybrid_production', f4: { imageModel: IMAGE } });
    expect(ok.status).toBe(200);
    // the creative endpoint refuses too
    const direct = await user.agent.post(`/projects/${projectId}/runs/creative-production`).send({ imageModel: IMAGE, maxImages: 2, hybrid: { imagery: { generation: 'forbidden' } } });
    expect(direct.status).toBe(422);
    expect(paid().filter((r) => r.path.endsWith('/images/generations'))).toHaveLength(0);
    expect(fake.requests.length - before).toBe(fake.requests.slice(before).filter((r) => r.path.endsWith('/models')).length); // at most the free model list
  });

  // ---- the gallery -------------------------------------------------------------------------------------------------------------------------------------

  it('GALLERY: uploads, website candidates (nothing downloaded), repository candidates, social references; rights are a hard gate', async () => {
    const { user, projectId } = await readyUser('noai-gallery', { withKey: false, intake: { websiteUrl: 'https://reef.example', githubUrl: 'https://github.com/acme/reef' } });
    await db.socialProfile.create({ data: { projectId, platform: 'instagram', url: 'https://www.instagram.com/bluereef/' } });
    const own = await upload(user, projectId, 1, 'my-dive-photo.jpg');
    files['https://reef.example/img/hero.jpg'] = await picture(5);
    files['https://reef.example/img/instructor.jpg'] = await picture(9);
    files['https://reef.example/img/instructor-copy.jpg'] = await sharp(files['https://reef.example/img/instructor.jpg']).resize(900, 675).jpeg({ quality: 60 }).toBuffer(); // a resized copy
    files['https://cdn.photos-elsewhere.example/boat.jpg'] = await picture(13);
    files['repo:public/screenshots/dashboard.png'] = await picture(21);

    // the upload is in the library, approved and eligible
    let g = await gallery(user, projectId);
    const mine = g.items.find((i: any) => i.assetId === own.id);
    expect(mine).toMatchObject({ source: 'upload', status: 'approved', rights: { eligible: true, verification: 'user_owned' }, preview: { kind: 'asset', url: `/api/assets/${own.id}/file` } });
    expect(g.counts.approved).toBe(1);

    const found = (await user.agent.post(`/projects/${projectId}/images/discover`).send({ sources: ['website', 'github', 'social'] }).expect(200)).body;
    expect(found.outcomes.website).toMatchObject({ status: 'ok', found: 4, rejected: 1 });
    expect(found.outcomes.github).toMatchObject({ status: 'ok', found: 1 });
    expect(found.outcomes.social.status).toBe('reference_only');
    expect(calls.fetchWebsite).toHaveLength(0); // candidates only: not one picture was downloaded
    expect(calls.fetchRepo).toHaveLength(0);
    g = found.library;
    const web = g.items.filter((i: any) => i.source === 'website');
    expect(web).toHaveLength(4);
    for (const w of web) expect(w).toMatchObject({ status: 'candidate', needs: 'attestation', rights: { eligible: false, status: 'needs_attestation', verification: 'unverified' } });
    const hero = web.find((i: any) => i.title.includes('coral reef'));
    expect(hero.preview.kind).toBe('remote'); // the owner's own page may be shown
    expect(web.find((i: any) => i.title === 'A boat').preview.kind).toBe('none'); // another host's picture is not shown before the rights are confirmed
    expect(web.find((i: any) => i.title === 'A boat').rights.reasons.join(' ')).toMatch(/served from another website/);
    const gh = g.items.find((i: any) => i.source === 'github');
    expect(gh).toMatchObject({ status: 'candidate', needs: 'attestation' });
    expect(gh.rights.reasons.join(' ')).toMatch(/does not grant permission to reuse its files commercially|repository license \(MIT\)/);
    const social = g.items.find((i: any) => i.source === 'social');
    expect(social).toMatchObject({ status: 'candidate', rights: { status: 'reference_only', eligible: false }, preview: { kind: 'none' } });
    expect(g.counts.approved).toBe(1); // nothing but the upload may be used so far

    // approval without the owner's confirmation never downloads; reference links can never become assets
    const noAttest = await user.agent.post(`/projects/${projectId}/images/${hero.id}/approve`).send({});
    expect(noAttest.status).toBe(422);
    expect(noAttest.body.code).toBe('attestation_required');
    const ref = await user.agent.post(`/projects/${projectId}/images/${social.id}/approve`).send({ attest: true });
    expect(ref.status).toBe(422);
    expect(ref.body.code).toBe('reference_only');
    expect(calls.fetchWebsite).toHaveLength(0);

    // with the confirmation the picture is fetched ONCE, measured, stored with provenance and becomes usable
    const ok = (await user.agent.post(`/projects/${projectId}/images/${hero.id}/approve`).send({ attest: true }).expect(200)).body.item;
    expect(calls.fetchWebsite).toEqual(['https://reef.example/img/hero.jpg']);
    expect(ok).toMatchObject({ status: 'approved', rights: { eligible: true, status: 'attested', verification: 'user_attested', redistributeOriginal: true }, preview: { kind: 'asset' } });
    expect(ok.rights.attestedAt).toBeTruthy();
    const prov = await db.imageProvenance.findFirst({ where: { projectId, assetId: ok.assetId } });
    expect(prov).toMatchObject({ provider: 'website', sourceKind: 'BRAND_ASSET', licenseBasis: 'user_attested', originalUrl: 'https://reef.example/img/hero.jpg' });
    expect(prov!.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    expect((prov!.rightsJson as any).userApproved).toBe(true);

    // a near-copy is not added again (perceptual hash)
    const inst = web.find((i: any) => i.title.startsWith('Instructor teaching'));
    await user.agent.post(`/projects/${projectId}/images/${inst.id}/approve`).send({ attest: true }).expect(200);
    const copy = web.find((i: any) => i.title === 'Instructor again');
    const dup = await user.agent.post(`/projects/${projectId}/images/${copy.id}/approve`).send({ attest: true });
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('duplicate');

    // the repository picture goes through the official-API fetcher, after the confirmation
    const shot = (await user.agent.post(`/projects/${projectId}/images/${gh.id}/approve`).send({ attest: true }).expect(200)).body.item;
    expect(calls.fetchRepo).toEqual(['public/screenshots/dashboard.png']);
    expect(shot.rights.verification).toBe('user_attested');

    // reject / restore
    const rej = (await user.agent.post(`/projects/${projectId}/images/${mine.id}/reject`).send({}).expect(200)).body.item;
    expect(rej.status).toBe('rejected');
    expect((await gallery(user, projectId)).counts.approved).toBe(3); // hero, instructor, dashboard
    const back = (await user.agent.post(`/projects/${projectId}/images/${mine.id}/restore`).send({}).expect(200)).body.item;
    expect(back.status).toBe('approved');
    expect((await gallery(user, projectId)).counts.approved).toBe(4);
    expect(paid()).toHaveLength(0);
  });

  it('GALLERY: licensed stock - cleared licenses can be approved, a license that needs a check only after confirmation, a non-commercial one never; credits are recorded', async () => {
    const { user, projectId } = await readyUser('noai-stock', { withKey: false });
    const found = (await user.agent.post(`/projects/${projectId}/images/discover`).send({ sources: ['stock'] }).expect(200)).body;
    expect(found.outcomes.stock.status).toBe('ok');
    const stock = found.library.items.filter((i: any) => i.source === 'stock');
    const coral = stock.find((i: any) => i.id === 'stock:pixabay:11');
    const diver = stock.find((i: any) => i.id === 'stock:pixabay:12');
    expect(coral).toMatchObject({ status: 'candidate', needs: null, rights: { status: 'cleared', license: 'Pixabay Content License', redistributeOriginal: false }, preview: { kind: 'thumbnail' } });
    expect(diver).toMatchObject({ needs: 'review', rights: { status: 'needs_review', eligible: false } });
    expect(stock.some((i: any) => i.id.includes('nc1'))).toBe(false); // a NonCommercial license is not offered at all
    expect(calls.download).toHaveLength(0);

    const review = await user.agent.post(`/projects/${projectId}/images/${diver.id}/approve`).send({});
    expect(review.status).toBe(422);
    expect(review.body.code).toBe('review_required');
    const ok = (await user.agent.post(`/projects/${projectId}/images/${coral.id}/approve`).send({}).expect(200)).body.item;
    expect(ok).toMatchObject({ status: 'approved', rights: { eligible: true, verification: 'provider_license', attribution: 'Image by ocean_pic on Pixabay' } });
    expect(calls.download).toEqual(['https://pixabay.com/get/a_1280.jpg']);
    const confirmedReview = (await user.agent.post(`/projects/${projectId}/images/${diver.id}/approve`).send({ reviewConfirmed: true }).expect(200)).body.item;
    expect(confirmedReview.rights).toMatchObject({ eligible: true, verification: 'user_reviewed' });
    expect((await gallery(user, projectId)).counts.approved).toBe(2);
    const alt = (await user.agent.post(`/projects/${projectId}/images/${coral.id}/alternatives`).send({}).expect(200)).body;
    expect(['ok', 'empty']).toContain(alt.status);
    expect(paid()).toHaveLength(0);
  });

  it('TENANT ISOLATION: another user can neither see nor change a project\'s pictures; ids of other projects are not found', async () => {
    const a = await readyUser('noai-tenant-a', { withKey: false });
    const b = await readyUser('noai-tenant-b', { withKey: false });
    const mineA = await upload(a.user, a.projectId, 3);
    const galleryA = await gallery(a.user, a.projectId);
    const item = galleryA.items.find((i: any) => i.assetId === mineA.id);
    expect((await b.user.agent.get(`/projects/${a.projectId}/images`)).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/images/discover`).send({})).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/images/${item.id}/approve`).send({})).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/images/${item.id}/reject`).send({})).status).toBe(404);
    // the picture id of project A used inside project B's own route
    expect((await b.user.agent.post(`/projects/${b.projectId}/images/${item.id}/reject`).send({})).status).toBe(404);
    expect((await gallery(b.user, b.projectId)).items).toHaveLength(0);
    expect((await a.user.agent.get(`/projects/${a.projectId}/images`).expect(200)).body.items).toHaveLength(1);
  });

  // ---- the free plan -----------------------------------------------------------------------------------------------------------------------------------

  it('PLAN (free): needs an approved design; shows AI images 0, the image sources, the providers and one budget approval; sends nothing', async () => {
    const { user, projectId } = await readyUser('noai-plan');
    const noDesign = (await preflight(user, projectId, { ...NO_AI, mode: 'fresh' }).expect(200)).body;
    expect(noDesign.blockers.map((b: any) => b.code)).toContain('design_missing');
    expect(noDesign.ok).toBe(false);

    await upload(user, projectId, 1);
    await upload(user, projectId, 2);
    const d = confirmed(await newDesign(user, projectId));
    await user.agent.put(`/projects/${projectId}/design`).send(d).expect(200);
    const before = paid().length;
    const plan = (await preflight(user, projectId, { ...NO_AI, hybrid: { design: d } }).expect(200)).body;
    expect(plan.blockers).toEqual([]);
    expect(plan.preset).toBe('no_ai_hybrid');
    const h = plan.hybrid;
    expect(h.headline).toMatch(/^NO AI HYBRID: 0 AI-generated images \+ 20 template creatives = 20 finished creatives$/);
    expect(h.noAi.statement).toEqual({ aiImages: 'AI-generated images: 0', imagery: 'Existing/licensed imagery: enabled', agents: 'AI agents for strategy and copywriting: enabled' });
    expect(h.noAi.imageRequestCap).toBe(0);
    expect(h.noAi.imagery).toMatchObject({ aiImages: 0, approved: 2, estimate: { creativesPlanned: 20, concepts: 5, approvedPictures: 2, enough: false } });
    expect(h.noAi.imagery.providers.map((p: any) => `${p.id}:${p.configured}`)).toEqual(['pixabay:true', 'openverse:true']);
    expect(h.originals).toMatchObject({ planned: 0, paidRequests: 0 });
    expect(plan.budget).toMatchObject({ required: true, imageRequestCap: 0, imagePriceUnavailable: false });
    expect(plan.totals.imageRequests).toBe(0);
    expect(plan.models.image).toBeNull();
    // one budget approval is required to start (text-model calls are paid)
    const refused = await startF(user, projectId, { preset: 'no_ai_hybrid', mode: 'fresh', hybrid: { design: d } });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/approve a spending limit/);
    expect(paid().filter((r) => r.path.endsWith('/responses'))).toHaveLength(before);

    // the free preview uses the approved pictures and sends nothing at all
    const reqBefore = fake.requests.length;
    const prev = (await user.agent.post(`/projects/${projectId}/hybrid/preview`).send({ preset: 'no_ai_hybrid', hybrid: { design: d } }).expect(200)).body;
    expect(prev.noOpenAIRequests).toBe(true);
    expect(prev.imageAllocation.approved).toBe(2);
    expect(prev.selection.items).toHaveLength(20);
    expect(prev.selection.items.every((i: any) => i.sourceKind === 'brand_image' && i.imageId)).toBe(true);
    expect(prev.selection.items.filter((i: any) => i.thumbnail?.url).length).toBeGreaterThan(10);
    expect(prev.sampleNote).toMatch(/nothing is generated/);
    expect(fake.requests.length - reqBefore).toBe(0);
  });

  // ---- a full mocked run ---------------------------------------------------------------------------------------------------------------------------------

  it('FULL RUN: 20 template creatives from approved pictures, zero image requests, one budget, rights in the archive, F1-F3 reused when continued with new pictures', async () => {
    const { user, projectId } = await readyUser('noai-full');
    // a first campaign with NO pictures at all: text-first, honest, never faked
    const d0 = confirmed(await newDesign(user, projectId, 'premium_editorial'));
    const first = (await startF(user, projectId, { ...NO_AI, hybrid: { design: d0 } }).expect(201)).body;
    const r1 = await waitF(user, first.id);
    expect(['completed', 'partial']).toContain(r1.status);
    expect(fake.imageCalls()).toHaveLength(0);
    const c1 = (await user.agent.get(`/campaigns/${r1.campaignId}`).expect(200)).body.package;
    expect(c1.hybrid.imagery).toMatchObject({ mode: 'no_ai_hybrid', aiImagesGenerated: 0, imageRequests: 0, approved: 0 });
    for (const t of c1.hybrid.creatives.filter((x: any) => x.status === 'rendered')) expect(t.sourceAssetIds).toEqual([]);
    expect(c1.limitations.join(' ')).toMatch(/No approved picture was available/);
    const f1Count = fake.requests.filter((r) => r.path.endsWith('/responses')).length;
    expect(f1Count).toBeGreaterThan(5);

    // new pictures arrive; the campaign is started again from the same strategy: F1-F3 are REUSED
    const own = [await upload(user, projectId, 1), await upload(user, projectId, 2), await upload(user, projectId, 3), await upload(user, projectId, 4)];
    const second = (await startF(user, projectId, { ...NO_AI, mode: 'continue', rerunCreative: true, hybrid: { design: d0 } }).expect(201)).body;
    const r2 = await waitF(user, second.id);
    expect(['completed', 'partial']).toContain(r2.status);
    const reload = (await user.agent.get(`/factory-runs/${second.id}`).expect(200)).body;
    expect(reload.phases.map((p: any) => `${p.code}:${p.action}`)).toEqual(['F1:reuse', 'F2:reuse', 'F3:reuse', 'F4:run']);
    expect(reload.config.settings.f4).toMatchObject({ imageModel: null, maxImages: 0, maxRegenerations: 0 });
    expect(reload.config.settings.hybrid).toMatchObject({ originals: 0, templateCreatives: 20, imagery: { generation: 'forbidden' } });
    expect(reload.config.imageModel ?? null).toBeNull();
    expect(fake.imageCalls()).toHaveLength(0);
    // the earlier campaign is untouched
    expect((await user.agent.get(`/campaigns/${r1.campaignId}`).expect(200)).body.package.hybrid.imagery.approved).toBe(0);

    const camp = (await user.agent.get(`/campaigns/${r2.campaignId}`).expect(200)).body;
    const pkg = camp.package;
    const h = pkg.hybrid;
    expect(pkg.usage.images.requested).toBe(0);
    expect(pkg.cost.imageUsd).toBe(0);
    expect(h.counts.originals.planned).toBe(0);
    expect(h.counts.templates.planned).toBe(20);
    expect(h.counts.total.delivered).toBe(h.counts.templates.rendered);
    expect(h.counts.templates.rendered).toBeGreaterThanOrEqual(18);
    expect(h.imagery).toMatchObject({ approved: 4, aiImagesGenerated: 0, imageRequests: 0, autoAdded: 0 });
    const ids = new Set(own.map((a: any) => a.id));
    for (const t of h.creatives.filter((x: any) => x.status === 'rendered')) {
      expect(t.sourceAssetIds.length).toBeGreaterThanOrEqual(1);
      for (const s of t.sourceAssetIds) expect(ids).toContain(String(s).replace('brand:', ''));
    }
    expect(new Set(h.selection.items.map((i: any) => i.imageId)).size).toBeGreaterThanOrEqual(3);
    // F4 asks the same Mozaik participants as before
    const events = (await user.agent.get(`/runs/${camp.runId}/events`).expect(200)).body;
    const types = (events.items ?? events).map((e: any) => e.eventType ?? e.type);
    expect(types).toContain('images.sourced');
    expect(types.indexOf('images.sourced')).toBeLessThan(types.indexOf('template.selection.completed'));

    // the archive: own originals included, usage and rights present, nothing restricted
    const res = await user.agent.get(`/campaigns/${r2.campaignId}/export`).buffer(true).parse(buf).expect(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const names = Object.keys(zip.files);
    expect(names.filter((n) => n.startsWith('images/approved-sources/'))).toHaveLength(4);
    expect(names.filter((n) => n.startsWith('images/templates/') && n.endsWith('.png')).length).toBe(h.counts.templates.rendered);
    for (const want of ['campaign.json', 'manifest.json', 'usage/sources.json', 'usage/rights.json', 'usage/README.txt', 'design/campaign-design.json']) expect(names).toContain(want);
    expect(names.some((n) => n.startsWith('strategy/')) && names.some((n) => n.startsWith('copy/')) && names.some((n) => n.startsWith('layouts/'))).toBe(true);
    const rights = JSON.parse(await zip.file('usage/rights.json')!.async('string'));
    expect(rights.aiImagesGenerated).toBe(0);
    expect(rights.creatives.every((c: any) => c.collection === 'premium_editorial')).toBe(true);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.hybrid.productionMode).toBe('no_ai_hybrid');

    // the continuation endpoint of AI campaigns refuses a NO AI campaign
    const cont = await user.agent.post(`/campaigns/${r2.campaignId}/continue-images`).send({ approvedBudgetUsd: 2, confirmCost: true });
    expect(cont.status).toBe(422);
    expect(cont.body.message).toMatch(/NO AI HYBRID, which never generates images/);
    expect(fake.imageCalls()).toHaveLength(0);
  });

  it('AUTOMATIC STOCK MODE adds only cleared licensed pictures during the run, with provenance and credits; without it nothing is searched', async () => {
    // off: no search, no download
    const off = await readyUser('noai-auto-off');
    await upload(off.user, off.projectId, 1);
    const dOff = confirmed(await newDesign(off.user, off.projectId, 'clean_ecommerce'));
    const offRun = await waitF(off.user, (await startF(off.user, off.projectId, { ...NO_AI, hybrid: { design: dOff } }).expect(201)).body.id);
    expect(['completed', 'partial']).toContain(offRun.status);
    expect(calls.fetch).toEqual([]);
    expect(calls.download).toEqual([]);

    // on: the Visual Researcher searches with the concepts and adds the cleared picture (never the one that needs a license check)
    const on = await readyUser('noai-auto-on');
    await upload(on.user, on.projectId, 2);
    const dOn = confirmed(await newDesign(on.user, on.projectId, 'clean_ecommerce'), { autoStock: true });
    const plan = (await preflight(on.user, on.projectId, { ...NO_AI, hybrid: { design: dOn } }).expect(200)).body;
    expect(plan.hybrid.settings.imagery.autoStock).toBe(true);
    const run = await waitF(on.user, (await startF(on.user, on.projectId, { ...NO_AI, hybrid: { design: dOn } }).expect(201)).body.id);
    expect(['completed', 'partial']).toContain(run.status);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(calls.download).toEqual(['https://pixabay.com/get/a_1280.jpg']);
    const pkg = (await on.user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body.package;
    expect(pkg.hybrid.imagery).toMatchObject({ approved: 2, autoAdded: 1 });
    expect(pkg.hybrid.imagery.library.find((l: any) => l.via === 'auto_stock')).toMatchObject({ source: 'stock', license: 'Pixabay Content License', verification: 'provider_license', attribution: 'Image by ocean_pic on Pixabay', redistributeOriginal: false });
    const prov = await db.imageProvenance.findMany({ where: { projectId: on.projectId } });
    expect(prov).toHaveLength(1);
    expect(prov[0]).toMatchObject({ provider: 'pixabay', sourceKind: 'LICENSED_STOCK' });
    const res = await on.user.agent.get(`/campaigns/${run.campaignId}/export`).buffer(true).parse(buf).expect(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(await zip.file('CREDITS.txt')!.async('string')).toMatch(/Image by ocean_pic on Pixabay/);
    // the stock ORIGINAL is not handed on (its license forbids it); the user's own upload is
    expect(Object.keys(zip.files).filter((n) => n.startsWith('images/approved-sources/'))).toHaveLength(1);
    const sourcesJson = JSON.parse(await zip.file('usage/sources.json')!.async('string'));
    expect(sourcesJson.sources.find((s: any) => s.source === 'stock').originalIncluded).toBeNull();
  });
});
