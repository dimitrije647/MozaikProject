import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import { AGENT_INFO, COORDINATOR_NAME, type F1Plan, type Finding, type SourceRecord } from '../../../discovery/f1/board';
import { validateFinding } from '../../../discovery/f1/policy';
import { LlmFinding } from '../../../discovery/f1/schemas';
import { OnEventTypes, guarded } from '../../run-context';
import type { F1Env } from './env';

const PHASE = 'F1_PRODUCT_DISCOVERY' as const;
const RESEARCHER = AGENT_INFO.researcher.name;

/**
 * The Phase Coordinator: a deterministic Mozaik participant (no model calls) that drives F1.
 *  - assigns the research task to the Business Researcher;
 *  - SINGLE WRITER of the shared board: it commits sources and findings that arrive as events (after the evidence policy);
 *  - one bounded barrier: when the analysis is in (or its deadline passed) it emits `phase.ready`, and the Business Researcher
 *    writes the report from the board. There is only one producer, so there are no cross-checks (V4: the analyst-to-analyst
 *    reviews of the earlier seven-agent team were removed).
 */
export class PhaseCoordinator {
  readonly participant: Participant;
  private barrier: NodeJS.Timeout | undefined;
  private analysisReported = false;
  private concluded = false;

  constructor(
    private readonly env: F1Env,
    private readonly plan: F1Plan,
    private readonly preSources: SourceRecord[],
  ) {
    const guard = env.ctx.guard(COORDINATOR_NAME);
    this.participant = createAgent({
      name: COORDINATOR_NAME,
      capabilities: ['coordination', 'fan-in', 'board-writer'],
      instruction: 'Deterministic phase coordinator. Performs no inference.',
      tools: [],
      handlers: [
        { specification: new OnEventTypes(['phase.started']), processor: guarded(guard, () => this.begin()) },
        { specification: new OnEventTypes(['source.retrieved']), processor: guarded(guard, ({ event }) => this.env.board.addSource((event.payload as { source: SourceRecord }).source)) },
        { specification: new OnEventTypes(['finding.posted']), processor: guarded(guard, ({ event }) => this.commitFindings(event.payload as never)) },
        { specification: new OnEventTypes(['task.completed']), processor: guarded(guard, ({ event }) => this.onTaskCompleted(event.payload as never)) },
      ],
    });
  }

  private begin() {
    const { env, plan } = this;
    const { ctx, board } = env;
    board.plan = plan;
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: COORDINATOR_NAME, source: s }, this.participant);
    board.setStatus(RESEARCHER, { state: 'working', reason: plan.activated[0]?.reason ?? 'Business research' });
    this.barrier = ctx.setTimer(env.settings.agentTimeoutMs + 5_000, () => this.conclude());
    ctx.emit('task.assigned', { agent: RESEARCHER, task: 'researcher' }, this.participant);
  }

  // ---- board commits (single writer) -------------------------------------------------------------

  private commitFindings(p: { agent: string; summary: string; findings: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board, store, input } = env;
    if (p.agent !== RESEARCHER) return;
    let count = 0;
    for (const raw of p.findings) {
      const parsed = LlmFinding.safeParse(raw);
      if (!parsed.success) continue; // already validated by the agent; defensive
      const v = validateFinding(parsed.data, p.agent, { input, store, issues: env.policyIssues });
      const finding: Finding = { ...v, id: board.nextFindingId(p.agent), crosscheck: { status: 'not_requested', reviewers: [] }, at: new Date().toISOString() };
      board.addFinding(finding);
      count++;
    }
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.missingInformation.push({ agent: p.agent, text: m });
    board.setStatus(p.agent, { findings: count });
  }

  /** The first task.completed of the Business Researcher is its analysis; the second (after phase.ready) is the synthesis. */
  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    if (p.agent !== RESEARCHER) return;
    if (this.analysisReported) {
      board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done', error: null } : { state: 'failed', error: p.error ?? null });
      return;
    }
    this.analysisReported = true;
    if (p.outcome === 'succeeded') board.setStatus(p.agent, { state: 'working', error: null, reason: 'Writing the Product Discovery report' });
    else board.setStatus(p.agent, { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });
    this.conclude();
  }

  private conclude() {
    if (this.concluded) return;
    this.concluded = true;
    const { ctx, board } = this.env;
    if (this.barrier) ctx.clearTimer(this.barrier);
    if (!this.analysisReported) board.setStatus(RESEARCHER, { state: 'timed_out', error: toSafeError('timeout') });
    const status = board.participantStatuses.find((s) => s.agent === RESEARCHER);
    if (!status || status.state !== 'working' || status.findings === 0) {
      const error: SafeProviderError = status?.error ?? { code: 'source_unavailable', message: 'The Business Researcher produced no usable findings.' };
      ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors: [{ agent: RESEARCHER, error }] }, this.participant);
      return;
    }
    ctx.emit('phase.ready', { phase: PHASE, succeeded: [RESEARCHER], failed: [], skipped: [], crosschecks: { requested: 0, answered: 0, failed: 0 } }, this.participant);
  }
}
