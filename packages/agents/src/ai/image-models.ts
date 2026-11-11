import { isSupportedImageModel } from './openai-images';

/**
 * What LaunchPilot knows about the lifecycle of OpenAI image models, from OpenAI's own SDK documentation.
 * IMPORTANT: GET /models can keep LISTING a model long after it stopped accepting requests (gpt-image-1 was shut down on
 * 2026-10-23 and was still listed afterwards), so "listed" never means "usable". This table is a guard, not a guarantee: the
 * only proof that a model works for an account is an actual image request (see the explicit "Test image model" action).
 */
export interface ImageModelLifecycle {
  retiredOn: string;
  replacements: string[];
}

export const RETIRED_IMAGE_MODELS: Record<string, ImageModelLifecycle> = {
  'gpt-image-1': { retiredOn: '2026-10-23', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
  // announced 2026-06-02 (OpenAI deprecations page): still accepted today, shut down on this date
  'gpt-image-1-mini': { retiredOn: '2026-12-01', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
  'dall-e-2': { retiredOn: '2026-05-12', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
  'dall-e-3': { retiredOn: '2026-05-12', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
};

/** The lifecycle record when the model has been shut down as of `now`, else null. */
export function retiredImageModel(id: string, now: Date = new Date()): ImageModelLifecycle | null {
  const l = RETIRED_IMAGE_MODELS[id];
  return l && now.getTime() >= Date.parse(`${l.retiredOn}T00:00:00Z`) ? l : null;
}

/**
 * HOW "AUTOMATIC" CHOOSES. Three strategies, because "the best model" and "the cheapest model" are different questions:
 *   economy  = the smallest current model first (First Test and Demo: a low-cost try-out; this was the only behavior before);
 *   balanced = a current, fully priced mid-tier model first;
 *   quality  = the most capable current model first (Full Production).
 * The orders come from what OpenAI itself says about each model (IMAGE_MODEL_INFO.positioning); there is no independent image-quality
 * benchmark in this repository, so a ranking is a documented preference, never a measured result. Price is never part of the order.
 */
export type ImageModelStrategy = 'economy' | 'balanced' | 'quality';
export const IMAGE_MODEL_STRATEGIES: ImageModelStrategy[] = ['economy', 'balanced', 'quality'];

export interface ImageModelInfo {
  tier: 'economy' | 'standard' | 'flagship';
  /** Quality values the model's documentation lists. A value outside this list is refused, never silently replaced. */
  qualities: string[];
  /** The model accepts WIDTHxHEIGHT sizes besides the three standard ones (documented for GPT Image 2.5). */
  customSizes: boolean;
  /** What OpenAI's own pages say about the model (read 2026-10-31). Not an independent comparison. */
  positioning: string;
}

const STD_QUALITIES = ['low', 'medium', 'high', 'auto'];
export const IMAGE_MODEL_INFO: Record<string, ImageModelInfo> = {
  'gpt-image-2.5-sunburst': { tier: 'flagship', qualities: [...STD_QUALITIES, 'xhigh', 'max'], customSizes: true, positioning: 'OpenAI: "our most capable model for image generation and editing" (the guide: "choose Sunburst for workflows where editing precision matters most").' },
  'gpt-image-2.5-flare': { tier: 'flagship', qualities: [...STD_QUALITIES, 'xhigh', 'max'], customSizes: true, positioning: 'OpenAI: its "fastest model for high-quality, everyday image generation".' },
  'gpt-image-2': { tier: 'standard', qualities: STD_QUALITIES, customSizes: false, positioning: 'OpenAI: a "state-of-the-art image generation model".' },
  'gpt-image-1.5': { tier: 'standard', qualities: STD_QUALITIES, customSizes: false, positioning: 'OpenAI: "our previous image generation model, with better instruction following and adherence to prompts" (deprecated, no shutdown date announced).' },
  'gpt-image-1-mini': { tier: 'economy', qualities: STD_QUALITIES, customSizes: false, positioning: 'OpenAI\'s smallest GPT Image model (deprecated; shutdown announced for 2026-12-01).' },
};

const ORDER: Record<ImageModelStrategy, string[]> = {
  economy: ['gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
  balanced: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-1.5', 'gpt-image-2.5-sunburst', 'gpt-image-1-mini'],
  quality: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'],
};

/** The original (economy) order, kept under its old name. */
export const IMAGE_MODEL_PREFERENCE = ORDER.economy;

const isSnapshot = (id: string) => /-\d{4}-\d{2}-\d{2}$/.test(id);

export interface ImageModelPick {
  model: string;
  strategy: ImageModelStrategy;
  /** One sentence: why this model, in terms of the documented positioning (never "best quality" as a fact). */
  reason: string;
  /** The usable models that were NOT chosen, in the strategy's order (so the user can see the alternatives). */
  alternatives: string[];
  /** true = LaunchPilot has no documentation for this model (a newer id); it was chosen only because nothing better is known. */
  unknownModel: boolean;
}

/**
 * The model an automatic choice uses. Retired models are never offered. For balanced and quality, a model whose announced shutdown is
 * within 90 days is moved behind longer-lived alternatives; economy keeps its original behavior exactly.
 */
export function pickImageModelFor(listed: string[], strategy: ImageModelStrategy = 'economy', now: Date = new Date()): ImageModelPick | null {
  const usable = listed.filter((id) => isSupportedImageModel(id) && !retiredImageModel(id, now) && !isSnapshot(id));
  if (!usable.length) return null;
  let known = ORDER[strategy].filter((id) => usable.includes(id));
  if (strategy !== 'economy') {
    const soon = known.filter((id) => imageModelWarning(id, now));
    const later = known.filter((id) => !soon.includes(id));
    if (later.length) known = [...later, ...soon];
  }
  const unknown = usable.filter((id) => !(id in IMAGE_MODEL_INFO)).sort();
  const chosen = known[0] ?? unknown[0];
  if (!chosen) return null;
  const info = IMAGE_MODEL_INFO[chosen];
  const alternatives = [...known, ...unknown].filter((id) => id !== chosen);
  const why =
    strategy === 'economy' ? 'the smallest current model first (a low-cost try-out)'
    : strategy === 'balanced' ? 'a current, fully priced mid-tier model first'
    : 'the most capable current model first, ahead of price';
  return { model: chosen, strategy, reason: `Chosen by the "${strategy}" strategy (${why}). ${info ? info.positioning : 'LaunchPilot has no documentation for this newer model; it is used only because nothing better is known.'}`, alternatives, unknownModel: !info };
}

/** The model an automatic choice uses (economy order unless a strategy is given). */
export function pickImageModel(listed: string[], now: Date = new Date(), strategy: ImageModelStrategy = 'economy'): string | null {
  return pickImageModelFor(listed, strategy, now)?.model ?? null;
}

/** Why a quality value cannot be used with a model, or null. A model LaunchPilot has no documentation for is not refused. */
export function imageQualityProblem(model: string, quality: string): string | null {
  const info = IMAGE_MODEL_INFO[model];
  if (!info || info.qualities.includes(quality)) return null;
  return `${model} does not list the quality "${quality}" (it lists: ${info.qualities.join(', ')}). LaunchPilot does not replace it with another value.`;
}

/** A heads-up (not a refusal) when a model that still works has a shutdown date within the next 90 days. */
export function imageModelWarning(id: string, now: Date = new Date()): string | null {
  const l = RETIRED_IMAGE_MODELS[id];
  if (!l || retiredImageModel(id, now)) return null;
  const days = Math.ceil((Date.parse(`${l.retiredOn}T00:00:00Z`) - now.getTime()) / 86_400_000);
  return days <= 90 ? `OpenAI will shut down ${id} on ${l.retiredOn} (in ${days} day${days === 1 ? '' : 's'}). It works today; plan to move to ${l.replacements.join(' or ')}.` : null;
}

/** Why a model cannot be used, in a sentence, or null when nothing known speaks against it. */
export function imageModelProblem(id: string, now: Date = new Date()): string | null {
  const r = retiredImageModel(id, now);
  if (r) return `OpenAI shut down ${id} on ${r.retiredOn}; requests to it are rejected even if your key still lists it. Choose ${r.replacements.join(' or ')} (or another current GPT Image model).`;
  if (!isSupportedImageModel(id)) return 'Only GPT Image models (gpt-image-*) can generate images. A text model cannot.';
  return null;
}
