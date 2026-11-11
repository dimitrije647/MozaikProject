import type { Color, ColorRole, Paint } from './schema';
import { normalizeHex } from './color';

/**
 * SVG building blocks for the template renderer. Everything here emits markup from NUMBERS and VALIDATED COLORS only (a color is a
 * role from the resolved palette or a normalized #rrggbb), so no template string can reach the SVG unescaped.
 */

export type Roles = Record<ColorRole, string>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const n2 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(2)) : 0);

export function resolveColor(c: Color, roles: Roles): string {
  if (Object.prototype.hasOwnProperty.call(roles, c)) return roles[c as ColorRole];
  return normalizeHex(c) ?? roles.ink;
}

/** Collects <defs> content and hands out deterministic element ids. */
export class Defs {
  private items: string[] = [];
  private counter = 0;
  id(prefix: string) {
    return `${prefix}${++this.counter}`;
  }
  add(markup: string) {
    this.items.push(markup);
  }
  take(): string {
    const out = this.items.join('');
    this.items = [];
    return out;
  }
  get size() {
    return this.items.length;
  }
}

/** A solid color or a `url(#gradient)` reference for `paint`, laid across `r`. Angle 0 = left to right, 90 = top to bottom. */
export function paintFill(paint: Paint, r: Rect, roles: Roles, defs: Defs): string {
  if (typeof paint === 'string') return resolveColor(paint, roles);
  const { angle, stops } = paint.gradient;
  const id = defs.id('g');
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const len = Math.abs(r.w * dx) + Math.abs(r.h * dy);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  defs.add(
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(cx - (dx * len) / 2)}" y1="${n2(cy - (dy * len) / 2)}" x2="${n2(cx + (dx * len) / 2)}" y2="${n2(cy + (dy * len) / 2)}">${sorted
      .map((s) => `<stop offset="${n2(s.at)}" stop-color="${resolveColor(s.color, roles)}" stop-opacity="${n2(s.opacity ?? 1)}"/>`)
      .join('')}</linearGradient>`,
  );
  return `url(#${id})`;
}

/** Representative solid colors of a paint (for contrast checks): the color itself, or every gradient stop. */
export function paintColors(paint: Paint, roles: Roles): string[] {
  if (typeof paint === 'string') return [resolveColor(paint, roles)];
  return paint.gradient.stops.map((s) => resolveColor(s.color, roles));
}

// ---- shape paths -----------------------------------------------------------------------------------------------------------------------

export type ShapeKind = 'rect' | 'circle' | 'arch' | 'cut-left' | 'cut-right';

/** A closed path for a shape inside rect r. `radius` is a fraction of the shorter side (rect corners / size of the diagonal cut). */
export function shapePath(kind: ShapeKind, r: Rect, radius = 0): string {
  const { x, y, w, h } = r;
  const m = Math.min(w, h);
  if (kind === 'circle') {
    const d = m;
    const rx = d / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `M${n2(cx - rx)} ${n2(cy)}a${n2(rx)} ${n2(rx)} 0 1 0 ${n2(d)} 0a${n2(rx)} ${n2(rx)} 0 1 0 ${n2(-d)} 0Z`;
  }
  if (kind === 'arch') {
    const rr = Math.min(w / 2, h);
    return `M${n2(x)} ${n2(y + rr)}A${n2(rr)} ${n2(rr)} 0 0 1 ${n2(x + w)} ${n2(y + rr)}L${n2(x + w)} ${n2(y + h)}L${n2(x)} ${n2(y + h)}Z`;
  }
  if (kind === 'cut-left' || kind === 'cut-right') {
    const cut = Math.min(w * 0.9, m * (radius || 0.2));
    return kind === 'cut-left'
      ? `M${n2(x + cut)} ${n2(y)}L${n2(x + w)} ${n2(y)}L${n2(x + w)} ${n2(y + h)}L${n2(x)} ${n2(y + h)}Z`
      : `M${n2(x)} ${n2(y)}L${n2(x + w)} ${n2(y)}L${n2(x + w - cut)} ${n2(y + h)}L${n2(x)} ${n2(y + h)}Z`;
  }
  const rr = Math.min(Math.max(0, radius) * m, m / 2);
  if (rr < 0.5) return `M${n2(x)} ${n2(y)}H${n2(x + w)}V${n2(y + h)}H${n2(x)}Z`;
  return `M${n2(x + rr)} ${n2(y)}H${n2(x + w - rr)}A${n2(rr)} ${n2(rr)} 0 0 1 ${n2(x + w)} ${n2(y + rr)}V${n2(y + h - rr)}A${n2(rr)} ${n2(rr)} 0 0 1 ${n2(x + w - rr)} ${n2(y + h)}H${n2(x + rr)}A${n2(rr)} ${n2(rr)} 0 0 1 ${n2(x)} ${n2(y + h - rr)}V${n2(y + rr)}A${n2(rr)} ${n2(rr)} 0 0 1 ${n2(x + rr)} ${n2(y)}Z`;
}

/** A soft drop shadow for the given path (blurred, slightly offset downwards). */
export function shadowMarkup(path: string, r: Rect, unit: number, defs: Defs): string {
  const id = defs.id('sh');
  const blur = unit * 0.018;
  const pad = blur * 4;
  const dy = unit * 0.012;
  defs.add(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${n2(r.x - pad)}" y="${n2(r.y - pad + dy)}" width="${n2(r.w + pad * 2)}" height="${n2(r.h + pad * 2)}"><feGaussianBlur stdDeviation="${n2(blur)}"/></filter>`);
  return `<path d="${path}" transform="translate(0 ${n2(dy)})" fill="#000000" fill-opacity="0.3" filter="url(#${id})"/>`;
}

// ---- patterns --------------------------------------------------------------------------------------------------------------------------

export type PatternKind = 'dots' | 'grid' | 'stripes' | 'rings' | 'waves' | 'checks';

/** Decorative pattern inside rect r, drawn with `color`; `cell` is the cell size in px. Element counts are capped. */
export function patternMarkup(kind: PatternKind, r: Rect, color: string, cell: number, defs: Defs): string {
  const c = Math.max(4, cell);
  const clip = defs.id('c');
  defs.add(`<clipPath id="${clip}"><rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}"/></clipPath>`);
  const wrap = (inner: string) => `<g clip-path="url(#${clip})">${inner}</g>`;
  if (kind === 'dots' || kind === 'grid' || kind === 'checks' || kind === 'stripes') {
    const id = defs.id('p');
    let tile: string;
    let extra = '';
    let size = c;
    if (kind === 'dots') tile = `<circle cx="${n2(c / 2)}" cy="${n2(c / 2)}" r="${n2(Math.max(0.8, c * 0.13))}" fill="${color}"/>`;
    else if (kind === 'grid') tile = `<path d="M${n2(c)} 0V${n2(c)}M0 ${n2(c)}H${n2(c)}" stroke="${color}" stroke-width="${n2(Math.max(1, c * 0.04))}" fill="none"/>`;
    else if (kind === 'checks') {
      size = c * 2;
      tile = `<rect x="0" y="0" width="${n2(c)}" height="${n2(c)}" fill="${color}"/><rect x="${n2(c)}" y="${n2(c)}" width="${n2(c)}" height="${n2(c)}" fill="${color}"/>`;
    } else {
      tile = `<rect x="0" y="0" width="${n2(c * 0.5)}" height="${n2(c)}" fill="${color}"/>`;
      extra = ` patternTransform="rotate(45)"`;
    }
    defs.add(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(size)}" height="${n2(size)}"${extra}>${tile}</pattern>`);
    return `<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="url(#${id})"/>`;
  }
  if (kind === 'rings') {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const maxR = Math.hypot(r.w, r.h) / 2;
    const count = Math.min(60, Math.ceil(maxR / c));
    let out = '';
    for (let i = 1; i <= count; i++) out += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(i * c)}" fill="none" stroke="${color}" stroke-width="${n2(Math.max(1, c * 0.07))}"/>`;
    return wrap(out);
  }
  // waves: horizontal sine-like rows
  const rows = Math.min(80, Math.ceil(r.h / c) + 1);
  const wl = c * 2.4;
  const amp = c * 0.28;
  let out = '';
  for (let i = 0; i < rows; i++) {
    const y = r.y + i * c;
    let d = `M${n2(r.x - wl)} ${n2(y)}`;
    for (let x = r.x - wl; x < r.x + r.w + wl; x += wl) d += `q${n2(wl / 4)} ${n2(-amp * 2)} ${n2(wl / 2)} 0t${n2(wl / 2)} 0`;
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n2(Math.max(1, c * 0.07))}"/>`;
  }
  return wrap(out);
}
