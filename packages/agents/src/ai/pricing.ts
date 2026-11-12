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
  textModel: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
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

/**
 * CLAUDE (Anthropic API) price book, USD per 1M tokens, standard tier (no batch, no fast mode), read from Anthropic's pricing page on
 * CLAUDE_PRICE_BOOK_VERIFIED_AT. Kept apart from the OpenAI book on purpose: an OpenAI price is never used for a Claude model or the reverse.
 * Anthropic reports cache reads and cache writes SEPARATELY from `input_tokens`, so Claude cost is computed by `claudeCostUsd`, not `textCostUsd`.
 * LaunchPilot sends no `cache_control`, so cache writes are normally 0; they are still priced (5-minute write rate) if the provider reports any.
 */
export const CLAUDE_PRICE_BOOK_VERIFIED_AT = '2026-11-11';
export const CLAUDE_PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export interface ClaudePrice extends TextPrice {
  cachedInputPerM: number;
  cacheWritePerM: number;
  /** Prompts above this many input tokens are billed at `long` (only where Anthropic lists a long-prompt rate). */
  longAbove?: number;
  long?: { inputPerM: number; cachedInputPerM: number; cacheWritePerM: number; outputPerM: number };
}
const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  'claude-fable-5-2': { inputPerM: 8, cacheWritePerM: 10, cachedInputPerM: 0.2, outputPerM: 40 },
  'claude-opus-5-5': { inputPerM: 4, cacheWritePerM: 5, cachedInputPerM: 0.2, outputPerM: 20 },
  'claude-opus-5': { inputPerM: 5, cacheWritePerM: 6.25, cachedInputPerM: 0.5, outputPerM: 25 },
  'claude-opus-4-8': { inputPerM: 5, cacheWritePerM: 6.25, cachedInputPerM: 0.5, outputPerM: 25 },
  'claude-sonnet-5-5': { inputPerM: 2, cacheWritePerM: 2.5, cachedInputPerM: 0.1, outputPerM: 10 },
  'claude-sonnet-5': { inputPerM: 2, cacheWritePerM: 2.5, cachedInputPerM: 0.2, outputPerM: 10 },
  'claude-haiku-5-5': {
    inputPerM: 0.1, cacheWritePerM: 0.125, cachedInputPerM: 0.01, outputPerM: 0.5,
    longAbove: 100_000, long: { inputPerM: 0.5, cacheWritePerM: 0.625, cachedInputPerM: 0.05, outputPerM: 2.5 },
  },
};
/** Every model above: 128K max output tokens (Anthropic model overview). */
const CLAUDE_MAX_OUTPUT = 128_000;

export const isClaudeModel = (model: string | null | undefined): boolean => !!model && /^claude-/.test(model.trim());
export const claudePrice = (model: string | null | undefined): ClaudePrice | null => (model ? (CLAUDE_PRICES[model.trim()] ?? null) : null);
/** The Claude models LaunchPilot can price (the Settings list; any other id the key can see may still be chosen, but runs unpriced). */
export const CLAUDE_PRICED_MODELS = Object.keys(CLAUDE_PRICES);

export interface ClaudeUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}
/** USD of one Claude answer from the usage Anthropic reported. null = no verified price for this model. */
export function claudeCostUsd(model: string | null | undefined, u: ClaudeUsageLike): number | null {
  const p = claudePrice(model);
  if (!p) return null;
  const input = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const rates = p.long && p.longAbove !== undefined && input + read + write > p.longAbove ? p.long : p;
  return (input * rates.inputPerM + read * rates.cachedInputPerM + write * rates.cacheWritePerM + (u.output_tokens ?? 0) * rates.outputPerM) / 1_000_000;
}
/** Worst case of ONE Claude request (estimated input + the FULL max_tokens, which includes adaptive thinking). */
export function claudeReserveUsd(model: string | null | undefined, inputChars: number, maxTokens: number): number | null {
  return claudeCostUsd(model, { input_tokens: estimateTokens(inputChars), output_tokens: maxTokens });
}

/** A dated snapshot ("gpt-4.1-mini-2025-04-14") is priced like its family. */
const family = (id: string) => id.trim().replace(/-\d{4}-\d{2}-\d{2}$/, '');

/** The price of a text model from the book of ITS provider (OpenAI or Claude). */
export const textPrice = (model: string | null | undefined): TextPrice | null => (model ? (isClaudeModel(model) ? claudePrice(model) : (TEXT_PRICES[family(model)] ?? null)) : null);

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
  if (claudePrice(model)) return { limit: CLAUDE_MAX_OUTPUT, verified: true };
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
  // Claude bills cache reads/writes on top of input_tokens: priced from its raw usage by claudeCostUsd (never with this formula)
  if (isClaudeModel(model)) return claudeCostUsd(model, { input_tokens: u.inputTokens, output_tokens: u.outputTokens });
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

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
