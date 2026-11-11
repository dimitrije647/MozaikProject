import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { OpenAIClient } from '../ai/openai-http';
import { ImageGenerator } from '../ai/openai-images';
import { ProviderError } from '../ai/errors';
import { HybridSettings, NO_AI_PRESET, HYBRID_PRESET, isNoAi, mergeHybrid } from '../hybrid/settings';
import { WebFetchTool } from '../tools/web-fetch';
import { allocateImages } from './allocate';
import { analyzeImage, hammingDistance, isNearDuplicate } from './analysis';
import { ImageSearchError, type ImageSearchAdapter } from './adapters';
import { buildSearchIntents, discoverImages } from './discovery';
import { classifyRepoImage, discoverRepositoryImages, pickRepoImages } from './repo-images';
import { approveRights, attestRights, candidateRights, confirmReview, exportEligibility, socialRights, stockRights, uploadRights } from './rights';
import { rankImages, scoreImage, type ScoreContext, type ScoreSubject } from './scoring';
import { describeSocialSources } from './social-sources';
import { bestOfSrcset, discoverWebsiteImages, imageStem, imagesOfHtml } from './website-images';
import { pexelsVerdict, pixabayVerdict, referenceVerdict } from './license';
import type { ImageCandidate } from './types';

// ---- helpers: small deterministic pictures --------------------------------------------------------------------------------------------------------

async function picture(seed: number, o: { w?: number; h?: number } = {}): Promise<Buffer> {
  const w = o.w ?? 1600;
  const h = o.h ?? 1200;
  const hue = (seed * 67) % 360;
  const shapes = Array.from({ length: 5 }, (_, i) => `<circle cx="${(seed * 131 + i * 307) % w}" cy="${(seed * 89 + i * 211) % h}" r="${60 + ((seed + i) * 37) % 180}" fill="hsl(${(hue + i * 55) % 360},70%,${30 + i * 8}%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,25%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},60%,65%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const subject = (id: string, o: Partial<ScoreSubject> = {}): ScoreSubject => ({ id, text: 'diving school coral reef', width: 2000, height: 1400, source: 'upload', rights: uploadRights(), ...o });
const ctx: ScoreContext = { businessWords: ['diving', 'school', 'coral'], collectionId: 'premium_editorial', formatClasses: ['square', 'portrait'], palette: ['#0b6e4f', '#e4572e'] };

const candidate = (id: string, o: Partial<ImageCandidate> = {}): ImageCandidate => ({
  id,
  provider: 'pixabay',
  kind: 'LICENSED_STOCK',
  title: `Picture ${id}`,
  pageUrl: `https://pixabay.com/photos/${id}/`,
  creator: `maker-${id}`,
  creatorUrl: null,
  width: 1920,
  height: 1280,
  tags: ['diving', 'ocean'],
  thumbnailUrl: null,
  downloadUrl: `https://pixabay.com/get/${id}.jpg`,
  license: pixabayVerdict({ tags: ['diving'], title: id, user: 'maker', pageUrl: '' }),
  platform: null,
  ...o,
});

describe('NO AI HYBRID: the rights gate is a hard gate', () => {
  it('an upload is eligible; a website or repository candidate is not until the owner attests', () => {
    assert.equal(exportEligibility(uploadRights()).eligible, true);
    for (const source of ['website', 'github'] as const) {
      const c = candidateRights(source);
      assert.equal(exportEligibility(c).eligible, false, `${source}: a candidate is not usable`);
      assert.match(exportEligibility(c).reason, /Confirm that you hold the rights/);
      const a = attestRights(c, { at: new Date('2026-11-03T10:00:00Z') });
      assert.equal(exportEligibility(a).eligible, true);
      assert.equal(a.verification, 'user_attested');
      assert.equal(a.attestedAt, '2026-11-03T10:00:00.000Z');
    }
  });

  it('approval alone never overrides a license: a blocked picture and a reference link stay unusable however they are approved or attested', () => {
    const blocked = stockRights({ ...pixabayVerdict({ tags: [], title: 'x', user: null, pageUrl: '' }), status: 'blocked', commercialUse: false }, { userApproved: true });
    assert.equal(exportEligibility(approveRights(blocked, true)).eligible, false);
    const ref = stockRights({ ...referenceVerdict('Pinterest') }, { userApproved: true });
    assert.equal(exportEligibility(ref).eligible, false);
    const social = socialRights('instagram');
    assert.equal(exportEligibility(social).eligible, false);
    assert.equal(exportEligibility(attestRights(social, { at: new Date() })).eligible, false, 'a social link cannot be attested into an asset');
    assert.equal(exportEligibility(approveRights(social, true)).eligible, false);
  });

  it('stock: a cleared license is eligible once approved; a license that needs a check only after the user confirmed it', () => {
    const cleared = stockRights(pixabayVerdict({ tags: ['ocean'], title: 'x', user: 'ann', pageUrl: '' }), { userApproved: true });
    assert.equal(exportEligibility(cleared).eligible, true);
    assert.equal(cleared.redistributeOriginal, false, 'Pixabay does not allow handing the unaltered file on');
    assert.equal(exportEligibility(stockRights(pixabayVerdict({ tags: ['ocean'], title: 'x', user: 'ann', pageUrl: '' }), { userApproved: false })).eligible, false, 'not approved yet');
    const people = stockRights(pexelsVerdict({ tags: ['woman', 'portrait'], title: 'x', photographer: 'Bo' }), { userApproved: true });
    assert.equal(people.status, 'needs_review');
    assert.equal(exportEligibility(people).eligible, false);
    assert.equal(exportEligibility(confirmReview(people)).eligible, true);
  });
});

describe('NO AI HYBRID: deterministic scoring and ranking', () => {
  it('the same inputs give the same order, whatever order they arrive in', () => {
    const items = [subject('c', { text: 'unrelated mountain', width: 1000, height: 700 }), subject('a'), subject('b', { text: 'diving coral', width: 1800, height: 1200 })];
    const one = rankImages(items, ctx, { stage: 'selection' }).ranked.map((r) => r.id);
    const two = rankImages([...items].reverse(), ctx, { stage: 'selection' }).ranked.map((r) => r.id);
    assert.deepEqual(one, two);
    assert.equal(JSON.stringify(scoreImage(items[1], ctx)), JSON.stringify(scoreImage(items[1], ctx)));
  });

  it('a better looking picture without rights NEVER outranks a worse one with rights', () => {
    const perfectButBlocked = subject('blocked', { text: 'diving school coral reef diving', width: 4000, height: 3000, source: 'stock', rights: stockRights({ ...pixabayVerdict({ tags: [], title: 'x', user: null, pageUrl: '' }), status: 'blocked', commercialUse: false }, { userApproved: true }) });
    const needsAttestation = subject('web', { source: 'website', rights: candidateRights('website'), text: 'diving school coral reef' });
    const mediocreButCleared = subject('own', { text: 'a harbour', width: 1000, height: 700 });
    const sel = rankImages([perfectButBlocked, needsAttestation, mediocreButCleared], ctx, { stage: 'selection' });
    assert.deepEqual(sel.ranked.map((r) => r.id), ['own'], 'only the cleared picture is in the selection');
    assert.deepEqual(sel.excluded.map((e) => e.id).sort(), ['blocked', 'web']);
    const review = rankImages([perfectButBlocked, needsAttestation, mediocreButCleared], ctx, { stage: 'candidates' }).ranked.map((r) => r.id);
    assert.deepEqual(review, ['own', 'web', 'blocked'], 'cleared first, then what the owner could still clear, then what can never be used');
    const s = scoreImage(perfectButBlocked, ctx);
    assert.ok(s.score > scoreImage(mediocreButCleared, ctx).score, 'it does look better');
    assert.equal(s.eligibleNow, false);
  });

  it('measures the pixels locally and removes near-identical pictures by perceptual hash', async () => {
    const a = await picture(3);
    const copy = await sharp(a).resize(900, 675).jpeg({ quality: 60 }).toBuffer(); // a resized, re-compressed copy
    const other = await picture(11);
    const [pa, pc, po] = await Promise.all([analyzeImage(a), analyzeImage(copy), analyzeImage(other)]);
    assert.ok(pa && pc && po);
    assert.ok(isNearDuplicate(pa.phash, pc.phash), `a copy is a near duplicate (distance ${hammingDistance(pa.phash, pc.phash)})`);
    assert.ok(!isNearDuplicate(pa.phash, po.phash), 'a different picture is not');
    for (const v of [pa.sharpness, pa.subject, pa.brightness, ...Object.values(pa.space), ...pa.focus]) assert.ok(v >= 0 && v <= 1);
    assert.equal(pa.version, 1);
    const r = rankImages([subject('a', { analysis: pa }), subject('copy', { analysis: pc }), subject('other', { analysis: po })], ctx, { stage: 'selection' });
    assert.equal(r.ranked.length, 2);
    assert.equal(r.duplicates.length, 1);
    assert.ok(['a', 'copy'].includes(r.duplicates[0].of) && ['a', 'copy'].includes(r.duplicates[0].id));
    assert.ok(r.ranked.some((x) => x.id === 'other'));
  });

  it('a collection changes what the pictures are asked for (typography room matters more to Premium Editorial than to Dynamic Events)', async () => {
    const a = await analyzeImage(await picture(5));
    assert.ok(a);
    const calm = { ...a, space: { top: 0.95, bottom: 0.9, left: 0.9, right: 0.9 } };
    const busy = { ...a, space: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 } };
    const gap = (id: string) => scoreImage(subject('x', { analysis: calm }), { ...ctx, collectionId: id }).score - scoreImage(subject('x', { analysis: busy }), { ...ctx, collectionId: id }).score;
    assert.ok(gap('premium_editorial') > gap('dynamic_events'));
  });
});

describe('NO AI HYBRID: allocation of pictures to creatives', () => {
  const concepts = Array.from({ length: 5 }, (_, i) => ({ id: `K${i + 1}`, words: i === 0 ? ['diving', 'reef'] : ['ocean'] }));
  const slots = concepts.flatMap((c) => [1, 2, 3, 4].map((n) => ({ slotId: `${c.id}-T${n}`, conceptId: c.id, index: n, formatClass: (['square', 'portrait', 'story', 'banner'] as const)[n - 1] })));
  const images = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `img${i + 1}`, score: 0.9 - i * 0.05, text: i === 0 ? 'diving reef' : 'ocean', width: 2000, height: 1500, analysis: null }));

  it('20 creatives need far fewer than 20 pictures: 1 to 3 per concept, every creative has one, and a reused picture is cropped differently', () => {
    const a = allocateImages({ concepts, slots, images: images(6), maxPerConcept: 3 });
    assert.equal(a.slots.length, 20);
    assert.ok(a.slots.every((s) => s.imageId));
    for (const c of a.perConcept) assert.ok(c.imageIds.length >= 1 && c.imageIds.length <= 3, `${c.conceptId}: ${c.imageIds.length}`);
    const byImage = new Map<string, string[]>();
    for (const s of a.slots) (byImage.get(s.imageId!) ?? byImage.set(s.imageId!, []).get(s.imageId!)!).push(`${s.focus![0]},${s.focus![1]}`);
    for (const [id, foci] of byImage) assert.equal(new Set(foci).size, foci.length, `${id}: every reuse has its own crop`);
  });

  it('with one picture all 20 creatives use it, each with a different crop; with none they are text-first and the plan says so', () => {
    const one = allocateImages({ concepts, slots, images: images(1), maxPerConcept: 3 });
    assert.ok(one.slots.every((s) => s.imageId === 'img1'));
    assert.equal(new Set(one.slots.map((s) => `${s.focus![0]},${s.focus![1]}`)).size >= 8, true);
    assert.ok(one.warnings.some((w) => /share a picture/.test(w)));
    const none = allocateImages({ concepts, slots, images: [], maxPerConcept: 3 });
    assert.ok(none.slots.every((s) => s.imageId === null && s.focus === null));
    assert.ok(none.warnings[0].includes('text-first'));
  });

  it('is deterministic and never uses more pictures per concept than allowed', () => {
    const x = allocateImages({ concepts, slots, images: images(9), maxPerConcept: 2 });
    const y = allocateImages({ concepts, slots, images: images(9), maxPerConcept: 2 });
    assert.equal(JSON.stringify(x), JSON.stringify(y));
    for (const c of x.perConcept) assert.ok(c.imageIds.length <= 2);
  });
});

// ---- website discovery against a fixture site --------------------------------------------------------------------------------------------------

describe('NO AI HYBRID: website image discovery (controlled fixtures, no downloads)', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  before(async () => {
    const home = `<!doctype html><html><head><title>Blue Reef Diving School</title>
      <meta property="og:image" content="/img/hero-reef.jpg"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="900">
      <script type="application/ld+json">{"@type":"Organization","name":"Blue Reef","image":["https://cdn.thirdparty-photos.example/boat.jpg"],"sameAs":["https://www.instagram.com/bluereef/"]}</script></head>
      <body><header><img src="/img/logo.png" alt="Blue Reef logo" width="200" height="60"><img src="/img/spacer.gif" width="1" height="1"></header>
      <h1>Learn to dive</h1><figure><img src="/img/instructor-300x200.jpg" srcset="/img/instructor-800.jpg 800w, /img/instructor-1600.jpg 1600w" alt="Instructor teaching a dive class" width="1600" height="1000"><figcaption>Our instructor</figcaption></figure>
      <img src="/img/instructor-1600.jpg" alt="Instructor teaching a dive class" width="1600" height="1000">
      <img src="/img/tiny.jpg" width="40" height="40"><img src="https://www.google-analytics.com/collect?v=1" width="1" height="1"><img src="/icons/sprite.png" width="400" height="400"><img src="/img/vector.svg" width="500" height="500">
      <a href="/courses">Courses</a> <a href="/private/members">Members</a> <a href="/captcha">Protected</a></body></html>`;
    const courses = `<!doctype html><html><head><title>Courses</title></head><body><h2>Open water course</h2><img src="/img/course-gear.jpg" alt="Scuba gear on the dock" width="1200" height="800"></body></html>`;
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      const send = (code: number, type: string, body: string) => (res.writeHead(code, { 'content-type': type }), res.end(body));
      if (req.url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /private/\n');
      if (req.url === '/') return send(200, 'text/html', home);
      if (req.url === '/courses') return send(200, 'text/html', courses);
      if (req.url === '/captcha') return send(403, 'text/html', '<html><title>Just a moment...</title><body>cf-chl challenge-platform</body></html>');
      if (req.url?.startsWith('/private')) return send(200, 'text/html', '<img src="/img/secret.jpg" width="900" height="900">');
      send(404, 'text/plain', 'nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  after(() => void server.close());

  const web = () => new WebFetchTool({ policy: { allowedPorts: new Set([port, 80, 443]), allowLoopbackForTests: true }, timeoutMs: 3000, maxPages: 6, respectRobots: true });

  it('finds the real pictures, ranks the prominent ones first and rejects icons, tracking pixels, logos, vectors and tiny files', async () => {
    hits.length = 0;
    const r = await discoverWebsiteImages(`http://127.0.0.1:${port}/`, { web: web(), maxPages: 5 });
    const urls = r.candidates.map((c) => new URL(c.url).pathname + (new URL(c.url).hostname.includes('thirdparty') ? '@third' : ''));
    assert.ok(urls.includes('/img/hero-reef.jpg'), 'the Open Graph image');
    assert.ok(urls.includes('/img/course-gear.jpg'), 'a picture of a second page of the same site');
    assert.ok(r.candidates.some((c) => c.url.includes('boat.jpg') && c.where === 'schema_org' && !c.firstParty), 'schema.org image from another host, flagged third-party');
    const instructor = r.candidates.filter((c) => /instructor/.test(c.url));
    assert.equal(instructor.length, 1, 'the same picture in three sizes is ONE candidate');
    assert.ok(instructor[0].url.includes('instructor-1600'), 'the largest size wins');
    assert.equal(instructor[0].alt, 'Instructor teaching a dive class');
    assert.equal(r.candidates[0].where, 'open_graph', 'the page\'s own image ranks first');
    const rejected = r.rejected.map((x) => x.url).join(' ');
    for (const bad of ['logo.png', 'spacer.gif', 'tiny.jpg', 'google-analytics', 'sprite.png', 'vector.svg']) assert.ok(rejected.includes(bad), `${bad} should be rejected`);
    assert.equal(r.socialLinks.some((s) => s.platform === 'instagram'), true, 'a profile the site declares itself (schema.org sameAs) is kept as a reference link');
  });

  it('downloads NO image file and respects robots.txt and bot protection', async () => {
    hits.length = 0;
    const r = await discoverWebsiteImages(`http://127.0.0.1:${port}/`, { web: web() });
    assert.ok(!hits.some((u) => u.startsWith('/img/')), `no picture was requested: ${hits.join(', ')}`);
    assert.ok(!hits.some((u) => u.startsWith('/private')), 'the disallowed page was not fetched');
    assert.ok(r.candidates.every((c) => !c.url.includes('secret')));
    assert.ok(r.notes.some((n) => /No picture was downloaded/.test(n)));
    const blocked = await discoverWebsiteImages(`http://127.0.0.1:${port}/captcha`, { web: web() });
    assert.equal(blocked.candidates.length, 0);
    assert.equal(blocked.pages[0].status, 'blocked');
    assert.match(blocked.pages[0].message ?? '', /not worked around/);
  });

  it('refuses private and unsafe addresses before any request', async () => {
    for (const u of ['http://10.0.0.5/', 'http://169.254.169.254/', 'http://localhost:4000/', 'file:///etc/passwd', 'ftp://example.com/']) {
      const r = await discoverWebsiteImages(u, { web: new WebFetchTool() });
      assert.equal(r.candidates.length, 0, u);
      assert.equal(r.pages[0].status, 'blocked', u);
    }
  });

  it('parses srcset, stems and html without a network', () => {
    assert.deepEqual(bestOfSrcset('/a-400.jpg 400w, /a-1200.jpg 1200w, /a-800.jpg 800w'), { url: '/a-1200.jpg', width: 1200 });
    assert.equal(imageStem('https://x.com/p/photo-300x200.jpg?w=300'), imageStem('https://x.com/p/photo-1600x1066.jpg'));
    const found = imagesOfHtml('<meta property="og:image" content="/o.jpg"><img src="/i.jpg" alt="A" width="800" height="600">', 'https://x.com/');
    assert.deepEqual(found.map((f) => f.where), ['open_graph', 'img']);
  });
});

describe('NO AI HYBRID: repository and social sources', () => {
  it('picks campaign pictures from a file tree and leaves out icons, build output and tests', () => {
    const tree = [
      { path: 'public/screenshots/dashboard.png', size: 420_000 },
      { path: 'public/hero-banner.jpg', size: 900_000 },
      { path: 'assets/logo.png', size: 52_000 },
      { path: 'node_modules/x/photo.png', size: 100_000 },
      { path: 'public/favicon.png', size: 80_000 },
      { path: 'src/__tests__/fixture.png', size: 90_000 },
      { path: 'images/tiny-icon-thing.png', size: 3_000 },
      { path: 'images/big.png', size: 30_000_000 },
      { path: 'docs/team-photo.jpg', size: 300_000 },
    ];
    const { candidates, rejected } = pickRepoImages(tree, { owner: 'acme', repo: 'app', ref: 'main' });
    assert.deepEqual(candidates.map((c) => c.path), ['public/screenshots/dashboard.png', 'public/hero-banner.jpg', 'assets/logo.png', 'docs/team-photo.jpg']);
    assert.equal(candidates[0].kind, 'screenshot');
    assert.equal(classifyRepoImage('assets/logo.png').kind, 'logo');
    assert.equal(rejected.length, 5);
    assert.ok(candidates[0].pageUrl.startsWith('https://github.com/acme/app/blob/main/'));
  });

  it('lists through the official API only, says the repository license covers code, and reports a rate limit honestly', async () => {
    const ok = await discoverRepositoryImages('https://github.com/acme/app', { github: { listImageFiles: async () => ({ ok: true, owner: 'acme', repo: 'app', ref: 'main', license: 'MIT', images: [{ path: 'public/hero.png', size: 400_000 }], truncated: false }) } });
    assert.equal(ok.ok, true);
    assert.equal(ok.candidates.length, 1);
    assert.match(ok.notes[0], /covers its source code/);
    assert.match(ok.notes.join(' '), /Nothing from the repository is executed/);
    const limited = await discoverRepositoryImages('https://github.com/acme/app', { github: { listImageFiles: async () => ({ ok: false, code: 'rate_limited', message: 'x' }) } });
    assert.equal(limited.ok, false);
    assert.match(limited.notes[0], /limit was reached/);
  });

  it('social profiles are reference links only: no integration is claimed and none is usable as a source', () => {
    const out = describeSocialSources([{ platform: 'instagram', url: 'https://www.instagram.com/bluereef/' }, { platform: 'pinterest', url: 'https://www.pinterest.com/bluereef/' }, { platform: 'x', url: 'javascript:alert(1)' }], [{ platform: 'facebook', url: 'https://www.facebook.com/bluereef' }]);
    assert.equal(out.length, 3, 'a non-http link is dropped');
    for (const s of out) {
      assert.equal(s.access, 'reference_link');
      assert.equal(s.apiAvailable, false);
      assert.match(s.note, /nothing is read|link-only|reads nothing|link is a reference/i);
      assert.equal(exportEligibility(socialRights(s.platform)).eligible, false);
    }
    assert.equal(out[2].origin, 'found_on_website');
  });
});

describe('NO AI HYBRID: search intents and providers', () => {
  const base = { business: 'Blue Reef Diving School', offering: 'Scuba diving courses and reef trips for beginners', audience: 'adults who want to learn to dive' };

  it('builds concept-, audience- and collection-aware queries (deterministic); without that context it keeps the earlier four', () => {
    const rich = buildSearchIntents({ ...base, concepts: [{ name: 'First breath underwater', visualIdea: 'a beginner taking a first breath underwater with an instructor', keyMessage: 'Your first dive' }], collectionId: 'premium_editorial', collectionNeeds: 'Strong editorial photography, negative space and a natural composition', objective: 'bookings' });
    assert.ok(rich.length > 4 && rich.length <= 7, String(rich.length));
    assert.ok(rich.some((i) => /concept/.test(i.why)));
    assert.ok(rich.some((i) => /collection/.test(i.why)));
    assert.deepEqual(rich, buildSearchIntents({ ...base, concepts: [{ name: 'First breath underwater', visualIdea: 'a beginner taking a first breath underwater with an instructor', keyMessage: 'Your first dive' }], collectionId: 'premium_editorial', collectionNeeds: 'Strong editorial photography, negative space and a natural composition', objective: 'bookings' }));
    assert.ok(buildSearchIntents(base).length <= 4);
  });

  it('never uses a paid provider unless paid search was approved, and says why', async () => {
    let paidCalls = 0;
    const paid: ImageSearchAdapter = { id: 'brave_images', label: 'Brave', kind: 'reference', configured: true, paid: true, setup: '', search: async () => (paidCalls++, []) };
    const free: ImageSearchAdapter = { id: 'pixabay', label: 'Pixabay', kind: 'licensed', configured: true, setup: '', search: async () => [candidate('1')] };
    const off = await discoverImages(base, [paid, free], { includePaid: false });
    assert.equal(paidCalls, 0);
    assert.equal(off.providers.find((p) => p.id === 'brave_images')?.status, 'skipped');
    assert.match(off.providers.find((p) => p.id === 'brave_images')?.message ?? '', /paid search was not approved/);
    assert.equal(off.licensed.length, 1);
    await discoverImages(base, [paid, free], { includePaid: true });
    assert.equal(paidCalls > 0, true);
    paidCalls = 0;
    await discoverImages(base, [paid, free]);
    assert.equal(paidCalls > 0, true, 'a search the user starts by hand keeps every configured provider');
  });

  it('a provider that is not configured is reported as such and nothing is invented', async () => {
    const none: ImageSearchAdapter = { id: 'pexels', label: 'Pexels', kind: 'licensed', configured: false, setup: 'Set PEXELS_API_KEY', search: async () => [candidate('x')] };
    const failing: ImageSearchAdapter = { id: 'openverse', label: 'Openverse', kind: 'licensed', configured: true, setup: '', search: async () => { throw new ImageSearchError('unavailable', 'x'); } };
    const r = await discoverImages(base, [none, failing]);
    assert.deepEqual(r.providers.map((p) => p.status), ['not_configured', 'failed']);
    assert.equal(r.licensed.length, 0);
    assert.match(r.notes.join(' '), /nothing was invented/);
  });
});

describe('NO AI HYBRID: nothing can ask the provider for an image', () => {
  it('the OpenAI client refuses an image request before any request is built', async () => {
    let sent = 0;
    let refused = 0;
    const client = new OpenAIClient({ apiKey: 'sk-test-0000000000000000', baseUrl: 'http://127.0.0.1:1', forbidImages: true, onImageRefused: () => void refused++, fetch: (async () => (sent++, new Response('{}'))) as typeof fetch });
    await assert.rejects(() => client.createImage({ model: 'gpt-image-1.5', prompt: 'x' }), (e: unknown) => e instanceof ProviderError && e.code === 'image_generation_forbidden');
    assert.equal(sent, 0, 'no HTTP request was made');
    assert.equal(refused, 1);
    // text requests are unaffected
    const ok = new OpenAIClient({ apiKey: 'sk-test-0000000000000000', baseUrl: 'http://127.0.0.1:1', forbidImages: true, fetch: (async () => (sent++, new Response('{"id":"r"}'))) as typeof fetch });
    await ok.createResponse({ model: 'm', input: 'hello' });
    assert.equal(sent, 1);
  });

  it('an image generator marked forbidden refuses before the budget and counts the attempt', async () => {
    let sent = 0;
    const client = new OpenAIClient({ apiKey: 'sk-test-0000000000000000', baseUrl: 'http://127.0.0.1:1', fetch: (async () => (sent++, new Response('{}'))) as typeof fetch });
    const gen = new ImageGenerator(client, { maxImages: 5, forbidden: true });
    const r = await gen.generate('a picture', { model: 'gpt-image-1.5', quality: 'low', size: '1024x1024' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'image_generation_forbidden');
    assert.equal(sent, 0);
    assert.equal(gen.usage().refusedForbidden, 1);
    assert.equal(gen.usage().requestsStarted, 0);
  });
});

describe('NO AI HYBRID: settings', () => {
  it('the preset has 0 originals, 20 template creatives and the guarantee; "allowed" with originals is unchanged', () => {
    assert.equal(NO_AI_PRESET.originals, 0);
    assert.equal(NO_AI_PRESET.templateCreatives, 20);
    assert.equal(isNoAi(NO_AI_PRESET), true);
    assert.equal(isNoAi(HYBRID_PRESET), false);
    assert.equal(HYBRID_PRESET.originals, 5);
    assert.equal(HYBRID_PRESET.templateCreatives, 15);
  });

  it('a campaign that never generates images cannot ask for generated ones; the refusal is an error, not a silent change', () => {
    assert.throws(() => mergeHybrid({ ...NO_AI_PRESET, originals: 3 }), /NO AI HYBRID makes no AI images/);
    assert.equal(mergeHybrid({ ...NO_AI_PRESET }).imagery.generation, 'forbidden');
    assert.equal(mergeHybrid({ ...NO_AI_PRESET, imagery: { autoStock: true } }).imagery.autoStock, true, 'a partial imagery patch is merged field by field');
  });

  it('settings saved before imagery existed still parse and mean "allowed"', () => {
    const { imagery: _i, ...old } = HYBRID_PRESET;
    void _i;
    const parsed = HybridSettings.parse(old);
    assert.equal(parsed.imagery.generation, 'allowed');
    assert.equal(parsed.imagery.autoStock, false);
    assert.equal(parsed.imagery.allowPaidSearch, false);
  });
});

describe('NO AI HYBRID: code policy (no unauthorized scraping)', () => {
  const code = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no module drives a browser, proxies a search engine or calls a platform; the social module makes no request at all', () => {
    for (const f of ['website-images.ts', 'repo-images.ts', 'social-sources.ts', 'rights.ts', 'scoring.ts', 'allocate.ts', 'analysis.ts']) {
      const c = code(f);
      assert.ok(!/puppeteer|playwright|selenium|chromium|jsdom/i.test(c), `${f}: no headless browser`);
      assert.ok(!/google\.com\/search|bing\.com\/images|duckduckgo|serpapi|customsearch/i.test(c), `${f}: no search engine as an extraction proxy`);
      assert.ok(!/pinterest\.com\/(resource|_)|instagram\.com\/(graphql|api)|graph\.facebook\.com|linkedin\.com\/(voyager|v2)/i.test(c), `${f}: no platform endpoints`);
    }
    assert.ok(!/fetch\(|https?\.request|axios|WebFetchTool|XMLHttpRequest/.test(code('social-sources.ts')), 'social-sources makes no network request');
    assert.ok(!/fetch\(|https?\.request|axios/.test(code('website-images.ts')), 'website discovery reads only through the shared guarded WebFetchTool');
    assert.ok(!/fetchAsset\(/.test(code('website-images.ts')), 'website discovery never downloads a picture');
  });
});
