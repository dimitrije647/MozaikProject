import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, RunStatus, type CampaignRun, type Project, type ProductIntake } from '@prisma/client';
import {
  buildDiscoveryInput,
  redact,
  resolveOpenAIBaseUrl,
  safeErrorMessage,
  type AiProvider,
  type CampaignManifest,
  type CampaignRunHandle,
  type CampaignRunResult,
  type CampaignRuntime,
  type DiscoveryRunConfig,
  type InferenceCredentials,
  type AuditReportMeta,
  type CampaignStrategyReport,
  type StrategyReportMeta,
  type StrategyRunConfig,
  buildF2Context,
  type AuditRunConfig,
  type DocumentInput,
  type MarketingAuditReport,
  buildF1Context,
  type ImageInput,
  type ProductDiscoveryReportV2,
  type ReportMeta,
  type SmokeTestOptions,
  buildF3Context,
  buildCampaignZip,
  zipFileName,
  renderLandingHtml,
  derivePalette,
  estimateCreativeRun,
  isSupportedImageModel,
  OpenAIClient,
  CampaignPackage,
  CAMPAIGN_SCHEMA_VERSION,
  CHANNEL_IDS,
  type ChannelId,
  type CreativeInput,
  type CreativeReportMeta,
  type CreativeRunConfig,
} from '@launchpilot/agents';
import { StorageDriver } from '../storage/storage.service';
import { DbAssetStore, readAll, toAssetRecord } from './campaign-assets';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { EventWriter } from './event-writer';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';
import { ListAuditsQueryDto, ListEventsQueryDto, StartAuditDto, StartCreativeDto, StartDiscoveryDto, StartSmokeTestDto, StartStrategyDto } from './dto/mozaik.dto';

const RESULT_TO_DB: Record<CampaignRunResult['status'], RunStatus> = {
  completed: RunStatus.COMPLETED,
  failed: RunStatus.FAILED,
  cancelled: RunStatus.CANCELLED,
  interrupted: RunStatus.INTERRUPTED,
};

const RUN_LABELS: Record<string, string> = {
  smoke_test: 'Infrastructure Smoke Test',
  product_discovery: 'Product Discovery',
  marketing_audit: 'Marketing Audit',
  market_strategy: 'Market Research & Strategy',
  creative_production: 'Creative Production',
};

type RunMode = 'smoke_test' | 'product_discovery' | 'marketing_audit' | 'market_strategy' | 'creative_production';
type RunWithReport = CampaignRun & { report?: { id: string } | null; audit?: { id: string } | null; strategy?: { id: string } | null; campaign?: { id: string } | null };
const withReport = { report: { select: { id: true } }, audit: { select: { id: true } }, strategy: { select: { id: true } }, campaign: { select: { id: true } } } as const;

interface ActiveEntry {
  handle: CampaignRunHandle;
  writer: EventWriter;
  /** Resolves after the terminal status has been written to PostgreSQL. */
  finalized: Promise<void>;
}

/** What the API returns for a run. No credentials, ever. */
export function toRunView(run: RunWithReport) {
  return {
    id: run.id,
    projectId: run.projectId,
    mode: run.mode,
    label: RUN_LABELS[run.mode] ?? run.mode,
    status: run.status,
    currentPhase: run.currentPhase,
    provider: run.provider,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    errorMessage: run.errorMessage,
    reportId: run.report?.id ?? null,
    auditId: run.audit?.id ?? null,
    strategyId: run.strategy?.id ?? null,
    campaignId: run.campaign?.id ?? null,
  };
}

/**
 * Orchestration adapter between the HTTP API, PostgreSQL and the Mozaik runtime (which lives in
 * @launchpilot/agents). It knows nothing about individual agents.
 *
 * Lifecycle: CampaignRun row (RUNNING) -> runtime.startRun -> events streamed to CampaignEvent
 * -> (product discovery: report saved) -> terminal status written once the runtime reports it.
 */
@Injectable()
export class MozaikService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MozaikService.name);
  private readonly active = new Map<string, ActiveEntry>();

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private credentials: ApiCredentialsService,
    @Inject(CAMPAIGN_RUNTIME) private runtime: CampaignRuntime,
    private storage: StorageDriver,
  ) {}

  /**
   * Runs left RUNNING by a previous process can never finish (live Mozaik state is in memory and is
   * not restored), so they are marked INTERRUPTED instead of being falsely resumed.
   * Assumes a single API instance; with several, this sweep would need an owner/heartbeat column.
   */
  async onModuleInit() {
    const orphans = await this.prisma.campaignRun.findMany({ where: { status: RunStatus.RUNNING } });
    for (const run of orphans) {
      const message = 'Interrupted: the server restarted while this run was in progress';
      const last = await this.prisma.campaignEvent.aggregate({ where: { runId: run.id }, _max: { sequence: true } });
      await this.prisma.$transaction([
        this.prisma.campaignEvent.create({
          data: {
            runId: run.id,
            sequence: (last._max.sequence ?? 0) + 1,
            eventType: 'factory.failed',
            participant: 'LaunchPilot API',
            payloadJson: { reason: 'server_shutdown', message },
          },
        }),
        this.prisma.campaignRun.update({
          where: { id: run.id },
          data: { status: RunStatus.INTERRUPTED, completedAt: new Date(), errorMessage: message },
        }),
      ]);
      this.logger.warn(`Marked orphaned run ${run.id} as INTERRUPTED`);
    }
  }

  /** Graceful shutdown: stop every active run, then wait until its final state is persisted. */
  async onModuleDestroy() {
    await this.runtime.shutdown();
    await Promise.allSettled([...this.active.values()].map((a) => a.finalized));
  }

  // ---- queries

  async listRuns(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const runs = await this.prisma.campaignRun.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: withReport,
    });
    return runs.map(toRunView);
  }

  async getRun(userId: string, runId: string) {
    return toRunView(await this.ownedRun(userId, runId));
  }

  async listEvents(userId: string, runId: string, query: ListEventsQueryDto) {
    await this.ownedRun(userId, runId);
    const limit = query.limit ?? 100;
    const rows = await this.prisma.campaignEvent.findMany({
      where: { runId, sequence: { gt: query.afterSequence ?? 0 } },
      orderBy: { sequence: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        eventType: e.eventType,
        phase: e.phase,
        participant: e.participant,
        payload: e.payloadJson,
        createdAt: e.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].sequence : null,
    };
  }

  /** Report summaries for a project (newest first). Full reports come from getReport. */
  async listReports(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const rows = await this.prisma.productDiscoveryReport.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => {
      const report = r.reportJson as unknown as Partial<ProductDiscoveryReportV2>;
      const meta = r.metadataJson as unknown as Partial<ReportMeta>;
      return {
        id: r.id,
        runId: r.runId,
        createdAt: r.createdAt,
        language: r.language,
        model: r.model,
        schemaVersion: r.schemaVersion,
        partial: report.partial ?? false,
        executiveSummary: report.executiveSummary ?? '',
        usage: meta?.usage?.total ?? null,
        activated: meta?.plan?.activated?.length ?? null,
        skipped: meta?.plan?.skipped?.length ?? null,
      };
    });
  }

  async getReport(userId: string, reportId: string) {
    // 404 (not 403) for other users' reports so ids cannot be probed.
    const r = await this.prisma.productDiscoveryReport.findFirst({ where: { id: reportId, project: { userId } } });
    if (!r) throw new NotFoundException('Report not found');
    return {
      id: r.id,
      projectId: r.projectId,
      runId: r.runId,
      schemaVersion: r.schemaVersion,
      language: r.language,
      model: r.model,
      createdAt: r.createdAt,
      report: r.reportJson,
      metadata: r.metadataJson,
    };
  }

  // ---- commands

  /**
   * Infrastructure smoke test: proves API <-> Mozaik <-> PostgreSQL work end to end.
   * Deterministic, no LLM, no API key needed, no marketing output.
   * `testHooks` is for fault-injection in tests only and is not reachable through HTTP.
   */
  async startSmokeTest(userId: string, projectId: string, dto: StartSmokeTestDto = {}, testHooks: SmokeTestOptions = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    const [intake, user] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    return this.launchRun({
      userId,
      projectId,
      mode: 'smoke_test',
      provider: user.defaultAiProvider,
      start: (run, writer) =>
        this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'smoke_test',
          manifest: this.buildManifest(project, intake),
          // No `credentials`: the smoke test never calls a model, so a missing key must not block it.
          options: { delayMs: dto.delayMs, ...testHooks },
          onEvent: writer.push,
        }),
    });
  }

  /**
   * Product Discovery (F1): real Mozaik agents using the USER's OpenAI key and an explicitly chosen
   * model. Requires an intentional call; nothing here runs on page load.
   * `testHooks` (timeouts etc.) is for tests only and is not reachable through HTTP.
   */
  async startProductDiscovery(userId: string, projectId: string, dto: StartDiscoveryDto = {}, testHooks: Partial<DiscoveryRunConfig> = {}) {
    const project = await this.projects.assertOwned(userId, projectId);

    const cred = await this.credentials.getDecryptedCredential(userId, 'openai');
    if (!cred) {
      throw new UnprocessableEntityException('Product Discovery needs your OpenAI API key. Add it under Settings > AI providers.');
    }
    const model = dto.model ?? cred.model;
    if (!model) {
      throw new UnprocessableEntityException('Choose an OpenAI model first (Settings > AI providers). LaunchPilot never picks one for you.');
    }
    const credentials: InferenceCredentials = { provider: 'openai', apiKey: cred.apiKey };

    const [intake, socials, assets, notes] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.socialProfile.findMany({ where: { projectId } }),
      this.prisma.projectAsset.findMany({ where: { projectId } }),
      this.prisma.workspaceNote.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const input = buildDiscoveryInput({ project, intake, socialProfiles: socials, assets, notes });
    const { documents, images } = this.loadAssets(assets);

    return this.launchRun({
      userId,
      projectId,
      mode: 'product_discovery',
      provider: 'openai',
      start: (run, writer) =>
        this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'product_discovery',
          manifest: this.buildManifest(project, intake),
          credentials,
          discovery: {
            input,
            model,
            documents,
            images,
            maxModelCalls: dto.maxModelCalls,
            maxOutputTokens: dto.maxOutputTokens,
            maxReviews: dto.maxReviews,
            baseUrl: resolveOpenAIBaseUrl(),
            ...testHooks,
          },
          onEvent: writer.push,
          // Saved BEFORE the run is marked COMPLETED (the runtime waits for this promise).
          onReport: async (report, meta) => {
            await this.prisma.productDiscoveryReport.create({
              data: {
                projectId,
                runId: run.id,
                schemaVersion: report.schemaVersion,
                language: report.language,
                model: meta.model,
                // Defense in depth: nothing credential-shaped is stored, even inside user text.
                reportJson: redact(report) as unknown as Prisma.InputJsonValue,
                metadataJson: redact(meta) as unknown as Prisma.InputJsonValue,
              },
            });
          },
        }),
    });
  }

  /** Resolves the user's OpenAI key and explicit model (never defaulted). */
  private async openAiFor(userId: string, modelOverride: string | undefined, what: string) {
    const cred = await this.credentials.getDecryptedCredential(userId, 'openai');
    if (!cred) throw new UnprocessableEntityException(`${what} needs your OpenAI API key. Add it under Settings > AI providers.`);
    const model = modelOverride ?? cred.model;
    if (!model) throw new UnprocessableEntityException('Choose an OpenAI model first (Settings > AI providers). LaunchPilot never picks one for you.');
    return { credentials: { provider: 'openai', apiKey: cred.apiKey } as InferenceCredentials, model };
  }

  /**
   * F2 Marketing Audit. Diagnostic only, built on ONE completed F1 report (the newest, or the one chosen).
   * Nothing runs without this explicit call; a missing F1 report is never fabricated.
   * `testHooks` (timeouts, test tools) is for tests only and is not reachable through HTTP.
   */
  async startMarketingAudit(userId: string, projectId: string, dto: StartAuditDto = {}, testHooks: Partial<AuditRunConfig> = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    const f1Row = dto.f1ReportId
      ? await this.prisma.productDiscoveryReport.findFirst({ where: { id: dto.f1ReportId, projectId, project: { userId } } })
      : await this.prisma.productDiscoveryReport.findFirst({ where: { projectId, schemaVersion: { gte: 2 }, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' } });
    if (dto.f1ReportId && !f1Row) throw new NotFoundException('Product Discovery report not found');
    if (!f1Row) throw new UnprocessableEntityException('Marketing Audit needs a completed Product Discovery (F1) report. Run Product Discovery first.');
    const f1 = buildF1Context(f1Row);
    if (!f1) throw new UnprocessableEntityException('That Product Discovery report is from an earlier version and has no Product Manifest. Run Product Discovery again.');

    const { credentials, model } = await this.openAiFor(userId, dto.model, 'Marketing Audit');
    const [intake, socials, assets, notes] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.socialProfile.findMany({ where: { projectId } }),
      this.prisma.projectAsset.findMany({ where: { projectId } }),
      this.prisma.workspaceNote.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const base = buildDiscoveryInput({ project, intake, socialProfiles: socials, assets, notes });
    const { documents, images } = this.loadAssets(assets);
    const input = {
      projectName: intake?.productName ?? project.name,
      language: base.language,
      websiteUrl: intake?.websiteUrl?.trim() || null,
      socialProfiles: socials.map((s) => ({ platform: s.platform, url: s.url })),
      socialDetails: (dto.socialDetails ?? []).map((d) => ({ platform: d.platform, url: d.url ?? null, bio: d.bio ?? null, followers: d.followers ?? null, postsPerMonth: d.postsPerMonth ?? null, notes: d.notes ?? null })),
      styleNotes: intake?.stylePreference?.trim() || null,
    };

    return this.launchRun({
      userId,
      projectId,
      mode: 'marketing_audit',
      provider: 'openai',
      start: (run, writer) =>
        this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'marketing_audit',
          manifest: this.buildManifest(project, intake),
          credentials,
          audit: { f1, input, model, documents, images, maxModelCalls: dto.maxModelCalls, maxOutputTokens: dto.maxOutputTokens, maxReviews: dto.maxReviews, baseUrl: resolveOpenAIBaseUrl(), ...testHooks },
          onEvent: writer.push,
          // Saved BEFORE the run is marked COMPLETED (the runtime waits for this promise).
          onAudit: async (report: MarketingAuditReport, meta: AuditReportMeta) => {
            await this.prisma.marketingAuditReport.create({
              data: {
                projectId,
                runId: run.id,
                f1ReportId: f1.reportId,
                schemaVersion: report.schemaVersion,
                language: report.language,
                model: meta.model,
                reportJson: redact(report) as unknown as Prisma.InputJsonValue,
                metadataJson: redact(meta) as unknown as Prisma.InputJsonValue,
              },
            });
          },
        }),
    });
  }

  /** Audit summaries for a project, newest first, with cursor pagination. */
  async listAudits(userId: string, projectId: string, query: ListAuditsQueryDto = {}) {
    await this.projects.assertOwned(userId, projectId);
    const limit = query.limit ?? 20;
    const rows = await this.prisma.marketingAuditReport.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const report = r.reportJson as unknown as Partial<MarketingAuditReport>;
        const meta = r.metadataJson as unknown as Partial<AuditReportMeta>;
        return {
          id: r.id,
          runId: r.runId,
          f1ReportId: r.f1ReportId,
          createdAt: r.createdAt,
          language: r.language,
          model: r.model,
          schemaVersion: r.schemaVersion,
          partial: report.partial ?? false,
          executiveSummary: report.executiveSummary ?? '',
          usage: meta?.usage?.total ?? null,
          activated: meta?.plan?.activated?.length ?? null,
          skipped: meta?.plan?.skipped?.length ?? null,
          findings: meta?.findings?.length ?? null,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async getAudit(userId: string, auditId: string) {
    // 404 (not 403) for other users' audits so ids cannot be probed.
    const r = await this.prisma.marketingAuditReport.findFirst({ where: { id: auditId, project: { userId } } });
    if (!r) throw new NotFoundException('Audit not found');
    return {
      id: r.id,
      projectId: r.projectId,
      runId: r.runId,
      f1ReportId: r.f1ReportId,
      schemaVersion: r.schemaVersion,
      language: r.language,
      model: r.model,
      createdAt: r.createdAt,
      report: r.reportJson,
      metadata: r.metadataJson,
    };
  }

  /**
   * F3 Market Research & Strategy. Built on ONE completed F2 audit (the newest, or the one chosen) and the F1 report
   * that audit was built on. Nothing runs without this explicit call; missing or mismatched prerequisites are refused,
   * never fabricated or silently combined across projects.
   * `testHooks` (timeouts, test tools, the clock) is for tests only and is not reachable through HTTP.
   */
  async startMarketStrategy(userId: string, projectId: string, dto: StartStrategyDto = {}, testHooks: Partial<StrategyRunConfig> = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    const auditRow = dto.auditId
      ? await this.prisma.marketingAuditReport.findFirst({ where: { id: dto.auditId, projectId, project: { userId } } })
      : await this.prisma.marketingAuditReport.findFirst({ where: { projectId, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' } });
    if (dto.auditId && !auditRow) throw new NotFoundException('Marketing audit not found');
    if (!auditRow) {
      const hasF1 = await this.prisma.productDiscoveryReport.count({ where: { projectId, schemaVersion: { gte: 2 } } });
      throw new UnprocessableEntityException(hasF1 ? 'Market Strategy needs a completed Marketing Audit (F2). Run the Marketing Audit first.' : 'Market Strategy needs a completed Product Discovery (F1) report and a Marketing Audit (F2). Run Product Discovery and the Marketing Audit first.');
    }
    // The audit points at the F1 report it was built on; that report must belong to the SAME project.
    const f1Row = await this.prisma.productDiscoveryReport.findFirst({ where: { id: auditRow.f1ReportId, projectId, project: { userId } } });
    if (!f1Row) throw new UnprocessableEntityException('The selected audit refers to a Product Discovery report that does not belong to this project.');
    const f1 = buildF1Context(f1Row);
    if (!f1) throw new UnprocessableEntityException('The Product Discovery report behind that audit is from an earlier version and has no Product Manifest. Run Product Discovery and the Marketing Audit again.');
    const f2 = buildF2Context(auditRow);
    if (!f2) throw new UnprocessableEntityException('That Marketing Audit report could not be read (unexpected format). Run the Marketing Audit again.');

    const { credentials, model } = await this.openAiFor(userId, dto.model, 'Market Strategy');
    const [intake, socials] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.prisma.socialProfile.findMany({ where: { projectId } })]);
    const base = buildDiscoveryInput({ project, intake, socialProfiles: socials, assets: [], notes: [] });
    const input = {
      projectName: intake?.productName ?? project.name,
      language: base.language,
      geography: [...new Set([...f1.report.productManifest.geography, ...(intake?.targetMarket ? [intake.targetMarket] : [])].map((g) => g.trim()).filter(Boolean))].slice(0, 6),
      targetAudience: intake?.targetAudience?.trim() || null,
      marketingGoal: dto.goal?.trim() || intake?.marketingGoal?.trim() || null,
      campaignDuration: intake?.campaignDuration?.trim() || null,
      budgetNote: dto.budgetNote?.trim() || null,
      websiteUrl: intake?.websiteUrl?.trim() || null,
      socialProfiles: socials.map((s) => ({ platform: s.platform, url: s.url })),
      competitorUrls: (dto.competitorUrls ?? []).map((u) => u.trim()).filter(Boolean),
      useHolidayCalendar: dto.useHolidayCalendar ?? intake?.enableSeasonalCalendar ?? false,
    };

    return this.launchRun({
      userId,
      projectId,
      mode: 'market_strategy',
      provider: 'openai',
      start: (run, writer) =>
        this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'market_strategy',
          manifest: this.buildManifest(project, intake),
          credentials,
          strategy: { f1, f2, input, model, maxModelCalls: dto.maxModelCalls, maxScouts: dto.maxScouts, maxReviews: dto.maxReviews, maxOutputTokens: dto.maxOutputTokens, baseUrl: resolveOpenAIBaseUrl(), ...testHooks },
          onEvent: writer.push,
          // Saved BEFORE the run is marked COMPLETED (the runtime waits for this promise).
          onStrategy: async (report: CampaignStrategyReport, meta: StrategyReportMeta) => {
            await this.prisma.marketingStrategyReport.create({
              data: {
                projectId,
                runId: run.id,
                f1ReportId: f1.reportId,
                f2AuditId: f2.auditId,
                schemaVersion: report.schemaVersion,
                language: report.language,
                model: meta.model,
                reportJson: redact(report) as unknown as Prisma.InputJsonValue,
                metadataJson: redact(meta) as unknown as Prisma.InputJsonValue,
              },
            });
          },
        }),
    });
  }

  /** Strategy summaries for a project, newest first, with cursor pagination. */
  async listStrategies(userId: string, projectId: string, query: ListAuditsQueryDto = {}) {
    await this.projects.assertOwned(userId, projectId);
    const limit = query.limit ?? 20;
    const rows = await this.prisma.marketingStrategyReport.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const report = r.reportJson as unknown as Partial<CampaignStrategyReport>;
        const meta = r.metadataJson as unknown as Partial<StrategyReportMeta>;
        return {
          id: r.id,
          runId: r.runId,
          f1ReportId: r.f1ReportId,
          f2AuditId: r.f2AuditId,
          createdAt: r.createdAt,
          language: r.language,
          model: r.model,
          schemaVersion: r.schemaVersion,
          partial: report.partial ?? false,
          executiveSummary: report.executiveSummary ?? '',
          usage: meta?.usage?.total ?? null,
          scouts: meta?.scoutDecisions?.filter((d) => d.selected).length ?? null,
          findings: meta?.findings?.length ?? null,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async getStrategy(userId: string, strategyId: string) {
    // 404 (not 403) for other users' strategies so ids cannot be probed.
    const r = await this.prisma.marketingStrategyReport.findFirst({ where: { id: strategyId, project: { userId } } });
    if (!r) throw new NotFoundException('Strategy not found');
    return {
      id: r.id,
      projectId: r.projectId,
      runId: r.runId,
      f1ReportId: r.f1ReportId,
      f2AuditId: r.f2AuditId,
      schemaVersion: r.schemaVersion,
      language: r.language,
      model: r.model,
      createdAt: r.createdAt,
      report: r.reportJson,
      metadata: r.metadataJson,
    };
  }

  async getStrategyAnalysis(userId: string, runId: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.mode !== 'market_strategy') throw new NotFoundException('Run not found');
    return this.getAnalysis(userId, runId);
  }

  /** Uploaded files as lazily-read inputs. Bytes are read through the storage driver only when an agent needs them. */
  private loadAssets(assets: { type: string; originalName: string; mimeType: string; filePath: string; fileSize: number }[]) {
    const read = (key: string) => async () => {
      const chunks: Buffer[] = [];
      for await (const c of this.storage.read(key)) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    };
    const documents: DocumentInput[] = [];
    const images: ImageInput[] = [];
    for (const a of assets) {
      const base = { name: a.originalName, mimeType: a.mimeType, size: a.fileSize, load: read(a.filePath) };
      if (a.mimeType.startsWith('image/') || ['logo', 'image', 'screenshot', 'reference'].includes(a.type)) images.push({ ...base, kind: a.type });
      else documents.push(base);
    }
    return { documents, images };
  }

  /**
   * Evidence view of a run: plan, agents, sources, findings and cross-checks. Taken from the saved report
   * metadata when the run produced one, otherwise folded from the persisted events (so a running or
   * failed run is still inspectable).
   */
  async getAnalysis(userId: string, runId: string) {
    const run = await this.ownedRun(userId, runId);
    const savedStrategy = await this.prisma.marketingStrategyReport.findFirst({ where: { runId } });
    if (savedStrategy) {
      const m = savedStrategy.metadataJson as unknown as Partial<StrategyReportMeta>;
      return {
        runId, status: run.status, source: 'report' as const, reportId: savedStrategy.id, kind: 'strategy' as const,
        plan: m.plan ?? null, scoutDecisions: m.scoutDecisions ?? [], participants: m.participants ?? [], sources: m.sources ?? [], findings: m.findings ?? [],
        crosschecks: m.crosschecks ?? [], usage: m.usage ?? null, aiCalls: m.aiCalls ?? {}, notAnalyzed: m.notAnalyzed ?? [],
        tools: m.tools ?? null, policyIssues: m.policyIssues ?? [], f1: m.f1 ?? null, f2: m.f2 ?? null,
      };
    }
    const savedAudit = await this.prisma.marketingAuditReport.findFirst({ where: { runId } });
    if (savedAudit) {
      const m = savedAudit.metadataJson as unknown as Partial<AuditReportMeta>;
      return {
        runId, status: run.status, source: 'report' as const, reportId: savedAudit.id, kind: 'audit' as const,
        plan: m.plan ?? null, participants: m.participants ?? [], sources: m.sources ?? [], findings: m.findings ?? [],
        crosschecks: m.crosschecks ?? [], usage: m.usage ?? null, aiCalls: m.aiCalls ?? {}, notAnalyzed: m.notAnalyzed ?? [],
        tools: m.tools ?? null, policyIssues: m.policyIssues ?? [], f1: m.f1 ?? null,
      };
    }
    const saved = await this.prisma.productDiscoveryReport.findFirst({ where: { runId } });
    if (saved) {
      const m = saved.metadataJson as unknown as Partial<ReportMeta>;
      return {
        runId, status: run.status, source: 'report' as const, reportId: saved.id, kind: 'discovery' as const,
        plan: m.plan ?? null, participants: m.participants ?? [], sources: m.sources ?? [], findings: m.findings ?? [],
        crosschecks: m.crosschecks ?? [], usage: m.usage ?? null, aiCalls: m.aiCalls ?? {}, notAnalyzed: m.notAnalyzed ?? [],
        tools: m.tools ?? null, policyIssues: m.policyIssues ?? [],
      };
    }
    const events = await this.prisma.campaignEvent.findMany({ where: { runId }, orderBy: { sequence: 'asc' }, take: 1000 });
    type Obj = Record<string, any>;
    const dyn = { activated: [] as Obj[], skipped: [] as Obj[], decisions: [] as Obj[] };
    const out = { plan: null as unknown, participants: new Map<string, Obj>(), sources: [] as unknown[], findings: [] as unknown[], crosschecks: [] as Obj[] };
    for (const e of events) {
      const p = (e.payloadJson ?? {}) as Obj;
      switch (e.eventType) {
        case 'phase.started': out.plan = p.plan ?? null; break;
        case 'source.retrieved': out.sources.push(p.source); break;
        case 'finding.posted': for (const f of p.findings ?? []) out.findings.push(f); break;
        case 'task.assigned': out.participants.set(p.agent, { agent: p.agent, state: 'working' }); break;
        case 'participant.idle':
          out.participants.set(p.agent, { agent: p.agent, state: 'skipped', reason: p.reason });
          if (/Scout$/.test(String(p.agent))) { dyn.skipped.push({ agent: p.agent, key: `scout:${p.channel ?? ''}`, reason: p.reason }); dyn.decisions.push({ name: p.agent, selected: false, score: p.score ?? 0, ruleHits: p.ruleHits ?? [], reason: p.reason }); }
          break;
        case 'participant.registered':
          out.participants.set(p.agent, { agent: p.agent, state: 'working', reason: p.reason });
          dyn.activated.push({ agent: p.agent, key: `scout:${p.channel}`, reason: p.reason, dynamic: true });
          dyn.decisions.push({ channel: p.channel, name: p.agent, selected: true, score: p.score, ruleHits: p.ruleHits, reason: p.reason });
          break;
        case 'task.completed':
          out.participants.set(p.agent, { agent: p.agent, state: p.outcome === 'succeeded' ? 'done' : p.outcome, error: p.error ?? null, reason: p.reason ?? null });
          break;
        case 'crosscheck.requested': for (const c of p.claims ?? []) out.crosschecks.push({ requestId: p.requestId, producer: p.producer, reviewer: p.reviewer, claimId: c.id ?? c.claimId, status: 'pending' }); break;
        case 'crosscheck.answered':
          for (const c of out.crosschecks.filter((x) => x.requestId === p.requestId)) {
            const a = (p.answers ?? []).find((x: Obj) => x.claimId === c.claimId);
            Object.assign(c, a ? { status: 'answered', verdict: a.verdict, rationale: a.rationale } : { status: 'failed' });
          }
          break;
      }
    }
    const basePlan = out.plan as { activated?: Obj[]; skipped?: Obj[] } | null;
    const plan = basePlan && (dyn.activated.length || dyn.skipped.length) ? { ...basePlan, activated: [...(basePlan.activated ?? []), ...dyn.activated], skipped: [...(basePlan.skipped ?? []), ...dyn.skipped] } : out.plan;
    return {
      runId, status: run.status, source: 'events' as const, reportId: null, kind: (run.mode === 'market_strategy' ? 'strategy' : run.mode === 'marketing_audit' ? 'audit' : 'discovery') as 'strategy' | 'audit' | 'discovery', scoutDecisions: dyn.decisions,
      plan, participants: [...out.participants.values()], sources: out.sources, findings: out.findings,
      crosschecks: out.crosschecks, usage: null, aiCalls: {}, notAnalyzed: [], tools: null, policyIssues: [],
    };
  }


  // ---- F4 Creative Production -------------------------------------------------------------------------------------

  /**
   * Resolves the F1 -> F2 -> F3 chain, the user's credentials and models and the effective settings of a creative run WITHOUT
   * starting anything or spending anything (the only request is GET /models, which is free). `startCreativeProduction`
   * reuses it, so what the preflight showed is exactly what runs.
   */
  private async resolveCreative(userId: string, projectId: string, dto: StartCreativeDto) {
    const project = await this.projects.assertOwned(userId, projectId);
    const strategyRow = dto.strategyId
      ? await this.prisma.marketingStrategyReport.findFirst({ where: { id: dto.strategyId, projectId, project: { userId } } })
      : await this.prisma.marketingStrategyReport.findFirst({ where: { projectId, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' } });
    if (dto.strategyId && !strategyRow) throw new NotFoundException('Strategy not found');
    if (!strategyRow) throw new UnprocessableEntityException('Creative Production needs a completed Market Research & Strategy (F3) report. Run Product Discovery, the Marketing Audit and the Strategy first.');
    // The strategy names the exact audit and report it was built on; both must belong to THIS project (never mixed across projects).
    const [f1Row, f2Row] = await Promise.all([
      this.prisma.productDiscoveryReport.findFirst({ where: { id: strategyRow.f1ReportId, projectId, project: { userId } } }),
      this.prisma.marketingAuditReport.findFirst({ where: { id: strategyRow.f2AuditId, projectId, project: { userId } } }),
    ]);
    if (!f1Row || !f2Row || f2Row.f1ReportId !== f1Row.id) throw new UnprocessableEntityException('The selected strategy refers to a Product Discovery report or Marketing Audit that does not belong to this project.');
    const f1 = buildF1Context(f1Row);
    const f2 = buildF2Context(f2Row);
    const f3 = buildF3Context(strategyRow);
    if (!f1 || !f2 || !f3) throw new UnprocessableEntityException('A report in the F1 -> F2 -> F3 chain could not be read (older format). Run the Strategy again.');

    const { credentials, model } = await this.openAiFor(userId, dto.model, 'Creative Production');
    const imageModel = dto.imageModel?.trim() || null;
    let imageModelCheck: { available: boolean | null; note: string } = { available: null, note: 'No image model selected: no image is generated; layouts use brand-colored backgrounds.' };
    if (imageModel) {
      if (!isSupportedImageModel(imageModel)) throw new UnprocessableEntityException('Only GPT Image models (gpt-image-*) are supported for image generation. A text model cannot generate images.');
      imageModelCheck = await this.checkImageModel(credentials.apiKey, imageModel);
      if (imageModelCheck.available === false) throw new UnprocessableEntityException(`The image model "${imageModel}" is not available to your OpenAI key. ${imageModelCheck.note}`);
    }

    const [intake, logoAsset] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.projectAsset.findFirst({ where: { projectId, type: 'logo', mimeType: { startsWith: 'image/' } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const recommended = f3.report.channels.map((c) => c.channel as string);
    const channels = (dto.channels?.length ? dto.channels : recommended.slice(0, 4)).filter((c): c is ChannelId => (CHANNEL_IDS as readonly string[]).includes(c));
    if (!channels.length) channels.push('instagram');
    const concepts = dto.concepts ?? Math.min(3, Math.max(1, f3.report.creativeBrief.suggestedConceptCount || 3));
    const input: CreativeInput = {
      projectName: intake?.productName ?? project.name,
      language: f3.report.language || 'en',
      websiteUrl: intake?.websiteUrl?.trim() || null,
      channels: [...new Set(channels)],
      concepts,
      landing: dto.landing ?? true,
    };
    const logo = logoAsset ? await readAll(this.storage.read(logoAsset.filePath)).catch(() => null) : null;
    const { palette, fromBrand } = await derivePalette(f1.palette, logo);
    const settings = {
      model,
      imageModel,
      imageQuality: dto.imageQuality ?? ('low' as const),
      imageSize: dto.imageSize ?? null,
      maxImages: imageModel ? Math.min(dto.maxImages ?? concepts, concepts) : 0,
      maxRegenerations: imageModel ? (dto.maxRegenerations ?? 0) : 0,
      maxLayoutsPerConcept: dto.maxLayoutsPerConcept ?? 4,
      maxRepairRounds: dto.maxRepairRounds ?? 2,
      visionReviews: dto.visionReviews ?? 0,
      maxModelCalls: dto.maxModelCalls ?? 16,
      maxOutputTokens: dto.maxOutputTokens,
    };
    const estimate = estimateCreativeRun({ concepts, landing: input.landing, imageGeneration: !!imageModel, maxImages: settings.maxImages, maxRegenerations: settings.maxRegenerations, maxLayoutsPerConcept: settings.maxLayoutsPerConcept, maxRepairRounds: settings.maxRepairRounds, visionReviews: settings.visionReviews, maxModelCalls: settings.maxModelCalls, channels: input.channels.length });
    return { project, intake, f1, f2, f3, credentials, input, settings, estimate, palette, fromBrand, logo, logoName: logoAsset?.originalName ?? null, imageModelCheck, strategyRow };
  }

  /** GET /models (free, no inference): does the user's key list the image model? null = could not tell (outage). */
  private async checkImageModel(apiKey: string, imageModel: string): Promise<{ available: boolean | null; note: string }> {
    try {
      const client = new OpenAIClient({ apiKey, baseUrl: resolveOpenAIBaseUrl() });
      const models = await client.listModels(AbortSignal.timeout(15_000));
      const ids = models.map((m) => m.id);
      if (ids.includes(imageModel)) return { available: true, note: `"${imageModel}" is listed for your key.` };
      const alternatives = ids.filter((id) => isSupportedImageModel(id));
      return { available: false, note: alternatives.length ? `Your key lists: ${alternatives.join(', ')}.` : 'Your key lists no gpt-image model.' };
    } catch (err) {
      return { available: null, note: `The model list could not be read (${safeErrorMessage(err)}). If the image model is unavailable the run says so and uses brand-colored backgrounds.` };
    }
  }

  /** Everything the user should see BEFORE spending: the exact chain, the effective settings and the expected call counts. No price is computed. */
  async preflightCreativeProduction(userId: string, projectId: string, dto: StartCreativeDto = {}) {
    const r = await this.resolveCreative(userId, projectId, dto);
    return {
      ok: true,
      chain: { f1ReportId: r.f1.reportId, f2AuditId: r.f2.auditId, f3StrategyId: r.f3.strategyId, strategyCreatedAt: r.strategyRow.createdAt, strategyPartial: r.f3.partial, campaignName: r.f3.report.productContext.name },
      input: r.input,
      settings: r.settings,
      estimate: r.estimate,
      brand: { palette: r.palette, fromBrand: r.fromBrand, logo: r.logoName },
      imageModel: r.imageModelCheck,
      notes: [
        'Every limit is enforced by LaunchPilot per run; none of them is an OpenAI spending cap.',
        r.settings.imageModel ? `Each image request is billed by OpenAI for ${r.settings.imageModel} at quality "${r.settings.imageQuality}"; LaunchPilot records only what the provider reports and shows no price.` : 'No image model is selected, so no image request is made.',
        'Channel layouts are rendered locally from the base images: no model call and no cost per format.',
        r.settings.maxRegenerations > 0 ? `Up to ${r.settings.maxRegenerations} extra image(s) may be generated to replace a rejected one.` : 'Image regeneration is off: a rejected picture stays visible as an unresolved issue instead of being re-bought.',
      ],
    };
  }

  /**
   * F4 Creative Production on ONE completed F3 strategy (and the exact F1 report and F2 audit it names). Six Mozaik participants
   * (the Fixer only if the review finds something to repair). Uses the user's own OpenAI key for text AND images; nothing runs
   * without this explicit call. `testHooks` (timeouts, fake tools) is for tests only and is not reachable through HTTP.
   */
  async startCreativeProduction(userId: string, projectId: string, dto: StartCreativeDto = {}, testHooks: Partial<CreativeRunConfig> = {}) {
    const r = await this.resolveCreative(userId, projectId, dto);
    const { f1, f2, f3, input, settings } = r;
    return this.launchRun({
      userId,
      projectId,
      mode: 'creative_production',
      provider: 'openai',
      start: async (run, writer) => {
        // The campaign row exists from the start so the assets the agents store while running already belong to it.
        const campaign = await this.prisma.creativeCampaign.create({
          data: { projectId, runId: run.id, f1ReportId: f1.reportId, f2AuditId: f2.auditId, f3StrategyId: f3.strategyId, schemaVersion: CAMPAIGN_SCHEMA_VERSION, language: input.language, model: settings.model, imageModel: settings.imageModel, status: 'running', campaignName: `${f3.report.productContext.name} — creative campaign`.slice(0, 120) },
        });
        const assets = new DbAssetStore(this.prisma, this.storage, projectId, campaign.id);
        return this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'creative_production',
          manifest: this.buildManifest(r.project, r.intake),
          credentials: r.credentials,
          creative: {
            campaignId: campaign.id,
            projectId,
            f1,
            f2,
            f3,
            input,
            model: settings.model,
            imageModel: settings.imageModel,
            imageQuality: settings.imageQuality,
            ...(settings.imageSize ? { imageSize: settings.imageSize } : {}),
            maxImages: settings.maxImages,
            maxRegenerations: settings.maxRegenerations,
            maxLayoutsPerConcept: settings.maxLayoutsPerConcept,
            maxRepairRounds: settings.maxRepairRounds,
            visionReviews: settings.visionReviews,
            maxModelCalls: settings.maxModelCalls,
            maxOutputTokens: settings.maxOutputTokens,
            palette: r.palette,
            hasBrandPalette: r.fromBrand,
            logo: r.logo,
            assets,
            baseUrl: resolveOpenAIBaseUrl(),
            ...testHooks,
          },
          onEvent: writer.push,
          // Saved BEFORE the run is marked COMPLETED (the runtime waits for this promise). A finished campaign is never overwritten.
          onCampaign: async (pkg: CampaignPackage, meta: CreativeReportMeta) => {
            await this.prisma.creativeCampaign.update({
              where: { id: campaign.id },
              data: {
                status: 'completed',
                approvalStatus: pkg.approval.status,
                campaignName: pkg.campaignName,
                packageJson: redact(pkg) as unknown as Prisma.InputJsonValue,
                metadataJson: redact({ ...meta, brand: { palette: r.palette, fromBrand: r.fromBrand, logo: !!r.logo } }) as unknown as Prisma.InputJsonValue,
              },
            });
          },
        });
      },
      afterFinalize: async (result) => {
        await this.prisma.creativeCampaign.updateMany({ where: { runId: result.runId, status: 'running' }, data: { status: result.status } });
      },
    });
  }

  private campaignSummary(r: { id: string; projectId: string; runId: string; f1ReportId: string; f2AuditId: string; f3StrategyId: string; schemaVersion: number; language: string; model: string; imageModel: string | null; status: string; approvalStatus: string | null; campaignName: string; packageJson: unknown; createdAt: Date }) {
    const pkg = (r.packageJson ?? null) as Partial<CampaignPackage> | null;
    const assets = pkg?.imageAssets ?? [];
    return {
      id: r.id,
      projectId: r.projectId,
      runId: r.runId,
      f1ReportId: r.f1ReportId,
      f2AuditId: r.f2AuditId,
      f3StrategyId: r.f3StrategyId,
      schemaVersion: r.schemaVersion,
      language: r.language,
      model: r.model,
      imageModel: r.imageModel,
      status: r.status,
      approvalStatus: r.approvalStatus,
      campaignName: r.campaignName,
      createdAt: r.createdAt,
      concepts: pkg?.concepts?.length ?? null,
      variants: pkg?.copyVariants?.length ?? null,
      layouts: pkg?.channelLayouts?.length ?? null,
      generatedImages: pkg ? assets.filter((a) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded').length : null,
      findings: pkg?.reviewFindings?.length ?? null,
      unresolved: pkg?.approval?.unresolvedFindingIds?.length ?? null,
      usage: pkg?.usage ?? null,
    };
  }

  /** Campaign summaries for a project, newest first, with cursor pagination. */
  async listCampaigns(userId: string, projectId: string, query: ListAuditsQueryDto = {}) {
    await this.projects.assertOwned(userId, projectId);
    const limit = query.limit ?? 20;
    const rows = await this.prisma.creativeCampaign.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return { items: page.map((r) => this.campaignSummary(r)), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  }

  private async ownedCampaign(userId: string, campaignId: string) {
    // 404 (not 403) for other users' campaigns so ids cannot be probed.
    const r = await this.prisma.creativeCampaign.findFirst({ where: { id: campaignId, project: { userId } } });
    if (!r) throw new NotFoundException('Campaign not found');
    return r;
  }

  private assetView(campaignId: string) {
    return (row: Parameters<typeof toAssetRecord>[0]) => ({ ...toAssetRecord(row), url: `/campaigns/${campaignId}/assets/${row.id}/file` });
  }

  async getCampaign(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    const rows = await this.prisma.campaignAsset.findMany({ where: { campaignId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { ...this.campaignSummary(r), package: r.packageJson, metadata: r.metadataJson, assets: rows.map(this.assetView(campaignId)) };
  }

  async getCampaignAssets(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    const rows = await this.prisma.campaignAsset.findMany({ where: { campaignId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { campaignId: r.id, status: r.status, items: rows.map(this.assetView(campaignId)) };
  }

  async getCampaignReviews(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    const pkg = (r.packageJson ?? null) as Partial<CampaignPackage> | null;
    return { campaignId: r.id, status: r.status, approval: pkg?.approval ?? null, findings: pkg?.reviewFindings ?? [], revisions: pkg?.revisions ?? [], limitations: pkg?.limitations ?? [] };
  }

  /** The stored binary of one campaign asset, for the authenticated owner only (never served statically). */
  async openCampaignAsset(userId: string, campaignId: string, assetId: string) {
    const row = await this.prisma.campaignAsset.findFirst({ where: { id: assetId, campaignId, project: { userId } } });
    if (!row) throw new NotFoundException('Asset not found');
    return { asset: row, stream: this.storage.read(row.filePath) };
  }

  /** The local landing-page PREVIEW (escaped template + CSP; the UI shows it in a sandboxed iframe). Deployed nowhere. */
  async getLandingPreview(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    const pkg = (r.packageJson ?? null) as Partial<CampaignPackage> | null;
    if (!pkg?.landingContent) throw new NotFoundException('This campaign has no landing page content');
    const meta = (r.metadataJson ?? {}) as { brand?: { palette?: string[] } };
    return renderLandingHtml(pkg.landingContent, { name: pkg.campaignName ?? r.campaignName, language: pkg.language ?? r.language, palette: meta.brand?.palette ?? [] });
  }

  /** The downloadable package: real binaries, JSON, copy, landing content and preview, review, manifest. */
  async exportCampaign(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    if (!r.packageJson) throw new ConflictException(r.status === 'running' ? 'The campaign is still being produced' : 'This campaign has no package (the run did not finish)');
    const parsed = CampaignPackage.safeParse(r.packageJson);
    if (!parsed.success) throw new UnprocessableEntityException('The stored campaign package could not be read');
    const meta = (r.metadataJson ?? {}) as { brand?: { palette?: string[] } };
    const { zip, manifest } = await buildCampaignZip(parsed.data, new DbAssetStore(this.prisma, this.storage, r.projectId, r.id), { palette: meta.brand?.palette ?? [] });
    return { zip, filename: zipFileName(parsed.data), manifest };
  }

  /**
   * The Mozaik view of a creative run: plan (incl. the Fixer created at run time), participants, cross-checks, usage and the
   * timeline of REAL participant events (copy -> images -> layouts -> review -> repairs). From the saved campaign when there is
   * one, otherwise folded from the persisted events, so a running or failed run is still inspectable.
   */
  async getCreativeAnalysis(userId: string, runId: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.mode !== 'creative_production') throw new NotFoundException('Run not found');
    type Obj = Record<string, any>;
    const [campaign, events] = await Promise.all([this.prisma.creativeCampaign.findFirst({ where: { runId } }), this.prisma.campaignEvent.findMany({ where: { runId }, orderBy: { sequence: 'asc' }, take: 1500 })]);
    const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    const TIMELINE = new Set(['phase.started', 'task.assigned', 'task.completed', 'copy.proposed', 'landing.proposed', 'visual.generated', 'layout.completed', 'crosscheck.requested', 'crosscheck.answered', 'review.requested', 'review.completed', 'participant.registered', 'participant.idle', 'fix.requested', 'revision.requested', 'revision.applied', 'revision.completed', 'campaign.completed', 'phase.completed', 'phase.failed', 'factory.completed', 'factory.failed', 'factory.cancelled']);
    const summarize = (type: string, p: Obj): string => {
      switch (type) {
        case 'copy.proposed': return `${n(p.concepts)} concept(s), ${n(p.variants)} copy variant(s) proposed`;
        case 'landing.proposed': return 'landing page content proposed';
        case 'visual.generated': return `${p.conceptId}: ${p.failed ? `image failed (${p.error?.message ?? 'unknown'}), brand background used` : `image stored as ${p.asset?.id ?? '?'}`}`;
        case 'layout.completed': return `${p.conceptId}: ${n(p.layouts)} layout(s) rendered${n(p.skipped) ? `, ${n(p.skipped)} format(s) skipped` : ''}`;
        case 'crosscheck.requested': return `${p.producer} → ${p.reviewer}: ${n(p.claims)} claim(s) to check`;
        case 'crosscheck.answered': return `${p.reviewer} → ${p.producer}: ${p.status}${p.status === 'answered' ? ` (${(p.answers ?? []).map((a: Obj) => a.verdict).join(', ')})` : ''}`;
        case 'review.requested': return `round ${p.round}: ${n(p.scope?.variantIds)} variant(s), ${n(p.scope?.assetIds)} asset(s)${p.scope?.landing ? ', landing page' : ''}`;
        case 'review.completed': return `round ${p.round}: ${n(p.findings)} finding(s), model review ${p.modelReview}`;
        case 'participant.registered': return `${p.agent} created at run time: ${p.reason}`;
        case 'participant.idle': return `${p.agent}: ${p.reason}`;
        case 'fix.requested': return `round ${p.round}: ${n(p.findingIds)} finding(s) handed to the Fixer`;
        case 'revision.requested': return `Fixer → ${p.agent}: ${n(p.operations)} repair operation(s), wave ${p.wave}`;
        case 'revision.applied': return `${p.owner}: ${p.status} — ${p.note}`;
        case 'revision.completed': return `round ${p.round}: ${(p.results ?? []).filter((r: Obj) => r.status === 'applied').length} of ${n(p.results)} repair(s) applied`;
        case 'task.assigned': return `${p.agent} assigned: ${p.task}`;
        case 'task.completed': return `${p.agent}: ${p.outcome}${p.error ? ` (${p.error.message})` : ''}${p.reason ? ` (${p.reason})` : ''}`;
        case 'campaign.completed': return 'campaign package saved';
        default: return '';
      }
    };
    const timeline = events.filter((e) => TIMELINE.has(e.eventType)).map((e) => ({ sequence: e.sequence, type: e.eventType, participant: e.participant, at: e.createdAt, summary: summarize(e.eventType, (e.payloadJson ?? {}) as Obj) }));

    const dyn = { activated: [] as Obj[], skipped: [] as Obj[] };
    const fold = { plan: null as unknown, participants: new Map<string, Obj>(), sources: [] as unknown[], crosschecks: [] as Obj[] };
    const progress = { concepts: 0, variants: 0, landing: false, images: 0, imagesFailed: 0, layouts: 0, skippedLayouts: 0, round: 0, findings: 0, repairsApplied: 0, repairsFailed: 0 };
    for (const e of events) {
      const p = (e.payloadJson ?? {}) as Obj;
      switch (e.eventType) {
        case 'phase.started': fold.plan = p.plan ?? null; break;
        case 'source.retrieved': fold.sources.push(p.source); break;
        case 'task.assigned': fold.participants.set(p.agent, { agent: p.agent, state: 'working' }); break;
        case 'participant.idle':
          fold.participants.set(p.agent, { agent: p.agent, state: 'skipped', reason: p.reason });
          if (p.agent === 'Fixer') dyn.skipped.push({ agent: p.agent, key: 'fixer', reason: p.reason });
          break;
        case 'participant.registered':
          fold.participants.set(p.agent, { agent: p.agent, state: 'working', reason: p.reason });
          dyn.activated.push({ agent: p.agent, key: 'fixer', reason: p.reason, dynamic: true });
          break;
        case 'task.completed': fold.participants.set(p.agent, { agent: p.agent, state: p.outcome === 'succeeded' ? 'done' : p.outcome, error: p.error ?? null, reason: p.reason ?? null }); break;
        case 'crosscheck.requested': for (const c of p.claims ?? []) fold.crosschecks.push({ requestId: p.requestId, producer: p.producer, reviewer: p.reviewer, claimId: c.claimId, status: 'pending' }); break;
        case 'crosscheck.answered':
          for (const c of fold.crosschecks.filter((x) => x.requestId === p.requestId)) {
            const a = (p.answers ?? []).find((x: Obj) => x.claimId === c.claimId);
            Object.assign(c, a ? { status: 'answered', verdict: a.verdict, rationale: a.rationale } : { status: 'failed' });
          }
          break;
        case 'copy.proposed': progress.concepts = n(p.concepts); progress.variants = n(p.variants); break;
        case 'landing.proposed': progress.landing = true; break;
        case 'visual.generated': progress.images += p.failed ? 0 : 1; progress.imagesFailed += p.failed ? 1 : 0; break;
        case 'layout.completed': progress.layouts += n(p.layouts); progress.skippedLayouts += n(p.skipped); break;
        case 'review.requested': progress.round = Number(p.round) || progress.round; break;
        case 'review.completed': progress.findings = n(p.findings); break;
        case 'revision.completed': for (const r of p.results ?? []) r.status === 'applied' ? progress.repairsApplied++ : progress.repairsFailed++; break;
      }
    }
    const base = { runId, status: run.status, kind: 'creative' as const, campaignId: campaign?.id ?? null, campaignStatus: campaign?.status ?? null, approvalStatus: campaign?.approvalStatus ?? null, progress, timeline };
    const m = (campaign?.metadataJson ?? null) as (Partial<CreativeReportMeta> & { brand?: { palette: string[]; fromBrand: boolean; logo: boolean } }) | null;
    if (campaign?.packageJson && m) {
      return {
        ...base, source: 'report' as const,
        plan: m.plan ?? null, participants: m.participants ?? [], sources: m.sources ?? [], crosschecks: m.crosschecks ?? [], usage: m.usage ?? null, aiCalls: m.aiCalls ?? {},
        images: m.images ?? null, settings: m.settings ?? null, chain: m.chain ?? null, summaries: m.summaries ?? {}, why: m.why ?? null, partial: m.partial ?? false, brand: m.brand ?? null, imageModel: m.imageModel ?? null, model: m.model ?? null,
      };
    }
    const basePlan = fold.plan as { activated?: Obj[]; skipped?: Obj[] } | null;
    const plan = basePlan && (dyn.activated.length || dyn.skipped.length) ? { ...basePlan, activated: [...(basePlan.activated ?? []), ...dyn.activated], skipped: [...(basePlan.skipped ?? []), ...dyn.skipped] } : fold.plan;
    return { ...base, source: 'events' as const, plan, participants: [...fold.participants.values()], sources: fold.sources, crosschecks: fold.crosschecks, usage: null, aiCalls: {}, images: null, settings: null, chain: campaign ? { f1ReportId: campaign.f1ReportId, f2AuditId: campaign.f2AuditId, f3StrategyId: campaign.f3StrategyId } : null, summaries: {}, why: null, partial: false, brand: null, imageModel: campaign?.imageModel ?? null, model: campaign?.model ?? null };
  }

  async cancel(userId: string, runId: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.status !== RunStatus.RUNNING) throw new ConflictException(`Run already ${run.status.toLowerCase()}`);

    const entry = this.active.get(runId);
    if (entry) {
      await entry.handle.cancel('cancelled');
      await entry.finalized;
    } else {
      // RUNNING in the database but not held by this process: nothing can still be executing it.
      await this.prisma.campaignRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING },
        data: { status: RunStatus.INTERRUPTED, completedAt: new Date(), errorMessage: 'Run was not active on this server' },
      });
    }
    return toRunView(await this.ownedRun(userId, runId));
  }

  /**
   * Single entrance for resolving a user's BYOK credentials at run start for providers other than
   * the dedicated flows above. Keyed by `userId`, so one user's key cannot reach another's run.
   */
  async prepareInference(userId: string, providerKey?: AiProvider): Promise<InferenceCredentials> {
    const resolved = await this.credentials.getDecryptedKey(userId, providerKey);
    if (!resolved) {
      throw new UnprocessableEntityException(
        'Add an OpenAI or Gemini API key under Settings > AI providers to run AI workflows',
      );
    }
    return { provider: resolved.providerKey as AiProvider, apiKey: resolved.apiKey };
  }

  // ---- internals

  /** Shared run lifecycle: row -> runtime -> event stream -> terminal status. */
  private async launchRun(args: {
    userId: string;
    projectId: string;
    mode: RunMode;
    provider: string | null;
    start: (run: CampaignRun, writer: EventWriter) => Promise<CampaignRunHandle>;
    /** Runs after the terminal status is persisted (and when the runtime failed to start). */
    afterFinalize?: (result: CampaignRunResult) => Promise<void>;
  }) {
    const { userId, projectId, mode } = args;
    let run: CampaignRun;
    try {
      // The partial unique index (one RUNNING run per project) makes this check atomic.
      run = await this.prisma.campaignRun.create({ data: { projectId, userId, mode, provider: args.provider } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A run is already in progress for this project');
      }
      throw err;
    }

    const writer = new EventWriter(this.prisma, this.logger);
    let handle: CampaignRunHandle;
    try {
      handle = await args.start(run, writer);
    } catch (err) {
      await writer.flush();
      const failed = await this.prisma.campaignRun.update({
        where: { id: run.id },
        data: { status: RunStatus.FAILED, completedAt: new Date(), errorMessage: safeErrorMessage(err) },
        include: withReport,
      });
      this.logger.error(`Runtime failed to start for run ${run.id}: ${safeErrorMessage(err)}`);
      await args.afterFinalize?.({ runId: run.id, status: 'failed', errorMessage: safeErrorMessage(err), eventCount: 0 }).catch(() => undefined);
      return toRunView(failed);
    }

    const finalized = handle.done
      .then((result) => this.finalize(result, writer))
      .then(() => undefined)
      .then(async () => {
        const row = await this.prisma.campaignRun.findUnique({ where: { id: run.id } });
        const status = (row?.status === RunStatus.COMPLETED ? 'completed' : row?.status === RunStatus.CANCELLED ? 'cancelled' : row?.status === RunStatus.INTERRUPTED ? 'interrupted' : 'failed') as CampaignRunResult['status'];
        await args.afterFinalize?.({ runId: run.id, status, errorMessage: row?.errorMessage ?? undefined, eventCount: 0 });
      })
      .catch((err) => {
        this.logger.error(`Failed to finalize run ${run.id}: ${safeErrorMessage(err)}`);
      })
      .finally(() => {
        this.active.delete(run.id);
      });
    this.active.set(run.id, { handle, writer, finalized });

    return toRunView(run);
  }

  private async finalize(result: CampaignRunResult, writer: EventWriter) {
    await writer.flush();
    let status = RESULT_TO_DB[result.status];
    let errorMessage = result.errorMessage ?? null;
    if (status === RunStatus.INTERRUPTED && !errorMessage) errorMessage = 'Interrupted: the server was shutting down';
    if (status === RunStatus.COMPLETED && writer.errors.length > 0) {
      // Never report success for a run whose history is incomplete.
      status = RunStatus.FAILED;
      errorMessage = 'Run finished but its event history could not be fully saved';
    }
    // Conditional update: a status that is already terminal is never overwritten.
    await this.prisma.campaignRun.updateMany({
      where: { id: result.runId, status: RunStatus.RUNNING },
      data: { status, completedAt: new Date(), errorMessage },
    });
  }

  private async ownedRun(userId: string, runId: string) {
    // 404 (not 403) for other users' runs so ids cannot be probed.
    const run = await this.prisma.campaignRun.findFirst({ where: { id: runId, userId }, include: withReport });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /** Whitelisted, non-secret snapshot of the brief given to the runtime. */
  private buildManifest(project: Project, intake: ProductIntake | null): CampaignManifest {
    return {
      productName: intake?.productName ?? project.name,
      description: intake?.shortDescription ?? project.description,
      websiteUrl: intake?.websiteUrl,
      githubUrl: intake?.githubUrl,
      marketingGoal: intake?.marketingGoal,
      targetMarket: intake?.targetMarket,
      targetAudience: intake?.targetAudience,
      language: intake?.preferredLanguage,
    };
  }
}
