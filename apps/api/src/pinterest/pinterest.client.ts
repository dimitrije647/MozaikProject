import { Inject, Injectable } from '@nestjs/common';
import {
  PINTEREST_BOARD_PAGE_SIZE,
  PINTEREST_HTTP_TIMEOUT_MS,
  PINTEREST_PATHS,
  PINTEREST_PIN_PAGE_SIZE,
  PINTEREST_SCOPES,
} from './pinterest.constants';
import { PinterestConfig, readPinterestConfig } from './pinterest.config';
import { PinterestError } from './pinterest.errors';
import { humanWait } from './pinterest.rate-guard';

/** Nest provider token for the HTTP function. Tests replace it with a mock; production uses the global `fetch`. */
export const PINTEREST_FETCH = Symbol('PINTEREST_FETCH');

export interface PinterestFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type PinterestFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<PinterestFetchResponse>;

export const defaultPinterestFetch: PinterestFetch = (url, init) => fetch(url, init) as Promise<PinterestFetchResponse>;

// ---- normalized shapes (the ONLY Pinterest data the rest of the app ever sees) ------------------------------------------------------------

export interface PinterestTokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  /** Space-separated, as granted. */
  scopes: string;
}

export interface PinterestBoardView {
  id: string;
  name: string;
  description: string | null;
  privacy: string | null;
  pinCount: number | null;
  /** Board owner's Pinterest username (for attribution, shown only; never stored). */
  ownerUsername: string | null;
  /** Link to the owner's Pinterest profile, for attribution. */
  ownerProfileUrl: string | null;
  /** Cover image URL served by Pinterest, for in-browser display only. */
  coverImageUrl: string | null;
}

export interface PinterestPinView {
  id: string;
  title: string | null;
  description: string | null;
  altText: string | null;
  mediaType: 'image' | 'video' | 'multiple' | 'unknown';
  /** Image URL served by Pinterest, for in-browser display only. The server never fetches it. */
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** Canonical link back to the Pin on Pinterest (required attribution). */
  pinUrl: string;
  boardId: string | null;
  boardOwnerUsername: string | null;
  boardOwnerProfileUrl: string | null;
}

export interface PinterestPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null on the last page. */
  bookmark: string | null;
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------------------

const BOARD_ID = /^\d{1,32}$/;
const USERNAME = /^[A-Za-z0-9_.\-]{1,100}$/;
const BOOKMARK = /^\S{1,1024}$/;
const MAX_BODY_CHARS = 5_000_000;

export const isValidBoardId = (v: unknown): v is string => typeof v === 'string' && BOARD_ID.test(v);
export const isValidBookmark = (v: unknown): v is string => typeof v === 'string' && BOOKMARK.test(v);

const str = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
/** Only https URLs may reach `<img src>`; anything else (javascript:, data:, http:) is dropped. */
const httpsUrl = (v: unknown): string | null => {
  const s = str(v, 2048);
  if (!s) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};
const profileUrl = (username: string | null) => (username && USERNAME.test(username) ? `https://www.pinterest.com/${username}/` : null);
export const pinUrl = (id: string) => `https://www.pinterest.com/pin/${id}/`;

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Picks a display-size image from a Pinterest `images` map ({ "600x": {url,width,height}, ... }). */
function pickImage(images: unknown): { url: string; width: number | null; height: number | null } | null {
  const map = asObject(images);
  for (const size of ['600x', '400x300', '1200x', '150x150']) {
    const e = asObject(map[size]);
    const url = httpsUrl(e.url);
    if (url) return { url, width: int(e.width), height: int(e.height) };
  }
  return null;
}

export function parseRetryAfter(headers: { get(name: string): string | null }, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  // `x-ratelimit-reset` is shown in Pinterest's rate-limit page example but its unit is not defined there (UNVERIFIED).
  // A small positive integer is treated as seconds; anything else is ignored.
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0 && reset <= 86_400) return Math.ceil(reset);
  return undefined;
}

/**
 * The ONLY code that talks HTTP to Pinterest. It can reach exactly three fixed paths on the configured API host
 * (`/v5/oauth/token`, `/v5/boards`, `/v5/boards/{numeric id}/pins`). No caller-supplied URL is ever requested, no redirect is
 * followed, no page is scraped, and no Pin image is downloaded: image URLs from the API are only passed on to the browser.
 * Tokens and response bodies are never logged.
 */
@Injectable()
export class PinterestClient {
  constructor(@Inject(PINTEREST_FETCH) private readonly doFetch: PinterestFetch) {}

  // ---- OAuth ---------------------------------------------------------------------------------------------------------------------------

  async exchangeAuthorizationCode(code: string): Promise<PinterestTokenSet> {
    const cfg = this.cfg();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
    if (cfg.continuousRefresh) body.set('continuous_refresh', 'true');
    return this.tokenRequest(cfg, body);
  }

  async refreshAccessToken(refreshToken: string): Promise<PinterestTokenSet> {
    const cfg = this.cfg();
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (cfg.continuousRefresh) body.set('continuous_refresh', 'true');
    return this.tokenRequest(cfg, body);
  }

  private async tokenRequest(cfg: PinterestConfig, body: URLSearchParams): Promise<PinterestTokenSet> {
    const basic = Buffer.from(`${cfg.appId}:${cfg.appSecret}`, 'utf8').toString('base64');
    const res = await this.send(cfg, PINTEREST_PATHS.token, 'POST', {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }, body.toString());

    if (res.status >= 200 && res.status < 300) {
      const j = asObject(res.json);
      const accessToken = str(j.access_token, 4096);
      const expiresIn = int(j.expires_in);
      if (!accessToken || !expiresIn || expiresIn <= 0) {
        throw new PinterestError('upstream_error', 'Pinterest returned a token response we could not read. Nothing was saved.', { upstreamStatus: res.status });
      }
      const now = Date.now();
      const refreshToken = str(j.refresh_token, 4096);
      const rIn = int(j.refresh_token_expires_in);
      const rAt = int(j.refresh_token_expires_at);
      const refreshExpiresAt = rIn && rIn > 0 ? new Date(now + rIn * 1000) : rAt && rAt > 0 ? new Date(rAt * 1000) : null;
      // `scope` may be comma or space separated (the docs allow both when requesting).
      const granted = (str(j.scope, 1000) ?? PINTEREST_SCOPES.join(' ')).split(/[\s,]+/).filter(Boolean);
      return { accessToken, refreshToken, accessExpiresAt: new Date(now + expiresIn * 1000), refreshExpiresAt, scopes: [...new Set(granted)].sort().join(' ') };
    }
    throw this.mapFailure(res, 'oauth');
  }

  // ---- data (read-only) ----------------------------------------------------------------------------------------------------------------------

  async listBoards(accessToken: string, opts: { bookmark?: string; pageSize?: number } = {}): Promise<PinterestPage<PinterestBoardView>> {
    const cfg = this.cfg();
    const q = new URLSearchParams({ page_size: String(clampPage(opts.pageSize, PINTEREST_BOARD_PAGE_SIZE)) });
    if (opts.bookmark) q.set('bookmark', checkBookmark(opts.bookmark));
    const res = await this.send(cfg, PINTEREST_PATHS.boards, 'GET', bearer(accessToken), undefined, q);
    if (res.status !== 200) throw this.mapFailure(res, 'data');
    const j = asObject(res.json);
    const items = (Array.isArray(j.items) ? j.items : []).map(asObject).flatMap((b): PinterestBoardView[] => {
      const id = str(b.id, 40);
      const name = str(b.name, 300);
      if (!id || !BOARD_ID.test(id) || !name) return [];
      const owner = str(asObject(b.owner).username, 100);
      return [{
        id,
        name,
        description: str(b.description, 500),
        privacy: str(b.privacy, 20),
        pinCount: int(b.pin_count),
        ownerUsername: owner,
        ownerProfileUrl: profileUrl(owner),
        coverImageUrl: httpsUrl(asObject(b.media).image_cover_url),
      }];
    });
    return { items, bookmark: str(j.bookmark, 1024) };
  }

  async listBoardPins(accessToken: string, boardId: string, opts: { bookmark?: string; pageSize?: number } = {}): Promise<PinterestPage<PinterestPinView>> {
    const cfg = this.cfg();
    if (!isValidBoardId(boardId)) throw new PinterestError('invalid_request', 'That is not a valid Pinterest board id.');
    const q = new URLSearchParams({ page_size: String(clampPage(opts.pageSize, PINTEREST_PIN_PAGE_SIZE)) });
    if (opts.bookmark) q.set('bookmark', checkBookmark(opts.bookmark));
    const res = await this.send(cfg, PINTEREST_PATHS.boardPins(boardId), 'GET', bearer(accessToken), undefined, q);
    if (res.status !== 200) throw this.mapFailure(res, 'data');
    const j = asObject(res.json);
    const items = (Array.isArray(j.items) ? j.items : []).map(asObject).flatMap((p): PinterestPinView[] => {
      const id = str(p.id, 40);
      if (!id || !BOARD_ID.test(id)) return [];
      const media = asObject(p.media);
      const type = str(media.media_type, 30);
      let img = pickImage(media.images);
      if (!img && type === 'video') {
        const cover = httpsUrl(media.cover_image_url);
        if (cover) img = { url: cover, width: int(media.width), height: int(media.height) };
      }
      if (!img && Array.isArray(media.items)) {
        for (const it of media.items.map(asObject)) {
          img = pickImage(it.images) ?? (httpsUrl(it.cover_image_url) ? { url: httpsUrl(it.cover_image_url)!, width: null, height: null } : null);
          if (img) break;
        }
      }
      const owner = str(asObject(p.board_owner).username, 100);
      return [{
        id,
        title: str(p.title, 200),
        description: str(p.description, 400),
        altText: str(p.alt_text, 500),
        mediaType: type === 'image' ? 'image' : type === 'video' ? 'video' : type?.startsWith('multiple') ? 'multiple' : 'unknown',
        imageUrl: img?.url ?? null,
        imageWidth: img?.width ?? null,
        imageHeight: img?.height ?? null,
        pinUrl: pinUrl(id),
        boardId: str(p.board_id, 40),
        boardOwnerUsername: owner,
        boardOwnerProfileUrl: profileUrl(owner),
      }];
    });
    return { items, bookmark: str(j.bookmark, 1024) };
  }

  // ---- transport -----------------------------------------------------------------------------------------------------------------------

  private cfg(): PinterestConfig {
    const cfg = readPinterestConfig();
    if (!cfg.configured) {
      throw new PinterestError('not_configured', 'Pinterest is not configured on this server. An administrator has to set the Pinterest app credentials first.');
    }
    return cfg;
  }

  /**
   * The single choke point for outbound HTTP. The URL is built here from the configured host and a fixed path; the final URL is
   * re-checked against both before the request is made.
   */
  private async send(
    cfg: PinterestConfig,
    path: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: string,
    query?: URLSearchParams,
  ): Promise<{ status: number; headers: { get(name: string): string | null }; json: unknown }> {
    const url = new URL(path, cfg.apiBase);
    if (query) url.search = query.toString();
    const allowedPath = path === PINTEREST_PATHS.token || path === PINTEREST_PATHS.boards || /^\/v5\/boards\/\d{1,32}\/pins$/.test(path);
    if (url.origin !== cfg.apiBase || url.pathname !== path || !allowedPath || url.username || url.password) {
      // Defensive: unreachable through the public methods above.
      throw new PinterestError('invalid_request', 'Refused to call an address that is not a fixed Pinterest API path.');
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PINTEREST_HTTP_TIMEOUT_MS);
    try {
      const res = await this.doFetch(url.toString(), { method, headers, body, signal: ctl.signal, redirect: 'error' });
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) throw new PinterestError('upstream_error', 'Pinterest returned an unexpectedly large response.', { upstreamStatus: res.status });
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined; // non-JSON bodies are ignored, never logged or relayed
        }
      }
      return { status: res.status, headers: res.headers, json };
    } catch (err) {
      if (err instanceof PinterestError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new PinterestError(
        'upstream_unavailable',
        aborted ? 'Pinterest did not answer in time. Try again in a moment.' : 'Could not reach Pinterest. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private mapFailure(res: { status: number; headers: { get(name: string): string | null }; json: unknown }, kind: 'oauth' | 'data'): PinterestError {
    const upstreamCode = int(asObject(res.json).code) ?? undefined;
    const extras = { upstreamStatus: res.status, upstreamCode };
    const s = res.status;
    if (s === 429) {
      const wait = parseRetryAfter(res.headers);
      return new PinterestError(
        'rate_limited',
        `Pinterest says there were too many requests${wait ? `. Try again in about ${humanWait(wait)}` : ', please try again later'}.`,
        { ...extras, retryAfterSeconds: wait },
      );
    }
    if (s >= 500) return new PinterestError('upstream_unavailable', 'Pinterest is having a problem right now. Try again later.', extras);
    if (kind === 'oauth') {
      if (s === 400 || s === 401 || s === 403) {
        return new PinterestError('oauth_rejected', 'Pinterest did not accept the authorization. The code may have expired or been used already, or the app settings do not match. Connect again.', extras);
      }
      return new PinterestError('upstream_error', 'Pinterest answered with an unexpected response while connecting.', extras);
    }
    if (s === 401) return new PinterestError('reconnect_required', 'Pinterest no longer accepts this connection. Reconnect your Pinterest account.', extras);
    if (s === 403) {
      return new PinterestError(
        'forbidden',
        'Pinterest refused this request. The LaunchPilot Pinterest app may not be approved for this access yet (Pinterest reviews apps before they can read real boards), or your account did not grant the board and Pin read permissions.',
        extras,
      );
    }
    if (s === 404) return new PinterestError('not_found', 'Pinterest could not find that board. It may have been deleted, made secret, or is not visible to this connection.', extras);
    if (s === 400) return new PinterestError('invalid_request', 'Pinterest rejected the request (for example an invalid page cursor).', extras);
    return new PinterestError('upstream_error', 'Pinterest answered with an unexpected response.', extras);
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
const clampPage = (n: number | undefined, dflt: number) => Math.min(Math.max(Math.round(n ?? dflt), 1), 50);
function checkBookmark(b: string): string {
  if (!isValidBookmark(b)) throw new PinterestError('invalid_request', 'That page cursor is not valid.');
  return b;
}
