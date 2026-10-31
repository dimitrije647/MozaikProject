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

/** Extracts what a human would see on a page: no scripts, styles, comments or hidden elements. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
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
  $('a[href]').each((_, el) => {
    if (links.length >= 120) return;
    const href = $(el).attr('href') ?? '';
    if (!href || /^(javascript:|mailto:|tel:|data:|#)/i.test(href)) return;
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = '';
      links.push({ text: clean($(el).text()).slice(0, 80), href: abs.toString() });
    } catch {
      /* ignore malformed href */
    }
  });

  $('nav, footer, header').addClass('lp-chrome'); // kept: headers often carry the offering; only collapse whitespace
  const text = clean($('body').text()).slice(0, MAX_TEXT);
  const inj = detectInjection(`${title ?? ''} ${description ?? ''} ${text}`);
  return { title, description, siteName, lang, headings, text, links, injectionSuspected: inj.suspected, injectionSamples: inj.samples };
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
