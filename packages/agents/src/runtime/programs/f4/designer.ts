import { toSafeError } from '../../../ai/errors';
import { CREATIVE_INFO } from '../../../creative/board';
import type { AssetRecord, LayoutRecord, SkippedLayout } from '../../../creative/schemas';
import type { RerenderOp } from '../../../creative/repair';
import { paletteKeyOf } from '../../../collections/design';
import { contentForSlot, renderContent } from '../../../hybrid/content';
import { exportEligibility, rightsSummary, uploadRights } from '../../../imagery/rights';
import { RIGHTS_BY_ORIGIN, type TemplateContent, type TemplateCreativeRecord, type TemplateSelectionItem } from '../../../hybrid/records';
import type { TemplateSlot } from '../../../hybrid/plan';
import { selectTemplates, type SelectorContext } from '../../../hybrid/selector';
import { renderTemplate } from '../../../templates/render';
import type { TemplateDef } from '../../../templates/schema';
import { OnEventTypes, guarded } from '../../run-context';
import { PhaseAgent } from '../f1/agent';
import type { F4Env } from './env';

const clean = (s: string, max: number) => s.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Everything the deterministic template selector needs, from the run's own state. */
export function selectorContext(env: F4Env): SelectorContext {
  const hs = env.settings.visual;
  const hy = env.hybrid;
  return {
    direction: env.board.direction!,
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
    mode: hs.selection === 'manual' ? 'manual' : 'automatic',
    basis: 'concepts',
    design: hy.design,
    collection: hy.collection,
  };
}

/** The content of every planned creative from the real copy (a deliverable without copy has none: nothing is invented for it). */
export function slotContents(env: F4Env, slots: TemplateSlot[]) {
  const contents = new Map<string, TemplateContent>();
  const missing: TemplateSlot[] = [];
  for (const slot of slots) {
    const c = contentForSlot(slot, env.board.concepts, env.board.variants);
    if (c) contents.set(slot.slotId, c);
    else missing.push(slot);
  }
  return { contents, missing };
}

/**
 * A5 CREATIVE DESIGNER (deterministic, no model call, no image generation). It chooses a template of the approved collection for every planned
 * deliverable and renders it locally with the approved copy, the palette, the logo and the approved picture assigned to it (or typography when
 * there is none). Text that does not fit is handled before a result is accepted: the supporting line is dropped, then a roomier template of
 * the shortlist is tried; whatever remains is flagged for the Quality Reviewer. Re-renders requested in a repair round keep the earlier version.
 *
 *   task.assigned      -> template.selection.completed, layout.completed (one per creative), task.completed
 *   revision.requested -> revision.applied (patch kind "layout")
 */
export function buildDesigner(env: F4Env): PhaseAgent {
  const { ctx, settings, tools } = env;
  const name = CREATIVE_INFO.designer.name;
  const hy = env.hybrid;
  const library = new Map<string, TemplateDef>(hy.library.map((t) => [t.id, t]));
  const instruction = 'Creative Designer. Chooses a template of the approved collection for every planned deliverable and renders it locally with the approved copy, palette, logo and picture. Never generates an image; makes no model call.';

  const record = (item: TemplateSelectionItem, status: TemplateCreativeRecord['status'], extra: Partial<TemplateCreativeRecord> = {}): TemplateCreativeRecord => ({
    slotId: item.slotId,
    conceptId: item.conceptId,
    templateId: item.templateId,
    templateName: item.templateName,
    templateVersion: item.templateVersion,
    variationId: null,
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

  const withTemplate = (it: TemplateSelectionItem, t: TemplateDef, why: string): TemplateSelectionItem => ({ ...it, templateId: t.id, templateName: t.name, templateVersion: t.version, category: t.category, family: t.family, origin: it.origin === 'user_override' ? it.origin : 'deterministic', rationale: `${t.name}: used because ${why}.`, alternatives: it.alternatives.filter((a) => a.templateId !== t.id) });

  type Attempt = { ok: true; asset: AssetRecord; layout: LayoutRecord; tc: TemplateCreativeRecord; item: TemplateSelectionItem } | { ok: false; reason: string };

  /** Renders ONE creative. `version` > 1 makes it a new version of an existing creative; `swap` starts with the first alternative template. */
  const renderItem = async (item: TemplateSelectionItem, o: { dropSupport?: boolean; version?: number; swap?: boolean } = {}): Promise<Attempt> => {
    let current = item;
    let dropSupport = o.dropSupport === true;
    const tried = new Set<string>([item.templateId]);
    if (o.swap) {
      const next = item.alternatives.map((a) => a.templateId).find((id) => !tried.has(id) && library.has(id));
      if (next) {
        tried.add(next);
        current = withTemplate(item, library.get(next)!, 'the review asked for another layout');
      }
    }
    for (let step = 0; step < 4; step++) {
      const tpl = library.get(current.templateId);
      if (!tpl) return { ok: false, reason: `Template ${current.templateId} is not in the collection.` };
      // the picture is the one the Visual Researcher assigned to THIS creative, from the approved library, and nothing else. It passes the rights gate
      // again here: a picture that may not be exported is never drawn, whatever reached this point.
      const credits: string[] = [];
      const take = (id: string | null | undefined): { data: Buffer; focus: [number, number] | null; id: string } | { error: string } | null => {
        if (!id) return null;
        const b = hy.brandImages.find((x) => x.id === id);
        if (!b) return { error: `Its picture (${id}) is not in the approved library.` };
        const info = b.library?.rights ?? uploadRights();
        const gate = exportEligibility(info);
        if (!gate.eligible) return { error: `Its picture "${b.name}" may not be used in a creative: ${gate.reason}` };
        credits.push(rightsSummary(info));
        return { data: b.data, focus: b.library?.analysis?.focus ?? null, id: b.id };
      };
      const sourceIds: string[] = [];
      let hero: Buffer | undefined;
      let secondary: Buffer | undefined;
      let heroFocus: [number, number] | undefined;
      // a picture is a SOURCE of this creative only if the template really draws it (no false credit or provenance entries)
      if (tpl.layers.some((l) => l.type === 'image' && l.slot !== 'secondary')) {
        const h = take(current.imageId);
        if (h && 'error' in h) return { ok: false, reason: h.error };
        if (h) {
          hero = h.data;
          sourceIds.push(`brand:${h.id}`);
          heroFocus = current.focus ? [current.focus[0], current.focus[1]] : (h.focus ?? undefined);
        }
      }
      if (tpl.layers.some((l) => l.type === 'image' && l.slot === 'secondary')) {
        const s = take(current.secondaryImageId);
        if (s && 'error' in s) return { ok: false, reason: s.error };
        if (s) {
          secondary = s.data;
          sourceIds.push(`brand:${s.id}`);
        }
      }
      const res = await renderTemplate({ template: tpl, width: current.width, height: current.height, content: renderContent(current.content, hy.brandName, settings.visual.facts, dropSupport), palette: env.hasBrandPalette ? env.palette : [], styleId: env.board.selection?.styleId ?? env.board.direction?.styleId, anchors: hy.anchors ?? undefined, brandName: hy.brandName, images: { hero, secondary }, logo: env.logo, ...(heroFocus ? { heroFocus } : {}), ...(env.brand?.logo ? { logoAdapt: true } : {}) });
      const nextTemplate = () => current.alternatives.map((a) => a.templateId).find((id) => !tried.has(id) && library.has(id));
      if (!res.ok) {
        const next = nextTemplate();
        if ((res.reason === 'unsupported_format' || res.reason === 'missing_required' || res.reason === 'render_failed') && next && step < 3) {
          tried.add(next);
          current = withTemplate(current, library.get(next)!, 'the planned template could not be rendered');
          continue;
        }
        return { ok: false, reason: res.message };
      }
      const flags = [...res.flags];
      const trimmed = (slot: string) => flags.includes(`text_trimmed:${slot}`);
      if (trimmed('support') && !dropSupport) {
        dropSupport = true; // the supporting line is optional: better without it than cut off
        continue;
      }
      if (trimmed('headline')) {
        const next = nextTemplate();
        if (next && step < 3) {
          tried.add(next);
          current = withTemplate(current, library.get(next)!, 'the planned template could not fit the headline');
          continue;
        }
        flags.push('text_overflow');
      }
      const hasLogoLayer = tpl.layers.some((l) => l.type === 'logo');
      if (env.logo && hasLogoLayer && !flags.includes('logo_missing_name_used') && !flags.includes('logo_unreadable')) flags.push('logo_applied');
      if (dropSupport) flags.push('support_dropped');
      // honest counting: a creative is photographic only when a real picture was drawn into it
      flags.push(sourceIds.length ? 'photo_drawn' : 'typography_first');
      const logoOutcome = env.brand?.logo
        ? flags.includes('logo_applied')
          ? { applied: true, reason: null }
          : { applied: false, reason: !hasLogoLayer ? 'This template has no logo area.' : flags.includes('logo_unreadable') ? 'The logo file could not be read, so the business name was used.' : 'The logo could not be drawn here, so the business name was used.' }
        : undefined;
      const rightsNote = credits.length ? `Inherits the rights of its source picture(s): ${[...new Set(credits)].join(' | ')}`.slice(0, 240) : null;
      const asset = await tools.assets.save({
        kind: 'layout',
        conceptId: current.conceptId,
        variationId: null,
        channel: current.channel,
        format: current.format,
        version: o.version ?? 1,
        parentAssetId: null,
        mimeType: 'image/png',
        width: res.width,
        height: res.height,
        source: 'template_render',
        model: null,
        quality: null,
        requestedSize: null,
        status: 'rendered',
        flags,
        altText: clean(current.content.headline, 200),
        promptMetadata: null,
        usage: null,
        data: res.png,
        origin: 'TEMPLATE_RENDERED',
        templateId: current.templateId,
        templateVersion: current.templateVersion,
        sourceAssetIds: sourceIds,
        rights: rightsNote ? { basis: 'original_template', note: rightsNote } : RIGHTS_BY_ORIGIN.TEMPLATE_RENDERED,
      });
      const layout: LayoutRecord = { id: `layout-${asset.id}`, conceptId: current.conceptId, variantId: current.content.variantId ?? '', variationId: null, assetId: asset.id, baseAssetId: '', format: current.format, channel: current.channel, headline: current.content.headline, ctaText: current.content.cta ?? '', flags, templateId: current.templateId, templateVersion: current.templateVersion, slotId: current.slotId };
      const tc = record(current, 'rendered', { ...(logoOutcome ? { logo: logoOutcome } : {}), assetId: asset.id, sourceAssetIds: sourceIds, origin: 'TEMPLATE_RENDERED', flags, reason: tried.size > 1 && current.templateId !== item.templateId ? `Rendered with ${current.templateName} instead of ${item.templateName}: ${current.rationale.slice(0, 120)}` : null });
      return { ok: true, asset, layout, tc, item: current };
    }
    return { ok: false, reason: 'No template in the shortlist could be rendered cleanly.' };
  };

  const blocked = (slot: TemplateSlot, reason: string): TemplateCreativeRecord => ({ slotId: slot.slotId, conceptId: slot.conceptId, templateId: '', templateName: '(none)', templateVersion: 0, collectionId: hy.collection?.id ?? null, collectionVersion: hy.collection?.version ?? null, paletteKey: null, variationId: null, channel: slot.channel, format: slot.formatId, width: slot.width, height: slot.height, status: 'skipped', assetId: null, sourceAssetIds: [], origin: null, flags: ['blocked'], reason });

  return new PhaseAgent(env, { key: 'designer', name, instruction, capabilities: ['creative-production', 'template-selection', 'rendering', 'sharp', 'deterministic'] }, (self) => [
    {
      specification: new OnEventTypes(['task.assigned']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        if ((event.payload as { agent: string }).agent !== name) return;
        if (!self.openTask(settings.designTimeoutMs, () => ctx.emit('task.completed', { agent: name, outcome: 'failed', error: toSafeError('timeout') }, self.participant))) return;
        await Promise.resolve();
        const plan = env.board.hybridPlan;
        const finish = (ok: boolean, message?: string) => {
          if (!self.isTaskOpen()) return;
          self.closeTask();
          ctx.emit('task.completed', ok ? { agent: name, outcome: 'succeeded' } : { agent: name, outcome: 'failed', error: { ...toSafeError('invalid_response'), message: message ?? 'No creative could be rendered.' } }, self.participant);
        };
        if (!plan || !plan.slots.length) return finish(false, 'There is no deliverable to design.');
        const { contents, missing } = slotContents(env, plan.slots);
        const result = selectTemplates({ slots: plan.slots.filter((s) => contents.has(s.slotId)), contents, ctx: selectorContext(env) });
        ctx.emit('template.selection.completed', { agent: name, plan: result.plan, mode: result.plan.mode, modelAssisted: false, note: 'Chosen by deterministic scoring inside the approved collection (no model call).' }, self.participant);
        const report = (conceptId: string, tc: TemplateCreativeRecord, asset: AssetRecord | null, layout: LayoutRecord | null, skipped: SkippedLayout | null) => {
          if (ctx.isClosed() || !self.isTaskOpen()) return;
          ctx.emit('layout.completed', { agent: name, conceptId, assets: asset ? [asset] : [], layouts: layout ? [layout] : [], skipped: skipped ? [skipped] : [], templateCreatives: [tc] }, self.participant);
        };
        // a planned deliverable that cannot be made is reported with its reason: it counts as planned and not delivered, never silently dropped
        for (const s of missing) report(s.conceptId, blocked(s, 'Not designed: the Content Writer produced no copy for it.'), null, null, { conceptId: s.conceptId, format: s.formatId, channel: s.channel, reason: 'No copy for this deliverable.' });
        for (const u of result.unplaceable) {
          const s = plan.slots.find((x) => x.slotId === u.slotId)!;
          const reason = s.source === 'none' ? 'Blocked: this deliverable has no picture and no typography template of the chosen collection fits it. Add a picture or choose another collection.' : 'Blocked: no template of the chosen collection fits this deliverable.';
          report(s.conceptId, blocked(s, reason), null, null, { conceptId: s.conceptId, format: s.formatId, channel: s.channel, reason });
        }
        let rendered = 0;
        for (const item of result.plan.items) {
          if (self.signal.aborted || ctx.isClosed()) break;
          try {
            const a = await renderItem(item);
            if (a.ok) {
              rendered++;
              report(item.conceptId, a.tc, a.asset, a.layout, null);
            } else report(item.conceptId, record(item, 'failed', { reason: a.reason }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason: a.reason });
          } catch (e) {
            const reason = clean(e instanceof Error ? e.message : 'The creative could not be rendered.', 160);
            report(item.conceptId, record(item, 'failed', { reason }), null, null, { conceptId: item.conceptId, format: item.format, channel: item.channel, reason });
          }
        }
        finish(rendered > 0, 'No creative could be rendered.');
      }),
    },
    {
      // Coordinator -> Creative Designer (repair wave 2): render creatives again with the revised copy, without the supporting line or with
      // another template of the collection. The earlier version is kept (superseded), never overwritten.
      specification: new OnEventTypes(['revision.requested']),
      processor: guarded(ctx.guard(name), async ({ event }) => {
        const p = event.payload as { agent: string; round: number; operations: (RerenderOp & { id: string })[] };
        if (p.agent !== name) return;
        await Promise.resolve(); // never answer inside the requester's own emit
        const assets: AssetRecord[] = [];
        const layouts: LayoutRecord[] = [];
        const creatives: TemplateCreativeRecord[] = [];
        const supersedes: string[] = [];
        const results: { id: string; ok: boolean; note: string; before?: string | null; after?: string | null }[] = [];
        for (const op of p.operations) {
          try {
            const planned = env.board.selection?.items.find((i) => i.slotId === op.slotId);
            const slot = env.board.hybridPlan?.slots.find((s) => s.slotId === op.slotId);
            if (!planned || !slot) {
              results.push({ id: op.id, ok: false, note: 'There is no planned creative with this id.' });
              continue;
            }
            // the copy may have been revised in wave 1: the creative shows the current text
            const content = contentForSlot(slot, env.board.concepts, env.board.variants) ?? planned.content;
            const old = env.board.templateCreatives.find((c) => c.slotId === op.slotId);
            const oldAsset = old?.assetId ? env.board.assets.find((a) => a.id === old.assetId) : undefined;
            const a = await renderItem({ ...planned, content }, { dropSupport: op.dropSupport, swap: op.swapTemplate, version: (oldAsset?.version ?? 0) + 1 });
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
          } catch {
            results.push({ id: op.id, ok: false, note: 'The creative could not be rendered again.' });
          }
        }
        const ok = results.some((r) => r.ok);
        ctx.emit('revision.applied', { owner: name, round: p.round, operationIds: p.operations.map((o) => o.id), status: ok ? 'applied' : 'failed', note: `${results.filter((r) => r.ok).length} of ${results.length} creative(s) rendered again.`, patch: { kind: 'layout', assets, layouts, supersedes, results, templateCreatives: creatives } }, self.participant);
      }),
    },
  ]);
}
