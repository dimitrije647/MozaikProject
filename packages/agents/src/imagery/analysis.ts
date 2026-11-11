import sharp from 'sharp';
import { extractPalette } from '../templates/image-palette';

/**
 * LOCAL IMAGE ANALYSIS. A few measurements taken from the pixels with sharp, in memory, with no model and no network: how sharp the picture is,
 * where its busy and calm areas are (room for typography), where the subject probably is (the crop focus), and a perceptual hash that
 * recognises the same picture again after it was resized or re-compressed. Deterministic: the same bytes always give the same numbers.
 *
 * "Room for text" is measured as calm, low-detail area: a region with little edge energy can carry a headline. "Subject" is where the edge
 * energy is concentrated. Neither is a claim about WHAT the picture shows (that would need a vision model, which is never called here).
 */

export interface ImageAnalysis {
  version: 1;
  width: number;
  height: number;
  /** 64-bit difference hash, 16 hex digits. Near-identical pictures differ in only a few bits. */
  phash: string;
  /** 0..1: how much fine detail the picture holds (a blurry picture scores low) */
  sharpness: number;
  /** 0..1 per side: how calm that side is (1 = empty, a good place for text) */
  space: { top: number; bottom: number; left: number; right: number };
  /** 0..1: where the subject sits (centre of the edge energy, pulled gently towards the centre) */
  focus: [number, number];
  /** 0..1: how clearly one subject stands out from its surroundings */
  subject: number;
  /** 0..1: mean brightness */
  brightness: number;
  /** up to three dominant colours (#rrggbb) */
  colors: string[];
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const SHARP_IN = { limitInputPixels: 80_000_000, failOn: 'none' as const };

/** Grayscale pixels of the picture scaled to w x h (fit: fill, so the grid is always complete). */
async function gray(buf: Buffer, w: number, h: number): Promise<Uint8Array | null> {
  try {
    const { data } = await sharp(buf, SHARP_IN).rotate().flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    return new Uint8Array(data.buffer, data.byteOffset, data.length);
  } catch {
    return null;
  }
}

/** 64-bit dHash: each bit says whether a pixel is brighter than its right-hand neighbour on a 9x8 grid. */
export async function perceptualHash(buf: Buffer): Promise<string | null> {
  const px = await gray(buf, 9, 8);
  if (!px) return null;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Number of differing bits between two hashes of equal length (Infinity when they cannot be compared). */
export function hammingDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Two hashes this close are the same picture for our purposes (a resized or re-compressed copy). */
export const NEAR_DUPLICATE_BITS = 6;
export const isNearDuplicate = (a: string, b: string) => hammingDistance(a, b) <= NEAR_DUPLICATE_BITS;

export async function analyzeImage(buf: Buffer): Promise<ImageAnalysis | null> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf, SHARP_IN).metadata();
  } catch {
    return null;
  }
  const rawW = meta.width ?? 0;
  const rawH = meta.height ?? 0;
  if (!rawW || !rawH) return null;
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? rawH : rawW;
  const height = swap ? rawW : rawH;

  const N = 48;
  const px = await gray(buf, N, N);
  const phash = await perceptualHash(buf);
  if (!px || !phash) return null;

  // edge energy per cell (absolute difference to the right and lower neighbour)
  const energy = new Float32Array(N * N);
  let total = 0;
  let mean = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = px[y * N + x];
      const dx = x + 1 < N ? Math.abs(v - px[y * N + x + 1]) : 0;
      const dy = y + 1 < N ? Math.abs(v - px[(y + 1) * N + x]) : 0;
      const e = dx + dy;
      energy[y * N + x] = e;
      total += e;
      mean += v;
    }
  }
  mean /= N * N;
  const avg = total / (N * N);
  // a typical busy photograph has about 14 units of energy per cell at this scale; the scale makes 1 = very busy
  const busy = (e: number) => clamp(e / 28);

  const region = (x0: number, x1: number, y0: number, y1: number) => {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) s += energy[y * N + x];
    return n ? s / n : 0;
  };
  const third = Math.floor(N / 3);
  const space = {
    top: 1 - busy(region(0, N, 0, third)),
    bottom: 1 - busy(region(0, N, N - third, N)),
    left: 1 - busy(region(0, third, 0, N)),
    right: 1 - busy(region(N - third, N, 0, N)),
  };

  // where the energy is: its centroid, pulled 30% towards the centre so a crop never hugs an edge
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const e = energy[y * N + x];
    cx += e * (x + 0.5);
    cy += e * (y + 0.5);
  }
  const fx = total > 0 ? cx / total / N : 0.5;
  const fy = total > 0 ? cy / total / N : 0.5;
  const focus: [number, number] = [clamp(0.5 + (fx - 0.5) * 0.7, 0.15, 0.85), clamp(0.5 + (fy - 0.5) * 0.7, 0.15, 0.85)];

  const centre = region(Math.floor(N * 0.25), Math.ceil(N * 0.75), Math.floor(N * 0.25), Math.ceil(N * 0.75));
  const border = (region(0, N, 0, Math.floor(N * 0.25)) + region(0, N, Math.ceil(N * 0.75), N) + region(0, Math.floor(N * 0.25), 0, N) + region(Math.ceil(N * 0.75), N, 0, N)) / 4;
  const subject = clamp(0.5 + (centre - border) / (centre + border + 4));

  // sharpness: the Laplacian variance of a larger grayscale version (a blurry picture has almost no second-derivative energy)
  const L = 128;
  const big = await gray(buf, L, L);
  let lap = 0;
  let lapSq = 0;
  let ln = 0;
  if (big) {
    for (let y = 1; y < L - 1; y++) for (let x = 1; x < L - 1; x++) {
      const v = 4 * big[y * L + x] - big[y * L + x - 1] - big[y * L + x + 1] - big[(y - 1) * L + x] - big[(y + 1) * L + x];
      lap += v;
      lapSq += v * v;
      ln++;
    }
  }
  const variance = ln ? lapSq / ln - (lap / ln) ** 2 : 0;
  const sharpness = clamp(Math.log10(1 + variance) / 3);

  let colors: string[] = [];
  try {
    colors = (await extractPalette(buf, 3)).slice(0, 3);
  } catch {
    colors = [];
  }
  void avg;
  return { version: 1, width, height, phash, sharpness: round(sharpness), space: { top: round(space.top), bottom: round(space.bottom), left: round(space.left), right: round(space.right) }, focus: [round(focus[0]), round(focus[1])], subject: round(subject), brightness: round(mean / 255), colors };
}

const round = (v: number) => Math.round(v * 1000) / 1000;
