import { hslToHex, rgbToHex } from '../templates/color';

/**
 * Reading colors out of UNTRUSTED text (CSS, config files, tokens, documents). Pure string work: nothing is executed, evaluated or fetched.
 * Every function returns lower-case #rrggbb or null.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** OKLCH (CSS Color 4) to sRGB hex. Out-of-gamut colors are clamped. */
export function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  const enc = (v: number) => {
    const c = clamp(v, 0, 1);
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return rgbToHex(enc(lin[0]), enc(lin[1]), enc(lin[2])).toLowerCase();
}

const num = (s: string, pctBase = 1): number => (s.endsWith('%') ? (parseFloat(s) / 100) * pctBase : parseFloat(s));

/** Splits the arguments of a CSS color function written with commas or spaces (and an optional "/ alpha"). */
function args(inner: string): { parts: string[]; alpha: number } {
  const [main, slash] = inner.split('/');
  const parts = main.trim().split(/[\s,]+/).filter(Boolean);
  let alpha = 1;
  if (slash) alpha = num(slash.trim());
  else if (parts.length === 4) alpha = num(parts.pop()!);
  return { parts, alpha: Number.isFinite(alpha) ? alpha : 1 };
}

/**
 * Parses a CSS color value: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch(). Mostly transparent colors (alpha < 0.5) are not
 * a brand color and give null; so do `currentColor`, `inherit`, `var()` and named colors other than none.
 */
export function parseColor(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s*!important$/, '');
  if (!v) return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && parseInt(h[3] + h[3], 16) / 255 < 0.5) return null;
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    if (h.length === 6) return `#${h}`;
    if (h.length === 8) return parseInt(h.slice(6), 16) / 255 < 0.5 ? null : `#${h.slice(0, 6)}`;
    return null;
  }
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const { parts, alpha } = args(fn[2]);
  if (alpha < 0.5 || parts.length < 3) return null;
  if (fn[1].startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    return rgb.every((x) => Number.isFinite(x)) ? rgbToHex(rgb[0], rgb[1], rgb[2]).toLowerCase() : null;
  }
  if (fn[1].startsWith('hsl')) {
    const h = parseFloat(parts[0]);
    const s = num(parts[1], 1);
    const l = num(parts[2], 1);
    if (![h, s, l].every(Number.isFinite)) return null;
    return hslToHex(h, s > 1 ? s / 100 : s, l > 1 ? l / 100 : l).toLowerCase();
  }
  const L = num(parts[0], 1);
  const C = num(parts[1], 0.4);
  const H = parseFloat(parts[2]);
  if (![L, C, H].every(Number.isFinite)) return null;
  return oklchToHex(L > 1 ? L / 100 : L, C, H);
}

/** shadcn / Tailwind style bare HSL triples: "222.2 47.4% 11.2%" (only meaningful for a custom property whose name says it is a color). */
export function parseHslTriple(raw: string): string | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)(?:deg)?\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(raw);
  if (!m) return null;
  return hslToHex(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100).toLowerCase();
}

/** Any color value of a custom property or a declaration: a color function, a hex, or a bare HSL triple. */
export function parseAnyColor(raw: string): string | null {
  return parseColor(raw) ?? parseHslTriple(raw);
}

/** "Redmean" weighted RGB distance (0 identical .. ~765 black vs white): close to what the eye sees, cheap and deterministic. */
export function colorDistance(a: string, b: string): number {
  const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

/** max(r,g,b) - min(r,g,b) as a fraction of 255. A grey has 0. */
export function chroma(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

export function lightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** A near-white, near-black or grey color: a page surface, text or a border, rarely a brand hue. */
export const isNeutral = (hex: string) => chroma(hex) < 0.12;
export const isNearWhite = (hex: string) => lightness(hex) > 0.9 && chroma(hex) < 0.1;
export const isNearBlack = (hex: string) => lightness(hex) < 0.14 && chroma(hex) < 0.25;
