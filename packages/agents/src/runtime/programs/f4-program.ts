import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { OpenAIClient } from '../../ai/openai-http';
import { DEFAULT_IMAGE_LIMITS, ImageGenerator, type ImageQuality, type ImageSize, type ImageUsageSnapshot } from '../../ai/openai-images';
import type { F1Context } from '../../audit/context';
import { SourceStore, type CrosscheckRecord, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import type { AgentOutcome } from '../../factory/events';
import type { AssetStore } from '../../creative/assets';
import { CREATIVE_INFO, CREATIVE_KEYS, type CreativeBoardStore, type CreativePlan, type CreativeSettingsSnapshot } from '../../creative/board';
import type { CreativeInput, F3Context } from '../../creative/context';
import { baseSizeFor, formatsForChannels } from '../../creative/formats';
import { CAMPAIGN_SCHEMA_VERSION, CampaignPackage, type ReviewFindingRecord } from '../../creative/schemas';
import type { F2Context } from '../../strategy/context';
import { ParticipantRegistry } from '../participant-registry';
import type { InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { buildCopywriter, buildFixer, buildLanding, buildLayout, buildReviewer, buildVisual } from './f4/agents';
import { CreativeCoordinator } from './f4/coordinator';
import type { F4Env, F4Settings, F4Tools } from './f4/env';
import type { PhaseAgent } from './f1/agent';
import { clamp } from './smoke-program';

const PHASE = 'F4_CREATIVE_PRODUCTION' as const;

export interface CreativeRunConfig {
  /** The id of the campaign row the backend created for this run; assets are stored under it as they are produced. */
  campaignId: string;
  projectId: string;
  /** The exact F1 -> F2 -> F3 chain the campaign is built on (all three ids are checked to belong together). */
  f1: F1Context;
  f2: F2Context;
  f3: F3Context;
  input: CreativeInput;
  /** Explicit text model chosen by the user (copy, landing, planning, review). Never defaulted. */
  model: string;
  /** Explicit image model (gpt-image-*). null/absent = no image is generated: layouts use brand-colored backgrounds. */
  imageModel?: string | null;
  imageQuality?: ImageQuality;
  imageSize?: ImageSize;
  /** Hard cap on ORIGINAL images (one request each). Default: the number of concepts. */
  maxImages?: number;
  /** Extra images allowed to replace a rejected one. 0 (default) = regeneration disabled. */
  maxRegenerations?: number;
  /** Layouts per concept (formats). Default 4, at most 6. */
  maxLayoutsPerConcept?: number;
  /** Review/repair rounds after the first review. Default 2. */
  maxRepairRounds?: number;
  /** Exported assets the reviewer may SEE with the vision model per review round. Default 0 (off). */
  visionReviews?: number;
  /** Hard cap on text-model calls for the whole run. Default 16. */
  maxModelCalls?: number;
  maxOutputTokens?: number;
  maxCrossChecks?: number;
  /** Brand colors (#rrggbb), see derivePalette. */
  palette?: string[];
  hasBrandPalette?: boolean;
  logo?: Buffer | null;
  assets: AssetStore;
  agentTimeoutMs?: number;
  visualTimeoutMs?: number;
  reviewTimeoutMs?: number;
  repairTimeoutMs?: number;
  productionTimeoutMs?: number;
  callTimeoutMs?: number;
  imageTimeoutMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  imageRetryBaseDelayMs?: number;
  /** Test seam: base URL of the OpenAI API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  tools?: { images?: ImageGenerator | null };
  /** TESTS ONLY. */
  fixtureSources?: boolean;
  now?: Date;
}

export interface CreativeReportMeta {
  schemaVersion: number;
  model: string;
  imageModel: string | null;
  provider: 'openai';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  images: ImageUsageSnapshot | null;
  settings: CreativeSettingsSnapshot | null;
  plan: CreativePlan;
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  aiCalls: Record<string, number>;
  why: string;
  modelReviewFailed: boolean;
  chain: { f1ReportId: string; f2AuditId: string; f3StrategyId: string };
  inputSnapshot: CreativeInput;
}

export type CreativeSink = (pkg: CampaignPackage, meta: CreativeReportMeta) => Promise<void>;

/** Which participants run. The Fixer is NOT planned here: it is created at run time only if the review finds something to repair. */
export function planF4(input: CreativeInput, imageGeneration: boolean): CreativePlan {
  const plan: CreativePlan = { activated: [], skipped: [] };
  const on = (key: (typeof CREATIVE_KEYS)[number], reason: string) => plan.activated.push({ agent: CREATIVE_INFO[key].name, key, reason });
  on('copywriter', 'Always runs: concepts and channel copy');
  on('visual', imageGeneration ? 'Plans and generates the base images with the selected image model' : 'Runs without an image model: layouts use brand-colored backgrounds');
  on('layout', 'Always runs: deterministic channel layouts from the base images (no model call)');
  if (input.landing) on('landing', 'Landing page content requested');
  else plan.skipped.push({ agent: CREATIVE_INFO.landing.name, key: 'landing', reason: 'No landing page was requested for this campaign' });
  on('reviewer', 'Always runs: deterministic checks plus text review');
  return plan;
}

/** What a run is expected to cost, for the preflight. Counts only: no price is ever computed. */
export function estimateCreativeRun(o: { concepts: number; landing: boolean; imageGeneration: boolean; maxImages: number; maxRegenerations: number; maxLayoutsPerConcept: number; maxRepairRounds: number; visionReviews: number; maxModelCalls: number; channels: number }) {
  const images = o.imageGeneration ? Math.min(o.maxImages, o.concepts) : 0;
  const base = 1 + (o.landing ? 1 : 0) + (o.imageGeneration ? 1 : 0); // copy + landing + visual planning
  const crossChecks = (o.landing ? 2 : 0) + (o.imageGeneration ? 1 : 0);
  const review = 1 + (o.visionReviews > 0 ? 1 : 0);
  const typical = base + crossChecks + review;
  const repairs = o.maxRepairRounds * ((o.landing ? 2 : 1) + 1);
  const layouts = Math.min(o.maxLayoutsPerConcept, 6) * o.concepts;
  return {
    textCalls: { typical: Math.min(typical, o.maxModelCalls), max: Math.min(typical + repairs, o.maxModelCalls), enforcedCap: o.maxModelCalls },
    imageRequests: { planned: images, max: images + (o.imageGeneration ? o.maxRegenerations : 0), regenerationEnabled: o.maxRegenerations > 0 },
    layouts: { planned: layouts, note: 'Rendered locally from the base images; no model call and no cost.' },
  };
}

/**
 * F4 Creative Production: Copywriter and Landing Content Builder start together; the Visual Creator starts as soon as the copy is
 * committed (and has the Copywriter check its picture plan before any image is paid for); the Layout Designer renders every
 * channel format from the base images as they appear; the Content & Brand Reviewer reviews once everything is in; and, only if
 * issues remain, the Creative Coordinator CREATES the Fixer at run time and runs the bounded review/repair loop.
 */
export class F4Program implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: F4Settings;
  private readonly tools: F4Tools;
  private readonly store = new SourceStore();
  private readonly plan: CreativePlan;
  private env!: F4Env;

  constructor(
    credentials: InferenceCredentials,
    private readonly config: CreativeRunConfig,
    private readonly sink: CreativeSink,
  ) {
    const analystTokens = clamp(config.maxOutputTokens, 800, 6000, 3000);
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 2, 40, 16),
      maxOutputTokens: analystTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    const client = new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl });
    this.gateway = new InferenceGateway(client, budget);
    const formats = formatsForChannels(config.input.channels, clamp(config.maxLayoutsPerConcept, 1, 6, 4));
    const imageGeneration = !!config.imageModel?.trim();
    const maxRegenerations = clamp(config.maxRegenerations, 0, 5, 0);
    this.settings = {
      model: config.model,
      analystTokens,
      reviewTokens: Math.min(1800, analystTokens),
      maxModelCalls: budget.maxModelCalls,
      maxCrossChecks: clamp(config.maxCrossChecks, 0, 4, 2),
      maxRepairRounds: clamp(config.maxRepairRounds, 0, 3, 2),
      visionReviews: clamp(config.visionReviews, 0, 6, 0),
      imageGeneration,
      imageModel: imageGeneration ? config.imageModel!.trim() : null,
      imageQuality: config.imageQuality ?? 'low',
      imageSize: config.imageSize ?? baseSizeFor(formats.map((f) => f.format)),
      allowRegeneration: maxRegenerations > 0,
      maxLayoutsPerConcept: formats.length,
      formats,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      visualTimeoutMs: clamp(config.visualTimeoutMs, 50, 1_200_000, 420_000),
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 90_000),
      repairTimeoutMs: clamp(config.repairTimeoutMs, 50, 600_000, 120_000),
      productionTimeoutMs: 0,
      fixtureSources: config.fixtureSources === true,
      now: config.now ?? new Date(),
    };
    this.settings.productionTimeoutMs = clamp(config.productionTimeoutMs, 100, 2_000_000, this.settings.visualTimeoutMs + this.settings.agentTimeoutMs + 60_000);
    const images =
      config.tools?.images !== undefined
        ? config.tools.images
        : imageGeneration
          ? new ImageGenerator(client, {
              maxImages: Math.min(clamp(config.maxImages, 0, 10, config.input.concepts), config.input.concepts),
              maxRegenerations,
              timeoutMs: clamp(config.imageTimeoutMs, 50, 600_000, DEFAULT_IMAGE_LIMITS.timeoutMs),
              maxRetries: DEFAULT_IMAGE_LIMITS.maxRetries,
              retryBaseDelayMs: clamp(config.imageRetryBaseDelayMs, 1, 60_000, DEFAULT_IMAGE_LIMITS.retryBaseDelayMs),
            })
          : null;
    this.tools = { images, assets: config.assets };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 3_600_000, 1_500_000);
    this.plan = planF4(config.input, imageGeneration);
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort();
    this.tools.images?.abort();
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'creative_production', label: 'F4 Creative Production' }, ctx.orchestrator);
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    const who = 'Factory Orchestrator';
    return [
      {
        specification: new OnEventTypes(['factory.started']),
        processor: guarded(ctx.guard(who), () => {
          ctx.state.currentPhase = PHASE;
          ctx.emit('phase.started', { phase: PHASE, agents: this.plan.activated.map((a) => a.agent), plan: { ...this.plan, fixerOnDemand: true } }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['campaign.completed']),
        processor: guarded(ctx.guard(who), async ({ event }) => {
          const { report } = event.payload as { report: { why: string; modelReviewFailed: boolean } };
          const { pkg, meta } = this.buildPackage(ctx, report.why, report.modelReviewFailed);
          // Persist BEFORE completing: a run is only COMPLETED if its package is saved.
          await this.sink(pkg, meta);
          if (ctx.isClosed()) return;
          ctx.emit('phase.completed', { phase: PHASE }, ctx.orchestrator);
          ctx.emit('factory.completed', { mode: 'creative_production', phasesCompleted: [PHASE] }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['phase.failed']),
        processor: guarded(ctx.guard(who), ({ event }) => {
          const { errors } = event.payload as { errors: AgentOutcome[] };
          const first = errors[0];
          ctx.emit('factory.failed', { reason: 'participant_error', message: first?.error?.message ?? 'Creative production failed', participant: first?.agent, code: first?.error?.code }, ctx.orchestrator);
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    const board: CreativeBoardStore = ctx.state.f4;
    const c = this.config;
    const env: F4Env = {
      ctx,
      gateway: this.gateway,
      store: this.store,
      board,
      f1: c.f1,
      f3: c.f3,
      input: c.input,
      settings: this.settings,
      tools: this.tools,
      palette: c.palette?.length ? c.palette : ['#1f2937', '#0f172a'],
      hasBrandPalette: c.hasBrandPalette === true,
      logo: c.logo ?? null,
      agents: new Map(),
      createFixer: () => {
        const agent = buildFixer(env);
        env.agents.set('fixer', agent);
        return agent;
      },
    };
    this.env = env;
    const pre = [
      { kind: 'f1_report' as const, label: `F1 Product Discovery report ${c.f1.reportId}`, text: `f1_report_id: ${c.f1.reportId}\nproduct: ${c.f1.report.productManifest.name}\npartial: ${c.f1.partial}` },
      { kind: 'f2_audit' as const, label: `F2 Marketing Audit ${c.f2.auditId}`, text: `f2_audit_id: ${c.f2.auditId}\nbuilt_on_f1_report: ${c.f2.f1ReportId}\npartial: ${c.f2.partial}` },
      { kind: 'f3_strategy' as const, label: `F3 Campaign Strategy ${c.f3.strategyId}`, text: `f3_strategy_id: ${c.f3.strategyId}\nbuilt_on_f1_report: ${c.f3.f1ReportId}\nbuilt_on_f2_audit: ${c.f3.f2AuditId}\npartial: ${c.f3.partial}` },
    ].map((p) => this.store.add({ kind: p.kind, label: p.label, url: null, status: 'retrieved', live: false, fixture: false, httpStatus: null, bytes: null, error: null, producer: 'Creative Coordinator', origin: 'previous_phase' }, p.text));

    const builders: Record<string, (e: F4Env) => PhaseAgent> = { copywriter: buildCopywriter, visual: buildVisual, layout: buildLayout, landing: buildLanding, reviewer: buildReviewer };
    const registry = new ParticipantRegistry();
    for (const key of Object.keys(builders)) {
      registry.register({
        phase: PHASE,
        name: CREATIVE_INFO[key as keyof typeof CREATIVE_INFO].name,
        create: () => {
          const agent = builders[key](env);
          env.agents.set(key, agent);
          return agent.participant;
        },
      });
    }
    const activated = new Set(this.plan.activated.map((a) => a.agent));
    const joined = registry.forPhase(PHASE).filter((r) => activated.has(r.name)).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));
    const coordinator = new CreativeCoordinator(env, this.plan, pre);
    return [coordinator.participant, ...joined];
  }

  // ---- the Campaign Package ----------------------------------------------------------------------------------------

  private buildPackage(ctx: RunContext, why: string, modelReviewFailed: boolean) {
    const { config: c, settings } = this;
    const snap = ctx.state.f4.snapshot();
    const usage = this.gateway.usage();
    const imgUsage = this.tools.images?.usage() ?? null;
    const failedAgents = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
    const unresolved = snap.findings.filter((f) => f.status === 'unresolved' && (f.severity === 'blocker' || f.severity === 'major'));
    const minorOpen = snap.findings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && f.severity === 'minor');
    const status = unresolved.length ? ('unresolved' as const) : minorOpen.length || failedAgents.length || modelReviewFailed ? ('approved_with_notes' as const) : ('approved' as const);
    const rounds = Math.max(0, snap.round - 1);
    const note =
      status === 'approved'
        ? 'No blocker, major or minor issue remains after the review.'
        : status === 'unresolved'
          ? `${unresolved.length} blocker/major issue(s) could not be repaired within ${settings.maxRepairRounds} repair round(s); they are listed unchanged in the review findings.`
          : 'Approved with notes: minor issues or missing parts remain and are listed in the review findings and limitations.';
    const limitations = [...snap.limitations];
    if (!settings.imageGeneration) limitations.push('No image model was selected: layouts use brand-colored backgrounds, not generated pictures.');
    if (modelReviewFailed) limitations.push('The model-based review failed in at least one round; only the automatic checks were applied in that round.');
    if (!settings.visionReviews) limitations.push('The exported images were checked by measurement only (size, text fit, contrast, logo); no model looked at them.');
    if (snap.skippedLayouts.length) limitations.push(`${snap.skippedLayouts.length} layout(s) could not be produced cleanly and were not exported (see the format list).`);
    if (!c.hasBrandPalette) limitations.push('No brand colors were available: a neutral palette was used.');
    if (!snap.landing && c.input.landing) limitations.push('The landing page content could not be produced.');
    const pkg: CampaignPackage = {
      id: c.campaignId,
      projectId: c.projectId,
      runId: ctx.runId,
      f1ReportId: c.f1.reportId,
      f2ReportId: c.f2.auditId,
      f3StrategyId: c.f3.strategyId,
      schemaVersion: CAMPAIGN_SCHEMA_VERSION,
      campaignName: `${c.f3.report.productContext.name} — creative campaign`.slice(0, 120),
      language: c.input.language,
      concepts: snap.concepts,
      copyVariants: snap.variants,
      imageAssets: snap.assets,
      channelLayouts: snap.layouts,
      skippedLayouts: snap.skippedLayouts,
      landingContent: snap.landing,
      reviewFindings: snap.findings as ReviewFindingRecord[],
      revisions: snap.revisions,
      approval: { status, rounds, unresolvedFindingIds: unresolved.map((f) => f.id), note },
      usage: {
        text: { calls: usage.total.calls, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, totalTokens: usage.total.inputTokens + usage.total.outputTokens, perAgent: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, { calls: v.calls, totalTokens: v.inputTokens + v.outputTokens }])) },
        images: { model: settings.imageModel, quality: settings.imageGeneration ? settings.imageQuality : null, size: settings.imageGeneration ? settings.imageSize : null, requested: imgUsage?.requestsStarted ?? 0, generated: imgUsage?.generated ?? 0, failed: imgUsage?.failed ?? 0, regenerations: imgUsage?.regenerationsStarted ?? 0, limits: { maxImages: imgUsage?.limits.maxImages ?? 0, maxRegenerations: imgUsage?.limits.maxRegenerations ?? 0 }, providerReportedTokens: imgUsage?.tokens ?? null },
        layouts: { rendered: snap.layouts.length, skipped: snap.skippedLayouts.length },
      },
      limitations,
      createdAt: new Date().toISOString(),
    };
    const checked = CampaignPackage.safeParse(pkg);
    if (!checked.success) throw new Error(`The campaign package is not valid: ${checked.error.issues[0]?.path.join('.')} ${checked.error.issues[0]?.message}`);
    const meta: CreativeReportMeta = {
      schemaVersion: CAMPAIGN_SCHEMA_VERSION,
      model: settings.model,
      imageModel: settings.imageModel,
      provider: 'openai',
      generatedAt: pkg.createdAt,
      partial: failedAgents.length > 0,
      usage,
      images: imgUsage,
      settings: snap.settings,
      plan: snap.plan ?? { activated: [], skipped: [] },
      participants: snap.participantStatuses,
      sources: snap.sources,
      crosschecks: snap.crosschecks,
      summaries: snap.summaries,
      aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
      why,
      modelReviewFailed,
      chain: { f1ReportId: c.f1.reportId, f2AuditId: c.f2.auditId, f3StrategyId: c.f3.strategyId },
      inputSnapshot: c.input,
    };
    return { pkg: checked.data, meta };
  }
}
