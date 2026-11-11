import sharp from 'sharp';

/**
 * Dominant colors of a RASTER image, computed locally (no model, no network): the image is downscaled to a small raw RGBA buffer and
 * quantized with a deterministic median cut. Used ONLY on assets the user owns or provided (brand logo, uploaded reference, licensed
 * asset): it reads the pixels the user gave us and never fetches anything.
 */

const MAX_BYTES = 40 * 1024 * 1024;
const SAMPLE_SIDE = 96;
/** Pixels below this alpha (0..255) are treated as transparent and ignored. */
const MIN_ALPHA = 128;
/** Two colors closer than this (weighted RGB distance) are the same color for a palette. */
const DUPLICATE_DISTANCE = 44;
/** A color under this share of the opaque pixels is noise (the dominant one is always kept). */
const MIN_SHARE = 0.004;

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/**
 * True when the bytes start like a raster image sharp can read: PNG, JPEG, GIF, WebP or AVIF. SVG (text), PDF and everything else is
 * refused on purpose: a palette is only read from real pixels, and an SVG can reference other resources.
 */
export function isImageBuffer(buf: unknown): buf is Buffer {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true; // PNG
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return true; // JPEG
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return true; // GIF
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return true; // WebP (RIFF....WEBP)
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return true; // AVIF
  }
  return false;
}

interface Entry {
  r: number;
  g: number;
  b: number;
  n: number;
}
interface Box {
  entries: Entry[];
  count: number;
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const toHex = (c: { r: number; g: number; b: number }) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();

/** "Redmean" weighted RGB distance: close to perceptual distance, cheap and deterministic. */
function distance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const rm = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

function ranges(box: Box): { channel: 'r' | 'g' | 'b'; range: number } {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const e of box.entries) {
    if (e.r < rMin) rMin = e.r;
    if (e.r > rMax) rMax = e.r;
    if (e.g < gMin) gMin = e.g;
    if (e.g > gMax) gMax = e.g;
    if (e.b < bMin) bMin = e.b;
    if (e.b > bMax) bMax = e.b;
  }
  const rr = rMax - rMin;
  const gr = gMax - gMin;
  const br = bMax - bMin;
  // ties resolve r, g, b so the result never depends on iteration luck
  if (gr > rr && gr >= br) return { channel: 'g', range: gr };
  if (br > rr && br > gr) return { channel: 'b', range: br };
  return { channel: 'r', range: rr };
}

function split(box: Box): [Box, Box] | null {
  if (box.entries.length < 2) return null;
  const { channel, range } = ranges(box);
  if (range <= 0) return null;
  const order: ('r' | 'g' | 'b')[] = channel === 'r' ? ['r', 'g', 'b'] : channel === 'g' ? ['g', 'r', 'b'] : ['b', 'r', 'g'];
  const sorted = [...box.entries].sort((x, y) => x[order[0]!] - y[order[0]!] || x[order[1]!] - y[order[1]!] || x[order[2]!] - y[order[2]!]);
  let acc = 0;
  let cut = sorted.length - 1;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i]!.n;
    if (acc >= box.count / 2) {
      cut = i + 1;
      break;
    }
  }
  cut = Math.min(Math.max(cut, 1), sorted.length - 1);
  const a = sorted.slice(0, cut);
  const b = sorted.slice(cut);
  const sum = (es: Entry[]) => es.reduce((s, e) => s + e.n, 0);
  return [{ entries: a, count: sum(a) }, { entries: b, count: sum(b) }];
}

function quantize(entries: Entry[], targetBoxes: number): { r: number; g: number; b: number; n: number }[] {
  let boxes: Box[] = [{ entries, count: entries.reduce((s, e) => s + e.n, 0) }];
  while (boxes.length < targetBoxes) {
    let best = -1;
    let bestPriority = 0;
    boxes.forEach((box, i) => {
      if (box.entries.length < 2) return;
      const priority = box.count * ranges(box).range;
      if (priority > bestPriority) {
        bestPriority = priority;
        best = i;
      }
    });
    if (best < 0) break;
    const parts = split(boxes[best]!);
    if (!parts) break;
    boxes = [...boxes.slice(0, best), parts[0], parts[1], ...boxes.slice(best + 1)];
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const e of box.entries) {
      r += e.r * e.n;
      g += e.g * e.n;
      b += e.b * e.n;
    }
    return { r: r / box.count, g: g / box.count, b: b / box.count, n: box.count };
  });
}

/**
 * The `n` dominant colors of a raster image as #RRGGBB, most frequent first. Near-transparent pixels are ignored and near-duplicates
 * merged (their pixels count for the more frequent one). Deterministic. Returns [] for anything that is not a readable raster image
 * (SVG, PDF, garbage, empty, fully transparent, too large) and NEVER throws.
 */
export async function extractPalette(buf: Buffer, n = 5): Promise<string[]> {
  try {
    if (!isImageBuffer(buf) || buf.length > MAX_BYTES) return [];
    const want = Number.isFinite(n) ? Math.max(1, Math.min(12, Math.floor(n))) : 5;
    const { data, info } = await sharp(buf, { failOn: 'none', limitInputPixels: 100_000_000 })
      .resize(SAMPLE_SIDE, SAMPLE_SIDE, { fit: 'inside', withoutEnlargement: true, kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return [];

    // 5-bit histogram of the opaque pixels (exact mean color per bin so a flat color stays exactly itself)
    const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
    let opaque = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3]! < MIN_ALPHA) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key);
      if (bin) {
        bin.r += r;
        bin.g += g;
        bin.b += b;
        bin.n++;
      } else bins.set(key, { r, g, b, n: 1 });
      opaque++;
    }
    if (!opaque) return [];
    const entries: Entry[] = [...bins.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ r: v.r / v.n, g: v.g / v.n, b: v.b / v.n, n: v.n }));

    const colors = quantize(entries, Math.max(want * 3, 10)).sort((a, b) => b.n - a.n || toHex(a).localeCompare(toHex(b)));

    // merge near-duplicates into the more frequent color
    const clusters: { r: number; g: number; b: number; n: number }[] = [];
    for (const c of colors) {
      const host = clusters.find((k) => distance(k, c) < DUPLICATE_DISTANCE);
      if (host) host.n += c.n;
      else clusters.push({ ...c });
    }
    clusters.sort((a, b) => b.n - a.n || toHex(a).localeCompare(toHex(b)));
    return clusters
      .filter((c, i) => i === 0 || c.n / opaque >= MIN_SHARE)
      .slice(0, want)
      .map(toHex);
  } catch {
    return [];
  }
}
