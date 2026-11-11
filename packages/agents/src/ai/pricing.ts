/**
 * The PRICE BOOK: what LaunchPilot knows about OpenAI prices and model limits, and where each number comes from.
 *
 * Every number below was read from OpenAI's own documentation on PRICE_BOOK_VERIFIED_AT (the sources are listed). Nothing is
 * guessed: a model that is not in the book has NO price, and every function here then answers `null` / "unavailable" instead of
 * inventing a figure. Prices change; the date is shown wherever a dollar amount is shown, and an estimate is never a guarantee.
 * An application-side budget built on these numbers is NOT a provider-side billing cap (see budget.ts).
 */
export const PRICE_BOOK_VERIFIED_AT = '2026-10-31';
export const PRICE_SOURCES = {
  pricing: 'https://developers.openai.com/api/docs/pricing',
  imageGuide: 'https://developers.openai.com/api/docs/guides/image-generation',
  textModel: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
  imageModel: 'https://developers.openai.com/api/docs/models/gpt-image-1-mini',
} as const;

export interface TextPrice {
  /** USD per 1M tokens (Standard tier, short context). */
  inputPerM: number;
  cachedInputPerM: number | null;
  outputPerM: number;
}

/** USD per 1M tokens, Standard tier, short context (up to 272K input where the page distinguishes), as listed on the pricing page. */
const TEXT_PRICES: Record<string, TextPrice> = {
  'gpt-4.1-mini': { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 },
  'gpt-4.1': { inputPerM: 2.0, cachedInputPerM: 0.5, outputPerM: 8.0 },
  'gpt-4.1-nano': { inputPerM: 0.1, cachedInputPerM: 0.025, outputPerM: 0.4 },
  'gpt-4o': { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
  'gpt-5': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
  'gpt-5-mini': { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2.0 },
  'gpt-5-nano': { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 },
  'gpt-5.1': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10.0 },
  'gpt-5.2': { inputPerM: 1.75, cachedInputPerM: 0.175, outputPerM: 14.0 },
  'gpt-5.4': { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15.0 },
  'gpt-5.4-mini': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  'gpt-5.4-nano': { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.25 },
  'gpt-6-luna': { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5 },
  'gpt-6-astra': { inputPerM: 10.0, cachedInputPerM: 1.0, outputPerM: 50.0 },
  'gpt-6.1-sol': { inputPerM: 2.0, cachedInputPerM: 0.1, outputPerM: 10.0 },
  'gpt-6.1-terra': { inputPerM: 1.0, cachedInputPerM: 0.05, outputPerM: 5.0 },
  'gpt-6-sol': { inputPerM: 2.0, cachedInputPerM: 0.2, outputPerM: 10.0 },
  'gpt-5.6-sol': { inputPerM: 4.0, cachedInputPerM: 0.4, outputPerM: 20.0 },
  'gpt-5.6-terra': { inputPerM: 2.0, cachedInputPerM: 0.2, outputPerM: 12.0 },
  'gpt-5.6-luna': { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 },
  'gpt-5.5': { inputPerM: 5.0, cachedInputPerM: 0.5, outputPerM: 30.0 },
  'gpt-5.5-pro': { inputPerM: 30.0, cachedInputPerM: null, outputPerM: 180.0 },
  'gpt-5.4-pro': { inputPerM: 30.0, cachedInputPerM: null, outputPerM: 180.0 },
  'gpt-5.2-pro': { inputPerM: 21.0, cachedInputPerM: null, outputPerM: 168.0 },
  'gpt-5-pro': { inputPerM: 15.0, cachedInputPerM: null, outputPerM: 120.0 },
  o3: { inputPerM: 2.0, cachedInputPerM: 0.5, outputPerM: 8.0 },
  'o4-mini': { inputPerM: 1.1, cachedInputPerM: 0.275, outputPerM: 4.4 },
};

/** A dated snapshot ("gpt-4.1-mini-2025-04-14") is priced like its family. */
const family = (id: string) => id.trim().replace(/-\d{4}-\d{2}-\d{2}$/, '');

export const textPrice = (model: string | null | undefined): TextPrice | null => (model ? (TEXT_PRICES[family(model)] ?? null) : null);

/** Text models OpenAI has announced a shutdown for (deprecations page, read on PRICE_BOOK_VERIFIED_AT). They work until that date. */
const TEXT_SHUTDOWNS: Record<string, { on: string; replacement: string }> = {
  'gpt-4.1-mini': { on: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4.1': { on: '2027-01-14', replacement: 'gpt-6-luna' },
};

/** A heads-up (never a refusal or a silent switch) when the chosen text model has an announced shutdown date. */
export function textModelWarning(model: string | null | undefined, now: Date = new Date()): string | null {
  const s = model ? TEXT_SHUTDOWNS[family(model)] : undefined;
  if (!s) return null;
  const days = Math.ceil((Date.parse(`${s.on}T00:00:00Z`) - now.getTime()) / 86_400_000);
  if (days <= 0) return `OpenAI shut down ${model} on ${s.on}; choose another text model in Settings > AI providers (OpenAI names ${s.replacement}).`;
  return `OpenAI will shut down ${model} on ${s.on} (in ${days} day${days === 1 ? '' : 's'}). It works today and LaunchPilot keeps using it because you chose it; OpenAI names ${s.replacement} as the replacement.`;
}

/**
 * Maximum output tokens per request, ONLY where OpenAI's model page states it (read on PRICE_BOOK_VERIFIED_AT: gpt-4.1-mini and gpt-4.1 32,768; gpt-4o and gpt-4o-mini 16,384; gpt-5-mini and gpt-6.1-sol 128,000). For any other model the
 * limit was not verified, so a conservative ceiling is used rather than a parameter the model might reject.
 */
const VERIFIED_MAX_OUTPUT: Record<string, number> = { 'gpt-4.1-mini': 32_768, 'gpt-4.1': 32_768, 'gpt-4o': 16_384, 'gpt-4o-mini': 16_384, 'gpt-5-mini': 128_000, 'gpt-6.1-sol': 128_000 };
export const UNVERIFIED_MAX_OUTPUT_TOKENS = 4096;

export function maxOutputTokensFor(model: string | null | undefined): { limit: number; verified: boolean } {
  const v = model ? VERIFIED_MAX_OUTPUT[family(model)] : undefined;
  return v ? { limit: v, verified: true } : { limit: UNVERIFIED_MAX_OUTPUT_TOKENS, verified: false };
}

/**
 * The output cap to send: what was asked for, never above what the model supports. A request above the ceiling of a model whose
 * limit is unverified is lowered (and `capped` says so), never submitted as-is.
 */
export function capOutputTokens(model: string | null | undefined, requested: number): { tokens: number; capped: boolean } {
  const { limit } = maxOutputTokensFor(model);
  return requested > limit ? { tokens: limit, capped: true } : { tokens: requested, capped: false };
}

export interface TextUsageLike {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** USD for measured text usage. null = no price for this model. Cached input is priced at the cached rate where one is listed. */
export function textCostUsd(model: string | null | undefined, u: TextUsageLike): number | null {
  const p = textPrice(model);
  if (!p) return null;
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens);
  const fresh = u.inputTokens - cached;
  return (fresh * p.inputPerM + cached * (p.cachedInputPerM ?? p.inputPerM) + u.outputTokens * p.outputPerM) / 1_000_000;
}

/** Input tokens are not known before a request is sent; characters / 3 is a deliberately high estimate for mixed-language text and JSON. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);

/** Worst-case USD of ONE text request: its estimated input plus the FULL output cap. Used to reserve budget before the call. */
export function textReserveUsd(model: string | null | undefined, inputChars: number, maxOutputTokens: number): number | null {
  return textCostUsd(model, { inputTokens: estimateTokens(inputChars), outputTokens: maxOutputTokens });
}

// ---- images ---------------------------------------------------------------------------------------------------------------------

export type PricedImageQuality = 'low' | 'medium' | 'high';
export type PricedImageSize = '1024x1024' | '1024x1536' | '1536x1024';
const SIZE_INDEX: Record<PricedImageSize, number> = { '1024x1024': 0, '1024x1536': 1, '1536x1024': 2 };

/** USD per image by quality and size [square, portrait, landscape], from the image guide's per-image table. */
const IMAGE_PER_IMAGE: Record<string, Record<PricedImageQuality, [number, number, number]>> = {
  'gpt-image-1-mini': { low: [0.005, 0.006, 0.006], medium: [0.011, 0.015, 0.015], high: [0.036, 0.052, 0.052] },
  'gpt-image-1.5': { low: [0.009, 0.013, 0.013], medium: [0.034, 0.05, 0.05], high: [0.133, 0.2, 0.2] },
  'gpt-image-2': { low: [0.006, 0.005, 0.005], medium: [0.053, 0.041, 0.041], high: [0.211, 0.165, 0.165] },
};

/** Token prices (USD per 1M tokens) used to turn the provider-reported usage of a finished image into dollars. */
const IMAGE_TOKEN_PRICES: Record<string, { textInputPerM: number; imageOutputPerM: number }> = {
  'gpt-image-1-mini': { textInputPerM: 2.0, imageOutputPerM: 8.0 },
  'gpt-image-1.5': { textInputPerM: 5.0, imageOutputPerM: 32.0 },
  'gpt-image-2': { textInputPerM: 5.0, imageOutputPerM: 30.0 },
  'gpt-image-2.5-sunburst': { textInputPerM: 5.0, imageOutputPerM: 30.0 },
  'gpt-image-2.5-flare': { textInputPerM: 5.0, imageOutputPerM: 30.0 },
};

export type ImageCostBasis =
  /** The per-image price from OpenAI's table for this model, quality and size. */
  | 'per_image_table'
  /** quality "auto": the model decides, so the price of "high" is used as an upper bound. */
  | 'upper_bound_auto'
  /** Token-priced model without a published per-image figure: no estimate exists before the request. */
  | 'unavailable';

export interface ImageCostEstimate {
  usd: number | null;
  basis: ImageCostBasis;
  note: string;
}

export function imageCostEstimate(model: string | null | undefined, quality: string | null | undefined, size: string | null | undefined): ImageCostEstimate {
  const id = model ? family(model) : '';
  const table = IMAGE_PER_IMAGE[id];
  const sz = SIZE_INDEX[(size ?? '1024x1024') as PricedImageSize];
  if (!table || sz === undefined) {
    const tokenPriced = !!IMAGE_TOKEN_PRICES[id];
    return { usd: null, basis: 'unavailable', note: tokenPriced ? `${id} is billed by tokens (image output $${IMAGE_TOKEN_PRICES[id].imageOutputPerM} per 1M tokens); OpenAI publishes no per-image price for it, so no estimate is shown before the request. The real cost is computed from the usage OpenAI reports for each image.` : `No verified price for ${model ?? 'this model'}.` };
  }
  const q = (quality ?? 'low') as string;
  if (q === 'auto') return { usd: table.high[sz], basis: 'upper_bound_auto', note: 'Quality "auto" lets the model choose, so the price of "high" is used as an upper bound.' };
  if (q !== 'low' && q !== 'medium' && q !== 'high') return { usd: null, basis: 'unavailable', note: `No verified price for quality "${q}".` };
  return { usd: table[q][sz], basis: 'per_image_table', note: `OpenAI per-image price for ${id}, ${q}, ${size ?? '1024x1024'}.` };
}

/** USD for ONE finished image from the usage the provider reported (text input + image output tokens). null = no token price known. */
export function imageActualCostUsd(model: string | null | undefined, usage: { input: number; output: number } | null | undefined): number | null {
  const p = model ? IMAGE_TOKEN_PRICES[family(model)] : undefined;
  if (!p || !usage) return null;
  return (usage.input * p.textInputPerM + usage.output * p.imageOutputPerM) / 1_000_000;
}

/** The cheapest verified per-image price among the models of the price book (for the "choose a cheaper model" option). */
export function cheaperImageModels(quality: string, size: string): { model: string; usd: number }[] {
  return Object.keys(IMAGE_PER_IMAGE)
    .map((model) => ({ model, usd: imageCostEstimate(model, quality, size).usd }))
    .filter((x): x is { model: string; usd: number } => x.usd !== null)
    .sort((a, b) => a.usd - b.usd);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
