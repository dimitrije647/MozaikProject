import { createAgent, type InferenceRunnerConfig, type Participant, type SemanticEvent, type SituationHandler } from '@mozaik-ai/core';
import type { z } from 'zod';
import { toSafeError, type SafeProviderError } from '../../ai/errors';
import { DEFAULT_BUDGET, InferenceGateway, readProviderErrorCode, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { OpenAIClient } from '../../ai/openai-http';
import { crossCheck, finalizeReport, type CrossCheckIssue, type Findings } from '../../discovery/crosscheck';
import type { DiscoveryInput } from '../../discovery/input';
import { INSTRUCTIONS, inputAnalyzerMessage, repairMessage, synthesizerMessage, textAnalyzerMessage } from '../../discovery/prompts';
import {
  InputAnalysis,
  ProductDiscoveryReport,
  REPORT_SCHEMA_VERSION,
  TextAnalysis,
  parseModelJson,
  toWireSchema,
} from '../../discovery/schemas';
import type { AgentOutcome, FindingKind } from '../../factory/events';
import type { InferenceCredentials } from '../providers';
import { clamp } from './smoke-program';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';

const PHASE = 'F1_PRODUCT_DISCOVERY' as const;

export const AGENT_NAMES = {
  input: 'Input Analyzer',
  text: 'Text Analyzer',
  checker: 'Evidence Cross-Checker',
  synthesizer: 'Product Synthesizer',
} as const;

export interface DiscoveryRunConfig {
  input: DiscoveryInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  /** Hard cap on provider calls for the run (retries and repair attempts count). Default 6. */
  maxModelCalls?: number;
  /** `max_output_tokens` per call. Default 3500. */
  maxOutputTokens?: number;
  /** Deadline per agent (including its retries). Default 150 s. */
  agentTimeoutMs?: number;
  /** Per-request timeout. Default 90 s. */
  callTimeoutMs?: number;
  /** Deadline for the whole run. Default 10 min. */
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Test seam: base URL of the OpenAI API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
}

/** Everything stored next to the report so the user knows what was analyzed and what it cost. */
export interface ReportMeta {
  schemaVersion: number;
  model: string;
  provider: 'openai';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  budget: { maxModelCalls: number; maxOutputTokens: number };
  agents: { name: string; status: 'succeeded' | 'failed'; error?: SafeProviderError }[];
  crosscheckIssues: CrossCheckIssue[];
  reportPolicyIssues: CrossCheckIssue[];
  findings: Findings;
  /** The exact input the agents saw. Contains the user's own text, never credentials. */
  inputSnapshot: DiscoveryInput;
}

export type ReportSink = (report: ProductDiscoveryReport, meta: ReportMeta) => Promise<void>;

const answerText = (event: SemanticEvent): string => {
  const answer = (event.payload as { answer?: { content?: { text?: unknown } } } | null)?.answer;
  const text = answer?.content?.text;
  return typeof text === 'string' ? text : '';
};

interface Harness {
  ctx: RunContext;
  gateway: InferenceGateway;
  model: string;
  maxOutputTokens: number;
  agentTimeoutMs: number;
}

interface LlmAgentSpec<T> {
  name: string;
  instruction: string;
  schemaName: string;
  schema: z.ZodType<T>;
  triggerTypes: string[];
  /** Returns the first message for this agent, or null when the event is not addressed to it. */
  trigger(event: SemanticEvent): string | null;
  onSuccess(value: T, agent: Participant): void;
  onFailure(error: SafeProviderError, agent: Participant): void;
}

/**
 * A real Mozaik Agent that does its work through Mozaik's `runLoop`.
 *
 * Loop safety: it acts once (`status`), reacts to `model.answer` only when it is its OWN answer,
 * allows exactly one repair attempt for malformed JSON, and has a deadline. It never subscribes to
 * the events it emits, so it cannot trigger itself.
 */
function createLlmAgent<T>(h: Harness, spec: LlmAgentSpec<T>): Participant {
  let status: 'idle' | 'working' | 'finished' = 'idle';
  let repairs = 0;
  let deadline: NodeJS.Timeout | undefined;
  const wire = toWireSchema(spec.schema);

  const finish = (fn: () => void) => {
    if (status === 'finished') return;
    status = 'finished';
    if (deadline) h.ctx.clearTimer(deadline);
    fn();
  };
  const startLoop = (message: string) =>
    h.ctx.runLoop(agent.getId(), message, {
      model: h.model,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: { name: spec.schemaName, schema: wire, strict: true },
      maxOutputTokens: h.maxOutputTokens,
    });

  const agent = createAgent({
    name: spec.name,
    capabilities: ['product-discovery', 'inference'],
    instruction: spec.instruction,
    tools: [],
    handlers: [
      {
        specification: new OnEventTypes(spec.triggerTypes),
        processor: guarded(h.ctx.guard(spec.name), ({ event }) => {
          if (status !== 'idle') return;
          const message = spec.trigger(event);
          if (message === null) return;
          status = 'working';
          deadline = h.ctx.setTimer(h.agentTimeoutMs, () =>
            finish(() => {
              h.gateway.abortAgent(agent.getMemory().getContext().id, 'timeout');
              spec.onFailure(toSafeError('timeout'), agent);
            }),
          );
          startLoop(message);
        }),
      },
      {
        specification: new OnEventTypes(['model.answer']),
        processor: guarded(h.ctx.guard(spec.name), ({ event }) => {
          if (event.producerId !== agent.getId() || status !== 'working') return;
          const text = answerText(event);
          const code = readProviderErrorCode(text);
          if (code) return finish(() => spec.onFailure(toSafeError(code), agent));
          const parsed = parseModelJson(text, spec.schema);
          if (parsed.ok) return finish(() => spec.onSuccess(parsed.value, agent));
          if (repairs < 1) {
            repairs++;
            return startLoop(repairMessage(parsed.issues));
          }
          finish(() => spec.onFailure(toSafeError('invalid_response'), agent));
        }),
      },
    ],
  });
  h.gateway.registerAgent(agent.getMemory().getContext().id, spec.name);
  return agent;
}

/**
 * Product Discovery (phase F1), text only.
 *
 *   factory.started -> phase.started -> task.assigned (x2)
 *     Input Analyzer ┐ run concurrently, each as a Mozaik agent loop
 *     Text Analyzer  ┘   -> finding.posted + task.completed
 *   Evidence Cross-Checker (deterministic fan-in barrier) -> phase.ready -> crosscheck.answered
 *   Product Synthesizer (consumes both findings from the event) -> report.generated
 *   Orchestrator persists the report, then phase.completed -> factory.completed
 */
export class DiscoveryProgram implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: { model: string; maxOutputTokens: number; agentTimeoutMs: number; maxModelCalls: number };
  private readonly input: DiscoveryInput;

  constructor(
    credentials: InferenceCredentials,
    config: DiscoveryRunConfig,
    private readonly sink: ReportSink,
  ) {
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 1, 20, DEFAULT_BUDGET.maxModelCalls),
      maxOutputTokens: clamp(config.maxOutputTokens, 100, 32_000, DEFAULT_BUDGET.maxOutputTokens),
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    // The key is handed to the client (private field) and not kept anywhere else.
    this.gateway = new InferenceGateway(new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl }), budget);
    this.input = config.input;
    this.settings = {
      model: config.model,
      maxOutputTokens: budget.maxOutputTokens,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      maxModelCalls: budget.maxModelCalls,
    };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 1_800_000, 600_000);
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort(); // aborts in-flight requests and blocks any further call
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'product_discovery', label: 'Product Discovery' }, ctx.orchestrator);
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    const who = 'Factory Orchestrator';
    const analyzers: { agent: string; task: FindingKind }[] = [
      { agent: AGENT_NAMES.input, task: 'input_analysis' },
      { agent: AGENT_NAMES.text, task: 'text_analysis' },
    ];
    return [
      {
        specification: new OnEventTypes(['factory.started']),
        processor: guarded(ctx.guard(who), () => {
          ctx.state.currentPhase = PHASE;
          ctx.emit('phase.started', { phase: PHASE, agents: analyzers.map((a) => a.agent) }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['phase.started']),
        processor: guarded(ctx.guard(who), () => {
          for (const a of analyzers) ctx.emit('task.assigned', a, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['report.generated']),
        processor: guarded(ctx.guard(who), async ({ event }) => {
          const { report, meta } = event.payload as { report: ProductDiscoveryReport; meta: ReportMeta };
          // Persist BEFORE completing: a run is only COMPLETED if its report is saved.
          await this.sink(report, meta);
          if (ctx.isClosed()) return;
          ctx.emit('phase.completed', { phase: PHASE }, ctx.orchestrator);
          ctx.emit('factory.completed', { mode: 'product_discovery', phasesCompleted: [PHASE] }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['phase.failed']),
        processor: guarded(ctx.guard(who), ({ event }) => {
          const { errors } = event.payload as { errors: AgentOutcome[] };
          const first = errors[0];
          ctx.emit(
            'factory.failed',
            {
              reason: 'participant_error',
              message: first?.error?.message ?? 'Product Discovery failed',
              participant: first?.agent,
              code: first?.error?.code,
            },
            ctx.orchestrator,
          );
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    const h: Harness = { ctx, gateway: this.gateway, model: this.settings.model, maxOutputTokens: this.settings.maxOutputTokens, agentTimeoutMs: this.settings.agentTimeoutMs };
    const input = this.input;

    const analyzer = <T>(name: string, kind: FindingKind, instruction: string, schema: z.ZodType<T>, schemaName: string, message: string): Participant =>
      createLlmAgent<T>(h, {
        name,
        instruction,
        schema,
        schemaName,
        triggerTypes: ['task.assigned'],
        trigger: (event) => ((event.payload as { agent?: string }).agent === name ? message : null),
        onSuccess: (finding, agent) => {
          ctx.state.findings.push({ id: `${kind}-${ctx.state.findings.length + 1}`, phase: PHASE, author: name, summary: kind, at: new Date().toISOString() });
          ctx.emit('finding.posted', { agent: name, kind, finding }, agent);
          ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, agent);
        },
        onFailure: (error, agent) => ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, agent),
      });

    const inputAnalyzer = analyzer(AGENT_NAMES.input, 'input_analysis', INSTRUCTIONS.inputAnalyzer, InputAnalysis, 'input_analysis', inputAnalyzerMessage(input));
    const textAnalyzer = analyzer(AGENT_NAMES.text, 'text_analysis', INSTRUCTIONS.textAnalyzer, TextAnalysis, 'text_analysis', textAnalyzerMessage(input));
    const checker = this.createCrossChecker(ctx);

    let handoff: { findings: Findings; issues: CrossCheckIssue[]; partial: boolean; failed: AgentOutcome[]; succeeded: string[] } | null = null;
    const synthesizer = createLlmAgent<ProductDiscoveryReport>(h, {
      name: AGENT_NAMES.synthesizer,
      instruction: INSTRUCTIONS.synthesizer,
      schema: ProductDiscoveryReport,
      schemaName: 'product_discovery_report',
      triggerTypes: ['crosscheck.answered'],
      trigger: (event) => {
        handoff = event.payload as NonNullable<typeof handoff>;
        return synthesizerMessage(input, handoff.findings, handoff.issues, handoff.partial, handoff.failed.map((f) => f.agent));
      },
      onSuccess: (draft, agent) => {
        const { report, issues } = finalizeReport(draft, input, handoff!.issues, handoff!.partial);
        const agents = [
          ...handoff!.succeeded.map((name) => ({ name, status: 'succeeded' as const })),
          ...handoff!.failed.map((f) => ({ name: f.agent, status: 'failed' as const, error: f.error })),
          { name: AGENT_NAMES.synthesizer, status: 'succeeded' as const },
        ];
        const meta: ReportMeta = {
          schemaVersion: REPORT_SCHEMA_VERSION,
          model: this.settings.model,
          provider: 'openai',
          generatedAt: new Date().toISOString(),
          partial: handoff!.partial,
          usage: this.gateway.usage(),
          budget: { maxModelCalls: this.settings.maxModelCalls, maxOutputTokens: this.settings.maxOutputTokens },
          agents,
          crosscheckIssues: handoff!.issues,
          reportPolicyIssues: issues,
          findings: handoff!.findings,
          inputSnapshot: input,
        };
        ctx.state.boards.intake = { ...ctx.state.boards.intake, report };
        ctx.emit('task.completed', { agent: AGENT_NAMES.synthesizer, outcome: 'succeeded' }, agent);
        ctx.emit('report.generated', { report, meta }, agent);
      },
      onFailure: (error, agent) => {
        ctx.emit('task.completed', { agent: AGENT_NAMES.synthesizer, outcome: 'failed', error }, agent);
        ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: AGENT_NAMES.synthesizer, error }] }, agent);
      },
    });

    return [inputAnalyzer, textAnalyzer, checker, synthesizer];
  }

  /**
   * Deterministic Mozaik participant (no model call) that is the bounded fan-in barrier: it waits
   * for BOTH analyzers to report success or failure, with a safety deadline instead of arbitrary
   * sleeps, then reconciles their findings under the evidence policy.
   */
  private createCrossChecker(ctx: RunContext): Participant {
    const expected: string[] = [AGENT_NAMES.input, AGENT_NAMES.text];
    const findings: Findings = { input_analysis: null, text_analysis: null };
    const reported = new Map<string, AgentOutcome & { ok: boolean }>();
    let concluded = false;
    let safety: NodeJS.Timeout | undefined;
    const who = AGENT_NAMES.checker;
    const input = this.input;

    const conclude = () => {
      if (concluded) return;
      concluded = true;
      if (safety) ctx.clearTimer(safety);
      for (const name of expected) {
        if (!reported.has(name)) reported.set(name, { agent: name, ok: false, error: toSafeError('timeout') });
      }
      const succeeded = expected.filter((n) => reported.get(n)!.ok);
      const failed: AgentOutcome[] = expected.filter((n) => !reported.get(n)!.ok).map((n) => ({ agent: n, error: reported.get(n)!.error }));
      if (succeeded.length === 0) {
        ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analyzers_failed', errors: failed }, checker);
        return;
      }
      ctx.emit('phase.ready', { phase: PHASE, succeeded, failed }, checker);
      const result = crossCheck(input, findings);
      ctx.state.boards.intake = { ...result.findings, crosscheckIssues: result.issues };
      ctx.emit('crosscheck.answered', { phase: PHASE, succeeded, failed, partial: failed.length > 0, issues: result.issues, findings: result.findings }, checker);
    };
    const armSafety = () => {
      safety ??= ctx.setTimer(this.settings.agentTimeoutMs + 5_000, () => {
        try {
          conclude();
        } catch (err) {
          ctx.fail(err, who);
        }
      });
    };

    const checker: Participant = createAgent({
      name: who,
      capabilities: ['cross-check'],
      instruction: 'Deterministic evidence cross-checker. Performs no inference.',
      tools: [],
      handlers: [
        { specification: new OnEventTypes(['phase.started']), processor: guarded(ctx.guard(who), armSafety) },
        {
          specification: new OnEventTypes(['finding.posted']),
          processor: guarded(ctx.guard(who), ({ event }) => {
            const p = event.payload as { kind: FindingKind; finding: never };
            findings[p.kind] = p.finding as never;
          }),
        },
        {
          specification: new OnEventTypes(['task.completed']),
          processor: guarded(ctx.guard(who), ({ event }) => {
            const p = event.payload as { agent: string; outcome: 'succeeded' | 'failed'; error?: SafeProviderError };
            if (!expected.includes(p.agent) || reported.has(p.agent)) return; // the synthesizer's completion is not ours
            armSafety();
            reported.set(p.agent, { agent: p.agent, ok: p.outcome === 'succeeded', error: p.error });
            if (reported.size >= expected.length) conclude();
          }),
        },
      ],
    });
    return checker;
  }
}
