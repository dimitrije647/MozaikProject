import { CREATIVE_FORMATS, baseSizeFor, formatsForChannels } from '../creative/formats';
import { HARD_MAX_IMAGES, planImageAllocation, type AllocConcept } from '../creative/image-allocation';
import type { ImageAllocationPlan, PlannedVariation } from '../creative/schemas';
import type { ChannelId } from '../strategy/channels';
import { formatClassOf, type FormatClass } from '../templates/schema';

/**
 * HYBRID QUOTA PLANNING. Pure and deterministic: how many original AI images and how many template creatives each concept gets, which
 * channel and format each template creative is for, and which original each one is built from. Nothing here calls a model.
 *
 *   default: 5 concepts x (1 original + 3 template creatives) = 5 AI images + 15 template creatives = 20 finished creatives
 */

/** The formats a channel can use for a template creative, best first. Wider than the per-original layouts: banners and heroes need templates built for them. */
export const HYBRID_FORMATS: Record<ChannelId, string[]> = {
  instagram: ['instagram_portrait', 'instagram_square', 'story'],
  facebook: ['facebook_feed', 'instagram_square', 'story'],
  linkedin: ['linkedin_feed', 'instagram_square', 'instagram_portrait'],
  youtube: ['promo_16x9', 'landing_hero'],
  tiktok: ['story'],
  google_search: ['promo_16x9', 'web_banner', 'instagram_square', 'landing_hero'],
  email: ['landing_hero', 'promo_16x9', 'web_banner', 'instagram_square'],
  organic_content: ['instagram_square', 'instagram_portrait', 'promo_16x9'],
  community: ['instagram_square', 'instagram_portrait'],
};

export interface TemplateSlot {
  slotId: string;
  conceptId: string;
  conceptName: string;
  /** 1-based position within the concept. */
  index: number;
  channel: ChannelId;
  formatId: string;
  width: number;
  height: number;
  formatClass: FormatClass;
  /** The planned original this creative is built from; null when the concept has none. */
  variationId: string | null;
  source: 'ai_original' | 'brand_image' | 'none';
  /** NO AI HYBRID: the approved library picture this creative is built from (set after image sourcing), a second picture for templates that have one, and the crop focus */
  imageId?: string | null;
  secondaryImageId?: string | null;
  focus?: [number, number] | null;
}

export interface HybridPlan {
  allocation: ImageAllocationPlan;
  slots: TemplateSlot[];
  perConcept: { conceptId: string; name: string; originals: number; templates: number; channels: ChannelId[] }[];
  rules: string[];
  warnings: string[];
}

export interface HybridPlanInput {
  concepts: AllocConcept[];
  originals: number;
  templateCreatives: number;
  channelPriority: ChannelId[];
  /** One size for every original (the user chose it); null = derived from the formats of the creatives built from it. */
  fixedSize: '1024x1024' | '1024x1536' | '1536x1024' | null;
  /** The project has brand images that can stand in as a picture when a concept has no AI original. */
  brandImages: number;
  basis: 'forecast' | 'concepts';
  /**
   * The output formats the user chose in the campaign design (creative format ids). When given, the template creatives rotate through exactly
   * these formats instead of the formats of each concept's channels. Empty/absent = the earlier behaviour.
   */
  formatIds?: string[];
}

/** The channel a chosen format is delivered on for a concept: one of the concept's own channels that the format serves, else the format's first channel. */
function channelForFormat(formatId: string, covered: ChannelId[]): ChannelId {
  const fmt = CREATIVE_FORMATS[formatId];
  return fmt.channels.find((c) => covered.includes(c)) ?? fmt.channels[0] ?? covered[0] ?? 'instagram';
}

/** Even share first, then the remainder by weight (ties: the earlier concept). Total is exact whenever the caps allow it. */
export function evenThenWeighted(total: number, weights: number[], cap: number): number[] {
  const n = weights.length;
  if (!n || total <= 0) return weights.map(() => 0);
  const base = Math.min(cap, Math.floor(total / n));
  const counts = weights.map(() => base);
  let left = total - base * n;
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w || a.i - b.i).map((x) => x.i);
  for (let pass = 0; left > 0 && pass < cap + 1; pass++) {
    let placed = false;
    for (const i of order) {
      if (left <= 0) break;
      if (counts[i] < cap) {
        counts[i]++;
        left--;
        placed = true;
      }
    }
    if (!placed) break;
  }
  return counts;
}

const rankOf = (priority: ChannelId[]) => (ch: ChannelId) => {
  const i = priority.indexOf(ch);
  return i >= 0 ? i : priority.length;
};

/** The slots of an earlier selection (a continuation reuses the plan it was made with). */
export function slotsFromSelection(items: { slotId: string; conceptId: string; conceptName: string; index: number; channel: ChannelId; format: string; formatClass: FormatClass; width: number; height: number; variationId: string | null; sourceKind: 'ai_original' | 'brand_image' | 'none' }[]): TemplateSlot[] {
  return items.map((i) => ({ slotId: i.slotId, conceptId: i.conceptId, conceptName: i.conceptName, index: i.index, channel: i.channel, formatId: i.format, width: i.width, height: i.height, formatClass: i.formatClass, variationId: i.variationId, source: i.sourceKind }));
}

export function planHybrid(input: HybridPlanInput): HybridPlan {
  const originals = Math.max(0, Math.min(Math.floor(input.originals), HARD_MAX_IMAGES));
  const templates = Math.max(0, Math.floor(input.templateCreatives));
  const warnings: string[] = [];
  const rank = rankOf(input.channelPriority);

  // 1) the originals: the same deterministic planner as Full Production
  const allocation = planImageAllocation({ target: originals, concepts: input.concepts, channelPriority: input.channelPriority, fixedSize: input.fixedSize, layoutsPerOriginal: 3, basis: input.basis });

  // 2) how many template creatives each concept gets: an even share, the remainder to the concepts with the most valuable channels
  const weights = input.concepts.map((c) => 1 + c.channels.reduce((s, ch) => s + 1 / (1 + 0.35 * rank(ch)), 0));
  const counts = evenThenWeighted(templates, weights, Math.max(1, Math.ceil(templates / Math.max(1, input.concepts.length)) + 2));
  const placed = counts.reduce((a, b) => a + b, 0);
  if (placed < templates) warnings.push(`Only ${placed} of the ${templates} template creatives can be placed with ${input.concepts.length} concept(s).`);

  // 3) channel, format and source original of every template creative
  const slots: TemplateSlot[] = [];
  input.concepts.forEach((c, ci) => {
    const count = counts[ci];
    const channels = [...new Set(c.channels)].sort((a, b) => rank(a) - rank(b));
    const covered: ChannelId[] = channels.length ? channels : ['instagram'];
    const mine = allocation.variations.filter((v) => v.conceptId === c.id);
    // channels take turns and each takes its formats in order; a format that is already in the list is only repeated after every other
    // format was used, so one concept does not repeat a format while another one is free
    const maxLen = Math.max(1, ...covered.map((ch) => (HYBRID_FORMATS[ch] ?? []).length));
    const firstPass: { channel: ChannelId; formatId: string }[] = [];
    const repeats: { channel: ChannelId; formatId: string }[] = [];
    for (let r = 0; r < maxLen; r++) {
      for (const ch of covered) {
        const list = HYBRID_FORMATS[ch] ?? ['instagram_square'];
        if (r >= list.length) continue;
        const pair = { channel: ch, formatId: list[r] };
        (firstPass.some((p) => p.formatId === pair.formatId) ? repeats : firstPass).push(pair);
      }
    }
    const chosen = (input.formatIds ?? []).filter((id) => !!CREATIVE_FORMATS[id]);
    // chosen formats: every one is used before any repeats, and each concept starts at a different one so the whole campaign covers them evenly
    const pairs = chosen.length ? chosen.map((id) => ({ channel: channelForFormat(id, covered), formatId: id })) : [...firstPass, ...repeats];
    for (let i = 0; i < count; i++) {
      const { channel, formatId } = pairs[(i + (chosen.length ? ci : 0)) % pairs.length];
      const fmt = CREATIVE_FORMATS[formatId];
      const original = mine.length ? mine[i % mine.length] : null;
      slots.push({
        slotId: `${c.id}-T${i + 1}`,
        conceptId: c.id,
        conceptName: c.name,
        index: i + 1,
        channel,
        formatId: fmt.id,
        width: fmt.width,
        height: fmt.height,
        formatClass: formatClassOf(fmt.width, fmt.height),
        variationId: original?.variationId ?? null,
        source: original ? 'ai_original' : input.brandImages > 0 ? 'brand_image' : 'none',
      });
    }
  });

  // 4) each original's size follows the formats that will be built from it; every planned original keeps its place in the plan
  const variations: PlannedVariation[] = allocation.variations.map((v) => {
    const mine = slots.filter((s) => s.variationId === v.variationId);
    const formatIds = [...new Set(mine.map((s) => s.formatId))];
    const formats = (formatIds.length ? formatIds.map((id) => CREATIVE_FORMATS[id]) : formatsForChannels(v.targetChannels, 1).map((f) => f.format)).filter(Boolean);
    return { ...v, targetChannels: [...new Set([...mine.map((s) => s.channel), ...(mine.length ? [] : v.targetChannels)])], formats: formatIds, size: input.fixedSize ?? baseSizeFor(formats) };
  });
  const noOriginal = input.concepts.filter((c) => !allocation.variations.some((v) => v.conceptId === c.id));
  if (originals > 0 && noOriginal.length) warnings.push(`${noOriginal.length} concept(s) get no AI original (${originals} originals for ${input.concepts.length} concepts); their creatives use ${input.brandImages ? 'the project\'s brand images' : 'image-free templates'}.`);
  if (originals === 0 && templates > 0) warnings.push('No original AI images were requested: every creative is a template creative built from brand assets or image-free templates.');

  return {
    allocation: { ...allocation, variations, expectedLayouts: slots.length, rules: [...allocation.rules.slice(0, 3), 'Hybrid Production: the originals are delivered as they are; every other creative is a template creative rendered locally from an original (or a brand image), so no extra image request is made for it.'] },
    slots,
    perConcept: input.concepts.map((c, i) => ({ conceptId: c.id, name: c.name, originals: allocation.variations.filter((v) => v.conceptId === c.id).length, templates: counts[i], channels: c.channels })),
    rules: [
      `${originals} original AI image(s) and ${placed} template creative(s) = ${originals + placed} finished creatives.`,
      'Each concept gets an even share of the template creatives; any remainder goes to the concepts with the best ranked channels.',
      input.formatIds?.length ? `The formats you chose in the campaign design are used in turn: ${input.formatIds.map((f) => CREATIVE_FORMATS[f]?.label ?? f).join(', ')}.` : 'Channels and formats take turns inside a concept, so one concept does not repeat a format while another one is free.',
      'Each template creative is built from one original of its concept; an original may serve several creatives (the lineage says which).',
    ],
    warnings: [...allocation.warnings, ...warnings],
  };
}
