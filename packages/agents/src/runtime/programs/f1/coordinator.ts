import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import {
  AGENT_INFO,
  ANALYST_KEYS,
  COORDINATOR_NAME,
  keyByName,
  type AnalystKey,
  type CrosscheckRecord,
  type CrosscheckStatus,
  type F1Plan,
  type Finding,
  type SourceRecord,
  type Verdict,
} from '../../../discovery/f1/board';
import { validateFinding } from '../../../discovery/f1/policy';
import type { ReviewClaim } from '../../../discovery/f1/prompts';
import { LlmFinding } from '../../../discovery/f1/schemas';
import type { AgentOutcome } from '../../../factory/events';
import { OnEventTypes, guarded } from '../../run-context';
import type { F1Env } from './env';

const PHASE = 'F1_PRODUCT_DISCOVERY' as const;

/** Who reviews whom, in order of preference. A reviewer must be activated and must have succeeded. */
export const REVIEWERS: Record<AnalystKey, AnalystKey[]> = {
  input: ['text', 'web', 'files'],
  text: ['input', 'web'],
  web: ['input', 'text'],
  repo: ['text', 'input'],
  files: ['input', 'text'],
  visual: ['web', 'text', 'input'],
};
const PRODUCER_ORDER: AnalystKey[] = ['input', 'text', 'web', 'repo', 'files', 'visual'];
const MAX_CLAIMS_PER_REQUEST = 4;
const SLACK_CALLS = 2; // reserved for the synthesizer and one repair

const IMPORTANCE = { high: 3, medium: 2, low: 1 } as const;
const CLASS_WEIGHT: Record<string, number> = { claimed: 1.5, inferred: 1, disputed: 1, verified: 0.2, unknown: 0 };

/**
 * The Phase Coordinator: a deterministic Mozaik participant (no model calls) that drives F1.
 *  - fan-out: assigns tasks to the activated analysts, announces skipped ones;
 *  - SINGLE WRITER of the shared board: it commits sources, findings and cross-check answers that
 *    arrive as events (after the evidence policy has been applied);
 *  - bounded fan-in barriers: it waits until every activated analyst has reported success, failure or
 *    a deadline passes, then selects claims for cross-checking and waits (again bounded) for answers;
 *  - emits `phase.ready` for the Synthesizer.
 */
export class PhaseCoordinator {
  readonly participant: Participant;
  private readonly analysts: AnalystKey[];
  private readonly reported = new Set<string>();
  private readonly pending = new Map<string, { producer: string; reviewer: string }>();
  private barrier1: NodeJS.Timeout | undefined;
  private barrier2: NodeJS.Timeout | undefined;
  private concluded1 = false;
  private concluded2 = false;
  private counters = { requested: 0, answered: 0, failed: 0 };
  private requestSeq = 0;
  private recordSeq = 0;

  constructor(
    private readonly env: F1Env,
    private readonly plan: F1Plan,
    private readonly preSources: SourceRecord[],
  ) {
    this.analysts = plan.activated.map((a) => a.key).filter((k): k is AnalystKey => k !== 'synthesizer');
    const who = COORDINATOR_NAME;
    const guard = env.ctx.guard(who);
    this.participant = createAgent({
      name: who,
      capabilities: ['coordination', 'fan-out', 'fan-in', 'board-writer'],
      instruction: 'Deterministic phase coordinator. Performs no inference.',
      tools: [],
      handlers: [
        { specification: new OnEventTypes(['phase.started']), processor: guarded(guard, () => this.begin()) },
        { specification: new OnEventTypes(['source.retrieved']), processor: guarded(guard, ({ event }) => this.env.board.addSource((event.payload as { source: SourceRecord }).source)) },
        { specification: new OnEventTypes(['finding.posted']), processor: guarded(guard, ({ event }) => this.commitFindings(event.payload as never)) },
        { specification: new OnEventTypes(['task.completed']), processor: guarded(guard, ({ event }) => this.onTaskCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['crosscheck.answered']), processor: guarded(guard, ({ event }) => this.commitAnswer(event.payload as never)) },
      ],
    });
  }

  // ---- phase start: fan-out -------------------------------------------------------------------

  private begin() {
    const { env, plan } = this;
    const { ctx, board } = env;
    board.plan = plan;
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: COORDINATOR_NAME, source: s }, this.participant);

    for (const s of plan.skipped) {
      board.setStatus(s.agent, { state: 'skipped', reason: s.reason });
      ctx.emit('participant.idle', { agent: s.agent, reason: s.reason, skipped: true }, this.participant);
    }
    board.setStatus(AGENT_INFO.synthesizer.name, { state: 'waiting', reason: 'Waits for phase.ready' });
    for (const a of plan.activated) if (a.key !== 'synthesizer') board.setStatus(a.agent, { state: 'working', reason: a.reason });

    this.barrier1 = ctx.setTimer(env.settings.agentTimeoutMs + 5_000, () => this.conclude1());
    for (const a of plan.activated) {
      if (a.key !== 'synthesizer') ctx.emit('task.assigned', { agent: a.agent, task: a.key }, this.participant);
    }
    // Defensive: with no activated analyst there is nothing to wait for.
    if (!this.analysts.length) this.conclude1();
  }

  // ---- board commits (single writer) -------------------------------------------------------------

  private commitFindings(p: { agent: string; summary: string; findings: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board, store, input } = env;
    const key = keyByName(p.agent);
    if (!key) return;
    let count = 0;
    for (const raw of p.findings) {
      const parsed = LlmFinding.safeParse(raw);
      if (!parsed.success) continue; // already validated by the agent; defensive
      const v = validateFinding(parsed.data, p.agent, key, { input, store, issues: env.policyIssues });
      const finding: Finding = { ...v, id: board.nextFindingId(p.agent), crosscheck: { status: 'not_requested', reviewers: [] }, at: new Date().toISOString() };
      board.addFinding(finding);
      count++;
    }
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.missingInformation.push({ agent: p.agent, text: m });
    board.setStatus(p.agent, { findings: count });
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    if (p.agent === AGENT_INFO.synthesizer.name) {
      board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done' } : { state: 'failed', error: p.error ?? null });
      return;
    }
    const key = keyByName(p.agent);
    if (!key || key === 'synthesizer' || this.reported.has(p.agent)) return;
    this.reported.add(p.agent);
    if (p.outcome === 'succeeded') board.setStatus(p.agent, { state: 'done', error: null });
    else if (p.outcome === 'skipped') board.setStatus(p.agent, { state: 'skipped', reason: p.reason ?? 'Nothing to analyze' });
    else board.setStatus(p.agent, { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });
    if (this.analysts.every((k) => this.reported.has(AGENT_INFO[k].name))) this.conclude1();
  }

  // ---- barrier 1: all analysts reported (or deadline) -> plan cross-checks ----------------------------

  private conclude1() {
    if (this.concluded1) return;
    this.concluded1 = true;
    const { env } = this;
    const { ctx, board } = env;
    if (this.barrier1) ctx.clearTimer(this.barrier1);
    for (const k of this.analysts) {
      const name = AGENT_INFO[k].name;
      if (!this.reported.has(name)) board.setStatus(name, { state: 'timed_out', error: toSafeError('timeout') });
    }
    const states = board.participantStatuses.filter((s) => this.analysts.some((k) => AGENT_INFO[k].name === s.agent));
    const usable = states.filter((s) => s.state === 'done' && s.findings > 0);
    if (!usable.length) {
      const errors: AgentOutcome[] = states.filter((s) => s.state === 'failed' || s.state === 'timed_out').map((s) => ({ agent: s.agent, error: s.error ?? undefined }));
      ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors: errors.length ? errors : [{ agent: COORDINATOR_NAME, error: { code: 'source_unavailable', message: 'No agent produced usable findings.' } }] }, this.participant);
      return;
    }
    this.planCrosschecks(usable.map((s) => s.agent));
  }

  private planCrosschecks(usable: string[]) {
    const { env } = this;
    const { ctx, board, settings } = env;
    const used = env.gateway.usage().callsStarted;
    let budget = Math.min(settings.maxReviews, Math.max(0, settings.maxModelCalls - used - SLACK_CALLS));
    const usableKeys = new Set(usable.map((n) => keyByName(n)!));

    // Pass 1 (always): one review per producer. Deeper passes (depth only): claims nobody checked yet go to ANOTHER reviewer, up to
    // maxReviews. Without depth the number of requests is bounded by the number of producers whatever maxReviews says.
    const asked = new Set<string>();
    for (let pass = 0; pass < (settings.depth ? 3 : 1) && budget > 0; pass++) {
      for (const producer of PRODUCER_ORDER) {
        if (budget <= 0) break;
        if (!usableKeys.has(producer)) continue;
        const options = REVIEWERS[producer].filter((r) => usableKeys.has(r) && r !== producer);
        const reviewer = options[pass % Math.max(1, options.length)];
        if (!reviewer) continue;
        const claims = this.selectClaims(AGENT_INFO[producer].name, asked, pass > 0);
        if (!claims.length || (pass > 0 && claims.length < 2)) continue;
        for (const c of claims) asked.add(c.id);
        this.request(AGENT_INFO[producer].name, AGENT_INFO[reviewer].name, claims);
        budget--;
      }
    }
    if (this.pending.size === 0) return this.conclude2();
    this.barrier2 = ctx.setTimer(settings.reviewTimeoutMs + 5_000, () => this.expirePending());
  }

  private selectClaims(agent: string, exclude: Set<string> = new Set(), deeper = false): Finding[] {
    return this.env.board
      .findingsBy(agent)
      .filter((f) => f.category !== 'missing_info' && f.classification !== 'unknown' && !exclude.has(f.id) && (!deeper || f.importance !== 'low'))
      .sort((a, b) => IMPORTANCE[b.importance] * (CLASS_WEIGHT[b.classification] ?? 0) - IMPORTANCE[a.importance] * (CLASS_WEIGHT[a.classification] ?? 0))
      .slice(0, MAX_CLAIMS_PER_REQUEST);
  }

  private request(producer: string, reviewer: string, claims: Finding[]) {
    const { ctx, board, store } = this.env;
    const requestId = `R${++this.requestSeq}`;
    const now = new Date().toISOString();
    const payloadClaims: ReviewClaim[] = claims.map((f) => ({
      claimId: f.id,
      agent: producer,
      statement: f.statement,
      classification: f.classification,
      locator: f.locator,
      excerpt: f.excerpt,
      sourceLabel: f.sourceId ? (store.get(f.sourceId)?.label ?? null) : null,
    }));
    for (const f of claims) {
      f.crosscheck.status = 'pending';
      board.crosschecks.push({ id: `X${++this.recordSeq}`, requestId, claimId: f.id, producer, reviewer, verdict: null, rationale: null, correction: null, status: 'pending', error: null, requestedAt: now, answeredAt: null });
    }
    this.pending.set(requestId, { producer, reviewer });
    this.counters.requested++;
    ctx.emit('crosscheck.requested', { requestId, producer, reviewer, claims: payloadClaims }, this.participant);
  }

  // ---- barrier 2: all answers in (or deadline) -> phase.ready ----------------------------------------

  private commitAnswer(p: { requestId: string; status: 'answered' | 'failed'; answers: { claimId: string; verdict: Verdict; rationale: string; correction: string | null }[]; error?: SafeProviderError }) {
    const { board } = this.env;
    const open = this.pending.get(p.requestId);
    if (!open) return; // unknown or already closed
    this.pending.delete(p.requestId);
    const now = new Date().toISOString();
    let anyAnswered = false;
    for (const rec of board.crosschecks.filter((r) => r.requestId === p.requestId)) {
      const finding = board.findings.find((f) => f.id === rec.claimId);
      const ans = p.status === 'answered' ? p.answers.find((a) => a.claimId === rec.claimId) : undefined;
      if (!ans) {
        rec.status = p.error?.code === 'timeout' ? 'timed_out' : 'failed';
        rec.error = p.error?.message ?? 'The reviewer gave no answer for this claim.';
        rec.answeredAt = now;
        if (finding && finding.crosscheck.status === 'pending') finding.crosscheck.status = 'not_requested';
        continue;
      }
      anyAnswered = true;
      Object.assign(rec, { verdict: ans.verdict, rationale: ans.rationale.slice(0, 500), correction: ans.verdict === 'correct' ? ans.correction : null, status: 'answered', answeredAt: now } satisfies Partial<CrosscheckRecord>);
      if (finding) this.applyVerdict(finding, rec.reviewer, ans.verdict);
    }
    if (anyAnswered) this.counters.answered++;
    else this.counters.failed++;
    if (this.pending.size === 0) this.conclude2();
  }

  /** Strongest outcome wins: disputed > corrected > insufficient > agreed. */
  private applyVerdict(f: Finding, reviewer: string, verdict: Verdict) {
    const rank: Record<CrosscheckStatus, number> = { not_requested: 0, pending: 0, agreed: 1, insufficient: 2, corrected: 3, disputed: 4 };
    const next: CrosscheckStatus = verdict === 'agree' ? 'agreed' : verdict === 'disagree' ? 'disputed' : verdict === 'correct' ? 'corrected' : 'insufficient';
    f.crosscheck.reviewers.push(reviewer);
    if (rank[next] >= rank[f.crosscheck.status]) f.crosscheck.status = next;
    if (verdict === 'disagree' && f.classification !== 'disputed') {
      f.adjustment = `${f.adjustment ? f.adjustment + ' ' : ''}Disputed by ${reviewer}.`;
      f.classification = 'disputed';
    }
  }

  private expirePending() {
    if (this.concluded2) return;
    const { board } = this.env;
    const now = new Date().toISOString();
    for (const [id] of this.pending) {
      for (const rec of board.crosschecks.filter((r) => r.requestId === id && r.status === 'pending')) {
        rec.status = 'timed_out';
        rec.error = 'The reviewer did not answer in time.';
        rec.answeredAt = now;
        const f = board.findings.find((x) => x.id === rec.claimId);
        if (f && f.crosscheck.status === 'pending') f.crosscheck.status = 'insufficient';
      }
      this.counters.failed++;
    }
    this.pending.clear();
    this.conclude2();
  }

  private conclude2() {
    if (this.concluded2) return;
    this.concluded2 = true;
    const { ctx, board } = this.env;
    if (this.barrier2) ctx.clearTimer(this.barrier2);
    const st = board.participantStatuses;
    const analystStatuses = st.filter((s) => ANALYST_KEYS.some((k) => AGENT_INFO[k].name === s.agent));
    ctx.emit(
      'phase.ready',
      {
        phase: PHASE,
        succeeded: analystStatuses.filter((s) => s.state === 'done').map((s) => s.agent),
        failed: analystStatuses.filter((s) => s.state === 'failed' || s.state === 'timed_out').map((s) => ({ agent: s.agent, error: s.error ?? undefined })),
        skipped: analystStatuses.filter((s) => s.state === 'skipped').map((s) => s.agent),
        crosschecks: this.counters,
      },
      this.participant,
    );
  }
}
