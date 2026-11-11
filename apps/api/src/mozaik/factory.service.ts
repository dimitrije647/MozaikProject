import { ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, RunStatus, type FactoryRun } from '@prisma/client';
import {
  OpenAIClient,
  baseSizeFor,
  capOutputTokens,
  estimateCreativeRun,
  forecastAllocation,
  formatsForChannels,
  IMAGE_MODEL_INFO,
  imageActualCostUsd,
  imageModelWarning,
  planHybrid,
  designFormatIds,
  isNoAi,
  redact,
  LIBRARY_VERSION,
  TEMPLATE_LIBRARY,
  textCostUsd,
  textModelWarning,
  resolveOpenAIBaseUrl,
  safeErrorMessage,
  SpendBudget,
  checkSavedChain,
  type AuditRunConfig,
  type CreativeRunConfig,
  type DiscoveryRunConfig,
  type LedgerPlan,
  type SpendSnapshot,
  type StrategyRunConfig,
} from '@launchpilot/agents';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StartFactoryDto } from './dto/factory.dto';
import { ImageLibraryService } from '../visual/image-library.service';
import type { StartAuditDto, StartCreativeDto, StartDiscoveryDto, StartStrategyDto } from './dto/mozaik.dto';
import { ACTIVITY_EVENT_TYPES, importanceOf, summarizeEvent } from './event-summary';
import { budgetViewOf, derivedBudgetView, refusalText, type BudgetView } from './budget-view';
import { explainFailure, type RecoveryView } from './failure-view';
import { chainProblem, reportFailureOf, REPORT_ERROR_CODES } from './report-errors';
import { estimateCost, profileFromUsage, type CostEstimate, type Profiles } from './cost-estimate';
import { assessInputs, type InputReadiness } from './input-readiness';
import {
  ACTIVE_FACTORY_STATUSES,
  BUDGET_REQUIRED,
  LineageError,
  PRESET_TARGET_USD,
  PHASE_META,
  PHASE_ORDER,
  PRESETS,
  buildPhasePlan,
  chooseChain,
  f3Expected,
  initialPhases,
  mergeSettings,
  ImageGenerationForbidden,
  outcomeOf,
  type Candidates,
  type Chain,
  type ChannelId,
  type FactoryPhaseState,
  type FactorySettings,
  type FactoryStatus,
  type PhaseFailure,
  type PhaseKey,
  type PlannedPhase,
  type PresetId,
} from './factory-plan';
import { chooseImageModel, type ImageModelChoice } from './image-model-choice';
import { VisualService } from '../visual/visual.service';
import { HybridInputsService, type HybridInputs } from './hybrid-support';
import { MozaikService } from './mozaik.service';

type Obj = Record<string, any>;

/** Test seams (timeouts, fake tools, the clock) for the phases. Not reachable through HTTP. */
export interface FactoryHooks {
  discovery?: Partial<DiscoveryRunConfig>;
  audit?: Partial<AuditRunConfig>;
  strategy?: Partial<StrategyRunConfig>;
  creative?: Partial<CreativeRunConfig>;
  /** How long the orchestrator waits for one phase before cancelling it. Default 35 minutes. */
  phaseTimeoutMs?: number;
}

const DEFAULT_PHASE_TIMEOUT_MS = 35 * 60_000;
/** Waits for a promise for at most `ms` and never leaves its timer behind. */
async function within(p: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, ms)))]);
  if (timer) clearTimeout(timer);
}
const isActive = (s: string) => (ACTIVE_FACTORY_STATUSES as string[]).includes(s);
const messageOf = (err: unknown) => (err instanceof HttpException ? err.message : safeErrorMessage(err));
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clip = (s: unknown, n = 260) => (typeof s === 'string' && s.trim() ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : null);

interface Blocker {
  code: 'design_missing' | 'design_unconfirmed' | 'design_palette' | 'design_formats' | 'design_collection' | 'no_credentials' | 'no_model' | 'model_unavailable' | 'image_model_unsupported' | 'image_model_unavailable' | 'image_model_retired' | 'image_model_unresolved' | 'image_quality_unsupported' | 'factory_active' | 'run_active' | 'lineage' | 'missing_name' | 'missing_description' | 'report_unreadable' | 'report_damaged' | 'report_lineage';
  message: string;
}

/**
 * The Factory Orchestrator: ONE deterministic sequence F1 -> F2 -> F3 -> F4 over the EXISTING phase services (each phase keeps its
 * own Mozaik runtime, participants, events, cross-checks and persistence). It reuses a coherent chain of saved results when
 * asked, runs the rest for real, waits for each phase's persisted result (no sleeping or guessing), stores every transition and
 * stops at the first failure or cancel. It never retries a phase by itself (a retry could cost money) and never resumes after a
 * restart. It holds no credentials: each phase resolves the user's key itself.
 */
@Injectable()
export class FactoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FactoryService.name);
  private readonly loops = new Map<string, Promise<void>>();
  /** The campaign budget ledger of every run that is going on in this server (the saved copy is FactoryRun.ledgerJson). */
  private readonly ledgers = new Map<string, SpendBudget>();
  private shuttingDown = false;

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private credentials: ApiCredentialsService,
    private mozaik: MozaikService,
    private hybridInputs: HybridInputsService,
    private visual: VisualService,
    private library: ImageLibraryService,
  ) {}

  /** A factory run left active by a previous process can never continue: it is marked interrupted, never resumed or "completed". */
  async onModuleInit() {
    const orphans = await this.prisma.factoryRun.findMany({ where: { status: { in: ACTIVE_FACTORY_STATUSES } } });
    for (const f of orphans) {
      const phases = (f.phasesJson as unknown as FactoryPhaseState[]).map((p) => ({ ...p }));
      for (const p of phases) {
        if (p.status === 'running') Object.assign(p, { status: 'failed', completedAt: new Date().toISOString(), error: 'Interrupted: the server restarted while this phase was running. Nothing was resumed or repeated.' });
        else if (p.status === 'pending') p.status = 'skipped';
      }
      const message = 'Interrupted: the server restarted while this campaign run was in progress. Nothing was resumed or repeated, so no further paid request was made.';
      await this.prisma.factoryRun.updateMany({ where: { id: f.id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { status: 'interrupted', currentPhase: null, completedAt: new Date(), errorMessage: message, phasesJson: phases as unknown as Prisma.InputJsonValue } });
      this.logger.warn(`Marked orphaned factory run ${f.id} as interrupted`);
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    await within(Promise.allSettled([...this.loops.values()]), 15_000);
  }

  presets() {
    return { default: 'first_test' as PresetId, presets: PRESETS };
  }

  // ---- planning (no paid request; only the free model list) -------------------------------------------------------------------

  private async loadCandidates(projectId: string) {
    const done = { run: { status: RunStatus.COMPLETED } };
    const newest = { createdAt: 'desc' as const };
    const [f1, f2, f3, f4] = await Promise.all([
      this.prisma.productDiscoveryReport.findMany({ where: { projectId, ...done }, orderBy: newest, take: 40, select: { id: true, runId: true, createdAt: true, model: true, schemaVersion: true, reportJson: true } }),
      this.prisma.marketingAuditReport.findMany({ where: { projectId, ...done }, orderBy: newest, take: 40, select: { id: true, runId: true, createdAt: true, model: true, f1ReportId: true, reportJson: true } }),
      this.prisma.marketingStrategyReport.findMany({ where: { projectId, ...done }, orderBy: newest, take: 40, select: { id: true, runId: true, createdAt: true, model: true, f1ReportId: true, f2AuditId: true, reportJson: true } }),
      this.prisma.creativeCampaign.findMany({ where: { projectId, status: 'completed' }, orderBy: newest, take: 40, select: { id: true, runId: true, createdAt: true, model: true, f3StrategyId: true, approvalStatus: true, metadataJson: true } }),
    ]);
    const summaries = new Map<string, string | null>();
    const partial = (j: unknown) => Boolean((j as Obj | null)?.partial);
    for (const r of [...f1, ...f2, ...f3]) summaries.set(r.id, clip((r.reportJson as Obj | null)?.executiveSummary));
    const candidates: Candidates = {
      f1: f1.map((r) => ({ id: r.id, runId: r.runId, createdAt: r.createdAt, model: r.model, partial: partial(r.reportJson), usable: r.schemaVersion >= 2 })),
      f2: f2.map((r) => ({ id: r.id, runId: r.runId, createdAt: r.createdAt, model: r.model, partial: partial(r.reportJson), usable: true, f1ReportId: r.f1ReportId })),
      f3: f3.map((r) => ({ id: r.id, runId: r.runId, createdAt: r.createdAt, model: r.model, partial: partial(r.reportJson), usable: true, f1ReportId: r.f1ReportId, f2AuditId: r.f2AuditId })),
      f4: f4.map((r) => ({ id: r.id, runId: r.runId, createdAt: r.createdAt, model: r.model, partial: partial(r.metadataJson), usable: true, f3StrategyId: r.f3StrategyId, approvalStatus: r.approvalStatus })),
    };
    return { candidates, summaries };
  }

  /** What an earlier saved result measurably used (real accounting from its stored metadata). */
  private async measured(kind: PhaseKey, id: string) {
    const select = { metadataJson: true } as const;
    const row =
      kind === 'discovery' ? await this.prisma.productDiscoveryReport.findUnique({ where: { id }, select })
      : kind === 'audit' ? await this.prisma.marketingAuditReport.findUnique({ where: { id }, select })
      : kind === 'strategy' ? await this.prisma.marketingStrategyReport.findUnique({ where: { id }, select })
      : await this.prisma.creativeCampaign.findUnique({ where: { id }, select });
    const m = (row?.metadataJson ?? {}) as Obj;
    const t = m.usage?.total ?? m.usage?.text;
    if (!t) return null;
    return { calls: num(t.calls), tokens: num(t.totalTokens) || num(t.inputTokens) + num(t.outputTokens), images: kind === 'creative' ? num(m.images?.generated) : undefined };
  }

  /** Tokens per call measured from the user's own earlier runs of each phase (real usage saved with the reports), for the cost estimate. */
  private async loadProfiles(projectId: string): Promise<Profiles> {
    const take = 5;
    const usageOf = (rows: { metadataJson: unknown }[]) =>
      rows.map((r) => {
        const t = ((r.metadataJson ?? {}) as Obj).usage?.total ?? ((r.metadataJson ?? {}) as Obj).usage?.text ?? {};
        return { calls: num(t.calls), inputTokens: num(t.inputTokens), outputTokens: num(t.outputTokens) };
      });
    const done = { run: { status: RunStatus.COMPLETED } };
    const q = { where: { projectId, ...done }, orderBy: { createdAt: 'desc' as const }, take, select: { metadataJson: true } };
    const [f1, f2, f3, f4] = await Promise.all([
      this.prisma.productDiscoveryReport.findMany(q),
      this.prisma.marketingAuditReport.findMany(q),
      this.prisma.marketingStrategyReport.findMany(q),
      this.prisma.creativeCampaign.findMany({ where: { projectId, status: 'completed' }, orderBy: { createdAt: 'desc' }, take, select: { metadataJson: true } }),
    ]);
    const out: Profiles = {};
    for (const [k, rows] of [['discovery', f1], ['audit', f2], ['strategy', f3], ['creative', f4]] as [PhaseKey, { metadataJson: unknown }[]][]) {
      const p = profileFromUsage(usageOf(rows));
      if (p) out[k] = p;
    }
    return out;
  }

  private async listProviderModels(apiKey: string): Promise<string[] | null> {
    try {
      const client = new OpenAIClient({ apiKey, baseUrl: resolveOpenAIBaseUrl() });
      return (await client.listModels(AbortSignal.timeout(15_000))).map((m) => m.id);
    } catch {
      return null; // an outage must not look like a missing model
    }
  }

  /** Reads what the project has (never any file content or secret) and classifies it. Enforced only for Hybrid Production. */
  private async inputReadiness(userId: string, projectId: string, project: { name: string; description: string | null }, settings: FactorySettings, preset: PresetId): Promise<InputReadiness> {
    const [intake, socialProfiles, assetRows, pin] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.socialProfile.count({ where: { projectId } }),
      this.prisma.projectAsset.groupBy({ by: ['type'], where: { projectId }, _count: { _all: true } }),
      this.prisma.pinterestConnection.findUnique({ where: { userId }, select: { status: true } }),
    ]);
    const n = (t: string) => assetRows.find((a) => a.type === t)?._count._all ?? 0;
    return assessInputs(
      {
        projectName: project.name,
        projectDescription: project.description,
        intake: intake && { productName: intake.productName, shortDescription: intake.shortDescription, websiteUrl: intake.websiteUrl, githubUrl: intake.githubUrl, targetMarket: intake.targetMarket, targetAudience: intake.targetAudience, marketingGoal: intake.marketingGoal, campaignDuration: intake.campaignDuration, stylePreference: intake.stylePreference },
        socialProfiles,
        assets: { logo: n('logo'), images: n('image'), screenshots: n('screenshot'), references: n('reference') },
        competitors: settings.f3.competitorUrls.length,
        channels: settings.f4.channels,
        style: settings.hybrid?.design?.collectionId ?? settings.hybrid?.style ?? null,
        pinterestConnected: pin?.status === 'connected',
        referenceCount: settings.hybrid?.references.length ?? 0,
      },
      { enforce: preset === 'hybrid_production' || preset === 'no_ai_hybrid' },
    );
  }

  /** `offline` = the free preview: no request to OpenAI of any kind (not even the model list). Models are then assumed, never verified. */
  private async resolve(userId: string, projectId: string, dto: StartFactoryDto, opts: { offline?: boolean } = {}) {
    const offline = opts.offline === true;
    const project = await this.projects.assertOwned(userId, projectId);
    const preset: PresetId = dto.preset ?? 'first_test';
    const mode = dto.mode ?? 'continue';
    const reusePartial = dto.reusePartial ?? true;
    const rerunCreative = dto.rerunCreative ?? false;
    let settings: FactorySettings;
    try {
      settings = mergeSettings(preset, { model: dto.model, f1: dto.f1, f2: dto.f2, f3: dto.f3, f4: dto.f4 as never, textBudgetUsd: dto.textBudgetUsd, depth: dto.depth, hybrid: dto.hybrid as never });
    } catch (e) {
      // an invalid or forbidden request is a client error (nothing was sent anywhere), not a server fault
      if (e instanceof ImageGenerationForbidden || e instanceof Error) throw new UnprocessableEntityException(e.message);
      throw e;
    }

    const blockers: Blocker[] = [];
    const warnings: string[] = [];
    if (dto.textBudgetUsd !== undefined) warnings.push('A separate text budget is no longer used: there is ONE campaign budget that every text call, image and review shares. The value was ignored.');
    // Hybrid Production: brand images and references of THIS project, normalized by the server (nothing is fetched, nothing is sent anywhere)
    let hybridIn: HybridInputs | null = null;
    if (settings.hybrid) {
      hybridIn = await this.hybridInputs.prepare(projectId, settings.hybrid, false);
      settings.hybrid = hybridIn.hybrid;
      warnings.push(...hybridIn.warnings);
    }
    const { candidates, summaries } = await this.loadCandidates(projectId);

    let chain: Chain = {};
    let notes: string[] = [];
    try {
      if (mode === 'continue') ({ chain, notes } = chooseChain(candidates, { reusePartial, rerunCreative, explicit: dto.reports }));
      else if (dto.reports && (dto.reports.f1ReportId || dto.reports.f2AuditId || dto.reports.f3StrategyId)) blockers.push({ code: 'lineage', message: 'Selected reports cannot be combined with a fresh run (a fresh run uses none of them).' });
    } catch (err) {
      if (!(err instanceof LineageError)) throw err;
      blockers.push({ code: 'lineage', message: err.message });
    }
    const plan = buildPhasePlan(chain, mode);
    warnings.push(...notes);
    // FREE and deterministic, before anything can be approved: every saved report this plan builds on must exist, be readable by this version, belong to
    // this project and match its neighbours. A report that is not usable blocks the plan with the exact report and field (nothing is spent on a plan that
    // is already known to fail). Adjustments the reader had to make are listed.
    const reportCheck = await this.checkReusedReports(userId, projectId, plan, chain);
    if (reportCheck && !reportCheck.check.ok) {
      const problem = chainProblem(reportCheck.consumer, reportCheck.check);
      blockers.push({ code: problem.code, message: problem.message });
    }
    for (const rc of reportCheck?.check.reports ?? []) if (rc.status === 'normalized') warnings.push(rc.message);

    // the project's own data: what exists and what is missing. Only the REQUIRED items can block (and only for Hybrid Production);
    // everything else is advice, each with the fallback LaunchPilot applies. Nothing is invented for a missing item.
    const inputs = await this.inputReadiness(userId, projectId, project, settings, preset);
    blockers.push(...inputs.blockers);

    // credentials and models (the model list is a free request; nothing is billed)
    const cred = await this.credentials.getDecryptedCredential(userId, 'openai');
    const textModel = settings.model ?? cred?.model ?? null;
    let providerModels: string[] | null = null;
    if (offline) {
      warnings.push('Free preview: nothing was sent to OpenAI, so your key, your models and the image model were not checked. Starting the campaign checks them first.');
      if (!textModel) warnings.push('No text model is saved yet (Settings > AI providers), so the text cost cannot be estimated.');
    } else if (!cred) blockers.push({ code: 'no_credentials', message: 'A full campaign needs your OpenAI API key. Add it under Settings > AI providers.' });
    else if (!textModel) blockers.push({ code: 'no_model', message: 'Choose an OpenAI text model first (Settings > AI providers). LaunchPilot never picks one for you.' });
    else {
      providerModels = await this.listProviderModels(cred.apiKey);
      if (providerModels && !providerModels.includes(textModel)) blockers.push({ code: 'model_unavailable', message: `The text model "${textModel}" is not available to your OpenAI key. Pick one of your models in Settings > AI providers.` });
      else if (!providerModels) warnings.push('Your OpenAI model list could not be read just now, so the models were not pre-checked. A wrong model would be reported by the first phase.');
    }
    const runsCreative = plan.find((p) => p.phase === 'creative')?.action === 'run';
    // the image model: "auto" picks a CURRENT model from the key's own list; a retired or unlisted one is refused before anything is spent
    const requestedImageModel = settings.f4.imageModel;
    let imageChoice: ImageModelChoice | null = null;
    let imageNote = 'No image model: the layouts use brand-colored backgrounds and nothing is generated.';
    let imageAvailable: boolean | null = null;
    if (runsCreative && requestedImageModel && (cred || offline)) {
      // the free preview assumes the models OpenAI documents; it cannot know which ones your key lists
      imageChoice = chooseImageModel(requestedImageModel, offline ? Object.keys(IMAGE_MODEL_INFO) : providerModels, new Date(), settings.f4.imageModelStrategy, settings.f4.imageQuality);
      if (offline && imageChoice.model) imageChoice = { ...imageChoice, available: null, verification: 'unknown', note: `Preview: "${imageChoice.model}" is the model the ${settings.f4.imageModelStrategy} strategy would pick from the models OpenAI documents. It is not checked against your key; starting the campaign does that and may pick another.` };
      imageNote = imageChoice.note;
      imageAvailable = imageChoice.available;
      if (imageChoice.blocker) blockers.push(imageChoice.blocker);
      // from here on the settings carry the model that WILL be requested (never the word "auto")
      if (imageChoice.model) settings.f4.imageModel = imageChoice.model;
    }
    const imageModel = settings.f4.imageModel;

    // an active full run or phase run owns the project
    const [activeFactory, activeRun] = await Promise.all([
      this.prisma.factoryRun.findFirst({ where: { projectId, status: { in: ACTIVE_FACTORY_STATUSES } }, select: { id: true } }),
      this.prisma.campaignRun.findFirst({ where: { projectId, status: RunStatus.RUNNING }, select: { id: true, mode: true } }),
    ]);
    if (offline) {
      /* a preview may be opened while another run is in progress */
    } else if (activeFactory) blockers.push({ code: 'factory_active', message: 'A full campaign run is already in progress for this project.' });
    else if (activeRun) blockers.push({ code: 'run_active', message: 'Another phase run is in progress for this project. Wait for it to finish or cancel it first.' });

    // honest notes about what is reused and about the chosen settings
    const reused = (k: PhaseKey) => plan.find((p) => p.phase === k)?.reuse ?? null;
    for (const [k, label] of [['discovery', 'F1 Product Discovery report'], ['audit', 'F2 audit'], ['strategy', 'F3 strategy']] as [PhaseKey, string][]) {
      if (reused(k)?.partial) warnings.push(`The reused ${label} is partial: some inputs were missing when it was made, so it is not fully verified. Its limitations carry into the campaign.`);
    }
    const strategyId = chain.f3?.id ?? null;
    let recommended: string[] | null = null;
    if (strategyId) {
      const s = await this.prisma.marketingStrategyReport.findUnique({ where: { id: strategyId }, select: { reportJson: true } });
      recommended = ((s?.reportJson as Obj | null)?.channels ?? []).map((c: Obj) => c.channel);
    }
    if (runsCreative) {
      if (settings.f4.channels && recommended && settings.f4.channels.some((c) => !recommended!.includes(c))) warnings.push(`The strategy does not recommend ${settings.f4.channels.filter((c) => !recommended!.includes(c)).join(', ')}; the copy for it follows the brief and the strategy's general messaging only.`);
      if (imageModel && settings.f4.maxImages === 0) warnings.push('The image limit is 0: no AI image will be generated. Every concept uses a brand-colored background.');
      else if (imageModel && !settings.f4.variations && settings.f4.maxImages < settings.f4.concepts) warnings.push(`The image limit is ${settings.f4.maxImages} for ${settings.f4.concepts} concepts: only ${settings.f4.maxImages} concept(s) get an AI image and the other ${settings.f4.concepts - settings.f4.maxImages} use brand-colored backgrounds. LaunchPilot never raises the limit for you; set it to ${settings.f4.concepts} to give every concept its own image.`);
      if (settings.f4.maxRegenerations > 0) warnings.push(`Up to ${settings.f4.maxRegenerations} extra image(s) may be generated to replace a rejected one (billed by OpenAI).`);
    }

    // ---- the plan of original images and the cost estimate (no paid request: prices come from the price book, tokens from your earlier runs) ----
    const imageOn = !!imageModel && runsCreative;
    const planChannels = (settings.f4.channels ?? (recommended ?? []).slice(0, 4)) as ChannelId[];
    const forecastChannels: ChannelId[] = planChannels.length ? planChannels : ['instagram'];
    const hy = settings.hybrid;
    const hybridForecast = hy && runsCreative ? planHybrid({ concepts: Array.from({ length: settings.f4.concepts }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels: forecastChannels })), originals: imageOn ? hy.originals : 0, templateCreatives: hy.templateCreatives, channelPriority: forecastChannels, fixedSize: settings.f4.imageSize, brandImages: hybridIn?.brandImageCount ?? 0, basis: 'forecast', formatIds: designFormatIds(hy) }) : null;
    // the approved campaign design: confirmed, readable, able to produce the chosen formats; where the pictures come from (all free, deterministic)
    const designPreflight = hy && runsCreative && hy.design ? await this.visual.preflight(projectId, hy, { imageOn, concepts: settings.f4.concepts, brandImageCount: hybridIn?.brandImageCount ?? 0, imageUsd: null }) : null;
    if (designPreflight) {
      blockers.push(...designPreflight.blockers);
      warnings.push(...designPreflight.warnings);
    }
    // NO AI HYBRID: the template collection and the palette decide how every creative looks, so a design is required; and the pictures are planned for free
    const noAi = isNoAi(hy);
    if (noAi && runsCreative && hy && !hy.design) blockers.push({ code: 'design_missing', message: 'NO AI HYBRID needs an approved campaign design: choose a template collection and a palette in Campaign Design and confirm it. Every creative is drawn with them.' });
    const imagePreflight = noAi && runsCreative && hy ? await this.library.preflight(projectId, { concepts: settings.f4.concepts, slots: hybridForecast?.slots.length ?? hy.templateCreatives, autoStock: hy.imagery.autoStock }) : null;
    if (imagePreflight) warnings.push(...imagePreflight.warnings);
    const allocation = hybridForecast ? hybridForecast.allocation : imageOn && settings.f4.variations ? forecastAllocation({ target: settings.f4.maxImages, conceptCount: settings.f4.concepts, channels: forecastChannels, fixedSize: settings.f4.imageSize, layoutsPerOriginal: settings.f4.layoutsPerOriginal }) : null;
    if (hy && runsCreative) {
      if (hybridForecast) warnings.push(...hybridForecast.warnings.filter((w) => !(allocation?.warnings ?? []).includes(w)));
      if (noAi) warnings.push('NO AI HYBRID: no AI image is generated and no image request is ever made. The Mozaik agents still plan, write, design and review the campaign with the text model.');
      if (hy.originals > 0 && !imageOn && !noAi) warnings.push('Hybrid Production has no image model, so no original AI images are generated: every creative is a template creative built from brand assets or picture-free templates.');
      if (hy.selection === 'manual' && !Object.keys(hy.overrides).length) warnings.push('Manual template selection is on but no template was chosen; every creative will be chosen automatically.');
    }
    if (allocation) warnings.push(...allocation.warnings);
    const planChunk = Math.max(3, Math.min(24, Math.floor(capOutputTokens(textModel, 9000).tokens / 450)));
    const creativeEst = runsCreative ? estimateCreativeRun({ concepts: settings.f4.concepts, landing: settings.f4.landing, imageGeneration: imageOn, maxImages: settings.f4.maxImages, maxRegenerations: settings.f4.variations ? 0 : settings.f4.maxRegenerations, maxLayoutsPerConcept: settings.f4.maxLayoutsPerConcept, maxRepairRounds: settings.f4.maxRepairRounds, visionReviews: settings.f4.visionReviews, maxModelCalls: settings.f4.maxModelCalls, channels: Math.max(1, forecastChannels.length), depth: settings.depth, variations: allocation ? { target: allocation.allocated, expectedLayouts: allocation.expectedLayouts, planChunk } : undefined, extraCalls: hy ? (hy.directionRefine ? 1 : 0) + (hy.selection === 'assisted' ? 1 : 0) : 0 }) : null;
    const imageSizes = !imageOn ? [] : allocation ? allocation.variations.map((v) => v.size) : Array.from({ length: Math.min(settings.f4.maxImages, settings.f4.concepts) }, () => settings.f4.imageSize ?? baseSizeFor(formatsForChannels(forecastChannels, Math.min(settings.f4.maxLayoutsPerConcept, 6)).map((f) => f.format)));
    const tok = (n: number | null, d: number) => capOutputTokens(textModel, n ?? d).tokens;
    const runs = (k: PhaseKey) => plan.find((p) => p.phase === k)?.action === 'run';
    const cost: CostEstimate = estimateCost({
      textModel,
      imageModel: imageOn ? imageModel : null,
      imageQuality: settings.f4.imageQuality,
      imageSizes,
      phases: [
        { phase: 'discovery', runs: runs('discovery'), typicalCalls: Math.min(settings.f1.maxModelCalls, 7 + settings.f1.maxReviews), capCalls: settings.f1.maxModelCalls, outputCap: tok(settings.f1.maxOutputTokens, 3000) },
        { phase: 'audit', runs: runs('audit'), typicalCalls: Math.min(settings.f2.maxModelCalls, 6 + settings.f2.maxReviews), capCalls: settings.f2.maxModelCalls, outputCap: tok(settings.f2.maxOutputTokens, 2500) },
        { phase: 'strategy', runs: runs('strategy'), typicalCalls: f3Expected(settings.f3).typical, capCalls: settings.f3.maxModelCalls, outputCap: tok(settings.f3.maxOutputTokens, 2500) },
        { phase: 'creative', runs: runsCreative, typicalCalls: creativeEst?.textCalls.typical ?? 0, capCalls: settings.f4.maxModelCalls, outputCap: tok(settings.f4.maxOutputTokens, 3000) },
      ],
      profiles: await this.loadProfiles(projectId),
      targetUsd: PRESET_TARGET_USD[preset],
      approvedUsd: dto.approvedBudgetUsd ?? null,
      listedImageModels: offline ? null : providerModels,
    });
    warnings.push(...cost.warnings);
    const textWarn = textModelWarning(textModel);
    if (textWarn) warnings.push(textWarn);
    const imageWarn = imageOn && imageModel ? imageModelWarning(imageModel) : null;
    if (imageWarn) warnings.push(imageWarn);
    // a model without a published price: the image cost cannot be known before the first image, and the user must say they know
    const unpricedImages = imageOn && cost.images.count > 0 && cost.images.basis === 'unavailable';
    // The unknown price is covered by the ONE spending approval of the campaign, which also fixes the maximum number of image requests (the
    // run can never send more). The number is computed from the plan; nobody types it and there is no second checkbox.
    const unifiedApproval = unpricedImages;
    const imageRequestCap = !imageOn ? 0 : settings.f4.variations ? settings.f4.maxImages : Math.min(settings.f4.maxImages, settings.f4.concepts) + settings.f4.maxRegenerations;
    const consentNeeded = BUDGET_REQUIRED[preset] || (settings.f4.variations && imageOn) || unpricedImages;
    if (unpricedImages) {
      warnings.push(`Image pricing is not available for ${imageModel} (it is billed by tokens). Your approved campaign budget is an application-level spending target, not a guaranteed billing cap for unpriced requests. The approval also covers at most ${imageRequestCap} image request(s); the first image goes alone and the rest of the campaign is protected with its real cost. Actual charges may differ from any estimate. You can instead choose a model with a published price or run without original images.`);
    }
    // The projection the shared ledger protects: the typical text spend of every phase that will still run (with a margin) and the required
    // originals. It is REVISABLE (it shrinks as phases finish and images start) and never a fixed allocation. Unknown prices stay unknown.
    const marginPct = 1.25;
    const ledgerPlan: LedgerPlan = {
      phases: PHASE_ORDER.map((k, idx) => {
        const ph = cost.text.phases[idx];
        return { label: PHASE_META[k].code, order: idx + 1, projectedUsd: !ph.runs ? 0 : ph.typicalUsd === null ? null : Math.round(ph.typicalUsd * marginPct * 10_000) / 10_000 };
      }),
      images: imageOn && cost.images.count > 0
        ? cost.images.perImageUsd !== null
          ? { remaining: cost.images.count, unitUsd: cost.images.perImageUsd, basis: 'published' as const }
          : cost.images.reference
            ? { remaining: cost.images.count, unitUsd: Math.round((cost.images.reference.totalUsd / cost.images.count) * 10_000) / 10_000, basis: 'reference' as const }
            : { remaining: cost.images.count, unitUsd: null }
        : undefined,
    };
    return { designPreflight, imagePreflight, project, preset, mode, reusePartial, rerunCreative, settings, plan, chain, reportChecks: (reportCheck?.check.reports ?? []).map((r) => ({ code: r.report, id: r.id, status: r.status, message: r.message, adjustments: [...r.defaulted.map((d) => `${d}: filled with its default`), ...r.ignored.map((d) => `${d}: not read by this version`)] })), candidates, blockers, warnings, summaries, textModel, imageNote, imageAvailable, imageChoice, requestedImageModel, recommended, nothingToRun: plan.every((p) => p.action === 'reuse'), existingCampaign: chain.f4 ?? null, hasCred: !!cred, allocation, hybridIn, hybridForecast, creativeEst, cost, approvedBudgetUsd: dto.approvedBudgetUsd ?? null, imageWarn, imageOn, unpricedImages, unifiedApproval, imageRequestCap, consentNeeded, ledgerPlan, inputs };
  }

  /** The plan the user confirms: which phases are reused (from exactly which saved result), which run, with which limits. Spends nothing. */
  async preflight(userId: string, projectId: string, dto: StartFactoryDto = {}, opts: { offline?: boolean } = {}) {
    const r = await this.resolve(userId, projectId, dto, opts);
    const s = r.settings;
    const intake = await this.prisma.productIntake.findUnique({ where: { projectId } });
    const phases = [];
    let textCallCap = 0;
    let imagesPlanned = 0;
    let layoutsPlanned = 0;
    let imagePlan: Obj | null = null;
    for (const p of r.plan) {
      const meta = PHASE_META[p.phase];
      const reuse = p.reuse ? { id: p.reuse.id, runId: p.reuse.runId, createdAt: p.reuse.createdAt.toISOString(), model: p.reuse.model, partial: p.reuse.partial, summary: r.summaries.get(p.reuse.id) ?? null, approvalStatus: 'approvalStatus' in p.reuse ? (p.reuse as { approvalStatus: string | null }).approvalStatus : null } : null;
      const refId = (p.reuse ?? { discovery: r.candidates.f1, audit: r.candidates.f2, strategy: r.candidates.f3, creative: r.candidates.f4 }[p.phase][0])?.id;
      const measured = refId ? await this.measured(p.phase, refId).catch(() => null) : null;
      let limits: Obj | null = null;
      let expected: Obj | null = null;
      if (p.action === 'run') {
        if (p.phase === 'discovery') { limits = s.f1; expected = { textCalls: { cap: s.f1.maxModelCalls, typical: null } }; textCallCap += s.f1.maxModelCalls; }
        else if (p.phase === 'audit') { limits = s.f2; expected = { textCalls: { cap: s.f2.maxModelCalls, typical: null } }; textCallCap += s.f2.maxModelCalls; }
        else if (p.phase === 'strategy') { limits = s.f3; expected = { textCalls: f3Expected(s.f3), maxScouts: s.f3.maxScouts, maxReviews: s.f3.maxReviews }; textCallCap += s.f3.maxModelCalls; }
        else {
          const channels = s.f4.channels ?? (r.recommended ?? []).slice(0, 4);
          const est = r.creativeEst!;
          limits = { ...s.f4, channels: s.f4.channels ?? (r.recommended ? channels : null) };
          layoutsPlanned = r.hybridForecast ? r.hybridForecast.slots.length : r.allocation ? r.allocation.expectedLayouts : channels.length ? formatsForChannels(channels as ChannelId[], Math.min(s.f4.maxLayoutsPerConcept, 6)).length * s.f4.concepts : est.layouts.planned;
          expected = { textCalls: est.textCalls, imageRequests: est.imageRequests, layouts: { ...est.layouts, planned: layoutsPlanned } };
          textCallCap += s.f4.maxModelCalls;
          imagesPlanned = est.imageRequests.planned;
          // concepts requested / originals permitted / requests planned / left to brand-colored backgrounds: four different numbers
          const permitted = s.f4.imageModel ? (s.f4.variations ? (r.allocation?.allocated ?? 0) : Math.min(s.f4.maxImages, s.f4.concepts)) : 0;
          imagePlan = { enabled: !!s.f4.imageModel, model: s.f4.imageModel, modelMode: r.imageChoice?.mode ?? (s.f4.imageModel ? 'explicit' : 'none'), conceptsRequested: s.f4.concepts, originalImagesPermitted: permitted, plannedRequests: est.imageRequests.planned, budgetLimitedConcepts: s.f4.imageModel && !s.f4.variations ? Math.max(0, s.f4.concepts - permitted) : 0, regenerationCap: s.f4.variations ? 0 : s.f4.maxRegenerations, variations: s.f4.variations, originalsTarget: s.f4.variations ? s.f4.maxImages : permitted, allocated: r.allocation?.allocated ?? permitted, perConcept: r.allocation?.perConcept ?? null, expectedLayouts: layoutsPlanned, imageConcurrency: s.f4.imageConcurrency, quality: s.f4.imageQuality };
        }
      }
      phases.push({ phase: p.phase, code: meta.code, title: meta.title, action: p.action, reuse, limits, expected, measured });
    }
    return {
      ok: r.blockers.length === 0,
      offline: opts.offline === true,
      blockers: r.blockers,
      warnings: r.warnings,
      reportChecks: r.reportChecks,
      nothingToRun: r.nothingToRun,
      project: { id: r.project.id, name: intake?.productName ?? r.project.name },
      brief: { language: intake?.preferredLanguage ?? null, targetAudience: intake?.targetAudience ?? null, marketingGoal: intake?.marketingGoal ?? null, targetMarket: intake?.targetMarket ?? null },
      mode: r.mode,
      preset: r.preset,
      reusePartial: r.reusePartial,
      rerunCreative: r.rerunCreative,
      chain: { f1ReportId: r.chain.f1?.id ?? null, f2AuditId: r.chain.f2?.id ?? null, f3StrategyId: r.chain.f3?.id ?? null, campaignId: r.chain.f4?.id ?? null },
      models: { text: { id: r.textModel, source: s.model ? 'override' : 'saved' }, image: s.f4.imageModel && r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? { id: r.imageChoice?.model ?? null, requested: r.requestedImageModel, mode: r.imageChoice?.mode ?? 'explicit', quality: s.f4.imageQuality, available: r.imageAvailable, note: r.imageNote, strategy: r.imageChoice?.strategy ?? null, strategySetting: s.f4.imageModelStrategy, reason: r.imageChoice?.reason ?? null, alternatives: r.imageChoice?.alternatives ?? [], verification: r.imageChoice?.verification ?? 'unknown', documented: r.imageChoice?.documented ?? null, warning: r.imageWarn, priceKnown: !r.unpricedImages, requiresPriceConfirmation: r.unpricedImages && !r.unifiedApproval, pricing: r.unpricedImages ? 'unavailable' : 'published' } : null },
      inputs: r.inputs,
      imagePlan,
      allocation: r.allocation,
      hybrid: s.hybrid && r.hybridForecast
        ? {
            settings: s.hybrid,
            noAi: isNoAi(s.hybrid)
              ? {
                  statement: { aiImages: 'AI-generated images: 0', imagery: 'Existing/licensed imagery: enabled', agents: 'AI agents for strategy and copywriting: enabled' },
                  imagery: r.imagePreflight,
                  imageRequestCap: 0,
                  textModelRequestsMax: s.f4.maxModelCalls,
                }
              : null,
            headline: isNoAi(s.hybrid) ? `NO AI HYBRID: 0 AI-generated images + ${r.hybridForecast.slots.length} template creative${r.hybridForecast.slots.length === 1 ? '' : 's'} = ${r.hybridForecast.slots.length} finished creative${r.hybridForecast.slots.length === 1 ? '' : 's'}` : `${r.hybridForecast.allocation.allocated} original AI image${r.hybridForecast.allocation.allocated === 1 ? '' : 's'} + ${r.hybridForecast.slots.length} template creative${r.hybridForecast.slots.length === 1 ? '' : 's'} = ${r.hybridForecast.allocation.allocated + r.hybridForecast.slots.length} finished creatives`,
            originals: { planned: r.hybridForecast.allocation.allocated, paidRequests: r.hybridForecast.allocation.allocated, model: s.f4.imageModel, quality: s.f4.imageQuality },
            templateCreatives: { planned: r.hybridForecast.slots.length, paidRequests: 0, note: 'Rendered locally from the originals, your brand colors and logo: no image request and no cost.' },
            total: r.hybridForecast.allocation.allocated + r.hybridForecast.slots.length,
            perConcept: r.hybridForecast.perConcept,
            slots: r.hybridForecast.slots,
            rules: r.hybridForecast.rules,
            brandImages: r.hybridIn?.brandImageCount ?? 0,
            references: s.hybrid.references,
            directionReview: { required: s.hybrid.reviewDirection, approved: s.hybrid.directionApproved },
            design: r.designPreflight,
            note: 'The template creatives are not AI images. The cost shown is for the text calls and the original images only; it is an estimate, not a guarantee, and it is not compared with any other preset.',
            library: { templates: TEMPLATE_LIBRARY.filter((t) => t.status === 'active').length, version: LIBRARY_VERSION },
          }
        : null,
      cost: r.cost,
      budget: {
        ...r.cost.budget,
        required: r.consentNeeded,
        consentNeeded: r.consentNeeded,
        depth: s.depth,
        /** There is no second checkbox any more: an unknown image price is accepted inside the one spending approval (imageRequestsApprovedWithBudget). */
        unpricedImagesConfirmationNeeded: false,
        imagePriceUnavailable: r.unpricedImages,
        imageRequestCap: r.imageRequestCap,
        imageRequestsApprovedWithBudget: r.unpricedImages,
        /** ONE budget for everything that is paid for. The numbers only inform: what the ledger keeps back for required work right now. Never a separate budget. */
        shared: {
          note: 'One campaign budget is shared by the text agents, the images, the reviews and the repairs. Required analysis and the required original images are protected from optional checks; money that one kind of work does not use stays available for the rest.',
          protectedEssentialUsd: Math.round(r.ledgerPlan.phases.reduce((a, p) => a + (p.projectedUsd ?? 0), 0) * 10_000) / 10_000,
          protectedEssentialKnown: r.ledgerPlan.phases.every((p) => p.projectedUsd !== null),
          protectedImagesUsd: r.ledgerPlan.images && r.ledgerPlan.images.unitUsd !== null ? Math.round(r.ledgerPlan.images.unitUsd * r.ledgerPlan.images.remaining * 10_000) / 10_000 : null,
          protectedImagesBasis: r.ledgerPlan.images ? (r.ledgerPlan.images.unitUsd === null ? 'unknown' : (r.ledgerPlan.images.basis ?? 'published')) : 'none',
        },
      },
      tokenBudgets: [
        { phase: 'discovery', code: 'F1', maxModelCalls: s.f1.maxModelCalls, outputTokens: r.cost.text.phases[0].outputCap },
        { phase: 'audit', code: 'F2', maxModelCalls: s.f2.maxModelCalls, outputTokens: r.cost.text.phases[1].outputCap },
        { phase: 'strategy', code: 'F3', maxModelCalls: s.f3.maxModelCalls, outputTokens: r.cost.text.phases[2].outputCap },
        { phase: 'creative', code: 'F4', maxModelCalls: s.f4.maxModelCalls, outputTokens: r.cost.text.phases[3].outputCap },
      ].map((t, i) => ({ ...t, runs: r.cost.text.phases[i].runs, modelLimit: r.cost.text.maxOutputTokensLimit })),
      settings: s,
      phases,
      totals: { phasesToRun: r.plan.filter((p) => p.action === 'run').length, phasesReused: r.plan.filter((p) => p.action === 'reuse').length, textCallCap, imageRequests: imagesPlanned, imageRegenerationCap: r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? s.f4.maxRegenerations : 0, layouts: layoutsPlanned },
      pricing: { dollars: r.cost.totals.typicalUsd, note: `Estimate from OpenAI's published prices (read ${r.cost.priceBookVerifiedAt}) and from token volumes ${Object.keys(r.cost.text.phases.filter((p) => p.basis === 'measured')).length ? 'measured in your earlier runs where they exist, otherwise assumed' : 'assumed (you have no earlier runs of these phases)'}. It is an estimate, not a guarantee or an invoice. The spending limit you approve is enforced by LaunchPilot before every paid request, but it is not an OpenAI billing cap: a request that times out may still be billed.` },
      limitations: [
        'Audience, channel fit and seasonality are hypotheses until validated with real data; no performance figure is promised.',
        'A phase that fails stops the run: nothing is retried automatically, because a retry could cost money.',
        r.settings.f3.useHolidayCalendar ? 'The public-holiday calendar is asked (a free service).' : 'The seasonal calendar is off, so seasonal statements are labeled hypotheses.',
        'Competitor research uses only URLs you supply and a search provider if the server has one configured.',
        'Nothing is published anywhere; the campaign package stays in LaunchPilot.',
      ],
    };
  }

  // ---- start -----------------------------------------------------------------------------------------------------------------

  async start(userId: string, projectId: string, dto: StartFactoryDto = {}, hooks: FactoryHooks = {}) {
    const r = await this.resolve(userId, projectId, dto);
    const lineage = r.blockers.find((b) => b.code === 'lineage');
    const active = r.blockers.find((b) => b.code === 'factory_active' || b.code === 'run_active');
    if (active) throw new ConflictException(active.message);
    if (r.blockers.length) throw new UnprocessableEntityException((lineage ?? r.blockers[0]).message);
    if (r.nothingToRun) throw new ConflictException('Every phase already has a saved result for this chain, so there is nothing to run. Choose "Run every phase again" or "Produce a new creative round" to spend more.');
    // a plan with many paid requests never starts without an approved spending limit AND an explicit confirmation of the estimate
    if (r.consentNeeded && !(dto.approvedBudgetUsd && dto.approvedBudgetUsd > 0 && dto.confirmCost === true)) {
      throw new UnprocessableEntityException('This plan makes many paid OpenAI requests. Review the cost estimate, approve a spending limit (approvedBudgetUsd) and confirm it (confirmCost) to start. Nothing has been sent to OpenAI.');
    }
    if (r.settings.hybrid?.reviewDirection && !r.settings.hybrid.directionApproved) throw new UnprocessableEntityException('You asked to review the visual direction first. Open the preview, review the direction and confirm it (hybrid.directionApproved) to start. Nothing has been sent to OpenAI.');
    if (dto.approvedBudgetUsd && r.cost.budget.status === 'below_estimate') throw new UnprocessableEntityException(r.cost.budget.message);
    if (r.unpricedImages && dto.approvedImageRequests !== r.imageRequestCap) {
      // the unknown price is accepted inside the ONE spending approval, which names the maximum number of image requests (computed from the plan)
      throw new UnprocessableEntityException(`Image pricing is not available for ${r.settings.f4.imageModel}, so your spending approval must also cover the maximum number of image requests this plan makes (${r.imageRequestCap}). Review the plan again and approve it as shown (approvedImageRequests: ${r.imageRequestCap}), or choose a model with a published price. Nothing has been sent to OpenAI.`);
    }

    const phases = initialPhases(r.plan);
    const config = { preset: r.preset, mode: r.mode, rerunCreative: r.rerunCreative, reusePartial: r.reusePartial, settings: r.settings, textModel: r.textModel, approvedBudgetUsd: dto.approvedBudgetUsd ?? null, sharedBudget: true, confirmedCost: dto.confirmCost === true, confirmedUnpricedImages: r.unpricedImages, approvedImageRequests: r.unpricedImages ? r.imageRequestCap : null, imageRequestCap: r.imageRequestCap, estimate: { typicalUsd: r.cost.totals.typicalUsd, maxUsd: r.cost.totals.maxUsd, imageUsd: r.cost.images.typicalUsd, available: r.cost.available, priceBookVerifiedAt: r.cost.priceBookVerifiedAt }, allocation: r.allocation, imageModel: r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? r.settings.f4.imageModel : null, reports: dto.reports ?? null };
    let row: FactoryRun;
    try {
      row = await this.prisma.factoryRun.create({
        data: {
          projectId,
          userId,
          mode: r.mode,
          status: 'queued',
          configJson: config as unknown as Prisma.InputJsonValue,
          phasesJson: phases as unknown as Prisma.InputJsonValue,
          warningsJson: r.warnings as unknown as Prisma.InputJsonValue,
          f1ReportId: r.chain.f1?.id ?? null,
          f2AuditId: r.chain.f2?.id ?? null,
          f3StrategyId: r.chain.f3?.id ?? null,
          campaignId: r.chain.f4?.id ?? null,
        },
      });
    } catch (err) {
      // the partial unique index (one queued/running full run per project) makes the duplicate-start check atomic
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('A full campaign run is already in progress for this project.');
      throw err;
    }
    const approved = dto.approvedBudgetUsd ?? null;
    const budget = { approvedUsd: approved, imageRequestCap: r.imageRequestCap, plan: r.ledgerPlan };
    const loop = this.execute({ id: row.id, userId, projectId }, phases, r.settings, r.warnings, hooks, budget)
      .catch((err) => this.logger.error(`Factory run ${row.id} crashed: ${safeErrorMessage(err)}`))
      .finally(() => this.loops.delete(row.id));
    this.loops.set(row.id, loop);
    return this.toView(row, { withUsage: false });
  }

  // ---- the orchestration loop -------------------------------------------------------------------------------------------------

  private async execute(run: { id: string; userId: string; projectId: string }, phases: FactoryPhaseState[], settings: FactorySettings, warnings: string[], hooks: FactoryHooks, budget: { approvedUsd: number | null; imageRequestCap: number; plan: LedgerPlan | null } = { approvedUsd: null, imageRequestCap: 0, plan: null }) {
    const { id, userId, projectId } = run;
    const at = () => new Date().toISOString();
    const st = (k: PhaseKey) => phases.find((p) => p.phase === k)!;
    const persist = (extra: Prisma.FactoryRunUpdateManyMutationInput = {}) =>
      this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { phasesJson: phases as unknown as Prisma.InputJsonValue, ...extra } });
    const finish = async (status: FactoryStatus, error: string | null, extra: Prisma.FactoryRunUpdateManyMutationInput = {}) => {
      // the ledger is final and saved BEFORE the run is: whoever sees the end of the run also sees its final figures
      settleLedger();
      await flushLedger();
      this.ledgers.delete(id);
      for (const p of phases) if (p.status === 'pending') p.status = 'skipped';
      await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { status, errorMessage: error, completedAt: new Date(), currentPhase: null, phasesJson: phases as unknown as Prisma.InputJsonValue, ...extra } });
    };
    const stopReason = async (): Promise<'cancel' | 'shutdown' | null> => {
      if (this.shuttingDown) return 'shutdown';
      const f = await this.prisma.factoryRun.findUnique({ where: { id }, select: { cancelRequested: true, status: true } });
      return f?.cancelRequested || (f && !isActive(f.status)) ? 'cancel' : null;
    };
    const timeoutMs = hooks.phaseTimeoutMs ?? (settings.f4.variations ? 75 * 60_000 : DEFAULT_PHASE_TIMEOUT_MS);
    // ONE campaign budget for every paid request of the run: the phases, the image provider, the reviews and the repairs all reserve from this
    // ledger. It is saved while the run goes (a refresh shows it) and at the end; whatever is still in flight when the run stops may have been
    // billed, so it is kept as uncertain, never dropped.
    let ledgerTimer: NodeJS.Timeout | null = null;
    let ledgerDirty = false;
    const flushLedger = async () => {
      ledgerDirty = false;
      await this.prisma.factoryRun.updateMany({ where: { id }, data: { ledgerJson: ledger.snapshot() as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
    };
    const settleLedger = () => {
      ledger.finalize();
      if (ledgerTimer) clearTimeout(ledgerTimer);
      ledgerTimer = null;
    };
    const ledger = new SpendBudget(budget.approvedUsd, {
      maxImageRequests: budget.approvedUsd !== null || budget.imageRequestCap > 0 ? budget.imageRequestCap : null,
      onChange: () => {
        ledgerDirty = true;
        if (!ledgerTimer) ledgerTimer = setTimeout(() => ((ledgerTimer = null), ledgerDirty && void flushLedger()), 1000);
      },
    });
    if (budget.plan) ledger.setPlan(budget.plan);
    this.ledgers.set(id, ledger);
    const ids: Record<PhaseKey, string | null> = { discovery: null, audit: null, strategy: null, creative: null };
    const textModel = settings.model ?? undefined;

    try {
      await this.prisma.factoryRun.updateMany({ where: { id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
      for (const k of PHASE_ORDER) {
        const p = st(k);
        if (p.status !== 'pending') continue;

        if (p.action === 'reuse') {
          // re-verify right before relying on it: the result must still exist, be completed and belong to this project and user
          if (!(await this.stillReusable(k, p.outputId!, projectId, userId))) {
            Object.assign(p, { status: 'failed', completedAt: at(), error: 'The saved result is no longer available.' });
            return await finish('failed', `${p.title}: the saved result that was going to be reused is no longer available.`);
          }
          Object.assign(p, { status: 'reused', completedAt: at() });
          ids[k] = p.outputId;
          await persist();
          continue;
        }

        const stop = await stopReason();
        if (stop) return await finish(stop === 'shutdown' ? 'interrupted' : 'cancelled', stop === 'shutdown' ? 'Interrupted: the server is shutting down.' : 'Cancelled before this phase started; nothing further was run.');

        Object.assign(p, { status: 'running', startedAt: at() });
        await persist({ currentPhase: k });

        if (k === 'creative') {
          const rec = await this.prisma.marketingStrategyReport.findUnique({ where: { id: ids.strategy! }, select: { reportJson: true } });
          const recommended: string[] = ((rec?.reportJson as Obj | null)?.channels ?? []).map((c: Obj) => c.channel);
          const off = (settings.f4.channels ?? []).filter((c) => !recommended.includes(c));
          if (off.length) {
            warnings.push(`The strategy that was just produced does not recommend ${off.join(', ')}; the copy for it follows the brief and the strategy's general messaging only.`);
            await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
          }
        }

        // ONE campaign budget: every phase reserves from the same ledger. A phase starts only while something is left; the ledger itself refuses,
        // unsent, any request that would knowingly exceed the total or use money that required work (analysis, the required images) still needs.
        const left = ledger.snapshot().remainingUsd;
        if (left !== null && left < 0.0005) {
          const why = `The approved campaign budget of $${budget.approvedUsd!.toFixed(2)} is used up (about $${ledger.snapshot().committedUsd.toFixed(2)} spent or held so far), so this phase was not started. Nothing further was sent to OpenAI.`;
          Object.assign(p, { status: 'failed', completedAt: at(), error: why });
          return await finish('failed', `${p.code} ${p.title} did not start: ${why}`);
        }
        // start the existing phase service; the run id is stored the moment it exists
        let started: { id: string };
        try {
          const o = { factoryRunId: id, ledger, depth: settings.depth };
          if (k === 'discovery') started = await this.mozaik.startProductDiscovery(userId, projectId, { model: textModel, ...settings.f1, maxOutputTokens: settings.f1.maxOutputTokens ?? undefined } as StartDiscoveryDto, hooks.discovery ?? {}, o);
          else if (k === 'audit') started = await this.mozaik.startMarketingAudit(userId, projectId, { model: textModel, f1ReportId: ids.discovery!, ...settings.f2, maxOutputTokens: settings.f2.maxOutputTokens ?? undefined } as StartAuditDto, hooks.audit ?? {}, o);
          else if (k === 'strategy') {
            const f3 = settings.f3;
            started = await this.mozaik.startMarketStrategy(userId, projectId, { model: textModel, auditId: ids.audit!, maxModelCalls: f3.maxModelCalls, maxScouts: f3.maxScouts, maxReviews: f3.maxReviews, maxOutputTokens: f3.maxOutputTokens ?? undefined, useHolidayCalendar: f3.useHolidayCalendar, competitorUrls: f3.competitorUrls.length ? f3.competitorUrls : undefined, goal: f3.goal ?? undefined, budgetNote: f3.budgetNote ?? undefined } as StartStrategyDto, hooks.strategy ?? {}, o);
          } else {
            const f4 = settings.f4;
            started = await this.mozaik.startCreativeProduction(userId, projectId, { model: textModel, strategyId: ids.strategy!, imageModel: f4.imageModel ?? undefined, imageQuality: f4.imageQuality, imageSize: f4.imageSize ?? undefined, concepts: f4.concepts, channels: f4.channels ?? undefined, landing: f4.landing, maxImages: f4.maxImages, maxRegenerations: f4.variations ? 0 : f4.maxRegenerations, variations: f4.variations, layoutsPerOriginal: f4.layoutsPerOriginal, imageConcurrency: f4.imageConcurrency, maxVariants: f4.maxVariants, maxLayoutsPerConcept: f4.maxLayoutsPerConcept, maxRepairRounds: f4.maxRepairRounds, visionReviews: f4.visionReviews, maxModelCalls: f4.maxModelCalls, maxOutputTokens: f4.maxOutputTokens ?? undefined, imageModelStrategy: f4.imageModelStrategy, ...(settings.hybrid ? { hybrid: settings.hybrid } : {}) } as StartCreativeDto, hooks.creative ?? {}, o);
          }
        } catch (err) {
          Object.assign(p, { status: 'failed', completedAt: at(), error: messageOf(err), ...(reportFailureOf(err) ? { failure: reportFailureOf(err) } : {}) });
          return await finish('failed', `${p.code} ${p.title} could not start: ${messageOf(err)}`);
        }
        p.runId = started.id;
        await persist();
        // a cancel that arrived while the phase was starting (before its run id existed) is honored now
        if ((await stopReason()) === 'cancel') await this.cancelChild(userId, started.id);

        const { row, heldHere } = await this.mozaik.waitForRun(started.id, timeoutMs);
        p.completedAt = at();
        if (row.status === RunStatus.RUNNING) {
          if (!heldHere) {
            Object.assign(p, { status: 'failed', error: 'Interrupted: the phase was no longer running on this server.' });
            return await finish('interrupted', `${p.code} ${p.title} was interrupted.`);
          }
          await this.cancelChild(userId, started.id);
          Object.assign(p, { status: 'failed', error: 'The phase did not finish within the time limit and was cancelled.' });
          return await finish('failed', `${p.code} ${p.title} did not finish in time and was cancelled.`);
        }
        if (row.status === RunStatus.CANCELLED) {
          Object.assign(p, { status: 'cancelled', error: 'Cancelled.' });
          return await finish('cancelled', `${p.code} ${p.title} was cancelled; the remaining phases were not started.`);
        }
        if (row.status === RunStatus.INTERRUPTED) {
          Object.assign(p, { status: 'failed', error: row.errorMessage ?? 'Interrupted.', failure: await this.failureOf(started.id) });
          return await finish('interrupted', `${p.code} ${p.title} was interrupted.`);
        }
        const outputId = row.status === RunStatus.COMPLETED ? await this.savedOutput(k, row) : null;
        if (!outputId) {
          const refusal = ledger.lastRefusal(p.code);
          const error = `${row.status === RunStatus.COMPLETED ? 'The run finished but no saved result was found.' : (row.errorMessage ?? 'The run failed.')}${refusal ? ` ${refusalText(refusal)}` : ''}`;
          Object.assign(p, { status: 'failed', error, failure: await this.failureOf(started.id) });
          return await finish('failed', `${p.code} ${p.title} failed: ${error}`);
        }
        Object.assign(p, { status: 'completed', outputId, error: null });
        ids[k] = outputId;
        // this phase no longer needs the money projected for it: whatever it did not use is available to the rest of the campaign
        ledger.phaseDone(p.code);
        const refused = ledger.lastRefusal(p.code);
        if (refused) {
          warnings.push(refusalText(refused));
          await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
        }
        await persist({ ...(k === 'discovery' ? { f1ReportId: outputId } : k === 'audit' ? { f2AuditId: outputId } : k === 'strategy' ? { f3StrategyId: outputId } : { campaignId: outputId }) });
      }

      // the whole chain is in place; the run is complete only when the campaign package is actually saved
      const campaignId = ids.creative;
      const camp = campaignId ? await this.prisma.creativeCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, packageJson: true, metadataJson: true } }) : null;
      if (!camp || camp.status !== 'completed' || !camp.packageJson) return await finish('failed', 'The campaign package was not saved.');
      const agentsFailed = Boolean((camp.metadataJson as Obj | null)?.partial);
      // images that were wanted but not produced are a partial result, with the reason per concept (never a silent brand-colored fallback)
      const results: Obj[] = Array.isArray((camp.packageJson as Obj).imageResults) ? (camp.packageJson as Obj).imageResults : [];
      const imageFailures = results.filter((x) => x.outcome === 'failed');
      const imageLimited = results.filter((x) => x.outcome === 'skipped' && x.stage === 'budget');
      const sentence = (x: Obj | undefined) => (typeof x?.explanation === 'string' ? x.explanation : null);
      let imageMessage: string | null = null;
      // several originals per concept: the count of REAL images against what was asked for decides, never the concept-level view alone
      const counts = ((camp.packageJson as Obj).imageCounts ?? null) as Obj | null;
      const shortfall = !!counts && num(counts.generated) < num(counts.requested);
      if (shortfall) {
        const why = sentence(((camp.packageJson as Obj).imageVariations as Obj[] | undefined)?.find((v) => v.status !== 'generated'));
        imageMessage = `${num(counts!.generated)} of the ${num(counts!.requested)} requested original AI images were generated (${num(counts!.failed)} failed, ${num(counts!.blockedByBudget)} stopped by a budget, ${num(counts!.skipped)} not requested).${why ? ` ${why}` : ''} Use "Generate the missing images" on the campaign page to finish them without repeating the research.`;
        warnings.push(imageMessage);
      }
      if (!shortfall && imageFailures.length) {
        const lead = imageFailures.find((x) => x.requestAttempted) ?? imageFailures[0]; // the request that really failed, not an echo of it
        imageMessage = `${imageFailures.length} of ${results.length} concept(s) have no AI image: ${sentence(lead) ?? 'the image request failed'}`;
        warnings.push(imageMessage);
      }
      if (imageLimited.length) warnings.push(sentence(imageLimited[0]) ?? 'Some concepts were left without an AI image because of the configured image limit.');
      if (imageFailures.length || imageLimited.length || shortfall) await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
      const hyb = ((camp.packageJson as Obj).hybrid ?? null) as Obj | null;
      const tplPlanned = num(hyb?.counts?.templates?.planned);
      const tplDelivered = num(hyb?.counts?.templates?.rendered) + num(hyb?.counts?.templates?.fallbackRendered);
      const tplShort = !!hyb && tplDelivered < tplPlanned;
      const tplMessage = tplShort ? `${tplDelivered} of the ${tplPlanned} planned template creatives were rendered (${num(hyb?.counts?.templates?.failed)} failed, ${num(hyb?.counts?.templates?.skipped)} not rendered).` : null;
      if (tplMessage) {
        warnings.push(tplMessage);
        await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
      }
      const partial = agentsFailed || imageFailures.length > 0 || shortfall || tplShort;
      const reasons = [imageMessage, tplMessage, agentsFailed ? 'At least one creative participant failed or timed out (see the phase details and the review).' : null].filter((x): x is string => !!x);
      await finish(partial ? 'partial' : 'completed', partial ? `The campaign was saved, but not everything succeeded. ${reasons.join(' ')}` : null, { campaignId: camp.id });
    } catch (err) {
      this.logger.error(`Factory run ${id} failed: ${safeErrorMessage(err)}`);
      const running = phases.find((p) => p.status === 'running');
      if (running) Object.assign(running, { status: 'failed', completedAt: at(), error: messageOf(err) });
      await finish('failed', `The campaign run stopped unexpectedly: ${messageOf(err)}`).catch(() => undefined);
    }
    finally {
      // whatever is still in flight when the run stops may have been billed: it becomes uncertain (never forgotten, never counted as free)
      settleLedger();
      await flushLedger();
      this.ledgers.delete(id);
    }
  }

  private async stillReusable(k: PhaseKey, id: string, projectId: string, userId: string) {
    const where = { id, projectId, project: { userId }, run: { status: RunStatus.COMPLETED } };
    if (k === 'discovery') return !!(await this.prisma.productDiscoveryReport.findFirst({ where, select: { id: true } }));
    if (k === 'audit') return !!(await this.prisma.marketingAuditReport.findFirst({ where, select: { id: true } }));
    if (k === 'strategy') return !!(await this.prisma.marketingStrategyReport.findFirst({ where, select: { id: true } }));
    return !!(await this.prisma.creativeCampaign.findFirst({ where: { id, projectId, project: { userId }, status: 'completed' }, select: { id: true } }));
  }

  /** The saved result of a COMPLETED child run, verified (never assumed from the run status alone). */
  private async savedOutput(k: PhaseKey, row: { id: string; report?: { id: string } | null; audit?: { id: string } | null; strategy?: { id: string } | null; campaign?: { id: string } | null }) {
    if (k === 'discovery') return row.report?.id ?? null;
    if (k === 'audit') return row.audit?.id ?? null;
    if (k === 'strategy') return row.strategy?.id ?? null;
    const c = row.campaign ? await this.prisma.creativeCampaign.findUnique({ where: { id: row.campaign.id }, select: { id: true, status: true, packageJson: true } }) : null;
    return c && c.status === 'completed' && c.packageJson ? c.id : null;
  }

  private async cancelChild(userId: string, runId: string) {
    try {
      await this.mozaik.cancel(userId, runId);
    } catch {
      /* already finished: nothing to cancel */
    }
  }

  // ---- cancel ----------------------------------------------------------------------------------------------------------------

  /** Stops the active phase of THIS run and prevents later phases from starting. Other runs of the project are not touched. */
  async cancel(userId: string, factoryId: string) {
    const f = await this.owned(userId, factoryId);
    if (!isActive(f.status)) throw new ConflictException(`This campaign run is already ${f.status}.`);
    await this.prisma.factoryRun.updateMany({ where: { id: factoryId, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { cancelRequested: true } });
    // The phases are read AFTER the flag is saved. The loop saves a child's run id and THEN reads the flag, so whichever of the two happens last sees the other
    // and the child is always cancelled; a snapshot read before the flag could miss an id saved in between, and nobody would cancel the child.
    const fresh = await this.prisma.factoryRun.findUnique({ where: { id: factoryId }, select: { phasesJson: true } });
    const current = ((fresh?.phasesJson ?? f.phasesJson) as unknown as FactoryPhaseState[]).find((p) => p.status === 'running' && p.runId);
    if (current?.runId) await this.cancelChild(userId, current.runId);
    // an in-flight phase start (no run id yet) notices the flag the moment its run exists
    const loop = this.loops.get(factoryId);
    if (loop) await within(loop, 20_000);
    return this.view(userId, factoryId);
  }

  // ---- reads -----------------------------------------------------------------------------------------------------------------

  private async owned(userId: string, id: string) {
    const f = await this.prisma.factoryRun.findFirst({ where: { id, userId } });
    if (!f) throw new NotFoundException('Campaign run not found'); // 404, not 403: ids cannot be probed
    return f;
  }

  async view(userId: string, id: string) {
    return this.toView(await this.owned(userId, id), { withUsage: true });
  }

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const rows = await this.prisma.factoryRun.findMany({ where: { projectId, userId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return Promise.all(rows.map((r, i) => this.toView(r, { withUsage: i === 0 })));
  }

  private async usageOf(phases: FactoryPhaseState[], textModelOf: string | null = null) {
    const mine = phases.filter((p) => p.action === 'run' && p.runId);
    const phaseOf = new Map(mine.map((p) => [p.runId!, p.phase]));
    const byPhase: Record<string, { textCalls: number; totalTokens: number; inputTokens: number; outputTokens: number; usd: number | null }> = {};
    const agents = new Map<string, { phase: string; agent: string; calls: number; inputTokens: number; outputTokens: number; usd: number | null }>();
    const out = { textCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, imagesGenerated: 0, imagesFailed: 0, byPhase, agents: [] as Obj[], images: null as Obj | null, cost: null as Obj | null };
    if (!mine.length) return out;
    const rows = await this.prisma.campaignEvent.findMany({ where: { runId: { in: mine.map((p) => p.runId!) }, eventType: { in: ['inference.completed', 'visual.generated'] } }, select: { runId: true, eventType: true, payloadJson: true, participant: true } });
    const prog = { attempted: 0, generated: 0, failed: 0, blocked: 0, skipped: 0, last: null as Obj | null, imageUsd: 0, imageUsdKnown: false };
    let textUsd: number | null = 0;
    for (const e of rows) {
      const payload = (e.payloadJson ?? {}) as Obj;
      const ph = phaseOf.get(e.runId)!;
      byPhase[ph] ??= { textCalls: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
      if (e.eventType === 'visual.generated') {
        payload.failed ? out.imagesFailed++ : out.imagesGenerated++;
        const v = payload.variation as Obj | undefined;
        if (v) {
          if (v.requestAttempted) prog.attempted++;
          if (v.status === 'generated') prog.generated++;
          else if (v.status === 'failed') prog.failed++;
          else if (v.status === 'blocked_by_budget') prog.blocked++;
          else prog.skipped++;
          if (typeof v.costUsd === 'number') {
            prog.imageUsd += v.costUsd;
            prog.imageUsdKnown = true;
          }
          prog.last = { conceptId: payload.conceptId, conceptName: v.conceptName, variationId: v.variationId, variationName: v.variationName, status: v.status, model: v.providerModel };
        } else {
          // one image per concept (First Test, Demo): the concept-level result and the stored asset carry the same facts
          const r = payload.result as Obj | undefined;
          const asset = payload.asset as Obj | null | undefined;
          if (r?.requestAttempted) prog.attempted++;
          if (r?.outcome === 'generated') prog.generated++;
          else if (r?.outcome === 'failed') prog.failed++;
          else if (r) prog.skipped++;
          if (asset?.source === 'ai_image') {
            const c = imageActualCostUsd(asset.model as string, asset.usage as { input: number; output: number } | null);
            if (c !== null) {
              prog.imageUsd += c;
              prog.imageUsdKnown = true;
            }
          }
          prog.last = { conceptId: payload.conceptId, conceptName: r?.conceptName ?? null, variationId: null, variationName: null, status: r?.outcome ?? (payload.failed ? 'failed' : 'generated'), model: r?.model ?? null };
        }
        continue;
      }
      const u = (payload.tokenUsage ?? {}) as Obj;
      out.textCalls++;
      const eventCost = textCostUsd(textModelOf, { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cachedInputTokens: num((u.inputTokenDetails as Obj | undefined)?.cached_tokens) });
      textUsd = textUsd === null || eventCost === null ? null : textUsd + eventCost;
      out.inputTokens += num(u.inputTokens);
      out.outputTokens += num(u.outputTokens);
      out.totalTokens += num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens);
      byPhase[ph].textCalls++;
      byPhase[ph].totalTokens += num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens);
      byPhase[ph].inputTokens += num(u.inputTokens);
      byPhase[ph].outputTokens += num(u.outputTokens);
      byPhase[ph].usd = byPhase[ph].usd === null || eventCost === null ? null : byPhase[ph].usd! + eventCost;
      // agent by agent (the participant that made the call)
      const who = `${ph}|${e.participant ?? 'unknown'}`;
      const a = agents.get(who) ?? { phase: ph, agent: e.participant ?? 'unknown', calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 as number | null };
      a.calls++;
      a.inputTokens += num(u.inputTokens);
      a.outputTokens += num(u.outputTokens);
      a.usd = a.usd === null || eventCost === null ? null : a.usd + eventCost;
      agents.set(who, a);
    }
    out.agents = [...agents.values()].map((x) => ({ ...x, usd: x.usd === null ? null : Math.round(x.usd * 10_000) / 10_000 }));
    for (const v of Object.values(byPhase)) if (v.usd !== null) v.usd = Math.round(v.usd * 10_000) / 10_000;
    out.images = { ...prog, imageUsd: undefined, imageUsdKnown: undefined };
    out.cost = { currency: 'USD', textUsd: textUsd === null ? null : Math.round(textUsd * 10_000) / 10_000, imageUsd: prog.imageUsdKnown ? Math.round(prog.imageUsd * 10_000) / 10_000 : null, totalUsd: textUsd === null || (!prog.imageUsdKnown && prog.generated > 0) ? null : Math.round((textUsd + prog.imageUsd) * 10_000) / 10_000, note: 'Computed from the usage OpenAI reported, at the price book of the estimate. Not an invoice.' };
    return out;
  }

  /** The ONE campaign budget as the screen shows it: live while the run goes, saved afterwards, derived (and labelled so) for runs made before it existed. */
  private withLedger<T extends { cost: Obj | null; images: Obj | null }>(usage: T, f: FactoryRun, config: Obj) {
    const live = this.ledgers.get(f.id)?.snapshot() ?? null;
    const saved = (f.ledgerJson ?? null) as SpendSnapshot | null;
    const generated = typeof usage.images?.generated === 'number' ? (usage.images.generated as number) : null;
    const legacyPools = typeof config.textBudgetUsd === 'number' && typeof config.approvedBudgetUsd === 'number' ? { text: Math.min(config.textBudgetUsd, config.approvedBudgetUsd), image: Math.max(0, Math.round((config.approvedBudgetUsd - Math.min(config.textBudgetUsd, config.approvedBudgetUsd)) * 100) / 100) } : null;
    const budget = live
      ? budgetViewOf(live, { source: 'live', currentPhase: f.currentPhase, imagesGenerated: generated })
      : saved && typeof saved === 'object' && 'knownUsd' in saved
        ? budgetViewOf(saved, { source: 'saved', currentPhase: f.currentPhase, imagesGenerated: generated })
        : derivedBudgetView({ approvedUsd: typeof config.approvedBudgetUsd === 'number' ? config.approvedBudgetUsd : null, textUsd: (usage.cost?.textUsd ?? null) as number | null, imageUsd: (usage.cost?.imageUsd ?? null) as number | null, imagesGenerated: generated, textPoolUsd: legacyPools?.text ?? null, imagePoolUsd: legacyPools?.image ?? null, currentPhase: f.currentPhase, textCalls: typeof (usage as Obj).textCalls === 'number' ? ((usage as Obj).textCalls as number) : null });
    return { ...usage, budget };
  }

  /**
   * The FREE check of the saved reports a plan builds on: each one read through the shared contract, ownership (project and user) and lineage
   * verified. Reads the database, writes nothing, sends nothing. null = the plan reuses no saved report.
   */
  private async checkReusedReports(userId: string, projectId: string, plan: PlannedPhase[], chain: Chain) {
    const reused = (k: PhaseKey) => plan.some((p) => p.phase === k && p.action === 'reuse' && p.reuse);
    const expect = ([['discovery', 'F1'], ['audit', 'F2'], ['strategy', 'F3']] as const).filter(([k]) => reused(k)).map(([, c]) => c);
    if (!expect.length) return null;
    const check = await this.checkChainRows(userId, projectId, { f1: chain.f1?.id ?? null, f2: chain.f2?.id ?? null, f3: chain.f3?.id ?? null }, expect);
    const first = plan.find((p) => p.action === 'run');
    return { check, consumer: PHASE_META[first?.phase ?? 'creative'].title };
  }

  /** Loads the named reports of ONE project and user (never anyone else's) and runs the shared chain check on them. */
  private async checkChainRows(userId: string, projectId: string, ids: { f1: string | null; f2: string | null; f3: string | null }, expect: ('F1' | 'F2' | 'F3')[]) {
    const owned = { projectId, project: { userId } };
    const [f1, f2, f3] = await Promise.all([
      ids.f1 ? this.prisma.productDiscoveryReport.findFirst({ where: { id: ids.f1, ...owned } }) : null,
      ids.f2 ? this.prisma.marketingAuditReport.findFirst({ where: { id: ids.f2, ...owned } }) : null,
      ids.f3 ? this.prisma.marketingStrategyReport.findFirst({ where: { id: ids.f3, ...owned } }) : null,
    ]);
    return checkSavedChain({ projectId, f1, f2, f3, expect });
  }

  /** For a run that stopped because a saved report could not be used: what THIS version can read of the chain the run used, and what would run next. */
  private async recoveryOf(f: FactoryRun, phases: FactoryPhaseState[]): Promise<RecoveryView | null> {
    try {
      const out = (k: PhaseKey) => phases.find((p) => p.phase === k && (p.status === 'reused' || p.status === 'completed'))?.outputId ?? null;
      const ids = { f1: out('discovery'), f2: out('audit'), f3: out('strategy') };
      const expect = (['F1', 'F2', 'F3'] as const).filter((_, i) => [ids.f1, ids.f2, ids.f3][i]);
      if (!expect.length) return null;
      const check = await this.checkChainRows(f.userId, f.projectId, ids, expect);
      const next = phases.find((p) => p.status !== 'completed' && p.status !== 'reused');
      return { ready: check.ok, reports: check.reports.map((r) => ({ code: r.report, id: r.id, status: r.status, message: r.message })), lineageProblems: check.lineageProblems, resumeFrom: next ? { code: next.code, title: next.title } : null };
    } catch {
      return null; // the explanation is optional: the run itself is still readable
    }
  }

  /**
   * WHY a child run stopped: the first failure its own events recorded (the participant, the code, the safe sentence and its specifics). Read-only.
   * The first `phase.failed` names the participant that failed first; `factory.failed` is the fallback.
   */
  private async failureOf(runId: string): Promise<PhaseFailure | null> {
    try {
      const rows = await this.prisma.campaignEvent.findMany({ where: { runId, eventType: { in: ['phase.failed', 'factory.failed'] } }, orderBy: { sequence: 'asc' }, select: { eventType: true, participant: true, payloadJson: true } });
      const text = (v: unknown, n: number) => clip(typeof v === 'string' ? redact(v) : null, n);
      const phase = rows.find((r) => r.eventType === 'phase.failed');
      const first = ((phase?.payloadJson as Obj | null)?.errors as Obj[] | undefined)?.[0];
      if (first?.error) return { agent: text(first.agent, 80), code: text(first.error.code, 40), message: text(first.error.message, 300) ?? 'The participant failed.', detail: text(first.error.detail, 500) };
      const fatal = rows.find((r) => r.eventType === 'factory.failed');
      const p = (fatal?.payloadJson ?? null) as Obj | null;
      if (p) return { agent: text(p.participant ?? fatal?.participant, 80), code: text(p.code ?? p.reason, 40), message: text(p.message, 300) ?? 'The run failed.', detail: null };
    } catch {
      /* the explanation is optional: the run itself is still readable */
    }
    return null;
  }

  private async toView(f: FactoryRun, o: { withUsage: boolean }) {
    const phases = f.phasesJson as unknown as FactoryPhaseState[];
    const campaign = f.campaignId ? await this.prisma.creativeCampaign.findUnique({ where: { id: f.campaignId }, select: { id: true, approvalStatus: true, status: true, campaignName: true, packageJson: true, imageModel: true } }) : null;
    const approvalStatus = campaign?.packageJson ? (campaign.approvalStatus ?? null) : null;
    const status = f.status as FactoryStatus;
    const config = (f.configJson ?? {}) as Obj;
    const usage = o.withUsage ? await this.withLedger(await this.usageOf(phases, (config.textModel as string | null) ?? null), f, config) : null;
    // why it stopped, in words the screen can show; for a run saved before the reason was recorded it is read (never written) from the child run's events
    const bad = phases.find((p) => p.status === 'failed' || p.status === 'cancelled');
    // a phase that never started (no child run) or stopped on a saved report: check, read-only, what this version can read of the chain the run used
    const recovery = ['failed', 'interrupted'].includes(status) && bad && bad.status === 'failed' && (!bad.runId || REPORT_ERROR_CODES.includes(bad.failure?.code ?? '')) ? await this.recoveryOf(f, phases) : null;
    const failure = ['failed', 'cancelled', 'interrupted'].includes(status)
      ? explainFailure({ status, phases, derived: bad && !bad.failure && bad.runId && bad.status === 'failed' ? await this.failureOf(bad.runId) : null, budget: (usage?.budget ?? null) as BudgetView | null, errorMessage: f.errorMessage, recovery })
      : null;
    return {
      id: f.id,
      projectId: f.projectId,
      mode: f.mode,
      status,
      outcome: outcomeOf(status, approvalStatus),
      currentPhase: f.currentPhase,
      cancelRequested: f.cancelRequested,
      startedAt: f.startedAt,
      completedAt: f.completedAt,
      createdAt: f.createdAt,
      errorMessage: f.errorMessage,
      warnings: (f.warningsJson ?? []) as string[],
      phases,
      chain: { f1ReportId: f.f1ReportId, f2AuditId: f.f2AuditId, f3StrategyId: f.f3StrategyId },
      campaignId: campaign?.packageJson ? f.campaignId : null,
      campaignName: campaign?.campaignName ?? null,
      approvalStatus,
      config: { preset: config.preset ?? null, mode: config.mode ?? f.mode, rerunCreative: !!config.rerunCreative, reusePartial: config.reusePartial !== false, textModel: config.textModel ?? null, imageModel: config.imageModel ?? null, settings: config.settings ?? null, approvedBudgetUsd: config.approvedBudgetUsd ?? null, textBudgetUsd: config.textBudgetUsd ?? null, confirmedUnpricedImages: config.confirmedUnpricedImages === true, estimate: config.estimate ?? null, allocation: config.allocation ?? null },
      usage,
      failure,
      quality: campaign?.packageJson ? ((campaign.packageJson as Obj).quality ?? null) : null,
    };
  }

  /** The persisted Mozaik activity of all phases this run executed, in order (the same events the phase panels show). */
  async events(userId: string, id: string, limit = 400) {
    const f = await this.owned(userId, id);
    const phases = (f.phasesJson as unknown as FactoryPhaseState[]).filter((p) => p.runId);
    if (!phases.length) return { items: [] as Obj[], total: 0 };
    const phaseOf = new Map(phases.map((p) => [p.runId!, p]));
    const rows = await this.prisma.campaignEvent.findMany({
      where: { runId: { in: phases.map((p) => p.runId!) }, eventType: { in: [...ACTIVITY_EVENT_TYPES] } },
      select: { id: true, runId: true, sequence: true, eventType: true, participant: true, payloadJson: true, createdAt: true },
    });
    const order = new Map(PHASE_ORDER.map((k, i) => [k, i]));
    rows.sort((a, b) => (order.get(phaseOf.get(a.runId)!.phase)! - order.get(phaseOf.get(b.runId)!.phase)!) || a.sequence - b.sequence);
    const items = rows.slice(-limit).map((e) => {
      const p = phaseOf.get(e.runId)!;
      return { id: e.id, runId: e.runId, phase: p.phase, code: p.code, sequence: e.sequence, type: e.eventType, participant: e.participant, at: e.createdAt, summary: summarizeEvent(e.eventType, (e.payloadJson ?? {}) as Obj), importance: importanceOf(e.eventType) };
    });
    return { items, total: rows.length };
  }
}
