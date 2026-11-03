import sharp from 'sharp';
import { isImageBuffer } from '../templates/image-palette';
import { chroma, colorDistance, isNearWhite, isNearBlack, isNeutral } from './color-parse';
import type { BrandCandidate, EvidenceTier } from './types';

/**
 * Brand colors from a RASTER image the user provided (a logo, a brand picture): local pixel work with Sharp, no model, no network. The aim is
 * the colors the artwork is MADE of, not what surrounds it:
 *   - transparent pixels are ignored (a logo on a transparent canvas has no background color at all)
 *   - the dominant color of the image border is the background and is never offered as a brand hue
 *   - near-white is never a primary color; greys count only when the artwork has no chromatic color
 *   - similar colors are merged, and anti-aliasing blends between two real colors are dropped
 *   - the order is by share of the artwork weighted by saturation, so a large pale area does not beat a small strong brand hue
 */

const SIDE = 128;
const MIN_ALPHA = 128;
const MERGE_DISTANCE = 42;
const MAX_INPUT_PIXELS = 60_000_000;

export interface ImageColor {
  hex: string;
  /** share of the opaque pixels, 0..1 */
  share: number;
  chroma: number;
  /** the color of the surrounding canvas */
  background: boolean;
}

export interface ImageColors {
  /** clusters, most frequent first */
  colors: ImageColor[];
  /** share of fully transparent pixels */
  transparent: number;
  background: string | null;
  width: number;
  height: number;
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** True when `c` lies on the straight line between a and b in RGB (an anti-aliased edge pixel), not at either end. */
function isBlend(c: [number, number, number], a: [number, number, number], b: [number, number, number]): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  if (len2 < 900) return false;
  const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2;
  if (t < 0.12 || t > 0.88) return false;
  const p = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 20;
}

export async function readImageColors(buf: Buffer): Promise<ImageColors | null> {
  if (!isImageBuffer(buf)) return null;
  let data: Buffer;
  let w: number;
  let h: number;
  try {
    const r = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate().resize(SIDE, SIDE, { fit: 'inside', withoutEnlargement: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    data = r.data;
    w = r.info.width;
    h = r.info.height;
  } catch {
    return null;
  }
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const border = new Map<number, number>();
  let opaque = 0;
  let borderOpaque = 0;
  const edge = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < MIN_ALPHA) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
      opaque++;
      if (x < edge || y < edge || x >= w - edge || y >= h - edge) {
        border.set(key, (border.get(key) ?? 0) + 1);
        borderOpaque++;
      }
    }
  }
  const total = w * h;
  if (!opaque) return { colors: [], transparent: 1, background: null, width: w, height: h };
  const transparent = 1 - opaque / total;

  // merge bins into clusters around the biggest ones
  const entries = [...bins.entries()].map(([key, b]) => ({ key, n: b.n, c: [b.r / b.n, b.g / b.n, b.b / b.n] as [number, number, number] })).sort((a, b) => b.n - a.n || a.key - b.key);
  const clusters: { n: number; sum: [number, number, number]; keys: Set<number>; rep: [number, number, number] }[] = [];
  for (const e of entries) {
    const hexE = toHex(...e.c);
    const near = clusters.find((cl) => colorDistance(toHex(...cl.rep), hexE) < MERGE_DISTANCE);
    if (near) {
      near.n += e.n;
      near.sum = [near.sum[0] + e.c[0] * e.n, near.sum[1] + e.c[1] * e.n, near.sum[2] + e.c[2] * e.n];
      near.keys.add(e.key);
    } else clusters.push({ n: e.n, sum: [e.c[0] * e.n, e.c[1] * e.n, e.c[2] * e.n], keys: new Set([e.key]), rep: e.c });
  }

  // the background: the cluster most of the border belongs to, when the canvas is not (mostly) transparent
  let bgCluster = -1;
  if (transparent < 0.3 && borderOpaque > 0) {
    let best = 0;
    clusters.forEach((cl, idx) => {
      const share = [...cl.keys].reduce((s, k) => s + (border.get(k) ?? 0), 0) / borderOpaque;
      if (share > best) ((best = share), (bgCluster = idx));
    });
    if (best < 0.5) bgCluster = -1;
  }

  const colors: (ImageColor & { rgb: [number, number, number] })[] = clusters
    .map((cl, idx) => {
      const c: [number, number, number] = [cl.sum[0] / cl.n, cl.sum[1] / cl.n, cl.sum[2] / cl.n];
      const hex = toHex(...c);
      return { hex, share: cl.n / opaque, chroma: chroma(hex), background: idx === bgCluster, rgb: c };
    })
    .sort((a, b) => b.share - a.share || (a.hex < b.hex ? -1 : 1));
  // drop anti-aliasing blends between the background (or any bigger cluster) and a real color
  const keep = colors.filter((c, i) => {
    if (c.share >= 0.12) return true;
    for (let a = 0; a < colors.length; a++) {
      for (let b = a + 1; b < colors.length; b++) {
        if (a === i || b === i) continue;
        if (colors[a].share > c.share && colors[b].share > c.share && isBlend(c.rgb, colors[a].rgb, colors[b].rgb)) return false;
      }
    }
    return true;
  });
  return { colors: keep.map(({ rgb: _rgb, ...c }) => c), transparent: Number(transparent.toFixed(3)), background: keep.find((c) => c.background)?.hex ?? null, width: w, height: h };
}

/**
 * The brand candidates of an image: primary = the strongest chromatic color, secondary and accent = the next DISTINCT ones. A logo with no
 * chromatic color (a black wordmark) gives its darkest non-background color as a lower-weight primary, and a dark neutral also as the text color.
 */
export function candidatesFromImage(ic: ImageColors, from: { tier: EvidenceTier; label: string; strong: number }): BrandCandidate[] {
  const out: BrandCandidate[] = [];
  const usable = ic.colors.filter((c) => !c.background && c.share >= 0.01);
  const chromatic = usable.filter((c) => c.chroma >= 0.18 && !isNearWhite(c.hex)).sort((a, b) => b.share * (0.4 + 1.6 * b.chroma) - a.share * (0.4 + 1.6 * a.chroma) || (a.hex < b.hex ? -1 : 1));
  const picked: ImageColor[] = [];
  for (const c of chromatic) {
    if (picked.every((p) => colorDistance(p.hex, c.hex) > 90) && (picked.length === 0 || c.share >= 0.02)) picked.push(c);
    if (picked.length === 3) break;
  }
  const roles = ['primary', 'secondary', 'accent'] as const;
  picked.forEach((c, i) => out.push({ hex: c.hex, role: roles[i], tier: from.tier, weight: Math.max(0.3, from.strong - i * 0.15), evidence: `${from.label}: ${i === 0 ? 'dominant' : i === 1 ? 'second' : 'third'} color of the artwork` }));
  if (!picked.length) {
    const neutral = usable.filter((c) => !isNearWhite(c.hex) && c.share >= 0.03).sort((a, b) => (isNearBlack(b.hex) ? 0 : 1) - (isNearBlack(a.hex) ? 0 : 1) || b.share - a.share)[0];
    if (neutral) out.push({ hex: neutral.hex, role: 'primary', tier: from.tier, weight: 0.4, evidence: `${from.label}: the artwork has no chromatic color; its main ${isNeutral(neutral.hex) ? 'neutral' : 'color'} is offered` });
  }
  const ink = usable.filter((c) => isNearBlack(c.hex) && c.share >= 0.04).sort((a, b) => b.share - a.share)[0];
  if (ink) out.push({ hex: ink.hex, role: 'text', tier: from.tier, weight: 0.4, evidence: `${from.label}: dark lettering of the artwork` });
  return out;
}
