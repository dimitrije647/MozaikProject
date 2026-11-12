import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { STRATEGY_COORDINATOR_NAME, STRATEGY_INFO, type StrategyPlan } from '../../../strategy/board';
import { validateStrategyFinding } from '../../../strategy/policy';
import { LlmStrategyFinding } from '../../../strategy/schemas';
import { OnEventTypes, guarded } from '../../run-context';
import type { F3Env } from './env';

const PHASE = 'F3_MARKET_STRATEGY' as const;

/**
 * The Strategy Coordinator: a deterministic Mozaik participant (no model calls) that drives F3 with ONE agent.
 *
 *  1. `task.assigned` to the Marketing Strategist (research: deterministic gathering plus one model call);
 *  2. it commits the research findings (`finding.posted`) through the evidence policy: it is the single writer of the board;
 *  3. when the research task completes (or its deadline passes) it emits `phase.ready`, and the same Marketing Strategist
 *     writes the strategy from the committed findings.
 * There are no cross-checks (one producer has no independent reviewer) and no dynamic participants.
 */
export class StrategyCoordinator {
  readonly participant: Participant;
  private readonly strategist = STRATEGY_INFO.strategist.name;
  private researchReported = false;
  private barrier: NodeJS.Timeout | undefined;
  private concluded = false;

  constructor(
    private readonly env: F3Env,
    private readonly plan: StrategyPlan,
    private readonly preSources: SourceRecord[],
  ) {
    const guard = env.ctx.guard(STRATEGY_COORDINATOR_NAME);
    this.participant = createAgent({
      name: STRATEGY_COORDINATOR_NAME,
      capabilities: ['coordination', 'board-writer'],
      instruction: 'Deterministic strategy coordinator. Performs no inference.',
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
    board.plan = { activated: [...plan.activated], skipped: [...plan.skipped] };
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: STRATEGY_COORDINATOR_NAME, source: s }, this.participant);
    board.setStatus(this.strategist, { state: 'working', reason: plan.activated[0]?.reason ?? 'Research, then strategy' });
    this.barrier = ctx.setTimer(env.settings.agentTimeoutMs + 5_000, () => this.conclude());
    ctx.emit('task.assigned', { agent: this.strategist, task: 'research' }, this.participant);
  }

  private commitFindings(p: { agent: string; summary: string; findings: unknown[]; missingInformation: string[] }) {
    const { board } = this.env;
    if (p.agent !== this.strategist || this.concluded) return;
    let count = 0;
    for (const raw of p.findings) {
      const parsed = LlmStrategyFinding.safeParse(raw);
      if (!parsed.success) continue;
      const v = validateStrategyFinding(parsed.data, p.agent, this.env.policyContext());
      board.findings.push({ ...v, id: board.nextFindingId(p.agent), crosscheck: { status: 'not_requested', reviewers: [] }, at: new Date().toISOString() });
      count++;
    }
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.missingInformation.push({ agent: p.agent, text: m });
    board.setStatus(p.agent, { findings: count });
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    if (p.agent !== this.strategist) return;
    if (this.researchReported) {
      // the second completion is the strategy itself
      board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done', error: null } : { state: 'failed', error: p.error ?? null });
      return;
    }
    this.researchReported = true;
    if (p.outcome !== 'succeeded') board.setStatus(p.agent, { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });
    this.conclude();
  }

  /** Research done (or its deadline passed): the strategy is written only on real (non-gap) findings, otherwise nothing more is spent. */
  private conclude() {
    if (this.concluded) return;
    this.concluded = true;
    const { ctx, board } = this.env;
    if (this.barrier) ctx.clearTimer(this.barrier);
    if (!this.researchReported) board.setStatus(this.strategist, { state: 'timed_out', error: toSafeError('timeout') });
    const status = board.participantStatuses.find((s) => s.agent === this.strategist);
    const substantive = board.findings.some((f) => f.kind !== 'gap');
    if (!substantive || status?.state === 'failed' || status?.state === 'timed_out') {
      const error = status?.error ?? { code: 'source_unavailable' as const, message: 'The research produced no usable findings.' };
      ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors: [{ agent: this.strategist, error }] }, this.participant);
      return;
    }
    board.setStatus(this.strategist, { state: 'working', reason: 'Writes the strategy from the committed findings' });
    ctx.emit('phase.ready', { phase: PHASE, succeeded: [this.strategist], failed: [], skipped: [], crosschecks: { requested: 0, answered: 0, failed: 0 } }, this.participant);
  }
}
