import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../ai/errors';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { OpenAIClient } from '../../ai/openai-http';
import {
  AGENT_INFO,
  ANALYST_KEYS,
  F1BoardStore,
  SourceStore,
  type AgentKey,
  type AnalystKey,
  type CrosscheckRecord,
  type F1Plan,
  type Finding,
  type ParticipantStatus,
  type SourceRecord,
} from '../../discovery/f1/board';
import { analyzedSections, type AnalyzedSections, type PolicyIssue, finalizeReportV2 } from '../../discovery/f1/policy';
import { reviewMessage, synthesizerMessage, type SynthDigest } from '../../discovery/f1/prompts';
import { AgentOutput, CrosscheckAnswer, ProductDiscoveryReportV2 } from '../../discovery/f1/schemas';
import { inputCorpus, type DiscoveryInput } from '../../discovery/input';
import { REPORT_V2_VERSION } from '../../discovery/f1/schemas';
import type { AgentOutcome } from '../../factory/events';
import { DocumentExtractionTool, detectFormat, type DocumentInput } from '../../tools/documents';
import { GitHubRepositoryTool, parseGitHubUrl } from '../../tools/github';
import { ImagePreparationTool, type ImageInput } from '../../tools/images';
import { WebFetchTool } from '../../tools/web-fetch';
import { createWebSearchFromEnv, type WebSearchTool } from '../../tools/web-search';
import { ParticipantRegistry } from '../participant-registry';
import type { InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { clamp } from './smoke-program';
import { F1Agent } from './f1/agent';
import { PhaseCoordinator } from './f1/coordinator';
import type { F1Env, F1Settings, F1Tools } from './f1/env';
import { prepareFiles, prepareInput, prepareRepo, prepareText, prepareVisual, prepareWeb, type Prep } from './f1/roles';

const PHASE = 'F1_PRODUCT_DISCOVERY' as const;

export interface DiscoveryRunConfig {
  input: DiscoveryInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  /** Uploaded documents / images (already authorized by the caller; bytes are loaded lazily). */
  documents?: DocumentInput[];
  images?: ImageInput[];
  /** Hard cap on provider calls for the whole run (retries, reviews and repairs count). Default 16. */
  maxModelCalls?: number;
  /** `max_output_tokens` for analysts. Reviews use less, the synthesizer up to twice as much. Default 3000. */
  maxOutputTokens?: number;
  /** Maximum number of cross-check requests (each costs one model call). Default 4. */
  maxReviews?: number;
  /** Deadline per analyst, including tool retrieval and the model call. Default 150 s. */
  agentTimeoutMs?: number;
  /** Deadline per cross-check review. Default 90 s. */
  reviewTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Deadline for the whole run. Default 10 min. */
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Website pages fetched per run (homepage + relevant pages). Default 4. */
  maxWebPages?: number;
  /** Test seam: base URL of the OpenAI API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  /** External tools. Defaults: strict SSRF-safe fetch, search from env (Tavily/Brave), GitHub (GITHUB_TOKEN optional). */
  tools?: Partial<F1Tools>;
  /** TESTS ONLY: marks every source from external tools as a fixture (never real-world evidence). */
  fixtureSources?: boolean;
}

export interface ReportMeta {
  schemaVersion: number;
  model: string;
  provider: 'openai';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  budget: { maxModelCalls: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  plan: F1Plan;
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  findings: Finding[];
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  policyIssues: PolicyIssue[];
  analyzed: AnalyzedSections;
  /** What was available or requested but not analyzed, and why. */
  notAnalyzed: { label: string; reason: string }[];
  /** Which participants actually made AI calls (the rest are deterministic tools or the coordinator). */
  aiCalls: Record<string, number>;
  tools: { search: string; searchConfigured: boolean; fixtureSources: boolean };
  inputSnapshot: DiscoveryInput;
}

export type ReportSink = (report: ProductDiscoveryReportV2, meta: ReportMeta) => Promise<void>;

// ---- activation plan --------------------------------------------------------------------------------

type PreSource = Pick<SourceRecord, 'kind' | 'label' | 'status'> & { url?: string | null; error?: string | null; text?: string };

/** Which agents run, which are skipped and why. Pure and deterministic. */
export function planF1(input: DiscoveryInput, files: { documents: DocumentInput[]; images: ImageInput[]; checkUrl: (u: string) => { ok: true } | { ok: false; message: string } }): { plan: F1Plan; pre: PreSource[] } {
  const plan: F1Plan = { activated: [], skipped: [] };
  const pre: PreSource[] = [{ kind: 'user_input', label: 'Project intake and notes', status: 'retrieved', text: inputCorpus(input) }];
  const on = (key: AgentKey, reason: string) => plan.activated.push({ agent: AGENT_INFO[key].name, key, reason });
  const off = (key: AgentKey, reason: string) => plan.skipped.push({ agent: AGENT_INFO[key].name, key, reason });

  on('input', 'Always runs: reads the project intake');
  on('text', 'Always runs: independent reading of the supplied text');

  const site = input.availableSources.websiteUrl;
  if (!site) off('web', 'No website URL was provided');
  else {
    const c = files.checkUrl(site);
    if (c.ok) on('web', `Website provided: ${site}`);
    else {
      off('web', `The website URL was rejected: ${c.message}`);
      pre.push({ kind: 'website', label: site, url: site, status: 'failed', error: c.message });
    }
  }

  const repo = input.availableSources.githubUrl;
  if (!repo) off('repo', 'No repository URL was provided');
  else {
    const parsed = parseGitHubUrl(repo);
    if (parsed) on('repo', `Public GitHub repository provided: ${parsed.owner}/${parsed.repo}`);
    else {
      off('repo', 'The repository URL is not a valid github.com/<owner>/<repo> URL');
      pre.push({ kind: 'repository', label: repo, url: repo, status: 'failed', error: 'Not a valid github.com/<owner>/<repo> URL.' });
    }
  }

  const docs = files.documents.filter((d) => detectFormat(d.name));
  const known = new Set([...files.documents, ...files.images].map((f) => f.name));
  const unsupported = input.availableSources.uploads.filter((u) => !known.has(u.name) || (!files.images.some((i) => i.name === u.name) && !detectFormat(u.name)));
  for (const u of unsupported) pre.push({ kind: 'document', label: u.name, status: 'unsupported', error: 'Unsupported file type. Supported documents: PDF, DOCX, TXT, Markdown, JSON, CSV; images: PNG, JPEG, WebP, GIF.' });
  if (docs.length) on('files', `${docs.length} supported document(s) uploaded`);
  else off('files', unsupported.length ? 'The uploaded files are not supported document types' : 'No documents were uploaded');

  if (files.images.length) on('visual', `${files.images.length} image(s) uploaded`);
  else off('visual', 'No images were uploaded');

  on('synthesizer', 'Always runs after the cross-checks');
  return { plan, pre };
}

// ---- the program -------------------------------------------------------------------------------------

const PREPARE: Record<AnalystKey, (env: F1Env, agent: F1Agent) => Promise<Prep>> = {
  input: prepareInput,
  text: prepareText,
  web: prepareWeb,
  repo: prepareRepo,
  files: prepareFiles,
  visual: prepareVisual,
};

/**
 * F1 Product Discovery with up to seven REAL Mozaik agents, a deterministic Phase Coordinator and
 * the Factory Orchestrator. See README "F1 Product Discovery" for the event flow.
 */
export class F1Program implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: F1Settings;
  private readonly tools: F1Tools;
  private readonly input: DiscoveryInput;
  private readonly documents: DocumentInput[];
  private readonly images: ImageInput[];
  private readonly store = new SourceStore();
  private readonly planned: { plan: F1Plan; pre: PreSource[] };
  private env!: F1Env;

  constructor(
    credentials: InferenceCredentials,
    config: DiscoveryRunConfig,
    private readonly sink: ReportSink,
  ) {
    const analystTokens = clamp(config.maxOutputTokens, 800, 8000, 3000);
    const synthTokens = Math.min(8000, analystTokens * 2);
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 1, 40, 16),
      maxOutputTokens: synthTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    // The key is handed to the client (private field) and not kept anywhere else.
    this.gateway = new InferenceGateway(new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl }), budget);
    this.input = config.input;
    this.documents = config.documents ?? [];
    this.images = config.images ?? [];
    this.settings = {
      model: config.model,
      analystTokens,
      reviewTokens: Math.min(1800, analystTokens),
      synthTokens,
      maxModelCalls: budget.maxModelCalls,
      maxReviews: clamp(config.maxReviews, 0, 8, 4),
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 90_000),
      maxWebPages: clamp(config.maxWebPages, 1, 8, 4),
      fixtureSources: config.fixtureSources === true,
    };
    this.tools = {
      web: config.tools?.web ?? new WebFetchTool({ maxPages: this.settings.maxWebPages }),
      search: config.tools?.search ?? createWebSearchFromEnv(),
      github: config.tools?.github ?? new GitHubRepositoryTool({ token: process.env.GITHUB_TOKEN }),
      documents: config.tools?.documents ?? new DocumentExtractionTool(),
      images: config.tools?.images ?? new ImagePreparationTool(),
    };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 1_800_000, 600_000);
    this.planned = planF1(this.input, { documents: this.documents, images: this.images, checkUrl: (u) => this.tools.web.checkUrl(u) });
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort(); // aborts in-flight model requests and blocks any further call
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'product_discovery', label: 'F1 Product Discovery' }, ctx.orchestrator);
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
        specification: new OnEventTypes(['report.generated']),
        processor: guarded(ctx.guard(who), async ({ event }) => {
          const { report, meta } = event.payload as { report: ProductDiscoveryReportV2; meta: ReportMeta };
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
          ctx.emit('factory.failed', { reason: 'participant_error', message: first?.error?.message ?? 'Product Discovery failed', participant: first?.agent, code: first?.error?.code }, ctx.orchestrator);
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    const board = ctx.state.f1;
    this.env = { ctx, gateway: this.gateway, store: this.store, board, input: this.input, settings: this.settings, tools: this.tools, documents: this.documents, images: this.images, policyIssues: [], palette: [] };
    const env = this.env;
    const { plan, pre } = this.planned;

    // Sources known before any agent runs (the user's own text, rejected URLs, unsupported uploads).
    const preRecords = pre.map((p) =>
      this.store.add({ kind: p.kind, label: p.label, url: p.url ?? null, status: p.status, live: false, fixture: false, httpStatus: null, bytes: null, error: p.error ?? null, producer: 'Phase Coordinator' }, p.text),
    );

    // The participant registry is where agents plug in: every role registers a factory; the plan decides who joins.
    const registry = new ParticipantRegistry();
    const agents = new Map<AgentKey, F1Agent>();
    for (const key of Object.keys(AGENT_INFO) as AgentKey[]) {
      registry.register({
        phase: PHASE,
        name: AGENT_INFO[key].name,
        create: () => {
          const agent = key === 'synthesizer' ? this.buildSynthesizer(env) : this.buildAnalyst(env, key as AnalystKey);
          agents.set(key, agent);
          return agent.participant;
        },
      });
    }
    const activated = new Set(plan.activated.map((a) => a.agent));
    const joined = registry.forPhase(PHASE).filter((r) => activated.has(r.name)).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));

    const coordinator = new PhaseCoordinator(env, plan, preRecords);
    return [coordinator.participant, ...joined];
  }

  // ---- analysts (A1 to A6) -----------------------------------------------------------------------

  private buildAnalyst(env: F1Env, key: AnalystKey): F1Agent {
    const { ctx, settings } = env;
    const name = AGENT_INFO[key].name;
    const failTask = (agent: F1Agent, error: ReturnType<typeof toSafeError> | { code: never; message: string }) => {
      agent.closeTask();
      ctx.emit('task.completed', { agent: name, outcome: 'failed', error: error as never }, agent.participant);
    };

    return new F1Agent(env, key, (self) => [
      {
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          const opened = self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
          if (!opened) return;

          const prep = await PREPARE[key](env, self);
          if (!self.isTaskOpen() || ctx.isClosed()) return; // timed out or run ended while retrieving
          if (prep.kind === 'skip') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'skipped', reason: prep.reason }, self.participant);
          }
          if (prep.kind === 'fail') return failTask(self, prep.error);

          self.runJob({
            kind: 'analysis',
            message: prep.message,
            images: prep.images,
            schema: AgentOutput,
            schemaName: `${key}_findings`,
            maxOutputTokens: settings.analystTokens,
            onSuccess: (out) => {
              self.closeTask();
              ctx.emit('finding.posted', { agent: name, summary: out.summary, findings: out.findings, missingInformation: out.missingInformation }, self.participant);
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
            },
            onFailure: (error) => failTask(self, error),
          });
        }),
      },
      {
        // Cross-check: this agent reviews ANOTHER agent's claims using what it analyzed itself.
        specification: new OnEventTypes(['crosscheck.requested']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { requestId: string; producer: string; reviewer: string; claims: never[] };
          if (p.reviewer !== name) return;
          self.runJob({
            kind: 'review',
            message: reviewMessage(p.requestId, p.producer, p.claims, env.input.language),
            schema: CrosscheckAnswer,
            schemaName: 'crosscheck_answer',
            maxOutputTokens: settings.reviewTokens,
            timeoutMs: settings.reviewTimeoutMs,
            onSuccess: (out) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'answered', answers: out.answers }, self.participant),
            onFailure: (error) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'failed', answers: [], error }, self.participant),
          });
        }),
      },
    ]);
  }

  // ---- synthesizer (A7) --------------------------------------------------------------------------

  private buildSynthesizer(env: F1Env): F1Agent {
    const { ctx, settings } = env;
    const name = AGENT_INFO.synthesizer.name;
    return new F1Agent(env, 'synthesizer', (self) => [
      {
        specification: new OnEventTypes(['phase.ready']),
        processor: guarded(ctx.guard(name), () => {
          // Reads the SHARED BOARD (written by the coordinator from the agents' events).
          const snap = env.board.snapshot();
          const failed = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
          const partial = failed.length > 0;
          const digest: SynthDigest = {
            input: env.input,
            plan: { activated: snap.plan?.activated ?? [], skipped: snap.plan?.skipped ?? [] },
            statuses: snap.participantStatuses.map((s) => ({ agent: s.agent, state: s.state, reason: s.error?.message ?? s.reason })),
            sources: snap.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, live: s.live, fixture: s.fixture, error: s.error })),
            findings: snap.findings,
            summaries: snap.summaries,
            crosschecks: snap.crosschecks.map((c) => ({ claimId: c.claimId, producer: c.producer, reviewer: c.reviewer, verdict: c.verdict, rationale: c.rationale, correction: c.correction, status: c.status })),
            missing: [...new Set(snap.missingInformation.map((m) => m.text))].slice(0, 24),
            partial,
          };
          self.openTask(settings.agentTimeoutMs, () => {
            ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant);
            ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: name, error: toSafeError('timeout') }] }, self.participant);
          });
          self.runJob({
            kind: 'synthesis',
            message: synthesizerMessage(digest),
            schema: ProductDiscoveryReportV2,
            schemaName: 'product_discovery_report',
            maxOutputTokens: settings.synthTokens,
            onSuccess: (draft) => {
              self.closeTask();
              const final = env.board.snapshot();
              const { report, issues, analyzed } = finalizeReportV2(draft, final, env.input, { partial, palette: env.palette });
              const usage = env.gateway.usage();
              const meta: ReportMeta = {
                schemaVersion: REPORT_V2_VERSION,
                model: settings.model,
                provider: 'openai',
                generatedAt: new Date().toISOString(),
                partial,
                usage,
                budget: { maxModelCalls: settings.maxModelCalls, analystTokens: settings.analystTokens, reviewTokens: settings.reviewTokens, synthTokens: settings.synthTokens },
                plan: final.plan ?? { activated: [], skipped: [] },
                participants: final.participantStatuses.map((s) => (s.agent === name ? { ...s, state: 'done' as const, error: null } : s)),
                sources: final.sources,
                findings: final.findings,
                crosschecks: final.crosschecks,
                summaries: final.summaries,
                policyIssues: [...env.policyIssues, ...issues],
                analyzed,
                notAnalyzed: this.notAnalyzed(final.sources, analyzed),
                aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
                tools: { search: env.tools.search.provider, searchConfigured: env.tools.search.configured, fixtureSources: settings.fixtureSources },
                inputSnapshot: env.input,
              };
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
              ctx.emit('report.generated', { report, meta }, self.participant);
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

  private notAnalyzed(sources: SourceRecord[], analyzed: AnalyzedSections): { label: string; reason: string }[] {
    const out: { label: string; reason: string }[] = [];
    const plan = this.planned.plan;
    for (const s of plan.skipped) out.push({ label: s.agent, reason: s.reason });
    for (const s of sources.filter((x) => x.status !== 'retrieved' && x.kind !== 'user_input')) out.push({ label: s.label, reason: `${s.status}${s.error ? `: ${s.error}` : ''}` });
    for (const p of this.input.availableSources.socialProfiles) out.push({ label: `${p.platform}: ${p.url}`, reason: 'Social profiles are listed but not retrieved in F1.' });
    if (!analyzed.website && this.input.availableSources.websiteUrl && !out.some((o) => o.label.includes('Web'))) out.push({ label: this.input.availableSources.websiteUrl, reason: 'The website was not analyzed.' });
    return out;
  }
}

export { ANALYST_KEYS, F1BoardStore };
