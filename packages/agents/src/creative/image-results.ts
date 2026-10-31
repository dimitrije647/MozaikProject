import type { SafeProviderError } from '../ai/errors';
import { retiredImageModel } from '../ai/image-models';
import type { ImageResultRecord } from './schemas';

/** Failures that will hit every concept the same way: after one of them no further image request is made. */
export const SYSTEMATIC_IMAGE_FAILURES = new Set(['invalid_api_key', 'permission_denied', 'model_unavailable', 'insufficient_quota']);

type Stage = ImageResultRecord['stage'];

/** The user-facing explanation of a failed image request, built from what the provider said (never from guesses). */
export function explainImageFailure(model: string, err: SafeProviderError, now: Date = new Date()): { stage: NonNullable<Stage>; explanation: string } {
  const retired = retiredImageModel(model, now);
  const http = err.status ? `HTTP ${err.status}` : null;
  const said = err.providerMessage ? ` OpenAI said: "${err.providerMessage}"` : '';
  if (retired && ['bad_request', 'model_unavailable', 'permission_denied'].includes(err.code)) {
    return { stage: 'provider', explanation: `OpenAI shut down ${model} on ${retired.retiredOn}, so it no longer accepts image requests (it can still appear in your model list). Choose ${retired.replacements.join(' or ')} or another current GPT Image model.${said}` };
  }
  switch (err.code) {
    case 'invalid_api_key':
      return { stage: 'provider', explanation: 'OpenAI rejected your API key for the image request. Check or replace the key in Settings > AI providers.' };
    case 'permission_denied':
      return { stage: 'provider', explanation: `OpenAI refused the image request for this account (${http ?? 'HTTP 403'}). ${model} may need organization verification or permission for this project: check Settings > Organization > General on platform.openai.com, and that this key's project may use ${model}.${said}` };
    case 'model_unavailable':
      return { stage: 'provider', explanation: `OpenAI says the image model "${model}" does not exist or is not available to this API key.${said}` };
    case 'insufficient_quota':
      return { stage: 'provider', explanation: 'The OpenAI account has no remaining credit for image generation. Check billing on platform.openai.com.' };
    case 'rate_limited':
      return { stage: 'provider', explanation: 'OpenAI rate limit reached for image generation. Wait a moment and run again.' };
    case 'timeout':
      return { stage: 'provider', explanation: 'The image request did not finish within the time limit.' };
    case 'cancelled':
      return { stage: 'cancelled', explanation: 'The run was cancelled before this image was produced.' };
    case 'invalid_response':
      return { stage: 'decoding', explanation: 'OpenAI image generation returned an invalid response: it could not be decoded as an image, so no picture was received for this concept.' };
    case 'provider_unavailable':
      return { stage: 'provider', explanation: 'OpenAI could not be reached or had a temporary error.' };
    case 'bad_request':
    default: {
      if (err.providerCode === 'moderation_blocked') return { stage: 'provider', explanation: `OpenAI's safety system declined this concept's image prompt (moderation_blocked). Adjust the concept wording.${said}` };
      if (err.providerCode === 'billing_hard_limit_reached') return { stage: 'provider', explanation: `OpenAI reports the billing limit of the account has been reached.${said}` };
      return { stage: 'provider', explanation: `OpenAI rejected the image request (${http ?? 'HTTP 400'}${err.providerCode ? `, code ${err.providerCode}` : ''}${err.providerParam ? `, parameter ${err.providerParam}` : ''}).${said || ' The selected image model may be retired or may not accept these settings.'}` };
    }
  }
}

export interface ResultInput {
  conceptId: string;
  conceptName: string;
  model: string | null;
  assetId: string;
}

export const generatedResult = (i: ResultInput): ImageResultRecord => ({ ...i, requestAttempted: true, outcome: 'generated', stage: null, errorCode: null, providerStatus: null, providerCode: null, message: null, explanation: null, fallbackUsed: false });

export const providerFailure = (i: ResultInput, err: SafeProviderError, now: Date): ImageResultRecord => {
  const e = explainImageFailure(i.model ?? 'the image model', err, now);
  return { ...i, requestAttempted: true, outcome: 'failed', stage: e.stage, errorCode: err.code, providerStatus: err.status ?? null, providerCode: err.providerCode ?? null, message: err.providerMessage ?? err.message, explanation: e.explanation, fallbackUsed: true };
};

/** A concept for which NO request was made, and why (configuration, budget, planning or an earlier systematic failure). */
export const notAttempted = (i: ResultInput, stage: NonNullable<Stage>, explanation: string, outcome: 'failed' | 'skipped'): ImageResultRecord => ({ ...i, requestAttempted: false, outcome, stage, errorCode: null, providerStatus: null, providerCode: null, message: null, explanation, fallbackUsed: true });

/** The provider delivered an image (it was billed) but it could not be stored. */
export const storageFailure = (i: ResultInput, detail: string): ImageResultRecord => ({ ...i, requestAttempted: true, outcome: 'failed', stage: 'storage', errorCode: null, providerStatus: null, providerCode: null, message: detail, explanation: `Image generation succeeded (OpenAI delivered the image and bills it), but storing it failed: ${detail}. A brand-colored background was used instead.`, fallbackUsed: true });

/**
 * Exactly one result per concept for the saved package. Concepts the Visual Creator never reported on get a result derived from
 * facts: no image model was selected, or the picture plan could not be produced.
 */
export function completeImageResults(args: { concepts: { id: string; name: string }[]; results: ImageResultRecord[]; baseAssetOf: (conceptId: string) => string | null; imageGeneration: boolean; model: string | null; planningError: string | null }): ImageResultRecord[] {
  return args.concepts.map((c) => {
    const have = args.results.find((r) => r.conceptId === c.id);
    if (have) return have;
    const base = { conceptId: c.id, conceptName: c.name, model: args.model, assetId: args.baseAssetOf(c.id) ?? '' };
    if (!args.imageGeneration) return notAttempted(base, 'configuration', 'No image model was selected for this campaign, so no AI image was requested.', 'skipped');
    return notAttempted(base, 'planning', `The picture plan could not be completed${args.planningError ? ` (${args.planningError})` : ''}, so no image was requested for this concept.`, 'failed');
  });
}

/**
 * For campaigns saved BEFORE per-concept results were recorded: derives them from what the run did record (the stored assets and
 * the `visual.generated` events). Nothing is invented: a concept with an AI image is "generated"; one with a recorded failure
 * gets the explanation for that recorded error code; one with a brand-colored background and no event was never sent to the
 * provider. Every record is flagged `reconstructed`, and `at` (when the campaign was made) decides whether a model had been
 * shut down by then.
 */
export function reconstructImageResults(args: {
  concepts: { id: string; name: string }[];
  assets: { id: string; conceptId: string | null; kind: string; source?: string | null; status?: string | null; model?: string | null }[];
  visualEvents: { conceptId?: string; failed?: boolean; error?: { code?: string; message?: string } | null }[];
  imageModel: string | null;
  at: Date;
}): ImageResultRecord[] {
  return args.concepts.map((c) => {
    const base = [...args.assets].reverse().find((a) => a.conceptId === c.id && a.kind === 'image' && a.status !== 'superseded');
    const common = { conceptId: c.id, conceptName: c.name, model: base?.model ?? args.imageModel, assetId: base?.id ?? '', reconstructed: true as const };
    if (base?.source === 'ai_image') return { ...generatedResult(common), reconstructed: true };
    const ev = [...args.visualEvents].reverse().find((e) => e.conceptId === c.id);
    if (ev?.failed && ev.error?.code) {
      const err: SafeProviderError = { code: ev.error.code as SafeProviderError['code'], message: ev.error.message ?? '' };
      return { ...providerFailure(common, err, args.at), reconstructed: true };
    }
    if (!args.imageModel) return { ...notAttempted(common, 'configuration', 'No image model was selected for this campaign, so no AI image was requested.', 'skipped'), reconstructed: true };
    return { ...notAttempted(common, 'budget', 'No image request was recorded for this concept: the image limit of that run did not cover it.', 'skipped'), reconstructed: true };
  });
}

/**
 * The distinct explanations to show ONCE (summary, limitations, alerts): the real failures first. A concept that was "Not attempted"
 * because an earlier request already failed only echoes that failure, so it is listed only when nothing else explains.
 */
export function distinctReasons(results: { outcome: string; requestAttempted: boolean; explanation: string | null }[], limit = 3): string[] {
  const all = results.filter((r) => r.outcome !== 'generated' && !!r.explanation);
  const primary = all.filter((r) => r.requestAttempted || !r.explanation!.startsWith('Not attempted'));
  return [...new Set((primary.length ? primary : all).map((r) => r.explanation!))].slice(0, limit);
}
