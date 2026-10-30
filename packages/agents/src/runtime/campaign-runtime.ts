import {
  SemanticEvent,
  SituationSpecification,
  createAgent,
  createHuman,
  defineRuntime,
  type Participant,
  type SituationContext,
  type SituationHandler,
} from '@mozaik-ai/core';
import { SMOKE_ACK_EVENT, type FactoryEventPayloads, type RunMode, type TerminalReason } from '../factory/events';
import { redact, safeErrorMessage } from '../factory/redact';
import {
  FactoryRuntimeState,
  isTerminal,
  type CampaignManifest,
  type CampaignRunStatus,
  type RecordedEvent,
} from '../factory/state';
import { buildInferenceRunnerConfig, type InferenceCredentials } from './providers';
import { enforceTelemetryPolicy } from './telemetry';

export type SmokeBehavior = 'acknowledge' | 'fail' | 'silent';

export interface SmokeTestOptions {
  /** Delay before the test participant acknowledges. Lets callers observe "running" and cancel. */
  delayMs?: number;
  /** Hard deadline for the whole run. */
  timeoutMs?: number;
  /** Fault injection for tests: 'fail' throws inside the participant, 'silent' never answers. */
  behavior?: SmokeBehavior;
}

export interface CampaignRunInput {
  runId: string;
  projectId: string;
  userId: string;
  mode: RunMode;
  /** Non-secret brief snapshot. */
  manifest: CampaignManifest;
  /** Only for modes that call an LLM. Never required for the smoke test. */
  credentials?: InferenceCredentials;
  options?: SmokeTestOptions;
  /**
   * Receives every event of the run, already sanitized, in order. The backend persists them.
   * Returned promises are not awaited by the runtime (Mozaik delivery is synchronous).
   */
  onEvent?: (event: RecordedEvent) => void | Promise<void>;
}

export interface CampaignRunResult {
  runId: string;
  status: Exclude<CampaignRunStatus, 'running'>;
  errorMessage?: string;
  eventCount: number;
}

export interface CampaignRunHandle {
  readonly runId: string;
  status(): CampaignRunStatus;
  /** Resolves exactly once, when the run reaches a terminal status. Never rejects. */
  readonly done: Promise<CampaignRunResult>;
  cancel(reason?: Extract<TerminalReason, 'cancelled' | 'server_shutdown'>): Promise<CampaignRunResult>;
}

export interface CampaignRuntime {
  startRun(input: CampaignRunInput): Promise<CampaignRunHandle>;
  /** Status of a run active in THIS process, or null when it is not active here. */
  getRunStatus(runId: string): Promise<CampaignRunStatus | null>;
  stopRun(runId: string): Promise<void>;
  /** Stops every active run as `interrupted` and waits for them to settle. */
  shutdown(): Promise<void>;
}

export class RuntimeInitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeInitError';
  }
}

export const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const clamp = (n: number | undefined, min: number, max: number, fallback: number) =>
  Math.min(Math.max(Number.isFinite(n as number) ? (n as number) : fallback, min), max);

// ---- Mozaik situation specifications -------------------------------------------------------

class OnEventTypes extends SituationSpecification {
  constructor(private readonly types: readonly string[]) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext): boolean {
    return this.types.includes(event.type);
  }
}

class OnAnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

/**
 * Mozaik calls `processor.apply` synchronously and ignores its result, so a thrown error or a
 * rejected promise would otherwise surface as an unhandled exception/rejection outside the run.
 * Every handler goes through here so failures become a `factory.failed` event instead.
 */
function guarded(
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

// ---- One isolated run ----------------------------------------------------------------------

class ActiveRun {
  readonly mozaik = defineRuntime<FactoryRuntimeState>(); // own closure => own runtime, no shared globals
  readonly state: FactoryRuntimeState;
  readonly done: Promise<CampaignRunResult>;

  private resolveDone!: (r: CampaignRunResult) => void;
  private sequence = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private orchestrator!: Participant;
  private smoke!: Participant;
  private readonly options: Required<SmokeTestOptions>;

  constructor(
    // Credentials are deliberately not part of this type: they are passed to start() once and
    // never retained, so they are not reachable from the run object for its lifetime.
    private readonly input: Omit<CampaignRunInput, 'credentials'>,
    private readonly release: (runId: string) => void,
    private readonly warn: (message: string) => void,
  ) {
    this.state = new FactoryRuntimeState(input.runId, input.projectId, input.userId, input.manifest);
    this.options = {
      delayMs: clamp(input.options?.delayMs, 0, 30_000, 0),
      timeoutMs: clamp(input.options?.timeoutMs, 50, 120_000, DEFAULT_SMOKE_TIMEOUT_MS),
      behavior: input.options?.behavior ?? 'acknowledge',
    };
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get status() {
    return this.state.status;
  }

  start(credentials?: InferenceCredentials) {
    this.mozaik.initializeRuntime({
      state: this.state,
      // Smoke test: no credentials => empty model list => inference is impossible by construction.
      inferenceRunnerConfig: buildInferenceRunnerConfig(credentials),
    });

    // Join order matters: the recorder joins first so it sees every later event, including joins.
    const recorder = createHuman({
      name: 'Run Recorder',
      capabilities: ['record-events'],
      handlers: [{ specification: new OnAnyEvent(), processor: guarded((e) => this.warnErr('recorder', e), (c) => this.record(c.event)) }],
    });

    const onError = (who: string) => (err: unknown) => this.fail(err, who);

    // Mozaik only offers Agent and Human participants; the orchestrator is a Human by type only.
    this.orchestrator = createHuman({
      name: 'Factory Orchestrator',
      capabilities: ['orchestrate'],
      handlers: [
        {
          specification: new OnEventTypes([SMOKE_ACK_EVENT]),
          processor: guarded(onError('Factory Orchestrator'), () => {
            this.emit('factory.completed', { mode: 'smoke_test', phasesCompleted: [] }, this.orchestrator);
          }),
        },
        {
          specification: new OnEventTypes(['factory.completed', 'factory.failed', 'factory.cancelled']),
          processor: guarded(onError('Factory Orchestrator'), ({ event }) => this.onTerminalEvent(event)),
        },
      ],
    });

    // Deterministic participant: genuinely joins the Mozaik runtime and reacts to events, but never
    // calls a model, so the smoke test costs nothing and needs no API key.
    this.smoke = createAgent({
      name: 'Smoke Test Participant',
      capabilities: ['smoke-test'],
      instruction: 'Deterministic infrastructure test participant. Performs no inference.',
      tools: [],
      handlers: [
        {
          specification: new OnEventTypes(['factory.started']),
          processor: guarded(onError('Smoke Test Participant'), () => this.smokeOnStarted()),
        },
      ],
    });

    this.mozaik.join(recorder);
    this.mozaik.join(this.orchestrator);
    this.mozaik.join(this.smoke);

    const timeout = setTimeout(() => {
      this.emit(
        'factory.failed',
        { reason: 'timeout', message: `Run timed out after ${this.options.timeoutMs} ms` },
        this.orchestrator,
      );
    }, this.options.timeoutMs);
    this.timers.add(timeout);

    this.emit('factory.started', { mode: this.input.mode, label: 'Infrastructure Smoke Test' }, this.orchestrator);
  }

  cancel(reason: 'cancelled' | 'server_shutdown' = 'cancelled') {
    if (!this.closed) this.emit('factory.cancelled', { reason }, this.orchestrator);
    return this.done;
  }

  /** Abort a half-started run (initialization failure): release everything, emit nothing further. */
  abort() {
    this.closeResources('failed');
  }

  // ---- internals

  private smokeOnStarted() {
    const { behavior, delayMs } = this.options;
    if (behavior === 'fail') throw new Error('Injected participant failure (fault-injection test)');
    if (behavior === 'silent') return;
    const acknowledge = () =>
      this.emit(SMOKE_ACK_EVENT, { by: 'Smoke Test Participant', receivedEvent: 'factory.started' }, this.smoke);
    if (delayMs === 0) return acknowledge();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // Timer callbacks run outside Mozaik's handler guard, so guard here too.
      try {
        acknowledge();
      } catch (err) {
        this.fail(err, 'Smoke Test Participant');
      }
    }, delayMs);
    this.timers.add(timer);
  }

  private emit<T extends keyof FactoryEventPayloads>(type: T, payload: FactoryEventPayloads[T], from: Participant) {
    if (this.closed) return;
    this.mozaik.sendEvent(SemanticEvent.create(type, from.getId(), payload), from.getId());
  }

  private record(event: SemanticEvent) {
    if (this.closed) return;
    const raw = event.payload;
    const payload =
      raw && typeof raw === 'object' ? (redact(raw) as Record<string, unknown>) : raw == null ? null : { value: redact(raw) };
    const producer = this.state.getParticipant(event.producerId);
    const recorded: RecordedEvent = {
      runId: this.input.runId,
      sequence: ++this.sequence,
      type: event.type,
      phase: this.state.currentPhase,
      participant: producer ? producer.getManifest().name : null,
      payload,
      occurredAt: event.occurredAt.toISOString(),
    };
    this.state.pushEvent(recorded);
    try {
      const pending = this.input.onEvent?.(recorded);
      if (pending && typeof pending.then === 'function') pending.catch((e) => this.warnErr('onEvent sink', e));
    } catch (err) {
      this.warnErr('onEvent sink', err);
    }
  }

  private onTerminalEvent(event: SemanticEvent) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'factory.completed') return this.closeResources('completed');
    if (event.type === 'factory.failed') return this.closeResources('failed', String(payload.message ?? 'Run failed'));
    // factory.cancelled
    return this.closeResources(payload.reason === 'server_shutdown' ? 'interrupted' : 'cancelled');
  }

  private fail(err: unknown, participant: string) {
    if (this.closed) return;
    try {
      this.emit(
        'factory.failed',
        { reason: 'participant_error', message: safeErrorMessage(err), participant },
        this.orchestrator,
      );
    } catch (emitErr) {
      // The event system itself is broken: still reach a truthful terminal state.
      this.closeResources('failed', safeErrorMessage(emitErr));
    }
  }

  private closeResources(status: Exclude<CampaignRunStatus, 'running'>, errorMessage?: string) {
    if (this.closed) return;
    this.closed = true; // from here on, nothing is recorded or emitted
    this.state.status = status;
    this.state.completedAt = new Date().toISOString();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    try {
      for (const p of [...this.state.getParticipants()].reverse()) this.mozaik.leave(p);
    } catch (err) {
      this.warnErr('leave', err);
    }
    this.release(this.input.runId);
    this.resolveDone({ runId: this.input.runId, status, errorMessage, eventCount: this.sequence });
  }

  private warnErr(where: string, err: unknown) {
    this.warn(`[campaign-runtime ${this.input.runId}] ${where}: ${safeErrorMessage(err)}`);
  }
}

// ---- Public runtime ------------------------------------------------------------------------

export interface MozaikCampaignRuntimeOptions {
  logger?: { warn(message: string): void };
}

export class MozaikCampaignRuntime implements CampaignRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly warn: (message: string) => void;

  constructor(options: MozaikCampaignRuntimeOptions = {}) {
    // Privacy by default: Mozaik Cloud telemetry stays off unless an operator opts in (see telemetry.ts).
    enforceTelemetryPolicy();
    this.warn = (m) => options.logger?.warn(m);
  }

  async startRun(input: CampaignRunInput): Promise<CampaignRunHandle> {
    if (input.mode !== 'smoke_test') {
      throw new RuntimeInitError(`Run mode "${String(input.mode)}" is not implemented yet`);
    }
    if (this.active.has(input.runId)) throw new RuntimeInitError(`Run ${input.runId} is already active`);
    enforceTelemetryPolicy(); // idempotent; guards against the environment changing after construction

    const { credentials, ...withoutCredentials } = input;
    const run = new ActiveRun(withoutCredentials, (id) => this.active.delete(id), this.warn);
    this.active.set(input.runId, run);
    try {
      run.start(credentials);
    } catch (err) {
      run.abort();
      this.active.delete(input.runId);
      throw new RuntimeInitError(`Mozaik runtime failed to start: ${safeErrorMessage(err)}`, { cause: err });
    }
    return {
      runId: input.runId,
      status: () => run.status,
      done: run.done,
      cancel: (reason) => run.cancel(reason),
    };
  }

  async getRunStatus(runId: string) {
    return this.active.get(runId)?.status ?? null;
  }

  async stopRun(runId: string) {
    await this.active.get(runId)?.cancel('cancelled');
  }

  async shutdown() {
    await Promise.all([...this.active.values()].map((r) => r.cancel('server_shutdown')));
  }

  /** For diagnostics and tests: number of runs currently held in memory. */
  get activeCount() {
    return this.active.size;
  }
}

export { isTerminal };
