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
  isClaudeModel,
  redact,
  resolveAnthropicBaseUrl,
  resolveOpenAIBaseUrl,
  TEXT_AGENT_PROVIDERS,
  safeErrorMessage,
  SpendBudget,
  type AiProvider,
  type CampaignManifest,
  type CampaignRunHandle,
  type CampaignRunResult,
  type CampaignRuntime,
  type DiscoveryRunConfig,
  type InferenceCredentials,
  type CampaignStrategyReport,
  type StrategyReportMeta,
  type StrategyRunConfig,
  checkSavedChain,
  type DocumentInput,
  type MarketingAuditReport,
  type ImageInput,
  type ProductDiscoveryReportV2,
  type ReportMeta,
  type SmokeTestOptions,
  buildCampaignZip,
  creditsText,
  zipFileName,
  derivePalette,
  CampaignPackage,
  CAMPAIGN_SCHEMA_VERSION,
  type ChannelId,
  type CreativeInput,
  type CreativeReportMeta,
  type CreativeRunConfig,
} from '@launchpilot/agents';
import { StorageDriver } from '../storage/storage.service';
import { DbAssetStore, readAll, toAssetRecord } from './campaign-assets';
import { HybridInputsService } from './hybrid-support';
import { ImageLibraryService } from '../visual/image-library.service';
import { ProjectBrandService } from '../visual/project-brand.service';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { EventWriter } from './event-writer';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';
import { chainException } from './report-errors';
import { VisualService } from '../visual/visual.service';
import { ListAuditsQueryDto, ListEventsQueryDto, StartSmokeTestDto } from './dto/mozaik.dto';

const RESULT_TO_DB: Record<CampaignRunResult['status'], RunStatus> = {
  completed: RunStatus.COMPLETED,
  failed: RunStatus.FAILED,
  cancelled: RunStatus.CANCELLED,
  interrupted: RunStatus.INTERRUPTED,
};

const RUN_LABELS: Record<string, string> = {
  smoke_test: 'Infrastructure Smoke Test',
  product_discovery: 'Business Research',
  marketing_audit: 'Marketing Audit (historical)',
  market_strategy: 'Marketing Strategy',
  creative_production: 'Creative Production',
};

type RunMode = 'smoke_test' | 'product_discovery' | 'marketing_audit' | 'market_strategy' | 'creative_production';
type RunWithReport = CampaignRun & { report?: { id: string } | null; audit?: { id: string } | null; strategy?: { id: string } | null; campaign?: { id: string } | null };
const withReport = { report: { select: { id: true } }, audit: { select: { id: true } }, strategy: { select: { id: true } }, campaign: { select: { id: true } } } as const;

/** What Campaign Production hands the strategy stage (the campaign configuration; never a model or a provider). */
export interface StrategyStartOptions {
  f1ReportId: string;
  objective: string | null;
  targetAudience: string | null;
  competitorUrls: string[];
  useHolidayCalendar: boolean;
  maxModelCalls?: number;
  maxOutputTokens?: number;
}

/** What Campaign Production hands the creative stage. */
export interface CreativeStartOptions {
  strategyId: string;
  channels: string[];
  concepts: number;
  objective: string | null;
  audience: string | null;
  /** The user's writing-style override (tone, humor, preferred and forbidden words); null/absent = inferred from the research. */
  voice?: { tone: 'professional' | 'conversational' | 'playful' | 'premium' | 'technical' | null; humor: boolean | null; preferredTerms: string[]; avoid: string[] } | null;
  /** The campaign design (collection, palette, formats, picture sourcing, facts, references); normalized by the server. */
  design: unknown;
  maxRepairRounds?: number;
  visionReviews?: number;
  maxModelCalls?: number;
  maxOutputTokens?: number;
}

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
    private hybridInputs: HybridInputsService,
    private visual: VisualService,
    private library: ImageLibraryService,
    private brandSvc: ProjectBrandService,
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
  async startSmokeTest(userId: string, projectId: string, dto: StartSmokeTestDto = {}, testHooks: SmokeTestOptions = {}, opts: { factoryRunId?: string } = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    const [intake, user] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    return this.launchRun({
      factoryRunId: opts.factoryRunId,
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
   * Business Research (F1): the Business Researcher on the user's own provider key and saved model. Started only by Campaign Production.
   * `testHooks` (timeouts etc.) is for tests only and is not reachable through HTTP.
   */
  async startProductDiscovery(userId: string, projectId: string, o: { maxModelCalls?: number; maxOutputTokens?: number } = {}, testHooks: Partial<DiscoveryRunConfig> = {}, opts: { factoryRunId?: string; spendCapUsd?: number | null; ledger?: SpendBudget } = {}) {
    const project = await this.projects.assertOwned(userId, projectId);

    const { credentials, model, baseUrl } = await this.textProviderFor(userId, 'Business Research');

    const [intake, socials, assets, notes] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.socialProfile.findMany({ where: { projectId } }),
      this.prisma.projectAsset.findMany({ where: { projectId } }),
      this.prisma.workspaceNote.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const input = buildDiscoveryInput({ project, intake, socialProfiles: socials, assets, notes });
    const { documents, images } = this.loadAssets(assets);

    return this.launchRun({
      factoryRunId: opts.factoryRunId,
      userId,
      projectId,
      mode: 'product_discovery',
      provider: credentials.provider,
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
            maxModelCalls: o.maxModelCalls,
            maxOutputTokens: o.maxOutputTokens,
            spendCapUsd: opts.spendCapUsd ?? null,
            ledger: opts.ledger,
            baseUrl,
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

  /**
   * THE text provider of a run: the user's persisted default provider (Settings > AI providers: OpenAI or Claude), its key and its explicitly
   * chosen model. Every phase, the factory and every continuation resolve through here, so a run never mixes providers and nothing is switched
   * silently: a missing key/model or a model of the other provider is refused BEFORE anything is sent.
   */
  async textProviderFor(userId: string, what: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } });
    const provider = (user.defaultAiProvider ?? 'openai') as AiProvider;
    if (!(TEXT_AGENT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new UnprocessableEntityException(`${what} runs on OpenAI or Claude, but your default AI provider is ${provider}. Choose OpenAI or Claude as the default under Settings > AI providers.`);
    }
    const name = provider === 'anthropic' ? 'Claude' : 'OpenAI';
    const cred = await this.credentials.getDecryptedCredential(userId, provider);
    if (!cred) throw new UnprocessableEntityException(`${what} needs your ${name} API key. Add it under Settings > AI providers.`);
    const model = cred.model;
    if (!model) throw new UnprocessableEntityException(`Choose ${provider === 'anthropic' ? 'a Claude' : 'an OpenAI'} model first (Settings > AI providers). LaunchPilot never picks one for you.`);
    if ((provider === 'anthropic') !== isClaudeModel(model)) {
      throw new UnprocessableEntityException(`The model "${model}" is not ${provider === 'anthropic' ? 'a Claude' : 'an OpenAI'} model, and LaunchPilot never switches providers on its own. Pick a ${name} model, or change the default provider under Settings > AI providers.`);
    }
    const credentials: InferenceCredentials = { provider, apiKey: cred.apiKey };
    return { credentials, model, provider, baseUrl: provider === 'anthropic' ? resolveAnthropicBaseUrl() : resolveOpenAIBaseUrl() };
  }

  /** HISTORICAL audit summaries (V4 runs no audit; saved ones stay readable), newest first, with cursor pagination. */
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
        const meta = (r.metadataJson ?? {}) as Record<string, any>;
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
   * Marketing Strategy (F3): the Marketing Strategist on ONE completed business research report, with this campaign's objective and audience.
   * Started only by Campaign Production. `testHooks` (timeouts, test tools, the clock) is for tests only and is not reachable through HTTP.
   */
  async startMarketStrategy(userId: string, projectId: string, o: StrategyStartOptions, testHooks: Partial<StrategyRunConfig> = {}, opts: { factoryRunId?: string; spendCapUsd?: number | null; ledger?: SpendBudget } = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    const f1Row = await this.prisma.productDiscoveryReport.findFirst({ where: { id: o.f1ReportId, projectId, project: { userId } } });
    if (!f1Row) throw new NotFoundException('Business research report not found');
    const check = checkSavedChain({ projectId, f1: f1Row, expect: ['F1'] });
    if (!check.ok) throw chainException('Marketing Strategy', check);
    const f1 = check.contexts.f1!;

    const { credentials, model, baseUrl } = await this.textProviderFor(userId, 'Marketing Strategy');
    const [intake, socials] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.prisma.socialProfile.findMany({ where: { projectId } })]);
    const base = buildDiscoveryInput({ project, intake, socialProfiles: socials, assets: [], notes: [] });
    const input = {
      projectName: intake?.productName ?? project.name,
      language: base.language,
      geography: [...new Set([...f1.report.productManifest.geography, ...(intake?.targetMarket ? [intake.targetMarket] : [])].map((g) => g.trim()).filter(Boolean))].slice(0, 6),
      targetAudience: o.targetAudience ?? (intake?.targetAudience?.trim() || null),
      marketingGoal: o.objective ?? (intake?.marketingGoal?.trim() || null),
      campaignDuration: intake?.campaignDuration?.trim() || null,
      budgetNote: null,
      websiteUrl: intake?.websiteUrl?.trim() || null,
      socialProfiles: socials.map((s) => ({ platform: s.platform, url: s.url })),
      competitorUrls: o.competitorUrls,
      competitorNames: [],
      useHolidayCalendar: o.useHolidayCalendar,
    };

    return this.launchRun({
      factoryRunId: opts.factoryRunId,
      userId,
      projectId,
      mode: 'market_strategy',
      provider: credentials.provider,
      start: (run, writer) =>
        this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'market_strategy',
          manifest: this.buildManifest(project, intake),
          credentials,
          strategy: { f1, input, model, maxModelCalls: o.maxModelCalls, maxOutputTokens: o.maxOutputTokens, spendCapUsd: opts.spendCapUsd ?? null, ledger: opts.ledger, baseUrl, ...testHooks },
          onEvent: writer.push,
          // Saved BEFORE the run is marked COMPLETED (the runtime waits for this promise).
          onStrategy: async (report: CampaignStrategyReport, meta: StrategyReportMeta) => {
            await this.prisma.marketingStrategyReport.create({
              data: {
                projectId,
                runId: run.id,
                f1ReportId: f1.reportId,
                f2AuditId: null,
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
      const m = (savedAudit.metadataJson ?? {}) as Record<string, any>;
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
   * Resolves the F1 -> F3 chain, the user's text provider and model and the inputs of a creative run WITHOUT starting or spending anything.
   * `startCreativeProduction` reuses it, so what the preflight showed is exactly what runs. Historical strategies (built on an F2 audit) work too:
   * the audit is simply not read any more.
   */
  private async resolveCreative(userId: string, projectId: string, o: CreativeStartOptions) {
    const project = await this.projects.assertOwned(userId, projectId);
    const strategyRow = await this.prisma.marketingStrategyReport.findFirst({ where: { id: o.strategyId, projectId, project: { userId } } });
    if (!strategyRow) throw new NotFoundException('Strategy not found');
    const f1Row = await this.prisma.productDiscoveryReport.findFirst({ where: { id: strategyRow.f1ReportId, projectId, project: { userId } } });
    if (!f1Row) throw new UnprocessableEntityException('The strategy refers to a business research report that does not belong to this project.');
    // ONE free check of the chain: each report read through the shared contract, ownership and lineage verified
    const chain = checkSavedChain({ projectId, f1: f1Row, f3: strategyRow, expect: ['F1', 'F3'] });
    if (!chain.ok) throw chainException('Creative Production', chain);
    const f1 = chain.contexts.f1!;
    const f3 = chain.contexts.f3!;

    const { credentials, model, baseUrl } = await this.textProviderFor(userId, 'Creative Production');
    const [intake, logoAsset] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.brandSvc.logoAsset(projectId)]);
    // brand content the owner approved with Get Content (null when Get Content was never used)
    const brandCtx = await this.brandSvc.brandContext(projectId, logoAsset?.id ?? null);
    const input: CreativeInput = {
      projectName: intake?.productName ?? project.name,
      language: f3.report.language || 'en',
      websiteUrl: intake?.websiteUrl?.trim() || null,
      channels: [...new Set(o.channels)] as ChannelId[],
      concepts: o.concepts,
      objective: o.objective,
      audience: o.audience,
      voice: o.voice ?? null,
    };
    const logo = logoAsset ? await readAll(this.storage.read(logoAsset.filePath)).catch(() => null) : null;
    const { palette, fromBrand } = await derivePalette(f1.palette, logo);
    // the campaign design and the approved, rights-cleared pictures of THIS project (normalized by the server)
    const designIn = await this.hybridInputs.prepare(projectId, o.design as never, true);
    return { project, intake, f1, f3, credentials, model, baseUrl, input, palette, fromBrand, logo, brandCtx, designIn };
  }

  /**
   * F4 Creative Production on ONE completed strategy: Content Writer, Visual Researcher, Creative Designer and Quality Reviewer. Text only on the
   * user's own provider key; every visual is rendered locally from approved pictures and the template collection. No image is ever generated.
   * Started only by Campaign Production. `testHooks` is for tests only and is not reachable through HTTP.
   */
  async startCreativeProduction(userId: string, projectId: string, o: CreativeStartOptions, testHooks: Partial<CreativeRunConfig> = {}, opts: { factoryRunId?: string; spendCapUsd?: number | null; ledger?: SpendBudget } = {}) {
    const r = await this.resolveCreative(userId, projectId, o);
    const { f1, f3, input, credentials, baseUrl, designIn } = r;
    const design = designIn.hybrid;
    return this.launchRun({
      factoryRunId: opts.factoryRunId,
      userId,
      projectId,
      mode: 'creative_production',
      provider: credentials.provider,
      start: async (run, writer) => {
        // The campaign row exists from the start so the assets the agents store while running already belong to it.
        const campaign = await this.prisma.creativeCampaign.create({
          data: { projectId, runId: run.id, f1ReportId: f1.reportId, f2AuditId: null, f3StrategyId: f3.strategyId, schemaVersion: CAMPAIGN_SCHEMA_VERSION, language: input.language, model: r.model, imageModel: null, status: 'running', campaignName: `${f3.report.productContext.name} — campaign`.slice(0, 120) },
        });
        const assets = new DbAssetStore(this.prisma, this.storage, projectId, campaign.id);
        return this.runtime.startRun({
          runId: run.id,
          projectId,
          userId,
          mode: 'creative_production',
          manifest: this.buildManifest(r.project, r.intake),
          credentials,
          creative: {
            campaignId: campaign.id,
            projectId,
            f1,
            f3,
            input,
            model: r.model,
            spendCapUsd: opts.spendCapUsd ?? null,
            ledger: opts.ledger,
            design,
            brandImages: designIn.brandImages,
            referencePalettes: designIn.referencePalettes,
            // search and download during the run happen ONLY in automatic stock mode, with the providers the user approved
            discovery: design.imagery.autoStock ? this.visual.discoveryPort({ includePaid: design.imagery.allowPaidSearch }) : null,
            acquire: design.imagery.autoStock ? this.visual.acquirePort(userId, projectId) : null,
            discoveredBefore: await this.library.discoveredCount(projectId),
            maxRepairRounds: o.maxRepairRounds,
            visionReviews: o.visionReviews,
            maxModelCalls: o.maxModelCalls,
            maxOutputTokens: o.maxOutputTokens,
            palette: r.palette,
            hasBrandPalette: r.fromBrand,
            logo: r.logo,
            ...(r.brandCtx ? { brand: r.brandCtx } : {}),
            assets,
            baseUrl,
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

  private campaignSummary(r: { id: string; projectId: string; runId: string; f1ReportId: string; f2AuditId: string | null; f3StrategyId: string; schemaVersion: number; language: string; model: string; imageModel: string | null; status: string; approvalStatus: string | null; campaignName: string; packageJson: unknown; createdAt: Date }) {
    const pkg = (r.packageJson ?? null) as Partial<CampaignPackage> | null;
    return {
      id: r.id,
      projectId: r.projectId,
      runId: r.runId,
      f1ReportId: r.f1ReportId,
      /** historical campaigns only (built on an F2 audit) */
      f2AuditId: r.f2AuditId,
      f3StrategyId: r.f3StrategyId,
      schemaVersion: r.schemaVersion,
      language: r.language,
      model: r.model,
      /** historical campaigns only: V4 never generates an AI image */
      imageModel: r.imageModel,
      status: r.status,
      approvalStatus: r.approvalStatus,
      campaignName: r.campaignName,
      createdAt: r.createdAt,
      concepts: pkg?.concepts?.length ?? null,
      variants: pkg?.copyVariants?.length ?? null,
      deliverables: pkg?.deliverables?.counts ?? null,
      cost: pkg?.cost ?? null,
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

  /** THE download: one ZIP with the strategy, the social posts and visuals per platform, the ads, the print designs, brand, sources and README. Old campaigns keep their own layout. */
  async exportCampaign(userId: string, campaignId: string) {
    const r = await this.ownedCampaign(userId, campaignId);
    if (!r.packageJson) throw new ConflictException(r.status === 'running' ? 'The campaign is still being produced' : 'This campaign has no package (the run did not finish)');
    const parsed = CampaignPackage.safeParse(r.packageJson);
    if (!parsed.success) throw new UnprocessableEntityException('The stored campaign package could not be read');
    const meta = (r.metadataJson ?? {}) as { brand?: { palette?: string[] } };
    const strategy = await this.prisma.marketingStrategyReport.findUnique({ where: { id: r.f3StrategyId }, select: { reportJson: true } });
    // credits of the licensed pictures this campaign was built from (a template creative lists its source pictures as "brand:<asset id>")
    const used = new Set(parsed.data.imageAssets.flatMap((a) => a.sourceAssetIds ?? []).filter((s) => s.startsWith('brand:')).map((s) => s.slice(6)));
    const provenance = used.size ? await this.prisma.imageProvenance.findMany({ where: { projectId: r.projectId, assetId: { in: [...used] } } }).catch(() => []) : [];
    const credits = creditsText(provenance.map((p) => ({ provider: p.provider, attribution: p.attribution, pageUrl: p.pageUrl, license: p.license, attributionRequired: p.attributionRequired })));
    // the original pictures the rights allow handing on (never a stock original whose license forbids it)
    const sources = parsed.data.hybrid?.imagery ? await this.library.exportSources(r.projectId, parsed.data.hybrid.imagery.library.filter((l) => l.redistributeOriginal).map((l) => l.id)) : [];
    // the approved logo file travels with the package metadata (only when Get Content approved one and it was used)
    const logoRef = parsed.data.hybrid?.brand?.logo ?? null;
    const logoRow = logoRef?.assetId ? await this.prisma.projectAsset.findFirst({ where: { id: logoRef.assetId, projectId: r.projectId } }) : null;
    const logoData = logoRow ? await readAll(this.storage.read(logoRow.filePath)).catch(() => null) : null;
    const brandRow = logoRow ? await this.brandSvc.content(r.projectId) : null;
    const logo = logoRow && logoData ? { fileName: logoRow.originalName, data: logoData, rights: ((brandRow?.logoRightsJson as { license?: string; verification?: string } | null)?.license ?? null) } : null;
    const { zip, manifest } = await buildCampaignZip(parsed.data, new DbAssetStore(this.prisma, this.storage, r.projectId, r.id), { palette: meta.brand?.palette ?? [], strategy: strategy?.reportJson ?? undefined, ...(credits ? { credits } : {}), ...(sources.length ? { sources } : {}), ...(logo ? { logo } : {}) });
    return { zip, filename: zipFileName(parsed.data), manifest };
  }

  /**
   * The Mozaik view of a creative run: plan, participants, usage and the timeline of REAL participant events (copy -> pictures -> templates ->
   * renders -> review -> repairs). From the saved campaign when there is one, otherwise folded from the persisted events, so a running or failed
   * run is still inspectable. Historical runs (AI images, landing page, Fixer) are folded with the same code: their extra events are listed as they are.
   */
  async getCreativeAnalysis(userId: string, runId: string) {
    const run = await this.ownedRun(userId, runId);
    if (run.mode !== 'creative_production') throw new NotFoundException('Run not found');
    type Obj = Record<string, any>;
    const [campaign, events] = await Promise.all([this.prisma.creativeCampaign.findFirst({ where: { runId } }), this.prisma.campaignEvent.findMany({ where: { runId }, orderBy: { sequence: 'asc' }, take: 1500 })]);
    const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    const TIMELINE = new Set(['phase.started', 'task.assigned', 'task.completed', 'copy.proposed', 'images.sourced', 'template.selection.completed', 'layout.completed', 'review.requested', 'review.completed', 'revision.requested', 'revision.applied', 'participant.registered', 'participant.idle', 'campaign.completed']);
    const summarize = (type: string, p: Obj): string => {
      switch (type) {
        case 'copy.proposed': return `${n(p.concepts)} concept(s), ${n(p.variants)} text(s) written`;
        case 'images.sourced': return String(p.summary ?? 'pictures sourced').slice(0, 200);
        case 'template.selection.completed': return `${n(p.plan?.items ?? p.items)} template(s) chosen`;
        case 'layout.completed': return `${p.conceptId ?? 'campaign'}: ${n(p.layouts)} visual(s) rendered${n(p.skipped) ? `, ${n(p.skipped)} skipped` : ''}`;
        case 'review.requested': return `review round ${p.round ?? 1}`;
        case 'review.completed': return `round ${p.round}: ${n(p.findings)} finding(s), model review ${p.modelReview}`;
        case 'revision.requested': return `${p.agent ?? 'revision'}: ${n(p.operations)} correction(s) requested`;
        case 'revision.applied': return `${p.owner ?? p.agent}: ${p.status}${p.note ? ` — ${p.note}` : ''}`;
        case 'participant.registered': return `${p.agent} joined: ${p.reason}`;
        case 'participant.idle': return `${p.agent}: ${p.reason}`;
        case 'task.assigned': return `${p.agent} assigned: ${p.task}`;
        case 'task.completed': return `${p.agent}: ${p.outcome}${p.error ? ` (${p.error.message})` : ''}${p.reason ? ` (${p.reason})` : ''}`;
        case 'campaign.completed': return 'campaign package saved';
        default: return '';
      }
    };
    const timeline = events.filter((e) => TIMELINE.has(e.eventType)).map((e) => ({ sequence: e.sequence, type: e.eventType, participant: e.participant, at: e.createdAt, summary: summarize(e.eventType, (e.payloadJson ?? {}) as Obj) }));
    const fold = { plan: null as unknown, participants: new Map<string, Obj>(), sources: [] as unknown[] };
    const progress = { concepts: 0, texts: 0, visuals: 0, skipped: 0, round: 0, findings: 0, corrections: 0 };
    for (const e of events) {
      const p = (e.payloadJson ?? {}) as Obj;
      switch (e.eventType) {
        case 'phase.started': fold.plan = p.plan ?? null; break;
        case 'source.retrieved': fold.sources.push(p.source); break;
        case 'task.assigned': fold.participants.set(p.agent, { agent: p.agent, state: 'working' }); break;
        case 'participant.idle': fold.participants.set(p.agent, { agent: p.agent, state: 'skipped', reason: p.reason }); break;
        case 'task.completed': fold.participants.set(p.agent, { agent: p.agent, state: p.outcome === 'succeeded' ? 'done' : p.outcome, error: p.error ?? null, reason: p.reason ?? null }); break;
        case 'copy.proposed': progress.concepts = n(p.concepts); progress.texts = n(p.variants); break;
        case 'layout.completed': progress.visuals += n(p.layouts); progress.skipped += n(p.skipped); break;
        case 'review.requested': progress.round = Number(p.round) || progress.round; break;
        case 'review.completed': progress.findings = n(p.findings); break;
        case 'revision.applied': if (p.status === 'applied') progress.corrections++; break;
      }
    }
    const base = { runId, status: run.status, kind: 'creative' as const, campaignId: campaign?.id ?? null, campaignStatus: campaign?.status ?? null, approvalStatus: campaign?.approvalStatus ?? null, progress, timeline };
    const m = (campaign?.metadataJson ?? null) as (Partial<CreativeReportMeta> & { brand?: { palette: string[]; fromBrand: boolean; logo: boolean } }) | null;
    if (campaign?.packageJson && m) {
      return { ...base, source: 'report' as const, plan: m.plan ?? null, participants: m.participants ?? [], sources: m.sources ?? [], usage: m.usage ?? null, aiCalls: m.aiCalls ?? {}, settings: m.settings ?? null, chain: m.chain ?? null, summaries: m.summaries ?? {}, why: m.why ?? null, partial: m.partial ?? false, brand: m.brand ?? null, model: m.model ?? null };
    }
    return { ...base, source: 'events' as const, plan: fold.plan, participants: [...fold.participants.values()], sources: fold.sources, usage: null, aiCalls: {}, settings: null, chain: campaign ? { f1ReportId: campaign.f1ReportId, f3StrategyId: campaign.f3StrategyId } : null, summaries: {}, why: null, partial: false, brand: null, model: campaign?.model ?? null };
  }

  /**
   * Waits until a run THIS process started has finished AND its terminal status, report and hooks are persisted (no polling, no
   * sleeping), then returns the stored row. If the timeout passes first the row is returned as it is (still RUNNING): the caller
   * decides. A RUNNING row that this process does not hold is an orphan (its owner is gone).
   */
  async waitForRun(runId: string, timeoutMs: number) {
    const entry = this.active.get(runId);
    if (entry) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([entry.finalized, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]).finally(() => timer && clearTimeout(timer));
    }
    const row = await this.prisma.campaignRun.findUniqueOrThrow({ where: { id: runId }, include: withReport });
    return { row, heldHere: this.active.has(runId) };
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
    /** Set only by the Factory Orchestrator, which owns the project while its full-campaign run is active. */
    factoryRunId?: string;
  }) {
    const { userId, projectId, mode } = args;
    if (!args.factoryRunId) {
      // While a full campaign run is active it owns the project: a phase started by hand in between would break its chain.
      const factory = await this.prisma.factoryRun.findFirst({ where: { projectId, status: { in: ['queued', 'running'] } }, select: { id: true } });
      if (factory) throw new ConflictException('A full campaign run is in progress for this project. Wait for it to finish or cancel it first.');
    }
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
