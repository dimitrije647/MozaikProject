import type { LandingContent } from './schemas';

/**
 * Local campaign landing-page PREVIEW. The HTML is built from a fixed template: every piece of model-written text is
 * HTML-escaped and placed as TEXT, never as markup, so a model (or a prompt-injected page) cannot add tags, scripts, links
 * or styles. The document also carries a Content-Security-Policy that forbids scripts and any external resource, and the UI
 * shows it in a sandboxed iframe. Nothing is deployed anywhere.
 */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const color = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

export function renderLandingHtml(content: LandingContent, opts: { name: string; language: string; palette: string[] }): string {
  const accent = color(opts.palette[0], '#2563eb');
  const lang = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(opts.language) ? opts.language : 'en';
  const li = (items: string[]) => items.map((t) => `<li>${esc(t)}</li>`).join('');
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${esc(content.seoTitle)}</title><meta name="description" content="${esc(content.metaDescription)}">
<style>
:root{--accent:${accent}}*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Arial,Helvetica,'DejaVu Sans',sans-serif;color:#1b1b1f;background:#fff;line-height:1.55}
header{background:#101828;color:#fff;padding:72px 24px;text-align:center}h1{font-size:clamp(28px,5vw,48px);margin:0 0 16px}header p{max-width:640px;margin:0 auto 28px;font-size:18px;opacity:.9}
.cta{display:inline-block;background:var(--accent);color:#fff;padding:14px 28px;border-radius:999px;font-weight:700;text-decoration:none}
main{max-width:880px;margin:0 auto;padding:40px 24px}section{margin:0 0 44px}h2{font-size:26px;margin:0 0 14px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.card{border:1px solid #e5e7eb;border-radius:14px;padding:18px}.card h3{margin:0 0 6px;font-size:17px}
ol,ul{padding-left:22px}details{border-bottom:1px solid #e5e7eb;padding:10px 0}summary{cursor:pointer;font-weight:600}.note{font-size:12px;color:#6b7280}footer{text-align:center;padding:36px 24px;background:#f3f4f6}
</style></head><body>
<header><h1>${esc(content.hero.headline)}</h1><p>${esc(content.hero.description)}</p><a class="cta" href="#contact">${esc(content.hero.ctaText)}</a></header>
<main>
<section><h2>${esc(opts.name)}</h2><p>${esc(content.valueProposition)}</p></section>
${content.benefits.length ? `<section><h2>Benefits</h2><div class="grid">${content.benefits.map((b) => `<div class="card"><h3>${esc(b.title)}</h3><p>${esc(b.text)}</p></div>`).join('')}</div></section>` : ''}
${content.sections.map((s) => `<section><h2>${esc(s.title)}</h2><p>${esc(s.body)}</p></section>`).join('')}
${content.howItWorks.length ? `<section><h2>How it works</h2><ol>${content.howItWorks.map((h) => `<li><strong>${esc(h.step)}</strong> ${esc(h.text)}</li>`).join('')}</ol></section>` : ''}
${content.trustSignals.length ? `<section><h2>Why trust us</h2><ul>${li(content.trustSignals.map((t) => t.text))}</ul></section>` : ''}
${content.faq.length ? `<section><h2>FAQ</h2>${content.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>` : ''}
</main>
<footer id="contact">${content.ctas.map((c) => `<a class="cta" href="#contact">${esc(c.text)}</a>`).join(' ')}<p class="note">Campaign landing page preview. Not published anywhere.</p></footer>
</body></html>`;
}
