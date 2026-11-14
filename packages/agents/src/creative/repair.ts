import type { CreativeBoard } from './board';
import type { ReviewFindingRecord, RevisionRecord } from './schemas';

/**
 * The Quality Reviewer's repair plan (pure, no model, no I/O): which correction a review finding calls for and who carries it out.
 *   - text problems   -> the Content Writer revises exactly the named copy (one model call for the whole round);
 *   - design problems -> the Creative Designer renders the creative again (deterministic, no model call): without the supporting line when
 *                        the text does not fit, with another template of the collection when the layout is the problem;
 *   - picture problems (rights, relevance) -> nothing is changed automatically: the finding stays visible for the owner.
 * Every creative that shows revised copy is rendered again afterwards. Nothing is repaired silently and earlier versions are kept.
 */
export type RepairOperation = RevisionRecord['operation'];

export interface RerenderOp {
  slotId: string;
  findingIds: string[];
  /** render without the supporting line (text did not fit) */
  dropSupport: boolean;
  /** try another template of the collection (layout, contrast, repetition) */
  swapTemplate: boolean;
}

export interface FindingPlan {
  findingId: string;
  operation: RepairOperation;
  owner: 'copywriter' | 'layout' | 'visual';
  note: string;
}

export interface RepairPlan {
  /** variantId -> finding ids */
  copy: Map<string, string[]>;
  rerender: Map<string, RerenderOp>;
  byFinding: FindingPlan[];
}

const SWAP_KINDS = new Set(['low_contrast', 'repetitive', 'visual_defect', 'poor_crop', 'logo', 'other']);

export function planRepairs(board: CreativeBoard, findings: ReviewFindingRecord[]): RepairPlan {
  const plan: RepairPlan = { copy: new Map(), rerender: new Map(), byFinding: [] };
  const layoutOf = (ref: string | null) => (ref ? board.layouts.find((l) => l.assetId === ref) : undefined);
  const variantOf = (ref: string | null) => (ref && board.variants.some((v) => v.id === ref) ? ref : layoutOf(ref)?.variantId || undefined);
  const rerender = (slotId: string, f: ReviewFindingRecord) => {
    const cur = plan.rerender.get(slotId) ?? { slotId, findingIds: [], dropSupport: false, swapTemplate: false };
    cur.findingIds.push(f.id);
    if (f.kind === 'text_overflow') cur.dropSupport = true;
    if (SWAP_KINDS.has(f.kind) || f.kind === 'text_overflow') cur.swapTemplate = true;
    plan.rerender.set(slotId, cur);
  };
  for (const f of findings) {
    if (f.responsibleAgent === 'copywriter' || f.responsibleAgent === 'landing') {
      const v = variantOf(f.assetRef);
      if (!v) {
        plan.byFinding.push({ findingId: f.id, operation: 'none', owner: 'copywriter', note: 'The finding names no specific copy, so there is nothing specific to revise; it stays visible.' });
        continue;
      }
      plan.copy.set(v, [...(plan.copy.get(v) ?? []), f.id]);
      plan.byFinding.push({ findingId: f.id, operation: 'revise_copy', owner: 'copywriter', note: '' });
    } else if (f.responsibleAgent === 'layout') {
      const l = layoutOf(f.assetRef);
      const slots = l?.slotId ? [l.slotId] : board.templateCreatives.filter((c) => c.conceptId === f.assetRef && c.status === 'failed').map((c) => c.slotId);
      if (!slots.length) {
        plan.byFinding.push({ findingId: f.id, operation: 'none', owner: 'layout', note: 'The finding does not point to a creative that can be rendered again.' });
        continue;
      }
      for (const s of slots) rerender(s, f);
      // essential text that no approved wording made fit: the Content Writer also writes a shorter call to action / headline for exactly this copy
      // (part of the round's ONE revision call), and the creative is rendered again with it
      if (f.kind === 'text_overflow' && l?.variantId && /call to action|headline/.test(f.finding)) {
        plan.copy.set(l.variantId, [...(plan.copy.get(l.variantId) ?? []), f.id]);
        plan.byFinding.push({ findingId: f.id, operation: 'revise_copy', owner: 'copywriter', note: 'A shorter wording of the text that did not fit.' });
      }
      plan.byFinding.push({ findingId: f.id, operation: 'rerender_layout', owner: 'layout', note: '' });
    } else {
      plan.byFinding.push({ findingId: f.id, operation: 'none', owner: 'visual', note: 'A picture problem is never repaired automatically (no picture is generated or swapped in without your approval). Change the picture in the image library and run the campaign again.' });
    }
  }
  return plan;
}

/** The creatives that show one of these copy variants: they are rendered again once the copy is revised. */
export function slotsShowing(board: CreativeBoard, variantIds: Iterable<string>): string[] {
  const ids = new Set(variantIds);
  return (board.selection?.items ?? []).filter((i) => i.content.variantId && ids.has(i.content.variantId)).map((i) => i.slotId);
}
