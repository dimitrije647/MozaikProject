import { openverseVerdict, pexelsVerdict, pixabayVerdict, referenceVerdict } from './license';
import type { ImageCandidate, SearchIntent } from './types';

/**
 * IMAGE SOURCE ADAPTERS. One small class per provider, each calling that provider's OFFICIAL API at a fixed base URL (a provider's host is
 * checked before every request, so no user input can redirect a call). Nothing here scrapes a page, nothing downloads a picture (see
 * ./acquire.ts) and nothing is invented: a provider without credentials is simply not configured, and a failing provider reports a safe sentence.
 *
 *   Pixabay    licensed  API key (PIXABAY_API_KEY)      Pixabay Content License
 *   Pexels     licensed  API key (PEXELS_API_KEY)        Pexels License (the provider has paused NEW key issuance; existing keys work)
 *   Openverse  licensed  opt-in (OPENVERSE_ENABLED=true) per-work Creative Commons licenses, always checked at the source
 *   Brave      reference opt-in (LAUNCHPILOT_REFERENCE_IMAGE_SEARCH=on + BRAVE_SEARCH_API_KEY): pictures to look at, never to use
 *
 * Google Custom Search and Bing image search are not used: Google's JSON API is closed to new customers and Bing's search APIs were retired.
 */

export type ImageSearchErrorCode = 'invalid_key' | 'rate_limited' | 'unavailable' | 'bad_response' | 'blocked_host';

export class ImageSearchError extends Error {
  constructor(
    readonly code: ImageSearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageSearchError';
  }
}

export interface ImageSearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface ImageSearchAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: 'licensed' | 'reference';
  readonly configured: boolean;
  /** the provider bills per request (Brave Search). A paid provider is never used unless the user approved paid search for the campaign. */
  readonly paid?: boolean;
  /** what to do to switch it on, shown when it is not configured */
  readonly setup: string;
  search(intent: SearchIntent, o?: ImageSearchOptions): Promise<ImageCandidate[]>;
}

interface Deps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SAFE: Record<ImageSearchErrorCode, string> = {
  invalid_key: 'The provider rejected the API key.',
  rate_limited: 'The provider\'s request limit was reached; try again later.',
  unavailable: 'The provider could not be reached.',
  bad_response: 'The provider answered in a format that could not be read.',
  blocked_host: 'The request was not sent: it did not go to the provider\'s official address.',
};

async function getJson(f: typeof fetch, url: string, hosts: readonly string[], init: { headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new ImageSearchError('blocked_host', SAFE.blocked_host);
  let res: Response;
  try {
    res = await f(u.toString(), { headers: { accept: 'application/json', 'user-agent': 'LaunchPilot-VisualDiscovery', ...(init.headers ?? {}) }, signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])]), redirect: 'error' });
  } catch {
    throw new ImageSearchError('unavailable', SAFE.unavailable);
  }
  if (res.status === 401 || res.status === 403) throw new ImageSearchError('invalid_key', SAFE.invalid_key);
  if (res.status === 429) throw new ImageSearchError('rate_limited', SAFE.rate_limited);
  if (!res.ok) throw new ImageSearchError('unavailable', SAFE.unavailable);
  try {
    return await res.json();
  } catch {
    throw new ImageSearchError('bad_response', SAFE.bad_response);
  }
}

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max) : '');
const nstr = (v: unknown, max = 300): string | null => str(v, max) || null;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
/** only https URLs of the expected hosts are carried on */
function httpsUrl(v: unknown, hosts: readonly string[] | null): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---- Pixabay ------------------------------------------------------------------------------------------------------------------------------

export const PIXABAY_HOSTS = ['pixabay.com'] as const;

export class PixabayAdapter implements ImageSearchAdapter {
  readonly id = 'pixabay';
  readonly label = 'Pixabay';
  readonly kind = 'licensed' as const;
  readonly setup = 'Create a free key at pixabay.com/api/docs and set PIXABAY_API_KEY in the API environment.';
  readonly #key: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  constructor(key: string | undefined, d: Deps = {}) {
    this.#key = (key ?? '').trim();
    this.f = d.fetch ?? fetch;
    this.timeoutMs = d.timeoutMs ?? 8000;
  }
  get configured() {
    return this.#key.length > 0;
  }
  async search(intent: SearchIntent, o: ImageSearchOptions = {}): Promise<ImageCandidate[]> {
    if (!this.configured) return [];
    const q = new URLSearchParams({ key: this.#key, q: intent.query.slice(0, 100), image_type: 'photo', safe_search: 'true', per_page: String(Math.min(Math.max(o.limit ?? 8, 3), 20)), order: 'popular' });
    if (intent.orientation === 'landscape') q.set('orientation', 'horizontal');
    if (intent.orientation === 'portrait') q.set('orientation', 'vertical');
    const body = (await getJson(this.f, `https://pixabay.com/api/?${q}`, PIXABAY_HOSTS, { timeoutMs: this.timeoutMs, signal: o.signal })) as { hits?: Record<string, unknown>[] };
    if (!Array.isArray(body?.hits)) throw new ImageSearchError('bad_response', SAFE.bad_response);
    const out: ImageCandidate[] = [];
    for (const h of body.hits.slice(0, 20)) {
      const page = httpsUrl(h.pageURL, ['pixabay.com']);
      const dl = httpsUrl(h.largeImageURL, ['pixabay.com']);
      if (!page || !dl || h.id === undefined) continue;
      const tags = str(h.tags, 200).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12);
      const user = nstr(h.user, 60);
      out.push({
        id: String(h.id).slice(0, 40),
        provider: this.id,
        kind: 'LICENSED_STOCK',
        title: tags.slice(0, 4).join(', ') || 'Pixabay picture',
        pageUrl: page,
        creator: user,
        creatorUrl: user && h.user_id ? `https://pixabay.com/users/${encodeURIComponent(user)}-${String(h.user_id).replace(/\D/g, '')}/` : null,
        width: int(h.imageWidth),
        height: int(h.imageHeight),
        tags,
        thumbnailUrl: httpsUrl(h.webformatURL, ['pixabay.com']),
        downloadUrl: dl,
        license: pixabayVerdict({ tags, title: '', user, pageUrl: page }),
        platform: null,
      });
    }
    return out;
  }
}

// ---- Pexels -------------------------------------------------------------------------------------------------------------------------------

export class PexelsAdapter implements ImageSearchAdapter {
  readonly id = 'pexels';
  readonly label = 'Pexels';
  readonly kind = 'licensed' as const;
  readonly setup = 'Set PEXELS_API_KEY in the API environment. Pexels has paused issuing NEW keys; an existing key still works.';
  readonly #key: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  constructor(key: string | undefined, d: Deps = {}) {
    this.#key = (key ?? '').trim();
    this.f = d.fetch ?? fetch;
    this.timeoutMs = d.timeoutMs ?? 8000;
  }
  get configured() {
    return this.#key.length > 0;
  }
  async search(intent: SearchIntent, o: ImageSearchOptions = {}): Promise<ImageCandidate[]> {
    if (!this.configured) return [];
    const q = new URLSearchParams({ query: intent.query.slice(0, 100), per_page: String(Math.min(Math.max(o.limit ?? 8, 3), 20)) });
    if (intent.orientation) q.set('orientation', intent.orientation);
    const body = (await getJson(this.f, `https://api.pexels.com/v1/search?${q}`, ['api.pexels.com'], { headers: { authorization: this.#key }, timeoutMs: this.timeoutMs, signal: o.signal })) as { photos?: Record<string, unknown>[] };
    if (!Array.isArray(body?.photos)) throw new ImageSearchError('bad_response', SAFE.bad_response);
    const out: ImageCandidate[] = [];
    for (const p of body.photos.slice(0, 20)) {
      const src = (p.src ?? {}) as Record<string, unknown>;
      const page = httpsUrl(p.url, ['pexels.com']);
      const dl = httpsUrl(src.large2x ?? src.large, ['pexels.com']);
      if (!page || !dl || p.id === undefined) continue;
      const title = str(p.alt, 140) || 'Pexels photo';
      const photographer = nstr(p.photographer, 60);
      out.push({
        id: String(p.id).slice(0, 40),
        provider: this.id,
        kind: 'LICENSED_STOCK',
        title,
        pageUrl: page,
        creator: photographer,
        creatorUrl: httpsUrl(p.photographer_url, ['pexels.com']),
        width: int(p.width),
        height: int(p.height),
        tags: title.toLowerCase().split(/\s+/).slice(0, 12),
        thumbnailUrl: httpsUrl(src.medium, ['pexels.com']),
        downloadUrl: dl,
        license: pexelsVerdict({ tags: title.toLowerCase().split(/\s+/), title, photographer }),
        platform: null,
      });
    }
    return out;
  }
}

// ---- Openverse ----------------------------------------------------------------------------------------------------------------------------

export class OpenverseAdapter implements ImageSearchAdapter {
  readonly id = 'openverse';
  readonly label = 'Openverse (Creative Commons)';
  readonly kind = 'licensed' as const;
  readonly setup = 'Set OPENVERSE_ENABLED=true in the API environment (no key is needed; a registered token raises the rate limit).';
  private readonly on: boolean;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  readonly #token: string;
  constructor(o: { enabled?: boolean; token?: string } & Deps = {}) {
    this.on = !!o.enabled;
    this.#token = (o.token ?? '').trim();
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8000;
  }
  get configured() {
    return this.on;
  }
  async search(intent: SearchIntent, o: ImageSearchOptions = {}): Promise<ImageCandidate[]> {
    if (!this.configured) return [];
    // only works that Openverse itself classifies as usable commercially AND for adaptations are asked for; every result is classified again here
    const q = new URLSearchParams({ q: intent.query.slice(0, 100), license_type: 'commercial,modification', page_size: String(Math.min(Math.max(o.limit ?? 8, 3), 20)), mature: 'false' });
    const body = (await getJson(this.f, `https://api.openverse.org/v1/images/?${q}`, ['api.openverse.org'], { headers: this.#token ? { authorization: `Bearer ${this.#token}` } : {}, timeoutMs: this.timeoutMs, signal: o.signal })) as { results?: Record<string, unknown>[] };
    if (!Array.isArray(body?.results)) throw new ImageSearchError('bad_response', SAFE.bad_response);
    const out: ImageCandidate[] = [];
    for (const r of body.results.slice(0, 20)) {
      const page = httpsUrl(r.foreign_landing_url, null);
      const dl = httpsUrl(r.url, null);
      if (!page || !dl || r.id === undefined) continue;
      const tags = Array.isArray(r.tags) ? (r.tags as { name?: unknown }[]).map((t) => str(t?.name, 40)).filter(Boolean).slice(0, 12) : [];
      const title = str(r.title, 140) || 'Openverse picture';
      out.push({
        id: String(r.id).slice(0, 60),
        provider: this.id,
        kind: 'LICENSED_STOCK',
        title,
        pageUrl: page,
        creator: nstr(r.creator, 80),
        creatorUrl: httpsUrl(r.creator_url, null),
        width: int(r.width),
        height: int(r.height),
        tags,
        thumbnailUrl: httpsUrl(r.thumbnail, null),
        downloadUrl: dl,
        license: openverseVerdict({ license: nstr(r.license, 20), version: nstr(r.license_version, 10), licenseUrl: httpsUrl(r.license_url, ['creativecommons.org']), attribution: nstr(r.attribution, 400), tags, title }),
        platform: null,
      });
    }
    return out;
  }
}

// ---- reference-only web image search ---------------------------------------------------------------------------------------------------------

export const isPinterestHost = (host: string) => /(^|\.)pinterest\.[a-z.]{2,6}$|(^|\.)pin\.it$/i.test(host);

/**
 * Brave's official image search, used ONLY to find pictures worth LOOKING at. Its terms grant no right to store, adapt or redistribute a result,
 * so every result is REFERENCE_ONLY: a title, the page it lives on and (except for Pinterest) the thumbnail Brave itself serves, for display.
 * Pinterest results never carry a thumbnail: they are a link only.
 */
export class BraveReferenceAdapter implements ImageSearchAdapter {
  readonly id = 'brave_images';
  readonly label = 'Web image search (reference only)';
  readonly kind = 'reference' as const;
  readonly paid = true;
  readonly setup = 'Set BRAVE_SEARCH_API_KEY and LAUNCHPILOT_REFERENCE_IMAGE_SEARCH=on in the API environment. Results are for inspiration only and are never used in a creative.';
  readonly #key: string;
  private readonly on: boolean;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  constructor(o: { key?: string; enabled?: boolean } & Deps = {}) {
    this.#key = (o.key ?? '').trim();
    this.on = !!o.enabled;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8000;
  }
  get configured() {
    return this.on && this.#key.length > 0;
  }
  async search(intent: SearchIntent, o: ImageSearchOptions = {}): Promise<ImageCandidate[]> {
    if (!this.configured) return [];
    const q = new URLSearchParams({ q: intent.query.slice(0, 100), count: String(Math.min(Math.max(o.limit ?? 8, 3), 20)), safesearch: 'strict' });
    const body = (await getJson(this.f, `https://api.search.brave.com/res/v1/images/search?${q}`, ['api.search.brave.com'], { headers: { 'x-subscription-token': this.#key }, timeoutMs: this.timeoutMs, signal: o.signal })) as { results?: Record<string, unknown>[] };
    if (!Array.isArray(body?.results)) throw new ImageSearchError('bad_response', SAFE.bad_response);
    const out: ImageCandidate[] = [];
    for (const r of body.results.slice(0, 20)) {
      const page = httpsUrl(r.url, null);
      if (!page) continue;
      const host = new URL(page).hostname;
      const pin = isPinterestHost(host);
      const thumb = (r.thumbnail ?? {}) as Record<string, unknown>;
      out.push({
        id: `${host}:${page.length}:${str(r.title, 20)}`.slice(0, 80),
        provider: this.id,
        kind: 'REFERENCE_ONLY',
        title: str(r.title, 140) || host,
        pageUrl: page,
        creator: null,
        creatorUrl: null,
        width: null,
        height: null,
        tags: [],
        thumbnailUrl: pin ? null : httpsUrl(thumb.src, null),
        downloadUrl: null,
        license: referenceVerdict(pin ? 'Pinterest' : null),
        platform: pin ? 'Pinterest: link only' : host,
      });
    }
    return out;
  }
}

/** The adapters the environment switches on. Nothing is configured by default: a fresh install makes no external image-search request. */
export function createImageAdaptersFromEnv(env: NodeJS.ProcessEnv = process.env, d: Deps = {}): ImageSearchAdapter[] {
  const on = (v: string | undefined) => /^(1|true|on|yes)$/i.test((v ?? '').trim());
  return [
    new PixabayAdapter(env.PIXABAY_API_KEY, d),
    new PexelsAdapter(env.PEXELS_API_KEY, d),
    new OpenverseAdapter({ enabled: on(env.OPENVERSE_ENABLED), token: env.OPENVERSE_TOKEN, ...d }),
    new BraveReferenceAdapter({ key: env.BRAVE_SEARCH_API_KEY, enabled: on(env.LAUNCHPILOT_REFERENCE_IMAGE_SEARCH), ...d }),
  ];
}
