import JSZip from 'jszip';
import type { AssetStore } from './assets';
import { CREATIVE_FORMATS } from './formats';
import { esc, renderLandingHtml } from './landing-html';
import { originOf } from '../hybrid/records';
import { visualDirectionSummary } from '../templates/visual-direction';
import type { AssetRecord, CampaignPackage } from './schemas';

/**
 * The downloadable Campaign Package: the real image binaries, the structured JSON, the copy as text, the landing content and
 * preview, the quality review, and a manifest that lists every file with its hash. Filenames are deterministic and safe
 * (lower-case, [a-z0-9._-]); building the same package twice yields byte-identical archives. Nothing credential-shaped is in
 * a package (the package never held one). With several originals per concept the archive is organised as
 *   campaign.json, strategy/, copy/, images/originals/concept-NN-variation-MM.png, images/layouts/, landing/, review/, usage/
 * and images/asset-manifest.json maps every concept and variation to its original, its derived layouts, model, size and status.
 * Only files that really exist are referenced: a missing file is listed in `assetsMissing` and never pointed to.
 */
export interface ExportFile {
  path: string;
  bytes: number;
  sha256: string;
  assetId?: string;
  kind: 'json' | 'markdown' | 'html' | 'text' | 'image' | 'manifest';
  /** Images only: where the file really comes from (AI_GENERATED, TEMPLATE_RENDERED, FALLBACK...), its size and, for template creatives, the template and the source files. */
  origin?: string;
  width?: number;
  height?: number;
  templateId?: string;
  templateVersion?: number;
  sourceFiles?: string[];
  rights?: string;
}

export interface ExportManifest {
  campaignId: string;
  campaignName: string;
  runId: string;
  chain: { f1ReportId: string; f2ReportId: string; f3StrategyId: string };
  schemaVersion: number;
  createdAt: string;
  approval: CampaignPackage['approval'];
  files: ExportFile[];
  assetsMissing: string[];
  /** Hybrid Production: the production mode, the honest counts, the image-to-template relationships, the template versions, the models and the rights. */
  hybrid?: Record<string, unknown>;
}

/**
 * NO AI HYBRID: the bytes of a source picture, supplied by the backend (the campaign package holds only records). `data` is null when the file is not
 * available. A source's ORIGINAL is placed in the archive only when its rights allow handing the unaltered file on (`redistributeOriginal`).
 */
export interface ExportSource {
  id: string;
  fileName: string;
  data: Buffer | null;
}

export const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'file';

const sha = async (b: Buffer) => (await import('node:crypto')).createHash('sha256').update(b).digest('hex');

export function assetFileName(a: AssetRecord, conceptName: string) {
  const base = `${safeName(conceptName)}-${safeName(a.conceptId)}`;
  if (a.kind === 'image') return `images/base/${base}-v${a.version}-${safeName(a.id)}.png`;
  return `images/layouts/${base}/${safeName(a.format ?? 'layout')}-${safeName(a.channel ?? 'any')}-v${a.version}-${safeName(a.id)}.png`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** File names of a campaign with several originals per concept: concept-01-variation-02.png and the layouts under the same stem. */
export function variationFileNames(pkg: CampaignPackage) {
  const conceptNo = (id: string) => pkg.concepts.findIndex((c) => c.id === id) + 1;
  const stem = (conceptId: string, variationIndex: number) => `concept-${pad(conceptNo(conceptId))}-variation-${pad(variationIndex)}`;
  const variationOf = new Map(pkg.imageVariations.map((v) => [v.variationId, v]));
  return (a: AssetRecord): string | null => {
    const v = a.variationId ? variationOf.get(a.variationId) : undefined;
    if (!v) return null;
    const st = stem(v.conceptId, v.index);
    const dir = a.status === 'superseded' ? 'images/superseded' : 'images';
    return a.kind === 'image' ? `${dir}/originals/${st}${a.version > 1 ? `-v${a.version}` : ''}.png` : `${dir}/layouts/${st}/${safeName(a.format ?? 'layout')}-${safeName(a.channel ?? 'any')}-v${a.version}-${safeName(a.id)}.png`;
  };
}

/** File name of a TEMPLATE creative: images/templates/concept-NN/<slot>-<template>-<format>.png (older versions under images/superseded/). */
export function templateFileName(pkg: CampaignPackage) {
  const slotOf = new Map(pkg.channelLayouts.map((l) => [l.assetId, l]));
  const conceptNo = (id: string) => pkg.concepts.findIndex((c) => c.id === id) + 1;
  return (a: AssetRecord): string | null => {
    if (a.kind !== 'layout' || a.source !== 'template_render') return null;
    const l = slotOf.get(a.id);
    const dir = a.status === 'superseded' ? 'images/superseded/templates' : 'images/templates';
    return `${dir}/concept-${pad(conceptNo(a.conceptId))}/${safeName(l?.slotId ?? a.id)}-${safeName(a.templateId ?? 'template')}-${safeName(a.format ?? 'layout')}${a.version > 1 ? `-v${a.version}` : ''}.png`;
  };
}

export function campaignMarkdown(pkg: CampaignPackage): string {
  const concept = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;
  const lines: string[] = [];
  lines.push(`# ${pkg.campaignName}`, '');
  lines.push(`Campaign package ${pkg.id} · schema v${pkg.schemaVersion} · created ${pkg.createdAt} · language ${pkg.language}`);
  lines.push(`Built on F1 report ${pkg.f1ReportId}, F2 audit ${pkg.f2ReportId}, F3 strategy ${pkg.f3StrategyId} (run ${pkg.runId}).`, '');
  lines.push(`## Approval`, '', `Status: **${pkg.approval.status}** after ${pkg.approval.rounds} repair round(s). ${pkg.approval.note}`);
  if (pkg.approval.unresolvedFindingIds.length) lines.push(`Unresolved: ${pkg.approval.unresolvedFindingIds.join(', ')}`);
  lines.push('', '## Concepts', '');
  for (const c of pkg.concepts) lines.push(`### ${c.name} (${c.id})`, '', `- Angle: ${c.angle}`, `- Key message: ${c.keyMessage}`, `- Audience: ${c.audience}`, `- Call to action: ${c.ctaText} (${c.ctaType})`, `- Visual idea: ${c.visualIdea}`, '');
  lines.push('## Copy', '');
  for (const v of pkg.copyVariants) {
    lines.push(`### ${v.id} · ${concept(v.conceptId)} · ${v.channel} · ${v.placement} (${v.length})${v.version > 1 ? ` · version ${v.version}` : ''}`, '', `**${v.headline}**`, '', v.body, '');
    if (v.description) lines.push(`_${v.description}_`, '');
    lines.push(`CTA: ${v.ctaText}${v.hashtags.length ? `  \nHashtags: ${v.hashtags.join(' ')}` : ''}`);
    if (v.claims.length) lines.push('', 'Claims: ' + v.claims.map((c) => `${c.text} [${c.support}${c.ref ? ` ${c.ref}` : ''}]`).join('; '));
    if (v.history.length) lines.push('', 'Earlier versions: ' + v.history.map((h) => `v${h.version} "${h.headline}" (${h.reason})`).join('; '));
    lines.push('');
  }
  if (pkg.imageAllocation) {
    const al = pkg.imageAllocation;
    lines.push('## Original AI images', '', `Requested ${al.target}, planned ${al.allocated}${pkg.imageCounts ? `, attempted ${pkg.imageCounts.attempted}, generated ${pkg.imageCounts.generated}, failed ${pkg.imageCounts.failed}, blocked by a budget ${pkg.imageCounts.blockedByBudget}, not requested ${pkg.imageCounts.skipped}` : ''}.`, '', 'These are conceptual marketing visuals made by an image model, not photographs of a real place, product or person.', '');
    for (const c of al.perConcept) {
      lines.push(`### ${c.name} (${c.conceptId}): ${c.count} planned`, '');
      for (const v of pkg.imageVariations.filter((x) => x.conceptId === c.conceptId)) lines.push(`- ${v.variationId} · ${v.variationName} · ${v.status}${v.status === 'generated' ? '' : ` (${v.explanation ?? 'no reason recorded'})`} · for ${v.targetChannels.join(', ')} · ${v.size}`);
      lines.push('');
    }
  }
  if (pkg.hybrid) {
    const h = pkg.hybrid;
    if (h.imagery) {
      const im = h.imagery;
      lines.push('## NO AI HYBRID', '', `AI-generated images: 0 (image requests: ${im.imageRequests}${im.refusedAttempts ? `; ${im.refusedAttempts} attempt(s) were refused before anything was sent` : ''}). Source pictures discovered: ${im.discovered}. Approved pictures used: ${im.approved}${im.autoAdded ? ` (${im.autoAdded} added automatically from licensed stock)` : ''}. Template creatives: ${h.counts.templates.rendered + h.counts.templates.fallbackRendered} of ${h.counts.templates.planned} planned.`, '', 'Every creative is rendered locally from a collection template, the approved palette and the pictures listed below. The rights of each picture are in usage/sources.json and usage/rights.json.', '');
      for (const l of im.library) lines.push(`- ${l.name} · ${l.source} · ${l.license} (${l.verification})${l.attribution ? ` · credit: ${l.attribution}` : ''}${l.usedBySlots.length ? ` · used by ${l.usedBySlots.length} creative(s)` : ' · not used'}`);
      if (im.blockedSlots.length) lines.push('', 'Blocked creatives:', ...im.blockedSlots.map((b) => `- ${b.slotId}: ${b.reason}`));
      lines.push('');
    } else lines.push('## Hybrid Production', '', `${h.counts.originals.generated} original AI image(s) of ${h.counts.originals.planned} planned + ${h.counts.templates.rendered + h.counts.templates.fallbackRendered} template creative(s) of ${h.counts.templates.planned} planned = ${h.counts.total.delivered} of ${h.counts.total.planned} finished creatives.`, '', 'Template creatives are NOT AI images: each one is rendered locally from a library template, your brand colors and logo, and the original image listed for it.', '');
    if (h.direction) lines.push(`Visual direction: ${visualDirectionSummary(h.direction)}`, '');
    for (const c of h.creatives) lines.push(`- ${c.slotId} · ${c.templateName} v${c.templateVersion} · ${c.format} ${c.width}×${c.height} · ${c.status}${c.reason ? ` (${c.reason})` : ''}${c.sourceAssetIds.length ? ` · built from ${c.sourceAssetIds.join(', ')}` : ''}`);
    for (const n of h.notes) lines.push('', `- Note: ${n}`);
    lines.push('');
  }
  lines.push('## Images and layouts', '');
  const current = pkg.imageAssets.filter((a) => a.status !== 'superseded');
  for (const a of current) lines.push(`- ${a.kind === 'image' ? 'Base image' : a.source === 'template_render' ? `Template creative ${a.templateId ?? ''} ${a.format} (${a.channel})` : `Layout ${a.format} (${a.channel})`} for ${concept(a.conceptId)} · ${a.width}×${a.height} · v${a.version} · ${a.source === 'ai_image' ? `generated by ${a.model}` : a.source === 'template_render' ? `rendered locally from a template (${originOf(a)})` : 'brand-colored background (no image generated)'}${a.flags.length ? ` · flags: ${a.flags.join(', ')}` : ''}`);
  if (pkg.skippedLayouts.length) {
    lines.push('', 'Formats not exported:', '');
    for (const s of pkg.skippedLayouts) lines.push(`- ${concept(s.conceptId)} · ${s.format} (${s.channel}): ${s.reason}`);
  }
  lines.push('', '## Quality review', '');
  if (!pkg.reviewFindings.length) lines.push('No issue was found.');
  for (const f of pkg.reviewFindings) lines.push(`- [${f.severity}] ${f.kind} · ${f.assetRef ?? 'campaign'} · ${f.status} (round ${f.round}${f.resolvedInRound ? `, resolved in round ${f.resolvedInRound}` : ''}): ${f.finding} — ${f.suggestedCorrection} (${f.responsibleAgent}, ${f.source})`);
  if (pkg.revisions.length) {
    lines.push('', '### Repairs', '');
    for (const r of pkg.revisions) lines.push(`- Round ${r.round} · ${r.findingId} · ${r.operation} by ${r.owner}: ${r.status}. ${r.note}`);
  }
  lines.push('', pkg.cost ? '## Usage and cost' : '## Usage (measured, no prices)', '');
  if (pkg.cost) lines.push(`- Known spend: $${pkg.cost.spentUsd.toFixed(4)} (text $${pkg.cost.textUsd.toFixed(4)}${pkg.cost.imageUsd !== null ? `, images $${pkg.cost.imageUsd.toFixed(4)}` : ''})${pkg.cost.approvedUsd !== null ? ` of the approved $${pkg.cost.approvedUsd.toFixed(2)}` : ''}${pkg.cost.uncertainUsd ? `; uncertain (may have been billed): $${pkg.cost.uncertainUsd.toFixed(4)}` : ''}. ${pkg.cost.note}`);
  lines.push(`- Text model calls: ${pkg.usage.text.calls} (${pkg.usage.text.inputTokens} in / ${pkg.usage.text.outputTokens} out tokens)`);
  lines.push(`- Image requests: ${pkg.usage.images.requested} (${pkg.usage.images.generated} generated, ${pkg.usage.images.failed} failed, ${pkg.usage.images.regenerations} regeneration(s))${pkg.usage.images.model ? ` with ${pkg.usage.images.model} (${pkg.usage.images.quality}, ${pkg.usage.images.size})` : ''}`);
  lines.push(`- Layouts rendered locally: ${pkg.usage.layouts.rendered} (${pkg.usage.layouts.skipped} skipped)`);
  if (pkg.limitations.length) {
    lines.push('', '## Limitations', '');
    for (const l of pkg.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n') + '\n';
}

export function campaignSummaryHtml(pkg: CampaignPackage, manifest: ExportManifest): string {
  const concept = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;
  const byAsset = new Map(manifest.files.filter((f) => f.assetId).map((f) => [f.assetId!, f.path]));
  const layouts = pkg.imageAssets.filter((a) => a.kind === 'layout' && a.status !== 'superseded');
  return `<!doctype html>
<html lang="${esc(pkg.language)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"><title>${esc(pkg.campaignName)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}h1,h2{font-weight:600}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}figure{margin:0}img{width:100%;height:auto;border:1px solid #ddd;border-radius:8px}figcaption{font-size:.8rem;color:#555}.v{border-left:3px solid #ddd;padding-left:1rem;margin:1rem 0}.s{display:inline-block;padding:.1rem .5rem;border-radius:999px;background:#eee;font-size:.75rem}</style></head>
<body><h1>${esc(pkg.campaignName)}</h1>
<p><span class="s">${esc(pkg.approval.status)}</span> ${esc(pkg.approval.note)}</p>
<p>F1 ${esc(pkg.f1ReportId)} → F2 ${esc(pkg.f2ReportId)} → F3 ${esc(pkg.f3StrategyId)} → run ${esc(pkg.runId)}</p>
${pkg.imageVariations.length ? `<h2>Original AI images (${pkg.imageCounts?.generated ?? 0} of ${pkg.imageCounts?.requested ?? 0})</h2><p>Conceptual marketing visuals, not photographs of a real place, product or person.</p><div class="grid">${pkg.imageVariations
    .map((v) => `<figure>${v.generatedAssetId && byAsset.get(v.generatedAssetId) ? `<img src="${esc(byAsset.get(v.generatedAssetId)!)}" alt="${esc(v.variationName)}">` : `<div style="border:1px dashed #bbb;border-radius:8px;padding:2rem 1rem;color:#555;font-size:.8rem">${esc(v.status)}: no image</div>`}<figcaption>${esc(concept(v.conceptId))} · ${esc(v.variationName)} · ${esc(v.status)}</figcaption></figure>`)
    .join('')}</div>` : ''}
<h2>Channel layouts</h2><div class="grid">${layouts
    .map((a) => `<figure><img src="${esc(byAsset.get(a.id) ?? '')}" alt="${esc(a.altText ?? '')}"><figcaption>${esc(concept(a.conceptId))} · ${esc(a.format ?? '')} · ${a.width}×${a.height}${a.source === 'brand_gradient' ? ' · brand background' : ''}${a.source === 'template_render' ? ` · template ${esc(a.templateId ?? '')} (not an AI image)` : ''}</figcaption></figure>`)
    .join('')}</div>
<h2>Copy</h2>${pkg.copyVariants.map((v) => `<div class="v"><strong>${esc(v.headline)}</strong> <span class="s">${esc(v.channel)} · ${esc(v.placement)}</span><p>${esc(v.body)}</p><p>CTA: ${esc(v.ctaText)}</p></div>`).join('')}
<h2>Quality review</h2><ul>${pkg.reviewFindings.map((f) => `<li>[${esc(f.severity)}] ${esc(f.finding)} — <em>${esc(f.status)}</em></li>`).join('') || '<li>No issue was found.</li>'}</ul>
${pkg.limitations.length ? `<h2>Limitations</h2><ul>${pkg.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
</body></html>`;
}

export interface AssetManifestEntry {
  concept: { id: string; name: string };
  variation: { id: string; name: string; index: number; status: string } | null;
  original: { file: string | null; assetId: string | null; width: number | null; height: number | null; source: string | null; model: string | null; quality: string | null; status: string };
  layouts: { file: string; assetId: string; format: string | null; channel: string | null; width: number; height: number }[];
}

/** The credit lines of the pictures a NO AI HYBRID campaign used (from the campaign package itself; the backend may supply its own text instead). */
export function creditsFromImagery(pkg: CampaignPackage): string {
  const used = (pkg.hybrid?.imagery?.library ?? []).filter((l) => l.attribution && l.usedBySlots.length);
  if (!used.length) return '';
  return ['Image credits', '', ...used.map((l) => `${l.attribution} (${l.license}${l.attributionRequired ? ', credit required' : ''})${l.pageUrl ? ` ${l.pageUrl}` : ''}`), ''].join('\n');
}

export async function buildCampaignZip(pkg: CampaignPackage, assets: AssetStore, opts: { palette?: string[]; strategy?: unknown; credits?: string; sources?: ExportSource[]; /** the approved logo file (Get Content) */ logo?: { fileName: string; data: Buffer; rights: string | null } | null } = {}): Promise<{ zip: Buffer; manifest: ExportManifest }> {
  const zip = new JSZip();
  const date = new Date(pkg.createdAt);
  const files: ExportFile[] = [];
  const missing: string[] = [];
  const put = async (path: string, data: Buffer | string, kind: ExportFile['kind'], assetId?: string) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    zip.file(path, buf, { date, createFolders: false });
    files.push({ path, bytes: buf.length, sha256: await sha(buf), kind, ...(assetId ? { assetId } : {}) });
  };
  const concept = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;

  // a Pinterest Pin link is the user's own note inside LaunchPilot; it is not copied into a package that may be shared
  const noPin = <T extends { kind: string; url: string | null }>(refs: T[]) => refs.map((r) => (r.kind === 'pinterest_board' ? { ...r, url: null } : r));
  const shareable = pkg.hybrid ? { ...pkg, hybrid: { ...pkg.hybrid, settings: { ...pkg.hybrid.settings, references: noPin(pkg.hybrid.settings.references) }, direction: pkg.hybrid.direction ? { ...pkg.hybrid.direction, references: noPin(pkg.hybrid.direction.references) } : null, discovery: null } } : pkg;
  await put('campaign.json', JSON.stringify(shareable, null, 2), 'json');
  await put('README.md', campaignMarkdown(pkg), 'markdown');
  for (const v of [...pkg.copyVariants].sort((a, b) => a.id.localeCompare(b.id))) {
    const text = [v.headline, '', v.body, ...(v.description ? ['', v.description] : []), '', `CTA: ${v.ctaText}`, ...(v.hashtags.length ? [v.hashtags.join(' ')] : [])].join('\n') + '\n';
    await put(`copy/${safeName(concept(v.conceptId))}-${safeName(v.channel)}-${safeName(v.placement)}-${safeName(v.id)}.txt`, text, 'text');
  }
  if (pkg.landingContent) {
    await put('landing/landing-content.json', JSON.stringify(pkg.landingContent, null, 2), 'json');
    await put('landing/landing-preview.html', renderLandingHtml(pkg.landingContent, { name: pkg.campaignName, language: pkg.language, palette: opts.palette ?? [] }), 'html');
  }
  // the approved campaign design travels with the package, and so do the credits of licensed pictures (when the campaign used any)
  const design = pkg.hybrid?.settings.design ?? null;
  if (design) await put('design/campaign-design.json', JSON.stringify({ collectionId: design.collectionId, collectionVersion: design.collectionVersion, collectionsVersion: pkg.hybrid?.collectionsVersion ?? null, palette: design.palette, paletteEvidence: design.paletteEvidence, editedByUser: design.overridden, formats: design.formats, imageSourcing: design.imageSourcing, confirmedAt: design.confirmedAt }, null, 2), 'json');
  // the brand material the owner approved with Get Content: what it is and where it was used (nothing is written when Get Content was not used)
  const brand = pkg.hybrid?.brand ?? null;
  if (brand) {
    let logoFile: string | null = null;
    if (brand.logo && opts.logo?.data) {
      logoFile = `design/brand/logo-${safeName(opts.logo.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''))}${(/\.[a-z0-9]{2,5}$/i.exec(opts.logo.fileName)?.[0] ?? '.png').toLowerCase()}`;
      await put(logoFile, opts.logo.data, 'image');
    }
    await put('design/brand-content.json', JSON.stringify({ logo: brand.logo ? { ...brand.logo, file: logoFile, rights: opts.logo?.rights ?? null } : null, creativesWithLogo: brand.withLogo, creativesWithoutLogo: brand.omitted, approvedPhotographs: brand.approvedPhotos, approvedAt: brand.contentApprovedAt, note: 'The logo and photographs the owner approved with Get Content, and where the logo was used. A logo is never forced into a creative where it cannot be drawn: the reason is listed.' }, null, 2), 'json');
  }
  const credits = opts.credits || creditsFromImagery(pkg);
  if (credits) await put('CREDITS.txt', credits, 'text');
  if (opts.strategy) await put('strategy/strategy.json', JSON.stringify(opts.strategy, null, 2), 'json');
  if (pkg.imageAllocation) await put('strategy/image-allocation.json', JSON.stringify(pkg.imageAllocation, null, 2), 'json');
  const variationName = pkg.imageVariations.length ? variationFileNames(pkg) : null;
  const templateName = pkg.hybrid ? templateFileName(pkg) : null;
  const pathOf = new Map<string, string>(); // asset id -> file that really exists in the archive
  const ordered = [...pkg.imageAssets].sort((a, b) => a.conceptId.localeCompare(b.conceptId) || a.kind.localeCompare(b.kind) || (a.format ?? '').localeCompare(b.format ?? '') || a.version - b.version || a.id.localeCompare(b.id));
  for (const a of ordered) {
    let bytes: Buffer;
    try {
      bytes = await assets.load(a.id);
    } catch {
      missing.push(a.id);
      continue;
    }
    const viaTemplate = templateName?.(a) ?? null;
    const viaVariation = viaTemplate ?? variationName?.(a) ?? null;
    const name = viaVariation ?? assetFileName(a, concept(a.conceptId));
    const path = viaVariation ? name : a.status === 'superseded' ? name.replace(/^images\//, 'images/superseded/') : name;
    await put(path, bytes, 'image', a.id);
    pathOf.set(a.id, path);
    if (pkg.hybrid) {
      // lineage travels with the file: what it is, which template made it and from which files
      const f = files[files.length - 1];
      f.origin = originOf(a);
      f.width = a.width;
      f.height = a.height;
      if (a.templateId) {
        f.templateId = a.templateId;
        if (a.templateVersion != null) f.templateVersion = a.templateVersion;
      }
      if (a.rights) f.rights = a.rights.basis;
    }
  }
  if (pkg.imageVariations.length) {
    // the asset manifest: concept -> variation -> original -> derived layouts. Only files that exist in the archive are referenced.
    const entries: AssetManifestEntry[] = pkg.imageVariations.map((v) => {
      const orig = v.generatedAssetId ? pkg.imageAssets.find((a) => a.id === v.generatedAssetId) : undefined;
      const file = orig ? (pathOf.get(orig.id) ?? null) : null;
      return {
        concept: { id: v.conceptId, name: concept(v.conceptId) },
        variation: { id: v.variationId, name: v.variationName, index: v.index, status: v.status },
        original: { file, assetId: file ? orig!.id : null, width: file ? orig!.width : null, height: file ? orig!.height : null, source: file ? orig!.source : null, model: v.providerModel, quality: v.quality, status: v.status === 'generated' && !file ? 'file_missing' : v.status },
        layouts: pkg.channelLayouts
          .filter((l) => l.baseAssetId === v.generatedAssetId && pathOf.has(l.assetId))
          .map((l) => {
            const a = pkg.imageAssets.find((x) => x.id === l.assetId)!;
            return { file: pathOf.get(l.assetId)!, assetId: l.assetId, format: l.format, channel: l.channel, width: a.width, height: a.height };
          }),
      };
    });
    // concepts whose layouts use a brand-colored background instead of an original are listed too, labelled as such
    for (const l of pkg.channelLayouts) {
      const base = pkg.imageAssets.find((a) => a.id === l.baseAssetId);
      if (base?.source !== 'brand_gradient' || !pathOf.has(l.assetId)) continue;
      let e = entries.find((x) => x.variation === null && x.concept.id === l.conceptId);
      if (!e) entries.push((e = { concept: { id: l.conceptId, name: concept(l.conceptId) }, variation: null, original: { file: null, assetId: null, width: null, height: null, source: 'brand_gradient', model: null, quality: null, status: 'no_ai_image' }, layouts: [] }));
      const a = pkg.imageAssets.find((x) => x.id === l.assetId)!;
      e.layouts.push({ file: pathOf.get(l.assetId)!, assetId: l.assetId, format: l.format, channel: l.channel, width: a.width, height: a.height });
    }
    await put('images/asset-manifest.json', JSON.stringify({ campaignId: pkg.id, imageCounts: pkg.imageCounts, entries }, null, 2), 'json');
  }
  let hybridManifest: Record<string, unknown> | undefined;
  if (pkg.hybrid) {
    const h = pkg.hybrid;
    for (const f of files) {
      const a = f.assetId ? pkg.imageAssets.find((x) => x.id === f.assetId) : undefined;
      if (a?.sourceAssetIds?.length) f.sourceFiles = a.sourceAssetIds.map((id) => pathOf.get(id)).filter((p): p is string => !!p);
    }
    // the visual direction and the creative brief (the references are listed by permission; Pinterest items never carry their address into a package)
    if (h.direction) {
      const dir = { ...h.direction, references: h.direction.references.map((r) => (r.kind === 'pinterest_board' ? { ...r, url: null } : r)) };
      await put('visual-direction/visual-direction.json', JSON.stringify(dir, null, 2), 'json');
      await put('visual-direction/visual-direction.md', `# Visual direction\n\n${visualDirectionSummary(h.direction)}\n\n- Style: ${h.direction.styleId}${h.direction.secondaryStyleIds.length ? ` (also ${h.direction.secondaryStyleIds.join(', ')})` : ''}\n- Origin: ${h.direction.origin} · confidence ${h.direction.confidence}\n- Composition: ${h.direction.composition.join('; ')}\n- Mood: ${h.direction.mood.join(', ')}\n- Image subjects: ${h.direction.imageSubjects.join('; ')}\n- Image treatment: ${h.direction.imageTreatment.join('; ')}\n${h.direction.limitations.length ? `\nLimitations:\n${h.direction.limitations.map((l) => `- ${l}`).join('\n')}\n` : ''}\n## References\n\n${h.direction.references.length ? h.direction.references.map((r) => `- ${r.label} · ${r.kind} · ${r.permission} · ${r.used}`).join('\n') : 'None.'}\n`, 'markdown');
    }
    const brief = (opts.strategy as { creativeBrief?: unknown } | undefined)?.creativeBrief;
    if (brief) await put('creative-brief/creative-brief.json', JSON.stringify(brief, null, 2), 'json');
    // one layout record per template creative: which template and version, which content, which source files
    const layoutInfo = h.creatives.map((c) => {
      const a = c.assetId ? pkg.imageAssets.find((x) => x.id === c.assetId) : undefined;
      const sel = h.selection?.items.find((i) => i.slotId === c.slotId);
      return { slotId: c.slotId, conceptId: c.conceptId, templateId: c.templateId, templateName: c.templateName, templateVersion: c.templateVersion, status: c.status, origin: c.origin, channel: c.channel, format: c.format, width: c.width, height: c.height, file: c.assetId ? (pathOf.get(c.assetId) ?? null) : null, sourceFiles: (c.sourceAssetIds ?? []).map((id) => pathOf.get(id) ?? null), content: sel?.content ?? null, rationale: sel?.rationale ?? null, flags: c.flags, rights: a?.rights ?? null, reason: c.reason };
    });
    for (const l of layoutInfo) await put(`layouts/${safeName(l.slotId)}.json`, JSON.stringify(l, null, 2), 'json');
    await put('layouts/selection.json', JSON.stringify({ selection: h.selection, library: h.libraryVersion }, null, 2), 'json');
    await put('layouts/template-quality.json', JSON.stringify(h.quality, null, 2), 'json');
    const delivered = (c: (typeof layoutInfo)[number]) => !!c.file && (c.status === 'rendered' || c.status === 'fallback_rendered');
    hybridManifest = {
      productionMode: h.imagery ? 'no_ai_hybrid' : 'hybrid_production',
      ...(h.imagery ? { imagery: { aiImagesGenerated: 0, imageRequests: 0, refusedAttempts: h.imagery.refusedAttempts, discovered: h.imagery.discovered, approved: h.imagery.approved, autoAdded: h.imagery.autoAdded, blockedSlots: h.imagery.blockedSlots } } : {}),
      libraryVersion: h.libraryVersion,
      design: h.settings.design ? { collectionId: h.settings.design.collectionId, collectionVersion: h.settings.design.collectionVersion, palette: h.settings.design.palette } : null,
      counts: h.counts,
      originals: pkg.imageVariations.map((v) => ({ variationId: v.variationId, conceptId: v.conceptId, status: v.status, model: v.providerModel, quality: v.quality, size: v.size, file: v.generatedAssetId ? (pathOf.get(v.generatedAssetId) ?? null) : null, origin: 'AI_GENERATED', rights: 'generated_for_user' })),
      templateCreatives: layoutInfo.map((l) => ({ slotId: l.slotId, templateId: l.templateId, templateVersion: l.templateVersion, status: l.status, origin: l.origin, format: l.format, width: l.width, height: l.height, file: l.file, sourceFiles: l.sourceFiles, deliveredAsFile: delivered(l) })),
      imageToTemplates: pkg.imageVariations.map((v) => ({ variationId: v.variationId, originalFile: v.generatedAssetId ? (pathOf.get(v.generatedAssetId) ?? null) : null, templateCreatives: layoutInfo.filter((l) => h.selection?.items.find((i) => i.slotId === l.slotId)?.variationId === v.variationId).map((l) => ({ slotId: l.slotId, templateId: l.templateId, templateVersion: l.templateVersion, file: l.file })) })),
      notes: h.notes,
    };
  }
  const imagery = pkg.hybrid?.imagery ?? null;
  if (imagery) {
    // the ORIGINAL pictures go into the archive only where their rights allow handing the unaltered file on
    const byId = new Map((opts.sources ?? []).map((s) => [s.id, s]));
    const originalPath = new Map<string, string | null>();
    for (const l of imagery.library) {
      const src = byId.get(l.id);
      if (l.redistributeOriginal && src?.data) {
        const path = `images/approved-sources/${safeName(src.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''))}-${safeName(l.id)}${(/\.[a-z0-9]{2,5}$/i.exec(src.fileName)?.[0] ?? '.jpg').toLowerCase()}`;
        await put(path, src.data, 'image');
        const f = files[files.length - 1];
        f.origin = l.kind;
        f.rights = l.verification;
        originalPath.set(l.id, path);
      } else originalPath.set(l.id, null);
    }
    const slotFile = (slotId: string) => {
      const c = pkg.hybrid!.creatives.find((x) => x.slotId === slotId);
      return c?.assetId ? (pathOf.get(c.assetId) ?? null) : null;
    };
    await put('usage/sources.json', JSON.stringify({ campaignId: pkg.id, note: 'Every picture of the image library with its source and rights. An original is included in this archive only when its license allows passing the unaltered file on; the advertisements made from it are included either way where the license allows advertising use.', sources: imagery.library.map((l) => ({ ...l, originalIncluded: originalPath.get(l.id) ?? null, originalNotIncludedBecause: originalPath.get(l.id) ? null : l.redistributeOriginal ? 'the file was not available' : 'its license does not allow handing the unaltered file on' })) }, null, 2), 'json');
    await put('usage/rights.json', JSON.stringify({ campaignId: pkg.id, aiImagesGenerated: 0, creatives: pkg.hybrid!.creatives.map((c) => {
      const a = c.assetId ? pkg.imageAssets.find((x) => x.id === c.assetId) : undefined;
      const sel = pkg.hybrid!.selection?.items.find((i) => i.slotId === c.slotId);
      const sources = (c.sourceAssetIds ?? []).map((sid) => (sid.startsWith('brand:') ? sid.slice(6) : sid));
      return { slotId: c.slotId, concept: concept(c.conceptId), conceptId: c.conceptId, status: c.status, file: slotFile(c.slotId), collection: c.collectionId ?? null, collectionVersion: c.collectionVersion ?? null, template: c.templateId || null, templateVersion: c.templateVersion || null, format: c.format, channel: c.channel, size: `${c.width}x${c.height}`, paletteKey: c.paletteKey ?? null, renderingVersion: { templateLibrary: pkg.hybrid!.libraryVersion, collections: pkg.hybrid!.collectionsVersion ?? null }, sourceImageIds: sources, sourceImages: sources.map((id) => imagery.library.find((l) => l.id === id)).filter(Boolean).map((l) => ({ id: l!.id, name: l!.name, license: l!.license, verification: l!.verification, attribution: l!.attribution })), rightsSummary: a?.rights?.note ?? (c.status === 'skipped' ? 'Not produced.' : 'Typography and shapes only: no third-party picture.'), headline: sel?.content.headline ?? null };
    }) }, null, 2), 'json');
    await put('usage/README.txt', ['NO AI HYBRID usage notes', '', 'No AI image was generated for this campaign.', 'sources.json lists every picture the campaign could use, where it came from and its license.', 'rights.json lists every creative with the pictures it was built from.', 'CREDITS.txt (when present) lists the credit lines the licenses ask for or recommend.', 'Keep the licenses of the pictures you use: a creative that contains a licensed picture is covered only as far as that license allows.', ''].join('\n'), 'text');
  }
  if (pkg.cost || pkg.imageVariations.length) await put('usage/usage.json', JSON.stringify({ usage: pkg.usage, cost: pkg.cost, imageCounts: pkg.imageCounts, perImage: pkg.imageVariations.map((v) => ({ variationId: v.variationId, status: v.status, model: v.providerModel, quality: v.quality, size: v.size, usage: v.usage, costUsd: v.costUsd })) }, null, 2), 'json');
  await put('review/findings.json', JSON.stringify(pkg.reviewFindings, null, 2), 'json');
  await put('review/revisions.json', JSON.stringify(pkg.revisions, null, 2), 'json');
  const manifest: ExportManifest = {
    campaignId: pkg.id,
    campaignName: pkg.campaignName,
    runId: pkg.runId,
    chain: { f1ReportId: pkg.f1ReportId, f2ReportId: pkg.f2ReportId, f3StrategyId: pkg.f3StrategyId },
    schemaVersion: pkg.schemaVersion,
    createdAt: pkg.createdAt,
    approval: pkg.approval,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    assetsMissing: missing,
    ...(hybridManifest ? { hybrid: hybridManifest } : {}),
  };
  // the summary page links the files by their manifest paths, so it is written after them
  zip.file('summary.html', Buffer.from(campaignSummaryHtml(pkg, manifest), 'utf8'), { date });
  zip.file('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { date });
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  return { zip: out, manifest };
}

/**
 * Only the ORIGINAL AI images (no layouts, no copy): originals/concept-NN-variation-MM.png plus originals.json that says, for every
 * planned image, what it is and whether it exists. A failed or missing image has no file and is never pointed at.
 */
export async function buildOriginalsZip(pkg: CampaignPackage, assets: AssetStore): Promise<{ zip: Buffer; files: string[] }> {
  const zip = new JSZip();
  const date = new Date(pkg.createdAt);
  const name = variationFileNames(pkg);
  const files: string[] = [];
  const entries: unknown[] = [];
  const concept = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;
  for (const v of pkg.imageVariations) {
    const a = v.generatedAssetId ? pkg.imageAssets.find((x) => x.id === v.generatedAssetId && x.kind === 'image' && x.source === 'ai_image') : undefined;
    let file: string | null = null;
    if (a) {
      try {
        const bytes = await assets.load(a.id);
        file = (name(a) ?? `images/originals/${safeName(a.id)}.png`).replace(/^images\//, '');
        zip.file(file, bytes, { date, createFolders: false });
        files.push(file);
      } catch {
        file = null;
      }
    }
    entries.push({ concept: { id: v.conceptId, name: concept(v.conceptId) }, variationId: v.variationId, variationName: v.variationName, status: file ? v.status : v.status === 'generated' ? 'file_missing' : v.status, file, model: v.providerModel, quality: v.quality, size: v.size, targetChannels: v.targetChannels, explanation: file ? null : v.explanation });
  }
  zip.file('originals.json', JSON.stringify({ campaignId: pkg.id, imageCounts: pkg.imageCounts, note: 'Conceptual marketing visuals generated by an image model, not photographs of a real place, product or person.', entries }, null, 2), { date });
  return { zip: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' }), files };
}

/**
 * Hybrid Production downloads: only the TEMPLATE creatives (`scope: 'templates'`) or every finished creative, originals and template
 * creatives together (`scope: 'all'`). creatives.json lists each file with its kind, template, source and status; nothing missing is pointed to.
 */
export async function buildCreativesZip(pkg: CampaignPackage, assets: AssetStore, scope: 'templates' | 'all'): Promise<{ zip: Buffer; files: string[] }> {
  const zip = new JSZip();
  const date = new Date(pkg.createdAt);
  const files: string[] = [];
  const entries: unknown[] = [];
  const tName = templateFileName(pkg);
  const vName = variationFileNames(pkg);
  const current = pkg.imageAssets.filter((a) => a.status !== 'superseded');
  const take = async (a: AssetRecord, path: string, extra: Record<string, unknown>) => {
    try {
      zip.file(path, await assets.load(a.id), { date, createFolders: false });
      files.push(path);
      entries.push({ file: path, assetId: a.id, origin: originOf(a), width: a.width, height: a.height, rights: a.rights ?? null, ...extra });
    } catch {
      entries.push({ file: null, assetId: a.id, status: 'file_missing', ...extra });
    }
  };
  if (scope === 'all') {
    for (const a of current.filter((x) => x.kind === 'image' && x.source === 'ai_image')) await take(a, (vName(a) ?? `images/originals/${safeName(a.id)}.png`).replace(/^images\//, ''), { kind: 'original_ai_image', model: a.model, quality: a.quality });
  }
  for (const a of current.filter((x) => x.kind === 'layout' && x.source === 'template_render')) {
    const l = pkg.channelLayouts.find((x) => x.assetId === a.id);
    await take(a, (tName(a) ?? `images/templates/${safeName(a.id)}.png`).replace(/^images\//, ''), { kind: 'template_creative', templateId: a.templateId, templateVersion: a.templateVersion, slotId: l?.slotId ?? null, format: a.format, channel: a.channel, sourceAssetIds: a.sourceAssetIds ?? [] });
  }
  zip.file('creatives.json', JSON.stringify({ campaignId: pkg.id, scope, note: 'Template creatives are rendered locally from library templates; they are not AI images. Original AI images are conceptual marketing visuals.', counts: pkg.hybrid?.counts ?? null, entries }, null, 2), { date });
  return { zip: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' }), files };
}

/** A safe download name for the archive. */
export const zipFileName = (pkg: CampaignPackage) => `${safeName(pkg.campaignName).slice(0, 50) || 'campaign'}-${safeName(pkg.id).slice(0, 12)}.zip`;
export const creativesZipFileName = (pkg: CampaignPackage, scope: 'templates' | 'all') => `${safeName(pkg.campaignName).slice(0, 40) || 'campaign'}-${safeName(pkg.id).slice(0, 12)}-${scope === 'all' ? 'all-creatives' : 'template-creatives'}.zip`;
export const originalsZipFileName = (pkg: CampaignPackage) => `${safeName(pkg.campaignName).slice(0, 44) || 'campaign'}-${safeName(pkg.id).slice(0, 12)}-originals.zip`;

export { CREATIVE_FORMATS as EXPORT_FORMATS };
