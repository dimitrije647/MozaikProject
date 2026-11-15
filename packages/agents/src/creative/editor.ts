import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { DesignDiagnostics, TemplateCreativeRecord } from '../hybrid/records';
import { analyzeSubject } from '../imagery/subject';
import { rankCompositions, type ContentProfile } from '../templates/adapt';
import { isBetter, repairLoop, type DesignAttempt } from '../templates/design-loop';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { CRITICAL_CHECKS, designStatus, preflight, visibilityScore, type PreflightResult } from '../templates/preflight';
import { renderTemplate } from '../templates/render';
import { TEXT_SLOTS, type CreativeContent, type RenderReport, type RenderTune, type TemplateDef, type TextSlot } from '../templates/schema';
import type { AssetRecord, CampaignPackage } from './schemas';

/**
 * THE CREATIVE EDITOR (MVP): the text of ONE rendered creative is changed by its owner and the creative is rendered again by the SAME deterministic
 * renderer, from the same render specification that produced it. No model is called, no image is generated, nothing is drawn over the old PNG.
 *
 *   CreativeRenderSpec   the smallest record that reproduces a creative exactly: the FINAL composed template (variant, reflowed text boxes), the
 *                        final repair tune (crop avoidance, opacities, moved logo, spacing moves...), the palette and surfaces, the references
 *                        (ids + sha256) of the approved pictures and of the logo, the content as drawn and the preflight context. Stored with
 *                        the asset row (never inside the campaign package); pictures are referenced, never copied.
 *   renderEdit           the text-fitting order: the stored composition as it is (line wrapping and sizing inside the template's limits are the
 *                        renderer's own) -> the bounded repair loop (adaptive spacing, crop, logo, opacity) -> another variant of the SAME template
 *                        reflowed for the new text -> an error naming the field that is too long. Text is never cut, never ellipsized, never
 *                        replaced by a shorter wording and never rewritten.
 *   applyCreativeRevision / restoreOriginalRevision   the campaign package after a saved edit (or a restore): the creative, its deliverable,
 *                        its layout and the asset list point at the new file, so the results page and the ZIP show exactly what was saved.
 */

/** Bumped when the renderer changes in a way that would draw an old specification differently. */
export const RENDERER_VERSION = 'v4.4';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Ref = z.object({ id: z.string().min(1).max(64), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export const CreativeRenderSpec = z.object({
  v: z.literal(1),
  renderer: z.string().max(20),
  slotId: z.string().max(120),
  templateId: z.string().max(60),
  templateVersion: z.number().int(),
  variant: z.string().max(40),
  /** the composed template exactly as rendered (variant applied, text boxes reflowed): validated again by the renderer on every render */
  template: z.unknown(),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  palette: z.array(Hex).max(12),
  styleId: z.string().max(40).nullable(),
  anchors: z.object({ ink: Hex, paper: Hex }).nullable(),
  brandName: z.string().max(200),
  hero: Ref.nullable(),
  secondary: Ref.nullable(),
  heroFocus: z.tuple([z.number(), z.number()]).nullable(),
  /** the logo file drawn (its sha256 identifies it among the project's logos); null = the business name was drawn */
  logo: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  logoAdapt: z.boolean(),
  /** the final repair tune of the delivered attempt */
  tune: z.record(z.string(), z.unknown()),
  /** everything the renderer was given as text (brand name and facts included), as drawn */
  content: z.record(z.string(), z.string().max(2000)),
  /** the editable fields as the generator drew them (the text a reset returns to) */
  original: z.record(z.string(), z.string().max(2000)),
  /** the preflight context of this creative */
  check: z.object({
    hasLogo: z.boolean(),
    hasPicture: z.boolean(),
    templateHasImage: z.boolean(),
    media: z.object({ kind: z.string().nullable(), logoSpellsName: z.boolean(), fastScroll: z.boolean().optional(), textBudget: z.object({ maxWords: z.number(), maxBlocks: z.number() }).nullable().optional(), pictureIsPhoto: z.boolean().optional() }).nullable(),
    density: z.enum(['airy', 'balanced', 'dense']).nullable(),
  }),
  /** the checks the delivered creative already failed (an edit that adds no new failure keeps the composition exactly as it was) */
  baseline: z.array(z.string().max(60)).max(40).default([]),
  /** how visible the people and the picture stayed in the delivered creative (an edit may not hide more of them without trying a repair) */
  baselineVisibility: z.number().nullable().default(null),
  /** what the composition scorer needs to try another variant of the same template */
  pictureKind: z.string().max(40).nullable(),
});
export type CreativeRenderSpec = z.infer<typeof CreativeRenderSpec>;

export const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Text slots that belong to the brand (the business name next to a mark, the logo's own words): never editable. */
const PROTECTED: ReadonlySet<string> = new Set(['brand']);

const LABEL: Record<TextSlot, string> = {
  headline: 'Headline',
  support: 'Supporting text',
  cta: 'Call to action',
  eyebrow: 'Eyebrow',
  brand: 'Business name',
  quote: 'Quote',
  attribution: 'Attribution',
  stat: 'Figure',
  statLabel: 'Figure label',
  date: 'Date',
  location: 'Location',
  offer: 'Offer',
  offerDetail: 'Offer detail',
  tag: 'Tag',
  point1: 'Feature 1',
  point2: 'Feature 2',
  point3: 'Feature 3',
};
/** Input limits per field (characters): generous for a creative, small enough that nothing can flood the renderer. */
const MAX_LEN: Partial<Record<TextSlot, number>> = { headline: 160, support: 320, quote: 320, cta: 60, eyebrow: 80, tag: 60, stat: 24, offer: 80 };
const maxLen = (slot: TextSlot) => MAX_LEN[slot] ?? 120;
const ORDER: TextSlot[] = ['eyebrow', 'headline', 'support', 'quote', 'attribution', 'stat', 'statLabel', 'offer', 'offerDetail', 'point1', 'point2', 'point3', 'date', 'location', 'tag', 'cta'];

export interface EditorField {
  /** the template's text slot: a stable id (never an array position) */
  id: TextSlot;
  label: string;
  value: string;
  original: string;
  multiline: boolean;
  maxLength: number;
  required: boolean;
}

const templateOf = (spec: CreativeRenderSpec) => spec.template as TemplateDef;

/** The editable text fields of a creative: the slots its template draws and the generator filled. A slot the template lacks is never offered. */
export function editorFields(spec: CreativeRenderSpec, current: Record<string, string> = spec.content): EditorField[] {
  const t = templateOf(spec);
  const layers = Array.isArray(t?.layers) ? t.layers : [];
  const slotsInTemplate = new Set<string>(layers.flatMap((l) => (l.type === 'text' ? [l.slot] : l.type === 'button' ? ['cta'] : [])));
  const required = new Set<string>(['headline', ...(t?.requires ?? []).filter((r) => r !== 'image' && r !== 'logo')]);
  for (const l of layers) if (l.type === 'text' && !l.optional) required.add(l.slot);
  return ORDER.filter((s) => slotsInTemplate.has(s) && !PROTECTED.has(s) && typeof spec.original[s] === 'string' && spec.original[s].length > 0).map((s) => ({
    id: s,
    label: LABEL[s],
    value: current[s] ?? '',
    original: spec.original[s],
    multiline: s === 'support' || s === 'quote' || s === 'headline',
    maxLength: maxLen(s),
    required: required.has(s),
  }));
}

export interface FieldError {
  field: string;
  message: string;
}

/** Cleans what the user typed (control characters out, whitespace collapsed) and validates it against the creative's fields. */
export function validateEdits(spec: CreativeRenderSpec, input: unknown): { ok: true; values: Record<string, string> } | { ok: false; errors: FieldError[] } {
  const fields = editorFields(spec);
  const errors: FieldError[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ field: '*', message: 'The text fields are missing.' }] };
  const raw = input as Record<string, unknown>;
  const known = new Map(fields.map((f) => [f.id as string, f]));
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push({ field: k, message: 'This creative has no such text field.' });
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = raw[f.id];
    if (v === undefined) {
      values[f.id] = spec.content[f.id] ?? f.original;
      continue;
    }
    if (typeof v !== 'string') {
      errors.push({ field: f.id, message: `${f.label} must be text.` });
      continue;
    }
    // eslint-disable-next-line no-control-regex
    const clean = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
    if (v.length > f.maxLength * 2 || clean.length > f.maxLength) errors.push({ field: f.id, message: `${f.label} is longer than ${f.maxLength} characters.` });
    else if (!clean && f.required) errors.push({ field: f.id, message: `${f.label} cannot be empty.` });
    else values[f.id] = clean;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

export interface EditInputs {
  hero?: Buffer | null;
  secondary?: Buffer | null;
  logo?: Buffer | null;
}

export type EditResult =
  | {
      ok: true;
      png: Buffer;
      sha256: string;
      width: number;
      height: number;
      status: 'passed' | 'warnings' | 'unresolved';
      pre: PreflightResult;
      flags: string[];
      /** the geometry of what was drawn (texts, button, logo, picture crop) */
      report: RenderReport;
      /** the specification of THIS render (what a save stores) */
      spec: CreativeRenderSpec;
      /** how the new text was fitted */
      fitting: 'unchanged_layout' | 'repaired' | 'variant';
      notes: string[];
      renders: number;
      actions: DesignAttempt['actions'];
    }
  | { ok: false; errors: FieldError[]; renders: number };

const trimmedSlots = (flags: string[]) => [...new Set(flags.filter((f) => f.startsWith('text_trimmed:')).map((f) => f.slice('text_trimmed:'.length)))];
const fits = (a: DesignAttempt) => trimmedSlots(a.res.flags).length === 0 && !a.res.flags.some((f) => f.startsWith('text_slot_empty:'));

/** Re-renders the stored specification as it is (the original text): what a creative looked like, reproduced. */
export async function renderSpec(spec: CreativeRenderSpec, inputs: EditInputs) {
  return renderTemplate(renderInput(spec, spec.content, spec.tune as RenderTune, templateOf(spec), inputs, await subjects(inputs)));
}

async function subjects(inputs: EditInputs) {
  const toRender = (m: Awaited<ReturnType<typeof analyzeSubject>>) => (m ? { faces: m.faces, subject: m.subject, graphic: m.graphic } : undefined);
  return { hero: inputs.hero ? toRender(await analyzeSubject(inputs.hero)) : undefined, secondary: inputs.secondary ? toRender(await analyzeSubject(inputs.secondary)) : undefined };
}

function renderInput(spec: CreativeRenderSpec, content: Record<string, string>, tune: RenderTune, template: TemplateDef, inputs: EditInputs, subj: Awaited<ReturnType<typeof subjects>>) {
  return {
    template,
    width: spec.width,
    height: spec.height,
    content: content as CreativeContent,
    palette: spec.palette,
    ...(spec.styleId ? { styleId: spec.styleId as never } : {}),
    ...(spec.anchors ? { anchors: spec.anchors } : {}),
    brandName: spec.brandName,
    images: { ...(inputs.hero ? { hero: inputs.hero } : {}), ...(inputs.secondary ? { secondary: inputs.secondary } : {}) },
    logo: spec.logo ? (inputs.logo ?? null) : null,
    ...(spec.heroFocus ? { heroFocus: spec.heroFocus } : {}),
    ...(spec.logoAdapt ? { logoAdapt: true } : {}),
    ...(subj.hero ? { subject: subj.hero } : {}),
    ...(subj.secondary ? { secondarySubject: subj.secondary } : {}),
    tune,
    // a manual edit is drawn as written: no shorter wording replaces it
    alternatives: {},
  };
}

const checkOf = (spec: CreativeRenderSpec) => (res: { report: RenderReport; flags: string[]; layers: string[] }): PreflightResult =>
  preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: spec.check.hasLogo, hasPicture: spec.check.hasPicture, templateHasImage: spec.check.templateHasImage, media: spec.check.media, layout: { density: spec.check.density } });

/**
 * Renders a creative with new text, keeping its composition whenever the text fits it. Returns the real PNG (the very bytes a save stores and the
 * ZIP exports) or the fields that do not fit. Deterministic: the same specification and text give the same image.
 */
export async function renderEdit(spec: CreativeRenderSpec, values: Record<string, string>, inputs: EditInputs, o: { maxVariants?: number } = {}): Promise<EditResult> {
  const content: Record<string, string> = { ...spec.content };
  for (const f of editorFields(spec)) {
    const v = values[f.id];
    if (v === undefined) continue;
    if (v) content[f.id] = v;
    else delete content[f.id];
  }
  const subj = await subjects(inputs);
  const check = checkOf(spec);
  let renders = 0;
  const notes: string[] = [];
  // 1-3. the stored composition with its own repairs (line wrapping and type size inside the template's limits happen in the renderer; adaptive
  // spacing, crop, logo and opacity repairs in the bounded loop, starting from the delivered tune)
  const stored = templateOf(spec);
  const renderStored = (tune: RenderTune) => renderTemplate(renderInput(spec, content, tune, stored, inputs, subj));
  let best: { a: DesignAttempt; template: TemplateDef; variant: string; fitting: 'unchanged_layout' | 'repaired' | 'variant' } | null = null;
  // 1. the composition exactly as delivered: kept when the new text fits it and adds no failure the delivered creative did not already have
  const first = await renderStored(spec.tune as RenderTune);
  renders++;
  if (!first.ok) return { ok: false, errors: [{ field: '*', message: 'The creative could not be rendered again (one of its pictures or its logo could not be read).' }], renders };
  const pre0 = check(first);
  const a0: DesignAttempt = { templateId: spec.templateId, res: first, pre: pre0, tune: spec.tune as RenderTune, actions: [] };
  const known = new Set(spec.baseline);
  const visibleEnough = spec.baselineVisibility === null || visibilityScore(first.report) >= spec.baselineVisibility - 0.05;
  if (fits(a0) && pre0.failures.every((f) => known.has(f.id)) && visibleEnough) best = { a: a0, template: stored, variant: spec.variant, fitting: 'unchanged_layout' };
  // 2-3. the bounded repair loop from the delivered tune (adaptive spacing, crop, logo, opacity)
  let runStored: Awaited<ReturnType<typeof repairLoop>> | null = null;
  if (!best) {
    runStored = await repairLoop(spec.templateId, renderStored, check, 4, spec.tune as RenderTune);
    renders += runStored.renders;
    const b = runStored.best && fits(runStored.best) ? runStored.best : fits(a0) ? a0 : null;
    if (b) best = { a: b, template: stored, variant: spec.variant, fitting: b === a0 || JSON.stringify(b.tune) === JSON.stringify(spec.tune) ? 'unchanged_layout' : 'repaired' };
  }
  // 4. the text does not fit (or a critical problem remains): another variant of the SAME template, reflowed for the new text
  // (a critical problem the delivered creative already had is not a reason to change its layout: only a NEW one, or text that does not fit, is)
  const newCritical = (a: DesignAttempt) => a.pre.failures.some((f) => CRITICAL_CHECKS.has(f.id) && (!known.has(f.id) || (spec.baselineVisibility !== null && visibilityScore(a.res.report) < spec.baselineVisibility - 0.05)));
  if (!best || newCritical(best.a)) {
    const lib = TEMPLATE_LIBRARY.find((t) => t.id === spec.templateId && t.version === spec.templateVersion);
    if (lib) {
      const profile = await profileOf(spec, content, inputs, subj);
      const comps = rankCompositions([lib], profile).filter((c) => !c.hard.some((h) => /^(asset_fit|template_fit|graphic_crop)/.test(h)));
      comps.sort((a, b) => Number(b.variant === spec.variant) - Number(a.variant === spec.variant) || b.score - a.score);
      for (const comp of comps.slice(0, o.maxVariants ?? 2)) {
        const initial: RenderTune = (spec.tune as RenderTune).brandName ? { brandName: true } : {};
        const run = await repairLoop(spec.templateId, (tune) => renderTemplate(renderInput(spec, content, tune, comp.template, inputs, subj)), check, 4, initial);
        renders += run.renders;
        if (!run.best || !fits(run.best)) continue;
        if (!best || isBetter(run.best, best.a)) {
          best = { a: run.best, template: comp.template, variant: comp.variant, fitting: 'variant' };
          notes.push(comp.variant === spec.variant ? 'The text boxes of the layout were reflowed for the new text.' : `The layout was adapted (${comp.variant}) so the new text fits.`);
        }
        if (!newCritical(run.best)) break;
      }
    }
  }
  if (!best) {
    // 5. nothing fits: name the field, never cut it
    const tried = trimmedSlots([...(runStored?.best?.res.flags ?? []), ...first.flags]);
    const fields = editorFields(spec);
    const errors: FieldError[] = (tried.length ? tried : fields.filter((f) => (values[f.id] ?? '').length > f.original.length).map((f) => f.id as string)).map((slot) => {
      const f = fields.find((x) => x.id === slot);
      const label = f?.label ?? slot;
      const len = (values[slot] ?? content[slot] ?? '').length;
      return { field: slot, message: `${label} is too long for this design: it would be cut. Shorten it${f ? ` (it has ${len} characters; the original had ${f.original.length})` : ''}.` };
    });
    return { ok: false, errors: errors.length ? errors : [{ field: '*', message: 'The new text does not fit this design. Shorten it.' }], renders };
  }
  const { a } = best;
  const png = a.res.png;
  const next: CreativeRenderSpec = { ...spec, template: best.template, variant: best.variant, tune: a.tune as Record<string, unknown>, content };
  return { ok: true, png, sha256: sha256Of(png), width: a.res.width, height: a.res.height, status: designStatus(a.pre), pre: a.pre, flags: a.res.flags, report: a.res.report, spec: next, fitting: best.fitting, notes, renders, actions: a.actions };
}

async function profileOf(spec: CreativeRenderSpec, content: Record<string, string>, inputs: EditInputs, subj: Awaited<ReturnType<typeof subjects>>): Promise<ContentProfile> {
  const dims = async (b: Buffer | null | undefined) => (b ? await sharp(b).metadata().then((m) => (m.width && m.height ? ((m.orientation ?? 1) >= 5 ? { w: m.height, h: m.width } : { w: m.width, h: m.height }) : null)).catch(() => null) : null);
  const hero = await dims(inputs.hero);
  const m = inputs.hero ? await analyzeSubject(inputs.hero) : null;
  return {
    width: spec.width,
    height: spec.height,
    picture: hero && subj ? { w: hero.w, h: hero.h, focus: spec.heroFocus, subject: m, kind: (spec.pictureKind ?? 'photograph') as never } : null,
    hasSecondPicture: !!inputs.secondary,
    logo: spec.logo ? await dims(inputs.logo) : null,
    copy: content as ContentProfile['copy'],
    kind: spec.check.media?.kind ?? null,
    fastScroll: !!spec.check.media?.fastScroll,
  };
}

/** The design diagnostics of an edited creative (the same shape the Quality Reviewer and the ZIP read). */
export function editDiagnostics(r: Extract<EditResult, { ok: true }>, previous: DesignDiagnostics | undefined): DesignDiagnostics {
  return {
    passed: r.pre.passed,
    status: r.status,
    checks: r.pre.checks.map((c) => ({ id: c.id, category: c.category, status: c.status, detail: c.detail })).slice(0, 32),
    repairs: [{ kind: 'copy', target: 'text', detail: 'The text was edited by the owner and the creative was rendered again (no AI call).' }, ...(r.fitting === 'variant' ? [{ kind: 'position', target: r.spec.variant, detail: r.notes[0] ?? 'The layout was adapted to the new text.' }] : []), ...r.actions].slice(0, 40),
    renders: r.renders,
    templatesTried: [r.spec.templateId],
    templateChanged: false,
    ...(previous?.composition ? { composition: { ...previous.composition, variant: r.spec.variant } } : {}),
    ...(previous?.crop !== undefined ? { crop: previous.crop } : {}),
    ...(previous?.concept ? { concept: previous.concept } : {}),
    ...(previous?.matrix !== undefined ? { matrix: previous.matrix } : {}),
    ...(previous?.picture !== undefined ? { picture: previous.picture } : {}),
    shortened: [],
  };
}

// ---- the campaign package after a saved revision ----------------------------------------------------------------------------------------------

export const EDITABLE_SLOTS = TEXT_SLOTS.filter((s) => !PROTECTED.has(s));

type Creative = TemplateCreativeRecord;

/** The readiness of a delivered creative from its own design checks and the open review findings about it (same rule as the campaign run). */
function readiness(pkg: CampaignPackage, tc: Creative, variantId: string | null) {
  const open = pkg.reviewFindings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && (f.assetRef === tc.assetId || (!!variantId && f.assetRef === variantId)));
  const blocking = open.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  const critical = (tc.design?.checks ?? []).filter((c) => c.status === 'fail' && CRITICAL_CHECKS.has(c.id));
  const blockers = [...critical.map((c) => c.detail), ...blocking.map((f) => f.finding)].map((x) => x.slice(0, 200)).slice(0, 8);
  const status = tc.design?.status ?? null;
  const quality = blockers.length || status === 'unresolved' ? ('unresolved' as const) : status === 'warnings' || open.length ? ('passed_with_warnings' as const) : status === 'passed' ? ('passed' as const) : ('produced' as const);
  return { quality, publishReady: quality === 'passed' || quality === 'passed_with_warnings', blockers };
}

function repoint(pkg: CampaignPackage, slotId: string, from: string, to: AssetRecord, creative: Creative, text: { headline?: string; cta?: string }): CampaignPackage {
  const imageAssets = [...pkg.imageAssets.map((a) => (a.id === from ? { ...a, status: 'superseded' as const } : a.id === to.id ? { ...to } : a)), ...(pkg.imageAssets.some((a) => a.id === to.id) ? [] : [to])];
  const hybrid = pkg.hybrid ? { ...pkg.hybrid, creatives: pkg.hybrid.creatives.map((c) => (c.slotId === slotId ? creative : c)) } : pkg.hybrid;
  const channelLayouts = pkg.channelLayouts.map((l) => (l.assetId === from ? { ...l, id: `layout-${to.id}`, assetId: to.id, headline: text.headline ?? l.headline, ctaText: text.cta ?? l.ctaText } : l));
  let deliverables = pkg.deliverables;
  if (deliverables) {
    const items = deliverables.items.map((i) => (i.id === slotId && i.assetId === from ? { ...i, assetId: to.id, design: creative.design?.status ?? i.design, ...readiness(pkg, creative, i.variantId) } : i));
    const delivered = items.filter((i) => i.status === 'delivered');
    deliverables = { ...deliverables, items, counts: { ...deliverables.counts, ...(deliverables.counts.publishReady !== undefined ? { publishReady: delivered.filter((i) => i.publishReady).length, needsReview: delivered.filter((i) => !i.publishReady).length } : {}) } };
  }
  return { ...pkg, imageAssets, channelLayouts, deliverables, ...(hybrid ? { hybrid } : {}) } as CampaignPackage;
}

/** The creative of a slot and whether it can be edited at all (rendered, with a file). */
export function creativeOf(pkg: CampaignPackage, slotId: string): Creative | null {
  return pkg.hybrid?.creatives.find((c) => c.slotId === slotId && !!c.assetId && (c.status === 'rendered' || c.status === 'fallback_rendered')) ?? null;
}

/**
 * The package after a saved edit: the creative, its deliverable and its layout point at the new asset (the previous one is kept, superseded),
 * the design diagnostics and the readiness are those of the NEW image, and the edit (revision, original asset, edited text) is recorded. The
 * campaign's overall approval is not touched: one edited creative passing does not approve a campaign.
 */
export function applyCreativeRevision(pkg: CampaignPackage, a: { slotId: string; previousAssetId: string; asset: AssetRecord; design: DesignDiagnostics; flags: string[]; fields: Record<string, string>; original: Record<string, string>; at: string }): CampaignPackage {
  const tc = creativeOf(pkg, a.slotId);
  if (!tc || tc.assetId !== a.previousAssetId) throw new Error('stale');
  const edit = tc.edit ?? { revision: 0, originalAssetId: tc.assetId!, originalDesign: tc.design ?? null, originalFlags: tc.flags, original: a.original, fields: null, state: 'original' as const, editedAt: null, history: [] };
  const next: Creative = {
    ...tc,
    assetId: a.asset.id,
    flags: [...a.flags.filter((f) => !f.startsWith('text_shortened')), 'edited_by_owner'],
    design: a.design,
    edit: { ...edit, revision: edit.revision + 1, fields: a.fields, state: 'edited', editedAt: a.at, history: [...edit.history, { revision: edit.revision + 1, assetId: a.asset.id, kind: 'edit' as const, at: a.at }].slice(-20) },
  };
  return repoint(pkg, a.slotId, a.previousAssetId, a.asset, next, { headline: a.fields.headline, cta: a.fields.cta });
}

/** The package after "restore original": the creative points at its ORIGINAL asset again (the very file the run made), with its original diagnostics. */
export function restoreOriginalRevision(pkg: CampaignPackage, a: { slotId: string; previousAssetId: string; original: AssetRecord; at: string }): CampaignPackage {
  const tc = creativeOf(pkg, a.slotId);
  if (!tc || tc.assetId !== a.previousAssetId || !tc.edit || tc.edit.originalAssetId !== a.original.id) throw new Error('stale');
  const e = tc.edit;
  const next: Creative = {
    ...tc,
    assetId: e.originalAssetId,
    flags: e.originalFlags,
    ...(e.originalDesign ? { design: e.originalDesign } : {}),
    edit: { ...e, revision: e.revision + 1, fields: null, state: 'original', editedAt: a.at, history: [...e.history, { revision: e.revision + 1, assetId: e.originalAssetId, kind: 'restore' as const, at: a.at }].slice(-20) },
  };
  return repoint(pkg, a.slotId, a.previousAssetId, { ...a.original, status: 'rendered' }, next, { headline: e.original.headline, cta: e.original.cta });
}
