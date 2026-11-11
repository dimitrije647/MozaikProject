import { toSafeError } from '../../../ai/errors';
import { CREATIVE_INFO } from '../../../creative/board';
import { paletteKeyOf } from '../../../collections/design';
import { buildSearchIntents, type IntentContext } from '../../../imagery/discovery';
import type { DiscoverySummary } from '../../../hybrid/records';
import { directionFor, industryTextOf, lockDesign } from '../../../hybrid/direction';
import { contentForSlot } from '../../../hybrid/content';
import { DirectionRefinement, RESEARCHER_INSTRUCTION, SELECTOR_INSTRUCTION, TemplatePicks, directionRefineMessage, selectionMessage } from '../../../hybrid/prompts';
import { verifyTemplateExport } from '../../../hybrid/quality';
import type { TemplateContent } from '../../../hybrid/records';
import { applyAssisted, selectTemplates, type SelectionResult, type SelectorContext } from '../../../hybrid/selector';
import { VisualDirectionBrief } from '../../../templates/schema';
import { visualDirectionSummary } from '../../../templates/visual-direction';
import { OnEventTypes, guarded } from '../../run-context';
import { PhaseAgent } from '../f1/agent';
import type { F4Env } from './env';
import { sourceImages } from './image-sourcing';

/** Model calls kept free for the copy, the reviews and the repairs that follow. */
const RESERVE_CALLS = 8;

/** The Visual Direction Brief as it stands: the researcher's published one, else the deterministic one (never empty). */
export function currentDirection(env: F4Env): VisualDirectionBrief {
  if (env.board.direction) return env.board.direction;
  const hs = env.settings.hybrid!;
  return directionFor({ visualBrief: env.visualBrief, projectName: env.input.projectName, channels: env.input.channels, palette: env.palette, hasBrandPalette: env.hasBrandPalette, settings: hs, referencePalettes: env.hybrid!.referencePalettes });
}

/** Everything the deterministic selector needs, from the run's own state. */
export function selectorContext(env: F4Env, direction: VisualDirectionBrief = currentDirection(env)): SelectorContext {
  const hs = env.settings.hybrid!;
  const hy = env.hybrid!;
  return {
    direction,
    industryText: hy.industryText,
    objectiveText: env.visualBrief.campaignGoal,
    palette: env.palette,
    hasLogo: !!env.logo,
    brandImageCount: hy.brandImages.length,
    brandName: hy.brandName,
    facts: hs.facts,
    library: hy.library,
    preferred: [...hs.preferredTemplates, ...(hy.design?.preferredTemplates ?? [])],
    overrides: hs.overrides,
    mode: hs.selection,
    basis: 'concepts',
    design: hy.design,
    collection: hy.collection,
    // the stars the user gave inside the collection are a soft preference; the design's own list wins when present
  };
}

/** A bounded, secret-free summary of a discovery result for the report and the review screen. */
export function summarizeDiscovery(d: import('../../../imagery/types').DiscoveryResult): DiscoverySummary {
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

/** The content of every planned slot from the real copy (a concept without copy has none: nothing is invented for it). */
export function slotContents(env: F4Env) {
  const plan = env.board.hybridPlan!;
  const contents = new Map<string, TemplateContent>();
  const missing: string[] = [];
  for (const slot of plan.slots) {
    const c = contentForSlot(slot, env.board.concepts, env.board.variants);
    if (c) contents.set(slot.slotId, c);
    else missing.push(slot.slotId);
  }
  return { contents, missing };
}

// ---- A25 Visual Researcher ------------------------------------------------------------------------------------------------------

export function buildResearcher(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.researcher.name;
  const hs = settings.hybrid!;
  return new PhaseAgent(env, { key: 'researcher', name, instruction: RESEARCHER_INSTRUCTION, capabilities: ['creative-production', 'visual-research', 'style-library', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        const base = directionFor({ visualBrief: env.visualBrief, projectName: env.input.projectName, channels: env.input.channels, palette: env.palette, hasBrandPalette: env.hasBrandPalette, settings: hs, referencePalettes: env.hybrid!.referencePalettes });
        const design = env.hybrid!.design;
        const collection = env.hybrid!.collection;
        let discovery: DiscoverySummary | null = null;
        const publish = (direction: VisualDirectionBrief, refined: boolean, note: string) => {
          if (!self.isTaskOpen()) return;
          self.closeTask();
          // the approved design is locked into whatever was published: a refinement can sharpen the brief, never replace the collection or the palette
          const locked = design && collection ? lockDesign(direction, design, collection) : direction;
          const discoveryLine = discovery ? ` Web visual discovery: ${discovery.licensed.length} licensed candidate(s) and ${discovery.references.length} reference link(s) found; none was added to the campaign.` : '';
          // the brand material the owner approved with Get Content is part of what the direction was made with (counts only: no text from the outside is passed on)
          const brandLine = env.brand ? ` Approved brand content: ${env.brand.logo ? 'the official logo' : 'no logo'} and ${env.brand.approvedPhotos} approved photograph(s); the template choice and the layouts use them.` : '';
          ctx.emit('finding.posted', { agent: name, summary: `${visualDirectionSummary(locked)}${discoveryLine}${brandLine}`.slice(0, 900), findings: [], missingInformation: locked.limitations }, self.participant);
          ctx.emit('visual.direction.published', { agent: name, direction: locked, refined, note, ...(discovery ? { discovery } : {}) }, self.participant);
          ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
        };
        // web visual discovery first (free of OpenAI cost; configured providers only), then the direction is published; a failure here never blocks the campaign
        const discover = async () => {
          const port = env.hybrid!.discovery;
          // NO AI HYBRID searches providers only in the sourcing step (after the concepts exist, and only in automatic stock mode)
          if (!port || env.settings.noAiImages) return;
          try {
            const ctxIntent: IntentContext = { business: env.visualBrief.business || env.input.projectName, offering: env.visualBrief.offering, valueProposition: env.visualBrief.valueProposition, audience: env.visualBrief.audience.primary, imageSubjects: base.imageSubjects, mood: base.mood, formatClasses: undefined };
            if (!buildSearchIntents(ctxIntent).length) return;
            const result = await Promise.race([port(ctxIntent), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
            if (result) discovery = summarizeDiscovery(result);
          } catch {
            discovery = null;
          }
        };
        return void discover().then(() => proceed());
        function proceed() {
        if (!hs.directionRefine) return publish(base, false, 'The brief comes from the style library, the brand and the strategy (model refinement is switched off).');
        if (settings.maxModelCalls - env.gateway.usage().callsStarted < RESERVE_CALLS) return publish(base, false, 'Not refined: too few text-model calls were left for the rest of the run.');
        const userStyle = collection ? collection.styleId : hs.style === 'auto' ? null : hs.style;
        self.runJob({
          kind: 'analysis',
          priority: 5, // an optional refinement of a brief that already exists
          message: directionRefineMessage(env.visualBrief, base, userStyle),
          schema: DirectionRefinement,
          schemaName: 'visual_direction',
          maxOutputTokens: Math.min(settings.analystTokens, 2200),
          onSuccess: (out) => {
            // a style the USER picked cannot be overridden; a style the model picked in auto mode rebuilds colors and fonts from that style
            const styleId = userStyle ?? out.styleId;
            const root = styleId !== base.styleId ? directionFor({ visualBrief: env.visualBrief, projectName: env.input.projectName, channels: env.input.channels, palette: env.palette, hasBrandPalette: env.hasBrandPalette, settings: hs, referencePalettes: env.hybrid!.referencePalettes, forceStyle: styleId }) : base;
            const merged = VisualDirectionBrief.safeParse({
              ...root,
              secondaryStyleIds: out.secondaryStyleIds.filter((s) => s !== styleId).slice(0, 2),
              rationale: out.rationale || root.rationale,
              composition: out.composition.length ? out.composition : root.composition,
              mood: out.mood.length ? out.mood : root.mood,
              imageSubjects: out.imageSubjects.length ? out.imageSubjects : root.imageSubjects,
              imageTreatment: out.imageTreatment.length ? out.imageTreatment : root.imageTreatment,
              channelNotes: out.channelNotes.length ? out.channelNotes : root.channelNotes,
              origin: 'model_refined',
              limitations: [...root.limitations, ...out.limitations].slice(0, 8),
            });
            if (merged.success) publish(merged.data, true, 'Refined by one text-model call; palette, fonts and references were kept exactly as the brand and the library set them.');
            else publish(base, false, 'The refinement was not valid, so the deterministic brief was used.');
          },
          onFailure: (error) => publish(base, false, `The refinement did not complete (${error.message}); the deterministic brief was used.`),
        });
        }
      }),
    },
    {
      // Coordinator -> Visual Researcher (NO AI HYBRID): the concepts and the creative plan exist; source the pictures and decide which one each creative uses
      specification: new OnEventTypes(['images.sourcing.requested']),
      processor: guarded(ctx.guard(name), async () => {
        if (!env.settings.noAiImages || ctx.isClosed()) return;
        await Promise.resolve(); // never answer inside the requester's own emit
        try {
          const outcome = await sourceImages(env, { refused: () => env.imageRefusals.count });
          if (ctx.isClosed()) return;
          env.hybrid!.brandImages = outcome.library;
          ctx.emit('finding.posted', { agent: name, summary: outcome.summary.slice(0, 900), findings: [], missingInformation: outcome.imagery.notes.slice(0, 5) }, self.participant);
          ctx.emit('images.sourced', { agent: name, summary: outcome.summary, sourcing: { imagery: outcome.imagery, allocation: outcome.allocation, discovery: outcome.discovery ? summarizeDiscovery(outcome.discovery) : null } }, self.participant);
        } catch {
          if (ctx.isClosed()) return;
          // sourcing failed: nothing is guessed. The creatives are text-first and the campaign says why.
          ctx.emit('images.sourced', { agent: name, summary: 'Picture sourcing failed, so every creative is text-first.', sourcing: null }, self.participant);
        }
      }),
    },
  ]);
}

// ---- A26 Template Selector -------------------------------------------------------------------------------------------------------

export function buildSelector(env: F4Env): PhaseAgent {
  const { ctx, settings } = env;
  const name = CREATIVE_INFO.selector.name;
  const hs = settings.hybrid!;
  return new PhaseAgent(env, { key: 'selector', name, instruction: SELECTOR_INSTRUCTION, capabilities: ['creative-production', 'template-selection', 'deterministic-scoring', 'inference'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.agentTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        const fail = (message: string) => {
          if (!self.isTaskOpen()) return;
          self.closeTask();
          ctx.emit('task.completed', { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message } }, self.participant);
        };
        const plan = env.board.hybridPlan;
        if (!plan) return fail('There is no hybrid plan to select templates for.');
        if (!plan.slots.length) {
          self.closeTask();
          ctx.emit('template.selection.completed', { agent: name, plan: { mode: hs.selection, basis: 'concepts', styleId: currentDirection(env).styleId, libraryCount: env.hybrid!.library.length, eligibleCount: 0, items: [], byTemplate: {}, byCategory: {}, rules: [], warnings: [] }, mode: hs.selection, modelAssisted: false, note: 'No template creatives were requested.' }, self.participant);
          return void ctx.emit('task.completed', { agent: name, outcome: 'skipped', reason: 'No template creatives were requested.' }, self.participant);
        }
        const { contents, missing } = slotContents(env);
        const sctx = selectorContext(env);
        const result = selectTemplates({ slots: plan.slots.filter((s) => contents.has(s.slotId)), contents, ctx: sctx });
        for (const id of missing) result.plan.warnings.push(`${id}: the concept has no copy to place on a template, so no creative was planned for it.`);
        const finish = (sel: SelectionResult['plan'], modelAssisted: boolean, note: string) => {
          if (!self.isTaskOpen()) return;
          self.closeTask();
          ctx.emit('finding.posted', { agent: name, summary: `${sel.items.length} template creative(s) planned from ${sel.eligibleCount} eligible template(s) of ${sel.libraryCount}.`, findings: [], missingInformation: sel.warnings.slice(0, 5) }, self.participant);
          ctx.emit('template.selection.completed', { agent: name, plan: sel, mode: sel.mode, modelAssisted, note }, self.participant);
          if (!sel.items.length) ctx.emit('task.completed', { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message: 'No template in the library fits the planned creatives.' } }, self.participant);
          else ctx.emit('task.completed', { agent: name, outcome: 'succeeded' }, self.participant);
        };
        const callsLeft = settings.maxModelCalls - env.gateway.usage().callsStarted;
        if (hs.selection !== 'assisted' || !result.plan.items.length) return finish(result.plan, false, hs.selection === 'manual' ? 'Your choices were applied; every other creative was scored automatically.' : 'Chosen by deterministic scoring from the library (no model call).');
        if (callsLeft < RESERVE_CALLS) return finish(result.plan, false, 'Assisted selection was skipped (too few text-model calls were left); the deterministic choice was used.');
        const slots = result.plan.items.map((it) => ({ slot: plan.slots.find((s) => s.slotId === it.slotId)!, content: it.content, shortlist: result.shortlists.get(it.slotId) ?? [], current: it.templateId }));
        self.runJob({
          kind: 'analysis',
          priority: 5, // an optional refinement: the deterministic choice already exists
          message: selectionMessage({ direction: sctx.direction, slots, objective: sctx.objectiveText }),
          schema: TemplatePicks,
          schemaName: 'template_picks',
          maxOutputTokens: Math.min(settings.analystTokens, 2400),
          onSuccess: (out) => {
            const applied = applyAssisted(result, out.picks);
            if (applied.applied === 0) return finish(result.plan, false, `The model's picks were not used (${applied.rejected.slice(0, 2).join('; ') || 'no change'}); the deterministic choice stands.`);
            applied.plan.warnings.push(...applied.rejected.map((r) => `Model pick rejected: ${r}`));
            finish(applied.plan, true, `${applied.applied} pick(s) re-ranked by one text-model call from validated shortlists.`);
          },
          onFailure: (e) => finish(result.plan, false, `Assisted selection did not complete (${e.message}); the deterministic choice was used.`),
        });
      }),
    },
  ]);
}

// ---- A27 Template Quality Reviewer -----------------------------------------------------------------------------------------------

export function buildTemplateReviewer(env: F4Env): PhaseAgent {
  const { ctx, tools } = env;
  const name = CREATIVE_INFO.templateReviewer.name;
  return new PhaseAgent(env, { key: 'templateReviewer', name, instruction: 'Template quality reviewer. Opens every template creative and checks it against the plan; makes no model call.', capabilities: ['creative-production', 'quality-review', 'sharp', 'deterministic'] }, (self) => [
    {
      specification: new OnEventTypes(['template.quality.requested']),
      processor: guarded(ctx.guard(name), async () => {
        try {
          const hy = env.hybrid;
          const design = hy?.design && hy.collection ? { collectionId: hy.collection.id, collectionVersion: hy.collection.version, templateIds: hy.collection.templateIds, paletteKey: paletteKeyOf(hy.design.palette) } : null;
          const allowedSources = env.settings.noAiImages ? new Set((env.board.imagery?.library ?? []).map((l) => l.id)) : null;
          const report = await verifyTemplateExport({ allowedSources, design, selection: env.board.selection, creatives: env.board.templateCreatives, assets: env.board.assets, load: (id) => tools.assets.load(id) });
          if (ctx.isClosed()) return;
          ctx.emit('template.quality.completed', { agent: name, report }, self.participant);
        } catch (e) {
          if (ctx.isClosed()) return;
          ctx.emit('template.quality.completed', { agent: name, report: null, error: e instanceof Error ? e.message.slice(0, 160) : 'The check failed.' }, self.participant);
        }
      }),
    },
  ]);
}

