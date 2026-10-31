import * as cheerio from 'cheerio';

export interface ExtractedPage {
  title: string | null;
  description: string | null;
  siteName: string | null;
  lang: string | null;
  headings: string[];
  /** Visible text, whitespace-collapsed and capped. */
  text: string;
  links: { text: string; href: string }[];
  /** Links to social networks found on the page (external hosts only). */
  socialLinks: { platform: string; url: string }[];
  /** `@type` values of the page's JSON-LD blocks (Organization, Product, LocalBusiness, ...). */
  jsonLdTypes: string[];
  /** The JSON-LD Organization / LocalBusiness / Brand entity when the page declares one. */
  organization: { name: string | null; sameAs: string[] } | null;
  /** True when the served HTML has almost no visible text but looks like a JavaScript application shell. */
  likelyJsRendered: boolean;
  scriptCount: number;
  /** True when the text contains phrases that look like instructions aimed at an AI. */
  injectionSuspected: boolean;
  injectionSamples: string[];
}

const MAX_TEXT = 12_000;
const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

// Phrases typical of prompt-injection attempts. This only RAISES A FLAG for the reader; page text is
// always treated as untrusted data and delimited in prompts regardless of this result.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier|system)/i,
  /(reveal|print|show|leak|send|exfiltrate|output).{0,40}(api[ _-]?key|secret|password|credential|system prompt|token)/i,
  /you are now (a|an|the)?\s*\w+/i,
  /(new|updated) (system )?(instructions|prompt)\s*:/i,
  /\bsystem prompt\b/i,
  /<\|?(im_start|im_end|system|assistant)\|?>/i,
  /(fetch|visit|open|request|call)\s+(this|the following)\s+(url|link|endpoint)/i,
  /\bas an ai (language )?model\b/i,
];

export function detectInjection(text: string): { suspected: boolean; samples: string[] } {
  const samples: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) samples.push(text.slice(Math.max(0, m.index - 20), m.index + Math.min(m[0].length + 40, 120)).replace(/\s+/g, ' ').trim());
  }
  return { suspected: samples.length > 0, samples: samples.slice(0, 3) };
}

// ---- social networks -------------------------------------------------------------------------------

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

/** The social network a host belongs to, or null. */
export const platformOfHost = (host: string) => SOCIAL_HOSTS.find(([re]) => re.test(host.toLowerCase()))?.[1] ?? null;

/** Profile links (not share/intent links) to social networks among the given absolute URLs. */
export function socialLinksOf(urls: string[], max = 10): { platform: string; url: string }[] {
  const out: { platform: string; url: string }[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const platform = platformOfHost(u.hostname);
    if (!platform || /\/(share|sharer|intent|plugins|embed)\b/i.test(u.pathname) || u.pathname === '/' || u.pathname === '') continue;
    u.hash = '';
    u.search = '';
    const url = u.toString();
    if (!out.some((s) => s.url === url)) out.push({ platform, url });
    if (out.length >= max) break;
  }
  return out;
}

// ---- JavaScript applications -----------------------------------------------------------------------

const APP_SHELL_MARKERS = /id=["'](root|app|__next|__nuxt|___gatsby|svelte|q-app|outlet)["']|data-reactroot|ng-version=|ng-app|__NEXT_DATA__|window\.__NUXT__|__remixContext|data-server-rendered|enable javascript/i;

/**
 * A page that renders on the client ships an almost empty HTML document plus scripts. This heuristic flags such
 * documents so the reader can say "only what the server sent was read" or ask a rendering service for the text.
 */
export function detectJsRendered(html: string, visibleTextLength: number, scriptCount: number): boolean {
  if (visibleTextLength >= 400) return false;
  if (APP_SHELL_MARKERS.test(html.slice(0, 200_000))) return true;
  // No framework marker: only an almost empty document that still loads several scripts counts as a shell.
  return visibleTextLength < 80 && scriptCount >= 3;
}

const HIDDEN_SELECTORS = [
  '[hidden]',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
  '[style*="font-size:0"]',
  '[style*="opacity:0"]',
  'input[type="hidden"]',
];

/** Reads JSON-LD blocks: the @type values and the first Organization-like entity. */
export function readJsonLd(html: string): { types: string[]; organization: ExtractedPage['organization'] } {
  const $ = cheerio.load(html);
  const types: string[] = [];
  let organization: ExtractedPage['organization'] = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      const t = o['@type'];
      const list = typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
      types.push(...list);
      if (!organization && list.some((x) => /organization|localbusiness|brand|corporation|store|restaurant|school|agency|company/i.test(x))) {
        const sameAs = o.sameAs;
        organization = { name: typeof o.name === 'string' ? clean(o.name).slice(0, 160) : null, sameAs: (Array.isArray(sameAs) ? sameAs : typeof sameAs === 'string' ? [sameAs] : []).filter((x): x is string => typeof x === 'string').slice(0, 12) };
      }
      walk(o['@graph']);
    };
    walk(data);
  });
  return { types: [...new Set(types)].slice(0, 12), organization };
}

/** Extracts what a human would see on a page: no scripts, styles, comments or hidden elements. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const scriptCount = $('script').not('[type="application/ld+json"]').length;
  const { types: jsonLdTypes, organization } = readJsonLd(html);
  $('script, style, noscript, svg, iframe, object, embed, template, canvas, link, head > meta[http-equiv]').remove();
  const meta = (name: string) => clean($(`meta[name="${name}"]`).attr('content')) || clean($(`meta[property="${name}"]`).attr('content')) || null;
  const title = clean($('title').first().text()) || meta('og:title');
  const description = meta('description') || meta('og:description');
  const siteName = meta('og:site_name');
  const lang = clean($('html').attr('lang')) || null;

  $(HIDDEN_SELECTORS.join(',')).remove();

  const headings: string[] = [];
  $('h1, h2, h3').each((_, el) => {
    const t = clean($(el).text());
    if (t && headings.length < 40) headings.push(t.slice(0, 160));
  });

  const links: { text: string; href: string }[] = [];
  const allHrefs: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || /^(javascript:|mailto:|tel:|data:|#)/i.test(href)) return;
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = '';
      if (allHrefs.length < 400) allHrefs.push(abs.toString());
      if (links.length < 120) links.push({ text: clean($(el).text()).slice(0, 80), href: abs.toString() });
    } catch {
      /* ignore malformed href */
    }
  });
  const socialLinks = socialLinksOf([...allHrefs, ...(organization?.sameAs ?? [])]);

  $('nav, footer, header').addClass('lp-chrome'); // kept: headers often carry the offering; only collapse whitespace
  const text = clean($('body').text()).slice(0, MAX_TEXT);
  const inj = detectInjection(`${title ?? ''} ${description ?? ''} ${text}`);
  return {
    title,
    description,
    siteName,
    lang,
    headings,
    text,
    links,
    socialLinks,
    jsonLdTypes,
    organization,
    likelyJsRendered: detectJsRendered(html, text.length, scriptCount),
    scriptCount,
    injectionSuspected: inj.suspected,
    injectionSamples: inj.samples,
  };
}

/**
 * Builds a page from rendered TEXT (for example from an extraction service) when no usable HTML was served.
 * Headings come from Markdown heading lines; links and structured data are unknown.
 */
export function pageFromText(markdownOrText: string, baseUrl: string): ExtractedPage {
  const raw = markdownOrText.replace(/\r/g, '');
  const headingLines = raw.split('\n').map((l) => l.trim()).filter((l) => /^#{1,3}\s+\S/.test(l));
  const headings = headingLines.map((l) => clean(l.replace(/^#{1,3}\s+/, '')).slice(0, 160)).slice(0, 40);
  const title = headings[0] ?? null;
  const urls = [...raw.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)].map((m) => m[0]);
  const text = clean(raw.replace(/^#{1,6}\s+/gm, '').replace(/[*_`>]+/g, ' ')).slice(0, MAX_TEXT);
  const inj = detectInjection(text);
  void baseUrl;
  return {
    title,
    description: null,
    siteName: null,
    lang: null,
    headings,
    text,
    links: [],
    socialLinks: socialLinksOf(urls),
    jsonLdTypes: [],
    organization: null,
    likelyJsRendered: false,
    scriptCount: 0,
    injectionSuspected: inj.suspected,
    injectionSamples: inj.samples,
  };
}

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|mp4|mp3|avi|mov|docx?|xlsx?|pptx?|exe|dmg|css|js|json|xml)(\?|$)/i;
const KEYWORDS: [RegExp, number][] = [
  [/about|o-nama|onama|who-we-are|company|team|story/i, 5],
  [/service|usluge|ponuda|offer|solutions?/i, 6],
  [/product|proizvod|features?|funkcij|how-it-works/i, 6],
  [/course|kurs|program|training|obuka/i, 5],
  [/pricing|price|cenovnik|cene|cijene|plans?/i, 4],
  [/faq|help|support|pitanja/i, 2],
  [/contact|kontakt/i, 2],
];

/** A short role label for a same-site page, from its path and link text (for grouping pages of one site). */
export function pageRole(url: string, linkText = ''): string {
  const hay = `${(() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })()} ${linkText}`;
  if (/pricing|price|cenovnik|cene|cijene|plans?|tarif/i.test(hay)) return 'pricing';
  if (/about|o-nama|onama|who-we-are|company|team|story/i.test(hay)) return 'about';
  if (/product|proizvod|features?|funkcij|how-it-works/i.test(hay)) return 'products';
  if (/service|usluge|ponuda|offer|solutions?/i.test(hay)) return 'services';
  if (/course|kurs|program|training|obuka/i.test(hay)) return 'courses';
  if (/contact|kontakt/i.test(hay)) return 'contact';
  if (/faq|help|support|pitanja/i.test(hay)) return 'faq';
  return 'page';
}

/** Picks same-site pages worth reading. Never follows links to other hosts. */
export function selectRelevantLinks(links: { text: string; href: string }[], baseUrl: string, max: number): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>([base.toString().replace(/\/$/, '')]);
  const scored: { href: string; score: number }[] = [];
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (SKIP_EXT.test(u.pathname) || u.pathname === '/' || u.search.length > 40) continue;
    const key = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const hay = `${u.pathname} ${l.text}`;
    const score = KEYWORDS.reduce((s, [re, w]) => (re.test(hay) ? s + w : s), 0);
    if (score > 0) scored.push({ href: `${u.origin}${u.pathname}${u.search}`, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.href);
}
