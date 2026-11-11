import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { renderTemplate } from '../templates/render';
import { brandWordsOf, confidenceLabel, logosOfHtml, logosOfTree, logosOfUploads, rankLogoCandidates, type LogoCandidateInfo } from './logo-discovery';
import { rasterizeSvg, sanitizeSvg } from './svg';

// GET CONTENT: logo discovery is deterministic (no model) and never downloads anything.

const SITE = 'https://bluereef.example/';
const brand = brandWordsOf('Blue Reef Diving School', 'bluereef.example');

const HOME = `<!doctype html><html><head><title>Blue Reef Diving School</title>
  <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Blue Reef","logo":"https://bluereef.example/brand/blue-reef-logo.png"}</script></head>
  <body><header><a href="/"><img src="/img/site-logo.svg" alt="Blue Reef Diving School" class="navbar-brand" width="180" height="48"></a><nav><a href="/courses">Courses</a></nav></header>
  <main><img src="/img/reef-photo.jpg" alt="Divers over a coral reef" width="1600" height="1000">
  <section class="partners"><h3>Our partners</h3><img src="/img/partner-logo-padi.png" alt="PADI partner logo" width="120" height="60"><img src="/img/client-logos.png" alt="Our clients" width="400" height="80"></section></main>
  <footer><img src="/img/footer-logo.png" alt="logo" class="logo" width="90" height="30"><img src="/social/facebook-logo.png" alt="Facebook" width="32" height="32"></footer></body></html>`;

describe('logo discovery: website', () => {
  const logos = logosOfHtml(HOME, SITE, brand);
  const by = (frag: string) => logos.find((l) => l.location.includes(frag));

  it('recognizes structured-data and header logos and ranks them above everything else', () => {
    assert.ok(by('/brand/blue-reef-logo.png'), 'the structured-data logo');
    assert.ok(by('/img/site-logo.svg'), 'the header logo');
    assert.equal(logos[0].favicon, false);
    assert.ok(logos[0].confidence >= 0.8, `${logos[0].location} ${logos[0].confidence}`);
    assert.match(by('/brand/blue-reef-logo.png')!.signals.join(' '), /structured data/);
    assert.match(by('/img/site-logo.svg')!.signals.join(' '), /header/);
    assert.equal(by('/img/site-logo.svg')!.svg, true);
    assert.ok(by('/img/site-logo.svg')!.signals.includes('names the business'), 'its alt text names the business');
    assert.equal(confidenceLabel(by('/img/site-logo.svg')!.confidence), 'high');
  });

  it('an ordinary photograph is not a logo candidate', () => {
    assert.equal(by('reef-photo.jpg'), undefined);
  });

  it('a file name with "logo" in it is not enough: partner, client and social marks are penalized or left out', () => {
    for (const frag of ['partner-logo-padi', 'client-logos', 'facebook-logo']) {
      const c = by(frag);
      assert.ok(!c || c.confidence < 0.4, `${frag} ${c?.confidence}`);
    }
    assert.ok(by('partner-logo-padi')?.signals.join(' ').match(/partner, client or social/));
    assert.ok(by('footer-logo.png')!.confidence < by('/img/site-logo.svg')!.confidence, 'a footer logo ranks below the header logo');
  });

  it('the favicon is a candidate of last resort: capped below "medium" and never primary', () => {
    const icons = logos.filter((l) => l.favicon);
    assert.ok(icons.length >= 2, 'favicon.ico and the apple touch icon are listed');
    for (const i of icons) assert.ok(i.confidence <= 0.35, `${i.location} ${i.confidence}`);
    assert.equal(confidenceLabel(icons[0].confidence), 'low');
    const ranked = rankLogoCandidates(logos);
    assert.equal(ranked[0].favicon, false);
    assert.ok(ranked.slice(-icons.length).every((c) => c.favicon), 'every favicon is after every real logo');
  });
});

describe('logo discovery: repository and uploads', () => {
  const tree = [
    { path: 'public/logo.svg', size: 4_200 },
    { path: 'public/brand/blue-reef-logo.png', size: 38_000 },
    { path: 'public/images/react-logo.svg', size: 2_000 },
    { path: 'public/vercel.svg', size: 1_000 },
    { path: 'src/assets/partners/padi-logo.png', size: 9_000 },
    { path: 'public/favicon.png', size: 5_000 },
    { path: 'public/hero.jpg', size: 400_000 },
    { path: 'node_modules/x/logo.png', size: 9_000 },
  ];
  const found = logosOfTree(tree, { owner: 'acme', repo: 'blue-reef-site', ref: 'main', brand });

  it('finds the logo files, prefers the plain "logo" and the brand-named one, and ignores third-party and technology marks', () => {
    const top = found.slice(0, 2).map((c) => c.location);
    assert.ok(top.includes('public/logo.svg') && top.includes('public/brand/blue-reef-logo.png'), top.join(','));
    assert.ok(found.find((c) => c.location === 'public/logo.svg')!.confidence >= 0.85);
    const react = found.find((c) => c.location.includes('react-logo'));
    assert.ok(!react || react.confidence < 0.4, 'a technology vendor\'s logo is not the company logo');
    assert.ok(!found.some((c) => /node_modules|partners|hero\.jpg|vercel/.test(c.location)));
    assert.equal(found.find((c) => c.location === 'public/favicon.png')?.favicon ?? true, true);
    assert.ok((found.find((c) => c.location === 'public/favicon.png')?.confidence ?? 0) <= 0.3);
    assert.ok(found[0].pageUrl!.startsWith('https://github.com/acme/blue-reef-site/blob/main/'));
  });

  it('an uploaded logo is the strongest candidate; other uploads qualify only when they look like a logo', () => {
    const ups = logosOfUploads([
      { id: 'a1', type: 'logo', name: 'our mark.png', mimeType: 'image/png', width: 800, height: 300 },
      { id: 'a2', type: 'image', name: 'company-logo-old.jpg', mimeType: 'image/jpeg' },
      { id: 'a3', type: 'image', name: 'team.jpg', mimeType: 'image/jpeg' },
      { id: 'a4', type: 'image', name: 'react-logo.png', mimeType: 'image/png' },
      { id: 'a5', type: 'doc', name: 'logo.pdf', mimeType: 'application/pdf' },
    ]);
    assert.deepEqual(ups.map((u) => u.location), ['a1', 'a2']);
    assert.equal(ups[0].confidence, 1);
    assert.ok(ups[1].confidence < 1);
  });

  it('the final order is: uploaded logo, approved logo, website, repository, other uploads; a weak candidate never wins by its source', () => {
    const mk = (source: LogoCandidateInfo['source'], confidence: number, key: string, favicon = false): LogoCandidateInfo => ({ source, location: key, fileName: key, format: 'png', svg: false, width: null, height: null, confidence, signals: [], favicon, pageUrl: null, key, meta: {} });
    const order = rankLogoCandidates([mk('github', 0.85, 'gh'), mk('website', 0.3, 'weak-web'), mk('website', 0.8, 'web'), mk('approved', 0.9, 'approved'), mk('upload', 1, 'upload'), mk('website', 0.3, 'fav', true), mk('upload', 0.5, 'other-upload')]).map((c) => c.key);
    assert.deepEqual(order.slice(0, 3), ['upload', 'approved', 'web']);
    assert.ok(order.indexOf('gh') < order.indexOf('weak-web'), 'a decent repository logo beats a weak website guess');
    assert.equal(order.at(-1), 'fav');
  });
});

describe('SVG logos are sanitized and rasterized, never used as they are', () => {
  const evil = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="80" viewBox="0 0 200 80" onload="alert(1)">
    <script>fetch('https://evil.example/x')</script><foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
    <style>@import url('https://evil.example/a.css'); .a{fill:url(https://evil.example/p.png)}</style>
    <image href="https://evil.example/pixel.png" width="10" height="10"/><image xlink:href="file:///etc/passwd" width="10" height="10"/>
    <a xlink:href="javascript:alert(1)"><rect x="10" y="10" width="180" height="60" rx="8" fill="#0b3d91" onclick="x()"/></a></svg>`;

  it('removes scripts, handlers, entities, embedded documents and every external reference', () => {
    const r = sanitizeSvg(evil)!;
    assert.ok(r);
    for (const bad of ['<script', 'foreignObject', 'iframe', 'onload', 'onclick', 'evil.example', 'file:///', 'javascript:', '<!ENTITY', '@import']) assert.ok(!r.svg.includes(bad), `still contains ${bad}`);
    assert.ok(r.svg.includes('<rect'), 'the drawing itself survives');
    assert.ok(r.removed.length >= 4);
  });

  it('rasterizes to a PNG of at most 1024 px; a file that is not an SVG, or is too large, is refused', async () => {
    const png = await rasterizeSvg(evil);
    assert.ok(png.ok);
    if (png.ok) {
      const meta = await sharp(png.png).metadata();
      assert.equal(meta.format, 'png');
      assert.ok(Math.max(meta.width!, meta.height!) <= 1024 && Math.max(meta.width!, meta.height!) >= 512);
      assert.equal(Math.round((meta.width! / meta.height!) * 100) / 100, 2.5, 'the aspect ratio of the drawing is kept');
    }
    assert.equal((await rasterizeSvg('<html><body>hello</body></html>')).ok, false);
    assert.equal((await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' + 'x'.repeat(310_000) + '</svg>')).ok, false);
  });
});

describe('the renderer: an APPROVED logo must read, and nothing changes without one', () => {
  const t = TEMPLATE_LIBRARY.find((x) => x.id === 'tech_minimalist')!; // a dark-surface layout whose logo area sits on the page background
  const dark = { ink: '#f4f4f4', paper: '#0d1117' };
  const render = async (logo: Buffer, o: { adapt?: boolean } = {}) => {
    const r = await renderTemplate({ template: t, width: 1080, height: 1080, content: { headline: t.sample.headline, support: t.sample.support ?? undefined, cta: t.sample.cta ?? undefined, eyebrow: t.sample.eyebrow ?? undefined }, palette: ['#0b3d91', '#e4572e'], anchors: dark, brandName: 'Blue Reef', logo, ...(o.adapt ? { logoAdapt: true } : {}) });
    assert.ok(r.ok, r.ok ? '' : r.message);
    return r.ok ? r : (null as never);
  };

  it('a dark mark on a dark background gets a quiet plate (only when the logo is approved); a legible one does not', async () => {
    const darkLogo = await sharp({ create: { width: 600, height: 200, channels: 4, background: '#0a0f1a' } }).png().toBuffer();
    const lightLogo = await sharp({ create: { width: 600, height: 200, channels: 4, background: '#f2f2f2' } }).png().toBuffer();
    const withoutApproval = await render(darkLogo);
    const adapted = await render(darkLogo, { adapt: true });
    const legible = await render(lightLogo, { adapt: true });
    assert.ok(!withoutApproval.flags.includes('logo_plate_added'), 'a campaign without an approved logo renders exactly as before');
    assert.ok(adapted.flags.includes('logo_plate_added'), adapted.flags.join(','));
    assert.ok(!legible.flags.includes('logo_plate_added'));
    assert.notDeepEqual(adapted.png, withoutApproval.png);
    assert.ok(adapted.flags.includes('logo_applied') || !adapted.flags.includes('logo_unreadable'));
    // the default path is byte-identical to the render with the option explicitly off
    const again = await render(darkLogo);
    assert.deepEqual(again.png, withoutApproval.png);
  });
});
