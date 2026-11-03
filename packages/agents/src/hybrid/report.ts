import { COLLECTIONS_VERSION } from '../collections/library';
import type { CreativeBoard } from '../creative/board';
import type { CostReport } from '../creative/schemas';
import type { BrandContext } from '../runtime/programs/f4/env';
import type { BrandBlock, HybridBlock, HybridCounts } from './records';
import type { HybridSettings } from './settings';

/**
 * The honest tally of a Hybrid Production run. "Delivered" counts only what really exists: an original AI image that the provider returned,
 * and a template creative that was rendered to a file. A failed request, a skipped slot and a stand-in are never counted as delivered.
 */
export function hybridCounts(o: { board: Pick<CreativeBoard, 'allocation' | 'variations' | 'hybridPlan' | 'templateCreatives'>; imageRequests: number; text: { calls: number; inputTokens: number; outputTokens: number }; cost: CostReport | null; /** NO AI HYBRID: the image cost is exactly zero, not unknown */ noAi?: boolean }): HybridCounts {
  const { board } = o;
  const vars = board.variations;
  const originalsPlanned = board.allocation?.allocated ?? vars.length;
  const generated = vars.filter((v) => v.status === 'generated').length;
  const failed = vars.filter((v) => v.status === 'failed').length;
  const blocked = vars.filter((v) => v.status === 'blocked_by_budget').length;
  const skipped = Math.max(0, originalsPlanned - generated - failed - blocked);
  const plannedTemplates = board.hybridPlan?.slots.length ?? board.templateCreatives.length;
  const rendered = board.templateCreatives.filter((c) => c.status === 'rendered').length;
  const fallbackRendered = board.templateCreatives.filter((c) => c.status === 'fallback_rendered').length;
  const failedRenders = board.templateCreatives.filter((c) => c.status === 'failed').length;
  const skippedRenders = Math.max(0, plannedTemplates - rendered - fallbackRendered - failedRenders);
  return {
    originals: { planned: originalsPlanned, requested: o.imageRequests, generated, failed, skipped, blockedByBudget: blocked },
    templates: { planned: plannedTemplates, rendered, fallbackRendered, failed: failedRenders, skipped: skippedRenders },
    total: { planned: originalsPlanned + plannedTemplates, delivered: generated + rendered + fallbackRendered },
    text: o.text,
    spending: {
      approvedUsd: o.cost?.approvedUsd ?? null,
      spentUsd: o.cost?.spentUsd ?? 0,
      textUsd: o.cost?.textUsd ?? 0,
      imageUsd: o.noAi ? 0 : (o.cost?.imageUsd ?? null),
      note: o.noAi
        ? 'NO AI HYBRID: no image-generation request was made, so image cost is exactly $0. Only text-model calls (and any paid search you approved) cost money. Template creatives are rendered locally and are never AI images.'
        : 'Only original image requests and text-model calls are paid. Template creatives are rendered locally and cost nothing; they are counted separately and never as AI images.',
    },
  };
}

export function hybridNotes(counts: HybridCounts, board: Pick<CreativeBoard, 'selection' | 'templateQuality' | 'directionRefined'>): string[] {
  const n: string[] = [];
  const o = counts.originals;
  const t = counts.templates;
  if (o.generated < o.planned) n.push(`${o.generated} of the ${o.planned} planned original AI images exist (${o.failed} failed, ${o.blockedByBudget} stopped by a budget, ${o.skipped} not requested).`);
  if (t.rendered + t.fallbackRendered < t.planned) n.push(`${t.rendered + t.fallbackRendered} of the ${t.planned} planned template creatives exist (${t.failed} failed to render, ${t.skipped} not rendered).`);
  if (t.fallbackRendered) n.push(`${t.fallbackRendered} template creative(s) use a picture-free template because their original image does not exist; they are labelled FALLBACK, not AI images.`);
  for (const w of board.selection?.warnings ?? []) n.push(w);
  if (!board.directionRefined) n.push('The visual direction comes from the style library, the brand and the strategy without model refinement.');
  if (board.templateQuality && !board.templateQuality.complete) n.push(`Template quality check: ${board.templateQuality.summary}`);
  return n.slice(0, 20);
}

/** What the approved brand content became in this campaign. null when Get Content was not used (nothing is recorded then). */
export function brandBlockOf(brand: BrandContext | null | undefined, creatives: readonly { slotId: string; status: string; logo?: { applied: boolean; reason: string | null } | null }[]): BrandBlock | null {
  if (!brand) return null;
  const rendered = creatives.filter((c) => c.status === 'rendered' || c.status === 'fallback_rendered');
  return {
    logo: brand.logo ? { approved: true, assetId: brand.logo.assetId, source: brand.logo.source, fileName: brand.logo.fileName, width: brand.logo.width, height: brand.logo.height } : null,
    withLogo: rendered.filter((c) => c.logo?.applied === true).length,
    omitted: rendered.filter((c) => c.logo && !c.logo.applied).map((c) => ({ slotId: c.slotId, reason: c.logo?.reason ?? 'No reason was recorded.' })),
    approvedPhotos: brand.approvedPhotos,
    contentApprovedAt: brand.approvedAt,
  };
}

export function buildHybridBlock(o: { settings: HybridSettings; libraryVersion: string; board: CreativeBoard; counts: HybridCounts; refusedImageRequests?: number; brand?: BrandContext | null }): HybridBlock {
  const { board } = o;
  const brand = brandBlockOf(o.brand, board.templateCreatives);
  const imagery = board.imagery
    ? {
        ...board.imagery,
        refusedAttempts: o.refusedImageRequests ?? board.imagery.refusedAttempts,
        blockedSlots: board.templateCreatives.filter((c) => c.status === 'skipped' && c.flags.includes('blocked')).map((c) => ({ slotId: c.slotId, reason: c.reason ?? 'Blocked.' })),
      }
    : null;
  return {
    mode: 'hybrid',
    version: 1,
    settings: o.settings,
    libraryVersion: o.libraryVersion,
    collectionsVersion: o.settings.design ? COLLECTIONS_VERSION : null,
    discovery: board.discovery ?? null,
    direction: board.direction,
    selection: board.selection,
    creatives: board.templateCreatives,
    counts: o.counts,
    quality: board.templateQuality,
    imagery,
    ...(brand ? { brand } : {}),
    notes: hybridNotes(o.counts, board),
  };
}
