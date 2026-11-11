import type { ImageSize } from '../ai/openai-images';
import type { ChannelId } from '../strategy/channels';
import { baseSizeFor, formatsForChannels } from './formats';
import type { ImageAllocationPlan, PlannedVariation } from './schemas';
import { VISUAL_ROLE_IDS } from './schemas';

/**
 * The IMAGE ALLOCATION PLANNER: a pure, deterministic function that decides how many original AI images each creative concept gets,
 * which channels each image is meant for, which layout formats are cut from it and which creative seeds (role, camera perspective,
 * lighting) make it different from its siblings.
 *
 * Why it is deterministic: the budget must be enforceable without trusting a model. The text model only proposes WHAT each planned
 * picture shows; how many pictures exist, to which concept each belongs and what is cut from it is decided here, from the strategy's
 * channel ranking and the concepts' channel coverage, and is the same for the same input (inspectable, testable).
 *
 * Nothing in here knows an industry. The roles describe what an image does in a campaign (a hero scene, a detail, a wide context, a
 * human moment, an outcome, an atmosphere, a symbolic graphic); what they depict for THIS business comes from the strategy through
 * the Visual Creator.
 */
export const VISUAL_ROLES: Record<(typeof VISUAL_ROLE_IDS)[number], { label: string; brief: string }> = {
  hero: { label: 'Hero scene', brief: 'the key message told as one clear, striking scene' },
  detail: { label: 'Close detail', brief: 'a close, tactile detail that makes the offer feel real' },
  context: { label: 'Wide context', brief: 'a wide view of the setting or situation in which the offer exists' },
  human: { label: 'Human moment', brief: 'a human moment the target audience recognizes (no recognizable real person)' },
  outcome: { label: 'Outcome', brief: 'the result or feeling after using the offer, shown as a scene and not as a claim' },
  mood: { label: 'Atmosphere', brief: 'an atmospheric image that carries the brand mood and colors' },
  symbol: { label: 'Symbolic graphic', brief: 'a bold, simplified illustration or symbolic composition' },
};

export const PERSPECTIVES = ['eye-level', 'close-up macro', 'overhead top-down', 'low angle looking up', 'wide establishing shot', 'three-quarter angle', 'over-the-shoulder', 'straight-on symmetrical'] as const;
export const LIGHTING = ['soft natural daylight', 'warm golden-hour light', 'cool diffused light', 'dramatic high-contrast light', 'bright high-key light', 'warm evening ambient light'] as const;

/** Most original images one concept can get: more would be near-duplicates of each other. */
export const HARD_MAX_PER_CONCEPT = 8;
/** Most original images one campaign can ask for. */
export const HARD_MAX_IMAGES = 40;

export interface AllocConcept {
  id: string;
  name: string;
  /** Channels this concept has copy for (at forecast time: every selected channel). */
  channels: ChannelId[];
  /** Number of copy variants of the concept (0 when unknown). */
  variants?: number;
}

export interface AllocationInput {
  /** Original AI images wanted. */
  target: number;
  concepts: AllocConcept[];
  /** The strategy's channel ranking, best first. Channels not listed rank after the listed ones, in the order given. */
  channelPriority: ChannelId[];
  /** One size for every image; null = derived per image from the formats cut from it. */
  fixedSize: ImageSize | null;
  /** Layout formats cut from each original (at most). */
  layoutsPerOriginal: number;
  /** Cap per concept (default: an even share plus two, never above HARD_MAX_PER_CONCEPT). */
  maxPerConcept?: number;
  basis?: 'forecast' | 'concepts';
}

const weightOf = (c: AllocConcept, rank: (ch: ChannelId) => number) => {
  const channelPart = c.channels.reduce((s, ch) => s + 1 / (1 + 0.35 * rank(ch)), 0);
  return 1 + channelPart + 0.1 * (c.variants ?? 0);
};

/** Largest-remainder apportionment with a floor of one image per concept (when the target allows it) and a cap per concept. */
export function apportion(target: number, weights: number[], cap: number): number[] {
  const n = weights.length;
  if (!n || target <= 0) return weights.map(() => 0);
  const total = weights.reduce((a, b) => a + b, 0);
  const quota = weights.map((w) => (target * w) / total);
  const floor = target >= n ? 1 : 0;
  const counts = quota.map((q) => Math.min(cap, Math.max(floor, Math.floor(q))));
  const sum = () => counts.reduce((a, b) => a + b, 0);
  // give the remaining images to the concepts whose share is most under-served (ties: the earlier concept)
  while (sum() < target) {
    let best = -1;
    for (let i = 0; i < n; i++) if (counts[i] < cap && (best < 0 || quota[i] - counts[i] > quota[best] - counts[best] + 1e-12)) best = i;
    if (best < 0) break; // every concept is at its cap: the target cannot be placed
    counts[best]++;
  }
  // a floor of one can overshoot a very small target: take back from the most over-served concept
  while (sum() > target) {
    let worst = -1;
    for (let i = 0; i < n; i++) if (counts[i] > floor && (worst < 0 || quota[i] - counts[i] < quota[worst] - counts[worst] - 1e-12)) worst = i;
    if (worst < 0) break;
    counts[worst]--;
  }
  return counts;
}

export function planImageAllocation(input: AllocationInput): ImageAllocationPlan {
  const target = Math.max(0, Math.min(Math.floor(input.target), HARD_MAX_IMAGES));
  const n = input.concepts.length;
  const cap = Math.max(1, Math.min(input.maxPerConcept ?? Math.ceil(target / Math.max(1, n)) + 2, HARD_MAX_PER_CONCEPT));
  const order = [...input.channelPriority];
  const rank = (ch: ChannelId) => {
    const i = order.indexOf(ch);
    return i >= 0 ? i : order.length;
  };
  const weights = input.concepts.map((c) => weightOf(c, rank));
  const counts = apportion(target, weights, cap);
  const warnings: string[] = [];
  const allocated = counts.reduce((a, b) => a + b, 0);
  if (allocated < target) warnings.push(`Only ${allocated} of the ${target} requested images can be placed: ${n} concept(s) at most ${cap} image(s) each. Add concepts to place more.`);
  if (input.target > HARD_MAX_IMAGES) warnings.push(`The request was lowered to ${HARD_MAX_IMAGES} images, the most one campaign can plan.`);
  if (n > target && target > 0) warnings.push(`There are more concepts (${n}) than images (${target}); the last ${n - target} concept(s) get no AI image and use a brand-colored background.`);

  const variations: PlannedVariation[] = [];
  const perConcept: ImageAllocationPlan['perConcept'] = [];
  let expectedLayouts = 0;
  input.concepts.forEach((c, ci) => {
    const count = counts[ci];
    const channels = [...new Set(c.channels)].sort((a, b) => rank(a) - rank(b) || input.channelPriority.indexOf(a) - input.channelPriority.indexOf(b));
    const covered = channels.length ? channels : (['instagram'] as ChannelId[]);
    perConcept.push({
      conceptId: c.id,
      name: c.name,
      count,
      channels: covered,
      reason: count === 0 ? 'The image target is smaller than the number of concepts.' : `${count} image${count === 1 ? '' : 's'}: share of ${((count / Math.max(1, allocated)) * 100).toFixed(0)}% from ${covered.length} channel${covered.length === 1 ? '' : 's'} (best ranked: ${covered[0]}).`,
    });
    for (let i = 0; i < count; i++) {
      // an image serves a channel and, when the concept covers more than one, the next channel too (broader reuse of one original)
      const targetChannels = [...new Set([covered[i % covered.length], covered[(i + 1) % covered.length]])];
      const formats = formatsForChannels(targetChannels, Math.max(1, Math.min(input.layoutsPerOriginal, 6)));
      expectedLayouts += formats.length;
      variations.push({
        variationId: `${c.id}-V${i + 1}`,
        conceptId: c.id,
        index: i + 1,
        role: VISUAL_ROLE_IDS[(i + ci) % VISUAL_ROLE_IDS.length],
        perspective: PERSPECTIVES[(i * 3 + ci) % PERSPECTIVES.length],
        lighting: LIGHTING[(i * 5 + ci) % LIGHTING.length],
        targetChannels,
        formats: formats.map((f) => f.format.id),
        size: input.fixedSize ?? baseSizeFor(formats.map((f) => f.format)),
      });
    }
  });
  return {
    target,
    allocated,
    maxPerConcept: cap,
    basis: input.basis ?? 'concepts',
    perConcept,
    variations,
    expectedLayouts,
    rules: [
      'Images are shared between concepts by weight: 1 plus the ranked value of the channels a concept covers (rank 1 counts 1.0, each later rank 0.35 less) plus a little for each copy variant; at least one image per concept when the target allows.',
      `No concept gets more than ${cap} image${cap === 1 ? '' : 's'}.`,
      'Every image has its own role, camera perspective and lighting, so no two images of a concept are planned alike; the text model fills in what each picture shows for this business.',
      'Layouts are cut locally from the originals (no extra image request): each original is cut for the formats of the channels it is meant for.',
    ],
    warnings,
  };
}

/** A forecast before any concept exists: equal weights, every selected channel covered by every concept. */
export function forecastAllocation(o: { target: number; conceptCount: number; channels: ChannelId[]; fixedSize: ImageSize | null; layoutsPerOriginal: number; maxPerConcept?: number }): ImageAllocationPlan {
  const concepts: AllocConcept[] = Array.from({ length: o.conceptCount }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels: o.channels }));
  return planImageAllocation({ target: o.target, concepts, channelPriority: o.channels, fixedSize: o.fixedSize, layoutsPerOriginal: o.layoutsPerOriginal, maxPerConcept: o.maxPerConcept, basis: 'forecast' });
}
