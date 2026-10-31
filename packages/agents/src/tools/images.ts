/**
 * Prepares uploaded images for a vision model. A deterministic TOOL: no AI, no network.
 *
 * Images are downscaled (default longest side 1024 px), re-encoded as JPEG (this also drops EXIF and
 * other metadata such as GPS), and a measured colour palette is computed in code, so the model is
 * not asked to guess colours that a few lines of arithmetic can measure exactly.
 * SVG is refused: it can reference external resources.
 */
export interface ImageInput {
  name: string;
  /** Upload category: logo, screenshot, image, reference. */
  kind: string;
  mimeType: string;
  size: number;
  load(): Promise<Buffer>;
}

export interface PreparedImage {
  name: string;
  kind: string;
  mimeType: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  originalBytes: number;
  preparedBytes: number;
  /** Measured, not model-guessed. Share is 0..1. */
  palette: { hex: string; share: number }[];
}

export interface ImageResult {
  name: string;
  status: 'prepared' | 'skipped' | 'failed';
  reason: string | null;
  prepared: PreparedImage | null;
}

export interface ImageLimits {
  maxImages: number;
  maxInputBytes: number;
  maxSide: number;
  jpegQuality: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxImages: 4, maxInputBytes: 10 * 1024 * 1024, maxSide: 1024, jpegQuality: 80 };

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

type Sharp = typeof import('sharp');
let sharpModule: Promise<Sharp | null> | undefined;
const loadSharp = () => (sharpModule ??= import('sharp').then((m) => (m.default ?? m) as unknown as Sharp).catch(() => null));

export class ImagePreparationTool {
  constructor(private readonly limits: ImageLimits = DEFAULT_IMAGE_LIMITS) {}

  async prepareAll(inputs: ImageInput[], signal?: AbortSignal): Promise<ImageResult[]> {
    const out: ImageResult[] = [];
    for (const [i, input] of inputs.entries()) {
      if (signal?.aborted) break;
      if (i >= this.limits.maxImages) {
        out.push({ name: input.name, status: 'skipped', reason: `Only the first ${this.limits.maxImages} images are analyzed per run.`, prepared: null });
        continue;
      }
      out.push(await this.prepareOne(input));
    }
    return out;
  }

  async prepareOne(input: ImageInput): Promise<ImageResult> {
    const fail = (status: 'skipped' | 'failed', reason: string): ImageResult => ({ name: input.name, status, reason, prepared: null });
    if (/svg/i.test(input.mimeType) || /\.svg$/i.test(input.name)) return fail('skipped', 'SVG images are not analyzed (they can reference external resources).');
    if (input.size > this.limits.maxInputBytes) return fail('skipped', 'Image is too large.');
    const sharp = await loadSharp();
    if (!sharp) return fail('failed', 'Image processing is not available on this server.');

    let buf: Buffer;
    try {
      buf = await input.load();
    } catch {
      return fail('failed', 'The stored image could not be read.');
    }
    try {
      const meta = await sharp(buf, { limitInputPixels: 60_000_000 }).metadata();
      if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) return fail('skipped', `Unsupported image format (${meta.format ?? 'unknown'}). Use JPEG, PNG, WebP or GIF.`);

      const jpeg = await sharp(buf, { limitInputPixels: 60_000_000 })
        .rotate() // honor EXIF orientation, then metadata is dropped on output
        .resize({ width: this.limits.maxSide, height: this.limits.maxSide, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: this.limits.jpegQuality })
        .toBuffer({ resolveWithObject: true });

      const palette = await measurePalette(sharp, buf);
      return {
        name: input.name,
        status: 'prepared',
        reason: null,
        prepared: {
          name: input.name,
          kind: input.kind,
          mimeType: 'image/jpeg',
          base64: jpeg.data.toString('base64'),
          width: jpeg.info.width,
          height: jpeg.info.height,
          originalWidth: meta.width ?? jpeg.info.width,
          originalHeight: meta.height ?? jpeg.info.height,
          originalBytes: buf.length,
          preparedBytes: jpeg.data.length,
          palette,
        },
      };
    } catch {
      return fail('failed', 'The image could not be decoded.');
    }
  }
}

/** Quantizes a 48px thumbnail to 4 bits per channel and reports the most common buckets. */
async function measurePalette(sharp: Sharp, buf: Buffer): Promise<{ hex: string; share: number }[]> {
  const { data, info } = await sharp(buf, { limitInputPixels: 60_000_000 })
    .resize(48, 48, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n++;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((c) => ({ hex: `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`, share: Math.round((c.n / px) * 100) / 100 }));
}
