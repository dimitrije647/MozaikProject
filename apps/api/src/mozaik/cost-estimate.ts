import {
  IMAGE_MODEL_INFO,
  PRICE_BOOK_VERIFIED_AT,
  PRICE_SOURCES,
  cheaperImageModels,
  imageCostEstimate,
  imageModelWarning,
  maxOutputTokensFor,
  retiredImageModel,
  textCostUsd,
  textPrice,
  type ImageCostBasis,
} from '@launchpilot/agents';
import type { PhaseKey } from './factory-plan';

/**
 * The preflight COST ESTIMATE. Every dollar figure here is derived from the price book (OpenAI's published prices, with the date they
 * were read) and from token volumes: measured from the user's own earlier runs where they exist, otherwise from stated assumptions.
 * It is an ESTIMATE, never a guarantee and never an invoice. A model without a published price gets "unavailable", never an invented
 * number. Pure functions: no I/O, no clock.
 */

export interface PhaseProfile {
  inputPerCall: number;
  outputPerCall: number;
  /** Earlier runs the averages come from (0 = the documented defaults below). */
  samples: number;
}
export type Profiles = Partial<Record<PhaseKey, PhaseProfile>>;

/** Tokens per call assumed when the user has no earlier run of a phase. They are assumptions, listed as such in every estimate. */
export const DEFAULT_PROFILE: Record<PhaseKey, { inputPerCall: number; outputPerCall: number }> = {
  discovery: { inputPerCall: 9000, outputPerCall: 1500 },
  audit: { inputPerCall: 11000, outputPerCall: 1500 },
  strategy: { inputPerCall: 14000, outputPerCall: 1800 },
  creative: { inputPerCall: 12000, outputPerCall: 1500 },
};

export interface CostPhaseInput {
  phase: PhaseKey;
  runs: boolean;
  typicalCalls: number;
  capCalls: number;
  /** The output cap sent with each call of this phase (after the model's own limit was applied). */
  outputCap: number;
}

export interface CostInput {
  textModel: string | null;
  imageModel: string | null;
  imageQuality: string;
  /** One size per original image that will be requested. */
  imageSizes: string[];
  phases: CostPhaseInput[];
  profiles: Profiles;
  targetUsd: number | null;
  approvedUsd: number | null;
  /** Image models the user's key lists (for the "cheaper model" option). null = unknown. */
  listedImageModels: string[] | null;
}

export interface PhaseCost {
  phase: PhaseKey;
  runs: boolean;
  calls: { typical: number; cap: number };
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  outputCap: number;
  basis: 'measured' | 'assumed';
  typicalUsd: number | null;
  maxUsd: number | null;
}

export type BudgetStatus = 'no_budget' | 'within' | 'may_stop_early' | 'below_estimate' | 'unknown';

export interface BudgetOption {
  /** priced_model / image_free are offered when the image price is not published (no dollar figure can bound the images): a bounded way out. */
  id: 'raise_budget' | 'cheaper_model' | 'lower_quality' | 'fewer_images' | 'priced_model' | 'image_free';
  label: string;
  detail: string;
  /** What to set to apply it (the user applies it; nothing changes by itself). imageFree = no image model at all. */
  set: { approvedBudgetUsd?: number; imageModel?: string; imageQuality?: string; maxImages?: number; imageFree?: boolean };
  estimatedTotalUsd: number | null;
}

export interface CostEstimate {
  currency: 'USD';
  priceBookVerifiedAt: string;
  sources: typeof PRICE_SOURCES;
  /** true when every request that will be made can be priced before it is sent. */
  available: boolean;
  text: { model: string | null; priced: boolean; maxOutputTokensLimit: { limit: number; verified: boolean }; phases: PhaseCost[]; typicalUsd: number | null; maxUsd: number | null };
  images: { model: string | null; quality: string; count: number; perImageUsd: number | null; typicalUsd: number | null; maxUsd: number | null; basis: ImageCostBasis | 'none'; note: string; /** Only when the image price is not published: ways to bound the image cost (a model with a published price, or no images). The user applies one; nothing changes by itself. */ alternatives: BudgetOption[]; /** For orientation ONLY when the model has no published per-image price: what GPT Image 2 (same token rates) costs for these images. Not an estimate. */ reference: { model: string; totalUsd: number; note: string } | null };
  totals: { typicalUsd: number | null; maxUsd: number | null; knownPartUsd: number };
  budget: {
    targetUsd: number | null;
    approvedUsd: number | null;
    status: BudgetStatus;
    message: string;
    options: BudgetOption[];
  };
  assumptions: string[];
  warnings: string[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const up2 = (n: number) => Math.ceil(n * 100) / 100;

export function estimateCost(i: CostInput): CostEstimate {
  const priced = textPrice(i.textModel) !== null;
  const assumptions: string[] = [];
  const phases: PhaseCost[] = i.phases.map((p) => {
    const prof = i.profiles[p.phase];
    const measured = !!prof && prof.samples > 0;
    const def = DEFAULT_PROFILE[p.phase];
    const inTok = measured ? prof!.inputPerCall : def.inputPerCall;
    const outTok = measured ? prof!.outputPerCall : def.outputPerCall;
    if (p.runs) assumptions.push(measured ? `${p.phase}: ${Math.round(inTok)} input / ${Math.round(outTok)} output tokens per call, measured from ${prof!.samples} earlier run(s) of yours.` : `${p.phase}: ${inTok} input / ${outTok} output tokens per call (assumption: you have no earlier run of this phase).`);
    const typical = p.runs ? textCostUsd(i.textModel, { inputTokens: inTok * p.typicalCalls, outputTokens: outTok * p.typicalCalls }) : 0;
    // worst case: every call allowed, 1.5x the usual input and the FULL output cap
    const max = p.runs ? textCostUsd(i.textModel, { inputTokens: inTok * 1.5 * p.capCalls, outputTokens: p.outputCap * p.capCalls }) : 0;
    return { phase: p.phase, runs: p.runs, calls: { typical: p.typicalCalls, cap: p.capCalls }, inputTokensPerCall: Math.round(inTok), outputTokensPerCall: Math.round(outTok), outputCap: p.outputCap, basis: measured ? 'measured' : 'assumed', typicalUsd: typical === null ? null : r4(typical), maxUsd: max === null ? null : r4(max) };
  });
  const sum = (f: (p: PhaseCost) => number | null) => (phases.some((p) => p.runs && f(p) === null) ? null : r4(phases.reduce((a, p) => a + (f(p) ?? 0), 0)));
  const textTypical = sum((p) => p.typicalUsd);
  const textMax = sum((p) => p.maxUsd);

  // images: priced per planned original (its own size), from the price book
  const count = i.imageSizes.length;
  const each = i.imageSizes.map((s) => imageCostEstimate(i.imageModel, i.imageQuality, s));
  const imgKnown = !!i.imageModel && count > 0 && each.every((e) => e.usd !== null);
  const imgTotal = imgKnown ? r4(each.reduce((a, e) => a + (e.usd ?? 0), 0)) : null;
  const basis: ImageCostBasis | 'none' = !i.imageModel || count === 0 ? 'none' : each.some((e) => e.basis === 'unavailable') ? 'unavailable' : each.some((e) => e.basis === 'upper_bound_auto') ? 'upper_bound_auto' : 'per_image_table';
  const images = {
    model: i.imageModel,
    quality: i.imageQuality,
    count,
    perImageUsd: imgTotal === null || !count ? null : r4(imgTotal / count),
    typicalUsd: !i.imageModel || count === 0 ? 0 : imgTotal,
    maxUsd: !i.imageModel || count === 0 ? 0 : imgTotal,
    basis,
    note: !i.imageModel || count === 0 ? 'No AI image is requested.' : (each.find((e) => e.usd === null)?.note ?? each[0].note),
    reference: null as { model: string; totalUsd: number; note: string } | null,
    alternatives: [] as BudgetOption[],
  };
  if (basis === 'unavailable' && i.imageModel && /^gpt-image-2\.5/.test(i.imageModel) && ['low', 'medium', 'high'].includes(i.imageQuality)) {
    const ref = i.imageSizes.map((sz) => imageCostEstimate('gpt-image-2', i.imageQuality, sz).usd);
    if (ref.every((x): x is number => x !== null)) images.reference = { model: 'gpt-image-2', totalUsd: r2(ref.reduce((a, b) => a + b, 0)), note: `For orientation only, NOT an estimate: GPT Image 2 is billed at the same token rates as ${i.imageModel}, and its per-image prices for these ${count} images add up to this. OpenAI publishes no token count per image for ${i.imageModel}.` };
  }

  // an unpublished image price cannot be bounded in dollars: offer the two honest ways out (a model with a published price, or no images)
  if (basis === 'unavailable' && i.imageModel && count > 0) {
    const size = i.imageSizes[0] ?? '1024x1024';
    const now = new Date();
    const priced = cheaperImageModels(i.imageQuality, size)
      .filter((m) => m.model !== i.imageModel && !retiredImageModel(m.model, now) && !imageModelWarning(m.model, now) && IMAGE_MODEL_INFO[m.model]?.qualities.includes(i.imageQuality) !== false && (i.listedImageModels === null || i.listedImageModels.includes(m.model)))
      .sort((a, b) => (IMAGE_MODEL_INFO[a.model]?.tier === 'economy' ? 1 : 0) - (IMAGE_MODEL_INFO[b.model]?.tier === 'economy' ? 1 : 0) || a.usd - b.usd);
    for (const m of priced.slice(0, 2)) {
      const total = r2(i.imageSizes.reduce((a, sz) => a + (imageCostEstimate(m.model, i.imageQuality, sz).usd ?? m.usd), 0));
      images.alternatives.push({ id: 'priced_model', label: `Use ${m.model} (published price)`, detail: `${count} image request(s) at OpenAI's published price: about ${total.toFixed(2)} US dollars in total, so the image cost can be bounded in dollars. Its output differs from ${i.imageModel}, and LaunchPilot never switches by itself.`, set: { imageModel: m.model }, estimatedTotalUsd: r2((textTypical ?? 0) + total) });
    }
    images.alternatives.push({ id: 'image_free', label: 'Run without original AI images', detail: 'No image request is made, so there is no image cost. The creatives are template creatives built from your brand images and picture-free templates; the plan shows how many that is.', set: { imageFree: true }, estimatedTotalUsd: textTypical });
  }

  const typical = textTypical === null || images.typicalUsd === null ? null : r4(textTypical + images.typicalUsd);
  const max = textMax === null || images.maxUsd === null ? null : r4(textMax + images.maxUsd);
  const known = r4((textTypical ?? 0) + (images.typicalUsd ?? 0));
  const warnings: string[] = [];
  if (!priced && i.phases.some((p) => p.runs)) warnings.push(`Cost estimate unavailable for the text model "${i.textModel}": there is no verified price for it. The call and token limits below still apply, and LaunchPilot cannot bound the text spending in dollars.`);
  if (i.imageModel && count > 0 && !imgKnown) warnings.push(`Cost estimate unavailable for the images: ${images.note} The image request cap (${count}) still applies.`);
  if (basis === 'upper_bound_auto') warnings.push('Image quality "auto" lets the model choose; the estimate uses the price of "high" as an upper bound.');

  // budget status and the explicit ways out when the plan does not fit. There is ONE approved total for everything that is paid for:
  // the text agents, the images, the reviews and the repairs. It is never split into pools; the estimate below only informs.
  const approved = i.approvedUsd;
  const unpricedImages = !!i.imageModel && count > 0 && !imgKnown;
  let status: BudgetStatus = 'no_budget';
  let message = 'No spending limit has been set.';
  if (approved !== null) {
    if (typical === null) {
      if (known > approved) {
        status = 'below_estimate';
        message = `The approved $${approved.toFixed(2)} is below the part of this plan that can already be priced ($${known.toFixed(2)}), and the image cost is not available on top of it: the run could not finish. Choose one of the options below.`;
      } else {
        status = 'unknown';
        message = unpricedImages
          ? `Image pricing is not available. Your approved campaign budget of $${approved.toFixed(2)} is an application-level spending target, not a guaranteed billing cap for unpriced requests. The part that can be priced is about $${known.toFixed(2)}; the first image goes alone and the rest of the campaign is protected with its real cost.`
          : `The estimate is unavailable for part of this plan, so $${approved.toFixed(2)} cannot be compared with it. The budget is still enforced for every request that can be priced.`;
      }
    } else if (approved < typical) {
      status = 'below_estimate';
      message = `The approved $${approved.toFixed(2)} is below the typical estimate of $${typical.toFixed(2)}: the run could not finish. Choose one of the options below.`;
    } else if (max !== null && approved < max) {
      status = 'may_stop_early';
      message = `The approved $${approved.toFixed(2)} covers the typical estimate ($${typical.toFixed(2)}) but not the worst case ($${max.toFixed(2)}). If real usage is higher, requests are refused before they are sent, the required images come before optional checks, and the campaign is saved as incomplete if something required cannot be paid for.`;
    } else {
      status = 'within';
      message = `The approved $${approved.toFixed(2)} covers the estimate (typical $${typical.toFixed(2)}, worst case ${max === null ? 'unavailable' : `$${max.toFixed(2)}`}). Money that one kind of work does not use stays available for the rest.`;
    }
  } else if (i.targetUsd !== null && typical !== null && typical > i.targetUsd) {
    message = `The typical estimate ($${typical.toFixed(2)}) is above the $${i.targetUsd.toFixed(2)} this preset aims at. Choose one of the options below.`;
  }
  const options: BudgetOption[] = [];
  const over = (approved !== null && ((typical !== null && approved < typical) || (typical === null && known > approved))) || (typical !== null && i.targetUsd !== null && typical > i.targetUsd && approved === null);
  if (over) {
    if (typical !== null) options.push({ id: 'raise_budget', label: 'Keep the plan and approve a higher budget', detail: `Approve $${up2(max ?? typical).toFixed(2)} (the worst case of this exact plan).`, set: { approvedBudgetUsd: up2(max ?? typical) }, estimatedTotalUsd: typical });
    else options.push({ id: 'raise_budget', label: 'Keep the plan and approve a higher budget', detail: `Approve at least $${up2(textMax ?? known).toFixed(2)} for the part that can be priced; the image cost is not available and comes on top of it.`, set: { approvedBudgetUsd: up2(textMax ?? known) }, estimatedTotalUsd: null });
    if (i.imageModel && count > 0 && imgTotal !== null) {
      const cheaper = cheaperImageModels(i.imageQuality, i.imageSizes[0] ?? '1024x1024').filter((m) => m.model !== i.imageModel && (i.listedImageModels === null || i.listedImageModels.includes(m.model)) && m.usd * count < imgTotal);
      for (const m of cheaper.slice(0, 2)) options.push({ id: 'cheaper_model', label: `Choose the cheaper image model ${m.model}`, detail: `${count} images at $${m.usd.toFixed(3)} each instead of $${(images.perImageUsd ?? 0).toFixed(3)}. Its output quality differs, and LaunchPilot never switches to it by itself.`, set: { imageModel: m.model }, estimatedTotalUsd: r2((textTypical ?? 0) + m.usd * count) });
      for (const q of ['low', 'medium'] as const) {
        if (q === i.imageQuality || (q === 'medium' && i.imageQuality === 'low')) continue;
        const t = i.imageSizes.reduce((a, s) => a + (imageCostEstimate(i.imageModel, q, s).usd ?? 0), 0);
        if (t > 0 && t < imgTotal) options.push({ id: 'lower_quality', label: `Lower the image quality to "${q}"`, detail: `${count} images for about $${t.toFixed(2)} instead of $${imgTotal.toFixed(2)}.`, set: { imageQuality: q }, estimatedTotalUsd: r2((textTypical ?? 0) + t) });
      }
      const room = (approved ?? i.targetUsd ?? 0) - (textTypical ?? 0);
      const perImage = images.perImageUsd ?? 0;
      const fit = perImage > 0 ? Math.max(0, Math.floor(room / perImage)) : 0;
      if (fit < count) options.push({ id: 'fewer_images', label: `Reduce the image count to ${fit}`, detail: `${fit} images would fit within $${Math.max(0, room).toFixed(2)} after the text work; the plan then has ${count - fit} fewer original images. LaunchPilot never lowers the count by itself.`, set: { maxImages: fit }, estimatedTotalUsd: r2((textTypical ?? 0) + fit * perImage) });
    }
  }

  return {
    currency: 'USD',
    priceBookVerifiedAt: PRICE_BOOK_VERIFIED_AT,
    sources: PRICE_SOURCES,
    available: priced && (imgKnown || !i.imageModel || count === 0),
    text: { model: i.textModel, priced, maxOutputTokensLimit: maxOutputTokensFor(i.textModel), phases, typicalUsd: textTypical, maxUsd: textMax },
    images,
    totals: { typicalUsd: typical, maxUsd: max, knownPartUsd: known },
    budget: { targetUsd: i.targetUsd, approvedUsd: approved, status, message, options },
    assumptions,
    warnings,
  };
}

/** Average tokens per call over earlier runs: measured from the usage their reports saved. */
export function profileFromUsage(rows: { calls: number; inputTokens: number; outputTokens: number }[]): PhaseProfile | null {
  const ok = rows.filter((r) => r.calls > 0 && r.inputTokens > 0);
  if (!ok.length) return null;
  const calls = ok.reduce((a, r) => a + r.calls, 0);
  return { inputPerCall: ok.reduce((a, r) => a + r.inputTokens, 0) / calls, outputPerCall: ok.reduce((a, r) => a + r.outputTokens, 0) / calls, samples: ok.length };
}
