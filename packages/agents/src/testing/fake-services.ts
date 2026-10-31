import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local FAKE external services for automated tests: a website, the GitHub REST API and Tavily.
 * Everything they return is a FIXTURE. It is never real-world evidence, and tests mark sources
 * created from them as fixtures.
 */

type Route = { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string>; delayMs?: number; hang?: boolean };

abstract class FakeHttp {
  protected server!: Server;
  private readonly sockets = new Set<import('node:net').Socket>();
  readonly hits: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  origin = '';

  protected abstract handle(req: IncomingMessage, res: ServerResponse, body: string): void | Promise<void>;

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      this.hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      try {
        await this.handle(req, res, body);
      } catch {
        res.writeHead(500).end();
      }
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  count(path: string | RegExp) {
    return this.hits.filter((h) => (typeof path === 'string' ? h.path === path : path.test(h.path))).length;
  }
}

// ---- Website ---------------------------------------------------------------------------------

export function htmlPage(o: { title: string; description?: string; headings?: string[]; paragraphs?: string[]; links?: { href: string; text: string }[]; extraBody?: string; lang?: string }): string {
  return `<!doctype html><html lang="${o.lang ?? 'en'}"><head><title>${o.title}</title>${o.description ? `<meta name="description" content="${o.description}">` : ''}<style>.x{color:red}</style><script>window.secret='SCRIPT_TEXT_MUST_NOT_APPEAR'</script></head><body>
${(o.headings ?? []).map((h, i) => `<h${Math.min(i + 1, 3)}>${h}</h${Math.min(i + 1, 3)}>`).join('\n')}
${(o.paragraphs ?? []).map((p) => `<p>${p}</p>`).join('\n')}
<nav>${(o.links ?? []).map((l) => `<a href="${l.href}">${l.text}</a>`).join(' ')}</nav>
${o.extraBody ?? ''}
</body></html>`;
}

export class FakeWebsite extends FakeHttp {
  readonly routes = new Map<string, Route>();
  robots = 'User-agent: *\nAllow: /';

  constructor() {
    super();
  }

  page(path: string, html: string, extra: Route = {}) {
    this.routes.set(path, { type: 'text/html; charset=utf-8', body: html, ...extra });
    return this;
  }

  protected async handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') {
      const r = this.routes.get('/robots.txt');
      if (r) return send(res, r);
      return send(res, { type: 'text/plain', body: this.robots });
    }
    const route = this.routes.get(path);
    if (!route) return send(res, { status: 404, type: 'text/html', body: '<h1>Not found</h1>' });
    if (route.hang) return;
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    send(res, route);
  }
}

function send(res: ServerResponse, r: Route) {
  res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html', ...(r.headers ?? {}) });
  res.end(r.body ?? '');
}

// ---- GitHub REST API ----------------------------------------------------------------------------

export interface FakeRepoSpec {
  owner: string;
  repo: string;
  description?: string;
  language?: string;
  readme?: string;
  /** path -> content */
  files?: Record<string, string>;
  languages?: Record<string, number>;
  topics?: string[];
}

export class FakeGitHub extends FakeHttp {
  private repos = new Map<string, FakeRepoSpec>();
  /** After this many API calls every request answers like an exhausted rate limit. Infinity = never. */
  limitAfter = Infinity;
  private calls = 0;

  addRepo(spec: FakeRepoSpec) {
    this.repos.set(`${spec.owner}/${spec.repo}`.toLowerCase(), spec);
    return this;
  }

  protected handle(req: IncomingMessage, res: ServerResponse) {
    this.calls++;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(Math.max(0, 60 - this.calls)), 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), ...headers });
      res.end(JSON.stringify(body));
    };
    if (this.calls > this.limitAfter) return json(403, { message: 'API rate limit exceeded for 203.0.113.9.' }, { 'x-ratelimit-remaining': '0' });
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const spec = m ? this.repos.get(`${m[1]}/${m[2]}`.toLowerCase()) : undefined;
    if (!m || !spec) return json(404, { message: 'Not Found' });
    const sub = m[3] ?? '';
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const files = spec.files ?? {};
    if (sub === '') return json(200, { full_name: `${spec.owner}/${spec.repo}`, description: spec.description ?? null, default_branch: 'main', homepage: null, topics: spec.topics ?? [], license: { spdx_id: 'MIT' }, stargazers_count: 7, archived: false, pushed_at: '2026-01-01T00:00:00Z' });
    if (sub === '/readme') return spec.readme ? json(200, { path: 'README.md', encoding: 'base64', content: b64(spec.readme) }) : json(404, { message: 'Not Found' });
    if (sub === '/languages') return json(200, spec.languages ?? { TypeScript: 8000, CSS: 1000 });
    if (sub === '/contents' || sub === '/contents/') {
      const top = new Map<string, string>();
      for (const p of Object.keys(files)) top.set(p.split('/')[0], p.includes('/') ? 'dir' : 'file');
      if (spec.readme) top.set('README.md', 'file');
      return json(200, [...top].map(([name, type]) => ({ name, type })));
    }
    if (sub.startsWith('/git/trees/')) return json(200, { truncated: false, tree: [...Object.keys(files), ...(spec.readme ? ['README.md'] : [])].map((p) => ({ path: p, type: 'blob' })) });
    if (sub.startsWith('/contents/')) {
      const path = decodeURIComponent(sub.slice('/contents/'.length));
      return files[path] !== undefined ? json(200, { path, encoding: 'base64', content: b64(files[path]) }) : json(404, { message: 'Not Found' });
    }
    return json(404, { message: 'Not Found' });
  }
}

// ---- Tavily ----------------------------------------------------------------------------------------

export class FakeTavily extends FakeHttp {
  status = 200;
  results: { title: string; url: string; content: string; score: number }[] = [{ title: 'Example result', url: 'https://search.example/result', content: 'A snippet from the search provider.', score: 0.9 }];

  protected handle(req: IncomingMessage, res: ServerResponse) {
    if (req.url !== '/search' || req.method !== 'POST') return send(res, { status: 404, type: 'application/json', body: '{}' });
    if (this.status !== 200) return send(res, { status: this.status, type: 'application/json', body: JSON.stringify({ detail: { error: 'raw provider text sk-should-never-leak' } }) });
    send(res, { type: 'application/json', body: JSON.stringify({ query: 'q', results: this.results, response_time: 0.1, request_id: 'x' }) });
  }
}

// ---- Google PageSpeed Insights v5 (FIXTURE) -----------------------------------------------------------

export class FakePageSpeed extends FakeHttp {
  status = 200;
  errorStatus: string | null = null;
  delayMs = 0;

  protected async handle(req: IncomingMessage, res: ServerResponse) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.status !== 200) return send(res, { status: this.status, type: 'application/json', body: JSON.stringify({ error: { code: this.status, message: 'raw provider text sk-should-never-leak', status: this.errorStatus ?? 'ERROR' } }) });
    const audit = (numericValue: number, displayValue: string) => ({ numericValue, displayValue });
    send(res, {
      type: 'application/json',
      body: JSON.stringify({
        id: 'http://fixture/',
        loadingExperience: { overall_category: 'AVERAGE' },
        lighthouseResult: {
          finalUrl: 'http://fixture/',
          fetchTime: '2026-01-01T00:00:00.000Z',
          categories: { performance: { score: 0.54 }, seo: { score: 0.82 }, accessibility: { score: 0.9 }, 'best-practices': { score: 0.95 } },
          audits: {
            'first-contentful-paint': audit(1800, '1.8 s'),
            'largest-contentful-paint': audit(4200, '4.2 s'),
            'total-blocking-time': audit(310, '310 ms'),
            'cumulative-layout-shift': audit(0.12, '0.12'),
            'speed-index': audit(3100, '3.1 s'),
          },
        },
      }),
    });
  }
}

// ---- YouTube Data API v3 (FIXTURE) ---------------------------------------------------------------------

export class FakeYouTube extends FakeHttp {
  status = 200;
  reason = '';
  hiddenSubscribers = false;
  description = 'Premium diving courses for everyone';

  protected handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => send(res, { status, type: 'application/json', body: JSON.stringify(body) });
    if (this.status !== 200) return json(this.status, { error: { code: this.status, message: 'raw provider text sk-should-never-leak', errors: [{ reason: this.reason }] } });
    if (url.pathname === '/channels') {
      if (url.searchParams.get('forHandle') === '@missing') return json(200, { items: [] });
      return json(200, {
        items: [
          {
            id: 'UCfixture0000000000000001',
            snippet: { title: 'Fixture Channel', description: this.description, customUrl: '@fixturechannel', publishedAt: '2020-01-01T00:00:00Z', country: 'RS' },
            statistics: { subscriberCount: this.hiddenSubscribers ? undefined : '1234', hiddenSubscriberCount: this.hiddenSubscribers, viewCount: '56789', videoCount: '42' },
            contentDetails: { relatedPlaylists: { uploads: 'UUfixture0000000000000001' } },
          },
        ],
      });
    }
    if (url.pathname === '/playlistItems') {
      const now = Date.now();
      const items = [3, 20, 45, 200].map((d, i) => ({ snippet: { title: `Video ${i + 1}`, publishedAt: new Date(now - d * 86_400_000).toISOString() }, contentDetails: { videoPublishedAt: new Date(now - d * 86_400_000).toISOString() } }));
      return json(200, { items });
    }
    json(404, { error: { code: 404 } });
  }
}

// ---- Nager.Date public holidays (FIXTURE) ----------------------------------------------------------------

export class FakeNager extends FakeHttp {
  status = 200;
  holidays: { date: string; name: string; localName: string }[] = [];

  protected handle(req: IncomingMessage, res: ServerResponse) {
    const m = /^\/PublicHolidays\/(\d{4})\/([A-Z]{2})$/.exec((req.url ?? '').split('?')[0]);
    if (!m) return send(res, { status: 404, type: 'application/json', body: '{}' });
    if (this.status !== 200) return send(res, { status: this.status, type: 'application/json', body: '{}' });
    send(res, { type: 'application/json', body: JSON.stringify(this.holidays.filter((h) => h.date.startsWith(m[1])).map((h) => ({ ...h, countryCode: m[2], fixed: false, global: true, counties: null, launchYear: null, types: ['Public'] }))) });
  }
}
