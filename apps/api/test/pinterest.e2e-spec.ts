import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { ActivityLogModule } from '../src/activity-log/activity-log.module';
import { configureApp } from '../src/app.setup';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaModule } from '../src/common/prisma.module';
import { UsersModule } from '../src/users/users.module';
import { PinterestModule } from '../src/pinterest/pinterest.module';
import { PINTEREST_FETCH, PinterestClient, PinterestFetch } from '../src/pinterest/pinterest.client';
import { readPinterestConfig } from '../src/pinterest/pinterest.config';
import { PinterestRateGuard } from '../src/pinterest/pinterest.rate-guard';
import { sanitizeReturnPath } from '../src/pinterest/pinterest.service';
import { normalizePinterestPinUrl } from '../src/pinterest/pinterest-url';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * The app under test is a MINIMAL Nest module (database, users + session auth, the real global JwtAuthGuard, and the Pinterest
 * module) built exactly like the production app (same middleware via configureApp). It does not import the Mozaik/OpenAI
 * modules, so this spec cannot be broken (or slowed) by unrelated modules; their absence also proves the integration has no
 * dependency on them. test/helpers.ts is deliberately not used because it imports the whole AppModule.
 */
async function createPinterestApp(fetchMock: PinterestFetch) {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, ActivityLogModule, AuthModule, UsersModule, PinterestModule],
    providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
  })
    .overrideProvider(PINTEREST_FETCH)
    .useValue(fetchMock)
    .compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

type Agent = ReturnType<typeof request.agent>;
interface TestUser {
  agent: Agent;
  id: string;
  email: string;
}
let userCounter = 0;
async function registerUser(app: INestApplication, label: string): Promise<TestUser> {
  const agent = request.agent(app.getHttpServer());
  const email = `${label}-${Date.now()}-${userCounter++}@test.launchpilot.dev`;
  const res = await agent.post('/auth/register').send({ name: 'Test User', email, password: 'password123' }).expect(201);
  return { agent, id: res.body.user.id, email };
}

/*
 * Optional Pinterest integration. EVERY Pinterest call here goes through a mocked fetch function injected via the PINTEREST_FETCH
 * provider: no request to Pinterest (or anyone else) is ever made, and there are no Pinterest credentials in this repository.
 * The real database (see global-setup.js) is used, like the other e2e specs.
 */

// ---- fixtures -----------------------------------------------------------------------------------------------------------------------------
const APP_ID = 'test-app-id-1234';
const APP_SECRET = 'APP-SECRET-zz91-NEVER-LOG-ME';
const REDIRECT = 'http://localhost:4000/integrations/pinterest/callback';
const WEB = 'http://localhost:3000';

const T1 = { access: 'pina_ACCESS_ONE_zz91_QWERTY', refresh: 'pinr_REFRESH_ONE_zz91_QWERTY' };
const T2 = { access: 'pina_ACCESS_TWO_zz91_ASDFGH', refresh: 'pinr_REFRESH_TWO_zz91_ASDFGH' };
const ALL_SECRETS = [T1.access, T1.refresh, T2.access, T2.refresh, APP_SECRET];

const tokenBody = (t: { access: string; refresh?: string | null }, extra: Record<string, unknown> = {}) => ({
  access_token: t.access,
  ...(t.refresh === null ? {} : { refresh_token: t.refresh }),
  token_type: 'bearer',
  expires_in: 2592000,
  refresh_token_expires_in: 5184000,
  scope: 'boards:read,pins:read',
  ...extra,
});

const BOARD_NAME = 'Zorblax Moodboard 7Q';
const PIN_TITLE = 'Terracotta Gradient Qvx';
const PIN_ID = '1234567890123';
const IMG_600 = 'https://i.pinimg.com/600x/aa/bb/cc-zq81.jpg';
const OWNER = 'pin_owner_qx81';
const BOARDS_BODY = {
  items: [
    {
      id: '549755885175',
      name: BOARD_NAME,
      description: 'warm tones',
      privacy: 'PUBLIC',
      pin_count: 42,
      owner: { username: OWNER },
      media: { image_cover_url: 'https://i.pinimg.com/236x/aa/bb/cover-zq81.jpg', pin_thumbnail_urls: [] },
      raw_extra_field: 'RAW-PASSTHROUGH-CHECK',
    },
    { id: 'not-numeric', name: 'dropped: bad id' },
  ],
  bookmark: 'Y3Vyc29yMQ==',
};
const PINS_BODY = {
  items: [
    {
      id: PIN_ID,
      title: PIN_TITLE,
      description: 'Soft light on clay',
      alt_text: 'clay vase',
      link: 'https://external-shop.example/buy-this',
      board_id: '549755885175',
      board_owner: { username: OWNER },
      media: {
        media_type: 'image',
        images: {
          '150x150': { url: 'https://i.pinimg.com/150x150/aa/bb/cc-zq81.jpg', width: 150, height: 150 },
          '600x': { url: IMG_600, width: 600, height: 800 },
        },
      },
    },
    { id: '2222222', media: { media_type: 'image', images: { '600x': { url: 'javascript:alert(1)', width: 1, height: 1 } } } },
    { id: '3333333', media: { media_type: 'video', cover_image_url: 'http://insecure.example/cover.jpg' } },
  ],
  bookmark: null,
};

// ---- mocked transport ---------------------------------------------------------------------------------------------------------------------
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  throwError?: Error;
}
type Route = (c: Call) => Reply | Promise<Reply>;

let calls: Call[] = [];
const allCalls: Call[] = [];
let unexpected: string[] = [];
const noRoute: Route = (c) => {
  unexpected.push(`${c.method} ${c.url}`);
  return { status: 500 };
};
let route: Route = noRoute;

const mockFetch: PinterestFetch = async (url, init) => {
  const call: Call = { url, method: init.method, headers: init.headers, body: init.body };
  calls.push(call);
  allCalls.push(call);
  const r = await route(call);
  if (r.delayMs) await sleep(r.delayMs);
  if (r.throwError) throw r.throwError;
  const hdr = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return { status: r.status, headers: { get: (n: string) => hdr[n.toLowerCase()] ?? null }, text: async () => text };
};

const isToken = (c: Call) => new URL(c.url).pathname === '/v5/oauth/token';
const isBoards = (c: Call) => new URL(c.url).pathname === '/v5/boards';
const isPins = (c: Call) => /^\/v5\/boards\/\d+\/pins$/.test(new URL(c.url).pathname);
const bearerOf = (c: Call) => (c.headers.Authorization?.startsWith('Bearer ') ? c.headers.Authorization.slice(7) : undefined);
const form = (c: Call) => new URLSearchParams(c.body ?? '');
const hitsOf = (pred: (c: Call) => boolean) => calls.filter(pred);

// ---- environment ----------------------------------------------------------------------------------------------------------------------------
const ENV_KEYS = ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'PINTEREST_REDIRECT_URI', 'PINTEREST_API_BASE', 'PINTEREST_ALLOW_TEST_BASE', 'PINTEREST_CONTINUOUS_REFRESH', 'WEB_ORIGIN'];
const savedEnv: Record<string, string | undefined> = {};
const configure = (over: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { PINTEREST_APP_ID: APP_ID, PINTEREST_APP_SECRET: APP_SECRET, PINTEREST_REDIRECT_URI: REDIRECT, WEB_ORIGIN: WEB, ...over };
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
};
const unconfigure = () => configure({ PINTEREST_APP_ID: undefined, PINTEREST_APP_SECRET: undefined, PINTEREST_REDIRECT_URI: undefined });

describe('Pinterest integration (optional, read-only, mocked HTTP only)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let crypto: CryptoService;
  let guard: PinterestRateGuard;
  const output: string[] = [];
  const spies: jest.SpyInstance[] = [];
  let globalFetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    configure();
    // Capture everything the process prints (call-through) so we can prove no token/secret is ever logged.
    const capture = (target: any, name: string, passThrough = true) => {
      const orig = target[name].bind(target);
      spies.push(jest.spyOn(target, name).mockImplementation((...args: any[]) => {
        output.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' '));
        return passThrough ? orig(...args) : undefined;
      }));
    };
    capture(process.stdout, 'write');
    capture(process.stderr, 'write');
    for (const m of ['log', 'warn', 'error', 'info', 'debug']) capture(console, m, false); // swallowed: keeps the probe silent
    // Nothing may use the global fetch (that is what any OpenAI/Pinterest call would use).
    globalFetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('global fetch must not be used by the Pinterest integration');
    });
    console.log('pinterest-capture-probe'); // proves the capture below sees console output
    app = await createPinterestApp(mockFetch);
    db = new PrismaClient();
    crypto = app.get(CryptoService);
    guard = app.get(PinterestRateGuard);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    spies.forEach((s) => s.mockRestore());
    globalFetchSpy.mockRestore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  beforeEach(() => {
    configure();
    calls = [];
    unexpected = [];
    route = noRoute;
    guard.reset();
    guard.userLimit = 30;
  });
  afterEach(() => {
    expect(unexpected).toEqual([]);
  });

  // ---- helpers ----------------------------------------------------------------------------------------------------------------------------
  let codeSeq = 0;
  async function startConnect(user: TestUser, body: Record<string, unknown> = {}) {
    const res = await user.agent.post('/integrations/pinterest/connect').send(body).expect(200);
    const url = new URL(res.body.authorizationUrl);
    return { res, url, state: url.searchParams.get('state')! };
  }
  /** Runs the whole authorize + callback flow with a mocked token endpoint. */
  async function connectUser(user: TestUser, tokens: { access: string; refresh?: string | null } = T1) {
    route = (c) => (isToken(c) ? { status: 200, body: tokenBody(tokens) } : { status: 500 });
    const { state } = await startConnect(user);
    const res = await user.agent.get(`/integrations/pinterest/callback?code=CODE-${++codeSeq}&state=${state}`).expect(302);
    expect(res.headers.location).toContain('pinterest=connected');
    calls = [];
    route = noRoute;
  }
  const rowOf = (userId: string) => db.pinterestConnection.findUnique({ where: { userId } });
  const expireAccess = (userId: string) => db.pinterestConnection.update({ where: { userId }, data: { accessExpiresAt: new Date(Date.now() - 60_000) } });

  async function tablesContaining(marker: string): Promise<string[]> {
    const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const hits: string[] = [];
    for (const t of tables) {
      const rows = await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${t.tablename}" r WHERE strpos(r::text, $1) > 0 LIMIT 1`, marker);
      if (rows.length) hits.push(t.tablename);
    }
    return hits;
  }

  // ---- 1. not configured ------------------------------------------------------------------------------------------------------------------
  describe('without credentials', () => {
    it('reports "not configured", refuses every action with a typed error and never contacts Pinterest or invents an account', async () => {
      unconfigure();
      const user = await registerUser(app, 'pin-unconf');

      const status = (await user.agent.get('/integrations/pinterest/status').expect(200)).body;
      expect(status).toMatchObject({ configured: false, connected: false, status: 'not_configured', scopes: [], connectedAt: null });
      expect(status.configProblems).toEqual(expect.arrayContaining(['PINTEREST_APP_ID is not set', 'PINTEREST_APP_SECRET is not set', 'PINTEREST_REDIRECT_URI is not set']));
      expect(status.message).toMatch(/optional/i);
      expect(status.notice).toMatch(/does not download, store, analyze or send it to AI/);

      for (const r of [
        await user.agent.post('/integrations/pinterest/connect').send({}),
        await user.agent.get('/integrations/pinterest/boards'),
        await user.agent.get('/integrations/pinterest/boards/123/pins'),
      ]) {
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'not_configured' });
        expect(r.body.message).toMatch(/not configured/i);
      }
      // Disconnect is idempotent and fine even when nothing exists.
      expect((await user.agent.delete('/integrations/pinterest').expect(200)).body).toEqual({ ok: true, removed: false });

      // The callback cannot create anything either.
      const cb = await request(app.getHttpServer()).get('/integrations/pinterest/callback?code=abc&state=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').expect(302);
      expect(cb.headers.location).toBe(`${WEB}/settings/integrations?pinterest=error&reason=invalid_state`);

      expect(await db.pinterestConnection.count({ where: { userId: user.id } })).toBe(0);
      expect(await db.pinterestOAuthState.count({ where: { userId: user.id } })).toBe(0);
      expect(calls).toEqual([]);
    });

    it('requires a LaunchPilot session for everything except the OAuth callback', async () => {
      const anon = request(app.getHttpServer());
      await anon.get('/integrations/pinterest/status').expect(401);
      await anon.post('/integrations/pinterest/connect').send({}).expect(401);
      await anon.get('/integrations/pinterest/boards').expect(401);
      await anon.get('/integrations/pinterest/boards/1/pins').expect(401);
      await anon.delete('/integrations/pinterest').expect(401);
      await anon.get('/integrations/pinterest/callback').expect(302); // public: answers with a redirect, never with data
    });

    it('config validation: partial or unsafe settings are "not configured"; non-official API hosts are refused', () => {
      const base = { PINTEREST_APP_ID: 'a', PINTEREST_APP_SECRET: 'b', PINTEREST_REDIRECT_URI: 'https://app.example.com/cb' } as NodeJS.ProcessEnv;
      expect(readPinterestConfig({ ...base })).toMatchObject({ configured: true, apiBase: 'https://api.pinterest.com', testBase: false });
      expect(readPinterestConfig({ ...base, PINTEREST_APP_SECRET: '' }).configured).toBe(false);
      expect(readPinterestConfig({ ...base, PINTEREST_REDIRECT_URI: 'http://app.example.com/cb' }).configured).toBe(false); // http only for localhost
      expect(readPinterestConfig({ ...base, PINTEREST_REDIRECT_URI: 'http://localhost:4000/cb' }).configured).toBe(true);
      expect(readPinterestConfig({ ...base, PINTEREST_API_BASE: 'https://api-sandbox.pinterest.com' })).toMatchObject({ configured: true, apiBase: 'https://api-sandbox.pinterest.com', testBase: false });
      // Not official: refused, even with the test flag when NODE_ENV is production.
      for (const evil of ['https://evil.example.com', 'https://api.pinterest.com.evil.com', 'http://api.pinterest.com', 'https://api.pinterest.com:8443', 'https://user@api.pinterest.com@evil.com']) {
        expect(readPinterestConfig({ ...base, PINTEREST_API_BASE: evil }).configured).toBe(false);
      }
      const local = { ...base, PINTEREST_API_BASE: 'http://127.0.0.1:5999' } as NodeJS.ProcessEnv;
      expect(readPinterestConfig({ ...local }).configured).toBe(false); // no flag
      expect(readPinterestConfig({ ...local, PINTEREST_ALLOW_TEST_BASE: '1' })).toMatchObject({ configured: true, testBase: true, apiBase: 'http://127.0.0.1:5999' });
      expect(readPinterestConfig({ ...local, PINTEREST_ALLOW_TEST_BASE: '1', NODE_ENV: 'production' }).configured).toBe(false); // never in production
    });

    it('an unofficial PINTEREST_API_BASE makes the whole integration "not configured" (no fallback, no call)', async () => {
      configure({ PINTEREST_API_BASE: 'https://evil.example.com' });
      const user = await registerUser(app, 'pin-evilbase');
      const status = (await user.agent.get('/integrations/pinterest/status').expect(200)).body;
      expect(status.configured).toBe(false);
      expect(status.configProblems.join(' ')).toMatch(/PINTEREST_API_BASE/);
      await user.agent.get('/integrations/pinterest/boards').expect(409);
      expect(calls).toEqual([]);
    });
  });

  // ---- 2. authorization URL ---------------------------------------------------------------------------------------------------------------
  describe('authorization URL', () => {
    it('uses exactly the minimal read-only scopes, a random single-use state, and no write/secret scope', async () => {
      const user = await registerUser(app, 'pin-authurl');
      const { res, url, state } = await startConnect(user);
      expect(url.origin + url.pathname).toBe('https://www.pinterest.com/oauth/');
      expect(url.searchParams.get('client_id')).toBe(APP_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('response_type')).toBe('code');
      const scopes = (url.searchParams.get('scope') ?? '').split(/[\s,]+/).sort();
      expect(scopes).toEqual(['boards:read', 'pins:read']);
      expect(scopes.join(' ')).not.toMatch(/write|secret|user_accounts|ads|billing|catalogs/);
      expect(res.body.scopes.sort()).toEqual(['boards:read', 'pins:read']);
      expect(url.searchParams.has('code_challenge')).toBe(false); // Pinterest's docs do not describe PKCE
      expect(state.length).toBeGreaterThanOrEqual(40);
      expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
      expect(res.body.expiresInSeconds).toBe(600);

      // Only a hash of the state is stored, with a ~10 minute expiry.
      const rows = await db.pinterestOAuthState.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].stateHash).not.toBe(state);
      expect(JSON.stringify(rows)).not.toContain(state);
      const ttl = rows[0].expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(8 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);
      expect(rows[0].usedAt).toBeNull();

      // A new attempt replaces the previous one.
      const second = await startConnect(user);
      expect(second.state).not.toBe(state);
      expect(await db.pinterestOAuthState.count({ where: { userId: user.id } })).toBe(1);
      expect(calls).toEqual([]);
    });

    it('only accepts an in-app return path (no open redirect)', async () => {
      expect(sanitizeReturnPath('/projects/abc123/campaign')).toBe('/projects/abc123/campaign');
      for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/a/../b', '/a?x=1', '/a#x', 'javascript:alert(1)', '', 5, null, undefined, '/' + 'a'.repeat(300)]) {
        expect(sanitizeReturnPath(bad as any)).toBeNull();
      }
      const user = await registerUser(app, 'pin-return');
      const { state } = await startConnect(user, { returnPath: '//evil.com/x' });
      const row = await db.pinterestOAuthState.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.returnPath).toBeNull();
      expect(state).toBeTruthy();
    });
  });

  // ---- 3. callback security ---------------------------------------------------------------------------------------------------------------
  describe('OAuth callback', () => {
    it('rejects unknown, malformed, expired, reused and other-browser states, and stores no tokens in any of those cases', async () => {
      const a = await registerUser(app, 'pin-cb-a');
      const b = await registerUser(app, 'pin-cb-b');
      const anon = request(app.getHttpServer());
      const loc = (r: request.Response) => r.headers.location as string;
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T1) } : { status: 500 });

      // unknown / malformed
      const forged = 'A'.repeat(43);
      expect(loc(await a.agent.get(`/integrations/pinterest/callback?code=x&state=${forged}`).expect(302))).toContain('reason=invalid_state');
      expect(loc(await a.agent.get('/integrations/pinterest/callback?code=x').expect(302))).toContain('reason=invalid_state');
      expect(loc(await a.agent.get('/integrations/pinterest/callback?code=x&state=%3Cscript%3E').expect(302))).toContain('reason=invalid_state');

      // expired
      const expired = await startConnect(a);
      await db.pinterestOAuthState.updateMany({ where: { userId: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(loc(await a.agent.get(`/integrations/pinterest/callback?code=x&state=${expired.state}`).expect(302))).toContain('reason=invalid_state');

      // another user's browser (and a browser with no session at all) presenting A's state: refused, the state is burned
      const stolen = await startConnect(a);
      expect(loc(await b.agent.get(`/integrations/pinterest/callback?code=x&state=${stolen.state}`).expect(302))).toContain('reason=session_mismatch');
      expect(loc(await a.agent.get(`/integrations/pinterest/callback?code=x&state=${stolen.state}`).expect(302))).toContain('reason=invalid_state'); // burned
      const noSession = await startConnect(a);
      expect(loc(await anon.get(`/integrations/pinterest/callback?code=x&state=${noSession.state}`).expect(302))).toContain('reason=session_mismatch');

      expect(await db.pinterestConnection.count({ where: { userId: { in: [a.id, b.id] } } })).toBe(0);
      expect(calls).toEqual([]); // the code was never exchanged
    });

    it('a state is single-use: the replayed callback is rejected and the code is exchanged exactly once', async () => {
      const user = await registerUser(app, 'pin-cb-reuse');
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T1) } : { status: 500 });
      const { state } = await startConnect(user, { returnPath: '/projects/p1/campaign' });
      const first = await user.agent.get(`/integrations/pinterest/callback?code=CODE-A&state=${state}`).expect(302);
      expect(first.headers.location).toBe(`${WEB}/projects/p1/campaign?pinterest=connected`);
      const replay = await user.agent.get(`/integrations/pinterest/callback?code=CODE-A&state=${state}`).expect(302);
      expect(replay.headers.location).toContain('reason=invalid_state');
      expect(hitsOf(isToken)).toHaveLength(1);
      // The redirect never carries the code, the state or a token.
      expect(first.headers.location).not.toMatch(/CODE-A|pina_|pinr_/);
      expect(first.headers.location).not.toContain(state);
      expect(first.headers['cache-control']).toBe('no-store');
    });

    it('concurrent replays of one state exchange the code once', async () => {
      const user = await registerUser(app, 'pin-cb-race');
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T1), delayMs: 60 } : { status: 500 });
      const { state } = await startConnect(user);
      const results = await Promise.all(Array.from({ length: 4 }, () => user.agent.get(`/integrations/pinterest/callback?code=RACE&state=${state}`)));
      const connected = results.filter((r) => String(r.headers.location).includes('pinterest=connected'));
      expect(connected).toHaveLength(1);
      expect(hitsOf(isToken)).toHaveLength(1);
    });

    it('user denial, rejected codes, missing scopes, rate limits and outages end in a clear error redirect and store nothing', async () => {
      const user = await registerUser(app, 'pin-cb-errors');
      const run = async (reply: Reply | null, query = 'code=CODE') => {
        route = (c) => (isToken(c) ? (reply ?? { status: 500 }) : { status: 500 });
        const { state } = await startConnect(user);
        const r = await user.agent.get(`/integrations/pinterest/callback?${query}&state=${state}`).expect(302);
        expect(await db.pinterestConnection.count({ where: { userId: user.id } })).toBe(0);
        return r.headers.location as string;
      };
      expect(await run(null, 'error=access_denied')).toContain('reason=denied');
      expect(hitsOf(isToken)).toHaveLength(0);
      expect(await run({ status: 400, body: { code: 2, message: 'UPSTREAM-TEXT' } })).toContain('reason=exchange_rejected');
      expect(await run({ status: 401, body: {} })).toContain('reason=exchange_rejected');
      expect(await run({ status: 429, headers: { 'Retry-After': '30' } })).toContain('reason=rate_limited');
      expect(await run({ status: 503 })).toContain('reason=unavailable');
      expect(await run({ status: 200, body: tokenBody(T1, { scope: 'boards:read' }) })).toContain('reason=scope_missing');
      expect(await run({ status: 200, body: { nonsense: true } })).toContain('reason=server_error');
      expect(await run({ status: 200, body: tokenBody(T1) }, 'x=1')).toContain('reason=exchange_rejected'); // no code at all
    });

    it('exchanges with HTTP Basic auth, a form body and no other URL than the fixed token path', async () => {
      const user = await registerUser(app, 'pin-cb-exchange');
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T1) } : { status: 500 });
      const { state } = await startConnect(user);
      await user.agent.get(`/integrations/pinterest/callback?code=CODE-X&state=${state}`).expect(302);
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c.method).toBe('POST');
      expect(c.url).toBe('https://api.pinterest.com/v5/oauth/token');
      expect(c.headers.Authorization).toBe(`Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`);
      expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(form(c))).toEqual({ grant_type: 'authorization_code', code: 'CODE-X', redirect_uri: REDIRECT });
    });

    it('sends continuous_refresh=true only when the admin enables it (apps created before 2025-09-25)', async () => {
      configure({ PINTEREST_CONTINUOUS_REFRESH: '1' });
      const user = await registerUser(app, 'pin-cb-continuous');
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T1) } : { status: 500 });
      const { state } = await startConnect(user);
      await user.agent.get(`/integrations/pinterest/callback?code=C&state=${state}`).expect(302);
      expect(form(calls[0]).get('continuous_refresh')).toBe('true');
    });
  });

  // ---- 4. tokens at rest ------------------------------------------------------------------------------------------------------------------
  describe('stored tokens', () => {
    it('are encrypted at rest (AES-256-GCM), round-trip, and are never returned by any endpoint', async () => {
      const user = await registerUser(app, 'pin-enc');
      await connectUser(user);

      const row = (await rowOf(user.id))!;
      expect(row.status).toBe('connected');
      expect(row.scopes.split(' ').sort()).toEqual(['boards:read', 'pins:read']);
      expect(row.accessTokenEnc).toBeTruthy();
      expect(row.accessTokenEnc!.split('.')).toHaveLength(3); // iv.tag.ciphertext
      for (const s of ALL_SECRETS) expect(JSON.stringify(row)).not.toContain(s);
      expect(crypto.decrypt(row.accessTokenEnc!)).toBe(T1.access);
      expect(crypto.decrypt(row.refreshTokenEnc!)).toBe(T1.refresh);
      expect(row.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
      expect(row.refreshExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 24 * 3600_000);

      // Raw database scan: the plaintext secrets are in no column of any table.
      for (const s of [T1.access, T1.refresh, APP_SECRET]) expect(await tablesContaining(s)).toEqual([]);

      // Nothing the API returns carries a token, ciphertext or secret.
      const status = await user.agent.get('/integrations/pinterest/status').expect(200);
      expect(status.body).toMatchObject({ configured: true, connected: true, status: 'connected' });
      route = (c) => (isBoards(c) ? { status: 200, body: BOARDS_BODY } : { status: 500 });
      const boards = await user.agent.get('/integrations/pinterest/boards').expect(200);
      const everything = JSON.stringify([status.body, boards.body, boards.headers]);
      for (const s of ALL_SECRETS) expect(everything).not.toContain(s);
      expect(everything).not.toContain(row.accessTokenEnc!);
      expect(everything).not.toMatch(/accessTokenEnc|refreshTokenEnc/);
    });

    it('the only Pinterest data kept is the connection row: no username or profile data is stored', async () => {
      const user = await registerUser(app, 'pin-minimal');
      await connectUser(user);
      expect(Object.keys((await rowOf(user.id))!).sort()).toEqual(
        ['accessExpiresAt', 'accessTokenEnc', 'connectedAt', 'id', 'lastError', 'refreshExpiresAt', 'refreshTokenEnc', 'scopes', 'status', 'updatedAt', 'userId'],
      );
    });
  });

  // ---- 5. reading boards and pins (live, never persisted) --------------------------------------------------------------------------------
  describe('boards and pins', () => {
    it('are fetched live with the user token, shown with attribution, mapped (no raw passthrough) and never persisted', async () => {
      const user = await registerUser(app, 'pin-read');
      await connectUser(user);

      route = (c) => (isBoards(c) ? { status: 200, body: BOARDS_BODY, headers: { 'x-ratelimit-remaining': '98' } } : isPins(c) ? { status: 200, body: PINS_BODY } : { status: 500 });
      const boards = await user.agent.get('/integrations/pinterest/boards').expect(200);
      expect(boards.headers['cache-control']).toBe('no-store');
      expect(boards.body.source).toBe('pinterest');
      expect(boards.body.notice).toMatch(/inspiration only/);
      expect(boards.body.bookmark).toBe('Y3Vyc29yMQ==');
      expect(boards.body.items).toEqual([
        {
          id: '549755885175',
          name: BOARD_NAME,
          description: 'warm tones',
          privacy: 'PUBLIC',
          pinCount: 42,
          ownerUsername: OWNER,
          ownerProfileUrl: `https://www.pinterest.com/${OWNER}/`,
          coverImageUrl: 'https://i.pinimg.com/236x/aa/bb/cover-zq81.jpg',
        },
      ]); // the row with a non-numeric id was dropped
      expect(JSON.stringify(boards.body)).not.toContain('RAW-PASSTHROUGH-CHECK');

      const first = calls[0];
      expect(first.method).toBe('GET');
      expect(new URL(first.url).origin + new URL(first.url).pathname).toBe('https://api.pinterest.com/v5/boards');
      expect(new URL(first.url).searchParams.get('page_size')).toBe('50');
      expect(bearerOf(first)).toBe(T1.access);

      // Next page: the bookmark is forwarded, URL-encoded.
      await user.agent.get(`/integrations/pinterest/boards?bookmark=${encodeURIComponent(BOARDS_BODY.bookmark)}`).expect(200);
      expect(new URL(calls[1].url).searchParams.get('bookmark')).toBe('Y3Vyc29yMQ==');

      const pins = await user.agent.get('/integrations/pinterest/boards/549755885175/pins').expect(200);
      expect(pins.headers['cache-control']).toBe('no-store');
      expect(new URL(calls[2].url).pathname).toBe('/v5/boards/549755885175/pins');
      expect(new URL(calls[2].url).searchParams.get('page_size')).toBe('24');
      expect(pins.body.boardId).toBe('549755885175');
      expect(pins.body.bookmark).toBeNull();
      expect(pins.body.items[0]).toEqual({
        id: PIN_ID,
        title: PIN_TITLE,
        description: 'Soft light on clay',
        altText: 'clay vase',
        mediaType: 'image',
        imageUrl: IMG_600,
        imageWidth: 600,
        imageHeight: 800,
        pinUrl: `https://www.pinterest.com/pin/${PIN_ID}/`,
        boardId: '549755885175',
        boardOwnerUsername: OWNER,
        boardOwnerProfileUrl: `https://www.pinterest.com/${OWNER}/`,
      });
      // Unsafe or insecure image URLs never reach the browser; the destination link of the Pin is not relayed.
      expect(pins.body.items[1].imageUrl).toBeNull();
      expect(pins.body.items[2]).toMatchObject({ mediaType: 'video', imageUrl: null });
      expect(JSON.stringify(pins.body)).not.toMatch(/external-shop|javascript:|insecure\.example/);

      // Nothing from Pinterest is persisted anywhere: no table contains a board name, Pin id/title, image URL or username.
      for (const marker of [BOARD_NAME, PIN_TITLE, PIN_ID, 'cc-zq81', OWNER, '549755885175']) expect(await tablesContaining(marker)).toEqual([]);
      expect(await db.pinterestConnection.count({ where: { userId: user.id } })).toBe(1);
      // No image was ever requested by the server.
      expect(calls.every((c) => !/pinimg|\.jpg/.test(c.url))).toBe(true);
    });

    it('validates the board id and bookmark before anything is sent to Pinterest', async () => {
      const user = await registerUser(app, 'pin-validate');
      await connectUser(user);
      for (const bad of ['abc', '12ab', '1'.repeat(40), '%2e%2e', '12%2F34', '1.5']) {
        const r = await user.agent.get(`/integrations/pinterest/boards/${bad}/pins`);
        expect([400, 404]).toContain(r.status);
      }
      await user.agent.get('/integrations/pinterest/boards?bookmark=has%20space').expect(400);
      await user.agent.get(`/integrations/pinterest/boards?bookmark=${'x'.repeat(2000)}`).expect(400);
      expect(calls).toEqual([]);

      // And the client itself refuses anything but a numeric board id (defence in depth).
      const client = app.get(PinterestClient);
      await expect(client.listBoardPins('tok', '12/../../oauth/token')).rejects.toMatchObject({ code: 'invalid_request' });
      expect(calls).toEqual([]);
    });
  });

  // ---- 6. tenant isolation ----------------------------------------------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it("user B cannot see, use or disconnect user A's connection", async () => {
      const a = await registerUser(app, 'pin-iso-a');
      const b = await registerUser(app, 'pin-iso-b');
      await connectUser(a);

      expect((await b.agent.get('/integrations/pinterest/status').expect(200)).body).toMatchObject({ connected: false, status: 'not_connected', scopes: [] });
      const r1 = await b.agent.get('/integrations/pinterest/boards');
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe('not_connected');
      expect((await b.agent.get('/integrations/pinterest/boards/549755885175/pins')).body.code).toBe('not_connected');
      expect(calls).toEqual([]); // B never caused a Pinterest request with A's token

      expect((await b.agent.delete('/integrations/pinterest').expect(200)).body).toEqual({ ok: true, removed: false });
      expect(await db.pinterestConnection.count({ where: { userId: a.id } })).toBe(1);
      expect((await a.agent.get('/integrations/pinterest/status').expect(200)).body.connected).toBe(true);

      // A's requests carry A's token; B connecting later gets B's own token. They never cross.
      await connectUser(b, T2);
      route = (c) => (isBoards(c) ? { status: 200, body: BOARDS_BODY } : { status: 500 });
      await a.agent.get('/integrations/pinterest/boards').expect(200);
      await b.agent.get('/integrations/pinterest/boards').expect(200);
      expect(calls.map(bearerOf)).toEqual([T1.access, T2.access]);
      expect(crypto.decrypt((await rowOf(a.id))!.accessTokenEnc!)).toBe(T1.access);
      expect(crypto.decrypt((await rowOf(b.id))!.accessTokenEnc!)).toBe(T2.access);
    });
  });

  // ---- 7. disconnect ----------------------------------------------------------------------------------------------------------------------
  describe('disconnect', () => {
    it('deletes the stored tokens, is idempotent, and does not call Pinterest', async () => {
      const user = await registerUser(app, 'pin-disc');
      await connectUser(user);
      expect(await rowOf(user.id)).not.toBeNull();

      expect((await user.agent.delete('/integrations/pinterest').expect(200)).body).toEqual({ ok: true, removed: true });
      expect(await rowOf(user.id)).toBeNull();
      expect(await db.pinterestOAuthState.count({ where: { userId: user.id } })).toBe(0);
      expect(await tablesContaining(T1.access)).toEqual([]);
      expect((await user.agent.delete('/integrations/pinterest').expect(200)).body).toEqual({ ok: true, removed: false });
      expect((await user.agent.get('/integrations/pinterest/status').expect(200)).body.status).toBe('not_connected');
      expect((await user.agent.get('/integrations/pinterest/boards')).body.code).toBe('not_connected');
      expect(calls).toEqual([]); // Pinterest's revoke endpoint only supports system-user tokens, so it is intentionally not called
    });
  });

  // ---- 8. refresh -------------------------------------------------------------------------------------------------------------------------
  describe('token refresh', () => {
    it('refreshes transparently once (single-flight) when the access token has expired, then uses the new token', async () => {
      const user = await registerUser(app, 'pin-refresh');
      await connectUser(user);
      await expireAccess(user.id);
      route = (c) =>
        isToken(c)
          ? { status: 200, body: tokenBody(T2), delayMs: 80 }
          : isBoards(c)
            ? bearerOf(c) === T2.access ? { status: 200, body: BOARDS_BODY } : { status: 401 }
            : { status: 500 };

      const results = await Promise.all(Array.from({ length: 5 }, () => user.agent.get('/integrations/pinterest/boards')));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const refreshes = hitsOf(isToken);
      expect(refreshes).toHaveLength(1);
      expect(Object.fromEntries(form(refreshes[0]))).toEqual({ grant_type: 'refresh_token', refresh_token: T1.refresh });
      expect(refreshes[0].headers.Authorization).toMatch(/^Basic /);
      expect(hitsOf(isBoards).every((c) => bearerOf(c) === T2.access)).toBe(true);

      const row = (await rowOf(user.id))!;
      expect(crypto.decrypt(row.accessTokenEnc!)).toBe(T2.access);
      expect(crypto.decrypt(row.refreshTokenEnc!)).toBe(T2.refresh);
      expect(row.status).toBe('connected');
      expect(await tablesContaining(T2.access)).toEqual([]);
    });

    it('keeps the old refresh token when Pinterest does not send a new one', async () => {
      const user = await registerUser(app, 'pin-refresh-keep');
      await connectUser(user);
      await expireAccess(user.id);
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody({ access: T2.access, refresh: null }) } : isBoards(c) ? { status: 200, body: BOARDS_BODY } : { status: 500 });
      await user.agent.get('/integrations/pinterest/boards').expect(200);
      const row = (await rowOf(user.id))!;
      expect(crypto.decrypt(row.accessTokenEnc!)).toBe(T2.access);
      expect(crypto.decrypt(row.refreshTokenEnc!)).toBe(T1.refresh);
    });

    it('after a 401 on a data call it refreshes once and retries once', async () => {
      const user = await registerUser(app, 'pin-401-retry');
      await connectUser(user);
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T2) } : isBoards(c) ? (bearerOf(c) === T2.access ? { status: 200, body: BOARDS_BODY } : { status: 401, body: { code: 2, message: 'Authentication failed.' } }) : { status: 500 });
      await user.agent.get('/integrations/pinterest/boards').expect(200);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v5/boards', '/v5/oauth/token', '/v5/boards']);
      expect(calls.map(bearerOf)).toEqual([T1.access, undefined, T2.access]);
    });

    it('a token Pinterest keeps rejecting marks the connection revoked, wipes the tokens and asks for a reconnect (never a 401)', async () => {
      const user = await registerUser(app, 'pin-revoked');
      await connectUser(user);
      route = (c) => (isToken(c) ? { status: 200, body: tokenBody(T2) } : { status: 401 });
      const r = await user.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(409); // NOT 401: the web app signs the user out on 401
      expect(r.body.code).toBe('reconnect_required');
      expect(r.body.message).toMatch(/reconnect/i);
      const row = (await rowOf(user.id))!;
      expect(row).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null });
      expect(row.lastError).toBeTruthy();
      const status = (await user.agent.get('/integrations/pinterest/status').expect(200)).body;
      expect(status).toMatchObject({ connected: false, status: 'revoked' });
      expect(status.message).toMatch(/reconnect/i);

      calls = [];
      const again = await user.agent.get('/integrations/pinterest/boards');
      expect(again.body.code).toBe('reconnect_required');
      expect(calls).toEqual([]);

      // Reconnecting restores the connection.
      await connectUser(user, T2);
      expect((await user.agent.get('/integrations/pinterest/status').expect(200)).body).toMatchObject({ connected: true, status: 'connected' });
    });

    it('a refresh token Pinterest rejects (400/401) wipes the connection; an expired refresh token needs no call to find out', async () => {
      const u1 = await registerUser(app, 'pin-refresh-rejected');
      await connectUser(u1);
      await expireAccess(u1.id);
      route = (c) => (isToken(c) ? { status: 400, body: { code: 3, message: 'invalid_grant UPSTREAM' } } : { status: 500 });
      const r = await u1.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('reconnect_required');
      expect(JSON.stringify(r.body)).not.toContain('UPSTREAM');
      expect((await rowOf(u1.id))!).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });

      const u2 = await registerUser(app, 'pin-refresh-expired');
      await connectUser(u2);
      await db.pinterestConnection.update({ where: { userId: u2.id }, data: { accessExpiresAt: new Date(Date.now() - 1000), refreshExpiresAt: new Date(Date.now() - 1000) } });
      calls = [];
      expect((await u2.agent.get('/integrations/pinterest/status').expect(200)).body).toMatchObject({ connected: false, status: 'expired' });
      const r2 = await u2.agent.get('/integrations/pinterest/boards');
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe('reconnect_required');
      expect((await rowOf(u2.id))!).toMatchObject({ status: 'expired', accessTokenEnc: null, refreshTokenEnc: null });
      expect(calls).toEqual([]);
    });

    it('a temporary refresh failure (5xx, 429) keeps the connection and its tokens', async () => {
      const user = await registerUser(app, 'pin-refresh-5xx');
      await connectUser(user);
      await expireAccess(user.id);
      route = (c) => (isToken(c) ? { status: 503 } : { status: 500 });
      const r = await user.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('upstream_unavailable');
      const row = (await rowOf(user.id))!;
      expect(row.status).toBe('connected');
      expect(crypto.decrypt(row.refreshTokenEnc!)).toBe(T1.refresh);
    });
  });

  // ---- 9. error mapping -------------------------------------------------------------------------------------------------------------------
  describe('error mapping', () => {
    it.each([
      [403, 403, 'forbidden'],
      [404, 404, 'not_found'],
      [400, 400, 'invalid_request'],
      [500, 502, 'upstream_unavailable'],
      [503, 502, 'upstream_unavailable'],
      [418, 502, 'upstream_error'],
    ])('Pinterest %i becomes %i %s with a message we wrote (never the upstream text)', async (upstream, status, code) => {
      const user = await registerUser(app, `pin-map-${upstream}`);
      await connectUser(user);
      route = () => ({ status: upstream, body: { code: 7, message: 'UPSTREAM-MESSAGE-LEAK' } });
      const r = await user.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ code, upstreamStatus: upstream, upstreamCode: 7 });
      expect(typeof r.body.message).toBe('string');
      expect(JSON.stringify(r.body)).not.toContain('UPSTREAM-MESSAGE-LEAK');
      expect((await rowOf(user.id))!.status).toBe('connected'); // these do not destroy the connection
    });

    it('403 tells the user the app may not be approved yet; 404 explains the board is not visible', async () => {
      const user = await registerUser(app, 'pin-map-text');
      await connectUser(user);
      route = () => ({ status: 403 });
      expect((await user.agent.get('/integrations/pinterest/boards')).body.message).toMatch(/not be approved|approved/i);
      route = () => ({ status: 404 });
      expect((await user.agent.get('/integrations/pinterest/boards/123456/pins')).body.message).toMatch(/board/i);
    });

    it('429 surfaces Retry-After and then blocks further calls until it passes (we do not hammer Pinterest)', async () => {
      const a = await registerUser(app, 'pin-429-a');
      const b = await registerUser(app, 'pin-429-b');
      await connectUser(a);
      await connectUser(b, T2);
      route = () => ({ status: 429, headers: { 'Retry-After': '120' }, body: { code: 8, message: 'rate' } });
      const r = await a.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('120');
      expect(r.body).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120 });
      expect(r.body.message).toMatch(/2 minutes/);
      expect(calls).toHaveLength(1);

      // The limit is per app on Pinterest's side, so every user is held back, without any new request.
      const again = await a.agent.get('/integrations/pinterest/boards');
      expect(again.status).toBe(429);
      expect(again.body.retryAfterSeconds).toBeGreaterThan(100);
      expect((await b.agent.get('/integrations/pinterest/boards/123456/pins')).status).toBe(429);
      expect(calls).toHaveLength(1);

      guard.reset(); // time passing
      route = (c) => (isBoards(c) ? { status: 200, body: BOARDS_BODY } : { status: 500 });
      await a.agent.get('/integrations/pinterest/boards').expect(200);
    });

    it('429 without Retry-After still backs off (default 60 s)', async () => {
      const user = await registerUser(app, 'pin-429-default');
      await connectUser(user);
      route = () => ({ status: 429 });
      const r = await user.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('rate_limited');
      const next = await user.agent.get('/integrations/pinterest/boards');
      expect(next.status).toBe(429);
      expect(calls).toHaveLength(1);
    });

    it('network failures and timeouts are reported as upstream_unavailable', async () => {
      const user = await registerUser(app, 'pin-net');
      await connectUser(user);
      route = () => ({ status: 0, throwError: new TypeError('fetch failed') });
      const r = await user.agent.get('/integrations/pinterest/boards');
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('upstream_unavailable');
      expect(r.body.message).toMatch(/could not reach/i);
      route = () => ({ status: 0, throwError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
      const t = await user.agent.get('/integrations/pinterest/boards');
      expect(t.body.code).toBe('upstream_unavailable');
      expect(t.body.message).toMatch(/in time/i);
      // Non-JSON / empty bodies on success do not crash anything.
      route = () => ({ status: 200, body: '<html>not json</html>' });
      const odd = await user.agent.get('/integrations/pinterest/boards').expect(200);
      expect(odd.body.items).toEqual([]);
    });

    it('our own per-user limiter stops a runaway client before Pinterest is contacted', async () => {
      const user = await registerUser(app, 'pin-ownlimit');
      await connectUser(user);
      guard.userLimit = 3;
      route = (c) => (isBoards(c) ? { status: 200, body: BOARDS_BODY } : { status: 500 });
      for (let i = 0; i < 3; i++) await user.agent.get('/integrations/pinterest/boards').expect(200);
      const blocked = await user.agent.get('/integrations/pinterest/boards');
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toMatch(/limiting requests to Pinterest/);
      expect(blocked.headers['retry-after']).toBeTruthy();
      expect(calls).toHaveLength(3);
    });
  });

  // ---- 10. hosts and paths ----------------------------------------------------------------------------------------------------------------
  describe('outbound requests', () => {
    it('the sandbox host is honored when configured explicitly', async () => {
      configure({ PINTEREST_API_BASE: 'https://api-sandbox.pinterest.com' });
      const user = await registerUser(app, 'pin-sandbox');
      await connectUser(user);
      route = (c) => (isBoards(c) ? { status: 200, body: { items: [], bookmark: null } } : { status: 500 });
      await user.agent.get('/integrations/pinterest/boards').expect(200);
      expect(new URL(calls[0].url).origin).toBe('https://api-sandbox.pinterest.com');
    });

    it('a local mock host works only with the explicit test flag', async () => {
      configure({ PINTEREST_API_BASE: 'http://127.0.0.1:5999', PINTEREST_ALLOW_TEST_BASE: '1' });
      const user = await registerUser(app, 'pin-testbase');
      await connectUser(user);
      route = (c) => (isBoards(c) ? { status: 200, body: { items: [], bookmark: null } } : { status: 500 });
      await user.agent.get('/integrations/pinterest/boards').expect(200);
      expect(calls[0].url.startsWith('http://127.0.0.1:5999/v5/boards')).toBe(true);
    });

    it('the pasted-link helper only normalizes a pinterest.com Pin address and never fetches anything', () => {
      const ok = (s: string) => normalizePinterestPinUrl(s);
      expect(ok('https://www.pinterest.com/pin/1234567890123/')).toEqual({ ok: true, pinId: '1234567890123', url: 'https://www.pinterest.com/pin/1234567890123/' });
      expect(ok('pinterest.com/pin/1234567890123?utm_source=x#frag')).toMatchObject({ ok: true, url: 'https://www.pinterest.com/pin/1234567890123/' });
      expect(ok('http://nl.pinterest.com/pin/9876543210/')).toMatchObject({ ok: true, url: 'https://www.pinterest.com/pin/9876543210/' });
      for (const bad of [
        'https://pin.it/abc123',
        'https://www.pinterest.com/someuser/some-board/',
        'https://www.pinterest.com/search/pins/?q=x',
        'https://pinterest.com.evil.com/pin/1234567890/',
        'https://evil.com/pin/1234567890/',
        'https://user:pw@www.pinterest.com/pin/1234567890/',
        'https://www.pinterest.com:8443/pin/1234567890/',
        'https://www.pinterest.com/pin/12/',
        'javascript:alert(1)',
        'ftp://www.pinterest.com/pin/1234567890/',
        '',
        'x'.repeat(3000),
      ]) {
        expect(ok(bad).ok).toBe(false);
      }
      expect(calls).toEqual([]);
    });
  });

  // ---- 11. global guarantees (keep last) --------------------------------------------------------------------------------------------------
  describe('global guarantees', () => {
    it('every request the integration made hit an official host and a fixed API path; nothing else', () => {
      expect(allCalls.length).toBeGreaterThan(0);
      const allowedHosts = new Set(['api.pinterest.com', 'api-sandbox.pinterest.com', '127.0.0.1:5999']);
      for (const c of allCalls) {
        const u = new URL(c.url);
        expect(allowedHosts.has(u.host)).toBe(true);
        expect(u.pathname).toMatch(/^\/v5\/(oauth\/token|boards|boards\/\d+\/pins)$/);
        expect(u.username + u.password).toBe('');
        expect(['GET', 'POST']).toContain(c.method);
        if (c.method === 'POST') expect(u.pathname).toBe('/v5/oauth/token'); // the only write-shaped call is the token exchange
        expect(c.url).not.toMatch(/pinimg|openai|pinterest\.com\/pin\//);
      }
    });

    it('PinterestModule is registered in the real AppModule (checked in source: this spec runs on a minimal module)', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.module.ts'), 'utf8');
      expect(src).toMatch(/import \{ PinterestModule \} from '\.\/pinterest\/pinterest\.module'/);
      expect(src).toMatch(/imports: \[[^\]]*\bPinterestModule\b/s);
    });

    it('nothing was sent to OpenAI (or anywhere else): the global fetch was never used', () => {
      expect(globalFetchSpy).not.toHaveBeenCalled();
    });

    it('the integration code has no console output and its logger calls cannot carry tokens, secrets, codes or response bodies', () => {
      const dir = path.join(__dirname, '..', 'src', 'pinterest');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
      expect(files.length).toBeGreaterThan(5);
      for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(src).not.toMatch(/console./);
        for (const m of src.matchAll(/.log.(?:log|warn|error|debug|verbose)(([^;]*));/g)) {
          expect(m[1]).not.toMatch(/token|secret|code|body|state|header|authorization/i);
        }
      }
    });

    it('no token, secret, authorization header or authorization code was ever written to the process output', () => {
      const printed = output.join('\n');
      expect(printed).toContain('pinterest-capture-probe'); // the capture itself works
      for (const s of [...ALL_SECRETS, 'CODE-A', 'CODE-X']) expect(printed).not.toContain(s);
      expect(printed).not.toMatch(/Basic [A-Za-z0-9+/=]{10,}|Bearer pin[a-z]_/);
    });
  });
});
