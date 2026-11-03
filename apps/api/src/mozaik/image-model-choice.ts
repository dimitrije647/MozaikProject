import { IMAGE_MODEL_INFO, imageModelProblem, imageQualityProblem, isSupportedImageModel, pickImageModelFor, retiredImageModel, type ImageModelStrategy } from '@launchpilot/agents';

/** "auto" = LaunchPilot picks a current GPT Image model from the models the user's own key lists (never a retired one). */
export const AUTO_IMAGE_MODEL = 'auto';

export interface ImageModelChoice {
  /** The model that will be requested; null = none usable (see `blocker`) or no images wanted. */
  model: string | null;
  mode: 'none' | 'auto' | 'explicit';
  /** true = listed for the key, false = not listed, null = could not tell (or not asked). */
  available: boolean | null;
  note: string;
  blocker: { code: 'image_model_unsupported' | 'image_model_unavailable' | 'image_model_retired' | 'image_model_unresolved' | 'image_quality_unsupported'; message: string } | null;
  /** The strategy an automatic choice followed (economy | balanced | quality); null for an explicit model. */
  strategy: ImageModelStrategy | null;
  /** Why this model: what OpenAI's own pages say about it. A documented preference, never a measured quality result. */
  reason: string | null;
  /** The other usable models of the key, in the strategy's order. */
  alternatives: string[];
  /**
   * listed_not_tested = the key lists the model but nobody has proved that this account may generate images with it (organization
   * verification, project permission); only a billed image request can. not_listed / unknown otherwise.
   */
  verification: 'listed_not_tested' | 'not_listed' | 'unknown';
  /** Documentation of the model that LaunchPilot holds (quality values, positioning), or null for an undocumented id. */
  documented: { tier: string; qualities: string[]; positioning: string } | null;
}

const LISTING_CAVEAT = 'A listing does not prove your account may use the model; only an image request does.';

/**
 * Decides which image model a run uses and refuses the ones that cannot work, BEFORE anything is spent. Pure: `listed` is the model
 * list of the user's own key (GET /models, free) or null when it could not be read.
 */
const docOf = (id: string | null) => {
  const i = id ? IMAGE_MODEL_INFO[id] : undefined;
  return i ? { tier: i.tier, qualities: i.qualities, positioning: i.positioning } : null;
};

export function chooseImageModel(requested: string | null | undefined, listed: string[] | null, now: Date = new Date(), strategy: ImageModelStrategy = 'economy', quality?: string | null): ImageModelChoice {
  const base = { strategy: null, reason: null, alternatives: [] as string[], verification: 'unknown' as const, documented: null };
  const want = requested?.trim() || null;
  if (!want) return { ...base, model: null, mode: 'none', available: null, note: 'No image model selected: no image is generated; layouts use brand-colored backgrounds.', blocker: null };
  const imageIds = (listed ?? []).filter((id) => isSupportedImageModel(id));

  if (want === AUTO_IMAGE_MODEL) {
    if (!listed) return { ...base, model: null, mode: 'auto', available: null, note: 'The model list of your key could not be read.', blocker: { code: 'image_model_unresolved', message: 'The image model cannot be chosen automatically because your OpenAI model list could not be read just now. Try again, choose a model yourself, or turn images off.' } };
    const pick = pickImageModelFor(listed, strategy, now);
    const picked = pick?.model ?? null;
    if (!picked) {
      const retired = imageIds.filter((id) => retiredImageModel(id, now));
      return { ...base, model: null, mode: 'auto', available: false, note: 'Your key lists no current GPT Image model.', blocker: { code: 'image_model_unavailable', message: `Your OpenAI key lists no current GPT Image model.${retired.length ? ` ${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} still listed but ${retired.length === 1 ? 'was' : 'were'} shut down by OpenAI and cannot generate images.` : ''} Choose another model or turn images off.` } };
    }
    const qProblem = quality ? imageQualityProblem(picked, quality) : null;
    return {
      model: picked,
      mode: 'auto',
      available: true,
      strategy,
      reason: pick!.reason,
      alternatives: pick!.alternatives,
      verification: 'listed_not_tested',
      documented: docOf(picked),
      note: `Chosen automatically (${strategy}): "${picked}" is listed for your key and is not retired. ${pick!.reason} ${LISTING_CAVEAT}`,
      blocker: qProblem ? { code: 'image_quality_unsupported', message: qProblem } : null,
    };
  }

  const problem = imageModelProblem(want, now);
  if (problem) return { ...base, model: want, mode: 'explicit', available: false, note: problem, blocker: { code: retiredImageModel(want, now) ? 'image_model_retired' : 'image_model_unsupported', message: problem } };
  const qProblem = quality ? imageQualityProblem(want, quality) : null;
  const qBlocker = qProblem ? ({ code: 'image_quality_unsupported', message: qProblem } as const) : null;
  const ex = { ...base, documented: docOf(want), reason: IMAGE_MODEL_INFO[want]?.positioning ?? null };
  if (!listed) return { ...ex, model: want, mode: 'explicit', available: null, verification: 'unknown', note: 'The model list could not be read, so the image model was not pre-checked. If it is unavailable, the run says so and uses brand-colored backgrounds.', blocker: qBlocker };
  if (listed.includes(want)) return { ...ex, model: want, mode: 'explicit', available: true, verification: 'listed_not_tested', note: `"${want}" is listed for your key. ${LISTING_CAVEAT}`, blocker: qBlocker };
  const note = imageIds.length ? `Your key lists: ${imageIds.join(', ')}.` : 'Your key lists no gpt-image model.';
  return { ...ex, model: want, mode: 'explicit', available: false, verification: 'not_listed', note, blocker: { code: 'image_model_unavailable', message: `The image model "${want}" is not available to your OpenAI key. ${note} Choose another or turn images off.` } };
}
