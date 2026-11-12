import sharp from 'sharp';
import { toSafeError, type SafeProviderError } from '../../../ai/errors';
import { CREATIVE_INFO } from '../../../creative/board';
import { assetFindings, channelFindings, claimFindings, conceptFindings, consistencyFindings, corpusOf, dedupe, scoreFindings, templateFindings, type RawFinding } from '../../../creative/checks';
import { copyCraftFindings } from '../../../copywriting/checks';
import { CREATIVE_INSTRUCTIONS, copyRevisionMessage, reviewTextMessage, reviewVisionMessage, writerMessage } from '../../../creative/prompts';
import { CopyOutput, CopyRevisionOutput, ReviewOutput, type Rubric } from '../../../creative/schemas';
import { paletteKeyOf } from '../../../collections/design';
import { directionFor } from '../../../hybrid/direction';
import { verifyTemplateExport } from '../../../hybrid/quality';
import type { DiscoverySummary, TemplateQualityReport } from '../../../hybrid/records';
import type { DiscoveryResult } from '../../../imagery/types';
import { visualDirectionSummary } from '../../../templates/visual-direction';
import { OnEventTypes, guarded } from '../../run-context';
import { PhaseAgent, type JobSpec } from '../f1/agent';
import type { F4Env } from './env';
import { sourceImages } from './image-sourcing';

/**
 * Three of the four F4 agents (the Creative Designer is in designer.ts). Each has ONE job and talks to the others only through the
 * Creative Coordinator's events; none writes the board.
 *   A3 Content Writer    task.assigned -> copy.proposed ; revision.requested -> revision.applied   (text model: 1 call + 1 per repair round)
 *   A4 Visual Researcher task.assigned -> images.sourced                                            (no model)
 *   A6 Quality Reviewer  review.requested -> review.completed                                       (text model: 1 call per round + optional vision)
 */

const clean = (s: string, max: number) => s.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const failedTask = (env: F4Env, self: PhaseAgent, name: string, error: SafeProviderError) => {
  self.closeTask();
  env.ctx.emit('task.completed', { agent: name, outcome: 'failed', error }, self.participant);
};

// ---- A3 Content Writer ----------------------------------------------------------------------------------------------------

/** One copy-revision request of the coordinator (from the Quality Reviewer's repair plan). */
export interface CopyOp {
  id: string;
  kind: 'revise_copy';
  variantIds: string[];
  findingIds: string[];
}

export function buildWriter(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.writer.name;
  return new PhaseAgent(env, { key: 'writer', name, instruction: CREATIVE_INSTRUCTIONS.writer, capabilities: ['creative-production', 'copywriting', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        self.runJob({
          kind: 'analysis',
          message: writerMessage(env.f1, env.f3, env.input, env.copyPlan),
          schema: CopyOutput,
          schemaName: 'campaign_copy',
          maxOutputTokens: settings.writerTokens,
          onSuccess: (out) => {
            self.closeTask();
            ctx.emit('copy.proposed', { agent: name, summary: out.summary, concepts: out.concepts, posts: out.posts, ads: out.ads, print: out.print, missingInformation: out.missingInformation }, self.participant);
            ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
          },
          onFailure: (error) => failedTask(env, self, name, error),
        });
      }),
    },
    {
      // Coordinator -> Content Writer: revise ONLY the named copy, with the review findings in hand.
      specification: new OnEventTypes(['revision.requested']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        const p = event.payload as { agent: string; round: number; operations: CopyOp[] };
        if (p.agent !== name) return;
        const operationIds = p.operations.map((o) => o.id);
        const variantIds = [...new Set(p.operations.flatMap((o) => o.variantIds))];
        const findingIds = new Set(p.operations.flatMap((o) => o.findingIds));
        const findings = env.board.findings.filter((f) => findingIds.has(f.id));
        const applied = (status: 'applied' | 'failed', note: string, patch: unknown) => ctx.emit('revision.applied', { owner: name, round: p.round, operationIds, status, note, patch }, self.participant);
        self.runJob({
          kind: 'review',
          message: copyRevisionMessage(env.input, env.board.snapshot(), findings, variantIds, env.copyPlan),
          schema: CopyRevisionOutput,
          schemaName: 'copy_revision',
          maxOutputTokens: settings.writerTokens,
          timeoutMs: settings.repairTimeoutMs,
          onSuccess: (out) => {
            const revisions = out.revisions.filter((r) => variantIds.includes(r.variantId));
            if (!revisions.length) return applied('failed', 'The Content Writer returned no usable revision.', null);
            const reason = findings.map((f) => f.finding).join(' | ').slice(0, 200);
            applied('applied', `${revisions.length} piece(s) of copy revised.`, { kind: 'copy', revisions: revisions.map((r) => ({ ...r, reason })) });
          },
          onFailure: (error) => applied('failed', error.message, null),
        });
      }),
    },
  ]);
}

// ---- A4 Visual Researcher -------------------------------------------------------------------------------------------------

/** A bounded, secret-free summary of a licensed picture search for the report. */
export function summarizeDiscovery(d: DiscoveryResult): DiscoverySummary {
  return {
    searchedAt: d.searchedAt,
    intents: d.intents.map((i) => ({ query: i.query, why: i.why })).slice(0, 6),
    providers: d.providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind, status: p.status, message: p.message, count: p.count })).slice(0, 8),
    licensed: d.licensed.slice(0, 12).map((c) => ({ provider: c.provider, id: c.id, title: c.title.slice(0, 140), pageUrl: c.pageUrl, creator: c.creator, license: c.license.license, licenseStatus: c.license.status, attribution: c.license.attribution })),
    references: d.references.slice(0, 8).map((c) => ({ provider: c.provider, title: c.title.slice(0, 140), pageUrl: c.pageUrl, platform: c.platform })),
    usedInCampaign: false,
    notes: d.notes.slice(0, 6),
  };
}

/** The visual direction of the campaign: the approved design locked in, built from the brand and the strategy (deterministic). */
export function campaignDirection(env: F4Env) {
  return directionFor({ visualBrief: env.visualBrief, projectName: env.input.projectName, channels: env.input.channels, palette: env.palette, hasBrandPalette: env.hasBrandPalette, settings: env.settings.visual, referencePalettes: env.hybrid.referencePalettes });
}

export function buildResearcher(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.researcher.name;
  const instruction = 'Visual Researcher. Builds the visual direction from the approved design, the brand and the strategy, then finds the pictures of the campaign: the approved library (uploads, approved website and repository pictures, licensed stock) and, in automatic stock mode, licensed pictures whose license is cleared. Records provenance and rights and decides which picture each creative uses. Never generates an image; makes no model call.';
  return new PhaseAgent(env, { key: 'researcher', name, instruction, capabilities: ['creative-production', 'visual-research', 'image-rights', 'deterministic'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.sourcingTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        await Promise.resolve(); // never answer inside the requester's own emit
        const direction = campaignDirection(env);
        let summary: string;
        let sourcing: unknown = null;
        try {
          const outcome = await sourceImages(env, direction);
          if (!self.isTaskOpen() || ctx.isClosed()) return;
          // the pictures that passed the rights gate (and nothing else) are what the Creative Designer may draw
          env.hybrid.brandImages = outcome.library;
          summary = outcome.summary;
          sourcing = { imagery: outcome.imagery, allocation: outcome.allocation, discovery: outcome.discovery ? summarizeDiscovery(outcome.discovery) : null };
          // the brand material the owner approved with Get Content is part of what the pictures were chosen from (counts only: no outside text is passed on)
          const brandLine = env.brand ? ` Approved brand content: ${env.brand.logo ? 'the official logo' : 'no logo'} and ${env.brand.approvedPhotos} approved photograph(s); the templates and layouts use them.` : '';
          ctx.emit('finding.posted', { agent: name, summary: `${visualDirectionSummary(direction)}${brandLine} ${summary}`.slice(0, 900), findings: [], missingInformation: outcome.imagery.notes.slice(0, 5) }, self.participant);
        } catch {
          if (!self.isTaskOpen() || ctx.isClosed()) return;
          summary = 'Picture sourcing failed; the pictures you already approved are used without a search.';
        }
        self.closeTask();
        ctx.emit('images.sourced', { agent: name, summary, sourcing, direction }, self.participant);
        ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
      }),
    },
  ]);
}

// ---- A6 Quality Reviewer --------------------------------------------------------------------------------------------------

const BLOCKER_KINDS = new Set(['unsupported_claim', 'factual_error']);

export function buildReviewer(env: F4Env): PhaseAgent {
  const { ctx, settings, tools } = env;
  const name = CREATIVE_INFO.reviewer.name;
  return new PhaseAgent(env, { key: 'reviewer', name, instruction: CREATIVE_INSTRUCTIONS.reviewer, capabilities: ['creative-production', 'quality-review', 'vision', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['review.requested']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        const p = event.payload as { round: number; scope: { variantIds: string[]; assetIds: string[] } };
        await Promise.resolve();
        // 1. the template side: every planned creative exists as a real file of the right size, from the collection, with cleared pictures only
        let templateQuality: TemplateQualityReport | null = null;
        try {
          const hy = env.hybrid;
          const design = hy.design && hy.collection ? { collectionId: hy.collection.id, collectionVersion: hy.collection.version, templateIds: hy.collection.templateIds, paletteKey: paletteKeyOf(hy.design.palette) } : null;
          templateQuality = await verifyTemplateExport({ allowedSources: new Set((env.board.imagery?.library ?? []).map((l) => l.id)), design, selection: env.board.selection, creatives: env.board.templateCreatives, assets: env.board.assets, load: (id) => tools.assets.load(id) });
        } catch {
          templateQuality = null;
        }
        if (ctx.isClosed()) return;
        const snap = { ...env.board.snapshot(), templateQuality: templateQuality ?? env.board.templateQuality };
        // 2. deterministic checks (no model): what code can prove
        const det: RawFinding[] = dedupe([
          ...claimFindings({ board: snap, f1: env.f1, f3: env.f3, language: env.input.language, allowedUrls: [env.input.websiteUrl] }),
          ...channelFindings(snap),
          ...consistencyFindings(snap),
          // copy craft against the copywriting plan: generic wording, false urgency, excluded principles, repetition, clarity, billboard
          ...copyCraftFindings({ variants: snap.variants.filter((v) => p.scope.variantIds.includes(v.id)), plan: env.copyPlan, corpus: corpusOf(env.f1, env.f3) }),
          ...(p.round === 1 ? conceptFindings(snap) : []),
          ...assetFindings({ board: snap, hasLogo: !!env.logo, hasPalette: env.hasBrandPalette }),
          ...templateFindings({ board: snap }),
        ]);
        const known = new Set([...snap.assets.map((a) => a.id), ...snap.variants.map((v) => v.id), ...snap.concepts.map((c) => c.id)]);
        const ownerOf = (ref: string | null, claimed: RawFinding['responsibleAgent']): RawFinding['responsibleAgent'] => (ref && snap.variants.some((v) => v.id === ref) ? 'copywriter' : claimed === 'landing' ? 'copywriter' : claimed);
        const toRaw = (i: ReviewOutput['issues'][number], source: 'llm_text' | 'llm_vision'): RawFinding => {
          const assetRef = i.assetRef && known.has(i.assetRef) ? i.assetRef : null;
          // subjective judgments never block: only an invented or forbidden claim can be a blocker
          const severity = i.severity === 'blocker' && !(source === 'llm_text' && BLOCKER_KINDS.has(i.kind)) ? 'major' : i.severity;
          return { kind: i.kind, severity, assetRef, finding: clean(i.finding, 300), evidence: clean(i.evidence, 300), suggestedCorrection: clean(i.suggestedCorrection, 300), responsibleAgent: ownerOf(assetRef, i.responsibleAgent), source };
        };
        const llm: RawFinding[] = [];
        const summaries: string[] = [];
        const skipped: { what: string; reason: string }[] = [];
        let scores: Rubric | null = null;
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
        // 3. ONE text review of the copy in scope
        if (p.scope.variantIds.length && left() < 1) skipped.push({ what: `text review (round ${p.round})`, reason: `no text-model call was left (limit ${settings.maxModelCalls})` });
        if (p.scope.variantIds.length && left() >= 1) {
          attempted++;
          await run({
            kind: 'review',
            message: reviewTextMessage(env.f1, env.f3, env.input, snap, det, p.scope.variantIds, env.copyPlan),
            schema: ReviewOutput,
            schemaName: 'campaign_review',
            maxOutputTokens: settings.reviewTokens,
            timeoutMs: settings.reviewTimeoutMs,
            onSuccess: (out: ReviewOutput) => {
              summaries.push(out.summary);
              llm.push(...out.issues.slice(0, 8).map((i) => toRaw(i, 'llm_text')));
              scores = out.scores ?? null;
              llm.push(...scoreFindings(scores, llm));
            },
            onFailure: () => failed++,
          });
        }
        // 4. a small sampled vision review of rendered creatives (one per deliverable kind first), only when enabled and affordable
        const inScope = snap.layouts.filter((l) => p.scope.assetIds.includes(l.assetId));
        const kindOf = (slotId: string | null | undefined) => snap.hybridPlan?.slots.find((s) => s.slotId === slotId)?.kind ?? 'social_post';
        const firstOfKind = inScope.filter((l, i, a) => a.findIndex((x) => kindOf(x.slotId) === kindOf(l.slotId)) === i);
        const shown = [...firstOfKind, ...inScope.filter((l) => !firstOfKind.includes(l))].slice(0, settings.visionReviews);
        if (settings.visionReviews > 0 && shown.length && left() < 1) skipped.push({ what: `vision review (round ${p.round})`, reason: `no text-model call was left (limit ${settings.maxModelCalls})` });
        if (settings.visionReviews > 0 && shown.length && left() >= 1 && !ctx.isClosed()) {
          attempted++;
          try {
            const images = await Promise.all(shown.map(async (l) => ({ mediaType: 'image/jpeg', base64: (await sharp(await tools.assets.load(l.assetId)).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer()).toString('base64') })));
            await run({
              kind: 'review',
              message: reviewVisionMessage(env.input, snap, shown.map((l) => ({ assetId: l.assetId, format: l.format, channel: l.channel, conceptId: l.conceptId, headline: l.headline, flags: l.flags })), env.f3),
              schema: ReviewOutput,
              schemaName: 'campaign_vision_review',
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
        } else if (!settings.visionReviews) skipped.push({ what: 'vision review of the rendered creatives', reason: 'switched off (visionReviews is 0); the creatives were checked by measurement only' });
        if (ctx.isClosed()) return;
        const modelReview = attempted === 0 ? 'skipped' : failed === 0 ? 'done' : failed === attempted ? 'failed' : 'partial';
        const findings = dedupe([...det, ...llm]);
        const summary = `${det.length} automatic check finding(s) and ${llm.length} reviewer finding(s)${modelReview === 'skipped' ? ' (no model review in this round)' : modelReview === 'failed' ? ' (the model review failed; only the automatic checks ran)' : ''}. ${summaries.join(' ')}`.trim().slice(0, 900);
        ctx.emit('review.completed', { agent: name, round: p.round, findings, summary, modelReview, scores, skipped, templateQuality }, self.participant);
      }),
    },
  ]);
}
