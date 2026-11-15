import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { detectBotChallenge, type FetchResult } from '../tools/web-fetch';
import { brandGraphic, personScene } from '../testing/photo-fixtures';
import {
  LIBRARY_MAX,
  LIBRARY_TARGET,
  bestOfSrcset,
  categoryOfPixels,
  classifyWebsiteImage,
  discoverWebsiteImages,
  imageStem,
  imagesOfHtml,
  looksLikePersonName,
  rankImagePages,
  linksOfHtml,
  pageKey,
  recommendLibrary,
  unwrapImageUrl,
  type WebsiteImageCandidate,
} from './website-images';

// WEBSITE IMAGE DISCOVERY against a fake multi-page site: the reader is a stub (no network, no paid call of any kind). The pages copy the structures of
// real sites - a Next.js image CDN (the FIRMENFELS GRUPPE case), WordPress lazy-loading, <picture>/srcset, CSS backgrounds - with invented content.

type Page = string | { status: number } | 'robots' | 'bot';
const SITE = 'https://acme-consult.example';

/** A fake WebFetchTool: serves `pages`, records every request, honours a robots rule for picture files, and never touches the network. */
function fakeWeb(pages: Record<string, Page>, o: { robotsBlocks?: RegExp; pageLimit?: number } = {}) {
  const fetched: string[] = [];
  const robotsAsked: string[] = [];
  let served = 0;
  const web = {
    checkUrl: (u: string) => (/^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(u) ? ({ ok: false as const, message: 'not public' }) : ({ ok: true as const })),
    fetchPage: async (u: string): Promise<FetchResult> => {
      fetched.push(u);
      const key = u.replace(/\/$/, '');
      if (o.pageLimit !== undefined && served >= o.pageLimit) return { ok: false, url: u, code: 'page_limit', message: 'limit' };
      const p = pages[key];
      if (p === undefined) return { ok: false, url: u, code: 'http_error', message: 'Not found (404).', status: 404 };
      if (p === 'robots') return { ok: false, url: u, code: 'robots_disallowed', message: 'robots' };
      if (p === 'bot') return { ok: false, url: u, code: 'bot_protected', message: 'bot' };
      if (typeof p !== 'string') return { ok: false, url: u, code: 'http_error', message: `HTTP ${p.status}`, status: p.status };
      served++;
      return { ok: true, url: u, finalUrl: key, status: 200, contentType: 'text/html', bytes: p.length, truncated: false, body: p, fromCache: false };
    },
    robotsAllow: async (u: string) => {
      robotsAsked.push(u);
      return !(o.robotsBlocks && o.robotsBlocks.test(new URL(u).pathname));
    },
  };
  return { web, fetched, robotsAsked };
}

const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${NAV}<main>${body}</main><footer><a href="/en/impressum">Legal notice</a> <a href="/en/privacy">Privacy</a></footer></body></html>`;
const NAV = `<header><a href="/en"><img src="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo-white.57e2.webp&w=384&q=75" alt="Acme Consult" width="159" height="40"></a>
  <nav><a href="/en/team">Team</a> <a href="/en/services">Services</a> <a href="/en/about-us">About us</a> <a href="/en/blog">Blog</a> <a href="/en/login">Login</a> <a href="/de/team">DE</a> <a href="/en/check/start?check=risk">Start the check</a> <a href="/en/partners" rel="nofollow">Partners</a></nav></header>`;
const next = (file: string, w: number, h: number, alt: string, lazy = true) =>
  `<img alt="${alt}" ${lazy ? 'loading="lazy"' : 'fetchpriority="high"'} width="${w}" height="${h}" srcset="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2F${file}&w=640&q=75 640w, /_next/image?url=%2F_next%2Fstatic%2Fmedia%2F${file}&w=3840&q=75 3840w" src="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2F${file}&w=3840&q=75">`;

const HOME = page(
  'Acme Consult',
  `<section><h1>Steering for growing companies</h1>${next('home-team.5af9.webp', 2400, 1600, 'The Acme Consult team', false)}${next('home-team.5af9.webp', 2400, 1600, 'The Acme Consult team')}</section>
   <section><h2>Advice on the shop floor</h2>${next('consultant-floor.6dc5.webp', 1491, 816, 'Consultant in conversation with a management team on the production floor')}</section>
   <section><h2>Finance</h2><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/wp-content/uploads/2026/03/meeting-room-1024x683.jpg" data-srcset="/wp-content/uploads/2026/03/meeting-room-1024x683.jpg 1024w, /wp-content/uploads/2026/03/meeting-room.jpg 2048w" width="2048" height="1365" alt="Four executives at a meeting table"></section>
   <section class="cta" style="background-image: url('/assets/office-lobby.jpg')" aria-label="Our office lobby in Zurich"><h2>Visit us</h2></section>
   <img src="/img/spacer.gif" width="1" height="1"><img src="https://www.google-analytics.com/collect?v=1&tid=x" width="1" height="1">`,
  `<meta property="og:image" content="${SITE}/og-default.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
   <link rel="preload" as="image" imagesrcset="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fhome-team.5af9.webp&w=3840&q=75 3840w">`,
);
const portraits = ['Dominic Weber', 'Kim Brunner', 'Dr. Ulrich von Arx', 'Tabea Gamper', 'Cristian Hofmann'].map((n, i) => `<div class="card"><h3>${n}</h3>${next(`spec-${n.split(' ').pop()!.toLowerCase()}.a${i}b.webp`, 800 + i * 10, 720, n)}</div>`).join('');
const TEAM = page('Team', `<section><h1>The team</h1>${next('team-hero.b90f.webp', 1354, 663, 'The Acme team')}</section><section>${portraits}${next('lead-small.e1.webp', 596, 506, 'Patrick Gauch')}</section>`);
const SERVICES = page(
  'Services',
  `<h1>Services</h1><picture><source type="image/webp" srcset="/media/workshop-800.webp 800w, /media/workshop-1600.webp 1600w"><img src="/media/workshop-800.jpg" alt="Strategy workshop" width="1600" height="1000"></picture>
   <noscript><img src="/media/advisory-desk.jpg" width="1400" height="900" alt="Advisory session at the desk"></noscript>
   <div class="hero" data-bg="/media/succession-planning.jpg" aria-label="Succession planning"></div>
   <img src="https://res.cloudinary.com/acme/image/upload/c_fill,w_400/v1/dashboard.png" srcset="https://res.cloudinary.com/acme/image/upload/c_fill,w_400/v1/dashboard.png 400w, https://res.cloudinary.com/acme/image/upload/c_fill,w_1600/v1/dashboard.png 1600w" alt="Dashboard screenshot of the reporting tool" width="1600" height="900">
   <a href="/en/services/consulting">Consulting</a> <a href="/en/services/training">Training</a>`,
  '<style>.banner{background:#123 url("/media/factory-hall.jpg") center/cover no-repeat}</style>',
);
const CONSULTING = page('Consulting', `<h1>Consulting</h1><img src="/media/consulting-team-session.jpg" width="1800" height="1200" alt="Consultants with a client team">`);
const ABOUT = page('About us', `<h1>About</h1><img src="https://images.unsplash.com/photo-123?w=1600" width="1600" height="1067" alt="Office building at dusk"><img src="/media/headquarters.jpg" width="1600" height="1067" alt="Our headquarters building">`);
const BLOG = page('Blog', `<h1>Blog</h1><a href="/en/blog/2026/some-article">Read</a><img src="/media/blog-cover.jpg" width="1200" height="800" alt="Article cover">`);

const SITE_PAGES: Record<string, Page> = {
  [`${SITE}/en`]: HOME,
  [`${SITE}/en/team`]: TEAM,
  [`${SITE}/en/services`]: SERVICES,
  [`${SITE}/en/services/consulting`]: CONSULTING,
  [`${SITE}/en/about-us`]: ABOUT,
  [`${SITE}/en/blog`]: BLOG,
};

// discovery must never reach the network: any real fetch fails the test
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (() => {
    throw new Error('network access in a test');
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('website image discovery: the FIRMENFELS GRUPPE regression', () => {
  it('pictures behind an image CDN (Next.js /_next/image) are distinct pictures, not one: the old stem merged every one of them', () => {
    const a = `${SITE}/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fhome-team.5af9.webp&w=3840&q=75`;
    const b = `${SITE}/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fteam-hero.b90f.webp&w=3840&q=75`;
    const aSmall = `${SITE}/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fhome-team.5af9.webp&w=640&q=75`;
    assert.notEqual(imageStem(a), imageStem(b));
    assert.equal(imageStem(a), imageStem(aSmall), 'the same picture in two sizes is one picture');
    assert.equal(unwrapImageUrl(a)!.pathname, '/_next/static/media/home-team.5af9.webp');
    assert.equal(unwrapImageUrl(`${SITE}/cdn-cgi/image/width=800,quality=75/media/a.jpg`)!.pathname, '/media/a.jpg');
    // a script address keeps its identifying parameter, so two pictures behind one script stay apart; size parameters do not split one picture
    assert.notEqual(imageStem(`${SITE}/media?id=1&w=400`), imageStem(`${SITE}/media?id=2&w=400`));
    assert.equal(imageStem(`${SITE}/media?id=1&w=400`), imageStem(`${SITE}/media?w=1600&id=1`));
    // WordPress sizes of one upload
    assert.equal(imageStem(`${SITE}/wp-content/uploads/a/meeting-room-1024x683.jpg`), imageStem(`${SITE}/wp-content/uploads/a/meeting-room.jpg`));
    assert.equal(imageStem(`${SITE}/wp-content/uploads/a/meeting-room-scaled.jpg`), imageStem(`${SITE}/wp-content/uploads/a/meeting-room.jpg`));
  });

  it('reads the relevant pages of the site (home, team, services, about, a relevant sub-page), never legal, login, other-language, query or nofollow pages', async () => {
    const { web, fetched } = fakeWeb(SITE_PAGES);
    const d = await discoverWebsiteImages(`${SITE}/en`, { web });
    const read = d.pages.filter((p) => p.status === 'read').map((p) => p.url.replace(SITE, ''));
    assert.deepEqual(read.slice(0, 2), ['/en', '/en/team'], 'home first, then the team page');
    assert.deepEqual(read.slice(2, 4).sort(), ['/en/about-us', '/en/services'], 'then about and services (equal priority)');
    assert.ok(read.includes('/en/about-us'));
    assert.ok(read.includes('/en/services/consulting'), 'a clearly relevant page one step deeper is read');
    for (const never of ['/en/impressum', '/en/privacy', '/en/login', '/de/team', '/en/check/start', '/en/partners', '/en/blog/2026/some-article']) assert.ok(!fetched.some((u) => u.replace(SITE, '').startsWith(never)), `${never} is never read`);
    assert.ok(read.length <= 8);
  });
});

describe('website image discovery: where pictures hide', () => {
  it('lazy-loaded images: data-src / data-srcset win over a placeholder src; <noscript> copies are read', () => {
    const imgs = imagesOfHtml(HOME, `${SITE}/en`);
    assert.ok(imgs.some((i) => i.url === '/wp-content/uploads/2026/03/meeting-room.jpg'), 'the largest data-srcset entry, not the data: placeholder');
    assert.ok(!imgs.some((i) => i.url.startsWith('data:')));
    const svc = imagesOfHtml(SERVICES, `${SITE}/en/services`);
    assert.ok(svc.some((i) => i.url === '/media/advisory-desk.jpg' && i.alt === 'Advisory session at the desk'), 'the <noscript> picture');
  });

  it('srcset and <picture>: the largest candidate; a Cloudinary address with commas stays whole', () => {
    assert.deepEqual(bestOfSrcset('/a-640.jpg 640w, /a-1600.jpg 1600w, /a-1024.jpg 1024w'), { url: '/a-1600.jpg', width: 1600 });
    assert.deepEqual(bestOfSrcset('/a.jpg 1x,/a@2x.jpg 2x'), { url: '/a@2x.jpg', width: null });
    assert.deepEqual(bestOfSrcset('https://res.cloudinary.com/x/image/upload/c_fill,w_400/v1/a.png 400w, https://res.cloudinary.com/x/image/upload/c_fill,w_1600/v1/a.png 1600w'), { url: 'https://res.cloudinary.com/x/image/upload/c_fill,w_1600/v1/a.png', width: 1600 });
    const svc = imagesOfHtml(SERVICES, `${SITE}/en/services`);
    assert.ok(svc.some((i) => i.where === 'picture' && i.url === '/media/workshop-1600.webp'));
  });

  it('CSS background images: inline style, data-bg attributes and the page\'s own <style> block', () => {
    assert.ok(imagesOfHtml(HOME, SITE).some((i) => i.where === 'background' && i.url === '/assets/office-lobby.jpg' && i.alt === 'Our office lobby in Zurich'));
    const svc = imagesOfHtml(SERVICES, SITE);
    assert.ok(svc.some((i) => i.where === 'background' && i.url === '/media/succession-planning.jpg'));
    assert.ok(svc.some((i) => i.where === 'background' && i.url === '/media/factory-hall.jpg'));
  });
});

describe('website image discovery: the library it proposes', () => {
  let d: Awaited<ReturnType<typeof discoverWebsiteImages>>;
  let robotsAsked: string[];
  before(async () => {
    const f = fakeWeb(SITE_PAGES, { robotsBlocks: /factory-hall/ });
    robotsAsked = f.robotsAsked;
    d = await discoverWebsiteImages(`${SITE}/en`, { web: f.web, logoBrand: ['acme'] });
  });
  const byFile = (f: string) => d.candidates.find((c) => decodeURIComponent(c.url).includes(f));

  it('counts every picture once (sizes, preload, og:image) and keeps the source page of each (provenance)', () => {
    const homeTeam = d.candidates.filter((c) => decodeURIComponent(c.url).includes('home-team'));
    assert.equal(homeTeam.length, 1, 'img x2 + preload = one picture');
    assert.equal(homeTeam[0].width, 2400, 'the declared size, not the srcset request width (3840)');
    assert.equal(homeTeam[0].height, 1600);
    assert.equal(byFile('team-hero')!.pageUrl, `${SITE}/en/team`);
    assert.equal(byFile('consulting-team-session')!.pageUrl, `${SITE}/en/services/consulting`);
    assert.equal(new Set(d.candidates.map((c) => imageStem(c.url))).size, d.candidates.length, 'no picture listed twice');
  });

  it('keeps logos, brand graphics and photographs apart; tracking pixels and spacers never appear', () => {
    assert.ok(d.rejected.some((r) => /logo-white/.test(decodeURIComponent(r.url)) && /logo/i.test(r.reason)), 'the header logo is not a photograph');
    assert.ok(d.logos && d.logos.length > 0, 'logo candidates are still discovered, separately');
    assert.equal(byFile('og-default')!.category, 'brand_graphic');
    assert.equal(byFile('dashboard')!.category, 'brand_graphic', 'a screenshot is not a photograph');
    assert.ok(!d.candidates.some((c) => /spacer|google-analytics/.test(c.url)));
    assert.equal(d.summary!.brandGraphics, 2);
    assert.equal(d.summary!.photos, d.candidates.length - 2);
    assert.ok(d.candidates.filter((c) => c.category === 'brand_graphic').every((c) => !c.recommended));
  });

  it('classifies what the pictures show: team, portraits, people, workplace, services', () => {
    assert.equal(byFile('home-team')!.category, 'team');
    assert.equal(byFile('spec-brunner')!.category, 'portrait');
    assert.equal(byFile('meeting-room')!.category, 'people');
    assert.equal(byFile('headquarters')!.category, 'workplace');
    assert.equal(byFile('workshop')!.category, 'people');
    assert.equal(byFile('succession-planning')!.category, 'service');
    assert.ok(looksLikePersonName('Dr. Ulrich von Arx') && looksLikePersonName('Edita Korać'));
    assert.ok(!looksLikePersonName('Acme Group', ['acme']) && !looksLikePersonName('The Acme team') && !looksLikePersonName('Strategy workshop'));
  });

  it('recommends at most 10, people first, at most three portraits, nothing too small or from another site; the target of five is reached here', () => {
    const rec = d.candidates.filter((c) => c.recommended);
    assert.ok(rec.length >= LIBRARY_TARGET && rec.length <= LIBRARY_MAX, String(rec.length));
    assert.deepEqual(rec.map((c) => c.rank), rec.map((_, i) => i + 1));
    assert.ok(rec.filter((c) => c.category === 'portrait').length <= 3);
    assert.ok(['team', 'people', 'portrait'].includes(rec[0].category!));
    assert.ok(rec.some((c) => c.category === 'workplace' || c.category === 'service'), 'room is kept for the business environment and its services');
    assert.equal(byFile('lead-small')!.recommended, false, 'only 596 px on its long side');
    assert.match(byFile('lead-small')!.why!, /596 px/);
    const stock = d.candidates.find((c) => c.url.includes('unsplash'))!;
    assert.equal(stock.firstParty, false);
    assert.equal(stock.recommended, false);
    assert.ok(d.summary!.targetReached);
  });

  it('robots.txt decides about picture files too: a disallowed picture is not offered', () => {
    assert.ok(!d.candidates.some((c) => c.url.includes('factory-hall')));
    assert.ok(d.rejected.some((r) => r.url.includes('factory-hall') && /robots/.test(r.reason)));
    assert.ok(robotsAsked.every((u) => u.startsWith(SITE)), 'only the site\'s own robots rules are consulted');
  });
});

describe('website image discovery: limits and permissions', () => {
  it('a small site gives fewer than five recommendations and says so: nothing is invented to fill the quota', async () => {
    const small = { [`${SITE}/en`]: page('Tiny', `<img src="/a/team-photo.jpg" width="1600" height="1000" alt="Our team"><img src="/a/shop-front.jpg" width="1600" height="1000" alt="Our store front"><img src="/a/icon-phone.png" width="32" height="32">`) };
    const d = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb(small).web });
    assert.equal(d.candidates.filter((c) => c.recommended).length, 2);
    assert.equal(d.summary!.targetReached, false);
    assert.match(d.notes[0], /fewer than 5.*nothing was added/);
  });

  it('robots.txt, bot protection and logins are respected: the page is reported, not read; a noimageindex page gives no pictures', async () => {
    const pages: Record<string, Page> = {
      [`${SITE}/en`]: HOME,
      [`${SITE}/en/team`]: 'robots',
      [`${SITE}/en/services`]: 'bot',
      [`${SITE}/en/about-us`]: { status: 401 },
      [`${SITE}/en/blog`]: page('Blog', '<img src="/media/blog-hero.jpg" width="1600" height="900" alt="Team at an event">', '<meta name="robots" content="index, noimageindex">'),
    };
    const d = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb(pages).web });
    const status = Object.fromEntries(d.pages.map((p) => [p.url.replace(SITE, ''), p]));
    assert.equal(status['/en/team'].status, 'blocked');
    assert.match(status['/en/team'].message!, /robots\.txt/);
    assert.equal(status['/en/services'].status, 'blocked');
    assert.equal(status['/en/about-us'].status, 'failed');
    assert.match(status['/en/about-us'].message!, /login|not public/);
    assert.equal(status['/en/blog'].images, 0);
    assert.ok(!d.candidates.some((c) => c.url.includes('blog-hero')));
    assert.ok(d.notes.some((n) => /noimageindex/.test(n)));
  });

  it('the crawl is bounded: page limit, byte limit and time budget stop it and the report says why', async () => {
    const many: Record<string, Page> = { [`${SITE}/en`]: page('Home', Array.from({ length: 14 }, (_, i) => `<a href="/en/services/s${i}">Service ${i}</a>`).join(' ')) };
    for (let i = 0; i < 14; i++) many[`${SITE}/en/services/s${i}`] = page(`S${i}`, `<img src="/m/s${i}.jpg" width="1200" height="800" alt="Service ${i}">`);
    const a = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb(many).web, maxPages: 4 });
    assert.equal(a.pages.filter((p) => p.status === 'read').length, 4);
    assert.ok(a.notes.some((n) => /page limit \(4\)/.test(n)));
    const b = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb(many).web, maxBytes: 1 });
    assert.equal(b.pages.filter((p) => p.status === 'read').length, 1);
    assert.ok(b.notes.some((n) => /size limit/.test(n)));
    let t = 0;
    const c = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb(many).web, budgetMs: 5_000, now: () => (t += 2_000) });
    assert.ok(c.pages.filter((p) => p.status === 'read').length < 4);
    assert.ok(c.notes.some((n) => /time limit/.test(n)));
  });

  it('page ranking: team, about and services first; a blog article, a query page or another language never', () => {
    const links = linksOfHtml(HOME, `${SITE}/en`);
    const ranked = rankImagePages(links, `${SITE}/en`, new Set());
    assert.deepEqual(ranked.slice(0, 3).map((r) => r.role).sort(), ['about', 'services', 'team']);
    assert.ok(!ranked.some((r) => /impressum|privacy|login|\/de\/|check|partners/.test(r.href)));
  });
});

describe('the library selection itself (pure)', () => {
  const cand = (i: number, category: WebsiteImageCandidate['category'], o: Partial<WebsiteImageCandidate> = {}): WebsiteImageCandidate => ({ url: `${SITE}/m/${category}-${i}.jpg`, pageUrl: SITE, alt: `${category} ${i}`, title: null, width: 1600, height: 1000, where: 'img', context: '', prominence: 0.8 - i * 0.01, firstParty: true, category, ...o });

  it('never more than 10 even when the site has 25 good photographs', () => {
    const list = [...Array.from({ length: 10 }, (_, i) => cand(i, 'team')), ...Array.from({ length: 10 }, (_, i) => cand(i, 'workplace')), ...Array.from({ length: 5 }, (_, i) => cand(i, 'portrait'))];
    const r = recommendLibrary(list);
    assert.equal(r.filter((c) => c.recommended).length, LIBRARY_MAX);
    assert.equal(r.filter((c) => c.recommended && c.category === 'workplace').length, 2, 'two places kept for the environment');
  });

  it('classification from words alone is conservative: a share card is a brand graphic, a banner with people stays a photograph', () => {
    assert.equal(classifyWebsiteImage({ url: `${SITE}/og-default.png`, where: 'open_graph' }), 'brand_graphic');
    assert.equal(classifyWebsiteImage({ url: `${SITE}/media/finance-cta.jpg`, alt: 'Four executives in conversation at a meeting table', where: 'img', width: 1467, height: 486 }), 'people');
    assert.equal(classifyWebsiteImage({ url: `${SITE}/media/logo-white.webp`, alt: 'Acme', where: 'img' }), 'logo');
    assert.equal(classifyWebsiteImage({ url: `${SITE}/media/summer-banner.jpg`, alt: 'Summer sale', where: 'img' }), 'brand_graphic');
  });
});

describe('the pixel check after import (local, no identification)', () => {
  it('a photograph of people is people / team; a flat graphic without faces is a brand graphic whatever its page called it', async () => {
    const group = await personScene({ width: 1200, height: 800, people: [{ x: 0.25, y: 0.4, size: 0.2, tone: 'medium' }, { x: 0.5, y: 0.42, size: 0.2, tone: 'dark' }, { x: 0.75, y: 0.4, size: 0.2, tone: 'light' }], backdrop: 'office' });
    const g = await categoryOfPixels(group, 'other');
    assert.ok(g && (g.category === 'team' || g.category === 'people') && g.faces >= 2, JSON.stringify(g));
    const graphic = await categoryOfPixels(await brandGraphic(1200, 630), 'workplace');
    assert.equal(graphic?.category, 'brand_graphic');
    const keep = await categoryOfPixels(group, 'brand_graphic');
    assert.equal(keep?.category, 'brand_graphic', 'a banner the words marked stays a brand graphic');
  });
});

// A small venue site built the way older CMS sites (ProcessWire, Joomla) often are: the home page at "/", every content page under a language prefix
// ("/rs/..."), internal links that mix http:// and https://, the logo among the template files (/site/templates/images/), and a lightbox gallery whose
// previews ("thumbnail_*.jpg", no declared size) link to the full pictures. All names and texts are invented; no file of a real site is used.
describe('website image discovery: a venue site with a language prefix and a lightbox gallery', () => {
  const VENUE = 'https://venue-cafe.example';
  const venueNav = `<div class="top"><a href="http://venue-cafe.example/rs/"><img src="/site/templates/images/logo-rs.png"/></a>
    <a href="http://venue-cafe.example/en/"><img src="/site/templates/images/lang-en.png"/></a>
    <ul class="menu"><li><a href="/rs/">POČETNA</a></li><li><a href="/rs/o-nama/">O NAMA</a></li><li><a href="/rs/meni/">HRANA</a></li><li><a href="/rs/nasi-gosti/">NAŠI GOSTI</a></li>
    <li><a href="/rs/galerija/">GALERIJA</a></li><li><a href="/rs/kontakt/">KONTAKT</a></li></ul></div>`;
  const venuePage = (title: string, body: string) => `<!doctype html><html><head><title>${title} - Venue Cafe</title><link rel="shortcut icon" href="/site/templates/images/favicon.png"></head><body>${venueNav}${body}</body></html>`;
  const slider = [1, 2, 3, 4, 5].map((i) => `<li><img src="/site/assets/files/1006/slide${i}.jpg" width="1170" height="524" alt="" /></li>`).join('');
  const tiles = ['coffee', 'food', 'about', 'gallery'].map((t, i) => `<div><a href="/rs/${t}/"><img src="/site/assets/files/10${23 + i}/${t}.jpg" width="270" height="275" alt="" /></a><a href="http://venue-cafe.example/rs/${t}/">Saznajte više</a></div>`).join('');
  const lightbox = (dir: number, names: string[]) => names.map((n) => `<a href="/site/assets/files/${dir}/${n}.jpg" class="lightview" data-lightview-group="g"><img src="/site/assets/files/${dir}/thumbnail_${n}.jpg" /></a>`).join('');
  const galleryNames = Array.from({ length: 14 }, (_, i) => `venue_interior_${String(i + 1).padStart(2, '0')}`);
  const pages: Record<string, Page> = {
    [VENUE]: venuePage('Home', `<ul data-orbit>${slider}</ul>${tiles}<img src="/site/assets/files/1020/rating-badge.jpg" width="270" height="50" alt="" />`),
    [`${VENUE}/rs/o-nama`]: venuePage('O nama', `<h1>O nama</h1><img src="/site/assets/files/1008/terrace.jpg" width="1170" height="700" alt="Terasa restorana" />`),
    [`${VENUE}/rs/galerija`]: venuePage('Galerija', `<img src="/site/assets/files/1009/header.jpg" width="1170" height="325" alt="" /><div class="gallery">${lightbox(1009, galleryNames)}<img src="/site/assets/files/1009/thumbnail_orphan_preview.jpg" /></div>`),
    [`${VENUE}/rs/nasi-gosti`]: venuePage('Naši gosti', `<div class="gallery">${lightbox(1012, ['guests_birthday_01', 'guests_birthday_02'])}</div>`),
    [`${VENUE}/rs/meni`]: venuePage('Meni', `<h1>Meni</h1><img src="/site/assets/files/1030/pizza.jpg" width="900" height="600" alt="Pizza" />`),
    [`${VENUE}/en`]: venuePage('Home EN', `<img src="/site/assets/files/1006/slide-en.jpg" width="1170" height="524" />`),
  };

  it('reads the language-prefixed pages (gallery, guests, about, menu) once each, though they are linked as http:// and https://; another language is not read', async () => {
    const { web, fetched } = fakeWeb(pages);
    const d = await discoverWebsiteImages(`${VENUE}/`, { web, logoBrand: ['venue', 'cafe'] });
    const read = d.pages.filter((p) => p.status === 'read').map((p) => p.url.replace(VENUE, '') || '/');
    for (const p of ['/rs/galerija', '/rs/nasi-gosti', '/rs/o-nama', '/rs/meni']) assert.ok(read.includes(p), `${p} is read (${read.join(', ')})`);
    assert.ok(!fetched.some((u) => /\/en\/?$/.test(u)), 'the English copy is not read');
    const keys = fetched.map(pageKey);
    assert.equal(new Set(keys).size, keys.length, `no page is fetched twice: ${fetched.join(', ')}`);
    assert.ok(fetched.every((u) => u.startsWith('https://')), 'pages linked as http:// are read the way the site was entered');
    assert.ok(read.length <= 8);
  });

  it('a lightbox gallery gives its FULL pictures: the preview is only the pointer (kept as provenance); an orphan preview is refused with the reason', async () => {
    const d = await discoverWebsiteImages(`${VENUE}/`, { web: fakeWeb(pages).web, logoBrand: ['venue', 'cafe'] });
    const full = d.candidates.filter((c) => c.where === 'gallery_link');
    assert.equal(full.length, 16, 'fourteen gallery pictures and two guest pictures');
    const one = full.find((c) => c.url.endsWith('/1009/venue_interior_01.jpg'))!;
    assert.equal(one.previewUrl, `${VENUE}/site/assets/files/1009/thumbnail_venue_interior_01.jpg`);
    assert.equal(one.pageUrl, `${VENUE}/rs/galerija`);
    assert.equal(one.width, null, "the preview's size is not the picture's size: the import measures the real file");
    assert.ok(!d.candidates.some((c) => /thumbnail_/.test(c.url)), 'no preview is offered as a picture');
    const orphan = d.rejected.find((r) => r.url.endsWith('thumbnail_orphan_preview.jpg'))!;
    assert.equal(orphan.kind, 'thumbnail');
    assert.match(orphan.reason, /thumbnail preview/);
    // the minimum-size policy is unchanged: declared small home tiles are never recommended, the thin badge is refused
    for (const small of ['coffee.jpg', 'food.jpg']) assert.ok(!d.candidates.some((c) => c.url.endsWith(small) && c.recommended), `${small} is not recommended`);
    assert.ok(d.rejected.some((r) => r.url.endsWith('rating-badge.jpg')) && !d.candidates.some((c) => c.url.endsWith('rating-badge.jpg')));
  });

  it('the logo in the template folder is a logo candidate, never a photograph; at most 10 recommended, all distinct, all first-party, nothing downloaded', async () => {
    const d = await discoverWebsiteImages(`${VENUE}/`, { web: fakeWeb(pages).web, logoBrand: ['venue', 'cafe'] });
    assert.equal(d.logos?.[0]?.location, `${VENUE}/site/templates/images/logo-rs.png`);
    assert.ok(!d.candidates.some((c) => /logo/.test(c.url)));
    assert.ok(d.rejected.some((r) => r.url.endsWith('logo-rs.png') && r.kind === 'logo'));
    const rec = d.candidates.filter((c) => c.recommended);
    assert.equal(rec.length, LIBRARY_MAX);
    assert.ok(rec.every((c) => c.firstParty && !/thumbnail_|logo/.test(c.url)));
    // the language-switch flag among the template files is an interface graphic, not a photograph
    assert.ok(!d.candidates.some((c) => c.url.endsWith('/site/templates/images/lang-en.png')));
    assert.equal(d.rejected.find((r) => r.url.endsWith('lang-en.png'))?.kind, 'icon');
    assert.equal(new Set(d.candidates.map((c) => imageStem(c.url))).size, d.candidates.length, 'no duplicates');
    assert.equal(d.summary!.targetReached, true);
    assert.ok(d.notes.some((n) => /No picture was downloaded/.test(n)));
  });

  it('a gallery link only counts when it points to a picture file; a link to a page leaves the preview a normal picture with its own size', () => {
    const html = `<a href="/rs/galerija/"><img src="/m/gallery-teaser.jpg" width="1170" height="600" alt=""></a><a href="/m/big.webp?v=2" data-width="2400" data-height="1600"><img src="/m/small.webp" width="300" height="200" alt="Terrace"></a>`;
    const imgs = imagesOfHtml(html, VENUE);
    assert.deepEqual(imgs.map((i) => [i.where, i.url, i.width]), [['img', '/m/gallery-teaser.jpg', 1170], ['gallery_link', '/m/big.webp?v=2', 2400]]);
    assert.equal(imgs[1].previewUrl, '/m/small.webp');
    assert.equal(imgs[1].alt, 'Terrace');
  });

  it('a page key ignores scheme, www and the trailing slash', () => {
    assert.equal(pageKey('http://www.Venue-Cafe.example/rs/galerija/'), pageKey('https://venue-cafe.example/rs/galerija'));
    assert.notEqual(pageKey('https://venue-cafe.example/rs/galerija'), pageKey('https://venue-cafe.example/en/gallery'));
  });
});

describe('website image discovery: explaining a result without pictures', () => {
  it('a start page answered with HTTP 404 is explained (respected, not worked around) and nothing is invented', async () => {
    const d = await discoverWebsiteImages(`${SITE}/`, { web: fakeWeb({}).web });
    assert.equal(d.pages.length, 1);
    assert.equal(d.pages[0].status, 'failed');
    assert.match(d.pages[0].message!, /HTTP 404 \(page not found\).*respected, not worked around.*upload the logo and photographs yourself/);
    assert.equal(d.candidates.length, 0);
    assert.ok(d.notes.some((n) => /No page of the website could be read/.test(n)));
  });

  it('pages that were read: "no pictures declared" and "pictures found but rejected" are different answers, with the counted reasons', async () => {
    const none = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb({ [`${SITE}/en`]: '<!doctype html><html><head><title>Plain</title></head><body><h1>Hello</h1><p>Text only.</p></body></html>' }).web });
    assert.match(none.notes[0], /1 page\(s\) read, but their HTML declares no pictures/);
    const icons = page('Icons', '<img src="/i/logo-acme.png" alt="Acme logo"><img src="/i/icon-phone.png" width="32" height="32"><img src="/i/arrow-right.png"><img src="/i/thumbs/team.jpg">');
    const some = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb({ [`${SITE}/en`]: icons }).web });
    assert.match(some.notes[0], /picture reference\(s\) found, but none is a usable photograph: /);
    for (const reason of [/logo\(s\)/, /thumbnail preview/, /icon/]) assert.match(some.notes[0], reason);
    const small = await discoverWebsiteImages(`${SITE}/en`, { web: fakeWeb({ [`${SITE}/en`]: page('Small', '<img src="/m/terrace.jpg" width="400" height="300" alt="Terrace">') }).web });
    assert.match(small.notes[0], /1 distinct photograph\(s\) found, none recommended for the campaign library: 1 smaller than 600 px/);
  });

  it('a hosting firewall\'s "One moment, please..." check is recognized as bot protection, not read as a page without pictures', () => {
    const challenge = `<!DOCTYPE html><html lang="en"><head><meta charset="utf8"><script>(function(){setTimeout(function(){window.location.reload();},5000);}())</script><title>One moment, please...</title></head><body><div id="container"><h1>One moment, please...</h1><p>Please wait while your request is being verified...</p></div><script>var a0y=1;</script></body></html>`;
    assert.equal(detectBotChallenge(200, {}, challenge), "a hosting firewall's");
    assert.equal(detectBotChallenge(200, {}, challenge.replace('One moment, please...</title>', 'Einen Moment bitte …</title>')), "a hosting firewall's");
    // an ordinary page that happens to say "one moment" is not a challenge
    assert.equal(detectBotChallenge(200, {}, '<html><head><title>One moment, please - our blog</title></head><body><a href="/a">Read</a><img src="/x.jpg"></body></html>'), null);
    assert.equal(detectBotChallenge(200, {}, HOME), null);
  });
});
