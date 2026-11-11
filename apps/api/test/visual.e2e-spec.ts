import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import request from 'supertest';
import { BraveReferenceAdapter, OpenverseAdapter, PixabayAdapter, getCollection, type BrandReading } from '@launchpilot/agents';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { BRAND_READERS, IMAGE_ADAPTERS, IMAGE_DOWNLOADER } from '../src/visual/visual.service';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';

// sharp belongs to the agents package; the API reaches the very same copy through that package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: any = require(require.resolve('sharp', { paths: [require.resolve('@launchpilot/agents')] }));

// VISUAL SYSTEM 2.0 end to end: ten collections, the ONE campaign design, brand palette analysis (website / repository / logo, mocked), web visual
// discovery (mocked providers; Pinterest is reference-only), licensed pictures with provenance, the free plan, and a full mocked Hybrid run that
// uses the approved design. OpenAI is faked over real HTTP: nothing is billed. No external website, repository or search provider is ever contacted.
jest.setTimeout(600_000);

const KEY = 'sk-test-VISUALE2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1.5';

// ---- mocked providers ------------------------------------------------------------------------------------------------------------------------

const reading = (source: BrandReading['source'], tier: 2 | 3 | 4, items: [BrandReading['candidates'][number]['role'], string][], label: string): BrandReading => ({
  source,
  label,
  status: 'ok',
  message: null,
  candidates: items.map(([role, hex]) => ({ role, hex, tier, weight: 0.85, evidence: `${label}: ${role}` })),
});

const calls = { website: [] as string[], repository: [] as string[], download: [] as string[], fetch: [] as string[] };
let websiteReading: BrandReading = reading('website', 2, [['primary', '#0a5cff'], ['accent', '#ff7a00'], ['background', '#ffffff'], ['text', '#1a1a2e']], 'Website');
let repoReading: BrandReading = reading('repository', 2, [['primary', '#0a5cff']], 'Repository');
const readers = {
  website: async (url: string) => {
    calls.website.push(url);
    return websiteReading;
  },
  repository: async (url: string) => {
    calls.repository.push(url);
    return repoReading;
  },
};

const PIXABAY = {
  hits: [
    { id: 11, pageURL: 'https://pixabay.com/photos/coral-11/', tags: 'coral, reef, underwater', user: 'ocean_pic', user_id: 9, webformatURL: 'https://pixabay.com/get/a_640.jpg', largeImageURL: 'https://pixabay.com/get/a_1280.jpg', imageWidth: 4000, imageHeight: 2667 },
    { id: 12, pageURL: 'https://pixabay.com/photos/diver-12/', tags: 'woman, diver, portrait', user: 'someone', user_id: 5, webformatURL: 'https://pixabay.com/get/b_640.jpg', largeImageURL: 'https://pixabay.com/get/b_1280.jpg', imageWidth: 3000, imageHeight: 2000 },
  ],
};
const OPENVERSE = {
  results: [
    { id: 'nc1', title: 'Fish', url: 'https://live.staticflickr.com/b.jpg', foreign_landing_url: 'https://flickr.com/b', creator: 'Cy', license: 'by-nc', license_version: '2.0', tags: [] },
    { id: 'cc0', title: 'Sea', url: 'https://live.staticflickr.com/c.jpg', foreign_landing_url: 'https://flickr.com/c', creator: 'Di', license: 'cc0', license_version: '1.0', tags: [] },
  ],
};
const BRAVE = { results: [{ title: 'Diving inspiration board', url: 'https://www.pinterest.com/pin/123456/', thumbnail: { src: 'https://imgs.search.brave.com/x' } }, { title: 'Underwater photography', url: 'https://www.example-photo.com/gallery', thumbnail: { src: 'https://imgs.search.brave.com/y' } }] };
const mockFetch = ((input: string | URL) => {
  const u = new URL(String(input));
  calls.fetch.push(u.hostname);
  const body = u.hostname === 'pixabay.com' ? PIXABAY : u.hostname === 'api.openverse.org' ? OPENVERSE : u.hostname === 'api.search.brave.com' ? BRAVE : {};
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}) as typeof fetch;

let bigJpeg: Buffer;
let otherJpeg: Buffer; // a textured, DIFFERENT picture: the library refuses a near-copy of a picture it already holds
const downloader = () => ({
  fetchAsset: async (url: string) => {
    calls.download.push(url);
    return { ok: true as const, finalUrl: url, contentType: 'image/jpeg', body: url.includes('b_1280') ? otherJpeg : bigJpeg, truncated: false };
  },
});

const pngBuffer = async (bg: string, shape: string) => sharp({ create: { width: 200, height: 200, channels: 4, background: bg } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">${shape}</svg>`) }]).png().toBuffer();

describe('Visual System 2.0', () => {
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
  const png = (u: TestUser, path: string) =>
    u.agent.get(path).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  async function readyUser(label: string, o: { withKey?: boolean; intake?: Record<string, unknown> } = {}) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, 'Deep Diving School');
    await user.agent
      .put(`/projects/${projectId}/intake`)
      .send({ productName: 'Deep Diving School', shortDescription: 'Scuba diving courses for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners and adventure seekers', marketingGoal: 'sign_ups', preferredLanguage: 'en', ...o.intake })
      .expect(200);
    if (o.withKey !== false) await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const waitF = async (u: TestUser, id: string, ms = 420_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
      if (!['queued', 'running'].includes(v.status)) return v;
      if (Date.now() > end) throw new Error(`Factory run ${id} still ${v.status}`);
      await sleep(150);
    }
  };
  const HYBRID = { preset: 'hybrid_production', mode: 'fresh', approvedBudgetUsd: 5, confirmCost: true, f4: { imageModel: IMAGE } };
  const newDesign = async (u: TestUser, projectId: string, collectionId = 'premium_editorial') => (await u.agent.post(`/projects/${projectId}/design/new`).send({ collectionId }).expect(200)).body.design;
  const confirmed = (d: any, over: Record<string, unknown> = {}) => ({ ...d, formats: ['instagram_post', 'instagram_story', 'website_banner'], confirmed: true, ...over });

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    const textured = (seed: number) =>
      sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${seed * 67 % 360},60%,22%)"/><stop offset="1" stop-color="hsl(${(seed * 67 + 90) % 360},60%,66%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${[0, 1, 2, 3, 4].map((i) => `<circle cx="${(seed * 131 + i * 307) % 1600}" cy="${(seed * 89 + i * 211) % 1000}" r="${70 + ((seed + i) * 37) % 200}" fill="hsl(${(seed * 67 + i * 55) % 360},70%,${28 + i * 9}%)"/>`).join('')}</svg>`)).jpeg().toBuffer();
    bigJpeg = await textured(3);
    otherJpeg = await textured(8);
    app = await createApp((b) =>
      b
        .overrideProvider(BRAND_READERS)
        .useValue(readers)
        .overrideProvider(IMAGE_ADAPTERS)
        .useValue([new PixabayAdapter('test-key', { fetch: mockFetch }), new OpenverseAdapter({ enabled: true, fetch: mockFetch }), new BraveReferenceAdapter({ key: 'test-key', enabled: true, fetch: mockFetch })])
        .overrideProvider(IMAGE_DOWNLOADER)
        .useValue(() => downloader()),
    );
    db = new PrismaClient();
  });
  beforeEach(async () => {
    await useFake();
    for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
    websiteReading = reading('website', 2, [['primary', '#0a5cff'], ['accent', '#ff7a00'], ['background', '#ffffff'], ['text', '#1a1a2e']], 'Website');
    repoReading = reading('repository', 2, [['primary', '#0a5cff']], 'Repository');
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  // ---- project creation ------------------------------------------------------------------------------------------------------------------------

  it('PROJECT: no visual style is required; a minimal project works; an older style value is only a hint, never an active choice', async () => {
    const minimal = await registerUser(app, 'vs-min');
    const projectId = await createProject(minimal, 'Tiny Bakery');
    const intake = (await minimal.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Tiny Bakery', shortDescription: 'Fresh sourdough bread baked every morning in Zrenjanin' }).expect(200)).body;
    expect(intake.stylePreference ?? null).toBeNull();
    const d = (await minimal.agent.get(`/projects/${projectId}/design`).expect(200)).body;
    expect(d.draft).toBeNull();
    expect(d.defaults.legacyStylePreference).toBeNull();

    // an older project that stored "cinematic": still readable, offered as a suggestion at most
    const old = await readyUser('vs-old', { withKey: false, intake: { stylePreference: 'cinematic' } });
    const oldDesign = (await old.user.agent.get(`/projects/${old.projectId}/design`).expect(200)).body;
    expect(oldDesign.defaults.legacyStylePreference).toBe('cinematic');
    expect(oldDesign.defaults.suggestedCollection.id).toBe('dynamic_events');
    expect(oldDesign.draft).toBeNull(); // nothing is chosen for the user
    expect((await old.user.agent.get(`/projects/${old.projectId}`).expect(200)).body.intake.stylePreference).toBe('cinematic');
    expect(paid()).toHaveLength(0);
  });

  // ---- the collections -------------------------------------------------------------------------------------------------------------------------

  it('COLLECTIONS API: exactly ten, stable ids, valid templates; previews are real PNGs from the renderer and follow the palette; authenticated', async () => {
    const { user } = await readyUser('vs-col', { withKey: false });
    const list = (await user.agent.get('/collections').expect(200)).body;
    expect(list.items.map((c: any) => c.id)).toEqual(['minimal_tech', 'bold_startup', 'premium_editorial', 'modern_corporate', 'luxury_hospitality', 'lifestyle_human', 'clean_ecommerce', 'dynamic_events', 'contemporary_geometric', 'soft_organic']);
    expect(list.formatOptions.map((f: any) => f.key)).toEqual(['instagram_post', 'instagram_story', 'facebook_post', 'linkedin_post', 'website_banner', 'flyer', 'billboard', 'other']);
    const templates = new Set((await user.agent.get('/templates').expect(200)).body.items.map((t: any) => t.id));
    for (const c of list.items) {
      expect(c.templates.length).toBeGreaterThanOrEqual(5);
      for (const t of c.templates) expect(templates.has(t.id)).toBe(true);
      expect(c.coverage).toEqual({ story: true, feed: true, banner: true });
      expect(c.previews.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(c)).not.toMatch(/https?:\/\/|<script/);
    }
    const one = (await user.agent.get('/collections/luxury_hospitality').expect(200)).body;
    expect(one.name).toBe('Luxury Hospitality');
    await user.agent.get('/collections/retro_arcade').expect(404);

    const a = await png(user, '/collections/bold_startup/preview?template=bold_big_claim&class=square&p=0b6e4f&s=111111&a=ffcc00&b=fff8ef&t=14142b').expect(200);
    const b = await png(user, '/collections/bold_startup/preview?template=bold_big_claim&class=square&p=7a1fa2&s=111111&a=ffcc00&b=fff8ef&t=14142b').expect(200);
    expect(a.headers['content-type']).toBe('image/png');
    expect((a.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    const meta = await sharp(a.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1080]);
    expect((a.body as Buffer).equals(b.body as Buffer)).toBe(false); // palette changes update the preview
    const pix = async (buf: Buffer) => (await sharp(buf).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer()).toString('hex');
    expect(await pix(a.body as Buffer)).toBe('0b6e4f');
    await png(user, '/collections/bold_startup/preview?template=bold_big_claim&class=square&p=red&s=1&a=2&b=3&t=4').expect(400);
    await png(user, '/collections/bold_startup/preview?template=tech_minimalist').expect(404); // not part of that collection
    await png(user, '/collections/bold_startup/preview?template=bold_big_claim&class=banner').expect(400); // never stretched into a class it was not designed for
    await request(app.getHttpServer()).get('/collections').expect(401);
    await request(app.getHttpServer()).get('/collections/minimal_tech/preview').expect(401);
    expect(paid()).toHaveLength(0);
  });

  // ---- the ONE design: draft, persistence, validation, isolation --------------------------------------------------------------------------------

  it('DESIGN: one draft per project that survives a refresh; an unreadable palette cannot be confirmed; another user cannot see or change it', async () => {
    const { user, projectId } = await readyUser('vs-draft', { withKey: false });
    const stranger = await registerUser(app, 'vs-stranger');
    const d = await newDesign(user, projectId, 'soft_organic');
    expect(d).toMatchObject({ collectionId: 'soft_organic', confirmed: false, overridden: [] });
    expect(d.formats).toEqual([]); // a project without default formats starts with none: the campaign confirms them

    const saved = (await user.agent.put(`/projects/${projectId}/design`).send({ ...d, formats: ['instagram_post'] }).expect(200)).body;
    expect(saved.check.ok).toBe(true);
    await user.agent.put(`/projects/${projectId}/design`).send({ ...d, formats: ['instagram_story'], palette: { ...d.palette, primary: '#112233' }, overridden: ['primary'] }).expect(200);
    expect(await db.campaignDesignDraft.count({ where: { projectId } })).toBe(1); // selected ONCE
    const again = (await user.agent.get(`/projects/${projectId}/design`).expect(200)).body; // "refresh"
    expect(again.draft).toMatchObject({ collectionId: 'soft_organic', formats: ['instagram_story'], overridden: ['primary'], palette: { primary: '#112233' } });

    // unreadable text blocks confirmation (the user edits first); an invalid design is refused with a reason
    const unreadable = { ...again.draft, palette: { ...again.draft.palette, text: '#f0f0f0', background: '#ffffff' }, confirmed: true };
    const r = await user.agent.put(`/projects/${projectId}/design`).send(unreadable).expect(422);
    expect(r.body.message).toMatch(/cannot be confirmed.*contrast/i);
    await user.agent.put(`/projects/${projectId}/design`).send({ ...again.draft, collectionId: 'nope' }).expect(422);
    await user.agent.put(`/projects/${projectId}/design`).send({ ...again.draft, palette: { ...again.draft.palette, accent: 'orange' } }).expect(422);
    // the same design with a readable palette can be confirmed
    const ok = (await user.agent.put(`/projects/${projectId}/design`).send({ ...again.draft, confirmed: true }).expect(200)).body;
    expect(ok.design.confirmed).toBe(true);
    expect(ok.design.confirmedAt).toEqual(expect.any(String));
    // changing the collection keeps what the user edited and asks for a new confirmation
    const sw = (await user.agent.post(`/projects/${projectId}/design/switch`).send({ design: ok.design, collectionId: 'premium_editorial' }).expect(200)).body;
    expect(sw.design).toMatchObject({ collectionId: 'premium_editorial', confirmed: false, palette: { primary: '#112233' }, overridden: ['primary'] });
    expect(sw.notes.join(' ')).toMatch(/kept/);

    // isolation: another user's session reaches none of it
    await stranger.agent.get(`/projects/${projectId}/design`).expect(404);
    await stranger.agent.put(`/projects/${projectId}/design`).send(d).expect(404);
    await stranger.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'minimal_tech' }).expect(404);
    await png(stranger, `/projects/${projectId}/design/preview?collection=minimal_tech&p=000000&s=111111&a=222222&b=ffffff&t=000000`).expect(404);
    await stranger.agent.post(`/projects/${projectId}/design/discover`).send({}).expect(404);
    await stranger.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'pixabay', id: '11' }).expect(404);
    await stranger.agent.delete(`/projects/${projectId}/design`).expect(404);
    expect(await db.campaignDesignDraft.count({ where: { projectId } })).toBe(1);
    expect(paid()).toHaveLength(0);
  });

  it('PROJECT PREVIEW: drawn with the project\'s own logo or its brand name, by the real renderer, with no OpenAI request', async () => {
    const { user, projectId } = await readyUser('vs-prev', { withKey: false });
    const before = await png(user, `/projects/${projectId}/design/preview?collection=minimal_tech&template=tech_minimalist&class=square&p=2f5bff&s=111827&a=14b8a6&b=f5f6f8&t=0f1419`).expect(200);
    const logo = await pngBuffer('#00000000', '<circle cx="100" cy="100" r="80" fill="#ff7a00"/>');
    await user.agent.post(`/projects/${projectId}/assets`).field('type', 'logo').attach('files', logo, { filename: 'logo.png', contentType: 'image/png' }).expect(201);
    const withLogo = await png(user, `/projects/${projectId}/design/preview?collection=minimal_tech&template=tech_minimalist&class=square&p=2f5bff&s=111827&a=14b8a6&b=f5f6f8&t=0f1419`).expect(200);
    expect((before.body as Buffer).equals(withLogo.body as Buffer)).toBe(false);
    expect(paid()).toHaveLength(0);
  });

  // ---- brand palette analysis ----------------------------------------------------------------------------------------------------------------------

  it('PALETTE: website tokens, repository tokens and the logo are read; explicit colors win; conflicts are reported; the analysis is cached', async () => {
    const { user, projectId } = await readyUser('vs-pal', { withKey: false, intake: { websiteUrl: 'https://deepdiving.example', githubUrl: 'https://github.com/acme/site' } });
    const logo = await pngBuffer('#00000000', '<circle cx="100" cy="100" r="80" fill="#e91e63"/>');
    await user.agent.post(`/projects/${projectId}/assets`).field('type', 'logo').attach('files', logo, { filename: 'logo.png', contentType: 'image/png' }).expect(201);

    const first = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'minimal_tech' }).expect(200)).body;
    expect(first.cached).toBe(false);
    expect(calls.website).toEqual(['https://deepdiving.example']);
    expect(calls.repository).toEqual(['https://github.com/acme/site']);
    const s = first.suggestion;
    expect(s.palette.primary).toBe('#0a5cff'); // declared design tokens (tier 2) beat the logo (tier 3)
    expect(s.palette.accent).toBe('#ff7a00');
    expect(s.palette.background).toBe('#ffffff');
    expect(s.palette.text).toBe('#1a1a2e');
    expect(['repository', 'website']).toContain(s.evidence.primary.source); // two tier-2 sources name the same color
    expect(s.evidence.primary.evidence).toMatch(/also seen in/);
    // the logo says something else: the disagreement is shown, not hidden
    expect(s.conflicts.map((c: any) => c.role)).toContain('primary');
    const conflict = s.conflicts.find((c: any) => c.role === 'primary');
    expect(conflict.alternatives.map((a: any) => a.hex)[0]).toMatch(/^#(e9|ea|eb)/);
    expect(s.evidence.primary.confidence).not.toBe('high');
    expect(s.readings.map((r: any) => [r.source, r.status])).toEqual(expect.arrayContaining([['website', 'ok'], ['repository', 'ok'], ['logo', 'ok']]));
    expect(s.check.ok).toBe(true);

    // another collection and a second request do NOT fetch the sites again
    const second = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'bold_startup' }).expect(200)).body;
    expect(second.cached).toBe(true);
    expect(calls.website).toHaveLength(1);
    expect(calls.repository).toHaveLength(1);
    expect(second.suggestion.palette.primary).toBe('#0a5cff');
    // an explicit refresh does
    await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'bold_startup', refresh: true }).expect(200);
    expect(calls.website).toHaveLength(2);

    // the user's own edit is the highest tier: it wins and the user's color is kept on re-analysis
    const d = await newDesign(user, projectId, 'bold_startup');
    await user.agent.put(`/projects/${projectId}/design`).send({ ...d, palette: { ...d.palette, primary: '#123456' }, overridden: ['primary'] }).expect(200);
    const withUser = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'bold_startup', explicit: { primary: '#123456' } }).expect(200)).body.suggestion;
    // the edits the screen holds decide, not an older saved draft: a color that was reset does not come back
    const reset = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'bold_startup', explicit: {} }).expect(200)).body.suggestion;
    expect(reset.palette.primary).toBe('#0a5cff');
    expect(reset.evidence.primary.source).not.toBe('user');
    expect(withUser.palette.primary).toBe('#123456');
    expect(withUser.evidence.primary).toMatchObject({ source: 'user', confidence: 'high' });
    expect(paid()).toHaveLength(0);
  });

  it('PALETTE: a white page background is not the brand color; unreadable sources and missing sources fall back to the collection default, openly', async () => {
    const { user, projectId } = await readyUser('vs-pal2', { withKey: false, intake: { websiteUrl: 'https://plain.example' } });
    websiteReading = reading('website', 4, [['background', '#ffffff'], ['text', '#222222']], 'Website');
    const s = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'luxury_hospitality' }).expect(200)).body.suggestion;
    expect(s.palette.background).toBe('#ffffff');
    expect(s.palette.primary).not.toBe('#ffffff');
    expect(s.palette.primary).toBe(getCollection('luxury_hospitality')!.defaultPalette.primary);
    expect(s.evidence.primary).toMatchObject({ source: 'collection_default', confidence: 'low' });
    expect(s.fallbackRoles).toEqual(expect.arrayContaining(['primary', 'secondary', 'accent']));

    // nothing at all: the default palette and a plain note
    const bare = await readyUser('vs-pal3', { withKey: false });
    const b = (await bare.user.agent.post(`/projects/${bare.projectId}/design/palette`).send({ collectionId: 'dynamic_events' }).expect(200)).body.suggestion;
    expect(b.palette).toEqual(getCollection('dynamic_events')!.defaultPalette);
    expect(b.notes.join(' ')).toMatch(/collection default/i);
    expect(b.check.ok).toBe(true);
    expect(calls.website).toHaveLength(1); // only the project that has a website
    expect(calls.repository).toHaveLength(0);

    // a source that failed is listed with its reason and does not stop the rest
    websiteReading = { source: 'website', label: 'Website', status: 'blocked', message: 'robots.txt of https://plain.example does not allow it.', candidates: [] };
    const blocked = (await user.agent.post(`/projects/${projectId}/design/palette`).send({ collectionId: 'luxury_hospitality', refresh: true }).expect(200)).body.suggestion;
    expect(blocked.readings.find((r: any) => r.source === 'website')).toMatchObject({ status: 'blocked' });
    expect(blocked.readings.find((r: any) => r.source === 'website').message).toMatch(/robots/);
    expect(paid()).toHaveLength(0);
  });

  // ---- web visual discovery and licensed pictures ---------------------------------------------------------------------------------------------------

  it('DISCOVERY: licensed candidates and reference links are separate; Pinterest is a link only; blocked licenses never appear; references are never stored', async () => {
    const { user, projectId } = await readyUser('vs-disc', { withKey: false });
    const r = (await user.agent.post(`/projects/${projectId}/design/discover`).send({}).expect(200)).body;
    expect(r.providers.map((p: any) => [p.id, p.status])).toEqual([['pixabay', 'ok'], ['openverse', 'ok'], ['brave_images', 'ok']]);
    expect(r.intents.length).toBeGreaterThan(0);
    expect(r.licensed.every((c: any) => c.license.status !== 'blocked' && c.kind === 'LICENSED_STOCK')).toBe(true);
    expect(r.licensed.some((c: any) => c.provider === 'openverse' && c.id === 'nc1')).toBe(false); // NonCommercial never reaches the list
    const people = r.licensed.find((c: any) => c.id === '12');
    expect(people.license.status).toBe('needs_review'); // a person: never cleared automatically
    expect(r.licensed.find((c: any) => c.id === '11').license).toMatchObject({ status: 'cleared', attribution: 'Image by ocean_pic on Pixabay' });
    expect(r.licensed.find((c: any) => c.id === 'cc0').license.status).toBe('needs_review'); // Openverse does not verify licenses
    const pin = r.references.find((c: any) => c.pageUrl.includes('pinterest.com'));
    expect(pin).toMatchObject({ kind: 'REFERENCE_ONLY', thumbnailUrl: null, downloadUrl: null, platform: 'Pinterest: link only' });
    expect(r.references.every((c: any) => c.downloadUrl === null)).toBe(true);
    // stored for 24 hours as the picture providers require, WITHOUT the reference results
    const cached = (await user.agent.post(`/projects/${projectId}/design/discover`).send({}).expect(200)).body;
    expect(cached.cached).toBe(true);
    expect(cached.references).toEqual([]);
    expect(JSON.stringify(await db.visualDiscoveryRun.findMany({ where: { projectId } }))).not.toMatch(/pinterest\.com|Diving inspiration/);
    expect(paid()).toHaveLength(0);
    expect(calls.fetch.every((h) => ['pixabay.com', 'api.openverse.org', 'api.search.brave.com'].includes(h))).toBe(true);
  });

  it('LICENSED PICTURES: added only when chosen, with provenance and credit; a reference or an unchecked license cannot be added; the client never supplies an address', async () => {
    const { user, projectId } = await readyUser('vs-lic', { withKey: false });
    await user.agent.post(`/projects/${projectId}/design/discover`).send({}).expect(200);
    // a reference-only result is not in the licensed list, so it cannot be added at all
    await user.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'brave_images', id: 'whatever' }).expect(404);
    // a picture whose license needs a check is refused until the user confirms it
    const refused = await user.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'pixabay', id: '12' }).expect(422);
    expect(refused.body.code).toBe('review_required');
    expect(calls.download).toHaveLength(0);
    // a cleared picture is downloaded through the guarded downloader, stored as a project picture and recorded
    const added = (await user.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'pixabay', id: '11' }).expect(201)).body;
    expect(calls.download).toEqual(['https://pixabay.com/get/a_1280.jpg']);
    expect(added.asset).toMatchObject({ type: 'image', projectId });
    expect(added.provenance).toMatchObject({ provider: 'pixabay', providerImageId: '11', creator: 'ocean_pic', license: 'Pixabay Content License', licenseBasis: 'provider_license', attribution: 'Image by ocean_pic on Pixabay' });
    expect(added.provenance.sha256).toHaveLength(64);
    expect(added.credit).toMatch(/Image credits[\s\S]*Image by ocean_pic on Pixabay/);
    await user.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'pixabay', id: '11' }).expect(422); // already there
    const confirmedPerson = (await user.agent.post(`/projects/${projectId}/design/images`).send({ provider: 'pixabay', id: '12', reviewConfirmed: true }).expect(201)).body;
    expect(confirmedPerson.provenance.licenseBasis).toBe('user_reviewed');
    const list = (await user.agent.get(`/projects/${projectId}/design/images`).expect(200)).body;
    expect(list.items).toHaveLength(2);
    expect(list.credits).toMatch(/ocean_pic/);
    // the file exists and is a real picture; ownership holds
    const file = await user.agent.get(`/assets/${added.asset.id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((await sharp(file.body as Buffer).metadata()).width).toBe(1600);
    const stranger = await registerUser(app, 'vs-lic-x');
    await stranger.agent.get(`/assets/${added.asset.id}/file`).expect(404);
    expect(paid()).toHaveLength(0);
  });

  // ---- the free plan ---------------------------------------------------------------------------------------------------------------------------------

  it('PLAN: the design must be confirmed and readable; the plan shows collection, palette, formats and where pictures come from; nothing is spent', async () => {
    const { user, projectId } = await readyUser('vs-plan');
    const d = await newDesign(user, projectId, 'premium_editorial');
    const body = (design: unknown, extra: object = {}) => ({ preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE }, hybrid: { design, ...extra } });

    // not confirmed: a blocker with a plain reason, found before any approval
    const open = (await preflight(user, projectId, body({ ...d, formats: ['instagram_post'] })).expect(200)).body;
    expect(open.ok).toBe(false);
    expect(open.blockers.map((b: any) => b.code)).toContain('design_unconfirmed');
    expect(open.hybrid.design.collection).toMatchObject({ id: 'premium_editorial', name: 'Premium Editorial' });
    await startF(user, projectId, { ...HYBRID, hybrid: { design: { ...d, formats: ['instagram_post'] } } }).expect(422);

    // an unreadable palette is a blocker too
    const bad = (await preflight(user, projectId, body(confirmed(d, { palette: { ...d.palette, text: '#f1f1f1', background: '#ffffff' } }))).expect(200)).body;
    expect(bad.blockers.map((b: any) => b.code)).toContain('design_palette');

    // confirmed: no design blocker; the plan carries the design and the picture-source plan; the paid request count is exactly what was asked
    const good = (await preflight(user, projectId, body(confirmed(d))).expect(200)).body;
    expect(good.blockers.map((b: any) => b.code).filter((c: string) => c.startsWith('design_'))).toEqual([]);
    expect(good.hybrid.design.collection.name).toBe('Premium Editorial');
    expect(good.hybrid.design.formats.labels).toEqual(['Instagram post', 'Instagram story', 'Website banner']);
    expect(good.hybrid.design.sources).toMatchObject({ paidImageRequests: 5, mode: 'balanced' });
    expect(good.hybrid.originals.paidRequests).toBe(5);
    expect(good.hybrid.slots.map((s: any) => s.formatId).every((f: string) => ['instagram_square', 'instagram_portrait', 'story', 'web_banner', 'landing_hero'].includes(f))).toBe(true);
    expect(good.budget.required).toBe(true); // the ONE campaign budget is still required
    await startF(user, projectId, { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE }, hybrid: { design: confirmed(d) } }).expect(422); // no budget approved: refused

    // picture sources: the user's own pictures are used for the suggestion; the requested AI count is never changed by the plan
    for (let i = 0; i < 3; i++) await user.agent.post(`/projects/${projectId}/assets`).field('type', 'image').attach('files', await pngBuffer('#336699', `<rect width="${60 + i}" height="60" fill="#fff"/>`), { filename: `p${i}.png`, contentType: 'image/png' }).expect(201);
    const sources = (await preflight(user, projectId, body(confirmed(d, { imageSourcing: 'prefer_existing' }))).expect(200)).body.hybrid.design.sources;
    expect(sources.paidImageRequests).toBe(5);
    expect(sources.suggestions).toHaveLength(1);
    expect(sources.suggestions[0].set.originals).toBeLessThan(5);
    expect(sources.perConcept.every((c: any) => ['AI_GENERATED', 'USER_PROVIDED'].includes(c.picture))).toBe(true);

    // a campaign configured without a design keeps working exactly as before
    const legacy = (await preflight(user, projectId, { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(legacy.hybrid.design ?? null).toBeNull();
    expect(legacy.blockers.filter((b: any) => String(b.code).startsWith('design_'))).toEqual([]);
    // the free hybrid preview with a design also makes no OpenAI request and uses only the collection
    const beforeReq = fake.requests.length;
    const prev = (await user.agent.post(`/projects/${projectId}/hybrid/preview`).send(body(confirmed(d))).expect(200)).body;
    const lib = new Set(getCollection('premium_editorial')!.templateIds);
    expect(prev.selection.items.every((i: any) => lib.has(i.templateId))).toBe(true);
    expect(prev.selection.collection).toMatchObject({ id: 'premium_editorial' });
    expect(prev.visualDirection.brief.origin).toBe('user_approved');
    expect(prev.visualDirection.brief.colors.primary).toBe(d.palette.primary);
    expect(paid()).toHaveLength(0); // the plan review only lists models (free); no text or image request exists
    expect(fake.requests.length - beforeReq).toBe(0); // and the free preview sends nothing at all, not even the model list
  });

  // ---- a full mocked run -----------------------------------------------------------------------------------------------------------------------------

  it('FULL RUN with the approved design: 5 AI originals + 15 template creatives inside the collection, lineage, ZIP, persistence, continuation after a failure', async () => {
    const { user, projectId } = await readyUser('vs-full');
    const d = await newDesign(user, projectId, 'clean_ecommerce');
    const design = confirmed({ ...d, palette: { ...d.palette, primary: '#0b6e4f', accent: '#e4572e' }, overridden: ['primary', 'accent'], paletteEvidence: { ...d.paletteEvidence, primary: { source: 'user', confidence: 'high', evidence: 'Chosen by you' }, accent: { source: 'user', confidence: 'high', evidence: 'Chosen by you' } } });
    await useFake({ reply: ((r: FakeRequest): FakeReply | undefined => (r.kind === 'image' && [2, 4].includes(r.attempt) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'rejected', type: 'invalid_request_error' } } } : undefined)) as FakeOpenAIOptions['reply'] });
    const started = (await startF(user, projectId, { ...HYBRID, hybrid: { design } }).expect(201)).body;
    const run = await waitF(user, started.id);
    expect(['completed', 'partial']).toContain(run.status);
    // the design is part of the run: it survives refreshes, and is exactly what was approved
    const reload = (await user.agent.get(`/factory-runs/${started.id}`).expect(200)).body;
    expect(reload.config.settings.hybrid.design).toMatchObject({ collectionId: 'clean_ecommerce', confirmed: true, palette: { primary: '#0b6e4f', accent: '#e4572e' } });
    expect(fake.imageCalls().length).toBeLessThanOrEqual(5); // never more than the 5 requested originals (2 of them were refused)
    const campaign = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const h = campaign.package.hybrid;
    expect(h.settings.design.collectionId).toBe('clean_ecommerce');
    const collection = getCollection('clean_ecommerce')!;
    expect(h.selection.collection.id).toBe('clean_ecommerce');
    for (const it of h.selection.items) expect(collection.templateIds).toContain(it.templateId);
    for (const t of h.creatives.filter((x: any) => x.status === 'rendered')) expect(t).toMatchObject({ collectionId: 'clean_ecommerce', origin: 'TEMPLATE_RENDERED' });
    expect(h.direction.origin).toMatch(/user_approved|model_refined/);
    expect(h.direction.colors.primary).toBe('#0b6e4f');
    expect(h.counts.originals.requested).toBeLessThanOrEqual(5);

    // the export carries the design
    const res = await user.agent.get(`/campaigns/${run.campaignId}/export`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const exported = JSON.parse(await zip.file('design/campaign-design.json')!.async('string'));
    expect(exported).toMatchObject({ collectionId: 'clean_ecommerce', palette: { primary: '#0b6e4f' } });
    expect(Object.keys(zip.files).some((n) => /pinterest/i.test(n))).toBe(false);
    expect(await zip.file('campaign.json')!.async('string')).not.toMatch(/pinterest\.com/i);

    // the missing originals are completed WITHOUT choosing another design
    if (h.counts.total.delivered < 20) {
      await useFake();
      const pre = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({ approvedBudgetUsd: 2 }).expect(200)).body;
      expect(pre.ok).toBe(true);
      const cont = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 2, confirmCost: true }).expect(201)).body;
      const end = Date.now() + 300_000;
      let row: any;
      for (;;) {
        row = (await user.agent.get(`/runs/${cont.id}`).expect(200)).body;
        if (row.status !== 'RUNNING') break;
        if (Date.now() > end) throw new Error('continuation still running');
        await sleep(150);
      }
      expect(row.status).toBe('COMPLETED');
      const done = (await user.agent.get(`/campaigns/${row.campaignId}`).expect(200)).body;
      expect(done.package.hybrid.settings.design.collectionId).toBe('clean_ecommerce');
      expect(done.package.hybrid.creatives.every((t: any) => !t.collectionId || t.collectionId === 'clean_ecommerce')).toBe(true);
      expect(fake.imageCalls().length).toBeLessThanOrEqual(2);
    }
    // the draft of the project is untouched by the run
    expect((await user.agent.get(`/projects/${projectId}/design`).expect(200)).body.draft).toBeNull();
  });
});
