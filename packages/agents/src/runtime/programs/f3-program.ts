import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../ai/errors';
import { SpendBudget, scopeFor } from '../../ai/budget';
import { resolveGeneration, synthesisTaskTimeoutMs, type GenerationTimeout } from '../../ai/timeouts';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { capOutputTokens } from '../../ai/pricing';
import type { F1Context } from '../../audit/context';
import { SourceStore, type CrosscheckRecord, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import { conformanceIssues } from '../../contracts/report-contract';
import type { AgentOutcome } from '../../factory/events';
import { STRATEGY_INFO, type ScoutDecision, type StrategyBoardStore, type StrategyFinding, type StrategyPlan } from '../../strategy/board';
import { ageDays, type StrategyInput } from '../../strategy/context';
import { finalizeStrategy, type StrategyPolicyContext, type StrategyPolicyIssue } from '../../strategy/policy';
import { STRATEGY_INSTRUCTIONS, strategistMessage, type StrategyDigest } from '../../strategy/prompts';
import { STRATEGY_REPORT_VERSION, CampaignStrategyReport, StrategyAgentOutput, StrategyDraft } from '../../strategy/schemas';
import { HolidayTool } from '../../tools/holidays';
import { createWebExtractFromEnv } from '../../tools/web-extract';
import { WebFetchTool } from '../../tools/web-fetch';
import { createWebSearchFromEnv } from '../../tools/web-search';
import { createTextTransport, type InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { PhaseAgent } from './f1/agent';
import { StrategyCoordinator } from './f3/coordinator';
import type { F3Env, F3Settings, F3Tools } from './f3/env';
import { prepareResearch } from './f3/roles';
import { clamp } from './smoke-program';

const PHASE = 'F3_MARKET_STRATEGY' as const;

export interface StrategyRunConfig {
  /** The completed business research (F1 report, built by the backend from the stored report). */
  f1: F1Context;
  input: StrategyInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  /** Hard cap on provider calls for the whole run (research, strategy, retries and repairs). Default 6. */
  maxModelCalls?: number;
  /** `max_output_tokens` of the research answer. The strategy may use up to three times as much. Default 3000. */
  maxOutputTokens?: number;
  /** The approved spending limit in US dollars for THIS run; null/absent = none. Enforced before every paid request. */
  spendCapUsd?: number | null;
  /** The campaign-wide spend ledger shared by every phase (the factory passes it). Absent = this run gets a ledger of its own with `spendCapUsd`. */
  ledger?: SpendBudget;
  /** Category search queries per run (named competitors add one lookup each). Default 3. */
  maxSearches?: number;
  /** Competitor SITES read per run. Default 4. */
  maxCompetitorPages?: number;
  /** Pages read per competitor site: the home page plus relevant same-site pages (pricing, about, services). Default 3. */
  maxPagesPerCompetitor?: number;
  /** Deadline of the research task (gathering plus its model call). Default 240 s. */
  agentTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Scales the clock of long structured answers with their output cap (default: on, unless callTimeoutMs is fixed). Tests may tune it. */
  generation?: Partial<GenerationTimeout>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Test seam: base URL of the provider API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  tools?: Partial<F3Tools>;
  /** TESTS ONLY: marks every source from external tools as a fixture (never real-world evidence). */
  fixtureSources?: boolean;
  /** TESTS ONLY: the clock. */
  now?: Date;
}

export interface StrategyReportMeta {
  schemaVersion: number;
  model: string;
  provider: 'openai' | 'anthropic';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  /** maxScouts and maxReviews stay 0 (stored shape of strategies saved before V4). */
  budget: { maxModelCalls: number; maxScouts: number; maxReviews: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  /** The exact business-research result this strategy used. */
  f1: { reportId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean };
  /** The Marketing Audit an older strategy was built on. Always null for V4 strategies (no audit is run). */
  f2: { auditId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean } | null;
  plan: StrategyPlan;
  /** LEGACY, always empty (no Channel Scouts in V4). */
  scoutDecisions: ScoutDecision[];
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  findings: StrategyFinding[];
  /** LEGACY, always empty (no cross-checks in V4). */
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  policyIssues: StrategyPolicyIssue[];
  aiCalls: Record<string, number>;
  /** Everything that limits the strategy (same list as the report's "limitations"). */
  notAnalyzed: { label: string; reason: string }[];
  tools: { search: { provider: string; configured: boolean; used: boolean }; extract: { provider: string; configured: boolean; calls: number }; holidays: { used: boolean; calls: number }; fixtureSources: boolean };
  inputSnapshot: StrategyInput;
}

export type StrategySink = (report: CampaignStrategyReport, meta: StrategyReportMeta) => Promise<void>;

/** The single participant of the phase and the business research it starts from. Pure and deterministic. */
export function planF3(f1: F1Context): { plan: StrategyPlan; pre: { kind: SourceRecord['kind']; label: string; text: string }[] } {
  const plan: StrategyPlan = { activated: [{ agent: STRATEGY_INFO.strategist.name, key: 'strategist', reason: 'Always runs: researches the audience, competitors, the five social platforms and timing, then writes the strategy' }], skipped: [] };
  return {
    plan,
    pre: [{ kind: 'f1_report', label: `Business research report ${f1.reportId}`, text: `f1_report_id: ${f1.reportId}\nproduct: ${f1.report.productManifest.name}\nconfidence: ${f1.report.productManifest.overallConfidence}\npartial: ${f1.partial}` }],
  };
}

/**
 * F3 Strategy with ONE Mozaik agent, the Marketing Strategist, and the deterministic Strategy Coordinator. The strategist gathers
 * competitor pages and the holiday calendar with tools, makes ONE research call (findings the coordinator commits through the
 * evidence policy) and ONE strategy call from those findings. Typically two model calls in total.
 */
export class F3Program implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: F3Settings;
  private readonly tools: F3Tools;
  private readonly store = new SourceStore();
  private readonly planned: ReturnType<typeof planF3>;
  private env!: F3Env;

  constructor(
    credentials: InferenceCredentials,
    private readonly config: StrategyRunConfig,
    private readonly sink: StrategySink,
  ) {
    const analystTokens = capOutputTokens(config.model, clamp(config.maxOutputTokens, 800, 16000, 3000)).tokens;
    const synthTokens = Math.min(8000, analystTokens * 3);
    const generation = resolveGeneration(config.generation, config.callTimeoutMs !== undefined);
    const budget: InferenceBudget = {
      spend: scopeFor(config.ledger, config.spendCapUsd, 'F3'),
      // a cut-off answer is asked again with a larger cap (up to what the model supports) instead of failing the agent
      escalateTo: capOutputTokens(config.model, 16000).tokens,
      maxModelCalls: clamp(config.maxModelCalls, 2, 12, 6),
      maxOutputTokens: synthTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      generation,
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    this.gateway = new InferenceGateway(createTextTransport(credentials, { baseUrl: config.baseUrl }).transport, budget);
    this.settings = {
      model: config.model,
      analystTokens,
      synthTokens,
      maxModelCalls: budget.maxModelCalls,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 240_000),
      synthTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      maxSearches: clamp(config.maxSearches, 0, 5, 3),
      maxCompetitorPages: clamp(config.maxCompetitorPages, 0, 6, 4),
      maxPagesPerCompetitor: clamp(config.maxPagesPerCompetitor, 1, 4, 3),
      fixtureSources: config.fixtureSources === true,
      now: config.now ?? new Date(),
    };
    // the strategy is the longest answer of the phase: its task deadline follows the clock of its request (and the one larger re-ask)
    if (generation) this.settings.synthTimeoutMs = Math.max(this.settings.synthTimeoutMs, synthesisTaskTimeoutMs(synthTokens, budget.escalateTo, generation));
    this.tools = {
      web: config.tools?.web ?? new WebFetchTool({ maxPages: this.settings.maxCompetitorPages * this.settings.maxPagesPerCompetitor + 2 }),
      search: config.tools?.search ?? createWebSearchFromEnv(),
      extract: config.tools?.extract ?? createWebExtractFromEnv(),
      holidays: config.tools?.holidays ?? new HolidayTool(),
    };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 1_800_000, 900_000);
    this.planned = planF3(config.f1);
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort();
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'market_strategy', label: 'F3 Strategy' }, ctx.orchestrator);
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    const who = 'Factory Orchestrator';
    const { plan } = this.planned;
    return [
      {
        specification: new OnEventTypes(['factory.started']),
        processor: guarded(ctx.guard(who), () => {
          ctx.state.currentPhase = PHASE;
          ctx.emit('phase.started', { phase: PHASE, agents: plan.activated.map((a) => a.agent), plan }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['strategy.completed']),
        processor: guarded(ctx.guard(who), async ({ event }) => {
          const { report, meta } = event.payload as { report: CampaignStrategyReport; meta: StrategyReportMeta };
          // Persist BEFORE completing: a run is only COMPLETED if its report is saved.
          await this.sink(report, meta);
          if (ctx.isClosed()) return;
          ctx.emit('phase.completed', { phase: PHASE }, ctx.orchestrator);
          ctx.emit('factory.completed', { mode: 'market_strategy', phasesCompleted: [PHASE] }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['phase.failed']),
        processor: guarded(ctx.guard(who), ({ event }) => {
          const { errors } = event.payload as { errors: AgentOutcome[] };
          const first = errors[0];
          ctx.emit('factory.failed', { reason: 'participant_error', message: first?.error?.message ?? 'The strategy failed', participant: first?.agent, code: first?.error?.code }, ctx.orchestrator);
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    const board: StrategyBoardStore = ctx.state.f3;
    const policyIssues: StrategyPolicyIssue[] = [];
    const env: F3Env = {
      ctx,
      gateway: this.gateway,
      store: this.store,
      board,
      f1: this.config.f1,
      input: this.config.input,
      settings: this.settings,
      tools: this.tools,
      facts: { competitors: null, holidays: null },
      policyIssues,
      policyContext: (): StrategyPolicyContext => ({ store: this.store, f1: this.config.f1, input: this.config.input, now: this.settings.now, issues: policyIssues }),
    };
    this.env = env;
    const { plan, pre } = this.planned;
    const preRecords = pre.map((p) => this.store.add({ kind: p.kind, label: p.label, url: null, status: 'retrieved', live: false, fixture: false, httpStatus: null, bytes: null, error: null, producer: 'Strategy Coordinator', origin: 'previous_phase' }, p.text));
    const coordinator = new StrategyCoordinator(env, plan, preRecords);
    return [coordinator.participant, this.buildStrategist(env).participant];
  }

  // ---- the Marketing Strategist (A2): research, then strategy --------------------------------------------------------------

  private buildStrategist(env: F3Env): PhaseAgent {
    const { ctx, settings } = env;
    const name = STRATEGY_INFO.strategist.name;
    return new PhaseAgent(env, { key: 'strategist', name, instruction: STRATEGY_INSTRUCTIONS.strategist, capabilities: ['market-strategy', 'research', 'synthesis', 'inference'] }, (self) => [
      {
        // TASK 1: deterministic gathering, then ONE research call; the coordinator commits the findings
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          const opened = self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
          if (!opened) return;
          const prep = await prepareResearch(env, self);
          if (!self.isTaskOpen() || ctx.isClosed()) return;
          if (prep.kind === 'fail') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'failed', error: prep.error }, self.participant);
          }
          self.runJob({
            kind: 'analysis',
            message: prep.message,
            schema: StrategyAgentOutput,
            schemaName: 'strategy_research',
            maxOutputTokens: settings.analystTokens,
            onSuccess: (out) => {
              self.closeTask();
              ctx.emit('finding.posted', { agent: name, summary: out.summary, findings: out.findings, missingInformation: out.missingInformation }, self.participant);
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
            },
            onFailure: (error) => {
              self.closeTask();
              ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
            },
          });
        }),
      },
      {
        // TASK 2: the strategy from the committed findings (read from the shared board)
        specification: new OnEventTypes(['phase.ready']),
        processor: guarded(ctx.guard(name), () => {
          const snap = env.board.snapshot();
          const partial = env.f1.partial;
          const digest: StrategyDigest = {
            ctx: { f1: env.f1, input: env.input, now: settings.now },
            statuses: snap.participantStatuses.map((s) => ({ agent: s.agent, state: s.state, reason: s.error?.message ?? s.reason })),
            sources: snap.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, origin: s.origin ?? 'unknown', live: s.live, fixture: s.fixture, error: s.error })),
            findings: snap.findings,
            summary: snap.summaries[name],
            missing: [...new Set(snap.missingInformation.map((m) => m.text))].slice(0, 20),
            partial,
            facts: env.facts,
          };
          self.openTask(settings.synthTimeoutMs, () => {
            ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant);
            ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: name, error: toSafeError('timeout') }] }, self.participant);
          });
          self.runJob({
            kind: 'synthesis',
            message: strategistMessage(digest),
            schema: StrategyDraft,
            schemaName: 'campaign_strategy',
            maxOutputTokens: settings.synthTokens,
            onSuccess: (draft) => {
              self.closeTask();
              const final = env.board.snapshot();
              const usage = env.gateway.usage();
              const { report, issues } = finalizeStrategy(draft, final, env.policyContext(), {
                f1: env.f1,
                input: env.input,
                facts: env.facts,
                now: settings.now,
                partial,
                fixtureSources: settings.fixtureSources,
                runId: ctx.runId,
                searchProvider: env.tools.search.provider,
                searchConfigured: env.tools.search.configured,
              });
              report.metrics = [
                { label: 'Model calls', value: String(usage.total.calls) },
                { label: 'Input tokens (measured)', value: String(usage.total.inputTokens) },
                { label: 'Output tokens (measured)', value: String(usage.total.outputTokens) },
                { label: 'Research findings', value: String(final.findings.length) },
              ];
              // BOUNDARY CHECK: the finished report must satisfy the schema its reader (F4) uses. A report that does not is still saved (the
              // analysis was paid for and is never thrown away) and the exact fields are recorded, so the problem is named before anything else is spent.
              const contract = conformanceIssues(CampaignStrategyReport, report);
              if (contract.length) issues.push({ type: 'report_contract', agent: name, detail: `The finished strategy does not match its own format: ${contract.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}${contract.length > 5 ? ` (and ${contract.length - 5} more)` : ''}.` });
              const meta: StrategyReportMeta = {
                schemaVersion: STRATEGY_REPORT_VERSION,
                model: settings.model,
                provider: env.gateway.provider,
                generatedAt: new Date().toISOString(),
                partial,
                usage,
                budget: { maxModelCalls: settings.maxModelCalls, maxScouts: 0, maxReviews: 0, analystTokens: settings.analystTokens, reviewTokens: 0, synthTokens: settings.synthTokens },
                f1: { reportId: env.f1.reportId, schemaVersion: env.f1.schemaVersion, generatedAt: env.f1.generatedAt, ageDays: ageDays(settings.now, env.f1.generatedAt), partial: env.f1.partial },
                f2: null,
                plan: final.plan ?? { activated: [], skipped: [] },
                scoutDecisions: [],
                participants: final.participantStatuses.map((s) => (s.agent === name ? { ...s, state: 'done' as const, error: null } : s)),
                sources: final.sources,
                findings: final.findings,
                crosschecks: [],
                summaries: final.summaries,
                policyIssues: [...env.policyIssues, ...issues],
                aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
                notAnalyzed: report.limitations.map((l) => ({ label: 'Limitation', reason: l })),
                tools: { search: { provider: env.tools.search.provider, configured: env.tools.search.configured, used: !!env.facts.competitors?.searchUsed }, extract: { provider: env.tools.extract.provider, configured: env.tools.extract.configured, calls: env.tools.extract.callCount }, holidays: { used: !!env.facts.holidays?.used, calls: env.tools.holidays.callCount }, fixtureSources: settings.fixtureSources },
                inputSnapshot: env.input,
              };
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
              ctx.emit('strategy.completed', { report, meta }, self.participant);
            },
            onFailure: (error) => {
              self.closeTask();
              ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
              ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: name, error }] }, self.participant);
            },
          });
        }),
      },
    ]);
  }
}
