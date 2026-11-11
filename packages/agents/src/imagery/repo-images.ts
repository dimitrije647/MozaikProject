import { GitHubRepositoryTool } from '../tools/github';
import { logosOfTree, type LogoCandidateInfo } from './logo-discovery';

/**
 * IMAGE DISCOVERY IN THE PROJECT'S REPOSITORY, through the official GitHub REST API only. The file TREE is listed (paths and sizes); nothing is cloned,
 * built or executed, and no file is downloaded here. Public visibility is not permission to reuse a file commercially, and the repository's license
 * usually covers the SOURCE CODE, not a brand's pictures: every picture is a candidate that needs the owner's confirmation before it is fetched.
 */

export type RepoImageKind = 'screenshot' | 'marketing' | 'illustration' | 'logo' | 'asset';

export interface RepoImageCandidate {
  path: string;
  size: number | null;
  kind: RepoImageKind;
  /** higher = more useful for a campaign */
  priority: number;
  /** where a person can look at the file */
  pageUrl: string;
  owner: string;
  repo: string;
  ref: string;
}

export interface RepoImageDiscovery {
  ok: boolean;
  repo: { owner: string; repo: string; ref: string; license: string | null } | null;
  candidates: RepoImageCandidate[];
  /** Logo candidates among the same file list (only when `logoBrand` was given). */
  logos?: LogoCandidateInfo[];
  rejected: { path: string; reason: string }[];
  notes: string[];
}

const GOOD_DIRS = /(^|\/)(public|assets?|images?|img|static|media|screenshots?|docs?|marketing|branding|brand|\.github)(\/|$)/i;
const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|__tests__|tests?|fixtures?|mocks?|stories|storybook|e2e|cypress|\.storybook|icons?|favicons?|emoji|flags|sprites?)(\/|$)/i;
const ICON_NAME = /(favicon|apple-touch|android-chrome|icon[-_]?\d*|sprite|emoji|avatar|badge|loading|spinner|placeholder|sample|test[-_]|mock)/i;

export function classifyRepoImage(path: string): { kind: RepoImageKind; priority: number } {
  const name = path.toLowerCase();
  if (/(screenshot|screen[-_]?shot|dashboard|app[-_]?ui|interface|preview|demo|mockup|product)/.test(name)) return { kind: 'screenshot', priority: 4 };
  if (/(hero|banner|cover|og[-_]?image|social|share|feature|marketing|brand|campaign|header)/.test(name)) return { kind: 'marketing', priority: 3 };
  if (/logo|wordmark/.test(name)) return { kind: 'logo', priority: 2 };
  if (/(illustration|artwork|graphic|diagram)/.test(name)) return { kind: 'illustration', priority: 2 };
  return { kind: 'asset', priority: GOOD_DIRS.test(path) ? 1 : 0 };
}

/** The usable pictures of a file tree, best first. Pure. */
export function pickRepoImages(tree: readonly { path: string; size: number | null }[], o: { owner: string; repo: string; ref: string }, max = 40): { candidates: RepoImageCandidate[]; rejected: { path: string; reason: string }[] } {
  const rejected: { path: string; reason: string }[] = [];
  const candidates: RepoImageCandidate[] = [];
  for (const f of tree) {
    // photographs are raster files; an SVG is only ever a logo candidate (see logo-discovery.ts)
    if (!/\.(png|jpe?g|webp)$/i.test(f.path)) continue;
    if (SKIP_DIRS.test(f.path)) {
      rejected.push({ path: f.path, reason: 'Inside a folder of build output, tests or interface icons.' });
      continue;
    }
    if (ICON_NAME.test(f.path.split('/').pop() ?? '')) {
      rejected.push({ path: f.path, reason: 'An icon, avatar or test image, not campaign imagery.' });
      continue;
    }
    if (f.size !== null && f.size < 20_000) {
      rejected.push({ path: f.path, reason: 'Very small file: probably an icon or thumbnail.' });
      continue;
    }
    if (f.size !== null && f.size > 8 * 1024 * 1024) {
      rejected.push({ path: f.path, reason: 'Larger than the allowed size (8 MB).' });
      continue;
    }
    const c = classifyRepoImage(f.path);
    candidates.push({ path: f.path, size: f.size, kind: c.kind, priority: c.priority, pageUrl: `https://github.com/${o.owner}/${o.repo}/blob/${encodeURIComponent(o.ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, owner: o.owner, repo: o.repo, ref: o.ref });
  }
  candidates.sort((a, b) => b.priority - a.priority || (GOOD_DIRS.test(b.path) ? 1 : 0) - (GOOD_DIRS.test(a.path) ? 1 : 0) || (b.size ?? 0) - (a.size ?? 0) || (a.path < b.path ? -1 : 1));
  return { candidates: candidates.slice(0, max), rejected: rejected.slice(0, 200) };
}

export async function discoverRepositoryImages(repoUrl: string, o: { github?: Pick<GitHubRepositoryTool, 'listImageFiles'>; token?: string; signal?: AbortSignal; max?: number; logoBrand?: string[] } = {}): Promise<RepoImageDiscovery> {
  const github = o.github ?? new GitHubRepositoryTool({ token: o.token });
  const r = await github.listImageFiles(repoUrl, o.signal);
  if (!r.ok) {
    return { ok: false, repo: null, candidates: [], rejected: [], notes: [r.code === 'rate_limited' ? 'The GitHub API limit was reached; try again later (a GITHUB_TOKEN raises the limit).' : r.message] };
  }
  const { candidates, rejected } = pickRepoImages(r.images, { owner: r.owner, repo: r.repo, ref: r.ref }, o.max ?? 40);
  const notes = [
    r.license ? `The repository license (${r.license}) covers its source code. It does not by itself give you the right to use its pictures in advertising: confirm the rights for each picture you choose.` : 'The repository states no license. Confirm that you own each picture you choose.',
    'No file was downloaded: these are candidates. A picture is fetched through the GitHub API only after you confirm that you hold the rights to use it. Nothing from the repository is executed.',
  ];
  if (r.truncated) notes.push('The repository is large; only part of its file tree could be listed.');
  if (!candidates.length) notes.push('No usable pictures were found in the repository (only icons, test files or very small images).');
  const logos = o.logoBrand ? logosOfTree(r.images, { owner: r.owner, repo: r.repo, ref: r.ref, brand: o.logoBrand }) : undefined;
  return { ok: true, repo: { owner: r.owner, repo: r.repo, ref: r.ref, license: r.license }, candidates, rejected, ...(logos ? { logos } : {}), notes };
}
