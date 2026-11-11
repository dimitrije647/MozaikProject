import sharp from 'sharp';

/** A small JPEG of a rendered creative (for previews). Reads the bytes only; never throws for a bad image, it returns null. */
export async function thumbnailJpeg(png: Buffer, width = 420, quality = 74): Promise<Buffer | null> {
  try {
    return await sharp(png, { limitInputPixels: 50_000_000 }).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  } catch {
    return null;
  }
}
