import { imageModelProblem, isSupportedImageModel, pickImageModel, retiredImageModel } from '@launchpilot/agents';

/** "auto" = LaunchPilot picks a current GPT Image model from the models the user's own key lists (never a retired one). */
export const AUTO_IMAGE_MODEL = 'auto';

export interface ImageModelChoice {
  /** The model that will be requested; null = none usable (see `blocker`) or no images wanted. */
  model: string | null;
  mode: 'none' | 'auto' | 'explicit';
  /** true = listed for the key, false = not listed, null = could not tell (or not asked). */
  available: boolean | null;
  note: string;
  blocker: { code: 'image_model_unsupported' | 'image_model_unavailable' | 'image_model_retired' | 'image_model_unresolved'; message: string } | null;
}

const LISTING_CAVEAT = 'A listing does not prove your account may use the model; only an image request does.';

/**
 * Decides which image model a run uses and refuses the ones that cannot work, BEFORE anything is spent. Pure: `listed` is the model
 * list of the user's own key (GET /models, free) or null when it could not be read.
 */
export function chooseImageModel(requested: string | null | undefined, listed: string[] | null, now: Date = new Date()): ImageModelChoice {
  const want = requested?.trim() || null;
  if (!want) return { model: null, mode: 'none', available: null, note: 'No image model selected: no image is generated; layouts use brand-colored backgrounds.', blocker: null };
  const imageIds = (listed ?? []).filter((id) => isSupportedImageModel(id));

  if (want === AUTO_IMAGE_MODEL) {
    if (!listed) return { model: null, mode: 'auto', available: null, note: 'The model list of your key could not be read.', blocker: { code: 'image_model_unresolved', message: 'The image model cannot be chosen automatically because your OpenAI model list could not be read just now. Try again, choose a model yourself, or turn images off.' } };
    const picked = pickImageModel(listed, now);
    if (!picked) {
      const retired = imageIds.filter((id) => retiredImageModel(id, now));
      return { model: null, mode: 'auto', available: false, note: 'Your key lists no current GPT Image model.', blocker: { code: 'image_model_unavailable', message: `Your OpenAI key lists no current GPT Image model.${retired.length ? ` ${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} still listed but ${retired.length === 1 ? 'was' : 'were'} shut down by OpenAI and cannot generate images.` : ''} Choose another model or turn images off.` } };
    }
    return { model: picked, mode: 'auto', available: true, note: `Chosen automatically: "${picked}" is listed for your key and is not retired. ${LISTING_CAVEAT}`, blocker: null };
  }

  const problem = imageModelProblem(want, now);
  if (problem) return { model: want, mode: 'explicit', available: false, note: problem, blocker: { code: retiredImageModel(want, now) ? 'image_model_retired' : 'image_model_unsupported', message: problem } };
  if (!listed) return { model: want, mode: 'explicit', available: null, note: 'The model list could not be read, so the image model was not pre-checked. If it is unavailable, the run says so and uses brand-colored backgrounds.', blocker: null };
  if (listed.includes(want)) return { model: want, mode: 'explicit', available: true, note: `"${want}" is listed for your key. ${LISTING_CAVEAT}`, blocker: null };
  const note = imageIds.length ? `Your key lists: ${imageIds.join(', ')}.` : 'Your key lists no gpt-image model.';
  return { model: want, mode: 'explicit', available: false, note, blocker: { code: 'image_model_unavailable', message: `The image model "${want}" is not available to your OpenAI key. ${note} Choose another or turn images off.` } };
}
