import { createAgent, type InferenceRunnerConfig, type Participant, type SituationHandler } from '@mozaik-ai/core';
import { SMOKE_ACK_EVENT } from '../../factory/events';
import { buildInferenceRunnerConfig, type InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';

export type SmokeBehavior = 'acknowledge' | 'fail' | 'silent';

export interface SmokeTestOptions {
  /** Delay before the test participant acknowledges. Lets callers observe "running" and cancel. */
  delayMs?: number;
  /** Hard deadline for the whole run. */
  timeoutMs?: number;
  /** Fault injection for tests: 'fail' throws inside the participant, 'silent' never answers. */
  behavior?: SmokeBehavior;
}

export const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
export const clamp = (n: number | undefined, min: number, max: number, fallback: number) =>
  Math.min(Math.max(Number.isFinite(n as number) ? (n as number) : fallback, min), max);

/**
 * Infrastructure smoke test: a deterministic participant that joins the real Mozaik runtime,
 * receives `factory.started` and answers with `test.acknowledged`. It never calls a model.
 */
export class SmokeProgram implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly delayMs: number;
  private readonly behavior: SmokeBehavior;
  // Built eagerly so the credentials (if any) are not retained by this object.
  private readonly config: InferenceRunnerConfig;
  private smoke!: Participant;

  constructor(options: SmokeTestOptions | undefined, credentials: InferenceCredentials | undefined) {
    this.delayMs = clamp(options?.delayMs, 0, 30_000, 0);
    this.defaultTimeoutMs = clamp(options?.timeoutMs, 50, 120_000, DEFAULT_SMOKE_TIMEOUT_MS);
    this.behavior = options?.behavior ?? 'acknowledge';
    // No credentials => empty model list => inference is impossible by construction.
    this.config = buildInferenceRunnerConfig(credentials);
  }

  inferenceConfig() {
    return this.config;
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    return [
      {
        specification: new OnEventTypes([SMOKE_ACK_EVENT]),
        processor: guarded(ctx.guard('Factory Orchestrator'), () => {
          ctx.emit('factory.completed', { mode: 'smoke_test', phasesCompleted: [] }, ctx.orchestrator);
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    this.smoke = createAgent({
      name: 'Smoke Test Participant',
      capabilities: ['smoke-test'],
      instruction: 'Deterministic infrastructure test participant. Performs no inference.',
      tools: [],
      handlers: [
        {
          specification: new OnEventTypes(['factory.started']),
          processor: guarded(ctx.guard('Smoke Test Participant'), () => this.onStarted(ctx)),
        },
      ],
    });
    return [this.smoke];
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'smoke_test', label: 'Infrastructure Smoke Test' }, ctx.orchestrator);
  }

  dispose() {
    /* timers are owned (and cleared) by the run */
  }

  private onStarted(ctx: RunContext) {
    if (this.behavior === 'fail') throw new Error('Injected participant failure (fault-injection test)');
    if (this.behavior === 'silent') return;
    const acknowledge = () => ctx.emit(SMOKE_ACK_EVENT, { by: 'Smoke Test Participant', receivedEvent: 'factory.started' }, this.smoke);
    if (this.delayMs === 0) return acknowledge();
    ctx.setTimer(this.delayMs, acknowledge);
  }
}
