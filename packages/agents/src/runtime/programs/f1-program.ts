import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../ai/errors';
import { SpendBudget, scopeFor } from '../../ai/budget';
import { resolveGeneration, synthesisTaskTimeoutMs, type GenerationTimeout } from '../../ai/timeouts';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { capOutputTokens } from '../../ai/pricing';
import {
  AGENT_INFO,
  F1BoardStore,
  SourceStore,
  type CrosscheckRecord,
  type F1Plan,
  type Finding,
  type ParticipantStatus,
  type SourceRecord,
} from '../../discovery/f1/board';
import { type AnalyzedSections, type PolicyIssue, finalizeReportV2 } from '../../discovery/f1/policy';
import { synthesizerMessage, type SynthDigest } from '../../discovery/f1/prompts';
import { AgentOutput, ProductDiscoveryReportV2 } from '../../discovery/f1/schemas';
import { inputCorpus, type DiscoveryInput } from '../../discovery/input';
import { REPORT_V2_VERSION } from '../../discovery/f1/schemas';
import type { AgentOutcome } from '../../factory/events';
import { DocumentExtractionTool, detectFormat, type DocumentInput } from '../../tools/documents';
import { GitHubRepositoryTool, parseGitHubUrl } from '../../tools/github';
import { ImagePreparationTool, type ImageInput } from '../../tools/images';
import { createWebExtractFromEnv } from '../../tools/web-extract';
import { WebFetchTool } from '../../tools/web-fetch';
import { brandFactsOf, type BrandFacts } from '../../brand/official';
import { createWebSearchFromEnv } from '../../tools/web-search';
import { ParticipantRegistry } from '../participant-registry';
import { createTextTransport, type InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { clamp } from './smoke-program';
import { F1Agent } from './f1/agent';
import { PhaseCoordinator } from './f1/coordinator';
import type { F1Env, F1Settings, F1Tools } from './f1/env';
import { prepareResearch, type ResearchSteps } from './f1/roles';

const PHASE = 'F1_PRODUCT_DISCOVERY' as const;

export interface DiscoveryRunConfig {
  input: DiscoveryInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  /** Uploaded documents / images (already authorized by the caller; bytes are loaded lazily). */
  documents?: DocumentInput[];
  images?: ImageInput[];
  /** Hard cap on provider calls for the whole run (retries and repairs count). Default 6: one analysis, one synthesis, room for repairs. */
  maxModelCalls?: number;
  /** `max_output_tokens` for the analysis call. The synthesis call may use up to twice as much. Default 3000. */
  maxOutputTokens?: number;
  /** The approved spending limit in US dollars for THIS run; null/absent = none. Enforced before every paid request. */
  spendCapUsd?: number | null;
  /** The campaign-wide spend ledger shared by every phase (the factory passes it). Absent = this run gets a ledger of its own with `spendCapUsd`. */
  ledger?: SpendBudget;
  /** Deadline of the research task (all tool retrieval and the analysis call). Default 150 s. */
  agentTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Scales the clock of long structured answers with their output cap (default: on, unless callTimeoutMs is fixed). Tests may tune it. */
  generation?: Partial<GenerationTimeout>;
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
  provider: 'openai' | 'anthropic';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  budget: { maxModelCalls: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  plan: F1Plan;
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  findings: Finding[];
  /** Always [] since V4 (one Business Researcher, no cross-checks); kept so stored reports keep their shape. */
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  policyIssues: PolicyIssue[];
  analyzed: AnalyzedSections;
  /** What was available or requested but not analyzed, and why. */
  notAnalyzed: { label: string; reason: string }[];
  /** Which participants actually made AI calls (the rest are deterministic tools or the coordinator). */
  aiCalls: Record<string, number>;
  tools: { search: string; searchConfigured: boolean; extract: string; extractConfigured: boolean; extractCalls: number; fixtureSources: boolean };
  inputSnapshot: DiscoveryInput;
  /** Verified identity facts read from the business's own website (official slogan, name, contact) with their sources. Absent in older reports. */
  brandFacts?: BrandFacts | null;
}

export type ReportSink = (report: ProductDiscoveryReportV2, meta: ReportMeta) => Promise<void>;

// ---- activation plan --------------------------------------------------------------------------------

type PreSource = Pick<SourceRecord, 'kind' | 'label' | 'status'> & { url?: string | null; error?: string | null; text?: string };

export interface F1Planned {
  plan: F1Plan;
  pre: PreSource[];
  /** The gather steps the Business Researcher runs. */
  steps: ResearchSteps;
  /** Sources the user did not supply (or that were rejected before anything ran), with the reason. */
  notGathered: { label: string; reason: string }[];
}

/** Which gather steps the Business Researcher runs, which are left out and why. Pure and deterministic. */
export function planF1(input: DiscoveryInput, files: { documents: DocumentInput[]; images: ImageInput[]; checkUrl: (u: string) => { ok: true } | { ok: false; message: string } }): F1Planned {
  const pre: PreSource[] = [{ kind: 'user_input', label: 'Project intake and notes', status: 'retrieved', text: inputCorpus(input) }];
  const steps: ResearchSteps = { web: false, repo: false, files: false, images: false };
  const reads: string[] = ['the project intake'];
  const notGathered: { label: string; reason: string }[] = [];

  const site = input.availableSources.websiteUrl;
  if (!site) notGathered.push({ label: 'Website', reason: 'No website URL was provided' });
  else {
    const c = files.checkUrl(site);
    if (c.ok) {
      steps.web = true;
      reads.push(`the website ${site}`);
    } else {
      notGathered.push({ label: site, reason: `The website URL was rejected: ${c.message}` });
      pre.push({ kind: 'website', label: site, url: site, status: 'failed', error: c.message });
    }
  }

  const repo = input.availableSources.githubUrl;
  if (!repo) notGathered.push({ label: 'Repository', reason: 'No repository URL was provided' });
  else {
    const parsed = parseGitHubUrl(repo);
    if (parsed) {
      steps.repo = true;
      reads.push(`the public GitHub repository ${parsed.owner}/${parsed.repo}`);
    } else {
      notGathered.push({ label: repo, reason: 'The repository URL is not a valid github.com/<owner>/<repo> URL' });
      pre.push({ kind: 'repository', label: repo, url: repo, status: 'failed', error: 'Not a valid github.com/<owner>/<repo> URL.' });
    }
  }

  const docs = files.documents.filter((d) => detectFormat(d.name));
  const known = new Set([...files.documents, ...files.images].map((f) => f.name));
  const unsupported = input.availableSources.uploads.filter((u) => !known.has(u.name) || (!files.images.some((i) => i.name === u.name) && !detectFormat(u.name)));
  for (const u of unsupported) pre.push({ kind: 'document', label: u.name, status: 'unsupported', error: 'Unsupported file type. Supported documents: PDF, DOCX, TXT, Markdown, JSON, CSV; images: PNG, JPEG, WebP, GIF.' });
  if (docs.length) {
    steps.files = true;
    reads.push(`${docs.length} uploaded document(s)`);
  } else notGathered.push({ label: 'Documents', reason: unsupported.length ? 'The uploaded files are not supported document types' : 'No documents were uploaded' });

  if (files.images.length) {
    steps.images = true;
    reads.push(`${files.images.length} uploaded image(s)`);
  } else notGathered.push({ label: 'Images', reason: 'No images were uploaded' });

  const plan: F1Plan = { activated: [{ agent: AGENT_INFO.researcher.name, key: 'researcher', reason: `Always runs: reads ${reads.join(', ')}` }], skipped: [] };
  return { plan, pre, steps, notGathered };
}

// ---- the program -------------------------------------------------------------------------------------

/**
 * F1 Business Research: ONE real Mozaik agent (the Business Researcher: deterministic gathering, one analysis call, one synthesis
 * call), a deterministic Phase Coordinator and the Factory Orchestrator.
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
  private readonly planned: F1Planned;
  private env!: F1Env;

  constructor(
    credentials: InferenceCredentials,
    config: DiscoveryRunConfig,
    private readonly sink: ReportSink,
  ) {
    // never above what the chosen model supports (a limit that was not verified is capped conservatively)
    const analystTokens = capOutputTokens(config.model, clamp(config.maxOutputTokens, 800, 16000, 3000)).tokens;
    const synthTokens = Math.min(8000, analystTokens * 2);
    const generation = resolveGeneration(config.generation, config.callTimeoutMs !== undefined);
    const budget: InferenceBudget = {
      spend: scopeFor(config.ledger, config.spendCapUsd, 'F1'),
      // a cut-off answer is asked again with a larger cap (up to what the model supports) instead of failing the agent
      escalateTo: capOutputTokens(config.model, 16000).tokens,
      maxModelCalls: clamp(config.maxModelCalls, 1, 40, 6),
      maxOutputTokens: synthTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      generation,
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    // The key is handed to the client (private field) and not kept anywhere else.
    this.gateway = new InferenceGateway(createTextTransport(credentials, { baseUrl: config.baseUrl }).transport, budget);
    this.input = config.input;
    this.documents = config.documents ?? [];
    this.images = config.images ?? [];
    this.settings = {
      model: config.model,
      analystTokens,
      synthTokens,
      maxModelCalls: budget.maxModelCalls,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      synthTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      maxWebPages: clamp(config.maxWebPages, 1, 8, 4),
      fixtureSources: config.fixtureSources === true,
    };
    // the synthesis writes the longest answer of the phase: its task deadline follows the clock of its request (and the one larger re-ask)
    if (generation) this.settings.synthTimeoutMs = Math.max(this.settings.agentTimeoutMs, synthesisTaskTimeoutMs(synthTokens, budget.escalateTo, generation));
    // V4: the ONE Business Researcher writes a single combined analysis with the analyst cap: a long answer, so its task deadline follows its clock
    if (generation) this.settings.agentTimeoutMs = Math.max(this.settings.agentTimeoutMs, synthesisTaskTimeoutMs(analystTokens, budget.escalateTo, generation));
    this.tools = {
      web: config.tools?.web ?? new WebFetchTool({ maxPages: this.settings.maxWebPages }),
      search: config.tools?.search ?? createWebSearchFromEnv(),
      extract: config.tools?.extract ?? createWebExtractFromEnv(),
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

    // The participant registry is where agents plug in: the one role registers its factory; the plan decides that it joins.
    const registry = new ParticipantRegistry();
    registry.register({ phase: PHASE, name: AGENT_INFO.researcher.name, create: () => this.buildResearcher(env).participant });
    const activated = new Set(plan.activated.map((a) => a.agent));
    const joined = registry.forPhase(PHASE).filter((r) => activated.has(r.name)).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));

    const coordinator = new PhaseCoordinator(env, plan, preRecords);
    return [coordinator.participant, ...joined];
  }

  // ---- the Business Researcher (A1): gather -> analysis -> (phase.ready) -> synthesis ------------------------------------------

  private buildResearcher(env: F1Env): F1Agent {
    const { ctx, settings } = env;
    const name = AGENT_INFO.researcher.name;
    const failTask = (agent: F1Agent, error: ReturnType<typeof toSafeError>) => {
      agent.closeTask();
      ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, agent.participant);
    };

    return new F1Agent(env, 'researcher', (self) => [
      {
        // STEP 1: every activated gather step, then ONE analysis call over the combined evidence
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          const opened = self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
          if (!opened) return;

          const prep = await prepareResearch(env, self, this.planned.steps);
          if (!self.isTaskOpen() || ctx.isClosed()) return; // timed out or run ended while retrieving
          if (prep.kind === 'fail') return failTask(self, prep.error as ReturnType<typeof toSafeError>);

          self.runJob({
            kind: 'analysis',
            message: prep.message,
            images: prep.images,
            schema: AgentOutput,
            schemaName: 'researcher_findings',
            maxOutputTokens: settings.analystTokens,
            longAnswer: true,
            onSuccess: (out) => {
              self.closeTask();
              ctx.emit('finding.posted', { agent: name, summary: out.summary, findings: out.findings, missingInformation: out.missingInformation }, self.participant);
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
            },
            onFailure: (error) => failTask(self, error as ReturnType<typeof toSafeError>),
          });
        }),
      },
      {
        // STEP 2: the report and Product Manifest from the SHARED BOARD (written by the coordinator from the agent's events)
        specification: new OnEventTypes(['phase.ready']),
        processor: guarded(ctx.guard(name), () => {
          const snap = env.board.snapshot();
          // partial = a source the user DID supply could not be read (a source the user did not supply is not a failure)
          const failedSources = snap.sources.some((s) => s.status === 'failed' && s.kind !== 'user_input' && s.kind !== 'search_result' && s.producer !== 'Phase Coordinator');
          const digest: SynthDigest = {
            input: env.input,
            plan: { activated: snap.plan?.activated ?? [], skipped: this.planned.notGathered.map((n) => ({ agent: n.label, reason: n.reason })) },
            statuses: snap.participantStatuses.map((s) => ({ agent: s.agent, state: s.state, reason: s.error?.message ?? s.reason })),
            sources: snap.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, live: s.live, fixture: s.fixture, error: s.error })),
            findings: snap.findings,
            summaries: snap.summaries,
            missing: [...new Set(snap.missingInformation.map((m) => m.text))].slice(0, 24),
            partial: failedSources,
          };
          self.openTask(settings.synthTimeoutMs, () => {
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
              const { report, issues, analyzed } = finalizeReportV2(draft, final, env.input, { partial: digest.partial, palette: env.palette });
              const usage = env.gateway.usage();
              const meta: ReportMeta = {
                schemaVersion: REPORT_V2_VERSION,
                model: settings.model,
                provider: env.gateway.provider,
                generatedAt: new Date().toISOString(),
                partial: digest.partial,
                usage,
                budget: { maxModelCalls: settings.maxModelCalls, analystTokens: settings.analystTokens, reviewTokens: 0, synthTokens: settings.synthTokens },
                plan: final.plan ?? { activated: [], skipped: [] },
                participants: final.participantStatuses.map((s) => (s.agent === name ? { ...s, state: 'done' as const, error: null } : s)),
                sources: final.sources,
                findings: final.findings,
                crosschecks: [],
                summaries: final.summaries,
                policyIssues: [...env.policyIssues, ...issues],
                analyzed,
                notAnalyzed: this.notAnalyzed(final.sources, analyzed),
                aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
                tools: { search: env.tools.search.provider, searchConfigured: env.tools.search.configured, extract: env.tools.extract.provider, extractConfigured: env.tools.extract.configured, extractCalls: env.tools.extract.callCount, fixtureSources: settings.fixtureSources },
                inputSnapshot: env.input,
                brandFacts: env.brandPages?.length ? brandFactsOf(env.brandPages, env.input.intake?.productName ?? env.input.project.name) : null,
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
    for (const s of this.planned.notGathered) out.push(s);
    for (const s of sources.filter((x) => x.status !== 'retrieved' && x.kind !== 'user_input')) out.push({ label: s.label, reason: `${s.status}${s.error ? `: ${s.error}` : ''}` });
    for (const p of this.input.availableSources.socialProfiles) out.push({ label: `${p.platform}: ${p.url}`, reason: 'Social profiles are listed but not retrieved in F1.' });
    if (!analyzed.website && this.input.availableSources.websiteUrl && !out.some((o) => o.label === this.input.availableSources.websiteUrl)) out.push({ label: this.input.availableSources.websiteUrl, reason: 'The website was not analyzed.' });
    return out;
  }
}

export { F1BoardStore };
