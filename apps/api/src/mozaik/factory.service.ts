import { ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, RunStatus, type FactoryRun } from '@prisma/client';
import {
  AnthropicClient,
  isClaudeModel,
  resolveAnthropicBaseUrl,
  OpenAIClient,
  capOutputTokens,
  checkSavedChain,
  estimateCreativeRun,
  getCollection,
  LIBRARY_VERSION,
  planDeliverables,
  redact,
  resolveOpenAIBaseUrl,
  safeErrorMessage,
  SpendBudget,
  TEMPLATE_LIBRARY,
  textCostUsd,
  textModelWarning,
  themedTemplates,
  type CreativeRunConfig,
  type DiscoveryRunConfig,
  type HybridSettings,
  type LedgerPlan,
  type SpendSnapshot,
  type StrategyRunConfig,
} from '@launchpilot/agents';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StartFactoryDto } from './dto/factory.dto';
import { ImageLibraryService } from '../visual/image-library.service';
import { ACTIVITY_EVENT_TYPES, importanceOf, summarizeEvent } from './event-summary';
import { budgetViewOf, derivedBudgetView, refusalText, type BudgetView } from './budget-view';
import { explainFailure, type RecoveryView } from './failure-view';
import { chainProblem, reportFailureOf, REPORT_ERROR_CODES } from './report-errors';
import { estimateCost, profileFromUsage, type Profiles } from './cost-estimate';
import { assessInputs, type InputReadiness } from './input-readiness';
import {
  ACTIVE_FACTORY_STATUSES,
  ALL_PHASES,
  PHASE_META,
  PHASE_ORDER,
  STAGE_LIMITS,
  buildPhasePlan,
  campaignSettings,
  initialPhases,
  outcomeOf,
  planResearch,
  type CampaignSettings,
  type FactoryPhaseState,
  type FactoryStatus,
  type PhaseFailure,
  type PhaseKey,
  type ResearchCandidate,
} from './factory-plan';
import { VisualService } from '../visual/visual.service';
import { HybridInputsService } from './hybrid-support';
import { MozaikService } from './mozaik.service';

type Obj = Record<string, any>;

/** Test seams (timeouts, fake tools, the clock) for the stages. Not reachable through HTTP. */
export interface FactoryHooks {
  discovery?: Partial<DiscoveryRunConfig>;
  strategy?: Partial<StrategyRunConfig>;
  creative?: Partial<CreativeRunConfig>;
  /** How long the orchestrator waits for one stage before cancelling it. Default 35 minutes. */
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
const latest = (...dates: (Date | null | undefined)[]) => dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

interface Blocker {
  code: 'provider_unsupported' | 'design_missing' | 'design_unconfirmed' | 'design_palette' | 'design_formats' | 'design_collection' | 'no_credentials' | 'no_model' | 'model_unavailable' | 'factory_active' | 'run_active' | 'missing_name' | 'missing_description' | 'report_unreadable' | 'report_damaged' | 'report_lineage';
  message: string;
}

/** The configuration saved with a run (FactoryRun.configJson). Never credentials. */
interface RunConfig {
  workflow: 'campaign_production';
  settings: CampaignSettings;
  design: HybridSettings;
  textModel: string | null;
  approvedBudgetUsd: number | null;
  sharedBudget: true;
  confirmedCost: boolean;
  estimate: { typicalUsd: number | null; maxUsd: number | null; available: boolean; priceBookVerifiedAt: string };
}

/**
 * CAMPAIGN PRODUCTION, the one production workflow: Business Research (F1, reused when the project's research is current) -> Marketing Strategy
 * (F3) -> Creative Production (F4). A deterministic orchestrator (the Campaign Coordinator's outer loop) over the stage services: it runs each
 * stage for real, waits for its persisted result (no sleeping or guessing), stores every transition and stops at the first failure or cancel.
 * It never retries a stage by itself (a retry could cost money) and never resumes after a restart. It holds no credentials: each stage resolves
 * the user's default provider and key itself. There are no presets and no modes.
 */
@Injectable()
export class FactoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FactoryService.name);
  private readonly loops = new Map<string, Promise<void>>();
  /** The campaign budget ledger of every run in progress in this server (the saved copy is FactoryRun.ledgerJson). */
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

  /** A run left active by a previous process can never continue: it is marked interrupted, never resumed or "completed". */
  async onModuleInit() {
    const orphans = await this.prisma.factoryRun.findMany({ where: { status: { in: ACTIVE_FACTORY_STATUSES } } });
    for (const f of orphans) {
      const phases = (f.phasesJson as unknown as FactoryPhaseState[]).map((p) => ({ ...p }));
      for (const p of phases) {
        if (p.status === 'running') Object.assign(p, { status: 'failed', completedAt: new Date().toISOString(), error: 'Interrupted: the server restarted while this stage was running. Nothing was resumed or repeated.' });
        else if (p.status === 'pending') p.status = 'skipped';
      }
      const message = 'Interrupted: the server restarted while this campaign was being produced. Nothing was resumed or repeated, so no further paid request was made.';
      await this.prisma.factoryRun.updateMany({ where: { id: f.id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { status: 'interrupted', currentPhase: null, completedAt: new Date(), errorMessage: message, phasesJson: phases as unknown as Prisma.InputJsonValue } });
      this.logger.warn(`Marked orphaned campaign run ${f.id} as interrupted`);
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    await within(Promise.allSettled([...this.loops.values()]), 15_000);
  }

  // ---- planning (no paid request; only the free model list) -------------------------------------------------------------------

  /** Completed business research reports of the project, newest first. */
  private async researchCandidates(projectId: string): Promise<ResearchCandidate[]> {
    const rows = await this.prisma.productDiscoveryReport.findMany({ where: { projectId, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, runId: true, createdAt: true, model: true, schemaVersion: true, reportJson: true } });
    return rows.map((r) => ({ id: r.id, runId: r.runId, createdAt: r.createdAt, model: r.model, partial: Boolean((r.reportJson as Obj | null)?.partial), usable: r.schemaVersion >= 2 }));
  }

  /** When the project's own information last changed (intake, uploads, social profiles, notes, Get Content, the image library). */
  private async inputsChangedAt(projectId: string): Promise<Date | null> {
    const newest = { orderBy: { updatedAt: 'desc' as const }, select: { updatedAt: true } };
    const [intake, asset, social, note, brand, image] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId }, select: { updatedAt: true } }),
      this.prisma.projectAsset.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.socialProfile.findFirst({ where: { projectId }, ...newest }),
      this.prisma.workspaceNote.findFirst({ where: { projectId }, ...newest }),
      this.prisma.projectBrandContent.findFirst({ where: { projectId }, ...newest }).catch(() => null),
      this.prisma.projectImage.findFirst({ where: { projectId }, ...newest }).catch(() => null),
    ]);
    return latest(intake?.updatedAt, asset?.createdAt, social?.updatedAt, note?.updatedAt, brand?.updatedAt, image?.updatedAt);
  }

  /** Tokens per call measured from the user's own earlier runs of each stage (real usage saved with the results), for the cost estimate. */
  private async loadProfiles(projectId: string): Promise<Profiles> {
    const take = 5;
    const usageOf = (rows: { metadataJson: unknown }[]) =>
      rows.map((r) => {
        const t = ((r.metadataJson ?? {}) as Obj).usage?.total ?? ((r.metadataJson ?? {}) as Obj).usage?.text ?? {};
        return { calls: num(t.calls), inputTokens: num(t.inputTokens), outputTokens: num(t.outputTokens) };
      });
    const done = { run: { status: RunStatus.COMPLETED } };
    const q = { where: { projectId, ...done }, orderBy: { createdAt: 'desc' as const }, take, select: { metadataJson: true } };
    const [f1, f3, f4] = await Promise.all([
      this.prisma.productDiscoveryReport.findMany(q),
      this.prisma.marketingStrategyReport.findMany(q),
      this.prisma.creativeCampaign.findMany({ where: { projectId, status: 'completed' }, orderBy: { createdAt: 'desc' }, take, select: { metadataJson: true } }),
    ]);
    const out: Profiles = {};
    for (const [k, rows] of [['discovery', f1], ['strategy', f3], ['creative', f4]] as [PhaseKey, { metadataJson: unknown }[]][]) {
      const p = profileFromUsage(usageOf(rows));
      if (p) out[k] = p;
    }
    return out;
  }

  private async listProviderModels(provider: 'openai' | 'anthropic', apiKey: string): Promise<string[] | null> {
    try {
      if (provider === 'anthropic') return (await new AnthropicClient({ apiKey, baseUrl: resolveAnthropicBaseUrl() }).listModels(AbortSignal.timeout(15_000))).map((m) => m.id);
      return (await new OpenAIClient({ apiKey, baseUrl: resolveOpenAIBaseUrl() }).listModels(AbortSignal.timeout(15_000))).map((m) => m.id);
    } catch {
      return null; // an outage must not look like a missing model
    }
  }

  /** What the project has (never any file content or secret) and what is missing. Only the REQUIRED items block. */
  private async inputReadiness(userId: string, projectId: string, project: { name: string; description: string | null }, settings: CampaignSettings, design: HybridSettings): Promise<InputReadiness> {
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
        intake: intake && { productName: intake.productName, shortDescription: intake.shortDescription, websiteUrl: intake.websiteUrl, githubUrl: intake.githubUrl, targetMarket: intake.targetMarket, targetAudience: settings.targetAudience, marketingGoal: settings.objective, campaignDuration: intake.campaignDuration, stylePreference: intake.stylePreference },
        socialProfiles,
        assets: { logo: n('logo'), images: n('image'), screenshots: n('screenshot'), references: n('reference') },
        competitors: settings.competitorUrls.length,
        channels: settings.channels,
        style: design.design?.collectionId ?? null,
        pinterestConnected: pin?.status === 'connected',
        referenceCount: design.references.length,
      },
      { enforce: true },
    );
  }

  /** `offline` = the free preview: no request to any provider (not even the model list). Models are then assumed, never verified. */
  private async resolve(userId: string, projectId: string, dto: StartFactoryDto, opts: { offline?: boolean } = {}) {
    const offline = opts.offline === true;
    const project = await this.projects.assertOwned(userId, projectId);
    const intake = await this.prisma.productIntake.findUnique({ where: { projectId } });
    const settings = campaignSettings(dto, { marketingGoal: intake?.marketingGoal ?? null, targetAudience: intake?.targetAudience ?? null, seasonalCalendar: intake?.enableSeasonalCalendar ?? false });
    const blockers: Blocker[] = [];
    const warnings: string[] = [];

    // the campaign design and the approved, rights-cleared pictures of THIS project (normalized by the server; nothing is fetched or sent)
    const designIn = await this.hybridInputs.prepare(projectId, (dto.design ?? {}) as never, false);
    const design = designIn.hybrid;
    warnings.push(...designIn.warnings);
    if (!design.design) blockers.push({ code: 'design_missing', message: 'Choose a template collection and a palette in Campaign Design and confirm it: every visual of the campaign is drawn with them.' });

    // Business Research is reused when it is current; strategy and creative always run for THIS campaign
    const research = planResearch(await this.researchCandidates(projectId), await this.inputsChangedAt(projectId), settings.refreshResearch);
    if (research.note) warnings.push(research.note);
    const plan = buildPhasePlan(research.reuse);
    if (research.reuse) {
      // FREE and deterministic: the reused report must exist, be readable by this version and belong to this project
      const row = await this.prisma.productDiscoveryReport.findFirst({ where: { id: research.reuse.id, projectId, project: { userId } } });
      const check = checkSavedChain({ projectId, f1: row, expect: ['F1'] });
      if (!check.ok) {
        const problem = chainProblem(PHASE_META.strategy.title, check);
        blockers.push({ code: problem.code, message: problem.message });
      }
      for (const rc of check.reports) if (rc.status === 'normalized') warnings.push(rc.message);
    }

    const inputs = await this.inputReadiness(userId, projectId, project, settings, design);
    blockers.push(...inputs.blockers);

    // THE provider of the whole campaign: the persisted default (Settings > AI providers) and its saved model. Nothing is switched silently.
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } });
    const textProvider = (owner.defaultAiProvider ?? 'openai') as 'openai' | 'anthropic' | 'gemini';
    const providerName = textProvider === 'anthropic' ? 'Claude' : textProvider === 'gemini' ? 'Gemini' : 'OpenAI';
    const cred = textProvider === 'gemini' ? null : await this.credentials.getDecryptedCredential(userId, textProvider);
    const textModel = cred?.model ?? null;
    if (textProvider === 'gemini') blockers.push({ code: 'provider_unsupported', message: 'The campaign agents run on OpenAI or Claude. Make one of them the default provider under Settings > AI providers.' });
    else if (offline) {
      warnings.push(`Free preview: nothing was sent to ${providerName}, so your key and model were not checked. Generating the campaign checks them first.`);
      if (!textModel) warnings.push('No text model is saved yet (Settings > AI providers), so the cost cannot be estimated.');
    } else if (!cred) blockers.push({ code: 'no_credentials', message: `A campaign needs your ${providerName} API key. Add it under Settings > AI providers.` });
    else if (!textModel) blockers.push({ code: 'no_model', message: `Choose ${textProvider === 'anthropic' ? 'a Claude' : 'an OpenAI'} text model first (Settings > AI providers). LaunchPilot never picks one for you.` });
    else if ((textProvider === 'anthropic') !== isClaudeModel(textModel)) blockers.push({ code: 'model_unavailable', message: `The text model "${textModel}" is not ${textProvider === 'anthropic' ? 'a Claude' : 'an OpenAI'} model. LaunchPilot never switches providers on its own: pick a ${providerName} model or change the default provider in Settings > AI providers.` });
    else {
      const models = await this.listProviderModels(textProvider, cred.apiKey);
      if (models && !models.includes(textModel)) blockers.push({ code: 'model_unavailable', message: `The text model "${textModel}" is not available to your ${providerName} key. Pick one of your models in Settings > AI providers.` });
      else if (!models) warnings.push(`Your ${providerName} model list could not be read just now, so the model was not pre-checked. A wrong model would be reported by the first stage.`);
    }

    // an active campaign run or stage run owns the project
    const [activeFactory, activeRun] = await Promise.all([
      this.prisma.factoryRun.findFirst({ where: { projectId, status: { in: ACTIVE_FACTORY_STATUSES } }, select: { id: true } }),
      this.prisma.campaignRun.findFirst({ where: { projectId, status: RunStatus.RUNNING }, select: { id: true } }),
    ]);
    if (!offline && activeFactory) blockers.push({ code: 'factory_active', message: 'A campaign is already being produced for this project.' });
    else if (!offline && activeRun) blockers.push({ code: 'run_active', message: 'Another run is in progress for this project. Wait for it to finish or cancel it first.' });

    // the deliverables plan (free, local, deterministic): what the campaign will contain, and what the chosen collection cannot draw
    const collection = design.design ? (getCollection(design.design.collectionId) ?? null) : null;
    const library = collection ? themedTemplates(collection) : TEMPLATE_LIBRARY;
    const deliverables = planDeliverables({ concepts: Array.from({ length: settings.concepts }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}` })), platforms: settings.channels, library, hasPicture: designIn.brandImageCount > 0, facts: design.facts });
    warnings.push(...deliverables.warnings);
    const designPreflight = design.design ? await this.visual.preflight(projectId, design, { concepts: settings.concepts, brandImageCount: designIn.brandImageCount, deliverables: deliverables.slots.length }) : null;
    if (designPreflight) {
      blockers.push(...designPreflight.blockers);
      warnings.push(...designPreflight.warnings);
    }
    const imagePreflight = await this.library.preflight(projectId, { concepts: settings.concepts, slots: deliverables.slots.length, autoStock: design.imagery.autoStock });
    warnings.push(...imagePreflight.warnings);

    // the cost estimate: text calls only (no image is ever requested). Prices come from the price book, tokens from your earlier runs.
    const L = STAGE_LIMITS;
    const creativeEst = estimateCreativeRun({ concepts: settings.concepts, platforms: settings.channels.length, maxRepairRounds: L.creative.maxRepairRounds, visionReviews: L.creative.visionReviews, maxModelCalls: L.creative.maxModelCalls });
    const runs = (k: PhaseKey) => plan.find((p) => p.phase === k)?.action === 'run';
    const tok = (n: number) => capOutputTokens(textModel, n).tokens;
    const cost = estimateCost({
      textModel,
      phases: [
        { phase: 'discovery', runs: runs('discovery'), typicalCalls: L.discovery.typicalCalls, capCalls: L.discovery.maxModelCalls, outputCap: tok(L.discovery.maxOutputTokens) },
        { phase: 'strategy', runs: runs('strategy'), typicalCalls: L.strategy.typicalCalls, capCalls: L.strategy.maxModelCalls, outputCap: tok(L.strategy.maxOutputTokens) },
        { phase: 'creative', runs: runs('creative'), typicalCalls: creativeEst.textCalls.typical, capCalls: L.creative.maxModelCalls, outputCap: tok(L.creative.maxOutputTokens) },
      ],
      profiles: await this.loadProfiles(projectId),
      approvedUsd: dto.approvedBudgetUsd ?? null,
    });
    warnings.push(...cost.warnings);
    const textWarn = textModelWarning(textModel);
    if (textWarn) warnings.push(textWarn);
    // the projection the shared ledger protects: the typical spend of every stage still to run (with a margin). Revisable, never a fixed split.
    const ledgerPlan: LedgerPlan = {
      phases: PHASE_ORDER.map((k, idx) => {
        const ph = cost.text.phases[idx];
        return { label: PHASE_META[k].code, order: idx + 1, projectedUsd: !ph.runs ? 0 : ph.typicalUsd === null ? null : Math.round(ph.typicalUsd * 1.25 * 10_000) / 10_000 };
      }),
    };
    return { project, intake, settings, design, designIn, plan, research, blockers, warnings, inputs, textProvider, providerName, textModel, deliverables, designPreflight, imagePreflight, creativeEst, cost, ledgerPlan, collection };
  }

  /** The plan the user confirms: which stages run, what the campaign will contain, and the one budget. Spends nothing. */
  async preflight(userId: string, projectId: string, dto: StartFactoryDto = {}, opts: { offline?: boolean } = {}) {
    const r = await this.resolve(userId, projectId, dto, opts);
    const s = r.settings;
    const byChannel = r.deliverables.slots.reduce<Record<string, number>>((m, x) => ({ ...m, [x.channel]: (m[x.channel] ?? 0) + 1 }), {});
    return {
      ok: r.blockers.length === 0,
      offline: opts.offline === true,
      blockers: r.blockers,
      warnings: r.warnings,
      project: { id: r.project.id, name: r.intake?.productName ?? r.project.name },
      brief: { objective: s.objective, targetAudience: s.targetAudience, language: r.intake?.preferredLanguage ?? null, targetMarket: r.intake?.targetMarket ?? null },
      settings: s,
      design: r.design,
      provider: { id: r.textProvider, name: r.providerName, model: r.textModel, source: 'settings' as const },
      phases: r.plan.map((p) => ({ phase: p.phase, code: PHASE_META[p.phase].code, title: PHASE_META[p.phase].title, action: p.action, reuse: p.reuse ? { id: p.reuse.id, createdAt: p.reuse.createdAt.toISOString(), model: p.reuse.model, partial: p.reuse.partial } : null })),
      deliverables: {
        platforms: r.deliverables.platforms,
        planned: r.deliverables.slots.length,
        byChannel,
        slots: r.deliverables.slots,
        notPlanned: r.deliverables.notPlanned,
        rules: r.deliverables.rules,
        note: 'Every platform gets its own post text, hook, CTA and hashtags; TikTok also gets a short video concept and script (no video is generated). Web/display ads and print designs get their own copy.',
      },
      statement: { aiImages: 'AI-generated images: 0 (LaunchPilot never generates images)', imagery: 'Pictures: your approved uploads, approved website/repository pictures and licensed stock; typography-first when none fit', agents: 'Mozaik agents: Business Researcher, Marketing Strategist, Content Writer, Visual Researcher, Creative Designer, Quality Reviewer' },
      designCheck: r.designPreflight,
      imagery: r.imagePreflight,
      inputs: r.inputs,
      library: { templates: (r.collection ? themedTemplates(r.collection) : TEMPLATE_LIBRARY).filter((t) => t.status === 'active').length, version: LIBRARY_VERSION, collection: r.collection ? { id: r.collection.id, name: r.collection.name } : null },
      cost: r.cost,
      budget: { ...r.cost.budget, required: true },
      limitations: [
        'Audience and channel fit are hypotheses until validated with real data; no performance figure is promised.',
        'A stage that fails stops the campaign: nothing is retried automatically, because a retry could cost money.',
        s.useHolidayCalendar ? 'The public-holiday calendar is asked (a free service).' : 'The seasonal calendar is off, so seasonal statements are labelled hypotheses.',
        'Competitor research uses only URLs you supply and a search provider if the server has one configured.',
        'Nothing is published anywhere; the campaign stays in LaunchPilot until you download it.',
      ],
    };
  }

  // ---- start -----------------------------------------------------------------------------------------------------------------

  async start(userId: string, projectId: string, dto: StartFactoryDto = {}, hooks: FactoryHooks = {}) {
    const r = await this.resolve(userId, projectId, dto);
    const active = r.blockers.find((b) => b.code === 'factory_active' || b.code === 'run_active');
    if (active) throw new ConflictException(active.message);
    if (r.blockers.length) throw new UnprocessableEntityException(r.blockers[0].message);
    // a campaign never starts without ONE approved budget and an explicit confirmation of the estimate
    if (!(dto.approvedBudgetUsd && dto.approvedBudgetUsd > 0 && dto.confirmCost === true)) {
      throw new UnprocessableEntityException(`Review the cost estimate, approve one campaign budget (approvedBudgetUsd) and confirm it (confirmCost) to start. Nothing has been sent to ${r.providerName}.`);
    }
    if (r.cost.budget.status === 'below_estimate') throw new UnprocessableEntityException(r.cost.budget.message);

    const phases = initialPhases(r.plan);
    const config: RunConfig = { workflow: 'campaign_production', settings: r.settings, design: r.design, textModel: r.textModel, approvedBudgetUsd: dto.approvedBudgetUsd, sharedBudget: true, confirmedCost: true, estimate: { typicalUsd: r.cost.totals.typicalUsd, maxUsd: r.cost.totals.maxUsd, available: r.cost.available, priceBookVerifiedAt: r.cost.priceBookVerifiedAt } };
    let row: FactoryRun;
    try {
      row = await this.prisma.factoryRun.create({
        data: {
          projectId,
          userId,
          mode: 'campaign_production',
          status: 'queued',
          configJson: redact(config) as unknown as Prisma.InputJsonValue,
          phasesJson: phases as unknown as Prisma.InputJsonValue,
          warningsJson: r.warnings as unknown as Prisma.InputJsonValue,
          f1ReportId: r.research.reuse?.id ?? null,
        },
      });
    } catch (err) {
      // the partial unique index (one queued/running run per project) makes the duplicate-start check atomic
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('A campaign is already being produced for this project.');
      throw err;
    }
    const loop = this.execute({ id: row.id, userId, projectId }, phases, config, r.warnings, hooks, r.ledgerPlan)
      .catch((err) => this.logger.error(`Campaign run ${row.id} crashed: ${safeErrorMessage(err)}`))
      .finally(() => this.loops.delete(row.id));
    this.loops.set(row.id, loop);
    return this.toView(row, { withUsage: false });
  }

  // ---- the orchestration loop -------------------------------------------------------------------------------------------------

  private async execute(run: { id: string; userId: string; projectId: string }, phases: FactoryPhaseState[], config: RunConfig, warnings: string[], hooks: FactoryHooks, ledgerPlan: LedgerPlan | null) {
    const { id, userId, projectId } = run;
    const s = config.settings;
    const L = STAGE_LIMITS;
    const at = () => new Date().toISOString();
    const st = (k: PhaseKey) => phases.find((p) => p.phase === k)!;
    const persist = (extra: Prisma.FactoryRunUpdateManyMutationInput = {}) =>
      this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { phasesJson: phases as unknown as Prisma.InputJsonValue, ...extra } });
    const saveWarnings = () => this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
    // ONE campaign budget for every paid request of the run, saved while the run goes (a refresh shows it) and at the end. Whatever is still in
    // flight when the run stops may have been billed, so it is kept as uncertain, never dropped.
    let ledgerTimer: NodeJS.Timeout | null = null;
    let ledgerDirty = false;
    const ledger = new SpendBudget(config.approvedBudgetUsd, {
      maxImageRequests: 0,
      onChange: () => {
        ledgerDirty = true;
        if (!ledgerTimer) ledgerTimer = setTimeout(() => ((ledgerTimer = null), ledgerDirty && void flushLedger()), 1000);
      },
    });
    const flushLedger = async () => {
      ledgerDirty = false;
      await this.prisma.factoryRun.updateMany({ where: { id }, data: { ledgerJson: ledger.snapshot() as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
    };
    const settleLedger = () => {
      ledger.finalize();
      if (ledgerTimer) clearTimeout(ledgerTimer);
      ledgerTimer = null;
    };
    if (ledgerPlan) ledger.setPlan(ledgerPlan);
    this.ledgers.set(id, ledger);
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
    const timeoutMs = hooks.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
    const ids: Record<PhaseKey, string | null> = { discovery: null, audit: null, strategy: null, creative: null };

    try {
      await this.prisma.factoryRun.updateMany({ where: { id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
      for (const k of PHASE_ORDER) {
        const p = st(k);
        if (p.status !== 'pending') continue;

        if (p.action === 'reuse') {
          // re-verify right before relying on it: the research must still exist, be completed and belong to this project and user
          const still = await this.prisma.productDiscoveryReport.findFirst({ where: { id: p.outputId!, projectId, project: { userId }, run: { status: RunStatus.COMPLETED } }, select: { id: true } });
          if (!still) {
            Object.assign(p, { status: 'failed', completedAt: at(), error: 'The saved research is no longer available.' });
            return await finish('failed', `${p.title}: the saved research that was going to be reused is no longer available.`);
          }
          Object.assign(p, { status: 'reused', completedAt: at() });
          ids[k] = p.outputId;
          await persist();
          continue;
        }

        const stop = await stopReason();
        if (stop) return await finish(stop === 'shutdown' ? 'interrupted' : 'cancelled', stop === 'shutdown' ? 'Interrupted: the server is shutting down.' : 'Cancelled before this stage started; nothing further was run.');

        Object.assign(p, { status: 'running', startedAt: at() });
        await persist({ currentPhase: k });

        // ONE campaign budget: a stage starts only while something is left; the ledger itself refuses, unsent, any request that would exceed it
        const left = ledger.snapshot().remainingUsd;
        if (left !== null && left < 0.0005) {
          const why = `The approved campaign budget of $${(config.approvedBudgetUsd ?? 0).toFixed(2)} is used up (about $${ledger.snapshot().committedUsd.toFixed(2)} spent or held so far), so this stage was not started. Nothing further was sent.`;
          Object.assign(p, { status: 'failed', completedAt: at(), error: why });
          return await finish('failed', `${p.code} ${p.title} did not start: ${why}`);
        }
        let started: { id: string };
        try {
          const o = { factoryRunId: id, ledger };
          if (k === 'discovery') started = await this.mozaik.startProductDiscovery(userId, projectId, { maxModelCalls: L.discovery.maxModelCalls, maxOutputTokens: L.discovery.maxOutputTokens }, hooks.discovery ?? {}, o);
          else if (k === 'strategy') started = await this.mozaik.startMarketStrategy(userId, projectId, { f1ReportId: ids.discovery!, objective: s.objective, targetAudience: s.targetAudience, competitorUrls: s.competitorUrls, useHolidayCalendar: s.useHolidayCalendar, maxModelCalls: L.strategy.maxModelCalls, maxOutputTokens: L.strategy.maxOutputTokens }, hooks.strategy ?? {}, o);
          else started = await this.mozaik.startCreativeProduction(userId, projectId, { strategyId: ids.strategy!, channels: s.channels, concepts: s.concepts, objective: s.objective, audience: s.targetAudience, voice: s.voice ?? null, design: config.design, maxRepairRounds: L.creative.maxRepairRounds, visionReviews: L.creative.visionReviews, maxModelCalls: L.creative.maxModelCalls, maxOutputTokens: L.creative.maxOutputTokens }, hooks.creative ?? {}, o);
        } catch (err) {
          Object.assign(p, { status: 'failed', completedAt: at(), error: messageOf(err), ...(reportFailureOf(err) ? { failure: reportFailureOf(err) } : {}) });
          return await finish('failed', `${p.code} ${p.title} could not start: ${messageOf(err)}`);
        }
        p.runId = started.id;
        await persist();
        // a cancel that arrived while the stage was starting (before its run id existed) is honored now
        if ((await stopReason()) === 'cancel') await this.cancelChild(userId, started.id);

        const { row, heldHere } = await this.mozaik.waitForRun(started.id, timeoutMs);
        p.completedAt = at();
        if (row.status === RunStatus.RUNNING) {
          if (!heldHere) {
            Object.assign(p, { status: 'failed', error: 'Interrupted: the stage was no longer running on this server.' });
            return await finish('interrupted', `${p.code} ${p.title} was interrupted.`);
          }
          await this.cancelChild(userId, started.id);
          Object.assign(p, { status: 'failed', error: 'The stage did not finish within the time limit and was cancelled.' });
          return await finish('failed', `${p.code} ${p.title} did not finish in time and was cancelled.`);
        }
        if (row.status === RunStatus.CANCELLED) {
          Object.assign(p, { status: 'cancelled', error: 'Cancelled.' });
          return await finish('cancelled', `${p.code} ${p.title} was cancelled; the remaining stages were not started.`);
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
        // this stage no longer needs the money projected for it: whatever it did not use is available to the rest of the campaign
        ledger.phaseDone(p.code);
        const refused = ledger.lastRefusal(p.code);
        if (refused) {
          warnings.push(refusalText(refused));
          await saveWarnings();
        }
        await persist(k === 'discovery' ? { f1ReportId: outputId } : k === 'strategy' ? { f3StrategyId: outputId } : { campaignId: outputId });
      }

      // complete only when the campaign package is actually saved; missing deliverables make an honest partial result
      const campaignId = ids.creative;
      const camp = campaignId ? await this.prisma.creativeCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, packageJson: true, metadataJson: true } }) : null;
      if (!camp || camp.status !== 'completed' || !camp.packageJson) return await finish('failed', 'The campaign package was not saved.');
      const agentsFailed = Boolean((camp.metadataJson as Obj | null)?.partial);
      const counts = ((camp.packageJson as Obj).deliverables?.counts ?? null) as Obj | null;
      const missing = num(counts?.missing);
      const missingMessage = counts && missing > 0 ? `${num(counts.delivered)} of the ${num(counts.planned)} planned deliverables were produced; ${missing} could not be made (the reasons are listed with the campaign).` : null;
      if (missingMessage) {
        warnings.push(missingMessage);
        await saveWarnings();
      }
      const partial = agentsFailed || missing > 0;
      const reasons = [missingMessage, agentsFailed ? 'At least one agent failed or timed out (see the stage details and the review).' : null].filter((x): x is string => !!x);
      await finish(partial ? 'partial' : 'completed', partial ? `The campaign was saved, but not everything succeeded. ${reasons.join(' ')}` : null, { campaignId: camp.id });
    } catch (err) {
      this.logger.error(`Campaign run ${id} failed: ${safeErrorMessage(err)}`);
      const running = phases.find((p) => p.status === 'running');
      if (running) Object.assign(running, { status: 'failed', completedAt: at(), error: messageOf(err) });
      await finish('failed', `The campaign stopped unexpectedly: ${messageOf(err)}`).catch(() => undefined);
    } finally {
      settleLedger();
      await flushLedger();
      this.ledgers.delete(id);
    }
  }

  /** The saved result of a COMPLETED child run, verified (never assumed from the run status alone). */
  private async savedOutput(k: PhaseKey, row: { id: string; report?: { id: string } | null; strategy?: { id: string } | null; campaign?: { id: string } | null }) {
    if (k === 'discovery') return row.report?.id ?? null;
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

  /** Stops the active stage of THIS run and prevents later stages from starting. Other runs of the project are not touched. */
  async cancel(userId: string, factoryId: string) {
    const f = await this.owned(userId, factoryId);
    if (!isActive(f.status)) throw new ConflictException(`This campaign run is already ${f.status}.`);
    await this.prisma.factoryRun.updateMany({ where: { id: factoryId, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { cancelRequested: true } });
    // the stages are read AFTER the flag is saved: whichever of (saving a child's run id, reading the flag) happens last sees the other
    const fresh = await this.prisma.factoryRun.findUnique({ where: { id: factoryId }, select: { phasesJson: true } });
    const current = ((fresh?.phasesJson ?? f.phasesJson) as unknown as FactoryPhaseState[]).find((p) => p.status === 'running' && p.runId);
    if (current?.runId) await this.cancelChild(userId, current.runId);
    const loop = this.loops.get(factoryId);
    if (loop) await within(loop, 20_000);
    return this.view(userId, factoryId);
  }

  // ---- reads (current AND historical runs) -------------------------------------------------------------------------------------

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

  /** Text usage per stage and per agent, from the persisted inference events. Historical runs may also show their AI-image count. */
  private async usageOf(phases: FactoryPhaseState[], textModelOf: string | null = null) {
    const mine = phases.filter((p) => p.action === 'run' && p.runId);
    const phaseOf = new Map(mine.map((p) => [p.runId!, p.phase]));
    const byPhase: Record<string, { textCalls: number; totalTokens: number; inputTokens: number; outputTokens: number; usd: number | null }> = {};
    const agents = new Map<string, { phase: string; agent: string; calls: number; inputTokens: number; outputTokens: number; usd: number | null }>();
    const out = { textCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, imagesGenerated: 0, byPhase, agents: [] as Obj[], cost: null as Obj | null };
    if (!mine.length) return out;
    const rows = await this.prisma.campaignEvent.findMany({ where: { runId: { in: mine.map((p) => p.runId!) }, eventType: { in: ['inference.completed', 'visual.generated'] } }, select: { runId: true, eventType: true, payloadJson: true, participant: true } });
    let textUsd: number | null = 0;
    for (const e of rows) {
      const payload = (e.payloadJson ?? {}) as Obj;
      const ph = phaseOf.get(e.runId)!;
      byPhase[ph] ??= { textCalls: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
      if (e.eventType === 'visual.generated') {
        if (!payload.failed) out.imagesGenerated++; // historical runs only: V4 never generates an image
        continue;
      }
      const u = (payload.tokenUsage ?? {}) as Obj;
      out.textCalls++;
      const eventCost = textCostUsd(textModelOf, { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cachedInputTokens: num((u.inputTokenDetails as Obj | undefined)?.cached_tokens) });
      textUsd = textUsd === null || eventCost === null ? null : textUsd + eventCost;
      const total = num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens);
      out.inputTokens += num(u.inputTokens);
      out.outputTokens += num(u.outputTokens);
      out.totalTokens += total;
      byPhase[ph].textCalls++;
      byPhase[ph].totalTokens += total;
      byPhase[ph].inputTokens += num(u.inputTokens);
      byPhase[ph].outputTokens += num(u.outputTokens);
      byPhase[ph].usd = byPhase[ph].usd === null || eventCost === null ? null : byPhase[ph].usd! + eventCost;
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
    const t = textUsd === null ? null : Math.round(textUsd * 10_000) / 10_000;
    out.cost = { currency: 'USD', textUsd: t, totalUsd: t, note: 'Computed from the usage the provider reported, at the price book of the estimate. Not an invoice.' };
    return out;
  }

  /** The ONE campaign budget as the screen shows it: live while the run goes, saved afterwards, derived (and labelled so) for runs made before it existed. */
  private withLedger<T extends { cost: Obj | null; imagesGenerated: number; textCalls: number }>(usage: T, f: FactoryRun, config: Obj) {
    const live = this.ledgers.get(f.id)?.snapshot() ?? null;
    const saved = (f.ledgerJson ?? null) as SpendSnapshot | null;
    const generated = usage.imagesGenerated || null;
    const budget = live
      ? budgetViewOf(live, { source: 'live', currentPhase: f.currentPhase, imagesGenerated: generated })
      : saved && typeof saved === 'object' && 'knownUsd' in saved
        ? budgetViewOf(saved, { source: 'saved', currentPhase: f.currentPhase, imagesGenerated: generated })
        : derivedBudgetView({ approvedUsd: typeof config.approvedBudgetUsd === 'number' ? config.approvedBudgetUsd : null, textUsd: (usage.cost?.textUsd ?? null) as number | null, imageUsd: null, imagesGenerated: generated, textPoolUsd: null, imagePoolUsd: null, currentPhase: f.currentPhase, textCalls: usage.textCalls });
    return { ...usage, budget };
  }

  /** For a run that stopped because a saved report could not be used: what THIS version can read of the reports the run used. */
  private async recoveryOf(f: FactoryRun, phases: FactoryPhaseState[]): Promise<RecoveryView | null> {
    try {
      const out = (k: PhaseKey) => phases.find((p) => p.phase === k && (p.status === 'reused' || p.status === 'completed'))?.outputId ?? null;
      const f1Id = out('discovery');
      const f3Id = out('strategy');
      if (!f1Id && !f3Id) return null;
      const owned = { projectId: f.projectId, project: { userId: f.userId } };
      const [f1, f3] = await Promise.all([f1Id ? this.prisma.productDiscoveryReport.findFirst({ where: { id: f1Id, ...owned } }) : null, f3Id ? this.prisma.marketingStrategyReport.findFirst({ where: { id: f3Id, ...owned } }) : null]);
      const expect: ('F1' | 'F3')[] = [...(f1Id ? (['F1'] as const) : []), ...(f3Id ? (['F3'] as const) : [])];
      const check = checkSavedChain({ projectId: f.projectId, f1, f3, expect });
      const next = phases.find((p) => p.status !== 'completed' && p.status !== 'reused');
      return { ready: check.ok, reports: check.reports.map((r) => ({ code: r.report, id: r.id, status: r.status, message: r.message })), lineageProblems: check.lineageProblems, resumeFrom: next ? { code: next.code, title: next.title } : null };
    } catch {
      return null; // the explanation is optional: the run itself is still readable
    }
  }

  /** WHY a child run stopped: the first failure its own events recorded (participant, code, safe sentence and specifics). Read-only. */
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
    const campaign = f.campaignId ? await this.prisma.creativeCampaign.findUnique({ where: { id: f.campaignId }, select: { id: true, approvalStatus: true, status: true, campaignName: true, packageJson: true } }) : null;
    const approvalStatus = campaign?.packageJson ? (campaign.approvalStatus ?? null) : null;
    const status = f.status as FactoryStatus;
    const config = (f.configJson ?? {}) as Obj;
    const usage = o.withUsage ? this.withLedger(await this.usageOf(phases, (config.textModel as string | null) ?? null), f, config) : null;
    const bad = phases.find((p) => p.status === 'failed' || p.status === 'cancelled');
    const recovery = ['failed', 'interrupted'].includes(status) && bad && bad.status === 'failed' && (!bad.runId || REPORT_ERROR_CODES.includes(bad.failure?.code ?? '')) ? await this.recoveryOf(f, phases) : null;
    const failure = ['failed', 'cancelled', 'interrupted'].includes(status)
      ? explainFailure({ status, phases, derived: bad && !bad.failure && bad.runId && bad.status === 'failed' ? await this.failureOf(bad.runId) : null, budget: (usage?.budget ?? null) as BudgetView | null, errorMessage: f.errorMessage, recovery })
      : null;
    const pkg = (campaign?.packageJson ?? null) as Obj | null;
    return {
      id: f.id,
      projectId: f.projectId,
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
      campaignId: pkg ? f.campaignId : null,
      campaignName: campaign?.campaignName ?? null,
      approvalStatus,
      config: {
        /** campaign_production for every V4 run; historical runs keep the preset they were made with (read-only). */
        workflow: config.workflow ?? 'legacy',
        legacyPreset: config.preset ?? null,
        textModel: config.textModel ?? null,
        settings: config.settings ?? null,
        approvedBudgetUsd: config.approvedBudgetUsd ?? null,
        estimate: config.estimate ?? null,
      },
      usage,
      failure,
      deliverables: pkg?.deliverables?.counts ?? null,
      quality: pkg?.quality ?? null,
    };
  }

  /** The persisted Mozaik activity of all stages this run executed, in order (historical runs include their audit stage). */
  async events(userId: string, id: string, limit = 400) {
    const f = await this.owned(userId, id);
    const phases = (f.phasesJson as unknown as FactoryPhaseState[]).filter((p) => p.runId);
    if (!phases.length) return { items: [] as Obj[], total: 0 };
    const phaseOf = new Map(phases.map((p) => [p.runId!, p]));
    const rows = await this.prisma.campaignEvent.findMany({
      where: { runId: { in: phases.map((p) => p.runId!) }, eventType: { in: [...ACTIVITY_EVENT_TYPES] } },
      select: { id: true, runId: true, sequence: true, eventType: true, participant: true, payloadJson: true, createdAt: true },
    });
    const order = new Map(ALL_PHASES.map((k, i) => [k, i]));
    rows.sort((a, b) => order.get(phaseOf.get(a.runId)!.phase)! - order.get(phaseOf.get(b.runId)!.phase)! || a.sequence - b.sequence);
    const items = rows.slice(-limit).map((e) => {
      const p = phaseOf.get(e.runId)!;
      return { id: e.id, runId: e.runId, phase: p.phase, code: p.code, sequence: e.sequence, type: e.eventType, participant: e.participant, at: e.createdAt, summary: summarizeEvent(e.eventType, (e.payloadJson ?? {}) as Obj), importance: importanceOf(e.eventType) };
    });
    return { items, total: rows.length };
  }
}
