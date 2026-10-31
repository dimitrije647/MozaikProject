import {
  SemanticEvent,
  createHuman,
  defineRuntime,
  type InferenceInput,
  type Participant,
} from '@mozaik-ai/core';
import type { EmittedEventType, FactoryEventPayloads, RunMode, TerminalReason } from '../factory/events';
import type { ProductDiscoveryReportV2 } from '../discovery/f1/schemas';
import { redact, safeErrorMessage } from '../factory/redact';
import {
  FactoryRuntimeState,
  isTerminal,
  type CampaignManifest,
  type CampaignRunStatus,
  type RecordedEvent,
} from '../factory/state';
import { summarizeForHistory } from './history';
import { F1Program, type DiscoveryRunConfig, type ReportMeta } from './programs/f1-program';
import { F2Program, type AuditReportMeta, type AuditRunConfig } from './programs/f2-program';
import { F3Program, type StrategyReportMeta, type StrategyRunConfig } from './programs/f3-program';
import { F4Program, type CreativeReportMeta, type CreativeRunConfig } from './programs/f4-program';
import type { CampaignPackage } from '../creative/schemas';
import type { CampaignStrategyReport } from '../strategy/schemas';
import type { MarketingAuditReport } from '../audit/schemas';
import { SmokeProgram, type SmokeTestOptions } from './programs/smoke-program';
import type { InferenceCredentials } from './providers';
import { OnAnyEvent, OnEventTypes, guarded, type RunContext, type RunProgram } from './run-context';
import { enforceTelemetryPolicy } from './telemetry';

export { DEFAULT_SMOKE_TIMEOUT_MS, type SmokeBehavior, type SmokeTestOptions } from './programs/smoke-program';
export { planF1, type DiscoveryRunConfig, type ReportMeta, type ReportSink } from './programs/f1-program';

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
  /** marketing_audit settings (needs a completed F1 report, see buildF1Context). */
  audit?: AuditRunConfig;
  /** market_strategy settings (needs a completed F1 report and F2 audit, see buildF1Context / buildF2Context). */
  strategy?: StrategyRunConfig;
  /** creative_production settings (needs the completed F1 -> F2 -> F3 chain and an asset store). */
  creative?: CreativeRunConfig;
  /**
   * Receives every event of the run, already sanitized and compacted, in order. The backend
   * persists them. Returned promises are not awaited by the runtime (Mozaik delivery is synchronous).
   */
  onEvent?: (event: RecordedEvent) => void | Promise<void>;
  /**
   * product_discovery: called with the validated report BEFORE the run is completed. The run only
   * completes if this resolves; a rejection fails the run.
   */
  onReport?: (report: ProductDiscoveryReportV2, meta: ReportMeta) => Promise<void>;
  /** marketing_audit: same contract as onReport, for the Marketing Audit Report. */
  onAudit?: (report: MarketingAuditReport, meta: AuditReportMeta) => Promise<void>;
  /** market_strategy: same contract, for the Campaign Strategy Report. */
  onStrategy?: (report: CampaignStrategyReport, meta: StrategyReportMeta) => Promise<void>;
  /** creative_production: same contract, for the Campaign Package. */
  onCampaign?: (pkg: CampaignPackage, meta: CreativeReportMeta) => Promise<void>;
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

type BaseRunInput = Omit<CampaignRunInput, 'credentials' | 'discovery' | 'audit' | 'strategy' | 'creative' | 'options' | 'onReport' | 'onAudit' | 'onStrategy' | 'onCampaign'>;

class ActiveRun implements RunContext {
  readonly mozaik = defineRuntime<FactoryRuntimeState>(); // own closure => own runtime, no shared globals
  readonly state: FactoryRuntimeState;
  readonly done: Promise<CampaignRunResult>;

  private readonly abortController = new AbortController();
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
  get signal() {
    return this.abortController.signal;
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

  join(participant: Participant) {
    if (this.closed) return;
    this.mozaik.join(participant);
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
    this.abortController.abort();
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

    const { credentials, discovery, audit, strategy, creative, options, onReport, onAudit, onStrategy, onCampaign, ...base } = input;
    const program = this.createProgram(input.mode, { credentials, discovery, audit, strategy, creative, options, onReport, onAudit, onStrategy, onCampaign });

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
    parts: Pick<CampaignRunInput, 'credentials' | 'discovery' | 'audit' | 'strategy' | 'creative' | 'options' | 'onReport' | 'onAudit' | 'onStrategy' | 'onCampaign'>,
  ): RunProgram {
    if (mode === 'smoke_test') return new SmokeProgram(parts.options, parts.credentials);
    if (mode === 'product_discovery') {
      if (!parts.credentials) throw new RuntimeInitError('Product Discovery needs the user\'s OpenAI credentials');
      if (parts.credentials.provider !== 'openai') throw new RuntimeInitError('Product Discovery currently supports OpenAI only');
      if (!parts.discovery?.model?.trim()) throw new RuntimeInitError('Product Discovery needs an explicit model');
      if (!parts.onReport) throw new RuntimeInitError('Product Discovery needs a report sink (onReport)');
      return new F1Program(parts.credentials, parts.discovery, parts.onReport);
    }
    if (mode === 'marketing_audit') {
      if (!parts.credentials) throw new RuntimeInitError("Marketing Audit needs the user's OpenAI credentials");
      if (parts.credentials.provider !== 'openai') throw new RuntimeInitError('Marketing Audit currently supports OpenAI only');
      if (!parts.audit?.model?.trim()) throw new RuntimeInitError('Marketing Audit needs an explicit model');
      if (!parts.audit.f1) throw new RuntimeInitError('Marketing Audit needs a completed F1 report');
      if (!parts.onAudit) throw new RuntimeInitError('Marketing Audit needs a report sink (onAudit)');
      return new F2Program(parts.credentials, parts.audit, parts.onAudit);
    }
    if (mode === 'market_strategy') {
      if (!parts.credentials) throw new RuntimeInitError("Market Strategy needs the user's OpenAI credentials");
      if (parts.credentials.provider !== 'openai') throw new RuntimeInitError('Market Strategy currently supports OpenAI only');
      if (!parts.strategy?.model?.trim()) throw new RuntimeInitError('Market Strategy needs an explicit model');
      if (!parts.strategy.f1 || !parts.strategy.f2) throw new RuntimeInitError('Market Strategy needs a completed F1 report and F2 audit');
      if (parts.strategy.f2.f1ReportId !== parts.strategy.f1.reportId) throw new RuntimeInitError('The F2 audit was not built on the selected F1 report');
      if (!parts.onStrategy) throw new RuntimeInitError('Market Strategy needs a report sink (onStrategy)');
      return new F3Program(parts.credentials, parts.strategy, parts.onStrategy);
    }
    if (mode === 'creative_production') {
      if (!parts.credentials) throw new RuntimeInitError("Creative Production needs the user's OpenAI credentials");
      if (parts.credentials.provider !== 'openai') throw new RuntimeInitError('Creative Production currently supports OpenAI only');
      const c = parts.creative;
      if (!c?.model?.trim()) throw new RuntimeInitError('Creative Production needs an explicit text model');
      if (!c.f1 || !c.f2 || !c.f3) throw new RuntimeInitError('Creative Production needs the completed F1 report, F2 audit and F3 strategy');
      if (c.f2.f1ReportId !== c.f1.reportId || c.f3.f1ReportId !== c.f1.reportId || c.f3.f2AuditId !== c.f2.auditId) throw new RuntimeInitError('The F1 report, F2 audit and F3 strategy do not belong to the same chain');
      if (!c.assets) throw new RuntimeInitError('Creative Production needs an asset store');
      if (!parts.onCampaign) throw new RuntimeInitError('Creative Production needs a package sink (onCampaign)');
      return new F4Program(parts.credentials, c, parts.onCampaign);
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
