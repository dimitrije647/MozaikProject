import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { CrosscheckRecord, SourceRecord, Verdict } from '../../../discovery/f1/board';
import type { ReviewClaim } from '../../../discovery/f1/prompts';
import type { AgentOutcome } from '../../../factory/events';
import { RESEARCHER_KEYS, STRATEGY_COORDINATOR_NAME, STRATEGY_INFO, strategyRoleByName, type ScoutDecision, type StrategyFinding, type StrategyPlan } from '../../../strategy/board';
import { scoutName, type ChannelId } from '../../../strategy/channels';
import { evaluateScouts } from '../../../strategy/scouts';
import { validateStrategyFinding } from '../../../strategy/policy';
import { LlmStrategyFinding } from '../../../strategy/schemas';
import { OnEventTypes, guarded } from '../../run-context';
import type { F3Env } from './env';

const PHASE = 'F3_MARKET_STRATEGY' as const;
const MAX_CLAIMS_PER_REQUEST = 3;
const SLACK_CALLS = 2; // reserved for the strategist and one repair

const IMPORTANCE = { high: 3, medium: 2, low: 1 } as const;
const CLASS_WEIGHT: Record<string, number> = { claimed: 1.5, inferred: 1.2, disputed: 1, verified: 0.8, unknown: 0 };
const REVIEWABLE = new Set(['observation', 'claim_on_source', 'assessment', 'hypothesis']);

/**
 * The Strategy Coordinator: a deterministic Mozaik participant (no model calls) that drives F3.
 *
 *  1. fan-out: Audience Researcher, Competitor Researcher and Seasonal Intelligence start together;
 *  2. barrier 1, then DYNAMIC REGISTRATION: it evaluates which Channel Scouts the project needs (transparent rules),
 *     creates only those participants, joins them to the live Mozaik runtime (`participant.registered`) and announces
 *     the others as not selected (`participant.idle`) with the reason;
 *  3. barrier 2 (the scouts), then bounded cross-checks between DIFFERENT participants;
 *  4. barrier 3, `phase.ready` for the Campaign Strategist.
 * It is the single writer of the F3 board and never calls a model.
 */
export class StrategyCoordinator {
  readonly participant: Participant;
  private readonly researchers: string[];
  private readonly reported = new Set<string>();
  private scouts: string[] = [];
  private readonly pending = new Map<string, { producer: string; reviewer: string }>();
  private barrier1: NodeJS.Timeout | undefined;
  private barrierScouts: NodeJS.Timeout | undefined;
  private barrier2: NodeJS.Timeout | undefined;
  private concluded1 = false;
  private concludedScouts = false;
  private concluded2 = false;
  private counters = { requested: 0, answered: 0, failed: 0 };
  private requestSeq = 0;
  private recordSeq = 0;

  constructor(
    private readonly env: F3Env,
    private readonly plan: StrategyPlan,
    private readonly preSources: SourceRecord[],
  ) {
    this.researchers = plan.activated.filter((a) => (RESEARCHER_KEYS as readonly string[]).includes(a.key)).map((a) => a.agent);
    const guard = env.ctx.guard(STRATEGY_COORDINATOR_NAME);
    this.participant = createAgent({
      name: STRATEGY_COORDINATOR_NAME,
      capabilities: ['coordination', 'fan-out', 'fan-in', 'dynamic-registration', 'board-writer'],
      instruction: 'Deterministic strategy coordinator. Performs no inference.',
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

  // ---- phase start: fan-out ------------------------------------------------------------------------

  private begin() {
    const { env, plan } = this;
    const { ctx, board } = env;
    board.plan = { activated: [...plan.activated], skipped: [...plan.skipped] };
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: STRATEGY_COORDINATOR_NAME, source: s }, this.participant);
    for (const s of plan.skipped) {
      board.setStatus(s.agent, { state: 'skipped', reason: s.reason });
      ctx.emit('participant.idle', { agent: s.agent, reason: s.reason, skipped: true }, this.participant);
    }
    board.setStatus(STRATEGY_INFO.strategist.name, { state: 'waiting', reason: 'Waits for phase.ready' });
    for (const a of plan.activated) if (this.researchers.includes(a.agent)) board.setStatus(a.agent, { state: 'working', reason: a.reason });

    this.barrier1 = ctx.setTimer(env.settings.agentTimeoutMs + 5_000, () => this.conclude1());
    for (const a of plan.activated) if (this.researchers.includes(a.agent)) ctx.emit('task.assigned', { agent: a.agent, task: a.key }, this.participant);
    if (!this.researchers.length) this.conclude1();
  }

  // ---- board commits (single writer) ------------------------------------------------------------------

  private commitFindings(p: { agent: string; summary: string; findings: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board } = env;
    const role = strategyRoleByName(p.agent);
    if (!role || role.key === 'strategist') return;
    let count = 0;
    for (const raw of p.findings) {
      const parsed = LlmStrategyFinding.safeParse(raw);
      if (!parsed.success) continue;
      const v = validateStrategyFinding(parsed.data, p.agent, role, env.policyContext());
      board.findings.push({ ...v, id: board.nextFindingId(p.agent), crosscheck: { status: 'not_requested', reviewers: [] }, at: new Date().toISOString() });
      count++;
    }
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.missingInformation.push({ agent: p.agent, text: m });
    board.setStatus(p.agent, { findings: count });
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    const role = strategyRoleByName(p.agent);
    if (!role) return;
    if (role.key === 'strategist') {
      board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done' } : { state: 'failed', error: p.error ?? null });
      return;
    }
    if (this.reported.has(p.agent)) return;
    this.reported.add(p.agent);
    if (p.outcome === 'succeeded') board.setStatus(p.agent, { state: 'done', error: null });
    else if (p.outcome === 'skipped') board.setStatus(p.agent, { state: 'skipped', reason: p.reason ?? 'Nothing to research' });
    else board.setStatus(p.agent, { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });

    if (role.key === 'scout') {
      if (this.scouts.every((n) => this.reported.has(n))) this.concludeScouts();
    } else if (this.researchers.every((n) => this.reported.has(n))) this.conclude1();
  }

  // ---- barrier 1 -> dynamic scout registration ---------------------------------------------------------

  private conclude1() {
    if (this.concluded1) return;
    this.concluded1 = true;
    const { env } = this;
    const { ctx, board } = env;
    if (this.barrier1) ctx.clearTimer(this.barrier1);
    for (const name of this.researchers) if (!this.reported.has(name)) board.setStatus(name, { state: 'timed_out', error: toSafeError('timeout') });
    const states = board.participantStatuses.filter((s) => this.researchers.includes(s.agent));
    // A deterministic "insufficient research" gap is a valid result, but it is not enough to build a strategy on: at least one
    // researcher must have produced real (non-gap) findings, otherwise no scout is created and nothing more is spent.
    const substantive = (agent: string) => board.findingsBy(agent).some((f) => f.kind !== 'gap');
    if (!states.some((s) => s.state === 'done' && substantive(s.agent))) {
      const errors: AgentOutcome[] = states.filter((s) => s.state === 'failed' || s.state === 'timed_out').map((s) => ({ agent: s.agent, error: s.error ?? undefined }));
      ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors: errors.length ? errors : [{ agent: STRATEGY_COORDINATOR_NAME, error: { code: 'source_unavailable', message: 'No researcher produced usable findings.' } }] }, this.participant);
      return;
    }
    this.registerScouts();
  }

  private registerScouts() {
    const { env } = this;
    const { ctx, board, settings } = env;
    const used = env.gateway.usage().callsStarted;
    // Every scout costs one model call; keep room for the strategist, one repair and at least one review.
    const affordable = Math.max(0, settings.maxModelCalls - used - SLACK_CALLS - 1);
    const cap = Math.min(settings.maxScouts, affordable);
    const decisions = evaluateScouts({ f1: env.f1, f2: env.f2, input: env.input, audience: board.findings.filter((f) => f.area === 'audience') }, cap);
    for (const d of decisions) {
      if (!d.selected && cap < settings.maxScouts && d.score >= 4 && !d.reason.includes('model-call budget')) d.reason += ` (the model-call budget leaves room for ${cap} scout(s))`;
    }
    board.scoutDecisions = decisions;

    const selected: ScoutDecision[] = [];
    for (const d of decisions) {
      if (d.selected) {
        const agent = env.createScout(d); // a NEW participant: its own memory, its own id
        ctx.join(agent.participant); // dynamic registration in the live Mozaik runtime
        this.scouts.push(d.name);
        selected.push(d);
        board.plan!.activated.push({ agent: d.name, key: `scout:${d.channel}`, reason: d.reason, dynamic: true });
        board.setStatus(d.name, { state: 'working', reason: d.reason });
        ctx.emit('participant.registered', { agent: d.name, role: 'Channel Scout', channel: d.channel, reason: d.reason, score: d.score, ruleHits: d.ruleHits }, this.participant);
      } else {
        board.plan!.skipped.push({ agent: d.name, key: `scout:${d.channel}`, reason: d.reason });
        board.setStatus(d.name, { state: 'skipped', reason: d.reason });
        ctx.emit('participant.idle', { agent: d.name, reason: d.reason, skipped: true, channel: d.channel, score: d.score, ruleHits: d.ruleHits }, this.participant);
      }
    }
    if (!selected.length) return this.concludeScouts();
    this.barrierScouts = ctx.setTimer(settings.agentTimeoutMs + 5_000, () => this.concludeScouts());
    for (const d of selected) ctx.emit('task.assigned', { agent: d.name, task: `scout:${d.channel}` }, this.participant);
  }

  // ---- barrier 2 (scouts) -> cross-checks --------------------------------------------------------------

  private concludeScouts() {
    if (this.concludedScouts) return;
    this.concludedScouts = true;
    const { env } = this;
    const { ctx, board } = env;
    if (this.barrierScouts) ctx.clearTimer(this.barrierScouts);
    for (const name of this.scouts) if (!this.reported.has(name)) board.setStatus(name, { state: 'timed_out', error: toSafeError('timeout') });
    this.planCrosschecks();
  }

  private usable(name: string) {
    return board(this.env).participantStatuses.some((s) => s.agent === name && s.state === 'done' && s.findings > 0);
  }
  /** A reviewer answers from its own earlier analysis, so it must have made a model call itself. */
  private canReview(name: string) {
    return (this.env.gateway.usage().perAgent[name]?.calls ?? 0) > 0 && this.usable(name);
  }

  private planCrosschecks() {
    const { env } = this;
    const { ctx, board: b, settings } = env;
    const used = env.gateway.usage().callsStarted;
    let budget = Math.min(settings.maxReviews, Math.max(0, settings.maxModelCalls - used - SLACK_CALLS));
    const audience = STRATEGY_INFO.audience.name;
    const competitor = STRATEGY_INFO.competitor.name;
    const seasonal = STRATEGY_INFO.seasonal.name;
    // scouts in order of their eligibility score (best fit first)
    const scouts = b.scoutDecisions.filter((d) => d.selected).map((d) => d.name).filter((n) => this.scouts.includes(n));
    const goodScouts = scouts.filter((n) => this.canReview(n));
    const hasB2B = b.findings.some((f) => f.segment?.kind === 'b2b');
    const linkedin = scoutName('linkedin' as ChannelId);

    const wanted: { producer: string; reviewer: string }[] = [];
    const add = (producer: string | undefined, reviewer: string | undefined) => {
      if (!producer || !reviewer || producer === reviewer) return;
      if (!this.usable(producer) || !this.canReview(reviewer)) return;
      if (wanted.some((w) => w.producer === producer && w.reviewer === reviewer)) return;
      wanted.push({ producer, reviewer });
    };
    // Audience vs. channel: does the channel recommendation actually fit the segments? (a B2B segment goes to LinkedIn's scout)
    const audienceReviewer = hasB2B && goodScouts.includes(linkedin) ? linkedin : goodScouts[0];
    add(audience, audienceReviewer);
    // Seasonal vs. channel: do the formats and lead times of a channel fit the proposed window?
    add(seasonal, goodScouts.find((n) => n !== audienceReviewer) ?? goodScouts[0]);
    // Cross-channel disagreement: the best-fit scout is reviewed by the next one (and vice versa)
    add(scouts[0], goodScouts.find((n) => n !== scouts[0]));
    // Competitor vs. audience: does the competitor positioning match what the segments need?
    add(competitor, audience);
    add(scouts[1], goodScouts.find((n) => n !== scouts[1]));
    // Every remaining scout is checked by the Audience Researcher against its own segments
    for (const s of scouts) add(s, audience);

    const asked = new Set<string>();
    for (const w of wanted) {
      if (budget <= 0) break;
      const claims = this.selectClaims(w.producer, asked);
      if (!claims.length) continue;
      for (const c of claims) asked.add(c.id);
      this.request(w.producer, w.reviewer, claims);
      budget--;
    }
    // Deeper pass (depth only): what the first round left unchecked is reviewed by a DIFFERENT agent than the first time, up to maxReviews.
    if (settings.depth) {
      const producers = [audience, competitor, seasonal, ...scouts].filter((p, i, a) => a.indexOf(p) === i && this.usable(p));
      const reviewers = [audience, ...goodScouts, competitor, seasonal].filter((r, i, a) => a.indexOf(r) === i && this.canReview(r));
      for (const p of producers) {
        if (budget <= 0) break;
        const claims = this.selectClaims(p, asked);
        if (claims.length < 2) continue;
        const reviewer = reviewers.find((r) => r !== p && !wanted.some((w) => w.producer === p && w.reviewer === r));
        if (!reviewer) continue;
        for (const c of claims) asked.add(c.id);
        this.request(p, reviewer, claims);
        budget--;
      }
    }
    if (this.pending.size === 0) return this.conclude2();
    this.barrier2 = ctx.setTimer(settings.reviewTimeoutMs + 5_000, () => this.expirePending());
  }

  private selectClaims(agent: string, exclude: Set<string> = new Set()): StrategyFinding[] {
    return this.env.board
      .findingsBy(agent)
      .filter((f) => REVIEWABLE.has(f.kind) && f.classification !== 'unknown' && !exclude.has(f.id))
      .sort((a, b) => IMPORTANCE[b.importance] * (CLASS_WEIGHT[b.classification] ?? 0) - IMPORTANCE[a.importance] * (CLASS_WEIGHT[a.classification] ?? 0))
      .slice(0, MAX_CLAIMS_PER_REQUEST);
  }

  private request(producer: string, reviewer: string, claims: StrategyFinding[]) {
    const { ctx, board, store } = this.env;
    const requestId = `R${++this.requestSeq}`;
    const now = new Date().toISOString();
    const detail = (f: StrategyFinding) =>
      f.segment
        ? ` [segment ${f.segment.name}: ${f.segment.kind}, fit ${f.segment.productFit}]`
        : f.channelEval
          ? ` [channel ${f.channelEval.channel}: fit ${f.channelEval.fit}, role ${f.channelEval.role}]`
          : f.opportunity
            ? ` [opportunity ${f.opportunity.name}: ${f.opportunity.window}, ${f.opportunity.dateBasis}]`
            : f.competitor
              ? ` [competitor ${f.competitor.name}${f.competitor.crowdedTheme ? `, crowded theme ${f.competitor.crowdedTheme}` : ''}]`
              : '';
    const payloadClaims: ReviewClaim[] = claims.map((f) => ({
      claimId: f.id,
      agent: producer,
      statement: `${f.title}: ${f.statement}${detail(f)}`,
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

  // ---- barrier 3 -> phase.ready ----------------------------------------------------------------------------

  private commitAnswer(p: { requestId: string; status: 'answered' | 'failed'; answers: { claimId: string; verdict: Verdict; rationale: string; correction: string | null }[]; error?: SafeProviderError }) {
    const { board } = this.env;
    if (!this.pending.has(p.requestId)) return;
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
  private applyVerdict(f: StrategyFinding, reviewer: string, verdict: Verdict) {
    const rank: Record<StrategyFinding['crosscheck']['status'], number> = { not_requested: 0, pending: 0, agreed: 1, insufficient: 2, corrected: 3, disputed: 4 };
    const next: StrategyFinding['crosscheck']['status'] = verdict === 'agree' ? 'agreed' : verdict === 'disagree' ? 'disputed' : verdict === 'correct' ? 'corrected' : 'insufficient';
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
    const strategist = STRATEGY_INFO.strategist.name;
    const st = board.participantStatuses.filter((s) => s.agent !== strategist);
    ctx.emit(
      'phase.ready',
      {
        phase: PHASE,
        succeeded: st.filter((s) => s.state === 'done').map((s) => s.agent),
        failed: st.filter((s) => s.state === 'failed' || s.state === 'timed_out').map((s) => ({ agent: s.agent, error: s.error ?? undefined })),
        skipped: st.filter((s) => s.state === 'skipped').map((s) => s.agent),
        crosschecks: this.counters,
      },
      this.participant,
    );
  }
}

const board = (env: F3Env) => env.board;
