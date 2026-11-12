import { COLLECTIONS_VERSION } from '../collections/library';
import type { CreativeBoard } from '../creative/board';
import type { CostReport } from '../creative/schemas';
import type { BrandContext } from '../runtime/programs/f4/env';
import type { BrandBlock, HybridBlock, HybridCounts } from './records';
import type { HybridSettings } from './settings';

/**
 * The honest tally of the template creatives. "Delivered" counts only what really exists: a template creative rendered to a file. A failed or
 * blocked creative is never counted as delivered. No AI image exists in a V4 campaign: the originals block is all zeros and image cost is $0.
 */
export function hybridCounts(o: { board: Pick<CreativeBoard, 'hybridPlan' | 'templateCreatives'>; text: { calls: number; inputTokens: number; outputTokens: number }; cost: CostReport | null }): HybridCounts {
  const { board } = o;
  const planned = board.hybridPlan?.slots.length ?? board.templateCreatives.length;
  const rendered = board.templateCreatives.filter((c) => c.status === 'rendered').length;
  const fallbackRendered = board.templateCreatives.filter((c) => c.status === 'fallback_rendered').length;
  const failed = board.templateCreatives.filter((c) => c.status === 'failed').length;
  const skipped = Math.max(0, planned - rendered - fallbackRendered - failed);
  return {
    originals: { planned: 0, requested: 0, generated: 0, failed: 0, skipped: 0, blockedByBudget: 0 },
    templates: { planned, rendered, fallbackRendered, failed, skipped },
    total: { planned, delivered: rendered + fallbackRendered },
    text: o.text,
    spending: {
      approvedUsd: o.cost?.approvedUsd ?? null,
      spentUsd: o.cost?.spentUsd ?? 0,
      textUsd: o.cost?.textUsd ?? 0,
      imageUsd: 0,
      note: 'No image-generation request was made, so image cost is exactly $0. Only text-model calls (and any paid search you approved) cost money. Every creative is rendered locally from a template.',
    },
  };
}

export function hybridNotes(counts: HybridCounts, board: Pick<CreativeBoard, 'selection' | 'templateQuality'>): string[] {
  const n: string[] = [];
  const t = counts.templates;
  if (t.rendered + t.fallbackRendered < t.planned) n.push(`${t.rendered + t.fallbackRendered} of the ${t.planned} planned creatives exist (${t.failed} failed to render, ${t.skipped} blocked or not rendered).`);
  for (const w of board.selection?.warnings ?? []) n.push(w);
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

export function buildHybridBlock(o: { settings: HybridSettings; libraryVersion: string; board: CreativeBoard; counts: HybridCounts; brand?: BrandContext | null }): HybridBlock {
  const { board } = o;
  const brand = brandBlockOf(o.brand, board.templateCreatives);
  const imagery = board.imagery
    ? {
        ...board.imagery,
        // "used by" = the creatives that really DREW the picture (from their recorded sources), not the slots the allocation planned for it
        library: board.imagery.library.map((l) => ({ ...l, usedBySlots: board.templateCreatives.filter((c) => (c.status === 'rendered' || c.status === 'fallback_rendered') && c.sourceAssetIds.includes(`brand:${l.id}`)).map((c) => c.slotId) })),
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
