import { CHANNEL_IDS, type ChannelId } from '../strategy/channels';
import { PERMISSION_STATUS, REFERENCE_KINDS, type StyleId, type VisualDirectionBrief } from './schema';
import { STYLE_FALLBACK_COLORS, STYLE_MOODS, foldForMatch, getStyle, isStyleId, matchStylesDetailed } from './styles';

/**
 * THE DETERMINISTIC VISUAL DIRECTION BUILDER. From what the project already knows (business, audience, tone, objective, channels, brand
 * colors, optional references) it produces the VisualDirectionBrief that drives the image prompts and the template/layout choice. No
 * model is called and nothing is invented: every sentence is the style library's own guidance, or the user's/strategy's words trimmed.
 *
 * REFERENCE COMPLIANCE (encoded here and covered by tests):
 *  - Pinterest boards and anything marked platform_restricted_not_stored are recorded and shown to the user only. They contribute nothing:
 *    no color, no text, no note, and their URL never reaches a prompt.
 *  - A plain link the user pasted (user_link / link_only_not_analyzed) is kept so the user can open it. It is not fetched or analyzed.
 *  - Only brand assets, user uploads, licensed assets and our own style library, with a permission that says the user owns, provided or
 *    licensed the material (or that it is original to LaunchPilot), may add palette colors or a short note.
 */

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export type PermissionStatus = (typeof PERMISSION_STATUS)[number];

export interface ReferencePolicy {
  kind: ReferenceKind;
  /** analyzable = pixels may be read (palette extraction, vision); original = our own library; link_only = just a link; display_only = shown to the user, nothing else. */
  mode: 'analyzable' | 'original' | 'link_only' | 'display_only';
  /** May a model or an analyzer read the content? */
  analyzable: boolean;
  /** May LaunchPilot keep a copy of the content? (For links only the URL text the user gave is kept.) */
  storable: boolean;
  /** May the UI show it to the user? */
  displayable: boolean;
  /** May it influence the brief (palette colors, a short note)? Also requires one of allowedPermissions. */
  contributes: boolean;
  allowedPermissions: readonly PermissionStatus[];
  summary: string;
}

const OWNED: readonly PermissionStatus[] = ['owned_by_user', 'user_provided', 'licensed', 'original_to_launchpilot'];

export const REFERENCE_POLICY: Readonly<Record<ReferenceKind, ReferencePolicy>> = Object.freeze({
  brand_asset: { kind: 'brand_asset', mode: 'analyzable', analyzable: true, storable: true, displayable: true, contributes: true, allowedPermissions: OWNED, summary: 'Your own logo or brand file: colors may be read and the file may be stored.' },
  user_upload: { kind: 'user_upload', mode: 'analyzable', analyzable: true, storable: true, displayable: true, contributes: true, allowedPermissions: OWNED, summary: 'A file you uploaded: it may be analyzed and stored for your project.' },
  licensed_asset: { kind: 'licensed_asset', mode: 'analyzable', analyzable: true, storable: true, displayable: true, contributes: true, allowedPermissions: OWNED, summary: 'An asset you have a license for: it may be analyzed and stored within that license.' },
  style_library: { kind: 'style_library', mode: 'original', analyzable: true, storable: true, displayable: true, contributes: true, allowedPermissions: OWNED, summary: 'LaunchPilot\'s own original style guidance.' },
  user_link: { kind: 'user_link', mode: 'link_only', analyzable: false, storable: false, displayable: true, contributes: false, allowedPermissions: ['link_only_not_analyzed'], summary: 'A link you pasted: kept so you can open it; it is not fetched or analyzed.' },
  pinterest_board: { kind: 'pinterest_board', mode: 'display_only', analyzable: false, storable: false, displayable: true, contributes: false, allowedPermissions: ['platform_restricted_not_stored'], summary: 'Platform content is shown to you only: not analyzed, not stored, not used in prompts.' },
});

/** True when a reference of this kind AND permission may add colors or a note to a brief. Platform-restricted and link-only items never may. */
export function referenceMayContribute(kind: ReferenceKind, permission: PermissionStatus): boolean {
  if (kind === 'pinterest_board' || permission === 'platform_restricted_not_stored' || permission === 'link_only_not_analyzed') return false;
  const policy = REFERENCE_POLICY[kind];
  return !!policy && policy.contributes && policy.allowedPermissions.includes(permission);
}

export const NOT_ANALYZED_PLATFORM = 'Not analyzed: platform content is shown to the user only';
export const LINK_ONLY_USED = 'Link only: kept for you to open, not analyzed';
/** The sentence every image prompt carries: the picture never holds typography. */
export const NO_TEXT_SENTENCE = 'The image must contain no text, letters, logos or watermarks (typography is added later by the layout engine), and no interface screenshots or readable numbers.';

export interface VisualReferenceInput {
  id: string;
  kind: ReferenceKind;
  label: string;
  url?: string | null;
  permission: PermissionStatus;
  /** Hex colors read from the reference. Used ONLY when referenceMayContribute(kind, permission). */
  palette?: string[];
  /** A short note about the reference. Used ONLY when referenceMayContribute(kind, permission). */
  note?: string;
}

export interface VisualDirectionInput {
  projectName: string;
  industry?: string;
  productSummary?: string;
  audience?: string;
  tone?: string;
  objective?: string;
  designDirection?: string;
  channels: ChannelId[];
  brandPalette: string[];
  userStyleId?: StyleId | 'auto';
  references?: VisualReferenceInput[];
}

// ---- small private helpers -------------------------------------------------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);

/** Free text from the project: URLs and control characters removed, whitespace collapsed, bounded. */
function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(URL_RE, ' ').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** Shortens to `max` characters at a word boundary (adds an ellipsis). */
function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  const base = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '');
  return `${base}…`;
}

const firstSentence = (s: string) => s.split(/(?<=[.!?])\s+/)[0] ?? s;
const stripEnd = (s: string) => s.replace(/[.\s]+$/, '');

function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  if (!/^https?:\/\/\S+$/i.test(t) || t.length > 300) return null;
  return t;
}

// ---- color math (private) ----------------------------------------------------------------------------------------------------------------

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** '#rgb' or '#rrggbb' (any case) -> '#rrggbb' keeping the case of a 6-digit value; anything else -> null. */
function normHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  return null;
}
const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hexOfRgb = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

function hslOf(hex: string): Hsl {
  const [r8, g8, b8] = rgbOf(hex);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hexOfHsl({ h, s, l }: Hsl): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return hexOfRgb((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function rgbDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgbOf(a), [r2, g2, b2] = rgbOf(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

type ColorKind = 'dark' | 'light' | 'gray' | 'chromatic';
function kindOf(hex: string): ColorKind {
  const { s, l } = hslOf(hex);
  if (l < 0.08 || (s < 0.15 && l < 0.2)) return 'dark';
  if (l > 0.94 || (s < 0.15 && l > 0.85)) return 'light';
  if (s < 0.12) return 'gray';
  return 'chromatic';
}

const HUES: [number, string][] = [[15, 'red'], [40, 'orange'], [65, 'yellow'], [90, 'lime'], [165, 'green'], [195, 'teal'], [215, 'sky blue'], [255, 'blue'], [285, 'violet'], [330, 'purple'], [345, 'pink'], [361, 'red']];

/** A plain-words name for a color ("deep blue", "muted green", "off-white"): approximate, for prompts and UI. */
export function describeColor(hex: string): string {
  const v = normHex(hex);
  if (!v) return 'neutral';
  const { h, s, l } = hslOf(v);
  if (l < 0.1) return 'near-black';
  if (l > 0.985) return 'white';
  if (l > 0.95 && s < 0.5) return 'off-white';
  if (s < 0.1) return l < 0.3 ? 'charcoal' : l < 0.62 ? 'gray' : 'light gray';
  const hue = HUES.find(([max]) => h < max)![1];
  if (hue === 'orange' && l < 0.4) return 'brown';
  const prefix = l < 0.28 ? 'deep ' : l > 0.72 ? 'light ' : s < 0.35 ? 'muted ' : s > 0.75 && l > 0.35 && l < 0.65 ? 'vivid ' : '';
  return `${prefix}${hue}`;
}

// ---- style selection -----------------------------------------------------------------------------------------------------------------------

const DEFAULT_STYLE: StyleId = 'modern_corporate';

// ---- vocabulary tied to the brief's own words ---------------------------------------------------------------------------------------------

/** [stem, mood word]: stems are matched against accent-folded words of the tone / design direction (English and Serbian/Croatian). */
const MOOD_STEMS: [string, string][] = [
  ['calm', 'calm'], ['smiren', 'calm'], ['warm', 'warm'], ['topl', 'warm'], ['friendl', 'friendly'], ['prijateljsk', 'friendly'], ['playful', 'playful'], ['razigran', 'playful'],
  ['bold', 'bold'], ['hrabr', 'bold'], ['elegan', 'elegant'], ['luxur', 'luxurious'], ['luksuz', 'luxurious'], ['minimal', 'minimal'], ['modern', 'modern'], ['moder', 'modern'],
  ['profession', 'professional'], ['trust', 'trustworthy'], ['pouzdan', 'trustworthy'], ['energ', 'energetic'], ['fresh', 'fresh'], ['svez', 'fresh'], ['cozy', 'cozy'], ['ugodn', 'cozy'],
  ['premium', 'premium'], ['refined', 'refined'], ['clean', 'clean'], ['cist', 'clean'], ['simple', 'simple'], ['jednostav', 'simple'], ['natural', 'natural'], ['prirodn', 'natural'],
  ['gentle', 'gentle'], ['nezn', 'gentle'], ['witty', 'witty'], ['duhovit', 'witty'], ['serious', 'serious'], ['ozbiljn', 'serious'], ['youth', 'youthful'], ['mlad', 'youthful'],
  ['inspir', 'inspiring'], ['optimis', 'optimistic'], ['confident', 'confident'], ['samouver', 'confident'], ['authentic', 'authentic'], ['autenticn', 'authentic'], ['relaxed', 'relaxed'],
  ['opusten', 'relaxed'], ['sophisticated', 'sophisticated'], ['exclusive', 'exclusive'], ['approachable', 'approachable'], ['caring', 'caring'],
];

function moodFromText(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
      const w = foldForMatch(m[0]);
      const hit = MOOD_STEMS.find(([stem]) => w.startsWith(stem));
      if (hit && !out.includes(hit[1])) out.push(hit[1]);
    }
  }
  return out;
}

const OBJECTIVE_CUES: [RegExp, string][] = [
  [/\b(book\w*|reserv\w*|table)\b/, 'Keep the lower third calm for a reservation or booking call to action'],
  [/\b(sales?|discount\w*|offers?|deals?|promo\w*|popust\w*|akcij\w*|ponud\w*|snizenj\w*)\b/, 'Reserve a clear corner of the frame for an offer badge added later'],
  [/\b(sign ?up|register\w*|registr\w*|prijav\w*|trial|demo|waitlist|subscri\w*|download\w*|leads?)\b/, 'Leave a clear area beside the subject for the headline and a sign-up button'],
  [/\b(events?|tickets?|concerts?|festival\w*|dogadaj\w*|dogadjaj\w*|koncert\w*|ulaznic\w*)\b/, 'Leave room for a date and place block next to the focal point'],
  [/\b(aware\w*|brand\w*|reach\w*|prepozn\w*|svest\w*|vidljiv\w*)\b/, 'Let one clear focal point carry the brand feel and keep the frame uncluttered'],
];

const DENSITY_CUE = {
  airy: 'Airy layout: most of the frame stays calm, three elements at most',
  balanced: 'Balanced layout: picture and text share the frame about equally',
  dense: 'Dense layout: date, price or offer blocks are welcome, but keep one focal point',
} as const;

const CHANNEL_NOTES: Record<ChannelId, string> = {
  instagram: 'Feed 4:5 or 1:1 and stories 9:16: subject in the middle 80%, text in the top or bottom third.',
  facebook: 'Feed images crop to 1:1 or 1.91:1: subject near the center, no fine detail at the edges.',
  linkedin: 'Landscape or square, understated and professional: one idea per image, restrained color.',
  youtube: '16:9 frame, subject large on one side with a clear area for a short title; high contrast.',
  tiktok: 'Vertical 9:16: keep the subject clear of the top 12% and bottom 20% where the app interface sits.',
  google_search: 'Display formats are small: one simple subject, high contrast, no fine detail.',
  email: 'Header image about 600 px wide: a strong focal point that survives a mobile crop.',
  organic_content: 'Everyday posts: keep the look repeatable so a series reads as one brand.',
  community: 'Groups and forums: friendly, uncluttered, one clear subject; avoid ad-like polish.',
};

// ---- colors ------------------------------------------------------------------------------------------------------------------------------------

interface ColorSource {
  hex: string;
  /** 'brand' = the project's brand palette; otherwise the index of the reference that supplied it. */
  from: 'brand' | number;
}
type RoleSource = 'brand' | 'reference' | 'derived' | 'style';

interface ColorPlan {
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
  paper: string;
  from: Record<'primary' | 'secondary' | 'accent' | 'ink' | 'paper', RoleSource>;
  neutralBrand: boolean;
}

function deriveSecondary(primary: string): string {
  const p = hslOf(primary);
  return hexOfHsl({ h: p.h + 12, s: clamp(p.s * 0.85, 0.2, 0.9), l: p.l > 0.5 ? p.l - 0.2 : p.l + 0.22 });
}

function deriveAccent(primary: string, mode: 'complement' | 'analogous' | 'mono' | 'neutral', others: string[]): string {
  const p = hslOf(primary);
  let candidate: Hsl;
  switch (mode) {
    case 'complement':
      candidate = { h: p.h + 150, s: clamp(Math.max(p.s, 0.6), 0.55, 0.85), l: 0.52 };
      break;
    case 'analogous':
      candidate = { h: p.h + 35, s: clamp(p.s, 0.45, 0.8), l: 0.5 };
      break;
    case 'mono':
      candidate = { h: p.h, s: clamp(Math.max(p.s, 0.6), 0.55, 0.9), l: clamp(p.l > 0.5 ? p.l - 0.25 : p.l + 0.3, 0.35, 0.7) };
      break;
    default:
      candidate = { h: p.h + 20, s: 0.35, l: 0.45 };
  }
  let hex = hexOfHsl(candidate);
  for (let i = 0; i < 9 && others.some((o) => rgbDistance(hex, o) < 70); i++) hex = hexOfHsl({ ...candidate, h: candidate.h + 37 * (i + 1), l: clamp(candidate.l + (i % 2 ? 0.08 : -0.08), 0.3, 0.7) });
  return hex;
}

function planColors(styleId: StyleId, sources: ColorSource[]): ColorPlan {
  const style = getStyle(styleId);
  const fb = STYLE_FALLBACK_COLORS[styleId];
  const kinds = sources.map((s) => ({ ...s, kind: kindOf(s.hex) }));
  const chromatic = kinds.filter((c) => c.kind === 'chromatic');
  const dark = kinds.filter((c) => c.kind === 'dark');
  const light = kinds.filter((c) => c.kind === 'light');
  const gray = kinds.filter((c) => c.kind === 'gray');
  const src = (c: ColorSource): RoleSource => (c.from === 'brand' ? 'brand' : 'reference');

  // ink and paper: the brand's own near-black / near-white when they give readable contrast, otherwise the style's anchors
  const inkChoices: { hex: string; from: RoleSource }[] = [...(dark[0] ? [{ hex: dark[0].hex, from: src(dark[0]) }] : []), { hex: style.color.ink, from: 'style' }];
  const paperChoices: { hex: string; from: RoleSource }[] = [...(light[0] ? [{ hex: light[0].hex, from: src(light[0]) }] : []), { hex: style.color.paper, from: 'style' }];
  let ink = inkChoices[inkChoices.length - 1]!;
  let paper = paperChoices[paperChoices.length - 1]!;
  search: for (const i of inkChoices) for (const p of paperChoices) if (contrast(i.hex, p.hex) >= 7) {
    ink = i;
    paper = p;
    break search;
  }

  if (!chromatic.length && !dark.length && !gray.length) {
    // nothing usable as a brand color (no color at all, or only near-white): the style's neutral stand-ins
    return { primary: fb.primary, secondary: fb.secondary, accent: fb.accent, ink: ink.hex, paper: paper.hex, from: { primary: 'style', secondary: 'style', accent: 'style', ink: ink.from, paper: paper.from }, neutralBrand: false };
  }
  if (!chromatic.length) {
    // black / white / gray brand: the darkest neutral leads, the accent comes from the style
    const lead = dark[0] ?? gray[0]!;
    const second = gray.find((g) => g.hex.toLowerCase() !== lead.hex.toLowerCase());
    return {
      primary: lead.hex,
      secondary: second?.hex ?? hexOfHsl({ ...hslOf(lead.hex), l: clamp(hslOf(lead.hex).l + 0.4, 0.45, 0.65), s: 0.05 }),
      accent: fb.accent,
      ink: ink.hex,
      paper: paper.hex,
      from: { primary: src(lead), secondary: second ? src(second) : 'derived', accent: 'style', ink: ink.from, paper: paper.from },
      neutralBrand: true,
    };
  }

  const primary = chromatic[0]!;
  const secondary = chromatic[1] ?? gray[0];
  const secondaryHex = secondary?.hex ?? deriveSecondary(primary.hex);
  const accent = chromatic[2];
  const accentHex = accent?.hex ?? deriveAccent(primary.hex, style.color.accent, [primary.hex, secondaryHex]);
  return {
    primary: primary.hex,
    secondary: secondaryHex,
    accent: accentHex,
    ink: ink.hex,
    paper: paper.hex,
    from: { primary: src(primary), secondary: secondary ? src(secondary) : 'derived', accent: accent ? src(accent) : 'derived', ink: ink.from, paper: paper.from },
    neutralBrand: false,
  };
}

// ---- the builder -----------------------------------------------------------------------------------------------------------------------------------

const KIND_ORDER: Record<ReferenceKind, number> = { brand_asset: 0, user_upload: 1, licensed_asset: 2, style_library: 3, user_link: 4, pinterest_board: 5 };
const MAX_REFERENCES = 24;

export function buildVisualDirection(input: VisualDirectionInput): VisualDirectionBrief {
  const projectName = clean(input.projectName, 80);
  const industry = clean(input.industry, 80);
  const productSummary = clean(input.productSummary, 600);
  const audience = clean(input.audience, 300);
  const tone = clean(input.tone, 200);
  const objective = clean(input.objective, 300);
  const designDirection = clean(input.designDirection, 500);
  const channels = [...new Set((Array.isArray(input.channels) ? input.channels : []).filter((c): c is ChannelId => (CHANNEL_IDS as readonly string[]).includes(c)))];
  const limitations: string[] = [];

  // ---- references: classify every one first (colors are needed before the palette is planned) ----
  interface Ref {
    id: string;
    kind: ReferenceKind;
    label: string;
    url: string | null;
    permission: PermissionStatus;
    eligible: boolean;
    colors: string[];
    note: string;
  }
  const refsIn = Array.isArray(input.references) ? input.references : [];
  const validRefs = refsIn.filter((r) => r && (REFERENCE_KINDS as readonly string[]).includes(r.kind) && (PERMISSION_STATUS as readonly string[]).includes(r.permission));
  if (validRefs.length < refsIn.length) limitations.push(`${refsIn.length - validRefs.length} reference(s) had an unknown type or permission and were left out.`);
  if (validRefs.length > MAX_REFERENCES) limitations.push(`Only the first ${MAX_REFERENCES} references are recorded.`);
  const refs: Ref[] = validRefs.slice(0, MAX_REFERENCES).map((r) => {
    const eligible = referenceMayContribute(r.kind, r.permission);
    const colors = eligible ? [...new Set((Array.isArray(r.palette) ? r.palette : []).map(normHex).filter((c): c is string => !!c))].slice(0, 6) : [];
    return {
      id: cap(clean(r.id, 80) || r.kind, 60),
      kind: r.kind,
      label: cap(clean(r.label, 160) || r.kind.replace(/_/g, ' '), 120),
      url: safeUrl(r.url),
      permission: r.permission,
      eligible,
      colors,
      note: eligible ? clean(r.note, 160) : '',
    };
  });

  // ---- style ----
  const matchText = [projectName, productSummary, designDirection].filter(Boolean).join('. ');
  const ranked = matchStylesDetailed({ industry, text: matchText, audience, tone, objective, channels });
  const userPick = isStyleId(input.userStyleId) ? input.userStyleId : null;
  const top = ranked.find((r) => r.contentScore > 0) ?? ranked[0]!;
  const evidence = top.contentScore > 0;
  const styleId: StyleId = userPick ?? (evidence ? top.style.id : DEFAULT_STYLE);
  const style = getStyle(styleId);
  const chosen = ranked.find((r) => r.style.id === styleId)!;
  const others = ranked.filter((r) => r.style.id !== styleId && r.contentScore >= 1.5);
  const secondaryStyleIds = others
    .filter((r) => r.score >= others[0]!.score * 0.6 && (userPick || r.score >= chosen.score * 0.5))
    .slice(0, 2)
    .map((r) => r.style.id);
  const secondaryNames = secondaryStyleIds.map((id) => getStyle(id).name);

  let rationale: string;
  if (userPick) rationale = `Style chosen by you: ${style.name}.${secondaryNames.length ? ` The brief also points to ${secondaryNames.join(' and ')}.` : ''}`;
  else if (!evidence) rationale = `Nothing in the brief pointed to a specific style, so the general-purpose ${style.name} style was used.`;
  else rationale = `${style.name} fits the brief. ${chosen.reasons.slice(0, 2).join('. ')}.${secondaryNames.length ? ` Also close: ${secondaryNames.join(', ')}.` : ''}`;
  if (!userPick && !evidence) limitations.push(`No industry, product or keyword matched a style: ${style.name} was used as a general-purpose default.`);

  // ---- colors ----
  const brandValid: string[] = [];
  const seen = new Set<string>();
  let brandDropped = 0;
  for (const c of Array.isArray(input.brandPalette) ? input.brandPalette : []) {
    const h = normHex(c);
    if (!h) brandDropped++;
    else if (!seen.has(h.toLowerCase())) (seen.add(h.toLowerCase()), brandValid.push(h));
  }
  if (brandDropped) limitations.push(`${brandDropped} brand color(s) were not valid hex values and were ignored.`);
  const sources: ColorSource[] = brandValid.map((hex) => ({ hex, from: 'brand' as const }));
  const refOrder = refs.map((r, i) => ({ r, i })).filter(({ r }) => r.eligible && r.colors.length).sort((a, b) => KIND_ORDER[a.r.kind] - KIND_ORDER[b.r.kind] || a.i - b.i);
  for (const { r, i } of refOrder) {
    for (const hex of r.colors) {
      if (seen.has(hex.toLowerCase()) || sources.some((s) => rgbDistance(s.hex, hex) < 18)) continue;
      seen.add(hex.toLowerCase());
      sources.push({ hex, from: i });
    }
  }
  const plan = planColors(styleId, sources);
  const brandCount = sources.filter((s) => s.from === 'brand').length;
  const hasBrandPalette = brandCount > 0 || sources.some((s) => typeof s.from === 'number' && refs[s.from]!.kind === 'brand_asset');

  const lab: Record<RoleSource, string> = { brand: 'brand color', reference: 'your reference', derived: 'derived from the primary', style: 'style default' };
  const colorNotes = cap(`Primary: ${lab[plan.from.primary]}. Secondary: ${lab[plan.from.secondary]}. Accent: ${lab[plan.from.accent]}. Ink: ${lab[plan.from.ink]}. Paper: ${lab[plan.from.paper]}.`, 240);

  if (!sources.length) limitations.push('No brand palette supplied: neutral palette from the style was used.');
  else if (plan.neutralBrand) limitations.push('The brand colors are all neutral (black, white or gray): the accent color comes from the style.');
  else if (!sources.some((s) => kindOf(s.hex) === 'chromatic')) limitations.push('The supplied colors were too pale to lead a palette: neutral stand-ins from the style were used.');
  else if (plan.from.accent === 'derived' || plan.from.secondary === 'derived') limitations.push(`The brand palette gave ${sources.filter((s) => kindOf(s.hex) === 'chromatic').length} leading color(s): the missing ${[plan.from.secondary === 'derived' ? 'secondary' : '', plan.from.accent === 'derived' ? 'accent' : ''].filter(Boolean).join(' and ')} color was derived from the primary.`);
  if (sources.length && !brandCount) limitations.push('No brand palette supplied: the colors come from your uploaded references.');

  // ---- text-driven parts ----
  const userMood = moodFromText(tone, designDirection).slice(0, 3);
  const mood = [...new Set([...userMood, ...STYLE_MOODS[styleId]])].slice(0, 5).map((m) => cap(m, 40));

  const objectiveCue = OBJECTIVE_CUES.find(([re]) => re.test(foldForMatch(objective)))?.[1];
  const composition = [...style.composition.slice(0, objectiveCue ? 3 : 4), ...(objectiveCue ? [objectiveCue] : []), DENSITY_CUE[style.density]].slice(0, 5).map((c) => cap(c, 140));

  const subjects: string[] = [];
  if (productSummary) subjects.push(`Scene grounded in the product: ${clipWords(stripEnd(firstSentence(productSummary)), 80)}`);
  else if (industry) subjects.push(`Setting and props typical for ${clipWords(industry, 70)}`);
  if (audience) subjects.push(`People and settings that fit this audience: ${clipWords(stripEnd(audience), 60)}`);
  const imageSubjects = [...subjects, ...style.photography.subjects].slice(0, 6).map((s) => cap(s, 120));

  // reference notes (only from contributing references)
  const noteRefs = refs.map((r, i) => ({ r, i })).filter(({ r }) => r.eligible && r.note);
  const noteLines = noteRefs.slice(0, 2).map(({ r }) => {
    const prefix = `Reference "${clipWords(r.label, 20)}": `;
    return cap(prefix + clipWords(r.note, Math.max(20, 100 - prefix.length)), 100);
  });
  const imageTreatment = [...noteLines, ...style.photography.treatment.slice(0, 3), 'Keep one calm, low-detail area where the layout engine will place text'].slice(0, 5).map((t) => cap(t, 100));

  const channelNotes = channels.slice(0, 9).map((channel) => ({
    channel,
    note: cap(`${CHANNEL_NOTES[channel]}${style.channels.includes(channel) ? '' : ' Less usual for this style: simplify.'}`, 160),
  }));

  // ---- references: record every one, honestly ----
  const roles = [plan.primary, plan.secondary, plan.accent, plan.ink, plan.paper].map((c) => c.toLowerCase());
  const references: VisualDirectionBrief['references'] = refs.map((r, i) => {
    let used: string;
    if (r.kind === 'pinterest_board' || r.permission === 'platform_restricted_not_stored') used = NOT_ANALYZED_PLATFORM;
    else if (r.kind === 'user_link' || r.permission === 'link_only_not_analyzed') used = LINK_ONLY_USED;
    else if (!r.eligible) used = 'Recorded only: its permission does not allow it to influence the brief';
    else {
      const usedColors = r.colors.filter((c) => roles.includes(c.toLowerCase()));
      const parts: string[] = [];
      if (usedColors.length) parts.push(`Palette used: ${usedColors.slice(0, 4).join(', ')}`);
      else if (r.colors.length) parts.push('Palette read but not needed: the brand colors already cover every role');
      const noteIdx = noteRefs.findIndex((n) => n.i === i);
      if (noteIdx >= 0 && noteIdx < 2) parts.push('note used');
      else if (noteIdx >= 2) parts.push('note not used: only two fit');
      used = parts.length ? parts.join('; ') : r.kind === 'style_library' ? 'Original LaunchPilot style guidance' : 'Recorded; it carried no palette or note to use';
    }
    return { id: r.id, kind: r.kind, label: r.label, url: r.url, permission: r.permission, used: cap(used, 160) };
  });

  // ---- confidence ----
  const signals = [industry, productSummary.length >= 10 ? productSummary : '', audience, tone || designDirection, objective].filter(Boolean).length + (hasBrandPalette ? 1 : 0);
  let confidence: VisualDirectionBrief['confidence'];
  if (signals <= 1) confidence = 'low';
  else if (industry && audience && hasBrandPalette && (userPick || top.contentScore >= 2)) confidence = 'high';
  else confidence = 'medium';
  if (confidence === 'low') limitations.push('Very little information was given: treat this direction as a starting point.');

  return {
    styleId,
    secondaryStyleIds,
    rationale: cap(rationale, 400),
    colors: { primary: plan.primary, secondary: plan.secondary, accent: plan.accent, ink: plan.ink, paper: plan.paper, notes: colorNotes },
    typography: { headline: style.typography.headline.family, body: style.typography.body.family, notes: cap(style.typography.hierarchy, 200) },
    composition,
    mood,
    imageSubjects,
    imageTreatment,
    channelNotes,
    references,
    origin: 'deterministic',
    confidence,
    limitations: limitations.slice(0, 8).map((l) => cap(l, 200)),
  };
}

// ---- text for prompts and the UI ---------------------------------------------------------------------------------------------------------------

const PROMPT_MAX = 1180;

/**
 * Compact plain text for an image prompt (at most ~1200 characters): style, palette in words and hex, composition, mood, subjects,
 * treatment, what to avoid, and ALWAYS the no-text sentence. References never appear here (only the brief's own fields), and any URL is
 * stripped as a last defense.
 */
export function visualDirectionForPrompt(brief: VisualDirectionBrief): string {
  const known = isStyleId(brief.styleId);
  const style = known ? getStyle(brief.styleId) : null;
  const list = (items: readonly string[], n: number) => items.slice(0, n).map((s) => stripEnd(s.trim())).filter(Boolean).join('; ');
  const d = (hex: string) => `${describeColor(hex)} ${hex}`;
  const sections = [
    `Visual direction: ${style?.name ?? brief.styleId}.`,
    `Palette: primary ${d(brief.colors.primary)}, secondary ${d(brief.colors.secondary)}, accent ${d(brief.colors.accent)}; ink ${brief.colors.ink}, paper ${brief.colors.paper}.`,
    brief.composition.length ? `Composition: ${list(brief.composition, 3)}.` : '',
    brief.mood.length ? `Mood: ${brief.mood.slice(0, 5).join(', ')}.` : '',
    brief.imageSubjects.length ? `Subjects: ${list(brief.imageSubjects, 3)}.` : '',
    brief.imageTreatment.length ? `Treatment: ${list(brief.imageTreatment, 3)}.` : '',
    style?.photography.avoid.length ? `Avoid: ${list(style.photography.avoid, 3)}.` : '',
  ].filter(Boolean);
  const reserve = NO_TEXT_SENTENCE.length + 1;
  let out = '';
  for (const section of sections) {
    const room = PROMPT_MAX - reserve - out.length - (out ? 1 : 0);
    if (section.length <= room) out = out ? `${out} ${section}` : section;
    else {
      if (room >= 60) out = `${out ? `${out} ` : ''}${clipWords(section, room)}`;
      break;
    }
  }
  return `${out} ${NO_TEXT_SENTENCE}`.replace(URL_RE, '').replace(/\s+/g, ' ').trim();
}

/** One or two plain sentences for the UI. */
export function visualDirectionSummary(brief: VisualDirectionBrief): string {
  const name = isStyleId(brief.styleId) ? getStyle(brief.styleId).name : brief.styleId;
  const first = stripEnd(brief.composition[0] ?? '');
  const moodWords = brief.mood.slice(0, 3).join(', ');
  const s1 = `${name}: a ${moodWords || 'considered'} look built around ${describeColor(brief.colors.primary)} (${brief.colors.primary}).`;
  const s2 = `${first ? `${first}` : 'Built from your brief'} (${brief.confidence} confidence${brief.confidence === 'low' ? ': little information was given' : ''}).`;
  return [s1, s2].filter(Boolean).join(' ');
}
