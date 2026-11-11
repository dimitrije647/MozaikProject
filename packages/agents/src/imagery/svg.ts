import sharp from 'sharp';

/**
 * SVG LOGOS. A logo is very often an SVG, and an SVG is not a picture but a small program-like document: it can carry scripts, event handlers,
 * external references and embedded HTML. LaunchPilot therefore NEVER hands an SVG to the renderer or to a browser as it is. It is
 *
 *   1. size-limited and required to parse as one `<svg>` root,
 *   2. SANITIZED: scripts, `foreignObject`, embedded documents, event handler attributes, external references (anything that is not a same-document `#id`
 *      or an embedded PNG/JPEG/WebP data URI) and `@import` / remote `url()` in styles are removed,
 *   3. rasterized to a PNG by sharp (librsvg), which is what is stored and drawn.
 *
 * The rasterized PNG is the asset; the original SVG text is not kept.
 */

export const MAX_SVG_BYTES = 300_000;

const DROP_ELEMENTS = /<\s*(script|foreignObject|iframe|object|embed|audio|video|canvas|animate|set|animateTransform|animateMotion|handler|listener)\b[\s\S]*?(?:<\/\s*\1\s*>|\/>)/gi;
const SELF_CLOSING_DROP = /<\s*(script|foreignObject|iframe|object|embed|audio|video|canvas|animate|set|handler|listener)\b[^>]*\/?>/gi;

export type SvgResult = { ok: true; png: Buffer; width: number; height: number; removed: string[] } | { ok: false; message: string };

/** The sanitized SVG text (or null when it cannot be an SVG). `removed` says what was taken out, for the record. */
export function sanitizeSvg(text: string): { svg: string; removed: string[] } | null {
  if (text.length > MAX_SVG_BYTES) return null;
  const head = text.replace(/^﻿/, '');
  if (!/<\s*svg\b/i.test(head)) return null;
  const removed: string[] = [];
  let s = head;
  // XML prologue, doctype and entity declarations can pull in external content or expand without bound
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(s)) removed.push('doctype/entity');
  s = s.replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/gi, '').replace(/<!ENTITY[\s\S]*?>/gi, '').replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '');
  if (DROP_ELEMENTS.test(s) || SELF_CLOSING_DROP.test(s)) removed.push('scripts/embedded content');
  DROP_ELEMENTS.lastIndex = 0;
  SELF_CLOSING_DROP.lastIndex = 0;
  s = s.replace(DROP_ELEMENTS, '').replace(SELF_CLOSING_DROP, '');
  // event handlers
  if (/\son[a-z]+\s*=/i.test(s)) removed.push('event handlers');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // references: only a same-document #id or an embedded raster image survives
  s = s.replace(/\s+((?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _a, _q, d1, d2) => {
    const v = String(d1 ?? d2 ?? '').trim();
    if (v.startsWith('#') || /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) return m;
    removed.push('external reference');
    return '';
  });
  // styles: no @import, no remote url()
  s = s.replace(/@import[^;]*;?/gi, () => (removed.push('@import'), ''));
  s = s.replace(/url\(\s*(['"]?)(?!#|data:image\/(?:png|jpe?g|webp);base64,)[^)]*\1\s*\)/gi, () => (removed.push('remote url()'), 'none'));
  // anything left that mentions a scripting scheme
  if (/javascript:|vbscript:/i.test(s)) {
    removed.push('script scheme');
    s = s.replace(/javascript:|vbscript:/gi, '');
  }
  return { svg: s, removed: [...new Set(removed)] };
}

/** Sanitizes and rasterizes an SVG logo to a PNG at most `maxSide` pixels on the long side (default 1024). */
export async function rasterizeSvg(input: Buffer | string, maxSide = 1024): Promise<SvgResult> {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  const clean = sanitizeSvg(text);
  if (!clean) return { ok: false, message: 'The file is not a usable SVG (too large, or not an SVG document).' };
  try {
    const meta = await sharp(Buffer.from(clean.svg), { density: 96, limitInputPixels: 40_000_000 }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return { ok: false, message: 'The SVG has no size.' };
    const k = Math.min(8, maxSide / Math.max(w, h));
    const density = Math.max(72, Math.min(1200, Math.round(96 * k)));
    const out = await sharp(Buffer.from(clean.svg), { density, limitInputPixels: 80_000_000 }).resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
    if (!out.info.width || !out.info.height) return { ok: false, message: 'The SVG could not be rendered.' };
    return { ok: true, png: out.data, width: out.info.width, height: out.info.height, removed: clean.removed };
  } catch {
    return { ok: false, message: 'The SVG could not be rendered.' };
  }
}
