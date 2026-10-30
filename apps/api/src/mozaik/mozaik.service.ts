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
  safeErrorMessage,
  type AiProvider,
  type CampaignManifest,
  type CampaignRunHandle,
  type CampaignRunResult,
  type CampaignRuntime,
  type InferenceCredentials,
  type SmokeTestOptions,
} from '@launchpilot/agents';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { EventWriter } from './event-writer';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';
import { ListEventsQueryDto, StartSmokeTestDto } from './dto/mozaik.dto';

const RESULT_TO_DB: Record<CampaignRunResult['status'], RunStatus> = {
  completed: RunStatus.COMPLETED,
  failed: RunStatus.FAILED,
  cancelled: RunStatus.CANCELLED,
  interrupted: RunStatus.INTERRUPTED,
};

interface ActiveEntry {
  handle: CampaignRunHandle;
  writer: EventWriter;
  /** Resolves after the terminal status has been written to PostgreSQL. */
  finalized: Promise<void>;
}

/** What the API returns for a run. No credentials, ever. */
export function toRunView(run: CampaignRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    mode: run.mode,
    label: run.mode === 'smoke_test' ? 'Infrastructure Smoke Test' : run.mode,
    status: run.status,
    currentPhase: run.currentPhase,
    provider: run.provider,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    errorMessage: run.errorMessage,
  };
}

/**
 * Orchestration adapter between the HTTP API, PostgreSQL and the Mozaik runtime (which lives in
 * @launchpilot/agents). It knows nothing about individual agents.
 *
 * Lifecycle: CampaignRun row (RUNNING) -> runtime.startRun -> events streamed to CampaignEvent
 * -> terminal status written once the runtime reports it.
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
      take: 20,
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

    let run: CampaignRun;
    try {
      // The partial unique index (one RUNNING run per project) makes this check atomic.
      run = await this.prisma.campaignRun.create({
        data: { projectId, userId, mode: 'smoke_test', provider: user.defaultAiProvider },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A run is already in progress for this project');
      }
      throw err;
    }

    const writer = new EventWriter(this.prisma, this.logger);
    let handle: CampaignRunHandle;
    try {
      handle = await this.runtime.startRun({
        runId: run.id,
        projectId,
        userId,
        mode: 'smoke_test',
        manifest: this.buildManifest(project, intake),
        // No `credentials`: the smoke test never calls a model, so a missing key must not block it.
        options: { delayMs: dto.delayMs, ...testHooks },
        onEvent: writer.push,
      });
    } catch (err) {
      await writer.flush();
      const failed = await this.prisma.campaignRun.update({
        where: { id: run.id },
        data: { status: RunStatus.FAILED, completedAt: new Date(), errorMessage: safeErrorMessage(err) },
      });
      this.logger.error(`Runtime failed to start for run ${run.id}: ${safeErrorMessage(err)}`);
      return toRunView(failed);
    }

    const finalized = handle.done.then((result) => this.finalize(result, writer)).catch((err) => {
      this.logger.error(`Failed to finalize run ${run.id}: ${safeErrorMessage(err)}`);
    }).finally(() => {
      this.active.delete(run.id);
    });
    this.active.set(run.id, { handle, writer, finalized });

    return toRunView(run);
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
   * Single entrance for resolving a user's BYOK credentials at run start. Not used by the smoke
   * test. Future inference-backed runs call this and pass the result to `runtime.startRun`, where
   * it lives only inside that run's isolated Mozaik inference runner (never in state, events, logs
   * or the database). The lookup is keyed by `userId`, so one user's key cannot reach another's run.
   */
  async prepareInference(userId: string): Promise<InferenceCredentials> {
    const resolved = await this.credentials.getDecryptedKey(userId);
    if (!resolved) {
      throw new UnprocessableEntityException(
        'Add an OpenAI or Gemini API key under Settings > AI providers to run AI workflows',
      );
    }
    return { provider: resolved.providerKey as AiProvider, apiKey: resolved.apiKey };
  }

  // ---- internals

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
    const run = await this.prisma.campaignRun.findFirst({ where: { id: runId, userId } });
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
