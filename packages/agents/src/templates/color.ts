/**
 * Small, dependency-free color toolbox for the template renderer: hex / rgb / hsl conversion, WCAG relative luminance and contrast,
 * mixing, and "make this readable on that" helpers. Everything works on `#rrggbb` strings (lower case) so results are stable and
 * can be dropped straight into SVG attributes. Invalid input never throws: `normalizeHex` returns null, the others fall back to black.
 */

export type RGB = [number, number, number];
export interface HSL {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const byte = (v: number) => clamp(Math.round(v), 0, 255);

/** Accepts `#rrggbb` and `#rgb` (any case); returns lower-case `#rrggbb` or null for anything else. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  return null;
}

export const isValidHex = (input: unknown): input is string => normalizeHex(input) !== null;

export function hexToRgb(hex: string): RGB {
  const h = normalizeHex(hex) ?? '#000000';
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: clamp(s, 0, 1), l };
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [byte((r + m) * 255), byte((g + m) * 255), byte((b + m) * 255)];
}

export const hexToHsl = (hex: string): HSL => rgbToHsl(...hexToRgb(hex));
export const hslToHex = (h: number, s: number, l: number): string => rgbToHex(...hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)));

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an sRGB triple (0..255 channels). */
export const rgbLuminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const relativeLuminance = (hex: string): number => rgbLuminance(...hexToRgb(hex));
export const luminanceRatio = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/** WCAG contrast ratio between two colors (1..21). */
export const contrast = (a: string, b: string): number => luminanceRatio(relativeLuminance(a), relativeLuminance(b));

/** Linear mix in sRGB: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
}

export const lighten = (hex: string, amount: number) => mix(hex, '#ffffff', amount);
export const darken = (hex: string, amount: number) => mix(hex, '#000000', amount);

export function rotateHue(hex: string, degrees: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + degrees, s, l);
}

export function withLightness(hex: string, l: number): string {
  const hsl = hexToHsl(hex);
  return hslToHex(hsl.h, hsl.s, l);
}

/** max - min of the channels, 0..1: 0 is a pure grey, large values are vivid colors (independent of lightness, unlike HSL saturation). */
export function chromaOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

export const saturationOf = (hex: string) => hexToHsl(hex).s;
export const isDark = (hex: string) => relativeLuminance(hex) < 0.179; // the luminance where black and white text have equal contrast

/** Of two candidates, the one that reads better on `bg`. */
export function readableOn(bg: string, a: string, b: string): string {
  return contrast(bg, a) >= contrast(bg, b) ? a : b;
}

/** The candidate with the best contrast against `bg` (first one wins ties, so list preferred colors first). */
export function bestReadable(bg: string, candidates: string[]): { color: string; ratio: number } {
  let best = { color: candidates[0] ?? '#000000', ratio: 0 };
  for (const c of candidates) {
    const ratio = contrast(bg, c);
    if (ratio > best.ratio + 1e-9) best = { color: c, ratio };
  }
  return best;
}

/**
 * Returns `fg` unchanged when it already reaches `min` contrast on `bg`; otherwise moves its lightness (keeping hue and saturation)
 * away from the background until it does. When that is impossible the better of black and white is returned.
 */
export function ensureContrast(fg: string, bg: string, min: number): string {
  const f = normalizeHex(fg) ?? '#000000';
  const b = normalizeHex(bg) ?? '#ffffff';
  if (contrast(f, b) >= min) return f;
  const hsl = hexToHsl(f);
  const bgDark = relativeLuminance(b) < 0.179;
  const dirs = bgDark ? [1, -1] : [-1, 1];
  for (const dir of dirs) {
    for (let l = hsl.l; l >= 0 && l <= 1; l += dir * 0.01) {
      const c = hslToHex(hsl.h, hsl.s, l);
      if (contrast(c, b) >= min) return c;
    }
  }
  return readableOn(b, '#000000', '#ffffff');
}
