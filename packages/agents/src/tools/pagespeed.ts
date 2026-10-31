/**
 * Google PageSpeed Insights API v5 adapter (official, documented):
 *   GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed
 *       ?url=<page>&strategy=mobile|desktop&category=PERFORMANCE&category=SEO&category=ACCESSIBILITY&category=BEST_PRACTICES&key=<API key>
 * Response fields used: lighthouseResult.categories.<id>.score (0..1), lighthouseResult.audits.<id>.numericValue/displayValue,
 * lighthouseResult.fetchTime/finalUrl, loadingExperience.overall_category (field data, only for popular pages).
 *
 * Optional: it is only called when PAGESPEED_API_KEY is configured. Without it LaunchPilot does not call the
 * API at all (anonymous quota is tiny and not something to rely on) and reports performance as unavailable.
 * The key travels in the query string as Google requires; it is never logged or put in an error message.
 * Scores are Lighthouse LAB data of a single run: they are reported as measured, never invented or averaged.
 */
export const PAGESPEED_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export type PageSpeedFailure = 'not_configured' | 'quota' | 'timeout' | 'http_error' | 'invalid_response' | 'cancelled' | 'network_error';

export interface PageSpeedResult {
  ok: true;
  strategy: 'mobile' | 'desktop';
  requestedUrl: string;
  finalUrl: string | null;
  fetchedAt: string | null;
  /** 0 to 100, as Lighthouse reports (null when Lighthouse could not compute it). */
  scores: { performance: number | null; seo: number | null; accessibility: number | null; bestPractices: number | null };
  metrics: { id: string; label: string; value: number | null; display: string | null }[];
  fieldData: { overall: string | null } | null;
}

export type PageSpeedOutcome = PageSpeedResult | { ok: false; code: PageSpeedFailure; message: string };

export interface PageSpeedOptions {
  apiKey?: string;
  /** TESTS ONLY (local fake). */
  baseUrl?: string;
  timeoutMs?: number;
}

const METRICS: [string, string][] = [
  ['first-contentful-paint', 'First Contentful Paint'],
  ['largest-contentful-paint', 'Largest Contentful Paint'],
  ['total-blocking-time', 'Total Blocking Time'],
  ['cumulative-layout-shift', 'Cumulative Layout Shift'],
  ['speed-index', 'Speed Index'],
];

const pct = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null);

export class PageSpeedTool {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private calls = 0;

  constructor(options: PageSpeedOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = options.baseUrl ?? PAGESPEED_URL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get configured() {
    return !!this.apiKey;
  }
  get callCount() {
    return this.calls;
  }

  async run(url: string, strategy: 'mobile' | 'desktop' = 'mobile', signal?: AbortSignal): Promise<PageSpeedOutcome> {
    if (!this.apiKey) return { ok: false, code: 'not_configured', message: 'PAGESPEED_API_KEY is not configured, so PageSpeed Insights was not called. Performance metrics are unavailable.' };
    const q = new URLSearchParams({ url, strategy, key: this.apiKey });
    for (const c of ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']) q.append('category', c);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    this.calls++;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}?${q.toString()}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } });
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: 'cancelled', message: 'The PageSpeed request was cancelled.' };
      if (timeout.aborted || (e as { name?: string }).name === 'TimeoutError') return { ok: false, code: 'timeout', message: 'PageSpeed Insights did not answer in time.' };
      return { ok: false, code: 'network_error', message: 'PageSpeed Insights could not be reached.' };
    }
    let body: Record<string, any> | null = null;
    try {
      body = (await res.json()) as Record<string, any>;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const status = String(body?.error?.status ?? '');
      if (res.status === 429 || status === 'RESOURCE_EXHAUSTED' || /quota/i.test(String(body?.error?.message ?? ''))) {
        return { ok: false, code: 'quota', message: 'The PageSpeed Insights quota is exhausted (or the key is rate limited). Performance metrics are unavailable.' };
      }
      return { ok: false, code: 'http_error', message: `PageSpeed Insights answered HTTP ${res.status}${res.status === 400 || res.status === 403 ? ' (check PAGESPEED_API_KEY and that the PageSpeed Insights API is enabled)' : ''}.` };
    }
    const lh = body?.lighthouseResult;
    if (!lh || typeof lh !== 'object' || !lh.categories) return { ok: false, code: 'invalid_response', message: 'PageSpeed Insights returned an unexpected response.' };
    const cat = (id: string) => pct(lh.categories?.[id]?.score);
    return {
      ok: true,
      strategy,
      requestedUrl: url,
      finalUrl: typeof lh.finalUrl === 'string' ? lh.finalUrl : null,
      fetchedAt: typeof lh.fetchTime === 'string' ? lh.fetchTime : null,
      scores: { performance: cat('performance'), seo: cat('seo'), accessibility: cat('accessibility'), bestPractices: cat('best-practices') },
      metrics: METRICS.map(([id, label]) => ({
        id,
        label,
        value: typeof lh.audits?.[id]?.numericValue === 'number' ? lh.audits[id].numericValue : null,
        display: typeof lh.audits?.[id]?.displayValue === 'string' ? lh.audits[id].displayValue : null,
      })),
      fieldData: body?.loadingExperience?.overall_category ? { overall: String(body.loadingExperience.overall_category) } : null,
    };
  }
}

export function describePageSpeed(r: PageSpeedResult): string {
  const s = (n: number | null) => (n === null ? 'unavailable' : String(n));
  return [
    `source: Google PageSpeed Insights API v5, ${r.strategy}, Lighthouse LAB data of a single run${r.fetchedAt ? ` at ${r.fetchedAt}` : ''}`,
    `url: ${r.finalUrl ?? r.requestedUrl}`,
    `score_performance: ${s(r.scores.performance)}`,
    `score_seo: ${s(r.scores.seo)}`,
    `score_accessibility: ${s(r.scores.accessibility)}`,
    `score_best_practices: ${s(r.scores.bestPractices)}`,
    ...r.metrics.map((m) => `${m.id}: ${m.display ?? (m.value === null ? 'unavailable' : String(m.value))}`),
    `field_data_overall: ${r.fieldData?.overall ?? 'unavailable (no real-user data for this URL)'}`,
  ].join('\n');
}
