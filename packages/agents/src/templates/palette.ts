import type { ColorRole } from './schema';
import { bestReadable, chromaOf, contrast, darken, ensureContrast, hexToHsl, hslToHex, isDark, lighten, mix, normalizeHex, relativeLuminance } from './color';

/**
 * Turns the brand colors (most important first, possibly none, possibly junk) into the fixed set of ROLES templates paint with.
 * The brand's own colors are never altered for primary/secondary/accent when they were given; everything that was NOT given is
 * derived (never invented as "brand": the caller can tell from the input which roles came from the brand).
 *
 *   primary    palette[0], else a neutral slate
 *   secondary  palette[1], else primary shifted in tone
 *   accent     palette[2], else the complement of primary that contrasts with it
 *   ink        the darkest palette color that is dark enough, else the style anchor, else a deep neutral
 *   paper      the lightest palette color that is light enough, else the style anchor, else off-white
 *   muted      a quiet text color between ink and paper that still reads on paper
 *   onX        the best of ink / paper / white / black for text laid on X (>= 4.5:1 whenever any of them can reach it)
 */
export interface PaletteAnchors {
  ink?: string;
  paper?: string;
  /** true = ink and paper are the user's own approved surfaces (a campaign design): used exactly, never derived from the brand colors. */
  exact?: boolean;
}

const DEFAULT_PRIMARY = '#334155';
const DEFAULT_INK = '#111827';
const DEFAULT_PAPER = '#f7f5f0';
/** A palette color may serve as ink only when it is this dark (relative luminance) and as paper only when it is this light. */
const INK_MAX_LUMINANCE = 0.09;
const PAPER_MIN_LUMINANCE = 0.7;
/** ...and, so a saturated brand color is never mistaken for a neutral, it must also be close to a grey (chroma = max - min of the channels, 0..1). */
const INK_MAX_CHROMA = 0.4;
const PAPER_MAX_CHROMA = 0.14;

/** The text color to use on `bg`: ink or paper when either reaches 4.5:1 (brand-consistent), else white/black, else the best available. */
function textOn(bg: string, ink: string, paper: string): string {
  const brandCandidates = bestReadable(bg, [ink, paper]);
  if (brandCandidates.ratio >= 4.5) return brandCandidates.color;
  return bestReadable(bg, [ink, paper, '#ffffff', '#000000']).color;
}

export function resolvePalette(brandHex: string[], anchors: PaletteAnchors = {}): Record<ColorRole, string> {
  const colors: string[] = [];
  for (const raw of brandHex ?? []) {
    const c = normalizeHex(raw);
    if (c && !colors.includes(c)) colors.push(c);
  }

  const primary = colors[0] ?? DEFAULT_PRIMARY;
  const primaryHsl = hexToHsl(primary);
  const chromatic = primaryHsl.s >= 0.12 && primaryHsl.l > 0.04 && primaryHsl.l < 0.96;

  // ink: the darkest brand color that is dark enough; when that IS the primary, a deeper shade of it (a very dark primary cannot be told apart from ink: templates draw accent/secondary, not primary, on ink)
  let ink: string;
  const exactInk = anchors.exact ? normalizeHex(anchors.ink) : null;
  const exactPaper = anchors.exact ? normalizeHex(anchors.paper) : null;
  const darkCandidates = colors.filter((c) => relativeLuminance(c) <= INK_MAX_LUMINANCE && chromaOf(c) <= INK_MAX_CHROMA).sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
  if (exactInk) {
    ink = exactInk;
  } else if (darkCandidates.length) {
    ink = darkCandidates[0];
    if (ink === primary) ink = darken(primary, 0.5);
  } else {
    ink = normalizeHex(anchors.ink) ?? DEFAULT_INK;
  }

  // paper: the lightest brand color that is light enough; when that IS the primary, a lighter tint of it
  let paper: string;
  const lightCandidates = colors.filter((c) => relativeLuminance(c) >= PAPER_MIN_LUMINANCE && chromaOf(c) <= PAPER_MAX_CHROMA).sort((a, b) => relativeLuminance(b) - relativeLuminance(a));
  if (exactPaper) {
    paper = exactPaper;
  } else if (lightCandidates.length) {
    paper = lightCandidates[0];
    if (paper === primary) {
      for (let t = 0.5; t <= 0.9 && contrast(paper, primary) < 1.12; t += 0.1) paper = lighten(primary, t);
    }
  } else {
    paper = normalizeHex(anchors.paper) ?? DEFAULT_PAPER;
  }

  // secondary: the second brand color, else the primary moved in tone (lighter when it is dark, darker when it is light)
  const secondary = colors[1] ?? (isDark(primary) ? lighten(primary, 0.32) : darken(primary, 0.3));

  // accent: the third brand color, else the complement of the primary, kept lively and at >= 3:1 against it
  let accent = colors[2];
  if (!accent) {
    if (chromatic) {
      const l = isDark(primary) ? 0.62 : 0.5;
      accent = hslToHex(primaryHsl.h + 180, Math.min(0.9, Math.max(0.62, primaryHsl.s)), l);
    } else {
      // a grey / near-white / near-black primary has no hue to rotate: pick a lively one that contrasts with it
      accent = isDark(primary) ? '#f5a524' : '#2563eb';
    }
    accent = ensureContrast(accent, primary, 3);
  }

  const muted = ensureContrast(mix(ink, paper, 0.5), paper, 4.5);

  return {
    primary,
    secondary,
    accent,
    ink,
    paper,
    muted,
    onPrimary: textOn(primary, ink, paper),
    onAccent: textOn(accent, ink, paper),
    onInk: textOn(ink, ink, paper),
    onPaper: textOn(paper, ink, paper),
    white: '#ffffff',
    black: '#000000',
  };
}
