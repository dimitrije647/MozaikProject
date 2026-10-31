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
  signal?: AbortSignal;
}

export type SearchErrorCode = 'not_configured' | 'invalid_key' | 'rate_limited' | 'quota_exceeded' | 'unavailable' | 'bad_response' | 'cancelled';

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

async function call(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
  } catch {
    if (signal?.aborted) throw err('cancelled');
    throw err('unavailable');
  }
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
    const body = {
      query: query.slice(0, 380),
      search_depth: 'basic', // 1 credit; never "advanced" (2 credits) automatically
      max_results: Math.min(Math.max(options.maxResults ?? 5, 1), 10),
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      ...(options.language ? { language: options.language } : {}),
    };
    const json = (await call(this.f, `${this.baseUrl}/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` }, body: JSON.stringify(body) }, this.timeoutMs, options.signal)) as { results?: unknown };
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
    const q = new URLSearchParams({ q: query.slice(0, 380), count: String(Math.min(Math.max(options.maxResults ?? 5, 1), 10)) });
    if (options.language) q.set('search_lang', options.language);
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
