import sharp from 'sharp';
import { ProviderError, toProviderError, toSafeError, toSafeErrorFrom, type SafeProviderError } from './errors';
import type { OpenAIClient } from './openai-http';

/**
 * Image generation through the user's OWN OpenAI key (Images API: POST /v1/images/generations).
 * Documented request: { model, prompt, size, quality, n, output_format }. Documented response:
 * { data: [{ b64_json }], usage?: { input_tokens, output_tokens, total_tokens } }.
 *
 * Only the GPT Image family (`gpt-image-*`) is supported: it returns base64 PNG data and supports the sizes below. A text model
 * such as gpt-4.1-mini cannot generate images and is never used for it. No price is ever computed here: only what the
 * provider reports is recorded.
 */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/** Model ids this adapter knows how to call. DALL-E models use a different contract and are not supported. */
export const isSupportedImageModel = (id: string) => /^gpt-image-[a-z0-9.-]+$/i.test(id);
/** For listings: anything that looks like an image model (so the UI can explain why it is not offered). */
export const looksLikeImageModel = (id: string) => /(gpt-image|dall-e)/i.test(id);

export interface ImageGenSettings {
  model: string;
  quality: ImageQuality;
  size: ImageSize;
}

export interface ImageBudgetLimits {
  /** Original images (one request each). */
  maxImages: number;
  /** Extra images allowed to REPLACE a rejected one. 0 = regeneration disabled. */
  maxRegenerations: number;
  timeoutMs: number;
  /** Retries for rate limits / provider outages. Retries count against the hard attempt cap. */
  maxRetries: number;
  retryBaseDelayMs: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageBudgetLimits = { maxImages: 3, maxRegenerations: 0, timeoutMs: 150_000, maxRetries: 1, retryBaseDelayMs: 1500 };

export interface ImageUsageSnapshot {
  model: string | null;
  quality: ImageQuality | null;
  size: ImageSize | null;
  requestsStarted: number;
  attempts: number;
  generated: number;
  failed: number;
  regenerationsStarted: number;
  limits: { maxImages: number; maxRegenerations: number };
  /** Summed from the provider's own `usage` field when it reports one. */
  tokens: { input: number; output: number; total: number } | null;
}

export type ImageResult =
  | { ok: true; bytes: Buffer; mimeType: 'image/png'; width: number; height: number; usage: { input: number; output: number; total: number } | null }
  | { ok: false; error: SafeProviderError };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class ImageGenerator {
  private readonly limits: ImageBudgetLimits;
  private readonly abortController = new AbortController();
  private requestsStarted = 0;
  private attempts = 0;
  private generated = 0;
  private failed = 0;
  private regenerationsStarted = 0;
  private tokens = { input: 0, output: 0, total: 0, any: false };
  private last: ImageGenSettings | null = null;

  constructor(
    private readonly client: OpenAIClient,
    limits: Partial<ImageBudgetLimits> = {},
  ) {
    this.limits = { ...DEFAULT_IMAGE_LIMITS, ...limits };
  }

  usage(): ImageUsageSnapshot {
    return {
      model: this.last?.model ?? null,
      quality: this.last?.quality ?? null,
      size: this.last?.size ?? null,
      requestsStarted: this.requestsStarted,
      attempts: this.attempts,
      generated: this.generated,
      failed: this.failed,
      regenerationsStarted: this.regenerationsStarted,
      limits: { maxImages: this.limits.maxImages, maxRegenerations: this.limits.maxRegenerations },
      tokens: this.tokens.any ? { input: this.tokens.input, output: this.tokens.output, total: this.tokens.total } : null,
    };
  }

  get regenerationAllowed() {
    return this.regenerationsStarted < this.limits.maxRegenerations;
  }

  /** Cancels the request in flight and refuses all further ones. */
  abort() {
    this.abortController.abort(new ProviderError('cancelled'));
  }

  async generate(prompt: string, settings: ImageGenSettings, opts: { regeneration?: boolean; signal?: AbortSignal } = {}): Promise<ImageResult> {
    const fail = (code: Parameters<typeof toSafeError>[0]): ImageResult => ({ ok: false, error: toSafeError(code) });
    if (this.abortController.signal.aborted || opts.signal?.aborted) return fail('cancelled');
    if (!isSupportedImageModel(settings.model)) return fail('model_unavailable');
    // The budget is checked and consumed BEFORE the request: a failed or cancelled request still counts.
    if (opts.regeneration) {
      if (this.regenerationsStarted >= this.limits.maxRegenerations) return fail('budget_exceeded');
      this.regenerationsStarted++;
    } else {
      if (this.requestsStarted - this.regenerationsStarted >= this.limits.maxImages) return fail('budget_exceeded');
    }
    this.requestsStarted++;
    this.last = settings;
    const signal = opts.signal ? AbortSignal.any([this.abortController.signal, opts.signal]) : this.abortController.signal;
    const attemptCap = this.limits.maxRetries + 1;

    for (let attempt = 1; attempt <= attemptCap; attempt++) {
      this.attempts++;
      const timeout = AbortSignal.timeout(this.limits.timeoutMs);
      try {
        const json = (await this.client.createImage({ model: settings.model, prompt, size: settings.size, quality: settings.quality, n: 1, output_format: 'png' }, AbortSignal.any([signal, timeout]))) as {
          data?: { b64_json?: unknown }[];
          usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
        };
        const b64 = json.data?.[0]?.b64_json;
        if (typeof b64 !== 'string' || b64.length < 100) throw new ProviderError('invalid_response');
        const bytes = Buffer.from(b64, 'base64');
        let meta: sharp.Metadata;
        try {
          meta = await sharp(bytes).metadata();
        } catch {
          throw new ProviderError('invalid_response');
        }
        if (meta.format !== 'png' || !meta.width || !meta.height) throw new ProviderError('invalid_response');
        const u = json.usage;
        const usage =
          u && Number.isFinite(Number(u.total_tokens))
            ? { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, total: Number(u.total_tokens) || 0 }
            : null;
        if (usage) {
          this.tokens.input += usage.input;
          this.tokens.output += usage.output;
          this.tokens.total += usage.total;
          this.tokens.any = true;
        }
        this.generated++;
        return { ok: true, bytes, mimeType: 'image/png', width: meta.width, height: meta.height, usage };
      } catch (e) {
        if (signal.aborted) {
          this.failed++;
          return fail('cancelled');
        }
        const err = timeout.aborted ? new ProviderError('timeout') : e instanceof ProviderError ? e : toProviderError(e);
        if (err.retryable && attempt < attemptCap) {
          await sleep(this.limits.retryBaseDelayMs * 2 ** (attempt - 1), signal);
          if (signal.aborted) {
            this.failed++;
            return fail('cancelled');
          }
          continue;
        }
        this.failed++;
        return { ok: false, error: toSafeErrorFrom(err) };
      }
    }
    this.failed++;
    return fail('provider_unavailable');
  }
}
