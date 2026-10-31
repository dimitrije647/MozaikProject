import type { SituationHandler } from '@mozaik-ai/core';
import sharp from 'sharp';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import { reviewMessage } from '../../../discovery/f1/prompts';
import { CrosscheckAnswer } from '../../../discovery/f1/schemas';
import type { AssetRecord, ConceptRecord, CopyVariantRecord, LayoutRecord, ReviewFindingRecord, SkippedLayout } from '../../../creative/schemas';
import { CopyOutput, CopyRevisionOutput, LandingOutput, LandingRevisionOutput, ReviewOutput, VisualDirections } from '../../../creative/schemas';
import { CREATIVE_INFO } from '../../../creative/board';
import { assetFindings, claimFindings, consistencyFindings, dedupe, type RawFinding } from '../../../creative/checks';
import { brandGradient, renderLayout, type LayoutOverrides } from '../../../creative/layout';
import { CREATIVE_INSTRUCTIONS, copyRevisionMessage, copywriterMessage, imagePrompt, landingMessage, landingRevisionMessage, reviewTextMessage, reviewVisionMessage, visualMessage } from '../../../creative/prompts';
import { layoutOperations, planRepairs, type CopyOp, type ImageOp, type LandingOp, type LayoutOp } from '../../../creative/repair';
import { OnEventTypes, guarded } from '../../run-context';
import { PhaseAgent, type JobSpec } from '../f1/agent';
import type { F4Env } from './env';

const CROSSCHECK_NOTE = `\nYou are checking material that ANOTHER participant of the same creative team produced. Compare it with what YOU produced earlier in this conversation and with the strategy and brief. "agree" = consistent with the strategy and supported; "disagree" = contradicts the strategy or the other material, or states something unsupported; "correct" = give the corrected wording; "insufficient_evidence" = you cannot judge it. Be fair and brief; do not invent problems.`;

const clean = (s: string, max: number) => s.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const errNote = (e: SafeProviderError) => e.message;

type Handler = SituationHandler;

/** The cross-check answering every model-using participant shares: answers from its OWN earlier analysis. */
function crosscheckHandler(env: F4Env, self: PhaseAgent, name: string): Handler {
  const { ctx, settings } = env;
  return {
    specification: new OnEventTypes(['crosscheck.requested']),
    processor: guarded(ctx.guard(name), ({ event }) => {
      const p = event.payload as { requestId: string; producer: string; reviewer: string; claims: never[] };
      if (p.reviewer !== name) return;
      self.runJob({
        kind: 'review',
        message: reviewMessage(p.requestId, p.producer, p.claims, env.input.language) + CROSSCHECK_NOTE,
        schema: CrosscheckAnswer,
        schemaName: 'crosscheck_answer',
        maxOutputTokens: settings.reviewTokens,
        timeoutMs: settings.reviewTimeoutMs,
        onSuccess: (out) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'answered', answers: out.answers }, self.participant),
        onFailure: (error) => ctx.emit('crosscheck.answered', { requestId: p.requestId, producer: p.producer, reviewer: name, status: 'failed', answers: [], error }, self.participant),
      });
    }),
  };
}

const failedTask = (env: F4Env, self: PhaseAgent, name: string, error: SafeProviderError) => {
  self.closeTask();
  env.ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
};

// ---- A19 Copywriter ------------------------------------------------------------------------------------------------------

export function buildCopywriter(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.copywriter.name;
  return new PhaseAgent(env, { key: 'copywriter', name, instruction: CREATIVE_INSTRUCTIONS.copywriter, capabilities: ['creative-production', 'copywriting', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        self.runJob({
          kind: 'analysis',
          message: copywriterMessage(env.f1, env.f3, env.input),
          schema: CopyOutput,
          schemaName: 'copy_proposal',
          maxOutputTokens: settings.analystTokens,
          onSuccess: (out) => {
            self.closeTask();
            ctx.emit('copy.proposed', { agent: name, summary: out.summary, concepts: out.concepts, variants: out.variants, missingInformation: out.missingInformation }, self.participant);
            ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
          },
          onFailure: (error) => failedTask(env, self, name, error),
        });
      }),
    },
    crosscheckHandler(env, self, name),
    {
      // Fixer -> Copywriter: revise ONLY the named variants, with the reviewer's findings in hand.
      specification: new OnEventTypes(['revision.requested']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        const p = event.payload as { agent: string; round: number; operations: CopyOp[] };
        if (p.agent !== name) return;
        const ops = p.operations;
        const operationIds = ops.map((o) => o.id);
        const variantIds = [...new Set(ops.flatMap((o) => o.variantIds))];
        const findingIds = new Set(ops.flatMap((o) => o.findingIds));
        const findings = env.board.findings.filter((f) => findingIds.has(f.id));
        const applied = (status: 'applied' | 'failed', note: string, patch: unknown) => ctx.emit('revision.applied', { owner: name, round: p.round, operationIds, status, note, patch }, self.participant);
        self.runJob({
          kind: 'review',
          message: copyRevisionMessage(env.input, env.board.snapshot(), findings, variantIds),
          schema: CopyRevisionOutput,
          schemaName: 'copy_revision',
          maxOutputTokens: settings.analystTokens,
          timeoutMs: settings.agentTimeoutMs,
          onSuccess: (out) => {
            const revisions = out.revisions.filter((r) => variantIds.includes(r.variantId));
            if (!revisions.length) return applied('failed', 'The Copywriter returned no usable revision.', null);
            const reason = findings.map((f) => f.finding).join(' | ').slice(0, 200);
            applied('applied', `${revisions.length} variant(s) revised.`, { kind: 'copy', revisions: revisions.map((r) => ({ ...r, reason })), results: ops.map((o) => ({ id: o.id, ok: true, note: '' })) });
          },
          onFailure: (error) => applied('failed', errNote(error), { results: ops.map((o) => ({ id: o.id, ok: false, note: errNote(error) })) }),
        });
      }),
    },
  ]);
}

// ---- A22 Landing Content Builder -----------------------------------------------------------------------------------------

export function buildLanding(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.landing.name;
  return new PhaseAgent(env, { key: 'landing', name, instruction: CREATIVE_INSTRUCTIONS.landing, capabilities: ['creative-production', 'landing-content', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        self.runJob({
          kind: 'analysis',
          message: landingMessage(env.f1, env.f3, env.input),
          schema: LandingOutput,
          schemaName: 'landing_content',
          maxOutputTokens: settings.analystTokens,
          onSuccess: (out) => {
            self.closeTask();
            ctx.emit('landing.proposed', { agent: name, summary: out.summary, content: out.content, missingInformation: out.missingInformation }, self.participant);
            ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
          },
          onFailure: (error) => failedTask(env, self, name, error),
        });
      }),
    },
    crosscheckHandler(env, self, name),
    {
      specification: new OnEventTypes(['revision.requested']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        const p = event.payload as { agent: string; round: number; operations: LandingOp[] };
        if (p.agent !== name) return;
        const operationIds = p.operations.map((o) => o.id);
        const findingIds = new Set(p.operations.flatMap((o) => o.findingIds));
        const findings = env.board.findings.filter((f) => findingIds.has(f.id));
        const applied = (status: 'applied' | 'failed', note: string, patch: unknown) => ctx.emit('revision.applied', { owner: name, round: p.round, operationIds, status, note, patch }, self.participant);
        self.runJob({
          kind: 'review',
          message: landingRevisionMessage(env.input, env.board.snapshot(), findings),
          schema: LandingRevisionOutput,
          schemaName: 'landing_revision',
          maxOutputTokens: settings.analystTokens,
          timeoutMs: settings.agentTimeoutMs,
          onSuccess: (out) => {
            if (!out.changes.length && !out.removals.length) return applied('failed', 'The Landing Content Builder proposed no change.', null);
            applied('applied', `${out.changes.length} field(s) changed, ${out.removals.length} item(s) removed.`, { kind: 'landing', changes: out.changes, removals: out.removals, results: p.operations.map((o) => ({ id: o.id, ok: true, note: '' })) });
          },
          onFailure: (error) => applied('failed', errNote(error), { results: p.operations.map((o) => ({ id: o.id, ok: false, note: errNote(error) })) }),
        });
      }),
    },
  ]);
}

// ---- shared: bases and layouts ---------------------------------------------------------------------------------------------

async function saveGradientBase(env: F4Env, conceptId: string): Promise<AssetRecord> {
  const data = await brandGradient(1024, env.palette);
  return env.tools.assets.save({ kind: 'image', conceptId, channel: null, format: null, version: 1, parentAssetId: null, mimeType: 'image/png', width: 1024, height: 1024, source: 'brand_gradient', model: null, quality: null, requestedSize: null, status: 'rendered', flags: [], altText: null, promptMetadata: null, usage: null, data });
}

/** The newest usable base image of a concept (never a superseded one). */
function currentBase(env: F4Env, conceptId: string): AssetRecord | undefined {
  return env.board.assets
    .filter((a) => a.kind === 'image' && a.conceptId === conceptId && a.status !== 'superseded' && a.status !== 'failed')
    .sort((a, b) => b.version - a.version)[0];
}

const supportingText = (v: CopyVariantRecord) => {
  const t = (v.description ?? v.body).replace(/\s+/g, ' ').trim();
  return t.length <= 110 ? t : `${t.slice(0, 107).replace(/\s+\S*$/, '')}…`;
};

const pickVariant = (variants: CopyVariantRecord[], conceptId: string, channel: string) =>
  variants.find((v) => v.conceptId === conceptId && v.channel === channel && v.placement === 'paid_ad') ?? variants.find((v) => v.conceptId === conceptId && v.channel === channel) ?? undefined;

// ---- A20 Visual Creator ---------------------------------------------------------------------------------------------------------

export function buildVisual(env: F4Env): PhaseAgent {
  const { ctx, settings, tools } = env;
  const name = CREATIVE_INFO.visual.name;
  const copywriter = CREATIVE_INFO.copywriter.name;
  const prompts = new Map<string, string>(); // conceptId -> the prompt used (kept in memory only, never persisted)
  let requestSeq = 0;
  let awaiting: { requestId: string; resume: (answers: { claimId: string; verdict: string; rationale: string; correction: string | null }[]) => void; timer: NodeJS.Timeout } | null = null;

  const emptyDirection = (c: ConceptRecord) => ({ conceptKey: c.id, subject: c.visualIdea || c.keyMessage, composition: 'Balanced composition with a calm, uncluttered area for text.', mood: 'Calm and professional', colors: env.palette.slice(0, 2), avoid: [] as string[], altText: c.name, promptDetails: '' });

  return new PhaseAgent(env, { key: 'visual', name, instruction: CREATIVE_INSTRUCTIONS.visual, capabilities: ['creative-production', 'image-generation', 'inference'] }, (self) => {
    const outcome = (o: 'succeeded' | 'failed' | 'skipped', extra: { error?: SafeProviderError; reason?: string } = {}) => {
      self.closeTask();
      ctx.emit('task.completed', { agent: name, outcome: o, ...extra }, self.participant);
    };

    const generateAll = async (directions: Map<string, ReturnType<typeof emptyDirection>>, feedback: Map<string, string>) => {
      const images = tools.images!;
      const queue = env.board.concepts.slice(0, images.usage().limits.maxImages);
      let ok = 0;
      let firstError: SafeProviderError | undefined;
      const one = async (c: ConceptRecord) => {
        const d = directions.get(c.id) ?? emptyDirection(c);
        const prompt = imagePrompt({ subject: d.subject, composition: d.composition, mood: d.mood, colors: d.colors, avoid: d.avoid, promptDetails: `${d.promptDetails}${feedback.get(c.id) ? ` Team feedback: ${feedback.get(c.id)}` : ''}`.trim() }, env.input.projectName, 'bottom');
        const res = await images.generate(prompt, { model: settings.imageModel!, quality: settings.imageQuality, size: settings.imageSize }, { signal: self.signal });
        if (ctx.isClosed() || !self.isTaskOpen()) return;
        let asset: AssetRecord | null = null;
        let error: SafeProviderError | undefined;
        if (res.ok) {
          try {
            asset = await tools.assets.save({ kind: 'image', conceptId: c.id, channel: null, format: null, version: 1, parentAssetId: null, mimeType: res.mimeType, width: res.width, height: res.height, source: 'ai_image', model: settings.imageModel, quality: settings.imageQuality, requestedSize: settings.imageSize, status: 'generated', flags: [], altText: clean(d.altText, 200) || null, promptMetadata: { promptChars: prompt.length, directionSummary: clean(d.subject, 160) }, usage: res.usage, data: res.bytes });
            prompts.set(c.id, prompt);
            ok++;
          } catch {
            error = toSafeError('provider_unavailable');
          }
        } else error = res.error;
        if (!self.isTaskOpen() || ctx.isClosed()) return;
        if (!asset) {
          firstError ??= error;
          asset = await saveGradientBase(env, c.id); // an honest fallback: the layouts will use a brand-colored background
        }
        ctx.emit('visual.generated', { agent: name, conceptId: c.id, asset, failed: !!error, error, directionSummary: clean(d.subject, 160) }, self.participant);
      };
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          if (self.signal.aborted) break;
          await one(c).catch(() => undefined);
        }
      };
      await Promise.all([worker(), worker()]); // at most two image requests in flight
      if (!self.isTaskOpen() || ctx.isClosed()) return;
      outcome(ok > 0 ? 'succeeded' : 'failed', ok > 0 ? {} : { error: firstError ?? toSafeError('provider_unavailable') });
    };

    const afterPlan = (out: VisualDirections) => {
      const directions = new Map(out.directions.map((d) => [d.conceptKey, d]));
      const concepts = env.board.concepts.slice(0, tools.images!.usage().limits.maxImages);
      const feedback = new Map<string, string>();
      const go = () => void generateAll(directions, feedback);
      // Copywriter <-> Visual Creator: the Copywriter checks the planned pictures against its messaging BEFORE any image is paid for.
      const used = env.gateway.usage();
      const copyReviewer = env.board.participantStatuses.some((s) => s.agent === copywriter && s.state === 'done') && (used.perAgent[copywriter]?.calls ?? 0) > 0;
      if (!copyReviewer || used.callsStarted + 4 > settings.maxModelCalls || !concepts.length) return go();
      const requestId = `VX${++requestSeq}`;
      const resume = (answers: { claimId: string; verdict: string; rationale: string; correction: string | null }[]) => {
        if (!awaiting || awaiting.requestId !== requestId) return;
        ctx.clearTimer(awaiting.timer);
        awaiting = null;
        for (const a of answers) {
          const text = a.verdict === 'correct' ? a.correction : a.verdict === 'disagree' ? a.rationale : null;
          if (text) feedback.set(a.claimId, clean(text, 220));
        }
        go();
      };
      awaiting = { requestId, resume, timer: ctx.setTimer(settings.reviewTimeoutMs + 2_000, () => resume([])) };
      const claims = concepts.map((c) => {
        const d = directions.get(c.id) ?? emptyDirection(c);
        return { claimId: c.id, agent: name, statement: `Planned picture for concept "${c.name}" (key message: ${c.keyMessage}): ${clean(d.subject, 200)}. Mood: ${clean(d.mood, 80)}.`, classification: 'proposed', locator: 'visual direction', excerpt: null, sourceLabel: null };
      });
      ctx.emit('crosscheck.requested', { requestId, producer: name, reviewer: copywriter, claims }, self.participant);
    };

    return [
      {
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          if (!self.openTask(settings.visualTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
          if (!settings.imageGeneration || !tools.images || !settings.imageModel) return outcome('skipped', { reason: 'No image model was selected, so no picture is generated. The layouts use brand-colored backgrounds.' });
          self.runJob({
            kind: 'analysis',
            message: visualMessage(env.f3, env.input, env.board.concepts.slice(0, tools.images.usage().limits.maxImages), env.palette, !!env.logo),
            schema: VisualDirections,
            schemaName: 'visual_directions',
            maxOutputTokens: settings.analystTokens,
            onSuccess: (out) => {
              env.ctx.emit('finding.posted', { agent: name, summary: out.summary, findings: [], missingInformation: [] }, self.participant);
              afterPlan(out);
            },
            // The text model could not plan: nothing is generated and nothing is paid for.
            onFailure: (error) => outcome('failed', { error }),
          });
        }),
      },
      {
        specification: new OnEventTypes(['crosscheck.answered']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { requestId: string; producer: string; status: string; answers: { claimId: string; verdict: string; rationale: string; correction: string | null }[] };
          if (p.producer !== name || !awaiting || awaiting.requestId !== p.requestId) return;
          awaiting.resume(p.status === 'answered' ? p.answers : []);
        }),
      },
      {
        // Fixer -> Visual Creator: regenerate a rejected image (only when the user enabled it; the generator enforces the budget).
        specification: new OnEventTypes(['revision.requested']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          const p = event.payload as { agent: string; round: number; operations: ImageOp[] };
          if (p.agent !== name) return;
          const operationIds = p.operations.map((o) => o.id);
          const assets: AssetRecord[] = [];
          const supersedes: string[] = [];
          const results: { id: string; ok: boolean; note: string }[] = [];
          for (const op of p.operations) {
            const base = currentBase(env, op.conceptId);
            const prompt = prompts.get(op.conceptId);
            if (!tools.images || !base || base.source !== 'ai_image' || !prompt || !settings.imageModel) {
              results.push({ id: op.id, ok: false, note: 'There is no generated image to regenerate for this concept.' });
              continue;
            }
            const res = await tools.images.generate(`${prompt}\nImprove on the previous attempt: ${clean(env.board.findings.filter((f) => op.findingIds.includes(f.id)).map((f) => f.suggestedCorrection).join(' '), 300)}`, { model: settings.imageModel, quality: settings.imageQuality, size: settings.imageSize }, { regeneration: true, signal: self.signal });
            if (!res.ok) {
              results.push({ id: op.id, ok: false, note: errNote(res.error) });
              continue;
            }
            const rec = await tools.assets.save({ kind: 'image', conceptId: op.conceptId, channel: null, format: null, version: base.version + 1, parentAssetId: base.id, mimeType: res.mimeType, width: res.width, height: res.height, source: 'ai_image', model: settings.imageModel, quality: settings.imageQuality, requestedSize: settings.imageSize, status: 'generated', flags: [], altText: base.altText, promptMetadata: base.promptMetadata, usage: res.usage, data: res.bytes });
            await tools.assets.markSuperseded(base.id);
            assets.push(rec);
            supersedes.push(base.id);
            results.push({ id: op.id, ok: true, note: 'Regenerated as a new version; the original is kept.' });
          }
          const ok = results.some((r) => r.ok);
          ctx.emit('revision.applied', { owner: name, round: p.round, operationIds, status: ok ? 'applied' : 'failed', note: ok ? `${assets.length} image(s) regenerated.` : (results[0]?.note ?? 'Nothing regenerated.'), patch: { kind: 'image', assets, supersedes, results } }, self.participant);
        }),
      },
    ];
  });
}

// ---- A21 Layout Designer ----------------------------------------------------------------------------------------------------------

export function buildLayout(env: F4Env): PhaseAgent {
  const { ctx, settings, tools } = env;
  const name = CREATIVE_INFO.layout.name;
  const visual = CREATIVE_INFO.visual.name;
  const started = new Set<string>();
  const done = new Set<string>();
  let rendered = 0;

  return new PhaseAgent(env, { key: 'layout', name, instruction: 'Deterministic layout designer. Renders channel formats from the base images with a layout tool. Performs no inference.', capabilities: ['creative-production', 'layout', 'sharp', 'deterministic'] }, (self) => {
    const finishIfDone = () => {
      if (!self.isTaskOpen() || done.size < env.board.concepts.length || !env.board.concepts.length) return;
      self.closeTask();
      ctx.emit('task.completed', rendered > 0 ? { agent: name, outcome: 'succeeded' } : { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message: 'No channel layout could be rendered.' } }, self.participant);
    };

    const renderConcept = async (conceptId: string, given: AssetRecord | null) => {
      if (started.has(conceptId) || !self.isTaskOpen()) return;
      started.add(conceptId);
      const layouts: LayoutRecord[] = [];
      const assets: AssetRecord[] = [];
      const skipped: SkippedLayout[] = [];
      try {
        let base = given;
        if (!base) {
          base = await saveGradientBase(env, conceptId);
          assets.push(base);
        }
        const baseBuf = base.source === 'ai_image' ? await tools.assets.load(base.id) : null;
        for (const { format, channel } of settings.formats) {
          if (self.signal.aborted) break;
          const variant = pickVariant(env.board.variants, conceptId, channel) ?? env.board.variants.find((v) => v.conceptId === conceptId);
          if (!variant) {
            skipped.push({ conceptId, format: format.id, channel, reason: 'There is no copy for this concept to place on the layout.' });
            continue;
          }
          const res = await renderLayout({ base: baseBuf, format, headline: variant.headline, body: supportingText(variant), ctaText: variant.ctaText, palette: env.palette, logo: env.logo });
          if (!res.ok) {
            skipped.push({ conceptId, format: format.id, channel, reason: res.reason });
            continue;
          }
          const rec = await tools.assets.save({ kind: 'layout', conceptId, channel, format: format.id, version: 1, parentAssetId: base.id, mimeType: 'image/png', width: res.width, height: res.height, source: base.source, model: base.model, quality: base.quality, requestedSize: null, status: 'rendered', flags: res.flags, altText: clean(variant.headline, 200), promptMetadata: null, usage: null, data: res.png });
          assets.push(rec);
          layouts.push({ id: `layout-${rec.id}`, conceptId, variantId: variant.id, assetId: rec.id, baseAssetId: base.id, format: format.id, channel, headline: variant.headline, ctaText: variant.ctaText, flags: res.flags });
          rendered++;
        }
      } catch {
        for (const { format, channel } of settings.formats) if (!layouts.some((l) => l.format === format.id)) skipped.push({ conceptId, format: format.id, channel, reason: 'The layout could not be rendered.' });
      }
      if (ctx.isClosed() || !self.isTaskOpen()) return;
      ctx.emit('layout.completed', { agent: name, conceptId, assets, layouts, skipped }, self.participant);
      done.add(conceptId);
      finishIfDone();
    };

    return [
      {
        specification: new OnEventTypes(['task.assigned']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          if ((event.payload as { agent: string }).agent !== name) return;
          self.openTask(settings.productionTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
        }),
      },
      {
        // Visual Creator -> Layout Designer: a base image exists; its layouts can be rendered (concurrently with the other concepts).
        specification: new OnEventTypes(['visual.generated']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { conceptId: string; asset: AssetRecord };
          void renderConcept(p.conceptId, p.asset).catch((e) => ctx.fail(e, name));
        }),
      },
      {
        // The Visual Creator ended (or was skipped / failed): every concept without a base image gets a brand-colored one.
        specification: new OnEventTypes(['task.completed']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { agent: string };
          if (p.agent !== visual) return;
          for (const c of env.board.concepts) if (!started.has(c.id)) void renderConcept(c.id, null).catch((e) => ctx.fail(e, name));
        }),
      },
      {
        // Fixer -> Layout Designer (second wave): re-render with adjusted parameters; the original assets are kept.
        specification: new OnEventTypes(['revision.requested']),
        processor: guarded(ctx.guard(name), async ({ event }) => {
          const p = event.payload as { agent: string; round: number; operations: LayoutOp[] };
          if (p.agent !== name) return;
          const assets: AssetRecord[] = [];
          const layouts: LayoutRecord[] = [];
          const supersedes: string[] = [];
          const results: { id: string; ok: boolean; note: string; before?: string | null; after?: string | null }[] = [];
          for (const op of p.operations) {
            try {
              const variant = env.board.variants.find((v) => v.id === op.variantId);
              const format = settings.formats.find((f) => f.format.id === op.format)?.format;
              const base = currentBase(env, op.conceptId);
              if (!variant || !format || !base) {
                results.push({ id: op.id, ok: false, note: 'The copy, format or base image is no longer available.' });
                continue;
              }
              const baseBuf = base.source === 'ai_image' ? await tools.assets.load(base.id) : null;
              const res = await renderLayout({ base: baseBuf, format, headline: variant.headline, body: op.overrides.hideBody ? null : supportingText(variant), ctaText: variant.ctaText, palette: env.palette, logo: env.logo, overrides: op.overrides as LayoutOverrides });
              if (!res.ok) {
                results.push({ id: op.id, ok: false, note: res.reason });
                continue;
              }
              const old = env.board.layouts.find((l) => l.conceptId === op.conceptId && l.format === op.format && l.variantId === op.variantId);
              const oldAsset = old ? env.board.assets.find((a) => a.id === old.assetId) : undefined;
              const rec = await tools.assets.save({ kind: 'layout', conceptId: op.conceptId, channel: op.channel, format: op.format, version: (oldAsset?.version ?? 0) + 1, parentAssetId: base.id, mimeType: 'image/png', width: res.width, height: res.height, source: base.source, model: base.model, quality: base.quality, requestedSize: null, status: 'rendered', flags: res.flags, altText: clean(variant.headline, 200), promptMetadata: null, usage: null, data: res.png });
              if (oldAsset) {
                await tools.assets.markSuperseded(oldAsset.id);
                supersedes.push(oldAsset.id);
              }
              assets.push(rec);
              layouts.push({ id: `layout-${rec.id}`, conceptId: op.conceptId, variantId: op.variantId, assetId: rec.id, baseAssetId: base.id, format: op.format, channel: op.channel, headline: variant.headline, ctaText: variant.ctaText, flags: res.flags });
              results.push({ id: op.id, ok: true, note: 'Rendered again; the earlier version is kept.', before: oldAsset ? `${oldAsset.id} (v${oldAsset.version})` : null, after: `${rec.id} (v${rec.version})` });
            } catch {
              results.push({ id: op.id, ok: false, note: 'The layout could not be rendered.' });
            }
          }
          const ok = results.some((r) => r.ok);
          ctx.emit('revision.applied', { owner: name, round: p.round, operationIds: p.operations.map((o) => o.id), status: ok ? 'applied' : 'failed', note: `${results.filter((r) => r.ok).length} of ${results.length} layout(s) re-rendered.`, patch: { kind: 'layout', assets, layouts, supersedes, results } }, self.participant);
        }),
      },
    ];
  });
}

// ---- A23 Content & Brand Reviewer --------------------------------------------------------------------------------------------------

const BLOCKER_KINDS = new Set(['unsupported_claim', 'factual_error']);

export function buildReviewer(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.reviewer.name;
  return new PhaseAgent(env, { key: 'reviewer', name, instruction: CREATIVE_INSTRUCTIONS.reviewer, capabilities: ['creative-production', 'quality-review', 'vision', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['review.requested']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        const p = event.payload as { round: number; scope: { variantIds: string[]; assetIds: string[]; landing: boolean } };
        const snap = env.board.snapshot();
        // 1. deterministic checks (no model): what code can prove
        const det: RawFinding[] = dedupe([
          ...claimFindings({ board: snap, f1: env.f1, f3: env.f3 }),
          ...consistencyFindings(snap),
          ...assetFindings({ board: snap, hasLogo: !!env.logo, hasPalette: env.hasBrandPalette, imageGeneration: settings.imageGeneration }),
        ]);
        const known = new Set([...snap.assets.map((a) => a.id), ...snap.variants.map((v) => v.id), ...snap.concepts.map((c) => c.id), 'landing']);
        const ownerOf = (ref: string | null, claimed: RawFinding['responsibleAgent']): RawFinding['responsibleAgent'] => (ref === 'landing' ? 'landing' : ref && snap.variants.some((v) => v.id === ref) ? 'copywriter' : claimed);
        const toRaw = (i: ReviewOutput['issues'][number], source: 'llm_text' | 'llm_vision'): RawFinding => {
          const assetRef = i.assetRef && known.has(i.assetRef) ? i.assetRef : null;
          // Subjective judgments never block: only an invented or forbidden claim can be a blocker.
          const severity = i.severity === 'blocker' && !(source === 'llm_text' && BLOCKER_KINDS.has(i.kind)) ? 'major' : i.severity;
          return { kind: i.kind, severity, assetRef, finding: clean(i.finding, 300), evidence: clean(i.evidence, 300), suggestedCorrection: clean(i.suggestedCorrection, 300), responsibleAgent: ownerOf(assetRef, i.responsibleAgent), source };
        };
        const llm: RawFinding[] = [];
        const summaries: string[] = [];
        let attempted = 0;
        let failed = 0;
        const left = () => settings.maxModelCalls - env.gateway.usage().callsStarted;

        const run = <T>(job: JobSpec<T>) =>
          new Promise<void>((resolve) =>
            self.runJob({
              ...job,
              onSuccess: (v: T) => {
                job.onSuccess(v);
                resolve();
              },
              onFailure: (e: SafeProviderError) => {
                job.onFailure(e);
                resolve();
              },
            }),
          );
        // 2. the text review
        if ((p.scope.variantIds.length || p.scope.landing) && left() >= 1) {
          attempted++;
          await run({
            kind: 'review',
            message: reviewTextMessage(env.f1, env.f3, env.input, snap, det, { variantIds: p.scope.variantIds, landing: p.scope.landing }),
            schema: ReviewOutput,
            schemaName: 'creative_review',
            maxOutputTokens: settings.reviewTokens,
            timeoutMs: settings.reviewTimeoutMs,
            onSuccess: (out: ReviewOutput) => {
              summaries.push(out.summary);
              llm.push(...out.issues.slice(0, 6).map((i) => toRaw(i, 'llm_text')));
            },
            onFailure: () => failed++,
          });
        }
        // 3. the vision review of exported assets (only when the user enabled it and the budget allows)
        const shown = snap.layouts.filter((l) => p.scope.assetIds.includes(l.assetId)).slice(0, settings.visionReviews);
        if (settings.visionReviews > 0 && shown.length && left() >= 1 && !ctx.isClosed()) {
          attempted++;
          try {
            const images = await Promise.all(shown.map(async (l) => ({ mediaType: 'image/jpeg', base64: (await sharp(await env.tools.assets.load(l.assetId)).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer()).toString('base64') })));
            await run({
              kind: 'review',
              message: reviewVisionMessage(env.input, snap, shown.map((l) => ({ assetId: l.assetId, format: l.format, channel: l.channel, conceptId: l.conceptId, headline: l.headline, flags: l.flags })), env.f3),
              schema: ReviewOutput,
              schemaName: 'creative_vision_review',
              maxOutputTokens: settings.reviewTokens,
              timeoutMs: settings.reviewTimeoutMs,
              images,
              onSuccess: (out: ReviewOutput) => {
                summaries.push(out.summary);
                llm.push(...out.issues.slice(0, 4).map((i) => toRaw(i, 'llm_vision')));
              },
              onFailure: () => failed++,
            });
          } catch {
            failed++;
          }
        }
        if (ctx.isClosed()) return;
        const modelReview = attempted === 0 ? 'skipped' : failed === 0 ? 'done' : failed === attempted ? 'failed' : 'partial';
        const findings = dedupe([...det, ...llm]);
        const summary = `${det.length} automatic check finding(s) and ${llm.length} reviewer finding(s)${modelReview === 'skipped' ? ' (no model review in this round)' : modelReview === 'failed' ? ' (the model review failed; only the automatic checks ran)' : ''}. ${summaries.join(' ')}`.trim().slice(0, 900);
        ctx.emit('review.completed', { agent: name, round: p.round, findings, summary, modelReview }, self.participant);
      }),
    },
  ]);
}

// ---- A24 Fixer ---------------------------------------------------------------------------------------------------------------------------

export function buildFixer(env: F4Env): PhaseAgent {
  const { ctx, settings, tools } = env;
  const name = CREATIVE_INFO.fixer.name;
  const owners = { copywriter: CREATIVE_INFO.copywriter.name, landing: CREATIVE_INFO.landing.name, layout: CREATIVE_INFO.layout.name, visual: CREATIVE_INFO.visual.name };

  interface Outcome {
    ok: boolean;
    note: string;
    before?: string | null;
    after?: string | null;
  }
  interface State {
    round: number;
    plan: ReturnType<typeof planRepairs>;
    findings: ReviewFindingRecord[];
    waiting: Set<string>;
    outcomes: Map<string, Outcome>;
    opIds: Map<string, string>; // opKey -> operation id
    timer?: NodeJS.Timeout;
    wave: 1 | 2;
    seq: number;
  }
  let st: State | null = null;

  return new PhaseAgent(env, { key: 'fixer', name, instruction: 'Fixer. Turns review findings into repair requests for the owners of the deliverables; makes no model call.', capabilities: ['creative-production', 'repair', 'revision-requests', 'deterministic'] }, (self) => {
    const nextId = () => `O${st!.round}.${++st!.seq}`;

    const armTimer = () => {
      st!.timer = ctx.setTimer(settings.repairTimeoutMs + 5_000, () => {
        if (!st) return;
        for (const id of st.waiting) st.outcomes.set(id, { ok: false, note: 'The owner did not answer in time.' });
        st.waiting.clear();
        advance();
      });
    };

    const send = (owner: string, operations: { id: string }[]) => {
      for (const o of operations) st!.waiting.add(o.id);
      ctx.emit('revision.requested', { agent: owner, round: st!.round, wave: st!.wave, operations }, self.participant);
    };

    const complete = () => {
      const s = st!;
      const round = s.round;
      if (s.timer) ctx.clearTimer(s.timer);
      const results = s.plan.byFinding.map((fp) => {
        const opId = fp.opKey ? s.opIds.get(fp.opKey) : undefined;
        const o = opId ? s.outcomes.get(opId) : undefined;
        const variantId = fp.opKey?.startsWith('copy:') ? fp.opKey.slice(5) : null;
        const v = variantId ? env.board.variants.find((x) => x.id === variantId) : undefined;
        const prev = v?.history[v.history.length - 1];
        const status = fp.operation === 'none' ? ('skipped' as const) : o?.ok ? ('applied' as const) : ('failed' as const);
        return {
          round: s.round,
          findingId: fp.findingId,
          operation: fp.operation,
          owner: fp.owner,
          status,
          before: prev ? `${prev.headline} — ${prev.body}`.slice(0, 300) : (o?.before ?? null),
          after: v && prev ? `${v.headline} — ${v.body}`.slice(0, 300) : (o?.after ?? null),
          note: fp.operation === 'none' ? fp.note : (o?.note ?? 'No answer.'),
        };
      });
      st = null;
      ctx.emit('revision.completed', { agent: name, round, results }, self.participant);
    };

    /** Wave 1 -> wave 2 -> done. Wave 2 (layouts) reads the board AFTER wave 1 was committed by the coordinator. */
    const advance = () => {
      const s = st;
      if (!s || s.waiting.size) return;
      if (s.timer) ctx.clearTimer(s.timer);
      if (s.wave === 1) {
        s.wave = 2;
        const okCopy = [...s.plan.copy.keys()].filter((v) => s.outcomes.get(s.opIds.get(`copy:${v}`) ?? '')?.ok);
        const okImages = [...s.plan.images.keys()].filter((c) => s.outcomes.get(s.opIds.get(`image:${c}`) ?? '')?.ok);
        const ops = layoutOperations(env.board.snapshot(), s.plan, { variantIds: okCopy, conceptIds: okImages }, nextId);
        if (ops.length) {
          for (const o of ops) s.opIds.set(`layout:${o.conceptId}|${o.format}|${o.variantId}`, o.id);
          send(owners.layout, ops);
          armTimer();
          return;
        }
      }
      complete();
    };

    return [
      {
        // Review -> Fixer: the findings arrive through shared state; the Fixer picks the repair for each one.
        specification: new OnEventTypes(['fix.requested']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const p = event.payload as { round: number; findingIds: string[] };
          const findings = env.board.findings.filter((f) => p.findingIds.includes(f.id));
          const canRegenerate = settings.allowRegeneration && !!tools.images?.regenerationAllowed;
          const plan = planRepairs(env.board.snapshot(), findings, { canRegenerate, formats: settings.formats, owners });
          st = { round: p.round, plan, findings, waiting: new Set(), outcomes: new Map(), opIds: new Map(), wave: 1, seq: 0 };
          const copyOps: CopyOp[] = [];
          if (plan.copy.size) {
            const op: CopyOp = { id: nextId(), kind: 'revise_copy', findingIds: [...new Set([...plan.copy.values()].flatMap((s) => [...s]))], variantIds: [...plan.copy.keys()] };
            for (const v of plan.copy.keys()) st.opIds.set(`copy:${v}`, op.id);
            copyOps.push(op);
          }
          const landingOps: LandingOp[] = [];
          if (plan.landing.size) {
            const op: LandingOp = { id: nextId(), kind: 'revise_landing', findingIds: [...plan.landing] };
            st.opIds.set('landing', op.id);
            landingOps.push(op);
          }
          const imageOps: ImageOp[] = [...plan.images].map(([conceptId, ids]) => {
            const op: ImageOp = { id: nextId(), kind: 'regenerate_image', conceptId, findingIds: [...ids] };
            st!.opIds.set(`image:${conceptId}`, op.id);
            return op;
          });
          if (copyOps.length) send(owners.copywriter, copyOps);
          if (landingOps.length) send(owners.landing, landingOps);
          if (imageOps.length) send(owners.visual, imageOps);
          if (st.waiting.size) armTimer();
          else advance();
        }),
      },
      {
        specification: new OnEventTypes(['revision.applied']),
        processor: guarded(ctx.guard(name), ({ event }) => {
          const s = st;
          const p = event.payload as { round: number; operationIds: string[]; status: 'applied' | 'failed'; note: string; patch: { results?: { id: string; ok: boolean; note: string; before?: string | null; after?: string | null }[] } | null };
          if (!s || p.round !== s.round) return;
          for (const id of p.operationIds) {
            if (!s.waiting.has(id)) continue;
            const r = p.patch?.results?.find((x) => x.id === id);
            s.outcomes.set(id, r ?? { ok: p.status === 'applied', note: p.note });
            s.waiting.delete(id);
          }
          advance();
        }),
      },
    ];
  });
}
