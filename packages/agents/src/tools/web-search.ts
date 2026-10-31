/**
 * Web search as a reusable deterministic TOOL (not an agent). Any future Mozaik agent can use it.
 *
 * Providers are official search APIs only (Tavily, Brave). Search-engine HTML is never scraped.
 * A search RESULT is a lead, not evidence: its snippet is the search provider's summary of a page
 * and is never treated as independently verified.
 */
export interface SearchResult {
  title: string;
  url: string;
  /** Provider snippet. Untrusted text. */
  snippet: string;
  score: number | null;
}

export interface SearchOptions {
  maxResults?: number;
  language?: string;
  /** ISO 3166-1 alpha-2 code of the market; results from that country are boosted when the provider supports it. */
  country?: string;
  /** Hosts whose pages must not appear (for example the business's own site when looking for outside mentions). */
  excludeDomains?: string[];
  signal?: AbortSignal;
}

/** Tavily's `country` parameter takes lowercase country names; only these codes are mapped (others are ignored). */
export const TAVILY_COUNTRY_NAMES: Record<string, string> = {
  RS: 'serbia', HR: 'croatia', BA: 'bosnia and herzegovina', ME: 'montenegro', SI: 'slovenia', MK: 'north macedonia',
  DE: 'germany', AT: 'austria', CH: 'switzerland', US: 'united states', GB: 'united kingdom', IE: 'ireland',
  FR: 'france', IT: 'italy', ES: 'spain', PT: 'portugal', NL: 'netherlands', BE: 'belgium', PL: 'poland',
  CZ: 'czech republic', SK: 'slovakia', HU: 'hungary', RO: 'romania', BG: 'bulgaria', GR: 'greece', TR: 'turkey',
  SE: 'sweden', NO: 'norway', DK: 'denmark', FI: 'finland', CA: 'canada', AU: 'australia',
};
/** Country codes Brave's `country` parameter documents. */
const BRAVE_COUNTRIES = new Set(['AR', 'AU', 'AT', 'BE', 'BR', 'CA', 'CL', 'DK', 'FI', 'FR', 'DE', 'HK', 'IN', 'ID', 'IT', 'JP', 'KR', 'MY', 'MX', 'NL', 'NZ', 'NO', 'CN', 'PL', 'PT', 'PH', 'RU', 'SA', 'ZA', 'ES', 'SE', 'CH', 'TW', 'TR', 'GB', 'US']);
const cleanDomains = (d?: string[]) => (d ?? []).map((x) => x.trim().toLowerCase().replace(/^www\./, '')).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)).slice(0, 10);

export type SearchErrorCode = 'not_configured' | 'invalid_key' | 'rate_limited' | 'quota_exceeded' | 'unavailable' | 'bad_response' | 'cancelled' | 'retry_without_country';

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

export interface WebSearchTool {
  /** "tavily" | "brave" | "none" */
  readonly provider: string;
  readonly configured: boolean;
  /** Throws SearchError with a safe message (never the provider's raw text or the key). */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

const SAFE: Record<SearchErrorCode, string> = {
  not_configured: 'No search provider is configured.',
  invalid_key: 'The search provider rejected the API key.',
  rate_limited: 'The search provider rate limit was reached.',
  quota_exceeded: 'The search provider usage limit was exceeded.',
  unavailable: 'The search provider is unavailable.',
  bad_response: 'The search provider returned an unexpected response.',
  cancelled: 'Search cancelled.',
  retry_without_country: 'The search provider rejected the country filter.',
};
const err = (code: SearchErrorCode) => new SearchError(code, SAFE[code]);

export class NoSearch implements WebSearchTool {
  readonly provider = 'none';
  readonly configured = false;
  async search(): Promise<SearchResult[]> {
    throw err('not_configured');
  }
}

interface HttpOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function mapStatus(status: number): SearchError {
  if (status === 401 || status === 403) return err('invalid_key');
  if (status === 429) return err('rate_limited');
  if (status === 432 || status === 433 || status === 402) return err('quota_exceeded');
  return err('unavailable');
}

async function call(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal, retryable?: (status: number) => boolean): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
  } catch {
    if (signal?.aborted) throw err('cancelled');
    throw err('unavailable');
  }
  if (!res.ok && retryable?.(res.status)) throw err('retry_without_country');
  if (!res.ok) throw mapStatus(res.status);
  try {
    return await res.json();
  } catch {
    throw err('bad_response');
  }
}

/**
 * Tavily Search API: POST https://api.tavily.com/search, `Authorization: Bearer <key>`,
 * body { query, max_results (0-20), search_depth: "basic" (1 credit), ... },
 * response { results: [{ title, url, content, score }] }. 401 invalid key, 429 rate limit, 432/433 usage limits.
 */
export class TavilySearch implements WebSearchTool {
  readonly provider = 'tavily';
  readonly configured = true;
  readonly #key: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: HttpOptions) {
    this.#key = o.apiKey;
    this.baseUrl = (o.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const exclude = cleanDomains(options.excludeDomains);
    const country = options.country ? TAVILY_COUNTRY_NAMES[options.country.toUpperCase()] : undefined;
    const body: Record<string, unknown> = {
      query: query.slice(0, 380),
      search_depth: 'basic', // 1 credit; never "advanced" (2 credits) automatically
      max_results: Math.min(Math.max(options.maxResults ?? 5, 1), 10),
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      ...(options.language ? { language: options.language } : {}),
      ...(exclude.length ? { exclude_domains: exclude } : {}),
      ...(country ? { country } : {}),
    };
    const post = (b: Record<string, unknown>) => call(this.f, `${this.baseUrl}/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` }, body: JSON.stringify(b) }, this.timeoutMs, options.signal, (status) => status === 400 && !!b.country) as Promise<{ results?: unknown }>;
    let json: { results?: unknown };
    try {
      json = await post(body);
    } catch (e) {
      // A country value the provider does not know must not cost the search: retry once without it.
      if (e instanceof SearchError && e.code === 'retry_without_country') json = await post({ ...body, country: undefined });
      else throw e;
    }
    if (!Array.isArray(json?.results)) throw err('bad_response');
    return (json.results as { title?: unknown; url?: unknown; content?: unknown; score?: unknown }[])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({ title: String(r.title ?? ''), url: String(r.url), snippet: String(r.content ?? '').slice(0, 600), score: typeof r.score === 'number' ? r.score : null }));
  }
}

/**
 * Brave Search API: GET https://api.search.brave.com/res/v1/web/search?q=..&count=..,
 * header `X-Subscription-Token: <key>`, response { web: { results: [{ title, url, description }] } }.
 * Implemented from the documented contract; not exercised against the live API by the automated tests.
 */
export class BraveSearch implements WebSearchTool {
  readonly provider = 'brave';
  readonly configured = true;
  readonly #key: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: HttpOptions) {
    this.#key = o.apiKey;
    this.baseUrl = (o.baseUrl ?? 'https://api.search.brave.com').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // Brave has no exclusion parameter; its documented `-site:` operator does the same inside the query.
    const exclude = cleanDomains(options.excludeDomains).map((d) => ` -site:${d}`).join('');
    const q = new URLSearchParams({ q: `${query.slice(0, 380 - exclude.length)}${exclude}`, count: String(Math.min(Math.max(options.maxResults ?? 5, 1), 10)) });
    if (options.language) q.set('search_lang', options.language);
    if (options.country && BRAVE_COUNTRIES.has(options.country.toUpperCase())) q.set('country', options.country.toUpperCase());
    const json = (await call(this.f, `${this.baseUrl}/res/v1/web/search?${q}`, { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': this.#key } }, this.timeoutMs, options.signal)) as { web?: { results?: unknown } };
    const results = json?.web?.results;
    if (!Array.isArray(results)) throw err('bad_response');
    return (results as { title?: unknown; url?: unknown; description?: unknown }[])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({ title: String(r.title ?? ''), url: String(r.url), snippet: String(r.description ?? '').replace(/<[^>]+>/g, '').slice(0, 600), score: null }));
  }
}

/** TAVILY_API_KEY preferred, then BRAVE_SEARCH_API_KEY. Neither set => disabled. No paid fallback. */
export function createWebSearchFromEnv(env: NodeJS.ProcessEnv = process.env): WebSearchTool {
  if (env.TAVILY_API_KEY?.trim()) return new TavilySearch({ apiKey: env.TAVILY_API_KEY.trim() });
  if (env.BRAVE_SEARCH_API_KEY?.trim()) return new BraveSearch({ apiKey: env.BRAVE_SEARCH_API_KEY.trim() });
  return new NoSearch();
}
