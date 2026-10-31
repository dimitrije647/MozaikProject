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
} from '@launchpilot/agents';
import { StorageDriver } from '../storage/storage.service';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { EventWriter } from './event-writer';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';
import { ListAuditsQueryDto, ListEventsQueryDto, StartAuditDto, StartDiscoveryDto, StartSmokeTestDto, StartStrategyDto } from './dto/mozaik.dto';

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
};

type RunMode = 'smoke_test' | 'product_discovery' | 'marketing_audit' | 'market_strategy';
type RunWithReport = CampaignRun & { report?: { id: string } | null; audit?: { id: string } | null; strategy?: { id: string } | null };
const withReport = { report: { select: { id: true } }, audit: { select: { id: true } }, strategy: { select: { id: true } } } as const;

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
      return toRunView(failed);
    }

    const finalized = handle.done
      .then((result) => this.finalize(result, writer))
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
