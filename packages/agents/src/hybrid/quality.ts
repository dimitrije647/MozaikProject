import sharp from 'sharp';
import { CREATIVE_FORMATS } from '../creative/formats';
import type { AssetRecord } from '../creative/schemas';
import { originOf, type TemplateCreativeRecord, type TemplateQualityIssue, type TemplateQualityReport, type TemplateSelectionPlan } from './records';

/**
 * THE TEMPLATE QUALITY REVIEW (deterministic, no model call): is the template side of the export COMPLETE and HONEST?
 *   - every planned template creative has an outcome (rendered, fallback-rendered, failed or skipped, with the reason)
 *   - every rendered one is a real file of exactly the planned size, with its template id + version and its source assets recorded
 *   - no two template creatives are the same bytes (a renamed copy is not a second creative)
 *   - a render that had to cut text is reported
 * It repairs nothing itself: findings with `repairable` are handed to the Fixer, the rest are limitations the user is told about.
 */
export interface QualityInput {
  /** The approved campaign design: every creative must come from its collection and be drawn with its palette. null = no design (earlier campaigns). */
  design?: { collectionId: string; collectionVersion: number; templateIds: readonly string[]; paletteKey: string } | null;
  selection: TemplateSelectionPlan | null;
  creatives: TemplateCreativeRecord[];
  assets: AssetRecord[];
  load(assetId: string): Promise<Buffer>;
  /** NO AI HYBRID: the ids of the approved, rights-cleared library pictures. A creative built from any other picture is a blocking issue. null = not checked (other modes). */
  allowedSources?: ReadonlySet<string> | null;
}

export async function verifyTemplateExport(input: QualityInput): Promise<TemplateQualityReport> {
  const { selection, creatives, assets } = input;
  const issues: TemplateQualityIssue[] = [];
  const planned = selection?.items ?? [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const seenHash = new Map<string, string>();
  let checked = 0;
  const count = { rendered: 0, fallbackRendered: 0, failed: 0, skipped: 0 };

  for (const item of planned) {
    const rec = creatives.find((c) => c.slotId === item.slotId);
    if (!rec) {
      issues.push({ slotId: item.slotId, assetId: null, kind: 'missing_render', severity: 'major', message: `${item.slotId} (${item.templateName}, ${item.format}) has no outcome: it was never rendered.`, repairable: true });
      count.skipped++;
      continue;
    }
    if (rec.status === 'failed') {
      count.failed++;
      issues.push({ slotId: item.slotId, assetId: null, kind: 'missing_render', severity: 'major', message: `${item.slotId} (${item.templateName}, ${item.format}) failed to render: ${rec.reason ?? 'unknown reason'}.`, repairable: !!item.variationId });
      continue;
    }
    if (rec.status === 'skipped') {
      count.skipped++;
      issues.push({ slotId: item.slotId, assetId: null, kind: 'missing_render', severity: 'major', message: `${item.slotId} (${item.templateName}, ${item.format}) was not rendered: ${rec.reason ?? 'its source image does not exist'}.`, repairable: false });
      continue;
    }
    if (input.design) {
      const d = input.design;
      const wrongCollection = !!rec.collectionId && rec.collectionId !== d.collectionId;
      const outside = !d.templateIds.includes(rec.templateId);
      const wrongPalette = !!rec.paletteKey && rec.paletteKey !== d.paletteKey;
      const unrecorded = !rec.collectionId || !rec.paletteKey;
      if (wrongCollection || outside || wrongPalette || unrecorded) {
        const why = wrongCollection ? `it was drawn with the collection "${rec.collectionId}", not the approved "${d.collectionId}"` : outside ? `${rec.templateId} does not belong to the approved collection` : wrongPalette ? 'it was drawn with a palette other than the approved one' : 'it does not record which collection and palette it was drawn with';
        issues.push({ slotId: item.slotId, assetId: rec.assetId, kind: 'design_mismatch', severity: 'major', message: `${item.slotId}: the creative does not match the approved campaign design: ${why}.`, repairable: true });
      }
    }
    if (input.allowedSources) {
      for (const sid of rec.sourceAssetIds) {
        const id = sid.startsWith('brand:') ? sid.slice(6) : sid;
        if (!input.allowedSources.has(id)) issues.push({ slotId: item.slotId, assetId: rec.assetId, kind: 'ineligible_source', severity: 'blocker', message: `${item.slotId}: it was built from a picture (${id}) that is not an approved, rights-cleared source.`, repairable: false });
      }
    }
    if (rec.logo && !rec.logo.applied) issues.push({ slotId: item.slotId, assetId: rec.assetId, kind: 'logo_omitted', severity: 'minor', message: `${item.slotId}: the approved logo is not in this creative: ${rec.logo.reason ?? 'no reason was recorded'}.`, repairable: false });
    if (rec.status === 'fallback_rendered') count.fallbackRendered++;
    else count.rendered++;
    const asset = rec.assetId ? byId.get(rec.assetId) : undefined;
    if (!asset || asset.status === 'superseded') {
      issues.push({ slotId: item.slotId, assetId: rec.assetId, kind: 'missing_render', severity: 'major', message: `${item.slotId}: the rendered file ${rec.assetId ?? '(none)'} is not part of the campaign assets.`, repairable: true });
      continue;
    }
    const origin = originOf(asset);
    if (origin !== 'TEMPLATE_RENDERED' && origin !== 'FALLBACK') issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'missing_lineage', severity: 'major', message: `${item.slotId}: the asset is labelled ${origin}, but it is a template render.`, repairable: false });
    if (!asset.templateId || asset.templateVersion == null) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'missing_lineage', severity: 'major', message: `${item.slotId}: the asset has no template id/version recorded.`, repairable: false });
    if (item.sourceKind !== 'none' && rec.status === 'rendered' && !(asset.sourceAssetIds?.length)) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'missing_lineage', severity: 'major', message: `${item.slotId}: the source image this creative was built from is not recorded.`, repairable: false });
    const fmt = CREATIVE_FORMATS[item.format];
    if (!fmt || asset.width !== fmt.width || asset.height !== fmt.height) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'wrong_dimensions', severity: 'blocker', message: `${item.slotId}: the file is ${asset.width}x${asset.height}, not the planned ${fmt ? `${fmt.width}x${fmt.height}` : item.format}.`, repairable: true });
    try {
      const buf = await input.load(asset.id);
      const meta = await sharp(buf).metadata();
      checked++;
      if (meta.format !== 'png' || meta.width !== asset.width || meta.height !== asset.height) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'unreadable_file', severity: 'blocker', message: `${item.slotId}: the stored file is ${meta.format} ${meta.width}x${meta.height}, which does not match its record.`, repairable: true });
      if (asset.sha256) {
        const twin = seenHash.get(asset.sha256);
        if (twin && twin !== item.slotId) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'duplicate_output', severity: 'major', message: `${item.slotId} is byte-identical to ${twin}: a copy is not a second creative.`, repairable: false });
        else seenHash.set(asset.sha256, item.slotId);
      }
    } catch {
      issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'unreadable_file', severity: 'blocker', message: `${item.slotId}: the stored file could not be read.`, repairable: true });
    }
    if (asset.flags.some((f) => f.startsWith('text_trimmed'))) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'text_trimmed', severity: 'minor', message: `${item.slotId}: some text was shortened with an ellipsis to fit (${asset.flags.filter((f) => f.startsWith('text_trimmed')).join(', ')}).`, repairable: false });
  }
  const blocking = issues.filter((i) => i.severity !== 'minor');
  const delivered = count.rendered + count.fallbackRendered;
  return {
    planned: planned.length,
    rendered: count.rendered,
    fallbackRendered: count.fallbackRendered,
    failed: count.failed,
    skipped: count.skipped,
    checkedFiles: checked,
    complete: planned.length > 0 && delivered === planned.length && blocking.length === 0,
    issues,
    summary: planned.length
      ? `${delivered} of ${planned.length} planned template creatives exist (${count.rendered} rendered${count.fallbackRendered ? `, ${count.fallbackRendered} rendered without their planned original` : ''}, ${count.failed} failed, ${count.skipped} not rendered); ${checked} file(s) opened and checked; ${blocking.length} blocking issue(s), ${issues.length - blocking.length} minor.`
      : 'No template creatives were planned.',
  };
}
