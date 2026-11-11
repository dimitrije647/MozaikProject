import type { FormatClass } from '../templates/schema';
import type { ImageAnalysis } from './analysis';
import { wordsOf } from './discovery';

/**
 * IMAGE ALLOCATION: which approved picture each template creative is built from. Pure and deterministic.
 *
 *   - a concept uses 1 to `maxPerConcept` (at most 3) source pictures; the picture of a concept is the best fit for its words, spread over the
 *     concepts so that one picture does not carry the whole campaign when there are more
 *   - a picture may serve several creatives of a concept, and every reuse gets a DIFFERENT crop (a different focus point), so the compositions
 *     differ even when the photograph is the same. 20 creatives do NOT need 20 photographs.
 *   - a creative gets no picture only when the library is empty: the selector then uses a text-first template. Nothing is invented.
 */

export interface AllocImage {
  id: string;
  /** the ranking score (0..1) from scoring.ts */
  score: number;
  text: string;
  width: number | null;
  height: number | null;
  analysis?: ImageAnalysis | null;
}

export interface AllocConceptInput {
  id: string;
  /** words of the concept (visual idea, key message) */
  words: string[];
}

export interface AllocSlot {
  slotId: string;
  conceptId: string;
  /** 1-based position inside the concept */
  index: number;
  formatClass: FormatClass;
}

export interface SlotImage {
  slotId: string;
  imageId: string | null;
  /** a second picture of the same concept for templates with a second picture area */
  secondaryImageId: string | null;
  /** where the crop is centred (0..1) */
  focus: [number, number] | null;
  reason: string;
}

export interface ImageAllocation {
  slots: SlotImage[];
  perConcept: { conceptId: string; imageIds: string[] }[];
  /** library pictures no creative uses */
  unused: string[];
  warnings: string[];
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const IDEAL: Record<FormatClass, number> = { story: 9 / 16, portrait: 4 / 5, square: 1, landscape: 1.91, banner: 3 };

/** A crop moves a little for every reuse of the same picture, so the same photograph gives different compositions. Deterministic. */
const SHIFTS: [number, number][] = [[0, 0], [-0.2, 0.06], [0.2, -0.06], [-0.1, -0.2], [0.14, 0.2], [-0.24, -0.1], [0.24, 0.1], [0, -0.24]];

const conceptFit = (img: AllocImage, words: readonly string[]): number => {
  const set = [...new Set(words.flatMap((w) => wordsOf(w)))];
  if (!set.length) return 0;
  const have = new Set(wordsOf(img.text));
  const hits = set.filter((w) => have.has(w) || [...have].some((x) => x.length > 4 && (x.startsWith(w) || w.startsWith(x)))).length;
  return clamp(hits / Math.min(3, set.length));
};

const aspectPenalty = (img: AllocImage, cls: FormatClass): number => {
  if (!img.width || !img.height) return 0;
  return clamp(Math.abs(Math.log(img.width / img.height / IDEAL[cls])) / Math.log(3)) * 0.3;
};

export function allocateImages(input: { concepts: readonly AllocConceptInput[]; slots: readonly AllocSlot[]; images: readonly AllocImage[]; maxPerConcept: number }): ImageAllocation {
  const warnings: string[] = [];
  const maxPer = Math.max(1, Math.min(3, Math.floor(input.maxPerConcept) || 3));
  const images = [...input.images].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  if (!images.length) {
    return {
      slots: input.slots.map((s) => ({ slotId: s.slotId, imageId: null, secondaryImageId: null, focus: null, reason: 'No approved picture exists, so a text-first template is used.' })),
      perConcept: input.concepts.map((c) => ({ conceptId: c.id, imageIds: [] })),
      unused: [],
      warnings: ['There is no approved picture. Every creative is text-first; add pictures to give the campaign photography.'],
    };
  }

  // 1) the pictures of each concept: best fit for its words, with a penalty for pictures other concepts already use (so the campaign spreads)
  const usedByConcepts = new Map<string, number>();
  const perConcept = new Map<string, string[]>();
  for (const c of input.concepts) {
    const mySlots = input.slots.filter((s) => s.conceptId === c.id);
    if (!mySlots.length) {
      perConcept.set(c.id, []);
      continue;
    }
    const want = Math.max(1, Math.min(maxPer, images.length, Math.ceil(mySlots.length / 2)));
    const ranked = images
      .map((img) => ({ img, fit: 0.55 * img.score + 0.45 * conceptFit(img, c.words) - 0.22 * (usedByConcepts.get(img.id) ?? 0) }))
      .sort((a, b) => b.fit - a.fit || (a.img.id < b.img.id ? -1 : 1));
    const chosen = ranked.slice(0, want).map((x) => x.img.id);
    for (const id of chosen) usedByConcepts.set(id, (usedByConcepts.get(id) ?? 0) + 1);
    perConcept.set(c.id, chosen);
  }

  // 2) the slots of a concept take turns over its pictures; a better shaped picture for the format wins ties; every reuse moves the crop
  const byId = new Map(images.map((i) => [i.id, i]));
  const reuse = new Map<string, number>();
  const usedInConcept = new Map<string, number>();
  const out: SlotImage[] = [];
  const ordered = [...input.slots].sort((a, b) => a.index - b.index);
  const result = new Map<string, SlotImage>();
  for (const s of ordered) {
    const mine = perConcept.get(s.conceptId) ?? [];
    if (!mine.length) {
      result.set(s.slotId, { slotId: s.slotId, imageId: null, secondaryImageId: null, focus: null, reason: 'The concept has no picture.' });
      continue;
    }
    const pick = mine
      .map((id) => ({ id, cost: (usedInConcept.get(`${s.conceptId}|${id}`) ?? 0) * 1 + aspectPenalty(byId.get(id)!, s.formatClass) }))
      .sort((a, b) => a.cost - b.cost || mine.indexOf(a.id) - mine.indexOf(b.id))[0].id;
    usedInConcept.set(`${s.conceptId}|${pick}`, (usedInConcept.get(`${s.conceptId}|${pick}`) ?? 0) + 1);
    const n = reuse.get(pick) ?? 0;
    reuse.set(pick, n + 1);
    const base = byId.get(pick)!.analysis?.focus ?? [0.5, 0.5];
    const [dx, dy] = SHIFTS[n % SHIFTS.length];
    const secondary = mine.find((id) => id !== pick) ?? null;
    result.set(s.slotId, {
      slotId: s.slotId,
      imageId: pick,
      secondaryImageId: secondary,
      focus: [clamp(base[0] + dx, 0.08, 0.92), clamp(base[1] + dy, 0.08, 0.92)],
      reason: n === 0 ? 'The best fit among this concept\'s pictures.' : `The same picture as another creative, cropped differently (variation ${n + 1}).`,
    });
  }
  for (const s of input.slots) out.push(result.get(s.slotId)!);

  const used = new Set(out.map((o) => o.imageId).filter((x): x is string => !!x));
  const unused = images.map((i) => i.id).filter((id) => !used.has(id));
  const concepts = input.concepts.filter((c) => (perConcept.get(c.id) ?? []).length);
  if (images.length < concepts.length) warnings.push(`There are ${images.length} approved picture${images.length === 1 ? '' : 's'} for ${concepts.length} concepts: some concepts share a picture. Different crops and templates keep them apart; more pictures give more variety.`);
  const heavy = [...reuse.entries()].filter(([, n]) => n > 6);
  if (heavy.length) warnings.push(`${heavy.length} picture${heavy.length === 1 ? ' is' : 's are'} used in more than six creatives; the compositions differ, but more pictures would give the campaign more variety.`);
  return { slots: out, perConcept: input.concepts.map((c) => ({ conceptId: c.id, imageIds: perConcept.get(c.id) ?? [] })), unused, warnings };
}
