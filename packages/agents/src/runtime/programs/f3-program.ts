import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../ai/errors';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { OpenAIClient } from '../../ai/openai-http';
import type { F1Context } from '../../audit/context';
import { SourceStore, type CrosscheckRecord, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import { reviewMessage } from '../../discovery/f1/prompts';
import { CrosscheckAnswer } from '../../discovery/f1/schemas';
import type { AgentOutcome } from '../../factory/events';
import { BASE_KEYS, STRATEGY_INFO, type BaseKey, type ScoutDecision, type StrategyBoardStore, type StrategyFinding, type StrategyPlan } from '../../strategy/board';
import { CHANNELS, channelById, scoutName, type ChannelId } from '../../strategy/channels';
import { ageDays, type F2Context, type StrategyFacts, type StrategyInput } from '../../strategy/context';
import { finalizeStrategy, type StrategyPolicyContext, type StrategyPolicyIssue } from '../../strategy/policy';
import { STRATEGY_INSTRUCTIONS, scoutInstruction, strategistMessage, type StrategyDigest } from '../../strategy/prompts';
import { STRATEGY_REPORT_VERSION, CampaignStrategyReport, StrategyAgentOutput, StrategyDraft } from '../../strategy/schemas';
import { HolidayTool } from '../../tools/holidays';
import { createWebExtractFromEnv } from '../../tools/web-extract';
import { WebFetchTool } from '../../tools/web-fetch';
import { createWebSearchFromEnv } from '../../tools/web-search';
import { ParticipantRegistry } from '../participant-registry';
import type { InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { PhaseAgent } from './f1/agent';
import { StrategyCoordinator } from './f3/coordinator';
import type { F3Env, F3Settings, F3Tools } from './f3/env';
import { prepareAudience, prepareCompetitor, prepareScout, prepareSeasonal, type F3Prep } from './f3/roles';
import { clamp } from './smoke-program';

const PHASE = 'F3_MARKET_STRATEGY' as const;

export interface StrategyRunConfig {
  /** The completed F1 report (built by the backend from the stored report). */
  f1: F1Context;
  /** The completed F2 audit this strategy builds on (must reference that exact F1 report). */
  f2: F2Context;
  input: StrategyInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  /** Hard cap on provider calls for the whole run (researchers, scouts, reviews, repairs, strategist). Default 24. */
  maxModelCalls?: number;
  /** `max_output_tokens` for researchers and scouts. Reviews use less, the strategist up to three times as much. Default 2500. */
  maxOutputTokens?: number;
  /** Maximum cross-check requests (each costs one model call). Default 6. */
  maxReviews?: number;
  /** Maximum dynamically created Channel Scouts. Default 4. */
  maxScouts?: number;
  /** Category search queries per run (named competitors add one lookup each). Default 3. */
  maxSearches?: number;
  /** Competitor SITES read per run. Default 4. */
  maxCompetitorPages?: number;
  /** Pages read per competitor site: the home page plus relevant same-site pages (pricing, about, services). Default 3. */
  maxPagesPerCompetitor?: number;
  agentTimeoutMs?: number;
  reviewTimeoutMs?: number;
  callTimeoutMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Test seam: base URL of the OpenAI API (the backend only passes a value under NODE_ENV=test). */
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
  provider: 'openai';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  budget: { maxModelCalls: number; maxScouts: number; maxReviews: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  /** The exact earlier-phase results this strategy used. */
  f1: { reportId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean };
  f2: { auditId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean };
  plan: StrategyPlan;
  scoutDecisions: ScoutDecision[];
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  findings: StrategyFinding[];
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

/** Which base participants run. Channel Scouts are NOT planned here: they are created dynamically after the research. */
export function planF3(f1: F1Context, f2: F2Context): { plan: StrategyPlan; pre: { kind: SourceRecord['kind']; label: string; text: string }[] } {
  const plan: StrategyPlan = { activated: [], skipped: [] };
  const on = (key: BaseKey, reason: string) => plan.activated.push({ agent: STRATEGY_INFO[key].name, key, reason });
  on('audience', 'Always runs: customer segments and their needs');
  on('competitor', 'Always runs: researches competitors from retrieved sources (reports insufficient research when there are none)');
  on('seasonal', 'Always runs: seasonal and time-sensitive opportunities');
  on('strategist', 'Always runs after the cross-checks');
  return {
    plan,
    pre: [
      { kind: 'f1_report', label: `F1 Product Discovery report ${f1.reportId}`, text: `f1_report_id: ${f1.reportId}\nproduct: ${f1.report.productManifest.name}\nconfidence: ${f1.report.productManifest.overallConfidence}\npartial: ${f1.partial}` },
      { kind: 'f2_audit', label: `F2 Marketing Audit ${f2.auditId}`, text: `f2_audit_id: ${f2.auditId}\nbuilt_on_f1_report: ${f2.f1ReportId}\npartial: ${f2.partial}\nmain_problems: ${f2.report.mainProblems.map((p) => p.title).join(' | ')}` },
    ],
  };
}

/**
 * F3 Market Research & Strategy: Audience Researcher, Competitor Researcher and Seasonal Intelligence run first; then the
 * Strategy Coordinator DYNAMICALLY creates and joins the Channel Scouts the project needs; then bounded cross-checks; then
 * the Campaign Strategist. Same runtime, event protocol and evidence rules as F1 and F2.
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
    const analystTokens = clamp(config.maxOutputTokens, 800, 6000, 2500);
    const synthTokens = Math.min(8000, analystTokens * 3);
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 1, 60, 24),
      maxOutputTokens: synthTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    this.gateway = new InferenceGateway(new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl }), budget);
    this.settings = {
      model: config.model,
      analystTokens,
      reviewTokens: Math.min(1500, analystTokens),
      synthTokens,
      maxModelCalls: budget.maxModelCalls,
      maxReviews: clamp(config.maxReviews, 0, 10, 6),
      maxScouts: clamp(config.maxScouts, 0, 6, 4),
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 90_000),
      maxSearches: clamp(config.maxSearches, 0, 5, 3),
      maxCompetitorPages: clamp(config.maxCompetitorPages, 0, 6, 4),
      maxPagesPerCompetitor: clamp(config.maxPagesPerCompetitor, 1, 4, 3),
      fixtureSources: config.fixtureSources === true,
      now: config.now ?? new Date(),
    };
    this.tools = {
      web: config.tools?.web ?? new WebFetchTool({ maxPages: this.settings.maxCompetitorPages * this.settings.maxPagesPerCompetitor + 2 }),
      search: config.tools?.search ?? createWebSearchFromEnv(),
      extract: config.tools?.extract ?? createWebExtractFromEnv(),
      holidays: config.tools?.holidays ?? new HolidayTool(),
    };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 1_800_000, 900_000);
    this.planned = planF3(config.f1, config.f2);
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort();
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'market_strategy', label: 'F3 Market Research & Strategy' }, ctx.orchestrator);
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    const who = 'Factory Orchestrator';
    const { plan } = this.planned;
    return [
      {
        specification: new OnEventTypes(['factory.started']),
        processor: guarded(ctx.guard(who), () => {
          ctx.state.currentPhase = PHASE;
          ctx.emit('phase.started', { phase: PHASE, agents: plan.activated.map((a) => a.agent), plan: { ...plan, scoutsPending: true, maxScouts: this.settings.maxScouts } }, ctx.orchestrator);
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
          ctx.emit('factory.failed', { reason: 'participant_error', message: first?.error?.message ?? 'Market strategy failed', participant: first?.agent, code: first?.error?.code }, ctx.orchestrator);
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
      f2: this.config.f2,
      input: this.config.input,
      settings: this.settings,
      tools: this.tools,
      facts: { competitors: null, holidays: null },
      policyIssues,
      agents: new Map(),
      createScout: (d) => {
        const agent = this.buildScout(env, d.channel);
        env.agents.set(`scout:${d.channel}`, agent);
        return agent;
      },
      policyContext: (): StrategyPolicyContext => ({ store: this.store, f1: this.config.f1, f2: this.config.f2, input: this.config.input, now: this.settings.now, issues: policyIssues }),
    };
    this.env = env;
    const { plan, pre } = this.planned;

    const preRecords = pre.map((p) => this.store.add({ kind: p.kind, label: p.label, url: null, status: 'retrieved', live: false, fixture: false, httpStatus: null, bytes: null, error: null, producer: 'Strategy Coordinator', origin: 'previous_phase' }, p.text));

    const registry = new ParticipantRegistry();
    for (const key of BASE_KEYS) {
      registry.register({
        phase: PHASE,
        name: STRATEGY_INFO[key].name,
        create: () => {
          const agent = key === 'strategist' ? this.buildStrategist(env) : this.buildResearcher(env, key);
          env.agents.set(key, agent);
          return agent.participant;
        },
      });
    }
    const activated = new Set(plan.activated.map((a) => a.agent));
    const joined = registry.forPhase(PHASE).filter((r) => activated.has(r.name)).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));
    const coordinator = new StrategyCoordinator(env, plan, preRecords);
    return [coordinator.participant, ...joined];
  }

  // ---- shared job wiring ---------------------------------------------------------------------------

  private agent(env: F3Env, key: string, name: string, instruction: string, capabilities: string[], handlers: ConstructorParameters<typeof PhaseAgent>[2]) {
    return new PhaseAgent(env, { key, name, instruction, capabilities }, handlers);
  }

  /** The analysis + cross-check handlers every researcher and scout shares. */
  private workerHandlers(env: F3Env, self: PhaseAgent, name: string, key: string, prepare: () => Promise<F3Prep>): SituationHandler[] {
    const { ctx, settings } = env;
    return [
      {
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          const opened = self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
          if (!opened) return;

          const prep = await prepare();
          if (!self.isTaskOpen() || ctx.isClosed()) return;
          if (prep.kind === 'skip') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'skipped', reason: prep.reason }, self.participant);
          }
          if (prep.kind === 'fail') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'failed', error: prep.error }, self.participant);
          }
          if (prep.kind === 'direct') {
            // Nothing to analyze with a model: the deterministic result is posted as this participant's findings.
            self.closeTask();
            ctx.emit('finding.posted', { agent: name, summary: prep.output.summary, findings: prep.output.findings, missingInformation: prep.output.missingInformation }, self.participant);
            return ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
          }
          self.runJob({
            kind: 'analysis',
            message: prep.message,
            schema: StrategyAgentOutput,
            schemaName: `${key.replace(/[^a-z0-9_]/gi, '_')}_findings`,
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
        // Cross-check: this participant reviews ANOTHER participant's claims using what it examined itself.
        specification: new OnEventTypes(['crosscheck.requested']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { requestId: string; producer: string; reviewer: string; claims: never[] };
          if (p.reviewer !== name) return;
          self.runJob({
            kind: 'review',
            message: reviewMessage(p.requestId, p.producer, p.claims, env.input.language) + STRATEGY_INSTRUCTIONS.reviewerNote,
            schema: CrosscheckAnswer,
            schemaName: 'crosscheck_answer',
            maxOutputTokens: settings.reviewTokens,
            timeoutMs: settings.reviewTimeoutMs,
            onSuccess: (out) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'answered', answers: out.answers }, self.participant),
            onFailure: (error) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'failed', answers: [], error }, self.participant),
          });
        }),
      },
    ];
  }

  private buildResearcher(env: F3Env, key: Exclude<BaseKey, 'strategist'>): PhaseAgent {
    const name = STRATEGY_INFO[key].name;
    const prepare = (self: PhaseAgent) => (key === 'audience' ? prepareAudience(env) : key === 'competitor' ? prepareCompetitor(env, self) : prepareSeasonal(env, self));
    return this.agent(env, key, name, STRATEGY_INSTRUCTIONS[key], ['market-strategy', 'research', 'inference'], (self) => this.workerHandlers(env, self, name, key, () => prepare(self)));
  }

  /** A Channel Scout: created on demand for ONE channel, with its own memory and its own id. */
  private buildScout(env: F3Env, channel: ChannelId): PhaseAgent {
    const name = scoutName(channel);
    return this.agent(env, `scout:${channel}`, name, scoutInstruction(channel), ['market-strategy', 'channel-scout', `channel:${channel}`, 'inference'], (self) => this.workerHandlers(env, self, name, `scout_${channel}`, () => prepareScout(env, self, channel)));
  }

  // ---- strategist (A18) --------------------------------------------------------------------------------

  private buildStrategist(env: F3Env): PhaseAgent {
    const { ctx, settings } = env;
    const name = STRATEGY_INFO.strategist.name;
    return this.agent(env, 'strategist', name, STRATEGY_INSTRUCTIONS.strategist, ['market-strategy', 'synthesis', 'inference'], (self) => [
      {
        specification: new OnEventTypes(['phase.ready']),
        processor: guarded(ctx.guard(name), () => {
          const snap = env.board.snapshot();
          const failed = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
          const partial = failed.length > 0;
          const digest: StrategyDigest = {
            ctx: { f1: env.f1, f2: env.f2, input: env.input, now: settings.now },
            plan: { activated: snap.plan?.activated ?? [], skipped: snap.plan?.skipped ?? [] },
            scoutDecisions: snap.scoutDecisions,
            statuses: snap.participantStatuses.map((s) => ({ agent: s.agent, state: s.state, reason: s.error?.message ?? s.reason })),
            sources: snap.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, origin: s.origin ?? 'unknown', live: s.live, fixture: s.fixture, error: s.error })),
            findings: snap.findings,
            summaries: snap.summaries,
            crosschecks: snap.crosschecks.map((c) => ({ claimId: c.claimId, producer: c.producer, reviewer: c.reviewer, verdict: c.verdict, rationale: c.rationale, correction: c.correction, status: c.status })),
            missing: [...new Set(snap.missingInformation.map((m) => m.text))].slice(0, 20),
            partial,
            facts: env.facts,
          };
          self.openTask(settings.agentTimeoutMs, () => {
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
                f2: env.f2,
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
                { label: 'Channel Scouts created', value: String(final.scoutDecisions.filter((d) => d.selected).length) },
                { label: 'Cross-check requests', value: String(new Set(final.crosschecks.map((c) => c.requestId)).size) },
              ];
              const meta: StrategyReportMeta = {
                schemaVersion: STRATEGY_REPORT_VERSION,
                model: settings.model,
                provider: 'openai',
                generatedAt: new Date().toISOString(),
                partial,
                usage,
                budget: { maxModelCalls: settings.maxModelCalls, maxScouts: settings.maxScouts, maxReviews: settings.maxReviews, analystTokens: settings.analystTokens, reviewTokens: settings.reviewTokens, synthTokens: settings.synthTokens },
                f1: { reportId: env.f1.reportId, schemaVersion: env.f1.schemaVersion, generatedAt: env.f1.generatedAt, ageDays: ageDays(settings.now, env.f1.generatedAt), partial: env.f1.partial },
                f2: { auditId: env.f2.auditId, schemaVersion: env.f2.schemaVersion, generatedAt: env.f2.generatedAt, ageDays: ageDays(settings.now, env.f2.generatedAt), partial: env.f2.partial },
                plan: final.plan ?? { activated: [], skipped: [] },
                scoutDecisions: final.scoutDecisions,
                participants: final.participantStatuses.map((s) => (s.agent === name ? { ...s, state: 'done' as const, error: null } : s)),
                sources: final.sources,
                findings: final.findings,
                crosschecks: final.crosschecks,
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

export { CampaignStrategyReport, CHANNELS, channelById };
export type { StrategyFacts };
