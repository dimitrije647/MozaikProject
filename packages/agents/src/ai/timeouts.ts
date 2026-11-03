/**
 * HOW LONG A MODEL MAY TAKE TO WRITE A LONG STRUCTURED ANSWER.
 *
 * Every request used to get the same fixed 90 s. That is plenty for an analyst (a few thousand tokens) and not enough for the final document
 * of a phase (the F1 report, the F2 audit, the F3 strategy), whose output cap is up to 8,000 tokens. Evidence (a real Hybrid Production run on
 * `gpt-6.1-sol`, 2026-11-02, read from the saved events): long structured answers were produced at 53 to 70 tokens/s (earlier recorded runs:
 * up to 93); the F1 and F2 synthesizers needed 65 s and 70 s for about 4.4k and 4.9k tokens, and the F3 Campaign Strategist, whose cap is 8,000
 * tokens, was still writing when the fixed 90 s ran out: the phase failed after 17 paid calls although every researcher had succeeded.
 *
 * So a request that is marked as a long answer gets a clock that grows with the number of tokens it may produce, at a speed deliberately
 * slower than anything measured (40 tokens/s), plus a fixed overhead for the time to the first token (a reasoning model may think first).
 * Only those requests change; every other call keeps its own limit, and an explicit `callTimeoutMs` of a caller (tests) is never overridden.
 * A request that still times out is NOT repeated automatically (it may have been billed); it is recorded as uncertain spend.
 */
export interface GenerationTimeout {
  /** The slowest speed the clock allows for. Lower = a longer clock. */
  tokensPerSecond: number;
  /** Time before the first token (queueing, reasoning). */
  overheadMs: number;
  /** No request is allowed more than this. */
  maxMs: number;
}

export const DEFAULT_GENERATION_TIMEOUT: GenerationTimeout = { tokensPerSecond: 40, overheadMs: 20_000, maxMs: 600_000 };

/** The clock of ONE request that may produce `outputTokens` tokens. */
export function generationTimeoutMs(outputTokens: number, g: GenerationTimeout = DEFAULT_GENERATION_TIMEOUT): number {
  return Math.min(g.maxMs, Math.ceil(Math.max(1, outputTokens) / g.tokensPerSecond) * 1000 + g.overheadMs);
}

/**
 * How long the AGENT's task (one synthesis, including the one larger re-ask that follows an answer that was cut off by its cap) may take.
 * The first attempt writes up to `cap` tokens; a cut-off answer is asked again with up to `escalateTo`.
 */
export function synthesisTaskTimeoutMs(cap: number, escalateTo: number | undefined, g: GenerationTimeout = DEFAULT_GENERATION_TIMEOUT): number {
  const second = escalateTo && escalateTo > cap ? generationTimeoutMs(Math.min(escalateTo, cap * 2), g) : 0;
  return generationTimeoutMs(cap, g) + second;
}

/**
 * Whether the clocks scale. They do unless the caller fixed the per-request limit itself (`callTimeoutMs`), unless it asked for scaling explicitly
 * (`configured`): the fixed value of a test or of an operator is respected.
 */
export function resolveGeneration(configured: Partial<GenerationTimeout> | undefined, callTimeoutFixed: boolean): GenerationTimeout | undefined {
  if (configured) return { ...DEFAULT_GENERATION_TIMEOUT, ...configured };
  return callTimeoutFixed ? undefined : DEFAULT_GENERATION_TIMEOUT;
}
