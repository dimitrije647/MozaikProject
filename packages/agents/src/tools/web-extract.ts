/**
 * Rendered-page extraction as a reusable deterministic TOOL (not an agent). It is the fallback for pages the plain
 * fetcher cannot read: JavaScript applications that serve an empty HTML shell, and sites behind a bot challenge.
 *
 * Provider: the official Tavily Extract API only (POST https://api.tavily.com/extract, `Authorization: Bearer <key>`,
 * body { urls, extract_depth: "basic", format: "markdown" }, response { results: [{ url, raw_content }],
 * failed_results: [{ url, error }] }). "basic" depth costs 1 credit per 5 URLs; "advanced" is never used automatically.
 * The text it returns is the page's content as rendered by the provider: it is still the page's own words (untrusted
 * data, delimited in prompts), never independent verification.
 */
export type ExtractErrorCode = 'not_configured' | 'invalid_key' | 'rate_limited' | 'quota_exceeded' | 'unavailable' | 'bad_response' | 'failed' | 'cancelled' | 'limit';

export type ExtractOutcome = { ok: true; url: string; text: string; truncated: boolean; provider: string } | { ok: false; code: ExtractErrorCode; message: string };

export interface WebExtractTool {
  /** "tavily" | "none" */
  readonly provider: string;
  readonly configured: boolean;
  readonly callCount: number;
  /** Never throws: failures come back as `{ ok: false }` with a safe message (never the provider's raw text or the key). */
  extract(url: string, options?: { signal?: AbortSignal }): Promise<ExtractOutcome>;
}

const SAFE: Record<ExtractErrorCode, string> = {
  not_configured: 'No page-rendering provider is configured.',
  invalid_key: 'The extraction provider rejected the API key.',
  rate_limited: 'The extraction provider rate limit was reached.',
  quota_exceeded: 'The extraction provider usage limit was exceeded.',
  unavailable: 'The extraction provider is unavailable.',
  bad_response: 'The extraction provider returned an unexpected response.',
  failed: 'The extraction provider could not read the page.',
  cancelled: 'Extraction cancelled.',
  limit: 'The per-run limit of extraction requests was reached.',
};
const fail = (code: ExtractErrorCode): ExtractOutcome => ({ ok: false, code, message: SAFE[code] });

export class NoExtract implements WebExtractTool {
  readonly provider = 'none';
  readonly configured = false;
  readonly callCount = 0;
  async extract(): Promise<ExtractOutcome> {
    return fail('not_configured');
  }
}

export interface TavilyExtractOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Hard cap on extraction requests per tool instance (= one run). */
  maxCalls?: number;
  /** Rendered text is cut to this many characters. */
  maxChars?: number;
}

export class TavilyExtract implements WebExtractTool {
  readonly provider = 'tavily';
  readonly configured = true;
  readonly #key: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxCalls: number;
  private readonly maxChars: number;
  private calls = 0;

  constructor(o: TavilyExtractOptions) {
    this.#key = o.apiKey;
    this.baseUrl = (o.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxCalls = o.maxCalls ?? 6;
    this.maxChars = o.maxChars ?? 12_000;
  }

  get callCount() {
    return this.calls;
  }

  async extract(url: string, options: { signal?: AbortSignal } = {}): Promise<ExtractOutcome> {
    if (this.calls >= this.maxCalls) return fail('limit');
    this.calls++;
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` },
        body: JSON.stringify({ urls: [url], extract_depth: 'basic', format: 'markdown', include_images: false }),
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])]),
      });
    } catch {
      return fail(options.signal?.aborted ? 'cancelled' : 'unavailable');
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return fail('invalid_key');
      if (res.status === 429) return fail('rate_limited');
      if (res.status === 432 || res.status === 433 || res.status === 402) return fail('quota_exceeded');
      return fail('unavailable');
    }
    let json: { results?: unknown; failed_results?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return fail('bad_response');
    }
    if (!Array.isArray(json?.results)) return fail('bad_response');
    const hit = (json.results as { url?: unknown; raw_content?: unknown }[]).find((r) => typeof r.raw_content === 'string' && String(r.raw_content).trim().length > 0);
    if (!hit) return fail('failed');
    const raw = String(hit.raw_content).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return { ok: true, url: typeof hit.url === 'string' ? hit.url : url, text: raw.slice(0, this.maxChars), truncated: raw.length > this.maxChars, provider: this.provider };
  }
}

/** TAVILY_API_KEY enables the fallback (the same key as web search). Nothing else is tried. */
export function createWebExtractFromEnv(env: NodeJS.ProcessEnv = process.env): WebExtractTool {
  if (env.TAVILY_API_KEY?.trim()) return new TavilyExtract({ apiKey: env.TAVILY_API_KEY.trim() });
  return new NoExtract();
}
