import type { FormatClass } from '../templates/schema';
import { hammingDistance, type ImageAnalysis } from './analysis';
import { wordsOf } from './discovery';
import { couldBecomeEligible, exportEligibility, type Eligibility, type ImageRights, type LibrarySource } from './rights';

/**
 * DETERMINISTIC IMAGE SCORING. Ranks pictures for a campaign from what is known about them: their words, size, shape and (when the file is
 * local) measurements taken from the pixels. No model, no network, no randomness: the same inputs always give the same order, ties are broken
 * by id.
 *
 * RIGHTS ARE A HARD GATE, NOT A SCORE. A picture that may not be used is never "worth a little less": it is outside the selection. When
 * candidates are ranked for a person to review, the ones that are cleared come first, then the ones the owner could still clear (attest,
 * confirm), then the ones that can never be used. In the SELECTION that feeds creatives only cleared and approved pictures exist at all.
 */

export const CRITERIA = ['relevance', 'concept', 'resolution', 'aspect', 'composition', 'subject', 'space', 'brandColor', 'originality', 'uniqueness'] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Record<Criterion, string> = {
  relevance: 'Relevance to the business',
  concept: 'Relevance to the concept',
  resolution: 'Resolution',
  aspect: 'Aspect ratio for the formats',
  composition: 'Composition and exposure',
  subject: 'Subject visibility',
  space: 'Room for typography',
  brandColor: 'Brand color compatibility',
  originality: 'Visual originality',
  uniqueness: 'Not a duplicate',
};

const WEIGHTS: Record<Criterion, number> = { relevance: 0.2, concept: 0.1, resolution: 0.13, aspect: 0.07, composition: 0.08, subject: 0.08, space: 0.1, brandColor: 0.05, originality: 0.09, uniqueness: 0.1 };

/** What each collection needs from its pictures: how much the typography needs calm area, how much the subject must stand out, and words that fit it. */
export interface CollectionImageNeeds {
  summary: string;
  /** 0.5..1.5 multiplier of the weight of "room for typography" */
  space: number;
  /** 0.5..1.5 multiplier of the weight of "subject visibility" */
  subject: number;
  words: string[];
}

export const COLLECTION_IMAGE_NEEDS: Record<string, CollectionImageNeeds> = {
  minimal_tech: { summary: 'Clean product screenshots and calm technology scenes on minimal backgrounds', space: 1.3, subject: 1, words: ['screenshot', 'dashboard', 'interface', 'app', 'software', 'laptop', 'workspace', 'minimal', 'product', 'technology', 'desk'] },
  bold_startup: { summary: 'Energetic, high-contrast pictures with one clear subject', space: 0.9, subject: 1.4, words: ['team', 'product', 'launch', 'startup', 'energy', 'people', 'work', 'growth', 'screen'] },
  premium_editorial: { summary: 'Strong editorial photography, negative space and a natural composition', space: 1.5, subject: 1.1, words: ['editorial', 'portrait', 'natural', 'light', 'texture', 'landscape', 'architecture', 'still', 'craft'] },
  modern_corporate: { summary: 'Trustworthy, well-lit business photography with room for a headline', space: 1.2, subject: 1, words: ['office', 'team', 'meeting', 'business', 'professional', 'client', 'service', 'city', 'handshake'] },
  luxury_hospitality: { summary: 'Atmospheric hospitality photography: venues, tables, light, detail', space: 1.2, subject: 1, words: ['hotel', 'restaurant', 'dining', 'interior', 'venue', 'table', 'luxury', 'elegant', 'evening', 'wine', 'suite'] },
  lifestyle_human: { summary: 'Warm, human moments and everyday scenes', space: 0.9, subject: 1.3, words: ['people', 'family', 'friends', 'lifestyle', 'home', 'smile', 'together', 'morning', 'outdoor', 'coffee'] },
  clean_ecommerce: { summary: 'Clean product photography on simple backgrounds', space: 1.1, subject: 1.5, words: ['product', 'packshot', 'studio', 'shop', 'store', 'collection', 'item', 'white', 'detail', 'package'] },
  dynamic_events: { summary: 'Crowds, stages and movement with energy', space: 0.8, subject: 1.2, words: ['event', 'crowd', 'stage', 'concert', 'festival', 'audience', 'lights', 'party', 'live', 'conference'] },
  contemporary_geometric: { summary: 'Graphic, high-contrast pictures that sit well inside shapes', space: 1, subject: 1.3, words: ['abstract', 'architecture', 'pattern', 'geometry', 'modern', 'design', 'lines', 'building', 'shape'] },
  soft_organic: { summary: 'Soft natural light, plants, textures and gentle colors', space: 1.2, subject: 1, words: ['nature', 'plant', 'organic', 'leaf', 'garden', 'natural', 'soft', 'wellness', 'botanical', 'earth', 'flower'] },
};

export const imageNeedsOf = (collectionId: string | null | undefined): CollectionImageNeeds | null => (collectionId ? (COLLECTION_IMAGE_NEEDS[collectionId] ?? null) : null);

export interface ScoreSubject {
  id: string;
  /** every word known about the picture: title, alt text, file name, tags, the text around it */
  text: string;
  width: number | null;
  height: number | null;
  source: LibrarySource;
  rights: ImageRights;
  /** present once the file is local and has been measured */
  analysis?: ImageAnalysis | null;
  /** 0..1: how prominent the picture is where it was found (a page's main image, a product photo...) */
  prominence?: number;
}

export interface ScoreContext {
  /** keywords of the business (name, offering, value proposition) */
  businessWords: string[];
  /** keywords of the concept the picture is for (visual idea, key message) */
  conceptWords?: string[];
  collectionId?: string | null;
  formatClasses?: readonly FormatClass[];
  /** the approved palette (#rrggbb), most important first */
  palette?: readonly string[];
  /** perceptual hashes of pictures that are already in use */
  chosenHashes?: readonly string[];
}

export interface Scored {
  id: string;
  score: number;
  parts: Record<Criterion, number>;
  /** criteria that could not be measured yet (no local file) and were given a neutral value */
  estimated: Criterion[];
  /** the strongest reasons in words */
  reasons: string[];
  eligibility: Eligibility;
  /** may enter a creative right now */
  eligibleNow: boolean;
  /** could enter a creative after the owner's confirmation */
  potential: boolean;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

const IDEAL_RATIO: Record<FormatClass, number> = { story: 9 / 16, portrait: 4 / 5, square: 1, landscape: 1.91, banner: 3 };

function hsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function brandColorScore(colors: readonly string[], palette: readonly string[]): number | null {
  const pal = palette.map(hsl).filter((x): x is [number, number, number] => !!x && x[1] > 0.12);
  const img = colors.map(hsl).filter((x): x is [number, number, number] => !!x);
  if (!img.length) return null;
  const vivid = img.filter((c) => c[1] > 0.2);
  if (!vivid.length) return 0.7; // a neutral picture goes with any brand
  if (!pal.length) return 0.6;
  let best = 180;
  for (const a of vivid) for (const b of pal) best = Math.min(best, Math.min(Math.abs(a[0] - b[0]), 360 - Math.abs(a[0] - b[0])));
  return clamp(1 - best / 150); // the same hue = 1, a hue 150 degrees away = 0
}

const ORIGINALITY: Record<LibrarySource, number> = { upload: 1, website: 0.9, github: 0.75, stock: 0.55, social: 0 };

export function scoreImage(s: ScoreSubject, ctx: ScoreContext): Scored {
  const needs = imageNeedsOf(ctx.collectionId);
  const estimated: Criterion[] = [];
  const reasons: string[] = [];
  const words = new Set(wordsOf(s.text));
  const overlap = (list: readonly string[] | undefined) => {
    const set = [...new Set((list ?? []).flatMap((w) => wordsOf(w)))];
    if (!set.length) return null;
    const hits = set.filter((w) => words.has(w) || [...words].some((x) => x.length > 4 && (x.startsWith(w) || w.startsWith(x))));
    return { hits, ratio: clamp(hits.length / Math.min(3, set.length)) };
  };
  const biz = overlap(ctx.businessWords);
  const con = overlap(ctx.conceptWords);
  const col = needs ? overlap(needs.words) : null;
  const relevance = clamp(0.75 * (biz?.ratio ?? 0.2) + 0.2 * (s.prominence ?? 0.3) + 0.1 * (col?.ratio ?? 0));
  if (biz?.hits.length) reasons.push(`mentions ${biz.hits.slice(0, 3).join(', ')}`);
  if (col?.hits.length) reasons.push(`suits the collection (${col.hits.slice(0, 2).join(', ')})`);
  const concept = con ? con.ratio : relevance;
  if (con?.hits.length) reasons.push(`fits the concept (${con.hits.slice(0, 2).join(', ')})`);

  const long = Math.max(s.width ?? 0, s.height ?? 0);
  let resolution = 0.4;
  if (long > 0) resolution = clamp((long - 900) / 900);
  else estimated.push('resolution');
  if (long >= 1600) reasons.push(`${s.width}x${s.height}, sharp enough for large formats`);

  let aspect = 0.6;
  if (s.width && s.height && ctx.formatClasses?.length) {
    const ratio = s.width / s.height;
    aspect = Math.max(...ctx.formatClasses.map((c) => clamp(1 - Math.abs(Math.log(ratio / IDEAL_RATIO[c])) / Math.log(3))));
  } else estimated.push('aspect');

  const a = s.analysis ?? null;
  let composition = 0.5;
  let subject = 0.5;
  let space = 0.5;
  let brandColor = 0.5;
  if (a) {
    composition = clamp(0.55 * a.sharpness + 0.45 * (1 - Math.abs(a.brightness - 0.5) * 1.4));
    subject = a.subject;
    space = clamp(0.6 * Math.max(a.space.top, a.space.bottom, a.space.left, a.space.right) + 0.4 * ((a.space.top + a.space.bottom + a.space.left + a.space.right) / 4));
    const bc = brandColorScore(a.colors, ctx.palette ?? []);
    if (bc === null) estimated.push('brandColor');
    else brandColor = bc;
    if (space > 0.7) reasons.push('has calm area for a headline');
    if (subject > 0.65) reasons.push('has a clear subject');
  } else estimated.push('composition', 'subject', 'space', 'brandColor');

  const originality = ORIGINALITY[s.source];
  let uniqueness = 1;
  if (a && ctx.chosenHashes?.length) {
    const d = Math.min(...ctx.chosenHashes.map((h) => hammingDistance(a.phash, h)));
    uniqueness = Number.isFinite(d) ? clamp(d / 16) : 1;
  }

  const wSpace = WEIGHTS.space * (needs?.space ?? 1);
  const wSubject = WEIGHTS.subject * (needs?.subject ?? 1);
  const wConcept = con ? WEIGHTS.concept : 0;
  const parts: Record<Criterion, number> = { relevance, concept, resolution, aspect, composition, subject, space, brandColor, originality, uniqueness };
  const weights: Record<Criterion, number> = { ...WEIGHTS, concept: wConcept, space: wSpace, subject: wSubject, relevance: WEIGHTS.relevance + (con ? 0 : WEIGHTS.concept) };
  const sum = CRITERIA.reduce((t, k) => t + weights[k], 0);
  const score = r4(CRITERIA.reduce((t, k) => t + weights[k] * parts[k], 0) / sum);
  const eligibility = exportEligibility(s.rights);
  return { id: s.id, score, parts: Object.fromEntries(CRITERIA.map((k) => [k, r4(parts[k])])) as Record<Criterion, number>, estimated, reasons: reasons.slice(0, 4), eligibility, eligibleNow: eligibility.eligible, potential: couldBecomeEligible(s.rights) };
}

export interface RankResult {
  ranked: (Scored & { subject: ScoreSubject })[];
  /** left out of the selection, with the reason (rights, duplicates) */
  excluded: { id: string; reason: string }[];
  duplicates: { id: string; of: string }[];
}

/**
 * stage 'selection'  the pictures that may enter a creative: eligible ones only, best first, near-duplicates removed.
 * stage 'candidates' everything, for a person to review: eligible first, then the ones that could still be cleared, then the rest; a better looking
 *                    picture NEVER outranks one with better rights.
 */
export function rankImages(subjects: readonly ScoreSubject[], ctx: ScoreContext, o: { stage: 'selection' | 'candidates' }): RankResult {
  const excluded: { id: string; reason: string }[] = [];
  const duplicates: { id: string; of: string }[] = [];
  const scored = subjects.map((s) => ({ ...scoreImage(s, ctx), subject: s }));
  const tier = (x: Scored) => (x.eligibleNow ? 0 : x.potential ? 1 : 2);
  const order = (a: Scored, b: Scored) => tier(a) - tier(b) || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const pool = o.stage === 'selection' ? scored.filter((x) => (x.eligibleNow ? true : (excluded.push({ id: x.id, reason: x.eligibility.reason }), false))) : scored;
  pool.sort(order);
  // near-identical pictures: the best one stays, the others are removed with a pointer to it
  const kept: (Scored & { subject: ScoreSubject })[] = [];
  for (const x of pool) {
    const h = x.subject.analysis?.phash;
    const twin = h ? kept.find((k) => k.subject.analysis?.phash && hammingDistance(k.subject.analysis.phash, h) <= 6) : undefined;
    if (twin) {
      duplicates.push({ id: x.id, of: twin.id });
      excluded.push({ id: x.id, reason: `Nearly identical to ${twin.id}, which ranks higher.` });
    } else kept.push(x);
  }
  return { ranked: kept, excluded, duplicates };
}

/** The text a picture is described by, from the pieces that are known: title, alt text, file name, tags, the text around it. */
export const textOfImage = (o: { title?: string | null; alt?: string | null; fileName?: string | null; tags?: readonly string[]; context?: string | null }): string =>
  [o.title, o.alt, (o.fileName ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_.]+/g, ' '), ...(o.tags ?? []), o.context].filter(Boolean).join(' ').slice(0, 600);
