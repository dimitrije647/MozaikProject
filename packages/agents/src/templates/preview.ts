import sharp from 'sharp';
import { hexToHsl, hslToHex, normalizeHex } from './color';
import { renderTemplate } from './render';
import { formatClassOf, layerFor, type CreativeContent, type FormatClass, type StyleId, type TemplateDef, type TemplateRenderResult } from './schema';

/**
 * Previews of templates: sample copy plus a SYNTHETIC placeholder picture made in code (soft sky, hills and light). The placeholder
 * is an obvious stand-in for "a photo goes here"; it is never an AI-generated or a stock image and must never be shown as one.
 * Every preview result carries the flag `placeholder_image` when it used one.
 */

/** A neutral three-color brand (blue, navy, amber) used when a preview or a test does not care about the brand. */
export const PREVIEW_PALETTE = ['#3157d5', '#14213d', '#f4a62a'];

const SIZES: Record<FormatClass, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  landscape: { width: 1200, height: 628 },
  banner: { width: 1200, height: 300 },
};

/** The size previews are rendered at for a format class (these match CREATIVE_FORMATS safe areas). */
export function previewSizeFor(cls: FormatClass): { width: number; height: number } {
  return { ...SIZES[cls] };
}

function rng(seed: string | number) {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Abstract placeholder "photo": a desaturated sky gradient tinted by the first palette color, a sun glow, soft bokeh circles, layered
 * hills and a faint picture icon in the middle. Deterministic for the same (size, palette, seed).
 */
export async function placeholderImage(width: number, height: number, palette: string[], seed: string | number = 1): Promise<Buffer> {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const rand = rng(seed);
  const first = (palette ?? []).map(normalizeHex).find((c): c is string => !!c) ?? '#6b7a90';
  const hsl = hexToHsl(first);
  const hue = hsl.h;
  const sat = Math.min(0.28, Math.max(0.1, hsl.s * 0.3));
  const tone = (l: number) => hslToHex(hue, sat, l);
  const m = Math.min(w, h);
  const sunX = w * (0.25 + rand() * 0.5);
  const sunY = h * (0.22 + rand() * 0.16);
  let bokeh = '';
  for (let i = 0; i < 9; i++) {
    const r = m * (0.04 + rand() * 0.09);
    bokeh += `<circle cx="${(rand() * w).toFixed(1)}" cy="${(rand() * h * 0.7).toFixed(1)}" r="${r.toFixed(1)}" fill="#ffffff" fill-opacity="${(0.05 + rand() * 0.1).toFixed(2)}" filter="url(#b)"/>`;
  }
  const hill = (baseY: number, amp: number, color: string, opacity: number) => {
    const phase = rand() * Math.PI * 2;
    const pts: string[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const x = (w * i) / steps;
      const y = baseY + Math.sin((i / steps) * Math.PI * (1.2 + rand() * 0.6) + phase) * amp + Math.sin((i / steps) * 9 + phase) * amp * 0.18;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return `<polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="${color}" fill-opacity="${opacity}"/>`;
  };
  const icon = m * 0.11;
  const cx = w / 2;
  const cy = h * 0.46;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(0.72)}"/><stop offset="0.55" stop-color="${tone(0.56)}"/><stop offset="1" stop-color="${tone(0.42)}"/></linearGradient>
<radialGradient id="sun" cx="${(sunX / w).toFixed(3)}" cy="${(sunY / h).toFixed(3)}" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.22"/></radialGradient>
<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(m * 0.012).toFixed(1)}"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="url(#sky)"/>
<rect width="${w}" height="${h}" fill="url(#sun)"/>
${bokeh}
${hill(h * 0.66, h * 0.05, tone(0.36), 0.9)}
${hill(h * 0.76, h * 0.045, tone(0.28), 0.95)}
${hill(h * 0.88, h * 0.035, tone(0.2), 1)}
<rect width="${w}" height="${h}" fill="url(#vig)"/>
<g fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="${Math.max(2, icon * 0.07).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round">
<rect x="${(cx - icon).toFixed(1)}" y="${(cy - icon * 0.75).toFixed(1)}" width="${(icon * 2).toFixed(1)}" height="${(icon * 1.5).toFixed(1)}" rx="${(icon * 0.12).toFixed(1)}"/>
<path d="M${(cx - icon * 0.8).toFixed(1)} ${(cy + icon * 0.55).toFixed(1)}L${(cx - icon * 0.2).toFixed(1)} ${(cy - icon * 0.05).toFixed(1)}L${(cx + icon * 0.2).toFixed(1)} ${(cy + icon * 0.35).toFixed(1)}L${(cx + icon * 0.45).toFixed(1)} ${(cy + icon * 0.1).toFixed(1)}L${(cx + icon * 0.8).toFixed(1)} ${(cy + icon * 0.55).toFixed(1)}"/>
<circle cx="${(cx + icon * 0.45).toFixed(1)}" cy="${(cy - icon * 0.4).toFixed(1)}" r="${(icon * 0.16).toFixed(1)}"/>
</g>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 3 }).toBuffer();
}

export interface PreviewOptions {
  template: TemplateDef;
  width?: number;
  height?: number;
  /** Used for the default size when width/height are not given (default: the template's first class). */
  class?: FormatClass;
  palette?: string[];
  styleId?: StyleId;
  /** The approved surfaces of a campaign design (see TemplateRenderInput.anchors). */
  anchors?: { ink: string; paper: string };
  /** Use a placeholder picture (default true). With false no picture is supplied (templates that require one are refused). */
  withImage?: boolean;
  content?: Partial<CreativeContent>;
  /** A real hero picture to use instead of the placeholder. */
  hero?: Buffer;
  logo?: Buffer | null;
}

/** Renders a template with its own `sample` copy (plus overrides), a placeholder picture and the given palette. */
export async function renderTemplatePreview(o: PreviewOptions): Promise<TemplateRenderResult> {
  const t = o.template;
  const cls = o.class ?? (o.width && o.height ? formatClassOf(o.width, o.height) : t.classes[0]);
  const size = o.width && o.height ? { width: o.width, height: o.height } : previewSizeFor(cls);
  const palette = o.palette ?? PREVIEW_PALETTE;
  const content = { ...t.sample, ...o.content } as CreativeContent;
  const usesSecondary = t.layers.some((l) => layerFor(l, formatClassOf(size.width, size.height))?.type === 'image' && (l as { slot?: string }).slot === 'secondary');
  const withImage = o.withImage !== false;
  const placeholder = withImage && !o.hero;
  const hero = o.hero ?? (withImage ? await placeholderImage(size.width, size.height, palette, t.id) : undefined);
  const secondary = withImage && usesSecondary ? await placeholderImage(size.width, size.height, palette, `${t.id}-2`) : undefined;
  const r = await renderTemplate({
    template: t,
    width: size.width,
    height: size.height,
    content,
    palette,
    styleId: o.styleId,
    anchors: o.anchors,
    brandName: content.brand ?? 'Northwind',
    images: { hero, secondary },
    logo: o.logo ?? null,
  });
  if (!r.ok || !placeholder) return r;
  return { ...r, flags: [...r.flags, 'placeholder_image'] };
}
