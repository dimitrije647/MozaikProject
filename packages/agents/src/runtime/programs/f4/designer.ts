import { toSafeError } from '../../../ai/errors';
import { CREATIVE_INFO } from '../../../creative/board';
import { RENDERER_VERSION, sha256Of, type CreativeRenderSpec } from '../../../creative/editor';
import type { AssetRecord, LayoutRecord, SkippedLayout } from '../../../creative/schemas';
import type { RerenderOp } from '../../../creative/repair';
import { paletteKeyOf } from '../../../collections/design';
import { contentForSlot, renderContent, visualTextBudget } from '../../../hybrid/content';
import { exportEligibility, rightsSummary, uploadRights } from '../../../imagery/rights';
import { RIGHTS_BY_ORIGIN, type DesignDiagnostics, type TemplateContent, type TemplateCreativeRecord, type TemplateSelectionItem } from '../../../hybrid/records';
import type { TemplateSlot } from '../../../hybrid/plan';
import { selectTemplates, type SelectorContext } from '../../../hybrid/selector';
import { analyzeSubject } from '../../../imagery/subject';
import sharp from 'sharp';
import { NEVER_A_PICTURE, assetKindOf, rankCompositions, shortlistCompositions, type AssetKind, type Composition, type CompositionContext, type ContentProfile, type VariantId } from '../../../templates/adapt';
import { isBetter, repairLoop, type DesignAttempt } from '../../../templates/design-loop';
import { designStatus, preflight, visibilityScore } from '../../../templates/preflight';
import { renderTemplate } from '../../../templates/render';
import { chooseSecondary, type FrameCandidate } from '../../../templates/crop';
import { formatClassOf, type RenderSubject, type TemplateDef } from '../../../templates/schema';
import { OnEventTypes, guarded } from '../../run-context';
import { PhaseAgent } from '../f1/agent';
import type { F4Env } from './env';

/** What each layout variant did, for people. */
const VARIANT_NOTE: Record<VariantId, string> = {
  base: 'The template as designed.',
  mirror: 'Mirrored the composition (text and picture swap sides) so the text sits in the free part of the picture.',
  compact: 'Shrank the text panel/band to the text and shortened the stripes, so the people stay visible.',
  'mirror+compact': 'Mirrored the composition and shrank the text panel to the text.',
  top: 'Moved the text group to the top, where the picture has free space.',
  bottom: 'Moved the text group to the bottom, where the picture has free space.',
  'top+compact': 'Moved the text group to the top and shrank its panel to the text.',
  'bottom+compact': 'Moved the text group to the bottom and shrank its panel to the text.',
  contain: 'Showed the whole photograph (letterboxed in its own border colour): any crop of this format would have cut people.',
  'photo-panel': 'Filled the large empty colour panel of the layout with the approved photograph instead of leaving a block of colour.',
};

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
  /** how many delivered creatives of this run use each library picture (a replacement picture prefers one the campaign uses less) */
  const pictureUses = new Map<string, number>();
  /** the verified web address of the business (the one the owner supplied), as print shows it: the host only */
  const site = (() => {
    try {
      return env.input.websiteUrl ? new URL(env.input.websiteUrl).hostname.replace(/^www\./, '') : null;
    } catch {
      return null;
    }
  })();
  /**
   * MEDIA-SPECIFIC CONTENT. A billboard is read in seconds and cannot be clicked: one headline, the business named, and the verified address as
   * its next step (nothing when there is none). A flyer is printed: its call to action becomes a written next step with the verified address.
   * Social posts and digital ads keep their call to action (a button where the layout has one).
   */
  const mediaContent = (c: TemplateContent, kind: string | null): TemplateContent => {
    if (kind === 'billboard') return { ...c, support: null, eyebrow: null, cta: site, ctaOptions: [] };
    if (kind === 'flyer') {
      const cta = c.cta ? (site ? `${c.cta} \u2013 ${site}` : c.cta) : site;
      return { ...c, cta, ctaOptions: site ? [...(c.ctaOptions ?? []).map((x) => `${x} \u2013 ${site}`), site] : c.ctaOptions };
    }
    return c;
  };
  /** what a library picture is, for a layout (photograph, screenshot, brand graphic, ...): its category, its words and its pixels */
  const kinds = new Map<string, AssetKind>();
  const pictureKind = async (id: string): Promise<AssetKind> => {
    if (kinds.has(id)) return kinds.get(id)!;
    const b = hy.brandImages.find((x) => x.id === id);
    const k = b ? assetKindOf({ category: b.library?.category ?? null, text: `${b.name} ${b.library?.text ?? ''}`, subject: await analyzeSubject(b.data) }) : 'photograph';
    kinds.set(id, k);
    return k;
  };
  /** the best other approved PHOTOGRAPH for a format: the shape that suits it, then the one the campaign uses least */
  const otherPhotograph = async (exclude: string, aspect: number): Promise<string | null> => {
    const alts: { id: string; d: number }[] = [];
    for (const b of hy.brandImages) {
      if (b.id === exclude || !exportEligibility(b.library?.rights ?? uploadRights()).eligible) continue;
      if ((await pictureKind(b.id)) !== 'photograph') continue;
      const sz = await pictureSize(b.id);
      if (sz) alts.push({ id: b.id, d: Math.abs(Math.log(sz.w / sz.h / aspect)) + 0.12 * (pictureUses.get(b.id) ?? 0) });
    }
    return alts.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))[0]?.id ?? null;
  };
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

  /** The pictures a template draws for a creative: rights-gated again, with the subject map of the hero picture. */
  type Pictures = { hero?: Buffer; secondary?: Buffer; heroId?: string; secondaryId?: string; heroFocus?: [number, number]; subject?: RenderSubject; secondarySubject?: RenderSubject; sourceIds: string[]; credits: string[] };
  const picturesFor = async (tpl: TemplateDef, current: TemplateSelectionItem): Promise<Pictures | { error: string }> => {
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
    const out: Pictures = { sourceIds: [], credits };
    // a picture is a SOURCE of this creative only if the template really draws it (no false credit or provenance entries)
    if (tpl.layers.some((l) => l.type === 'image' && l.slot !== 'secondary')) {
      const h = take(current.imageId);
      if (h && 'error' in h) return h;
      if (h) {
        out.hero = h.data;
        out.heroId = h.id;
        out.sourceIds.push(`brand:${h.id}`);
        out.heroFocus = current.focus ? [current.focus[0], current.focus[1]] : (h.focus ?? undefined);
        // where the people, faces and subject are (local pixel analysis, cached per picture): the crop keeps them whole and visible
        const m = await analyzeSubject(h.data);
        if (m) out.subject = { faces: m.faces, subject: m.subject, graphic: m.graphic };
      }
    }
    if (tpl.layers.some((l) => l.type === 'image' && l.slot === 'secondary')) {
      const s = take(current.secondaryImageId);
      if (s && 'error' in s) return s;
      if (s) {
        out.secondary = s.data;
        out.secondaryId = s.id;
        out.sourceIds.push(`brand:${s.id}`);
        // the small second frame is cropped around its own people (a centre crop of a group photo leaves half a face at the edge)
        const m = await analyzeSubject(s.data);
        if (m) out.secondarySubject = { faces: m.faces, subject: m.subject, graphic: m.graphic };
      }
    }
    return out;
  };

  /**
   * THE SECOND PICTURE OF A TWO-PICTURE LAYOUT must be a meaningful picture in its small frame, never the main photograph again and never a slice
   * of a group with half a face at the edge. The assigned one is kept when its predicted frame is fine; otherwise another approved photograph
   * whose frame is (the one the campaign uses least first). Nothing better: the assigned one stays and the preflight judges the render.
   */
  const secondaryFor = async (tpl: TemplateDef, current: TemplateSelectionItem): Promise<{ id: string | null; note: string | null }> => {
    const layer = tpl.layers.find((l) => l.type === 'image' && l.slot === 'secondary');
    const assigned = current.secondaryImageId ?? null;
    if (!layer || !('box' in layer) || !current.imageId) return { id: assigned, note: null };
    const [bx, by, bwf, bhf] = layer.box;
    const candidate = async (id: string): Promise<FrameCandidate | null> => {
      const b = hy.brandImages.find((x) => x.id === id);
      const sz = b ? await pictureSize(id) : null;
      if (!b || !sz) return null;
      const m = await analyzeSubject(b.data);
      return { id, w: sz.w, h: sz.h, subject: m ? { faces: m.faces, subject: m.subject, graphic: m.graphic } : undefined, uses: pictureUses.get(id) ?? 0 };
    };
    const others: FrameCandidate[] = [];
    for (const b of hy.brandImages) {
      if (b.id === assigned || b.id === current.imageId || !exportEligibility(b.library?.rights ?? uploadRights()).eligible) continue;
      if ((await pictureKind(b.id)) !== 'photograph') continue;
      const c = await candidate(b.id);
      if (c) others.push(c);
    }
    const pick = chooseSecondary({ rect: { x: bx * current.width, y: by * current.height, w: bwf * current.width, h: bhf * current.height }, canvasW: current.width, canvasH: current.height, heroId: current.imageId, assigned: assigned ? await candidate(assigned) : null, others });
    return { id: pick.id, note: pick.replaced ? (assigned === current.imageId ? 'The second picture was the main photograph again, so another approved photograph was used.' : `The assigned second picture would have shown ${pick.problem ?? 'only a fragment of a person'} in its small frame, so another approved photograph was used there.`) : null };
  };

  /** Pixel size of a library picture (from its stored analysis, else read once) and of the logo. */
  const sizes = new Map<string, { w: number; h: number } | null>();
  const pictureSize = async (id: string): Promise<{ w: number; h: number } | null> => {
    if (sizes.has(id)) return sizes.get(id)!;
    const b = hy.brandImages.find((x) => x.id === id);
    let out: { w: number; h: number } | null = null;
    if (b?.library?.analysis?.width && b.library.analysis.height) out = { w: b.library.analysis.width, h: b.library.analysis.height };
    else if (b) out = await sharp(b.data).metadata().then((m) => (m.width && m.height ? ((m.orientation ?? 1) >= 5 ? { w: m.height, h: m.width } : { w: m.width, h: m.height }) : null)).catch(() => null);
    sizes.set(id, out);
    return out;
  };
  let logoSize: { w: number; h: number } | null | undefined;
  const logoDims = async () => {
    if (logoSize === undefined) logoSize = env.logo ? await sharp(env.logo).metadata().then((m) => (m.width && m.height ? { w: m.width, h: m.height } : null)).catch(() => null) : null;
    return logoSize;
  };

  /** The content of a creative as the composition scorer sees it: the picture (size, faces, subject, busy map), the copy, the logo, the format. */
  const profileFor = async (current: TemplateSelectionItem, imageId: string | null | undefined, dropSupport: boolean, kind: string | null): Promise<ContentProfile> => {
    const copy = renderContent(current.content, hy.brandName, settings.visual.facts, dropSupport) as ContentProfile['copy'];
    let picture: ContentProfile['picture'] = null;
    const b = imageId ? hy.brandImages.find((x) => x.id === imageId) : undefined;
    if (b && exportEligibility(b.library?.rights ?? uploadRights()).eligible) {
      const size = await pictureSize(b.id);
      const m = await analyzeSubject(b.data);
      if (size) picture = { w: size.w, h: size.h, focus: current.focus ? [current.focus[0], current.focus[1]] : (b.library?.analysis?.focus ?? null), subject: m, kind: await pictureKind(b.id) };
    }
    const second = !!current.secondaryImageId && hy.brandImages.some((x) => x.id === current.secondaryImageId);
    const slot = env.board.hybridPlan?.slots.find((s) => s.slotId === current.slotId);
    const fastScroll = !!slot && !!visualTextBudget(slot)?.fastScroll;
    return { width: current.width, height: current.height, picture, hasSecondPicture: second, logo: await logoDims(), copy, kind, fastScroll };
  };

  /**
   * Renders ONE creative by ADAPTIVE COMPOSITION (templates/adapt.ts) validated by the DESIGN PREFLIGHT:
   *   1. the content is analysed (the picture's faces, subject and busy areas, the copy, the logo, the format)
   *   2. every template of the collection that can draw the format is turned into its few layout variants and scored against that content
   *      BEFORE rendering (critical problems are hard failures, not penalties)
   *   3. the best MAX_COMPOSITIONS compositions (preferring different templates) are rendered and checked by the preflight, which repairs in
   *      place (crop, logo position and size, overlay opacity, decoration, text backing) within a bounded number of renders
   *   4. if the best result still has a CRITICAL problem and another approved picture suits the format better, the best composition for that
   *      picture is tried once
   * The best attempt is delivered with its diagnostics and an honest status (passed / warnings / unresolved).
   * `version` > 1 makes it a new version of an existing creative; `swap` (asked for by the review) ranks the delivered layout last; `avoid`
   * lists the layouts (template -> variants) already used in this format.
   */
  const MAX_COMPOSITIONS = 3;
  type MatrixOpts = { force?: { templateId: string; variant: string } | null; exclude?: ReadonlySet<string> };
  const renderItem = async (planned: TemplateSelectionItem, o: { dropSupport?: boolean; version?: number; swap?: boolean; avoid?: ReadonlyMap<string, ReadonlySet<string>>; families?: ReadonlySet<string>; matrix?: MatrixOpts } = {}): Promise<Attempt> => {
    const slot = env.board.hybridPlan?.slots.find((s) => s.slotId === planned.slotId);
    const kind = slot?.kind ?? null;
    let item: TemplateSelectionItem = { ...planned, content: mediaContent(planned.content, kind) };
    // a picture that cannot BE a picture (a brand graphic with its own text and logo, a logo) is replaced by another approved photograph, never
    // written over; without one the creative is photo-free. The same unsuitable picture is never inserted again.
    let replaced: string | null = null;
    if (item.imageId && NEVER_A_PICTURE.has(await pictureKind(item.imageId))) {
      replaced = item.imageId;
      const alt = await otherPhotograph(item.imageId, item.width / item.height);
      item = { ...item, imageId: alt, focus: null, secondaryImageId: item.secondaryImageId === alt ? null : item.secondaryImageId };
    }
    if (item.secondaryImageId && NEVER_A_PICTURE.has(await pictureKind(item.secondaryImageId))) item = { ...item, secondaryImageId: null };
    const shortlist = [item.templateId, ...item.alternatives.map((a) => a.templateId)].filter((id, i, all) => all.indexOf(id) === i && library.has(id));
    const cls = formatClassOf(item.width, item.height);
    let candidates = [...library.values()].filter((t) => t.classes.includes(cls));
    if (!candidates.length) return { ok: false, reason: `No template of the collection draws ${item.format}.` };
    // the second design of a variation matrix is ANOTHER template (never the first design mirrored)
    let matrixNote: string | null = null;
    if (o.matrix?.exclude?.size) {
      const rest = candidates.filter((t) => !o.matrix!.exclude!.has(t.id));
      if (rest.length) candidates = rest;
      else matrixNote = 'The collection has only one template for this format, so the second design of the matrix could not be a different layout.';
    }
    const print = kind === 'billboard' || kind === 'flyer';
    const budget = slot ? visualTextBudget(slot) : null;
    // PHOTO FIRST on a FAST-SCROLL format (a TikTok cover): when an approved photograph is assigned, a composition that shows it beats a photo-free
    // one unless it has a critical problem. Other formats compare by the preflight as before (the ranking already penalises a photo-free layout).
    const photoAvailable = !!item.imageId && (await pictureKind(item.imageId)) === 'photograph';
    const photoFirst = photoAvailable && !!budget?.fastScroll;
    const better = (a: DesignAttempt, aPhoto: boolean, b: DesignAttempt, bPhoto: boolean) => {
      if (photoFirst && aPhoto !== bPhoto) {
        const ok = (x: DesignAttempt) => designStatus(x.pre) !== 'unresolved';
        if (aPhoto && ok(a)) return true;
        if (bPhoto && ok(b)) return false;
      }
      return isBetter(a, b);
    };
    const spells = await logoDims().then((d) => !!d && d.w / d.h >= 2.2);
    // print names the business in full: next to a logo mark that does not spell it, the name is written
    const initialTune = print && env.logo && !spells ? { brandName: true } : {};
    const used = new Map<string, Set<string>>([...(o.avoid ?? new Map())].map(([k, v]) => [k, new Set(v)]));
    // the review asked for ANOTHER layout: everything of the delivered template counts as used
    if (o.swap) used.set(item.templateId, new Set(['base', 'mirror', 'compact', 'mirror+compact', 'top', 'bottom', 'top+compact', 'bottom+compact', 'contain', 'photo-panel']));
    const ctxC: CompositionContext = { used, usedFamilies: o.families, preferred: shortlist };
    type Best = { attempt: DesignAttempt; comp: Composition; current: TemplateSelectionItem; pics: Pictures; dropSupport: boolean; secNote: string | null };
    let best: Best | null = null;
    let renders = 0;
    let lastRefusal: string | null = null;
    const tried: string[] = [];
    let ranked: Composition[] = [];
    const attemptWith = async (comp: Composition, base: TemplateSelectionItem) => {
      const lib = library.get(comp.templateId)!;
      let current = comp.templateId === item.templateId ? base : withTemplate(base, lib, o.swap ? 'the review asked for another layout' : 'it suits this content better');
      const sec = await secondaryFor(comp.template, current);
      if (sec.id !== (current.secondaryImageId ?? null)) current = { ...current, secondaryImageId: sec.id };
      const pics = await picturesFor(comp.template, current);
      if ('error' in pics) return pics.error;
      tried.push(`${comp.templateId}${comp.variant === 'base' ? '' : `:${comp.variant}`}`);
      const templateHasImage = comp.template.layers.some((l) => l.type === 'image');
      let dropSupport = o.dropSupport === true;
      for (let pass = 0; pass < 2; pass++) {
        const content = renderContent(current.content, hy.brandName, settings.visual.facts, dropSupport);
        const run = await repairLoop(
          comp.templateId,
          (tune) => renderTemplate({ template: comp.template, width: current.width, height: current.height, content, palette: env.hasBrandPalette ? env.palette : [], styleId: env.board.selection?.styleId ?? env.board.direction?.styleId, anchors: hy.anchors ?? undefined, brandName: hy.brandName, images: { hero: pics.hero, secondary: pics.secondary }, logo: env.logo, ...(pics.heroFocus ? { heroFocus: pics.heroFocus } : {}), ...(env.brand?.logo ? { logoAdapt: true } : {}), ...(pics.subject ? { subject: pics.subject } : {}), ...(pics.secondarySubject ? { secondarySubject: pics.secondarySubject } : {}), tune, alternatives: { cta: current.content.ctaOptions ?? [], headline: current.content.headlineOptions ?? [] } }),
          (res) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: !!env.logo, hasPicture: pics.sourceIds.length > 0, templateHasImage, media: { kind, logoSpellsName: spells, fastScroll: !!budget?.fastScroll, textBudget: budget ? { maxWords: budget.maxWords, maxBlocks: budget.maxBlocks } : null, pictureIsPhoto: photoAvailable }, layout: { density: comp.template.density } }),
          4,
          initialTune,
        );
        renders += run.renders;
        if (run.refused) {
          lastRefusal = run.refused.message;
          return null;
        }
        if (!run.best) return null;
        // the supporting line is optional: better without it than cut off
        if (!dropSupport && run.best.res.flags.includes('text_trimmed:support')) {
          dropSupport = true;
          continue;
        }
        const drawsPhoto = pics.sourceIds.length > 0;
        if (!best || better(run.best, drawsPhoto, best.attempt, best.pics.sourceIds.length > 0)) best = { attempt: run.best, comp, current, pics, dropSupport, secNote: sec.note };
        return null;
      }
      return null;
    };
    const profile = await profileFor(item, item.imageId, o.dropSupport === true, kind);
    ranked = rankCompositions(candidates, profile, ctxC);
    // a matrix partner: the SAME design (template and arrangement) carries the second text; it is kept unless it fails critically with this text
    let shared = false;
    const force = o.matrix?.force ?? null;
    if (force) {
      const fc = ranked.find((c) => c.templateId === force.templateId && c.variant === force.variant) ?? ranked.find((c) => c.templateId === force.templateId);
      if (fc && !fc.hard.some((h) => h.startsWith('asset_fit') || h.startsWith('template_fit'))) {
        const err = await attemptWith(fc, item);
        if (err) return { ok: false, reason: err };
        shared = !!best && designStatus((best as Best).attempt.pre) !== 'unresolved';
      }
      if (!shared) matrixNote = `The first design (${force.templateId}) could not carry this text cleanly, so another layout was used: this cell of the matrix is not the same design.`;
    }
    if (!shared) {
      for (const comp of shortlistCompositions(ranked, MAX_COMPOSITIONS)) {
        const err = await attemptWith(comp, item);
        if (err) return { ok: false, reason: err };
        if (best && (best as Best).attempt.pre.passed && (!photoFirst || (best as Best).pics.sourceIds.length > 0)) break;
      }
    }
    // a critical problem remains: another approved picture whose shape suits the format may give a clean composition (tried once)
    const bestNow = best as Best | null;
    if (bestNow && designStatus(bestNow.attempt.pre) === 'unresolved' && item.imageId) {
      const aspect = item.width / item.height;
      const alts: { id: string; d: number }[] = [];
      for (const b of hy.brandImages) {
        if (b.id === item.imageId || !exportEligibility(b.library?.rights ?? uploadRights()).eligible) continue;
        if (NEVER_A_PICTURE.has(await pictureKind(b.id))) continue;
        const sz = await pictureSize(b.id);
        // shape first; a picture the campaign already uses often costs a little, and a brand graphic is a last resort for a photograph's place
        if (sz) alts.push({ id: b.id, d: Math.abs(Math.log(sz.w / sz.h / aspect)) + 0.12 * (pictureUses.get(b.id) ?? 0) + (b.library?.category === 'brand_graphic' ? 0.5 : 0) });
      }
      const alt = alts.sort((a, b) => a.d - b.d)[0];
      if (alt) {
        const altItem = { ...item, imageId: alt.id, focus: null };
        const altRanked = rankCompositions(candidates, await profileFor(altItem, alt.id, o.dropSupport === true, kind), ctxC);
        if (altRanked[0] && altRanked[0].hard.length < (bestNow.comp.hard.length || 1)) await attemptWith(altRanked[0], altItem);
      }
    }
    if (!best) return { ok: false, reason: lastRefusal ?? 'No composition of the collection could be rendered cleanly.' };
    const chosen = best as Best;
    const { attempt, pics, comp } = chosen;
    const current = chosen.current;
    const dropSupport = chosen.dropSupport;
    const tpl = library.get(attempt.templateId)!;
    const res = attempt.res;
    const sourceIds = pics.sourceIds;
    const credits = pics.credits;
    {
      const flags = [...res.flags];
      if (flags.includes('text_trimmed:headline')) flags.push('text_overflow');
      if (attempt.pre.passed) flags.push('preflight_passed');
      else flags.push(...attempt.pre.failures.map((f) => `preflight_failed:${f.id}`));
      if (attempt.actions.length) flags.push('preflight_repaired');
      flags.push(`layout_variant:${comp.variant}`);
      const usedHere = o.avoid?.get(attempt.templateId);
      // a mirrored, compacted or shifted copy of a layout already used in this channel is NOT a new design (a matrix partner shares it on purpose)
      const duplicate = !!usedHere && !shared;
      const sameTemplate = false;
      const relation: 'creative_direction' | 'layout_adaptation' | 'copy_variation' = !usedHere && !shared ? 'creative_direction' : shared || [...(usedHere ?? [])].includes(comp.variant) ? 'copy_variation' : 'layout_adaptation';
      const channelKey = kind && kind !== 'social_post' ? kind : `social:${current.channel}`;
      const checks = [
        ...attempt.pre.checks.map((c) => ({ id: c.id, category: c.category, status: c.status, detail: c.detail })),
        { id: 'duplicate_layout', category: 'duplicate_layout', status: duplicate || sameTemplate ? ('warn' as const) : ('pass' as const), detail: duplicate ? `Another creative of this ${kind === 'social_post' ? 'channel' : 'deliverable'} already uses this layout (${relation === 'copy_variation' ? 'the same arrangement' : `a ${comp.variant} copy is not a new design`}): no other composition of the collection passed the checks.` : shared ? 'Shares its design with its partner in the variation matrix (on purpose: same design, other text).' : 'No other creative of this channel uses this layout.' },
      ];
      const status = designStatus(attempt.pre) === 'passed' && (duplicate || sameTemplate) ? 'warnings' : designStatus(attempt.pre);
      if (status === 'unresolved') flags.push('design_unresolved');
      const others = ranked.filter((r) => !(r.templateId === comp.templateId && r.variant === comp.variant)).slice(0, 4);
      const hero = res.report.hero;
      const design: DesignDiagnostics = {
        passed: attempt.pre.passed,
        status,
        checks,
        repairs: [
          ...(attempt.templateId !== item.templateId ? [{ kind: 'template', target: attempt.templateId, detail: `Composed with ${attempt.templateId} instead of the planned ${item.templateId}${o.swap ? ' (asked for by the review)' : ' (it suits this content better)'}.` }] : []),
          ...(comp.variant !== 'base' ? [{ kind: 'position', target: comp.variant, detail: VARIANT_NOTE[comp.variant] }] : []),
          ...(current.imageId !== item.imageId ? [{ kind: 'crop', target: current.imageId ?? '', detail: 'Used another approved picture whose shape suits this format.' }] : []),
          ...(chosen.secNote ? [{ kind: 'crop', target: current.secondaryImageId ?? 'secondary', detail: chosen.secNote }] : []),
          ...(dropSupport && !o.dropSupport ? [{ kind: 'copy', target: 'support', detail: 'Left out the supporting line: it did not fit without being cut.' }] : []),
          ...attempt.actions,
        ].slice(0, 40),
        renders,
        templatesTried: tried.slice(0, 8),
        templateChanged: attempt.templateId !== item.templateId,
        composition: {
          templateId: comp.templateId,
          variant: comp.variant,
          score: comp.score,
          considered: ranked.length,
          reasons: comp.reasons.slice(0, 4),
          hard: comp.hard.slice(0, 4),
          rejected: others.map((r) => ({ templateId: r.templateId, variant: r.variant, score: r.score, why: (r.hard[0] ?? r.reasons[0] ?? '').slice(0, 200) })),
        },
        crop: hero ? { fit: hero.fit, zoom: hero.zoom, cropLoss: hero.cropLoss, subjectAware: flags.includes('crop_subject_aware:hero') || hero.fit === 'contain', facesWhole: hero.faces.filter((f) => f.inFrame >= 0.85).length, faces: hero.faces.length } : null,
        text: { over: comp.predicted.textOver, placement: comp.variant },
        logo: res.report.logo ? { mode: res.report.logo.mode, moved: flags.includes('logo_moved'), enlarged: flags.includes('logo_enlarged'), plate: res.report.logo.plate, contrast: res.report.logo.contrast, name: res.report.logo.name === true } : null,
        concept: { key: comp.templateId, family: comp.family, relation, channel: channelKey },
        matrix: slot?.matrix ? { group: slot.matrix.group, design: slot.matrix.design, copy: slot.matrix.copy, shared: !!force && shared, note: matrixNote } : null,
        shortened: (res.report.shortened ?? []).slice(0, 6).map((x) => ({ slot: x.slot, from: x.from.slice(0, 200), to: x.to.slice(0, 200) })),
        picture: current.imageId ? { kind: await pictureKind(current.imageId), replaced } : replaced ? { kind: 'none', replaced } : null,
      };
      if (replaced) design.repairs.unshift({ kind: 'crop', target: replaced, detail: current.imageId ? 'Its assigned picture is a brand graphic or logo (it carries its own text and mark), so another approved photograph was used.' : 'Its assigned picture is a brand graphic or logo and no other approved photograph exists, so the design is photo-free.' });
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
      // THE EDITABLE RENDER SPECIFICATION: what reproduces this creative exactly (the final composed template and repair tune, the references of
      // its pictures and logo, the text as drawn), stored with the asset so its owner can change the text later without any model call
      const drawnContent = renderContent(current.content, hy.brandName, settings.visual.facts, dropSupport) as Record<string, string>;
      for (const sh of res.report.shortened ?? []) drawnContent[sh.slot] = sh.to;
      const renderSpec: CreativeRenderSpec = {
        v: 1,
        renderer: RENDERER_VERSION,
        slotId: current.slotId,
        templateId: attempt.templateId,
        templateVersion: tpl.version,
        variant: comp.variant,
        template: comp.template,
        width: res.width,
        height: res.height,
        palette: env.hasBrandPalette ? env.palette : [],
        styleId: env.board.selection?.styleId ?? env.board.direction?.styleId ?? null,
        anchors: hy.anchors ?? null,
        brandName: hy.brandName,
        hero: pics.hero && pics.heroId ? { id: pics.heroId, sha256: sha256Of(pics.hero) } : null,
        secondary: pics.secondary && pics.secondaryId ? { id: pics.secondaryId, sha256: sha256Of(pics.secondary) } : null,
        heroFocus: pics.heroFocus ?? null,
        logo: env.logo ? { sha256: sha256Of(env.logo) } : null,
        logoAdapt: !!env.brand?.logo,
        tune: attempt.tune as Record<string, unknown>,
        content: drawnContent,
        original: Object.fromEntries(res.drawn.filter((d) => d !== 'brand' && typeof drawnContent[d] === 'string').map((d) => [d, drawnContent[d]])),
        check: { hasLogo: !!env.logo, hasPicture: sourceIds.length > 0, templateHasImage: comp.template.layers.some((l) => l.type === 'image'), media: { kind, logoSpellsName: spells, fastScroll: !!budget?.fastScroll, textBudget: budget ? { maxWords: budget.maxWords, maxBlocks: budget.maxBlocks } : null, pictureIsPhoto: photoAvailable }, density: comp.template.density ?? null },
        baseline: attempt.pre.failures.map((f) => f.id),
        baselineVisibility: res.report.hero ? visibilityScore(res.report) : null,
        pictureKind: current.imageId ? await pictureKind(current.imageId) : null,
      };
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
        renderSpec,
        origin: 'TEMPLATE_RENDERED',
        templateId: current.templateId,
        templateVersion: current.templateVersion,
        sourceAssetIds: sourceIds,
        rights: rightsNote ? { basis: 'original_template', note: rightsNote } : RIGHTS_BY_ORIGIN.TEMPLATE_RENDERED,
      });
      const layout: LayoutRecord = { id: `layout-${asset.id}`, conceptId: current.conceptId, variantId: current.content.variantId ?? '', variationId: null, assetId: asset.id, baseAssetId: '', format: current.format, channel: current.channel, headline: current.content.headline, ctaText: current.content.cta ?? '', flags, templateId: current.templateId, templateVersion: current.templateVersion, slotId: current.slotId };
      const tc = record(current, 'rendered', { ...(logoOutcome ? { logo: logoOutcome } : {}), assetId: asset.id, sourceAssetIds: sourceIds, origin: 'TEMPLATE_RENDERED', flags, design, reason: current.templateId !== item.templateId ? `Rendered with ${current.templateName} instead of ${item.templateName}: ${current.rationale.slice(0, 120)}` : null });
      return { ok: true, asset, layout, tc, item: current };
    }
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
        // layout diversity: the layouts (template -> variants) and families already delivered per format (two billboards must not look the same)
        // the key is the CHANNEL for social posts (reuse across networks is allowed, repetition inside one is not) and the deliverable otherwise
        const usedLayouts = new Map<string, Map<string, Set<string>>>();
        const usedFamilies = new Map<string, Set<string>>();
        const layoutKey = (it: TemplateSelectionItem) => {
          const k = plan.slots.find((s) => s.slotId === it.slotId)?.kind;
          return k && k !== 'social_post' ? k : `social:${it.channel}`;
        };
        // the variation matrix: design 1 is chosen with the first text and shared with the second; design 2 is another template
        const matrixDesign = new Map<string, { templateId: string; variant: string }>();
        const matrixOf = (it: TemplateSelectionItem): MatrixOpts | undefined => {
          const m = plan.slots.find((s) => s.slotId === it.slotId)?.matrix;
          if (!m) return undefined;
          const mine = matrixDesign.get(`${m.group}|${m.design}`);
          const other = matrixDesign.get(`${m.group}|${m.design === 1 ? 2 : 1}`);
          return { force: mine ?? null, exclude: new Set(other ? [other.templateId] : []) };
        };
        // matrix cells of the same design are rendered in order (design 1 text 1 decides design 1)
        const order = [...result.plan.items].sort((a, b) => {
          const ma = plan.slots.find((s) => s.slotId === a.slotId)?.matrix;
          const mb = plan.slots.find((s) => s.slotId === b.slotId)?.matrix;
          return ma && mb && ma.group === mb.group ? ma.design - mb.design || ma.copy - mb.copy : 0;
        });
        for (const item of order) {
          if (self.signal.aborted || ctx.isClosed()) break;
          try {
            const mx = matrixOf(item);
            const a = await renderItem(item, { avoid: mx?.force ? undefined : usedLayouts.get(layoutKey(item)), families: usedFamilies.get(layoutKey(item)), matrix: mx });
            if (a.ok) {
              rendered++;
              const m = plan.slots.find((s) => s.slotId === item.slotId)?.matrix;
              if (m && !matrixDesign.has(`${m.group}|${m.design}`)) matrixDesign.set(`${m.group}|${m.design}`, { templateId: a.item.templateId, variant: a.tc.design?.composition?.variant ?? 'base' });
              for (const id of [a.item.imageId, a.item.secondaryImageId]) if (id) pictureUses.set(id, (pictureUses.get(id) ?? 0) + 1);
              const k = layoutKey(item);
              const byTemplate = usedLayouts.get(k) ?? new Map<string, Set<string>>();
              byTemplate.set(a.item.templateId, new Set([...(byTemplate.get(a.item.templateId) ?? []), a.tc.design?.composition?.variant ?? 'base']));
              usedLayouts.set(k, byTemplate);
              usedFamilies.set(k, new Set([...(usedFamilies.get(k) ?? []), library.get(a.item.templateId)?.family ?? '']));
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
            // the layouts the OTHER creatives of this format use stay at the back of the queue (no repair turns two billboards into twins)
            const avoid = new Map<string, Set<string>>();
            const keyOf = (slotId: string, channel: string) => {
              const k = env.board.hybridPlan?.slots.find((s) => s.slotId === slotId)?.kind;
              return k && k !== 'social_post' ? k : `social:${channel}`;
            };
            const mine = keyOf(op.slotId, planned.channel);
            for (const c of env.board.templateCreatives.filter((x) => keyOf(x.slotId, x.channel) === mine && x.slotId !== op.slotId && x.status === 'rendered')) {
              // the partner of a variation matrix shares its design on purpose: it is not a repetition to avoid
              const partner = slot.matrix && env.board.hybridPlan?.slots.find((s) => s.slotId === c.slotId)?.matrix?.design === slot.matrix.design;
              if (!partner) avoid.set(c.templateId, new Set([...(avoid.get(c.templateId) ?? []), c.design?.composition?.variant ?? 'base']));
            }
            const a = await renderItem({ ...planned, content }, { dropSupport: op.dropSupport, swap: op.swapTemplate, version: (oldAsset?.version ?? 0) + 1, avoid });
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
