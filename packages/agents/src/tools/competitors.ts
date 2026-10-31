import type { SearchResult } from './web-search';

/**
 * Deterministic helpers for competitor research (F3). The model never chooses what is fetched: queries are built
 * from the project, results are filtered here, and only a bounded number of pages is retrieved through the SSRF-safe
 * fetcher. A search result is a LEAD; it becomes a confirmed competitor only when its own page was retrieved.
 */
const DIRECTORY_HOST = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|youtu|tiktok|pinterest|reddit|wikipedia|tripadvisor|yelp|google|bing|duckduckgo|amazon|ebay|alibaba|medium|quora|booking|trustpilot|glassdoor|crunchbase|capterra|g2|indeed)\.[a-z.]+$/i;

export function competitorQueries(args: { category: string; offering: string; geography: string[]; maxQueries: number }): string[] {
  const geo = args.geography[0] ?? '';
  const words = (s: string, n: number) => s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
  const category = words(args.category, 6);
  const offering = words(args.offering, 6);
  const out = [`${category} ${geo}`, offering && offering.toLowerCase() !== category.toLowerCase() ? `${offering} ${geo}` : '', `${category} alternatives comparison ${geo}`]
    .map((q) => q.replace(/\s+/g, ' ').trim())
    .filter((q) => q.length >= 4);
  return [...new Set(out)].slice(0, Math.max(0, args.maxQueries));
}

export function hostKey(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
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
