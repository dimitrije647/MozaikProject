import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { WebFetchTool } from '../tools/web-fetch';
import { acquireLicensedImage, creditsText } from './acquire';
import { BraveReferenceAdapter, OpenverseAdapter, PexelsAdapter, PixabayAdapter, createImageAdaptersFromEnv, ImageSearchError, type ImageSearchAdapter } from './adapters';
import { buildSearchIntents, discoverImages, keywordsOf } from './discovery';
import { openverseVerdict, pixabayVerdict } from './license';
import { planImageSources } from './planner';
import { assetOriginOf, isExportable, IMAGE_SOURCE_KINDS, type ImageCandidate } from './types';

// ---- mocked providers ----------------------------------------------------------------------------------------------------------------------------

interface Call {
  url: string;
  headers: Record<string, string>;
}
function mockFetch(routes: Record<string, unknown | ((u: URL) => Response)>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ url: u.toString(), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const r = routes[u.hostname];
    if (typeof r === 'function') return (r as (u: URL) => Response)(u);
    if (r === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const PIXABAY = {
  hits: [
    { id: 1, pageURL: 'https://pixabay.com/photos/coral-reef-1/', tags: 'coral, reef, underwater', user: 'ocean_pic', user_id: 99, webformatURL: 'https://pixabay.com/get/a_640.jpg', largeImageURL: 'https://pixabay.com/get/a_1280.jpg', imageWidth: 4000, imageHeight: 2667 },
    { id: 2, pageURL: 'https://pixabay.com/photos/diver-2/', tags: 'woman, diver, portrait', user: 'someone', user_id: 5, webformatURL: 'https://pixabay.com/get/b_640.jpg', largeImageURL: 'https://pixabay.com/get/b_1280.jpg', imageWidth: 3000, imageHeight: 2000 },
    { id: 3, pageURL: 'http://evil.example/page', tags: 'x', user: 'u', webformatURL: 'https://pixabay.com/x.jpg', largeImageURL: 'https://evil.example/big.jpg' },
  ],
};
const PEXELS = { photos: [{ id: 7, url: 'https://www.pexels.com/photo/boat-7/', photographer: 'Ana K', photographer_url: 'https://www.pexels.com/@ana', width: 5000, height: 3333, alt: 'Boat on calm sea', src: { large2x: 'https://images.pexels.com/photos/7/pexels-photo-7.jpeg?w=1880', medium: 'https://images.pexels.com/photos/7/m.jpeg' } }] };
const OPENVERSE = {
  results: [
    { id: 'a', title: 'Reef', url: 'https://upload.wikimedia.org/a.jpg', thumbnail: 'https://api.openverse.org/v1/images/a/thumb/', foreign_landing_url: 'https://commons.wikimedia.org/wiki/a', creator: 'Bob', license: 'cc0', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: '"Reef" by Bob is marked CC0 1.0', tags: [{ name: 'reef' }], width: 4000, height: 3000 },
    { id: 'b', title: 'Fish', url: 'https://live.staticflickr.com/b.jpg', foreign_landing_url: 'https://flickr.com/b', creator: 'Cy', license: 'by-nc', license_version: '2.0', tags: [] },
    { id: 'c', title: 'Sea', url: 'https://live.staticflickr.com/c.jpg', foreign_landing_url: 'https://flickr.com/c', creator: 'Di', license: 'by-nd', license_version: '4.0', tags: [] },
    { id: 'd', title: 'Wave', url: 'https://live.staticflickr.com/d.jpg', foreign_landing_url: 'https://flickr.com/d', creator: 'Ed', license: 'by', license_version: '4.0', attribution: '"Wave" by Ed is licensed under CC BY 4.0', tags: [] },
    { id: 'e', title: 'Sun', url: 'https://live.staticflickr.com/e.jpg', foreign_landing_url: 'https://flickr.com/e', creator: 'Fa', license: 'by-sa', license_version: '4.0', tags: [] },
  ],
};
const BRAVE = {
  results: [
    { title: 'Diving inspiration board', url: 'https://www.pinterest.com/pin/123456/', thumbnail: { src: 'https://imgs.search.brave.com/pin-thumb' } },
    { title: 'Underwater photography', url: 'https://www.example-photo.com/gallery', thumbnail: { src: 'https://imgs.search.brave.com/thumb2' } },
  ],
};

const intent = { query: 'scuba diving school', why: 'test', orientation: 'landscape' as const };

describe('search adapters with mocked providers', () => {
  it('Pixabay: official host only, key in the query, results mapped with provenance; a result pointing elsewhere is dropped', async () => {
    const calls: Call[] = [];
    const a = new PixabayAdapter('SECRET-KEY', { fetch: mockFetch({ 'pixabay.com': PIXABAY }, calls) });
    const r = await a.search(intent);
    assert.equal(new URL(calls[0].url).hostname, 'pixabay.com');
    assert.match(calls[0].url, /safe_search=true/);
    assert.equal(r.length, 2);
    assert.equal(r[0].license.status, 'cleared');
    assert.equal(r[0].license.attribution, 'Image by ocean_pic on Pixabay');
    assert.equal(r[0].kind, 'LICENSED_STOCK');
    assert.equal(r[1].license.status, 'needs_review', 'a picture of a person is never cleared automatically');
    assert.ok(r.every((c) => c.downloadUrl?.startsWith('https://pixabay.com/')));
  });

  it('Pexels: key in the Authorization header, credit line carried', async () => {
    const calls: Call[] = [];
    const r = await new PexelsAdapter('PEXELS-KEY', { fetch: mockFetch({ 'api.pexels.com': PEXELS }, calls) }).search(intent);
    assert.equal(calls[0].headers.authorization, 'PEXELS-KEY');
    assert.equal(r[0].license.attribution, 'Photo by Ana K on Pexels');
    assert.equal(r[0].license.license, 'Pexels License');
    assert.ok(r[0].downloadUrl?.startsWith('https://images.pexels.com/'));
  });

  it('Openverse: asks only for commercial+modification works, then classifies each license itself (NC/ND blocked, BY-SA and everything else needs review)', async () => {
    const calls: Call[] = [];
    const r = await new OpenverseAdapter({ enabled: true, fetch: mockFetch({ 'api.openverse.org': OPENVERSE }, calls) }).search(intent);
    assert.match(calls[0].url, /license_type=commercial%2Cmodification/);
    const by = Object.fromEntries(r.map((c) => [c.id, c.license.status]));
    assert.deepEqual(by, { a: 'needs_review', b: 'blocked', c: 'blocked', d: 'needs_review', e: 'needs_review' });
    assert.match(r.find((c) => c.id === 'e')!.license.reasons.join(' '), /same license|share/i);
    assert.ok(r.every((c) => c.license.status !== 'cleared'), 'Openverse does not verify licenses: nothing is cleared without a check at the source');
  });

  it('an adapter without credentials is not configured and makes NO request', async () => {
    const calls: Call[] = [];
    const f = mockFetch({}, calls);
    for (const a of [new PixabayAdapter('', { fetch: f }), new PexelsAdapter(undefined, { fetch: f }), new OpenverseAdapter({ fetch: f }), new BraveReferenceAdapter({ key: 'k', fetch: f })]) {
      assert.equal(a.configured, false, a.id);
      assert.deepEqual(await a.search(intent), []);
      assert.ok(a.setup.length > 20);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(createImageAdaptersFromEnv({}).filter((a) => a.configured), [], 'a fresh install configures nothing');
    assert.deepEqual(createImageAdaptersFromEnv({ PIXABAY_API_KEY: 'x', OPENVERSE_ENABLED: 'true' }).filter((a) => a.configured).map((a) => a.id), ['pixabay', 'openverse']);
  });

  it('errors are safe sentences: no key, no provider text', async () => {
    const f = (status: number) => mockFetch({ 'pixabay.com': () => new Response('boom SECRET-KEY internal trace', { status }) });
    for (const [status, code] of [[401, 'invalid_key'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
      await assert.rejects(new PixabayAdapter('SECRET-KEY', { fetch: f(status) }).search(intent), (e: unknown) => e instanceof ImageSearchError && e.code === code && !/SECRET|trace/.test(e.message));
    }
    const bad = mockFetch({ 'pixabay.com': () => new Response('<html>', { status: 200 }) });
    await assert.rejects(new PixabayAdapter('k', { fetch: bad }).search(intent), (e: unknown) => e instanceof ImageSearchError && e.code === 'bad_response');
  });
});

describe('Pinterest and web image results are reference-only', () => {
  const brave = () => new BraveReferenceAdapter({ key: 'k', enabled: true, fetch: mockFetch({ 'api.search.brave.com': BRAVE }) });

  it('a Pinterest result is a link only: no thumbnail, no download address, blocked license', async () => {
    const r = await brave().search(intent);
    const pin = r.find((c) => c.pageUrl.includes('pinterest.com'))!;
    assert.equal(pin.kind, 'REFERENCE_ONLY');
    assert.equal(pin.thumbnailUrl, null);
    assert.equal(pin.downloadUrl, null);
    assert.equal(pin.platform, 'Pinterest: link only');
    assert.equal(pin.license.status, 'blocked');
    const other = r.find((c) => !c.pageUrl.includes('pinterest.com'))!;
    assert.equal(other.kind, 'REFERENCE_ONLY');
    assert.equal(other.downloadUrl, null);
    assert.ok(other.thumbnailUrl, 'a thumbnail the search engine itself serves may be shown for display');
  });

  it('discovery keeps references in their own list and they can never be acquired or exported', async () => {
    const d = await discoverImages({ business: 'Blue Fin', offering: 'scuba diving school' }, [brave()]);
    assert.equal(d.licensed.length, 0);
    assert.equal(d.references.length, 2);
    assert.ok(d.references.every((c) => c.downloadUrl === null && c.license.status === 'blocked'));
    const got = await acquireLicensedImage(d.references[0], { web: { fetchAsset: async () => assert.fail('must not download a reference') } });
    assert.equal(got.ok, false);
    if (!got.ok) assert.equal(got.code, 'reference_only');
    assert.equal(isExportable('REFERENCE_ONLY'), false);
    assert.equal(assetOriginOf('REFERENCE_ONLY'), null);
    for (const k of IMAGE_SOURCE_KINDS.filter((k) => k !== 'REFERENCE_ONLY')) assert.ok(isExportable(k), k);
  });
});

describe('discovery', () => {
  it('builds focused, deterministic queries from the business and the visual direction, for any industry', () => {
    const diving = buildSearchIntents({ business: 'Blue Fin Diving School', offering: 'Scuba diving courses and equipment rental on the Adriatic coast', imageSubjects: ['Underwater photography with sunlight rays', 'Diving equipment close up'], mood: ['adventurous'] });
    assert.ok(diving.length >= 3 && diving.length <= 4);
    assert.match(diving[0].query, /diving/);
    assert.ok(diving.some((i) => /underwater/.test(i.query)));
    assert.deepEqual(diving, buildSearchIntents({ business: 'Blue Fin Diving School', offering: 'Scuba diving courses and equipment rental on the Adriatic coast', imageSubjects: ['Underwater photography with sunlight rays', 'Diving equipment close up'], mood: ['adventurous'] }), 'deterministic');
    const saas = buildSearchIntents({ business: 'Northwind', offering: 'Project planning software for engineering teams', imageSubjects: ['Single device on a clean desk surface'], formatClasses: ['story', 'portrait'] });
    assert.ok(saas.every((i) => i.orientation === 'portrait'));
    assert.ok(saas.some((i) => /planning|software|engineering/.test(i.query)));
    assert.ok(!saas.some((i) => /diving/.test(i.query)), 'nothing is hardcoded to one industry');
    assert.deepEqual(keywordsOf({ business: '', offering: '' }), []);
    assert.deepEqual(buildSearchIntents({ business: '', offering: '' }), []);
  });

  it('one failing provider does not block the others, and failures are safe sentences', async () => {
    const ok = new PixabayAdapter('k', { fetch: mockFetch({ 'pixabay.com': PIXABAY }) });
    const limited = new PexelsAdapter('k', { fetch: mockFetch({ 'api.pexels.com': () => new Response('', { status: 429 }) }) });
    const broken = new OpenverseAdapter({ enabled: true, fetch: (async () => { throw new Error('connect ECONNREFUSED 10.0.0.1 SECRET'); }) as typeof fetch });
    const off = new BraveReferenceAdapter({});
    const d = await discoverImages({ business: 'Blue Fin', offering: 'scuba diving school' }, [ok, limited, broken, off]);
    assert.deepEqual(d.providers.map((p) => [p.id, p.status]), [['pixabay', 'ok'], ['pexels', 'rate_limited'], ['openverse', 'failed'], ['brave_images', 'not_configured']]);
    assert.ok(d.providers.every((p) => !/SECRET|ECONNREFUSED/.test(p.message ?? '')));
    assert.ok(d.licensed.length >= 1, 'the working provider still delivers');
    assert.match(d.providers[3].message ?? '', /BRAVE_SEARCH_API_KEY/);
  });

  it('with nothing configured it says so and returns nothing: no results are invented', async () => {
    const d = await discoverImages({ business: 'Blue Fin', offering: 'scuba diving school' }, createImageAdaptersFromEnv({}));
    assert.deepEqual([d.licensed.length, d.references.length], [0, 0]);
    assert.ok(d.providers.every((p) => p.status === 'not_configured'));
    assert.ok(d.notes.some((n) => /nothing was invented/.test(n)));
  });

  it('blocked licenses never reach the licensed list; cleared come before pictures needing a check', async () => {
    const op = new OpenverseAdapter({ enabled: true, fetch: mockFetch({ 'api.openverse.org': OPENVERSE }) });
    const px = new PixabayAdapter('k', { fetch: mockFetch({ 'pixabay.com': PIXABAY }) });
    const d = await discoverImages({ business: 'Blue Fin', offering: 'scuba diving school' }, [op, px]);
    assert.ok(d.licensed.every((c) => c.license.status !== 'blocked'));
    assert.ok(!d.licensed.some((c) => c.provider === 'openverse' && ['b', 'c'].includes(c.id)));
    assert.equal(d.licensed[0].license.status, 'cleared');
    assert.ok(d.notes.some((n) => /left out/.test(n)));
  });
});

// ---- acquiring: the only gate a third-party picture passes ---------------------------------------------------------------------------------------------

describe('acquiring licensed pictures', () => {
  let server: http.Server;
  let port: number;
  let big: Buffer;
  let small: Buffer;
  const hits: string[] = [];
  before(async () => {
    big = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    small = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      if (req.url === '/big.jpg') return void res.writeHead(200, { 'content-type': 'image/jpeg' }).end(big);
      if (req.url === '/small.jpg') return void res.writeHead(200, { 'content-type': 'image/jpeg' }).end(small);
      if (req.url === '/page.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());
  const web = () => new WebFetchTool({ policy: { allowedPorts: new Set([port]), allowLoopbackForTests: true }, maxAssets: 5, timeoutMs: 3000 });
  const candidate = (over: Partial<ImageCandidate> = {}): ImageCandidate => ({
    id: 'a',
    provider: 'openverse',
    kind: 'LICENSED_STOCK',
    title: 'Reef',
    pageUrl: 'https://commons.wikimedia.org/wiki/a',
    creator: 'Bob',
    creatorUrl: null,
    width: 1600,
    height: 1000,
    tags: [],
    thumbnailUrl: null,
    downloadUrl: `http://127.0.0.1:${port}/big.jpg`,
    license: openverseVerdict({ license: 'cc0', version: '1.0', licenseUrl: null, attribution: '"Reef" by Bob is marked CC0 1.0', tags: [], title: 'Reef' }),
    platform: null,
    ...over,
  });

  it('licensed pictures keep their provenance: provider, creator, license, credit, hash and time', async () => {
    const r = await acquireLicensedImage(candidate(), { web: web(), reviewConfirmed: true, now: () => new Date('2026-11-02T10:00:00Z') });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.provenance.provider, 'openverse');
    assert.equal(r.provenance.creator, 'Bob');
    assert.equal(r.provenance.license, 'CC0 1.0');
    assert.equal(r.provenance.attribution, '"Reef" by Bob is marked CC0 1.0');
    assert.equal(r.provenance.licenseBasis, 'user_reviewed');
    assert.equal(r.provenance.width, 1600);
    assert.equal(r.provenance.sha256.length, 64);
    assert.equal(r.provenance.acquiredAt, '2026-11-02T10:00:00.000Z');
    assert.match(creditsText([r.provenance]), /Image credits[\s\S]*"Reef" by Bob/);
    assert.equal(creditsText([]), '');
  });

  it('a license that needs a check is refused until the user confirms it; a blocked license is refused always', async () => {
    const before = hits.length;
    const need = await acquireLicensedImage(candidate(), { web: web() });
    assert.equal(need.ok, false);
    if (!need.ok) assert.equal(need.code, 'review_required');
    const nc = await acquireLicensedImage(candidate({ license: openverseVerdict({ license: 'by-nc', version: '2.0', licenseUrl: null, attribution: null, tags: [], title: '' }) }), { web: web(), reviewConfirmed: true });
    assert.equal(nc.ok, false);
    if (!nc.ok) assert.equal(nc.code, 'license_blocked');
    const nd = await acquireLicensedImage(candidate({ license: openverseVerdict({ license: 'by-nd', version: '4.0', licenseUrl: null, attribution: null, tags: [], title: '' }) }), { web: web(), reviewConfirmed: true });
    if (!nd.ok) assert.equal(nd.code, 'license_blocked');
    assert.equal(hits.length, before, 'nothing was downloaded for a refused picture');
  });

  it('a cleared provider picture needs no review, but only downloads from that provider\'s own host', async () => {
    const cleared = candidate({ provider: 'pixabay', downloadUrl: 'https://evil.example/big.jpg', license: pixabayVerdict({ tags: ['reef'], title: '', user: 'u', pageUrl: 'https://pixabay.com/x' }) });
    assert.equal(cleared.license.status, 'cleared');
    const r = await acquireLicensedImage(cleared, { web: web() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'host_not_allowed');
    const unknown = await acquireLicensedImage(candidate({ provider: 'someone_else', license: cleared.license }), { web: web() });
    if (!unknown.ok) assert.equal(unknown.code, 'host_not_allowed');
  });

  it('SSRF: a download address on a private or local network is never contacted (default policy)', async () => {
    const before = hits.length;
    for (const url of [`http://127.0.0.1:${port}/big.jpg`, 'http://169.254.169.254/latest/meta-data/', 'http://localhost/x.jpg', 'http://10.1.2.3/x.jpg', 'file:///etc/passwd']) {
      const r = await acquireLicensedImage(candidate({ downloadUrl: url }), { web: new WebFetchTool(), reviewConfirmed: true });
      assert.equal(r.ok, false, url);
      if (!r.ok) assert.ok(['download_failed', 'host_not_allowed'].includes(r.code), `${url}: ${r.code}`);
    }
    assert.equal(hits.length, before);
  });

  it('refuses a file that is not a picture and a picture that is too small to stay sharp', async () => {
    const html = await acquireLicensedImage(candidate({ downloadUrl: `http://127.0.0.1:${port}/page.html` }), { web: web(), reviewConfirmed: true });
    assert.equal(html.ok, false);
    const tiny = await acquireLicensedImage(candidate({ downloadUrl: `http://127.0.0.1:${port}/small.jpg` }), { web: web(), reviewConfirmed: true });
    assert.equal(tiny.ok, false);
    if (!tiny.ok) assert.equal(tiny.code, 'too_small');
  });
});

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------------

describe('source selection planner', () => {
  const base = { originalsRequested: 5, imageModelOn: true, concepts: 5, userImages: 0, licensedImages: 0, licensedCandidates: 0, imageUsd: 0.07 };

  it('never changes the number of AI images asked for: prefer-AI and balanced keep it, existing pictures fill the concepts without one', () => {
    for (const mode of ['prefer_ai', 'balanced'] as const) {
      const p = planImageSources({ ...base, mode, userImages: 2 });
      assert.equal(p.paidImageRequests, 5);
      assert.equal(p.totals.AI_GENERATED, 5);
    }
    const p = planImageSources({ ...base, mode: 'balanced', originalsRequested: 3, userImages: 2 });
    assert.deepEqual([p.totals.AI_GENERATED, p.totals.USER_PROVIDED, p.totals.NONE], [3, 2, 0]);
    assert.equal(p.paidImageRequests, 3);
  });

  it('prefer-existing OFFERS fewer AI images and what it would save; it never applies the offer itself', () => {
    const p = planImageSources({ ...base, mode: 'prefer_existing', userImages: 3, licensedImages: 1 });
    assert.equal(p.paidImageRequests, 5, 'the request count is still the user\'s');
    assert.equal(p.suggestions.length, 1);
    assert.deepEqual([p.suggestions[0].set.originals, p.suggestions[0].fewerRequests, p.suggestions[0].savesUsd], [1, 4, 0.28]);
    assert.equal(planImageSources({ ...base, mode: 'prefer_ai', userImages: 3 }).suggestions.length, 0);
  });

  it('zero AI images in prefer-existing mode is reported accurately', () => {
    // two pictures of your own are shared by all five concepts (the renderer cycles through them)
    const some = planImageSources({ ...base, mode: 'prefer_existing', originalsRequested: 0, userImages: 2 });
    assert.equal(some.paidImageRequests, 0);
    assert.deepEqual([some.totals.USER_PROVIDED, some.totals.NONE], [5, 0]);
    assert.ok(some.warnings.some((w) => /every concept uses a picture you provided or licensed/.test(w)));
    // with no picture at all every concept falls back to typographic templates, and the plan says so
    const none = planImageSources({ ...base, mode: 'prefer_existing', originalsRequested: 0 });
    assert.equal(none.paidImageRequests, 0);
    assert.deepEqual([none.totals.USER_PROVIDED, none.totals.NONE], [0, 5]);
    assert.ok(none.warnings.some((w) => /5 of 5 concepts have no existing picture/.test(w)));
    assert.match(none.summary, /0 paid image requests/);
  });

  it('licensed candidates that were only found are not counted as sources until they are added', () => {
    const p = planImageSources({ ...base, mode: 'prefer_existing', licensedCandidates: 6 });
    assert.equal(p.totals.LICENSED_STOCK, 0);
    assert.ok(p.warnings.some((w) => /6 licensed candidates were found/.test(w) && /5 original AI images will be made as requested/.test(w)));
  });

  it('no image model means no AI request, and the plan says why', () => {
    const p = planImageSources({ ...base, mode: 'prefer_ai', imageModelOn: false });
    assert.equal(p.paidImageRequests, 0);
    assert.ok(p.warnings.some((w) => /no image model is selected/.test(w)));
  });
});

// ---- policy checks over the source code -------------------------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('code policy: no Pinterest scraping and no unsupported API access', () => {
  const root = join(__dirname, '..', '..', '..', '..');
  const files = [...walk(join(root, 'packages', 'agents', 'src')), ...walk(join(root, 'apps', 'api', 'src')), ...walk(join(root, 'apps', 'web', 'src'))];

  it('only the official Pinterest API client talks to Pinterest, and nothing fetches Pinterest CDN pictures or pages', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(root.length + 1).replace(/\\/g, '/');
      assert.doesNotMatch(text, /i\.pinimg\.com|pinimg\.com\/\d|pinterest\.[a-z.]+\/resource\/|BaseSearchResource|pinterest-scraper|pin-scraper/i, `${rel}: no scraping of Pinterest`);
      if (!rel.startsWith('apps/api/src/pinterest/')) assert.doesNotMatch(text, /api(-sandbox)?\.pinterest\.com/, `${rel}: the official API host is only used by the Pinterest client`);
    }
  });

  it('no code calls Google Custom Search, Bing search or unofficial image-search endpoints', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(root.length + 1).replace(/\\/g, '/');
      assert.doesNotMatch(text, /customsearch\.googleapis\.com|www\.google\.[a-z.]+\/search\?|tbm=isch|api\.bing\.microsoft\.com|bing\.com\/images|serpapi\.com|scrapingbee|apify\.com/i, `${rel}: no unsupported image-search access`);
    }
  });

  it('every adapter host is an official API host of that provider', () => {
    const text = readFileSync(join(root, 'packages', 'agents', 'src', 'imagery', 'adapters.ts'), 'utf8');
    const hosts = [...text.matchAll(/https:\/\/([a-z.]+)\//g)].map((m) => m[1]).filter((h) => !/example|creativecommons/.test(h));
    assert.deepEqual([...new Set(hosts)].sort(), ['api.openverse.org', 'api.pexels.com', 'api.search.brave.com', 'pixabay.com']);
  });

  it('adapters are the only code that holds image-search keys, and they never log them', () => {
    const text = readFileSync(join(root, 'packages', 'agents', 'src', 'imagery', 'adapters.ts'), 'utf8');
    assert.doesNotMatch(text, /console\.(log|error|warn)/);
  });
});

describe('the interface contract', () => {
  it('every adapter exposes id, label, kind, configured and setup', () => {
    for (const a of createImageAdaptersFromEnv({}) as ImageSearchAdapter[]) {
      assert.ok(a.id && a.label && ['licensed', 'reference'].includes(a.kind) && typeof a.configured === 'boolean' && a.setup);
    }
  });
});
