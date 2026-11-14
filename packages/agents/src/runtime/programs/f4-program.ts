import { campaignCopyPlan } from '../../copywriting/campaign';
import type { CopyPlan } from '../../copywriting/plan';
import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { SpendBudget, scopeFor } from '../../ai/budget';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { resolveGeneration, synthesisTaskTimeoutMs, writerOutputCap, type GenerationTimeout } from '../../ai/timeouts';
import { CLAUDE_PRICE_BOOK_VERIFIED_AT, PRICE_BOOK_VERIFIED_AT, capOutputTokens, textCostUsd, textPrice } from '../../ai/pricing';
import type { F1Context } from '../../audit/context';
import { SourceStore, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import type { AgentOutcome } from '../../factory/events';
import type { AssetStore } from '../../creative/assets';
import { CREATIVE_INFO, CREATIVE_KEYS, type CreativeBoard, type CreativeBoardStore, type CreativePlan, type CreativeSettingsSnapshot } from '../../creative/board';
import type { CreativeInput, F3Context } from '../../creative/context';
import { CAMPAIGN_SCHEMA_VERSION, CampaignPackage, RUBRIC_CRITERIA, CAMPAIGN_PLATFORMS, isCampaignPlatform, type CostReport, type DeliverablesBlock, type QualityDiagnostic, type ReviewFindingRecord } from '../../creative/schemas';
import { NO_IMAGE_USAGE } from '../../creative/legacy-schemas';
import { buildVisualBrief } from '../../creative/visual-brief';
import { industryTextOf } from '../../hybrid/direction';
import { MAX_DELIVERABLES, folderOf } from '../../hybrid/deliverables';
import { buildHybridBlock, hybridCounts } from '../../hybrid/report';
import { DEFAULT_HYBRID_SETTINGS, type HybridSettings } from '../../hybrid/settings';
import { designAnchors, designBrandColors } from '../../collections/design';
import { getCollection, themedTemplates } from '../../collections/registry';
import type { VisualDiscoveryPort } from '../../imagery/discovery';
import { LIBRARY_VERSION, TEMPLATE_LIBRARY } from '../../templates/library';
import { CRITICAL_CHECKS } from '../../templates/preflight';
import type { ChannelId } from '../../strategy/channels';
import { ParticipantRegistry } from '../participant-registry';
import { createTextTransport, type InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { buildResearcher, buildReviewer, buildWriter } from './f4/agents';
import { CreativeCoordinator } from './f4/coordinator';
import { buildDesigner } from './f4/designer';
import type { BrandContext, BrandImage, F4Env, F4Settings, F4Tools, ImageAcquirePort } from './f4/env';
import type { PhaseAgent } from './f1/agent';
import { clamp } from './smoke-program';

const PHASE = 'F4_CREATIVE_PRODUCTION' as const;

export interface CreativeRunConfig {
  /** The id of the campaign row the backend created for this run; assets are stored under it as they are produced. */
  campaignId: string;
  projectId: string;
  /** The exact Business Research -> Strategy chain the campaign is built on (the backend checks they belong together). */
  f1: F1Context;
  f3: F3Context;
  input: CreativeInput;
  /** Explicit text model chosen by the user in Settings. Never defaulted or switched. */
  model: string;
  /** The approved spending limit in US dollars for THIS run; null/absent = none. Enforced before every paid request. */
  spendCapUsd?: number | null;
  /** The campaign-wide spend ledger shared by every phase (the factory passes it). Absent = this run gets a ledger of its own with `spendCapUsd`. */
  ledger?: SpendBudget;
  /** The visual settings: the approved campaign design (collection, palette), facts, references, picture sourcing. Default: no design. */
  design?: HybridSettings | null;
  /** The project's approved pictures (read, rights-checked and size-limited by the backend). */
  brandImages?: BrandImage[];
  /** Palettes the backend extracted from reference images the USER owns, by reference id. */
  referencePalettes?: Record<string, string[]>;
  /** Licensed picture search (configured providers only). */
  discovery?: VisualDiscoveryPort | null;
  /** Adds a licensed picture during the run (automatic stock mode only). */
  acquire?: ImageAcquirePort | null;
  /** How many picture candidates the image gallery already knows before the run (reported only). */
  discoveredBefore?: number;
  /** Brand content the owner approved with Get Content (logo, photographs). null/absent = Get Content was not used. */
  brand?: BrandContext | null;
  /** Brand colors (#rrggbb) used when there is no approved design palette. */
  palette?: string[];
  hasBrandPalette?: boolean;
  logo?: Buffer | null;
  assets: AssetStore;
  /** Repair rounds after the first review. Default 1, at most 2. */
  maxRepairRounds?: number;
  /** Rendered creatives the Quality Reviewer may SEE with the model per round. Default 2, at most 6 (0 = off). */
  visionReviews?: number;
  /** Hard cap on text-model calls for the whole run. Default 8. */
  maxModelCalls?: number;
  /** Output cap of the Content Writer's answer (the posts of every platform plus ads and print need room). Default 9000. */
  maxOutputTokens?: number;
  agentTimeoutMs?: number;
  sourcingTimeoutMs?: number;
  designTimeoutMs?: number;
  reviewTimeoutMs?: number;
  repairTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Scales the clock of the Content Writer's long answer with its output cap (default: on, unless callTimeoutMs is fixed). Tests may tune it. */
  generation?: Partial<GenerationTimeout>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Test seam: base URL of the provider API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  /** TESTS ONLY. */
  fixtureSources?: boolean;
  now?: Date;
}

export interface CreativeReportMeta {
  schemaVersion: number;
  model: string;
  provider: 'openai' | 'anthropic';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  settings: CreativeSettingsSnapshot | null;
  plan: CreativePlan;
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  summaries: Record<string, string>;
  aiCalls: Record<string, number>;
  why: string;
  modelReviewFailed: boolean;
  chain: { f1ReportId: string; f3StrategyId: string };
  inputSnapshot: CreativeInput;
}

export type CreativeSink = (pkg: CampaignPackage, meta: CreativeReportMeta) => Promise<void>;

/** The creative team. Every agent runs in every campaign; nothing is optional and no agent is created on demand. */
export function planF4(): CreativePlan {
  const reasons: Record<(typeof CREATIVE_KEYS)[number], string> = {
    writer: 'Always runs: concepts on the strategy, platform posts, ad and print copy',
    researcher: 'Always runs: visual direction, approved and licensed pictures with their rights',
    designer: 'Always runs: renders every planned deliverable from the approved collection (no model call)',
    reviewer: 'Always runs: checks, one text review and bounded corrections',
  };
  return { activated: CREATIVE_KEYS.map((key) => ({ agent: CREATIVE_INFO[key].name, key, reason: reasons[key] })), skipped: [] };
}

/** What a run is expected to need, for the preflight. Counts only: the backend prices them. */
export function estimateCreativeRun(o: { concepts: number; platforms?: number; maxRepairRounds: number; visionReviews: number; maxModelCalls: number }) {
  const vision = o.visionReviews > 0 ? 1 : 0;
  const review = 1 + vision;
  // copy + first review, and (typically) one repair round: one revision + one re-review
  const typical = 1 + review + Math.min(o.maxRepairRounds, 1) * (1 + review);
  const max = 1 + review + o.maxRepairRounds * (1 + review);
  const platforms = o.platforms ?? CAMPAIGN_PLATFORMS.length;
  // social posts + three 2 x 2 matrices (web banner, display ad, billboard) + two flyers
  const deliverables = Math.min(MAX_DELIVERABLES, o.concepts * platforms + 3 * 2 * Math.min(2, o.concepts) + 2);
  return {
    textCalls: { typical: Math.min(typical, o.maxModelCalls), max: Math.min(max, o.maxModelCalls), enforcedCap: o.maxModelCalls },
    imageRequests: { planned: 0, max: 0 },
    deliverables: { planned: deliverables, note: 'Rendered locally from the approved collection; no model call, no image generation, no cost.' },
  };
}

/**
 * F4 Creative Production, the last stage of the one campaign workflow: the Content Writer writes, the Visual Researcher finds the approved
 * pictures, the Creative Designer renders every deliverable locally, the Quality Reviewer checks and requests bounded corrections. There is
 * NO image generator in this program: no request of any kind can produce an AI image.
 */
export class F4Program implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: F4Settings;
  private readonly tools: F4Tools;
  private readonly store = new SourceStore();
  private readonly plan: CreativePlan;
  /** The campaign's copywriting plan, built once when the participants join (deterministic). */
  private copyPlan: CopyPlan | null = null;

  constructor(
    credentials: InferenceCredentials,
    private readonly config: CreativeRunConfig,
    private readonly sink: CreativeSink,
  ) {
    // the Content Writer answers for every platform at once: its FIRST request gets room for the answer this campaign really needs (a cut-off
    // answer is billed and useless, and asking again doubles the cost), never above what the chosen model supports
    const platforms = config.input.channels.filter(isCampaignPlatform);
    const needed = writerOutputCap({ concepts: config.input.concepts, platforms: platforms.length, tiktok: platforms.includes('tiktok'), leadConcepts: Math.min(2, config.input.concepts) }, clamp(config.maxOutputTokens, 2000, 16000, 9000), 16000);
    const writerTokens = capOutputTokens(config.model, needed).tokens;
    const generation = resolveGeneration(config.generation, config.callTimeoutMs !== undefined);
    const spend = scopeFor(config.ledger, config.spendCapUsd, 'F4');
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 2, 20, 8),
      maxOutputTokens: writerTokens,
      spend,
      // a cut-off answer is asked again with a larger cap (up to what the model supports) instead of failing the agent
      escalateTo: capOutputTokens(config.model, 16000).tokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      // the Content Writer's answer is a long structured answer: its clock grows with its output cap (as F1's and F3's final documents)
      generation,
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    // text only: the transport is told to refuse any image request
    this.gateway = new InferenceGateway(createTextTransport(credentials, { baseUrl: config.baseUrl }).transport, budget);
    this.settings = {
      model: config.model,
      writerTokens,
      reviewTokens: Math.min(2400, writerTokens),
      maxModelCalls: budget.maxModelCalls,
      maxRepairRounds: clamp(config.maxRepairRounds, 0, 2, 1),
      visionReviews: clamp(config.visionReviews, 0, 6, 2),
      visual: config.design ?? structuredClone(DEFAULT_HYBRID_SETTINGS),
      approvedBudgetUsd: spend.approvedUsd,
      agentTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 240_000),
      writerTimeoutMs: clamp(config.agentTimeoutMs, 50, 600_000, 240_000),
      revisionTokens: Math.min(6000, writerTokens),
      sourcingTimeoutMs: clamp(config.sourcingTimeoutMs, 50, 300_000, 100_000),
      designTimeoutMs: clamp(config.designTimeoutMs, 50, 900_000, 300_000),
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 120_000),
      repairTimeoutMs: clamp(config.repairTimeoutMs, 50, 600_000, 180_000),
      fixtureSources: config.fixtureSources === true,
      now: config.now ?? new Date(),
    };
    // the writer's task covers its first request and, when that answer is cut off by its cap, ONE larger request (synthesisTaskTimeoutMs)
    if (generation) {
      this.settings.writerTimeoutMs = Math.max(this.settings.writerTimeoutMs, synthesisTaskTimeoutMs(writerTokens, budget.escalateTo, generation));
      this.settings.repairTimeoutMs = Math.max(this.settings.repairTimeoutMs, synthesisTaskTimeoutMs(this.settings.revisionTokens, undefined, generation));
    }
    this.tools = { assets: config.assets };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 3_600_000, 1_800_000);
    this.plan = planF4();
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort();
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
          ctx.emit('phase.started', { phase: PHASE, agents: this.plan.activated.map((a) => a.agent), plan: this.plan }, ctx.orchestrator);
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
    const design = this.settings.visual.design;
    const collection = design ? (getCollection(design.collectionId) ?? null) : null;
    const palette = design ? designBrandColors(design.palette) : c.palette?.length ? c.palette : ['#1f2937', '#0f172a'];
    const visualBrief = buildVisualBrief(c.f1, c.f3, c.input, palette);
    const copyPlan = campaignCopyPlan({ f1: c.f1, f3: c.f3, input: c.input, collectionId: design?.collectionId ?? null, facts: this.settings.visual.facts });
    this.copyPlan = copyPlan;
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
      visualBrief,
      hybrid: {
        library: collection ? themedTemplates(collection) : TEMPLATE_LIBRARY,
        libraryVersion: LIBRARY_VERSION,
        brandName: c.f3.report.productContext.name || c.input.projectName,
        brandImages: c.brandImages ?? [],
        referencePalettes: c.referencePalettes ?? {},
        industryText: industryTextOf(visualBrief),
        design,
        collection,
        anchors: design ? designAnchors(design.palette) : null,
        discovery: c.discovery ?? null,
        acquire: c.acquire ?? null,
        discoveredBefore: c.discoveredBefore ?? 0,
      },
      brand: c.brand ?? null,
      copyPlan,
    };
    const pre = [
      { kind: 'f1_report' as const, label: `Business research ${c.f1.reportId}`, text: `f1_report_id: ${c.f1.reportId}\nproduct: ${c.f1.report.productManifest.name}\npartial: ${c.f1.partial}` },
      { kind: 'f3_strategy' as const, label: `Campaign strategy ${c.f3.strategyId}`, text: `f3_strategy_id: ${c.f3.strategyId}\nbuilt_on_f1_report: ${c.f3.f1ReportId}\npartial: ${c.f3.partial}` },
    ].map((p) => this.store.add({ kind: p.kind, label: p.label, url: null, status: 'retrieved', live: false, fixture: false, httpStatus: null, bytes: null, error: null, producer: 'Creative Coordinator', origin: 'previous_phase' }, p.text));

    const builders: Record<(typeof CREATIVE_KEYS)[number], (e: F4Env) => PhaseAgent> = { writer: buildWriter, researcher: buildResearcher, designer: buildDesigner, reviewer: buildReviewer };
    const registry = new ParticipantRegistry();
    for (const key of CREATIVE_KEYS) {
      registry.register({
        phase: PHASE,
        name: CREATIVE_INFO[key].name,
        create: () => {
          const agent = builders[key](env);
          env.agents.set(key, agent);
          return agent.participant;
        },
      });
    }
    const joined = registry.forPhase(PHASE).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));
    const coordinator = new CreativeCoordinator(env, this.plan, pre);
    return [coordinator.participant, ...joined];
  }

  // ---- the Campaign Package ----------------------------------------------------------------------------------------

  private qualityDiagnostic(snap: CreativeBoard, status: 'approved' | 'approved_with_notes' | 'unresolved', repairRounds: number, usage: UsageSnapshot): QualityDiagnostic {
    const fixed = snap.findings.filter((f) => f.status === 'fixed').length;
    const unresolved = snap.findings.filter((f) => f.status === 'unresolved').length;
    const latest = snap.rubrics.at(-1)?.scores ?? null;
    return {
      reviewRounds: snap.round,
      repairRounds,
      conceptCritique: null,
      rubric: { criteria: [...RUBRIC_CRITERIA], latest, history: snap.rubrics },
      findings: { total: snap.findings.length, deterministic: snap.findings.filter((f) => f.source === 'deterministic').length, fromModel: snap.findings.filter((f) => f.source !== 'deterministic').length, fixed, open: snap.findings.filter((f) => f.status === 'open').length, unresolved },
      truncatedAnswersRetried: usage.escalations,
      skipped: [...snap.skipped],
      verdict: `${status}: ${snap.round} review round(s), ${repairRounds} repair round(s), ${fixed} finding(s) fixed, ${unresolved} unresolved${latest ? `; lowest rubric score ${Math.min(...Object.values(latest))} of 5` : ''}.`,
    };
  }

  /** What this run cost, as far as it can be known: provider-reported usage at the published price book. Never an invoice. */
  private costReport(usage: UsageSnapshot): CostReport {
    const sp = usage.spend;
    const priced = textPrice(this.config.model) !== null;
    const claude = this.gateway.provider === 'anthropic';
    const vendor = claude ? 'Anthropic' : 'OpenAI';
    const book = claude ? CLAUDE_PRICE_BOOK_VERIFIED_AT : PRICE_BOOK_VERIFIED_AT;
    return {
      currency: 'USD',
      priceBookVerifiedAt: book,
      approvedUsd: sp?.approvedUsd ?? null,
      spentUsd: sp?.spentUsd ?? 0,
      uncertainUsd: sp?.uncertainUsd ?? 0,
      textUsd: sp?.text.spentUsd ?? 0,
      imageUsd: 0,
      unpricedRequests: sp?.unpriced ?? 0,
      blockedRequests: sp?.blocked ?? 0,
      note: `Computed from the usage ${vendor} reported, at the published ${vendor} API prices of ${book}${priced ? '' : `; there is no verified price for ${this.config.model}, so its text cost is not included`}. No image was generated (image cost $0). An application-side figure, not an ${vendor} invoice: a request that timed out may still be billed (counted as uncertain).`,
    };
  }

  /** What became of every planned deliverable (delivered, or missing with the reason). */
  private deliverablesBlock(snap: CreativeBoard): DeliverablesBlock {
    const slots = snap.hybridPlan?.slots ?? [];
    // a file existing is not "ready to publish": a critical design problem or an open blocker/major finding on the creative or its copy blocks it
    const readiness = (delivered: boolean, tc: CreativeBoard['templateCreatives'][number] | undefined, variantId: string | null) => {
      if (!delivered || !tc) return { quality: null, publishReady: false, blockers: [] as string[] };
      const open = snap.findings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && (f.assetRef === tc.assetId || (!!variantId && f.assetRef === variantId)));
      const blocking = open.filter((f) => f.severity === 'blocker' || f.severity === 'major');
      const critical = (tc.design?.checks ?? []).filter((c) => c.status === 'fail' && CRITICAL_CHECKS.has(c.id));
      const blockers = [...critical.map((c) => c.detail), ...blocking.map((f) => f.finding)].map((x) => x.slice(0, 200)).slice(0, 8);
      const status = tc.design?.status ?? null;
      const quality = blockers.length || status === 'unresolved' ? ('unresolved' as const) : status === 'warnings' || open.length ? ('passed_with_warnings' as const) : status === 'passed' ? ('passed' as const) : ('produced' as const);
      return { quality, publishReady: quality === 'passed' || quality === 'passed_with_warnings', blockers };
    };
    const items = slots.map((s) => {
      const tc = snap.templateCreatives.find((t) => t.slotId === s.slotId);
      const delivered = !!tc?.assetId && (tc.status === 'rendered' || tc.status === 'fallback_rendered');
      const variantId = snap.selection?.items.find((i) => i.slotId === s.slotId)?.content.variantId ?? null;
      return {
        id: s.slotId,
        kind: s.kind ?? 'social_post',
        label: s.label ?? s.formatId,
        conceptId: s.conceptId,
        channel: s.channel,
        format: tc?.format ?? s.formatId,
        width: tc?.width ?? s.width,
        height: tc?.height ?? s.height,
        folder: s.folder ?? folderOf(s.kind ?? 'social_post', s.channel),
        status: delivered ? ('delivered' as const) : ('missing' as const),
        design: delivered ? (tc!.design?.status ?? null) : null,
        assetId: delivered ? tc!.assetId : null,
        variantId,
        withPicture: delivered && (tc!.sourceAssetIds.length > 0),
        reason: delivered ? null : (tc?.reason ?? 'Not produced.'),
        ...readiness(delivered, tc, variantId),
        matrix: s.matrix ? { group: s.matrix.group, design: s.matrix.design, copy: s.matrix.copy, shared: tc?.design?.matrix?.shared ?? false } : null,
      };
    });
    const delivered = items.filter((i) => i.status === 'delivered');
    return {
      version: 1,
      platforms: snap.platforms as ChannelId[],
      items,
      notPlanned: snap.notPlanned,
      rules: snap.hybridPlan?.rules ?? [],
      counts: { planned: items.length, delivered: delivered.length, missing: items.length - delivered.length, withPicture: delivered.filter((i) => i.withPicture).length, typographyFirst: delivered.filter((i) => !i.withPicture).length, publishReady: delivered.filter((i) => i.publishReady).length, needsReview: delivered.filter((i) => !i.publishReady).length },
    };
  }

  private buildPackage(ctx: RunContext, why: string, modelReviewFailed: boolean) {
    const { config: c, settings } = this;
    const snap = ctx.state.f4.snapshot();
    const usage = this.gateway.usage();
    const cost = this.costReport(usage);
    const failedAgents = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
    const unresolved = snap.findings.filter((f) => f.status === 'unresolved' && (f.severity === 'blocker' || f.severity === 'major'));
    const minorOpen = snap.findings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && f.severity === 'minor');
    const deliverables = this.deliverablesBlock(snap);
    const short = deliverables.counts.missing > 0 || deliverables.notPlanned.length > 0;
    const status = unresolved.length ? ('unresolved' as const) : minorOpen.length || failedAgents.length || modelReviewFailed || short ? ('approved_with_notes' as const) : ('approved' as const);
    const rounds = Math.max(0, snap.round - 1);
    const note =
      status === 'approved'
        ? 'No blocker, major or minor issue remains after the review, and every planned deliverable exists.'
        : status === 'unresolved'
          ? `${unresolved.length} blocker/major issue(s) could not be repaired within ${settings.maxRepairRounds} repair round(s); they are listed unchanged in the review findings.`
          : short
            ? `Approved with notes: ${deliverables.counts.delivered} of ${deliverables.counts.planned} planned deliverables exist${deliverables.notPlanned.length ? ` and ${deliverables.notPlanned.length} could not be planned` : ''}; each missing one is listed with the reason.`
            : 'Approved with notes: minor issues or missing parts remain and are listed in the review findings and limitations.';
    const limitations = [...snap.limitations];
    limitations.push('No AI image was generated or requested. Every creative is a template rendered locally from approved pictures or typography.');
    if (snap.imagery && snap.imagery.approved === 0) limitations.push('No approved picture was available, so every creative is typography-first. Add pictures in the image gallery (or approve website pictures with Get Content) to give the campaign photography.');
    if (deliverables.counts.needsReview) limitations.push(`NOT READY TO PUBLISH: ${deliverables.counts.needsReview} of the ${deliverables.counts.delivered} delivered creatives still have a critical problem after the automatic repairs (listed under "Needs review" in the README); they are in the ZIP for inspection only.`);
    if (deliverables.counts.missing) limitations.push(`PARTIAL: ${deliverables.counts.delivered} of the ${deliverables.counts.planned} planned deliverables were produced. The rest are listed with their reasons; nothing was faked to reach the number.`);
    limitations.push('TikTok: a 9:16 cover image and a video concept/script are delivered; no video was produced.');
    if (deliverables.items.some((i) => i.status === 'delivered' && (i.kind === 'billboard' || i.kind === 'flyer'))) limitations.push('Print: billboards and flyers are PNG files at the planned pixel size, not print-ready PDFs (no bleed, crop marks or CMYK conversion). Ask the printer for their specification and check the contact details before printing.');
    if (this.copyPlan?.voice.evidenceConfidence === 'low') limitations.push('The brand voice was inferred from little evidence (a cautious default). Set the writing style in the campaign setup to make the copy sound like the brand.');
    if (modelReviewFailed) limitations.push('The model review failed in at least one round; only the automatic checks were applied in that round.');
    if (!settings.visionReviews) limitations.push('The rendered creatives were checked by measurement only (size, text fit, contrast, logo); no model looked at them.');
    if (!design(c) && !c.hasBrandPalette) limitations.push('No brand colors were available: the palette comes from the template library and is not presented as the brand\'s own.');
    if (!c.input.websiteUrl) limitations.push('No website was supplied, so no destination link appears in any creative. Add the real destination before publishing.');
    if (!c.logo) limitations.push('No logo was supplied: the business name is used as a text-based brand identity.');
    const counts = hybridCounts({ board: snap, text: { calls: usage.total.calls, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens }, cost });
    const pkg: CampaignPackage = {
      id: c.campaignId,
      projectId: c.projectId,
      runId: ctx.runId,
      f1ReportId: c.f1.reportId,
      f2ReportId: null,
      f3StrategyId: c.f3.strategyId,
      schemaVersion: CAMPAIGN_SCHEMA_VERSION,
      campaignName: `${c.f3.report.productContext.name} — marketing campaign`.slice(0, 120),
      language: c.input.language,
      concepts: snap.concepts,
      copyVariants: snap.variants,
      imageAssets: snap.assets,
      deliverables,
      copywriting: this.copyPlan,
      cost,
      quality: this.qualityDiagnostic(snap, status, rounds, usage),
      hybrid: buildHybridBlock({ settings: settings.visual, libraryVersion: LIBRARY_VERSION, board: snap, counts, brand: c.brand ?? null }),
      channelLayouts: snap.layouts,
      skippedLayouts: snap.skippedLayouts,
      reviewFindings: snap.findings as ReviewFindingRecord[],
      revisions: snap.revisions,
      approval: { status, rounds, unresolvedFindingIds: unresolved.map((f) => f.id), note },
      usage: {
        text: { calls: usage.total.calls, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, totalTokens: usage.total.inputTokens + usage.total.outputTokens, perAgent: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, { calls: v.calls, totalTokens: v.inputTokens + v.outputTokens, inputTokens: v.inputTokens, outputTokens: v.outputTokens, costUsd: textCostUsd(settings.model, { inputTokens: v.inputTokens, outputTokens: v.outputTokens, cachedInputTokens: v.cachedInputTokens }) }])) },
        images: { ...NO_IMAGE_USAGE },
        layouts: { rendered: snap.layouts.length, skipped: snap.skippedLayouts.length },
      },
      limitations,
      createdAt: new Date().toISOString(),
      imageResults: [],
      imageAllocation: null,
      imageVariations: [],
      imageCounts: null,
      lineage: { kind: 'full', revision: 1, parentCampaignId: null, reusedAssets: 0 },
      landingContent: null,
    };
    const checked = CampaignPackage.safeParse(pkg);
    if (!checked.success) throw new Error(`The campaign package is not valid: ${checked.error.issues[0]?.path.join('.')} ${checked.error.issues[0]?.message}`);
    const meta: CreativeReportMeta = {
      schemaVersion: CAMPAIGN_SCHEMA_VERSION,
      model: settings.model,
      provider: this.gateway.provider,
      generatedAt: pkg.createdAt,
      partial: failedAgents.length > 0,
      usage,
      settings: snap.settings,
      plan: snap.plan ?? { activated: [], skipped: [] },
      participants: snap.participantStatuses,
      sources: snap.sources,
      summaries: snap.summaries,
      aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
      why,
      modelReviewFailed,
      chain: { f1ReportId: c.f1.reportId, f3StrategyId: c.f3.strategyId },
      inputSnapshot: c.input,
    };
    return { pkg: checked.data, meta };
  }
}

const design = (c: CreativeRunConfig) => c.design?.design ?? null;
