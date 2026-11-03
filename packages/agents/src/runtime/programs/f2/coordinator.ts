import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import { AUDITOR_KEYS, AUDIT_COORDINATOR_NAME, AUDIT_INFO, auditKeyByName, type AuditFinding, type AuditKey, type AuditPlan, type AuditorKey, type Severity } from '../../../audit/board';
import { validateAuditFinding } from '../../../audit/policy';
import { LlmAuditFinding } from '../../../audit/schemas';
import type { CrosscheckRecord, SourceRecord, Verdict } from '../../../discovery/f1/board';
import type { ReviewClaim } from '../../../discovery/f1/prompts';
import type { AgentOutcome } from '../../../factory/events';
import { OnEventTypes, guarded } from '../../run-context';
import type { F2Env } from './env';

const PHASE = 'F2_MARKETING_AUDIT' as const;

/**
 * Who reviews whom, in order of preference (a reviewer must be activated and have produced findings).
 * Designed so that the natural pairs examine the same evidence from different angles:
 *   SEO <-> Messaging (page description / headline), Messaging -> Brand (wording vs identity),
 *   Social -> Presence (profile description vs cross-channel identity), Brand -> Messaging, Presence -> Social.
 */
export const AUDIT_REVIEWERS: Record<AuditorKey, AuditorKey[]> = {
  seo: ['messaging', 'presence'],
  messaging: ['brand', 'seo', 'presence'],
  brand: ['messaging', 'presence'],
  social: ['presence', 'brand'],
  presence: ['social', 'seo', 'messaging'],
};
const PRODUCER_ORDER: AuditorKey[] = ['seo', 'messaging', 'social', 'brand', 'presence'];
const MAX_CLAIMS_PER_REQUEST = 3;
const SLACK_CALLS = 2; // reserved for the synthesizer and one repair

const SEV_WEIGHT: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const CLASS_WEIGHT: Record<string, number> = { claimed: 1.5, inferred: 1.2, disputed: 1, verified: 0.8, unknown: 0 };
const REVIEWABLE = new Set(['observation', 'claim_on_source', 'assessment']);

/**
 * The Audit Coordinator: a deterministic Mozaik participant (no model calls) that drives F2.
 * Same protocol as the F1 Phase Coordinator: fan-out, SINGLE WRITER of the shared audit board, bounded
 * fan-in barriers, cross-check planning and `phase.ready` for the Audit Synthesizer.
 */
export class AuditCoordinator {
  readonly participant: Participant;
  private readonly auditors: AuditorKey[];
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
    private readonly env: F2Env,
    private readonly plan: AuditPlan,
    private readonly preSources: SourceRecord[],
  ) {
    this.auditors = plan.activated.map((a) => a.key).filter((k): k is AuditorKey => k !== 'synthesizer');
    const guard = env.ctx.guard(AUDIT_COORDINATOR_NAME);
    this.participant = createAgent({
      name: AUDIT_COORDINATOR_NAME,
      capabilities: ['coordination', 'fan-out', 'fan-in', 'board-writer'],
      instruction: 'Deterministic audit coordinator. Performs no inference.',
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

  private begin() {
    const { env, plan } = this;
    const { ctx, board } = env;
    board.plan = plan;
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: AUDIT_COORDINATOR_NAME, source: s }, this.participant);
    for (const s of plan.skipped) {
      board.setStatus(s.agent, { state: 'skipped', reason: s.reason });
      ctx.emit('participant.idle', { agent: s.agent, reason: s.reason, skipped: true }, this.participant);
    }
    board.setStatus(AUDIT_INFO.synthesizer.name, { state: 'waiting', reason: 'Waits for phase.ready' });
    for (const a of plan.activated) if (a.key !== 'synthesizer') board.setStatus(a.agent, { state: 'working', reason: a.reason });

    // The auditors wait on the shared collection (crawl) inside their own deadline; this barrier is the outer bound.
    this.barrier1 = ctx.setTimer(env.settings.agentTimeoutMs + 5_000, () => this.conclude1());
    for (const a of plan.activated) if (a.key !== 'synthesizer') ctx.emit('task.assigned', { agent: a.agent, task: a.key }, this.participant);
    if (!this.auditors.length) this.conclude1();
  }

  // ---- board commits (single writer) -----------------------------------------------------------------

  private commitFindings(p: { agent: string; summary: string; findings: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board, store } = env;
    const key = auditKeyByName(p.agent);
    if (!key) return;
    let count = 0;
    for (const raw of p.findings) {
      const parsed = LlmAuditFinding.safeParse(raw);
      if (!parsed.success) continue;
      const v = validateAuditFinding(parsed.data, p.agent, key, { store, f1: env.f1, issues: env.policyIssues });
      const finding: AuditFinding = { ...v, id: board.nextFindingId(p.agent), crosscheck: { status: 'not_requested', reviewers: [] }, at: new Date().toISOString() };
      board.findings.push(finding);
      count++;
    }
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.missingInformation.push({ agent: p.agent, text: m });
    board.setStatus(p.agent, { findings: count });
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    if (p.agent === AUDIT_INFO.synthesizer.name) {
      board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done' } : { state: 'failed', error: p.error ?? null });
      return;
    }
    const key = auditKeyByName(p.agent);
    if (!key || key === 'synthesizer' || this.reported.has(p.agent)) return;
    this.reported.add(p.agent);
    if (p.outcome === 'succeeded') board.setStatus(p.agent, { state: 'done', error: null });
    else if (p.outcome === 'skipped') board.setStatus(p.agent, { state: 'skipped', reason: p.reason ?? 'Nothing to audit' });
    else board.setStatus(p.agent, { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });
    if (this.auditors.every((k) => this.reported.has(AUDIT_INFO[k].name))) this.conclude1();
  }

  // ---- barrier 1 -> cross-checks ---------------------------------------------------------------------

  private conclude1() {
    if (this.concluded1) return;
    this.concluded1 = true;
    const { env } = this;
    const { ctx, board } = env;
    if (this.barrier1) ctx.clearTimer(this.barrier1);
    for (const k of this.auditors) {
      const name = AUDIT_INFO[k].name;
      if (!this.reported.has(name)) board.setStatus(name, { state: 'timed_out', error: toSafeError('timeout') });
    }
    const states = board.participantStatuses.filter((s) => this.auditors.some((k) => AUDIT_INFO[k].name === s.agent));
    // A skipped auditor (nothing to audit) is not a failure; but at least one must have produced findings.
    const usable = states.filter((s) => s.state === 'done' && s.findings > 0);
    if (!usable.length) {
      const errors: AgentOutcome[] = states.filter((s) => s.state === 'failed' || s.state === 'timed_out').map((s) => ({ agent: s.agent, error: s.error ?? undefined }));
      ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors: errors.length ? errors : [{ agent: AUDIT_COORDINATOR_NAME, error: { code: 'source_unavailable', message: 'No auditor produced usable findings.' } }] }, this.participant);
      return;
    }
    this.planCrosschecks(usable.map((s) => s.agent));
  }

  private planCrosschecks(usable: string[]) {
    const { env } = this;
    const { ctx, settings } = env;
    const used = env.gateway.usage().callsStarted;
    let budget = Math.min(settings.maxReviews, Math.max(0, settings.maxModelCalls - used - SLACK_CALLS));
    const usableKeys = new Set(usable.map((n) => auditKeyByName(n)!));
    // Reviewers that only produced deterministic findings (no model memory of the topic) can still review from their own evidence.
    // Pass 1 (always): one review per producer. Deeper passes (depth only): claims nobody checked yet go to ANOTHER auditor, up to maxReviews.
    const asked = new Set<string>();
    for (let pass = 0; pass < (settings.depth ? 3 : 1) && budget > 0; pass++) {
      for (const producer of PRODUCER_ORDER) {
        if (budget <= 0) break;
        if (!usableKeys.has(producer)) continue;
        const options = AUDIT_REVIEWERS[producer].filter((r) => usableKeys.has(r) && r !== producer && this.canReview(r));
        const reviewer = options[pass % Math.max(1, options.length)];
        if (!reviewer) continue;
        const claims = this.selectClaims(AUDIT_INFO[producer].name, asked);
        if (!claims.length || (pass > 0 && claims.length < 2)) continue;
        for (const c of claims) asked.add(c.id);
        this.request(AUDIT_INFO[producer].name, AUDIT_INFO[reviewer].name, claims);
        budget--;
      }
    }
    if (this.pending.size === 0) return this.conclude2();
    this.barrier2 = ctx.setTimer(settings.reviewTimeoutMs + 5_000, () => this.expirePending());
  }

  /** An auditor that finished without any model call has no analysis in memory to review from. */
  private canReview(key: AuditKey) {
    const calls = this.env.gateway.usage().perAgent[AUDIT_INFO[key].name]?.calls ?? 0;
    return calls > 0;
  }

  private selectClaims(agent: string, exclude: Set<string> = new Set()): AuditFinding[] {
    return this.env.board
      .findingsBy(agent)
      .filter((f) => REVIEWABLE.has(f.kind) && f.classification !== 'unknown' && !exclude.has(f.id))
      .sort((a, b) => SEV_WEIGHT[b.severity] * (CLASS_WEIGHT[b.classification] ?? 0) - SEV_WEIGHT[a.severity] * (CLASS_WEIGHT[a.classification] ?? 0))
      .slice(0, MAX_CLAIMS_PER_REQUEST);
  }

  private request(producer: string, reviewer: string, claims: AuditFinding[]) {
    const { ctx, board, store } = this.env;
    const requestId = `R${++this.requestSeq}`;
    const now = new Date().toISOString();
    const payloadClaims: ReviewClaim[] = claims.map((f) => ({
      claimId: f.id,
      agent: producer,
      statement: `${f.title}: ${f.statement}`,
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

  // ---- barrier 2 -> phase.ready ----------------------------------------------------------------------

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
  private applyVerdict(f: AuditFinding, reviewer: string, verdict: Verdict) {
    const rank: Record<AuditFinding['crosscheck']['status'], number> = { not_requested: 0, pending: 0, agreed: 1, insufficient: 2, corrected: 3, disputed: 4 };
    const next: AuditFinding['crosscheck']['status'] = verdict === 'agree' ? 'agreed' : verdict === 'disagree' ? 'disputed' : verdict === 'correct' ? 'corrected' : 'insufficient';
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
    const st = board.participantStatuses.filter((s) => AUDITOR_KEYS.some((k) => AUDIT_INFO[k].name === s.agent));
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
