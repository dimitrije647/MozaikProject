import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { normalizeText } from '../../../discovery/input';
import { wordTokens } from '../../../creative/checks';
import { refusedRevision } from '../../../copywriting/checks';
import type { AgentOutcome } from '../../../factory/events';
import { CREATIVE_COORDINATOR_NAME, CREATIVE_INFO, creativeKeyByName, type CreativePlan } from '../../../creative/board';
import { planRepairs, slotsShowing } from '../../../creative/repair';
import { CopyOutput, type AssetRecord, type CopyVariantRecord, type LayoutRecord, type ReviewFindingRecord, type Rubric, type SkippedLayout } from '../../../creative/schemas';
import { planDeliverables } from '../../../hybrid/deliverables';
import type { DiscoverySummary, ImageryBlock, TemplateCreativeRecord, TemplateQualityReport, TemplateSelectionPlan } from '../../../hybrid/records';
import type { ImageAllocation } from '../../../imagery/allocate';
import type { VisualDirectionBrief } from '../../../templates/schema';
import { OnEventTypes, guarded } from '../../run-context';
import { campaignDirection } from './agents';
import type { F4Env } from './env';
import { allocateApprovedOnly } from './image-sourcing';

const PHASE = 'F4_CREATIVE_PRODUCTION' as const;
const SEV_ACTIONABLE = new Set(['blocker', 'major']);

const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((t) => b.has(t)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};

type RawReviewFinding = Omit<ReviewFindingRecord, 'id' | 'round' | 'status' | 'resolvedInRound'>;

/**
 * The Creative Coordinator: a deterministic Mozaik participant (no model calls) that drives F4 in ONE straight line and is the single writer
 * of the F4 board:
 *
 *   Content Writer (copy.proposed) -> the deliverables plan -> Visual Researcher (images.sourced) -> Creative Designer (layout.completed...)
 *   -> Quality Reviewer (review.completed) -> [repair round: Content Writer revision -> Creative Designer re-renders -> review] -> campaign.completed
 *
 * Every stage has a deadline; a stage that does not answer never holds the campaign: the copy is required, pictures fall back to the approved
 * library, a review that does not finish ends the campaign with what exists. Repair rounds are bounded by maxRepairRounds and every issue
 * that remains is reported, never hidden.
 */
export class CreativeCoordinator {
  readonly participant: Participant;
  private finished = false;
  private stageTimer: NodeJS.Timeout | undefined;
  private copied = false;
  private sourced = false;
  private designed = false;
  private modelReviewFailed = false;
  private repair: { round: number; wave: 1 | 2; plan: ReturnType<typeof planRepairs>; ops: Map<string, string[]>; applied: Set<string>; changedVariants: Set<string>; changedAssets: Set<string> } | null = null;

  constructor(
    private readonly env: F4Env,
    private readonly plan: CreativePlan,
    private readonly preSources: SourceRecord[],
  ) {
    const guard = env.ctx.guard(CREATIVE_COORDINATOR_NAME);
    this.participant = createAgent({
      name: CREATIVE_COORDINATOR_NAME,
      capabilities: ['coordination', 'board-writer', 'deterministic'],
      instruction: 'Deterministic creative coordinator. Performs no inference.',
      tools: [],
      handlers: [
        { specification: new OnEventTypes(['phase.started']), processor: guarded(guard, () => this.begin()) },
        { specification: new OnEventTypes(['source.retrieved']), processor: guarded(guard, ({ event }) => this.env.board.addSource((event.payload as { source: SourceRecord }).source)) },
        { specification: new OnEventTypes(['finding.posted']), processor: guarded(guard, ({ event }) => this.onSummary(event.payload as never)) },
        { specification: new OnEventTypes(['copy.proposed']), processor: guarded(guard, ({ event }) => this.onCopy(event.payload as never)) },
        { specification: new OnEventTypes(['images.sourced']), processor: guarded(guard, ({ event }) => this.onImages(event.payload as never)) },
        { specification: new OnEventTypes(['template.selection.completed']), processor: guarded(guard, ({ event }) => this.onSelection(event.payload as never)) },
        { specification: new OnEventTypes(['layout.completed']), processor: guarded(guard, ({ event }) => this.onLayout(event.payload as never)) },
        { specification: new OnEventTypes(['task.completed']), processor: guarded(guard, ({ event }) => this.onTaskCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['review.completed']), processor: guarded(guard, ({ event }) => this.onReviewCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['revision.applied']), processor: guarded(guard, ({ event }) => this.onRevisionApplied(event.payload as never)) },
      ],
    });
  }

  private stage(ms: number, onTimeout: () => void) {
    const { ctx } = this.env;
    if (this.stageTimer) ctx.clearTimer(this.stageTimer);
    this.stageTimer = ctx.setTimer(ms, () => {
      if (!this.finished) onTimeout();
    });
  }

  private assign(key: keyof typeof CREATIVE_INFO, reason: string, task: string) {
    const { board, ctx } = this.env;
    board.setStatus(CREATIVE_INFO[key].name, { state: 'working', reason });
    ctx.emit('task.assigned', { agent: CREATIVE_INFO[key].name, task }, this.participant);
  }

  // ---- 1. copy ---------------------------------------------------------------------------------------------------------------------

  private begin() {
    const { env, plan } = this;
    const { ctx, board, settings } = env;
    board.plan = { activated: [...plan.activated], skipped: [...plan.skipped] };
    board.settings = { channels: env.input.channels, concepts: env.input.concepts, maxRepairRounds: settings.maxRepairRounds, maxModelCalls: settings.maxModelCalls, visionReviews: settings.visionReviews, approvedBudgetUsd: settings.approvedBudgetUsd };
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: CREATIVE_COORDINATOR_NAME, source: s }, this.participant);
    for (const a of plan.activated) board.setStatus(a.agent, { state: 'waiting', reason: a.reason });
    this.stage(settings.writerTimeoutMs + 10_000, () => this.failPhase('The Content Writer did not answer in time: nothing can be designed without copy.', toSafeError('timeout'), CREATIVE_INFO.writer.name));
    this.assign('writer', 'Writing the concepts, posts, ad and print copy', 'copy');
  }

  private onSummary(p: { agent: string; summary: string }) {
    if (creativeKeyByName(p.agent) && p.summary) this.env.board.summaries[p.agent] = p.summary.slice(0, 900);
  }

  private onCopy(p: { agent: string; summary: string; concepts: unknown[]; posts: unknown[]; ads: unknown[]; print: unknown[]; missingInformation: string[] }) {
    const { env } = this;
    const { board, input } = env;
    if (this.copied || this.finished) return;
    const parsed = CopyOutput.safeParse({ summary: p.summary, concepts: p.concepts, posts: p.posts ?? [], ads: p.ads ?? [], print: p.print ?? [], missingInformation: p.missingInformation ?? [] });
    if (!parsed.success) return this.failPhase('The campaign copy was not valid.');
    this.copied = true;
    const out = parsed.data;
    const keyToId = new Map<string, string>();
    for (const c of out.concepts.slice(0, input.concepts)) {
      const id = board.next('K');
      keyToId.set(c.key, id);
      board.concepts.push({ id, name: c.name, basis: c.basis || null, angle: c.angle, keyMessage: c.keyMessage, audience: c.audience, ctaType: c.ctaType, ctaText: c.ctaText, visualIdea: c.visualIdea, purpose: c.purpose, principleNote: c.principleNote || null, points: (c.points ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 3) });
    }
    const add = (v: Omit<CopyVariantRecord, 'id' | 'version' | 'history'>) => board.variants.push({ ...v, id: board.next('V'), version: 1, history: [] });
    const seen = new Set<string>();
    // one post per concept and platform (the first one wins); a text that repeats another platform's post of the same concept is kept and reviewed
    for (const post of out.posts) {
      const conceptId = keyToId.get(post.conceptKey);
      if (!conceptId || !input.channels.includes(post.platform) || seen.has(`${conceptId}|${post.platform}`)) continue;
      seen.add(`${conceptId}|${post.platform}`);
      add({ conceptId, channel: post.platform, placement: 'social_post', length: post.text.length > 220 ? 'long' : 'short', headline: post.hook, body: post.text, description: null, ctaText: post.cta, ctaType: post.ctaType, hashtags: post.hashtags, claims: post.claims, postingFormat: post.postingFormat || null, videoScript: post.platform === 'tiktok' ? post.videoScript : null, visualLine: post.visualLine.trim() || null, principles: [...new Set(post.principles)], ctaShort: post.ctaShort?.trim() || null, headlineShort: null });
    }
    for (const ad of out.ads) {
      const conceptId = keyToId.get(ad.conceptKey);
      if (!conceptId || seen.has(`${conceptId}|${ad.kind}`)) continue;
      seen.add(`${conceptId}|${ad.kind}`);
      add({ conceptId, channel: 'google_search', placement: ad.kind, length: 'short', headline: ad.headline, body: ad.description, description: ad.description, ctaText: ad.cta, ctaType: ad.ctaType, hashtags: [], claims: ad.claims, postingFormat: null, videoScript: null, visualLine: null, principles: [...new Set(ad.principles)], ctaShort: ad.ctaShort?.trim() || null, headlineShort: ad.headlineShort?.trim() || null });
    }
    for (const pr of out.print) {
      const conceptId = keyToId.get(pr.conceptKey);
      if (!conceptId || seen.has(`${conceptId}|${pr.kind}`)) continue;
      seen.add(`${conceptId}|${pr.kind}`);
      add({ conceptId, channel: 'organic_content', placement: pr.kind, length: pr.kind === 'billboard' ? 'short' : 'long', headline: pr.headline, body: pr.body, description: null, ctaText: pr.cta, ctaType: pr.ctaType, hashtags: [], claims: pr.claims, postingFormat: null, videoScript: null, visualLine: pr.kind === 'flyer' ? pr.visualLine.trim() || null : null, principles: [...new Set(pr.principles)], ctaShort: pr.ctaShort?.trim() || null, headlineShort: pr.headlineShort?.trim() || null });
    }
    // near-identical texts across platforms are reported by the Quality Reviewer; exact duplicates of one text inside a concept are dropped here
    const kept: { conceptId: string; tok: Set<string> }[] = [];
    board.variants = board.variants.filter((v) => {
      const tok = wordTokens(`${v.headline} ${v.body}`);
      if (kept.some((k) => k.conceptId === v.conceptId && jaccard(k.tok, tok) >= 0.98 && tok.size > 3)) {
        board.note('An exact duplicate of a copy text was dropped.');
        return false;
      }
      kept.push({ conceptId: v.conceptId, tok });
      return true;
    });
    board.summaries[p.agent] = out.summary;
    for (const m of out.missingInformation) board.note(`Content Writer: ${m}`);
    board.setStatus(p.agent, { findings: board.variants.length });
    if (!board.concepts.length || !board.variants.length) return this.failPhase('The Content Writer produced no usable concept or copy.');

    // the deliverables plan: what this campaign delivers, from the concepts, the platforms and what the collection can draw
    const hy = env.hybrid;
    const deliverables = planDeliverables({
      concepts: board.concepts.map((c) => ({ id: c.id, name: c.name })),
      platforms: input.channels,
      library: hy.library,
      hasPicture: hy.brandImages.length > 0 || env.settings.visual.imagery.autoStock,
      facts: env.settings.visual.facts,
      hasCopy: (conceptId, kind, channel) => board.variants.some((v) => v.conceptId === conceptId && (kind === 'social_post' ? v.placement === 'social_post' && v.channel === channel : v.placement === kind)),
    });
    board.platforms = deliverables.platforms;
    board.notPlanned = deliverables.notPlanned;
    board.hybridPlan = {
      slots: deliverables.slots,
      perConcept: board.concepts.map((c) => {
        const mine = deliverables.slots.filter((s) => s.conceptId === c.id);
        return { conceptId: c.id, name: c.name, templates: mine.length, channels: [...new Set(mine.map((s) => s.channel))] };
      }),
      rules: deliverables.rules,
      warnings: deliverables.warnings,
    };
    for (const n of deliverables.notPlanned) board.note(`Not delivered: ${n.label}${n.conceptId ? ` (${board.concepts.find((c) => c.id === n.conceptId)?.name ?? n.conceptId})` : ''}: ${n.reason}`);
    if (!deliverables.slots.length) return this.failPhase('No deliverable can be designed with the chosen template collection.');

    // 2. the pictures (a missing answer never holds the campaign: the approved library is then used without a search)
    this.stage(env.settings.sourcingTimeoutMs + 5_000, () => this.onImages({ agent: CREATIVE_INFO.researcher.name, summary: 'Picture sourcing did not answer in time.', sourcing: null, direction: null }));
    this.assign('researcher', 'Visual direction and the pictures of every deliverable', 'source');
  }

  // ---- 2. pictures ---------------------------------------------------------------------------------------------------------------

  private onImages(p: { agent: string; summary: string; sourcing: { imagery: ImageryBlock; allocation: ImageAllocation; discovery?: DiscoverySummary | null } | null; direction: VisualDirectionBrief | null }) {
    const { env } = this;
    const { board } = env;
    if (this.sourced || this.finished) return;
    this.sourced = true;
    board.direction = p.direction ?? campaignDirection(env);
    const plan = board.hybridPlan!;
    // sourcing failed or timed out: the pictures the user ALREADY approved are still used (allocated without any search or download)
    const fallback = p.sourcing ? null : allocateApprovedOnly(env);
    const bySlot = new Map((p.sourcing?.allocation.slots ?? fallback?.slots ?? []).map((s) => [s.slotId, s]));
    for (const slot of plan.slots) {
      const a = bySlot.get(slot.slotId);
      slot.imageId = a?.imageId ?? null;
      slot.secondaryImageId = a?.secondaryImageId ?? null;
      slot.focus = a?.focus ?? null;
      slot.source = a?.imageId ? 'brand_image' : 'none';
    }
    if (p.sourcing) {
      board.imagery = p.sourcing.imagery;
      board.discovery = p.sourcing.discovery ?? null;
      for (const n of p.sourcing.imagery.notes.slice(0, 6)) board.note(n);
    } else if (fallback) board.note(`${p.summary} The pictures you already approved were used without the licensed search (no new picture was added).`);
    else {
      env.hybrid.brandImages = [];
      board.note(`${p.summary} No approved picture is available, so every creative is typography-first. Nothing was used by guesswork.`);
    }
    board.summaries[CREATIVE_INFO.researcher.name] = [board.summaries[CREATIVE_INFO.researcher.name], p.summary].filter(Boolean).join(' ').slice(0, 900);
    board.setStatus(CREATIVE_INFO.researcher.name, { state: 'done' });
    // 3. the design
    this.stage(env.settings.designTimeoutMs + 5_000, () => {
      board.setStatus(CREATIVE_INFO.designer.name, { state: 'timed_out', error: toSafeError('timeout') });
      board.note('The Creative Designer did not finish in time; the review continues with what exists.');
      this.afterDesign();
    });
    this.assign('designer', `Designing ${plan.slots.length} deliverable(s)`, 'design');
  }

  // ---- 3. design ------------------------------------------------------------------------------------------------------------------

  private onSelection(p: { plan: TemplateSelectionPlan }) {
    if (this.finished) return;
    this.env.board.selection = p.plan;
    for (const w of p.plan.warnings.slice(0, 6)) this.env.board.note(w);
  }

  private onLayout(p: { assets: AssetRecord[]; layouts: LayoutRecord[]; skipped: SkippedLayout[]; templateCreatives?: TemplateCreativeRecord[] }) {
    const { board } = this.env;
    for (const a of p.assets) board.assets.push(a);
    for (const l of p.layouts) board.layouts.push(l);
    for (const s of p.skipped) board.skippedLayouts.push(s);
    for (const t of p.templateCreatives ?? []) board.putCreative(t);
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    const key = creativeKeyByName(p.agent);
    if (!key || this.finished) return;
    board.setStatus(p.agent, p.outcome === 'succeeded' ? { state: 'done', error: null } : p.outcome === 'skipped' ? { state: 'skipped', reason: p.reason ?? 'Nothing to do' } : { state: p.error?.code === 'timeout' ? 'timed_out' : 'failed', error: p.error ?? null });
    if (p.outcome === 'succeeded') return key === 'designer' ? this.afterDesign() : undefined;
    board.note(`${p.agent} ${p.error?.code === 'timeout' ? 'timed out' : 'failed'}${p.error ? `: ${p.error.message}` : ''}.`);
    if (key === 'writer' && !this.copied) return this.failPhase(`The Content Writer ${p.error?.code === 'timeout' ? 'timed out' : 'failed'}: nothing can be designed without copy.`, p.error, CREATIVE_INFO.writer.name);
    if (key === 'researcher') return this.onImages({ agent: p.agent, summary: 'Picture sourcing failed.', sourcing: null, direction: null });
    if (key === 'designer') return this.afterDesign();
  }

  private afterDesign() {
    if (this.designed || this.finished) return;
    this.designed = true;
    const { board } = this.env;
    if (!board.layouts.length) return this.failPhase('No creative could be rendered.');
    this.startReview(1, board.variants.map((v) => v.id), board.layouts.map((l) => l.assetId));
  }

  // ---- 4. review and bounded repairs ------------------------------------------------------------------------------------------------

  private startReview(round: number, variantIds: string[], assetIds: string[]) {
    const { ctx, board, settings } = this.env;
    board.round = round;
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'working', reason: `Review round ${round}` });
    this.stage(settings.reviewTimeoutMs * 2 + 15_000, () => {
      board.note(`The review of round ${round} did not finish in time.`);
      this.finish('The review timed out.');
    });
    ctx.emit('review.requested', { round, scope: { variantIds, assetIds } }, this.participant);
  }

  private fingerprint(f: Pick<ReviewFindingRecord, 'kind' | 'assetRef' | 'finding'>) {
    const { board } = this.env;
    let subject = f.assetRef ?? '-';
    // a creative keeps its identity across versions: findings about version 1 and version 2 of the same slot are the same finding
    const layout = board.layouts.find((l) => l.assetId === f.assetRef);
    if (layout) subject = layout.slotId ?? `${layout.conceptId}:${layout.format}`;
    return `${f.kind}|${subject}|${normalizeText(f.finding).slice(0, 40)}`;
  }

  private onReviewCompleted(p: { round: number; findings: RawReviewFinding[]; summary: string; modelReview: 'done' | 'partial' | 'failed' | 'skipped'; scores?: Rubric | null; skipped?: { what: string; reason: string }[]; templateQuality?: TemplateQualityReport | null }) {
    const { env } = this;
    const { board, settings, ctx } = env;
    if (this.finished || p.round !== board.round) return;
    board.summaries[CREATIVE_INFO.reviewer.name] = p.summary;
    if (p.modelReview === 'failed') this.modelReviewFailed = true;
    if (p.templateQuality) board.templateQuality = p.templateQuality;
    if (p.scores) board.rubrics.push({ round: p.round, scores: p.scores });
    for (const s of p.skipped ?? []) board.skip(s.what, s.reason);
    const attempted = (id: string) => board.revisions.some((r) => r.findingId === id && r.operation !== 'none');
    const known = new Map(board.findings.map((f) => [this.fingerprint(f), f]));
    const thisRound: ReviewFindingRecord[] = [];
    for (const raw of p.findings) {
      const fp = this.fingerprint(raw);
      const earlier = known.get(fp);
      if (earlier) {
        if (earlier.round < p.round) {
          // still there after a repair attempt: it was NOT fixed, and the report says so
          thisRound.push(earlier);
          if (attempted(earlier.id) && earlier.status !== 'accepted') Object.assign(earlier, { status: 'unresolved', resolvedInRound: null });
        }
        continue;
      }
      const rec: ReviewFindingRecord = { ...raw, id: board.next('Q'), round: p.round, status: 'open', resolvedInRound: null };
      board.findings.push(rec);
      known.set(fp, rec);
      thisRound.push(rec);
    }
    // an issue that is no longer reported is fixed when a measurement can prove it (deterministic checks re-run) or when a repair was attempted
    for (const f of board.findings) {
      if ((f.status !== 'open' && f.status !== 'unresolved') || f.round >= p.round || thisRound.includes(f)) continue;
      if (f.source === 'deterministic' || attempted(f.id)) Object.assign(f, { status: 'fixed', resolvedInRound: p.round });
    }
    const actionable = thisRound.filter((f) => (f.status === 'open' || f.status === 'unresolved') && SEV_ACTIONABLE.has(f.severity) && !attempted(f.id));
    if (!actionable.length) return this.finish('No blocker or major issue remains that a repair could address.');
    if (p.round - 1 >= settings.maxRepairRounds) return this.finish(`Repair limit reached (${settings.maxRepairRounds} round(s)).`);
    // the Quality Reviewer's repair plan: copy first (Content Writer), then the creatives (Creative Designer)
    const plan = planRepairs(board.snapshot(), actionable);
    for (const fp of plan.byFinding.filter((x) => x.operation === 'none')) board.revisions.push({ id: board.next('R'), round: p.round, findingId: fp.findingId, operation: 'none', owner: fp.owner, status: 'skipped', before: null, after: null, note: fp.note });
    if (!plan.copy.size && !plan.rerender.size) return this.finish('The remaining issues cannot be repaired automatically; they are listed in the review findings.');
    this.repair = { round: p.round, wave: 1, plan, ops: new Map(), applied: new Set(), changedVariants: new Set(), changedAssets: new Set() };
    this.stage(settings.repairTimeoutMs * 2 + 15_000, () => {
      board.note('The repairs of this round did not finish in time.');
      this.afterRepairs();
    });
    if (plan.copy.size) {
      const op = { id: `O${p.round}.1`, kind: 'revise_copy' as const, variantIds: [...plan.copy.keys()], findingIds: [...new Set([...plan.copy.values()].flat())] };
      this.repair.ops.set(op.id, op.findingIds);
      board.setStatus(CREATIVE_INFO.writer.name, { state: 'working', reason: `Revising ${op.variantIds.length} piece(s) of copy (round ${p.round})` });
      ctx.emit('revision.requested', { agent: CREATIVE_INFO.writer.name, round: p.round, wave: 1, operations: [op] }, this.participant);
    } else this.startRerenders();
  }

  /** Wave 2: every creative the review named, plus every creative that shows revised copy, is rendered again. */
  private startRerenders() {
    const r = this.repair;
    if (!r || this.finished) return;
    const { board, ctx } = this.env;
    r.wave = 2;
    const ops = new Map(r.plan.rerender);
    for (const slotId of slotsShowing(board, r.changedVariants)) if (!ops.has(slotId)) ops.set(slotId, { slotId, findingIds: [], dropSupport: false, swapTemplate: false });
    if (!ops.size) return this.afterRepairs();
    const operations = [...ops.values()].map((o, i) => ({ ...o, id: `O${r.round}.${i + 2}` }));
    for (const o of operations) r.ops.set(o.id, o.findingIds);
    board.setStatus(CREATIVE_INFO.designer.name, { state: 'working', reason: `Rendering ${operations.length} creative(s) again (round ${r.round})` });
    ctx.emit('revision.requested', { agent: CREATIVE_INFO.designer.name, round: r.round, wave: 2, operations }, this.participant);
  }

  private onRevisionApplied(p: { owner: string; round: number; operationIds: string[]; status: 'applied' | 'failed'; note: string; patch: Record<string, any> | null }) {
    const r = this.repair;
    const { board } = this.env;
    if (this.finished || !r || p.round !== r.round) return;
    const findingIds = p.operationIds.flatMap((id) => r.ops.get(id) ?? []);
    const owner = p.owner;
    const refused: string[] = [];
    if (p.status === 'applied' && p.patch?.kind === 'copy') {
      for (const rev of p.patch.revisions as { variantId: string; headline: string; body: string; visualLine?: string; ctaText: string; ctaShort?: string; hashtags: string[]; claims: never[]; reason: string }[]) {
        const v = board.variants.find((x) => x.id === rev.variantId);
        if (!v) continue;
        // a revision that replaces the copy with a note ("Izostavljeno iz kampanje", "omitted") or drops the call to action is refused: the
        // earlier, publishable version stays (it would otherwise be printed on the visual)
        if (refusedRevision(v, rev)) {
          refused.push(v.id);
          continue;
        }
        v.history.push({ version: v.version, headline: v.headline, body: v.body, ctaText: v.ctaText, reason: rev.reason });
        Object.assign(v, { headline: rev.headline, body: rev.body || v.body, ctaText: rev.ctaText, hashtags: rev.hashtags, claims: rev.claims, version: v.version + 1, ...(v.description !== null ? { description: rev.body || v.description } : {}), ...(v.visualLine != null && rev.visualLine?.trim() ? { visualLine: rev.visualLine.trim() } : {}), ...(rev.ctaShort?.trim() ? { ctaShort: rev.ctaShort.trim() } : {}) });
        r.changedVariants.add(v.id);
      }
    } else if (p.status === 'applied' && p.patch?.kind === 'layout') {
      for (const id of (p.patch.supersedes ?? []) as string[]) {
        const a = board.assets.find((x) => x.id === id);
        if (a) a.status = 'superseded';
      }
      for (const a of (p.patch.assets ?? []) as AssetRecord[]) {
        board.assets.push(a);
        r.changedAssets.add(a.id);
      }
      for (const t of (p.patch.templateCreatives ?? []) as TemplateCreativeRecord[]) board.putCreative(t);
      for (const l of (p.patch.layouts ?? []) as LayoutRecord[]) {
        const i = board.layouts.findIndex((x) => x.slotId === l.slotId);
        if (i >= 0) board.layouts[i] = l;
        else board.layouts.push(l);
      }
    }
    const isCopy = owner === CREATIVE_INFO.writer.name;
    const results = (p.patch?.results ?? []) as { id: string; ok: boolean; note: string; before?: string | null; after?: string | null }[];
    for (const fid of new Set(findingIds)) {
      const res = results.find((x) => (r.ops.get(x.id) ?? []).includes(fid));
      const kept = isCopy && refused.includes(board.findings.find((x) => x.id === fid)?.assetRef ?? '');
      const ok = isCopy ? p.status === 'applied' && !kept : (res?.ok ?? p.status === 'applied');
      board.revisions.push({ id: board.next('R'), round: r.round, findingId: fid, operation: isCopy ? 'revise_copy' : 'rerender_layout', owner, status: ok ? 'applied' : 'failed', before: res?.before ?? null, after: res?.after ?? null, note: kept ? 'The revision replaced the copy with a note or dropped the call to action, so the earlier version was kept.' : (res?.note ?? p.note) });
    }
    board.setStatus(owner, { state: 'done' });
    if (r.wave === 1 && isCopy) return this.startRerenders();
    this.afterRepairs();
  }

  private afterRepairs() {
    const r = this.repair;
    if (!r || this.finished) return;
    this.repair = null;
    if (!r.changedVariants.size && !r.changedAssets.size) return this.finish('No repair could be applied.');
    this.startReview(r.round + 1, [...r.changedVariants], [...r.changedAssets]);
  }

  // ---- end ------------------------------------------------------------------------------------------------------------------------

  /** `agent` = the participant that really failed (the Content Writer, ...), so the failure is attributed to it; default the coordinator. */
  private failPhase(message: string, error?: SafeProviderError, agent: string = CREATIVE_COORDINATOR_NAME) {
    if (this.finished) return;
    this.finished = true;
    const { ctx } = this.env;
    if (this.stageTimer) ctx.clearTimer(this.stageTimer);
    const err = error ?? { code: 'invalid_response' as const, message };
    const errors: AgentOutcome[] = [{ agent, error: { ...err, message } }];
    ctx.emit('phase.failed', { phase: PHASE, reason: 'all_analysts_failed', errors }, this.participant);
  }

  /** Hands the finished work to the orchestrator, which builds and saves the package. Called exactly once. */
  private finish(why: string) {
    if (this.finished) return;
    this.finished = true;
    const { ctx, board } = this.env;
    if (this.stageTimer) ctx.clearTimer(this.stageTimer);
    for (const f of board.findings) if (f.status === 'open' && (f.severity === 'blocker' || f.severity === 'major')) f.status = 'unresolved';
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'done' });
    ctx.emit('campaign.completed', { report: { why, modelReviewFailed: this.modelReviewFailed }, meta: null }, this.participant);
  }
}
