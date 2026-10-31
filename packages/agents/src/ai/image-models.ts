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
  'dall-e-2': { retiredOn: '2026-05-12', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
  'dall-e-3': { retiredOn: '2026-05-12', replacements: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] },
};

/** The lifecycle record when the model has been shut down as of `now`, else null. */
export function retiredImageModel(id: string, now: Date = new Date()): ImageModelLifecycle | null {
  const l = RETIRED_IMAGE_MODELS[id];
  return l && now.getTime() >= Date.parse(`${l.retiredOn}T00:00:00Z`) ? l : null;
}

/**
 * Order in which an automatic choice looks at the models a key lists: the smallest current GPT Image model first (a sensible
 * default for a first, low-cost test), then the newer ones. It is a PREFERENCE, not a price list: LaunchPilot does not know prices.
 */
export const IMAGE_MODEL_PREFERENCE = ['gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];

const isSnapshot = (id: string) => /-\d{4}-\d{2}-\d{2}$/.test(id);

/** The model an automatic choice uses: the first preferred model the key lists and that is not retired, else any other listed one. */
export function pickImageModel(listed: string[], now: Date = new Date()): string | null {
  const usable = listed.filter((id) => isSupportedImageModel(id) && !retiredImageModel(id, now) && !isSnapshot(id));
  for (const id of IMAGE_MODEL_PREFERENCE) if (usable.includes(id)) return id;
  return [...usable].sort()[0] ?? null;
}

/** Why a model cannot be used, in a sentence, or null when nothing known speaks against it. */
export function imageModelProblem(id: string, now: Date = new Date()): string | null {
  const r = retiredImageModel(id, now);
  if (r) return `OpenAI shut down ${id} on ${r.retiredOn}; requests to it are rejected even if your key still lists it. Choose ${r.replacements.join(' or ')} (or another current GPT Image model).`;
  if (!isSupportedImageModel(id)) return 'Only GPT Image models (gpt-image-*) can generate images. A text model cannot.';
  return null;
}
