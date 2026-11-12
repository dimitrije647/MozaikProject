import JSZip from 'jszip';
import type { AssetStore } from './assets';
import { originOf } from '../hybrid/records';
import { visualDirectionSummary } from '../templates/visual-direction';
import { buildLegacyCampaignZip } from './export-legacy';
import { safeName, sha256, type ExportFile, type ExportManifest, type ExportSource } from './export-files';
import type { CampaignPackage, CopyVariantRecord, DeliverableRecord } from './schemas';

export { safeName, type ExportFile, type ExportManifest, type ExportSource };

/**
 * THE ONE DOWNLOAD of a campaign: every deliverable, its copy, the strategy, the brand material and the rights of every picture, in a
 * predictable structure:
 *
 *   campaign/README.md                       what is inside, the deliverables (delivered / missing with the reason), how to use them
 *   campaign/strategy/                       the strategy (JSON and a readable summary) and the concepts
 *   campaign/social/{x,tiktok,facebook,instagram,linkedin}/   the post visuals and the post text (TikTok: cover + video script)
 *   campaign/ads/{web,display}/              web banner and display ad visuals with their copy
 *   campaign/print/{billboards,flyers}/      billboard and flyer designs with their copy
 *   campaign/brand/                          palette, collection, the approved logo, the brand voice (voice.md)
 *   campaign/sources/                        every picture's source, license and credit (CREDITS.txt), originals where the license allows
 *   campaign/review/quality.json             the quality review, the repairs and the remaining findings
 *   campaign/review/copywriting-plan.json    the copywriting plan the copy was written and reviewed against (purpose, principles, voice)
 *   campaign/campaign.json, campaign/manifest.json
 *
 * Only files that exist are written: a missing deliverable is listed in the README with its reason, never as an empty placeholder file.
 * Building the same package twice yields byte-identical archives. Campaigns saved before V4 keep their own layout (export-legacy.ts).
 */

export interface ExportOptions {
  /** The brand palette in use (when there is no approved design palette). */
  palette?: string[];
  /** The stored strategy report the campaign is built on. */
  strategy?: unknown;
  /** Credit lines supplied by the backend (otherwise built from the package). */
  credits?: string;
  /** The bytes of the approved source pictures (originals are included only where their rights allow it). */
  sources?: ExportSource[];
  /** The approved logo file (Get Content). */
  logo?: { fileName: string; data: Buffer; rights: string | null } | null;
}

const ROOT = 'campaign';
const pad = (n: number) => String(n).padStart(2, '0');
const PLATFORM_NAME: Record<string, string> = { x: 'X', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn' };

/** The credit lines of the pictures the campaign really drew (from the package itself; the backend may supply its own text instead). */
export function creditsFromImagery(pkg: CampaignPackage): string {
  const used = (pkg.hybrid?.imagery?.library ?? []).filter((l) => l.attribution && l.usedBySlots.length);
  if (!used.length) return '';
  return ['Image credits', '', ...used.map((l) => `${l.attribution} (${l.license}${l.attributionRequired ? ', credit required' : ''})${l.pageUrl ? ` ${l.pageUrl}` : ''}`), ''].join('\n');
}

const copyText = (v: CopyVariantRecord, conceptName: string, visual: string | null, item: DeliverableRecord | undefined) => {
  const lines = [`Concept: ${conceptName}`, ''];
  if (v.placement === 'social_post') {
    lines.push(`Hook / headline: ${v.headline}`, '', 'Post text:', v.body, '', `Call to action: ${v.ctaText}`);
    if (v.hashtags.length) lines.push(`Hashtags: ${v.hashtags.join(' ')}`);
    if (v.postingFormat) lines.push(`Suggested posting format: ${v.postingFormat}`);
  } else {
    lines.push(`Headline: ${v.headline}`);
    if (v.body && v.body !== v.headline) lines.push('', v.placement === 'flyer' ? 'Body:' : 'Description:', v.body);
    lines.push('', `Call to action: ${v.ctaText}`);
  }
  lines.push('', visual ? `Visual: ${visual}` : `Visual: not produced${item?.reason ? ` (${item.reason})` : ''}.`);
  if (v.version > 1) lines.push(`Revised ${v.version - 1} time(s) after the quality review.`);
  return lines.join('\n') + '\n';
};

const scriptMarkdown = (v: CopyVariantRecord, conceptName: string) => {
  const s = v.videoScript!;
  return [
    `# TikTok video concept: ${conceptName}`,
    '',
    '> A script to film. LaunchPilot did not produce a video.',
    '',
    `- Hook: ${s.hook}`,
    `- Length: about ${s.durationSeconds} seconds`,
    `- Sound: ${s.soundNote || '—'}`,
    '',
    '| Time | What is filmed | On-screen text | Voiceover |',
    '| --- | --- | --- | --- |',
    ...s.scenes.map((x) => `| ${x.seconds} | ${x.visual.replace(/\|/g, '/')} | ${x.onScreenText.replace(/\|/g, '/')} | ${x.voiceover.replace(/\|/g, '/')} |`),
    '',
    `Caption: ${v.body}`,
    v.hashtags.length ? `Hashtags: ${v.hashtags.join(' ')}` : '',
    '',
  ].join('\n');
};

/** A readable summary of the stored strategy (the fields are read defensively: older strategies have fewer of them). */
function strategyMarkdown(strategy: unknown, pkg: CampaignPackage): string {
  const r = (strategy ?? {}) as Record<string, any>;
  const lines = [`# Campaign strategy: ${pkg.campaignName}`, ''];
  const txt = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '');
  if (txt(r.valueProposition)) lines.push('## Value proposition', '', txt(r.valueProposition), '');
  if (txt(r.positioning?.statement)) lines.push('## Positioning', '', txt(r.positioning.statement), '');
  if (Array.isArray(r.campaignGoals) && r.campaignGoals.length) lines.push('## Goals', '', ...r.campaignGoals.map((g: { goal?: string; measuredBy?: string }) => `- ${g.goal ?? ''}${g.measuredBy ? ` (measured by ${g.measuredBy})` : ''}`), '');
  if (Array.isArray(r.priorityAudiences) && r.priorityAudiences.length) lines.push('## Target audiences', '', ...r.priorityAudiences.map((a: { segmentName?: string; priority?: string }) => `- ${a.segmentName ?? ''}${a.priority ? ` (${a.priority})` : ''}`), '');
  if (Array.isArray(r.mainMessages) && r.mainMessages.length) lines.push('## Key messages', '', ...r.mainMessages.map((m: { message?: string; audience?: string }) => `- ${m.message ?? ''}${m.audience ? ` — for ${m.audience}` : ''}`), '');
  if (Array.isArray(r.contentPillars) && r.contentPillars.length) lines.push('## Content pillars', '', ...r.contentPillars.map((p: { name?: string; description?: string }) => `- **${p.name ?? ''}**: ${p.description ?? ''}`), '');
  if (Array.isArray(r.channels) && r.channels.length) lines.push('## Channel strategy', '', ...r.channels.map((c: { channel?: string; role?: string; approach?: string }) => `- ${PLATFORM_NAME[c.channel ?? ''] ?? c.channel}: ${c.role ?? ''}${c.approach ? ` — ${c.approach}` : ''}`), '');
  lines.push('## Campaign concepts', '');
  for (const [i, c] of pkg.concepts.entries()) lines.push(`### ${pad(i + 1)}. ${c.name}`, '', ...(c.basis ? [`- Built on: ${c.basis}`] : []), `- Angle: ${c.angle}`, `- Key message: ${c.keyMessage}`, `- Audience: ${c.audience}`, `- Call to action: ${c.ctaText}`, '');
  return lines.join('\n');
}

function readme(pkg: CampaignPackage, pathOf: Map<string, string>, conceptNo: (id: string) => string): string {
  const d = pkg.deliverables!;
  const conceptName = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;
  const lines = [`# ${pkg.campaignName}`, ''];
  lines.push(`Created ${pkg.createdAt} · language ${pkg.language} · quality status **${pkg.approval.status}**: ${pkg.approval.note}`, '');
  lines.push('## What is inside', '', '- `strategy/` the campaign strategy and the concepts', '- `social/<platform>/` post visuals and post texts for X, TikTok, Facebook, Instagram and LinkedIn (TikTok: cover image and a video script to film)', '- `ads/web/`, `ads/display/` web banner and display ad designs with their copy', '- `print/billboards/`, `print/flyers/` print designs with their copy', '- `brand/` palette, template collection, the approved logo and the brand voice the copy was written in (`voice.md`)', '- `sources/` where every picture comes from, its license and the credits to show', '- `review/quality.json` the quality review and the corrections that were made', '');
  lines.push(`## Deliverables: ${d.counts.delivered} of ${d.counts.planned} delivered`, '', `${d.counts.withPicture} with an approved real picture, ${d.counts.typographyFirst} typography-first. No AI image was generated.`, '');
  lines.push('| Concept | Deliverable | Format | File |', '| --- | --- | --- | --- |');
  for (const i of d.items) lines.push(`| ${conceptNo(i.conceptId)} ${conceptName(i.conceptId)} | ${i.label} | ${i.width}×${i.height} | ${i.status === 'delivered' && i.assetId && pathOf.get(i.assetId) ? `\`${pathOf.get(i.assetId)!.replace(`${ROOT}/`, '')}\`` : `missing: ${i.reason ?? 'not produced'}`} |`);
  if (d.notPlanned.length) lines.push('', '### Not delivered', '', ...d.notPlanned.map((n) => `- ${n.label}${n.conceptId ? ` (${conceptName(n.conceptId)})` : ''}: ${n.reason}`));
  lines.push('', '## Before you publish', '', '- Check every call to action points to a real destination (no web address was invented).', '- Keep the picture credits listed in `sources/CREDITS.txt` where a license asks for them.', '- TikTok: film the video from `social/tiktok/*-video-script.md`; use the cover image as its thumbnail.');
  if (pkg.limitations.length) lines.push('', '## Notes and limitations', '', ...pkg.limitations.map((l) => `- ${l}`));
  if (pkg.cost) lines.push('', '## Cost', '', `Known spend: $${pkg.cost.spentUsd.toFixed(4)} (text only)${pkg.cost.approvedUsd !== null ? ` of the approved $${pkg.cost.approvedUsd.toFixed(2)}` : ''}. ${pkg.cost.note}`);
  return lines.join('\n') + '\n';
}

export async function buildCampaignZip(pkg: CampaignPackage, assets: AssetStore, opts: ExportOptions = {}): Promise<{ zip: Buffer; manifest: ExportManifest }> {
  // campaigns saved before V4 keep the archive layout they were made with
  if (!pkg.deliverables) return buildLegacyCampaignZip(pkg, assets, opts);
  const zip = new JSZip();
  const date = new Date(pkg.createdAt);
  const files: ExportFile[] = [];
  const missing: string[] = [];
  const put = async (path: string, data: Buffer | string, kind: ExportFile['kind'], assetId?: string) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const full = `${ROOT}/${path}`;
    zip.file(full, buf, { date, createFolders: false });
    files.push({ path: full, bytes: buf.length, sha256: await sha256(buf), kind, ...(assetId ? { assetId } : {}) });
    return files[files.length - 1];
  };
  const d = pkg.deliverables;
  const conceptIndex = new Map(pkg.concepts.map((c, i) => [c.id, i + 1]));
  const conceptNo = (id: string) => `concept-${pad(conceptIndex.get(id) ?? 0)}`;
  const conceptName = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? id;

  // ---- the deliverables (current versions only) ----
  const pathOf = new Map<string, string>();
  const current = new Map(pkg.imageAssets.filter((a) => a.status !== 'superseded').map((a) => [a.id, a]));
  for (const item of d.items) {
    if (item.status !== 'delivered' || !item.assetId) continue;
    const a = current.get(item.assetId);
    if (!a) {
      missing.push(item.assetId);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await assets.load(a.id);
    } catch {
      missing.push(a.id);
      continue;
    }
    const f = await put(`${item.folder}/${conceptNo(item.conceptId)}-${safeName(item.kind === 'social_post' ? item.format : item.kind)}.png`, bytes, 'image', a.id);
    Object.assign(f, { origin: originOf(a), width: a.width, height: a.height, ...(a.templateId ? { templateId: a.templateId } : {}), ...(a.templateVersion != null ? { templateVersion: a.templateVersion } : {}), ...(a.rights ? { rights: a.rights.basis } : {}) });
    pathOf.set(a.id, f.path);
  }
  // ---- the copy that goes with them ----
  for (const v of [...pkg.copyVariants].sort((x, y) => x.id.localeCompare(y.id))) {
    const item = d.items.find((i) => i.variantId === v.id) ?? d.items.find((i) => i.conceptId === v.conceptId && i.kind === v.placement && (v.placement !== 'social_post' || i.channel === v.channel));
    const folder = item?.folder ?? (v.placement === 'social_post' ? `social/${v.channel}` : d.items.find((i) => i.kind === v.placement)?.folder ?? 'other');
    const visual = item?.assetId ? (pathOf.get(item.assetId)?.split('/').pop() ?? null) : null;
    const suffix = v.placement === 'social_post' ? 'post' : `${safeName(v.placement)}-copy`;
    await put(`${folder}/${conceptNo(v.conceptId)}-${suffix}.txt`, copyText(v, conceptName(v.conceptId), visual, item), 'text');
    if (v.placement === 'social_post' && v.channel === 'tiktok' && v.videoScript) await put(`${folder}/${conceptNo(v.conceptId)}-video-script.md`, scriptMarkdown(v, conceptName(v.conceptId)), 'markdown');
  }
  // ---- strategy ----
  if (opts.strategy) await put('strategy/strategy.json', JSON.stringify(opts.strategy, null, 2), 'json');
  await put('strategy/campaign-strategy.md', strategyMarkdown(opts.strategy, pkg), 'markdown');
  if (pkg.hybrid?.direction) await put('strategy/visual-direction.md', `# Visual direction\n\n${visualDirectionSummary(pkg.hybrid.direction)}\n`, 'markdown');
  // ---- brand ----
  const design = pkg.hybrid?.settings.design ?? null;
  let logoFile: string | null = null;
  if (opts.logo?.data) {
    const ext = (/\.[a-z0-9]{2,5}$/i.exec(opts.logo.fileName)?.[0] ?? '.png').toLowerCase();
    logoFile = (await put(`brand/logo-${safeName(opts.logo.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''))}${ext}`, opts.logo.data, 'image')).path;
  }
  const brand = pkg.hybrid?.brand ?? null;
  await put('brand/brand.json', JSON.stringify({
    campaign: pkg.campaignName,
    palette: design ? design.palette : (opts.palette ?? []),
    collection: design ? { id: design.collectionId, version: design.collectionVersion } : null,
    logo: logoFile ? { file: logoFile.replace(`${ROOT}/`, ''), rights: opts.logo?.rights ?? null } : null,
    creativesWithLogo: brand?.withLogo ?? null,
    creativesWithoutLogo: brand?.omitted ?? [],
    approvedPhotographs: brand?.approvedPhotos ?? null,
  }, null, 2), 'json');
  // ---- sources and rights ----
  const imagery = pkg.hybrid?.imagery ?? null;
  const credits = opts.credits || creditsFromImagery(pkg);
  if (credits) await put('sources/CREDITS.txt', credits, 'text');
  if (imagery) {
    const byId = new Map((opts.sources ?? []).map((s) => [s.id, s]));
    const originalPath = new Map<string, string | null>();
    for (const l of imagery.library) {
      const src = byId.get(l.id);
      if (l.redistributeOriginal && src?.data && l.usedBySlots.length) {
        const ext = (/\.[a-z0-9]{2,5}$/i.exec(src.fileName)?.[0] ?? '.jpg').toLowerCase();
        const f = await put(`sources/approved-pictures/${safeName(src.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''))}-${safeName(l.id)}${ext}`, src.data, 'image');
        Object.assign(f, { origin: l.kind, rights: l.verification });
        originalPath.set(l.id, f.path);
      } else originalPath.set(l.id, null);
    }
    await put('sources/sources.json', JSON.stringify({ note: 'Every picture the campaign could use: where it came from, its license and whether a credit is required. Publicly accessible does not mean licensed: only approved or cleared pictures were drawn.', pictures: imagery.library.map((l) => ({ ...l, originalIncluded: originalPath.get(l.id)?.replace(`${ROOT}/`, '') ?? null })) }, null, 2), 'json');
  }
  const creatives = pkg.hybrid?.creatives ?? [];
  if (creatives.length) {
    await put('sources/rights.json', JSON.stringify({ aiImagesGenerated: 0, creatives: creatives.map((c) => {
      const a = c.assetId ? current.get(c.assetId) : undefined;
      const sources = c.sourceAssetIds.map((sid) => (sid.startsWith('brand:') ? sid.slice(6) : sid));
      return { deliverable: c.slotId, concept: conceptName(c.conceptId), file: c.assetId ? (pathOf.get(c.assetId)?.replace(`${ROOT}/`, '') ?? null) : null, status: c.status, template: c.templateId || null, templateVersion: c.templateVersion || null, collection: c.collectionId ?? null, format: c.format, pictures: sources.map((id) => imagery?.library.find((l) => l.id === id)).filter(Boolean).map((l) => ({ id: l!.id, name: l!.name, source: l!.source, license: l!.license, verification: l!.verification, attribution: l!.attribution })), rights: a?.rights?.note ?? (c.status === 'skipped' || c.status === 'failed' ? 'Not produced.' : 'Typography and shapes only: no third-party picture.') };
    }) }, null, 2), 'json');
  }
  // ---- quality review ----
  await put('review/quality.json', JSON.stringify({ approval: pkg.approval, quality: pkg.quality, findings: pkg.reviewFindings, revisions: pkg.revisions, templateQuality: pkg.hybrid?.quality ?? null }, null, 2), 'json');
  // ---- the copywriting plan (internal: why the copy says what it says) and the brand voice the team wrote in ----
  if (pkg.copywriting) {
    const cp = pkg.copywriting;
    await put('review/copywriting-plan.json', JSON.stringify({ plan: cp, concepts: pkg.concepts.map((c) => ({ id: c.id, name: c.name, purpose: c.purpose ?? null, principleNote: c.principleNote ?? null })), copy: pkg.copyVariants.map((v) => ({ id: v.id, placement: v.placement, channel: v.channel, principles: v.principles ?? [] })) }, null, 2), 'json');
    const v = cp.voice;
    await put('brand/voice.md', [
      '# Brand voice used for this campaign',
      '',
      `- Tone: ${v.tone} (${v.formality}, ${v.directness}); emotional intensity ${v.emotionalIntensity}; technical depth ${v.technicalDepth}`,
      `- Personality: ${v.personality.join(', ')}`,
      `- Humor: ${v.humor}${v.sensitivity === 'regulated' ? ' · regulated industry: conservative claim language' : ''}`,
      ...(v.preferredTerms.length ? [`- Preferred terms: ${v.preferredTerms.join(', ')}`] : []),
      `- Never used: ${v.forbiddenExpressions.join(', ')}`,
      `- Evidence about the voice: ${v.evidenceConfidence}`,
      '',
      '## Why',
      '',
      ...v.basis.map((b) => `- ${b}`),
      '',
    ].join('\n'), 'markdown');
  }
  // ---- the package itself and the README ----
  const noPin = <T extends { kind: string; url: string | null }>(refs: T[]) => refs.map((r) => (r.kind === 'pinterest_board' ? { ...r, url: null } : r));
  const shareable = pkg.hybrid ? { ...pkg, hybrid: { ...pkg.hybrid, settings: { ...pkg.hybrid.settings, references: noPin(pkg.hybrid.settings.references) }, direction: pkg.hybrid.direction ? { ...pkg.hybrid.direction, references: noPin(pkg.hybrid.direction.references) } : null, discovery: null } } : pkg;
  await put('campaign.json', JSON.stringify(shareable, null, 2), 'json');
  await put('README.md', readme(pkg, pathOf, conceptNo), 'markdown');
  const manifest: ExportManifest = {
    campaignId: pkg.id,
    campaignName: pkg.campaignName,
    runId: pkg.runId,
    chain: { f1ReportId: pkg.f1ReportId, f2ReportId: pkg.f2ReportId ?? null, f3StrategyId: pkg.f3StrategyId },
    schemaVersion: pkg.schemaVersion,
    createdAt: pkg.createdAt,
    approval: pkg.approval,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    assetsMissing: missing,
    deliverables: { ...d.counts, notPlanned: d.notPlanned.length },
  };
  zip.file(`${ROOT}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { date });
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  return { zip: out, manifest };
}

/** A safe download name for the archive. */
export const zipFileName = (pkg: CampaignPackage) => `${safeName(pkg.campaignName).slice(0, 50) || 'campaign'}-${safeName(pkg.id).slice(0, 12)}.zip`;
