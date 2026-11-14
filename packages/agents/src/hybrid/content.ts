import { isPlaceholderCopy, unnaturalPhrases } from '../copywriting/checks';
import type { ConceptRecord, CopyVariantRecord } from '../creative/schemas';
import type { CreativeContent } from '../templates/schema';
import type { TemplateSlot } from './plan';
import type { TemplateContent } from './records';
import type { HybridFacts } from './settings';

/** The text a creative shows is the approved copy of the concept: the headline, the supporting line written for the visual (else a trimmed body) and the call to action. */
export const supportingTextOf = (v: Pick<CopyVariantRecord, 'description' | 'body'> & { visualLine?: string | null }) => {
  // the Content Writer's own line for the visual comes first: a cut-off caption is a last resort (older campaigns)
  const t = (v.visualLine || v.description || v.body).replace(/\s+/g, ' ').trim();
  return t.length <= 110 ? t : `${t.slice(0, 107).replace(/\s+\S*$/, '')}…`;
};

/**
 * The copy a slot shows. V4 slots name their deliverable: a social post uses that platform's post, an ad or print slot uses the ad or print copy
 * of its concept. Older slots (no kind) keep the earlier rule: the concept's paid ad for the channel, else any copy of the channel, else any copy.
 */
const pickVariant = (variants: CopyVariantRecord[], slot: Pick<TemplateSlot, 'conceptId' | 'channel' | 'kind'>) => {
  const mine = variants.filter((v) => v.conceptId === slot.conceptId);
  if (slot.kind === 'social_post') return mine.find((v) => v.placement === 'social_post' && v.channel === slot.channel);
  if (slot.kind) return mine.find((v) => v.placement === slot.kind);
  return mine.find((v) => v.channel === slot.channel && v.placement === 'paid_ad') ?? mine.find((v) => v.channel === slot.channel) ?? mine[0];
};

// ---- shorter wordings: one policy for every format -------------------------------------------------------------------------------------

/** Words a shortening may ADD (articles, possessives, small prepositions in a few languages); nothing that promises, counts or names a service. */
const FILLER = new Set('a an the your our to for of with in on and & der die das den dem ein eine ihr ihre ihren ihrem unser unsere zum zur fur fuer für mit und le la les un une votre vos de du des pour et el la los las tu su para y il lo gli i ta tvoj vas vaš vašu za i'.split(' '));
const wordsOf = (s: string) => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}%€$£]+/gu) ?? [];
const NUMBERISH = /[\d%€$£]/;

/**
 * Whether `short` is a FAITHFUL shorter wording of `long`: shorter, every content word of it already in the long form (or in the rest of the
 * approved copy), and no number, price, percentage or currency the approved copy does not have. "Start your free Risk Check" for "Start the free
 * Management and Risk Check" is faithful; "Start your free check today -50%" is not.
 */
export function isFaithfulShortening(short: string, long: string, context = ''): boolean {
  const s = short.trim();
  if (!s || s.length >= long.trim().length || /[…]|\.\.\.$/.test(s)) return false;
  const known = new Set([...wordsOf(long), ...wordsOf(context)]);
  for (const w of wordsOf(s)) {
    if (known.has(w)) continue;
    if (NUMBERISH.test(w) || !FILLER.has(w)) return false;
  }
  return wordsOf(s).length >= 1;
}

/**
 * Shorter wordings of a call to action made ONLY by leaving words out (never a new word): "Start the free Management and Risk Check" ->
 * "Start the free Risk Check" (a coordination dropped), "Start the free Check", "Start Risk Check". Longest first; at least two words.
 */
export function dropWordShortenings(cta: string): string[] {
  const w = cta.trim().split(/\s+/);
  if (w.length < 3) return [];
  const tiers: string[][] = [[], []];
  const add = (tier: number, parts: string[]) => {
    const t = parts.join(' ').trim();
    if (parts.length >= 2 && t.length < cta.trim().length && !tiers.some((x) => x.includes(t))) tiers[tier].push(t);
  };
  const CONJ = /^(and|und|&|i|et|y|e|or|oder|ili)$/i;
  // 1) "X and Y Z" -> "Y Z": the first part of a coordination goes, everything else stays
  for (let i = 1; i < w.length - 1; i++) if (CONJ.test(w[i])) add(0, [...w.slice(0, i - 1), ...w.slice(i + 1)]);
  // 2) the action + its article + the end of the object ("Start the Risk Check", "Start the Check")
  const verb = w[0];
  const det = w[1] && FILLER.has(w[1].toLowerCase()) ? [w[1]] : [];
  for (let k = w.length - 1 - det.length; k >= 1; k--) {
    const tail = w.slice(w.length - k);
    if (CONJ.test(tail[0]) || /^(of|for|to|the|a|an)$/i.test(tail[0])) continue;
    // a single remaining word must look like the object's name ("Check"), not an adverb ("today")
    if (k === 1 && !/^\p{Lu}/u.test(tail[0])) continue;
    add(1, [verb, ...det, ...tail]);
  }
  return tiers.flatMap((t) => t.sort((a, b) => b.length - a.length));
}

/** The approved shorter calls to action of one piece of copy: the Content Writer's own short form (when faithful) and drop-word shortenings, longest first. */
export function ctaOptionsOf(v: Pick<CopyVariantRecord, 'ctaText' | 'headline' | 'body'> & { ctaShort?: string | null }): string[] {
  const cta = v.ctaText.trim();
  if (!cta) return [];
  const own = v.ctaShort && isFaithfulShortening(v.ctaShort, cta, `${v.headline} ${v.body}`) ? [v.ctaShort.trim()] : [];
  // the Content Writer's own short form first (written for meaning), then the drop-word forms; the renderer takes the first that fits completely
  return [...new Set([...own, ...dropWordShortenings(cta)])].filter((x) => x !== cta).slice(0, 6);
}

/** The approved shorter headline (the Content Writer's own, when it adds no number, price or new claim word beyond one). */
export function headlineOptionsOf(v: Pick<CopyVariantRecord, 'headline' | 'body'> & { headlineShort?: string | null; description?: string | null; visualLine?: string | null }): string[] {
  const h = v.headlineShort?.trim();
  if (!h || h.length >= v.headline.trim().length) return [];
  const known = new Set([...wordsOf(v.headline), ...wordsOf(`${v.body} ${v.description ?? ''} ${v.visualLine ?? ''}`)]);
  const fresh = wordsOf(h).filter((w) => !known.has(w) && !FILLER.has(w));
  if (fresh.some((w) => NUMBERISH.test(w)) || fresh.length > 1) return [];
  return [h];
}

/**
 * PLATFORM-AWARE TEXT DENSITY: how much text the VISUAL of a social post may carry (the post text itself is published next to it, unchanged).
 * TikTok is a fast-scroll, sound-on feed: the picture must stop the thumb, so the cover shows one short headline and the call to action, nothing
 * else. Instagram allows a short supporting line; X a compact one; Facebook and LinkedIn are read more slowly and may carry a little more.
 *   eyebrow       the small label above the headline (the concept name) is shown
 *   supportMax    the longest supporting line shown on the visual (0 = none); a longer one is left out, never cut
 *   headlineWords a longer headline is replaced by the writer's own shorter wording or its first sentence (never invented words)
 *   maxWords      all words on the visual together (QA limit, design preflight `text_density`)
 *   maxBlocks     text blocks besides the button (QA limit)
 *   fastScroll    the format is scrolled past in a second: picture first
 */
export interface VisualTextBudget {
  eyebrow: boolean;
  supportMax: number;
  headlineWords: number;
  maxWords: number;
  maxBlocks: number;
  fastScroll: boolean;
}
export const VISUAL_TEXT_BUDGET: Readonly<Record<string, VisualTextBudget>> = {
  tiktok: { eyebrow: false, supportMax: 0, headlineWords: 6, maxWords: 12, maxBlocks: 1, fastScroll: true },
  instagram: { eyebrow: false, supportMax: 70, headlineWords: 8, maxWords: 22, maxBlocks: 2, fastScroll: false },
  x: { eyebrow: false, supportMax: 90, headlineWords: 10, maxWords: 26, maxBlocks: 2, fastScroll: false },
  facebook: { eyebrow: true, supportMax: 110, headlineWords: 12, maxWords: 34, maxBlocks: 3, fastScroll: false },
  linkedin: { eyebrow: true, supportMax: 110, headlineWords: 12, maxWords: 34, maxBlocks: 3, fastScroll: false },
};
/** The text budget of a slot's visual (social posts only; ads and print have their own media rules). */
export const visualTextBudget = (slot: Pick<TemplateSlot, 'channel' | 'kind'>): VisualTextBudget | null => (slot.kind === 'social_post' ? (VISUAL_TEXT_BUDGET[slot.channel] ?? null) : null);

/** The first sentence or clause of a headline ("Evo gde je Giardino. Na krovu TC Bazar." -> "Evo gde je Giardino."): the writer's own words, only shorter. */
export function firstClause(h: string): string | null {
  const m = h.trim().match(/^(.{4,}?[.!?:;—–])(\s+|$)/u);
  const first = m?.[1]?.replace(/[:;—–]$/u, '').trim();
  return first && first.length < h.trim().length && first.split(/\s+/).length >= 2 ? first : null;
}

const stemOf = (w: string) => w.slice(0, 5);
/**
 * The concept's SHORT LABELS that may be shown in the cards, rows or steps of a structured layout: at most three, at most five words each, and
 * every content word must already be in the concept's approved copy (its posts, ads, print and concept fields; an inflected form counts). A label
 * with a number, a price, a promise word or an unnatural phrase the copy does not have is left out: nothing new is ever printed.
 */
export function groundedPoints(concept: Pick<ConceptRecord, 'name'> & Partial<Pick<ConceptRecord, 'points' | 'keyMessage' | 'angle' | 'visualIdea'>>, copy: readonly Pick<CopyVariantRecord, 'headline' | 'body' | 'ctaText' | 'description'>[]): string[] {
  const corpus = [concept.name, concept.keyMessage, concept.angle, concept.visualIdea, ...copy.flatMap((v) => [v.headline, v.body, v.ctaText, v.description ?? ''])].join(' ');
  const known = new Set(wordsOf(corpus));
  const stems = new Set([...known].filter((w) => w.length >= 5).map(stemOf));
  const out: string[] = [];
  for (const raw of concept.points ?? []) {
    const p = raw.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
    const ws = wordsOf(p);
    if (!p || ws.length === 0 || ws.length > 5 || p.length > 40 || isPlaceholderCopy(p) || unnaturalPhrases(p).length) continue;
    const fresh = ws.filter((w) => !known.has(w) && !FILLER.has(w) && !(w.length >= 5 && stems.has(stemOf(w))));
    if (fresh.length || (NUMBERISH.test(p) && !ws.filter((w) => NUMBERISH.test(w)).every((w) => known.has(w)))) continue;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out.slice(0, 3);
}

/** The content for a slot, from the concept's real copy. null when there is no copy for it (nothing to place, nothing invented). */
export function contentForSlot(slot: Pick<TemplateSlot, 'conceptId' | 'channel' | 'kind'>, concepts: (Pick<ConceptRecord, 'id' | 'name'> & Partial<ConceptRecord>)[], variants: CopyVariantRecord[]): TemplateContent | null {
  const v = pickVariant(variants, slot);
  // a note instead of copy ("Izostavljeno iz kampanje", "omitted") is never printed on a visual: the deliverable has no copy
  if (!v || isPlaceholderCopy(v.headline)) return null;
  const concept = concepts.find((c) => c.id === slot.conceptId);
  const eyebrow = concept && concept.name.length <= 40 && concept.name.trim().toLowerCase() !== v.headline.trim().toLowerCase() ? concept.name.trim() : null;
  // a billboard carries its headline and nothing else that has to be read from a distance
  const support = slot.kind === 'billboard' ? null : supportingTextOf(v) || null;
  // a billboard is read in a few seconds: its short headline (the Content Writer's own, when faithful) is THE headline when the long one runs past seven words
  const shortHead = headlineOptionsOf(v);
  const headline = slot.kind === 'billboard' && shortHead.length && v.headline.trim().split(/\s+/).length > 7 ? shortHead[0] : v.headline.trim();
  // a billboard stays sparse (read in seconds); every other visual may fill the cards/rows/steps of a structured layout with the concept's labels
  const points = slot.kind === 'billboard' || !concept ? [] : groundedPoints(concept, variants.filter((x) => x.conceptId === slot.conceptId));
  const out: TemplateContent = { headline, support, cta: v.ctaText.trim() || null, eyebrow: slot.kind === 'billboard' ? null : eyebrow, variantId: v.id, ctaOptions: ctaOptionsOf(v), headlineOptions: headline === v.headline.trim() ? shortHead : [], ...(points.length ? { points } : {}) };
  return withTextBudget(out, visualTextBudget(slot), v.ctaShort ?? null);
}

/**
 * Applies a platform's text budget to the content of its visual: the eyebrow and a long supporting line are left out, a long headline gives way
 * to the writer's own shorter wording (or its first sentence), and on a fast-scroll format the short call to action is preferred. Nothing is cut
 * mid-sentence and no word is added.
 */
export function withTextBudget(c: TemplateContent, b: VisualTextBudget | null, ctaShort: string | null = null): TemplateContent {
  if (!b) return c;
  const out: TemplateContent = { ...c };
  if (!b.eyebrow) out.eyebrow = null;
  if (out.support && (b.supportMax === 0 || out.support.length > b.supportMax)) out.support = null;
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  if (words(out.headline) > b.headlineWords) {
    const shorter = [...(c.headlineOptions ?? []), firstClause(out.headline)].find((x): x is string => !!x && words(x) <= b.headlineWords);
    if (shorter) out.headline = shorter;
    out.headlineOptions = (c.headlineOptions ?? []).filter((x) => x !== out.headline);
  }
  // fast scroll: the shortest faithful call to action is the one shown (the long one stays in the post text)
  if (b.fastScroll && out.cta && ctaShort && (out.ctaOptions ?? []).includes(ctaShort.trim())) {
    const short = ctaShort.trim();
    out.ctaOptions = (out.ctaOptions ?? []).filter((x) => x !== short && x.length < short.length);
    out.cta = short;
  }
  return out;
}

/** What a forecast (before any copy exists) assumes: every slot will have a headline, a supporting line and a call to action. */
export function forecastContent(slot: Pick<TemplateSlot, 'conceptName'>): TemplateContent {
  return { headline: `Headline for ${slot.conceptName}`, support: 'Supporting line', cta: 'Call to action', eyebrow: slot.conceptName.length <= 40 ? slot.conceptName : null, variantId: null };
}

/** The renderer's content: the approved copy plus the brand name and ONLY the facts the user supplied. */
export function renderContent(content: TemplateContent, brandName: string, facts: HybridFacts, dropSupport = false): CreativeContent {
  const out: CreativeContent = { headline: content.headline };
  if (content.support && !dropSupport) out.support = content.support;
  if (content.cta) out.cta = content.cta;
  if (content.eyebrow) out.eyebrow = content.eyebrow;
  (content.points ?? []).slice(0, 3).forEach((p, i) => {
    if (p.trim()) out[`point${i + 1}` as 'point1'] = p.trim();
  });
  if (brandName) out.brand = brandName;
  for (const [k, v] of Object.entries(facts)) if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim();
  return out;
}
