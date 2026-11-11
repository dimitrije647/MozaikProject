import {
  ModelMessageItem,
  OpenAIResponses,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from '@mozaik-ai/core';
import type { Reservation, SpendController, SpendPriority, SpendSnapshot } from './budget';
import { ProviderError, toProviderError, type ProviderErrorCode } from './errors';
import type { OpenAIClient } from './openai-http';
import { textCostUsd, textReserveUsd } from './pricing';
import { generationTimeoutMs, type GenerationTimeout } from './timeouts';

/**
 * Marker used to carry a provider failure through Mozaik's agent loop.
 *
 * Why this exists: Mozaik's `runLoop` calls `agentLoop.run(...)` without awaiting or catching it, so
 * an exception thrown by the inference runner becomes an UNHANDLED PROMISE REJECTION, which crashes
 * a Node 22 server. The gateway therefore never throws. It returns a normal assistant message whose
 * text is this marker plus a ProviderErrorCode, and the agent that receives that `model.answer`
 * turns it into a proper task failure. The text contains no provider output and no secrets.
 */
export const PROVIDER_ERROR_PREFIX = '\u0000LAUNCHPILOT_PROVIDER_ERROR:';

export function readProviderErrorCode(text: string): ProviderErrorCode | null {
  return text.startsWith(PROVIDER_ERROR_PREFIX) ? (text.slice(PROVIDER_ERROR_PREFIX.length) as ProviderErrorCode) : null;
}

export interface InferenceBudget {
  /** Hard cap on provider calls for the whole run. Retries and repair attempts count. */
  maxModelCalls: number;
  /** Cap on `max_output_tokens` sent with every request. */
  maxOutputTokens: number;
  /** Per-request timeout. */
  callTimeoutMs: number;
  /**
   * When set, a request marked as a LONG ANSWER (see `setLongAnswer`: the final document of a phase) gets a clock that grows with the tokens it may
   * produce (never shorter than `callTimeoutMs`). Absent = every request keeps `callTimeoutMs`.
   */
  generation?: GenerationTimeout;
  /** Extra attempts after a retryable failure (429 rate limit, 5xx, network). Quota errors are never retried. */
  maxRetries: number;
  /** Base delay for exponential backoff. */
  retryBaseDelayMs: number;
  /** The campaign's shared spend ledger (US dollars). Every request reserves its worst case first; absent = usage is measured but never capped. */
  spend?: SpendController;
  /**
   * When an answer is CUT OFF by `max_output_tokens` (status "incomplete"), the same request is sent again with a larger cap, up to this
   * ceiling and at most twice: a cut-off JSON answer is unusable, and asking for the same size again only truncates it again. The cut-off
   * attempt was billed and stays in the accounting; the retry counts as a model call. Absent = no escalation.
   */
  escalateTo?: number;
}

export const DEFAULT_BUDGET: InferenceBudget = {
  maxModelCalls: 6,
  maxOutputTokens: 3500,
  callTimeoutMs: 90_000,
  maxRetries: 2,
  retryBaseDelayMs: 1000,
};

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

const emptyUsage = (): UsageTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});

export interface UsageSnapshot {
  total: UsageTotals;
  perAgent: Record<string, UsageTotals>;
  /** Provider calls started (including retries), against `budget.maxModelCalls`. */
  callsStarted: number;
  /** Dollars: known spend, reservations, uncertain spend and refused requests (null when the run has no spend controller). */
  spend: SpendSnapshot | null;
  /** Requests re-sent with a larger output cap because the answer was cut off (each one is also counted in `callsStarted`). */
  escalations: number;
}

// Mozaik's default OpenAI Responses mapper: converts a ModelContext to a Responses request and a
// Responses reply back to Mozaik items. Constructing the endpoint only stores config (no client, no
// env access); we use just its public mapper and do the HTTP ourselves.
const mapper = new OpenAIResponses().endpointMapper;

/**
 * Mozaik `InferenceRunner` for ONE run, backed by the user's OpenAI key.
 *
 * Why not Mozaik's DefaultInferenceRunner + OpenAIResponses: Mozaik's OpenAI mapper does not send
 * `max_output_tokens` (no output cap) or `store: false` (OpenAI would retain the conversation), and
 * the endpoint API has no abort signal. This runner adds an output cap, `store: false`, a call
 * budget, bounded retries, per-call timeout, cancellation and token accounting.
 */
export class InferenceGateway implements InferenceRunner {
  private callsStarted = 0;
  private escalations = 0;
  private readonly total = emptyUsage();
  private readonly perAgent = new Map<string, UsageTotals>();
  private readonly agentNames = new Map<string, string>(); // ModelContext id -> agent name
  private readonly contextAborts = new Map<string, AbortController>();
  private readonly runAbort = new AbortController();
  private readonly pendingImages = new Map<string, { mediaType: string; base64: string }[]>();
  /** What the NEXT request of an agent is for (see SpendPriority): decides what the shared budget may refuse first when money is tight. */
  private readonly priorities = new Map<string, SpendPriority>();
  /** Agents whose next requests write a long structured answer (the synthesizers). */
  private readonly longAnswers = new Set<string>();
  /** What the last request of an agent was given, and why it failed, for a specific and safe error message. */
  private readonly attempts = new Map<string, { limitMs: number; cap: number }>();
  private readonly failureNotes = new Map<string, string>();

  constructor(
    private readonly client: OpenAIClient,
    private readonly budget: InferenceBudget = DEFAULT_BUDGET,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  registerAgent(contextId: string, agentName: string) {
    this.agentNames.set(contextId, agentName);
  }

  /** Marks the agent's next requests as long structured answers (a synthesis): their clock scales with the answer's output cap. */
  setLongAnswer(contextId: string, on: boolean) {
    if (on) this.longAnswers.add(contextId);
    else this.longAnswers.delete(contextId);
  }

  /** A safe sentence about why the last request of this agent failed with `code` (null = nothing specific to add). Never contains provider text. */
  failureDetail(contextId: string, code: ProviderErrorCode): string | undefined {
    return code === 'timeout' ? this.failureNotes.get(contextId) : undefined;
  }

  private timeoutFor(contextId: string, cap: number): number {
    const g = this.budget.generation;
    return g && this.longAnswers.has(contextId) ? Math.max(this.budget.callTimeoutMs, generationTimeoutMs(cap, g)) : this.budget.callTimeoutMs;
  }

  /** Sets the spend priority of the agent's next requests (1 essential analysis ... 5 optional refinements). Default 1. */
  setCallPriority(contextId: string, priority: SpendPriority) {
    this.priorities.set(contextId, priority);
  }

  /**
   * Attaches images to the NEXT request of one agent (vision). Mozaik's context items carry text only,
   * so the images are appended to the last user message as `input_image` parts (detail "low": a flat,
   * small token cost per image). They are dropped once a request succeeds, so repair or follow-up
   * calls do not resend them.
   */
  attachImages(contextId: string, images: { mediaType: string; base64: string }[]) {
    this.pendingImages.set(contextId, images);
  }

  usage(): UsageSnapshot {
    return {
      total: { ...this.total },
      perAgent: Object.fromEntries([...this.perAgent].map(([k, v]) => [k, { ...v }])),
      callsStarted: this.callsStarted,
      spend: this.budget.spend?.snapshot() ?? null,
      escalations: this.escalations,
    };
  }

  /** Cancels everything: in-flight requests are aborted and no further call is made. */
  abort() {
    if (!this.runAbort.signal.aborted) this.runAbort.abort(new ProviderError('cancelled'));
  }

  /** Aborts only the calls of one agent (e.g. when that agent times out). */
  abortAgent(contextId: string, code: ProviderErrorCode = 'timeout') {
    this.contextAborts.get(contextId)?.abort(new ProviderError(code));
  }

  /** Never throws (see PROVIDER_ERROR_PREFIX). */
  async run(input: InferenceInput): Promise<InferenceOutput> {
    const contextId = input.context.id;
    let agentAbort = this.contextAborts.get(contextId);
    if (!agentAbort || agentAbort.signal.aborted) {
      agentAbort = new AbortController();
      this.contextAborts.set(contextId, agentAbort);
    }

    let lastCode: ProviderErrorCode = 'provider_unavailable';
    let cap = Math.min(input.maxOutputTokens ?? this.budget.maxOutputTokens, this.budget.maxOutputTokens);
    let escalated = 0;
    for (let attempt = 0; attempt <= this.budget.maxRetries; attempt++) {
      const abortReason = this.abortReason(agentAbort.signal);
      if (abortReason) return failure(abortReason);
      if (this.callsStarted >= this.budget.maxModelCalls) return failure('budget_exceeded');
      this.callsStarted++;

      const stop = AbortSignal.any([this.runAbort.signal, agentAbort.signal]);
      let held: Reservation | null = null;
      try {
        const request = mapper.toRequest(input) as { input: { role?: string; content?: unknown[] }[] };
        const images = this.pendingImages.get(contextId);
        if (images?.length) {
          const lastUser = [...request.input].reverse().find((i) => i.role === 'user');
          if (lastUser?.content) for (const img of images) lastUser.content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' });
        }
        const body = {
          ...request,
          max_output_tokens: cap,
          store: false, // do not let OpenAI retain the user's product text
        };
        // Spend control: the worst case of this request (estimated input + the FULL output cap) is held BEFORE it is sent.
        const model = (request as { model?: string }).model ?? input.model;
        if (this.budget.spend) {
          const worst = textReserveUsd(model, JSON.stringify(body).length, body.max_output_tokens);
          const priority = this.priorities.get(contextId) ?? 1;
          // a request that does not fit only because other requests hold their worst case waits for them to settle (they release the difference)
          await this.budget.spend.awaitRoom?.('text', worst, { priority }, stop);
          held = this.budget.spend.tryReserve('text', worst, { priority });
          if (!held) {
            this.callsStarted--; // refused before it was sent: not a provider call
            return failure('spend_limit');
          }
        }
        // the clock of THIS request starts when it is sent, not while it waited for room in the campaign budget
        const limitMs = this.timeoutFor(contextId, cap);
        this.attempts.set(contextId, { limitMs, cap });
        const signal = AbortSignal.any([stop, AbortSignal.timeout(limitMs)]);
        const response = await this.client.createResponse(body, signal);
        this.failureNotes.delete(contextId);
        const output = mapper.toResponse(response);
        this.record(contextId, output);
        if (held) {
          const u = output.tokenUsage;
          this.budget.spend!.settle(held, u ? textCostUsd(model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.inputTokenDetails.cached_tokens }) : null);
          held = null;
        }
        // An answer cut off by the output cap is useless as JSON, and the same cap would cut it off again: ask once more, bigger.
        const cutOff = response.status === 'incomplete' && (response.incomplete_details as { reason?: string } | null | undefined)?.reason === 'max_output_tokens';
        if (cutOff && this.budget.escalateTo && cap < this.budget.escalateTo && escalated < 2) {
          escalated++;
          this.escalations++;
          cap = Math.min(this.budget.escalateTo, cap * 2);
          attempt--; // not a network retry
          continue;
        }
        this.pendingImages.delete(contextId);
        if (!output.items.some((i) => i.type === 'message')) return failure('invalid_response');
        // Drop the raw provider response: Mozaik publishes the whole output as an event payload.
        return { items: output.items, tokenUsage: output.tokenUsage, rowResponse: undefined };
      } catch (err) {
        const pe = toProviderError(err);
        lastCode = pe.code;
        // A rejection by the provider (HTTP error, rate limit) bills nothing; a timeout or cancel after sending may have been billed.
        if (held) {
          if (pe.code === 'timeout' || pe.code === 'cancelled') this.budget.spend!.markUncertain(held);
          else this.budget.spend!.release(held);
          held = null;
        }
        const stopped = this.abortReason(agentAbort.signal);
        if (stopped) return failure(stopped);
        if (pe.code === 'timeout') {
          const a = this.attempts.get(contextId);
          if (a) this.failureNotes.set(contextId, `No answer arrived within ${a.limitMs < 10_000 ? (a.limitMs / 1000).toFixed(1) : Math.round(a.limitMs / 1000)} s (the answer could be up to ${a.cap} tokens long). The request had been sent, so it may still have been billed; it was not repeated automatically.`);
        }
        if (!pe.retryable || attempt === this.budget.maxRetries) return failure(pe.code);
        const delay = pe.retryAfterMs ?? this.budget.retryBaseDelayMs * 2 ** attempt;
        try {
          await this.sleep(delay, AbortSignal.any([this.runAbort.signal, agentAbort.signal]));
        } catch {
          return failure(this.abortReason(agentAbort.signal) ?? 'cancelled');
        }
      }
    }
    return failure(lastCode);
  }

  // Required by the InferenceRunner interface; the agents never request streaming.
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<SemanticEvent> {
    throw new Error('Streaming is not supported by InferenceGateway');
  }

  private abortReason(agentSignal: AbortSignal): ProviderErrorCode | null {
    if (this.runAbort.signal.aborted) return 'cancelled';
    if (agentSignal.aborted) return agentSignal.reason instanceof ProviderError ? agentSignal.reason.code : 'cancelled';
    return null;
  }

  private record(contextId: string, output: InferenceOutput) {
    const u = output.tokenUsage;
    const add = (t: UsageTotals) => {
      t.calls += 1;
      if (!u) return;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.totalTokens += u.totalTokens;
      t.reasoningTokens += u.outputTokenDetails.reasoning_tokens;
      t.cachedInputTokens += u.inputTokenDetails.cached_tokens;
    };
    add(this.total);
    const name = this.agentNames.get(contextId) ?? 'unknown';
    const per = this.perAgent.get(name) ?? emptyUsage();
    add(per);
    this.perAgent.set(name, per);
  }
}

function failure(code: ProviderErrorCode): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text: `${PROVIDER_ERROR_PREFIX}${code}` })], tokenUsage: undefined, rowResponse: undefined };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
