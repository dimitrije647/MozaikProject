import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { applyDetectedPalette, checkPalette, editPaletteRole, newDesign, paletteFit, resetPalette, switchCollection } from '../collections/design';
import { GitHubRepositoryTool } from '../tools/github';
import { WebFetchTool } from '../tools/web-fetch';
import { parseAnyColor, parseColor, parseHslTriple } from './color-parse';
import { pickBrandFiles, readGuidelinesBrand, readLogoBrand, readRepositoryBrand, readWebsiteBrand, readImagesBrand } from './analyze';
import { candidatesFromImage, readImageColors } from './image-colors';
import { brandFromCss, brandFromGuidelinesText, brandFromTailwindConfig, brandFromTokensJson, roleOfName } from './sources';
import { suggestPalette } from './suggest';
import type { BrandReading } from './types';

// ---- fixtures ------------------------------------------------------------------------------------------------------------------------------

const CSS = `
:root { --primary: #0a5cff; --accent: #ff7a00; --background: #ffffff; --foreground: #1a1a2e; --muted: #eeeeee; --border: #dddddd; --destructive: #ff0000; }
body { background: #fff; color: #1a1a2e; }
a { color: #0a5cff; }
.btn-primary { background-color: #0a5cff; color: #fff; }
.btn-ghost { background: transparent; }
@media (prefers-color-scheme: dark) { :root { --primary: #ff00ff; --background: #000000; } }
.dark { --primary: #00ffff; }
`;
const HTML = `<!doctype html><html><head><meta name="theme-color" content="#0a5cff"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="https://cdn.example.org/bootstrap.css"></head><body><header class="site-header"><img class="logo" src="/logo.png" alt="Acme logo"></header><h1>Welcome</h1><a class="btn btn-primary" href="#">Buy</a></body></html>`;

const svg = (body: string, w = 200, h = 200) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const png = async (bg: { r: number; g: number; b: number; alpha: number }, body: string, w = 200, h = 200) => sharp({ create: { width: w, height: h, channels: 4, background: bg } }).composite([{ input: svg(body, w, h) }]).png().toBuffer();

let blueOrangeOnTransparent: Buffer;
let blueOrangeOnWhite: Buffer;
let blackWordmark: Buffer;
let tinyLogo: Buffer;

before(async () => {
  const shapes = '<circle cx="100" cy="100" r="70" fill="#0A5CFF"/><rect x="150" y="150" width="34" height="34" fill="#FF7A00"/>';
  blueOrangeOnTransparent = await png({ r: 0, g: 0, b: 0, alpha: 0 }, shapes);
  blueOrangeOnWhite = await png({ r: 255, g: 255, b: 255, alpha: 1 }, shapes);
  blackWordmark = await png({ r: 0, g: 0, b: 0, alpha: 0 }, '<rect x="20" y="80" width="160" height="40" fill="#111111"/>');
  tinyLogo = await png({ r: 255, g: 255, b: 255, alpha: 1 }, '<circle cx="8" cy="8" r="6" fill="#E91E63"/>', 16, 16);
});

// ---- colors ---------------------------------------------------------------------------------------------------------------------------------

describe('color parsing', () => {
  it('reads hex, rgb, hsl, oklch and shadcn HSL triples; refuses transparent and unknown values', () => {
    assert.equal(parseColor('#0A5CFF'), '#0a5cff');
    assert.equal(parseColor('#fc0'), '#ffcc00');
    assert.equal(parseColor('rgb(10, 92, 255)'), '#0a5cff');
    assert.equal(parseColor('rgb(10 92 255 / 0.9)'), '#0a5cff');
    assert.equal(parseColor('rgba(10,92,255,0.2)'), null, 'mostly transparent');
    assert.equal(parseColor('hsl(221, 100%, 52%)')?.length, 7);
    assert.equal(parseHslTriple('222.2 47.4% 11.2%')?.length, 7);
    assert.equal(parseAnyColor('currentColor'), null);
    assert.equal(parseAnyColor('var(--x)'), null);
    const o = parseColor('oklch(0.62 0.19 255)');
    assert.ok(o && /^#[0-9a-f]{6}$/.test(o));
    const white = parseColor('oklch(1 0 0)');
    assert.equal(white, '#ffffff');
  });

  it('turns variable names into roles and ignores everything that is not a brand role', () => {
    assert.equal(roleOfName('primary')?.role, 'primary');
    assert.equal(roleOfName('color-brand-500')?.role, 'primary');
    assert.equal(roleOfName('accent')?.role, 'accent');
    assert.equal(roleOfName('secondary')?.role, 'secondary');
    assert.equal(roleOfName('background')?.role, 'background');
    assert.equal(roleOfName('foreground')?.role, 'text');
    assert.equal(roleOfName('primary-foreground'), null, 'text ON the primary color says nothing about the page text');
    assert.equal(roleOfName('muted'), null);
    assert.equal(roleOfName('destructive'), null);
    assert.equal(roleOfName('primary-dark'), null);
  });
});

// ---- CSS, Tailwind, tokens, guidelines --------------------------------------------------------------------------------------------------------

describe('brand colors in text sources (fixtures)', () => {
  it('reads declared CSS variables and visible branding; dark-mode, muted and destructive colors are not the brand', () => {
    const c = brandFromCss(CSS, { tier: 4, label: 'Website stylesheet' });
    const of = (role: string) => c.filter((x) => x.role === role).sort((a, b) => a.tier - b.tier || b.weight - a.weight)[0];
    assert.equal(of('primary').hex, '#0a5cff');
    assert.equal(of('primary').tier, 2, 'a declared variable is a design token');
    assert.equal(of('accent').hex, '#ff7a00');
    assert.equal(of('background').hex, '#ffffff');
    assert.equal(of('text').hex, '#1a1a2e');
    assert.ok(!c.some((x) => ['#ff00ff', '#00ffff', '#000000', '#ff0000', '#eeeeee'].includes(x.hex)), c.map((x) => x.hex).join(','));
    assert.ok(c.every((x) => !/<|>/.test(x.evidence)), 'evidence is a safe sentence');
  });

  it('a white page background is only ever a background: it never becomes the primary color', () => {
    const c = brandFromCss('body { background: #ffffff; color: #222222 } header { background: #ffffff } .btn { background: #ffffff }', { tier: 4, label: 'Website' });
    assert.ok(c.some((x) => x.role === 'background' && x.hex === '#ffffff'));
    assert.ok(!c.some((x) => x.role === 'primary' && x.hex === '#ffffff'));
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [{ source: 'website', label: 'Website', status: 'ok', message: null, candidates: c }] });
    assert.notEqual(s.palette.primary, '#ffffff');
    assert.equal(s.palette.background, '#ffffff');
    assert.equal(s.evidence.primary.source, 'collection_default', 'nobody gave a primary color: the default is used and says so');
  });

  it('reads a Tailwind config as text (never executes it): nested scales, DEFAULT and 500', () => {
    const cfg = `
      import type { Config } from 'tailwindcss';
      export default { theme: { extend: { colors: {
        brand: { 50: '#eef4ff', 500: '#0a5cff', 600: '#084ad0' },
        accent: { DEFAULT: '#ff7a00', foreground: '#ffffff' },
        secondary: '#0b2545',
        background: 'hsl(0 0% 100%)',
        danger: '#ff0000',
      } } }, plugins: [require('evil')] } satisfies Config;`;
    const c = brandFromTailwindConfig(cfg, { tier: 2, label: 'Repository file tailwind.config.ts' });
    const by = (role: string) => c.filter((x) => x.role === role).sort((a, b) => b.weight - a.weight)[0];
    assert.equal(by('primary').hex, '#0a5cff');
    assert.equal(by('accent').hex, '#ff7a00');
    assert.equal(by('secondary').hex, '#0b2545');
    assert.ok(!c.some((x) => x.hex === '#ff0000'));
  });

  it('reads design-token JSON (Style Dictionary and W3C $value shapes)', () => {
    const c = brandFromTokensJson({ color: { brand: { primary: { $value: '#0a5cff' }, accent: { value: '#ff7a00' } }, text: { base: { value: '#1a1a2e' } }, border: { value: '#cccccc' } } }, { tier: 2, label: 'Repository file tokens.json' });
    assert.ok(c.some((x) => x.role === 'primary' && x.hex === '#0a5cff'));
    assert.ok(c.some((x) => x.role === 'accent' && x.hex === '#ff7a00'));
    assert.ok(c.some((x) => x.role === 'text' && x.hex === '#1a1a2e'));
    assert.ok(!c.some((x) => x.hex === '#cccccc'));
  });

  it('reads colors from brand guideline text only next to a role word', () => {
    const c = brandFromGuidelinesText('Brand guidelines\nPrimary color: #0A5CFF\nAccent - rgb(255, 122, 0)\nWe used #123456 for the print run in 2019\nBackground: #F7F9FC', { tier: 2, label: 'Document brand.pdf' });
    assert.deepEqual(c.map((x) => [x.role, x.hex]).sort(), [['accent', '#ff7a00'], ['background', '#f7f9fc'], ['primary', '#0a5cff']]);
  });

  it('ignores oversized or hostile input without hanging', () => {
    const big = `:root{${'--x:#fff;'.repeat(50_000)}} ${'{'.repeat(3000)}`;
    const t = Date.now();
    brandFromCss(big, { tier: 4, label: 'x' });
    brandFromTailwindConfig(`colors: ${'{'.repeat(5000)}`, { tier: 2, label: 'x' });
    assert.ok(Date.now() - t < 3000);
  });

  it('chooses repository files to read: tokens and theme files first, never node_modules or tests', () => {
    const picks = pickBrandFiles(['node_modules/x/tailwind.config.js', 'src/app/globals.css', 'tailwind.config.ts', 'design-tokens/colors.json', 'src/styles/theme.css', 'test/theme.css', 'README.md', 'src/main.tsx']);
    assert.deepEqual(picks.map((p) => p.path), ['design-tokens/colors.json', 'tailwind.config.ts', 'src/styles/theme.css', 'src/app/globals.css']);
  });
});

// ---- images -----------------------------------------------------------------------------------------------------------------------------------

describe('logo and image colors (local, deterministic)', () => {
  it('finds the artwork colors on a transparent canvas: blue is primary, the small orange square is the next distinct color', async () => {
    const r = await readLogoBrand(blueOrangeOnTransparent);
    assert.equal(r.status, 'ok');
    const p = r.candidates.find((c) => c.role === 'primary')!;
    assert.ok(Math.abs(parseInt(p.hex.slice(5, 7), 16) - 0xff) < 30 && parseInt(p.hex.slice(1, 3), 16) < 40, p.hex);
    const s = r.candidates.find((c) => c.role === 'secondary')!;
    assert.ok(parseInt(s.hex.slice(1, 3), 16) > 200 && parseInt(s.hex.slice(5, 7), 16) < 60, s.hex);
  });

  it('a logo on a large white canvas: white is the background, not a brand color', async () => {
    const ic = (await readImageColors(blueOrangeOnWhite))!;
    assert.equal(ic.background, '#ffffff');
    const r = await readLogoBrand(blueOrangeOnWhite);
    assert.ok(!r.candidates.some((c) => c.hex === '#ffffff'));
    assert.ok(r.candidates.every((c) => c.role !== 'primary' || c.hex !== '#ffffff'));
    assert.ok(r.candidates.find((c) => c.role === 'primary'), 'the blue is the primary color');
  });

  it('works for a very small logo and for a logo with no chromatic color (a black wordmark)', async () => {
    const t = await readLogoBrand(tinyLogo);
    assert.equal(t.candidates.find((c) => c.role === 'primary')?.hex.slice(1, 3).length, 2);
    assert.ok(parseInt(t.candidates.find((c) => c.role === 'primary')!.hex.slice(1, 3), 16) > 200, 'pink/red stays primary');
    const w = await readLogoBrand(blackWordmark);
    const p = w.candidates.find((c) => c.role === 'primary');
    assert.ok(p && parseInt(p.hex.slice(1, 3), 16) < 40, 'a black logo is a black brand, at low weight');
    assert.ok(p!.weight <= 0.4);
  });

  it('merges near-duplicates and drops anti-aliasing blends', async () => {
    const edge = await png({ r: 255, g: 255, b: 255, alpha: 1 }, '<circle cx="100" cy="100" r="60" fill="#0A5CFF" stroke="#ffffff" stroke-width="1.5"/>');
    const ic = (await readImageColors(edge))!;
    const cands = candidatesFromImage(ic, { tier: 3, label: 'Logo', strong: 0.85 });
    assert.equal(cands.filter((c) => c.role !== 'text').length, 1, cands.map((c) => c.hex).join(','));
  });

  it('refuses SVG, PDF and garbage: palettes are read only from real pixels', async () => {
    assert.equal(await readImageColors(svg('<rect width="10" height="10" fill="red"/>')), null);
    assert.equal(await readImageColors(Buffer.from('not an image at all, just text')), null);
    assert.equal((await readLogoBrand(Buffer.from('%PDF-1.7 ....................'))).status, 'failed');
    assert.equal((await readLogoBrand(null)).status, 'unavailable');
  });

  it('uploaded pictures are low-priority evidence (tier 6)', async () => {
    const r = await readImagesBrand([{ name: 'team.png', data: blueOrangeOnWhite }]);
    assert.ok(r.candidates.length > 0 && r.candidates.every((c) => c.tier === 6));
  });
});

// ---- the website (a local fixture server; the loopback allowance exists only for tests) --------------------------------------------------------------------

describe('website brand extraction', () => {
  let server: http.Server;
  let port: number;
  let robots = 'User-agent: *\nAllow: /\n';
  const hits: string[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
      if (req.url === '/site.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
      if (req.url === '/logo.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(blueOrangeOnTransparent);
      if (req.url === '/captcha') return void res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }).end('<title>Just a moment...</title>');
      if (req.url === '/empty') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>hello</body></html>');
      if (req.url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(HTML);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());
  const fetcher = () => new WebFetchTool({ policy: { allowedPorts: new Set([port]), allowLoopbackForTests: true }, timeoutMs: 3000, maxPages: 2, maxAssets: 5 });

  it('reads declared tokens, buttons, theme-color and the same-site logo; cross-origin framework CSS is not fetched', async () => {
    hits.length = 0;
    const r = await readWebsiteBrand(`http://127.0.0.1:${port}/`, { fetcher: fetcher() });
    assert.equal(r.status, 'ok');
    const hexes = new Set(r.candidates.map((c) => c.hex));
    for (const h of ['#0a5cff', '#ff7a00', '#ffffff', '#1a1a2e']) assert.ok(hexes.has(h), `${h} in ${[...hexes].join(',')}`);
    assert.ok(!hexes.has('#ff00ff'), 'the dark-mode color is not the brand');
    assert.ok(hits.includes('/site.css') && hits.includes('/logo.png'));
    assert.ok(!hits.some((h) => h.includes('bootstrap')), 'a stylesheet from another site is never requested');
    assert.ok(r.candidates.some((c) => c.evidence.startsWith('Website') && !/<|>/.test(c.evidence)));
  });

  it('honors robots.txt: a disallowed site is not read and says so', async () => {
    robots = 'User-agent: *\nDisallow: /\n';
    const r = await readWebsiteBrand(`http://127.0.0.1:${port}/`, { fetcher: fetcher() });
    robots = 'User-agent: *\nAllow: /\n';
    assert.equal(r.status, 'blocked');
    assert.match(r.message ?? '', /robots\.txt/);
    assert.equal(r.candidates.length, 0);
  });

  it('reports bot protection instead of guessing, and an empty page as empty', async () => {
    const blocked = await readWebsiteBrand(`http://127.0.0.1:${port}/captcha`, { fetcher: fetcher() });
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.message ?? '', /bot protection|Cloudflare/i);
    const empty = await readWebsiteBrand(`http://127.0.0.1:${port}/empty`, { fetcher: fetcher() });
    assert.equal(empty.status, 'empty');
  });

  it('SSRF: loopback, private, metadata, credentials, file and odd ports are refused before any request', async () => {
    const sentBefore = hits.length;
    for (const u of ['http://127.0.0.1/', 'http://localhost:4000/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://example.com:22/', 'http://0x7f000001/']) {
      const r = await readWebsiteBrand(u);
      assert.equal(r.status, 'blocked', u);
      assert.equal(r.candidates.length, 0);
    }
    assert.equal(hits.length, sentBefore);
  });
});

// ---- the repository (a fake GitHub API) ------------------------------------------------------------------------------------------------------------------

function fakeGitHub(files: Record<string, string>, opts: { notFound?: boolean } = {}) {
  const tree = Object.keys(files).map((path) => ({ path, type: 'blob' }));
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-ratelimit-remaining': '50', 'content-type': 'application/json' } });
    if (opts.notFound) return json({ message: 'Not Found' }, 404);
    const p = u.pathname.replace(/^\/repos\/acme\/site/, '');
    if (p === '') return json({ full_name: 'acme/site', default_branch: 'main', description: 'x', topics: [], pushed_at: null });
    if (p === '/readme') return json(null, 404);
    if (p === '/languages') return json({ TypeScript: 100 });
    if (p === '/contents') return json(Object.keys(files).filter((k) => !k.includes('/')).map((name) => ({ name, type: 'file' })));
    if (p.startsWith('/git/trees/')) return json({ tree, truncated: false });
    if (p.startsWith('/contents/')) {
      const path = decodeURIComponent(p.slice('/contents/'.length));
      return files[path] === undefined ? json(null, 404) : json({ path, encoding: 'base64', size: files[path].length, content: Buffer.from(files[path]).toString('base64') });
    }
    return json({}, 404);
  };
  return { fetch: f, calls };
}

describe('repository brand extraction', () => {
  const FILES = {
    'package.json': '{"name":"site"}',
    'tailwind.config.ts': "export default { theme: { extend: { colors: { brand: { DEFAULT: '#0a5cff' }, accent: '#ff7a00' } } } }",
    'src/styles/theme.css': ':root{ --primary: #0a5cff; --background: #fafafa; --foreground: #111827 }',
    'src/components/Button.tsx': 'export const x = 1; // #ff0000',
    'node_modules/pkg/tailwind.config.js': "module.exports={colors:{primary:'#ff00ff'}}",
  };

  it('reads theme files of a public repository through the API only; evidence names the file', async () => {
    const gh = fakeGitHub(FILES);
    const r = await readRepositoryBrand('https://github.com/acme/site', { tool: new GitHubRepositoryTool({ fetch: gh.fetch, maxCalls: 20 }) });
    assert.equal(r.status, 'ok');
    const primary = r.candidates.filter((c) => c.role === 'primary');
    assert.ok(primary.some((c) => c.hex === '#0a5cff' && /tailwind\.config\.ts|theme\.css/.test(c.evidence)));
    assert.ok(r.candidates.some((c) => c.role === 'accent' && c.hex === '#ff7a00'));
    assert.ok(!r.candidates.some((c) => c.hex === '#ff00ff' || c.hex === '#ff0000'), 'node_modules and component source are not read');
    assert.ok(gh.calls.every((c) => c.startsWith('/repos/acme/site')), 'only the official API of the named repository is called');
    assert.ok(!gh.calls.some((c) => c.includes('node_modules') || c.includes('Button.tsx')));
  });

  it('a private or missing repository is not read and says why; a non-GitHub address is refused without any request', async () => {
    const gh = fakeGitHub(FILES, { notFound: true });
    const r = await readRepositoryBrand('https://github.com/acme/site', { tool: new GitHubRepositoryTool({ fetch: gh.fetch }) });
    assert.equal(r.status, 'blocked');
    assert.match(r.message ?? '', /not public|not found/i);
    const bad = fakeGitHub(FILES);
    const b = await readRepositoryBrand('https://evil.example.com/acme/site', { tool: new GitHubRepositoryTool({ fetch: bad.fetch }) });
    assert.equal(b.status, 'blocked');
    assert.equal(bad.calls.length, 0);
  });

  it('a repository with no theme file is reported as empty, not guessed', async () => {
    const gh = fakeGitHub({ 'package.json': '{}', 'src/main.ts': 'x' });
    const r = await readRepositoryBrand('https://github.com/acme/site', { tool: new GitHubRepositoryTool({ fetch: gh.fetch }) });
    assert.equal(r.status, 'empty');
  });
});

// ---- the suggestion: precedence, conflicts, fallbacks, readability ------------------------------------------------------------------------------------------

const reading = (source: BrandReading['source'], tier: 2 | 3 | 4 | 5 | 6, items: [BrandReading['candidates'][number]['role'], string, number?][], label: string = source): BrandReading => ({
  source,
  label,
  status: 'ok',
  message: null,
  candidates: items.map(([role, hex, weight]) => ({ role, hex, tier, weight: weight ?? 0.8, evidence: `${label}: ${role}` })),
});

describe('palette suggestion', () => {
  it('explicit colors of the user take precedence over every source', () => {
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [reading('website', 2, [['primary', '#0a5cff']]), reading('logo', 3, [['primary', '#ff7a00']])], explicit: { primary: '#123456' } });
    assert.equal(s.palette.primary, '#123456');
    assert.equal(s.evidence.primary.source, 'user');
    assert.equal(s.evidence.primary.confidence, 'high');
  });

  it('declared design tokens beat the logo, the logo beats visible website styling; the order is reported', () => {
    const tokens = reading('repository', 2, [['primary', '#0a5cff']]);
    const logo = reading('logo', 3, [['primary', '#0a5cff'], ['secondary', '#ff7a00', 0.7]]);
    const site = reading('website', 4, [['secondary', '#00aa55', 0.75]]);
    const s = suggestPalette({ collectionId: 'bold_startup', readings: [site, logo, tokens] });
    assert.equal(s.palette.primary, '#0a5cff');
    assert.equal(s.evidence.primary.confidence, 'high');
    assert.equal(s.palette.secondary, '#ff7a00', 'the logo (tier 3) outranks the website (tier 4)');
    assert.equal(s.evidence.secondary.source, 'logo');
  });

  it('conflicting credible sources are REPORTED next to the choice and lower the confidence', () => {
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [reading('website', 2, [['primary', '#0a5cff', 0.9]], 'Website'), reading('logo', 3, [['primary', '#e91e63', 0.85]], 'Logo')] });
    assert.equal(s.conflicts.length, 1);
    assert.equal(s.conflicts[0].role, 'primary');
    assert.equal(s.conflicts[0].chosen.hex, '#0a5cff');
    assert.deepEqual(s.conflicts[0].alternatives.map((a) => a.hex), ['#e91e63']);
    assert.match(s.conflicts[0].message, /Logo.*#e91e63/);
    assert.notEqual(s.evidence.primary.confidence, 'high');
  });

  it('agreeing sources raise confidence', () => {
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [reading('website', 4, [['primary', '#0a5cff', 0.75]]), reading('logo', 3, [['primary', '#0b5bfe', 0.85]])] });
    assert.equal(s.conflicts.length, 0);
    assert.equal(s.evidence.primary.confidence, 'high');
    assert.match(s.evidence.primary.evidence, /also seen in/);
  });

  it('missing sources fall back to the collection default and say so (nothing is invented as brand)', () => {
    const s = suggestPalette({ collectionId: 'luxury_hospitality', readings: [] });
    assert.deepEqual(s.palette, { primary: '#14342b', secondary: '#0d1b17', accent: '#c9a24b', background: '#f6f1e7', text: '#14201c' });
    assert.deepEqual(s.fallbackRoles, ['primary', 'secondary', 'accent', 'background', 'text']);
    for (const r of Object.values(s.evidence)) assert.deepEqual([r.source, r.confidence], ['collection_default', 'low']);
    assert.ok(s.notes.some((n) => /collection default/i.test(n)));
    assert.ok(s.check.ok);
  });

  it('a source that failed is listed with its reason and does not stop the others', () => {
    const failed: BrandReading = { source: 'website', label: 'Website', status: 'blocked', message: 'robots.txt does not allow it', candidates: [] };
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [failed, reading('logo', 3, [['primary', '#0a5cff']])] });
    assert.equal(s.palette.primary, '#0a5cff');
    assert.deepEqual(s.readings.map((r) => [r.source, r.status]), [['website', 'blocked'], ['logo', 'ok']]);
    assert.match(s.readings[0].message ?? '', /robots/);
  });

  it('text that cannot be read on the suggested background is corrected only when that color was merely a default', () => {
    const s = suggestPalette({ collectionId: 'minimal_tech', readings: [reading('website', 4, [['background', '#0b1020', 0.7]])] });
    assert.ok(s.check.ratios.textOnBackground >= 4.5, String(s.check.ratios.textOnBackground));
    assert.equal(s.evidence.background.source, 'website');
    assert.ok(s.notes.some((n) => /readability/.test(n)));
    // two real brand colors that cannot be read together are KEPT and reported, not silently changed
    const bad = suggestPalette({ collectionId: 'minimal_tech', readings: [reading('website', 4, [['background', '#f0f0f0', 0.7], ['text', '#e0e0e0', 0.7]])] });
    assert.equal(bad.palette.text, '#e0e0e0');
    assert.equal(bad.check.ok, false);
    assert.match(bad.check.errors[0], /contrast/);
  });
});

describe('palette contrast and the fit of a palette to a collection', () => {
  it('validates readable text; near-duplicates of the background are reported', () => {
    assert.equal(checkPalette({ primary: '#0a5cff', secondary: '#111827', accent: '#14b8a6', background: '#ffffff', text: '#0f1419' }).ok, true);
    const bad = checkPalette({ primary: '#7f7f7f', secondary: '#111827', accent: '#7a7a7a', background: '#ffffff', text: '#cccccc' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /text color/.test(e)));
    assert.equal(checkPalette({ primary: '#7f7f7f', secondary: '#111827', accent: '#7a7a7a', background: '#ffffff', text: '#101010' }).ok, true, 'a button or panel in any color still gets a readable label');
    assert.ok(checkPalette({ primary: '#0a5cff', secondary: '#111', accent: '#0a5cfe', background: '#0a5cff', text: '#ffffff' }).warnings.length > 0);
  });

  it('explains a conflict between a palette and a collection without blocking it', () => {
    const vivid = { primary: '#ff0066', secondary: '#00ccff', accent: '#ffee00', background: '#0b1020', text: '#ffffff' };
    const fit = paletteFit('premium_editorial', vivid);
    assert.equal(fit.ok, true, 'readable, so allowed');
    assert.ok(fit.notes.some((n) => /light backgrounds/.test(n)));
    assert.ok(fit.notes.some((n) => /hue/.test(n)));
    assert.ok(fit.notes.some((n) => /muted/.test(n)));
  });
});

describe('user edits are never lost', () => {
  it('changing the collection keeps edited and brand colors and only replaces colors that were merely defaults', () => {
    let d = newDesign('minimal_tech');
    d = applyDetectedPalette(d, { palette: { ...d.palette, primary: '#0a5cff' }, evidence: { ...d.paletteEvidence, primary: { source: 'website', confidence: 'high', evidence: 'Website: variable --primary' } } });
    d = editPaletteRole(d, 'accent', '#ff7a00');
    const sw = switchCollection(d, 'soft_organic');
    assert.equal(sw.design.collectionId, 'soft_organic');
    assert.equal(sw.design.palette.primary, '#0a5cff', 'brand color kept');
    assert.equal(sw.design.palette.accent, '#ff7a00', 'manual edit kept');
    assert.equal(sw.design.palette.background, '#faf5ee', 'a default follows the new collection');
    assert.deepEqual(sw.design.overridden, ['accent']);
    assert.equal(sw.design.confirmed, false, 'a changed design must be confirmed again');
    assert.ok(sw.notes.length >= 2);
  });

  it('a new analysis does not overwrite colors the user edited; reset restores the detected or default colors', () => {
    let d = editPaletteRole(newDesign('bold_startup'), 'primary', '#123456');
    const detected = { palette: { primary: '#0a5cff', secondary: '#111111', accent: '#ff7a00', background: '#ffffff', text: '#222222' }, evidence: newDesign('bold_startup').paletteEvidence };
    d = applyDetectedPalette(d, detected);
    assert.equal(d.palette.primary, '#123456');
    assert.equal(d.palette.accent, '#ff7a00');
    const reset = resetPalette(d, detected, ['primary']);
    assert.equal(reset.palette.primary, '#0a5cff');
    assert.deepEqual(reset.overridden, []);
    assert.equal(resetPalette(d, null).palette.primary, '#ff4d1c', 'no analysis: the collection default');
  });

  it('refuses an invalid color', () => {
    assert.throws(() => editPaletteRole(newDesign('minimal_tech'), 'primary', 'blue'), /valid color/);
  });
});

describe('brand documents', () => {
  it('reads guideline text of uploaded documents and says when none names a color', () => {
    assert.equal(readGuidelinesBrand([]).status, 'unavailable');
    assert.equal(readGuidelinesBrand([{ name: 'x.txt', text: 'no colors here' }]).status, 'empty');
    const r = readGuidelinesBrand([{ name: 'brand.txt', text: 'Primary: #0A5CFF' }]);
    assert.equal(r.status, 'ok');
    assert.equal(r.candidates[0].tier, 2);
  });
});
