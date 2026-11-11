import * as cheerio from 'cheerio';
import { WebFetchTool } from '../tools/web-fetch';
import { extractPage, selectRelevantLinks } from '../tools/html';
import { logosOfHtml, type LogoCandidateInfo } from './logo-discovery';

/**
 * IMAGE DISCOVERY ON THE PROJECT'S OWN WEBSITE. Extends the website reading that already exists (same SSRF-safe, robots-respecting WebFetchTool, same
 * link selection) instead of adding a second crawler. It reads a few public pages of the SAME site and collects the picture addresses they declare:
 * <img> and <picture>/srcset, Open Graph and Twitter images, schema.org images, inline background images.
 *
 * What it does NOT do: download a single picture. A picture on a website belongs to whoever made it, so what is found here is a CANDIDATE with a
 * source page, a declared size and the words around it. The file is fetched only after the project owner confirms the right to use it (see the
 * import step in the API). A page that robots.txt disallows or that sits behind bot protection is reported and skipped, never worked around.
 */

export interface WebsiteImageCandidate {
  /** absolute https/http address of the picture file */
  url: string;
  /** the page it was found on */
  pageUrl: string;
  alt: string | null;
  title: string | null;
  /** declared size (attributes or the largest srcset descriptor), null when the page does not say */
  width: number | null;
  height: number | null;
  where: 'open_graph' | 'twitter' | 'schema_org' | 'img' | 'picture' | 'background' | 'link_rel';
  /** the text around the picture: caption, nearest heading, aria label */
  context: string;
  /** 0..1: how prominent it is on its page */
  prominence: number;
  /** the picture is served by the same site (false = another host, e.g. a stock site or a CDN of someone else) */
  firstParty: boolean;
}

export interface WebsitePageOutcome {
  url: string;
  status: 'read' | 'blocked' | 'failed';
  message: string | null;
  images: number;
}

export interface WebsiteImageDiscovery {
  site: string;
  pages: WebsitePageOutcome[];
  candidates: WebsiteImageCandidate[];
  rejected: { url: string; reason: string }[];
  socialLinks: { platform: string; url: string }[];
  /** Logo candidates of the home page (only when `logoBrand` was given): descriptions, nothing was downloaded. */
  logos?: LogoCandidateInfo[];
  notes: string[];
}

const RASTER_EXT = /\.(jpe?g|png|webp)(?:$|[?#])/i;
const NOT_PICTURE_EXT = /\.(svg|ico|gif|bmp|tif{1,2}|avif|heic|mp4|webm|pdf|css|js)(?:$|[?#])/i;
const DECORATIVE = /(sprite|favicon|apple-touch|emoji|avatar|gravatar|pixel|tracking|tracker|spacer|blank|transparent|1x1|badge|flag-|\/flags\/|payment|visa|mastercard|paypal|arrow|chevron|spinner|loader|placeholder|logo)/i;
const TRACKING_HOST = /(google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|connect\.facebook|bat\.bing|hotjar|px\.ads|adsrvr|scorecardresearch|quantserve|pixel\.)/i;
const MIN_SIDE = 200;

const decode = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const num = (v: string | undefined) => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The largest candidate of a srcset (by its width descriptor, else the last one) and its declared width. */
export function bestOfSrcset(srcset: string | undefined): { url: string; width: number | null } | null {
  if (!srcset) return null;
  let best: { url: string; width: number | null; rank: number } | null = null;
  srcset.split(',').forEach((part, i) => {
    const [url, desc] = part.trim().split(/\s+/);
    if (!url) return;
    const w = desc && /^\d+w$/.test(desc) ? Number.parseInt(desc, 10) : null;
    const rank = w ?? (desc && /^\d+(\.\d+)?x$/.test(desc) ? Number.parseFloat(desc) * 1000 : i);
    if (!best || rank > best.rank) best = { url, width: w, rank };
  });
  const out = best as { url: string; width: number | null } | null;
  return out ? { url: out.url, width: out.width } : null;
}

/** The same picture served in several sizes shares a "stem": the file name without size suffixes, density markers and resize parameters. */
export function imageStem(raw: string): string {
  try {
    const u = new URL(raw);
    const file = decodeURIComponent(u.pathname.split('/').pop() ?? '').toLowerCase();
    const dir = u.pathname.split('/').slice(0, -1).join('/').replace(/\/(\d{2,4}x\d{2,4}|w_\d+|c_[a-z_]+,?[\w,]*)\//g, '/');
    const stem = file.replace(/\.[a-z0-9]{2,5}$/, '').replace(/[-_@]?\d{2,4}x\d{2,4}$/, '').replace(/@\d(x)?$/, '').replace(/[-_](thumb|thumbnail|small|medium|large|scaled|min|mobile|desktop|retina)$/, '');
    return `${u.hostname.replace(/^www\./, '')}${dir}/${stem}`;
  } catch {
    return raw;
  }
}

/** Same site: the host is equal or a subdomain of the site's host (ignoring "www"). */
export function isFirstParty(imageHost: string, siteHost: string): boolean {
  const a = imageHost.toLowerCase().replace(/^www\./, '');
  const b = siteHost.toLowerCase().replace(/^www\./, '');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function jsonLdImages(raw: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) return void node.slice(0, 40).forEach((n) => walk(n, depth + 1));
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    for (const key of ['image', 'photo', 'thumbnailUrl', 'contentUrl']) {
      const v = o[key];
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => (typeof x === 'string' ? out.push(x) : x && typeof x === 'object' && typeof (x as { url?: unknown }).url === 'string' ? out.push((x as { url: string }).url) : undefined));
      else if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') out.push((v as { url: string }).url);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  try {
    walk(JSON.parse(raw));
  } catch {
    /* malformed JSON-LD is ignored */
  }
  return out;
}

interface Raw {
  url: string;
  alt?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  where: WebsiteImageCandidate['where'];
  context?: string;
  weight: number;
}

/** The picture references of ONE page's HTML, in document order, with the words around each. Pure: no network. */
export function imagesOfHtml(html: string, pageUrl: string): Raw[] {
  const $ = cheerio.load(html);
  const out: Raw[] = [];
  const add = (r: Raw) => out.push(r);
  const meta = (sel: string, where: Raw['where'], weight: number) =>
    $(sel).each((_, el) => {
      const v = decode($(el).attr('content') ?? $(el).attr('href'));
      if (v) add({ url: v, where, weight, alt: decode($('meta[property="og:image:alt"]').attr('content')) || null, width: num($('meta[property="og:image:width"]').attr('content')), height: num($('meta[property="og:image:height"]').attr('content')), context: decode($('meta[property="og:title"]').attr('content') ?? $('title').text()) });
    });
  meta('meta[property="og:image"], meta[property="og:image:secure_url"]', 'open_graph', 1);
  meta('meta[name="twitter:image"], meta[name="twitter:image:src"]', 'twitter', 0.8);
  meta('link[rel="image_src"]', 'link_rel', 0.5);
  $('script[type="application/ld+json"]').each((_, el) => {
    for (const u of jsonLdImages($(el).contents().text())) add({ url: u, where: 'schema_org', weight: 0.7, context: decode($('title').text()) });
  });
  const contextOf = (el: ReturnType<typeof $>): string => {
    const fig = el.closest('figure').find('figcaption').first().text();
    const label = el.attr('aria-label') ?? el.closest('[aria-label]').attr('aria-label') ?? '';
    const heading = el.closest('section, article, div').find('h1, h2, h3').first().text();
    return decode(`${fig} ${label} ${heading}`).slice(0, 200);
  };
  $('img').each((i, el) => {
    const $el = $(el);
    const src = decode($el.attr('src') ?? $el.attr('data-src') ?? $el.attr('data-lazy-src') ?? $el.attr('data-original'));
    const set = bestOfSrcset($el.attr('srcset') ?? $el.attr('data-srcset'));
    const url = set?.url ?? src;
    if (!url || url.startsWith('data:')) return;
    const w = num($el.attr('width')) ?? set?.width ?? null;
    const h = num($el.attr('height'));
    const inHeader = $el.closest('header, nav, footer').length > 0;
    add({ url, alt: decode($el.attr('alt')) || null, title: decode($el.attr('title')) || null, width: w, height: h, where: 'img', context: contextOf($el), weight: inHeader ? 0.15 : Math.max(0.3, 0.9 - i * 0.04) });
  });
  $('picture source[srcset]').each((i, el) => {
    const set = bestOfSrcset($(el).attr('srcset'));
    if (set) add({ url: set.url, width: set.width, where: 'picture', context: contextOf($(el)), weight: 0.6, alt: decode($(el).closest('picture').find('img').attr('alt')) || null });
  });
  $('[style*="background"]').each((_, el) => {
    const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec($(el).attr('style') ?? '');
    if (m && !m[1].startsWith('data:')) add({ url: m[1], where: 'background', context: contextOf($(el)), weight: 0.5 });
  });
  void pageUrl;
  return out;
}

export interface DiscoverWebsiteOptions {
  web?: Pick<WebFetchTool, 'fetchPage' | 'checkUrl'>;
  /** pages read in total, the home page included (default 5) */
  maxPages?: number;
  maxCandidates?: number;
  /** Also collect the home page's logo candidates (the business words are used to recognize a logo that names the business). */
  logoBrand?: string[];
  signal?: AbortSignal;
}

/**
 * Reads the home page and a few relevant pages of the SAME site and returns the picture candidates, best first by prominence. Reading is bounded
 * (pages, time, size) by the shared WebFetchTool. Nothing here fetches an image file.
 */
export async function discoverWebsiteImages(siteUrl: string, o: DiscoverWebsiteOptions = {}): Promise<WebsiteImageDiscovery> {
  const maxPages = Math.max(1, Math.min(8, o.maxPages ?? 5));
  const web = o.web ?? new WebFetchTool({ maxPages, respectRobots: true, timeoutMs: 8_000 });
  const notes: string[] = [];
  const out: WebsiteImageDiscovery = { site: siteUrl, pages: [], candidates: [], rejected: [], socialLinks: [], notes };
  const first = web.checkUrl(siteUrl);
  if (!first.ok) {
    out.pages.push({ url: siteUrl, status: 'blocked', message: first.message, images: 0 });
    notes.push(`The website address cannot be read: ${first.message}`);
    return out;
  }
  let siteHost = '';
  try {
    siteHost = new URL(siteUrl).hostname;
  } catch {
    return out;
  }

  const rawAll: (Raw & { pageUrl: string })[] = [];
  const readPage = async (url: string): Promise<{ links: { text: string; href: string }[]; finalUrl: string } | null> => {
    const r = await web.fetchPage(url, o.signal);
    if (!r.ok) {
      const blocked = r.code === 'robots_disallowed' || r.code === 'bot_protected' || r.code === 'blocked_url';
      out.pages.push({ url, status: blocked ? 'blocked' : 'failed', message: r.code === 'robots_disallowed' ? 'robots.txt does not allow reading this page; it was not read.' : r.code === 'bot_protected' ? 'The page is protected against automated reading; it was not worked around.' : r.message, images: 0 });
      return null;
    }
    const imgs = imagesOfHtml(r.body, r.finalUrl);
    for (const i of imgs) rawAll.push({ ...i, pageUrl: r.finalUrl });
    // the logo is on every page; the home page (the first one read) is enough and keeps the work bounded
    if (o.logoBrand && !out.logos) out.logos = logosOfHtml(r.body, r.finalUrl, o.logoBrand);
    const page = extractPage(r.body, r.finalUrl);
    for (const s of page.socialLinks) if (!out.socialLinks.some((x) => x.url === s.url)) out.socialLinks.push(s);
    out.pages.push({ url: r.finalUrl, status: 'read', message: null, images: imgs.length });
    return { links: page.links, finalUrl: r.finalUrl };
  };

  const home = await readPage(siteUrl);
  if (home && maxPages > 1) {
    for (const link of selectRelevantLinks(home.links, home.finalUrl, maxPages - 1)) {
      if (o.signal?.aborted) break;
      await readPage(link);
    }
  }
  if (!out.pages.some((p) => p.status === 'read')) {
    notes.push('No page of the website could be read, so no website pictures were found. Upload your own pictures or use a licensed provider.');
    return out;
  }

  // normalise, filter, merge sizes of the same picture
  const byStem = new Map<string, WebsiteImageCandidate & { weight: number; area: number }>();
  const reject = (url: string, reason: string) => {
    if (!out.rejected.some((r) => r.url === url)) out.rejected.push({ url, reason });
  };
  for (const r of rawAll) {
    let abs: URL;
    try {
      abs = new URL(r.url, r.pageUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
    abs.hash = '';
    const url = abs.toString();
    const policy = web.checkUrl(url);
    if (!policy.ok) {
      reject(url, 'The address is not a public web address.');
      continue;
    }
    if (TRACKING_HOST.test(url)) {
      reject(url, 'A tracking pixel, not a picture.');
      continue;
    }
    if (NOT_PICTURE_EXT.test(abs.pathname + abs.search)) {
      reject(url, 'Not a photograph (vector, icon, animation or document).');
      continue;
    }
    if (DECORATIVE.test(abs.pathname)) {
      reject(url, 'A logo, icon or interface graphic, not campaign imagery.');
      continue;
    }
    if ((r.width !== null && r.width !== undefined && r.width < MIN_SIDE) || (r.height !== null && r.height !== undefined && r.height < MIN_SIDE)) {
      reject(url, `Too small (${r.width ?? '?'}x${r.height ?? '?'} declared): it would look soft in a creative.`);
      continue;
    }
    if (r.width && r.height && (r.width / r.height > 6 || r.height / r.width > 6)) {
      reject(url, 'A thin strip, not a usable picture.');
      continue;
    }
    if (!RASTER_EXT.test(abs.pathname + abs.search) && r.where !== 'open_graph' && r.where !== 'twitter' && r.where !== 'schema_org') {
      // an address without a file extension (a CDN) is accepted only when the page itself marks it as its image
      if (!(r.width && r.width >= 400)) {
        reject(url, 'The file type is not clear from the address.');
        continue;
      }
    }
    const cand: WebsiteImageCandidate & { weight: number; area: number } = {
      url,
      pageUrl: r.pageUrl,
      alt: r.alt ?? null,
      title: r.title ?? null,
      width: r.width ?? null,
      height: r.height ?? null,
      where: r.where,
      context: r.context ?? '',
      prominence: Math.min(1, r.weight),
      firstParty: isFirstParty(abs.hostname, siteHost),
      weight: r.weight,
      area: (r.width ?? 0) * (r.height ?? r.width ?? 0),
    };
    const key = imageStem(url);
    const cur = byStem.get(key);
    // keep the better description of one picture: the larger declared size, the more prominent place
    if (!cur) byStem.set(key, cand);
    else if (cand.area > cur.area || (cand.area === cur.area && cand.weight > cur.weight)) byStem.set(key, { ...cand, alt: cand.alt ?? cur.alt, context: cand.context || cur.context, prominence: Math.max(cand.prominence, cur.prominence) });
    else byStem.set(key, { ...cur, alt: cur.alt ?? cand.alt, context: cur.context || cand.context, prominence: Math.max(cand.prominence, cur.prominence) });
  }
  const max = o.maxCandidates ?? 30;
  out.candidates = [...byStem.values()]
    .sort((a, b) => b.prominence - a.prominence || b.area - a.area || (a.url < b.url ? -1 : 1))
    .slice(0, max)
    .map(({ weight: _w, area: _a, ...c }) => (void _w, void _a, c));
  if (byStem.size > max) notes.push(`${byStem.size - max} more picture(s) were found; the ${max} most prominent are listed.`);
  if (!out.candidates.length) notes.push('The pages were read but no usable pictures were found on them (only icons, logos or very small images).');
  const third = out.candidates.filter((c) => !c.firstParty).length;
  if (third) notes.push(`${third} picture(s) are served by another website. Being shown on your page does not make them yours.`);
  notes.push('No picture was downloaded: these are candidates. A picture is fetched only after you confirm that you hold the rights to use it.');
  return out;
}
