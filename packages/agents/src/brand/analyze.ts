import { GitHubRepositoryTool, parseGitHubUrl } from '../tools/github';
import { WebFetchTool } from '../tools/web-fetch';
import { readImageColors, candidatesFromImage } from './image-colors';
import { brandFromCss, brandFromGuidelinesText, brandFromHtml, brandFromTailwindConfig, brandFromTokensJson } from './sources';
import { emptyReading, type BrandCandidate, type BrandReading } from './types';

/**
 * Reading brand colors from the places a project points to. Each function returns ONE BrandReading and never throws: a source that cannot
 * be read says why (blocked by robots, bot protection, not public, too large...) and the others still count.
 *
 * Safety: the website goes through WebFetchTool (https/http only, public addresses only, every redirect re-validated, robots.txt honored,
 * timeouts and byte limits, one page plus a few stylesheets); the repository goes through GitHub's official REST API for PUBLIC repositories
 * only and its files are read as text and never executed; images are only decoded by Sharp. Nothing here executes code from a source and
 * nothing is sent to a language model.
 */

// ---- the website ---------------------------------------------------------------------------------------------------------------------------

const registrable = (host: string) => host.replace(/^www\./, '').split('.').slice(-2).join('.');

export interface WebsiteBrandOptions {
  fetcher?: WebFetchTool;
  signal?: AbortSignal;
  /** at most this many stylesheets of the site are read */
  maxStylesheets?: number;
}

export async function readWebsiteBrand(url: string, o: WebsiteBrandOptions = {}): Promise<BrandReading> {
  const label = 'Website';
  const web = o.fetcher ?? new WebFetchTool({ timeoutMs: 8000, maxBytes: 600_000, maxPages: 2, maxRedirects: 3, maxAssets: 5, userAgent: 'LaunchPilotBot/1.0 (brand colors; honors robots.txt)' });
  const checked = web.checkUrl(url);
  if (!checked.ok) return emptyReading('website', label, 'blocked', checked.message);
  const page = await web.fetchHtml(url, o.signal);
  if (!page.ok) {
    const f = page.result;
    const status = f.code === 'robots_disallowed' || f.code === 'bot_protected' || f.code === 'blocked_url' ? 'blocked' : 'unavailable';
    return emptyReading('website', label, status, `${f.message}${f.code === 'robots_disallowed' ? ' Its colors were not read.' : ''}`);
  }
  const base = page.result.finalUrl;
  const html = brandFromHtml(page.result.body, { tier: 4, label });
  const candidates: BrandCandidate[] = [...html.candidates];
  const notes: string[] = [];
  // the site's own stylesheets: same site only (its registrable domain), so a CDN framework file is not mistaken for the brand
  const host = new URL(base).hostname;
  const sheets = html.stylesheets
    .map((h) => {
      try {
        return new URL(h, base);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => !!u && /^https?:$/.test(u.protocol) && registrable(u.hostname) === registrable(host))
    .slice(0, o.maxStylesheets ?? 3);
  let read = 0;
  for (const s of sheets) {
    const r = await web.fetchAsset(s.toString(), { kind: 'css', signal: o.signal });
    if (!r.ok) {
      notes.push(`A stylesheet could not be read (${r.message})`);
      continue;
    }
    read++;
    candidates.push(...brandFromCss(r.body.toString('utf8'), { tier: 4, label: 'Website stylesheet', tokenTier: 2 }));
  }
  // the site's logo, when it is a raster image on the same site
  for (const l of html.logoCandidates.slice(0, 1)) {
    try {
      const u = new URL(l, base);
      if (registrable(u.hostname) !== registrable(host)) continue;
      const r = await web.fetchAsset(u.toString(), { kind: 'image', signal: o.signal });
      if (!r.ok) continue;
      const ic = await readImageColors(r.body);
      if (ic) candidates.push(...candidatesFromImage(ic, { tier: 4, label: 'Website logo image', strong: 0.65 }));
    } catch {
      /* a bad logo link is not worth reporting */
    }
  }
  if (!candidates.length) return emptyReading('website', label, 'empty', `The page was read${read ? ` with ${read} stylesheet${read === 1 ? '' : 's'}` : ''} but no brand colors were declared in a way that can be read automatically.`);
  return { source: 'website', label, status: 'ok', message: notes.length ? notes.join('; ') : null, candidates };
}

// ---- the repository -----------------------------------------------------------------------------------------------------------------------

/** Files that declare a theme, by how likely they are to be the brand's own. Order = priority when the read budget is small. */
const REPO_FILE_PATTERNS: { re: RegExp; kind: 'tailwind' | 'css' | 'tokens' | 'brand_doc'; rank: number }[] = [
  { re: /(^|\/)(brand|design)[-_]?(tokens?|system)?\.json$|(^|\/)tokens?\.json$|(^|\/)design-tokens\/[^/]+\.json$/i, kind: 'tokens', rank: 0 },
  { re: /(^|\/)tailwind\.config\.(ts|js|cjs|mjs)$/i, kind: 'tailwind', rank: 1 },
  { re: /(^|\/)(brand|branding|guidelines?)\.(md|txt)$|(^|\/)docs\/(brand|branding|design)[^/]*\.md$/i, kind: 'brand_doc', rank: 2 },
  { re: /(^|\/)(theme|tokens|variables|colors?|brand)\.(css|scss)$|(^|\/)styles?\/(theme|tokens|variables|colors?|brand)\.(css|scss)$/i, kind: 'css', rank: 3 },
  { re: /(^|\/)(globals?|index|main|app)\.css$/i, kind: 'css', rank: 4 },
];

/** Which files of a repository tree are worth reading (at most `max`, best first, node_modules etc. already excluded by the tree). Pure. */
export function pickBrandFiles(paths: readonly string[], max = 6): { path: string; kind: 'tailwind' | 'css' | 'tokens' | 'brand_doc' }[] {
  const out: { path: string; kind: 'tailwind' | 'css' | 'tokens' | 'brand_doc'; rank: number; depth: number }[] = [];
  for (const path of paths) {
    if (/(^|\/)(node_modules|dist|build|vendor|\.next|coverage|test|tests|__tests__|e2e)\//i.test(path)) continue;
    const m = REPO_FILE_PATTERNS.find((p) => p.re.test(path));
    if (m) out.push({ path, kind: m.kind, rank: m.rank, depth: path.split('/').length });
  }
  return out.sort((a, b) => a.rank - b.rank || a.depth - b.depth || (a.path < b.path ? -1 : 1)).slice(0, max).map(({ path, kind }) => ({ path, kind }));
}

export interface RepositoryBrandOptions {
  tool?: GitHubRepositoryTool;
  token?: string;
  signal?: AbortSignal;
}

export async function readRepositoryBrand(repoUrl: string, o: RepositoryBrandOptions = {}): Promise<BrandReading> {
  const label = 'Repository';
  if (!parseGitHubUrl(repoUrl)) return emptyReading('repository', label, 'blocked', 'The repository link is not a github.com/<owner>/<repo> address.');
  const tool = o.tool ?? new GitHubRepositoryTool({ token: o.token, maxCalls: 14, maxFileBytes: 120_000, timeoutMs: 10_000 });
  const snap = await tool.inspect(repoUrl, o.signal);
  if (!snap.ok) return emptyReading('repository', label, snap.code === 'not_found' ? 'blocked' : 'unavailable', snap.code === 'not_found' ? 'The repository was not found or is not public, so it was not read (private repositories are never read without your authorization).' : snap.message);
  const picks = pickBrandFiles(snap.snapshot.paths);
  if (!picks.length) return emptyReading('repository', label, 'empty', 'No theme, token or style file was found in the repository tree.');
  const { files } = await tool.readFiles(repoUrl, picks.map((p) => p.path), snap.snapshot.defaultBranch, o.signal);
  const candidates: BrandCandidate[] = [];
  for (const f of files) {
    const kind = picks.find((p) => p.path === f.path)?.kind;
    const from = { tier: 5 as const, label: `Repository file ${f.path}` };
    try {
      if (kind === 'tokens') candidates.push(...brandFromTokensJson(JSON.parse(f.text), { tier: 2, label: from.label }));
      else if (kind === 'tailwind') candidates.push(...brandFromTailwindConfig(f.text, { tier: 2, label: from.label }));
      else if (kind === 'brand_doc') candidates.push(...brandFromGuidelinesText(f.text, { tier: 2, label: from.label }));
      else candidates.push(...brandFromCss(f.text, { tier: 5, label: from.label, tokenTier: 2 }));
    } catch {
      /* a file that does not parse contributes nothing */
    }
  }
  if (!candidates.length) return emptyReading('repository', label, 'empty', `${files.length} theme file${files.length === 1 ? '' : 's'} read, but no brand colors were declared in them.`);
  return { source: 'repository', label, status: 'ok', message: null, candidates };
}

// ---- images and documents the user uploaded --------------------------------------------------------------------------------------------------

export async function readLogoBrand(logo: Buffer | null): Promise<BrandReading> {
  const label = 'Logo';
  if (!logo) return emptyReading('logo', label, 'unavailable', 'No logo was uploaded to this project.');
  const ic = await readImageColors(logo);
  if (!ic) return emptyReading('logo', label, 'failed', 'The logo file could not be read as an image (PNG, JPEG, WebP or GIF).');
  const candidates = candidatesFromImage(ic, { tier: 3, label, strong: 0.85 });
  if (!candidates.length) return emptyReading('logo', label, 'empty', 'The logo has no color that could be told apart from its background.');
  return { source: 'logo', label, status: 'ok', message: null, candidates };
}

export async function readImagesBrand(images: { name: string; data: Buffer }[]): Promise<BrandReading> {
  const label = 'Uploaded images';
  if (!images.length) return emptyReading('uploaded_image', label, 'unavailable', 'No brand pictures were uploaded to this project.');
  const candidates: BrandCandidate[] = [];
  for (const img of images.slice(0, 4)) {
    const ic = await readImageColors(img.data);
    if (ic) candidates.push(...candidatesFromImage(ic, { tier: 6, label: `Image ${img.name.slice(0, 40)}`, strong: 0.45 }).filter((c) => c.role !== 'text'));
  }
  if (!candidates.length) return emptyReading('uploaded_image', label, 'empty', 'No distinct colors could be read from the uploaded pictures.');
  return { source: 'uploaded_image', label, status: 'ok', message: null, candidates };
}

/** Text of brand guideline documents the user uploaded (already extracted to plain text by the caller). */
export function readGuidelinesBrand(docs: { name: string; text: string }[]): BrandReading {
  const label = 'Brand documents';
  if (!docs.length) return emptyReading('brand_guidelines', label, 'unavailable', 'No brand document was uploaded to this project.');
  const candidates: BrandCandidate[] = [];
  for (const d of docs.slice(0, 5)) candidates.push(...brandFromGuidelinesText(d.text, { tier: 2, label: `Document ${d.name.slice(0, 40)}` }));
  if (!candidates.length) return emptyReading('brand_guidelines', label, 'empty', 'The uploaded documents do not name brand colors next to a role such as "primary" or "accent".');
  return { source: 'brand_guidelines', label, status: 'ok', message: null, candidates };
}
