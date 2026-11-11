import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  analyzeImage,
  attestRights,
  brandWordsOf,
  candidateRights,
  exportEligibility,
  getCollection,
  isFirstParty,
  isImageBuffer,
  logosOfUploads,
  rasterizeSvg,
  type ImageRights,
  type LibrarySource,
  type LogoCandidateInfo,
  uploadRights,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll } from '../mozaik/campaign-assets';
import { IMAGE_SOURCES, ImageLibraryService, type FetchedPicture, type ImageSourceReaders } from './image-library.service';
import { ProjectBrandService } from './project-brand.service';
import { VisualService } from './visual.service';

type Obj = Record<string, any>;

export type GetContentSourceId = 'uploads' | 'website' | 'github' | 'existing' | 'palette';
export type SourceStatus = 'pending' | 'running' | 'ok' | 'empty' | 'unavailable' | 'blocked' | 'failed' | 'skipped' | 'cancelled';
export interface SourceState {
  id: GetContentSourceId;
  label: string;
  status: SourceStatus;
  message: string | null;
  found: { logos: number; photos: number; colors: number };
}

const LABELS: Record<GetContentSourceId, string> = { uploads: 'Project uploads', website: 'Website', github: 'GitHub repository', existing: 'Existing approved assets', palette: 'Palette extraction' };
const ORDER: GetContentSourceId[] = ['uploads', 'website', 'github', 'existing', 'palette'];
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_RUN_MS = 10 * 60 * 1000;
const WEBSITE_MS = 45_000;
const GITHUB_MS = 40_000;
const PALETTE_MS = 40_000;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const MIN_LOGO_SIDE = 32;
const RASTER = /^image\/(png|jpe?g|webp)$/i;

const initial = (): SourceState[] => ORDER.map((id) => ({ id, label: LABELS[id], status: 'pending', message: null, found: { logos: 0, photos: 0, colors: 0 } }));

/**
 * GET CONTENT. An OPTIONAL step before a campaign: it looks, for free and deterministically, at the material the project already supplied (uploads, official
 * website, GitHub repository, earlier approvals) and offers a real LOGO, useful PHOTOGRAPHS and a recommended PALETTE for the owner to review and approve.
 *
 *   - it never calls OpenAI, never starts a campaign run and needs no budget; nothing here runs unless the owner asks for it
 *   - every source is its own step with its own status and timeout; a failed source never fails the others, and an unreachable source is never reported as analysed
 *   - one run per project at a time; an unchanged project reuses a run younger than 24 hours; a run can be cancelled
 *   - candidates are only DESCRIPTIONS until the owner approves them: a website or repository file is downloaded only after the owner confirms the rights
 *   - discovered photographs and logos live in the existing image library (ProjectImage), approvals in the existing provenance model; the palette is only a
 *     suggestion for the Campaign Design editor, which stays the single palette store
 */
@Injectable()
export class GetContentService implements OnModuleInit {
  private readonly logger = new Logger('GetContent');
  private readonly active = new Map<string, { runId: string; abort: AbortController }>();

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private storage: StorageDriver,
    private activity: ActivityLogService,
    private visual: VisualService,
    private library: ImageLibraryService,
    private brand: ProjectBrandService,
    @Inject(IMAGE_SOURCES) private readers: ImageSourceReaders,
  ) {}

  /** A run left "running" by a previous process can never finish: it is marked interrupted, never resumed. */
  async onModuleInit() {
    await this.prisma.getContentRun
      .updateMany({ where: { status: 'running' }, data: { status: 'interrupted', finishedAt: new Date() } })
      .catch(() => undefined); // the table may not exist yet (migration pending)
  }

  // ---- the run --------------------------------------------------------------------------------------------------------------------------------------------

  private runView(row: Obj, cached = false) {
    const sources = (row.sourcesJson as SourceState[]) ?? [];
    return {
      id: row.id as string,
      status: row.status as string,
      startedAt: (row.startedAt as Date).toISOString(),
      finishedAt: row.finishedAt ? (row.finishedAt as Date).toISOString() : null,
      cached,
      sources,
      summary: (row.summaryJson as Obj | null) ?? { uploadsInspected: 0, websiteInspected: false, githubInspected: false, imagesFound: 0, imagesEligibleForApproval: 0, logoCandidates: 0, sourcesUnavailable: [] },
      notes: ((row.notesJson as string[] | null) ?? []).slice(0, 12),
    };
  }

  private async fingerprint(projectId: string, collectionId: string | null): Promise<string> {
    const [intake, assets, brand] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.projectAsset.findMany({ where: { projectId }, select: { id: true, type: true, fileSize: true }, orderBy: { id: 'asc' } }),
      this.brand.content(projectId),
    ]);
    return createHash('sha256')
      .update(JSON.stringify({ w: intake?.websiteUrl ?? null, g: intake?.githubUrl ?? null, a: assets.map((x) => [x.id, x.type, x.fileSize]), l: brand?.logoAssetId ?? null, c: collectionId }))
      .digest('hex')
      .slice(0, 32);
  }

  async start(userId: string, projectId: string, o: { refresh?: boolean; collectionId?: string } = {}) {
    await this.projects.assertOwned(userId, projectId);
    // one discovery per project at a time: pressing the button again while it runs returns the run that is running
    const running = this.active.get(projectId);
    if (running) {
      const row = await this.prisma.getContentRun.findUnique({ where: { id: running.runId } });
      if (row) return this.runView(row);
    }
    await this.prisma.getContentRun.updateMany({ where: { projectId, status: 'running', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }, data: { status: 'interrupted', finishedAt: new Date() } });
    const collectionId = o.collectionId && getCollection(o.collectionId) ? o.collectionId : null;
    const fp = await this.fingerprint(projectId, collectionId);
    if (!o.refresh) {
      const hit = await this.prisma.getContentRun.findFirst({ where: { projectId, fingerprint: fp, status: { in: ['completed', 'partial'] }, expiresAt: { gt: new Date() } }, orderBy: { startedAt: 'desc' } });
      if (hit) return this.runView(hit, true);
    }
    const row = await this.prisma.getContentRun.create({ data: { projectId, userId, status: 'running', fingerprint: fp, sourcesJson: initial() as never } });
    const abort = new AbortController();
    this.active.set(projectId, { runId: row.id, abort });
    void this.execute(row.id, userId, projectId, collectionId, abort).finally(() => this.active.delete(projectId));
    return this.runView(row);
  }

  async cancel(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const running = this.active.get(projectId);
    if (running) running.abort.abort();
    const row = await this.prisma.getContentRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
    if (!row) throw new NotFoundException('There is no Get Content run to cancel.');
    // give the job a moment to record the cancellation
    for (let i = 0; i < 20 && this.active.has(projectId); i++) await new Promise((r) => setTimeout(r, 50));
    return this.runView((await this.prisma.getContentRun.findUnique({ where: { id: row.id } })) ?? row);
  }

  private async guarded<T>(fn: () => Promise<T>, ms: number, signal: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; message: string; aborted: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const v = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), ms);
          signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        }),
      ]);
      return { ok: true, value: v };
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      return { ok: false, message: m === 'timeout' ? 'The source did not answer in time.' : m === 'aborted' ? 'Cancelled.' : 'The source could not be read.', aborted: m === 'aborted' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async execute(runId: string, userId: string, projectId: string, collectionId: string | null, abort: AbortController) {
    const signal = abort.signal;
    const states = initial();
    const notes: string[] = [];
    let paletteSnapshot: unknown = null;
    const save = () => this.prisma.getContentRun.update({ where: { id: runId }, data: { sourcesJson: states as never } }).catch(() => undefined);
    const set = async (id: GetContentSourceId, patch: Partial<SourceState>) => {
      const s = states.find((x) => x.id === id)!;
      Object.assign(s, patch);
      await save();
    };
    const step = async (id: GetContentSourceId, fn: () => Promise<Partial<SourceState>>) => {
      if (signal.aborted) return void (await set(id, { status: 'cancelled', message: 'Cancelled before it started.' }));
      await set(id, { status: 'running' });
      try {
        const r = await fn();
        await set(id, signal.aborted && r.status !== 'skipped' ? { status: 'cancelled', message: 'Cancelled.' } : r);
      } catch (e) {
        this.logger.warn(`Get Content ${id} failed: ${e instanceof Error ? e.name : 'error'}`);
        await set(id, { status: 'failed', message: 'This source could not be processed.' });
      }
    };
    try {
      const [intake, project] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })]);
      const brandWords = brandWordsOf(intake?.productName ?? project?.name, intake?.websiteUrl ? new URL(intake.websiteUrl).hostname.replace(/^www\./, '').split('.')[0] : null);

      // stage A: the local steps and the two network sources run side by side (at most two requests to the outside at once)
      await Promise.all([
        step('uploads', async () => {
          const assets = await this.prisma.projectAsset.findMany({ where: { projectId, type: { in: ['logo', 'image', 'screenshot', 'other'] } }, orderBy: { createdAt: 'desc' }, take: 60 });
          await this.library.ensureRows(projectId);
          const owned: { id: string; type: string; name: string; mimeType: string; width: number | null; height: number | null }[] = [];
          for (const a of assets.filter((x) => x.type === 'logo' || /logo|wordmark|brandmark/i.test(x.originalName)).slice(0, 8)) {
            let w: number | null = null;
            let h: number | null = null;
            if (RASTER.test(a.mimeType) && a.fileSize <= MAX_LOGO_BYTES) {
              const data = await readAll(this.storage.read(a.filePath)).catch(() => null);
              const an = data && isImageBuffer(data) ? await analyzeImage(data) : null;
              w = an?.width ?? null;
              h = an?.height ?? null;
            }
            owned.push({ id: a.id, type: a.type, name: a.originalName, mimeType: a.mimeType, width: w, height: h });
          }
          const infos = logosOfUploads(owned, brandWords);
          await this.library.ingestLogoCandidates(projectId, infos);
          const brand = await this.brand.content(projectId);
          if (brand?.logoAssetId) await this.prisma.projectImage.updateMany({ where: { projectId, role: 'logo', assetId: brand.logoAssetId }, data: { status: 'approved' } });
          const photos = await this.prisma.projectImage.count({ where: { projectId, role: 'photo', source: 'upload' } });
          return { status: assets.length ? 'ok' : 'empty', message: assets.length ? null : 'Nothing has been uploaded to this project yet.', found: { logos: infos.length, photos, colors: 0 } };
        }),
        step('website', async () => {
          if (!intake?.websiteUrl) return { status: 'skipped', message: 'No website address was given for this project.' };
          const r = await this.guarded(() => this.readers.website(intake.websiteUrl!, { logoBrand: brandWords, signal }), WEBSITE_MS, signal);
          if (!r.ok) return { status: 'failed', message: r.message };
          const d = r.value;
          const read = d.pages.some((p) => p.status === 'read');
          if (!read) {
            const blocked = d.pages.some((p) => p.status === 'blocked');
            return { status: blocked ? 'blocked' : 'unavailable', message: d.pages[0]?.message ?? d.notes[0] ?? 'The website could not be read.' };
          }
          const ing = await this.library.ingestWebsite(projectId, d);
          notes.push(...d.notes.slice(0, 2));
          const logos = d.logos?.length ?? 0;
          const photos = d.candidates.length;
          return { status: logos || photos ? 'ok' : 'empty', message: logos || photos ? `${d.pages.filter((p) => p.status === 'read').length} page(s) read; nothing was downloaded.` : 'The pages were read, but no logo or usable photograph was found on them.', found: { logos, photos: Math.max(photos, ing.created), colors: 0 } };
        }),
        step('github', async () => {
          if (!intake?.githubUrl) return { status: 'skipped', message: 'No repository address was given for this project.' };
          const r = await this.guarded(() => this.readers.repository(intake.githubUrl!, { logoBrand: brandWords, signal }), GITHUB_MS, signal);
          if (!r.ok) return { status: 'failed', message: r.message };
          const d = r.value;
          if (!d.ok) return { status: /limit/i.test(d.notes[0] ?? '') ? 'failed' : 'unavailable', message: d.notes[0] ?? 'The repository could not be read.' };
          await this.library.ingestRepository(projectId, d);
          const logos = d.logos?.length ?? 0;
          return { status: logos || d.candidates.length ? 'ok' : 'empty', message: logos || d.candidates.length ? 'The file list was read through the GitHub API; nothing was downloaded or executed.' : 'No logo or usable picture was found in the repository.', found: { logos, photos: d.candidates.length, colors: 0 } };
        }),
      ]);

      // existing approved material
      await step('existing', async () => {
        const [brand, photos] = await Promise.all([this.brand.content(projectId), this.prisma.projectImage.count({ where: { projectId, role: 'photo', status: 'approved', assetId: { not: null } } })]);
        const hasLogo = !!brand?.logoAssetId;
        return { status: hasLogo || photos ? 'ok' : 'empty', message: hasLogo || photos ? null : 'Nothing has been approved for this project yet.', found: { logos: hasLogo ? 1 : 0, photos, colors: 0 } };
      });

      // stage B: the palette (it reads the project's logo, uploads, website and repository styling through the existing analyzer and its 24 h cache)
      await step('palette', async () => {
        let id = collectionId;
        if (!id) {
          const draft = await this.prisma.campaignDesignDraft.findUnique({ where: { projectId } }).catch(() => null);
          id = (draft?.designJson as Obj | null)?.collectionId ?? null;
        }
        if (!id || !getCollection(id)) id = (await this.visual.getDesign(userId, projectId)).defaults.suggestedCollection?.id ?? 'modern_corporate';
        const g = await this.guarded(() => this.visual.suggestPaletteFor(userId, projectId, { collectionId: id! }), PALETTE_MS, signal);
        if (!g.ok) return { status: 'failed', message: g.message };
        paletteSnapshot = { suggestion: g.value.suggestion, analyzedAt: g.value.analyzedAt, collectionId: id };
        const readOk = g.value.suggestion.readings.filter((x) => x.status === 'ok');
        const fromSources = Object.values(g.value.suggestion.evidence).filter((e) => e.source !== 'collection_default').length;
        return { status: readOk.length ? 'ok' : 'empty', message: readOk.length ? `${readOk.map((x) => x.label).join(', ')} read; ${fromSources} of 5 colors come from your sources.` : 'No brand colors could be read from your sources, so the collection defaults are suggested (labelled as defaults).', found: { logos: 0, photos: 0, colors: fromSources } };
      });
    } catch (e) {
      this.logger.warn(`Get Content run failed: ${e instanceof Error ? e.name : 'error'}`);
    }

    // finish: one record of what happened to every source
    for (const s of states) if (s.status === 'pending' || s.status === 'running') s.status = signal.aborted ? 'cancelled' : 'failed';
    const attempted = states.filter((s) => s.status !== 'skipped' && s.status !== 'cancelled');
    const bad = states.filter((s) => ['unavailable', 'blocked', 'failed'].includes(s.status));
    const status = signal.aborted ? 'cancelled' : attempted.length && bad.length === attempted.length ? 'failed' : bad.length ? 'partial' : 'completed';
    const [logoRows, photoRows] = await Promise.all([
      this.prisma.projectImage.count({ where: { projectId, role: 'logo', status: 'candidate' } }),
      this.prisma.projectImage.findMany({ where: { projectId, role: 'photo', status: { in: ['candidate', 'approved'] } }, select: { source: true, status: true, rightsJson: true } }),
    ]);
    const uploads = states.find((s) => s.id === 'uploads')!;
    const summary = {
      uploadsInspected: uploads.status === 'ok' ? await this.prisma.projectAsset.count({ where: { projectId } }) : 0,
      websiteInspected: ['ok', 'empty'].includes(states.find((s) => s.id === 'website')!.status),
      githubInspected: ['ok', 'empty'].includes(states.find((s) => s.id === 'github')!.status),
      imagesFound: photoRows.filter((r) => ['website', 'github', 'upload'].includes(r.source)).length,
      imagesEligibleForApproval: photoRows.filter((r) => r.status === 'candidate' && ['website', 'github'].includes(r.source) && (r.rightsJson as unknown as ImageRights).status !== 'blocked').length,
      logoCandidates: logoRows,
      sourcesUnavailable: bad.map((s) => s.label),
    };
    if (!summary.logoCandidates && !summary.imagesFound && status !== 'cancelled') notes.push('Nothing useful was found. You can continue normally, upload your own logo and pictures, or try again after adding a website or repository address.');
    await this.prisma.getContentRun
      .update({ where: { id: runId }, data: { status, sourcesJson: states as never, summaryJson: summary as never, notesJson: notes.slice(0, 12) as never, paletteJson: (paletteSnapshot ?? undefined) as never, finishedAt: new Date(), expiresAt: status === 'completed' || status === 'partial' ? new Date(Date.now() + DAY_MS) : null } })
      .catch(() => undefined);
    await this.activity.log(userId, 'content.discovered', projectId, { status }).catch(() => undefined);
  }

  // ---- what the screen shows -----------------------------------------------------------------------------------------------------------------------

  private logoView(row: Obj, o: { approvedAssetId: string | null; siteHost: string | null }) {
    const meta = (row.metaJson ?? {}) as Obj;
    const r = row.rightsJson as unknown as ImageRights;
    const e = exportEligibility(r);
    const approved = !!row.assetId && row.assetId === o.approvedAssetId;
    const status = approved ? 'approved' : (row.status as 'candidate' | 'approved' | 'rejected') === 'approved' ? 'candidate' : (row.status as 'candidate' | 'rejected');
    const conf = Number(row.score ?? 0);
    const host = (() => {
      try {
        return row.remoteUrl ? new URL(String(row.remoteUrl)).hostname : null;
      } catch {
        return null;
      }
    })();
    const remoteOk = row.source === 'website' && row.remoteUrl && !!host && !!o.siteHost && isFirstParty(host, o.siteHost) && !meta.favicon;
    const gh = row.source === 'github' && meta.owner && !meta.svg ? `https://raw.githubusercontent.com/${meta.owner}/${meta.repo}/${encodeURIComponent(meta.ref)}/${String(meta.path).split('/').map(encodeURIComponent).join('/')}` : null;
    const preview = row.assetId ? { kind: 'asset' as const, url: `/api/assets/${row.assetId}/file`, note: null } : remoteOk ? { kind: 'remote' as const, url: String(row.remoteUrl), note: 'Shown from your own page; nothing has been downloaded.' } : gh ? { kind: 'remote' as const, url: gh, note: 'Shown from the public repository; nothing has been downloaded.' } : { kind: 'none' as const, url: null, note: meta.svg ? 'An SVG is shown only after you choose it (it is cleaned and converted first).' : 'Shown after you confirm the rights.' };
    const needs = r.status === 'needs_attestation' && !row.assetId ? ('attestation' as const) : null;
    const actions: string[] = [];
    if (status === 'candidate') actions.push('approve');
    if (status !== 'rejected') actions.push('reject');
    else actions.push('restore');
    if (row.pageUrl) actions.push('view_source');
    return {
      id: row.id as string,
      source: row.source as 'upload' | 'website' | 'github',
      title: String(row.title),
      fileName: String(meta.fileName ?? row.title),
      format: String(meta.format ?? 'unknown'),
      svg: meta.svg === true,
      width: (row.width as number | null) ?? null,
      height: (row.height as number | null) ?? null,
      confidence: conf,
      confidenceLabel: conf >= 0.7 ? ('high' as const) : conf >= 0.45 ? ('medium' as const) : ('low' as const),
      signals: ((meta.signals as string[]) ?? []).slice(0, 5),
      favicon: meta.favicon === true,
      preview,
      pageUrl: (row.pageUrl as string | null) ?? null,
      rights: { status: r.status, verification: r.verification, license: r.license, eligible: e.eligible, reason: e.reason },
      needs,
      status,
      note: meta.favicon ? 'A favicon is a small site icon, not a full logo. It is offered only as a last resort.' : null,
      actions,
    };
  }

  private approvedLogoView(brand: Obj | null, asset: Obj | null) {
    if (!brand?.logoAssetId || !asset) return null;
    const r = (brand.logoRightsJson ?? null) as unknown as ImageRights | null;
    return {
      assetId: asset.id as string,
      source: String(brand.logoSource ?? 'upload'),
      title: String(brand.logoFileName ?? asset.originalName),
      format: /svg/i.test(String(asset.originalName)) ? 'svg' : String(asset.mimeType).replace('image/', ''),
      width: (brand.logoWidth as number | null) ?? null,
      height: (brand.logoHeight as number | null) ?? null,
      approvedAt: ((brand.approvedAt as Date | null) ?? (asset.createdAt as Date)).toISOString(),
      previewUrl: `/api/assets/${asset.id}/file`,
      rights: { verification: r?.verification ?? 'user_owned', license: r?.license ?? 'Provided by the user', attestedAt: r?.attestedAt ?? null },
    };
  }

  /** The stored state of Get Content for a project. Cheap: it only reads. */
  async state(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const [run, brand, rows, intake, photos] = await Promise.all([
      this.prisma.getContentRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } }),
      this.brand.content(projectId),
      this.prisma.projectImage.findMany({ where: { projectId, role: 'logo' }, orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }] }),
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.projectImage.findMany({ where: { projectId, role: 'photo', status: 'approved', assetId: { not: null } }, select: { rightsJson: true } }),
    ]);
    const asset = brand?.logoAssetId ? await this.prisma.projectAsset.findFirst({ where: { id: brand.logoAssetId, projectId } }) : null;
    const siteHost = (() => {
      try {
        return intake?.websiteUrl ? new URL(intake.websiteUrl).hostname : null;
      } catch {
        return null;
      }
    })();
    const sourceTier = (s: string) => (s === 'upload' ? 0 : s === 'website' ? 1 : 2);
    const candidates = rows
      .map((r) => this.logoView(r, { approvedAssetId: asset?.id ?? null, siteHost }))
      .sort((a, b) => Number(a.favicon) - Number(b.favicon) || Number(b.status === 'approved') - Number(a.status === 'approved') || (a.confidence < 0.45 ? 1 : 0) - (b.confidence < 0.45 ? 1 : 0) || sourceTier(a.source) - sourceTier(b.source) || b.confidence - a.confidence);
    const approvedPhotos = photos.filter((p) => exportEligibility(p.rightsJson as unknown as ImageRights).eligible).length;
    const pal = (run?.paletteJson ?? null) as Obj | null;
    return {
      projectId,
      run: run ? this.runView(run) : null,
      logo: { approved: this.approvedLogoView(brand, asset), candidates },
      palette: { suggestion: pal?.suggestion ?? null, analyzedAt: pal?.analyzedAt ?? null, collectionId: pal?.collectionId ?? null },
      approved: { logo: !!asset, photos: approvedPhotos, approvedAt: brand?.approvedAt?.toISOString() ?? null },
    };
  }

  // ---- logo decisions -----------------------------------------------------------------------------------------------------------------------------------

  private async logoRow(projectId: string, id: string) {
    const row = await this.prisma.projectImage.findFirst({ where: { id, projectId, role: 'logo' } });
    if (!row) throw new NotFoundException('Logo candidate not found');
    return row;
  }

  /** Turns the fetched bytes into the PNG/JPEG/WebP that is stored: an SVG is sanitized and rasterized first; anything else must really be a picture. */
  private async prepareLogoBytes(got: Extract<FetchedPicture, { ok: true }>, svg: boolean): Promise<{ data: Buffer; mime: string; ext: string; width: number; height: number; note: string | null }> {
    if (got.data.length > MAX_LOGO_BYTES) throw new UnprocessableEntityException({ statusCode: 422, code: 'too_large', message: 'The logo file is larger than 5 MB.' });
    if (svg || /svg/i.test(got.contentType)) {
      const r = await rasterizeSvg(got.data, 1024);
      if (!r.ok) throw new UnprocessableEntityException({ statusCode: 422, code: 'unsupported_svg', message: `This SVG cannot be used: ${r.message}` });
      return { data: r.png, mime: 'image/png', ext: '.png', width: r.width, height: r.height, note: r.removed.length ? `The SVG was cleaned (removed: ${r.removed.join(', ')}) and converted to a PNG.` : 'The SVG was converted to a PNG.' };
    }
    if (!isImageBuffer(got.data)) throw new UnprocessableEntityException({ statusCode: 422, code: 'not_an_image', message: 'The file is not a PNG, JPEG or WebP picture.' });
    const an = await analyzeImage(got.data);
    if (!an) throw new UnprocessableEntityException({ statusCode: 422, code: 'not_an_image', message: 'The logo could not be read.' });
    if (Math.max(an.width, an.height) < MIN_LOGO_SIDE) throw new UnprocessableEntityException({ statusCode: 422, code: 'too_small', message: `The logo is only ${an.width}x${an.height} pixels; it would be unreadable.` });
    const mime = /png/i.test(got.contentType) ? 'image/png' : /webp/i.test(got.contentType) ? 'image/webp' : 'image/jpeg';
    return { data: got.data, mime, ext: mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg', width: an.width, height: an.height, note: null };
  }

  /** The existing logo asset with exactly these bytes (a repeated import is not stored twice), or null. */
  private async sameLogo(projectId: string, sha: string) {
    const assets = await this.prisma.projectAsset.findMany({ where: { projectId, type: 'logo' }, orderBy: { createdAt: 'desc' }, take: 12 });
    for (const a of assets) {
      const data = await readAll(this.storage.read(a.filePath)).catch(() => null);
      if (data && createHash('sha256').update(data).digest('hex') === sha) return a;
    }
    return null;
  }

  async approveLogo(userId: string, projectId: string, candidateId: string, body: { attest?: boolean } = {}) {
    await this.projects.assertOwned(userId, projectId);
    const row = await this.logoRow(projectId, candidateId);
    const meta = (row.metaJson ?? {}) as Obj;
    let rights = row.rightsJson as unknown as ImageRights;
    let assetId = row.assetId;
    let width = row.width;
    let height = row.height;
    let sha: string | null = null;
    let note: string | null = null;

    // an uploaded picture that is not stored as a logo (a picture whose name says "logo"): the logo is a COPY stored as a logo, the original stays what it was
    if (!assetId && row.source === 'upload' && meta.assetId) {
      const src = await this.prisma.projectAsset.findFirst({ where: { id: String(meta.assetId), projectId } });
      if (!src) throw new NotFoundException('The uploaded file no longer exists.');
      if (src.type === 'logo') assetId = src.id;
      else {
        const bytes = await readAll(this.storage.read(src.filePath)).catch(() => null);
        if (!bytes) throw new UnprocessableEntityException({ statusCode: 422, code: 'file_missing', message: 'The uploaded file could not be read.' });
        const prepared = await this.prepareLogoBytes({ ok: true, data: bytes, contentType: src.mimeType }, /svg/i.test(src.mimeType));
        sha = createHash('sha256').update(prepared.data).digest('hex');
        const twin = await this.sameLogo(projectId, sha);
        if (twin) assetId = twin.id;
        else {
          const name = `${src.originalName.replace(/\.[a-z0-9]{2,5}$/i, '')}${prepared.ext}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
          const key = await this.storage.save(projectId, name, prepared.data);
          assetId = (await this.prisma.projectAsset.create({ data: { projectId, type: 'logo', originalName: name, mimeType: prepared.mime, filePath: key, fileSize: prepared.data.length } })).id;
        }
        width = prepared.width;
        height = prepared.height;
        note = 'The picture was copied as your logo; the original picture is unchanged.';
      }
    }

    if (!assetId) {
      if (row.source !== 'website' && row.source !== 'github') throw new BadRequestException('This logo candidate cannot be approved.');
      if (body.attest !== true) throw new UnprocessableEntityException({ statusCode: 422, code: 'attestation_required', message: 'Confirm that you own this logo or hold the rights to use it in advertising. Without that confirmation LaunchPilot does not download or use it.' });
      const svg = meta.svg === true;
      const got: FetchedPicture = row.source === 'website' ? (row.remoteUrl ? await (svg ? this.readers.fetchWebsiteSvg(row.remoteUrl) : this.readers.fetchWebsiteImage(row.remoteUrl)) : { ok: false, message: 'The logo address is missing.' }) : await this.readers.fetchRepositoryImage({ owner: String(meta.owner), repo: String(meta.repo), ref: String(meta.ref), path: String(meta.path) });
      if (!got.ok) throw new UnprocessableEntityException({ statusCode: 422, code: 'download_failed', message: `The logo could not be downloaded (${got.message}).` });
      const prepared = await this.prepareLogoBytes(got, svg);
      sha = createHash('sha256').update(prepared.data).digest('hex');
      rights = attestRights(rights.status === 'needs_attestation' ? rights : candidateRights(row.source as 'website' | 'github'), { at: new Date() });
      const twin = await this.sameLogo(projectId, sha);
      if (twin) {
        assetId = twin.id; // the same logo is already in the project: it is used, not stored twice
        note = 'This logo was already in the project; the existing file is used.';
      } else {
        const name = `${String(meta.fileName ?? row.title).replace(/\.[a-z0-9]{2,5}$/i, '')}${prepared.ext}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
        const key = await this.storage.save(projectId, name, prepared.data);
        const asset = await this.prisma.projectAsset.create({ data: { projectId, type: 'logo', originalName: name, mimeType: prepared.mime, filePath: key, fileSize: prepared.data.length } });
        await this.prisma.imageProvenance.create({ data: { projectId, assetId: asset.id, provider: row.source, providerImageId: row.dedupeKey.slice(0, 200), pageUrl: row.pageUrl ?? row.remoteUrl ?? '', creator: null, creatorUrl: null, license: rights.license, licenseUrl: null, attribution: null, attributionRequired: false, licenseBasis: 'user_attested', sha256: sha, width: prepared.width, height: prepared.height, acquiredById: userId, sourceKind: 'BRAND_LOGO', originalUrl: row.remoteUrl ?? row.pageUrl ?? null, perceptualHash: null, rightsJson: rights as never } });
        assetId = asset.id;
        note = prepared.note;
      }
      width = prepared.width;
      height = prepared.height;
    } else {
      const a = await this.prisma.projectAsset.findFirst({ where: { id: assetId, projectId } });
      if (!a) throw new NotFoundException('The logo file no longer exists.');
      const data = RASTER.test(a.mimeType) ? await readAll(this.storage.read(a.filePath)).catch(() => null) : null;
      if (data) sha = createHash('sha256').update(data).digest('hex');
      rights = rights.verification === 'user_owned' || rights.status === 'cleared' ? rights : uploadRights();
    }
    const asset = await this.prisma.projectAsset.findFirst({ where: { id: assetId!, projectId } });
    await this.brand.setLogo(projectId, userId, { assetId: assetId!, source: row.source, fileName: asset?.originalName ?? row.title, sha256: sha, width, height, rights });
    // exactly one candidate is the approved one
    await this.prisma.projectImage.updateMany({ where: { projectId, role: 'logo', status: 'approved', id: { not: row.id } }, data: { status: 'candidate' } });
    await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', assetId: assetId!, width, height, rightsJson: rights as never, decidedAt: new Date(), metaJson: { ...meta, note } as never } }).catch(async () => {
      // the asset already belongs to another library row (the same file was imported earlier): keep this row a candidate and point to the shared asset's row
      await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'approved', width, height, rightsJson: rights as never, decidedAt: new Date() } });
    });
    await this.activity.log(userId, 'logo.approved', projectId, { source: row.source });
    const state = await this.state(userId, projectId);
    return { approved: state.logo.approved!, note };
  }

  async rejectLogo(userId: string, projectId: string, candidateId: string) {
    await this.projects.assertOwned(userId, projectId);
    const row = await this.logoRow(projectId, candidateId);
    const brand = await this.brand.content(projectId);
    if (brand?.logoAssetId && row.assetId === brand.logoAssetId) await this.prisma.projectBrandContent.update({ where: { projectId }, data: { logoAssetId: null, logoSource: null, logoFileName: null, logoSha256: null, logoWidth: null, logoHeight: null, logoRightsJson: undefined } });
    await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'rejected', decidedAt: new Date() } });
    const state = await this.state(userId, projectId);
    return { candidate: state.logo.candidates.find((c) => c.id === candidateId) ?? null };
  }

  async restoreLogo(userId: string, projectId: string, candidateId: string) {
    await this.projects.assertOwned(userId, projectId);
    const row = await this.logoRow(projectId, candidateId);
    await this.prisma.projectImage.update({ where: { id: row.id }, data: { status: 'candidate', decidedAt: null } });
    const state = await this.state(userId, projectId);
    return { candidate: state.logo.candidates.find((c) => c.id === candidateId) ?? null };
  }

  /** "Upload a different logo": stores the file as the project's logo and approves it at once. */
  async uploadLogo(userId: string, projectId: string, file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined) {
    await this.projects.assertOwned(userId, projectId);
    if (!file?.buffer?.length) throw new BadRequestException('No file was uploaded.');
    if (file.size > MAX_LOGO_BYTES) throw new UnprocessableEntityException({ statusCode: 422, code: 'too_large', message: 'The logo file is larger than 5 MB.' });
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.mimetype)) throw new UnprocessableEntityException({ statusCode: 422, code: 'unsupported_type', message: 'A logo must be a PNG, JPEG, WebP or SVG file.' });
    const prepared = await this.prepareLogoBytes({ ok: true, data: file.buffer, contentType: file.mimetype }, /svg/i.test(file.mimetype));
    const sha = createHash('sha256').update(prepared.data).digest('hex');
    let asset = await this.sameLogo(projectId, sha);
    if (!asset) {
      const name = `${file.originalname.replace(/\.[a-z0-9]{2,5}$/i, '')}${prepared.ext}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const key = await this.storage.save(projectId, name, prepared.data);
      asset = await this.prisma.projectAsset.create({ data: { projectId, type: 'logo', originalName: name, mimeType: prepared.mime, filePath: key, fileSize: prepared.data.length } });
    }
    const rights = uploadRights({ note: 'Uploaded by the project owner as the logo.' });
    await this.brand.setLogo(projectId, userId, { assetId: asset.id, source: 'upload', fileName: asset.originalName, sha256: sha, width: prepared.width, height: prepared.height, rights });
    await this.prisma.projectImage.updateMany({ where: { projectId, role: 'logo', status: 'approved' }, data: { status: 'candidate' } });
    await this.prisma.projectImage.upsert({
      where: { projectId_source_dedupeKey: { projectId, source: 'upload', dedupeKey: `upload:${asset.id}` } },
      create: { projectId, role: 'logo', source: 'upload', status: 'approved', dedupeKey: `upload:${asset.id}`, title: asset.originalName, text: 'you uploaded it as your logo', score: 1, width: prepared.width, height: prepared.height, rightsJson: rights as never, assetId: asset.id, metaJson: { signals: ['you uploaded it as your logo'], favicon: false, svg: false, format: prepared.ext.slice(1), fileName: asset.originalName, note: prepared.note } as never, decidedAt: new Date() },
      update: { status: 'approved', decidedAt: new Date(), width: prepared.width, height: prepared.height },
    }).catch(() => undefined);
    await this.activity.log(userId, 'logo.uploaded', projectId, {});
    const state = await this.state(userId, projectId);
    return { approved: state.logo.approved!, note: prepared.note };
  }
}

export type { LibrarySource, LogoCandidateInfo };
