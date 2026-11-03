import type { SituationHandler } from '@mozaik-ai/core';
import { toSafeError } from '../../../ai/errors';
import { CREATIVE_INFO } from '../../../creative/board';
import type { AssetRecord, LayoutRecord, SkippedLayout } from '../../../creative/schemas';
import type { LayoutOverrides } from '../../../creative/layout';
import type { LayoutOp } from '../../../creative/repair';
import { paletteKeyOf } from '../../../collections/design';
import { renderContent } from '../../../hybrid/content';
import { exportEligibility, rightsSummary, uploadRights } from '../../../imagery/rights';
import { RIGHTS_BY_ORIGIN, type AssetOrigin, type TemplateCreativeRecord, type TemplateSelectionItem, type TemplateSelectionPlan } from '../../../hybrid/records';
import { selectTemplates } from '../../../hybrid/selector';
import { renderTemplate } from '../../../templates/render';
import type { TemplateDef } from '../../../templates/schema';
import { OnEventTypes, guarded } from '../../run-context';
import type { PhaseAgent } from '../f1/agent';
import type { F4Env } from './env';
import { currentDirection, selectorContext } from './hybrid-agents';

const clean = (s: string, max: number) => s.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The Layout Designer in HYBRID mode. It renders the TEMPLATE CREATIVES of the Template Selector's plan: each one from a library
 * template, the concept's copy, the brand colors and logo, and the picture it was planned for (the concept's original AI image, or a
 * brand image). Everything is local and deterministic: no model call, no cost. The originals themselves are delivered untouched.
 *
 *   - a creative is rendered as soon as its original exists (concurrently with the other originals still being generated)
 *   - if the original could not be generated, the creative is left out and the reason recorded; only when the user allowed it is it
 *     re-selected among picture-free templates and labelled FALLBACK
 *   - text that does not fit is handled before the result is accepted: the supporting line is dropped, then a roomier alternative
 *     template is tried; whatever remains is flagged for the reviewer
 */
export function hybridLayoutHandlers(env: F4Env, self: PhaseAgent, name: string): SituationHandler[] {
  const { ctx, settings, tools } = env;
  const hy = env.hybrid!;
  const hs = settings.hybrid!;
  const library = new Map<string, TemplateDef>(hy.library.map((t) => [t.id, t]));
  const visual = CREATIVE_INFO.visual.name;
  const selector = CREATIVE_INFO.selector.name;

  let plan: TemplateSelectionPlan | null = null;
  const originals = new Map<string, AssetRecord | 'failed'>(); // variationId -> the original, or 'failed'
  const started = new Set<string>();
  const resolved = new Set<string>();
  let inflight = 0;
  let visualFinished = false;
  let selectorFailed = false;
  let renderedCount = 0;

  // an image-only continuation: the earlier originals and the creatives that were rendered with their planned picture are already here
  for (const v of env.board.variations) {
    const a = v.status === 'generated' && v.generatedAssetId ? env.board.assets.find((x) => x.id === v.generatedAssetId) : undefined;
    if (a) originals.set(v.variationId, a);
  }
  if (env.seed && env.board.selection) {
    plan = env.board.selection;
    for (const tc of env.board.templateCreatives) {
      if (tc.status !== 'rendered' && tc.status !== 'fallback_rendered') continue;
      started.add(tc.slotId);
      resolved.add(tc.slotId);
      renderedCount++;
    }
  }

  const maybeFinish = () => {
    if (!self.isTaskOpen()) return;
    if (selectorFailed) {
      self.closeTask();
      return void ctx.emit('task.completed', { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message: 'No template selection was produced, so no template creative could be rendered.' } }, self.participant);
    }
    if (!plan || !visualFinished || inflight > 0) return;
    // creatives still waiting for an original that will never come
    for (const item of plan.items) if (!started.has(item.slotId) && !resolved.has(item.slotId)) void handleItem(item);
    if (inflight > 0) return;
    if (plan.items.some((i) => !resolved.has(i.slotId))) return;
    self.closeTask();
    ctx.emit('task.completed', plan.items.length === 0 || renderedCount > 0 ? { agent: name, outcome: 'succeeded' } : { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message: 'No template creative could be rendered.' } }, self.participant);
  };

  const record = (item: TemplateSelectionItem, status: TemplateCreativeRecord['status'], extra: Partial<TemplateCreativeRecord> = {}): TemplateCreativeRecord => ({
    slotId: item.slotId,
    conceptId: item.conceptId,
    templateId: item.templateId,
    templateName: item.templateName,
    templateVersion: item.templateVersion,
    variationId: item.variationId,
    channel: item.channel,
    format: item.format,
    width: item.width,
    height: item.height,
    status,
    collectionId: hy.collection?.id ?? null,
    collectionVersion: hy.collection?.version ?? null,
    paletteKey: hy.design ? paletteKeyOf(hy.design.palette) : null,
    assetId: null,
    sourceAssetIds: [],
    origin: null,
    flags: [],
    reason: null,
    ...extra,
  });

  const emitOutcome = (item: TemplateSelectionItem, tc: TemplateCreativeRecord, asset: AssetRecord | null, layout: LayoutRecord | null, skipped: SkippedLayout | null) => {
    resolved.add(item.slotId);
    if (tc.status === 'rendered' || tc.status === 'fallback_rendered') renderedCount++;
    if (ctx.isClosed() || !self.isTaskOpen()) return;
    ctx.emit('layout.completed', { agent: name, conceptId: item.conceptId, assets: asset ? [asset] : [], layouts: layout ? [layout] : [], skipped: skipped ? [skipped] : [], templateCreatives: [tc] }, self.participant);
  };

  type Attempt = { ok: true; asset: AssetRecord; layout: LayoutRecord; tc: TemplateCreativeRecord } | { ok: false; reason: string };

  /** Renders ONE creative (also used for repairs). `version` > 1 and `parent` make it a new version of an existing layout. */
  const renderItem = async (item: TemplateSelectionItem, o: { fallback: boolean; dropSupport?: boolean; version?: number; swapDepth?: number }): Promise<Attempt> => {
    let current = item;
    let dropSupport = o.dropSupport === true;
    const tried = new Set<string>([item.templateId]);
    type Tried = { error: string } | { error?: undefined; res: Awaited<ReturnType<typeof renderTemplate>>; tpl: TemplateDef; original: AssetRecord | null; sourceIds: string[]; heroFromBrand: { id: string } | null; rightsNote: string | null };
    const tryOnce = async (it: TemplateSelectionItem): Promise<Tried> => {
      const tpl = library.get(it.templateId);
      if (!tpl) return { error: `Template ${it.templateId} is not in the library.` };
      const original = it.variationId ? originals.get(it.variationId) : undefined;
      const sourceIds: string[] = [];
      let hero: Buffer | undefined;
      let secondary: Buffer | undefined;
      let heroFromBrand: { id: string } | null = null;
      let heroFocus: [number, number] | undefined;
      let rightsNote: string | null = null;
      if (settings.noAiImages) {
        // NO AI HYBRID: the picture is the one the allocation assigned to THIS creative, from the approved library, and nothing else. It is checked against
        // the rights gate here too: a picture that may not be exported is never drawn into a creative, whatever reached this point.
        const credits: string[] = [];
        const take = (id: string | null | undefined): { data: Buffer; analysisFocus: [number, number] | null; id: string } | { error: string } | null => {
          if (!id) return null;
          const b = hy.brandImages.find((x) => x.id === id);
          if (!b) return { error: `Its source picture (${id}) is not in the approved library.` };
          const info = b.library?.rights ?? uploadRights();
          const gate = exportEligibility(info);
          if (!gate.eligible) return { error: `Its source picture "${b.name}" may not be used in a creative: ${gate.reason}` };
          credits.push(rightsSummary(info));
          return { data: b.data, analysisFocus: b.library?.analysis?.focus ?? null, id: b.id };
        };
        if (!o.fallback) {
          const h = take(it.imageId);
          if (h && 'error' in h) return { error: h.error };
          if (h) {
            hero = h.data;
            heroFromBrand = { id: h.id };
            sourceIds.push(`brand:${h.id}`);
            heroFocus = it.focus ? [it.focus[0], it.focus[1]] : (h.analysisFocus ?? undefined);
          }
          if (tpl.layers.some((l) => l.type === 'image' && l.slot === 'secondary')) {
            const sec = take(it.secondaryImageId);
            if (sec && 'error' in sec) return { error: sec.error };
            if (sec) {
              secondary = sec.data;
              sourceIds.push(`brand:${sec.id}`);
            }
          }
        }
        if (credits.length) rightsNote = `Inherits the rights of its source picture(s): ${[...new Set(credits)].join(' | ')}`.slice(0, 240);
      } else if (!o.fallback && original && original !== 'failed') {
        hero = await tools.assets.load(original.id);
        sourceIds.push(original.id);
      } else if (!o.fallback && it.sourceKind === 'brand_image' && hy.brandImages.length) {
        const b = hy.brandImages[(it.index - 1) % hy.brandImages.length];
        hero = b.data;
        heroFromBrand = { id: b.id };
        sourceIds.push(`brand:${b.id}`);
      }
      if (!settings.noAiImages && tpl.layers.some((l) => l.type === 'image' && l.slot === 'secondary') && hy.brandImages.length) {
        const b = hy.brandImages.find((x) => !heroFromBrand || x.id !== heroFromBrand.id);
        if (b) {
          secondary = b.data;
          sourceIds.push(`brand:${b.id}`);
        }
      }
      const res = await renderTemplate({ template: tpl, width: it.width, height: it.height, content: renderContent(it.content, hy.brandName, hs.facts, dropSupport), palette: env.hasBrandPalette ? env.palette : [], styleId: plan?.styleId, anchors: hy.anchors ?? undefined, brandName: hy.brandName, images: { hero, secondary }, logo: env.logo, ...(heroFocus ? { heroFocus } : {}), ...(env.brand?.logo ? { logoAdapt: true } : {}) });
      return { res, tpl, original: original && original !== 'failed' ? original : null, sourceIds, heroFromBrand, rightsNote };
    };

    for (let step = 0; step < 4; step++) {
      const r = await tryOnce(current);
      if (r.error !== undefined) return { ok: false, reason: r.error };
      if (!r.res.ok) {
        const next = current.alternatives.map((a) => a.templateId).find((id) => !tried.has(id) && library.has(id));
        if (r.res.reason === 'unsupported_format' || r.res.reason === 'missing_required' || r.res.reason === 'render_failed') {
          if (next && step < 3) {
            tried.add(next);
            current = withTemplate(current, library.get(next)!, 'the planned template could not be rendered');
            continue;
          }
        }
        return { ok: false, reason: r.res.message };
      }
      const flags = [...r.res.flags];
      const trimmed = (slot: string) => flags.some((f) => f === `text_trimmed:${slot}`);
      if (trimmed('support') && !dropSupport) {
        dropSupport = true; // the supporting line is optional: better without it than cut off
        continue;
      }
      if (trimmed('headline')) {
        const next = current.alternatives.map((a) => a.templateId).find((id) => !tried.has(id) && library.has(id));
        if (next && step < 3 && (o.swapDepth ?? 2) > tried.size - 1) {
          tried.add(next);
          current = withTemplate(current, library.get(next)!, 'the planned template could not fit the headline');
          continue;
        }
        flags.push('text_overflow');
      }
      if (env.logo && !flags.includes('logo_missing_name_used') && !flags.includes('logo_unreadable') && r.tpl.layers.some((l) => l.type === 'logo')) flags.push('logo_applied');
      if (dropSupport) flags.push('support_dropped');
      // the approved logo: every creative says whether it carries it and, when it does not, why (a logo is never forced where it cannot be drawn)
      const logoOutcome = env.brand?.logo
        ? flags.includes('logo_applied')
          ? { applied: true, reason: null }
          : { applied: false, reason: !r.tpl.layers.some((l) => l.type === 'logo') ? 'This template has no logo area.' : flags.includes('logo_unreadable') ? 'The logo file could not be read, so the business name was used.' : flags.includes('logo_missing_name_used') ? 'The logo could not be drawn here, so the business name was used.' : 'The logo was not drawn in this creative.' }
        : undefined;
      const origin: AssetOrigin = o.fallback ? 'FALLBACK' : 'TEMPLATE_RENDERED';
      const asset = await tools.assets.save({
        kind: 'layout',
        conceptId: current.conceptId,
        variationId: current.variationId,
        channel: current.channel,
        format: current.format,
        version: o.version ?? 1,
        parentAssetId: r.original?.id ?? null,
        mimeType: 'image/png',
        width: r.res.width,
        height: r.res.height,
        source: 'template_render',
        model: null,
        quality: null,
        requestedSize: null,
        status: 'rendered',
        flags,
        altText: clean(current.content.headline, 200),
        promptMetadata: null,
        usage: null,
        data: r.res.png,
        origin,
        templateId: current.templateId,
        templateVersion: current.templateVersion,
        sourceAssetIds: r.sourceIds,
        rights: r.rightsNote ? { basis: 'original_template', note: r.rightsNote } : RIGHTS_BY_ORIGIN[origin],
      });
      const layout: LayoutRecord = { id: `layout-${asset.id}`, conceptId: current.conceptId, variantId: current.content.variantId ?? '', variationId: current.variationId, assetId: asset.id, baseAssetId: r.original?.id ?? '', format: current.format, channel: current.channel, headline: current.content.headline, ctaText: current.content.cta ?? '', flags, templateId: current.templateId, templateVersion: current.templateVersion, slotId: current.slotId };
      const tc = record(current, o.fallback ? 'fallback_rendered' : 'rendered', { ...(logoOutcome ? { logo: logoOutcome } : {}), assetId: asset.id, sourceAssetIds: r.sourceIds, origin, flags, reason: o.fallback ? 'The planned original image does not exist, so this creative uses a picture-free template (labelled FALLBACK).' : tried.size > 1 ? `Rendered with ${current.templateName} instead of ${item.templateName}: ${current.rationale.slice(0, 120)}` : null });
      return { ok: true, asset, layout, tc };
    }
    return { ok: false, reason: 'No template in the shortlist could be rendered cleanly.' };
  };

  const withTemplate = (it: TemplateSelectionItem, t: TemplateDef, why: string): TemplateSelectionItem => ({ ...it, templateId: t.id, templateName: t.name, templateVersion: t.version, category: t.category, family: t.family, origin: it.origin === 'user_override' ? it.origin : 'deterministic', rationale: `${t.name}: used because ${why}.`, alternatives: it.alternatives.filter((a) => a.templateId !== t.id) });

  /** A picture-free template for a creative whose original does not exist (only when the user allowed it). */
  const fallbackItem = (item: TemplateSelectionItem): TemplateSelectionItem | null => {
    const slot = { slotId: item.slotId, conceptId: item.conceptId, conceptName: item.conceptName, index: item.index, channel: item.channel, formatId: item.format, width: item.width, height: item.height, formatClass: item.formatClass, variationId: null, source: 'none' as const };
    const r = selectTemplates({ slots: [slot], contents: new Map([[item.slotId, item.content]]), ctx: { ...selectorContext(env, currentDirection(env)), overrides: {}, mode: 'automatic' } });
    const pick = r.plan.items[0];
    return pick ? { ...pick, variationId: item.variationId, sourceKind: 'none' } : null;
  };

  const handleItem = async (item: TemplateSelectionItem) => {
    if (started.has(item.slotId) || !self.isTaskOpen()) return;
    started.add(item.slotId);
    inflight++;
    try {
      const orig = item.variationId ? originals.get(item.variationId) : undefined;
      const wantsOriginal = item.sourceKind === 'ai_original' && !!item.variationId;
      if (wantsOriginal && orig === 'failed') {
        const why = env.board.variations.find((v) => v.variationId === item.variationId)?.explanation ?? 'the original image was not generated';
        const fb = hs.allowTemplateFallback ? fallbackItem(item) : null;
        if (fb) {
          const a = await renderItem(fb, { fallback: true });
          if (a.ok) return emitOutcome(fb, a.tc, a.asset, a.layout, null);
          return emitOutcome(item, record(item, 'failed', { reason: `The original image failed (${clean(why, 140)}) and the picture-free template could not be rendered either: ${a.reason}` }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason: a.reason });
        }
        const reason = `Not rendered: its original image was not generated (${clean(why, 160)}). ${hs.allowTemplateFallback ? 'No picture-free template fits.' : 'Picture-free fallback templates are switched off.'}`;
        return emitOutcome(item, record(item, 'skipped', { reason }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason });
      }
      const a = await renderItem(item, { fallback: false });
      if (a.ok) return emitOutcome(item, a.tc, a.asset, a.layout, null);
      emitOutcome(item, record(item, 'failed', { reason: a.reason }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason: a.reason });
    } catch (e) {
      emitOutcome(item, record(item, 'failed', { reason: clean(e instanceof Error ? e.message : 'The creative could not be rendered.', 160) }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason: 'The creative could not be rendered.' });
    } finally {
      inflight--;
      maybeFinish();
    }
  };

  /** Starts every creative that can start now: the ones whose original exists (or failed), and the ones that need no original. */
  const pump = () => {
    if (!plan) return;
    for (const item of plan.items) {
      if (started.has(item.slotId)) continue;
      if (item.sourceKind !== 'ai_original' || !item.variationId) void handleItem(item);
      else if (originals.has(item.variationId)) void handleItem(item);
    }
    maybeFinish();
  };

  return [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        self.openTask(settings.productionTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant));
        pump(); // a continuation already has its plan
      }),
    },
    {
      // Template Selector -> Layout Designer: the plan arrives; creatives whose original already exists start at once
      specification: new OnEventTypes(['template.selection.completed']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        plan = (event.payload as { plan: TemplateSelectionPlan }).plan;
        pump();
      }),
    },
    {
      specification: new OnEventTypes(['visual.generated']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        const p = event.payload as { variationId?: string; asset: AssetRecord | null; failed: boolean };
        if (!p.variationId) return;
        originals.set(p.variationId, p.asset && !p.failed ? p.asset : 'failed');
        pump();
      }),
    },
    {
      specification: new OnEventTypes(['task.completed']),
      processor: guarded(ctx.guard(name), ({ event }) => {
        const p = event.payload as { agent: string; outcome: string };
        if (p.agent === visual) {
          visualFinished = true;
          // planned originals that never reported (planning failed, budget) count as failed
          for (const v of env.board.allocation?.variations ?? []) if (!originals.has(v.variationId)) originals.set(v.variationId, 'failed');
          pump();
        } else if (p.agent === selector && p.outcome !== 'succeeded' && !plan) {
          selectorFailed = true;
          maybeFinish();
        }
      }),
    },
    {
      // Fixer -> Layout Designer: re-render a template creative (shorter text, a roomier template); the earlier version is kept
      specification: new OnEventTypes(['revision.requested']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        const p = event.payload as { agent: string; round: number; operations: LayoutOp[] };
        if (p.agent !== name) return;
        await Promise.resolve(); // never answer inside the requester's own emit
        const assets: AssetRecord[] = [];
        const layouts: LayoutRecord[] = [];
        const creatives: TemplateCreativeRecord[] = [];
        const supersedes: string[] = [];
        const results: { id: string; ok: boolean; note: string; before?: string | null; after?: string | null }[] = [];
        const sel = env.board.selection;
        for (const op of p.operations) {
          try {
            const own = env.board.templateCreatives.filter((c) => c.conceptId === op.conceptId && c.format === op.format && (c.variationId ?? null) === (op.variationId ?? null));
            const targets = own.length ? own : env.board.templateCreatives.filter((c) => c.conceptId === op.conceptId && (c.status === 'failed' || c.status === 'skipped'));
            if (!targets.length || !sel) {
              results.push({ id: op.id, ok: false, note: 'There is no template creative of this concept that can be rendered again.' });
              continue;
            }
            let any = false;
            for (const t of targets) {
              const planned = sel.items.find((i) => i.slotId === t.slotId);
              if (!planned) continue;
              // the rule that applies to the first render applies to a repair: no original, no render (unless picture-free fallback was allowed)
              const orig = planned.variationId ? originals.get(planned.variationId) : undefined;
              const needsMissingOriginal = planned.sourceKind === 'ai_original' && !!planned.variationId && (orig === undefined || orig === 'failed');
              if (needsMissingOriginal && t.status !== 'fallback_rendered' && !hs.allowTemplateFallback) {
                results.push({ id: op.id, ok: false, note: 'Its original image does not exist, so this creative cannot be rendered. Generate the missing images first (an image-only continuation does not run the research again).' });
                continue;
              }
              const useFallback = t.status === 'fallback_rendered' || needsMissingOriginal;
              // a creative that was rendered without its original keeps using a picture-free template
              const item = useFallback ? (fallbackItem(planned) ?? planned) : planned;
              const oldAsset = t.assetId ? env.board.assets.find((a) => a.id === t.assetId) : undefined;
              const a = await renderItem(item, { fallback: useFallback, dropSupport: !!op.overrides.hideBody, version: (oldAsset?.version ?? 0) + 1, swapDepth: op.overrides.headlineScale ? 3 : 1 });
              if (!a.ok) {
                results.push({ id: op.id, ok: false, note: a.reason });
                continue;
              }
              if (oldAsset) {
                await tools.assets.markSuperseded(oldAsset.id);
                supersedes.push(oldAsset.id);
              }
              assets.push(a.asset);
              layouts.push(a.layout);
              creatives.push(a.tc);
              results.push({ id: op.id, ok: true, note: 'Rendered again; the earlier version is kept.', before: oldAsset ? `${oldAsset.id} (v${oldAsset.version})` : null, after: `${a.asset.id} (v${a.asset.version})` });
              any = true;
            }
            if (!any && !results.some((r) => r.id === op.id)) results.push({ id: op.id, ok: false, note: 'Nothing was rendered.' });
          } catch {
            results.push({ id: op.id, ok: false, note: 'The creative could not be rendered again.' });
          }
        }
        const ok = results.some((r) => r.ok);
        ctx.emit('revision.applied', { owner: name, round: p.round, operationIds: p.operations.map((o) => o.id), status: ok ? 'applied' : 'failed', note: `${results.filter((r) => r.ok).length} of ${results.length} template creative(s) rendered again.`, patch: { kind: 'layout', assets, layouts, supersedes, results, templateCreatives: creatives } }, self.participant);
      }),
    },
  ];
}

export type { LayoutOverrides };
