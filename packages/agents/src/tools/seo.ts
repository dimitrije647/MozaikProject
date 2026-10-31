import * as cheerio from 'cheerio';
import { detectInjection } from './html';
import type { WebFetchTool } from './web-fetch';

/**
 * Deterministic SEO / site inspection (F2). No AI, no private APIs: it reads the pages the site serves,
 * through the same SSRF-safe, robots-respecting WebFetchTool that F1 uses.
 *
 * It reports what was OBSERVED in the HTML. It cannot know whether Google has indexed a page.
 */

export interface PageSignals {
  url: string;
  finalUrl: string;
  status: number;
  redirected: boolean;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: { level: number; text: string }[];
  canonical: string | null;
  canonicalMatchesUrl: boolean | null;
  robotsMeta: string | null;
  noindex: boolean;
  viewport: string | null;
  lang: string | null;
  og: { title: string | null; description: string | null; image: string | null; siteName: string | null };
  twitterCard: string | null;
  jsonLdTypes: string[];
  jsonLdInvalid: number;
  images: { total: number; missingAlt: number };
  internalLinks: string[];
  externalLinkCount: number;
  wordCount: number;
  hreflang: string[];
  hasFavicon: boolean;
  branding: { themeColor: string | null; fonts: string[]; colors: string[]; logoCandidates: { src: string; alt: string }[] };
  ctas: string[];
  contact: { emails: string[]; phones: string[]; hasContactLink: boolean };
  socialLinks: { platform: string; url: string }[];
  text: string;
  injectionSuspected: boolean;
}

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const nonEmpty = (s: string | undefined | null) => {
  const c = clean(s);
  return c ? c : null;
};

const SOCIAL_HOSTS: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(facebook|fb)\.com$/, 'facebook'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(x|twitter)\.com$/, 'x'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)pinterest\.[a-z.]+$/, 'pinterest'],
  [/(^|\.)reddit\.com$/, 'reddit'],
];
export const platformOfHost = (host: string) => SOCIAL_HOSTS.find(([re]) => re.test(host.toLowerCase()))?.[1] ?? null;

const CTA_RE = /\b(book|buy|order|shop|contact|call|sign ?up|register|subscribe|get started|start|try|download|request|demo|learn more|join|enroll|apply|rezerv|kupi|naru[cč]i|kontakt|prijav|poziv|zapo[cč]n|pogledaj|saznaj)/i;

/** Parses one HTML document into measurable signals. */
export function inspectHtml(html: string, requestedUrl: string, finalUrl: string, status: number): PageSignals {
  const $ = cheerio.load(html);
  const base = new URL(finalUrl);
  const abs = (href: string | undefined) => {
    if (!href) return null;
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  };

  // visible text (scripts/styles/hidden removed) for word count and messaging
  const body = cheerio.load(html);
  body('script,style,noscript,template,svg,iframe,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"]').remove();
  const text = clean(body('body').text());

  const canonical = abs($('link[rel="canonical"]').attr('href'));
  const robotsMeta = nonEmpty($('meta[name="robots"]').attr('content'));
  const headings: PageSignals['headings'] = [];
  $('h1,h2,h3,h4').each((_, el) => {
    const t = clean($(el).text());
    if (t && headings.length < 30) headings.push({ level: Number(el.tagName.slice(1)), text: t.slice(0, 160) });
  });

  const jsonLdTypes: string[] = [];
  let jsonLdInvalid = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          const t = (n as Record<string, unknown>)['@type'];
          if (typeof t === 'string') jsonLdTypes.push(t);
          else if (Array.isArray(t)) jsonLdTypes.push(...t.filter((x): x is string => typeof x === 'string'));
          walk((n as Record<string, unknown>)['@graph']);
        }
      };
      walk(data);
    } catch {
      jsonLdInvalid++;
    }
  });

  const internal = new Set<string>();
  let external = 0;
  const socialLinks: PageSignals['socialLinks'] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();
  let hasContactLink = false;
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (href.startsWith('mailto:')) return void emails.add(href.slice(7).split('?')[0].toLowerCase());
    if (href.startsWith('tel:')) return void phones.add(href.slice(4).replace(/[^\d+]/g, ''));
    const u = abs(href);
    if (!u || !/^https?:/.test(u)) return;
    const url = new URL(u);
    url.hash = '';
    const label = clean($(el).text()).toLowerCase();
    if (/contact|kontakt/.test(label) || /contact|kontakt/.test(url.pathname.toLowerCase())) hasContactLink = true;
    if (url.hostname === base.hostname) internal.add(url.toString());
    else {
      external++;
      const platform = platformOfHost(url.hostname);
      if (platform && !socialLinks.some((s) => s.url === url.toString())) socialLinks.push({ platform, url: url.toString() });
    }
  });

  const images = $('img');
  let missingAlt = 0;
  images.each((_, el) => {
    if (!clean($(el).attr('alt'))) missingAlt++;
  });

  const logoCandidates: { src: string; alt: string }[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    const alt = clean($(el).attr('alt'));
    if (logoCandidates.length < 3 && (/logo/i.test(src) || /logo/i.test(alt) || /logo/i.test($(el).attr('class') ?? ''))) {
      const u = abs(src);
      if (u) logoCandidates.push({ src: u.slice(0, 200), alt: alt.slice(0, 100) });
    }
  });

  // Branding signals from what the page declares: fonts (Google Fonts links, font-family) and colours (hex in <style>).
  const fonts = new Set<string>();
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const m = /family=([^&:]+)/g;
    for (const f of ($(el).attr('href') ?? '').matchAll(m)) fonts.add(decodeURIComponent(f[1]).replace(/\+/g, ' '));
  });
  const css = $('style').map((_, el) => $(el).text()).get().join('\n').slice(0, 60_000);
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1].split(',')[0].replace(/["']/g, '').trim();
    if (first && !/^(inherit|initial|unset|sans-serif|serif|monospace)$/i.test(first)) fonts.add(first);
  }
  const colorCounts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    colorCounts.set(`#${hex}`, (colorCounts.get(`#${hex}`) ?? 0) + 1);
  }
  const colors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);

  const ctas: string[] = [];
  $('a,button').each((_, el) => {
    const t = clean($(el).text());
    if (t.length >= 2 && t.length <= 40 && CTA_RE.test(t) && !ctas.includes(t) && ctas.length < 10) ctas.push(t);
  });

  const hreflang = $('link[rel="alternate"][hreflang]').map((_, el) => $(el).attr('hreflang') ?? '').get().slice(0, 10);
  const injection = detectInjection(text);

  return {
    url: requestedUrl,
    finalUrl,
    status,
    redirected: requestedUrl.replace(/\/$/, '') !== finalUrl.replace(/\/$/, ''),
    title: nonEmpty($('head title').first().text() || $('title').first().text()),
    metaDescription: nonEmpty($('meta[name="description"]').attr('content')),
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings,
    canonical,
    canonicalMatchesUrl: canonical ? canonical.replace(/\/$/, '') === finalUrl.replace(/\/$/, '') : null,
    robotsMeta,
    noindex: /noindex/i.test(robotsMeta ?? ''),
    viewport: nonEmpty($('meta[name="viewport"]').attr('content')),
    lang: nonEmpty($('html').attr('lang')),
    og: {
      title: nonEmpty($('meta[property="og:title"]').attr('content')),
      description: nonEmpty($('meta[property="og:description"]').attr('content')),
      image: nonEmpty($('meta[property="og:image"]').attr('content')),
      siteName: nonEmpty($('meta[property="og:site_name"]').attr('content')),
    },
    twitterCard: nonEmpty($('meta[name="twitter:card"]').attr('content')),
    jsonLdTypes: [...new Set(jsonLdTypes)].slice(0, 10),
    jsonLdInvalid,
    images: { total: images.length, missingAlt },
    internalLinks: [...internal].slice(0, 80),
    externalLinkCount: external,
    wordCount: text ? text.split(/\s+/).length : 0,
    hreflang,
    hasFavicon: $('link[rel~="icon"]').length > 0,
    branding: { themeColor: nonEmpty($('meta[name="theme-color"]').attr('content')), fonts: [...fonts].slice(0, 6), colors, logoCandidates },
    ctas,
    contact: { emails: [...emails].slice(0, 3), phones: [...phones].slice(0, 3), hasContactLink },
    socialLinks: socialLinks.slice(0, 10),
    text: text.slice(0, 3000),
    injectionSuspected: injection.suspected,
  };
}

export type DescribeMode = 'full' | 'seo' | 'messaging' | 'brand' | 'presence';
const MODE_KEYS: Record<Exclude<DescribeMode, 'full'>, string[]> = {
  seo: ['url', 'http_status', 'title', 'meta_description', 'h1_count', 'heading_outline', 'canonical', 'meta_robots', 'viewport', 'html_lang', 'open_graph', 'twitter_card', 'structured_data_types', 'images', 'links', 'word_count', 'hreflang', 'favicon_declared'],
  messaging: ['url', 'title', 'meta_description', 'heading_outline', 'ctas', 'open_graph', 'html_lang', 'text'],
  brand: ['url', 'title', 'open_graph', 'declared_branding', 'favicon_declared', 'html_lang'],
  presence: ['url', 'title', 'open_graph', 'contact', 'social_links_on_page', 'structured_data_types'],
};

/** Compact, line-oriented rendering of a page's signals (this text is what agents quote from). */
export function describePage(p: PageSignals, mode: DescribeMode = 'full'): string {
  const v = (x: unknown) => (x === null || x === undefined || x === '' ? '(missing)' : String(x));
  const lines: [string, string][] = [
    ['url', `url: ${p.finalUrl}`],
    ['http_status', `http_status: ${p.status}${p.redirected ? ` (requested ${p.url}, redirected)` : ''}`],
    ['title', `title: ${v(p.title)} [${p.title?.length ?? 0} chars]`],
    ['meta_description', `meta_description: ${v(p.metaDescription)} [${p.metaDescription?.length ?? 0} chars]`],
    ['h1_count', `h1_count: ${p.h1.length}${p.h1.length ? ` | h1: ${p.h1.join(' | ')}` : ''}`],
    ['heading_outline', `heading_outline: ${p.headings.slice(0, 16).map((h) => `h${h.level} ${h.text}`).join(' | ') || '(none)'}`],
    ['canonical', `canonical: ${v(p.canonical)}${p.canonicalMatchesUrl === false ? ' (differs from page URL)' : ''}`],
    ['meta_robots', `meta_robots: ${v(p.robotsMeta)}${p.noindex ? ' (NOINDEX)' : ''}`],
    ['viewport', `viewport: ${v(p.viewport)}`],
    ['html_lang', `html_lang: ${v(p.lang)}`],
    ['open_graph', `open_graph: title=${v(p.og.title)}; description=${v(p.og.description)}; image=${v(p.og.image)}; site_name=${v(p.og.siteName)}`],
    ['twitter_card', `twitter_card: ${v(p.twitterCard)}`],
    ['structured_data_types', `structured_data_types: ${p.jsonLdTypes.join(', ') || '(none)'}${p.jsonLdInvalid ? ` (${p.jsonLdInvalid} invalid JSON-LD block(s))` : ''}`],
    ['images', `images: ${p.images.total} total, ${p.images.missingAlt} without alt text`],
    ['links', `links: ${p.internalLinks.length} internal, ${p.externalLinkCount} external`],
    ['word_count', `word_count: ${p.wordCount}`],
    ['hreflang', `hreflang: ${p.hreflang.join(', ') || '(none)'}`],
    ['favicon_declared', `favicon_declared: ${p.hasFavicon}`],
    ['ctas', `ctas: ${p.ctas.join(' | ') || '(none found)'}`],
    ['contact', `contact: emails=${p.contact.emails.join(',') || '(none)'}; phones=${p.contact.phones.join(',') || '(none)'}; contact_page_link=${p.contact.hasContactLink}`],
    ['social_links_on_page', `social_links_on_page: ${p.socialLinks.map((s) => s.url).join(' | ') || '(none)'}`],
    ['declared_branding', `declared_branding: theme_color=${v(p.branding.themeColor)}; fonts=${p.branding.fonts.join(', ') || '(none declared in inline CSS or Google Fonts links)'}; css_colors=${p.branding.colors.join(', ') || '(none in inline CSS)'}; logo_images=${p.branding.logoCandidates.map((l) => l.alt || l.src).join(' | ') || '(none identified)'}`],
    ['text', `text: ${p.text}`],
  ];
  const keep = mode === 'full' ? null : new Set(MODE_KEYS[mode]);
  return lines.filter(([k]) => !keep || keep.has(k)).map(([, l]) => l).join('\n');
}

// ---- robots.txt / sitemap ---------------------------------------------------------------------------

export interface RobotsInfo {
  status: 'found' | 'missing' | 'unreachable' | 'disallowed';
  url: string;
  text: string;
  /** `User-agent: *` with `Disallow: /` and no Allow rule. */
  blocksAll: boolean;
  sitemaps: string[];
}

export function analyzeRobots(text: string): { blocksAll: boolean; sitemaps: string[] } {
  const sitemaps = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 5);
  let blocksAll = false;
  let inStar = false;
  let sawAllow = false;
  let sawDisallowAll = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) {
        if (inStar && sawDisallowAll && !sawAllow) blocksAll = true;
        inStar = false;
        sawAllow = false;
        sawDisallowAll = false;
      }
      if (m[2].trim() === '*') inStar = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inStar) continue;
    if (key === 'disallow' && m[2].trim() === '/') sawDisallowAll = true;
    if (key === 'allow' && m[2].trim()) sawAllow = true;
  }
  if (inStar && sawDisallowAll && !sawAllow) blocksAll = true;
  return { blocksAll, sitemaps };
}

export interface SitemapInfo {
  status: 'found' | 'missing' | 'unreachable' | 'not_checked';
  url: string | null;
  urlCount: number | null;
  isIndex: boolean;
}

export interface BrokenLink {
  from: string;
  url: string;
  status: number | null;
  reason: string;
}

export interface SiteAudit {
  startUrl: string;
  origin: string;
  home: { ok: true } | { ok: false; code: string; message: string; status: number | null };
  pages: PageSignals[];
  failedPages: { url: string; code: string; message: string; status: number | null }[];
  robots: RobotsInfo;
  sitemap: SitemapInfo;
  broken: BrokenLink[];
  linksChecked: number;
  notes: string[];
}

export interface SeoAuditOptions {
  /** Pages analyzed in detail (home included). */
  maxPages: number;
  /** Additional internal links only status-checked for the broken-link scan. */
  maxLinkChecks: number;
}

const PRIORITY_PATH = /about|contact|pricing|price|services?|products?|courses?|shop|features?|how|faq|kontakt|o-nama|cene|usluge|kursevi/i;

/** Bounded crawl of one site. Never throws; failures are recorded. */
export async function auditSite(web: WebFetchTool, startUrl: string, opts: SeoAuditOptions, signal?: AbortSignal): Promise<SiteAudit> {
  const out: SiteAudit = {
    startUrl,
    origin: '',
    home: { ok: false, code: 'not_started', message: 'Not started', status: null },
    pages: [],
    failedPages: [],
    robots: { status: 'unreachable', url: '', text: '', blocksAll: false, sitemaps: [] },
    sitemap: { status: 'not_checked', url: null, urlCount: null, isIndex: false },
    broken: [],
    linksChecked: 0,
    notes: [],
  };

  const fetchPage = async (url: string) => {
    const r = await web.fetchHtml(url, signal);
    if (!r.ok) {
      out.failedPages.push({ url, code: r.result.code, message: r.result.message, status: r.result.status ?? null });
      return null;
    }
    const sig = inspectHtml(r.result.body, url, r.result.finalUrl, r.result.status);
    out.pages.push(sig);
    return sig;
  };

  const home = await fetchPage(startUrl);
  if (!home) {
    const f = out.failedPages[0];
    out.home = { ok: false, code: f.code, message: f.message, status: f.status };
    return out;
  }
  out.home = { ok: true };
  out.origin = new URL(home.finalUrl).origin;
  if (home.redirected) out.notes.push(`${startUrl} redirected to ${home.finalUrl}.`);

  // robots.txt and sitemap
  const rob = await web.fetchPage(`${out.origin}/robots.txt`, signal);
  out.robots.url = `${out.origin}/robots.txt`;
  if (rob.ok) {
    out.robots = { status: 'found', url: out.robots.url, text: rob.body.slice(0, 4000), ...analyzeRobots(rob.body) };
  } else if (rob.code === 'robots_disallowed') {
    out.robots = { ...out.robots, status: 'disallowed', blocksAll: true };
  } else if (rob.code === 'http_error' && rob.status && rob.status >= 400 && rob.status < 500) {
    out.robots.status = 'missing';
  }

  if (!signal?.aborted) {
    const candidate = out.robots.sitemaps[0] ?? `${out.origin}/sitemap.xml`;
    const sm = await web.fetchPage(candidate, signal);
    if (sm.ok && /<(urlset|sitemapindex)\b/i.test(sm.body)) {
      out.sitemap = { status: 'found', url: candidate, urlCount: (sm.body.match(/<loc>/gi) ?? []).length, isIndex: /<sitemapindex\b/i.test(sm.body) };
    } else if (!sm.ok && sm.code === 'http_error') out.sitemap = { status: 'missing', url: candidate, urlCount: null, isIndex: false };
    else out.sitemap = { status: sm.ok ? 'missing' : 'unreachable', url: candidate, urlCount: null, isIndex: false };
  }

  // detailed pages: prefer pages that matter for marketing
  const seen = new Set([home.finalUrl]);
  const sameSite = home.internalLinks.filter((l) => !seen.has(l) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|css|js)(\?|$)/i.test(l));
  const prioritized = [...sameSite.filter((l) => PRIORITY_PATH.test(new URL(l).pathname)), ...sameSite.filter((l) => !PRIORITY_PATH.test(new URL(l).pathname))];
  for (const link of prioritized) {
    if (signal?.aborted || out.pages.length >= opts.maxPages) break;
    if (seen.has(link)) continue;
    seen.add(link);
    await fetchPage(link);
  }

  // broken internal links (status check only), bounded
  const checked = new Set(out.pages.map((p) => p.finalUrl));
  for (const f of out.failedPages) checked.add(f.url);
  for (const f of out.failedPages) if (f.code === 'http_error') out.broken.push({ from: home.finalUrl, url: f.url, status: f.status, reason: f.message });
  for (const link of sameSite) {
    if (signal?.aborted || out.linksChecked >= opts.maxLinkChecks) break;
    if (checked.has(link)) continue;
    checked.add(link);
    out.linksChecked++;
    const r = await web.fetchPage(link, signal);
    if (!r.ok && r.code === 'http_error') out.broken.push({ from: home.finalUrl, url: link, status: r.status ?? null, reason: r.message });
  }
  if (out.pages.length >= opts.maxPages && prioritized.length > out.pages.length) out.notes.push(`Only ${out.pages.length} pages were analyzed in detail (limit ${opts.maxPages}).`);
  return out;
}
