import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderLandingHtml } from './landing-html';
import type { LandingContent } from './schemas';

const content: LandingContent = {
  seoTitle: 'Learn to dive </title><script>alert(1)</script>',
  metaDescription: 'A "quoted" description',
  hero: { headline: 'Hello <img src=x onerror=alert(1)>', description: "It's <b>bold</b>", ctaText: 'Book <now>' },
  valueProposition: 'javascript:alert(1)',
  benefits: [{ title: '<svg onload=alert(1)>', text: 'x', evidence: 'f1', ref: null }],
  sections: [{ title: 'About', body: '<iframe src="https://evil.example"></iframe>' }],
  howItWorks: [{ step: '<a href="https://evil.example">link</a>', text: 'x' }],
  faq: [{ q: 'Q?', a: '<style>body{display:none}</style>' }],
  trustSignals: [{ text: '<script>fetch("https://evil.example")</script>', evidence: 'user', ref: null }],
  ctas: [{ objective: 'learn_more', text: 'Go' }],
  ctaObjective: 'learn_more',
  mobileHierarchy: [],
};

describe('landing page preview HTML', () => {
  it('escapes every model-written string, so no tag, script, link, style or frame from the content survives', () => {
    const html = renderLandingHtml(content, { name: 'Deep <Diving> School', language: 'en', palette: ['#0a5c8c'] });
    for (const bad of ['<script', '<img', '<svg', '<iframe', '<a href="https://evil', '<style>body']) assert.ok(!html.includes(bad), `found ${bad}`);
    // the dangerous strings survive only as inert, escaped TEXT: never inside a tag
    assert.doesNotMatch(html, /<[a-z][^>]*\son\w+=/i);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Deep &lt;Diving&gt; School'));
    assert.ok(html.includes('A &quot;quoted&quot; description'));
    // the only tags present are the template's own
    const tags = [...html.matchAll(/<([a-z0-9]+)[\s>/]/gi)].map((m) => m[1].toLowerCase());
    const allowed = new Set(['!doctype', 'html', 'head', 'meta', 'title', 'style', 'body', 'header', 'h1', 'h2', 'h3', 'p', 'a', 'main', 'section', 'div', 'ol', 'ul', 'li', 'strong', 'details', 'summary', 'footer']);
    for (const t of tags) assert.ok(allowed.has(t), `unexpected tag <${t}>`);
    // every link is an in-page anchor
    for (const m of html.matchAll(/href="([^"]*)"/g)) assert.equal(m[1], '#contact');
  });

  it('section headings and the preview note follow the campaign language; unknown languages fall back to English', () => {
    const sr = renderLandingHtml(content, { name: 'x', language: 'sr', palette: [] });
    for (const label of ['<h2>Prednosti</h2>', '<h2>Kako funkcioniše</h2>', '<h2>Zašto nam verovati</h2>', '<h2>Česta pitanja</h2>', 'Nije objavljeno nigde.']) assert.ok(sr.includes(label), label);
    assert.ok(!sr.includes('<h2>Benefits</h2>'));
    const de = renderLandingHtml(content, { name: 'x', language: 'de', palette: [] });
    assert.ok(de.includes('<h2>Vorteile</h2>') && de.includes('<h2>Häufige Fragen</h2>'));
    const unknown = renderLandingHtml(content, { name: 'x', language: 'xx', palette: [] });
    assert.ok(unknown.includes('<h2>Benefits</h2>') && unknown.includes('Not published anywhere.'));
  });

  it('carries a Content-Security-Policy that forbids scripts and external resources, and only accepts safe palette/lang values', () => {
    const html = renderLandingHtml(content, { name: 'x', language: 'en"><script>', palette: ['red;}body{display:none}', '#00ff00'] });
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"/);
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('--accent:#2563eb'), 'an invalid palette value falls back instead of being injected');
    assert.doesNotMatch(html, /<style>[^<]*display:none/, 'content text never reaches the stylesheet');
    const ok = renderLandingHtml(content, { name: 'x', language: 'sr', palette: ['#0A5C8C'] });
    assert.ok(ok.includes('--accent:#0A5C8C') && ok.includes('<html lang="sr">'));
  });
});
