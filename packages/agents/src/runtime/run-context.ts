import {
  SituationSpecification,
  type InferenceInput,
  type InferenceRunnerConfig,
  type Participant,
  type SituationContext,
  type SituationHandler,
} from '@mozaik-ai/core';
import type { EmittedEventType, FactoryEventPayloads } from '../factory/events';
import type { FactoryRuntimeState } from '../factory/state';

// ---- Mozaik situation specifications -------------------------------------------------------

export class OnEventTypes extends SituationSpecification {
  constructor(private readonly types: readonly string[]) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext): boolean {
    return this.types.includes(event.type);
  }
}

export class OnAnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

/**
 * Mozaik calls `processor.apply` synchronously and ignores its result, so a thrown error or a
 * rejected promise would otherwise surface as an unhandled exception/rejection outside the run.
 * Every handler goes through here so failures become a `factory.failed` event instead.
 */
export function guarded(
  onError: (err: unknown) => void,
  fn: (context: SituationContext) => void | Promise<void>,
): SituationHandler['processor'] {
  return {
    apply(context) {
      try {
        const result = fn(context);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(onError);
        }
      } catch (err) {
        onError(err);
      }
    },
  };
}

// ---- What a run program may do -------------------------------------------------------------

export interface RunContext {
  readonly runId: string;
  readonly state: FactoryRuntimeState;
  /** The orchestrator participant (valid once the run has started). */
  readonly orchestrator: Participant;
  emit<T extends EmittedEventType>(type: T, payload: FactoryEventPayloads[T], from: Participant): void;
  /** Reports a participant failure; ends the run as `factory.failed`. */
  fail(err: unknown, who: string): void;
  /** Timer that is cleared automatically when the run ends. */
  setTimer(ms: number, fn: () => void): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  isClosed(): boolean;
  /** Mozaik agent loop of this run's runtime. */
  runLoop(agentId: string, message: string, input: InferenceInput): void;
  guard(who: string): (err: unknown) => void;
}

/** A run program supplies the participants and kickoff for one kind of run. */
export interface RunProgram {
  readonly defaultTimeoutMs: number;
  /** Inference configuration for this run's isolated Mozaik runtime. */
  inferenceConfig(): InferenceRunnerConfig;
  /** Orchestrator handlers specific to this program (terminal-event handling is added by the run). */
  orchestratorHandlers(ctx: RunContext): SituationHandler[];
  /** Other participants; joined after the recorder and orchestrator. */
  participants(ctx: RunContext): Participant[];
  /** Emits the first event. */
  kickoff(ctx: RunContext): void;
  /** Cancels in-flight work (e.g. aborts model requests). Called once when the run ends. */
  dispose(): void;
}
