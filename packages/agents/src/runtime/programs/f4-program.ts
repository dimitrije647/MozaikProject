import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { SpendBudget, scopeFor } from '../../ai/budget';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { PRICE_BOOK_VERIFIED_AT, capOutputTokens, imageCostEstimate, textCostUsd, textPrice } from '../../ai/pricing';
import { OpenAIClient } from '../../ai/openai-http';
import { DEFAULT_IMAGE_LIMITS, ImageGenerator, type ImageQuality, type ImageSize, type ImageUsageSnapshot } from '../../ai/openai-images';
import type { F1Context } from '../../audit/context';
import { SourceStore, type CrosscheckRecord, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import type { AgentOutcome } from '../../factory/events';
import type { AssetStore } from '../../creative/assets';
import type { ContinuationSeed } from '../../creative/continuation';
import { CREATIVE_INFO, CREATIVE_KEYS, type CreativeBoardStore, type CreativePlan, type CreativeSettingsSnapshot } from '../../creative/board';
import type { CreativeInput, F3Context } from '../../creative/context';
import { baseSizeFor, formatsForChannels } from '../../creative/formats';
import { completeImageResults, completeVariations, conceptResultFromVariations, countVariations, distinctReasons } from '../../creative/image-results';
import { CAMPAIGN_SCHEMA_VERSION, CampaignPackage, RUBRIC_CRITERIA, type CostReport, type QualityDiagnostic, type ReviewFindingRecord } from '../../creative/schemas';
import type { F2Context } from '../../strategy/context';
import type { ChannelId } from '../../strategy/channels';
import { buildVisualBrief } from '../../creative/visual-brief';
import { industryTextOf } from '../../hybrid/direction';
import { slotsFromSelection } from '../../hybrid/plan';
import { buildHybridBlock, hybridCounts } from '../../hybrid/report';
import type { HybridSettings } from '../../hybrid/settings';
import { designAnchors, designBrandColors } from '../../collections/design';
import { getCollection, themedTemplates } from '../../collections/registry';
import type { VisualDiscoveryPort } from '../../imagery/discovery';
import { isNoAi } from '../../hybrid/settings';
import { LIBRARY_VERSION, TEMPLATE_LIBRARY } from '../../templates/library';
import { ParticipantRegistry } from '../participant-registry';
import type { InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { buildCopywriter, buildFixer, buildLanding, buildLayout, buildReviewer, buildVisual } from './f4/agents';
import { CreativeCoordinator } from './f4/coordinator';
import type { BrandContext, BrandImage, F4Env, F4Settings, F4Tools, ImageAcquirePort } from './f4/env';
import { buildResearcher, buildSelector, buildTemplateReviewer } from './f4/hybrid-agents';
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
  /** Hard cap on ORIGINAL images (one request each). Default: the number of concepts. With `variations` it is the number of originals planned (at most 40). */
  maxImages?: number;
  /** Several original images per concept, placed by the deterministic allocation planner (Full Production). false/absent = one image per concept. */
  variations?: boolean;
  /** Original images requested at the same time (each is its own request). Default 2, at most 4. */
  imageConcurrency?: number;
  /** Layout formats cut from each original when `variations` is on. Default 3, at most 6. */
  layoutsPerOriginal?: number;
  /** Cap on copy variants over all concepts when `variations` is on. Default 24. */
  maxVariants?: number;
  /** The approved spending limit in US dollars for THIS run (text and images); null/absent = none. Enforced before every paid request. */
  spendCapUsd?: number | null;
  /** The campaign-wide spend ledger shared by every phase (the factory passes it). Absent = this run gets a ledger of its own with `spendCapUsd`. */
  ledger?: SpendBudget;
  /** Deeper work where it adds something (more cross-check passes; F4: a concept critique before the images). */
  depth?: boolean;
  /** Image-only continuation of an earlier campaign (see creative/continuation.ts): copy, landing, the plan and the images that succeeded are reused. */
  seed?: ContinuationSeed;
  /**
   * Hybrid Production: a few original AI images plus template creatives rendered locally from them (see hybrid/). `brandImages` are the
   * project's own images (read and size-limited by the backend); `referencePalettes` come from reference images the USER owns.
   */
  hybrid?: { settings: HybridSettings; brandImages?: BrandImage[]; referencePalettes?: Record<string, string[]>; discovery?: VisualDiscoveryPort | null; /** NO AI HYBRID: adds a licensed picture during the run (automatic stock mode) */ acquire?: ImageAcquirePort | null; /** NO AI HYBRID: picture candidates the gallery already knows */ discoveredBefore?: number } | null;
  /** Brand content the owner approved with Get Content (logo, photographs). null/absent = Get Content was not used: nothing changes. */
  brand?: BrandContext | null;
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
export function planF4(input: CreativeInput, imageGeneration: boolean, reused: string | null = null, hybrid = false, noAi = false): CreativePlan {
  const plan: CreativePlan = { activated: [], skipped: [] };
  const on = (key: (typeof CREATIVE_KEYS)[number], reason: string) => plan.activated.push({ agent: CREATIVE_INFO[key].name, key, reason });
  if (reused) plan.skipped.push({ agent: CREATIVE_INFO.copywriter.name, key: 'copywriter', reason: reused });
  else on('copywriter', 'Always runs: concepts and channel copy');
  on('visual', noAi ? 'NO AI HYBRID: never generates images; it is routed to the Visual Researcher, which sources existing and licensed pictures' : imageGeneration ? 'Plans and generates the base images with the selected image model' : 'Runs without an image model: layouts use brand-colored backgrounds');
  on('layout', hybrid ? 'Always runs: renders the template creatives of the selection from the originals, the brand colors and the logo (deterministic, no model call)' : 'Always runs: deterministic channel layouts from the base images (no model call)');
  if (reused && input.landing) plan.skipped.push({ agent: CREATIVE_INFO.landing.name, key: 'landing', reason: reused });
  else if (input.landing) on('landing', 'Landing page content requested');
  else plan.skipped.push({ agent: CREATIVE_INFO.landing.name, key: 'landing', reason: 'No landing page was requested for this campaign' });
  on('reviewer', 'Always runs: deterministic checks plus text review');
  if (hybrid) {
    if (reused) {
      plan.skipped.push({ agent: CREATIVE_INFO.researcher.name, key: 'researcher', reason: reused });
      plan.skipped.push({ agent: CREATIVE_INFO.selector.name, key: 'selector', reason: reused });
    } else {
      on('researcher', noAi ? 'NO AI HYBRID: builds the Visual Direction Brief, then sources the pictures of the campaign (your uploads, approved website and repository pictures, licensed stock) and decides which picture each creative uses' : 'Hybrid Production: builds the Visual Direction Brief from the brand, the strategy, the style library and the references you may share');
      on('selector', 'Hybrid Production: chooses a library template for every planned template creative');
    }
    on('templateReviewer', 'Hybrid Production: opens every template creative and checks it against the plan, its lineage and its size');
  }
  return plan;
}

/** What a run is expected to cost, for the preflight. Counts only: no price is ever computed. */
export function estimateCreativeRun(o: { concepts: number; landing: boolean; imageGeneration: boolean; maxImages: number; maxRegenerations: number; maxLayoutsPerConcept: number; maxRepairRounds: number; visionReviews: number; maxModelCalls: number; channels: number; depth?: boolean; variations?: { target: number; expectedLayouts: number; planChunk: number }; /** Hybrid Production: optional model calls of the Visual Researcher and the Template Selector. */ extraCalls?: number }) {
  const images = o.imageGeneration ? (o.variations ? o.variations.target : Math.min(o.maxImages, o.concepts)) : 0;
  const planCalls = o.imageGeneration ? (o.variations ? Math.max(1, Math.ceil(images / Math.max(1, o.variations.planChunk))) : 1) : 0;
  const base = 1 + (o.landing ? 1 : 0) + planCalls; // copy + landing + visual planning
  const crossChecks = (o.landing ? 2 : 0) + (o.imageGeneration ? 1 : 0);
  const review = 1 + (o.visionReviews > 0 ? 1 : 0);
  // a real run almost always finds something to repair: one repair round (a revision per owner, then a second review) is the TYPICAL case
  const expectedRounds = Math.min(o.maxRepairRounds, 1);
  const typical = base + crossChecks + review + expectedRounds * ((o.landing ? 2 : 1) + review) + (o.depth && o.imageGeneration ? 1 : 0) + (o.extraCalls ?? 0);
  const repairs = o.maxRepairRounds * ((o.landing ? 2 : 1) + 1);
  const layouts = o.variations ? o.variations.expectedLayouts : Math.min(o.maxLayoutsPerConcept, 6) * o.concepts;
  return {
    textCalls: { typical: Math.min(typical, o.maxModelCalls), max: Math.min(typical + repairs, o.maxModelCalls), enforcedCap: o.maxModelCalls },
    imageRequests: { planned: images, max: images + (o.imageGeneration ? o.maxRegenerations : 0), regenerationEnabled: o.maxRegenerations > 0 && !o.variations },
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
  /** NO AI HYBRID: refused image-generation attempts (shared with the environment once the participants exist). */
  private readonly imageRefusals = { count: 0 };
  private reportRefusal: (() => void) | null = null;

  constructor(
    credentials: InferenceCredentials,
    private readonly config: CreativeRunConfig,
    private readonly sink: CreativeSink,
  ) {
    // never above what the chosen model supports (a limit that was not verified is capped conservatively)
    const analystTokens = capOutputTokens(config.model, clamp(config.maxOutputTokens, 800, 16000, 3000)).tokens;
    // THE NO AI HYBRID GUARANTEE at the orchestration layer: a campaign that never generates images cannot be started with an image model, an image
    // budget, an image generator or a continuation that asks for images. Refused here, before anything exists that could send a request.
    const noAi = isNoAi(config.hybrid?.settings);
    if (noAi) {
      const problems: string[] = [];
      if (config.imageModel?.trim()) problems.push('an image model was selected');
      if ((config.maxImages ?? 0) > 0) problems.push(`${config.maxImages} image request(s) were allowed`);
      if ((config.maxRegenerations ?? 0) > 0) problems.push('image regeneration was allowed');
      if (config.tools?.images) problems.push('an image generator was supplied');
      if (config.seed) problems.push('an image continuation was requested');
      if ((config.hybrid?.settings.originals ?? 0) > 0) problems.push('original AI images were planned');
      if (problems.length) throw new Error(`NO AI HYBRID never generates images, so this run was refused before anything was sent: ${problems.join('; ')}.`);
    }
    const imageGenerationOn = !noAi && !!config.imageModel?.trim();
    const variations = (config.variations === true || !!config.seed) && imageGenerationOn;
    // picture planning of several images per request needs a larger answer than one concept's copy
    const visualPlanTokens = variations ? capOutputTokens(config.model, Math.max(analystTokens, 9000)).tokens : analystTokens;
    const spend = scopeFor(config.ledger, config.spendCapUsd, 'F4');
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 2, 80, 16),
      maxOutputTokens: Math.max(analystTokens, visualPlanTokens),
      spend,
      // a cut-off answer is asked again with a larger cap (up to what the model supports) instead of failing the agent
      escalateTo: capOutputTokens(config.model, 16000).tokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    // in NO AI HYBRID the client itself refuses image requests (second layer under the orchestration check above)
    const client = new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl, forbidImages: noAi, onImageRefused: () => {
      this.imageRefusals.count++;
      this.reportRefusal?.();
    } });
    this.gateway = new InferenceGateway(client, budget);
    const formats = formatsForChannels(config.input.channels, clamp(config.maxLayoutsPerConcept, 1, 6, 4));
    const imageGeneration = !noAi && !!config.imageModel?.trim();
    const maxRegenerations = clamp(config.maxRegenerations, 0, 5, 0);
    const imageTarget = variations ? clamp(config.maxImages, 0, 40, config.input.concepts) : Math.min(clamp(config.maxImages, 0, 10, config.input.concepts), config.input.concepts);
    const imageConcurrency = clamp(config.imageConcurrency, 1, 4, 2);
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
      imageSizeExplicit: config.imageSize !== undefined,
      allowRegeneration: maxRegenerations > 0,
      maxLayoutsPerConcept: formats.length,
      formats,
      depth: config.depth === true,
      variations,
      imageTarget: variations ? imageTarget : Math.min(imageTarget, config.input.concepts),
      imageConcurrency,
      layoutsPerOriginal: clamp(config.layoutsPerOriginal, 1, 6, 3),
      maxVariants: variations ? clamp(config.maxVariants, 6, 30, 24) : 12,
      visualPlanTokens,
      channelPriority: config.f3.report.channels.map((c) => c.channel as ChannelId),
      approvedBudgetUsd: spend.approvedUsd,
      hybrid: config.hybrid?.settings ?? null,
      noAiImages: noAi,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 150_000),
      // 20 originals at a few in flight need far longer than 3: the default grows with the number of images (and stays bounded)
      visualTimeoutMs: clamp(config.visualTimeoutMs, 50, 1_800_000, variations ? Math.min(1_800_000, Math.max(420_000, Math.ceil(imageTarget / imageConcurrency) * (clamp(config.imageTimeoutMs, 50, 600_000, DEFAULT_IMAGE_LIMITS.timeoutMs) + 20_000) + 150_000)) : 420_000),
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 90_000),
      repairTimeoutMs: clamp(config.repairTimeoutMs, 50, 600_000, 120_000),
      productionTimeoutMs: 0,
      fixtureSources: config.fixtureSources === true,
      now: config.now ?? new Date(),
    };
    this.settings.productionTimeoutMs = clamp(config.productionTimeoutMs, 100, 2_000_000, this.settings.visualTimeoutMs + this.settings.agentTimeoutMs + 60_000);
    // a run that has no campaign ledger of its own (a direct creative run or an image-only continuation) protects its required originals
    // and caps its image requests itself; inside a factory run the orchestrator did both for the whole campaign
    if (!config.ledger && imageGeneration) {
      const unit = imageCostEstimate(this.settings.imageModel, this.settings.imageQuality, this.settings.imageSize).usd;
      spend.setImagePlan?.(imageTarget, unit, 'published');
      spend.setMaxImageRequests?.(imageTarget + (variations ? 0 : maxRegenerations));
    }
    const images = noAi
      ? null
      : config.tools?.images !== undefined
        ? config.tools.images
        : imageGeneration
          ? new ImageGenerator(client, {
              maxImages: imageTarget,
              spend,
              maxRegenerations: variations ? 0 : maxRegenerations,
              timeoutMs: clamp(config.imageTimeoutMs, 50, 600_000, DEFAULT_IMAGE_LIMITS.timeoutMs),
              maxRetries: DEFAULT_IMAGE_LIMITS.maxRetries,
              retryBaseDelayMs: clamp(config.imageRetryBaseDelayMs, 1, 60_000, DEFAULT_IMAGE_LIMITS.retryBaseDelayMs),
            })
          : null;
    this.tools = { images, assets: config.assets };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 3_600_000, variations ? 3_300_000 : 1_500_000);
    this.plan = planF4(config.input, imageGeneration, config.seed ? `Reused from campaign ${config.seed.parentCampaignId}: an image-only continuation does not write copy again` : null, !!config.hybrid, noAi);
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
    // the approved campaign design is the ONE source of the palette and of the templates: everything below reads these, nothing re-derives them
    const design = c.hybrid?.settings.design ?? null;
    const collection = design ? (getCollection(design.collectionId) ?? null) : null;
    const palette = design ? designBrandColors(design.palette) : c.palette?.length ? c.palette : ['#1f2937', '#0f172a'];
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
      palette,
      hasBrandPalette: design ? true : c.hasBrandPalette === true,
      logo: c.logo ?? null,
      agents: new Map(),
      seed: c.seed ?? null,
      hybrid: c.hybrid
        ? {
            library: collection ? themedTemplates(collection) : TEMPLATE_LIBRARY,
            libraryVersion: LIBRARY_VERSION,
            brandName: c.f3.report.productContext.name || c.input.projectName,
            brandImages: c.hybrid.brandImages ?? [],
            referencePalettes: c.hybrid.referencePalettes ?? {},
            industryText: '',
            design,
            collection,
            anchors: design ? designAnchors(design.palette) : null,
            discovery: c.hybrid.discovery ?? null,
            acquire: c.hybrid.acquire ?? null,
            discoveredBefore: c.hybrid.discoveredBefore ?? 0,
          }
        : null,
      imageRefusals: this.imageRefusals,
      brand: c.brand ?? null,
      visualBrief: buildVisualBrief(c.f1, c.f3, c.input, palette),
      createFixer: () => {
        const agent = buildFixer(env);
        env.agents.set('fixer', agent);
        return agent;
      },
    };
    this.env = env;
    // a refusal by the OpenAI client itself is reported as a safe event too (no prompt, no key, no provider text)
    this.reportRefusal = () => {
      if (!ctx.isClosed()) ctx.emit('image.generation.refused', { agent: null, reason: 'no_ai_hybrid', count: this.imageRefusals.count }, ctx.orchestrator);
    };
    if (env.hybrid) env.hybrid.industryText = industryTextOf(env.visualBrief);
    if (c.seed) {
      // an image-only continuation starts from what the earlier campaign has: nothing is written or planned again
      const s = c.seed;
      board.concepts = structuredClone(s.concepts);
      board.variants = structuredClone(s.variants);
      board.landing = s.landing ? structuredClone(s.landing) : null;
      board.allocation = structuredClone(s.allocation);
      for (const a of s.assets) board.assets.push(structuredClone(a));
      for (const l of s.layouts) board.layouts.push(structuredClone(l));
      for (const v of s.variations) board.variations.push(structuredClone(v));
      if (s.hybrid) {
        // Hybrid continuation: the earlier direction, selection and the creatives that were rendered with their planned picture are reused
        board.direction = s.hybrid.direction ? structuredClone(s.hybrid.direction) : null;
        board.selection = s.hybrid.selection ? structuredClone(s.hybrid.selection) : null;
        for (const t of s.hybrid.creatives) board.templateCreatives.push(structuredClone(t));
        if (board.selection) board.hybridPlan = { allocation: board.allocation!, slots: slotsFromSelection(board.selection.items), perConcept: [], rules: [], warnings: [] };
      }
      board.seedCounters();
    }
    const pre = [
      { kind: 'f1_report' as const, label: `F1 Product Discovery report ${c.f1.reportId}`, text: `f1_report_id: ${c.f1.reportId}\nproduct: ${c.f1.report.productManifest.name}\npartial: ${c.f1.partial}` },
      { kind: 'f2_audit' as const, label: `F2 Marketing Audit ${c.f2.auditId}`, text: `f2_audit_id: ${c.f2.auditId}\nbuilt_on_f1_report: ${c.f2.f1ReportId}\npartial: ${c.f2.partial}` },
      { kind: 'f3_strategy' as const, label: `F3 Campaign Strategy ${c.f3.strategyId}`, text: `f3_strategy_id: ${c.f3.strategyId}\nbuilt_on_f1_report: ${c.f3.f1ReportId}\nbuilt_on_f2_audit: ${c.f3.f2AuditId}\npartial: ${c.f3.partial}` },
    ].map((p) => this.store.add({ kind: p.kind, label: p.label, url: null, status: 'retrieved', live: false, fixture: false, httpStatus: null, bytes: null, error: null, producer: 'Creative Coordinator', origin: 'previous_phase' }, p.text));

    const builders: Record<string, (e: F4Env) => PhaseAgent> = { copywriter: buildCopywriter, visual: buildVisual, layout: buildLayout, landing: buildLanding, reviewer: buildReviewer, ...(c.hybrid ? { researcher: buildResearcher, selector: buildSelector, templateReviewer: buildTemplateReviewer } : {}) };
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

  /** Where the quality work stood when the campaign was saved: what was checked and scored, what was repaired, what was left out and why. */
  private qualityDiagnostic(snap: ReturnType<CreativeBoardStore['snapshot']>, status: 'approved' | 'approved_with_notes' | 'unresolved', repairRounds: number, usage: UsageSnapshot): QualityDiagnostic {
    const { settings } = this;
    const fixed = snap.findings.filter((f) => f.status === 'fixed').length;
    const unresolved = snap.findings.filter((f) => f.status === 'unresolved').length;
    const skipped = [...snap.skipped];
    if (!settings.depth) skipped.push({ what: 'concept critique before the images', reason: 'not part of this preset (the Full Production preset runs it)' });
    if (!settings.visionReviews) skipped.push({ what: 'vision review of the exported images', reason: 'visionReviews is 0 in this configuration; the images were checked by measurement only' });
    const cc = snap.conceptReview;
    const latest = snap.rubrics.at(-1)?.scores ?? null;
    return {
      reviewRounds: snap.round,
      repairRounds,
      conceptCritique: cc
        ? {
            ran: true,
            modelReview: cc.modelReview,
            flagged: cc.flagged.length,
            revised: cc.revised.length,
            scores: (cc.critique?.concepts ?? []).map((x) => ({ conceptId: x.conceptId, conceptName: snap.concepts.find((k) => k.id === x.conceptId)?.name ?? x.conceptId, specificity: x.specificity, originality: x.originality, audienceFit: x.audienceFit, visualPotential: x.visualPotential, verdict: x.verdict })),
            note: cc.note,
          }
        : null,
      rubric: { criteria: [...RUBRIC_CRITERIA], latest, history: snap.rubrics },
      findings: { total: snap.findings.length, deterministic: snap.findings.filter((f) => f.source === 'deterministic').length, fromModel: snap.findings.filter((f) => f.source !== 'deterministic').length, fixed, open: snap.findings.filter((f) => f.status === 'open').length, unresolved },
      truncatedAnswersRetried: usage.escalations,
      skipped,
      verdict: `${status}: ${snap.round} review round(s), ${repairRounds} repair round(s), ${fixed} finding(s) fixed, ${unresolved} unresolved${latest ? `; lowest rubric score ${Math.min(...Object.values(latest))} of 5` : ''}.`,
    };
  }

  /** What this run cost, as far as it can be known: provider-reported usage at the price book of PRICE_BOOK_VERIFIED_AT. Never an invoice. */
  private costReport(usage: UsageSnapshot, img: ImageUsageSnapshot | null): CostReport {
    const sp = usage.spend;
    const priced = textPrice(this.config.model) !== null;
    return {
      currency: 'USD',
      priceBookVerifiedAt: PRICE_BOOK_VERIFIED_AT,
      approvedUsd: sp?.approvedUsd ?? null,
      spentUsd: sp?.spentUsd ?? 0,
      uncertainUsd: sp?.uncertainUsd ?? 0,
      textUsd: sp?.text.spentUsd ?? 0,
      imageUsd: this.settings.noAiImages ? 0 : (img?.costUsd ?? (sp && sp.image.requests ? sp.image.spentUsd : null)),
      unpricedRequests: sp?.unpriced ?? 0,
      blockedRequests: (sp?.blocked ?? 0),
      note: `Computed from the usage OpenAI reported, at the published prices of ${PRICE_BOOK_VERIFIED_AT}${priced ? '' : `; there is no verified price for ${this.config.model}, so its text cost is not included`}. An application-side figure, not an OpenAI invoice: a request that timed out may still be billed (counted as uncertain).`,
    };
  }

  private buildPackage(ctx: RunContext, why: string, modelReviewFailed: boolean) {
    const { config: c, settings } = this;
    const snap = ctx.state.f4.snapshot();
    const usage = this.gateway.usage();
    const imgUsage = this.tools.images?.usage() ?? null;
    const failedAgents = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
    const unresolved = snap.findings.filter((f) => f.status === 'unresolved' && (f.severity === 'blocker' || f.severity === 'major'));
    const minorOpen = snap.findings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && f.severity === 'minor');
    const planned = snap.allocation;
    const genCount = snap.variations.filter((v) => v.status === 'generated').length;
    const shortfall = settings.variations && !!planned && genCount < planned.target;
    const hybridCounts_ = settings.hybrid ? hybridCounts({ board: snap, imageRequests: imgUsage?.requestsStarted ?? 0, text: { calls: usage.total.calls, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens }, cost: this.costReport(usage, imgUsage), noAi: settings.noAiImages }) : null;
    const templateShort = !!hybridCounts_ && hybridCounts_.templates.rendered + hybridCounts_.templates.fallbackRendered < hybridCounts_.templates.planned;
    const status = unresolved.length ? ('unresolved' as const) : minorOpen.length || failedAgents.length || modelReviewFailed || shortfall || templateShort ? ('approved_with_notes' as const) : ('approved' as const);
    const rounds = Math.max(0, snap.round - 1);
    const note =
      status === 'approved'
        ? 'No blocker, major or minor issue remains after the review.'
        : status === 'unresolved'
          ? `${unresolved.length} blocker/major issue(s) could not be repaired within ${settings.maxRepairRounds} repair round(s); they are listed unchanged in the review findings.`
          : shortfall
            ? `Approved with notes: only ${genCount} of the ${planned!.target} requested original AI images exist (see the image list and the limitations).`
            : 'Approved with notes: minor issues or missing parts remain and are listed in the review findings and limitations.';
    const limitations = [...snap.limitations];
    // one result per concept: generated / failed / skipped, each with the reason (no concept silently shows a fallback)
    const baseAssetOf = (conceptId: string) => [...snap.assets].reverse().find((a) => a.conceptId === conceptId && a.kind === 'image' && a.status !== 'superseded')?.id ?? null;
    const visualStatus = snap.participantStatuses.find((s) => s.agent === CREATIVE_INFO.visual.name);
    const planningError = visualStatus?.state === 'failed' ? (visualStatus.error?.message ?? null) : null;
    // several originals per concept: one record per planned image (never fewer than were planned), the concept-level result derived from them
    const allocation = settings.variations ? snap.allocation : null;
    const imageVariations = allocation ? completeVariations({ allocation, records: snap.variations, concepts: snap.concepts, model: settings.imageModel, quality: settings.imageQuality, imageGeneration: settings.imageGeneration, planningError }) : [];
    const imageResults = allocation
      ? snap.concepts.map((cpt) => conceptResultFromVariations(cpt, imageVariations, settings.imageModel, baseAssetOf(cpt.id) ?? ''))
      : completeImageResults({ concepts: snap.concepts, results: snap.imageResults, baseAssetOf, imageGeneration: settings.imageGeneration, model: settings.imageModel, planningError });
    const imageCounts = allocation ? countVariations(imageVariations, allocation.target) : null;
    if (settings.noAiImages) {
      limitations.push('NO AI HYBRID: no AI image was generated or requested. Every creative is a template rendered locally from approved pictures or typography.');
      const img = snap.imagery;
      if (img && img.approved === 0) limitations.push('No approved picture was available, so every creative is text-first. Add pictures in the image gallery and continue to give the campaign photography.');
      if (hybridCounts_ && hybridCounts_.templates.rendered + hybridCounts_.templates.fallbackRendered < hybridCounts_.templates.planned) limitations.push(`PARTIAL CAMPAIGN: ${hybridCounts_.templates.rendered + hybridCounts_.templates.fallbackRendered} of the ${hybridCounts_.templates.planned} planned creatives were produced. The rest are blocked or failed and are listed with their reasons; nothing was faked to reach the number. Add pictures and continue (Product Discovery, the Audit and the Strategy are reused).`);
    } else if (!settings.imageGeneration) limitations.push('No image model was selected: layouts use brand-colored backgrounds, not generated pictures.');
    const noAi = imageResults.filter((r) => r.outcome !== 'generated');
    if (settings.imageGeneration && noAi.length) {
      limitations.push(`${noAi.length} of ${imageResults.length} concept(s) have NO AI-generated image; their layouts use a brand-colored background.`);
      for (const reason of distinctReasons(noAi)) limitations.push(reason);
    }
    if (imageCounts && imageCounts.generated < imageCounts.requested) {
      // never "complete" with fewer originals than were asked for: the count and the reasons are part of the package
      limitations.push(`${imageCounts.generated} of the ${imageCounts.requested} requested original AI images were generated (${imageCounts.failed} failed, ${imageCounts.blockedByBudget} stopped by a budget, ${imageCounts.skipped} not requested).`);
      for (const reason of distinctReasons(imageVariations.filter((v) => v.status !== 'generated').map((v) => ({ outcome: v.status, requestAttempted: v.requestAttempted, explanation: v.explanation })))) limitations.push(reason);
    }
    if (allocation?.warnings.length) for (const w of allocation.warnings) limitations.push(w);
    const imageShortfall = !!imageCounts && imageCounts.generated < imageCounts.requested;
    if (modelReviewFailed) limitations.push('The model-based review failed in at least one round; only the automatic checks were applied in that round.');
    if (!settings.visionReviews) limitations.push('The exported images were checked by measurement only (size, text fit, contrast, logo); no model looked at them.');
    if (snap.skippedLayouts.length) limitations.push(`${snap.skippedLayouts.length} layout(s) could not be produced cleanly and were not exported (see the format list).`);
    if (!c.hasBrandPalette) limitations.push(c.hybrid ? 'No brand colors were available: the palette comes from the built-in style library and is not presented as the brand\'s own.' : 'No brand colors were available: a neutral palette was used.');
    if (!c.input.websiteUrl) limitations.push('No website was supplied, so no destination link appears in any creative. The calls to action are proposals that name an action; add the real destination before publishing.');
    if (!c.logo) limitations.push('No logo was supplied: the business name is used as a text-based brand identity.');
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
      imageResults,
      imageAllocation: allocation,
      imageVariations,
      imageCounts,
      cost: this.costReport(usage, imgUsage),
      quality: this.qualityDiagnostic(snap, status, rounds, usage),
      hybrid: settings.hybrid && hybridCounts_ ? buildHybridBlock({ settings: settings.hybrid, libraryVersion: LIBRARY_VERSION, board: snap, counts: hybridCounts_, refusedImageRequests: this.imageRefusals.count, brand: c.brand ?? null }) : null,
      lineage: c.seed ? { kind: 'image_continuation', revision: c.seed.parentRevision + 1, parentCampaignId: c.seed.parentCampaignId, reusedAssets: c.seed.reusedAssets } : { kind: 'full', revision: 1, parentCampaignId: null, reusedAssets: 0 },
      channelLayouts: snap.layouts,
      skippedLayouts: snap.skippedLayouts,
      landingContent: snap.landing,
      reviewFindings: snap.findings as ReviewFindingRecord[],
      revisions: snap.revisions,
      approval: { status, rounds, unresolvedFindingIds: unresolved.map((f) => f.id), note },
      usage: {
        text: { calls: usage.total.calls, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, totalTokens: usage.total.inputTokens + usage.total.outputTokens, perAgent: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, { calls: v.calls, totalTokens: v.inputTokens + v.outputTokens, inputTokens: v.inputTokens, outputTokens: v.outputTokens, costUsd: textCostUsd(settings.model, { inputTokens: v.inputTokens, outputTokens: v.outputTokens, cachedInputTokens: v.cachedInputTokens }) }])) },
        images: { model: settings.imageModel, quality: settings.imageGeneration ? settings.imageQuality : null, size: settings.imageGeneration ? settings.imageSize : null, requested: imgUsage?.requestsStarted ?? 0, generated: imgUsage?.generated ?? 0, failed: imgUsage?.failed ?? 0, regenerations: imgUsage?.regenerationsStarted ?? 0, limits: { maxImages: imgUsage?.limits.maxImages ?? 0, maxRegenerations: imgUsage?.limits.maxRegenerations ?? 0 }, providerReportedTokens: imgUsage?.tokens ?? null, costUsd: imgUsage?.costUsd ?? null, blockedBySpend: imgUsage?.blockedBySpend ?? 0, rateLimited: imgUsage?.rateLimited ?? 0 },
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
