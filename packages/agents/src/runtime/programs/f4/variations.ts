import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import { imageModelProblem, retiredImageModel } from '../../../ai/image-models';
import { missingSlots } from '../../../creative/continuation';
import { VISUAL_ROLES } from '../../../creative/image-allocation';
import { SYSTEMATIC_IMAGE_FAILURES, variationFailed, variationGenerated, variationNotAttempted, variationStorageFailure, type VariationBase } from '../../../creative/image-results';
import { fallbackVariationDirection, variationImagePrompt, variationVisualMessage, type SlotBrief, type VariationDirection } from '../../../creative/prompts';
import { VariationDirections, type AssetRecord, type ConceptRecord, type ImageVariationRecord, type PlannedVariation } from '../../../creative/schemas';
import type { PhaseAgent } from '../f1/agent';
import type { F4Env } from './env';
import { visualDirectionForPrompt } from '../../../templates/visual-direction';
import { currentDirection } from './hybrid-agents';

/** Hybrid Production: the Visual Direction Brief and how the picture will be reused, for the image prompt ('' on every other preset). */
export function directionText(env: F4Env): string {
  if (!env.settings.hybrid) return '';
  return `${visualDirectionForPrompt(currentDirection(env))} The picture will be re-cropped by layout templates into several formats (square, portrait, wide): keep the main subject inside the central 60% of the frame and leave calm, low-detail areas for text.`;
}

/**
 * The part of the Visual Creator that works on SEVERAL original images per concept.
 *
 * The allocation planner (deterministic) decided which images exist. Here the text model proposes what each one shows (in chunks
 * that fit its output limit), every proposal is checked for distinctness, and then each image is requested on its own: one provider
 * request per image, bounded by the image limit and by the approved spending limit, at most `imageConcurrency` in flight, every
 * outcome stored as its own record. A failed image is never replaced by a stand-in picture.
 */
export interface SlotPlan {
  slot: PlannedVariation;
  concept: ConceptRecord;
  direction: VariationDirection;
  plannedBy: 'model' | 'deterministic';
  /** The prompt planned for this image (sent to the image model, or reused by a continuation). */
  prompt: string;
  brief: SlotBrief;
  /** The names of the other planned images of the same concept (the prompt says to look different from them). */
  siblings: string[];
}

export interface VisualCtx {
  env: F4Env;
  self: PhaseAgent;
  name: string;
  /** The Visual task is still open and the run is not closed. */
  alive(): boolean;
  /** Ends the Visual task. */
  outcome(o: 'succeeded' | 'failed' | 'skipped', extra?: { error?: SafeProviderError; reason?: string }): void;
}

const clean = (s: string, max: number) => s.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const briefOf = (slot: PlannedVariation): SlotBrief => ({ slotId: slot.variationId, conceptId: slot.conceptId, index: slot.index, role: { id: slot.role, ...VISUAL_ROLES[slot.role] }, perspective: slot.perspective, lighting: slot.lighting, targetChannels: slot.targetChannels, size: slot.size });

const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
/** How alike two proposals are (shared share of their words): 1 = identical. */
export function directionSimilarity(a: VariationDirection, b: VariationDirection): number {
  const wa = words(`${a.subject} ${a.setting} ${a.focalPoint} ${a.composition} ${a.promptDetails} ${a.goal}`);
  const wb = words(`${b.subject} ${b.setting} ${b.focalPoint} ${b.composition} ${b.promptDetails} ${b.goal}`);
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / Math.max(1, wa.size + wb.size - inter);
}

/** Two pictures of one concept that read almost the same are not "distinct originals": the later one is rebuilt from its own seeds. */
export const SIMILARITY_LIMIT = 0.7;

export function buildPlans(env: F4Env, proposals: Map<string, VariationDirections['variations'][number]>): { plans: SlotPlan[]; fromModel: number } {
  const alloc = env.board.allocation!;
  const plans: SlotPlan[] = [];
  let fromModel = 0;
  for (const slot of alloc.variations) {
    const concept = env.board.concepts.find((c) => c.id === slot.conceptId);
    if (!concept) continue;
    const brief = briefOf(slot);
    const fb = fallbackVariationDirection(concept, brief);
    const p = proposals.get(slot.variationId);
    let direction: VariationDirection = p
      ? { name: clean(p.name, 60), goal: clean(p.goal, 180), medium: clean(p.medium, 80) || fb.medium, subject: clean(p.subject, 260) || fb.subject, setting: clean(p.setting, 220) || fb.setting, focalPoint: clean(p.focalPoint, 160) || fb.focalPoint, composition: clean(p.composition, 260) || fb.composition, mood: clean(p.mood, 140) || fb.mood, avoid: p.avoid.map((a) => clean(a, 60)).filter(Boolean), altText: clean(p.altText, 160) || fb.altText, promptDetails: clean(p.promptDetails, 260) }
      : fb;
    let plannedBy: SlotPlan['plannedBy'] = p ? 'model' : 'deterministic';
    if (plannedBy === 'model' && plans.some((x) => x.concept.id === concept.id && directionSimilarity(x.direction, direction) > SIMILARITY_LIMIT)) {
      direction = fb;
      plannedBy = 'deterministic';
    }
    if (plannedBy === 'model') fromModel++;
    plans.push({ slot, concept, direction, plannedBy, prompt: '', brief, siblings: [] });
  }
  // the prompts are written last, when every image of a concept is known: each one is told to look different from its siblings
  for (const p of plans) {
    p.siblings = plans.filter((x) => x.concept.id === p.concept.id && x !== p).map((x) => `${x.direction.name}: ${clean(x.direction.subject, 70)}`);
    p.prompt = variationImagePrompt(p.direction, env.input.projectName, p.concept, p.brief, env.palette, 'bottom', env.visualBrief, p.siblings, directionText(env));
  }
  return { plans, fromModel };
}

/** Asks the text model what each planned image shows (several chunks when the output limit requires it) and builds the plans. */
export function planVariations(vc: VisualCtx, done: (r: { plans: SlotPlan[]; fromModel: number } | { error: SafeProviderError }) => void) {
  const { env, self } = vc;
  const alloc = env.board.allocation!;
  const slots = alloc.variations.filter((s) => env.board.concepts.some((c) => c.id === s.conceptId));
  const size = Math.max(3, Math.min(24, Math.floor(env.settings.visualPlanTokens / 450)));
  const chunks: PlannedVariation[][] = [];
  for (let i = 0; i < slots.length; i += size) chunks.push(slots.slice(i, i + size));
  const proposals = new Map<string, VariationDirections['variations'][number]>();
  let failed = 0;
  let firstError: SafeProviderError | null = null;
  let at = 0;
  const next = (): void => {
    if (!vc.alive()) return;
    if (at >= chunks.length) {
      if (chunks.length && failed === chunks.length) return done({ error: firstError ?? toSafeError('provider_unavailable') });
      if (failed) env.board.note(`The picture plan of ${failed} of ${chunks.length} planning request(s) could not be produced; those images use directions built from the planner's seeds.`);
      return done(buildPlans(env, proposals));
    }
    const part = chunks[at++];
    const concepts = env.board.concepts.filter((c) => part.some((s) => s.conceptId === c.id));
    self.runJob({
      kind: 'analysis',
      message: variationVisualMessage(env.f3, env.input, concepts, part.map(briefOf), env.palette, !!env.logo, env.visualBrief, new Map(Object.entries(env.board.conceptNotes))),
      schema: VariationDirections,
      schemaName: 'variation_directions',
      maxOutputTokens: env.settings.visualPlanTokens,
      onSuccess: (out) => {
        for (const v of out.variations) if (part.some((s) => s.variationId === v.slotId) && !proposals.has(v.slotId)) proposals.set(v.slotId, v);
        env.ctx.emit('finding.posted', { agent: vc.name, summary: out.summary, findings: [], missingInformation: [] }, self.participant);
        next();
      },
      onFailure: (error) => {
        failed++;
        firstError ??= error;
        next();
      },
    });
  };
  next();
}

/** The images an image-only continuation still has to produce, with the prompts that were already planned (no new text-model call). */
export function plansFromSeed(env: F4Env): SlotPlan[] {
  const out: SlotPlan[] = [];
  for (const slot of missingSlots(env.board.allocation!, env.board.variations)) {
    const concept = env.board.concepts.find((c) => c.id === slot.conceptId);
    if (!concept) continue;
    const brief = briefOf(slot);
    const fb = fallbackVariationDirection(concept, brief);
    const saved = env.board.variations.find((v) => v.variationId === slot.variationId);
    const siblings = env.board.variations.filter((v) => v.conceptId === concept.id && v.variationId !== slot.variationId).map((v) => v.variationName);
    const prompt = saved?.imagePrompt && saved.imagePrompt.length > 50 ? saved.imagePrompt : variationImagePrompt(fb, env.input.projectName, concept, brief, env.palette, 'bottom', env.visualBrief, siblings, directionText(env));
    const subject = /SUBJECT: (.*)/i.exec(prompt)?.[1] ?? fb.subject;
    out.push({ slot, concept, direction: { ...fb, name: saved?.variationName || fb.name, goal: saved?.visualGoal || fb.goal, subject: clean(subject, 260) }, plannedBy: saved?.plannedBy ?? 'deterministic', prompt, brief, siblings });
  }
  return out;
}

const baseOf = (p: SlotPlan, model: string | null, quality: string | null, prompt: string): VariationBase => ({
  conceptId: p.concept.id,
  conceptName: p.concept.name,
  variationId: p.slot.variationId,
  index: p.slot.index,
  variationName: p.direction.name,
  visualGoal: p.direction.goal,
  role: p.slot.role,
  targetChannels: p.slot.targetChannels,
  size: p.slot.size,
  imagePrompt: prompt,
  plannedBy: p.plannedBy,
  providerModel: model,
  quality,
});

/**
 * Requests the planned images, `imageConcurrency` at a time. Each image is one request with its own prompt; the budgets are
 * consumed by the generator before each request. Every image yields exactly one `visual.generated` event with its record.
 */
export async function generateVariations(vc: VisualCtx, plans: SlotPlan[], feedback: Map<string, string>) {
  const { env, self, name } = vc;
  const { ctx, settings, tools } = env;
  const images = tools.images!;
  const model = settings.imageModel!;
  const retired = retiredImageModel(model, settings.now) ? imageModelProblem(model, settings.now) : null;
  const st: { ok: number; firstError: SafeProviderError | null; firstExplanation: string | null; systematic: ImageVariationRecord | null; stopped: ImageVariationRecord | null } = { ok: 0, firstError: null, firstExplanation: null, systematic: null, stopped: null };
  const queue = [...plans];

  const report = (p: SlotPlan, record: ImageVariationRecord, asset: AssetRecord | null, error?: SafeProviderError) => {
    if (!vc.alive()) return;
    if (record.status === 'failed') {
      st.firstError ??= error ?? toSafeError('provider_unavailable');
      st.firstExplanation ??= record.explanation;
    }
    ctx.emit('visual.generated', { agent: name, conceptId: p.concept.id, variationId: p.slot.variationId, asset, failed: record.status !== 'generated', error, variation: record, directionSummary: clean(p.direction.subject, 160) }, self.participant);
  };

  const one = async (p: SlotPlan) => {
    const feedbackText = feedback.get(p.concept.id);
    const prompt = feedbackText ? variationImagePrompt({ ...p.direction, promptDetails: `${p.direction.promptDetails} Team feedback: ${feedbackText}`.trim().slice(0, 400) }, env.input.projectName, p.concept, p.brief, env.palette, 'bottom', env.visualBrief, p.siblings, directionText(env)) : p.prompt;
    const b = baseOf(p, model, settings.imageQuality, prompt);
    if (retired) return report(p, variationNotAttempted(b, 'configuration', retired, 'failed'), null, toSafeError('model_unavailable'));
    if (st.systematic) return report(p, variationNotAttempted(b, 'provider', `Not attempted: an earlier image request already failed in a way that affects every image. ${st.systematic.explanation ?? ''}`.trim(), 'failed'), null, st.firstError ?? toSafeError('model_unavailable'));
    if (st.stopped) return report(p, variationNotAttempted(b, 'budget', st.stopped.explanation ?? 'Not generated: the budget was used up.', 'blocked_by_budget'), null);
    const res = await images.generate(prompt, { model, quality: settings.imageQuality, size: p.slot.size }, { signal: self.signal });
    if (!vc.alive()) return;
    if (!res.ok) {
      const code = res.error.code;
      if (code === 'budget_exceeded' || code === 'spend_limit') {
        const why = code === 'spend_limit' ? 'Not generated: the approved spending limit for this campaign would have been exceeded, so no further paid image request was made.' : `Not generated: the configured limit of ${images.usage().limits.maxImages} original image${images.usage().limits.maxImages === 1 ? '' : 's'} was reached.`;
        const rec = variationNotAttempted(b, 'budget', why, 'blocked_by_budget');
        st.stopped ??= rec;
        return report(p, rec, null);
      }
      const rec = variationFailed(b, res.error, settings.now);
      if (SYSTEMATIC_IMAGE_FAILURES.has(code)) st.systematic ??= rec;
      return report(p, rec, null, res.error);
    }
    let asset: AssetRecord;
    try {
      asset = await tools.assets.save({ kind: 'image', conceptId: p.concept.id, variationId: p.slot.variationId, channel: null, format: null, version: 1, parentAssetId: null, mimeType: res.mimeType, width: res.width, height: res.height, source: 'ai_image', model, quality: settings.imageQuality, requestedSize: p.slot.size, status: 'generated', flags: [], altText: clean(p.direction.altText, 200) || null, promptMetadata: { promptChars: prompt.length, directionSummary: clean(p.direction.subject, 160) }, usage: res.usage, data: res.bytes });
    } catch (e) {
      return report(p, variationStorageFailure(b, clean(e instanceof Error ? e.message : 'storage error', 160), res.usage, res.costUsd), null, toSafeError('provider_unavailable'));
    }
    st.ok++;
    report(p, variationGenerated(b, asset.id, res.usage, res.costUsd), asset);
  };

  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (self.signal.aborted) break;
      await one(p).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, settings.imageConcurrency) }, worker));
  if (!vc.alive()) return;
  // the task error carries the real reason (the first failure's explanation), not a generic text-model message
  const error = st.firstError ? { ...st.firstError, message: st.firstExplanation ?? st.firstError.message } : st.stopped ? toSafeError('spend_limit') : toSafeError('provider_unavailable');
  vc.outcome(st.ok > 0 ? 'succeeded' : 'failed', st.ok > 0 ? {} : { error });
}
