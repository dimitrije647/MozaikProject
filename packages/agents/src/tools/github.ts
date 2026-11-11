/**
 * GitHub repository inspection through the OFFICIAL REST API only (https://api.github.com).
 * Nothing is cloned, installed, built or executed; file contents are fetched as text, bounded, and
 * treated as untrusted data. Public repositories only (a private or missing repo is reported as
 * "not accessible"). Rate limits are read from x-ratelimit-* headers and respected without retries.
 */
export type RepoFailureCode = 'invalid_repo_url' | 'not_found' | 'rate_limited' | 'api_error' | 'network_error' | 'cancelled';

export interface RepoFile {
  path: string;
  text: string;
  truncated: boolean;
}

export interface RepoSnapshot {
  owner: string;
  repo: string;
  url: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  homepage: string | null;
  topics: string[];
  license: string | null;
  stars: number | null;
  archived: boolean;
  pushedAt: string | null;
  languages: Record<string, number>;
  /** Top-level entries: name + type. */
  topLevel: { name: string; type: string }[];
  /** Up to ~300 file paths (from the git tree) used for structure indicators. */
  paths: string[];
  pathsTruncated: boolean;
  readme: RepoFile | null;
  manifests: RepoFile[];
  /** Calls made against the API for this snapshot. */
  apiCalls: number;
  rateLimit: { remaining: number | null; reset: string | null } | null;
  /** Parts that could not be retrieved (e.g. rate limit hit midway). */
  incomplete: string[];
}

export type RepoResult = { ok: true; snapshot: RepoSnapshot } | { ok: false; code: RepoFailureCode; message: string; resetAt?: string | null };

export interface GitHubToolOptions {
  baseUrl?: string;
  /** Optional read-only token raises the limit from 60 to 5000 requests/hour. Never logged. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxFileBytes?: number;
  /** Hard cap on API calls per snapshot. */
  maxCalls?: number;
}

const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'pom.xml', 'build.gradle', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pubspec.yaml', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];
const MIN_REMAINING = 3;

export function parseGitHubUrl(raw: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['github.com', 'www.github.com'].includes(u.hostname.toLowerCase()) || !/^https?:$/.test(u.protocol)) return null;
  const [owner, repoRaw] = u.pathname.split('/').filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/i, '');
  if (!owner || !repo || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

class RateLimited extends Error {
  constructor(readonly resetAt: string | null) {
    super('rate limited');
  }
}

export class GitHubRepositoryTool {
  readonly #token?: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly maxCalls: number;
  private calls = 0;
  private remaining: number | null = null;
  private reset: string | null = null;

  constructor(o: GitHubToolOptions = {}) {
    this.#token = o.token?.trim() || undefined;
    this.baseUrl = (o.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 12_000;
    this.maxFileBytes = o.maxFileBytes ?? 60_000;
    this.maxCalls = o.maxCalls ?? 16;
  }

  async inspect(repoUrl: string, signal?: AbortSignal): Promise<RepoResult> {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) return { ok: false, code: 'invalid_repo_url', message: 'Not a valid github.com/<owner>/<repo> URL.' };
    const { owner, repo } = parsed;
    const base = `/repos/${owner}/${repo}`;
    const incomplete: string[] = [];

    try {
      const meta = (await this.get(`${base}`, signal)) as Record<string, any> | null;
      if (!meta) return { ok: false, code: 'not_found', message: 'The repository was not found or is not public.' };

      const snapshot: RepoSnapshot = {
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}`,
        fullName: String(meta.full_name ?? `${owner}/${repo}`),
        description: meta.description ?? null,
        defaultBranch: String(meta.default_branch ?? 'main'),
        homepage: meta.homepage || null,
        topics: Array.isArray(meta.topics) ? meta.topics.slice(0, 20) : [],
        license: meta.license?.spdx_id ?? meta.license?.name ?? null,
        stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : null,
        archived: !!meta.archived,
        pushedAt: meta.pushed_at ?? null,
        languages: {},
        topLevel: [],
        paths: [],
        pathsTruncated: false,
        readme: null,
        manifests: [],
        apiCalls: 0,
        rateLimit: null,
        incomplete,
      };

      // Each optional step re-checks the budget; hitting the limit stops further calls (no retry loops).
      const step = async (label: string, fn: () => Promise<void>) => {
        if (!this.canCall()) return void incomplete.push(label);
        try {
          await fn();
        } catch (e) {
          if (e instanceof RateLimited) throw e;
          incomplete.push(label);
        }
      };

      await step('readme', async () => {
        const r = (await this.get(`${base}/readme`, signal)) as Record<string, any> | null;
        if (r?.content) snapshot.readme = this.file(String(r.path ?? 'README'), Buffer.from(String(r.content), 'base64'));
      });
      await step('languages', async () => {
        snapshot.languages = ((await this.get(`${base}/languages`, signal)) as Record<string, number> | null) ?? {};
      });
      await step('top-level listing', async () => {
        const list = (await this.get(`${base}/contents`, signal)) as { name: string; type: string }[] | null;
        if (Array.isArray(list)) snapshot.topLevel = list.slice(0, 60).map((e) => ({ name: e.name, type: e.type }));
      });
      await step('file tree', async () => {
        const tree = (await this.get(`${base}/git/trees/${encodeURIComponent(snapshot.defaultBranch)}?recursive=1`, signal)) as { tree?: { path: string; type: string }[]; truncated?: boolean } | null;
        if (tree?.tree) {
          const all = tree.tree.filter((t) => t.type === 'blob' && !/(^|\/)(node_modules|dist|build|\.git|vendor)\//.test(t.path)).map((t) => t.path);
          snapshot.paths = all.slice(0, 300);
          snapshot.pathsTruncated = !!tree.truncated || all.length > 300;
        }
      });

      // Dependency manifests: root-level, and one level down for monorepos (apps/*, packages/*).
      const names = new Set(snapshot.topLevel.map((e) => e.name));
      const wanted = [
        ...MANIFESTS.filter((m) => names.has(m)),
        ...snapshot.paths.filter((p) => /^(apps|packages|services|backend|frontend|server|client)\/[^/]+\/(package\.json|requirements\.txt|pyproject\.toml|pom\.xml|go\.mod)$/.test(p)).slice(0, 4),
      ].slice(0, 7);
      for (const path of wanted) {
        await step(`file ${path}`, async () => {
          const c = (await this.get(`${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, signal)) as Record<string, any> | null;
          if (c?.content && c.encoding === 'base64') snapshot.manifests.push(this.file(path, Buffer.from(String(c.content), 'base64')));
        });
      }

      snapshot.apiCalls = this.calls;
      snapshot.rateLimit = { remaining: this.remaining, reset: this.reset };
      return { ok: true, snapshot };
    } catch (e) {
      if (e instanceof RateLimited) return { ok: false, code: 'rate_limited', message: `GitHub API rate limit reached${e.resetAt ? ` (resets ${e.resetAt})` : ''}. Add a GITHUB_TOKEN or try later.`, resetAt: e.resetAt };
      if (signal?.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
      if (e instanceof Error && e.message === 'api_error') return { ok: false, code: 'api_error', message: 'GitHub returned an unexpected response.' };
      return { ok: false, code: 'network_error', message: 'GitHub could not be reached.' };
    }
  }

  /**
   * Reads a few specific text files of a PUBLIC repository through the contents API (no clone, nothing executed). `paths` come from the
   * snapshot's file tree. A file larger than the tool's byte limit is truncated, binary content is skipped, and the shared per-snapshot call
   * budget and rate-limit guard apply (a hit limit simply returns what was read so far).
   */
  async readFiles(repoUrl: string, paths: string[], ref: string, signal?: AbortSignal): Promise<{ files: RepoFile[]; skipped: string[] }> {
    const parsed = parseGitHubUrl(repoUrl);
    const files: RepoFile[] = [];
    const skipped: string[] = [];
    if (!parsed) return { files, skipped: paths };
    const base = `/repos/${parsed.owner}/${parsed.repo}/contents`;
    for (const path of paths.slice(0, 12)) {
      if (!this.canCall() || !/^[\w@./+-]{1,200}$/.test(path) || path.includes('..')) {
        skipped.push(path);
        continue;
      }
      try {
        const c = (await this.get(`${base}/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, signal)) as Record<string, any> | null;
        if (c?.content && c.encoding === 'base64' && !Array.isArray(c) && (typeof c.size !== 'number' || c.size <= this.maxFileBytes * 8)) files.push(this.file(path, Buffer.from(String(c.content), 'base64')));
        else skipped.push(path);
      } catch (e) {
        if (e instanceof RateLimited) {
          skipped.push(path);
          break;
        }
        skipped.push(path);
      }
    }
    return { files, skipped };
  }

  /**
   * The raster image files of a repository (path and size, from the git tree) plus its license and default branch. Two API calls; nothing is
   * downloaded. Image files are LISTED here; they are fetched only by `readBinary`, after the owner confirmed they hold the rights.
   */
  async listImageFiles(repoUrl: string, signal?: AbortSignal): Promise<{ ok: true; owner: string; repo: string; ref: string; license: string | null; images: { path: string; size: number | null }[]; truncated: boolean } | { ok: false; code: RepoFailureCode; message: string; resetAt?: string | null }> {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) return { ok: false, code: 'invalid_repo_url', message: 'Not a valid github.com/<owner>/<repo> URL.' };
    const { owner, repo } = parsed;
    try {
      const meta = (await this.get(`/repos/${owner}/${repo}`, signal)) as Record<string, any> | null;
      if (!meta) return { ok: false, code: 'not_found', message: 'The repository was not found or is not public.' };
      const ref = String(meta.default_branch ?? 'main');
      const license: string | null = meta.license?.spdx_id ?? meta.license?.name ?? null;
      if (!this.canCall()) return { ok: false, code: 'rate_limited', message: 'The GitHub API limit was reached.', resetAt: this.reset };
      const tree = (await this.get(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal)) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean } | null;
      const images = (tree?.tree ?? [])
        .filter((t) => t.type === 'blob' && /\.(png|jpe?g|webp|svg)$/i.test(t.path) && !/(^|\/)(node_modules|dist|build|\.git|vendor|\.next|coverage)\//.test(t.path))
        .slice(0, 600)
        .map((t) => ({ path: t.path, size: typeof t.size === 'number' ? t.size : null }));
      return { ok: true, owner, repo, ref, license, images, truncated: !!tree?.truncated };
    } catch (e) {
      if (e instanceof RateLimited) return { ok: false, code: 'rate_limited', message: 'The GitHub API limit was reached.', resetAt: e.resetAt };
      return { ok: false, code: 'api_error', message: 'The repository could not be read.' };
    }
  }

  /** ONE image file through the official contents API (raw media type), bounded in size. Never executes or interprets the file. */
  async readBinary(o: { owner: string; repo: string; ref: string; path: string; maxBytes?: number }, signal?: AbortSignal): Promise<{ ok: true; data: Buffer } | { ok: false; message: string }> {
    const max = o.maxBytes ?? 8 * 1024 * 1024;
    if (!/^[\w.-]{1,100}$/.test(o.owner) || !/^[\w.-]{1,100}$/.test(o.repo) || !/^[\w@./+ -]{1,240}$/.test(o.path) || o.path.includes('..')) return { ok: false, message: 'The file path is not valid.' };
    if (!this.canCall()) return { ok: false, message: 'The GitHub API limit was reached.' };
    try {
      this.calls++;
      const res = await this.f(`${this.baseUrl}/repos/${o.owner}/${o.repo}/contents/${o.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(o.ref)}`, {
        headers: { accept: 'application/vnd.github.raw+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'LaunchPilot-ProductDiscovery', ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) },
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs * 2), ...(signal ? [signal] : [])]),
      });
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null) this.remaining = Number(remaining);
      if (!res.ok) return { ok: false, message: res.status === 404 ? 'The file no longer exists in the repository.' : 'The file could not be read.' };
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > max) return { ok: false, message: 'The file is larger than the allowed size.' };
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > max) return { ok: false, message: 'The file is larger than the allowed size.' };
      return { ok: true, data };
    } catch {
      return { ok: false, message: 'The file could not be read.' };
    }
  }

  private canCall() {
    if (this.calls >= this.maxCalls) return false;
    return this.remaining === null || this.remaining > MIN_REMAINING;
  }

  private file(path: string, buf: Buffer): RepoFile {
    const truncated = buf.length > this.maxFileBytes;
    return { path, text: buf.subarray(0, this.maxFileBytes).toString('utf8'), truncated };
  }

  /** Returns parsed JSON, null for 404, throws RateLimited when the API says so. */
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    this.calls++;
    const res = await this.f(`${this.baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'LaunchPilot-ProductDiscovery',
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.remaining = Number(remaining);
    if (reset) this.reset = new Date(Number(reset) * 1000).toISOString();
    if (res.status === 404) return null;
    if (res.status === 429 || (res.status === 403 && (this.remaining === 0 || /rate limit/i.test(await res.clone().text().catch(() => ''))))) {
      throw new RateLimited(this.reset);
    }
    if (!res.ok) throw new Error('api_error');
    return res.json();
  }
}
