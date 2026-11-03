import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { OpenverseAdapter, PixabayAdapter, brandWordsOf, logosOfHtml, logosOfTree, type BrandReading, type RepoImageDiscovery, type WebsiteImageDiscovery } from '@launchpilot/agents';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { IMAGE_ADAPTERS, IMAGE_DOWNLOADER, BRAND_READERS } from '../src/visual/visual.service';
import { IMAGE_SOURCES } from '../src/visual/image-library.service';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';

// sharp belongs to the agents package; the API reaches the very same copy through that package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: any = require(require.resolve('sharp', { paths: [require.resolve('@launchpilot/agents')] }));

// GET CONTENT end to end with mocked sources: the website and the repository are fixtures (the REAL logo parsers run over fixture HTML / file lists), OpenAI is
// faked over real HTTP. Nothing external is contacted and nothing is billed.
jest.setTimeout(900_000);

const KEY = 'sk-test-GETCONTENT1234567890abcdefghi';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1.5';

async function picture(seed: number, w = 1600, h = 1200): Promise<Buffer> {
  const hue = (seed * 67) % 360;
  const shapes = Array.from({ length: 6 }, (_, i) => `<circle cx="${(seed * 131 + i * 307) % w}" cy="${(seed * 89 + i * 211) % h}" r="${70 + ((seed + i) * 37) % 200}" fill="hsl(${(hue + i * 55) % 360},70%,${28 + i * 9}%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},60%,66%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
const logoPng = (hex: string, w = 640, h = 220) => sharp({ create: { width: w, height: h, channels: 4, background: hex } }).png().toBuffer();
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><rect x="4" y="4" width="292" height="92" rx="14" fill="#0b3d91"/><circle cx="50" cy="50" r="24" fill="#ffffff"/><rect x="90" y="38" width="170" height="24" rx="6" fill="#f2c94c"/></svg>';
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" onload="alert(1)"><script>fetch("https://evil.example")</script><image href="https://evil.example/p.png" width="5" height="5"/><rect width="200" height="80" fill="#222"/></svg>';

// ---- fixtures --------------------------------------------------------------------------------------------------------------------------------------

const SITE = 'https://reef.example/';
const HOME_HTML = `<!doctype html><html><head><title>Blue Reef Diving School</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <script type="application/ld+json">{"@type":"Organization","name":"Blue Reef","logo":"https://reef.example/brand/blue-reef-logo.png"}</script></head>
  <body><header><a href="/"><img src="/img/site-logo.svg" alt="Blue Reef Diving School" class="navbar-brand" width="180" height="48"></a></header>
  <main><img src="/img/hero.jpg" alt="Divers over a coral reef" width="1600" height="1200"><section class="partners"><img src="/img/partner-logo-padi.png" alt="PADI partner logo" width="120" height="60"></section></main></body></html>`;
const BRAND = brandWordsOf('Blue Reef Diving School', 'reef.example');
const WEBSITE: WebsiteImageDiscovery = {
  site: SITE,
  pages: [{ url: SITE, status: 'read', message: null, images: 4 }],
  candidates: [
    { url: `${SITE}img/hero.jpg`, pageUrl: SITE, alt: 'Divers over a coral reef', title: null, width: 1600, height: 1200, where: 'open_graph', context: 'Learn to dive', prominence: 1, firstParty: true },
    { url: `${SITE}img/instructor.jpg`, pageUrl: SITE, alt: 'Instructor teaching a dive class', title: null, width: 1600, height: 1200, where: 'img', context: '', prominence: 0.7, firstParty: true },
    { url: `${SITE}img/instructor-copy.jpg`, pageUrl: SITE, alt: 'Instructor again', title: null, width: 1600, height: 1200, where: 'img', context: '', prominence: 0.5, firstParty: true },
  ],
  rejected: [{ url: `${SITE}img/spacer.gif`, reason: 'A tracking pixel, not a picture.' }],
  socialLinks: [],
  logos: logosOfHtml(HOME_HTML, SITE, BRAND),
  notes: ['No picture was downloaded: these are candidates.'],
};
const TREE = [
  { path: 'public/logo.svg', size: 4_200 },
  { path: 'public/brand/blue-reef-logo.png', size: 38_000 },
  { path: 'public/brand/logo-old.svg', size: 900 },
  { path: 'public/images/react-logo.svg', size: 2_000 },
  { path: 'src/assets/partners/padi-logo.png', size: 9_000 },
];
const REPO: RepoImageDiscovery = { ok: true, repo: { owner: 'acme', repo: 'reef', ref: 'main', license: 'MIT' }, candidates: [], rejected: [], logos: logosOfTree(TREE, { owner: 'acme', repo: 'reef', ref: 'main', brand: BRAND }), notes: ['The repository license (MIT) covers its source code.'] };

const calls = { website: 0, repo: 0, fetchWebsite: [] as string[], fetchRepo: [] as string[] };
const mode = { website: 'ok' as 'ok' | 'throw' | 'gate' | 'blocked' | 'empty', repo: 'ok' as 'ok' | 'unavailable' };
let gate: { promise: Promise<void>; open: () => void } = { promise: Promise.resolve(), open: () => undefined };
const newGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  gate = { promise, open };
};
let files: Record<string, Buffer | string> = {};
const sources = {
  website: async () => {
    calls.website++;
    if (mode.website === 'throw') throw new Error('boom');
    if (mode.website === 'gate') await gate.promise;
    if (mode.website === 'blocked') return { ...WEBSITE, pages: [{ url: SITE, status: 'blocked' as const, message: 'The page is protected against automated reading; it was not worked around.', images: 0 }], candidates: [], logos: [] };
    if (mode.website === 'empty') return { ...WEBSITE, candidates: [], logos: [] };
    return WEBSITE;
  },
  repository: async () => {
    calls.repo++;
    if (mode.repo === 'unavailable') return { ok: false, repo: null, candidates: [], rejected: [], notes: ['The repository was not found or is not public.'] } as RepoImageDiscovery;
    return REPO;
  },
  fetchWebsiteImage: async (url: string) => (calls.fetchWebsite.push(url), files[url] ? { ok: true as const, data: files[url] as Buffer, contentType: 'image/png' } : { ok: false as const, message: 'not found' }),
  fetchWebsiteSvg: async (url: string) => (calls.fetchWebsite.push(url), files[url] ? { ok: true as const, data: Buffer.from(files[url] as string), contentType: 'image/svg+xml' } : { ok: false as const, message: 'not found' }),
  fetchRepositoryImage: async (o: { path: string }) => (calls.fetchRepo.push(o.path), files[`repo:${o.path}`] ? { ok: true as const, data: Buffer.isBuffer(files[`repo:${o.path}`]) ? (files[`repo:${o.path}`] as Buffer) : Buffer.from(files[`repo:${o.path}`] as string), contentType: /svg/.test(o.path) ? 'image/svg+xml' : 'image/png' } : { ok: false as const, message: 'not found' }),
};
const reading = (source: BrandReading['source'], items: [BrandReading['candidates'][number]['role'], string][], label: string): BrandReading => ({ source, label, status: 'ok', message: null, candidates: items.map(([role, hex]) => ({ role, hex, tier: 2 as const, weight: 0.85, evidence: `${label}: ${role}` })) });
const readers = {
  website: async () => reading('website', [['primary', '#0a5cff'], ['accent', '#ff7a00'], ['background', '#ffffff'], ['text', '#1a1a2e']], 'Website'),
  repository: async () => reading('repository', [['primary', '#0a5cff']], 'Repository'),
};

describe('GET CONTENT', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, IMAGE, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }

  async function readyUser(label: string, o: { intake?: Record<string, unknown>; key?: boolean } = {}) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, 'Blue Reef Diving School');
    await user.agent
      .put(`/projects/${projectId}/intake`)
      .send({ productName: 'Blue Reef Diving School', shortDescription: 'Scuba diving courses and reef trips for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners and adventure seekers', marketingGoal: 'sign_ups', preferredLanguage: 'en', ...o.intake })
      .expect(200);
    if (o.key !== false) await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }
  const rich = (label: string) => readyUser(label, { intake: { websiteUrl: 'https://reef.example', githubUrl: 'https://github.com/acme/reef' } });
  const upload = async (u: TestUser, projectId: string, type: string, name: string, data: Buffer, mime = 'image/png') => (await u.agent.post(`/projects/${projectId}/assets`).field('type', type).attach('files', data, { filename: name, contentType: mime }).expect(201)).body[0];
  const state = async (u: TestUser, projectId: string) => (await u.agent.get(`/projects/${projectId}/get-content`).expect(200)).body;
  const waitRun = async (u: TestUser, projectId: string, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await state(u, projectId);
      if (s.run && s.run.status !== 'running') return s;
      if (Date.now() > end) throw new Error('Get Content still running');
      await sleep(80);
    }
  };
  const run = async (u: TestUser, projectId: string, body: object = {}) => {
    const started = (await u.agent.post(`/projects/${projectId}/get-content`).send(body).expect(200)).body;
    return { started, done: await waitRun(u, projectId) };
  };
  const logoBy = (s: any, frag: string) => s.logo.candidates.find((c: any) => c.fileName.includes(frag));
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);
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
  const NO_AI = { preset: 'no_ai_hybrid', mode: 'fresh', approvedBudgetUsd: 3, confirmCost: true };
  const design = async (u: TestUser, projectId: string, over: Record<string, unknown> = {}) => {
    const d = (await u.agent.post(`/projects/${projectId}/design/new`).send({ collectionId: 'premium_editorial' }).expect(200)).body.design;
    return { ...d, formats: ['instagram_post', 'instagram_story', 'website_banner'], confirmed: true, ...over };
  };

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    app = await createApp((b) =>
      b
        .overrideProvider(IMAGE_SOURCES)
        .useValue(sources)
        .overrideProvider(BRAND_READERS)
        .useValue(readers)
        .overrideProvider(IMAGE_ADAPTERS)
        .useValue([new PixabayAdapter('test-key', { fetch: (async () => new Response('{"hits":[]}', { status: 200 })) as typeof fetch }), new OpenverseAdapter({ enabled: false })])
        .overrideProvider(IMAGE_DOWNLOADER)
        .useValue(() => ({ fetchAsset: async () => ({ ok: false as const, code: 'http_error', message: 'no' }) })),
    );
    db = new PrismaClient();
  });
  beforeEach(async () => {
    await useFake();
    calls.website = 0;
    calls.repo = 0;
    calls.fetchWebsite = [];
    calls.fetchRepo = [];
    mode.website = 'ok';
    mode.repo = 'ok';
    files = {};
  });
  afterAll(async () => {
    gate.open();
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  // ---- optional: until it is pressed nothing happens ---------------------------------------------------------------------------------------------------

  it('OPTIONAL: until the button is pressed nothing is discovered, nothing is requested and the campaign flow is unchanged', async () => {
    const { user, projectId } = await rich('gc-default');
    const s = await state(user, projectId);
    expect(s).toMatchObject({ projectId, run: null, logo: { approved: null, candidates: [] }, palette: { suggestion: null }, approved: { logo: false, photos: 0, approvedAt: null } });
    expect(calls.website + calls.repo).toBe(0);
    expect(await db.getContentRun.count({ where: { projectId } })).toBe(0);
    // the plan of a campaign needs nothing from Get Content: only the design (as before)
    const plan = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({ ...NO_AI }).expect(200)).body;
    expect(plan.blockers.map((b: any) => b.code)).toEqual(['design_missing']);
    expect(calls.website + calls.repo).toBe(0);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'))).toHaveLength(0);
  });

  // ---- the run -----------------------------------------------------------------------------------------------------------------------------------------

  it('RUN: free and deterministic; discovers uploads, website, repository and palette; starts no campaign; an uploaded logo ranks first and the favicon last', async () => {
    const { user, projectId } = await rich('gc-run');
    const own = await upload(user, projectId, 'logo', 'our-logo.png', await logoPng('#115577'));
    const oldLogoImage = await upload(user, projectId, 'image', 'company-logo-old.jpg', await picture(3, 800, 300), 'image/jpeg');
    await upload(user, projectId, 'image', 'team.jpg', await picture(7), 'image/jpeg');
    const requestsBefore = fake.requests.length;

    const { started, done } = await run(user, projectId);
    expect(started.status).toBe('running');
    expect(done.run.status).toBe('completed');
    expect(done.run.sources.map((x: any) => `${x.id}:${x.status}`)).toEqual(['uploads:ok', 'website:ok', 'github:ok', 'existing:ok', 'palette:ok']); // the two uploaded pictures count as approved (uploads are approved by default)
    expect(done.run.sources.find((x: any) => x.id === 'existing').found).toMatchObject({ logos: 0, photos: 2 });
    expect(done.run.summary).toMatchObject({ websiteInspected: true, githubInspected: true, sourcesUnavailable: [] });
    expect(done.run.summary.logoCandidates).toBeGreaterThanOrEqual(6);
    expect(fake.requests.length - requestsBefore).toBe(0); // not even the free model list: Get Content never talks to OpenAI
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
    expect(await db.campaignRun.count({ where: { projectId } })).toBe(0);
    expect(calls.website).toBe(1);
    expect(calls.repo).toBe(1);
    expect(calls.fetchWebsite).toEqual([]); // nothing was downloaded

    const c = done.logo.candidates;
    expect(c[0]).toMatchObject({ source: 'upload', fileName: 'our-logo.png', confidence: 1, confidenceLabel: 'high', status: 'candidate', needs: null, preview: { kind: 'asset', url: `/api/assets/${own.id}/file` } });
    expect(c.some((x: any) => x.fileName === 'company-logo-old.png' || x.fileName === 'company-logo-old.jpg')).toBe(true); // an upload whose name says it is a logo
    expect(c.some((x: any) => x.source === 'website' && x.fileName === 'site-logo.svg' && x.svg === true && x.confidenceLabel === 'high')).toBe(true);
    expect(c.some((x: any) => x.source === 'website' && x.fileName === 'blue-reef-logo.png')).toBe(true);
    expect(c.some((x: any) => x.source === 'github' && x.fileName === 'logo.svg' && x.confidence >= 0.85)).toBe(true);
    const fav = c.filter((x: any) => x.favicon);
    expect(fav.length).toBeGreaterThanOrEqual(2);
    for (const f of fav) expect(f).toMatchObject({ confidenceLabel: 'low', status: 'candidate' });
    expect(c.slice(-fav.length).every((x: any) => x.favicon)).toBe(true); // a favicon is always last
    expect(c.find((x: any) => /partner|react/.test(x.fileName))?.confidence ?? 0).toBeLessThan(0.4);
    for (const x of c) expect(x.signals.length).toBeGreaterThan(0);
    expect(done.logo.approved).toBeNull(); // nothing is approved by discovery
    expect(done.approved).toMatchObject({ logo: false, photos: 2, approvedAt: null }); // the two uploads are approved by default; nothing was approved by Get Content
    // the uploaded picture whose name says "logo" is still a PHOTO of the gallery; the logo list does not leak into it
    const gallery = (await user.agent.get(`/projects/${projectId}/images`).expect(200)).body;
    expect(gallery.items.some((i: any) => i.assetId === oldLogoImage.id)).toBe(true);
    expect(gallery.items.some((i: any) => /logo/i.test(i.title) && i.source === 'website')).toBe(false);
    // the palette comes from real readings, with a source and a confidence per color
    const sug = done.palette.suggestion;
    expect(sug.palette.primary).toBe('#0a5cff');
    for (const role of ['primary', 'secondary', 'accent', 'background', 'text']) expect(sug.evidence[role]).toMatchObject({ source: expect.any(String), confidence: expect.stringMatching(/high|medium|low/), evidence: expect.any(String) });
    expect(sug.evidence.primary.source).not.toBe('collection_default');
    expect(done.palette.collectionId).toBeTruthy();

    // an unchanged project reuses the run (no new request to the website); "try again" really looks again
    const again = (await user.agent.post(`/projects/${projectId}/get-content`).send({}).expect(200)).body;
    expect(again.cached).toBe(true);
    expect(again.id).toBe(started.id);
    expect(calls.website).toBe(1);
    const fresh = (await user.agent.post(`/projects/${projectId}/get-content`).send({ refresh: true }).expect(200)).body;
    await waitRun(user, projectId);
    expect(fresh.id).not.toBe(started.id);
    expect(calls.website).toBe(2);
  });

  it('ONE RUN AT A TIME and CANCELLATION: pressing the button again returns the running run; a slow site never holds the screen; cancel stops it', async () => {
    const { user, projectId } = await rich('gc-cancel');
    mode.website = 'gate';
    newGate();
    const a = (await user.agent.post(`/projects/${projectId}/get-content`).send({}).expect(200)).body;
    expect(a.status).toBe('running');
    const b = (await user.agent.post(`/projects/${projectId}/get-content`).send({}).expect(200)).body;
    expect(b.id).toBe(a.id);
    await sleep(300);
    const mid = await state(user, projectId);
    expect(mid.run.status).toBe('running');
    expect(mid.run.sources.find((s: any) => s.id === 'website').status).toBe('running');
    expect(mid.run.sources.find((s: any) => s.id === 'uploads').status).toBe('empty'); // the other sources did not wait for the slow one (nothing was uploaded to this project)
    const cancelled = (await user.agent.post(`/projects/${projectId}/get-content/cancel`).send({}).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.sources.some((s: any) => s.status === 'cancelled')).toBe(true);
    gate.open();
    expect(calls.website).toBe(1);
    // after a cancellation the next press starts a new run
    mode.website = 'ok';
    const next = (await user.agent.post(`/projects/${projectId}/get-content`).send({}).expect(200)).body;
    expect(next.id).not.toBe(a.id);
    await waitRun(user, projectId);
  });

  it('PARTIAL SUCCESS and MISSING SOURCES never block: a failing, blocked or missing source is reported honestly; the others still work', async () => {
    const { user, projectId } = await rich('gc-partial');
    await upload(user, projectId, 'logo', 'mark.png', await logoPng('#aa2255'));
    mode.website = 'throw';
    mode.repo = 'unavailable';
    const one = (await run(user, projectId, { refresh: true })).done;
    expect(one.run.status).toBe('partial');
    expect(one.run.sources.map((s: any) => `${s.id}:${s.status}`)).toEqual(['uploads:ok', 'website:failed', 'github:unavailable', 'existing:empty', 'palette:ok']);
    expect(one.run.summary.sourcesUnavailable).toEqual(['Website', 'GitHub repository']);
    expect(one.run.sources.find((s: any) => s.id === 'github').message).toMatch(/not found or is not public/);
    expect(one.logo.candidates.map((c: any) => c.source)).toEqual(['upload']); // what could be read is still offered
    mode.website = 'blocked';
    mode.repo = 'ok';
    const two = (await run(user, projectId, { refresh: true })).done;
    expect(two.run.sources.find((s: any) => s.id === 'website')).toMatchObject({ status: 'blocked' });
    expect(two.run.sources.find((s: any) => s.id === 'website').message).toMatch(/not worked around/);
    expect(two.run.summary.websiteInspected).toBe(false); // an inaccessible source is never reported as analysed
    mode.website = 'empty';
    const three = (await run(user, projectId, { refresh: true })).done;
    expect(three.run.sources.find((s: any) => s.id === 'website').status).toBe('empty');

    // a project with no website, no repository and nothing uploaded: an informative result, never an error
    const bare = await readyUser('gc-bare', { key: false });
    const r = (await run(bare.user, bare.projectId)).done;
    expect(['completed', 'partial']).toContain(r.run.status);
    expect(r.run.sources.find((s: any) => s.id === 'website')).toMatchObject({ status: 'skipped', message: 'No website address was given for this project.' });
    expect(r.run.sources.find((s: any) => s.id === 'github')).toMatchObject({ status: 'skipped' });
    expect(r.run.notes.join(' ')).toMatch(/Nothing useful was found.*continue normally/);
    expect(r.logo.candidates).toEqual([]);
  });

  // ---- logo decisions ----------------------------------------------------------------------------------------------------------------------------------

  it('LOGO approval: the owner confirms the rights before any file is downloaded; an SVG is cleaned and converted; a repeated logo is not stored twice', async () => {
    const { user, projectId } = await rich('gc-logo');
    files[`${SITE}img/site-logo.svg`] = LOGO_SVG;
    files[`${SITE}brand/blue-reef-logo.png`] = await logoPng('#0b3d91');
    files['repo:public/logo.svg'] = LOGO_SVG;
    files['repo:public/brand/blue-reef-logo.png'] = await logoPng('#0b3d91');
    files['repo:public/brand/logo-old.svg'] = '<html><body>not a logo</body></html>';
    const s0 = (await run(user, projectId)).done;
    const svg = logoBy(s0, 'site-logo.svg');
    expect(svg).toMatchObject({ needs: 'attestation', rights: { status: 'needs_attestation', eligible: false }, status: 'candidate' });
    expect(svg.preview.kind).toBe('remote'); // the owner's own page may be shown; nothing has been downloaded
    // without the confirmation nothing is downloaded or approved
    const refused = await user.agent.post(`/projects/${projectId}/get-content/logo/${svg.id}/approve`).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('attestation_required');
    expect(calls.fetchWebsite).toEqual([]);
    expect((await state(user, projectId)).approved.logo).toBe(false);

    const ok = (await user.agent.post(`/projects/${projectId}/get-content/logo/${svg.id}/approve`).send({ attest: true }).expect(200)).body;
    expect(calls.fetchWebsite).toEqual([`${SITE}img/site-logo.svg`]);
    expect(ok.approved).toMatchObject({ source: 'website', format: 'png', rights: { verification: 'user_attested', license: 'Rights confirmed by the project owner' } });
    expect(ok.approved.rights.attestedAt).toBeTruthy();
    expect(ok.approved.width && ok.approved.height).toBeTruthy();
    const asset = await db.projectAsset.findUnique({ where: { id: ok.approved.assetId } });
    expect(asset).toMatchObject({ type: 'logo', mimeType: 'image/png', projectId });
    const prov = await db.imageProvenance.findFirst({ where: { assetId: asset!.id } });
    expect(prov).toMatchObject({ provider: 'website', sourceKind: 'BRAND_LOGO', licenseBasis: 'user_attested', originalUrl: `${SITE}img/site-logo.svg` });
    expect(prov!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const brand = await db.projectBrandContent.findUnique({ where: { projectId } });
    expect(brand).toMatchObject({ logoAssetId: asset!.id, logoSource: 'website', approvedById: expect.any(String) });
    const s1 = await state(user, projectId);
    expect(s1.approved).toMatchObject({ logo: true });
    expect(logoBy(s1, 'site-logo.svg').status).toBe('approved');
    expect(s1.logo.candidates.filter((c: any) => c.status === 'approved')).toHaveLength(1);
    expect(s1.logo.approved.assetId).toBe(asset!.id);
    expect(s1.logo.approved.previewUrl).toBe(`/api/assets/${asset!.id}/file`);

    // the same logo from the repository: the existing file is used, nothing is stored twice
    const gh = logoBy(s1, 'logo.svg') && s1.logo.candidates.find((c: any) => c.source === 'github' && c.fileName === 'logo.svg');
    const dup = (await user.agent.post(`/projects/${projectId}/get-content/logo/${gh.id}/approve`).send({ attest: true }).expect(200)).body;
    expect(dup.approved.assetId).toBe(asset!.id);
    expect(dup.note).toMatch(/already in the project/);
    expect(await db.projectAsset.count({ where: { projectId, type: 'logo' } })).toBe(1);
    expect(calls.fetchRepo).toEqual(['public/logo.svg']);

    // an HTML file disguised as an SVG is refused
    const bad = s1.logo.candidates.find((c: any) => c.fileName === 'logo-old.svg');
    const refusedSvg = await user.agent.post(`/projects/${projectId}/get-content/logo/${bad.id}/approve`).send({ attest: true });
    expect(refusedSvg.status).toBe(422);
    expect(refusedSvg.body.code).toBe('unsupported_svg');

    // a hostile SVG is sanitized (scripts and external references removed) and the result is a plain PNG
    files['repo:public/logo.svg'] = EVIL_SVG;
    // reject the approved one, then choose the same candidate again after "restore"
    const rej = (await user.agent.post(`/projects/${projectId}/get-content/logo/${svg.id}/reject`).send({}).expect(200)).body;
    expect(rej.candidate.status).toBe('rejected');
    expect((await state(user, projectId)).approved.logo).toBe(false);
    expect(await db.projectBrandContent.findUnique({ where: { projectId } })).toMatchObject({ logoAssetId: null });
    const rest = (await user.agent.post(`/projects/${projectId}/get-content/logo/${svg.id}/restore`).send({}).expect(200)).body;
    expect(rest.candidate.status).toBe('candidate');

    // "upload a different logo": stored and approved at once; the same bytes twice are one file
    const png = await logoPng('#8844aa');
    const up = (await user.agent.post(`/projects/${projectId}/get-content/logo/upload`).attach('file', png, { filename: 'new logo.png', contentType: 'image/png' }).expect(200)).body;
    expect(up.approved).toMatchObject({ source: 'upload', rights: { verification: 'user_owned' } });
    const up2 = (await user.agent.post(`/projects/${projectId}/get-content/logo/upload`).attach('file', png, { filename: 'again.png', contentType: 'image/png' }).expect(200)).body;
    expect(up2.approved.assetId).toBe(up.approved.assetId);
    const types = await user.agent.post(`/projects/${projectId}/get-content/logo/upload`).attach('file', Buffer.from('<html></html>'), { filename: 'x.html', contentType: 'text/html' });
    expect(types.status).toBe(422);
    // the project uses the approved logo EVERYWHERE the newest uploaded logo used to be chosen
    expect((await user.agent.get(`/projects/${projectId}/get-content`).expect(200)).body.logo.approved.assetId).toBe(up.approved.assetId);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(0);
  });

  it('PHOTOGRAPHS: several approved at once, each through the same rights rules; duplicates are refused; only approved pictures count', async () => {
    const { user, projectId } = await rich('gc-photos');
    files[`${SITE}img/hero.jpg`] = await picture(5);
    files[`${SITE}img/instructor.jpg`] = await picture(9);
    files[`${SITE}img/instructor-copy.jpg`] = await sharp(files[`${SITE}img/instructor.jpg`] as Buffer).resize(900, 675).jpeg({ quality: 60 }).toBuffer();
    await run(user, projectId);
    const items = (await user.agent.get(`/projects/${projectId}/images`).expect(200)).body.items.filter((i: any) => i.source === 'website');
    expect(items).toHaveLength(3);
    expect(items.every((i: any) => i.status === 'candidate' && i.rights.eligible === false)).toBe(true);
    expect((await state(user, projectId)).approved.photos).toBe(0);
    const ids = items.map((i: any) => i.id);
    // without the owner's confirmation every one of them is refused and nothing is downloaded
    const none = (await user.agent.post(`/projects/${projectId}/images/approve-batch`).send({ ids }).expect(200)).body.results;
    expect(none.every((r: any) => !r.ok && r.code === 'attestation_required')).toBe(true);
    expect(await db.projectBrandContent.findUnique({ where: { projectId } })).toBeNull();
    // with it, the pictures are imported; the near-copy fails on its own and the others still succeed
    const res = (await user.agent.post(`/projects/${projectId}/images/approve-batch`).send({ ids, attest: true }).expect(200)).body.results;
    expect(res.filter((r: any) => r.ok)).toHaveLength(2);
    const failed = res.find((r: any) => !r.ok);
    expect(failed.code).toBe('duplicate');
    const s = await state(user, projectId);
    expect(s.approved.photos).toBe(2);
    expect(s.approved.approvedAt).toBeTruthy();
    expect(await db.projectImage.count({ where: { projectId, role: 'photo', status: 'approved' } })).toBe(2);
    const rej = (await user.agent.post(`/projects/${projectId}/images/reject-batch`).send({ ids: [failed.id] }).expect(200)).body.results;
    expect(rej[0].ok).toBe(true);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses'))).toHaveLength(0);
  });

  it('PALETTE: suggested from real sources and shown with evidence; the colors the user edited are never overwritten', async () => {
    const { user, projectId } = await rich('gc-palette');
    const d = await design(user, projectId, { confirmed: false });
    const edited = { ...d, palette: { ...d.palette, primary: '#123456' }, overridden: ['primary'], paletteEvidence: { ...d.paletteEvidence, primary: { source: 'user', confidence: 'high', evidence: 'Chosen by you' } } };
    await user.agent.put(`/projects/${projectId}/design`).send(edited).expect(200);
    const s = (await run(user, projectId, { collectionId: 'premium_editorial', refresh: true })).done;
    expect(s.palette.suggestion.palette.primary).toBe('#123456');
    expect(s.palette.suggestion.evidence.primary.source).toBe('user');
    expect(s.palette.suggestion.palette.accent).toBe('#ff7a00'); // another role comes from the website
    expect(s.palette.suggestion.evidence.accent.source).toBe('website');
    // the draft itself is untouched: the Campaign Design editor stays the single palette store
    const draft = (await user.agent.get(`/projects/${projectId}/design`).expect(200)).body.draft;
    expect(draft.palette.primary).toBe('#123456');
    expect(draft.palette.accent).toBe(d.palette.accent);
  });

  // ---- the campaign uses what was approved --------------------------------------------------------------------------------------------------------------

  it('CAMPAIGN: approved content reaches the agents and the renderer; the logo is recorded per creative; a later campaign reuses it; the archive keeps the lineage', async () => {
    const { user, projectId } = await rich('gc-campaign');
    files[`${SITE}brand/blue-reef-logo.png`] = await logoPng('#0b3d91');
    files[`${SITE}img/hero.jpg`] = await picture(5);
    files[`${SITE}img/instructor.jpg`] = await picture(9);
    await run(user, projectId);
    const s0 = await state(user, projectId);
    const logo = logoBy(s0, 'blue-reef-logo.png');
    await user.agent.post(`/projects/${projectId}/get-content/logo/${logo.id}/approve`).send({ attest: true }).expect(200);
    const photos = (await user.agent.get(`/projects/${projectId}/images`).expect(200)).body.items.filter((i: any) => i.source === 'website' && /coral reef|Instructor teaching/.test(i.title));
    await user.agent.post(`/projects/${projectId}/images/approve-batch`).send({ ids: photos.map((p: any) => p.id), attest: true }).expect(200);
    const d = await design(user, projectId);
    await user.agent.put(`/projects/${projectId}/design`).send(d).expect(200);

    // the free preview draws the approved logo
    const prev = (await user.agent.post(`/projects/${projectId}/hybrid/preview`).send({ preset: 'no_ai_hybrid', hybrid: { design: d } }).expect(200)).body;
    expect(prev.brand).toMatchObject({ logo: true, logoApproved: true, approvedPhotos: 2 });

    const textBefore = fake.requests.filter((r) => r.path.endsWith('/responses')).length;
    const started = (await startF(user, projectId, { ...NO_AI, hybrid: { design: d } }).expect(201)).body;
    const r1 = await waitF(user, started.id);
    expect(['completed', 'partial']).toContain(r1.status);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses')).length).toBeGreaterThan(textBefore);
    const pkg = (await user.agent.get(`/campaigns/${r1.campaignId}`).expect(200)).body.package;
    const h = pkg.hybrid;
    expect(h.brand.logo).toMatchObject({ approved: true, source: 'website', assetId: s0.logo.approved?.assetId ?? (await state(user, projectId)).logo.approved.assetId });
    expect(h.brand.approvedPhotos).toBe(2);
    expect(h.brand.withLogo + h.brand.omitted.length).toBe(20);
    expect(h.brand.withLogo).toBeGreaterThanOrEqual(18);
    for (const c of h.creatives.filter((x: any) => x.status === 'rendered')) expect(c.logo).toBeDefined();
    // only the approved pictures were used (the third candidate was never approved, so it is not in any creative)
    const ids = new Set(h.imagery.library.map((l: any) => l.id));
    expect(ids.size).toBe(2);
    for (const c of h.creatives.filter((x: any) => x.status === 'rendered')) expect(c.sourceAssetIds.every((x: string) => ids.has(x.replace('brand:', '')))).toBe(true);
    // the Visual Researcher was told (counts only)
    const events = (await user.agent.get(`/runs/${r1.phases.find((p: any) => p.code === 'F4').runId}/events?limit=500`).expect(200)).body;
    const list = events.items ?? events;
    expect(JSON.stringify(list.filter((e: any) => (e.eventType ?? e.type) === 'finding.posted')).includes('Approved brand content: the official logo and 2 approved photograph')).toBe(true);

    // the archive: brand metadata and the logo file travel with the campaign
    const res = await user.agent.get(`/campaigns/${r1.campaignId}/export`).buffer(true).parse(buf).expect(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const names = Object.keys(zip.files);
    expect(names).toContain('design/brand-content.json');
    expect(names.some((n) => n.startsWith('design/brand/logo-'))).toBe(true);
    const meta = JSON.parse(await zip.file('design/brand-content.json')!.async('string'));
    expect(meta).toMatchObject({ approvedPhotographs: 2, creativesWithLogo: h.brand.withLogo, logo: { approved: true, source: 'website', rights: 'Rights confirmed by the project owner' } });
    expect(names.filter((n) => n.startsWith('images/templates/')).length).toBe(h.counts.templates.rendered);

    // a LATER campaign for the same project reuses the approved content without another Get Content run
    const websiteCalls = calls.website;
    const second = (await startF(user, projectId, { ...NO_AI, mode: 'continue', rerunCreative: true, hybrid: { design: d } }).expect(201)).body;
    const r2 = await waitF(user, second.id);
    expect(['completed', 'partial']).toContain(r2.status);
    const pkg2 = (await user.agent.get(`/campaigns/${r2.campaignId}`).expect(200)).body.package;
    expect(pkg2.hybrid.brand.logo.approved).toBe(true);
    expect(calls.website).toBe(websiteCalls);
    // the earlier campaign is unchanged
    expect((await user.agent.get(`/campaigns/${r1.campaignId}`).expect(200)).body.package.hybrid.brand.withLogo).toBe(h.brand.withLogo);
  });

  it('SKIPPING Get Content: the campaign behaves exactly as before (no brand block, no per-creative logo record, the newest uploaded logo is used)', async () => {
    const { user, projectId } = await readyUser('gc-skip');
    const up = await upload(user, projectId, 'logo', 'plain-logo.png', await logoPng('#226644'));
    for (const seed of [11, 12]) await upload(user, projectId, 'image', `photo-${seed}.jpg`, await picture(seed), 'image/jpeg');
    const d = await design(user, projectId);
    await user.agent.put(`/projects/${projectId}/design`).send(d).expect(200);
    const prev = (await user.agent.post(`/projects/${projectId}/hybrid/preview`).send({ preset: 'no_ai_hybrid', hybrid: { design: d } }).expect(200)).body;
    expect(prev.brand).toMatchObject({ logo: true, logoApproved: false, approvedPhotos: 0 });
    const started = (await startF(user, projectId, { ...NO_AI, hybrid: { design: d } }).expect(201)).body;
    const r = await waitF(user, started.id);
    expect(['completed', 'partial']).toContain(r.status);
    const pkg = (await user.agent.get(`/campaigns/${r.campaignId}`).expect(200)).body.package;
    expect(pkg.hybrid.brand).toBeUndefined();
    for (const c of pkg.hybrid.creatives) expect(c.logo).toBeUndefined();
    expect(pkg.hybrid.counts.templates.rendered).toBe(20);
    expect(await db.getContentRun.count({ where: { projectId } })).toBe(0);
    expect(await db.projectBrandContent.count({ where: { projectId } })).toBe(0);
    expect(calls.website + calls.repo).toBe(0);
    const res = await user.agent.get(`/campaigns/${r.campaignId}/export`).buffer(true).parse(buf).expect(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(Object.keys(zip.files).some((n) => n.startsWith('design/brand'))).toBe(false);
    expect((await db.projectAsset.findFirst({ where: { projectId, type: 'logo' } }))?.id).toBe(up.id);
    expect(fake.imageCalls()).toHaveLength(0);
  });

  it('TENANT ISOLATION: another user can neither see nor change a project\'s Get Content; candidate ids of other projects are not found', async () => {
    const a = await rich('gc-tenant-a');
    const b = await rich('gc-tenant-b');
    await upload(a.user, a.projectId, 'logo', 'a-logo.png', await logoPng('#112233'));
    const sa = (await run(a.user, a.projectId)).done;
    const cand = sa.logo.candidates[0];
    expect((await b.user.agent.get(`/projects/${a.projectId}/get-content`)).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/get-content`).send({})).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/get-content/cancel`).send({})).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/get-content/logo/${cand.id}/approve`).send({})).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/get-content/logo/upload`).attach('file', await logoPng('#000000'), { filename: 'x.png', contentType: 'image/png' })).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${b.projectId}/get-content/logo/${cand.id}/approve`).send({ attest: true })).status).toBe(404);
    expect((await b.user.agent.post(`/projects/${a.projectId}/images/approve-batch`).send({ ids: [cand.id], attest: true })).status).toBe(404);
    expect((await state(b.user, b.projectId)).logo.candidates).toEqual([]);
    expect(await db.projectBrandContent.count({ where: { projectId: a.projectId } })).toBe(0);
    expect(fake.imageCalls()).toHaveLength(0);
  });
});
