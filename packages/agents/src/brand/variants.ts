import { checkPalette, type PaletteCheck } from '../collections/design';
import { PALETTE_ROLES, type DesignPalette, type PaletteRole } from '../collections/schema';
import { contrast, ensureContrast, hexToHsl, hslToHex, mix, relativeLuminance } from '../templates/color';
import { colorDistance } from './color-parse';

/**
 * THREE PALETTE OPTIONS (deterministic, no model): the detected palette is offered in three CLOSE variants so the user can choose how the
 * campaign looks without leaving the brand:
 *
 *   closest   the detected palette, only corrected where it would not work (unreadable text, an accent that is nearly the primary or
 *             vanishes on the background)
 *   contrast  the same colors pushed for readability: text and primary further from the background, a clearer accent
 *   emphasis  another balance of the same brand: the background tinted with the brand color, the primary deepened and the accent shifted a
 *             little warmer (or cooler for a warm brand)
 *
 * Roles the user set by hand (`locked`) stay exactly as chosen in every option. Every option keeps text readable at the collection's minimum,
 * keeps the primary and the accent apart, and the three options differ visibly from each other while staying close to the detected colors.
 */

export const PALETTE_VARIANT_IDS = ['closest', 'contrast', 'emphasis'] as const;
export type PaletteVariantId = (typeof PALETTE_VARIANT_IDS)[number];

export interface PaletteVariant {
  id: PaletteVariantId;
  label: string;
  description: string;
  palette: DesignPalette;
  recommended: boolean;
  /** the roles whose color differs from the detected palette, with why */
  changes: { role: PaletteRole; from: string; to: string; why: string }[];
  check: PaletteCheck;
}

/** Redmean distance below which two colors read as "the same color" (primary vs accent). */
export const TOO_SIMILAR = 70;
/** Mean per-role distance below which two palette options are not worth offering separately. */
export const MIN_OPTION_DISTANCE = 14;
/** Mean per-role distance from the detected palette above which an option is no longer a close variant. */
export const MAX_OPTION_DISTANCE = 140;

export const paletteDistance = (a: DesignPalette, b: DesignPalette): number => PALETTE_ROLES.reduce((s, r) => s + colorDistance(a[r], b[r]), 0) / PALETTE_ROLES.length;

const LABELS: Record<PaletteVariantId, { label: string; description: string }> = {
  closest: { label: 'Closest to your brand', description: 'The detected colors, corrected only where text or the accent would not read.' },
  contrast: { label: 'Stronger contrast', description: 'The same colors with darker/lighter text and a clearer accent: easiest to read on small screens.' },
  emphasis: { label: 'Different emphasis', description: 'The background tinted with your brand color, a deeper primary and a slightly shifted accent.' },
};

const isLightBg = (p: DesignPalette) => relativeLuminance(p.background) >= 0.179;

/** Moves the accent away from the primary (hue and lightness) until the two read as different colors and the accent stands out on the background. */
function separateAccent(p: DesignPalette): string {
  let acc = p.accent;
  const ok = (c: string) => colorDistance(c, p.primary) >= TOO_SIMILAR && contrast(c, p.background) >= 1.5;
  if (ok(acc)) return acc;
  const base = hexToHsl(acc);
  const dark = !isLightBg(p);
  for (let k = 1; k <= 12; k++) {
    const h = base.h + 22 * k;
    const s = Math.max(base.s, 0.55);
    const l = dark ? Math.min(0.72, Math.max(base.l, 0.55)) : Math.max(0.38, Math.min(base.l, 0.5));
    acc = hslToHex(h, s, l);
    if (ok(acc)) return acc;
  }
  return ensureContrast(acc, p.background, 1.5);
}

function finish(p: DesignPalette, min: number): DesignPalette {
  const out = { ...p };
  out.text = ensureContrast(out.text, out.background, min);
  out.accent = separateAccent(out);
  return out;
}

function closest(d: DesignPalette, min: number): DesignPalette {
  return finish(d, min);
}

function stronger(a: DesignPalette, min: number): DesignPalette {
  const light = isLightBg(a);
  const p = { ...a };
  // text as far from the background as the brand allows: a near-black/near-white tinted with the primary
  p.text = light ? mix(p.primary, '#000000', 0.88) : mix(p.primary, '#ffffff', 0.92);
  p.text = ensureContrast(p.text, p.background, Math.max(min, 7));
  // the primary readable as large text on the background, the accent clearly visible
  p.primary = ensureContrast(p.primary, p.background, 4.5);
  const acc = hexToHsl(p.accent);
  p.accent = ensureContrast(hslToHex(acc.h, Math.min(1, acc.s + 0.12), acc.l), p.background, 3);
  return finish(p, min);
}

function emphasis(a: DesignPalette, min: number): DesignPalette {
  const light = isLightBg(a);
  const p = { ...a };
  // the background takes a little of the brand color (a tinted paper or a deep brand night)
  p.background = light ? mix(p.background, p.primary, 0.07) : mix(p.background, p.primary, 0.12);
  // the primary a step deeper (light) or brighter (dark)
  const pr = hexToHsl(p.primary);
  p.primary = hslToHex(pr.h, pr.s, light ? Math.max(0.12, pr.l - 0.08) : Math.min(0.85, pr.l + 0.08));
  // the accent shifted: a cool brand gets a warmer accent, a warm brand a cooler one
  const ac = hexToHsl(p.accent);
  const warm = ac.h < 90 || ac.h > 300;
  p.accent = hslToHex(ac.h + (warm ? -18 : 18), Math.min(1, ac.s + 0.05), ac.l);
  return finish(p, min);
}

/** Pushes `v` away from `ref` (lightness of the primary, then the accent hue) until the two options differ visibly. */
function spread(v: DesignPalette, ref: DesignPalette, others: DesignPalette[], min: number): DesignPalette {
  let out = v;
  for (let k = 1; k <= 6 && [ref, ...others].some((o) => paletteDistance(out, o) < MIN_OPTION_DISTANCE); k++) {
    const pr = hexToHsl(out.primary);
    const ac = hexToHsl(out.accent);
    const light = isLightBg(out);
    out = finish({ ...out, primary: hslToHex(pr.h, pr.s, light ? pr.l - 0.05 : pr.l + 0.05), accent: hslToHex(ac.h + 10, ac.s, ac.l), background: light ? mix(out.background, out.primary, 0.03) : out.background }, min);
  }
  return out;
}

const keepLocked = (p: DesignPalette, detected: DesignPalette, locked: readonly PaletteRole[]): DesignPalette => ({ ...p, ...Object.fromEntries(locked.map((r) => [r, detected[r]])) });

const WHY: Record<PaletteRole, string> = {
  primary: 'adjusted lightness',
  secondary: 'adjusted',
  accent: 'kept apart from the primary and visible on the background',
  background: 'tinted with the brand color',
  text: 'made readable on the background',
};

/** The three close palette options of a detected palette. `locked` roles (edited by the user) are never changed. */
export function paletteVariants(detected: DesignPalette, o: { minTextContrast?: number; locked?: readonly PaletteRole[] } = {}): PaletteVariant[] {
  const min = o.minTextContrast ?? 4.5;
  const locked = o.locked ?? [];
  const d = Object.fromEntries(PALETTE_ROLES.map((r) => [r, detected[r].toLowerCase()])) as DesignPalette;
  const a = keepLocked(closest(d, min), d, locked);
  let b = keepLocked(stronger(a, min), d, locked);
  b = keepLocked(spread(b, a, [], min), d, locked);
  let c = keepLocked(emphasis(a, min), d, locked);
  c = keepLocked(spread(c, a, [b], min), d, locked);
  const options: [PaletteVariantId, DesignPalette][] = [['closest', a], ['contrast', b], ['emphasis', c]];
  const checks = options.map(([, p]) => checkPalette(p, min));
  // the closest option is recommended when it works; otherwise the readable one
  const rec: PaletteVariantId = checks[0].ok ? 'closest' : 'contrast';
  return options.map(([id, p], i) => ({
    id,
    ...LABELS[id],
    palette: p,
    recommended: id === rec,
    changes: PALETTE_ROLES.filter((r) => p[r] !== d[r]).map((r) => ({ role: r, from: d[r], to: p[r], why: id === 'contrast' && r !== 'background' ? 'more contrast for readability' : WHY[r] })),
    check: checks[i],
  }));
}

/** What makes a set of palette options unusable: options too close to tell apart, unreadable text, an accent that is the primary again. */
export function paletteVariantIssues(variants: readonly Pick<PaletteVariant, 'id' | 'palette'>[], minTextContrast = 4.5): string[] {
  const out: string[] = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (contrast(v.palette.text, v.palette.background) < minTextContrast) out.push(`${v.id}: the text does not read on the background.`);
    if (colorDistance(v.palette.primary, v.palette.accent) < TOO_SIMILAR) out.push(`${v.id}: the primary and the accent are nearly the same color.`);
    for (let j = i + 1; j < variants.length; j++) if (paletteDistance(v.palette, variants[j].palette) < MIN_OPTION_DISTANCE) out.push(`${v.id} and ${variants[j].id} are too similar to be separate options.`);
  }
  return out;
}
