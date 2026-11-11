import { BadRequestException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  GitHubRepositoryTool,
  WebFetchTool,
  analyzeImage,
  attestRights,
  candidateRights,
  describeSocialSources,
  discoverImages,
  discoverRepositoryImages,
  discoverWebsiteImages,
  exportEligibility,
  formatClassOfId,
  formatIdsOf,
  getCollection,
  imageStem,
  isImageBuffer,
  isNearDuplicate,
  keywordsOf,
  parseDesign,
  designBrandColors,
  rankImages,
  rightsSummary,
  socialRights,
  stockRights,
  textOfImage,
  confirmReview,
  uploadRights,
  imageNeedsOf,
  LIBRARY_SOURCES,
  type BrandImage,
  type DiscoveryResult,
  type ImageAnalysis,
  type ImageCandidate,
  type ImageRights,
  type ImageSearchAdapter,
  type LibrarySource,
  type LogoCandidateInfo,
  type RepoImageDiscovery,
  type ScoreContext,
  type ScoreSubject,
  type SocialSourceInfo,
  type WebsiteImageDiscovery,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll } from '../mozaik/campaign-assets';
import { IMAGE_ADAPTERS, VisualService } from './visual.service';
import { ProjectBrandService } from './project-brand.service';

/** Test seam: how the website, the repository and their picture files are read. Production uses the SSRF-guarded, robots-respecting readers. */
export const IMAGE_SOURCES = Symbol('IMAGE_SOURCES');

export type FetchedPicture = { ok: true; data: Buffer; contentType: string } | { ok: false; message: string };

export interface ImageSourceReaders {
  /** `logoBrand` also asks for the logo candidates of the home page (Get Content); `signal` cancels the read. */
  website(url: string, o?: { logoBrand?: string[]; signal?: AbortSignal }): Promise<WebsiteImageDiscovery>;
  repository(url: string, o?: { logoBrand?: string[]; signal?: AbortSignal }): Promise<RepoImageDiscovery>;
  /** ONE SVG logo of a website as TEXT (guarded, size-limited). It is sanitized and rasterized by the caller; never used as it is. */
  fetchWebsiteSvg(url: string): Promise<FetchedPicture>;
  /** ONE picture file of a website. Called only after the owner confirmed the rights. */
  fetchWebsiteImage(url: string): Promise<FetchedPicture>;
  /** ONE picture file of a repository, through the official API. Called only after the owner confirmed the rights. */
  fetchRepositoryImage(o: { owner: string; repo: string; ref: string; path: string }): Promise<FetchedPicture>;
}

export const defaultImageSources = (): ImageSourceReaders => ({
  website: (url, o) => discoverWebsiteImages(url, { maxPages: 5, logoBrand: o?.logoBrand, signal: o?.signal }),
  repository: (url, o) => discoverRepositoryImages(url, { token: process.env.GITHUB_TOKEN, logoBrand: o?.logoBrand, signal: o?.signal }),
  fetchWebsiteSvg: async (url) => {
    const r = await new WebFetchTool({ timeoutMs: 15_000, maxAssets: 1, maxPages: 1, userAgent: 'LaunchPilotBot/1.0 (logo import after owner confirmation; honors robots.txt)' }).fetchAsset(url, { kind: 'svg' });
    return r.ok ? { ok: true, data: r.body, contentType: 'image/svg+xml' } : { ok: false, message: r.message };
  },
  fetchWebsiteImage: async (url) => {
    const r = await new WebFetchTool({ timeoutMs: 15_000, maxAssets: 1, maxPages: 1, userAgent: 'LaunchPilotBot/1.0 (picture import after owner confirmation; honors robots.txt)' }).fetchAsset(url, { kind: 'image', maxBytes: MAX_IMPORT_BYTES });
    return r.ok ? { ok: true, data: r.body, contentType: r.contentType } : { ok: false, message: r.message };
  },
  fetchRepositoryImage: async (o) => {
    const r = await new GitHubRepositoryTool({ token: process.env.GITHUB_TOKEN }).readBinary({ ...o, maxBytes: MAX_IMPORT_BYTES });
    return r.ok ? { ok: true, data: r.data, contentType: /\.png$/i.test(o.path) ? 'image/png' : /\.webp$/i.test(o.path) ? 'image/webp' : /\.svg$/i.test(o.path) ? 'image/svg+xml' : 'image/jpeg' } : { ok: false, message: r.message };
  },
});

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MIN_IMPORT_SIDE = 600;
const MAX_CANDIDATES_PER_SOURCE = 60;
const MAX_APPROVED_IMPORTS = 30;
const MAX_LIBRARY_IMAGES = 24;
const MAX_LIBRARY_BYTES = 120 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const RASTER = /^image\/(png|jpe?g|webp)$/i;

type Obj = Record<string, any>;
export type ImageStatus = 'candidate' | 'approved' | 'rejected';

export interface LibraryItemView {
  id: string;
  source: LibrarySource;
  status: ImageStatus;
  title: string;
  pageUrl: string | null;
  creator: string | null;
  width: number | null;
  height: number | null;
  /** what may be shown: a stored copy (asset), a picture the owner's own page/repository serves (remote), a provider thumbnail (thumbnail) or nothing */
  preview: { kind: 'asset' | 'remote' | 'thumbnail' | 'none'; url: string | null; note: string | null };
  rights: {
    status: ImageRights['status'];
    verification: ImageRights['verification'];
    license: string;
    licenseUrl: string | null;
    eligible: boolean;
    reason: string;
    attribution: string | null;
    attributionRequired: boolean;
    commercialUse: boolean;
    derivatives: boolean;
    downloadAllowed: boolean;
    redistributeOriginal: boolean;
    userApproved: boolean;
    attestedAt: string | null;
    reasons: string[];
  };
  /** 0..1 deterministic score; null for pictures that can never be used */
  score: number | null;
  relevance: number | null;
  scoreEstimated: boolean;
  reasons: string[];
  /** why the picture is (or is not) selected for the campaign, in a sentence */
  selection: string;
  assetId: string | null;
  /** what the owner must do before the picture can be used */
  needs: 'attestation' | 'review' | null;
  note: string | null;
  actions: ('approve' | 'reject' | 'restore' | 'view_source' | 'search_alternatives')[];
}

const asRights = (j: unknown): ImageRights => j as ImageRights;

function rightsView(r: ImageRights) {
  const e = exportEligibility(r);
  return { status: r.status, verification: r.verification, license: r.license, licenseUrl: r.licenseUrl, eligible: e.eligible, reason: e.reason, attribution: r.attribution, attributionRequired: r.attributionRequired, commercialUse: r.commercialUse, derivatives: r.derivatives, downloadAllowed: r.downloadAllowed, redistributeOriginal: r.redistributeOriginal, userApproved: r.userApproved, attestedAt: r.attestedAt, reasons: r.reasons.slice(0, 5) };
}

/**
 * THE PROJECT'S IMAGE LIBRARY (NO AI HYBRID). One place that knows every picture a campaign could use, where it came from and under which rights:
 *
 *   uploads            the owner's files (approved by default; can be rejected)
 *   website / github   CANDIDATES found on the project's own website and repository. Their files are NOT downloaded until the owner confirms the
 *                      rights (an attestation); then the file is fetched through the guarded fetcher, measured, checked for duplicates and stored
 *                      with its provenance.
 *   social             reference links only. LaunchPilot has no social-media integration and never fetches from those platforms.
 *   stock              licensed provider results (cached 24 hours as the providers require); imported when chosen, or automatically in automatic stock mode
 *                      (cleared licenses only).
 *
 * Rights are a hard gate: `exportEligibility` decides what a campaign may use, and nothing here (approval, ranking, automatic mode) can override it.
 */
@Injectable()
export class ImageLibraryService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private storage: StorageDriver,
    private activity: ActivityLogService,
    private visual: VisualService,
    private brand: ProjectBrandService,
    @Inject(IMAGE_ADAPTERS) private adapters: ImageSearchAdapter[],
    @Inject(IMAGE_SOURCES) private readers: ImageSourceReaders,
  ) {}

  // ---- the library rows of uploads ----------------------------------------------------------------------------------------------------------------

  /** Every raster picture the owner uploaded (and every picture imported by the older "add licensed picture" flow) gets a library row, once. */
  async ensureRows(projectId: string): Promise<void> {
    const assets = await this.prisma.projectAsset.findMany({ where: { projectId, type: { in: ['image', 'screenshot'] }, projectImage: null }, include: { provenance: true }, orderBy: { createdAt: 'asc' }, take: 40 });
    for (const a of assets) {
      if (!RASTER.test(a.mimeType) || a.fileSize <= 0 || a.fileSize > MAX_IMPORT_BYTES) continue;
      const data = await readAll(this.storage.read(a.filePath)).catch(() => null);
      const analysis = data && isImageBuffer(data) ? await analyzeImage(data) : null;
      const prov = a.provenance;
      const source: LibrarySource = prov ? (prov.provider === 'website' ? 'website' : prov.provider === 'github' ? 'github' : 'stock') : 'upload';
      let rights: ImageRights = uploadRights();
      let dedupe = `asset:${a.id}`;
      let remoteUrl: string | null = null;
      if (prov) {
        rights = prov.rightsJson ? asRights(prov.rightsJson) : source === 'stock' ? { ...stockRights({ status: 'cleared', license: prov.license, licenseUrl: prov.licenseUrl, commercialUse: true, derivatives: true, attributionRequired: prov.attributionRequired, attribution: prov.attribution, reasons: [] }, { userApproved: true }), verification: prov.licenseBasis === 'user_reviewed' ? 'user_reviewed' : 'provider_license' } : attestRights(candidateRights(source as 'website' | 'github'), { at: prov.acquiredAt });
        dedupe = `${prov.provider}:${prov.providerImageId}`;
        remoteUrl = prov.originalUrl ?? null;
      }
      const duplicate = analysis ? await this.findNearDuplicate(projectId, analysis.phash, null) : null;
      await this.prisma.projectImage
        .create({
          data: {
            projectId,
            source,
            status: duplicate ? 'rejected' : 'approved',
            dedupeKey: dedupe,
            title: a.originalName.slice(0, 160),
            pageUrl: prov?.pageUrl ?? null,
            remoteUrl,
            creator: prov?.creator ?? null,
            width: analysis?.width ?? prov?.width ?? null,
            height: analysis?.height ?? prov?.height ?? null,
            text: textOfImage({ fileName: a.originalName }),
            rightsJson: rights as never,
            analysisJson: (analysis ?? undefined) as never,
            assetId: a.id,
            metaJson: duplicate ? ({ autoRejected: 'duplicate', duplicateOf: duplicate.title } as never) : undefined,
            decidedAt: new Date(),
          },
        })
        .catch(() => undefined); // a concurrent request created it first
    }
  }

  private async findNearDuplicate(projectId: string, phash: string, exceptId: string | null) {
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, role: 'photo', status: 'approved', assetId: { not: null }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, title: true, analysisJson: true } });
    for (const r of rows) {
      const h = (r.analysisJson as Obj | null)?.phash;
      if (typeof h === 'string' && isNearDuplicate(h, phash)) return r;
    }
    return null;
  }

  // ---- context for ranking ---------------------------------------------------------------------------------------------------------------------------

  private async scoring(userId: string | null, projectId: string): Promise<{ ctx: ScoreContext; collectionId: string | null; autoStock: boolean; intake: Obj | null; designFormats: string[] }> {
    const [project, intake, draft] = await Promise.all([this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, description: true } }), this.prisma.productIntake.findUnique({ where: { projectId } }), this.prisma.campaignDesignDraft.findUnique({ where: { projectId } }).catch(() => null)]);
    const d = draft ? parseDesign(draft.designJson) : null;
    const design = d?.ok ? d.design : null;
    const classes = design ? [...new Set(formatIdsOf(design.formats).map(formatClassOfId).filter((x): x is NonNullable<typeof x> => !!x))] : [];
    const ctx: ScoreContext = {
      businessWords: keywordsOf({ business: intake?.productName ?? project?.name ?? '', offering: intake?.shortDescription ?? project?.description ?? '' }, 8),
      collectionId: design?.collectionId ?? null,
      formatClasses: classes,
      palette: design ? designBrandColors(design.palette) : [],
    };
    void userId;
    return { ctx, collectionId: design?.collectionId ?? null, autoStock: design?.autoStock === true, intake, designFormats: design?.formats ?? [] };
  }

  // ---- the gallery ------------------------------------------------------------------------------------------------------------------------------------------

  private viewOf(row: Obj, s: { score: number | null; relevance: number | null; estimated: boolean; reasons: string[] }): LibraryItemView {
    const r = asRights(row.rightsJson);
    const e = exportEligibility(r);
    const meta = (row.metaJson ?? {}) as Obj;
    const remote = row.source === 'website' && meta.firstParty !== false && row.remoteUrl ? { kind: 'remote' as const, url: String(row.remoteUrl), note: 'Shown from your own page; nothing has been downloaded.' } : row.source === 'github' && meta.owner ? { kind: 'remote' as const, url: `https://raw.githubusercontent.com/${meta.owner}/${meta.repo}/${encodeURIComponent(meta.ref)}/${String(meta.path).split('/').map(encodeURIComponent).join('/')}`, note: 'Shown from the public repository; nothing has been downloaded.' } : null;
    const preview = row.assetId ? { kind: 'asset' as const, url: `/api/assets/${row.assetId}/file`, note: null } : remote ?? { kind: 'none' as const, url: null, note: row.source === 'social' ? 'Platform content is never shown or copied here.' : row.source === 'website' ? 'Served by another website: shown only after you confirm the rights.' : null };
    const status = row.status as ImageStatus;
    const needs = r.status === 'needs_attestation' ? ('attestation' as const) : r.status === 'needs_review' ? ('review' as const) : null;
    const never = r.kind === 'REFERENCE_ONLY' || r.status === 'reference_only' || r.status === 'blocked';
    const actions: LibraryItemView['actions'] = [];
    if (!never && status !== 'approved') actions.push(status === 'rejected' ? 'restore' : 'approve');
    if (!never && status === 'approved' && !e.eligible) actions.push('approve');
    if (status !== 'rejected' && row.source !== 'social') actions.push('reject');
    if (row.pageUrl) actions.push('view_source');
    if (row.source !== 'social') actions.push('search_alternatives');
    const selection = status === 'rejected' ? (meta.autoRejected === 'duplicate' ? `Left out: nearly identical to "${meta.duplicateOf}".` : 'You rejected this picture.') : never ? e.reason : status === 'approved' && e.eligible ? `Selected for the campaign: ${e.reason}${s.reasons.length ? ` It ${s.reasons.slice(0, 2).join(' and ')}.` : ''}` : needs === 'attestation' ? 'Not used yet: confirm that you hold the rights to approve it.' : needs === 'review' ? 'Not used yet: check the license at its source and confirm it.' : e.reason;
    return {
      id: row.id,
      source: row.source,
      status,
      title: String(row.title),
      pageUrl: row.pageUrl ?? null,
      creator: row.creator ?? null,
      width: row.width ?? null,
      height: row.height ?? null,
      preview,
      rights: rightsView(r),
      score: never ? null : s.score,
      relevance: never ? null : s.relevance,
      scoreEstimated: s.estimated,
      reasons: s.reasons,
      selection,
      assetId: row.assetId ?? null,
      needs,
      note: (meta.note as string | undefined) ?? null,
      actions,
    };
  }

  /** The stock candidates of the latest searches that are not in the library yet. */
  private async stockCandidates(projectId: string): Promise<{ items: ImageCandidate[]; searchedAt: string | null }> {
    const runs = await this.prisma.visualDiscoveryRun.findMany({ where: { projectId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 4 }).catch(() => []);
    const seen = new Set<string>();
    const out: ImageCandidate[] = [];
    for (const run of runs) {
      for (const c of (run.resultJson as unknown as DiscoveryResult).licensed ?? []) {
        const key = `${c.provider}:${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    const have = await this.prisma.projectImage.findMany({ where: { projectId, source: 'stock' }, select: { dedupeKey: true } });
    const haveKeys = new Set(have.map((h) => h.dedupeKey));
    return { items: out.filter((c) => !haveKeys.has(`${c.provider}:${c.id}`)).slice(0, 40), searchedAt: runs[0]?.createdAt.toISOString() ?? null };
  }

  private stockView(c: ImageCandidate, s: { score: number | null; relevance: number | null; estimated: boolean; reasons: string[] }): LibraryItemView {
    const rights = stockRights(c.license, { userApproved: false });
    const e = exportEligibility(rights);
    const needs = rights.status === 'needs_review' ? ('review' as const) : null;
    const never = rights.status === 'blocked';
    return {
      id: `stock:${c.provider}:${c.id}`,
      source: 'stock',
      status: 'candidate',
      title: c.title,
      pageUrl: c.pageUrl,
      creator: c.creator,
      width: c.width,
      height: c.height,
      preview: c.thumbnailUrl ? { kind: 'thumbnail', url: c.thumbnailUrl, note: 'A thumbnail served by the provider; it is not stored.' } : { kind: 'none', url: null, note: null },
      rights: rightsView(rights),
      score: never ? null : s.score,
      relevance: never ? null : s.relevance,
      scoreEstimated: s.estimated,
      reasons: s.reasons,
      selection: never ? e.reason : needs ? 'Not used yet: check the license at its source and confirm it.' : 'Cleared by the provider license: approve it, or let automatic stock mode choose it.',
      assetId: null,
      needs,
      note: null,
      actions: never ? ['view_source'] : ['approve', 'view_source', 'search_alternatives'],
    };
  }

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    await this.ensureRows(projectId);
    const sc = await this.scoring(userId, projectId);
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, role: 'photo' }, orderBy: [{ updatedAt: 'desc' }] });
    const stock = await this.stockCandidates(projectId);
    const subjects: ScoreSubject[] = [
      ...rows.map((r) => ({ id: r.id, text: `${r.title} ${r.text}`, width: r.width, height: r.height, source: r.source as LibrarySource, rights: asRights(r.rightsJson), analysis: (r.analysisJson ?? null) as ImageAnalysis | null, prominence: Number((r.metaJson as Obj | null)?.prominence ?? 0.4) })),
      ...stock.items.map((c): ScoreSubject => ({ id: `stock:${c.provider}:${c.id}`, text: textOfImage({ title: c.title, tags: c.tags }), width: c.width, height: c.height, source: 'stock', rights: stockRights(c.license, { userApproved: false }), prominence: 0.4 })),
    ];
    const ranked = rankImages(subjects, sc.ctx, { stage: 'candidates' });
    const scoreOf = new Map(ranked.ranked.map((x) => [x.id, { score: x.score, relevance: x.parts.relevance, estimated: x.estimated.length > 0, reasons: x.reasons }]));
    const dup = new Set(ranked.duplicates.map((d) => d.id));
    const none = { score: null, relevance: null, estimated: false, reasons: [] as string[] };
    const items: LibraryItemView[] = [
      ...rows.map((r) => this.viewOf(r, scoreOf.get(r.id) ?? none)),
      ...stock.items.filter((c) => !dup.has(`stock:${c.provider}:${c.id}`)).map((c) => this.stockView(c, scoreOf.get(`stock:${c.provider}:${c.id}`) ?? none)),
    ];
    // best first inside the library: usable pictures, then the ones the owner could still clear, then the rest
    const tier = (i: LibraryItemView) => (i.status === 'approved' && i.rights.eligible ? 0 : i.needs ? 1 : i.status === 'rejected' ? 3 : i.rights.eligible || i.status === 'candidate' ? 2 : 3);
    items.sort((a, b) => tier(a) - tier(b) || (b.score ?? -1) - (a.score ?? -1) || (a.id < b.id ? -1 : 1));
    const eligible = items.filter((i) => i.status === 'approved' && i.rights.eligible);
    const count = (src: LibrarySource) => items.filter((i) => i.source === src).length;
    const intake = sc.intake;
    const social: SocialSourceInfo[] = describeSocialSources((await this.prisma.socialProfile.findMany({ where: { projectId }, select: { platform: true, url: true } })), rows.filter((r) => r.source === 'social' && (r.metaJson as Obj | null)?.origin === 'found_on_website').map((r) => ({ platform: String((r.metaJson as Obj).platform ?? 'other'), url: r.pageUrl ?? '' })));
    return {
      projectId,
      items,
      counts: { approved: eligible.length, candidates: items.filter((i) => i.status === 'candidate' && i.source !== 'social').length, rejected: items.filter((i) => i.status === 'rejected').length, restricted: items.filter((i) => i.rights.status === 'blocked' || i.rights.status === 'reference_only').length, upload: count('upload'), website: count('website'), github: count('github'), social: count('social'), stock: count('stock'), usable: eligible.length },
      providers: this.adapters.map((a) => ({ id: a.id, label: a.label, kind: a.kind, configured: a.configured, paid: a.paid === true, setup: a.configured ? null : a.setup })),
      sources: { website: intake?.websiteUrl ?? null, repository: intake?.githubUrl ?? null, social },
      autoStock: sc.autoStock,
      collectionNeeds: imageNeedsOf(sc.collectionId)?.summary ?? null,
      stockSearchedAt: stock.searchedAt,
      notes: [
        'AI-generated images: 0. Existing and licensed pictures only.',
        'A picture is used in a creative only when its rights are confirmed. Being found on a website, in a repository or on a platform is not permission.',
      ],
    };
  }

  // ---- discovery --------------------------------------------------------------------------------------------------------------------------------------------

  private async guarded<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    try {
      const v = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, message: e instanceof Error && e.message === 'timeout' ? 'The source did not answer in time.' : 'The source could not be read.' };
    }
  }

  private async trim(projectId: string, source: LibrarySource) {
    const extra = await this.prisma.projectImage.findMany({ where: { projectId, role: 'photo', source, status: 'candidate', assetId: null }, orderBy: { updatedAt: 'desc' }, skip: MAX_CANDIDATES_PER_SOURCE, select: { id: true } });
    if (extra.length) await this.prisma.projectImage.deleteMany({ where: { id: { in: extra.map((x) => x.id) } } });
  }

  // ---- ingestion of what discovery found (shared with Get Content) ---------------------------------------------------------------------------------------

  /** Stores the website's picture candidates (and, when the reader returned them, its logo candidates) as library rows. Nothing is downloaded. */
  async ingestWebsite(projectId: string, d: WebsiteImageDiscovery): Promise<{ created: number; logos: number }> {
          let created = 0;
          for (const c of d.candidates) {
            const key = imageStem(c.url);
            const file = decodeURIComponent(new URL(c.url).pathname.split('/').pop() ?? '');
            const title = (c.alt || c.title || c.context || file).slice(0, 160);
            const data = { title, pageUrl: c.pageUrl, remoteUrl: c.url, width: c.width, height: c.height, text: textOfImage({ title: c.title, alt: c.alt, fileName: file, context: c.context }), metaJson: { where: c.where, firstParty: c.firstParty, prominence: c.prominence } as never };
            const existing = await this.prisma.projectImage.findUnique({ where: { projectId_source_dedupeKey: { projectId, source: 'website', dedupeKey: key } } });
            if (existing) {
              if (existing.status === 'candidate' && !existing.assetId) await this.prisma.projectImage.update({ where: { id: existing.id }, data });
              continue;
            }
            await this.prisma.projectImage.create({ data: { projectId, source: 'website', status: 'candidate', dedupeKey: key, rightsJson: candidateRights('website', { firstParty: c.firstParty }) as never, ...data } });
            created++;
          }
          await this.trim(projectId, 'website');
    const logos = d.logos?.length ? await this.ingestLogoCandidates(projectId, d.logos) : 0;
    return { created, logos };
  }

  /** Stores the repository's picture candidates (and logo candidates) as library rows. Nothing is downloaded. */
  async ingestRepository(projectId: string, d: RepoImageDiscovery): Promise<{ created: number; logos: number }> {
            let created = 0;
            for (const c of d.candidates) {
              const key = `${c.owner}/${c.repo}@${c.path}`;
              const file = c.path.split('/').pop() ?? c.path;
              const data = { title: `${c.kind === 'logo' ? 'Logo' : c.kind === 'screenshot' ? 'Screenshot' : c.kind === 'marketing' ? 'Marketing image' : 'Image'}: ${c.path}`.slice(0, 160), pageUrl: c.pageUrl, remoteUrl: null, text: textOfImage({ fileName: file, context: c.path.replace(/[/_.-]+/g, ' ') }), metaJson: { owner: c.owner, repo: c.repo, ref: c.ref, path: c.path, size: c.size, kind: c.kind, prominence: Math.min(1, c.priority / 4), repoLicense: d.repo?.license ?? null } as never };
              const existing = await this.prisma.projectImage.findUnique({ where: { projectId_source_dedupeKey: { projectId, source: 'github', dedupeKey: key } } });
              if (existing) {
                if (existing.status === 'candidate' && !existing.assetId) await this.prisma.projectImage.update({ where: { id: existing.id }, data });
                continue;
              }
              await this.prisma.projectImage.create({ data: { projectId, source: 'github', status: 'candidate', dedupeKey: key, rightsJson: candidateRights('github', { note: d.repo?.license ? `The repository license (${d.repo.license}) covers its source code, not necessarily this picture.` : undefined }) as never, ...data } });
              created++;
            }
            await this.trim(projectId, 'github');
    const logos = d.logos?.length ? await this.ingestLogoCandidates(projectId, d.logos) : 0;
    return { created, logos };
  }

  /** Stores logo candidates as library rows of role "logo". An approved or rejected candidate keeps its decision; a candidate is refreshed. */
  async ingestLogoCandidates(projectId: string, list: readonly LogoCandidateInfo[]): Promise<number> {
    let created = 0;
    for (const c of list.slice(0, 24)) {
      const source: LibrarySource = c.source === 'approved' ? 'upload' : c.source;
      const isOwn = c.source === 'upload' || c.source === 'approved';
      const data = {
        title: c.fileName.slice(0, 160),
        pageUrl: c.pageUrl,
        remoteUrl: c.source === 'website' ? c.location : null,
        width: c.width,
        height: c.height,
        text: c.signals.join('; ').slice(0, 300),
        score: c.confidence,
        metaJson: { signals: c.signals, favicon: c.favicon, svg: c.svg, format: c.format, fileName: c.fileName, location: c.location, ...c.meta } as never,
      };
      const existing = await this.prisma.projectImage.findUnique({ where: { projectId_source_dedupeKey: { projectId, source, dedupeKey: c.key } } });
      if (existing) {
        if (existing.status === 'candidate' && existing.role === 'logo') await this.prisma.projectImage.update({ where: { id: existing.id }, data });
        continue;
      }
      await this.prisma.projectImage.create({
        data: { projectId, role: 'logo', source, status: 'candidate', dedupeKey: c.key, rightsJson: (isOwn ? uploadRights({ note: 'The logo file the project holds.' }) : candidateRights(source as 'website' | 'github', { note: c.source === 'github' ? 'The repository license covers its source code, not necessarily this logo.' : undefined })) as never, assetId: c.source === 'upload' && (c.meta as { assetType?: string }).assetType === 'logo' ? String((c.meta as { assetId?: string }).assetId ?? '') || null : null, ...data },
      });
      created++;
    }
    return created;
  }

  async discover(userId: string, projectId: string, o: { sources?: string[]; refresh?: boolean } = {}) {
    await this.projects.assertOwned(userId, projectId);
    const wanted = new Set((o.sources?.length ? o.sources : ['website', 'github', 'social', 'stock']).filter((s) => (LIBRARY_SOURCES as readonly string[]).includes(s)));
    const sc = await this.scoring(userId, projectId);
    const intake = sc.intake;
    const outcomes: Record<string, Obj> = {};
    const foundSocial: { platform: string; url: string }[] = [];

    if (wanted.has('website')) {
      if (!intake?.websiteUrl) outcomes.website = { status: 'not_configured', message: 'This project has no website address. Add it in the project settings to find your own pictures.', pages: [], found: 0 };
      else {
        const r = await this.guarded(() => this.readers.website(intake.websiteUrl), 40_000);
        if (!r.ok) outcomes.website = { status: 'failed', message: r.message, pages: [], found: 0 };
        else {
          const d = r.value;
          for (const s of d.socialLinks) foundSocial.push(s);
          const { created } = await this.ingestWebsite(projectId, d);
          outcomes.website = { status: d.pages.some((p) => p.status === 'read') ? 'ok' : 'failed', message: d.pages.some((p) => p.status === 'read') ? null : (d.notes[0] ?? 'No page could be read.'), pages: d.pages, found: d.candidates.length, added: created, rejected: d.rejected.length, notes: d.notes };
        }
      }
    }

    if (wanted.has('github')) {
      if (!intake?.githubUrl) outcomes.github = { status: 'not_configured', message: 'This project has no repository address.', found: 0 };
      else {
        const r = await this.guarded(() => this.readers.repository(intake.githubUrl), 40_000);
        if (!r.ok) outcomes.github = { status: 'failed', message: r.message, found: 0 };
        else {
          const d = r.value;
          if (!d.ok) outcomes.github = { status: 'failed', message: d.notes[0] ?? 'The repository could not be read.', found: 0, notes: d.notes };
          else {
            const { created } = await this.ingestRepository(projectId, d);
            outcomes.github = { status: 'ok', message: null, found: d.candidates.length, added: created, rejected: d.rejected.length, repository: d.repo, notes: d.notes };
          }
        }
      }
    }

    if (wanted.has('social')) {
      const profiles = await this.prisma.socialProfile.findMany({ where: { projectId }, select: { platform: true, url: true } });
      const infos = describeSocialSources(profiles, foundSocial);
      for (const s of infos) {
        const rights = socialRights(s.platform);
        await this.prisma.projectImage
          .upsert({ where: { projectId_source_dedupeKey: { projectId, source: 'social', dedupeKey: s.url } }, create: { projectId, source: 'social', status: 'candidate', dedupeKey: s.url, title: `${s.platform} profile`, pageUrl: s.url, rightsJson: rights as never, text: s.platform, metaJson: { platform: s.platform, origin: s.origin, note: s.note, manualImport: s.manualImport } as never }, update: { metaJson: { platform: s.platform, origin: s.origin, note: s.note, manualImport: s.manualImport } as never } })
          .catch(() => undefined);
      }
      outcomes.social = { status: infos.length ? 'reference_only' : 'not_configured', message: infos.length ? 'No integration reads pictures from these platforms: the links are references. Upload a picture you own to use it.' : 'No social profile links are stored for this project.', found: infos.length, sources: infos };
    }

    if (wanted.has('stock')) {
      if (!this.adapters.some((a) => a.configured)) outcomes.stock = { status: 'not_configured', message: 'No licensed image provider is configured on this server.', providers: this.adapters.map((a) => ({ id: a.id, label: a.label, configured: a.configured, setup: a.configured ? null : a.setup })), found: 0 };
      else {
        const r = await this.guarded(() => this.visual.discover(userId, projectId, { refresh: o.refresh === true }), 40_000);
        outcomes.stock = r.ok ? { status: r.value.providers.some((p) => p.status === 'ok') ? 'ok' : 'failed', message: r.value.notes[0] ?? null, providers: r.value.providers, found: r.value.licensed.length, notes: r.value.notes } : { status: 'failed', message: r.message, found: 0 };
      }
    }
    return { outcomes, library: await this.list(userId, projectId) };
  }

  // ---- decisions ---------------------------------------------------------------------------------------------------------------------------------------------

  private async row(projectId: string, id: string) {
    const row = await this.prisma.projectImage.findFirst({ where: { id, projectId, role: 'photo' } });
    if (!row) throw new NotFoundException('Picture not found');
    return row;
  }

  async approve(userId: string, projectId: string, imageId: string, body: { attest?: boolean; reviewConfirmed?: boolean } = {}) {
    await this.projects.assertOwned(userId, projectId);
    if (imageId.startsWith('stock:')) {
      const [, provider, ...rest] = imageId.split(':');
      const id = rest.join(':');
      await this.visual.addLicensedImage(userId, projectId, { provider, id, reviewConfirmed: body.reviewConfirmed === true });
      const row = await this.prisma.projectImage.findFirst({ where: { projectId, source: 'stock', dedupeKey: `${provider}:${id}` } });
      return { item: row ? await this.itemOf(userId, projectId, row.id) : null };
    }
    await this.ensureRows(projectId);
    const row = await this.row(projectId, imageId);
    const rights = asRights(row.rightsJson);
    if (row.source === 'social' || rights.kind === 'REFERENCE_ONLY' || rights.status === 'reference_only') throw new UnprocessableEntityException({ statusCode: 422, code: 'reference_only', message: 'A link to a social profile is a reference. LaunchPilot never copies platform content: upload a picture you own instead.' });
    if (rights.status === 'blocked') throw new UnprocessableEntityException({ statusCode: 422, code: 'license_blocked', message: `The license (${rights.license}) does not allow this picture to be used in advertising. Approving it cannot change that.` });
    if (row.source === 'upload' || (row.assetId && rights.userApproved === false && (rights.status === 'cleared' || rights.status === 'attested'))) {
      await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', decidedAt: new Date(), rightsJson: { ...rights, userApproved: true } as never } });
      await this.activity.log(userId, 'image.approved', projectId, { source: row.source });
      return { item: await this.itemOf(userId, projectId, row.id) };
    }
    if (row.source === 'website' || row.source === 'github') {
      if (body.attest !== true) throw new UnprocessableEntityException({ statusCode: 422, code: 'attestation_required', message: 'Confirm that you own this picture or hold the rights to use it in advertising. Without that confirmation LaunchPilot does not download or use it.' });
      if (row.assetId) {
        const attested = attestRights(rights, { at: new Date() });
        await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', decidedAt: new Date(), rightsJson: attested as never } });
        return { item: await this.itemOf(userId, projectId, row.id) };
      }
      const approvedImports = await this.prisma.projectImage.count({ where: { projectId, role: 'photo', status: 'approved', source: { in: ['website', 'github'] } } });
      if (approvedImports >= MAX_APPROVED_IMPORTS) throw new UnprocessableEntityException(`A project can import at most ${MAX_APPROVED_IMPORTS} pictures from its website and repository.`);
      const meta = (row.metaJson ?? {}) as Obj;
      const got = row.source === 'website' ? (row.remoteUrl ? await this.readers.fetchWebsiteImage(row.remoteUrl) : ({ ok: false, message: 'The picture address is missing.' } as FetchedPicture)) : await this.readers.fetchRepositoryImage({ owner: String(meta.owner), repo: String(meta.repo), ref: String(meta.ref), path: String(meta.path) });
      if (!got.ok) throw new UnprocessableEntityException({ statusCode: 422, code: 'download_failed', message: `The picture could not be downloaded (${got.message}).` });
      if (!isImageBuffer(got.data)) throw new UnprocessableEntityException({ statusCode: 422, code: 'not_an_image', message: 'The file is not a PNG, JPEG, WebP or GIF picture.' });
      const analysis = await analyzeImage(got.data);
      if (!analysis) throw new UnprocessableEntityException({ statusCode: 422, code: 'not_an_image', message: 'The picture could not be read.' });
      const dims = { width: analysis.width, height: analysis.height };
      if (Math.max(dims.width, dims.height) < MIN_IMPORT_SIDE) throw new UnprocessableEntityException({ statusCode: 422, code: 'too_small', message: `The picture is only ${dims.width}x${dims.height} pixels; at least ${MIN_IMPORT_SIDE} on the long side is needed so it stays sharp in a creative.` });
      const twin = analysis ? await this.findNearDuplicate(projectId, analysis.phash, row.id) : null;
      if (twin) throw new UnprocessableEntityException({ statusCode: 422, code: 'duplicate', message: `This picture is nearly identical to "${twin.title}", which is already in the library, so it was not added again.` });
      const ext = got.contentType.includes('png') ? '.png' : got.contentType.includes('webp') ? '.webp' : '.jpg';
      const name = `${row.source}-${row.id}${ext}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const key = await this.storage.save(projectId, name, got.data);
      const attested = attestRights(rights, { at: new Date() });
      const sha = (await import('node:crypto')).createHash('sha256').update(got.data).digest('hex');
      const asset = await this.prisma.projectAsset.create({ data: { projectId, type: 'image', originalName: String(row.title).slice(0, 100) + ext, mimeType: got.contentType.startsWith('image/') ? got.contentType.split(';')[0] : 'image/jpeg', filePath: key, fileSize: got.data.length } });
      await this.prisma.imageProvenance.create({ data: { projectId, assetId: asset.id, provider: row.source, providerImageId: row.dedupeKey.slice(0, 200), pageUrl: row.pageUrl ?? row.remoteUrl ?? '', creator: null, creatorUrl: null, license: attested.license, licenseUrl: null, attribution: null, attributionRequired: false, licenseBasis: 'user_attested', sha256: sha, width: dims.width, height: dims.height, acquiredById: userId, sourceKind: 'BRAND_ASSET', originalUrl: row.remoteUrl ?? row.pageUrl ?? null, perceptualHash: analysis?.phash ?? null, rightsJson: attested as never } });
      await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', assetId: asset.id, width: dims.width, height: dims.height, analysisJson: (analysis ?? undefined) as never, rightsJson: attested as never, decidedAt: new Date() } });
      await this.activity.log(userId, 'image.attested_imported', projectId, { source: row.source });
      return { item: await this.itemOf(userId, projectId, row.id) };
    }
    if (row.source === 'stock') {
      if (rights.status === 'needs_review' && body.reviewConfirmed !== true) throw new UnprocessableEntityException({ statusCode: 422, code: 'review_required', message: 'Check the license at the source and confirm it before this picture can be used.' });
      await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', decidedAt: new Date(), rightsJson: { ...confirmReview(rights), userApproved: true } as never } });
      return { item: await this.itemOf(userId, projectId, row.id) };
    }
    throw new BadRequestException('This picture cannot be approved.');
  }

  /**
   * Get Content: approves several pictures at once. Each one goes through the SAME single-picture rules (rights, attestation, duplicates), so a batch can
   * never approve what one click could not. One failing picture never stops the others; every result is reported.
   */
  async approveBatch(userId: string, projectId: string, ids: string[], body: { attest?: boolean; reviewConfirmed?: boolean }) {
    await this.projects.assertOwned(userId, projectId);
    const results: { id: string; ok: boolean; item?: LibraryItemView | null; code?: string; message?: string }[] = [];
    for (const id of [...new Set(ids)].slice(0, 24)) {
      try {
        const r = await this.approve(userId, projectId, id, { attest: body.attest === true, reviewConfirmed: body.reviewConfirmed === true });
        results.push({ id, ok: true, item: r.item });
      } catch (e) {
        const res = (e as { getResponse?: () => unknown })?.getResponse?.() as { code?: string; message?: unknown } | string | undefined;
        results.push({ id, ok: false, code: typeof res === 'object' ? res?.code : undefined, message: typeof res === 'object' ? String(res?.message ?? '') : typeof res === 'string' ? res : 'The picture could not be approved.' });
      }
    }
    if (results.some((r) => r.ok)) await this.brand.touchApproved(projectId, userId);
    return { results };
  }

  async rejectBatch(userId: string, projectId: string, ids: string[]) {
    await this.projects.assertOwned(userId, projectId);
    const results: { id: string; ok: boolean; item?: LibraryItemView | null }[] = [];
    for (const id of [...new Set(ids)].slice(0, 24)) {
      try {
        const r = await this.reject(userId, projectId, id);
        results.push({ id, ok: true, item: r.item });
      } catch {
        results.push({ id, ok: false });
      }
    }
    return { results };
  }

  async reject(userId: string, projectId: string, imageId: string) {
    await this.projects.assertOwned(userId, projectId);
    if (imageId.startsWith('stock:')) return { item: null, dismissed: imageId }; // a search result that was never imported has nothing to reject
    const row = await this.row(projectId, imageId);
    const rights = asRights(row.rightsJson);
    await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'rejected', decidedAt: new Date(), rightsJson: { ...rights, userApproved: false } as never } });
    await this.activity.log(userId, 'image.rejected', projectId, { source: row.source });
    return { item: await this.itemOf(userId, projectId, row.id) };
  }

  /** A rejected picture is restored: an upload or an already imported picture is approved again; a candidate goes back to being a candidate. */
  async restore(userId: string, projectId: string, imageId: string) {
    await this.projects.assertOwned(userId, projectId);
    const row = await this.row(projectId, imageId);
    const rights = asRights(row.rightsJson);
    if (row.assetId && rights.status !== 'blocked' && rights.status !== 'reference_only') await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', decidedAt: new Date(), rightsJson: { ...rights, userApproved: true } as never, metaJson: { ...((row.metaJson ?? {}) as Obj), autoRejected: undefined } as never } });
    else await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'candidate', decidedAt: null } });
    return { item: await this.itemOf(userId, projectId, row.id) };
  }

  private async itemOf(userId: string, projectId: string, id: string): Promise<LibraryItemView | null> {
    const lib = await this.list(userId, projectId);
    return lib.items.find((i) => i.id === id) ?? null;
  }

  /** Other licensed pictures like this one (a new search from the picture's own words). The results join the 24-hour cache so they can be approved. */
  async alternatives(userId: string, projectId: string, imageId: string) {
    await this.projects.assertOwned(userId, projectId);
    let text = '';
    if (imageId.startsWith('stock:')) {
      const lib = await this.list(userId, projectId);
      text = lib.items.find((i) => i.id === imageId)?.title ?? '';
    } else {
      const row = await this.row(projectId, imageId);
      text = `${row.title} ${row.text}`;
    }
    if (!this.adapters.some((a) => a.configured && a.kind === 'licensed')) return { status: 'not_configured', message: 'No licensed image provider is configured on this server, so there is nothing to search. Upload your own picture instead.', items: [] as LibraryItemView[] };
    const sc = await this.scoring(userId, projectId);
    const result = await this.guarded(() => discoverImages({ business: sc.intake?.productName ?? text, offering: text, formatClasses: [] }, this.adapters, { includePaid: false }), 40_000);
    if (!result.ok) return { status: 'failed', message: result.message, items: [] as LibraryItemView[] };
    const r = result.value;
    if (r.licensed.length) await this.prisma.visualDiscoveryRun.create({ data: { projectId, userId, queryKey: `alt:${imageId}:${Date.now()}`, resultJson: { ...r, references: [] } as never, expiresAt: new Date(Date.now() + DAY_MS) } }).catch(() => undefined);
    const have = new Set((await this.prisma.projectImage.findMany({ where: { projectId, source: 'stock' }, select: { dedupeKey: true } })).map((h) => h.dedupeKey));
    const none = { score: null, relevance: null, estimated: true, reasons: [] as string[] };
    return { status: r.licensed.length ? 'ok' : 'empty', message: r.notes[0] ?? null, items: r.licensed.filter((c) => !have.has(`${c.provider}:${c.id}`)).slice(0, 12).map((c) => this.stockView(c, none)) };
  }

  // ---- what a campaign uses ---------------------------------------------------------------------------------------------------------------------------------

  /** The approved, rights-eligible pictures of a project as the campaign receives them (bytes + rights + measurements). Reference-only and unapproved pictures never appear. */
  async loadApproved(projectId: string, o: { withData: boolean }): Promise<{ images: BrandImage[]; count: number; skipped: string[] }> {
    await this.ensureRows(projectId);
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, role: 'photo', status: 'approved', assetId: { not: null } }, include: { asset: true }, orderBy: [{ score: 'desc' }, { createdAt: 'asc' }] });
    const skipped: string[] = [];
    const usable = rows.filter((r) => {
      const e = exportEligibility(asRights(r.rightsJson));
      if (!e.eligible) skipped.push(`${r.title}: ${e.reason}`);
      return e.eligible && !!r.asset && RASTER.test(r.asset.mimeType);
    });
    if (!o.withData) return { images: [], count: Math.min(usable.length, MAX_LIBRARY_IMAGES), skipped };
    const images: BrandImage[] = [];
    let bytes = 0;
    for (const r of usable) {
      if (images.length >= MAX_LIBRARY_IMAGES || bytes >= MAX_LIBRARY_BYTES) break;
      const data = await readAll(this.storage.read(r.asset!.filePath)).catch(() => null);
      if (!data || !isImageBuffer(data)) continue;
      bytes += data.length;
      let analysis = (r.analysisJson ?? null) as ImageAnalysis | null;
      if (!analysis) {
        analysis = await analyzeImage(data);
        if (analysis) await this.prisma.projectImage.update({ where: { id: r.id }, data: { analysisJson: analysis as never } }).catch(() => undefined);
      }
      images.push({ id: r.assetId!, name: r.asset!.originalName.slice(0, 120), data, library: { rights: asRights(r.rightsJson), analysis, text: `${r.title} ${r.text}`.slice(0, 500), width: analysis?.width ?? r.width, height: analysis?.height ?? r.height, pageUrl: r.pageUrl, via: 'library' } });
    }
    return { images, count: images.length, skipped };
  }

  /** How many picture candidates the gallery knows (website, repository, licensed): reported in the campaign, never used as pictures. */
  async discoveredCount(projectId: string): Promise<number> {
    const [rows, stock] = await Promise.all([this.prisma.projectImage.count({ where: { projectId, role: 'photo', source: { in: ['website', 'github', 'stock'] } } }), this.stockCandidates(projectId)]);
    return rows + stock.items.length;
  }

  /** Original files of the library pictures a package may hand on (rights allow it), for the archive. */
  async exportSources(projectId: string, ids: string[]): Promise<{ id: string; fileName: string; data: Buffer | null }[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.projectImage.findMany({ where: { projectId, assetId: { in: ids } }, include: { asset: true } });
    const out: { id: string; fileName: string; data: Buffer | null }[] = [];
    for (const r of rows) {
      if (!r.asset || !asRights(r.rightsJson).redistributeOriginal) continue;
      out.push({ id: r.assetId!, fileName: r.asset.originalName, data: await readAll(this.storage.read(r.asset.filePath)).catch(() => null) });
    }
    return out;
  }

  /** The rights line of every library picture, for the usage notes. */
  rightsLine(r: ImageRights): string {
    return rightsSummary(r);
  }

  // ---- the free check the factory plan shows -----------------------------------------------------------------------------------------------------------------

  async preflight(projectId: string, o: { concepts: number; slots: number; autoStock: boolean }) {
    await this.ensureRows(projectId);
    const [rows, stock, social] = await Promise.all([this.prisma.projectImage.findMany({ where: { projectId, role: 'photo' } }), this.stockCandidates(projectId), this.prisma.socialProfile.count({ where: { projectId } })]);
    const eligible = rows.filter((r) => r.status === 'approved' && !!r.assetId && exportEligibility(asRights(r.rightsJson)).eligible);
    const awaiting = { website: rows.filter((r) => r.source === 'website' && r.status === 'candidate').length, github: rows.filter((r) => r.source === 'github' && r.status === 'candidate').length, stockReview: stock.items.filter((c) => c.license.status === 'needs_review').length, stockCleared: stock.items.filter((c) => c.license.status === 'cleared').length };
    const configured = this.adapters.filter((a) => a.configured);
    const needed = Math.min(10, Math.max(o.concepts, Math.ceil(o.slots / 2)));
    const providers = this.adapters.map((a) => ({ id: a.id, label: a.label, kind: a.kind, configured: a.configured, paid: a.paid === true, setup: a.configured ? null : a.setup }));
    const warnings: string[] = [];
    const canTopUp = o.autoStock && configured.some((a) => a.kind === 'licensed');
    if (eligible.length === 0 && !canTopUp) warnings.push('No approved picture exists yet: every creative would be text-first. Upload pictures, approve candidates from your website or repository, or switch on automatic stock mode (needs a licensed image provider).');
    else if (eligible.length < o.concepts && !canTopUp) warnings.push(`${eligible.length} approved picture(s) for ${o.concepts} concepts: some concepts will share a picture (cropped differently).`);
    if (o.autoStock && !configured.some((a) => a.kind === 'licensed')) warnings.push('Automatic stock mode is on, but no licensed image provider is configured on this server (set PIXABAY_API_KEY, PEXELS_API_KEY or OPENVERSE_ENABLED=true). Nothing can be added automatically.');
    if (awaiting.website + awaiting.github > 0) warnings.push(`${awaiting.website + awaiting.github} website/repository picture(s) wait for your rights confirmation and are NOT used until you approve them.`);
    if (awaiting.stockReview > 0) warnings.push(`${awaiting.stockReview} licensed picture(s) need a license check at the source and are never added automatically.`);
    if (social > 0) warnings.push('Social media links are references only: LaunchPilot has no integration that reads pictures from them.');
    return {
      aiImages: 0,
      approved: eligible.length,
      approvedBySource: Object.fromEntries(LIBRARY_SOURCES.map((s) => [s, eligible.filter((r) => r.source === s).length])),
      awaitingAuthorization: awaiting,
      providers,
      providersConfigured: configured.map((a) => a.id),
      autoStock: o.autoStock,
      estimate: { creativesPlanned: o.slots, concepts: o.concepts, approvedPictures: eligible.length, picturesWanted: needed, enough: eligible.length >= o.concepts, note: eligible.length >= o.concepts ? `${eligible.length} approved picture(s) are enough for ${o.concepts} concepts; creatives reuse them with different crops and templates.` : canTopUp ? 'Automatic stock mode may add pictures during the run when a provider has cleared ones; this is not guaranteed.' : 'Fewer pictures than concepts: the rest of the creatives are text-first or share a picture.' },
      warnings,
    };
  }
}
