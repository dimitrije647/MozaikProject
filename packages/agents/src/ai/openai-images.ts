import sharp from 'sharp';
import type { Reservation, SpendController } from './budget';
import { ProviderError, toProviderError, toSafeError, toSafeErrorFrom, type SafeProviderError } from './errors';
import type { OpenAIClient } from './openai-http';
import { imageActualCostUsd, imageCostEstimate } from './pricing';

/**
 * Image generation through the user's OWN OpenAI key (Images API: POST /v1/images/generations).
 * Documented request: { model, prompt, size, quality, n, output_format }. Documented response:
 * { data: [{ b64_json }], usage?: { input_tokens, output_tokens, total_tokens } }.
 *
 * Only the GPT Image family (`gpt-image-*`) is supported: it returns base64 PNG data and supports the sizes below. A text model
 * such as gpt-4.1-mini cannot generate images and is never used for it. The cost of a finished image is computed from the usage the
 * provider reports at the published token rates (pricing.ts); before a request, the price book's per-image figure is held in the
 * spend controller, and a request that would knowingly exceed the approved amount is refused without being sent.
 */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
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
  /** Retries for rate limits / provider outages (never for a timeout: it may already have been billed). Retries count against the hard attempt cap. */
  maxRetries: number;
  /** Base delay of the backoff when the provider sends no Retry-After. */
  retryBaseDelayMs: number;
  /** The campaign's shared spend ledger (US dollars). Absent = requests are counted and costed but never refused for money. */
  spend?: SpendController;
  /** NO AI HYBRID: this generator refuses every request (before the budget, before the client). */
  forbidden?: boolean;
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
  /** Known cost of the finished images (provider-reported usage at the published token rates, else the price-book estimate). null = no price known. */
  costUsd: number | null;
  /** Requests refused BEFORE sending because they would have exceeded the approved spending limit. */
  blockedBySpend: number;
  /** 429 answers received (each one is waited out for the provider's Retry-After, or backed off, and costs nothing). */
  rateLimited: number;
  /** Requests refused because the campaign mode never generates images (NO AI HYBRID). Nothing was sent for them. */
  refusedForbidden?: number;
}

export type ImageResult =
  | { ok: true; bytes: Buffer; mimeType: 'image/png'; width: number; height: number; usage: { input: number; output: number; total: number } | null; costUsd: number | null }
  | { ok: false; error: SafeProviderError };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
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
  private blockedBySpend = 0;
  private rateLimited = 0;
  private refusedForbidden = 0;
  private cost = { usd: 0, any: false };
  private tokens = { input: 0, output: 0, total: 0, any: false };
  private last: ImageGenSettings | null = null;
  /** No request is sent before this time: set by a 429's Retry-After and shared by every concurrent worker. */
  private pauseUntil = 0;
  /** Highest real cost seen for one image: the reservation for models without a published per-image price. */
  private observedMaxUsd: number | null = null;
  private calibration: Promise<unknown> = Promise.resolve();

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
      costUsd: this.cost.any ? Math.round(this.cost.usd * 1_000_000) / 1_000_000 : null,
      blockedBySpend: this.blockedBySpend,
      rateLimited: this.rateLimited,
      ...(this.refusedForbidden ? { refusedForbidden: this.refusedForbidden } : {}),
    };
  }

  get regenerationAllowed() {
    return this.regenerationsStarted < this.limits.maxRegenerations;
  }

  /** Cancels the request in flight and refuses all further ones. */
  abort() {
    this.abortController.abort(new ProviderError('cancelled'));
  }

  /** What one request must reserve: the price book's per-image figure, else the dearest real image seen so far, else null (unknown). */
  private reserveFor(settings: ImageGenSettings): number | null {
    const est = imageCostEstimate(settings.model, settings.quality, settings.size).usd;
    // the dearest REAL image seen so far wins over the table (the table is a published figure; the usage OpenAI reported is the truth)
    if (est !== null) return this.observedMaxUsd === null ? est : Math.max(est, this.observedMaxUsd);
    return this.observedMaxUsd === null ? null : this.observedMaxUsd * 1.15;
  }

  async generate(prompt: string, settings: ImageGenSettings, opts: { regeneration?: boolean; signal?: AbortSignal } = {}): Promise<ImageResult> {
    const fail = (code: Parameters<typeof toSafeError>[0]): ImageResult => ({ ok: false, error: toSafeError(code) });
    // NO AI HYBRID: refused first of all, before the budget is touched or a request exists
    if (this.limits.forbidden || this.client.imagesForbidden) {
      this.refusedForbidden++;
      return fail('image_generation_forbidden');
    }
    if (this.abortController.signal.aborted || opts.signal?.aborted) return fail('cancelled');
    if (!isSupportedImageModel(settings.model)) return fail('model_unavailable');
    // Under a spending limit the FIRST image goes alone: the real cost of one image (from the usage OpenAI reports) is learned before
    // more are sent, so the limit is never overrun by several requests in flight on a wrong estimate (or on none at all, for a model
    // without a published per-image price). Once it is known, requests run in parallel again.
    if (this.limits.spend && this.limits.spend.approvedUsd !== null && this.observedMaxUsd === null) {
      const turn = this.calibration;
      let release!: () => void;
      this.calibration = new Promise<void>((r) => (release = r));
      await turn.catch(() => undefined);
      if (this.observedMaxUsd !== null) {
        release(); // learned while this request waited: no reason to keep it in line
        return this.generateOne(prompt, settings, opts, fail);
      }
      try {
        return await this.generateOne(prompt, settings, opts, fail);
      } finally {
        release();
      }
    }
    return this.generateOne(prompt, settings, opts, fail);
  }

  private async generateOne(prompt: string, settings: ImageGenSettings, opts: { regeneration?: boolean; signal?: AbortSignal }, fail: (code: Parameters<typeof toSafeError>[0]) => ImageResult): Promise<ImageResult> {
    if (this.abortController.signal.aborted || opts.signal?.aborted) return fail('cancelled');
    // The budgets are checked and consumed BEFORE the request: a failed or cancelled request still counts.
    if (opts.regeneration) {
      if (this.regenerationsStarted >= this.limits.maxRegenerations) return fail('budget_exceeded');
    } else if (this.requestsStarted - this.regenerationsStarted >= this.limits.maxImages) return fail('budget_exceeded');
    // ... and so is the money: the request is refused here, unsent, if it would knowingly exceed the approved amount
    let held: Reservation | null = null;
    if (this.limits.spend) {
      // the required originals are priority 2; an extra image that replaces a rejected one is a correction (priority 4)
      const worst = this.reserveFor(settings);
      const priority = opts.regeneration ? 4 : 2;
      // a request that does not fit only because other images hold their worst case waits for them to settle (they release the difference)
      await this.limits.spend.awaitRoom?.('image', worst, { priority }, opts.signal ? AbortSignal.any([this.abortController.signal, opts.signal]) : this.abortController.signal);
      if (this.abortController.signal.aborted || opts.signal?.aborted) return fail('cancelled');
      held = this.limits.spend.tryReserve('image', worst, { priority });
      if (!held) {
        this.blockedBySpend++;
        return fail('spend_limit');
      }
    }
    if (opts.regeneration) this.regenerationsStarted++;
    this.requestsStarted++;
    this.last = settings;
    const signal = opts.signal ? AbortSignal.any([this.abortController.signal, opts.signal]) : this.abortController.signal;
    const attemptCap = this.limits.maxRetries + 1;
    const spend = this.limits.spend;
    const drop = (how: 'release' | 'uncertain') => {
      if (!held || !spend) return;
      if (how === 'release') spend.release(held);
      else spend.markUncertain(held);
      held = null;
    };

    for (let attempt = 1; attempt <= attemptCap; attempt++) {
      // a provider that asked us to wait (Retry-After) is waited for, by every worker, before the next attempt
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) await sleep(wait, signal);
      if (signal.aborted) {
        this.failed++;
        drop('release'); // nothing was sent
        return fail('cancelled');
      }
      this.attempts++;
      const timeout = AbortSignal.timeout(this.limits.timeoutMs);
      try {
        const json = (await this.client.createImage({ model: settings.model, prompt, size: settings.size, quality: settings.quality, n: 1, output_format: 'png' }, AbortSignal.any([signal, timeout]))) as {
          data?: { b64_json?: unknown }[];
          usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
        };
        const u = json.usage;
        const usage =
          u && Number.isFinite(Number(u.total_tokens))
            ? { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, total: Number(u.total_tokens) || 0 }
            : null;
        // the image was produced (and billed) even if what comes back is unusable: the cost is recorded either way
        const actual = imageActualCostUsd(settings.model, usage);
        const known = actual ?? imageCostEstimate(settings.model, settings.quality, settings.size).usd;
        if (held && spend) {
          spend.settle(held, actual);
          held = null;
        }
        if (known !== null) {
          this.cost.usd += known;
          this.cost.any = true;
          this.observedMaxUsd = Math.max(this.observedMaxUsd ?? 0, known);
          // a model without a published price: the real cost of the first image is what the rest of the campaign is protected with
          if (imageCostEstimate(settings.model, settings.quality, settings.size).usd === null) spend?.learnImageUnit?.(this.observedMaxUsd * 1.15);
        }
        if (usage) {
          this.tokens.input += usage.input;
          this.tokens.output += usage.output;
          this.tokens.total += usage.total;
          this.tokens.any = true;
        }
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
        this.generated++;
        return { ok: true, bytes, mimeType: 'image/png', width: meta.width, height: meta.height, usage, costUsd: known };
      } catch (e) {
        if (signal.aborted) {
          this.failed++;
          drop('uncertain'); // aborted after sending: it may still be billed
          return fail('cancelled');
        }
        const err = timeout.aborted ? new ProviderError('timeout') : e instanceof ProviderError ? e : toProviderError(e);
        if (err.code === 'rate_limited') this.rateLimited++;
        if (err.retryable) {
          // everyone waits for the provider's Retry-After (or a backoff) before anything is sent again; served at the top of the loop
          this.pauseUntil = Math.max(this.pauseUntil, Date.now() + (err.retryAfterMs ?? this.limits.retryBaseDelayMs * 2 ** (attempt - 1)));
          if (attempt < attemptCap) continue;
        }
        this.failed++;
        // an HTTP rejection or a rate limit bills nothing; a timeout may have been billed
        drop(err.code === 'timeout' ? 'uncertain' : 'release');
        return { ok: false, error: toSafeErrorFrom(err) };
      }
    }
    this.failed++;
    drop('release');
    return fail('provider_unavailable');
  }
}
