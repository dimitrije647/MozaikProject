import sharp from 'sharp';
import type { FontFamily } from './schema';

/**
 * Text measuring and fitting for the template renderer. Nothing is bundled or downloaded: only system fonts are named, each family
 * with a fallback chain that resolves on Windows, macOS and Linux. Because the final font can differ per machine, widths are
 * MEASURED (a word is rendered once at a reference size and its ink is scanned), cached, and scaled linearly; the chosen layout is
 * then rendered once more and its ink is compared with the layer box, so an overflow is detected, not guessed.
 */

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: "'Segoe UI', 'SF Pro Text', 'Helvetica Neue', Arial, Helvetica, 'DejaVu Sans', 'Liberation Sans', sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', 'DejaVu Serif', 'Liberation Serif', serif",
  display: "Bahnschrift, 'Avenir Next', Futura, 'Trebuchet MS', 'Arial Black', 'Segoe UI', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif",
  condensed: "'Arial Narrow', 'Avenir Next Condensed', 'Roboto Condensed', 'DejaVu Sans Condensed', 'Liberation Sans Narrow', Impact, 'Helvetica Neue', Arial, sans-serif",
  mono: "Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
};

/** Escapes text for use inside SVG/XML and drops characters XML 1.0 forbids (they would make the whole SVG unparsable). */
export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface FontSpec {
  family: FontFamily;
  weight: number;
  italic: boolean;
  /** letter spacing in em */
  tracking: number;
}

export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

// ---- tokens ----------------------------------------------------------------------------------------------------------------------------

const CJK = /[⺀-ㄯ㆐-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{3FFFF}]/u;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

export const isCjkChar = (ch: string) => CJK.test(ch);
export const hasRtl = (s: string) => RTL.test(s);

export interface Tok {
  t: string;
  /** a space precedes this token */
  sp: boolean;
  cjk: boolean;
}

/** Collapses whitespace, removes control characters. */
export function normalizeText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hard cap on how much copy one layer will ever lay out (keeps measuring bounded). Longer text is cut at a word boundary and ends with an ellipsis. */
export function capLength(text: string, max: number): { text: string; cut: boolean } {
  const cps = Array.from(text);
  if (cps.length <= max) return { text, cut: false };
  let head = cps.slice(0, max - 1).join('');
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > max * 0.6) head = head.slice(0, lastSpace);
  return { text: head.replace(/[\s,;:.\-–—]+$/u, '') + '…', cut: true };
}

/** Words split on spaces; CJK characters are their own tokens (they can break anywhere). */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const words = normalizeText(text).split(' ').filter(Boolean);
  words.forEach((word) => {
    let first = true;
    let run = '';
    const pushRun = () => {
      if (run) out.push({ t: run, sp: first && out.length > 0, cjk: false });
      if (run) first = false;
      run = '';
    };
    for (const ch of Array.from(word)) {
      if (isCjkChar(ch)) {
        pushRun();
        out.push({ t: ch, sp: first && out.length > 0, cjk: true });
        first = false;
      } else run += ch;
    }
    pushRun();
  });
  return out;
}

// ---- measuring -------------------------------------------------------------------------------------------------------------------------

const REF = 48;
const ROW = 80;
const PAD = 40;
const CHUNK = 24;
const BATCH = 24;
const EST_EM = 0.58; // the same average glyph width the existing Layout Designer assumes for bold sans
const cache = new Map<string, number>();

const keyOf = (f: FontSpec, s: string) => `${f.family}|${f.weight}|${f.italic ? 1 : 0}|${f.tracking}|${s}`;

function chunksOf(token: string): string[] {
  const cps = Array.from(token);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += CHUNK) out.push(cps.slice(i, i + CHUNK).join(''));
  return out;
}

const fontAttrs = (f: FontSpec, size: number) =>
  `font-family="${FONT_STACKS[f.family]}" font-weight="${f.weight}" font-size="${size}"${f.italic ? ' font-style="italic"' : ''}${f.tracking ? ` letter-spacing="${(f.tracking * size).toFixed(3)}"` : ''}`;

async function measureBatch(strings: string[], f: FontSpec): Promise<void> {
  const longest = Math.max(...strings.map((s) => Array.from(s).length));
  const width = Math.ceil(longest * REF * 1.3 + PAD * 2);
  const height = strings.length * ROW;
  const rows = strings.map((s, i) => `<text x="${PAD}" y="${i * ROW + Math.round(ROW * 0.68)}" ${fontAttrs(f, REF)}>${xmlEscape(s)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="#000">${rows}</g></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  strings.forEach((s, i) => {
    let maxX = -1;
    for (let y = i * ROW; y < (i + 1) * ROW; y++) {
      const base = y * info.width;
      for (let x = info.width - 1; x > maxX; x--) {
        if (data[base + x] > 40) {
          maxX = x;
          break;
        }
      }
    }
    // right edge of the ink measured from the pen origin; + a small right side bearing
    const em = maxX < 0 ? 0 : (maxX + 1 - PAD) / REF + 0.02;
    cache.set(keyOf(f, s), Math.max(0, em));
  });
}

/** Measures every distinct token once (cached across renders). Never throws: unmeasurable tokens fall back to an estimate. */
export async function prepareMeasure(tokens: string[], f: FontSpec): Promise<void> {
  if (cache.size > 30000) cache.clear();
  const need = new Set<string>();
  for (const t of tokens) for (const c of chunksOf(t)) if (!cache.has(keyOf(f, c)) && !Array.from(c).every(isCjkChar)) need.add(c);
  if (!cache.has(keyOf(f, 'x x'))) {
    need.add('x x');
    need.add('xx');
  }
  const list = [...need].sort((a, b) => a.length - b.length);
  for (let i = 0; i < list.length; i += BATCH) {
    try {
      await measureBatch(list.slice(i, i + BATCH), f);
    } catch {
      /* fall back to estimates for this batch */
    }
  }
}

/** Width of a token in em at any size (CJK characters are full-width). */
export function tokenWidth(token: string, f: FontSpec): number {
  let sum = 0;
  for (const c of chunksOf(token)) {
    const cps = Array.from(c);
    if (cps.every(isCjkChar)) {
      sum += cps.length * (1 + f.tracking);
      continue;
    }
    const w = cache.get(keyOf(f, c));
    sum += w ?? cps.length * (EST_EM + f.tracking);
  }
  return sum;
}

export function spaceWidth(f: FontSpec): number {
  const a = cache.get(keyOf(f, 'x x'));
  const b = cache.get(keyOf(f, 'xx'));
  if (a === undefined || b === undefined) return 0.28 + f.tracking;
  return Math.min(0.6, Math.max(0.15, a - b));
}

/** Width in em of a whole line (re-tokenised: used by the trimmer). */
export function lineWidth(line: string, f: FontSpec): number {
  const toks = tokenize(line);
  const sp = spaceWidth(f);
  return toks.reduce((w, t) => w + tokenWidth(t.t, f) + (t.sp ? sp : 0), 0);
}

// ---- wrapping --------------------------------------------------------------------------------------------------------------------------

interface MTok extends Tok {
  w: number;
}

/** Greedy wrap into at most `maxLines` lines no wider than `maxEm`. Null = does not fit. `breakLong` splits a too-wide word with a hyphen. */
export function wrapTokens(toks: MTok[], spaceEm: number, maxEm: number, maxLines: number, breakLong: boolean): string[] | null {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const tok of toks) {
    const addSp = cur && tok.sp;
    const need = (addSp ? spaceEm : 0) + tok.w;
    if (cur && curW + need <= maxEm) {
      cur += (addSp ? ' ' : '') + tok.t;
      curW += need;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = '';
      curW = 0;
      if (lines.length >= maxLines) return null;
    }
    if (tok.w <= maxEm) {
      cur = tok.t;
      curW = tok.w;
      continue;
    }
    if (!breakLong) return null;
    const cps = Array.from(tok.t);
    const per = tok.w / cps.length;
    let rest = cps;
    for (;;) {
      const n = Math.max(1, Math.floor((maxEm - 0.4) / per));
      if (rest.length <= n) {
        cur = rest.join('');
        curW = rest.length * per;
        break;
      }
      lines.push(rest.slice(0, n).join('') + '-');
      if (lines.length >= maxLines) return null;
      rest = rest.slice(n);
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

// ---- drawing ---------------------------------------------------------------------------------------------------------------------------

export interface TextBlockSpec {
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  size: number;
  lineHeight: number;
  align: Align;
  valign: VAlign;
  font: FontSpec;
  fill: string;
  underline?: boolean;
}

/** SVG text elements for already-wrapped lines laid out inside a box. `block` is the rectangle the lines occupy. */
export function textBlockSvg(lines: string[], b: TextBlockSpec): { svg: string; block: { y: number; h: number } } {
  const lh = b.size * b.lineHeight;
  const blockH = lines.length * lh;
  const top = b.valign === 'top' ? b.boxY : b.valign === 'middle' ? b.boxY + (b.boxH - blockH) / 2 : b.boxY + b.boxH - blockH;
  const ls = b.font.tracking * b.size;
  const anchor = b.align === 'left' ? 'start' : b.align === 'center' ? 'middle' : 'end';
  const x = (b.align === 'left' ? b.boxX : b.align === 'center' ? b.boxX + b.boxW / 2 + ls / 2 : b.boxX + b.boxW + ls).toFixed(2);
  const els = lines
    .map((line, i) => {
      const y = (top + i * lh + lh / 2 + b.size * 0.35).toFixed(2);
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" ${fontAttrs(b.font, b.size)} fill="${b.fill}"${b.underline ? ' text-decoration="underline"' : ''}>${xmlEscape(line)}</text>`;
    })
    .join('');
  return { svg: els, block: { y: top, h: blockH } };
}

/** Renders the lines alone with a margin around the box and reports whether ink escapes the box (beyond a small tolerance). */
export async function inkOverflows(lines: string[], b: TextBlockSpec): Promise<boolean> {
  const M = Math.ceil(b.size * 1.5) + 4;
  const w = Math.ceil(b.boxW + M * 2);
  const h = Math.ceil(b.boxH + M * 2);
  if (w * h > 36_000_000) return false;
  const { svg } = textBlockSvg(lines, { ...b, boxX: M, boxY: M, fill: '#000000' });
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svg}</svg>`;
  try {
    const { data, info } = await sharp(Buffer.from(doc)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let maxX = -1;
    let minY = info.height;
    let maxY = -1;
    for (let y = 0; y < info.height; y++) {
      const base = y * info.width;
      for (let x = 0; x < info.width; x++) {
        if (data[base + x] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return false;
    const tol = Math.max(2, b.size * 0.12);
    return minX < M - tol || maxX + 1 > M + b.boxW + tol || minY < M - tol || maxY + 1 > M + b.boxH + tol;
  } catch {
    return false;
  }
}

// ---- fitting ---------------------------------------------------------------------------------------------------------------------------

export interface FitInput {
  text: string;
  font: FontSpec;
  lineHeight: number;
  boxW: number;
  boxH: number;
  maxPx: number;
  minPx: number;
  maxLines: number;
  align: Align;
  valign: VAlign;
  /** skip the render-and-test pass (used for tiny labels where it is not worth it) */
  noVerify?: boolean;
}

export interface FitResult {
  lines: string[];
  size: number;
  /** pixel width of each line (estimated from measured tokens) */
  widths: number[];
  shrunk: boolean;
  /** text was cut and ends with an ellipsis */
  trimmed: boolean;
  /** a word wider than the box was split with a hyphen (only at the smallest size) */
  hyphenated: boolean;
}

const WIDTH_SAFETY = 1.015;

/** Cuts a line so that line + "…" fits `maxEm`: whole words first, then characters. */
function ellipsize(line: string, f: FontSpec, maxEm: number): string {
  const ell = 1.0;
  let toks = tokenize(line);
  const sp = spaceWidth(f);
  const width = (ts: Tok[]) => ts.reduce((w, t) => w + tokenWidth(t.t, f) + (t.sp ? sp : 0), 0);
  while (toks.length > 1 && width(toks) + ell > maxEm) toks = toks.slice(0, -1);
  let str = toks.map((t, i) => (t.sp && i > 0 ? ' ' : '') + t.t).join('');
  while (Array.from(str).length > 1 && width(tokenize(str)) + ell > maxEm) str = Array.from(str).slice(0, -1).join('');
  return str.replace(/[\s,;:.\-–—]+$/u, '') + '…';
}

/** Largest size in [minPx, maxPx] at which `text` wraps into <= maxLines lines inside the box; trims with an ellipsis only at minPx. */
export async function fitText(inp: FitInput): Promise<FitResult | null> {
  const text = normalizeText(inp.text);
  if (!text) return null;
  const f = inp.font;
  const maxPx = Math.max(4, Math.round(inp.maxPx));
  const minPx = Math.max(4, Math.min(maxPx, Math.round(inp.minPx)));
  const toks = tokenize(text);
  await prepareMeasure(toks.filter((t) => !t.cjk).map((t) => t.t), f);
  const mt: MTok[] = toks.map((t) => ({ ...t, w: tokenWidth(t.t, f) }));
  const sp = spaceWidth(f);
  const spec = (size: number): TextBlockSpec => ({ boxX: 0, boxY: 0, boxW: inp.boxW, boxH: inp.boxH, size, lineHeight: inp.lineHeight, align: inp.align, valign: inp.valign, font: f, fill: '#000000' });
  const widthsPx = (lines: string[], size: number) => lines.map((l) => lineWidth(l, f) * size);
  const wrapAt = (size: number, breakLong: boolean, maxLines: number) => wrapTokens(mt, sp, inp.boxW / (size * WIDTH_SAFETY), maxLines, breakLong);

  // candidate sizes from large to small (a few percent apart)
  const step = Math.max(1, Math.round(maxPx * 0.035));
  const sizes: number[] = [];
  for (let s = maxPx; s > minPx; s -= step) sizes.push(s);
  sizes.push(minPx);

  /** Same number of lines, as even as possible (like CSS `text-wrap: balance`): no one-word last lines. */
  const balanced = (lines: string[], size: number): string[] => {
    if (lines.length < 2) return lines;
    let best = lines;
    let lo = 0.25;
    let hi = 1;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      const w = wrapTokens(mt, sp, (inp.boxW * mid) / (size * WIDTH_SAFETY), inp.maxLines, false);
      if (w && w.length === lines.length) {
        best = w;
        hi = mid;
      } else lo = mid;
    }
    return best;
  };

  for (const size of sizes) {
    const greedy = wrapAt(size, false, inp.maxLines);
    if (!greedy || greedy.length * size * inp.lineHeight > inp.boxH * 1.001) continue;
    const lines = balanced(greedy, size);
    if (!inp.noVerify && (await inkOverflows(lines, spec(size)))) continue;
    return { lines, size, widths: widthsPx(lines, size), shrunk: size < maxPx, trimmed: false, hyphenated: false };
  }

  // at the smallest size: hyphenate a too-long word, keep what fits the box height, finish with an ellipsis
  const heightLines = Math.max(1, Math.floor((inp.boxH * 1.001) / (minPx * inp.lineHeight)));
  const allowed = Math.max(1, Math.min(inp.maxLines, heightLines));
  const maxEm = inp.boxW / (minPx * WIDTH_SAFETY);
  const all = wrapTokens(mt, sp, maxEm, 10_000, true) ?? [text];
  let lines = all.slice(0, allowed);
  if (all.length > allowed) lines[lines.length - 1] = ellipsize(lines[lines.length - 1], f, maxEm);
  for (let attempt = 0; attempt < 6 && !inp.noVerify && (await inkOverflows(lines, spec(minPx))); attempt++) {
    const last = lines[lines.length - 1].replace(/…$/, '');
    lines = [...lines.slice(0, -1), ellipsize(last, f, maxEm * (0.92 - attempt * 0.08))];
  }
  const cut = all.length > allowed || lines.some((l) => l.endsWith('…'));
  const hyphenated = lines.some((l, i) => i < lines.length - 1 && l.endsWith('-') && !text.includes(l));
  return { lines, size: minPx, widths: widthsPx(lines, minPx), shrunk: minPx < maxPx, trimmed: cut, hyphenated };
}
