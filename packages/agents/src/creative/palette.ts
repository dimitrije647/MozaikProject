import sharp from 'sharp';
import { isHex } from './layout';

export const NEUTRAL_PALETTE = ['#1f2937', '#0f172a'];

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Brand colors for the layouts. Order of trust: colors F1 measured from the business's own material, else the dominant color
 * of an uploaded logo, else a neutral palette (and the reviewer says so). Brand colors are never invented.
 */
export async function derivePalette(f1Palette: string[], logo: Buffer | null): Promise<{ palette: string[]; fromBrand: boolean }> {
  const measured = f1Palette.filter(isHex).slice(0, 4);
  if (measured.length) return { palette: measured.length > 1 ? measured : [measured[0], '#0f172a'], fromBrand: true };
  if (logo) {
    try {
      const { dominant } = await sharp(logo).flatten({ background: '#ffffff' }).stats();
      const c = toHex(dominant.r, dominant.g, dominant.b);
      return { palette: [c, '#0f172a'], fromBrand: true };
    } catch {
      /* unreadable logo: fall through */
    }
  }
  return { palette: [...NEUTRAL_PALETTE], fromBrand: false };
}
