import type { ChannelId } from '../strategy/channels';
import type { CreativeBoard } from './board';
import type { CreativeFormat } from './formats';
import type { LayoutOverrides } from './layout';
import { SYSTEMATIC_IMAGE_FAILURES } from './image-results';
import type { ReviewFindingRecord, RevisionRecord } from './schemas';

/**
 * The Fixer's decision logic (pure, no model, no I/O): which repair operation a review finding calls for, and who owns it.
 *   - text problems  -> the Copywriter / Landing Content Builder revise their own text (one model call each, requested by event);
 *   - layout problems -> the Layout Designer re-renders deterministically with adjusted parameters (no model call);
 *   - image problems -> regeneration, ONLY when the user enabled it and budget remains (it costs money); otherwise the finding
 *     stays visible as unresolved. Nothing is ever repaired silently and originals are never overwritten.
 */
export type RepairOperation = RevisionRecord['operation'];

export interface CopyOp {
  id: string;
  kind: 'revise_copy';
  findingIds: string[];
  variantIds: string[];
}
export interface LandingOp {
  id: string;
  kind: 'revise_landing';
  findingIds: string[];
}
export interface ImageOp {
  id: string;
  kind: 'regenerate_image';
  conceptId: string;
  findingIds: string[];
}
export interface LayoutOp {
  id: string;
  kind: 'rerender_layout';
  conceptId: string;
  format: string;
  channel: ChannelId;
  variantId: string;
  /** Several images per concept: the planned image whose layout this is, and the original it is cut from. */
  variationId?: string | null;
  baseAssetId?: string | null;
  findingIds: string[];
  overrides: LayoutOverrides;
}

export interface FindingPlan {
  findingId: string;
  operation: RepairOperation;
  owner: string;
  /** The operation that carries out this repair (null = nothing can be done). */
  opKey: string | null;
  note: string;
}

export interface RepairPlan {
  copy: Map<string, Set<string>>; // variantId -> finding ids
  landing: Set<string>;
  /** Findings that are repaired by aligning the landing call to action with the ads (deterministic: no model call, no wording changed). */
  ctaAlign: Set<string>;
  images: Map<string, Set<string>>; // conceptId -> finding ids
  layouts: Map<string, { conceptId: string; format: string; channel: ChannelId; variantId: string; variationId?: string | null; baseAssetId?: string | null; findingIds: Set<string>; overrides: LayoutOverrides }>;
  byFinding: FindingPlan[];
}

export interface RepairOptions {
  canRegenerate: boolean;
  formats: { format: CreativeFormat; channel: ChannelId }[];
  owners: { copywriter: string; landing: string; layout: string; visual: string };
}

export const layoutKey = (conceptId: string, format: string, variantId: string, variationId?: string | null) => `${conceptId}|${format}|${variantId}${variationId ? `|${variationId}` : ''}`;

/** Parameters that address the cause the reviewer measured. */
export function overridesFor(f: Pick<ReviewFindingRecord, 'kind' | 'finding'>): LayoutOverrides {
  switch (f.kind) {
    case 'text_overflow':
      return { headlineScale: 0.82, hideBody: true };
    case 'low_contrast':
      return { scrim: 0.78 };
    case 'logo':
      return /overlap|collid/i.test(f.finding) ? { logoPosition: 'top-right' } : {};
    default:
      return {};
  }
}

const merge = (a: LayoutOverrides, b: LayoutOverrides): LayoutOverrides => ({
  ...a,
  ...b,
  headlineScale: a.headlineScale && b.headlineScale ? Math.min(a.headlineScale, b.headlineScale) : (b.headlineScale ?? a.headlineScale),
  scrim: Math.max(a.scrim ?? 0, b.scrim ?? 0) || undefined,
});

export function planRepairs(board: CreativeBoard, findings: ReviewFindingRecord[], opts: RepairOptions): RepairPlan {
  const plan: RepairPlan = { copy: new Map(), landing: new Set(), ctaAlign: new Set(), images: new Map(), layouts: new Map(), byFinding: [] };
  const none = (f: ReviewFindingRecord, owner: string, note: string) => plan.byFinding.push({ findingId: f.id, operation: 'none', owner, opKey: null, note });
  const variantOf = (ref: string | null) => {
    if (!ref) return undefined;
    if (board.variants.some((v) => v.id === ref)) return ref;
    return board.layouts.find((l) => l.assetId === ref)?.variantId;
  };
  const addLayout = (conceptId: string, format: string, channel: ChannelId, variantId: string, f: ReviewFindingRecord, variationId?: string | null, baseAssetId?: string | null) => {
    const k = layoutKey(conceptId, format, variantId, variationId);
    const cur = plan.layouts.get(k);
    if (cur) {
      cur.findingIds.add(f.id);
      cur.overrides = merge(cur.overrides, overridesFor(f));
    } else plan.layouts.set(k, { conceptId, format, channel, variantId, variationId, baseAssetId, findingIds: new Set([f.id]), overrides: overridesFor(f) });
    return k;
  };

  for (const f of findings) {
    if (f.responsibleAgent === 'copywriter') {
      const v = variantOf(f.assetRef);
      if (!v) {
        none(f, opts.owners.copywriter, 'The finding names no copy variant, so there is nothing specific to revise.');
        continue;
      }
      (plan.copy.get(v) ?? plan.copy.set(v, new Set()).get(v)!).add(f.id);
      plan.byFinding.push({ findingId: f.id, operation: 'revise_copy', owner: opts.owners.copywriter, opKey: `copy:${v}`, note: '' });
    } else if (f.responsibleAgent === 'landing' && f.kind === 'cta_mismatch' && f.source === 'deterministic') {
      // the landing page's text revision cannot change its call-to-action TYPE, so this one is aligned directly (and said so)
      plan.ctaAlign.add(f.id);
      plan.byFinding.push({ findingId: f.id, operation: 'align_cta', owner: opts.owners.landing, opKey: 'cta:landing', note: '' });
    } else if (f.responsibleAgent === 'landing') {
      plan.landing.add(f.id);
      plan.byFinding.push({ findingId: f.id, operation: 'revise_landing', owner: opts.owners.landing, opKey: 'landing', note: '' });
    } else if (f.responsibleAgent === 'layout') {
      const existing = board.layouts.find((l) => l.assetId === f.assetRef);
      if (existing) {
        const k = addLayout(existing.conceptId, existing.format, existing.channel, existing.variantId, f, existing.variationId, existing.baseAssetId);
        plan.byFinding.push({ findingId: f.id, operation: 'rerender_layout', owner: opts.owners.layout, opKey: `layout:${k}`, note: '' });
      } else if (f.assetRef && board.concepts.some((c) => c.id === f.assetRef)) {
        // the concept has no exported layout at all: render each requested format again
        let any = false;
        for (const { format, channel } of opts.formats) {
          const variant = board.variants.find((v) => v.conceptId === f.assetRef && v.channel === channel) ?? board.variants.find((v) => v.conceptId === f.assetRef);
          if (!variant) continue;
          const k = addLayout(f.assetRef, format.id, channel, variant.id, f);
          if (!any) plan.byFinding.push({ findingId: f.id, operation: 'rerender_layout', owner: opts.owners.layout, opKey: `layout:${k}`, note: '' });
          any = true;
        }
        if (!any) none(f, opts.owners.layout, 'There is no copy for this concept to lay out.');
      } else none(f, opts.owners.layout, 'The finding does not point to a layout that can be re-rendered.');
    } else {
      // visual
      const asset = board.assets.find((a) => a.id === f.assetRef);
      const conceptId = asset?.conceptId ?? (board.concepts.some((c) => c.id === f.assetRef) ? f.assetRef! : undefined);
      const result = conceptId ? board.imageResults.find((r) => r.conceptId === conceptId) : undefined;
      // regeneration must neither get around the image limit the user chose nor repeat a failure that will happen again
      const cannotRetry = result && (result.stage === 'budget' || result.stage === 'configuration' || result.stage === 'planning' || (result.errorCode !== null && SYSTEMATIC_IMAGE_FAILURES.has(result.errorCode)));
      if (!opts.canRegenerate) none(f, opts.owners.visual, 'Image regeneration is switched off (or its budget is used up), so the image is kept as it is. The issue stays visible in the report.');
      else if (cannotRetry) none(f, opts.owners.visual, result!.stage === 'budget' ? 'This concept was left without an AI image because of the image limit you chose; regeneration does not get around that limit.' : 'Regenerating would repeat the same failure, so no request is made. Fix the cause named in the finding first.');
      else if (!conceptId) none(f, opts.owners.visual, 'The finding does not say which image it concerns.');
      else {
        (plan.images.get(conceptId) ?? plan.images.set(conceptId, new Set()).get(conceptId)!).add(f.id);
        plan.byFinding.push({ findingId: f.id, operation: 'regenerate_image', owner: opts.owners.visual, opKey: `image:${conceptId}`, note: '' });
      }
    }
  }
  return plan;
}

/**
 * Layout operations of the second wave: the explicit ones plus the CONSEQUENCES of wave 1 (every layout of a revised variant
 * must show the new text, every layout of a regenerated concept must use the new image). Reads the board AFTER wave 1 was committed.
 */
export function layoutOperations(board: CreativeBoard, plan: RepairPlan, applied: { variantIds: string[]; conceptIds: string[] }, nextId: () => string): LayoutOp[] {
  const ops = new Map<string, LayoutOp>();
  const add = (conceptId: string, format: string, channel: ChannelId, variantId: string, findingIds: Iterable<string>, overrides: LayoutOverrides, variationId?: string | null, baseAssetId?: string | null) => {
    const k = layoutKey(conceptId, format, variantId, variationId);
    const cur = ops.get(k);
    if (cur) {
      cur.findingIds = [...new Set([...cur.findingIds, ...findingIds])];
      cur.overrides = merge(cur.overrides, overrides);
    } else ops.set(k, { id: nextId(), kind: 'rerender_layout', conceptId, format, channel, variantId, variationId, baseAssetId, findingIds: [...findingIds], overrides });
  };
  for (const v of plan.layouts.values()) add(v.conceptId, v.format, v.channel, v.variantId, v.findingIds, v.overrides, v.variationId, v.baseAssetId);
  for (const l of board.layouts) {
    const a = board.assets.find((x) => x.id === l.assetId);
    if (a?.status === 'superseded') continue;
    const copyIds = plan.copy.get(l.variantId);
    if (applied.variantIds.includes(l.variantId)) add(l.conceptId, l.format, l.channel, l.variantId, copyIds ?? [], {}, l.variationId, l.baseAssetId);
    if (applied.conceptIds.includes(l.conceptId)) add(l.conceptId, l.format, l.channel, l.variantId, [...(plan.images.get(l.conceptId) ?? [])], {}, l.variationId, l.baseAssetId);
  }
  return [...ops.values()];
}
