import sharp from 'sharp';
import { MAX_UPSCALE, upscaleFactor, type CreativeFormat } from './formats';

/**
 * Deterministic ad layout (the Layout Designer's tool). It crops a base image to a format, places the headline, supporting
 * text, call to action and logo inside the format's safe area, and MEASURES the result. No model is involved and nothing is
 * generated: resizing and compositing is not image editing, and it is never described as such.
 *
 * Fonts: only system fonts are referenced (a fallback stack), so no font file is bundled and no font license is involved.
 * Text is fitted with a shrink loop that renders the block and checks that no ink touches the edge of its box (clipping).
 */
export const FONT_STACK = "'Segoe UI', Arial, Helvetica, 'DejaVu Sans', 'Liberation Sans', sans-serif";

export interface LayoutOverrides {
  /** 0..0.9, strength of the readability scrim behind the text. */
  scrim?: number;
  /** Multiplies the headline size (e.g. 0.85 to make it smaller). */
  headlineScale?: number;
  textPosition?: 'top' | 'bottom';
  hideBody?: boolean;
  logoPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Force the text theme instead of choosing it from the image. */
  theme?: 'light-text' | 'dark-text';
}

export interface LayoutRequest {
  /** Base image. null = a brand-colored gradient is drawn instead (no image was generated). */
  base: Buffer | null;
  format: CreativeFormat;
  headline: string;
  body: string | null;
  ctaText: string;
  /** Brand colors as #rrggbb. */
  palette: string[];
  logo: Buffer | null;
  overrides?: LayoutOverrides;
}

export type LayoutResult =
  | { ok: true; png: Buffer; width: number; height: number; flags: string[]; info: { headlineSize: number; lines: number; theme: string; scrim: number; contrast: number; upscale: number } }
  | { ok: false; reason: string };

export const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const relLum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const contrastRatio = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/** Greedy word wrap with a conservative average glyph width (bold sans ~0.58 em). */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): { lines: string[]; truncated: boolean } {
  const charW = fontSize * 0.58;
  const maxChars = Math.max(4, Math.floor(maxWidth / charW));
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while (w.length > maxChars) {
      if (cur) (lines.push(cur), (cur = ''));
      lines.push(w.slice(0, maxChars - 1) + '-');
      w = w.slice(maxChars - 1);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else (lines.push(cur), (cur = w));
  }
  if (cur) lines.push(cur);
  const truncated = lines.length > maxLines;
  return { lines: lines.slice(0, maxLines), truncated };
}

/** Renders a text block alone and reports whether any ink touches the edge of its box (= clipped). */
async function clipped(lines: string[], fontSize: number, lineH: number, boxW: number, boxH: number, weight: number): Promise<boolean> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(boxW)}" height="${Math.ceil(boxH)}"><g font-family="${FONT_STACK}" font-weight="${weight}" font-size="${fontSize}" fill="#000">${lines.map((l, i) => `<text x="0" y="${Math.round(fontSize * 0.9 + i * lineH)}">${esc(l)}</text>`).join('')}</g></svg>`;
  try {
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const { info } = await sharp(png).trim({ threshold: 5 }).toBuffer({ resolveWithObject: true });
    const left = -(info.trimOffsetLeft ?? 0);
    const top = -(info.trimOffsetTop ?? 0);
    return left + info.width >= Math.floor(boxW) || top + info.height >= Math.floor(boxH);
  } catch {
    return false; // nothing drawn: nothing can be clipped
  }
}

const gradientSvg = (w: number, h: number, palette: string[]) => {
  const a = isHex(palette[0] ?? '') ? palette[0] : '#1f2937';
  const b = isHex(palette[1] ?? '') ? palette[1] : '#0f172a';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
};

/** A brand-colored base image (used when no AI image exists for a concept). */
export const brandGradient = (size: number, palette: string[]) => sharp(gradientSvg(size, size, palette)).png().toBuffer();

export async function renderLayout(req: LayoutRequest): Promise<LayoutResult> {
  const { format: f } = req;
  const { width: W, height: H } = f;
  const o = req.overrides ?? {};
  const flags: string[] = [];
  let upscale = 1;

  // 1. the base, cropped to the format (never stretched)
  let canvas: Buffer;
  if (req.base) {
    let meta: sharp.Metadata;
    try {
      meta = await sharp(req.base).metadata();
    } catch {
      return { ok: false, reason: 'The base image could not be read.' };
    }
    if (!meta.width || !meta.height) return { ok: false, reason: 'The base image has no dimensions.' };
    upscale = upscaleFactor(meta.width, meta.height, f);
    if (upscale > MAX_UPSCALE) return { ok: false, reason: `Cutting ${f.width}×${f.height} from a ${meta.width}×${meta.height} image would enlarge it ${upscale.toFixed(2)}× and look blurry (limit ${MAX_UPSCALE}×).` };
    if (upscale > 1.25) flags.push(`upscaled_${upscale.toFixed(2)}x`);
    canvas = await sharp(req.base).resize(W, H, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer();
  } else {
    canvas = await sharp(gradientSvg(W, H, req.palette)).png().toBuffer();
  }

  // 2. geometry: everything stays inside the safe area
  const x0 = Math.round(W * f.safe.left);
  const x1 = Math.round(W * (1 - f.safe.right));
  const y0 = Math.round(H * f.safe.top);
  const y1 = Math.round(H * (1 - f.safe.bottom));
  const wide = W / H > 1.5;
  const textW = Math.round(Math.min(x1 - x0, wide ? W * 0.58 : x1 - x0));
  const unit = Math.min(W, H);
  const position = o.textPosition ?? 'bottom';

  // 3. theme from the image area behind the text (works for light and dark images)
  const bandH = Math.round((y1 - y0) * 0.55);
  const bandTop = position === 'bottom' ? y1 - bandH : y0;
  const stats = await sharp(canvas).extract({ left: x0, top: bandTop, width: Math.max(8, x1 - x0), height: Math.max(8, bandH) }).stats();
  const [mr, mg, mb] = [stats.channels[0].mean, stats.channels[1].mean, stats.channels[2].mean];
  const bgLum = relLum(mr, mg, mb);
  const theme = o.theme ?? (bgLum > 0.55 ? 'dark-text' : 'light-text');
  const textColor = theme === 'light-text' ? '#ffffff' : '#111111';
  const scrimColor = theme === 'light-text' ? '#000000' : '#ffffff';
  const scrim = Math.min(0.9, Math.max(0, o.scrim ?? (bgLum > 0.2 && bgLum < 0.55 ? 0.62 : 0.5)));
  const lumAfter = scrimColor === '#000000' ? bgLum * (1 - scrim) : bgLum * (1 - scrim) + scrim;
  const contrast = contrastRatio(theme === 'light-text' ? 1 : relLum(17, 17, 17), lumAfter);
  if (contrast < 4.5) flags.push(`low_contrast_${contrast.toFixed(1)}`);

  // 4. fit the headline: shrink until it fits its box AND a render shows no clipping
  const maxHeadH = Math.round((y1 - y0) * (wide ? 0.5 : 0.34));
  let fs = Math.round(unit * 0.078 * (o.headlineScale ?? 1));
  const minFs = Math.round(unit * 0.034);
  let head = wrapText(req.headline, fs, textW, 4);
  let fits = false;
  for (let i = 0; i < 12; i++) {
    head = wrapText(req.headline, fs, textW, 4);
    const lineH = fs * 1.14;
    const needH = head.lines.length * lineH;
    if (!head.truncated && needH <= maxHeadH && !(await clipped(head.lines, fs, lineH, textW, needH + fs * 0.35, 800))) {
      fits = true;
      break;
    }
    if (fs <= minFs) break;
    fs = Math.max(minFs, Math.round(fs * 0.9));
  }
  if (!fits) flags.push('text_overflow');
  const headLineH = fs * 1.14;
  const headH = head.lines.length * headLineH;

  // 5. supporting text (optional) and CTA
  const showBody = !!req.body && !o.hideBody && H >= 600 && !wide;
  const bodyFs = Math.round(fs * 0.42);
  const bodyBlock = showBody ? wrapText(req.body!, bodyFs, textW, 3) : { lines: [], truncated: false };
  const bodyH = bodyBlock.lines.length * bodyFs * 1.3;
  const accent = isHex(req.palette[0] ?? '') ? req.palette[0] : '#2563eb';
  const [ar, ag, ab] = hexRgb(accent);
  const ctaTextColor = contrastRatio(1, relLum(ar, ag, ab)) >= contrastRatio(relLum(0, 0, 0), relLum(ar, ag, ab)) ? '#ffffff' : '#000000';
  let ctaFs = Math.round(fs * 0.4);
  let cta = req.ctaText.replace(/\s+/g, ' ').trim();
  const ctaPadX = Math.round(ctaFs * 1.1);
  const ctaH = Math.round(ctaFs * 2.3);
  let ctaW = Math.round(cta.length * ctaFs * 0.6 + ctaPadX * 2);
  if (ctaW > textW) {
    ctaFs = Math.max(12, Math.floor((textW - ctaPadX * 2) / (cta.length * 0.6)));
    ctaW = Math.round(textW);
    if (ctaFs < 14) {
      cta = cta.slice(0, Math.max(6, Math.floor((textW - ctaPadX * 2) / (14 * 0.6)) - 1)).trimEnd() + '…';
      ctaFs = 14;
      flags.push('cta_truncated');
    }
  }
  const gap = Math.round(unit * 0.022);
  const blockH = headH + (bodyH ? gap + bodyH : 0) + gap * 1.4 + ctaH;
  const room = y1 - y0;
  if (blockH > room * 0.9) flags.push('text_overflow');
  const blockTop = Math.round(position === 'bottom' ? Math.max(y0, y1 - blockH) : y0);

  // 6. compose
  const scrimTop = position === 'bottom' ? Math.max(0, blockTop - Math.round(unit * 0.12)) : 0;
  const scrimH = position === 'bottom' ? H - scrimTop : Math.min(H, Math.round(blockTop + blockH + unit * 0.12));
  const grad = position === 'bottom' ? ['0', '1'] : ['1', '0'];
  const scrimSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${scrimH}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${scrimColor}" stop-opacity="${(scrim * Number(grad[0])).toFixed(2)}"/><stop offset="1" stop-color="${scrimColor}" stop-opacity="${(scrim * Number(grad[1])).toFixed(2)}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/></svg>`;
  let y = blockTop;
  const lines: string[] = [];
  head.lines.forEach((l, i) => lines.push(`<text x="${x0}" y="${Math.round(y + fs * 0.9 + i * headLineH)}" font-size="${fs}" font-weight="800" fill="${textColor}">${esc(l)}</text>`));
  y += headH;
  if (bodyH) {
    y += gap;
    bodyBlock.lines.forEach((l, i) => lines.push(`<text x="${x0}" y="${Math.round(y + bodyFs * 0.95 + i * bodyFs * 1.3)}" font-size="${bodyFs}" font-weight="500" fill="${textColor}" fill-opacity="0.92">${esc(l)}</text>`));
    y += bodyH;
  }
  y += Math.round(gap * 1.4);
  const ctaSvg = `<rect x="${x0}" y="${Math.round(y)}" width="${ctaW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="${accent}"/><text x="${x0 + Math.round(ctaW / 2)}" y="${Math.round(y + ctaH / 2 + ctaFs * 0.34)}" text-anchor="middle" font-size="${ctaFs}" font-weight="700" fill="${ctaTextColor}">${esc(cta)}</text>`;
  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g font-family="${FONT_STACK}">${lines.join('')}${ctaSvg}</g></svg>`;
  const layers: sharp.OverlayOptions[] = [
    { input: Buffer.from(scrimSvg), left: 0, top: scrimTop },
    { input: Buffer.from(textSvg), left: 0, top: 0 },
  ];

  // 7. logo: contained (never stretched), in a safe-area corner that does not collide with the text
  if (req.logo) {
    try {
      const maxLogoW = Math.round((x1 - x0) * (wide ? 0.16 : 0.22));
      const maxLogoH = Math.round((y1 - y0) * 0.12);
      const logo = await sharp(req.logo).resize(maxLogoW, maxLogoH, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      const pos = o.logoPosition ?? (position === 'bottom' ? 'top-left' : 'bottom-left');
      const left = pos.endsWith('left') ? x0 : x1 - logo.info.width;
      const top = pos.startsWith('top') ? y0 : y1 - logo.info.height;
      const collides = top < blockTop + blockH && top + logo.info.height > blockTop && left < x0 + textW && left + logo.info.width > x0;
      if (collides) flags.push('logo_collides_with_text');
      layers.push({ input: logo.data, left, top });
      flags.push('logo_applied');
    } catch {
      flags.push('logo_unreadable');
    }
  }

  const png = await sharp(canvas).composite(layers).png().toBuffer();
  return { ok: true, png, width: W, height: H, flags, info: { headlineSize: fs, lines: head.lines.length, theme, scrim, contrast: Number(contrast.toFixed(2)), upscale: Number(upscale.toFixed(2)) } };
}

export const _internal = { relLum, esc };
