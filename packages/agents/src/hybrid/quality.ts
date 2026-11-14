import sharp from 'sharp';
import { CREATIVE_FORMATS } from '../creative/formats';
import type { AssetRecord } from '../creative/schemas';
import { originOf, type LibraryImageRecord, type TemplateCreativeRecord, type TemplateQualityIssue, type TemplateQualityReport, type TemplateSelectionPlan } from './records';

/**
 * THE TEMPLATE QUALITY REVIEW (deterministic, no model call): is the template side of the export COMPLETE and HONEST?
 *   - every planned template creative has an outcome (rendered, fallback-rendered, failed or skipped, with the reason)
 *   - every rendered one is a real file of exactly the planned size, with its template id + version and its source assets recorded
 *   - no two template creatives are the same bytes (a renamed copy is not a second creative)
 *   - a render that had to cut text is reported
 *   - what the DESIGN PREFLIGHT still found after its automatic repairs (templates/preflight.ts), one typed issue per remaining failure:
 *     text_issue, image_issue, crop_issue, occlusion_issue, logo_issue, safe_area_issue, template_mismatch, ui_contamination, duplicate_layout
 * It repairs nothing itself: findings with `repairable` become re-render requests of the Quality Reviewer, the rest are limitations the user is told about.
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
  /** The campaign's image library with its provenance (V4.3): a drawn picture without a traceable source is reported. */
  library?: readonly LibraryImageRecord[] | null;
  /** slotId -> kind and matrix cell of the plan (V4.3: repetition inside one channel is judged per channel; matrix partners share a design on purpose) */
  slots?: readonly { slotId: string; kind?: string | null; channel: string; matrix?: { group: string; design: number } | null }[] | null;
}

/** Design preflight category -> the issue kind the review reports. */
export const DESIGN_ISSUE = {
  text: 'text_issue',
  image: 'image_issue',
  crop: 'crop_issue',
  occlusion: 'occlusion_issue',
  logo: 'logo_issue',
  safe_area: 'safe_area_issue',
  template_mismatch: 'template_mismatch',
  ui_contamination: 'ui_contamination',
  duplicate_layout: 'duplicate_layout',
  alignment: 'alignment_issue',
  media: 'media_issue',
  composition: 'composition_issue',
} as const satisfies Record<string, TemplateQualityIssue['kind']>;
const MAJOR_DESIGN = new Set(['text', 'crop', 'occlusion', 'logo', 'ui_contamination', 'media']);
const NOT_A_PICTURE = new Set(['brand_graphic', 'text_heavy_graphic', 'logo']);

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
      issues.push({ slotId: item.slotId, assetId: null, kind: 'missing_render', severity: 'major', message: `${item.slotId} (${item.templateName}, ${item.format}) failed to render: ${rec.reason ?? 'unknown reason'}.`, repairable: true });
      continue;
    }
    if (rec.status === 'skipped') {
      count.skipped++;
      issues.push({ slotId: item.slotId, assetId: null, kind: 'missing_render', severity: 'major', message: `${item.slotId} (${item.templateName}, ${item.format}) was not rendered: ${rec.reason ?? 'no template of the collection fits it'}.`, repairable: false });
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
    // essential text cut with an ellipsis ("Start the free Management and Risk Chec...") is never acceptable in a final asset: it blocks approval and is repaired
    const cutText = asset.flags.filter((f) => f.startsWith('text_trimmed'));
    if (cutText.length) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'text_trimmed', severity: 'major', message: `${item.slotId}: ${cutText.map((f) => (f.endsWith(':cta') ? 'the call to action' : f.endsWith(':headline') ? 'the headline' : `the ${f.split(':')[1] ?? 'text'}`)).join(' and ')} did not fit and was cut; no shorter approved wording fitted either.`, repairable: true });
    // a brand graphic, a text-heavy banner or a logo drawn as the creative's picture (copy over existing copy, the logo twice)
    const pk = rec.design?.picture?.kind;
    if (pk && NOT_A_PICTURE.has(pk)) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'asset_mismatch', severity: 'major', message: `${item.slotId}: its picture is a ${pk.replace(/_/g, ' ')}, which carries its own text and mark; it cannot be the picture of a creative.`, repairable: true });
    // provenance: every drawn library picture can be traced to its source and its rights basis
    if (input.library) {
      for (const sid of rec.sourceAssetIds) {
        const id = sid.startsWith('brand:') ? sid.slice(6) : sid;
        const lib = input.library.find((l) => l.id === id);
        const remote = lib && (lib.source === 'website' || lib.source === 'github' || lib.source === 'stock');
        if (!lib || !lib.verification || (remote && !lib.pageUrl && !lib.originalUrl)) issues.push({ slotId: item.slotId, assetId: asset.id, kind: 'missing_provenance', severity: 'major', message: `${item.slotId}: the source of its picture (${id}) cannot be traced (${!lib ? 'it is not in the campaign image library' : !lib.verification ? 'no rights basis is recorded' : 'neither the page nor the address it came from is recorded'}). Re-approve the picture in the image library so its source is stored.`, repairable: false });
      }
    }
    // what the design preflight could not repair: people, logo and readable text block the "approved" verdict; the rest is reported
    for (const c of rec.design?.checks ?? []) {
      if (c.status !== 'fail' && !(c.status === 'warn' && c.category === 'duplicate_layout')) continue;
      const kind = DESIGN_ISSUE[c.category as keyof typeof DESIGN_ISSUE];
      if (!kind) continue;
      const major = c.status === 'fail' && MAJOR_DESIGN.has(c.category);
      issues.push({ slotId: item.slotId, assetId: asset.id, kind, severity: major ? 'major' : 'minor', message: `${item.slotId} (${rec.templateName}, ${item.format}): ${c.detail}`.slice(0, 400), repairable: c.category !== 'duplicate_layout' });
    }
  }
  // ---- campaign level: the same creative concept twice inside ONE channel (reuse across channels is allowed; matrix partners share a design on purpose)
  const slotInfo = new Map((input.slots ?? []).map((s) => [s.slotId, s]));
  const seen = new Map<string, string>();
  for (const rec of creatives) {
    if (rec.status !== 'rendered' && rec.status !== 'fallback_rendered') continue;
    const s = slotInfo.get(rec.slotId);
    const channelKey = rec.design?.concept?.channel ?? (s?.kind && s.kind !== 'social_post' ? s.kind : `social:${rec.channel}`);
    const key = `${channelKey}|${rec.templateId}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, rec.slotId);
      continue;
    }
    const m1 = slotInfo.get(first)?.matrix;
    const m2 = s?.matrix;
    if (m1 && m2 && m1.group === m2.group && m1.design === m2.design) continue;
    // the designer already tried every other layout of the collection and none passed: an honest limit of the collection (reported), not a repair loop
    const unavoidable = !!rec.design?.checks.some((c) => c.id === 'duplicate_layout' && c.status === 'warn' && /no other composition/.test(c.detail));
    issues.push({ slotId: rec.slotId, assetId: rec.assetId, kind: 'repeated_concept', severity: unavoidable ? 'minor' : 'major', message: `${rec.slotId} repeats the creative concept of ${first} in ${channelKey.replace('social:', '')} (${rec.templateId}${rec.design?.composition?.variant && rec.design.composition.variant !== 'base' ? `, ${rec.design.composition.variant}` : ''}): different words or a mirrored layout are not a new design.${unavoidable ? ' The collection has no other layout for this format that passes the checks: add a collection with more layouts, or fewer posts per channel.' : ''}`, repairable: !unavoidable });
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
