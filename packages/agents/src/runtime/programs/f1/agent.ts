import { createAgent, type Participant, type SemanticEvent, type SituationHandler } from '@mozaik-ai/core';
import type { z } from 'zod';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { SpendPriority } from '../../../ai/budget';
import { readProviderErrorCode } from '../../../ai/gateway';
import { AGENT_INFO, type AgentKey } from '../../../discovery/f1/board';
import { F1_INSTRUCTIONS, repairMessage } from '../../../discovery/f1/prompts';
import type { InferenceGateway } from '../../../ai/gateway';
import { parseModelJson, toWireSchema } from '../../../discovery/schemas';
import { OnEventTypes, guarded } from '../../run-context';
import type { F1Env } from './env';
import type { RunContext } from '../../run-context';

/** What a phase agent needs from its phase's environment (F1 and F2 both satisfy it). */
export interface AgentHost {
  ctx: RunContext;
  gateway: InferenceGateway;
  settings: { model: string };
}

export interface AgentProfile {
  key: string;
  name: string;
  instruction: string;
  capabilities: string[];
}

export interface JobSpec<T> {
  kind: 'analysis' | 'review' | 'synthesis';
  /**
   * What this job is for when money is tight (SpendPriority). Default: analysis and synthesis are essential (1), cross-checks and
   * corrections are quality work (4). Optional refinements say 5.
   */
  priority?: SpendPriority;
  message: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  /** Deadline for this job (analysis uses the task deadline instead). */
  timeoutMs?: number;
  images?: { mediaType: string; base64: string }[];
  onSuccess(value: T): void;
  onFailure(error: SafeProviderError): void;
}

interface ActiveJob {
  spec: JobSpec<unknown>;
  repairs: number;
  timer?: NodeJS.Timeout;
}

/**
 * One phase agent (F1 or F2) as a REAL Mozaik Agent.
 *
 * It performs jobs (analysis, review, synthesis) through Mozaik's `runLoop` using its own memory
 * context, so a reviewer really answers from what it analyzed earlier in the same conversation.
 *
 * Loop safety: jobs run strictly one at a time (a queue holds the rest); it reacts to `model.answer`
 * only when the answer is its own and a job is active; a malformed answer gets exactly one repair
 * attempt; every job has a deadline; and it never subscribes to events that it emits itself.
 */
export class PhaseAgent {
  readonly participant: Participant;
  readonly name: string;
  readonly key: string;
  private job: ActiveJob | null = null;
  private readonly queue: JobSpec<unknown>[] = [];
  private taskTimer?: NodeJS.Timeout;
  private taskOpen = false;
  private readonly taskAbort = new AbortController();

  constructor(
    protected readonly env: AgentHost,
    profile: AgentProfile,
    handlers: (self: PhaseAgent) => SituationHandler[],
  ) {
    this.key = profile.key;
    this.name = profile.name;
    const ctx = env.ctx;
    this.participant = createAgent({
      name: this.name,
      capabilities: profile.capabilities,
      instruction: profile.instruction,
      tools: [],
      handlers: [
        ...handlers(this),
        {
          specification: new OnEventTypes(['model.answer']),
          processor: guarded(ctx.guard(this.name), ({ event }) => this.onAnswer(event)),
        },
      ],
    });
    env.gateway.registerAgent(this.contextId, this.name);
  }

  get contextId() {
    return (this.participant as unknown as { getMemory(): { getContext(): { id: string } } }).getMemory().getContext().id;
  }

  /** Aborted when the agent's own task deadline passes or the run ends: pass to tool calls. */
  get signal(): AbortSignal {
    return AbortSignal.any([this.env.ctx.signal, this.taskAbort.signal]);
  }

  get busy() {
    return this.taskOpen || this.job !== null || this.queue.length > 0;
  }

  // ---- task (analysis) lifecycle: covers tool retrieval AND the model call ----

  openTask(timeoutMs: number, onTimeout: () => void) {
    if (this.taskOpen) return false;
    this.taskOpen = true;
    this.taskTimer = this.env.ctx.setTimer(timeoutMs, () => {
      if (!this.taskOpen) return;
      this.taskOpen = false;
      this.taskAbort.abort(); // stops tool calls in flight
      this.env.gateway.abortAgent(this.contextId, 'timeout'); // stops the model request in flight
      this.dropJobs();
      onTimeout();
    });
    return true;
  }

  isTaskOpen() {
    return this.taskOpen;
  }

  closeTask() {
    this.taskOpen = false;
    if (this.taskTimer) this.env.ctx.clearTimer(this.taskTimer);
  }

  // ---- jobs ----

  runJob<T>(spec: JobSpec<T>) {
    if (this.job) this.queue.push(spec as JobSpec<unknown>);
    else this.start(spec as JobSpec<unknown>);
  }

  private start(spec: JobSpec<unknown>) {
    const job: ActiveJob = { spec, repairs: 0 };
    this.job = job;
    if (spec.timeoutMs) {
      job.timer = this.env.ctx.setTimer(spec.timeoutMs, () => {
        if (this.job !== job) return;
        this.env.gateway.abortAgent(this.contextId, 'timeout');
        this.job = null;
        spec.onFailure(toSafeError('timeout'));
        this.next();
      });
    }
    if (spec.images?.length) this.env.gateway.attachImages(this.contextId, spec.images);
    this.env.gateway.setCallPriority(this.contextId, spec.priority ?? (spec.kind === 'review' ? 4 : 1));
    // the final document of a phase is a long structured answer: its clock grows with the tokens it may produce
    this.env.gateway.setLongAnswer(this.contextId, spec.kind === 'synthesis');
    this.loop(spec.message);
  }

  private loop(message: string) {
    const spec = this.job!.spec;
    this.env.ctx.runLoop(this.participant.getId(), message, {
      model: this.env.settings.model,
      context: (this.participant as unknown as { getMemory(): { getContext(): never } }).getMemory().getContext(),
      tools: [],
      structuredOutput: { name: spec.schemaName, schema: toWireSchema(spec.schema), strict: true },
      maxOutputTokens: spec.maxOutputTokens,
    });
  }

  private finish(then: () => void) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    if (job.timer) this.env.ctx.clearTimer(job.timer);
    then();
    this.next();
  }

  /**
   * Starts the next queued job, but ONLY if nothing is running. `then()` in finish() emits events synchronously, and
   * those can hand this very agent a new job (e.g. review requests) before finish() reaches next(): starting another
   * one then would run two loops at once and lose track of the first (the run would never finish).
   */
  private next() {
    if (this.job || this.env.ctx.isClosed()) return;
    const spec = this.queue.shift();
    if (spec) this.start(spec);
  }

  private dropJobs() {
    if (this.job?.timer) this.env.ctx.clearTimer(this.job.timer);
    this.job = null;
    this.queue.length = 0;
  }

  private onAnswer(event: SemanticEvent) {
    const job = this.job;
    if (event.producerId !== this.participant.getId() || !job) return; // not mine, or nothing pending (e.g. aborted)
    const answer = (event.payload as { answer?: { content?: { text?: unknown } } } | null)?.answer;
    const text = typeof answer?.content?.text === 'string' ? answer.content.text : '';
    const code = readProviderErrorCode(text);
    if (code) {
      const detail = this.env.gateway.failureDetail(this.contextId, code);
      return this.finish(() => job.spec.onFailure(detail ? { ...toSafeError(code), detail } : toSafeError(code)));
    }
    const parsed = parseModelJson(text, job.spec.schema);
    if (parsed.ok) return this.finish(() => job.spec.onSuccess(parsed.value));
    if (job.repairs < 1) {
      job.repairs++;
      return this.loop(repairMessage(parsed.issues));
    }
    this.finish(() => job.spec.onFailure({ ...toSafeError('invalid_response'), detail: parsed.issues.join('; ').slice(0, 400) }));
  }
}

/** An F1 analyst or the Product Synthesizer. */
export class F1Agent extends PhaseAgent {
  constructor(env: F1Env, key: AgentKey, handlers: (self: PhaseAgent) => SituationHandler[]) {
    super(env, { key, name: AGENT_INFO[key].name, instruction: F1_INSTRUCTIONS[key], capabilities: ['product-discovery', key === 'synthesizer' ? 'synthesis' : 'analysis', 'inference'] }, handlers);
  }
}
