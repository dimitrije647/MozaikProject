import { createAgent, type Participant } from '@mozaik-ai/core';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import type { CrosscheckRecord, SourceRecord, Verdict } from '../../../discovery/f1/board';
import { normalizeText } from '../../../discovery/input';
import { wordTokens } from '../../../creative/checks';
import type { ReviewClaim } from '../../../discovery/f1/prompts';
import type { AgentOutcome } from '../../../factory/events';
import { CREATIVE_COORDINATOR_NAME, CREATIVE_INFO, creativeKeyByName, type CreativeKey, type CreativePlan } from '../../../creative/board';
import type { AssetRecord, ImageResultRecord, ImageVariationRecord, LandingContent, LayoutRecord, ReviewFindingRecord, RevisionRecord, Rubric, SkippedLayout } from '../../../creative/schemas';

interface RawConceptFinding {
  kind: ReviewFindingRecord['kind'];
  severity: string;
  assetRef: string | null;
  finding: string;
}
import { CopyOutput, CTA_TYPES, type ConceptCritique } from '../../../creative/schemas';
import { planImageAllocation } from '../../../creative/image-allocation';
import { designFormatIds } from '../../../hybrid/design-plan';
import type { DiscoverySummary } from '../../../hybrid/records';
import { planHybrid } from '../../../hybrid/plan';
import type { ImageryBlock, TemplateCreativeRecord, TemplateQualityReport, TemplateSelectionPlan } from '../../../hybrid/records';
import type { ImageAllocation } from '../../../imagery/allocate';
import type { VisualDirectionBrief } from '../../../templates/schema';
import { currentDirection } from './hybrid-agents';
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
  private conceptGate = false;
  private conceptTimer: NodeJS.Timeout | undefined;
  // Hybrid Production
  private directionReady = false;
  private directionTimer: NodeJS.Timeout | undefined;
  private visualReason: string | null = null;
  private productionStarted = false;
  // NO AI HYBRID: the pictures are sourced (and assigned to the planned creatives) before any template is chosen
  private imagesRequested = false;
  private imagesReady = false;
  private imagesTimer: NodeJS.Timeout | undefined;
  private qualityTimer: NodeJS.Timeout | undefined;
  private pendingReview: { round: number; scope: { variantIds: string[]; assetIds: string[]; landing: boolean } } | null = null;

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
        { specification: new OnEventTypes(['visual.direction.published']), processor: guarded(guard, ({ event }) => this.onDirection(event.payload as never)) },
        { specification: new OnEventTypes(['template.selection.completed']), processor: guarded(guard, ({ event }) => this.onSelection(event.payload as never)) },
        { specification: new OnEventTypes(['images.sourced']), processor: guarded(guard, ({ event }) => this.onImages(event.payload as never)) },
        { specification: new OnEventTypes(['template.quality.completed']), processor: guarded(guard, ({ event }) => this.onTemplateQuality(event.payload as never)) },
        { specification: new OnEventTypes(['task.completed']), processor: guarded(guard, ({ event }) => this.onTaskCompleted(event.payload as never)) },
        { specification: new OnEventTypes(['crosscheck.requested']), processor: guarded(guard, ({ event }) => this.onForeignRequest(event.payload as never)) },
        { specification: new OnEventTypes(['crosscheck.answered']), processor: guarded(guard, ({ event }) => this.onAnswer(event.payload as never)) },
        { specification: new OnEventTypes(['concept.review.completed']), processor: guarded(guard, ({ event }) => this.onConceptReview(event.payload as never)) },
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
      variations: settings.variations,
      imageConcurrency: settings.imageConcurrency,
      approvedBudgetUsd: settings.approvedBudgetUsd,
      hybrid: settings.hybrid ? { originals: settings.hybrid.originals, templateCreatives: settings.hybrid.templateCreatives } : null,
    };
    for (const s of this.preSources) ctx.emit('source.retrieved', { agent: CREATIVE_COORDINATOR_NAME, source: s }, this.participant);
    for (const s of plan.skipped) {
      board.setStatus(s.agent, { state: 'skipped', reason: s.reason });
      ctx.emit('participant.idle', { agent: s.agent, reason: s.reason, skipped: true }, this.participant);
    }
    for (const a of plan.activated) board.setStatus(a.agent, { state: a.key === 'copywriter' || a.key === 'landing' || a.key === 'researcher' ? 'working' : 'waiting', reason: a.reason });
    this.barrier = ctx.setTimer(settings.productionTimeoutMs, () => this.forceBarrier());
    if (!plan.activated.some((a) => a.key === 'landing')) this.landingResolved = true;
    for (const key of ['copywriter', 'landing', 'layout', 'researcher'] as CreativeKey[]) if (plan.activated.some((a) => a.key === key)) ctx.emit('task.assigned', { agent: CREATIVE_INFO[key].name, task: key }, this.participant);
    // the Visual Researcher never holds the production back for long: without its brief the deterministic one is used
    if (settings.hybrid && !env.seed) this.directionTimer = ctx.setTimer(settings.agentTimeoutMs + 5_000, () => this.useFallbackDirection('The Visual Researcher did not publish in time.'));
    if (settings.hybrid && env.seed) {
      this.directionReady = true;
      if (env.seed.hybrid?.direction) board.direction = structuredClone(env.seed.hybrid.direction);
      else board.direction = currentDirection(env);
    }
    if (env.seed) {
      // image-only continuation: copy, landing and cross-checks are already done (they belong to the earlier campaign), so the Visual
      // Creator starts at once and only the missing images are requested
      this.copyCommitted = true;
      this.landingResolved = true;
      this.crossPlanned = true;
      board.setStatus(CREATIVE_INFO.visual.name, { state: 'working', reason: 'Image-only continuation' });
      ctx.emit('task.assigned', { agent: CREATIVE_INFO.visual.name, task: 'visual' }, this.participant);
    }
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
    // When the cap on copy variants would bite, every concept still gets its first variants before any concept gets a second one
    // (otherwise the last concept could be left with no copy at all, and nothing could be laid out for it).
    const usable = out.variants.filter((v) => keyToId.has(v.conceptKey) && input.channels.includes(v.channel));
    let ordered = out.variants;
    if (usable.length > env.settings.maxVariants) {
      const rank = new Map<string, number>();
      const withRank = out.variants.map((v, i) => {
        const r = rank.get(v.conceptKey) ?? 0;
        rank.set(v.conceptKey, r + 1);
        return { v, r, i };
      });
      ordered = withRank.sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.v);
    }
    for (const v of ordered) {
      const conceptId = keyToId.get(v.conceptKey);
      if (!conceptId || !input.channels.includes(v.channel)) continue; // unknown concept or a channel the user did not select
      const pair = `${conceptId}|${v.channel}`;
      if ((perPair.get(pair) ?? 0) >= 2 || board.variants.length >= env.settings.maxVariants) continue;
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
    // Several originals per concept: the images are placed by the deterministic planner from the REAL concepts and their channels,
    // before anything is requested. The model never decides how many images there are.
    if (env.settings.hybrid) {
      const { settings } = env;
      const hs = settings.hybrid!;
      board.hybridPlan = planHybrid({
        concepts: board.concepts.map((c) => {
          const mine = board.variants.filter((v) => v.conceptId === c.id);
          const channels = [...new Set(mine.map((v) => v.channel))];
          return { id: c.id, name: c.name, channels: channels.length ? channels : input.channels, variants: mine.length };
        }),
        originals: settings.imageGeneration ? hs.originals : 0,
        templateCreatives: hs.templateCreatives,
        channelPriority: settings.channelPriority,
        fixedSize: settings.imageSizeExplicit ? settings.imageSize : null,
        brandImages: env.hybrid!.brandImages.length,
        basis: 'concepts',
        formatIds: designFormatIds(hs),
      });
      board.allocation = board.hybridPlan.allocation;
      for (const w of board.hybridPlan.warnings) board.note(w);
    } else if (env.settings.variations && env.settings.imageGeneration) {
      const { settings } = env;
      board.allocation = planImageAllocation({
        target: settings.imageTarget,
        concepts: board.concepts.map((c) => {
          const mine = board.variants.filter((v) => v.conceptId === c.id);
          const channels = [...new Set(mine.map((v) => v.channel))];
          return { id: c.id, name: c.name, channels: channels.length ? channels : input.channels, variants: mine.length };
        }),
        channelPriority: settings.channelPriority,
        fixedSize: settings.imageSizeExplicit ? settings.imageSize : null,
        layoutsPerOriginal: settings.layoutsPerOriginal,
        basis: 'concepts',
      });
    }
    // Depth: the concepts are critiqued BEFORE the Visual Creator starts, so a weak concept is improved before any image is paid for.
    if (env.settings.depth && env.settings.imageGeneration && !env.seed) return this.startConceptGate();
    this.startVisual('Copy proposed');
  }

  /** The Visual Creator starts (it does not wait for the landing page or the cross-checks). */
  private startVisual(reason: string) {
    this.visualReason = reason;
    this.maybeStartProduction();
  }

  /** Hybrid: the pictures and the template choice need the Visual Direction Brief, so they start once it is published (or the fallback brief is in). */
  private maybeStartProduction() {
    const { env } = this;
    if (this.productionStarted || this.visualReason === null || this.finished) return;
    if (env.settings.hybrid && !this.directionReady) return;
    // NO AI HYBRID: the Visual Researcher sources and assigns the pictures first; the Template Selector then works with what really exists
    if (env.settings.noAiImages && !env.seed && env.board.hybridPlan && !this.imagesReady) return this.requestImages();
    this.productionStarted = true;
    env.board.setStatus(CREATIVE_INFO.visual.name, { state: 'working', reason: this.visualReason });
    env.ctx.emit('task.assigned', { agent: CREATIVE_INFO.visual.name, task: 'visual' }, this.participant);
    if (env.settings.hybrid && !env.seed && env.board.hybridPlan) {
      env.board.setStatus(CREATIVE_INFO.selector.name, { state: 'working', reason: 'Choosing a template for every planned creative' });
      env.ctx.emit('task.assigned', { agent: CREATIVE_INFO.selector.name, task: 'select' }, this.participant);
    }
  }

  /** NO AI HYBRID: asks the Visual Researcher to source pictures; a missing answer never holds the campaign back for long. */
  private requestImages() {
    if (this.imagesRequested) return;
    this.imagesRequested = true;
    const { env } = this;
    const { ctx, board, settings } = env;
    board.setStatus(CREATIVE_INFO.researcher.name, { state: 'working', reason: 'Sourcing the pictures of the campaign' });
    this.imagesTimer = ctx.setTimer(Math.min(settings.agentTimeoutMs, 100_000), () => this.onImages({ agent: CREATIVE_INFO.researcher.name, summary: 'Picture sourcing did not answer in time.', sourcing: null }));
    ctx.emit('images.sourcing.requested', { slots: board.hybridPlan?.slots.length ?? 0, concepts: board.concepts.length }, this.participant);
  }

  /** NO AI HYBRID: the pictures are in. Every planned creative is given its picture (or none: then it is text-first); the production starts. */
  private onImages(p: { agent: string; summary: string; sourcing: { imagery: ImageryBlock; allocation: ImageAllocation; discovery?: DiscoverySummary | null } | null }) {
    const { env } = this;
    const { board, ctx } = env;
    if (this.finished || this.imagesReady) return;
    this.imagesReady = true;
    if (this.imagesTimer) ctx.clearTimer(this.imagesTimer);
    const plan = board.hybridPlan;
    if (plan) {
      const bySlot = new Map((p.sourcing?.allocation.slots ?? []).map((s) => [s.slotId, s]));
      for (const slot of plan.slots) {
        const a = bySlot.get(slot.slotId);
        slot.imageId = a?.imageId ?? null;
        slot.secondaryImageId = a?.secondaryImageId ?? null;
        slot.focus = a?.focus ?? null;
        slot.source = a?.imageId ? 'brand_image' : 'none';
      }
    }
    if (p.sourcing) {
      board.imagery = p.sourcing.imagery;
      if (p.sourcing.discovery) board.discovery = p.sourcing.discovery;
    } else {
      // sourcing failed: no library picture is used by guesswork
      env.hybrid!.brandImages = [];
      board.note(`${p.summary} No picture was used by guesswork.`);
    }
    board.summaries[CREATIVE_INFO.researcher.name] = [board.summaries[CREATIVE_INFO.researcher.name], p.summary].filter(Boolean).join(' ').slice(0, 900);
    board.setStatus(CREATIVE_INFO.researcher.name, { state: 'done' });
    for (const n of p.sourcing?.imagery.notes.slice(0, 6) ?? []) board.note(n);
    this.maybeStartProduction();
  }

  private onDirection(p: { direction: VisualDirectionBrief; refined: boolean; note: string; discovery?: DiscoverySummary | null }) {
    const { board, ctx } = this.env;
    if (this.finished || this.directionReady) return;
    this.directionReady = true;
    if (this.directionTimer) ctx.clearTimer(this.directionTimer);
    board.direction = p.direction;
    board.directionRefined = p.refined;
    board.discovery = p.discovery ?? null;
    if (p.note) board.summaries[CREATIVE_INFO.researcher.name] = p.note;
    this.maybeStartProduction();
  }

  private useFallbackDirection(why: string) {
    const { board, ctx } = this.env;
    if (this.finished || this.directionReady) return;
    this.directionReady = true;
    if (this.directionTimer) ctx.clearTimer(this.directionTimer);
    board.direction = currentDirection(this.env);
    board.directionRefined = false;
    board.note(`${why} The deterministic Visual Direction Brief from the style library and the brand was used.`);
    this.maybeStartProduction();
  }

  private onSelection(p: { plan: TemplateSelectionPlan }) {
    if (this.finished) return;
    this.env.board.selection = p.plan;
    for (const w of p.plan.warnings.slice(0, 6)) this.env.board.note(w);
    // a planned creative that no template could be chosen for is BLOCKED, with its reason: it counts as planned and not delivered, never silently dropped
    if (this.env.settings.noAiImages) {
      const placed = new Set(p.plan.items.map((i) => i.slotId));
      for (const slot of this.env.board.hybridPlan?.slots ?? []) {
        if (placed.has(slot.slotId) || this.env.board.templateCreatives.some((t) => t.slotId === slot.slotId)) continue;
        this.putCreative({ slotId: slot.slotId, conceptId: slot.conceptId, templateId: '', templateName: '(none)', templateVersion: 0, collectionId: this.env.hybrid?.collection?.id ?? null, collectionVersion: this.env.hybrid?.collection?.version ?? null, paletteKey: null, variationId: null, channel: slot.channel, format: slot.formatId, width: slot.width, height: slot.height, status: 'skipped', assetId: null, sourceAssetIds: [], origin: null, flags: ['blocked'], reason: slot.source === 'none' ? 'Blocked: this creative has no picture and no text-first template of the chosen collection fits it. Add a picture to unblock it.' : 'Blocked: no template of the chosen collection fits this creative.' });
      }
    }
  }

  private onTemplateQuality(p: { report: TemplateQualityReport | null }) {
    const { board, ctx } = this.env;
    if (this.finished || !this.pendingReview) return;
    if (this.qualityTimer) ctx.clearTimer(this.qualityTimer);
    if (p.report) board.templateQuality = p.report;
    const review = this.pendingReview;
    this.pendingReview = null;
    ctx.emit('review.requested', review, this.participant);
  }

  private startConceptGate() {
    const { ctx, board, settings } = this.env;
    this.conceptGate = true;
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'working', reason: 'Concept critique before the images' });
    // the images never wait forever for the critique
    this.conceptTimer = ctx.setTimer(settings.reviewTimeoutMs + 4_000, () => this.onConceptReview({ critique: null, deterministic: [], modelReview: 'failed' }));
    ctx.emit('concept.review.requested', { concepts: board.concepts }, this.participant);
  }

  private onConceptReview(p: { critique: ConceptCritique | null; deterministic: RawConceptFinding[]; modelReview: 'done' | 'failed' | 'skipped' }) {
    if (!this.conceptGate || this.finished) return;
    this.conceptGate = false;
    const { env } = this;
    const { board, ctx } = env;
    if (this.conceptTimer) ctx.clearTimer(this.conceptTimer);
    const flagged = new Map<string, { severity: 'major' | 'minor'; why: string; source: 'deterministic' | 'llm_text'; kind: ReviewFindingRecord['kind'] }>();
    const mark = (id: string | null, severity: 'major' | 'minor', why: string, source: 'deterministic' | 'llm_text', kind: ReviewFindingRecord['kind']) => {
      if (id && !flagged.has(id)) flagged.set(id, { severity, why, source, kind });
    };
    for (const d of p.deterministic) mark(d.assetRef, d.severity === 'major' ? 'major' : 'minor', d.finding, 'deterministic', d.kind);
    for (const c of p.critique?.concepts ?? []) {
      const low = Math.min(c.specificity, c.originality, c.audienceFit, c.visualPotential);
      if (c.verdict === 'revise' || low <= 2) mark(c.conceptId, low <= 2 ? 'major' : 'minor', c.problem || 'The critique asks for a stronger concept.', 'llm_text', low <= 2 && c.originality <= 2 ? 'generic_concept' : 'strategy_mismatch');
    }
    const revised: string[] = [];
    for (const c of p.critique?.concepts ?? []) {
      const concept = board.concepts.find((x) => x.id === c.conceptId);
      if (!concept) continue;
      const note = [c.artDirection, c.problem && flagged.has(c.conceptId) ? `Problem to avoid: ${c.problem}` : ''].filter(Boolean).join(' ').slice(0, 480);
      if (note) board.conceptNotes[concept.id] = note;
      const better = c.visualIdeaRevision?.trim();
      if (flagged.has(concept.id) && better && better.length >= 30 && better !== concept.visualIdea) {
        board.conceptHistory.push({ conceptId: concept.id, field: 'visualIdea', before: concept.visualIdea, after: better, reason: flagged.get(concept.id)!.why.slice(0, 200) });
        concept.visualIdea = better.slice(0, 300);
        revised.push(concept.id);
      }
    }
    for (const [id, f] of flagged) {
      const fixed = revised.includes(id);
      const name = board.concepts.find((x) => x.id === id)?.name ?? id;
      board.findings.push({ id: board.next('Q'), round: 0, kind: f.kind, severity: f.severity, assetRef: id, finding: `Concept "${name}": ${f.why}`.slice(0, 300), evidence: 'Concept critique before the images (measured overlap/thinness, or the reviewer\'s scores).', suggestedCorrection: fixed ? 'Revised before the images were generated.' : 'Give the concept a specific subject, setting and angle that belong to this business.', responsibleAgent: 'copywriter', source: f.source, status: fixed ? 'fixed' : f.severity === 'major' ? 'unresolved' : 'open', resolvedInRound: fixed ? 0 : null });
    }
    board.conceptReview = { critique: p.critique, modelReview: p.modelReview, flagged: [...flagged.keys()], revised, note: p.modelReview === 'done' ? `${flagged.size} concept(s) flagged, ${revised.length} revised before the images.` : p.modelReview === 'skipped' ? 'The critique was skipped: not enough text-model calls were left.' : 'The critique did not finish; only the automatic checks ran.' };
    if (p.modelReview !== 'done') board.skip('concept critique before the images', board.conceptReview.note);
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'waiting', reason: 'Waiting for the production to finish' });
    this.startVisual(revised.length ? `Concepts improved (${revised.length}); art direction attached` : 'Concepts critiqued');
  }

  private onLanding(p: { agent: string; summary: string; content: LandingContent; missingInformation: string[] }) {
    const { board } = this.env;
    board.landing = p.content;
    board.summaries[p.agent] = p.summary;
    for (const m of p.missingInformation) board.note(`Landing Content Builder: ${m}`);
    board.setStatus(p.agent, { findings: 1 });
    this.landingResolved = true;
  }

  private onVisual(p: { conceptId: string; variationId?: string; asset: AssetRecord | null; failed: boolean; error?: SafeProviderError; directionSummary: string; result?: ImageResultRecord; variation?: ImageVariationRecord }) {
    const { board } = this.env;
    this.visualSeen.add(p.conceptId);
    if (p.asset) board.assets.push(p.asset);
    if (p.variationId && p.variation) {
      // one record per planned image, replaced if the same image reports again; the concept-level result is derived from them at the end
      const i = board.variations.findIndex((v) => v.variationId === p.variationId);
      if (i >= 0) board.variations[i] = p.variation;
      else board.variations.push(p.variation);
      return;
    }
    if (!p.result) return;
    const i = board.imageResults.findIndex((r) => r.conceptId === p.conceptId);
    if (i >= 0) board.imageResults[i] = p.result;
    else board.imageResults.push(p.result);
    // every concept without an AI image says why (a fallback is never silent); a budget limit is stated once
    if (p.result.outcome === 'failed') board.note(`No AI image for "${p.result.conceptName}": ${p.result.explanation}`);
    else if (p.result.outcome === 'skipped' && p.result.stage === 'budget') board.note(p.result.explanation ?? '');
  }

  private onLayout(p: { conceptId: string; assets: AssetRecord[]; layouts: LayoutRecord[]; skipped: SkippedLayout[]; templateCreatives?: TemplateCreativeRecord[] }) {
    const { board } = this.env;
    for (const a of p.assets) board.assets.push(a);
    for (const l of p.layouts) board.layouts.push(l);
    for (const s of p.skipped) board.skippedLayouts.push(s);
    for (const t of p.templateCreatives ?? []) this.putCreative(t);
  }

  private putCreative(t: TemplateCreativeRecord) {
    const list = this.env.board.templateCreatives;
    const i = list.findIndex((x) => x.slotId === t.slotId);
    if (i >= 0) list[i] = t;
    else list.push(t);
  }

  private onTaskCompleted(p: { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string }) {
    const { board } = this.env;
    const key = creativeKeyByName(p.agent);
    if (!key || this.finished) return;
    const state = p.outcome === 'succeeded' ? { state: 'done' as const, error: null } : p.outcome === 'skipped' ? { state: 'skipped' as const, reason: p.reason ?? 'Nothing to do' } : { state: p.error?.code === 'timeout' ? ('timed_out' as const) : ('failed' as const), error: p.error ?? null };
    board.setStatus(p.agent, state);
    if (key === 'researcher' && p.outcome !== 'succeeded') this.useFallbackDirection(`The Visual Researcher ${p.outcome === 'failed' ? 'failed' : 'was skipped'}.`);
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
    const need = this.plan.activated.filter((a) => ['copywriter', 'landing', 'visual', 'layout', 'researcher', 'selector'].includes(a.key)).map((a) => a.agent);
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
    for (const a of this.plan.activated) if (['copywriter', 'landing', 'visual', 'layout', 'researcher', 'selector'].includes(a.key) && !this.reported.has(a.agent)) {
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
    const { env } = this;
    // a continuation reviews what is NEW (the earlier text and layouts were reviewed with the earlier campaign)
    const copied = new Set((env.seed?.assets ?? []).map((a) => a.id));
    this.startReview(1, { variantIds: env.seed ? [] : env.board.variants.map((v) => v.id), assetIds: env.board.assets.filter((a) => a.kind === 'layout' && a.status !== 'superseded' && !copied.has(a.id)).map((a) => a.id), landing: env.seed ? false : !!env.board.landing });
  }

  private startReview(round: number, scope: { variantIds: string[]; assetIds: string[]; landing: boolean }) {
    const { ctx, board, settings } = this.env;
    board.round = round;
    board.setStatus(CREATIVE_INFO.reviewer.name, { state: 'working', reason: `Review round ${round}` });
    this.reviewTimer = ctx.setTimer(settings.reviewTimeoutMs * 3 + 10_000, () => {
      board.note(`The review of round ${round} timed out.`);
      this.finish('The review timed out.');
    });
    if (this.env.settings.hybrid && this.plan.activated.some((a) => a.key === 'templateReviewer')) {
      // the Template Quality Reviewer opens every template creative first; the Content & Brand Reviewer then sees its report
      this.pendingReview = { round, scope };
      board.setStatus(CREATIVE_INFO.templateReviewer.name, { state: 'working', reason: `Checking the template creatives (round ${round})` });
      this.qualityTimer = ctx.setTimer(settings.reviewTimeoutMs, () => this.onTemplateQuality({ report: null }));
      ctx.emit('template.quality.requested', { planned: board.hybridPlan?.slots.length ?? 0 }, this.participant);
      return;
    }
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

  private onReviewCompleted(p: { round: number; findings: Omit<ReviewFindingRecord, 'id' | 'round' | 'status' | 'resolvedInRound'>[]; summary: string; modelReview: 'done' | 'partial' | 'failed' | 'skipped'; scores?: Rubric | null; skipped?: { what: string; reason: string }[] }) {
    const { env } = this;
    const { board, settings, ctx } = env;
    if (this.finished || p.round !== board.round) return;
    if (this.reviewTimer) ctx.clearTimer(this.reviewTimer);
    board.summaries[CREATIVE_INFO.reviewer.name] = p.summary;
    if (p.modelReview === 'failed') this.modelReviewFailed = true;
    if (p.scores) board.rubrics.push({ round: p.round, scores: p.scores });
    for (const s of p.skipped ?? []) board.skip(s.what, s.reason);
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
      // a deterministic alignment of the call-to-action TYPE with the ads (the text revision cannot change it)
      if (typeof patch.ctaObjective === 'string' && (CTA_TYPES as readonly string[]).includes(patch.ctaObjective)) {
        l.ctaObjective = patch.ctaObjective;
        if (Array.isArray(l.ctas) && l.ctas[0]) l.ctas[0] = { ...l.ctas[0], objective: patch.ctaObjective };
      }
      for (const c of (patch.changes ?? []) as { path: string; value: string }[]) {
        const [a, b] = c.path.split('.');
        if (b) l[a][b] = c.value;
        else l[a] = c.value;
      }
      const removals = [...((patch.removals ?? []) as { list: 'benefits' | 'sections' | 'faq' | 'trustSignals'; index: number }[])].sort((x, y) => y.index - x.index);
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
      for (const t of (patch.templateCreatives ?? []) as TemplateCreativeRecord[]) this.putCreative(t);
      for (const l of (patch.layouts ?? []) as LayoutRecord[]) {
        const i = board.layouts.findIndex((x) => (l.slotId ? x.slotId === l.slotId : x.variantId === l.variantId && x.format === l.format && x.conceptId === l.conceptId && (x.variationId ?? null) === (l.variationId ?? null)));
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
    if (this.env.settings.hybrid && this.plan.activated.some((a) => a.key === 'templateReviewer')) board.setStatus(CREATIVE_INFO.templateReviewer.name, { state: board.templateQuality ? 'done' : 'skipped', reason: board.templateQuality ? null : 'The check did not run' });
    ctx.emit('campaign.completed', { report: { why, modelReviewFailed: this.modelReviewFailed }, meta: null }, this.participant);
  }
}
