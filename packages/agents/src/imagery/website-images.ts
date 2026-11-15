import * as cheerio from 'cheerio';
import { WebFetchTool } from '../tools/web-fetch';
import { extractPage } from '../tools/html';
import { logosOfHtml, type LogoCandidateInfo } from './logo-discovery';
import { analyzeSubject } from './subject';

/**
 * IMAGE DISCOVERY ON THE PROJECT'S OWN WEBSITE. Extends the website reading that already exists (same SSRF-safe, robots-respecting WebFetchTool)
 * instead of adding a second crawler. It reads a BOUNDED set of public pages of the SAME site (home first, then team / about / services and the other
 * pages that usually carry photographs) and collects the picture addresses they declare: <img> (also lazy-loaded: data-src, data-srcset, <noscript>),
 * <picture>/<source> srcset, preloaded hero images, Open Graph / Twitter / schema.org images and CSS background images (inline styles, data-bg
 * attributes and the page's own <style> blocks; external stylesheets are not read).
 *
 * Every picture is described (category, declared size, the words around it) and the best ones (at most 10) are RECOMMENDED for the campaign's image
 * library: team and people photographs first, then the business environment, then services. Logos and brand graphics are kept apart from the
 * photograph count. The same picture in several sizes (srcset, image CDNs such as Next.js /_next/image) counts once.
 *
 * What it does NOT do: download a single picture. A picture on a website belongs to whoever made it, so what is found here is a CANDIDATE with a
 * source page, a declared size and the words around it. The file is fetched only after the project owner confirms the right to use it (see the
 * import step in the API). A page or picture that robots.txt disallows, a page marked "noimageindex", a login / account / legal page and a page
 * behind bot protection are skipped and reported, never worked around.
 */

/** What a website picture shows, from its words, its page and its declared shape (no pixels: nothing is downloaded here). */
export type WebsiteImageCategory = 'team' | 'portrait' | 'people' | 'workplace' | 'service' | 'product' | 'other' | 'brand_graphic';

/** Lower = more useful for a campaign. Brand graphics (share cards, banners, infographics) never count as photographs. */
export const CATEGORY_PRIORITY: Record<WebsiteImageCategory, number> = { team: 1, portrait: 1, people: 1, workplace: 2, service: 3, product: 4, other: 5, brand_graphic: 9 };
export const PHOTO_CATEGORIES: readonly WebsiteImageCategory[] = ['team', 'portrait', 'people', 'workplace', 'service', 'product', 'other'];

/** The campaign image library: aim for at least this many distinct photographs when the site has them... */
export const LIBRARY_TARGET = 5;
/** ...and never recommend more than this. */
export const LIBRARY_MAX = 10;
/** A picture shorter than this on its long side is refused at import (it would look soft in a creative), so it is never recommended. */
export const MIN_LIBRARY_SIDE = 600;
/** Single-person portraits (team headshots) are useful, but a library of ten headshots is not: at most this many are recommended. */
const MAX_PORTRAITS = 3;
/** Places kept for the business environment and its services when the site shows them, so the library is not people only. */
const RESERVED_OTHER = 2;

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
  where: 'open_graph' | 'twitter' | 'schema_org' | 'img' | 'picture' | 'background' | 'link_rel' | 'preload' | 'gallery_link';
  /** for a picture found through a gallery link: the small preview shown on the page that links to this file */
  previewUrl?: string | null;
  /** the text around the picture: caption, nearest heading, aria label */
  context: string;
  /** 0..1: how prominent it is on its page */
  prominence: number;
  /** the picture is served by the same site (false = another host, e.g. a stock site or a CDN of someone else) */
  firstParty: boolean;
  /** what it probably shows (absent on results of older versions) */
  category?: WebsiteImageCategory;
  /** the role of the page it was found on (team, about, services, ...) */
  pageRole?: string;
  /** one of the (at most 10) pictures recommended for the campaign's image library */
  recommended?: boolean;
  /** 1-based order of a recommended picture */
  rank?: number | null;
  /** why it is (or is not) recommended, in a sentence */
  why?: string;
}

export interface WebsitePageOutcome {
  url: string;
  status: 'read' | 'blocked' | 'failed';
  message: string | null;
  images: number;
}

export interface WebsiteDiscoverySummary {
  /** distinct pictures found (all sizes of one picture count once), logos excluded */
  distinct: number;
  photos: number;
  brandGraphics: number;
  /** photographs that passed the quality and source checks (first-party, large enough, not a strip) */
  usable: number;
  recommended: number;
  target: number;
  max: number;
  targetReached: boolean;
}

export interface WebsiteImageDiscovery {
  site: string;
  pages: WebsitePageOutcome[];
  candidates: WebsiteImageCandidate[];
  /** `kind` groups the reasons for the zero-result explanation (absent on results of older versions) */
  rejected: { url: string; reason: string; kind?: RejectKind }[];
  socialLinks: { platform: string; url: string }[];
  /** Logo candidates of the home page (only when `logoBrand` was given): descriptions, nothing was downloaded. */
  logos?: LogoCandidateInfo[];
  /** counts for the report (absent on results of older versions) */
  summary?: WebsiteDiscoverySummary;
  notes: string[];
}

export type RejectKind = 'not_public' | 'tracking' | 'not_photo' | 'logo' | 'icon' | 'too_small' | 'thumbnail' | 'strip' | 'unclear_type' | 'robots';

const RASTER_PATH = /\.(jpe?g|png|webp)$/i;
/** A file that names itself a thumbnail (`thumbnail_x.jpg`, `x-thumb.jpg`, `/thumbs/x.jpg`): a preview of a larger picture, not the picture. */
const THUMB_FILE = /\/(thumbs?|thumbnails?)\/|(^|[-_.\/])(thumb|thumbs|thumbnail|thumbnails)[-_.]/i;
/**
 * A PNG among the files of the site's TEMPLATE / THEME (`/site/templates/images/`, `/wp-content/themes/x/img/`, `/templates/x/images/`): language
 * flags, buttons, ornaments. Content photographs live in the media folders; a photograph in a theme folder is a JPEG and stays a candidate.
 */
const TEMPLATE_PNG = /\/(templates?|themes?|skins?)\/(?:[^/?#]+\/)*[^/?#]+\.png$/i;
const RASTER_FORMAT_PARAM = /(?:^|[?&])(?:fm|format|f|ext)=(jpe?g|png|webp)(?:&|$)/i;
const NOT_PICTURE_EXT = /\.(svg|ico|gif|bmp|tif{1,2}|avif|heic|mp4|webm|pdf|css|js)$/i;
const DECORATIVE = /(sprite|favicon|apple-touch|android-chrome|mstile|emoji|avatar|gravatar|pixel|tracking|tracker|spacer|blank|transparent|1x1|badge|flag-|\/flags\/|payment|visa|mastercard|paypal|arrow|chevron|spinner|loader|placeholder)/i;
const LOGO_WORDS = /(logo|wordmark|brandmark|signet)/i;
const TRACKING_HOST = /(google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|connect\.facebook|bat\.bing|hotjar|px\.ads|adsrvr|scorecardresearch|quantserve|pixel\.)/i;
const MIN_SIDE = 200;
/** query parameters that only change the delivered size / quality of the same picture */
const SIZE_PARAMS = new Set(['w', 'h', 'width', 'height', 'q', 'quality', 'fit', 'crop', 'auto', 'fm', 'format', 'f', 'dpr', 's', 'size', 'resize', 'scale', 'v', 'ver', 'version', 'ext', 'ixlib', 'cs', 'rect', 'm', 'mode', 'bg', 'sharp', 'blur']);

const decode = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const num = (v: string | undefined) => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The entries of a srcset as the HTML standard reads them: a URL up to whitespace (it may contain commas, e.g. Cloudinary "c_fill,w_400"), then an optional descriptor up to the next comma. */
function parseSrcset(s: string): { url: string; desc: string | null }[] {
  const out: { url: string; desc: string | null }[] = [];
  let i = 0;
  while (i < s.length && out.length < 40) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    i = j;
    let desc: string | null = null;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      let k = i;
      while (k < s.length && s[k] !== ',') k++;
      desc = s.slice(i, k).trim() || null;
      i = k + 1;
    }
    if (url) out.push({ url, desc });
  }
  return out;
}

/** The largest candidate of a srcset (by its width descriptor, else its density, else the last one) and its declared width. */
export function bestOfSrcset(srcset: string | undefined): { url: string; width: number | null } | null {
  if (!srcset) return null;
  let best: { url: string; width: number | null; rank: number } | null = null;
  parseSrcset(srcset).forEach(({ url, desc }, i) => {
    if (!url || url.startsWith('data:')) return;
    const w = desc && /^\d+w$/.test(desc) ? Number.parseInt(desc, 10) : null;
    const rank = w ?? (desc && /^\d+(\.\d+)?x$/.test(desc) ? Number.parseFloat(desc) * 1000 : i);
    if (!best || rank > best.rank) best = { url, width: w, rank };
  });
  const out = best as { url: string; width: number | null } | null;
  return out ? { url: out.url, width: out.width } : null;
}

/**
 * The file a picture address really serves. Image CDNs and frameworks wrap the original: Next.js / Vercel / Netlify (`/_next/image?url=/media/a.webp&w=3840`),
 * Cloudflare (`/cdn-cgi/image/width=800/media/a.jpg`), and generic resizers with a `url` / `src` / `image` parameter. Their outer path is the SAME for
 * every picture, so comparing outer paths merged all pictures of such a site into one.
 */
export function unwrapImageUrl(raw: string | URL): URL | null {
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw) : new URL(raw.toString());
  } catch {
    return null;
  }
  const inner = (v: string | null): URL | null => {
    if (!v) return null;
    try {
      const x = new URL(v, u.origin);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x : null;
    } catch {
      return null;
    }
  };
  if (/^\/(_next|_vercel)\/image\/?$|^\/\.netlify\/images\/?$/i.test(u.pathname)) return inner(u.searchParams.get('url')) ?? u;
  const cf = /^\/cdn-cgi\/image\/[^/]+\/(.+)$/i.exec(u.pathname);
  if (cf) return inner(cf[1].startsWith('http') ? decodeURIComponent(cf[1]) : `/${cf[1]}`) ?? u;
  if (!RASTER_PATH.test(u.pathname)) {
    for (const key of ['url', 'src', 'image', 'img', 'file']) {
      const v = u.searchParams.get(key);
      if (v && RASTER_PATH.test(v.split(/[?#]/)[0])) return inner(v) ?? u;
    }
  }
  return u;
}

/**
 * The same picture served in several sizes shares a "stem": the (unwrapped) file name without size suffixes, density markers and resize parameters.
 * A file address WITHOUT an image extension (`/media?id=12`) keeps its identifying parameters, so different pictures behind one script stay apart.
 */
export function imageStem(raw: string): string {
  const u = unwrapImageUrl(raw);
  if (!u) return raw;
  try {
    const file = decodeURIComponent(u.pathname.split('/').pop() ?? '').toLowerCase();
    const dir = u.pathname.split('/').slice(0, -1).join('/').replace(/\/(\d{2,4}x\d{2,4}|w_\d+|c_[a-z_]+,?[\w,]*)\//g, '/');
    const stem = file.replace(/\.[a-z0-9]{2,5}$/, '').replace(/[-_@]?\d{2,4}x\d{2,4}$/, '').replace(/@\d(x)?$/, '').replace(/[-_](thumb|thumbnail|small|medium|large|scaled|min|mobile|desktop|retina)$/, '');
    let id = '';
    if (!RASTER_PATH.test(u.pathname) && u.search) {
      const keep = [...u.searchParams.entries()].filter(([k]) => !SIZE_PARAMS.has(k.toLowerCase())).sort(([a], [b]) => (a < b ? -1 : 1));
      if (keep.length) id = `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}`;
    }
    return `${u.hostname.replace(/^www\./, '')}${dir}/${stem}${id}`;
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
  previewUrl?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  where: WebsiteImageCandidate['where'];
  context?: string;
  weight: number;
}

/** A lazy-loading placeholder, not the picture: a data: URI or a tiny "blank/spacer/placeholder" file. */
const isPlaceholder = (u: string) => !u || u.startsWith('data:') || /(?:^|\/)(blank|spacer|placeholder|lazy|loading|transparent|pixel|grey|gray)[\w-]*\.(gif|png|svg|jpe?g|webp)(?:$|[?#])/i.test(u);
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-original-src', 'data-echo', 'data-url', 'data-full', 'data-large_image', 'data-hi-res', 'data-zoom-image'];
const LAZY_SET = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-original-set'];
const BG_ATTRS = ['data-bg', 'data-background', 'data-background-image', 'data-bg-src', 'data-image-src', 'data-bgset'];
const CSS_URL = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
const STYLE_BG = /background(?:-image)?\s*:[^;}]*?url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;

/** A link straight to a picture file (jpg / png / webp, query ignored), not a placeholder. */
const isImageLink = (href: string) => {
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) return false;
  return RASTER_PATH.test(href.split(/[?#]/)[0]) && !isPlaceholder(href);
};

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
  meta('link[rel="image_src"], meta[itemprop="image"]', 'link_rel', 0.5);
  $('script[type="application/ld+json"]').each((_, el) => {
    for (const u of jsonLdImages($(el).contents().text())) add({ url: u, where: 'schema_org', weight: 0.7, context: decode($('title').text()) });
  });
  // a hero picture the page asks the browser to load first
  $('link[rel="preload"][as="image"]').each((_, el) => {
    const set = bestOfSrcset($(el).attr('imagesrcset'));
    const url = set?.url ?? decode($(el).attr('href'));
    if (url && !isPlaceholder(url)) add({ url, where: 'preload', width: set?.width ?? null, weight: 0.6 });
  });
  const contextOf = (el: ReturnType<typeof $>): string => {
    const fig = el.closest('figure').find('figcaption').first().text();
    const label = el.attr('aria-label') ?? el.closest('[aria-label]').attr('aria-label') ?? '';
    const heading = el.closest('section, article, li, div').find('h1, h2, h3, h4').first().text();
    return decode(`${fig} ${label} ${heading}`).slice(0, 200);
  };
  const imgOf = ($el: ReturnType<typeof $>, i: number, weightScale = 1) => {
    const lazy = LAZY_SRC.map((a) => decode($el.attr(a))).find((v) => v && !isPlaceholder(v));
    const src = decode($el.attr('src'));
    let set: ReturnType<typeof bestOfSrcset> = null;
    for (const a of LAZY_SET) {
      set = bestOfSrcset($el.attr(a));
      if (set) break;
    }
    const url = set?.url ?? lazy ?? (isPlaceholder(src) ? '' : src);
    if (!url) return;
    const w = num($el.attr('width')) ?? num($el.attr('data-width')) ?? set?.width ?? null;
    const h = num($el.attr('height')) ?? num($el.attr('data-height'));
    const inHeader = $el.closest('header, nav, footer').length > 0;
    const weight = (inHeader ? 0.15 : Math.max(0.3, 0.9 - i * 0.03)) * weightScale;
    // A gallery / lightbox shows a small preview inside a link to the full picture (<a href="photo.jpg"><img src="thumbnail_photo.jpg"></a>).
    // The link names the real file, so that file is the candidate; the preview is only the pointer to it (its declared size is the preview's).
    const link = $el.closest('a[href]');
    const href = decode(link.attr('href'));
    if (link.length && !inHeader && isImageLink(href) && href !== url) {
      add({ url: href, previewUrl: url, alt: decode($el.attr('alt')) || decode(link.attr('title')) || null, title: decode($el.attr('title')) || null, width: num(link.attr('data-width')), height: num(link.attr('data-height')), where: 'gallery_link', context: contextOf($el), weight });
      return;
    }
    add({ url, alt: decode($el.attr('alt')) || null, title: decode($el.attr('title')) || null, width: w, height: h, where: 'img', context: contextOf($el), weight });
  };
  $('img').each((i, el) => imgOf($(el), i));
  // a lazy-loading script often leaves the real <img> only inside <noscript>
  $('noscript').each((_, el) => {
    const inner = $(el).html() ?? '';
    if (!/<img/i.test(inner)) return;
    const $n = cheerio.load(inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    $n('img').each((i, img) => {
      const a = $n(img);
      const set = bestOfSrcset(a.attr('srcset'));
      const url = set?.url ?? decode(a.attr('src'));
      if (url && !isPlaceholder(url)) add({ url, alt: decode(a.attr('alt')) || null, width: num(a.attr('width')) ?? set?.width ?? null, height: num(a.attr('height')), where: 'img', context: contextOf($(el)), weight: Math.max(0.3, 0.8 - i * 0.03) });
    });
  });
  $('picture source').each((_, el) => {
    const set = bestOfSrcset($(el).attr('srcset') ?? $(el).attr('data-srcset'));
    if (set) add({ url: set.url, width: set.width, where: 'picture', context: contextOf($(el)), weight: 0.6, alt: decode($(el).closest('picture').find('img').attr('alt')) || null });
  });
  $('[style*="url("]').each((_, el) => {
    const style = $(el).attr('style') ?? '';
    if (!/background/i.test(style)) return;
    for (const m of style.matchAll(CSS_URL)) if (!isPlaceholder(m[1])) add({ url: m[1], where: 'background', context: contextOf($(el)), weight: 0.5, alt: decode($(el).attr('aria-label') ?? $(el).attr('title')) || null });
  });
  $(BG_ATTRS.map((a) => `[${a}]`).join(', ')).each((_, el) => {
    for (const a of BG_ATTRS) {
      const v = decode($(el).attr(a));
      const url = bestOfSrcset(v)?.url ?? v.replace(/^url\(\s*['"]?|['"]?\s*\)$/g, '');
      if (url && !isPlaceholder(url)) add({ url, where: 'background', context: contextOf($(el)), weight: 0.5, alt: decode($(el).attr('aria-label') ?? $(el).attr('title')) || null });
    }
  });
  // the page's own <style> blocks (bounded); external stylesheets are not read
  let styleBudget = 200_000;
  $('style').each((_, el) => {
    if (styleBudget <= 0) return;
    const css = $(el).text().slice(0, styleBudget);
    styleBudget -= css.length;
    let n = 0;
    for (const m of css.matchAll(STYLE_BG)) {
      if (++n > 40) break;
      if (!isPlaceholder(m[1])) add({ url: m[1], where: 'background', weight: 0.35 });
    }
  });
  void pageUrl;
  return out;
}

// ---- which pages to read --------------------------------------------------------------------------------------------------------------------------------

const LOCALES = new Set('en de fr it es pt nl sr hr bs sl mk sq pl cs sk hu ro bg ru uk tr el sv da no nb fi et lv lt ja zh ko ar he'.split(' '));
/** pages never read for pictures: legal, login / account, shop flow, search and feeds */
const NEVER_READ = /(impressum|imprint|datenschutz|privacy|cookie|\bagb\b|\/agb|terms|legal|disclaimer|gdpr|dsgvo|login|log-in|signin|sign-in|signup|sign-up|register|account|admin|wp-admin|wp-login|dashboard|cart|checkout|basket|warenkorb|kasse|korpa|search|suche|\/feed|rss|\/tag\/|\/category\/|\/author\/|\/page\/\d|unsubscribe)/i;
const PAGE_KINDS: [RegExp, number, string][] = [
  [/team|staff|our-people|people|mitarbeit|equipe|ekipa|\btim\b/i, 10, 'team'],
  [/about|ueber-uns|uber-uns|über-uns|who-we-are|unternehmen|company|o-nama|onama|story|history|geschichte|wir\b/i, 9, 'about'],
  [/service|leistung|dienstleistung|angebot|usluge|offer|solution|loesung|lösung|beratung|consulting|what-we-do|expertise/i, 9, 'services'],
  [/galler|galerie|galerij|portfolio|project|projekt|reference|referenz|cases?\b|case-stud|showcase|kunden|clients|work\b/i, 8, 'gallery'],
  // a venue's guests (restaurants, hotels, events): pages of photographs of people at the place
  [/gosti|guests|gaeste|gäste/i, 7, 'gallery'],
  [/system|method|approach|ansatz|how-we-work|process|prozess|program|academy|akademie|training|kurs|course|workshop|seminar|schulung/i, 6, 'services'],
  [/product|produkt|proizvod|shop|collection|kollektion|menu|meni\b|jelovnik|speisekarte/i, 6, 'products'],
  [/career|karriere|jobs|join-us|stellen|karijer|posao/i, 5, 'about'],
  [/location|standort|office|buero|büro|contact|kontakt/i, 3, 'contact'],
  [/blog|news|aktuell|magazin|insights|journal|vijesti|novosti/i, 3, 'blog'],
];

export interface PageLink {
  href: string;
  text: string;
  nav: boolean;
  nofollow: boolean;
}

/** The links of a page with what a crawler must know about them (absolute, no fragment). Pure. */
export function linksOfHtml(html: string, pageUrl: string): PageLink[] {
  const $ = cheerio.load(html);
  const out: PageLink[] = [];
  $('a[href]').each((_, el) => {
    const raw = decode($(el).attr('href'));
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) return;
    try {
      const u = new URL(raw, pageUrl);
      u.hash = '';
      out.push({ href: u.toString(), text: decode($(el).text()).slice(0, 80), nav: $(el).closest('header, nav, [role="navigation"]').length > 0, nofollow: /\bnofollow\b/i.test($(el).attr('rel') ?? '') });
    } catch {
      /* not a link */
    }
  });
  return out;
}

/**
 * One page, however it is linked: `http://` and `https://`, with or without `www.`, with or without the trailing slash. Sites often mix these in their
 * own links; read as different pages, the same page took two places of the page budget.
 */
export function pageKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return raw;
  }
}

const localeOf = (path: string): string | null => {
  const seg = path.split('/')[1]?.toLowerCase() ?? '';
  return LOCALES.has(seg) || /^[a-z]{2}-[a-z]{2}$/.test(seg) ? seg : null;
};

/** The role of a same-site page from its path and link text (team, about, services, gallery, ...), or 'page'. */
export function imagePageRole(url: string, text = ''): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep the raw text */
  }
  const hay = `${path} ${text}`;
  return PAGE_KINDS.find(([re]) => re.test(hay))?.[2] ?? (path === '/' || (localeOf(path) !== null && path.split('/').filter(Boolean).length === 1) ? 'home' : 'page');
}

/**
 * Same-site pages worth reading for pictures, best first. Team, about and services first; galleries, methods and products next; a navigation link that
 * names nothing known is read only when nothing better is left. Never: another host, a query string, a nofollow link, a file, a legal / login / shop
 * page, or the same page in another language (when the site was entered in one language, its other-language copies show the same pictures).
 */
export function rankImagePages(links: readonly PageLink[], baseUrl: string, read: ReadonlySet<string>): { href: string; score: number; role: string }[] {
  const base = new URL(baseUrl);
  const host = base.hostname.replace(/^www\./, '');
  const locale = localeOf(base.pathname);
  const best = new Map<string, { href: string; score: number; role: string }>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== host || (u.protocol !== 'https:' && u.protocol !== 'http:')) continue;
    // the same page linked through the other scheme or host spelling is read the way the site was entered
    u.protocol = base.protocol;
    u.hostname = base.hostname;
    if (l.nofollow || u.search || /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp4|mp3|avi|mov|docx?|xlsx?|pptx?|exe|dmg|css|js|json|xml|txt)$/i.test(u.pathname)) continue;
    const key = pageKey(u.toString());
    if (read.has(key) || key === pageKey(base.toString())) continue;
    if (NEVER_READ.test(u.pathname)) continue;
    const loc = localeOf(u.pathname);
    if (locale ? loc !== locale : loc !== null) continue;
    const segments = u.pathname.split('/').filter(Boolean).length - (loc ? 1 : 0);
    if (segments <= 0) continue;
    const hay = `${u.pathname} ${l.text}`;
    const kind = PAGE_KINDS.find(([re]) => re.test(hay));
    let score = kind ? kind[1] : l.nav ? 2 : 0;
    if (!score) continue;
    // a blog or news listing may carry pictures; its individual articles rarely carry the business's own
    if (kind?.[2] === 'blog' && segments > 1) continue;
    if (l.nav) score += 0.5;
    score -= Math.max(0, segments - 2) * 1.5;
    const cur = best.get(key);
    if (!cur || score > cur.score) best.set(key, { href: `${u.origin}${u.pathname}`, score, role: kind?.[2] ?? 'page' });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (a.href < b.href ? -1 : 1));
}

// ---- what a picture shows ---------------------------------------------------------------------------------------------------------------------------------

const TEAM_WORDS = /\b(team|teams|staff|crew|our people|colleagues|kollegen|mitarbeit\w*|belegschaft|équipe|equipe|ekipa|tim|kolektiv)\b/i;
const PEOPLE_WORDS = /\b(people|person|persons|man|men|woman|women|girl|boy|family|families|customer|customers|client|clients|guest|guests|student|students|executives?|managers?|consultants?|advisors?|berater\w*|kunden?|meeting|conversation|gespräch|discussion|workshop|handshake|smiling|portrait|headshot|founders?|owner|ceo|employees?|worker|workers|engineer|chef|doctor|nurse|teacher|instructor|trainer|coach|speaker|audience|participants?)\b/i;
const PLACE_WORDS = /\b(office|offices|büro|buero|workplace|workspace|building|headquarters|hq|factory|production|floor|warehouse|plant|site|interior|reception|lobby|store|shop|showroom|restaurant|kitchen|studio|clinic|lab|laboratory|campus|classroom|location|standort|premises)\b/i;
const SERVICE_WORDS = /\b(service|services|leistung\w*|beratung|consulting|advice|support|training|course|kurs|seminar|coaching|repair|installation|delivery|treatment|therapy|analysis|audit|implementation|planning)\b/i;
const PRODUCT_WORDS = /\b(product|products|produkt\w*|packshot|package|packaging|bottle|box|device|app|bag|shoe|dress|jewel\w*|collection)\b/i;
const GRAPHIC_WORDS = /\b(banner|infographic|flyer|poster|brochure|slide|slides|screenshot|screenshots|dashboard|mockup|diagram|chart|graph|illustration|graphic|icon|icons|pattern|texture|badge|certificate|award|seal|map|qr|cover-image|share-image|social-card|og-image)\b/i;
const SHARE_CARD_FILE = /(^|[-_./])(og|opengraph|open-graph|default|share|sharing|social|card|preview|twitter|fb|facebook|meta)([-_.]|$)/i;
const PORTRAIT_FILE = /(^|[-_/])(portrait|headshot|avatar|profile|member|employee|staff|lead|senior|spec|junior|partner|founder|ceo|cto|coo|cfo)([-_.]|$)/i;
const GENERIC_NAME_WORDS = /^(team|group|gruppe|company|gmbh|ag|inc|ltd|llc|office|logo|image|photo|picture|bild|foto|hero|banner|home|about|our|the|and|und|der|die|das|und|with|mit)$/i;

/** "Dominic Görg", "Dr. Ulrich von Bassewitz": an alt text that is a person's name (2-5 words, at least two capitalised, nothing generic). */
export function looksLikePersonName(alt: string | null | undefined, siteWords: readonly string[] = []): boolean {
  const t = decode(alt);
  if (!t || t.length > 48 || /[0-9@:|/]/.test(t)) return false;
  const words = t.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  let caps = 0;
  for (const w of words) {
    if (GENERIC_NAME_WORDS.test(w) || siteWords.includes(w.toLowerCase())) return false;
    if (/^(dr\.?|prof\.?|dipl\.?|mag\.?|ing\.?|von|van|de|der|den|da|di|du|le|la|del|zu|y|el|bin|al)$/i.test(w)) continue;
    if (/^\p{Lu}[\p{L}'’.-]+$/u.test(w)) caps++;
    else return false;
  }
  return caps >= 2;
}

/** What a website picture probably shows, from its words, its page and its declared shape. Deterministic, no pixels. */
export function classifyWebsiteImage(c: { url: string; alt?: string | null; title?: string | null; context?: string; where: WebsiteImageCandidate['where']; pageRole?: string; width?: number | null; height?: number | null }, siteWords: readonly string[] = []): WebsiteImageCategory | 'logo' {
  const u = unwrapImageUrl(c.url);
  const file = decodeURIComponent((u?.pathname ?? c.url).split('/').pop() ?? '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/\.[0-9a-f]{6,}$/, '');
  const fileWords = file.replace(/[-_.]+/g, ' ');
  const own = `${c.alt ?? ''} ${c.title ?? ''} ${fileWords}`;
  if (LOGO_WORDS.test(`${file} ${c.alt ?? ''}`) && !PEOPLE_WORDS.test(c.alt ?? '') && !TEAM_WORDS.test(c.alt ?? '')) return 'logo';
  const people = PEOPLE_WORDS.test(own) || TEAM_WORDS.test(own);
  if ((c.where === 'open_graph' || c.where === 'twitter' || c.where === 'schema_org' || c.where === 'link_rel') && SHARE_CARD_FILE.test(file) && !people) return 'brand_graphic';
  if (GRAPHIC_WORDS.test(own) && !people) return 'brand_graphic';
  if (c.width && c.height && (c.width / c.height > 4 || c.height / c.width > 4) && !people) return 'brand_graphic';
  if (TEAM_WORDS.test(own)) return 'team';
  if (looksLikePersonName(c.alt, siteWords) && (c.pageRole === 'team' || c.pageRole === 'about' || PORTRAIT_FILE.test(file))) return 'portrait';
  if (PEOPLE_WORDS.test(own)) return PORTRAIT_FILE.test(file) ? 'portrait' : 'people';
  if (PLACE_WORDS.test(own)) return 'workplace';
  if (c.pageRole === 'services' || SERVICE_WORDS.test(own)) return 'service';
  if (c.pageRole === 'products' || PRODUCT_WORDS.test(own)) return 'product';
  const ctx = c.context ?? '';
  if (TEAM_WORDS.test(ctx)) return 'team';
  if (PEOPLE_WORDS.test(ctx)) return 'people';
  if (PLACE_WORDS.test(ctx)) return 'workplace';
  return 'other';
}

const CATEGORY_LABEL: Record<WebsiteImageCategory, string> = { team: 'a team photograph', portrait: 'a portrait of a team member', people: 'a photograph of people at work', workplace: 'a photograph of the business environment', service: 'a photograph illustrating a service', product: 'a product photograph', other: 'a photograph of the website', brand_graphic: 'a brand graphic' };

/**
 * The campaign image library: at most `max` distinct photographs, best first. Team and people photographs first, then the business environment, then
 * services, products and the rest; at most three single-person portraits. Only first-party pictures large enough for a creative are recommended;
 * brand graphics and logos never count. Fewer than five is a valid answer: nothing is added to fill a quota. Pure.
 */
export function recommendLibrary(list: readonly WebsiteImageCandidate[], o: { max?: number } = {}): WebsiteImageCandidate[] {
  const max = Math.max(1, Math.min(LIBRARY_MAX, o.max ?? LIBRARY_MAX));
  const quality = (c: WebsiteImageCandidate) => {
    const long = Math.max(c.width ?? 0, c.height ?? 0);
    const size = long ? Math.min(1, long / 1600) : 0.4;
    const page = c.pageRole === 'team' || c.pageRole === 'about' ? 0.1 : c.pageRole === 'services' || c.pageRole === 'home' ? 0.06 : 0;
    return c.prominence * 0.5 + size * 0.3 + (c.alt ? 0.1 : 0) + page;
  };
  const verdict = (c: WebsiteImageCandidate): string | null => {
    const cat = c.category ?? 'other';
    if (cat === 'brand_graphic') return 'Not recommended: it looks like a brand graphic (share card, banner or illustration), kept apart from the photographs.';
    if (!c.firstParty) return 'Not recommended: it is served by another website, so it is probably not the business\'s own picture.';
    const long = Math.max(c.width ?? 0, c.height ?? 0);
    if (long && long < MIN_LIBRARY_SIDE) return `Not recommended: only ${long} px on its long side (${MIN_LIBRARY_SIDE} are needed to stay sharp in a creative).`;
    return null;
  };
  const ordered = [...list].sort((a, b) => CATEGORY_PRIORITY[a.category ?? 'other'] - CATEGORY_PRIORITY[b.category ?? 'other'] || quality(b) - quality(a) || (a.url < b.url ? -1 : 1));
  // a few places stay open for the business environment / services / products when the site shows usable ones (people photographs still come first)
  const isPeople = (c: WebsiteImageCandidate) => CATEGORY_PRIORITY[c.category ?? 'other'] === 1;
  const others = ordered.filter((c) => !verdict(c) && !isPeople(c) && c.category !== 'other').length;
  const peopleMax = max - Math.min(RESERVED_OTHER, others);
  let portraits = 0;
  let people = 0;
  let rank = 0;
  const out = ordered.map((c): WebsiteImageCandidate => {
    const no = verdict(c);
    if (no) return { ...c, recommended: false, rank: null, why: no };
    if (rank >= max) return { ...c, recommended: false, rank: null, why: `Not recommended: the library already holds the ${max} most useful pictures.` };
    if (c.category === 'portrait' && portraits >= MAX_PORTRAITS) return { ...c, recommended: false, rank: null, why: `Not recommended: ${MAX_PORTRAITS} single-person portraits are already in the library.` };
    if (isPeople(c) && people >= peopleMax) return { ...c, recommended: false, rank: null, why: 'Not recommended: the library keeps room for the business environment and its services.' };
    if (c.category === 'portrait') portraits++;
    if (isPeople(c)) people++;
    rank++;
    return { ...c, recommended: true, rank, why: `Recommended: ${CATEGORY_LABEL[c.category ?? 'other']}.` };
  });
  return out.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || CATEGORY_PRIORITY[a.category ?? 'other'] - CATEGORY_PRIORITY[b.category ?? 'other'] || b.prominence - a.prominence || (a.url < b.url ? -1 : 1));
}

/**
 * The category of a picture once its pixels exist (after the owner approved and imported it): a flat graphic with no face (a share card, a text banner,
 * a screenshot) is a BRAND GRAPHIC whatever its words said; a picture with faces that was filed as "other" / "service" / "product" shows people. A picture
 * the words already marked as a brand graphic stays one (a banner with a face in it still carries its own text).
 * Local and deterministic (the same light-weight analysis the designer uses); it never identifies anyone.
 */
export async function categoryOfPixels(buf: Buffer, prior: WebsiteImageCategory | null | undefined): Promise<{ category: WebsiteImageCategory; faces: number; graphic: boolean } | null> {
  const m = await analyzeSubject(buf);
  if (!m) return null;
  const faces = m.faces.length;
  const before = prior ?? 'other';
  let category: WebsiteImageCategory = before;
  if (m.graphic && !faces) category = 'brand_graphic';
  else if (faces && (before === 'other' || before === 'service' || before === 'product' || before === 'workplace')) category = faces >= 3 ? 'team' : 'people';
  return { category, faces, graphic: m.graphic };
}

// ---- explaining an empty result ---------------------------------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<RejectKind, string> = {
  logo: 'logo(s), offered separately as logo candidates',
  icon: 'icon(s) or interface graphic(s)',
  too_small: 'picture(s) too small for a creative',
  thumbnail: 'thumbnail preview(s) without a linked full-size version',
  strip: 'thin strip(s)',
  not_photo: 'vector, animation or document file(s)',
  tracking: 'tracking pixel(s)',
  robots: 'picture(s) robots.txt does not allow fetching',
  not_public: 'non-public address(es)',
  unclear_type: 'address(es) whose file type is not clear',
};

/** Why nothing usable came out of pages that WERE read, from what was actually seen and rejected (never "no pictures" when pictures were found). */
function emptyResultNote(read: number, references: number, rejected: readonly { kind?: RejectKind }[]): string {
  if (!references) return `${read} page(s) read, but their HTML declares no pictures (pictures that a script adds later are not seen by this reader).`;
  const counts = new Map<RejectKind, number>();
  for (const r of rejected) if (r.kind) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KIND_LABEL[k]}`);
  return `${read} page(s) read and ${references} picture reference(s) found, but none is a usable photograph${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

/** The reasons the photographs that were found are not recommended (too small, another website), counted. */
function whyNone(photos: readonly WebsiteImageCandidate[]): string {
  const counts = new Map<string, number>();
  for (const c of photos) {
    const why = !c.firstParty ? 'served by another website' : Math.max(c.width ?? 0, c.height ?? 0) && Math.max(c.width ?? 0, c.height ?? 0) < MIN_LIBRARY_SIDE ? `smaller than ${MIN_LIBRARY_SIDE} px on the long side` : 'not suitable';
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return `${[...counts.entries()].map(([w, n]) => `${n} ${w}`).join(', ')}. Nothing was added to fill the gap.`;
}

// ---- the crawl ------------------------------------------------------------------------------------------------------------------------------------------

export interface DiscoverWebsiteOptions {
  web?: Pick<WebFetchTool, 'fetchPage' | 'checkUrl'> & Partial<Pick<WebFetchTool, 'robotsAllow'>>;
  /** pages read in total, the home page included (default 8, at most 10) */
  maxPages?: number;
  /** total HTML bytes read (default 6 MB) */
  maxBytes?: number;
  /** wall-clock budget of the whole discovery (default 30 s) */
  budgetMs?: number;
  /** how many link steps away from the home page a page may be (default 2) */
  maxDepth?: number;
  maxCandidates?: number;
  /** Also collect the home page's logo candidates (the business words are used to recognize a logo that names the business). */
  logoBrand?: string[];
  signal?: AbortSignal;
  now?: () => number;
}

/** Enough strong photographs were found: reading more pages would not change the recommendation. */
const ENOUGH_STRONG = 24;

/**
 * Reads the home page and the relevant pages of the SAME site (bounded: pages, depth, bytes, time; robots.txt respected) and returns the picture
 * candidates, the recommended library first. Nothing here fetches an image file.
 */
export async function discoverWebsiteImages(siteUrl: string, o: DiscoverWebsiteOptions = {}): Promise<WebsiteImageDiscovery> {
  const maxPages = Math.max(1, Math.min(10, o.maxPages ?? 8));
  const maxBytes = o.maxBytes ?? 6_000_000;
  const maxDepth = Math.max(0, Math.min(3, o.maxDepth ?? 2));
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? 30_000);
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
  const siteWords = siteHost.replace(/^www\./, '').split('.').slice(0, -1).map((w) => w.toLowerCase());

  const rawAll: (Raw & { pageUrl: string; pageRole: string })[] = [];
  const readKeys = new Set<string>();
  const keyOf = pageKey;
  let bytes = 0;
  let stoppedBy: string | null = null;
  const strongStems = new Set<string>();
  const readPage = async (url: string, role: string): Promise<{ links: PageLink[]; finalUrl: string } | null> => {
    readKeys.add(keyOf(url));
    const r = await web.fetchPage(url, o.signal);
    if (!r.ok) {
      const blocked = r.code === 'robots_disallowed' || r.code === 'bot_protected' || r.code === 'blocked_url';
      if (r.code === 'page_limit') return null;
      const notFound = r.code === 'http_error' && (r.status === 404 || r.status === 410);
      const message =
        r.code === 'robots_disallowed'
          ? 'robots.txt does not allow reading this page; it was not read.'
          : r.code === 'bot_protected'
            ? `${r.message ? `${r.message} ` : ''}The page is protected against automated reading; it was not worked around.`
            : r.status === 401 || r.status === 403
              ? 'The page needs a login or is not public; it was not read.'
              : notFound && role === 'home'
                ? // the address the owner entered: the server itself says it does not exist (some servers answer automated readers so even when a browser shows the page)
                  `The website answered HTTP ${r.status} (page not found) to LaunchPilot's reader for ${url}. Some servers answer automated readers this way even when the page opens in a browser; the answer is respected, not worked around. Check the website address, or upload the logo and photographs yourself.`
                : r.message;
      out.pages.push({ url, status: blocked ? 'blocked' : 'failed', message, images: 0 });
      return null;
    }
    readKeys.add(keyOf(r.finalUrl));
    bytes += r.bytes ?? r.body.length;
    const $robots = /<meta[^>]+name=["']?(robots|launchpilotbot)["']?[^>]*>/gi;
    const noImageIndex = [...r.body.slice(0, 60_000).matchAll($robots)].some((m) => /content=["'][^"']*(noimageindex|none)/i.test(m[0]));
    const imgs = noImageIndex ? [] : imagesOfHtml(r.body, r.finalUrl);
    if (noImageIndex) notes.push(`${r.finalUrl} asks search engines not to index its pictures (noimageindex); its pictures were not collected.`);
    const pageRole = role;
    for (const i of imgs) {
      rawAll.push({ ...i, pageUrl: r.finalUrl, pageRole });
      const long = Math.max(i.width ?? 0, i.height ?? 0);
      if (long >= MIN_LIBRARY_SIDE) strongStems.add(imageStem(new URL(i.url, r.finalUrl).toString()));
    }
    // the logo is on every page; the home page (the first one read) is enough and keeps the work bounded
    if (o.logoBrand && !out.logos) out.logos = logosOfHtml(r.body, r.finalUrl, o.logoBrand);
    const page = extractPage(r.body, r.finalUrl);
    for (const s of page.socialLinks) if (!out.socialLinks.some((x) => x.url === s.url)) out.socialLinks.push(s);
    out.pages.push({ url: r.finalUrl, status: 'read', message: null, images: imgs.length });
    return { links: linksOfHtml(r.body, r.finalUrl), finalUrl: r.finalUrl };
  };

  const home = await readPage(siteUrl, 'home');
  if (home && maxPages > 1) {
    // best first across depths: the pages the home page links to, then - while budget is left - the clearly relevant pages those link to
    // (team, about, services, gallery, method: score 6 and more), one step further costing a point
    const queue = rankImagePages(home.links, home.finalUrl, readKeys).map((l) => ({ ...l, depth: 1 }));
    const queued = new Set(queue.map((l) => keyOf(l.href)));
    let skipped = 0;
    while (queue.length) {
      queue.sort((a, b) => b.score - a.score || a.depth - b.depth || (a.href < b.href ? -1 : 1));
      const link = queue.shift()!;
      if (o.signal?.aborted) stoppedBy ??= 'the discovery was cancelled';
      else if (out.pages.filter((p) => p.status === 'read').length >= maxPages) stoppedBy ??= `the page limit (${maxPages}) was reached`;
      else if (bytes >= maxBytes) stoppedBy ??= 'the size limit for reading pages was reached';
      else if (now() >= deadline) stoppedBy ??= 'the time limit was reached';
      else if (strongStems.size >= ENOUGH_STRONG && readKeys.size >= 4) stoppedBy ??= `${ENOUGH_STRONG} large pictures were already found`;
      if (stoppedBy) {
        skipped += 1 + queue.length;
        break;
      }
      if (readKeys.has(keyOf(link.href))) continue;
      const got = await readPage(link.href, link.role);
      if (got && link.depth < maxDepth) {
        for (const l of rankImagePages(got.links, home.finalUrl, readKeys)) {
          if (l.score < 6 || queued.has(keyOf(l.href))) continue;
          queued.add(keyOf(l.href));
          queue.push({ ...l, score: l.score - link.depth, depth: link.depth + 1 });
        }
      }
    }
    if (stoppedBy && skipped) notes.push(`${skipped} more page(s) of the site were not read because ${stoppedBy}.`);
  }
  if (!out.pages.some((p) => p.status === 'read')) {
    notes.push('No page of the website could be read, so no website pictures were found. Upload your own pictures or use a licensed provider.');
    return out;
  }

  // normalise, filter, merge sizes of the same picture
  const byStem = new Map<string, WebsiteImageCandidate & { weight: number; area: number }>();
  const reject = (url: string, reason: string, kind: RejectKind) => {
    if (!out.rejected.some((r) => r.url === url)) out.rejected.push({ url, reason, kind });
  };
  let logosSeen = 0;
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
    const file = unwrapImageUrl(abs) ?? abs;
    const policy = web.checkUrl(url);
    if (!policy.ok) {
      reject(url, 'The address is not a public web address.', 'not_public');
      continue;
    }
    if (TRACKING_HOST.test(url)) {
      reject(url, 'A tracking pixel, not a picture.', 'tracking');
      continue;
    }
    if (NOT_PICTURE_EXT.test(file.pathname)) {
      reject(url, 'Not a photograph (vector, icon, animation or document).', 'not_photo');
      continue;
    }
    const category = classifyWebsiteImage({ ...r, url, pageRole: r.pageRole }, siteWords);
    if (category === 'logo') {
      logosSeen++;
      reject(url, 'A logo: logos are collected separately (logo candidates), never as campaign photographs.', 'logo');
      continue;
    }
    if (DECORATIVE.test(file.pathname)) {
      reject(url, 'An icon or interface graphic, not campaign imagery.', 'icon');
      continue;
    }
    if (!r.width && !r.height && TEMPLATE_PNG.test(file.pathname)) {
      reject(url, "A graphic of the site's template (button, flag or ornament), not campaign imagery.", 'icon');
      continue;
    }
    if ((r.width !== null && r.width !== undefined && r.width < MIN_SIDE) || (r.height !== null && r.height !== undefined && r.height < MIN_SIDE)) {
      reject(url, `Too small (${r.width ?? '?'}x${r.height ?? '?'} declared): it would look soft in a creative.`, 'too_small');
      continue;
    }
    if (r.width && r.height && (r.width / r.height > 6 || r.height / r.width > 6)) {
      reject(url, 'A thin strip, not a usable picture.', 'strip');
      continue;
    }
    // a preview that names itself a thumbnail, with no size on the page and no link to its full picture: too small to use, and not the original
    if (r.where !== 'gallery_link' && !r.width && !r.height && THUMB_FILE.test(file.pathname)) {
      reject(url, 'A thumbnail preview: the page links no full-size version of it, and a preview is too small for a creative.', 'thumbnail');
      continue;
    }
    if (!RASTER_PATH.test(file.pathname) && !RASTER_FORMAT_PARAM.test(file.search) && r.where !== 'open_graph' && r.where !== 'twitter' && r.where !== 'schema_org') {
      // an address without a file extension (a CDN) is accepted only when the page itself marks it as its image
      if (!(r.width && r.width >= 400)) {
        reject(url, 'The file type is not clear from the address.', 'unclear_type');
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
      ...(r.previewUrl ? { previewUrl: new URL(r.previewUrl, r.pageUrl).toString() } : {}),
      context: r.context ?? '',
      prominence: Math.min(1, r.weight),
      firstParty: isFirstParty(file.hostname, siteHost) && isFirstParty(abs.hostname, siteHost),
      category,
      pageRole: r.pageRole,
      weight: r.weight,
      // a size counts only when BOTH sides are declared: a srcset "3840w" is the width a browser may ASK for, not the size of the picture
      area: r.width && r.height ? r.width * r.height : 0,
    };
    const key = imageStem(url);
    const cur = byStem.get(key);
    // keep the better description of one picture: the larger declared size, the more prominent place; a people / team reading wins over "other"
    const better = (a: WebsiteImageCategory, b: WebsiteImageCategory) => (CATEGORY_PRIORITY[a] <= CATEGORY_PRIORITY[b] ? a : b);
    const merged = (main: typeof cand, other: typeof cand): typeof cand => ({
      ...main,
      width: main.area || !other.area ? (main.width ?? other.width) : other.width,
      height: main.area || !other.area ? (main.height ?? other.height) : other.height,
      area: Math.max(main.area, other.area),
      alt: main.alt ?? other.alt,
      title: main.title ?? other.title,
      context: main.context || other.context,
      prominence: Math.max(main.prominence, other.prominence),
      category: better(main.category!, other.category!),
      pageRole: main.pageRole === 'home' && other.pageRole !== 'home' ? other.pageRole : main.pageRole,
    });
    if (!cur) byStem.set(key, cand);
    else if (cand.area > cur.area || (cand.area === cur.area && cand.weight > cur.weight)) byStem.set(key, merged(cand, cur));
    else byStem.set(key, merged(cur, cand));
  }

  // robots.txt also governs the picture files (checked once per origin: the rules are cached by the reader)
  let robotsBlocked = 0;
  if (web.robotsAllow) {
    // first-party pictures only: a picture on another host is never recommended, and its own robots.txt is checked when (if ever) it is imported
    for (const [key, c] of [...byStem.entries()].filter(([, c]) => c.firstParty).slice(0, 80)) {
      if (o.signal?.aborted) break;
      if (!(await web.robotsAllow(c.url, o.signal))) {
        byStem.delete(key);
        robotsBlocked++;
        reject(c.url, 'robots.txt does not allow fetching this picture; it is not offered.', 'robots');
      }
    }
  }

  const max = o.maxCandidates ?? 40;
  const all = recommendLibrary([...byStem.values()].map(({ weight: _w, area: _a, ...c }) => (void _w, void _a, c)));
  out.candidates = all.slice(0, max);
  if (all.length > max) notes.push(`${all.length - max} more picture(s) were found; the ${max} most useful are listed.`);

  const photos = all.filter((c) => c.category !== 'brand_graphic');
  const usable = photos.filter((c) => c.firstParty && !(Math.max(c.width ?? 0, c.height ?? 0) && Math.max(c.width ?? 0, c.height ?? 0) < MIN_LIBRARY_SIDE));
  const recommended = all.filter((c) => c.recommended).length;
  out.summary = { distinct: all.length, photos: photos.length, brandGraphics: all.length - photos.length, usable: usable.length, recommended, target: LIBRARY_TARGET, max: LIBRARY_MAX, targetReached: recommended >= LIBRARY_TARGET };
  const read = out.pages.filter((p) => p.status === 'read').length;
  if (!out.candidates.length) notes.unshift(emptyResultNote(read, rawAll.length, out.rejected));
  else if (!recommended && photos.length) notes.unshift(`${read} page(s) read: ${photos.length} distinct photograph(s) found, none recommended for the campaign library: ${whyNone(photos)}`);
  else
    notes.unshift(
      `${read} page(s) read: ${photos.length} distinct photograph(s)${all.length - photos.length ? ` and ${all.length - photos.length} brand graphic(s)` : ''} found${logosSeen ? ' (logos are listed separately)' : ''}; ${recommended} recommended for the campaign library` +
        (recommended < LIBRARY_TARGET ? ` - fewer than ${LIBRARY_TARGET}, because the site does not show more suitable pictures; nothing was added to fill the gap.` : '.'),
    );
  if (robotsBlocked) notes.push(`${robotsBlocked} picture(s) are not offered because robots.txt does not allow fetching them.`);
  const third = out.candidates.filter((c) => !c.firstParty).length;
  if (third) notes.push(`${third} picture(s) are served by another website. Being shown on your page does not make them yours.`);
  notes.push('No picture was downloaded: these are candidates. A picture is fetched only after you confirm that you hold the rights to use it.');
  return out;
}
