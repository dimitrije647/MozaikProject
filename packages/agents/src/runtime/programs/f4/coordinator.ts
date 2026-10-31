import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { CrosscheckRecord, SourceRecord, Verdict } from '../../../discovery/f1/board';
import { normalizeText } from '../../../discovery/input';
import { wordTokens } from '../../../creative/checks';
import type { ReviewClaim } from '../../../discovery/f1/prompts';
import type { AgentOutcome } from '../../../factory/events';
import { CREATIVE_COORDINATOR_NAME, CREATIVE_INFO, creativeKeyByName, type CreativeKey, type CreativePlan } from '../../../creative/board';
import type { AssetRecord, ImageResultRecord, LandingContent, LayoutRecord, ReviewFindingRecord, RevisionRecord, SkippedLayout } from '../../../creative/schemas';
import { CopyOutput } from '../../../creative/schemas';
import { OnEventTypes, guarded } from '../../run-context';
import type { F4Env } from './env';

const PHASE = 'F4_CREATIVE_PRODUCTION' as const;
const SEV_ACTIONABLE = new Set(['blocker', 'major']);

const tokens = wordTokens;
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((t) => b.has(t)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};

/**
 * The Creative Coordinator: a deterministic Mozaik participant (no model calls) that drives F4. It is the single writer of the
 * F4 board and follows the protocol:
 *   copy.proposed -> (Visual Creator starts) ; landing.proposed ; visual.generated -> layout.completed (per concept)
 *   bounded fan-in barrier -> review.requested -> review.completed
 *   if blockers/majors remain and rounds are left: the Fixer is CREATED AND JOINED (participant.registered), fix.requested ->
 *   revision.requested (wave 1: copy/landing/image, wave 2: layouts) -> revision.applied -> revision.completed -> review.requested ...
 *   finally campaign.completed. Every loop is bounded by maxRepairRounds; unresolved issues are reported, never hidden.
 */
export class CreativeCoordinator {
  readonly participant: Participant;
  private readonly reported = new Set<string>();
  private copyCommitted = false;
  private landingResolved = false;
  private crossPlanned = false;
  private barrierDone = false;
  private finished = false;
  private fixerJoined = false;
  private readonly pending = new Map<string, { producer: string; reviewer: string }>();
  private barrier: NodeJS.Timeout | undefined;
  private reviewTimer: NodeJS.Timeout | undefined;
  private fixTimer: NodeJS.Timeout | undefined;
  private requestSeq = 0;
  private recordSeq = 0;
  private changed = { variantIds: new Set<string>(), assetIds: new Set<string>(), landing: false };
  private modelReviewFailed = false;
  private visualSeen = new Set<string>();

  constructor(
    private readonly env: F4Env,
    private readonly plan: CreativePlan,
    private readonly preSources: SourceRecord[],
  ) {
    const guard = env.ctx.guard(CREATIVE_COORDINATOR_NAME);
    this.participant = createAgent({
      name: CREATIVE_COORDINATOR_NAME,
      capabilities: ['coordination', 'fan-out', 'fan-in', 'dynamic-registration', 'board-writer'],
      instruction: 'Deterministic creative coordinator. Performs no inference.',
      tools: [],
      handlers: [
        { specification: new OnEventTypes(['phase.started']), processor: guarded(guard, () => this.begin()) },
        { specification: new OnEventTypes(['source.retrieved']), processor: guarded(guard, ({ event }) => this.env.board.addSource((event.payload as { source: SourceRecord }).source)) },
        { specification: new OnEventTypes(['copy.proposed']), processor: guarded(guard, ({ event }) => this.onCopy(event.payload as never)) },
        { specification: new OnEventTypes(['landing.proposed']), processor: guarded(guard, ({ event }) => this.onLanding(event.payload as never)) },
        { specification: new OnEventTypes(['visual.generated']), processor: guarded(guard, ({ event }) => this.onVisual(event.payload as never)) },
        { specification: new OnEventTypes(['layout.completed']), processor: guarded(guard, ({ event }) => this.onLayout(event.payload as never)) },
        { specification: new OnEventTypes(['task.completed']), processor: guarded(guard, ({ event }) => this.onTaskCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['crosscheck.requested']), processor: guarded(guard, ({ event }) => this.onForeignRequest(event.payload as never)) },
        { specification: new OnEventTypes(['crosscheck.answered']), processor: guarded(guard, ({ event }) => this.onAnswer(event.payload as never)) },
        { specification: new OnEventTypes(['review.completed']), processor: guarded(guard, ({ event }) => this.onReviewCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['revision.applied']), processor: guarded(guard, ({ event }) => this.onRevisionApplied(event.payload as never)) },
        { specification: new OnEventTypes(['revision.completed']), processor: guarded(guard, ({ event }) => this.onRevisionCompleted(event.payload as never)) },
      ],
    });
  }

  // ---- start: fan-out ------------------------------------------------------------------------------------------

  private begin() {
    const { env, plan } = this;
    const { ctx, board, settings } = env;
    board.plan = { activated: [...plan.activated], skipped: [...plan.skipped] };
    board.settings = {
      channels: env.input.channels,
      concepts: env.input.concepts,
      formats: settings.formats.map((f) => f.format.id),
      imageGeneration: settings.imageGeneration,
      imageModel: settings.imageModel,
      imageQuality: settings.imageGeneration ? settings.imageQuality : null,
      imageSize: settings.imageGeneration ? settings.imageSize : null,
      maxImages: env.tools.images ? env.tools.images.usage().limits.maxImages : 0,
      maxRegenerations: env.tools.images ? env.tools.images.usage().limits.maxRegenerations : 0,
      maxRepairRounds: settings.maxRepairRounds,
      maxModelCalls: settings.maxModelCalls,
    };
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: CREATIVE_COORDINATOR_NAME, source: s }, this.participant);
    for (const s of plan.skipped) {
      board.setStatus(s.agent, { state: 'skipped', reason: s.reason });
      ctx.emit('participant.idle', { agent: s.agent, reason: s.reason, skipped: true }, this.participant);
    }
    for (const a of plan.activated) board.setStatus(a.agent, { state: a.key === 'copywriter' || a.key === 'landing' ? 'working' : 'waiting', reason: a.reason });
    this.barrier = ctx.setTimer(settings.productionTimeoutMs, () => this.forceBarrier());
    if (!plan.activated.some((a) => a.key === 'landing')) this.landingResolved = true;
    for (const key of ['copywriter', 'landing', 'layout'] as CreativeKey[]) if (plan.activated.some((a) => a.key === key)) ctx.emit('task.assigned', { agent: CREATIVE_INFO[key].name, task: key }, this.participant);
  }

  // ---- production: copy, landing, visuals, layouts -----------------------------------------------------------------

  private onCopy(p: { agent: string; summary: string; concepts: unknown[]; variants: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board, input } = env;
    const parsed = CopyOutput.safeParse({ summary: p.summary, concepts: p.concepts, variants: p.variants, missingInformation: p.missingInformation });
    if (!parsed.success) return this.failPhase('The copy proposal was not valid.');
    const out = parsed.data;
    const keyToId = new Map<string, string>();
    for (const c of out.concepts.slice(0, input.concepts)) {
      const id = board.next('K');
      keyToId.set(c.key, id);
      board.concepts.push({ id, name: c.name, angle: c.angle, keyMessage: c.keyMessage, audience: c.audience, ctaType: c.ctaType, ctaText: c.ctaText, visualIdea: c.visualIdea });
    }
    const perPair = new Map<string, number>();
    const kept: { tok: Set<string> }[] = [];
    for (const v of out.variants) {
      const conceptId = keyToId.get(v.conceptKey);
      if (!conceptId || !input.channels.includes(v.channel)) continue; // unknown concept or a channel the user did not select
      const pair = `${conceptId}|${v.channel}`;
      if ((perPair.get(pair) ?? 0) >= 2 || board.variants.length >= 12) continue;
      const tok = tokens(`${v.headline} ${v.body}`);
      if (kept.some((k) => jaccard(k.tok, tok) > 0.8)) {
        board.note('Near-identical copy variants were dropped.');
        continue;
      }
      kept.push({ tok });
      perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
      board.variants.push({ id: board.next('V'), conceptId, channel: v.channel, placement: v.placement, length: v.length, headline: v.headline, body: v.body, description: v.description, ctaText: v.ctaText, ctaType: v.ctaType, hashtags: v.hashtags, claims: v.claims, version: 1, history: [] });
    }
    board.summaries[p.agent] = out.summary;
    for (const m of out.missingInformation) board.note(`Copywriter: ${m}`);
    board.setStatus(p.agent, { findings: board.variants.length });
    if (!board.concepts.length || !board.variants.length) return this.failPhase('The copywriter produced no usable concept or variant.');
    this.copyCommitted = true;
    // The Visual Creator starts NOW (it does not wait for the landing page or the cross-checks).
    board.setStatus(CREATIVE_INFO.visual.name, { state: 'working', reason: 'Copy proposed' });
    env.ctx.emit('task.assigned', { agent: CREATIVE_INFO.visual.name, task: 'visual' }, this.participant);
  }

  private onLanding(p: { agent: string; summary: string; content: LandingContent; missingInformation: string[] }) {
    const { board } = this.env;
    board.landing = p.content;
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.note(`Landing Content Builder: ${m}`);
    board.setStatus(p.agent, { findings: 1 });
    this.landingResolved = true;
  }

  private onVisual(p: { conceptId: string; asset: AssetRecord; failed: boolean; error?: SafeProviderError; directionSummary: string; result?: ImageResultRecord }) {
    const { board } = this.env;
    this.visualSeen.add(p.conceptId);
    board.assets.push(p.asset);
    if (!p.result) return;
    const i = board.imageResults.findIndex((r) => r.conceptId === p.conceptId);
    if (i >= 0) board.imageResults[i] = p.result;
    else board.imageResults.push(p.result);
    // every concept without an AI image says why (a fallback is never silent); a budget limit is stated once
    if (p.result.outcome === 'failed') board.note(`No AI image for "${p.result.conceptName}": ${p.result.explanation}`);
    else if (p.result.outcome === 'skipped' && p.result.stage === 'budget') board.note(p.result.explanation ?? '');
  }

  private onLayout(p: { conceptId: string; assets: AssetRecord[]; layouts: LayoutRecord[]; skipped: SkippedLayout[] }) {
    const { board } = this.env;
    for (const a of p.assets) board.assets.push(a);
    for (const l of p.layouts) board.layouts.push(l);
    for (const s of p.skipped) board.skippedLayouts.push(s);
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    const key = creativeKeyByName(p.agent);
    if (!key || this.finished) return;
    const state = p.outcome === 'succeeded' ? { state: 'done' as const, error: null } : p.outcome === 'skipped' ? { state: 'skipped' as const, reason: p.reason ?? 'Nothing to do' } : { state: p.error?.code === 'timeout' ? ('timed_out' as const) : ('failed' as const), error: p.error ?? null };
    board.setStatus(p.agent, state);
    if (key === 'reviewer' || key === 'fixer') {
      // These are handled per round: a failure here ends the loop honestly instead of hanging it.
      if (p.outcome !== 'succeeded') {
        board.note(`${p.agent} ${p.outcome === 'failed' ? 'failed' : p.outcome}: ${p.error?.message ?? ''}`.trim());
        if (key === 'reviewer') this.finish('The review could not be completed.');
        else this.afterRepairs();
      }
      return;
    }
    if (this.reported.has(p.agent)) return;
    this.reported.add(p.agent);
    if (p.outcome !== 'succeeded') {
      board.note(`${p.agent} ${p.outcome === 'failed' ? (p.error?.code === 'timeout' ? 'timed out' : 'failed') : 'was skipped'}${p.error ? `: ${p.error.message}` : ''}.`);
      if (key === 'copywriter') return this.failPhase(`The Copywriter ${p.error?.code === 'timeout' ? 'timed out' : 'failed'}: nothing can be built without copy.`, p.error);
      if (key === 'landing') this.landingResolved = true;
    }
    // The cross-checks start when BOTH producers have reported (a reviewer must be 'done' to answer from its own analysis).
    if (key === 'copywriter' || key === 'landing') this.maybeCrosscheck();
    this.maybeReady();
  }

  // ---- cross-checks between producers (concurrent with image generation) ---------------------------------------------

  private maybeCrosscheck() {
    const landingActive = this.plan.activated.some((a) => a.key === 'landing');
    if (this.crossPlanned || !this.copyCommitted || !this.landingResolved || !this.reported.has(CREATIVE_INFO.copywriter.name) || (landingActive && !this.reported.has(CREATIVE_INFO.landing.name))) return;
    this.crossPlanned = true;
    const { env } = this;
    const { board, settings } = env;
    const used = env.gateway.usage().callsStarted;
    let budget = Math.min(settings.maxCrossChecks, Math.max(0, settings.maxModelCalls - used - 6));
    const copy = CREATIVE_INFO.copywriter.name;
    const landing = CREATIVE_INFO.landing.name;
    if (board.landing && budget > 0 && this.canReview(copy)) {
      // The landing page must say what the ads say: the Copywriter checks the landing claims against its own approved messaging.
      const l = board.landing;
      const claims = [
        { id: 'LP1', text: `Hero: ${l.hero.headline}. ${l.hero.description}` },
        { id: 'LP2', text: `Value proposition: ${l.valueProposition}` },
        ...l.benefits.slice(0, 1).map((b, i) => ({ id: `LP${3 + i}`, text: `Benefit: ${b.title}. ${b.text}` })),
      ];
      this.request(landing, copy, claims.map((c) => ({ claimId: c.id, agent: landing, statement: c.text, classification: 'proposed', locator: 'landing', excerpt: null, sourceLabel: null })));
      budget--;
    }
    if (board.landing && budget > 0 && this.canReview(landing)) {
      // ... and the Landing Content Builder checks that the ads' promises are consistent with the page.
      const picks = board.variants.slice(0, 3);
      this.request(copy, landing, picks.map((v) => ({ claimId: v.id, agent: copy, statement: `${v.headline}. ${v.body} [CTA: ${v.ctaText}]`, classification: 'proposed', locator: v.channel, excerpt: null, sourceLabel: null })));
      budget--;
    }
    this.maybeReady();
  }

  private canReview(name: string) {
    return (this.env.gateway.usage().perAgent[name]?.calls ?? 0) > 0 && this.env.board.participantStatuses.some((s) => s.agent === name && s.state === 'done');
  }

  private request(producer: string, reviewer: string, claims: ReviewClaim[]) {
    const { ctx, board } = this.env;
    const requestId = `R${++this.requestSeq}`;
    const now = new Date().toISOString();
    for (const c of claims) board.crosschecks.push({ id: `X${++this.recordSeq}`, requestId, claimId: c.claimId, producer, reviewer, verdict: null, rationale: null, correction: null, status: 'pending', error: null, requestedAt: now, answeredAt: null });
    this.pending.set(requestId, { producer, reviewer });
    ctx.emit('crosscheck.requested', { requestId, producer, reviewer, claims }, this.participant);
  }

  /** A participant (the Visual Creator) asked another one to check its work: record it so the barrier waits for the answer. */
  private onForeignRequest(p: { requestId: string; producer: string; reviewer: string; claims: { claimId: string }[] }) {
    if (this.pending.has(p.requestId) || this.finished) return;
    const now = new Date().toISOString();
    for (const c of p.claims) this.env.board.crosschecks.push({ id: `X${++this.recordSeq}`, requestId: p.requestId, claimId: c.claimId, producer: p.producer, reviewer: p.reviewer, verdict: null, rationale: null, correction: null, status: 'pending', error: null, requestedAt: now, answeredAt: null });
    this.pending.set(p.requestId, { producer: p.producer, reviewer: p.reviewer });
  }

  private onAnswer(p: { requestId: string; status: 'answered' | 'failed'; answers: { claimId: string; verdict: Verdict; rationale: string; correction: string | null }[]; error?: SafeProviderError }) {
    const { board } = this.env;
    if (!this.pending.has(p.requestId)) return;
    this.pending.delete(p.requestId);
    const now = new Date().toISOString();
    for (const rec of board.crosschecks.filter((r) => r.requestId === p.requestId)) {
      const ans = p.status === 'answered' ? p.answers.find((a) => a.claimId === rec.claimId) : undefined;
      if (!ans) Object.assign(rec, { status: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error?.message ?? 'The reviewer gave no answer for this claim.', answeredAt: now } satisfies Partial<CrosscheckRecord>);
      else Object.assign(rec, { verdict: ans.verdict, rationale: ans.rationale.slice(0, 500), correction: ans.verdict === 'correct' ? ans.correction : null, status: 'answered', answeredAt: now } satisfies Partial<CrosscheckRecord>);
    }
    this.maybeReady();
  }

  // ---- bounded fan-in barrier -> review ---------------------------------------------------------------------------------------

  private requiredReported() {
    const need = this.plan.activated.filter((a) => ['copywriter', 'landing', 'visual', 'layout'].includes(a.key)).map((a) => a.agent);
    return need.every((n) => this.reported.has(n));
  }

  private maybeReady() {
    if (this.barrierDone || this.finished) return;
    if (!this.copyCommitted || !this.landingResolved || !this.crossPlanned || this.pending.size > 0 || !this.requiredReported()) return;
    this.concludeBarrier();
  }

  private forceBarrier() {
    if (this.barrierDone || this.finished) return;
    const { board } = this.env;
    for (const a of this.plan.activated) if (['copywriter', 'landing', 'visual', 'layout'].includes(a.key) && !this.reported.has(a.agent)) {
      board.setStatus(a.agent, { state: 'timed_out', error: toSafeError('timeout') });
      board.note(`${a.agent} did not finish in time; the review continues with what exists.`);
    }
    for (const rec of board.crosschecks.filter((r) => r.status === 'pending')) Object.assign(rec, { status: 'timed_out', error: 'The reviewer did not answer in time.' });
    this.pending.clear();
    if (!this.copyCommitted) return this.failPhase('The copy was not produced in time.', toSafeError('timeout'));
    this.concludeBarrier();
  }

  private concludeBarrier() {
    this.barrierDone = true;
    if (this.barrier) this.env.ctx.clearTimer(this.barrier);
    this.startReview(1, { variantIds: this.env.board.variants.map((v) => v.id), assetIds: this.env.board.assets.filter((a) => a.kind === 'layout' && a.status !== 'superseded').map((a) => a.id), landing: !!this.env.board.landing });
  }

  private startReview(round: number, scope: { variantIds: string[]; assetIds: string[]; landing: boolean }) {
    const { ctx, board, settings } = this.env;
    board.round = round;
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'working', reason: `Review round ${round}` });
    this.reviewTimer = ctx.setTimer(settings.reviewTimeoutMs * 3 + 10_000, () => {
      board.note(`The review of round ${round} timed out.`);
      this.finish('The review timed out.');
    });
    ctx.emit('review.requested', { round, scope }, this.participant);
  }

  // ---- review -> fix loop ------------------------------------------------------------------------------------------------------

  private fingerprint(f: Pick<ReviewFindingRecord, 'kind' | 'assetRef' | 'finding'>) {
    const { board } = this.env;
    let subject = f.assetRef ?? '-';
    const layout = board.layouts.find((l) => l.assetId === f.assetRef);
    if (layout) subject = `${layout.conceptId}:${layout.format}`;
    const asset = board.assets.find((a) => a.id === f.assetRef);
    if (asset) subject = `${asset.conceptId}:${asset.format ?? 'base'}`;
    return `${f.kind}|${subject}|${normalizeText(f.finding).slice(0, 40)}`;
  }

  private onReviewCompleted(p: { round: number; findings: Omit<ReviewFindingRecord, 'id' | 'round' | 'status' | 'resolvedInRound'>[]; summary: string; modelReview: 'done' | 'partial' | 'failed' | 'skipped' }) {
    const { env } = this;
    const { board, settings, ctx } = env;
    if (this.finished || p.round !== board.round) return;
    if (this.reviewTimer) ctx.clearTimer(this.reviewTimer);
    board.summaries[CREATIVE_INFO.reviewer.name] = p.summary;
    if (p.modelReview === 'failed') this.modelReviewFailed = true;
    const known = new Map(board.findings.map((f) => [this.fingerprint(f), f]));
    const thisRound: ReviewFindingRecord[] = [];
    for (const raw of p.findings) {
      const fp = this.fingerprint(raw);
      const earlier = known.get(fp);
      if (earlier) {
        if (earlier.round < p.round) {
          // The same issue is still there. If a repair was attempted for it, it was NOT fixed: say so instead of hiding it.
          thisRound.push(earlier);
          if (this.repairAttempts(earlier.id) > 0 && earlier.status !== 'accepted') Object.assign(earlier, { status: 'unresolved', resolvedInRound: null });
        }
        continue;
      }
      const rec: ReviewFindingRecord = { ...raw, id: board.next('Q'), round: p.round, status: 'open', resolvedInRound: null };
      board.findings.push(rec);
      known.set(fp, rec);
      thisRound.push(rec);
    }
    // An issue that is no longer reported is fixed when a measurement can prove it (deterministic checks re-run over everything) or
    // when a repair was attempted. A model-found issue outside the scope of a narrower re-review stays as it was.
    for (const f of board.findings) {
      if ((f.status !== 'open' && f.status !== 'unresolved') || f.round >= p.round || thisRound.includes(f)) continue;
      if (f.source === 'deterministic' || this.repairAttempts(f.id) > 0) Object.assign(f, { status: 'fixed', resolvedInRound: p.round });
    }
    const canTry = (f: ReviewFindingRecord) => {
      const attempts = board.revisions.filter((r) => r.findingId === f.id);
      return !attempts.some((r) => r.operation === 'none') && attempts.filter((r) => r.status === 'applied').length < settings.maxRepairRounds;
    };
    const actionable = thisRound.filter((f) => (f.status === 'open' || f.status === 'unresolved') && SEV_ACTIONABLE.has(f.severity) && canTry(f));
    const repairsDone = board.round - 1;
    if (!actionable.length || repairsDone >= settings.maxRepairRounds) return this.finish(actionable.length ? `Repair limit reached (${settings.maxRepairRounds} round(s)).` : 'No blocker or major issue remains.');
    // The Fixer is created on demand: it exists only because the review found something to repair.
    if (!this.fixerJoined) {
      const fixer = env.createFixer();
      ctx.join(fixer.participant);
      this.fixerJoined = true;
      board.plan!.activated.push({ agent: CREATIVE_INFO.fixer.name, key: 'fixer', reason: `Created at run time: the review found ${actionable.length} issue(s) to repair`, dynamic: true });
      board.setStatus(CREATIVE_INFO.fixer.name, { state: 'working', reason: 'Repairing review findings' });
      ctx.emit('participant.registered', { agent: CREATIVE_INFO.fixer.name, role: 'Fixer', channel: null, reason: `The review found ${actionable.length} blocker/major issue(s)`, score: actionable.length, ruleHits: [...new Set(actionable.map((f) => `${f.severity} ${f.kind}`))] }, this.participant);
    } else board.setStatus(CREATIVE_INFO.fixer.name, { state: 'working', reason: `Repair round ${board.round}` });
    this.changed = { variantIds: new Set(), assetIds: new Set(), landing: false };
    this.fixTimer = ctx.setTimer(settings.repairTimeoutMs * 3 + 10_000, () => {
      board.note('The repairs of this round timed out.');
      this.afterRepairs();
    });
    ctx.emit('fix.requested', { round: board.round, findingIds: actionable.map((f) => f.id) }, this.participant);
  }

  private repairAttempts(findingId: string) {
    return this.env.board.revisions.filter((r) => r.findingId === findingId && r.operation !== 'none').length;
  }

  private onRevisionApplied(p: { owner: string; round: number; operationIds: string[]; status: 'applied' | 'failed'; note: string; patch: { kind: string; [k: string]: unknown } | null }) {
    const { board } = this.env;
    if (this.finished || !p.patch || p.status !== 'applied') return;
    const patch = p.patch as never as Record<string, any>;
    if (patch.kind === 'copy') {
      for (const r of patch.revisions as { variantId: string; headline: string; body: string; ctaText: string; hashtags: string[]; claims: never[]; reason: string }[]) {
        const v = board.variants.find((x) => x.id === r.variantId);
        if (!v) continue;
        v.history.push({ version: v.version, headline: v.headline, body: v.body, ctaText: v.ctaText, reason: r.reason });
        Object.assign(v, { headline: r.headline, body: r.body, ctaText: r.ctaText, hashtags: r.hashtags, claims: r.claims, version: v.version + 1 });
        this.changed.variantIds.add(v.id);
      }
    } else if (patch.kind === 'landing' && board.landing) {
      const l = board.landing as Record<string, any>;
      for (const c of patch.changes as { path: string; value: string }[]) {
        const [a, b] = c.path.split('.');
        if (b) l[a][b] = c.value;
        else l[a] = c.value;
      }
      const removals = [...(patch.removals as { list: 'benefits' | 'sections' | 'faq' | 'trustSignals'; index: number }[])].sort((x, y) => y.index - x.index);
      for (const r of removals) if (Array.isArray(l[r.list]) && r.index >= 0 && r.index < l[r.list].length) l[r.list].splice(r.index, 1);
      this.changed.landing = true;
    } else if (patch.kind === 'layout' || patch.kind === 'image') {
      for (const id of (patch.supersedes ?? []) as string[]) {
        const a = board.assets.find((x) => x.id === id);
        if (a) a.status = 'superseded';
      }
      for (const a of (patch.assets ?? []) as AssetRecord[]) {
        board.assets.push(a);
        if (a.kind === 'layout') this.changed.assetIds.add(a.id);
        // a regenerated image replaces the concept's base: its result now points at the new AI image
        const r = a.kind === 'image' && a.source === 'ai_image' ? board.imageResults.find((x) => x.conceptId === a.conceptId) : undefined;
        if (r) Object.assign(r, { requestAttempted: true, outcome: 'generated', stage: null, errorCode: null, providerStatus: null, providerCode: null, message: null, explanation: null, fallbackUsed: false, assetId: a.id });
      }
      for (const l of (patch.layouts ?? []) as LayoutRecord[]) {
        const i = board.layouts.findIndex((x) => x.variantId === l.variantId && x.format === l.format && x.conceptId === l.conceptId);
        if (i >= 0) board.layouts[i] = l;
        else board.layouts.push(l);
      }
    }
  }

  private onRevisionCompleted(p: { round: number; results: (Omit<RevisionRecord, 'id'> & { applied?: boolean })[] }) {
    const { board } = this.env;
    if (this.finished || p.round !== board.round) return;
    if (this.fixTimer) this.env.ctx.clearTimer(this.fixTimer);
    for (const r of p.results) {
      const { applied: _applied, ...rest } = r;
      void _applied;
      board.revisions.push({ ...rest, id: board.next('R') });
      const f = board.findings.find((x) => x.id === r.findingId);
      if (f && r.status === 'applied') f.status = 'open'; // stays open until the re-review confirms it
      else if (f && r.operation === 'none') f.status = 'unresolved';
    }
    board.setStatus(CREATIVE_INFO.fixer.name, { state: 'done' });
    this.afterRepairs();
  }

  private afterRepairs() {
    const { board } = this.env;
    if (this.finished) return;
    if (this.fixTimer) this.env.ctx.clearTimer(this.fixTimer);
    const applied = board.revisions.some((r) => r.round === board.round && r.status === 'applied');
    if (!applied) return this.finish('No repair could be applied.');
    this.startReview(board.round + 1, { variantIds: [...this.changed.variantIds], assetIds: [...this.changed.assetIds], landing: this.changed.landing });
  }

  // ---- end ------------------------------------------------------------------------------------------------------------------------

  private failPhase(message: string, error?: SafeProviderError) {
    if (this.finished) return;
    this.finished = true;
    const { ctx } = this.env;
    const err = error ?? { code: 'invalid_response' as const, message };
    const errors: AgentOutcome[] = [{ agent: CREATIVE_COORDINATOR_NAME, error: { ...err, message } }];
    ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors }, this.participant);
  }

  /** Builds the package and hands it to the orchestrator. Called exactly once. */
  private finish(why: string) {
    if (this.finished) return;
    this.finished = true;
    const { ctx, board } = this.env;
    for (const t of [this.barrier, this.reviewTimer, this.fixTimer]) if (t) ctx.clearTimer(t);
    for (const f of board.findings) if (f.status === 'open' && (f.severity === 'blocker' || f.severity === 'major')) f.status = 'unresolved';
    const f = board.plan?.skipped;
    if (!this.fixerJoined && f && !f.some((s) => s.key === 'fixer')) {
      f.push({ agent: CREATIVE_INFO.fixer.name, key: 'fixer', reason: 'No issue required a repair, so no Fixer was created' });
      board.setStatus(CREATIVE_INFO.fixer.name, { state: 'skipped', reason: 'No issue required a repair' });
      ctx.emit('participant.idle', { agent: CREATIVE_INFO.fixer.name, reason: 'No issue required a repair, so no Fixer was created', skipped: true }, this.participant);
    }
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'done' });
    ctx.emit('campaign.completed', { report: { why, modelReviewFailed: this.modelReviewFailed }, meta: null }, this.participant);
  }
}
