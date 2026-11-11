import * as cheerio from 'cheerio';

/**
 * LOGO DISCOVERY. Which picture is the company's real logo? Answered DETERMINISTICALLY (no model) from signals a person would also use, in the order the
 * product promises:
 *
 *   1. the logo the user uploaded as a logo
 *   2. the logo the project already approved
 *   3. official website candidates (structured data, the header, the link to the home page, a `logo` marked image)
 *   4. GitHub logo assets
 *   5. other uploads that look like a logo
 *
 * A file name containing "logo" proves nothing by itself (`partner-logo.png`, `react-logo.svg`, `client-logos.png` are other people's marks): every candidate
 * is scored from where it appears, what it says about itself and how it matches the business name, and known third-party contexts are penalized. A FAVICON is
 * a candidate of last resort: its confidence is capped below "medium" so it is never chosen over a real logo and never presented as the primary one.
 * Nothing here downloads a file: these are descriptions of candidates.
 */

export type LogoSource = 'upload' | 'approved' | 'website' | 'github';

export interface LogoCandidateInfo {
  source: LogoSource;
  /** the picture's address (website) or path (repository, upload name) */
  location: string;
  fileName: string;
  format: string;
  svg: boolean;
  width: number | null;
  height: number | null;
  /** 0..1; a favicon never exceeds 0.35 */
  confidence: number;
  /** plain-language reasons, best first */
  signals: string[];
  favicon: boolean;
  pageUrl: string | null;
  /** stable key inside the project (see dedupe) */
  key: string;
  /** extra facts by source (repository coordinates, declared size...) */
  meta: Record<string, unknown>;
}

export const confidenceLabel = (c: number): 'high' | 'medium' | 'low' => (c >= 0.7 ? 'high' : c >= 0.45 ? 'medium' : 'low');

const THIRD_PARTY = /(partner|client|customer|sponsor|trusted|award|badge|certif|member|press|featured|review|payment|visa|mastercard|paypal|stripe|social|facebook|twitter|instagram|linkedin|youtube|tiktok|pinterest|google|apple|appstore|app-store|playstore|play-store|whatsapp|telegram|testimonial|brands|logos?-(strip|slider|carousel|wall|grid)|as-seen)/i;
const TECH_LOGOS = /(^|[^a-z])(react|next(js)?|vue|angular|svelte|node(js)?|docker|github|gitlab|vercel|netlify|tailwind(css)?|typescript|postgres(ql)?|nest(js)?|webpack|vite|express|redis|mongodb|prisma|aws|azure|gcp|firebase|stripe|npm|yarn|pnpm|jest|eslint|prettier|bootstrap|jquery|wordpress|shopify|figma|openai|anthropic)([^a-z]|$)/i;
const RASTER = /\.(png|jpe?g|webp)(?:$|[?#])/i;
const SVG = /\.svg(?:$|[?#])/i;
const ICO = /\.ico(?:$|[?#])/i;

const words = (s: string) => (s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !['the', 'and', 'for', 'www', 'com', 'inc', 'ltd', 'llc', 'school', 'shop', 'store'].includes(w));
const formatOf = (u: string) => (SVG.test(u) ? 'svg' : ICO.test(u) ? 'ico' : /\.png/i.test(u) ? 'png' : /\.jpe?g/i.test(u) ? 'jpg' : /\.webp/i.test(u) ? 'webp' : /\.gif/i.test(u) ? 'gif' : 'unknown');
const fileOf = (u: string) => {
  try {
    return decodeURIComponent(new URL(u, 'https://x.invalid').pathname.split('/').pop() ?? '') || u;
  } catch {
    return u.split('/').pop() ?? u;
  }
};
const num = (v: string | undefined) => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The brand's own words (name, site host) used to recognize a logo that names the business. */
export const brandWordsOf = (...texts: (string | null | undefined)[]): string[] => [...new Set(texts.flatMap((t) => words(t ?? '')))].slice(0, 8);

function nameMatch(text: string, brand: readonly string[]): boolean {
  if (!brand.length) return false;
  const have = words(text);
  return brand.some((b) => have.some((h) => h === b || (h.length > 4 && b.length > 4 && (h.startsWith(b) || b.startsWith(h)))));
}

// ---- website ---------------------------------------------------------------------------------------------------------------------------------------

/** The logo candidates one page of HTML declares. Pure: no network. */
export function logosOfHtml(html: string, pageUrl: string, brand: readonly string[] = []): LogoCandidateInfo[] {
  const $ = cheerio.load(html);
  const out: LogoCandidateInfo[] = [];
  const abs = (u: string | undefined | null) => {
    const v = (u ?? '').trim();
    if (!v || v.startsWith('data:')) return null;
    try {
      const x = new URL(v, pageUrl);
      if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
      x.hash = '';
      return x.toString();
    } catch {
      return null;
    }
  };
  const add = (o: { url: string | null; base: number; signals: string[]; favicon?: boolean; width?: number | null; height?: number | null; context?: string; order: number }) => {
    if (!o.url) return;
    const fmt = formatOf(o.url);
    const file = fileOf(o.url);
    const hay = `${o.url} ${o.context ?? ''}`;
    let c = o.base;
    const signals = [...o.signals];
    if (THIRD_PARTY.test(hay)) {
      c -= 0.45;
      signals.push('looks like a partner, client or social mark, not the company logo');
    }
    if (TECH_LOGOS.test(file)) {
      c -= 0.4;
      signals.push('looks like a technology vendor\'s logo');
    }
    if (nameMatch(hay, brand)) {
      c += 0.12;
      signals.push('names the business');
    }
    if ((o.width !== null && o.width !== undefined && o.width < 24) || (o.height !== null && o.height !== undefined && o.height < 16)) {
      c -= 0.3;
      signals.push('very small');
    }
    if (fmt === 'ico' || fmt === 'gif') c -= 0.1;
    c -= Math.min(0.1, o.order * 0.01); // earlier in the page wins ties
    const favicon = o.favicon === true;
    out.push({ source: 'website', location: o.url, fileName: file, format: fmt, svg: fmt === 'svg', width: o.width ?? null, height: o.height ?? null, confidence: Math.max(0, Math.min(favicon ? 0.35 : 0.95, Math.round(c * 100) / 100)), signals: signals.slice(0, 5), favicon, pageUrl, key: `website:${o.url.replace(/[?#].*$/, '')}`, meta: {} });
  };

  let order = 0;
  // structured data: Organization / LocalBusiness / Brand `logo`
  $('script[type="application/ld+json"]').each((_, el) => {
    const walk = (node: unknown, depth = 0) => {
      if (depth > 5 || node == null) return;
      if (Array.isArray(node)) return void node.slice(0, 30).forEach((n) => walk(n, depth + 1));
      if (typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      const v = o.logo;
      const u = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null;
      if (u) add({ url: abs(u), base: 0.88, signals: ['declared as the logo in the site\'s structured data'], order: order++, width: v && typeof v === 'object' ? num(String((v as { width?: unknown }).width ?? '')) : null });
      for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, depth + 1);
    };
    try {
      walk(JSON.parse($(el).contents().text()));
    } catch {
      /* malformed JSON-LD is ignored */
    }
  });
  $('[itemprop="logo"]').each((_, el) => {
    const $el = $(el);
    const u = $el.is('img') ? $el.attr('src') : ($el.attr('content') ?? $el.attr('href') ?? $el.find('img').attr('src'));
    add({ url: abs(u), base: 0.84, signals: ['marked as the logo in the page markup (itemprop)'], width: num($el.attr('width')), height: num($el.attr('height')), order: order++ });
  });
  const ogLogo = $('meta[property="og:logo"], meta[name="og:logo"]').attr('content');
  if (ogLogo) add({ url: abs(ogLogo), base: 0.7, signals: ['declared as og:logo'], order: order++ });

  // images the page shows: header / brand areas / the link to the home page
  const homePath = (() => {
    try {
      return new URL(pageUrl).pathname;
    } catch {
      return '/';
    }
  })();
  $('img').each((i, el) => {
    const $el = $(el);
    const src = $el.attr('src') ?? $el.attr('data-src') ?? $el.attr('data-lazy-src') ?? $el.attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    const url = abs(src);
    if (!url) return;
    const cls = `${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''} ${$el.parent().attr('class') ?? ''} ${$el.parent().attr('id') ?? ''}`;
    const alt = $el.attr('alt') ?? '';
    const inHeader = $el.closest('header, nav, [role="banner"], .navbar, .nav, .site-header, #header').length > 0;
    const inFooter = $el.closest('footer, .footer').length > 0;
    const homeLink = $el.closest('a').filter((_, a) => {
      const h = $(a).attr('href') ?? '';
      if (h === '/' || h === '' || h === './' || h === '#') return true;
      try {
        const u = new URL(h, pageUrl);
        return u.origin === new URL(pageUrl).origin && (u.pathname === '/' || u.pathname === homePath) && !u.search;
      } catch {
        return false;
      }
    }).length > 0;
    const marked = /logo|brand|wordmark|site-title|navbar-brand/i.test(`${cls} ${alt} ${fileOf(url)}`);
    const signals: string[] = [];
    let base = 0;
    if (inHeader && marked) (base = 0.78), signals.push('in the page header and marked as a logo');
    else if (inHeader && homeLink) (base = 0.74), signals.push('in the page header, linking to the home page');
    else if (homeLink && marked) (base = 0.7), signals.push('links to the home page and is marked as a logo');
    else if (inHeader) (base = 0.4), signals.push('in the page header');
    else if (marked && !inFooter) (base = 0.42), signals.push('marked as a logo in the page');
    else if (marked && inFooter) (base = 0.3), signals.push('a logo in the page footer');
    else return; // an ordinary picture is not a logo candidate
    add({ url, base, signals, width: num($el.attr('width')), height: num($el.attr('height')), context: `${alt} ${cls}`, order: order++ + i });
  });
  // inline SVG logos have no address: they cannot be imported, so they are not listed

  // icons: candidates of last resort
  $('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]').each((_, el) => {
    const sizes = $(el).attr('sizes')?.split('x')[0];
    add({ url: abs($(el).attr('href')), base: 0.3, favicon: true, signals: ['a home-screen icon, not a full logo'], width: num(sizes), height: num(sizes), order: order++ });
  });
  $('link[rel~="icon"], link[rel="shortcut icon"]').each((_, el) => {
    const sizes = $(el).attr('sizes')?.split('x')[0];
    add({ url: abs($(el).attr('href')), base: 0.2, favicon: true, signals: ['the site favicon, not a full logo'], width: num(sizes), height: num(sizes), order: order++ });
  });
  const conventional = abs('/favicon.ico');
  if (conventional && !out.some((c) => c.location === conventional)) add({ url: conventional, base: 0.15, favicon: true, signals: ['the conventional favicon address'], order: order++ });
  return dedupeLogos(out.filter((c) => c.format !== 'gif'));
}

/** One candidate per address: the better description (higher confidence) wins; signals are merged. */
export function dedupeLogos(list: readonly LogoCandidateInfo[]): LogoCandidateInfo[] {
  const by = new Map<string, LogoCandidateInfo>();
  for (const c of list) {
    const cur = by.get(c.key);
    if (!cur) by.set(c.key, c);
    else {
      const win = c.confidence > cur.confidence ? c : cur;
      const lose = win === c ? cur : c;
      by.set(c.key, { ...win, signals: [...new Set([...win.signals, ...lose.signals])].slice(0, 5), width: win.width ?? lose.width, height: win.height ?? lose.height });
    }
  }
  return [...by.values()].sort((a, b) => b.confidence - a.confidence || (a.key < b.key ? -1 : 1));
}

// ---- repository -----------------------------------------------------------------------------------------------------------------------------------

const BRAND_DIRS = /(^|\/)(brand|branding|logos?|identity|assets?|public|static|images?|img|media|docs?|\.github|resources|design)(\/|$)/i;
const NOT_LOGO_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|__tests__|tests?|fixtures?|mocks?|stories|e2e|icons?|emoji|flags|sprites?|screenshots?|third[-_]?party|partners?|clients?|sponsors?)(\/|$)/i;

/** Logo candidates among the image files of a repository tree. Pure. `brand` = the business words. */
export function logosOfTree(tree: readonly { path: string; size: number | null }[], o: { owner: string; repo: string; ref: string; brand?: readonly string[] }): LogoCandidateInfo[] {
  const brand = [...(o.brand ?? []), ...brandWordsOf(o.repo)];
  const out: LogoCandidateInfo[] = [];
  for (const f of tree) {
    const file = f.path.split('/').pop() ?? f.path;
    const stem = file.replace(/\.[a-z0-9]{2,5}$/i, '');
    if (!/\.(png|jpe?g|webp|svg)$/i.test(file)) continue;
    if (NOT_LOGO_DIRS.test(f.path)) continue;
    const hasLogo = /logo|wordmark|logotype|brandmark/i.test(stem);
    const inBrandDir = /(^|\/)(brand|branding|logos?|identity)(\/|$)/i.test(f.path);
    const named = nameMatch(stem, brand);
    if (!hasLogo && !(inBrandDir && named) && !(/^(logo|brand|icon-?brand)/i.test(stem))) continue;
    let c = 0.4;
    const signals: string[] = [];
    if (/^logo(\.|$)/i.test(file) || /^(logo|wordmark|logotype)$/i.test(stem)) (c = 0.85), signals.push('named exactly "logo"');
    else if (/^logo[-_]?(full|main|primary|horizontal|color|colour|dark|light|large|lg|2x)?$/i.test(stem)) (c = 0.8), signals.push('a primary logo file name');
    else if (hasLogo && named) (c = 0.78), signals.push('a logo file that names the business');
    else if (hasLogo) (c = 0.5), signals.push('a file with "logo" in its name');
    else if (inBrandDir && named) (c = 0.55), signals.push('in a brand folder and names the business');
    if (inBrandDir) (c += 0.07), signals.push('in a brand/logo folder');
    else if (BRAND_DIRS.test(f.path)) c += 0.03;
    if (named && !signals.some((s) => /names the business/.test(s))) (c += 0.08), signals.push('names the business');
    if (THIRD_PARTY.test(f.path) || TECH_LOGOS.test(stem)) (c -= 0.45), signals.push('looks like a third-party or technology mark');
    if (/favicon|apple-touch|android-chrome|icon-\d/i.test(stem)) (c = Math.min(c, 0.3)), signals.push('an app icon, not a full logo');
    if (f.size !== null && f.size < 600) (c -= 0.25), signals.push('very small file');
    if (f.size !== null && f.size > 6 * 1024 * 1024) continue;
    c -= Math.min(0.05, f.path.split('/').length * 0.005);
    const confidence = Math.max(0.05, Math.min(0.95, Math.round(c * 100) / 100));
    const fmt = formatOf(file);
    out.push({
      source: 'github',
      location: f.path,
      fileName: file,
      format: fmt,
      svg: fmt === 'svg',
      width: null,
      height: null,
      confidence,
      signals: signals.slice(0, 5),
      favicon: /favicon|apple-touch|android-chrome/i.test(stem),
      pageUrl: `https://github.com/${o.owner}/${o.repo}/blob/${encodeURIComponent(o.ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      key: `github:${o.owner}/${o.repo}@${f.path}`,
      meta: { owner: o.owner, repo: o.repo, ref: o.ref, path: f.path, size: f.size },
    });
  }
  return dedupeLogos(out).slice(0, 12);
}

// ---- the project's own files -----------------------------------------------------------------------------------------------------------------------

export interface OwnedAsset {
  id: string;
  type: string;
  name: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
}

/** The project's uploads that are, or look like, a logo. An explicit logo upload is the strongest signal of all. */
export function logosOfUploads(assets: readonly OwnedAsset[], brand: readonly string[] = []): LogoCandidateInfo[] {
  const out: LogoCandidateInfo[] = [];
  for (const a of assets) {
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(a.mimeType)) continue;
    const explicit = a.type === 'logo';
    const looks = /logo|wordmark|brandmark|logotype/i.test(a.name) && !THIRD_PARTY.test(a.name) && !TECH_LOGOS.test(a.name);
    if (!explicit && !looks) continue;
    const fmt = /svg/i.test(a.mimeType) ? 'svg' : /png/i.test(a.mimeType) ? 'png' : /webp/i.test(a.mimeType) ? 'webp' : 'jpg';
    out.push({
      source: 'upload',
      location: a.id,
      fileName: a.name,
      format: fmt,
      svg: fmt === 'svg',
      width: a.width ?? null,
      height: a.height ?? null,
      confidence: explicit ? 1 : nameMatch(a.name, brand) ? 0.62 : 0.5,
      signals: explicit ? ['you uploaded it as your logo'] : ['an uploaded picture whose name says it is a logo'],
      favicon: false,
      pageUrl: null,
      key: `upload:${a.id}`,
      meta: { assetId: a.id, assetType: a.type },
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.key < b.key ? -1 : 1));
}

/**
 * The final order across sources (the product's promise): an uploaded logo, then the previously approved one, then website, repository and other uploads.
 * Within a tier the confidence decides. A favicon is always last.
 */
export function rankLogoCandidates(all: readonly LogoCandidateInfo[]): LogoCandidateInfo[] {
  const sourceTier = (c: LogoCandidateInfo) => (c.source === 'upload' && c.confidence >= 1 ? 0 : c.source === 'approved' ? 1 : c.source === 'website' ? 2 : c.source === 'github' ? 3 : 4);
  // a weak candidate never outranks a decent one only because of where it was found
  const tier = (c: LogoCandidateInfo) => (c.favicon ? 9 : c.confidence < 0.45 && sourceTier(c) > 1 ? 6 + sourceTier(c) / 10 : sourceTier(c));
  return [...all].sort((a, b) => tier(a) - tier(b) || b.confidence - a.confidence || (a.key < b.key ? -1 : 1));
}
