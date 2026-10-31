import { ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, RunStatus, type FactoryRun } from '@prisma/client';
import {
  OpenAIClient,
  estimateCreativeRun,
  formatsForChannels,
  resolveOpenAIBaseUrl,
  safeErrorMessage,
  type AuditRunConfig,
  type CreativeRunConfig,
  type DiscoveryRunConfig,
  type StrategyRunConfig,
} from '@launchpilot/agents';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StartFactoryDto } from './dto/factory.dto';
import type { StartAuditDto, StartCreativeDto, StartDiscoveryDto, StartStrategyDto } from './dto/mozaik.dto';
import { ACTIVITY_EVENT_TYPES, importanceOf, summarizeEvent } from './event-summary';
import {
  ACTIVE_FACTORY_STATUSES,
  LineageError,
  PHASE_META,
  PHASE_ORDER,
  PRESETS,
  buildPhasePlan,
  chooseChain,
  f3Expected,
  initialPhases,
  mergeSettings,
  outcomeOf,
  type Candidates,
  type Chain,
  type ChannelId,
  type FactoryPhaseState,
  type FactorySettings,
  type FactoryStatus,
  type PhaseKey,
  type PresetId,
} from './factory-plan';
import { chooseImageModel, type ImageModelChoice } from './image-model-choice';
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
  code: 'no_credentials' | 'no_model' | 'model_unavailable' | 'image_model_unsupported' | 'image_model_unavailable' | 'image_model_retired' | 'image_model_unresolved' | 'factory_active' | 'run_active' | 'lineage';
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
  private shuttingDown = false;

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private credentials: ApiCredentialsService,
    private mozaik: MozaikService,
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

  private async listProviderModels(apiKey: string): Promise<string[] | null> {
    try {
      const client = new OpenAIClient({ apiKey, baseUrl: resolveOpenAIBaseUrl() });
      return (await client.listModels(AbortSignal.timeout(15_000))).map((m) => m.id);
    } catch {
      return null; // an outage must not look like a missing model
    }
  }

  private async resolve(userId: string, projectId: string, dto: StartFactoryDto) {
    const project = await this.projects.assertOwned(userId, projectId);
    const preset: PresetId = dto.preset ?? 'first_test';
    const mode = dto.mode ?? 'continue';
    const reusePartial = dto.reusePartial ?? true;
    const rerunCreative = dto.rerunCreative ?? false;
    const settings = mergeSettings(preset, { model: dto.model, f1: dto.f1, f2: dto.f2, f3: dto.f3, f4: dto.f4 as never });

    const blockers: Blocker[] = [];
    const warnings: string[] = [];
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

    // credentials and models (the model list is a free request; nothing is billed)
    const cred = await this.credentials.getDecryptedCredential(userId, 'openai');
    const textModel = settings.model ?? cred?.model ?? null;
    let providerModels: string[] | null = null;
    if (!cred) blockers.push({ code: 'no_credentials', message: 'A full campaign needs your OpenAI API key. Add it under Settings > AI providers.' });
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
    if (runsCreative && requestedImageModel && cred) {
      imageChoice = chooseImageModel(requestedImageModel, providerModels, new Date());
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
    if (activeFactory) blockers.push({ code: 'factory_active', message: 'A full campaign run is already in progress for this project.' });
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
      else if (imageModel && settings.f4.maxImages < settings.f4.concepts) warnings.push(`The image limit is ${settings.f4.maxImages} for ${settings.f4.concepts} concepts: only ${settings.f4.maxImages} concept(s) get an AI image and the other ${settings.f4.concepts - settings.f4.maxImages} use brand-colored backgrounds. LaunchPilot never raises the limit for you; set it to ${settings.f4.concepts} to give every concept its own image.`);
      if (settings.f4.maxRegenerations > 0) warnings.push(`Up to ${settings.f4.maxRegenerations} extra image(s) may be generated to replace a rejected one (billed by OpenAI).`);
    }
    return { project, preset, mode, reusePartial, rerunCreative, settings, plan, chain, candidates, blockers, warnings, summaries, textModel, imageNote, imageAvailable, imageChoice, requestedImageModel, recommended, nothingToRun: plan.every((p) => p.action === 'reuse'), existingCampaign: chain.f4 ?? null, hasCred: !!cred };
  }

  /** The plan the user confirms: which phases are reused (from exactly which saved result), which run, with which limits. Spends nothing. */
  async preflight(userId: string, projectId: string, dto: StartFactoryDto = {}) {
    const r = await this.resolve(userId, projectId, dto);
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
          const est = estimateCreativeRun({ concepts: s.f4.concepts, landing: s.f4.landing, imageGeneration: !!s.f4.imageModel, maxImages: s.f4.maxImages, maxRegenerations: s.f4.maxRegenerations, maxLayoutsPerConcept: s.f4.maxLayoutsPerConcept, maxRepairRounds: s.f4.maxRepairRounds, visionReviews: s.f4.visionReviews, maxModelCalls: s.f4.maxModelCalls, channels: Math.max(1, channels.length) });
          limits = { ...s.f4, channels: s.f4.channels ?? (r.recommended ? channels : null) };
          layoutsPlanned = channels.length ? formatsForChannels(channels as ChannelId[], Math.min(s.f4.maxLayoutsPerConcept, 6)).length * s.f4.concepts : est.layouts.planned;
          expected = { textCalls: est.textCalls, imageRequests: est.imageRequests, layouts: { ...est.layouts, planned: layoutsPlanned } };
          textCallCap += s.f4.maxModelCalls;
          imagesPlanned = est.imageRequests.planned;
          // concepts requested / originals permitted / requests planned / left to brand-colored backgrounds: four different numbers
          const permitted = s.f4.imageModel ? Math.min(s.f4.maxImages, s.f4.concepts) : 0;
          imagePlan = { enabled: !!s.f4.imageModel, model: s.f4.imageModel, modelMode: r.imageChoice?.mode ?? (s.f4.imageModel ? 'explicit' : 'none'), conceptsRequested: s.f4.concepts, originalImagesPermitted: permitted, plannedRequests: est.imageRequests.planned, budgetLimitedConcepts: s.f4.imageModel ? Math.max(0, s.f4.concepts - permitted) : 0, regenerationCap: s.f4.maxRegenerations };
        }
      }
      phases.push({ phase: p.phase, code: meta.code, title: meta.title, action: p.action, reuse, limits, expected, measured });
    }
    return {
      ok: r.blockers.length === 0,
      blockers: r.blockers,
      warnings: r.warnings,
      nothingToRun: r.nothingToRun,
      project: { id: r.project.id, name: intake?.productName ?? r.project.name },
      brief: { language: intake?.preferredLanguage ?? null, targetAudience: intake?.targetAudience ?? null, marketingGoal: intake?.marketingGoal ?? null, targetMarket: intake?.targetMarket ?? null },
      mode: r.mode,
      preset: r.preset,
      reusePartial: r.reusePartial,
      rerunCreative: r.rerunCreative,
      chain: { f1ReportId: r.chain.f1?.id ?? null, f2AuditId: r.chain.f2?.id ?? null, f3StrategyId: r.chain.f3?.id ?? null, campaignId: r.chain.f4?.id ?? null },
      models: { text: { id: r.textModel, source: s.model ? 'override' : 'saved' }, image: s.f4.imageModel && r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? { id: r.imageChoice?.model ?? null, requested: r.requestedImageModel, mode: r.imageChoice?.mode ?? 'explicit', quality: s.f4.imageQuality, available: r.imageAvailable, note: r.imageNote } : null },
      imagePlan,
      settings: s,
      phases,
      totals: { phasesToRun: r.plan.filter((p) => p.action === 'run').length, phasesReused: r.plan.filter((p) => p.action === 'reuse').length, textCallCap, imageRequests: imagesPlanned, imageRegenerationCap: r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? s.f4.maxRegenerations : 0, layouts: layoutsPlanned },
      pricing: { dollars: null, note: 'No dollar estimate is shown: LaunchPilot does not have your OpenAI pricing. The limits above are enforced per phase by LaunchPilot (they are not an OpenAI spending cap). Text usage is measured in tokens; each image is billed by OpenAI per model, quality and size. Check platform.openai.com for current prices.' },
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

    const phases = initialPhases(r.plan);
    const config = { preset: r.preset, mode: r.mode, rerunCreative: r.rerunCreative, reusePartial: r.reusePartial, settings: r.settings, textModel: r.textModel, imageModel: r.plan.find((p) => p.phase === 'creative')?.action === 'run' ? r.settings.f4.imageModel : null, reports: dto.reports ?? null };
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
    const loop = this.execute({ id: row.id, userId, projectId }, phases, r.settings, r.warnings, hooks)
      .catch((err) => this.logger.error(`Factory run ${row.id} crashed: ${safeErrorMessage(err)}`))
      .finally(() => this.loops.delete(row.id));
    this.loops.set(row.id, loop);
    return this.toView(row, { withUsage: false });
  }

  // ---- the orchestration loop -------------------------------------------------------------------------------------------------

  private async execute(run: { id: string; userId: string; projectId: string }, phases: FactoryPhaseState[], settings: FactorySettings, warnings: string[], hooks: FactoryHooks) {
    const { id, userId, projectId } = run;
    const at = () => new Date().toISOString();
    const st = (k: PhaseKey) => phases.find((p) => p.phase === k)!;
    const persist = (extra: Prisma.FactoryRunUpdateManyMutationInput = {}) =>
      this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { phasesJson: phases as unknown as Prisma.InputJsonValue, ...extra } });
    const finish = async (status: FactoryStatus, error: string | null, extra: Prisma.FactoryRunUpdateManyMutationInput = {}) => {
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

        // start the existing phase service; the run id is stored the moment it exists
        let started: { id: string };
        try {
          const o = { factoryRunId: id };
          if (k === 'discovery') started = await this.mozaik.startProductDiscovery(userId, projectId, { model: textModel, ...settings.f1, maxOutputTokens: settings.f1.maxOutputTokens ?? undefined } as StartDiscoveryDto, hooks.discovery ?? {}, o);
          else if (k === 'audit') started = await this.mozaik.startMarketingAudit(userId, projectId, { model: textModel, f1ReportId: ids.discovery!, ...settings.f2, maxOutputTokens: settings.f2.maxOutputTokens ?? undefined } as StartAuditDto, hooks.audit ?? {}, o);
          else if (k === 'strategy') {
            const f3 = settings.f3;
            started = await this.mozaik.startMarketStrategy(userId, projectId, { model: textModel, auditId: ids.audit!, maxModelCalls: f3.maxModelCalls, maxScouts: f3.maxScouts, maxReviews: f3.maxReviews, maxOutputTokens: f3.maxOutputTokens ?? undefined, useHolidayCalendar: f3.useHolidayCalendar, competitorUrls: f3.competitorUrls.length ? f3.competitorUrls : undefined, goal: f3.goal ?? undefined, budgetNote: f3.budgetNote ?? undefined } as StartStrategyDto, hooks.strategy ?? {}, o);
          } else {
            const f4 = settings.f4;
            started = await this.mozaik.startCreativeProduction(userId, projectId, { model: textModel, strategyId: ids.strategy!, imageModel: f4.imageModel ?? undefined, imageQuality: f4.imageQuality, imageSize: f4.imageSize ?? undefined, concepts: f4.concepts, channels: f4.channels ?? undefined, landing: f4.landing, maxImages: f4.maxImages, maxRegenerations: f4.maxRegenerations, maxLayoutsPerConcept: f4.maxLayoutsPerConcept, maxRepairRounds: f4.maxRepairRounds, visionReviews: f4.visionReviews, maxModelCalls: f4.maxModelCalls, maxOutputTokens: f4.maxOutputTokens ?? undefined } as StartCreativeDto, hooks.creative ?? {}, o);
          }
        } catch (err) {
          Object.assign(p, { status: 'failed', completedAt: at(), error: messageOf(err) });
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
          Object.assign(p, { status: 'failed', error: row.errorMessage ?? 'Interrupted.' });
          return await finish('interrupted', `${p.code} ${p.title} was interrupted.`);
        }
        const outputId = row.status === RunStatus.COMPLETED ? await this.savedOutput(k, row) : null;
        if (!outputId) {
          const error = row.status === RunStatus.COMPLETED ? 'The run finished but no saved result was found.' : (row.errorMessage ?? 'The run failed.');
          Object.assign(p, { status: 'failed', error });
          return await finish('failed', `${p.code} ${p.title} failed: ${error}`);
        }
        Object.assign(p, { status: 'completed', outputId, error: null });
        ids[k] = outputId;
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
      if (imageFailures.length) {
        const lead = imageFailures.find((x) => x.requestAttempted) ?? imageFailures[0]; // the request that really failed, not an echo of it
        imageMessage = `${imageFailures.length} of ${results.length} concept(s) have no AI image: ${sentence(lead) ?? 'the image request failed'}`;
        warnings.push(imageMessage);
      }
      if (imageLimited.length) warnings.push(sentence(imageLimited[0]) ?? 'Some concepts were left without an AI image because of the configured image limit.');
      if (imageFailures.length || imageLimited.length) await this.prisma.factoryRun.updateMany({ where: { id, status: { in: ACTIVE_FACTORY_STATUSES } }, data: { warningsJson: warnings as unknown as Prisma.InputJsonValue } });
      const partial = agentsFailed || imageFailures.length > 0;
      const reasons = [imageMessage, agentsFailed ? 'At least one creative participant failed or timed out (see the phase details and the review).' : null].filter((x): x is string => !!x);
      await finish(partial ? 'partial' : 'completed', partial ? `The campaign was saved, but not everything succeeded. ${reasons.join(' ')}` : null, { campaignId: camp.id });
    } catch (err) {
      this.logger.error(`Factory run ${id} failed: ${safeErrorMessage(err)}`);
      const running = phases.find((p) => p.status === 'running');
      if (running) Object.assign(running, { status: 'failed', completedAt: at(), error: messageOf(err) });
      await finish('failed', `The campaign run stopped unexpectedly: ${messageOf(err)}`).catch(() => undefined);
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
    const current = (f.phasesJson as unknown as FactoryPhaseState[]).find((p) => p.status === 'running' && p.runId);
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

  private async usageOf(phases: FactoryPhaseState[]) {
    const mine = phases.filter((p) => p.action === 'run' && p.runId);
    const phaseOf = new Map(mine.map((p) => [p.runId!, p.phase]));
    const byPhase: Record<string, { textCalls: number; totalTokens: number }> = {};
    const out = { textCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, imagesGenerated: 0, imagesFailed: 0, byPhase };
    if (!mine.length) return out;
    const rows = await this.prisma.campaignEvent.findMany({ where: { runId: { in: mine.map((p) => p.runId!) }, eventType: { in: ['inference.completed', 'visual.generated'] } }, select: { runId: true, eventType: true, payloadJson: true } });
    for (const e of rows) {
      const payload = (e.payloadJson ?? {}) as Obj;
      const ph = phaseOf.get(e.runId)!;
      byPhase[ph] ??= { textCalls: 0, totalTokens: 0 };
      if (e.eventType === 'visual.generated') {
        payload.failed ? out.imagesFailed++ : out.imagesGenerated++;
        continue;
      }
      const u = (payload.tokenUsage ?? {}) as Obj;
      out.textCalls++;
      out.inputTokens += num(u.inputTokens);
      out.outputTokens += num(u.outputTokens);
      out.totalTokens += num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens);
      byPhase[ph].textCalls++;
      byPhase[ph].totalTokens += num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens);
    }
    return out;
  }

  private async toView(f: FactoryRun, o: { withUsage: boolean }) {
    const phases = f.phasesJson as unknown as FactoryPhaseState[];
    const campaign = f.campaignId ? await this.prisma.creativeCampaign.findUnique({ where: { id: f.campaignId }, select: { id: true, approvalStatus: true, status: true, campaignName: true, packageJson: true, imageModel: true } }) : null;
    const approvalStatus = campaign?.packageJson ? (campaign.approvalStatus ?? null) : null;
    const status = f.status as FactoryStatus;
    const config = (f.configJson ?? {}) as Obj;
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
      config: { preset: config.preset ?? null, mode: config.mode ?? f.mode, rerunCreative: !!config.rerunCreative, reusePartial: config.reusePartial !== false, textModel: config.textModel ?? null, imageModel: config.imageModel ?? null, settings: config.settings ?? null },
      usage: o.withUsage ? await this.usageOf(phases) : null,
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
