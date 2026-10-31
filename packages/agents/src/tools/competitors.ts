import type { SearchResult } from './web-search';

/**
 * Deterministic helpers for competitor research (F3). The model never chooses what is fetched: queries are built
 * from the project, results are filtered here, and only a bounded number of pages is retrieved through the SSRF-safe
 * fetcher. A search result is a LEAD; it becomes a confirmed competitor only when its own page was retrieved.
 */
const DIRECTORY_HOST = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|youtu|tiktok|pinterest|reddit|wikipedia|tripadvisor|yelp|google|bing|duckduckgo|amazon|ebay|alibaba|medium|quora|booking|trustpilot|glassdoor|crunchbase|capterra|g2|indeed)\.[a-z.]+$/i;

/**
 * Query templates per report language. The category and offering already come from the F1 manifest in the project's
 * language; only the connecting words ("best", "prices") need to follow it, so a Serbian market gets Serbian queries.
 */
const TEMPLATES: Record<string, { best: string; prices: string }> = {
  en: { best: 'best {category} {geo}', prices: '{category} prices comparison {geo}' },
  sr: { best: 'najbolji {category} {geo}', prices: '{category} cene {geo}' },
  hr: { best: 'najbolji {category} {geo}', prices: '{category} cijene {geo}' },
  de: { best: 'beste {category} {geo}', prices: '{category} Preise Vergleich {geo}' },
  es: { best: 'mejores {category} {geo}', prices: '{category} precios comparativa {geo}' },
  fr: { best: 'meilleurs {category} {geo}', prices: '{category} prix comparatif {geo}' },
  it: { best: 'migliori {category} {geo}', prices: '{category} prezzi confronto {geo}' },
};

const words = (s: string, n: number) => s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const tidy = (q: string) => q.replace(/\s+/g, ' ').trim();

export function competitorQueries(args: { category: string; offering: string; geography: string[]; maxQueries: number; language?: string }): string[] {
  const geo = args.geography[0] ?? '';
  const t = TEMPLATES[(args.language ?? 'en').toLowerCase().slice(0, 2)] ?? TEMPLATES.en;
  const category = words(args.category, 6);
  const offering = words(args.offering, 6);
  const fill = (tpl: string) => tidy(tpl.replace('{category}', category).replace('{geo}', geo));
  const out = [tidy(`${category} ${geo}`), offering && offering.toLowerCase() !== category.toLowerCase() ? tidy(`${offering} ${geo}`) : '', fill(t.best), fill(t.prices)].filter((q) => q.length >= 4);
  return [...new Set(out)].slice(0, Math.max(0, args.maxQueries));
}

/** The lookup query for a competitor the user named (no URL): the name plus the market, nothing invented. */
export function namedCompetitorQuery(name: string, geography: string[]): string {
  return tidy(`${words(name, 8)} ${geography[0] ?? ''}`);
}

export function hostKey(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

/**
 * The search result most likely to be the OWN website of a competitor the user named: a host that contains the
 * name, or a title that contains every word of the name; directories and social networks never qualify.
 * Null when nothing resembles the name (the competitor is then reported as not found, never guessed).
 */
export function pickNamed(name: string, results: SearchResult[], ownHosts: (string | null)[]): SearchResult | null {
  const own = new Set(ownHosts.filter((h): h is string => !!h));
  const compact = norm(name);
  const toks = tokens(name);
  if (!compact) return null;
  const usable = results.filter((r) => {
    const h = hostKey(r.url);
    return !!h && !own.has(h) && !DIRECTORY_HOST.test(h) && /^https?:\/\//i.test(r.url);
  });
  const byHost = usable.find((r) => norm(hostKey(r.url)!.split('.').slice(0, -1).join('')).includes(compact) || (toks.length > 1 && toks.every((t) => norm(hostKey(r.url)!).includes(t))));
  if (byHost) return byHost;
  return usable.find((r) => norm(r.title).includes(compact) || (toks.length > 1 && toks.every((t) => norm(r.title).includes(t)))) ?? null;
}

/** Search results worth fetching: not the business itself, not a social network/directory, one per host. */
export function pickCandidates(results: SearchResult[], ownHosts: (string | null)[], max: number): SearchResult[] {
  const own = new Set(ownHosts.filter((h): h is string => !!h));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const h = hostKey(r.url);
    if (!h || own.has(h) || seen.has(h) || DIRECTORY_HOST.test(h)) continue;
    if (!/^https?:\/\//i.test(r.url)) continue;
    seen.add(h);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}
