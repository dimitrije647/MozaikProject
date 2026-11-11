import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { DEFAULT_URL_POLICY, UnsafeUrlError, guardedLookup, parseHttpUrl, resolveSafe, type UrlPolicy } from './url-safety';
import { extractPage, selectRelevantLinks, type ExtractedPage } from './html';

export type FetchFailureCode =
  | 'blocked_url'
  | 'robots_disallowed'
  | 'bot_protected'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'unsupported_content_type'
  | 'network_error'
  | 'too_many_redirects'
  | 'page_limit'
  | 'cancelled';

export type FetchResult =
  | { ok: true; url: string; finalUrl: string; status: number; contentType: string; bytes: number; truncated: boolean; body: string; fromCache: boolean }
  | { ok: false; url: string; code: FetchFailureCode; message: string; status?: number };

export interface WebFetchOptions {
  policy?: UrlPolicy;
  timeoutMs?: number;
  /** Per response. Larger bodies are truncated (HTML) or refused. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Total pages (not robots.txt) one tool instance (= one run) may fetch. */
  maxPages?: number;
  userAgent?: string;
  respectRobots?: boolean;
  /** Stylesheets and images (fetchAsset) one tool instance may fetch. */
  maxAssets?: number;
}

const UA_TOKEN = 'launchpilotbot';

// ---- bot protection ------------------------------------------------------------------------------

const CHALLENGE_VENDORS: [RegExp, string][] = [
  [/cf-chl|challenge-platform|cf_chl_opt|cf-browser-verification|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|cdn-cgi\/challenge-platform/i, 'Cloudflare'],
  [/_Incapsula_Resource|incapsula/i, 'Imperva'],
  [/captcha-delivery\.com|datadome/i, 'DataDome'],
  [/px-captcha|_pxAppId|perimeterx/i, 'PerimeterX'],
  [/errors\.edgesuite\.net|akamai/i, 'Akamai'],
];
const GENERIC_CHALLENGE = /captcha|verify (that )?you are (a )?human|are you a robot|bot (detection|protection)|access denied|request blocked|unusual traffic/i;

/**
 * Recognizes challenge or block pages served by bot-protection services, so they are reported as "cannot be read
 * automatically" instead of a plain HTTP error. Vendor markers count at any status; generic wording only with a
 * blocking status (403, 429, 503).
 */
export function detectBotChallenge(status: number, headers: Record<string, string | string[] | undefined>, body: string): string | null {
  const mitigated = String(headers['cf-mitigated'] ?? '').toLowerCase();
  if (mitigated === 'challenge' || mitigated === 'block') return 'Cloudflare';
  const head = body.slice(0, 40_000);
  for (const [re, vendor] of CHALLENGE_VENDORS) if (re.test(head)) return vendor;
  if ((status === 403 || status === 429 || status === 503) && GENERIC_CHALLENGE.test(head) && head.length < 30_000) return 'bot protection';
  return null;
}
const TEXTUAL = /^(text\/(html|plain|markdown)|application\/(xhtml\+xml|xml)|text\/xml)/i;

export interface RobotsRules {
  allowed(path: string): boolean;
}

/** Minimal RFC 9309 parser: longest matching rule wins, Allow beats Disallow on ties, `*` and `$` supported. */
export function parseRobots(txt: string): RobotsRules {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', pattern: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a)));
  const chosen = (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  const toRe = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return {
    allowed(path: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of chosen) {
        if (!r.pattern) continue; // empty Disallow = allow everything
        if (toRe(r.pattern).test(path) && (!best || r.pattern.length > best.len || (r.pattern.length === best.len && r.allow))) {
          best = { allow: r.allow, len: r.pattern.length };
        }
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * Safe HTTP(S) retrieval for untrusted pages. One instance = one run: it enforces the per-run page
 * budget, caches identical fetches and caches robots.txt per origin. It never throws: failures are
 * returned as `{ ok: false, code }`.
 */
export class WebFetchTool {
  private readonly policy: UrlPolicy;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly maxPages: number;
  private readonly userAgent: string;
  private readonly respectRobots: boolean;
  private readonly cache = new Map<string, FetchResult>();
  private readonly robots = new Map<string, RobotsRules | 'deny_all'>();
  private pagesFetched = 0;
  private assetsFetched = 0;
  private readonly maxAssets: number;

  constructor(options: WebFetchOptions = {}) {
    this.policy = options.policy ?? DEFAULT_URL_POLICY;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.maxRedirects = options.maxRedirects ?? 4;
    this.maxPages = options.maxPages ?? 6;
    this.userAgent = options.userAgent ?? 'LaunchPilotBot/1.0 (product discovery; honors robots.txt)';
    this.respectRobots = options.respectRobots ?? true;
    this.maxAssets = options.maxAssets ?? 6;
  }

  get pageCount() {
    return this.pagesFetched;
  }

  /** Synchronous syntax/policy check of a URL (no DNS, no network). */
  checkUrl(raw: string): { ok: true } | { ok: false; message: string } {
    try {
      parseHttpUrl(raw, this.policy);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof UnsafeUrlError ? e.message : 'Invalid URL.' };
    }
  }

  /** Validates a user-submitted URL without fetching it. */
  async validate(raw: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    try {
      const u = parseHttpUrl(raw, this.policy);
      await resolveSafe(u.hostname, this.policy);
      return { ok: true, url: u.toString() };
    } catch (e) {
      return { ok: false, message: e instanceof UnsafeUrlError ? e.message : 'Invalid URL.' };
    }
  }

  async fetchPage(raw: string, signal?: AbortSignal): Promise<FetchResult> {
    const cached = this.cache.get(raw);
    if (cached) return cached.ok ? { ...cached, fromCache: true } : cached;
    if (this.pagesFetched >= this.maxPages) return { ok: false, url: raw, code: 'page_limit', message: `Page limit (${this.maxPages}) for this run reached.` };

    let result: FetchResult;
    try {
      result = await this.fetchFollowing(raw, signal);
    } catch (err) {
      result = failure(raw, err, signal);
    }
    if (result.ok || result.code !== 'cancelled') this.cache.set(raw, result);
    if (result.ok || result.code === 'http_error' || result.code === 'bot_protected') this.pagesFetched++;
    return result;
  }

  /** Fetches a page and parses it as HTML. */
  async fetchHtml(raw: string, signal?: AbortSignal): Promise<{ ok: true; result: Extract<FetchResult, { ok: true }>; page: ExtractedPage } | { ok: false; result: Extract<FetchResult, { ok: false }> }> {
    const r = await this.fetchPage(raw, signal);
    if (!r.ok) return { ok: false, result: r };
    return { ok: true, result: r, page: extractPage(r.body, r.finalUrl) };
  }

  relevantLinks(page: ExtractedPage, baseUrl: string, max: number) {
    return selectRelevantLinks(page.links, baseUrl, max);
  }

  /**
   * Fetches ONE public stylesheet or raster image with the same protections as a page (scheme/port/credential checks, DNS validation of every
   * hop, robots.txt, timeout, byte limit) and its own small budget of `maxAssets` per instance. The body is returned as bytes and is never
   * interpreted here. `kind: 'svg'` (logos) returns the SVG TEXT as bytes with a small size limit: it is never rendered as it is, only sanitized and
   * rasterized by the caller (an SVG can reference other resources); `kind: 'image'` still refuses it.
   */
  async fetchAsset(raw: string, o: { kind: 'css' | 'image' | 'svg'; maxBytes?: number; signal?: AbortSignal }): Promise<{ ok: true; finalUrl: string; contentType: string; body: Buffer; truncated: boolean } | { ok: false; code: FetchFailureCode; message: string }> {
    if (this.assetsFetched >= this.maxAssets) return { ok: false, code: 'page_limit', message: `Asset limit (${this.maxAssets}) for this run reached.` };
    this.assetsFetched++;
    const maxBytes = o.maxBytes ?? (o.kind === 'css' ? 400_000 : o.kind === 'svg' ? 300_000 : 2_000_000);
    const ok = o.kind === 'css' ? /^text\/(css|plain)/i : o.kind === 'svg' ? /^image\/svg\+xml/i : /^image\/(png|jpe?g|webp|gif)/i;
    try {
      let current = raw;
      for (let hop = 0; hop <= this.maxRedirects; hop++) {
        const url = parseHttpUrl(current, this.policy);
        await resolveSafe(url.hostname, this.policy);
        if (this.respectRobots && !(await this.robotsAllows(url, o.signal))) return { ok: false, code: 'robots_disallowed', message: `robots.txt of ${url.origin} does not allow fetching ${url.pathname}.` };
        const res = await this.request(url, { accept: o.kind === 'css' ? 'text/css,*/*;q=0.1' : o.kind === 'svg' ? 'image/svg+xml' : 'image/png,image/jpeg,image/webp,image/gif;q=0.9', maxBytes, signal: o.signal });
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          current = new URL(res.headers.location, url).toString();
          continue;
        }
        if (res.status >= 400) return { ok: false, code: 'http_error', message: `The server answered HTTP ${res.status}.` };
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!ok.test(contentType)) return { ok: false, code: 'unsupported_content_type', message: `Content type ${contentType || 'unknown'} is not accepted here.` };
        if (res.truncated && o.kind !== 'css') return { ok: false, code: 'too_large', message: 'The image is larger than the limit.' };
        return { ok: true, finalUrl: url.toString(), contentType, body: res.body, truncated: res.truncated };
      }
      return { ok: false, code: 'too_many_redirects', message: `More than ${this.maxRedirects} redirects.` };
    } catch (err) {
      const f = failure(raw, err, o.signal);
      return f.ok ? { ok: false, code: 'network_error', message: 'The site could not be reached.' } : { ok: false, code: f.code, message: f.message };
    }
  }

  // ---- internals

  private async fetchFollowing(raw: string, signal?: AbortSignal): Promise<FetchResult> {
    let current = raw;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const url = parseHttpUrl(current, this.policy); // throws UnsafeUrlError (each hop is re-validated)
      await resolveSafe(url.hostname, this.policy);
      if (this.respectRobots && !(await this.robotsAllows(url, signal))) {
        return { ok: false, url: raw, code: 'robots_disallowed', message: `robots.txt of ${url.origin} does not allow fetching ${url.pathname}.` };
      }
      const res = await this.request(url, { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', maxBytes: this.maxBytes, signal });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, url).toString();
        continue;
      }
      const vendor = detectBotChallenge(res.status, res.headers as Record<string, string | string[] | undefined>, res.body.subarray(0, 40_000).toString('utf8'));
      if (vendor) {
        return { ok: false, url: raw, code: 'bot_protected', status: res.status, message: `The site is behind ${vendor} bot protection (HTTP ${res.status}): it serves a browser challenge instead of the page, so it cannot be read automatically.` };
      }
      if (res.status >= 400) return { ok: false, url: raw, code: 'http_error', status: res.status, message: `The server answered HTTP ${res.status}.` };
      const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType && !TEXTUAL.test(contentType)) {
        return { ok: false, url: raw, code: 'unsupported_content_type', message: `Content type ${contentType} is not supported (HTML or text only).` };
      }
      return { ok: true, url: raw, finalUrl: url.toString(), status: res.status, contentType: contentType || 'text/html', bytes: res.body.length, truncated: res.truncated, body: decode(res.body, String(res.headers['content-type'] ?? '')), fromCache: false };
    }
    return { ok: false, url: raw, code: 'too_many_redirects', message: `More than ${this.maxRedirects} redirects.` };
  }

  private async robotsAllows(url: URL, signal?: AbortSignal): Promise<boolean> {
    let rules = this.robots.get(url.origin);
    if (!rules) {
      try {
        const res = await this.request(new URL('/robots.txt', url.origin), { accept: 'text/plain', maxBytes: 150_000, signal });
        if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body.toString('utf8'));
        else if (res.status >= 400 && res.status < 500) rules = parseRobots(''); // no robots file: no restrictions (RFC 9309)
        else rules = 'deny_all'; // server error: assume disallowed
      } catch {
        rules = 'deny_all'; // robots.txt unreachable: be conservative
      }
      this.robots.set(url.origin, rules);
    }
    return rules === 'deny_all' ? false : rules.allowed(url.pathname + url.search);
  }

  private request(url: URL, o: { accept: string; maxBytes: number; signal?: AbortSignal }): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const signals = [AbortSignal.timeout(this.timeoutMs), ...(o.signal ? [o.signal] : [])];
      const req = lib.request(
        url,
        {
          method: 'GET',
          headers: { 'user-agent': this.userAgent, accept: o.accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': '*' },
          lookup: guardedLookup(this.policy) as never, // validates the address at connect time (anti DNS-rebinding)
          signal: AbortSignal.any(signals),
        },
        (res) => {
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
          const out: Readable = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : encoding === 'deflate' ? res.pipe(zlib.createInflate()) : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const finish = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
          out.on('data', (c: Buffer) => {
            if (truncated) return;
            if (size + c.length > o.maxBytes) {
              chunks.push(c.subarray(0, o.maxBytes - size));
              size = o.maxBytes;
              truncated = true;
              res.destroy(); // stop downloading; keep what we have
              finish();
              return;
            }
            chunks.push(c);
            size += c.length;
          });
          out.on('end', () => !truncated && finish());
          out.on('error', (e) => !truncated && reject(e));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
}

type Readable = NodeJS.ReadableStream;

function decode(buf: Buffer, contentType: string): string {
  const cs = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function failure(url: string, err: unknown, signal?: AbortSignal): FetchResult {
  if (err instanceof UnsafeUrlError) return { ok: false, url, code: 'blocked_url', message: err.message };
  if (signal?.aborted) return { ok: false, url, code: 'cancelled', message: 'Cancelled.' };
  const name = (err as { name?: string; code?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  // The guarded lookup reports unsafe resolutions as an UnsafeUrlError-like error through the socket.
  if ((err as { code?: string } | null)?.code === 'blocked_address') return { ok: false, url, code: 'blocked_url', message: 'The host resolves to a non-public address.' };
  const causeName = (err as { cause?: { name?: string } } | null)?.cause?.name;
  if (name === 'TimeoutError' || causeName === 'TimeoutError' || code === 'ETIMEDOUT') return { ok: false, url, code: 'timeout', message: 'The server did not answer in time.' };
  if (name === 'AbortError') return { ok: false, url, code: 'cancelled', message: 'Cancelled.' };
  return { ok: false, url, code: 'network_error', message: 'The site could not be reached.' };
}
