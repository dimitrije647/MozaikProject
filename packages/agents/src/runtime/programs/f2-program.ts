import type { InferenceRunnerConfig, Participant, SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../ai/errors';
import { DEFAULT_BUDGET, InferenceGateway, type InferenceBudget, type UsageSnapshot } from '../../ai/gateway';
import { OpenAIClient } from '../../ai/openai-http';
import { AUDIT_INFO, AUDIT_KEYS, AuditBoardStore, type AuditFinding, type AuditKey, type AuditPlan, type AuditorKey } from '../../audit/board';
import type { AuditFacts, F1Context } from '../../audit/context';
import { finalizeAuditReport, type AuditPolicyIssue } from '../../audit/policy';
import { AUDIT_INSTRUCTIONS, auditSynthesizerMessage, type AuditSynthDigest } from '../../audit/prompts';
import { AUDIT_REPORT_VERSION, AuditAgentOutput, AuditReportDraft, MarketingAuditReport } from '../../audit/schemas';
import { SourceStore, type CrosscheckRecord, type ParticipantStatus, type SourceRecord } from '../../discovery/f1/board';
import { reviewMessage } from '../../discovery/f1/prompts';
import { CrosscheckAnswer } from '../../discovery/f1/schemas';
import type { AgentOutcome } from '../../factory/events';
import { DocumentExtractionTool, type DocumentInput } from '../../tools/documents';
import { ImagePreparationTool, type ImageInput } from '../../tools/images';
import { PageSpeedTool } from '../../tools/pagespeed';
import { YouTubeTool } from '../../tools/social';
import { WebFetchTool } from '../../tools/web-fetch';
import { ParticipantRegistry } from '../participant-registry';
import type { InferenceCredentials } from '../providers';
import { OnEventTypes, guarded, type RunContext, type RunProgram } from '../run-context';
import { PhaseAgent } from './f1/agent';
import { AuditCoordinator } from './f2/coordinator';
import type { AuditInput, F2Env, F2Settings, F2Tools } from './f2/env';
import { PREPARE } from './f2/roles';
import { clamp } from './smoke-program';

const PHASE = 'F2_MARKETING_AUDIT' as const;

export interface AuditRunConfig {
  /** The completed F1 report this audit builds on (built by the backend from the stored report). */
  f1: F1Context;
  input: AuditInput;
  /** Explicit model id chosen by the user. Never defaulted or switched automatically. */
  model: string;
  documents?: DocumentInput[];
  images?: ImageInput[];
  /** Hard cap on provider calls for the whole run. Default 14. */
  maxModelCalls?: number;
  /** `max_output_tokens` for auditors. Reviews use less, the synthesizer up to twice as much. Default 2500. */
  maxOutputTokens?: number;
  /** Maximum cross-check requests (each costs one model call). Default 4. */
  maxReviews?: number;
  /** Pages analyzed in detail (home included). Default 5. */
  maxPages?: number;
  /** Extra internal links only status-checked. Default 8. */
  maxLinkChecks?: number;
  agentTimeoutMs?: number;
  reviewTimeoutMs?: number;
  callTimeoutMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Test seam: base URL of the OpenAI API (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  tools?: Partial<F2Tools>;
  /** TESTS ONLY: marks every source from external tools as a fixture (never real-world evidence). */
  fixtureSources?: boolean;
}

export interface AuditReportMeta {
  schemaVersion: number;
  model: string;
  provider: 'openai';
  generatedAt: string;
  partial: boolean;
  usage: UsageSnapshot;
  budget: { maxModelCalls: number; auditorTokens: number; reviewTokens: number; synthTokens: number };
  /** The exact F1 report this audit used. */
  f1: { reportId: string; schemaVersion: number; generatedAt: string | null; model: string | null; partial: boolean };
  plan: AuditPlan;
  participants: ParticipantStatus[];
  sources: SourceRecord[];
  findings: AuditFinding[];
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  policyIssues: AuditPolicyIssue[];
  aiCalls: Record<string, number>;
  /** Everything that limits the audit (same list as the report's "limitations"). */
  notAnalyzed: { label: string; reason: string }[];
  tools: { pagespeed: { configured: boolean; calls: number }; youtube: { configured: boolean; calls: number }; fixtureSources: boolean };
  inputSnapshot: AuditInput;
}

export type AuditSink = (report: MarketingAuditReport, meta: AuditReportMeta) => Promise<void>;

/** Which auditors run, which are skipped and why. Pure and deterministic. */
export function planF2(input: AuditInput, f1: F1Context, files: { images: ImageInput[]; checkUrl: (u: string) => { ok: true } | { ok: false; message: string } }): { plan: AuditPlan; pre: Pick<SourceRecord, 'kind' | 'label' | 'status'>[] & { url?: string | null; error?: string | null }[] } {
  const plan: AuditPlan = { activated: [], skipped: [] };
  const pre: { kind: SourceRecord['kind']; label: string; status: SourceRecord['status']; url?: string | null; error?: string | null; text?: string }[] = [
    { kind: 'f1_report', label: `F1 Product Discovery report ${f1.reportId}`, status: 'retrieved', text: `f1_report_id: ${f1.reportId}\nproduct: ${f1.report.productManifest.name}\nconfidence: ${f1.report.productManifest.overallConfidence}\npartial: ${f1.partial}` },
  ];
  const on = (key: AuditKey, reason: string) => plan.activated.push({ agent: AUDIT_INFO[key].name, key, reason });
  const off = (key: AuditKey, reason: string) => plan.skipped.push({ agent: AUDIT_INFO[key].name, key, reason });

  let siteOk = false;
  if (!input.websiteUrl) off('seo', 'No website URL is set for this project');
  else {
    const c = files.checkUrl(input.websiteUrl);
    if (c.ok) {
      siteOk = true;
      on('seo', `Website provided: ${input.websiteUrl}`);
    } else {
      off('seo', `The website URL was rejected: ${c.message}`);
      pre.push({ kind: 'website', label: input.websiteUrl, url: input.websiteUrl, status: 'failed', error: c.message });
    }
  }

  if (input.socialProfiles.length || input.socialDetails.length) on('social', `${input.socialProfiles.length} social profile URL(s) supplied`);
  else off('social', 'No social profile was supplied');

  const hasBrandMaterial = siteOk || files.images.length > 0 || f1.findings.some((f) => f.agent === 'Visual Analyzer') || !!f1.report.productManifest.brand || (input.styleNotes?.trim().length ?? 0) >= 20;
  if (hasBrandMaterial) on('brand', 'Brand material available (website, images, F1 visual analysis or a style description)');
  else off('brand', 'No website, images, F1 visual analysis or brand description to audit');

  on('messaging', 'Always runs: audits the product communication');
  on('presence', 'Always runs: checks cross-channel completeness and consistency');
  on('synthesizer', 'Always runs after the cross-checks');
  return { plan, pre: pre as never };
}

/**
 * F2 Marketing Audit with up to six REAL Mozaik agents, a deterministic Audit Coordinator and the Factory
 * Orchestrator, running in the same runtime, with the same event protocol and evidence rules as F1.
 */
export class F2Program implements RunProgram {
  readonly defaultTimeoutMs: number;
  private readonly gateway: InferenceGateway;
  private readonly settings: F2Settings;
  private readonly tools: F2Tools;
  private readonly store = new SourceStore();
  private readonly planned: ReturnType<typeof planF2>;
  private env!: F2Env;

  constructor(
    credentials: InferenceCredentials,
    private readonly config: AuditRunConfig,
    private readonly sink: AuditSink,
  ) {
    const auditorTokens = clamp(config.maxOutputTokens, 800, 6000, 2500);
    const synthTokens = Math.min(8000, auditorTokens * 2);
    const budget: InferenceBudget = {
      maxModelCalls: clamp(config.maxModelCalls, 1, 30, 14),
      maxOutputTokens: synthTokens,
      callTimeoutMs: clamp(config.callTimeoutMs, 50, 300_000, DEFAULT_BUDGET.callTimeoutMs),
      maxRetries: clamp(config.maxRetries, 0, 3, DEFAULT_BUDGET.maxRetries),
      retryBaseDelayMs: clamp(config.retryBaseDelayMs, 1, 30_000, DEFAULT_BUDGET.retryBaseDelayMs),
    };
    this.gateway = new InferenceGateway(new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: config.baseUrl }), budget);
    const agentTimeoutMs = clamp(config.agentTimeoutMs, 50, 600_000, 150_000);
    this.settings = {
      model: config.model,
      auditorTokens,
      reviewTokens: Math.min(1500, auditorTokens),
      synthTokens,
      maxModelCalls: budget.maxModelCalls,
      maxReviews: clamp(config.maxReviews, 0, 8, 4),
      agentTimeoutMs,
      reviewTimeoutMs: clamp(config.reviewTimeoutMs, 50, 600_000, 90_000),
      collectTimeoutMs: Math.max(30, Math.floor(agentTimeoutMs * 0.7)),
      maxPages: clamp(config.maxPages, 1, 8, 5),
      maxLinkChecks: clamp(config.maxLinkChecks, 0, 20, 8),
      fixtureSources: config.fixtureSources === true,
    };
    this.tools = {
      web: config.tools?.web ?? new WebFetchTool({ maxPages: this.settings.maxPages + this.settings.maxLinkChecks + 4 }),
      pagespeed: config.tools?.pagespeed ?? new PageSpeedTool({ apiKey: process.env.PAGESPEED_API_KEY }),
      youtube: config.tools?.youtube ?? new YouTubeTool({ apiKey: process.env.YOUTUBE_API_KEY }),
      documents: config.tools?.documents ?? new DocumentExtractionTool(),
      images: config.tools?.images ?? new ImagePreparationTool(),
    };
    this.defaultTimeoutMs = clamp(config.timeoutMs, 200, 1_800_000, 600_000);
    this.planned = planF2(config.input, config.f1, { images: config.images ?? [], checkUrl: (u) => this.tools.web.checkUrl(u) });
  }

  inferenceConfig(): InferenceRunnerConfig {
    return { runner: this.gateway };
  }

  dispose() {
    this.gateway.abort();
  }

  kickoff(ctx: RunContext) {
    ctx.emit('factory.started', { mode: 'marketing_audit', label: 'F2 Marketing Audit' }, ctx.orchestrator);
  }

  orchestratorHandlers(ctx: RunContext): SituationHandler[] {
    const who = 'Factory Orchestrator';
    const { plan } = this.planned;
    return [
      {
        specification: new OnEventTypes(['factory.started']),
        processor: guarded(ctx.guard(who), () => {
          ctx.state.currentPhase = PHASE;
          ctx.emit('phase.started', { phase: PHASE, agents: plan.activated.map((a) => a.agent), plan }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['audit.completed']),
        processor: guarded(ctx.guard(who), async ({ event }) => {
          const { report, meta } = event.payload as { report: MarketingAuditReport; meta: AuditReportMeta };
          // Persist BEFORE completing: a run is only COMPLETED if its report is saved.
          await this.sink(report, meta);
          if (ctx.isClosed()) return;
          ctx.emit('phase.completed', { phase: PHASE }, ctx.orchestrator);
          ctx.emit('factory.completed', { mode: 'marketing_audit', phasesCompleted: [PHASE] }, ctx.orchestrator);
        }),
      },
      {
        specification: new OnEventTypes(['phase.failed']),
        processor: guarded(ctx.guard(who), ({ event }) => {
          const { errors } = event.payload as { errors: AgentOutcome[] };
          const first = errors[0];
          ctx.emit('factory.failed', { reason: 'participant_error', message: first?.error?.message ?? 'Marketing Audit failed', participant: first?.agent, code: first?.error?.code }, ctx.orchestrator);
        }),
      },
    ];
  }

  participants(ctx: RunContext): Participant[] {
    const board = ctx.state.f2;
    this.env = {
      ctx,
      gateway: this.gateway,
      store: this.store,
      board,
      f1: this.config.f1,
      input: this.config.input,
      settings: this.settings,
      tools: this.tools,
      documents: this.config.documents ?? [],
      images: this.config.images ?? [],
      facts: { site: null, siteError: null, pagespeed: null, social: [], presence: null },
      policyIssues: [],
      agents: new Map(),
      pageSources: new Map(),
      siteSourceIds: [],
    };
    const env = this.env;
    const { plan, pre } = this.planned;

    const preRecords = (pre as unknown as { kind: SourceRecord['kind']; label: string; status: SourceRecord['status']; url?: string | null; error?: string | null; text?: string }[]).map((p) =>
      this.store.add({ kind: p.kind, label: p.label, url: p.url ?? null, status: p.status, live: false, fixture: false, httpStatus: null, bytes: null, error: p.error ?? null, producer: 'Audit Coordinator', origin: p.kind === 'f1_report' ? 'previous_phase' : 'user_provided' }, p.text),
    );

    const registry = new ParticipantRegistry();
    for (const key of AUDIT_KEYS) {
      registry.register({
        phase: PHASE,
        name: AUDIT_INFO[key].name,
        create: () => {
          const agent = key === 'synthesizer' ? this.buildSynthesizer(env) : this.buildAuditor(env, key);
          env.agents.set(key, agent);
          return agent.participant;
        },
      });
    }
    const activated = new Set(plan.activated.map((a) => a.agent));
    const joined = registry.forPhase(PHASE).filter((r) => activated.has(r.name)).map((r) => r.create({ runId: ctx.runId, phase: PHASE, state: ctx.state }));
    const coordinator = new AuditCoordinator(env, plan, preRecords);
    return [coordinator.participant, ...joined];
  }

  private agent(env: F2Env, key: AuditKey, handlers: ConstructorParameters<typeof PhaseAgent>[2]) {
    return new PhaseAgent(env, { key, name: AUDIT_INFO[key].name, instruction: AUDIT_INSTRUCTIONS[key], capabilities: ['marketing-audit', key === 'synthesizer' ? 'synthesis' : 'audit', 'inference'] }, handlers);
  }

  // ---- auditors (A8 to A12) ------------------------------------------------------------------------

  private buildAuditor(env: F2Env, key: AuditorKey): PhaseAgent {
    const { ctx, settings } = env;
    const name = AUDIT_INFO[key].name;
    return this.agent(env, key, (self) => [
      {
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          const opened = self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
          if (!opened) return;

          const prep = await PREPARE[key](env, self);
          if (!self.isTaskOpen() || ctx.isClosed()) return;
          if (prep.kind === 'skip') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'skipped', reason: prep.reason }, self.participant);
          }
          if (prep.kind === 'fail') {
            self.closeTask();
            return ctx.emit('task.completed', { agent: name, outcome: 'failed', error: prep.error }, self.participant);
          }
          if (prep.kind === 'direct') {
            // Nothing to analyze with a model: the deterministic result is posted as this agent's findings.
            self.closeTask();
            ctx.emit('finding.posted', { agent: name, summary: prep.output.summary, findings: prep.output.findings, missingInformation: prep.output.missingInformation }, self.participant);
            return ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
          }
          self.runJob({
            kind: 'analysis',
            message: prep.message,
            images: prep.images,
            schema: AuditAgentOutput,
            schemaName: `${key}_audit`,
            maxOutputTokens: settings.auditorTokens,
            onSuccess: (out) => {
              self.closeTask();
              ctx.emit('finding.posted', { agent: name, summary: out.summary, findings: out.findings, missingInformation: out.missingInformation }, self.participant);
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
            },
            onFailure: (error) => {
              self.closeTask();
              ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
            },
          });
        }),
      },
      {
        // Cross-check: this auditor reviews ANOTHER auditor's claims using what it examined itself.
        specification: new OnEventTypes(['crosscheck.requested']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { requestId: string; producer: string; reviewer: string; claims: never[] };
          if (p.reviewer !== name) return;
          self.runJob({
            kind: 'review',
            message: reviewMessage(p.requestId, p.producer, p.claims, env.input.language),
            schema: CrosscheckAnswer,
            schemaName: 'crosscheck_answer',
            maxOutputTokens: settings.reviewTokens,
            timeoutMs: settings.reviewTimeoutMs,
            onSuccess: (out) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'answered', answers: out.answers }, self.participant),
            onFailure: (error) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'failed', answers: [], error }, self.participant),
          });
        }),
      },
    ]);
  }

  // ---- synthesizer (A13) ---------------------------------------------------------------------------

  private buildSynthesizer(env: F2Env): PhaseAgent {
    const { ctx, settings } = env;
    const name = AUDIT_INFO.synthesizer.name;
    return this.agent(env, 'synthesizer', (self) => [
      {
        specification: new OnEventTypes(['phase.ready']),
        processor: guarded(ctx.guard(name), () => {
          const snap = env.board.snapshot();
          const failed = snap.participantStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out');
          const partial = failed.length > 0;
          const digest: AuditSynthDigest = {
            f1: env.f1,
            language: env.input.language,
            plan: { activated: snap.plan?.activated ?? [], skipped: snap.plan?.skipped ?? [] },
            statuses: snap.participantStatuses.map((s) => ({ agent: s.agent, state: s.state, reason: s.error?.message ?? s.reason })),
            sources: snap.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, origin: s.origin ?? 'unknown', live: s.live, fixture: s.fixture, error: s.error })),
            findings: snap.findings,
            summaries: snap.summaries,
            crosschecks: snap.crosschecks.map((c) => ({ claimId: c.claimId, producer: c.producer, reviewer: c.reviewer, verdict: c.verdict, rationale: c.rationale, correction: c.correction, status: c.status })),
            missing: [...new Set(snap.missingInformation.map((m) => m.text))].slice(0, 20),
            measured: this.measured(env.facts),
            partial,
          };
          self.openTask(settings.agentTimeoutMs, () => {
            ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant);
            ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: name, error: toSafeError('timeout') }] }, self.participant);
          });
          self.runJob({
            kind: 'synthesis',
            message: auditSynthesizerMessage(digest),
            schema: AuditReportDraft,
            schemaName: 'marketing_audit_report',
            maxOutputTokens: settings.synthTokens,
            onSuccess: (draft) => {
              self.closeTask();
              const final = env.board.snapshot();
              const psConfigured = env.tools.pagespeed.configured;
              const { report, issues } = finalizeAuditReport(draft, final, {
                f1: env.f1,
                facts: env.facts,
                partial,
                websiteUrl: env.input.websiteUrl,
                fixtureSources: settings.fixtureSources,
                pageSpeedNote: !env.input.websiteUrl ? 'There is no website to test.' : psConfigured ? 'PageSpeed Insights was not run.' : 'PAGESPEED_API_KEY is not configured, so PageSpeed Insights was not called. Performance metrics are unavailable.',
              });
              const usage = env.gateway.usage();
              const meta: AuditReportMeta = {
                schemaVersion: AUDIT_REPORT_VERSION,
                model: settings.model,
                provider: 'openai',
                generatedAt: new Date().toISOString(),
                partial,
                usage,
                budget: { maxModelCalls: settings.maxModelCalls, auditorTokens: settings.auditorTokens, reviewTokens: settings.reviewTokens, synthTokens: settings.synthTokens },
                f1: { reportId: env.f1.reportId, schemaVersion: env.f1.schemaVersion, generatedAt: env.f1.generatedAt, model: env.f1.model, partial: env.f1.partial },
                plan: final.plan ?? { activated: [], skipped: [] },
                participants: final.participantStatuses.map((s) => (s.agent === name ? { ...s, state: 'done' as const, error: null } : s)),
                sources: final.sources,
                findings: final.findings,
                crosschecks: final.crosschecks,
                summaries: final.summaries,
                policyIssues: [...env.policyIssues, ...issues],
                aiCalls: Object.fromEntries(Object.entries(usage.perAgent).map(([k, v]) => [k, v.calls])),
                notAnalyzed: report.limitations.map((l) => ({ label: 'Limitation', reason: l })),
                tools: { pagespeed: { configured: psConfigured, calls: env.tools.pagespeed.callCount }, youtube: { configured: env.tools.youtube.configured, calls: env.tools.youtube.callCount }, fixtureSources: settings.fixtureSources },
                inputSnapshot: env.input,
              };
              ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
              ctx.emit('audit.completed', { report, meta }, self.participant);
            },
            onFailure: (error) => {
              self.closeTask();
              ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
              ctx.emit('phase.failed', { phase: PHASE, reason: 'synthesis_failed', errors: [{ agent: name, error }] }, self.participant);
            },
          });
        }),
      },
    ]);
  }

  /** Measured facts for the synthesizer (numbers only where a tool measured them). */
  private measured(f: AuditFacts) {
    const site = f.site;
    return {
      website: site
        ? {
            reachable: site.home.ok,
            pagesAnalyzed: site.pages.length,
            robots: site.robots.status + (site.robots.blocksAll ? ' (blocks all crawlers)' : ''),
            sitemap: site.sitemap.status + (site.sitemap.urlCount !== null ? ` (${site.sitemap.urlCount} entries)` : ''),
            brokenInternalLinks: site.home.ok ? site.broken.length : null,
          }
        : 'not collected',
      pageSpeed: f.pagespeed ? (f.pagespeed.ok ? f.pagespeed.scores : `unavailable: ${f.pagespeed.message}`) : 'not collected',
      social: f.social.filter((s) => s.access !== 'not_supplied').map((s) => ({ platform: s.platform, access: s.access, metrics: s.metrics })),
      presenceIssues: f.presence?.issues ?? [],
    };
  }
}

export { MarketingAuditReport };
