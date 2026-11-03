import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import {
  PINTEREST_AUTHORIZE_URL,
  PINTEREST_DEFAULT_RETURN_PATH,
  PINTEREST_BOARD_PAGE_SIZE,
  PINTEREST_NOTICE,
  PINTEREST_PIN_PAGE_SIZE,
  PINTEREST_REFRESH_SKEW_MS,
  PINTEREST_SCOPES,
  PINTEREST_STATE_TTL_MS,
} from './pinterest.constants';
import { PinterestConfig, readPinterestConfig } from './pinterest.config';
import { PinterestClient, PinterestTokenSet, isValidBoardId, isValidBookmark } from './pinterest.client';
import { PinterestError } from './pinterest.errors';
import { PinterestRateGuard } from './pinterest.rate-guard';

export type PinterestUiStatus = 'not_configured' | 'not_connected' | 'connected' | 'expired' | 'revoked' | 'error';

export interface PinterestStatusView {
  configured: boolean;
  /** Names of settings that are missing/invalid (never values). Empty when configured. */
  configProblems: string[];
  connected: boolean;
  status: PinterestUiStatus;
  requiredScopes: string[];
  scopes: string[];
  connectedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  message: string;
  notice: string;
}

/** Callback outcomes surfaced to the browser as `?pinterest=error&reason=<one of these>`. */
export type PinterestCallbackReason =
  | 'denied'
  | 'invalid_state'
  | 'session_mismatch'
  | 'not_configured'
  | 'exchange_rejected'
  | 'scope_missing'
  | 'rate_limited'
  | 'unavailable'
  | 'server_error';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Accepts only an in-app path ("/projects/abc/campaign"); everything else (absolute URLs, "//host", backslashes) is dropped. */
export function sanitizeReturnPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  if (!/^\/[A-Za-z0-9\-._~/\[\]]{0,200}$/.test(p) || p.startsWith('//') || p.includes('..')) return null;
  return p;
}

@Injectable()
export class PinterestService {
  private readonly log = new Logger(PinterestService.name);
  /** One in-flight refresh per user: concurrent requests share it (refresh tokens must not be spent twice). */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly client: PinterestClient,
    private readonly guard: PinterestRateGuard,
  ) {}

  // ---- status ---------------------------------------------------------------------------------------------------------------------------

  async status(userId: string): Promise<PinterestStatusView> {
    const cfg = readPinterestConfig();
    const base = { requiredScopes: [...PINTEREST_SCOPES], notice: PINTEREST_NOTICE };
    if (!cfg.configured) {
      return {
        ...base,
        configured: false,
        configProblems: cfg.problems,
        connected: false,
        status: 'not_configured',
        scopes: [],
        connectedAt: null,
        accessExpiresAt: null,
        refreshExpiresAt: null,
        message: 'Pinterest is optional and is not set up on this server. LaunchPilot works fully without it.',
      };
    }
    const row = await this.prisma.pinterestConnection.findUnique({ where: { userId } });
    if (!row) {
      return { ...base, configured: true, configProblems: [], connected: false, status: 'not_connected', scopes: [], connectedAt: null, accessExpiresAt: null, refreshExpiresAt: null, message: 'Pinterest is not connected. Connect it to browse your own boards for inspiration.' };
    }
    const effective = this.effectiveStatus(row);
    const messages: Record<PinterestUiStatus, string> = {
      connected: 'Pinterest is connected.',
      expired: 'The Pinterest connection expired. Reconnect to browse your boards again.',
      revoked: 'Pinterest no longer accepts this connection (it may have been revoked). Reconnect to browse your boards again.',
      error: 'The Pinterest connection has a problem. Reconnect to fix it.',
      not_connected: 'Pinterest is not connected.',
      not_configured: '',
    };
    return {
      ...base,
      configured: true,
      configProblems: [],
      connected: effective === 'connected',
      status: effective,
      scopes: row.scopes.split(' ').filter(Boolean),
      connectedAt: row.connectedAt.toISOString(),
      accessExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
      refreshExpiresAt: row.refreshExpiresAt?.toISOString() ?? null,
      message: messages[effective],
    };
  }

  /** Derives the status from the stored row WITHOUT calling Pinterest. Lazy refresh happens on the next real use. */
  private effectiveStatus(row: { status: string; accessTokenEnc: string | null; accessExpiresAt: Date | null; refreshTokenEnc: string | null; refreshExpiresAt: Date | null }): PinterestUiStatus {
    if (row.status === 'revoked' || row.status === 'error' || row.status === 'expired') return row.status as PinterestUiStatus;
    if (!row.accessTokenEnc) return 'expired';
    const now = Date.now();
    const accessLive = !!row.accessExpiresAt && row.accessExpiresAt.getTime() > now;
    const refreshLive = !!row.refreshTokenEnc && (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() > now);
    return accessLive || refreshLive ? 'connected' : 'expired';
  }

  // ---- connect / callback / disconnect --------------------------------------------------------------------------------------------------

  async startConnect(userId: string, returnPath?: string): Promise<{ authorizationUrl: string; expiresInSeconds: number; scopes: string[] }> {
    const cfg = this.requireConfigured();
    const state = randomBytes(32).toString('base64url');
    const now = Date.now();
    // The latest attempt wins; expired rows of anyone are swept opportunistically.
    await this.prisma.pinterestOAuthState.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date(now - 60 * 60 * 1000) } }] } });
    await this.prisma.pinterestOAuthState.create({
      data: { userId, stateHash: sha256(state), returnPath: sanitizeReturnPath(returnPath), expiresAt: new Date(now + PINTEREST_STATE_TTL_MS) },
    });
    const url = new URL(PINTEREST_AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.appId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', PINTEREST_SCOPES.join(','));
    url.searchParams.set('state', state);
    return { authorizationUrl: url.toString(), expiresInSeconds: PINTEREST_STATE_TTL_MS / 1000, scopes: [...PINTEREST_SCOPES] };
  }

  /**
   * Handles the browser redirect from Pinterest. The single-use `state` row says which LaunchPilot user started the flow, and
   * `sessionUserId` (the user of the LaunchPilot session cookie the browser sent along; null when there is none) MUST be that
   * same user. Without this second check an attacker could start a flow, hand the authorization link to a victim, and get the
   * victim's Pinterest tokens attached to the attacker's account (account-linking CSRF).
   * Always resolves to a web URL to redirect to; it never throws and never reveals tokens, codes or upstream bodies.
   */
  async handleCallback(query: { code?: unknown; state?: unknown; error?: unknown }, sessionUserId: string | null): Promise<string> {
    const fail = (reason: PinterestCallbackReason, returnPath?: string | null) => this.webUrl(returnPath, 'error', reason);
    try {
      const rawState = typeof query.state === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(query.state) ? query.state : null;
      if (!rawState) return fail('invalid_state');
      const row = await this.prisma.pinterestOAuthState.findUnique({ where: { stateHash: sha256(rawState) } });
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return fail('invalid_state', row?.returnPath);

      // Single use under concurrency: only one request can flip usedAt from null.
      const claimed = await this.prisma.pinterestOAuthState.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) return fail('invalid_state', row.returnPath);
      // The state is burned either way; a mismatching browser never gets to exchange the code.
      if (!sessionUserId || sessionUserId !== row.userId) return fail('session_mismatch');

      if (typeof query.error === 'string' && query.error) return fail('denied', row.returnPath);
      const code = typeof query.code === 'string' && /^[\x21-\x7e]{1,2048}$/.test(query.code) ? query.code : null;
      if (!code) return fail('exchange_rejected', row.returnPath);
      if (!readPinterestConfig().configured) return fail('not_configured', row.returnPath);

      let tokens: PinterestTokenSet;
      try {
        tokens = await this.client.exchangeAuthorizationCode(code);
      } catch (err) {
        return fail(this.reasonFor(err), row.returnPath);
      }
      const granted = tokens.scopes.split(' ');
      if (!PINTEREST_SCOPES.every((s) => granted.includes(s))) return fail('scope_missing', row.returnPath);

      await this.saveTokens(row.userId, tokens, { connectedNow: true });
      return this.webUrl(row.returnPath, 'connected');
    } catch (err) {
      // Log only the error class: stack traces and messages could echo request data.
      this.log.warn(`Pinterest callback failed (${err instanceof Error ? err.name : 'unknown'})`);
      return fail('server_error');
    }
  }

  /**
   * Disconnects: deletes the stored tokens. Idempotent. Pinterest's token-revoke endpoint exists but, per its own description,
   * "Only tokens issued for system users are currently supported", so it is deliberately NOT called for user tokens. The user
   * can also remove the app's access inside their Pinterest account settings.
   */
  async disconnect(userId: string): Promise<{ ok: true; removed: boolean }> {
    const [conn] = await Promise.all([
      this.prisma.pinterestConnection.deleteMany({ where: { userId } }),
      this.prisma.pinterestOAuthState.deleteMany({ where: { userId } }),
    ]);
    this.refreshing.delete(userId);
    return { ok: true, removed: conn.count > 0 };
  }

  // ---- live, on-demand reads (nothing persisted) ----------------------------------------------------------------------------------------

  async listBoards(userId: string, bookmark?: string) {
    this.checkBookmark(bookmark);
    const page = await this.authed(userId, (token) => this.client.listBoards(token, { bookmark, pageSize: PINTEREST_BOARD_PAGE_SIZE }));
    return { items: page.items, bookmark: page.bookmark, source: 'pinterest' as const, fetchedAt: new Date().toISOString(), notice: PINTEREST_NOTICE };
  }

  async listBoardPins(userId: string, boardId: string, bookmark?: string) {
    if (!isValidBoardId(boardId)) throw new PinterestError('invalid_request', 'That is not a valid Pinterest board id.');
    this.checkBookmark(bookmark);
    const page = await this.authed(userId, (token) => this.client.listBoardPins(token, boardId, { bookmark, pageSize: PINTEREST_PIN_PAGE_SIZE }));
    return { boardId, items: page.items, bookmark: page.bookmark, source: 'pinterest' as const, fetchedAt: new Date().toISOString(), notice: PINTEREST_NOTICE };
  }

  // ---- token lifecycle ------------------------------------------------------------------------------------------------------------------

  private requireConfigured(): PinterestConfig {
    const cfg = readPinterestConfig();
    if (!cfg.configured) {
      throw new PinterestError('not_configured', 'Pinterest is not configured on this server. An administrator has to set the Pinterest app credentials first (see the README, "Pinterest (optional)").');
    }
    return cfg;
  }

  private checkBookmark(b: string | undefined) {
    if (b !== undefined && !isValidBookmark(b)) throw new PinterestError('invalid_request', 'That page cursor is not valid.');
  }

  /**
   * Runs `fn` with a valid access token for THIS user: refreshes first when it is (about to be) expired, and after a 401 refreshes
   * once and retries once. A connection that cannot be revived is marked expired/revoked and the user is asked to reconnect.
   */
  private async authed<T>(userId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    this.requireConfigured();
    const row = await this.prisma.pinterestConnection.findUnique({ where: { userId } });
    if (!row) throw new PinterestError('not_connected', 'Pinterest is not connected. Connect your Pinterest account first.');
    if (row.status !== 'connected' || !row.accessTokenEnc) {
      throw new PinterestError('reconnect_required', 'The Pinterest connection is no longer valid. Reconnect your Pinterest account.');
    }

    let token = this.decrypt(row.accessTokenEnc);
    const stale = !row.accessExpiresAt || row.accessExpiresAt.getTime() - PINTEREST_REFRESH_SKEW_MS <= Date.now();
    if (stale) token = await this.refresh(userId, null);

    this.guard.consume(userId);
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof PinterestError && err.code === 'rate_limited') this.guard.noteUpstreamLimit(err.retryAfterSeconds);
      if (!(err instanceof PinterestError) || err.code !== 'reconnect_required') throw err;
      // Pinterest rejected the access token: refresh once (single-flight) and retry once.
      const fresh = await this.refresh(userId, token);
      this.guard.consume(userId);
      try {
        return await fn(fresh);
      } catch (err2) {
        if (err2 instanceof PinterestError && err2.code === 'rate_limited') this.guard.noteUpstreamLimit(err2.retryAfterSeconds);
        if (err2 instanceof PinterestError && err2.code === 'reconnect_required') {
          await this.markDead(userId, 'revoked', 'Pinterest rejected the refreshed access token.');
        }
        throw err2;
      }
    }
  }

  /** Single-flight per user. Resolves to a usable (decrypted) access token. */
  private refresh(userId: string, rejectedToken: string | null): Promise<string> {
    const inflight = this.refreshing.get(userId);
    if (inflight) return inflight;
    const p = this.doRefresh(userId, rejectedToken).finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, p);
    return p;
  }

  private async doRefresh(userId: string, rejectedToken: string | null): Promise<string> {
    const row = await this.prisma.pinterestConnection.findUnique({ where: { userId } });
    if (!row || row.status !== 'connected') throw new PinterestError('reconnect_required', 'The Pinterest connection is no longer valid. Reconnect your Pinterest account.');

    // Another request may already have refreshed while we waited: reuse its token instead of spending the refresh token again.
    if (row.accessTokenEnc && row.accessExpiresAt && row.accessExpiresAt.getTime() - PINTEREST_REFRESH_SKEW_MS > Date.now()) {
      const current = this.decrypt(row.accessTokenEnc);
      if (current !== rejectedToken) return current;
    }

    const now = Date.now();
    if (!row.refreshTokenEnc || (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now)) {
      await this.markDead(userId, 'expired', 'The access token expired and no valid refresh token is available.');
      throw new PinterestError('reconnect_required', 'The Pinterest connection expired. Reconnect your Pinterest account.');
    }

    let tokens: PinterestTokenSet;
    try {
      tokens = await this.client.refreshAccessToken(this.decrypt(row.refreshTokenEnc));
    } catch (err) {
      if (err instanceof PinterestError && err.code === 'oauth_rejected') {
        await this.markDead(userId, 'revoked', 'Pinterest rejected the refresh token.');
        throw new PinterestError('reconnect_required', 'Pinterest no longer accepts this connection (it may have been revoked). Reconnect your Pinterest account.');
      }
      throw err; // 429 / 5xx / network: keep the connection, the caller sees the typed error
    }
    // Keep the old refresh token when Pinterest did not send a new one (and its expiry with it).
    await this.saveTokens(userId, { ...tokens, refreshToken: tokens.refreshToken ?? this.decrypt(row.refreshTokenEnc), refreshExpiresAt: tokens.refreshToken ? tokens.refreshExpiresAt : row.refreshExpiresAt, scopes: tokens.scopes || row.scopes }, { connectedNow: false });
    return tokens.accessToken;
  }

  private async saveTokens(userId: string, t: PinterestTokenSet, opts: { connectedNow: boolean }) {
    const data = {
      scopes: t.scopes,
      accessTokenEnc: this.crypto.encrypt(t.accessToken),
      refreshTokenEnc: t.refreshToken ? this.crypto.encrypt(t.refreshToken) : null,
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
      status: 'connected',
      lastError: null,
      ...(opts.connectedNow ? { connectedAt: new Date() } : {}),
    };
    await this.prisma.pinterestConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  /** Wipes the tokens of a connection that can no longer be used and records why (a safe, fixed sentence). */
  private async markDead(userId: string, status: 'expired' | 'revoked' | 'error', reason: string) {
    await this.prisma.pinterestConnection.updateMany({
      where: { userId },
      data: { status, lastError: reason, accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null },
    });
  }

  private decrypt(payload: string): string {
    try {
      return this.crypto.decrypt(payload);
    } catch {
      throw new PinterestError('reconnect_required', 'The stored Pinterest connection could not be read. Reconnect your Pinterest account.');
    }
  }

  private reasonFor(err: unknown): PinterestCallbackReason {
    if (err instanceof PinterestError) {
      if (err.code === 'oauth_rejected') return 'exchange_rejected';
      if (err.code === 'rate_limited') return 'rate_limited';
      if (err.code === 'upstream_unavailable') return 'unavailable';
      if (err.code === 'not_configured') return 'not_configured';
    }
    return 'server_error';
  }

  /** Builds the web redirect: WEB_ORIGIN + a validated in-app path + `?pinterest=...`. Never contains codes, state or tokens. */
  private webUrl(returnPath: string | null | undefined, outcome: 'connected' | 'error', reason?: PinterestCallbackReason): string {
    let origin = 'http://localhost:3000';
    try {
      const u = new URL(process.env.WEB_ORIGIN ?? origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
    } catch {
      /* keep the default */
    }
    const url = new URL(sanitizeReturnPath(returnPath) ?? PINTEREST_DEFAULT_RETURN_PATH, origin);
    url.searchParams.set('pinterest', outcome);
    if (reason) url.searchParams.set('reason', reason);
    return url.toString();
  }
}
