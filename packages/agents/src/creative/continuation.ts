import type { AssetStore, NewAsset } from './assets';
import type { HybridSettings } from '../hybrid/settings';
import type { TemplateCreativeRecord, TemplateSelectionPlan } from '../hybrid/records';
import type { VisualDirectionBrief } from '../templates/schema';
import type { AssetRecord, CampaignPackage, ConceptRecord, CopyVariantRecord, ImageAllocationPlan, ImageVariationRecord, LandingContent, LayoutRecord } from './schemas';

/**
 * IMAGE-ONLY CONTINUATION: finishing the original images of an earlier campaign WITHOUT running research, strategy, copy or the
 * landing page again.
 *
 * The earlier campaign is never touched. A continuation is a NEW campaign (a revision) that starts from copies of everything that
 * succeeded: the concepts, the copy, the landing content, the allocation plan, every original image that was really generated and the
 * layouts cut from them. Only the images that are missing (failed, blocked by a budget, never requested) are requested again, with
 * the prompts that were already planned, under a budget the user approves again. Fallback backgrounds are not carried over: a concept
 * that still has no original afterwards gets a fresh, labelled one.
 */
export class ContinuationError extends Error {}

export interface ContinuationSeed {
  parentCampaignId: string;
  /** Revision number of the earlier campaign (1 for a campaign made by a full run). */
  parentRevision: number;
  concepts: ConceptRecord[];
  variants: CopyVariantRecord[];
  landing: LandingContent | null;
  allocation: ImageAllocationPlan;
  /** Copies of the earlier originals and layouts, ALREADY stored under the new campaign (new ids). */
  assets: AssetRecord[];
  layouts: LayoutRecord[];
  /** The earlier image records; generated ones point at the copied assets, the others keep their planned prompt for the retry. */
  variations: ImageVariationRecord[];
  reusedAssets: number;
  /** Hybrid Production: what the earlier campaign decided and rendered. Template creatives whose original did not exist are rendered now that it does; the rest are kept. */
  hybrid: { settings: HybridSettings; direction: VisualDirectionBrief | null; selection: TemplateSelectionPlan | null; creatives: TemplateCreativeRecord[] } | null;
}

const asNew = (a: AssetRecord, data: Buffer, patch: Partial<NewAsset>): NewAsset => {
  const { id: _id, sha256: _sha, bytes: _bytes, createdAt: _at, ...rest } = a;
  void _id;
  void _sha;
  void _bytes;
  void _at;
  return { ...rest, ...patch, data };
};

/** Copies what succeeded from the earlier campaign's store into the new campaign's store and returns the seed. */
export async function prepareContinuationSeed(pkg: CampaignPackage, from: AssetStore, to: AssetStore, parentRevision = 1): Promise<ContinuationSeed> {
  if (!pkg.imageAllocation || !pkg.imageVariations.length) throw new ContinuationError('This campaign was made with one image per concept, so there is no image plan to continue. Run a Full Production campaign to get several original images per concept.');
  const live = new Map(pkg.imageAssets.filter((a) => a.status !== 'superseded').map((a) => [a.id, a]));
  const map = new Map<string, string>();
  const keptAssets = new Map<string, string>();
  const assets: AssetRecord[] = [];

  // the originals that were really generated
  for (const v of pkg.imageVariations) {
    const old = v.status === 'generated' && v.generatedAssetId ? live.get(v.generatedAssetId) : undefined;
    if (!old || old.kind !== 'image' || old.source !== 'ai_image') continue;
    const rec = await to.save(asNew(old, await from.load(old.id), { parentAssetId: null }));
    map.set(old.id, rec.id);
    assets.push(rec);
  }
  // the layouts cut from them (Hybrid: the template creatives that were rendered with their planned picture; a FALLBACK creative is rendered again properly)
  const layouts: LayoutRecord[] = [];
  const fallbackAssets = new Set((pkg.hybrid?.creatives ?? []).filter((c) => c.status === 'fallback_rendered').map((c) => c.assetId));
  for (const l of pkg.channelLayouts) {
    if (fallbackAssets.has(l.assetId)) continue;
    const base = l.baseAssetId ? map.get(l.baseAssetId) : pkg.hybrid ? '' : undefined;
    const old = live.get(l.assetId);
    if (base === undefined || !old) continue;
    const rec = await to.save(asNew(old, await from.load(old.id), { parentAssetId: base || null, ...(old.sourceAssetIds ? { sourceAssetIds: old.sourceAssetIds.map((id) => map.get(id) ?? id) } : {}) }));
    map.set(old.id, rec.id);
    assets.push(rec);
    layouts.push({ ...l, id: `layout-${rec.id}`, assetId: rec.id, baseAssetId: base });
    keptAssets.set(l.assetId, rec.id);
  }
  const hybrid: ContinuationSeed['hybrid'] = pkg.hybrid
    ? {
        settings: structuredClone(pkg.hybrid.settings),
        direction: pkg.hybrid.direction ? structuredClone(pkg.hybrid.direction) : null,
        selection: pkg.hybrid.selection ? structuredClone(pkg.hybrid.selection) : null,
        creatives: pkg.hybrid.creatives
          .filter((c) => c.status === 'rendered' && c.assetId && keptAssets.has(c.assetId))
          .map((c) => ({ ...c, assetId: keptAssets.get(c.assetId!) ?? c.assetId, sourceAssetIds: c.sourceAssetIds.map((id) => map.get(id) ?? id) })),
      }
    : null;
  const variations = pkg.imageVariations.map((v) => (v.status === 'generated' ? { ...v, generatedAssetId: v.generatedAssetId ? (map.get(v.generatedAssetId) ?? null) : null } : { ...v }));
  return {
    parentCampaignId: pkg.id,
    parentRevision,
    concepts: structuredClone(pkg.concepts),
    variants: structuredClone(pkg.copyVariants),
    landing: pkg.landingContent ? structuredClone(pkg.landingContent) : null,
    allocation: structuredClone(pkg.imageAllocation),
    assets,
    layouts,
    variations,
    reusedAssets: assets.length,
    hybrid,
  };
}

/** The slots a continuation still has to generate: planned images that have no generated original. */
export const missingSlots = (allocation: ImageAllocationPlan, variations: Pick<ImageVariationRecord, 'variationId' | 'status'>[]) =>
  allocation.variations.filter((s) => !variations.some((v) => v.variationId === s.variationId && v.status === 'generated'));
