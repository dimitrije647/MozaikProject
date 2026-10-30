import {
  SemanticEvent,
  createHuman,
  defineRuntime,
  type InferenceInput,
  type Participant,
} from '@mozaik-ai/core';
import type { EmittedEventType, FactoryEventPayloads, RunMode, TerminalReason } from '../factory/events';
import type { ProductDiscoveryReport } from '../discovery/schemas';
import { redact, safeErrorMessage } from '../factory/redact';
import {
  FactoryRuntimeState,
  isTerminal,
  type CampaignManifest,
  type CampaignRunStatus,
  type RecordedEvent,
} from '../factory/state';
import { summarizeForHistory } from './history';
import { DiscoveryProgram, type DiscoveryRunConfig, type ReportMeta } from './programs/discovery-program';
import { SmokeProgram, type SmokeTestOptions } from './programs/smoke-program';
import type { InferenceCredentials } from './providers';
import { OnAnyEvent, OnEventTypes, guarded, type RunContext, type RunProgram } from './run-context';
import { enforceTelemetryPolicy } from './telemetry';

export { DEFAULT_SMOKE_TIMEOUT_MS, type SmokeBehavior, type SmokeTestOptions } from './programs/smoke-program';
export { AGENT_NAMES, type DiscoveryRunConfig, type ReportMeta, type ReportSink } from './programs/discovery-program';

export interface CampaignRunInput {
  runId: string;
  projectId: string;
  userId: string;
  mode: RunMode;
  /** Non-secret brief snapshot. */
  manifest: CampaignManifest;
  /** Only for modes that call an LLM (product_discovery requires OpenAI credentials). */
  credentials?: InferenceCredentials;
  /** smoke_test settings. */
  options?: SmokeTestOptions;
  /** product_discovery settings. */
  discovery?: DiscoveryRunConfig;
  /**
   * Receives every event of the run, already sanitized and compacted, in order. The backend
   * persists them. Returned promises are not awaited by the runtime (Mozaik delivery is synchronous).
   */
  onEvent?: (event: RecordedEvent) => void | Promise<void>;
  /**
   * product_discovery: called with the validated report BEFORE the run is completed. The run only
   * completes if this resolves; a rejection fails the run.
   */
  onReport?: (report: ProductDiscoveryReport, meta: ReportMeta) => Promise<void>;
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

/** Safety net against runaway event loops: a run that emits more events than this is failed. */
export const MAX_EVENTS_PER_RUN = 600;

// ---- One isolated run ----------------------------------------------------------------------

type BaseRunInput = Omit<CampaignRunInput, 'credentials' | 'discovery' | 'options' | 'onReport'>;

class ActiveRun implements RunContext {
  readonly mozaik = defineRuntime<FactoryRuntimeState>(); // own closure => own runtime, no shared globals
  readonly state: FactoryRuntimeState;
  readonly done: Promise<CampaignRunResult>;

  private resolveDone!: (r: CampaignRunResult) => void;
  private sequence = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private orchestratorParticipant!: Participant;

  constructor(
    // Credentials are deliberately not part of this type: they go to the program once and are never
    // retained here, so they are not reachable from the run object for its lifetime.
    private readonly input: BaseRunInput,
    private readonly program: RunProgram,
    private readonly timeoutMs: number,
    private readonly release: (runId: string) => void,
    private readonly warn: (message: string) => void,
  ) {
    this.state = new FactoryRuntimeState(input.runId, input.projectId, input.userId, input.manifest);
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get runId() {
    return this.input.runId;
  }
  get orchestrator() {
    return this.orchestratorParticipant;
  }
  get status() {
    return this.state.status;
  }
  isClosed() {
    return this.closed;
  }

  start() {
    this.mozaik.initializeRuntime({ state: this.state, inferenceRunnerConfig: this.program.inferenceConfig() });

    // Join order matters: the recorder joins first so it sees every later event, including joins.
    const recorder = createHuman({
      name: 'Run Recorder',
      capabilities: ['record-events'],
      handlers: [{ specification: new OnAnyEvent(), processor: guarded((e) => this.warnErr('recorder', e), (c) => this.record(c.event)) }],
    });

    // Mozaik only offers Agent and Human participants; the orchestrator is a Human by type only.
    this.orchestratorParticipant = createHuman({
      name: 'Factory Orchestrator',
      capabilities: ['orchestrate'],
      handlers: [
        ...this.program.orchestratorHandlers(this),
        {
          specification: new OnEventTypes(['factory.completed', 'factory.failed', 'factory.cancelled']),
          processor: guarded(this.guard('Factory Orchestrator'), ({ event }) => this.onTerminalEvent(event)),
        },
      ],
    });

    this.mozaik.join(recorder);
    this.mozaik.join(this.orchestratorParticipant);
    for (const p of this.program.participants(this)) this.mozaik.join(p);

    const deadline = setTimeout(() => {
      this.emit('factory.failed', { reason: 'timeout', message: `Run timed out after ${this.timeoutMs} ms` }, this.orchestratorParticipant);
    }, this.timeoutMs);
    this.timers.add(deadline);

    this.program.kickoff(this);
  }

  cancel(reason: 'cancelled' | 'server_shutdown' = 'cancelled') {
    if (!this.closed) this.emit('factory.cancelled', { reason }, this.orchestratorParticipant);
    return this.done;
  }

  /** Abort a half-started run (initialization failure): release everything, emit nothing further. */
  abort() {
    this.closeResources('failed');
  }

  // ---- RunContext

  emit<T extends EmittedEventType>(type: T, payload: FactoryEventPayloads[T], from: Participant) {
    if (this.closed) return;
    this.mozaik.sendEvent(SemanticEvent.create(type, from.getId(), payload), from.getId());
  }

  fail(err: unknown, participant: string) {
    if (this.closed) return;
    try {
      this.emit('factory.failed', { reason: 'participant_error', message: safeErrorMessage(err), participant }, this.orchestratorParticipant);
    } catch (emitErr) {
      // The event system itself is broken: still reach a truthful terminal state.
      this.closeResources('failed', safeErrorMessage(emitErr));
    }
  }

  guard(who: string) {
    return (err: unknown) => this.fail(err, who);
  }

  setTimer(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      // Timer callbacks run outside Mozaik's handler guard, so guard here too.
      try {
        fn();
      } catch (err) {
        this.fail(err, 'timer');
      }
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  clearTimer(timer: NodeJS.Timeout) {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  runLoop(agentId: string, message: string, input: InferenceInput) {
    if (this.closed) return;
    this.mozaik.runLoop(agentId, message, input);
  }

  // ---- internals

  private record(event: SemanticEvent) {
    if (this.closed) return;
    const summary = summarizeForHistory(event.type, event.payload);
    const raw = event.payload;
    const payload =
      summary ?? (raw && typeof raw === 'object' ? (redact(raw) as Record<string, unknown>) : raw == null ? null : { value: redact(raw) });
    const producer = this.state.getParticipant(event.producerId);
    const recorded: RecordedEvent = {
      runId: this.input.runId,
      sequence: ++this.sequence,
      type: event.type,
      phase: this.state.currentPhase,
      participant: producer ? producer.getManifest().name : null,
      payload: payload ? (redact(payload) as Record<string, unknown>) : null,
      occurredAt: event.occurredAt.toISOString(),
    };
    this.state.pushEvent(recorded);
    try {
      const pending = this.input.onEvent?.(recorded);
      if (pending && typeof pending.then === 'function') pending.catch((e) => this.warnErr('onEvent sink', e));
    } catch (err) {
      this.warnErr('onEvent sink', err);
    }
    if (this.sequence === MAX_EVENTS_PER_RUN + 1) {
      queueMicrotask(() => this.fail(new Error(`Event limit (${MAX_EVENTS_PER_RUN}) exceeded; stopping a possible event loop`), 'runtime'));
    }
  }

  private onTerminalEvent(event: SemanticEvent) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'factory.completed') return this.closeResources('completed');
    if (event.type === 'factory.failed') return this.closeResources('failed', String(payload.message ?? 'Run failed'));
    // factory.cancelled
    return this.closeResources(payload.reason === 'server_shutdown' ? 'interrupted' : 'cancelled');
  }

  private closeResources(status: Exclude<CampaignRunStatus, 'running'>, errorMessage?: string) {
    if (this.closed) return;
    this.closed = true; // from here on, nothing is recorded or emitted
    this.state.status = status;
    this.state.completedAt = new Date().toISOString();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    try {
      this.program.dispose();
    } catch (err) {
      this.warnErr('dispose', err);
    }
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
    enforceTelemetryPolicy(); // idempotent; guards against the environment changing after construction
    if (this.active.has(input.runId)) throw new RuntimeInitError(`Run ${input.runId} is already active`);

    const { credentials, discovery, options, onReport, ...base } = input;
    const program = this.createProgram(input.mode, { credentials, discovery, options, onReport });

    const run = new ActiveRun(base, program, program.defaultTimeoutMs, (id) => this.active.delete(id), this.warn);
    this.active.set(input.runId, run);
    try {
      run.start();
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

  private createProgram(
    mode: RunMode,
    parts: Pick<CampaignRunInput, 'credentials' | 'discovery' | 'options' | 'onReport'>,
  ): RunProgram {
    if (mode === 'smoke_test') return new SmokeProgram(parts.options, parts.credentials);
    if (mode === 'product_discovery') {
      if (!parts.credentials) throw new RuntimeInitError('Product Discovery needs the user\'s OpenAI credentials');
      if (parts.credentials.provider !== 'openai') throw new RuntimeInitError('Product Discovery currently supports OpenAI only');
      if (!parts.discovery?.model?.trim()) throw new RuntimeInitError('Product Discovery needs an explicit model');
      if (!parts.onReport) throw new RuntimeInitError('Product Discovery needs a report sink (onReport)');
      return new DiscoveryProgram(parts.credentials, parts.discovery, parts.onReport);
    }
    throw new RuntimeInitError(`Run mode "${String(mode)}" is not implemented`);
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
