import { platformOfHost } from './seo';

/**
 * Social profile tools (F2). Only OFFICIAL, authorized APIs. No scraping, no login automation.
 *
 *  - parseSocialUrl: pure URL validator / handle extractor (no network).
 *  - YouTubeTool: YouTube Data API v3 (public channel data with an API key).
 *      GET https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&forHandle=|id=|forUsername=&key=
 *      GET https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=<uploads>&maxResults=10&key=
 *    Optional (YOUTUBE_API_KEY). Subscriber counts can be hidden by the channel owner: then they are reported as hidden.
 *  - Instagram, Facebook, LinkedIn, X, TikTok, Pinterest and Reddit have NO live adapter here: their public pages
 *    require login/anti-bot measures and the official APIs need an authorized app and account tokens, which LaunchPilot
 *    does not hold. Their metrics are reported as unavailable unless the user supplies them.
 */

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x', 'youtube', 'tiktok', 'pinterest', 'reddit'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface ParsedSocialUrl {
  /** The platform the user declared (normalized). */
  declared: string;
  /** The platform the URL's host belongs to, or null. */
  actual: string | null;
  valid: boolean;
  handle: string | null;
  youtube: { handle?: string; channelId?: string; username?: string } | null;
  issues: string[];
}

const normalizePlatform = (p: string) => {
  const s = p.trim().toLowerCase();
  return s === 'twitter' ? 'x' : s;
};

export function parseSocialUrl(platform: string, raw: string): ParsedSocialUrl {
  const declared = normalizePlatform(platform);
  const out: ParsedSocialUrl = { declared, actual: null, valid: false, handle: null, youtube: null, issues: [] };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    out.issues.push('Not a valid URL.');
    return out;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    out.issues.push('Only http(s) profile URLs are accepted.');
    return out;
  }
  out.actual = platformOfHost(url.hostname);
  if (!out.actual) out.issues.push(`The host ${url.hostname} is not a supported social platform.`);
  else if (declared && out.actual !== declared) out.issues.push(`The URL belongs to ${out.actual}, but the profile is listed as ${declared}.`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (out.actual === 'youtube') {
    if (parts[0]?.startsWith('@')) out.youtube = { handle: parts[0] };
    else if (parts[0] === 'channel' && parts[1]) out.youtube = { channelId: parts[1] };
    else if ((parts[0] === 'user' || parts[0] === 'c') && parts[1]) out.youtube = parts[0] === 'user' ? { username: parts[1] } : null;
    out.handle = parts[0]?.startsWith('@') ? parts[0] : (parts[1] ?? null);
  } else if (out.actual === 'linkedin') out.handle = parts[1] ?? null;
  else out.handle = parts[0] ? parts[0].replace(/^@/, '') : null;
  if (out.actual && !out.handle) out.issues.push('The URL does not point to a specific profile or page.');
  out.valid = !!out.actual && out.actual === declared && !!out.handle;
  return out;
}

// ---- YouTube Data API ------------------------------------------------------------------------------

export const YOUTUBE_URL = 'https://www.googleapis.com/youtube/v3';
export type YouTubeFailure = 'not_configured' | 'unsupported_reference' | 'not_found' | 'quota' | 'forbidden' | 'timeout' | 'http_error' | 'invalid_response' | 'cancelled' | 'network_error';

export interface YouTubeChannel {
  ok: true;
  channelId: string;
  title: string;
  description: string;
  customUrl: string | null;
  publishedAt: string | null;
  country: string | null;
  subscriberCount: number | null;
  subscribersHidden: boolean;
  viewCount: number | null;
  videoCount: number | null;
  recent: { title: string; publishedAt: string | null }[];
  /** Computed from the returned upload dates only. */
  uploadsInLast90Days: number | null;
}
export type YouTubeOutcome = YouTubeChannel | { ok: false; code: YouTubeFailure; message: string };

export class YouTubeTool {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private calls = 0;
  private readonly maxCalls: number;

  constructor(options: { apiKey?: string; baseUrl?: string; timeoutMs?: number; maxCalls?: number } = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = options.baseUrl ?? YOUTUBE_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxCalls = options.maxCalls ?? 6;
  }

  get configured() {
    return !!this.apiKey;
  }
  get callCount() {
    return this.calls;
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ ok: true; body: Record<string, any> } | { ok: false; code: YouTubeFailure; message: string }> {
    if (this.calls >= this.maxCalls) return { ok: false, code: 'quota', message: 'The per-run limit of YouTube API requests was reached.' };
    this.calls++;
    const q = new URLSearchParams({ ...params, key: this.apiKey! });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${path}?${q.toString()}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } });
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: 'cancelled', message: 'The YouTube request was cancelled.' };
      if (timeout.aborted || (e as { name?: string }).name === 'TimeoutError') return { ok: false, code: 'timeout', message: 'The YouTube API did not answer in time.' };
      return { ok: false, code: 'network_error', message: 'The YouTube API could not be reached.' };
    }
    let body: Record<string, any> = {};
    try {
      body = (await res.json()) as Record<string, any>;
    } catch {
      /* non-JSON error */
    }
    if (!res.ok) {
      const reason = String(body?.error?.errors?.[0]?.reason ?? '');
      if (reason === 'quotaExceeded' || res.status === 429) return { ok: false, code: 'quota', message: 'The YouTube Data API quota is exhausted.' };
      if (res.status === 403 || res.status === 400) return { ok: false, code: 'forbidden', message: `The YouTube Data API refused the request (HTTP ${res.status}). Check YOUTUBE_API_KEY and that the API is enabled.` };
      return { ok: false, code: 'http_error', message: `The YouTube Data API answered HTTP ${res.status}.` };
    }
    return { ok: true, body };
  }

  async channel(ref: { handle?: string; channelId?: string; username?: string }, signal?: AbortSignal): Promise<YouTubeOutcome> {
    if (!this.apiKey) return { ok: false, code: 'not_configured', message: 'YOUTUBE_API_KEY is not configured, so no live YouTube data was requested.' };
    const params: Record<string, string> = { part: 'snippet,statistics,contentDetails' };
    if (ref.channelId) params.id = ref.channelId;
    else if (ref.handle) params.forHandle = ref.handle;
    else if (ref.username) params.forUsername = ref.username;
    else return { ok: false, code: 'unsupported_reference', message: 'This YouTube URL form (custom /c/ name) cannot be resolved with the official API. Use the @handle or /channel/ URL.' };

    const ch = await this.get('channels', params, signal);
    if (!ch.ok) return ch;
    const item = ch.body.items?.[0];
    if (!item) return { ok: false, code: 'not_found', message: 'The YouTube API found no channel for this reference.' };
    if (typeof item.id !== 'string' || !item.snippet) return { ok: false, code: 'invalid_response', message: 'The YouTube API returned an unexpected response.' };

    const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const hidden = item.statistics?.hiddenSubscriberCount === true;
    let recent: YouTubeChannel['recent'] = [];
    let uploads90: number | null = null;
    const uploadsId = item.contentDetails?.relatedPlaylists?.uploads;
    if (typeof uploadsId === 'string') {
      const pl = await this.get('playlistItems', { part: 'snippet,contentDetails', playlistId: uploadsId, maxResults: '10' }, signal);
      if (pl.ok && Array.isArray(pl.body.items)) {
        recent = pl.body.items.slice(0, 10).map((it: any) => ({ title: String(it.snippet?.title ?? '').slice(0, 140), publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? null }));
        const cutoff = Date.now() - 90 * 86_400_000;
        // Only meaningful when the 10 most recent uploads reach back past the 90-day window (otherwise it is "at least").
        uploads90 = recent.filter((r) => r.publishedAt && Date.parse(r.publishedAt) >= cutoff).length;
      }
    }
    return {
      ok: true,
      channelId: item.id,
      title: String(item.snippet.title ?? ''),
      description: String(item.snippet.description ?? '').slice(0, 600),
      customUrl: item.snippet.customUrl ?? null,
      publishedAt: item.snippet.publishedAt ?? null,
      country: item.snippet.country ?? null,
      subscriberCount: hidden ? null : num(item.statistics?.subscriberCount),
      subscribersHidden: hidden,
      viewCount: num(item.statistics?.viewCount),
      videoCount: num(item.statistics?.videoCount),
      recent,
      uploadsInLast90Days: uploads90,
    };
  }
}

export function describeYouTube(c: YouTubeChannel): string {
  return [
    'source: YouTube Data API v3 (official), live request',
    `channel: ${c.title} (${c.channelId})${c.customUrl ? ` ${c.customUrl}` : ''}`,
    `description: ${c.description || '(empty)'}`,
    `created: ${c.publishedAt ?? 'unavailable'}; country: ${c.country ?? 'not stated'}`,
    `subscribers: ${c.subscribersHidden ? 'hidden by the channel owner' : (c.subscriberCount ?? 'unavailable')}`,
    `total_views: ${c.viewCount ?? 'unavailable'}; videos: ${c.videoCount ?? 'unavailable'}`,
    `uploads_in_last_90_days (among the ${c.recent.length} most recent uploads returned): ${c.uploadsInLast90Days ?? 'unavailable'}`,
    ...c.recent.map((r) => `recent_upload: ${r.publishedAt ?? 'date unavailable'} | ${r.title}`),
  ].join('\n');
}
