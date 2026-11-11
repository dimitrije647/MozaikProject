import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  COLLECTIONS_VERSION,
  CREATIVE_FORMATS,
  DocumentExtractionTool,
  FORMAT_OPTIONS,
  FORMAT_OPTION_KEYS,
  GitHubRepositoryTool,
  TEMPLATE_LIBRARY,
  WebFetchTool,
  acquireLicensedImage,
  analyzeImage,
  applyDetectedPalette,
  checkDesignFit,
  checkPalette,
  collectionTemplates,
  coverageOf,
  creditsText,
  designAnchors,
  designBrandColors,
  designFormatIds,
  discoverImages,
  fontsOf,
  formatClassOfId,
  formatIdsOf,
  formatKeysFromProject,
  getCollection,
  getStyle,
  isImageBuffer,
  isNearDuplicate,
  listCollections,
  newDesign,
  paletteFit,
  parseDesign,
  placeholderImage,
  planImageSources,
  stockRights,
  readGuidelinesBrand,
  readImagesBrand,
  readLogoBrand,
  readRepositoryBrand,
  readWebsiteBrand,
  renderTemplatePreview,
  suggestPalette,
  switchCollection,
  themedTemplate,
  type BrandImage,
  type BrandReading,
  type CampaignDesign,
  type CollectionId,
  type DesignPalette,
  type DiscoveryResult,
  type HybridSettings,
  type ImageCandidate,
  type ImageSearchAdapter,
  type ImageAcquirePort,
  type IntentContext,
  type PaletteRole,
  type TemplateCollection,
  type TemplateDef,
  type VisualDiscoveryPort,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll } from '../mozaik/campaign-assets';
import { ProjectBrandService } from './project-brand.service';

export const IMAGE_ADAPTERS = Symbol('IMAGE_ADAPTERS');
/** Test seam: how the website and the repository are read. Production uses the real, SSRF-guarded readers. */
export const BRAND_READERS = Symbol('BRAND_READERS');
/** Test seam: how a licensed picture is downloaded. */
export const IMAGE_DOWNLOADER = Symbol('IMAGE_DOWNLOADER');

export interface BrandReaders {
  website(url: string): Promise<BrandReading>;
  repository(url: string): Promise<BrandReading>;
}

export const defaultBrandReaders = (): BrandReaders => ({
  website: (url) => readWebsiteBrand(url),
  repository: (url) => readRepositoryBrand(url, { token: process.env.GITHUB_TOKEN }),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HEX = /^[0-9a-fA-F]{6}$/;
const MAX_LICENSED_PER_PROJECT = 12;
const MAX_PREVIEW_ASSET_BYTES = 8 * 1024 * 1024;

type Obj = Record<string, any>;

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

/** What the gallery and the design step show about a collection: data only, never executable content. */
export function collectionView(c: TemplateCollection, library: readonly TemplateDef[] = TEMPLATE_LIBRARY) {
  const cov = coverageOf(c, library);
  const templates = collectionTemplates(c, library);
  return {
    id: c.id,
    number: c.number,
    name: c.name,
    tagline: c.tagline,
    description: c.description,
    designCategory: c.designCategory,
    styleId: c.styleId,
    industries: c.industrySuitability,
    audiences: c.audienceSuitability,
    version: c.version,
    templates: templates.map((t) => ({ id: t.id, name: t.name, version: t.version, classes: t.classes, requires: t.requires, family: t.family, roles: Object.entries(c.roles).filter(([, ids]) => ids.includes(t.id)).map(([r]) => r) })),
    roles: c.roles,
    supportedClasses: cov.classes,
    supportedFormats: cov.formats.map((id) => ({ id, label: CREATIVE_FORMATS[id].label })),
    coverage: { story: cov.has.story, feed: cov.has.feed, banner: cov.has.banner },
    typographySystem: c.typographySystem,
    layoutPrinciples: c.layoutPrinciples,
    imageTreatment: c.imageTreatment,
    decorativeSystem: c.decorativeSystem,
    fonts: fontsOf(c.tokens),
    tokens: { corner: c.tokens.shape.cardRadius, button: c.tokens.shape.buttonRadius, mask: c.tokens.image.mask, patterns: c.tokens.decor.patterns === 'hide' ? 'none' : c.tokens.decor.patterns === 'keep' ? 'keep' : c.tokens.decor.patterns.kind },
    defaultPalette: c.defaultPalette,
    paletteRules: c.recommendedPaletteRules,
    previews: c.previewAssets,
  };
}

@Injectable()
export class VisualService {
  private readonly previews = new Lru<Buffer>(240);
  private readonly assetBytes = new Lru<Buffer>(24);

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private storage: StorageDriver,
    private activity: ActivityLogService,
    @Inject(IMAGE_ADAPTERS) private adapters: ImageSearchAdapter[],
    @Inject(BRAND_READERS) private readers: BrandReaders,
    @Inject(IMAGE_DOWNLOADER) private downloader: () => Pick<WebFetchTool, 'fetchAsset'>,
    private brand: ProjectBrandService,
  ) {}

  // ---- the collections (global, read-only) ---------------------------------------------------------------------------------------------------

  listCollections() {
    return { version: COLLECTIONS_VERSION, formatOptions: FORMAT_OPTION_KEYS.map((k) => ({ key: k, label: FORMAT_OPTIONS[k].label, formatIds: FORMAT_OPTIONS[k].formatIds })), items: listCollections().map((c) => collectionView(c)) };
  }

  getCollection(id: string) {
    const c = getCollection(id);
    if (!c || !c.enabled) throw new NotFoundException('Template collection not found');
    return collectionView(c);
  }

  private palette(q: Obj): DesignPalette | null {
    const keys = ['p', 's', 'a', 'b', 't'] as const;
    if (keys.every((k) => q[k] === undefined)) return null;
    if (keys.some((k) => typeof q[k] !== 'string' || !HEX.test(q[k]))) throw new BadRequestException('Colors must be six hex digits without #: p (primary), s (secondary), a (accent), b (background), t (text).');
    return { primary: `#${q.p}`, secondary: `#${q.s}`, accent: `#${q.a}`, background: `#${q.b}`, text: `#${q.t}` };
  }

  /**
   * A PNG of one template of a collection drawn by the REAL renderer with the collection's tokens and a palette. Free: no OpenAI request.
   * With `projectId` the project's own logo and first brand picture are used (labelled illustrative placeholders otherwise).
   */
  async previewPng(userId: string | null, projectId: string | null, collectionId: string, q: Obj): Promise<Buffer> {
    const c = getCollection(collectionId);
    if (!c || !c.enabled) throw new NotFoundException('Template collection not found');
    const templateId = typeof q.template === 'string' ? q.template : c.previewAssets[0].templateId;
    const t = themedTemplate(c, templateId);
    if (!t) throw new NotFoundException('That template is not part of this collection');
    const cls = (typeof q.class === 'string' ? q.class : t.classes[0]) as TemplateDef['classes'][number];
    if (!t.classes.includes(cls)) throw new BadRequestException(`This template is not designed for ${cls} formats (it supports ${t.classes.join(', ')}).`);
    const palette = this.palette(q) ?? c.defaultPalette;
    const withImage = q.image !== '0';
    let logo: Buffer | null = null;
    let hero: Buffer | undefined;
    let brandName: string | undefined;
    let sourceKey = 'placeholder';
    if (projectId && userId) {
      const project = await this.projects.assertOwned(userId, projectId);
      brandName = project.name.slice(0, 30);
      const [logoRow, imgRow] = await Promise.all([
        this.brand.logoAsset(projectId),
        q.picture === 'project' && withImage ? this.prisma.projectAsset.findFirst({ where: { projectId, type: 'image', mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] }, fileSize: { lte: MAX_PREVIEW_ASSET_BYTES } }, orderBy: { createdAt: 'desc' } }) : null,
      ]);
      if (logoRow) logo = await this.bytes(logoRow.id, logoRow.filePath);
      if (imgRow) hero = (await this.bytes(imgRow.id, imgRow.filePath)) ?? undefined;
      sourceKey = `${project.id}|${logoRow?.id ?? '-'}|${imgRow?.id ?? '-'}|${brandName}`;
    }
    const key = `${c.id}@${c.version}|${t.id}@${t.version}|${cls}|${Object.values(palette).join(',')}|${withImage ? 1 : 0}|${sourceKey}`;
    const hit = this.previews.get(key);
    if (hit) return hit;
    const a = designAnchors(palette);
    const r = await renderTemplatePreview({ template: t, class: cls, palette: designBrandColors(palette), anchors: { ink: a.ink, paper: a.paper }, withImage, hero, logo, content: brandName ? { brand: brandName } : undefined });
    if (!r.ok) throw new BadRequestException(r.message);
    this.previews.set(key, r.png);
    return r.png;
  }

  private async bytes(id: string, filePath: string): Promise<Buffer | null> {
    const hit = this.assetBytes.get(id);
    if (hit) return hit;
    const buf = await readAll(this.storage.read(filePath)).catch(() => null);
    if (buf && isImageBuffer(buf)) {
      this.assetBytes.set(id, buf);
      return buf;
    }
    return null;
  }

  // ---- the design draft (one per project) -------------------------------------------------------------------------------------------------------

  private async tables<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2021') throw new ServiceUnavailableException('The visual design tables are not in the database yet. Run "pnpm db:deploy" in the project folder and try again.');
      throw e;
    }
  }

  /** Normalizes and checks a design: palette readability, fit of the palette to the collection and fit of the formats to the collection. */
  evaluate(design: CampaignDesign, o: { hasPicture?: boolean; facts?: HybridSettings['facts']; templateCreatives?: number } = {}) {
    const c = getCollection(design.collectionId)!;
    const check = checkPalette(design.palette, c.recommendedPaletteRules.minTextContrast);
    const fit = paletteFit(design.collectionId, design.palette);
    const formats = design.formats.length ? checkDesignFit({ collectionId: design.collectionId, formatKeys: design.formats, hasPicture: o.hasPicture ?? true, facts: (o.facts ?? {}) as Record<string, string | undefined>, templateCreatives: o.templateCreatives ?? 15 }) : null;
    return { check, paletteFit: fit, formats, canConfirm: check.ok && (formats?.ok ?? true) };
  }

  async getDesign(userId: string, projectId: string) {
    const project = await this.projects.assertOwned(userId, projectId);
    const [intake, formats, draft, analysis, licensed] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.campaignFormatPreference.findMany({ where: { projectId, enabled: true } }),
      this.tables(() => this.prisma.campaignDesignDraft.findUnique({ where: { projectId } })),
      this.tables(() => this.prisma.brandPaletteAnalysis.findFirst({ where: { projectId, expiresAt: { gt: new Date() } }, orderBy: { analyzedAt: 'desc' } })),
      this.tables(() => this.prisma.imageProvenance.count({ where: { projectId } })),
    ]);
    const parsed = draft ? parseDesign(draft.designJson) : null;
    const suggested = this.suggestCollection(project.name, intake);
    return {
      projectId,
      draft: parsed?.ok ? parsed.design : null,
      draftProblem: parsed && !parsed.ok ? parsed.message : null,
      updatedAt: draft?.updatedAt ?? null,
      defaults: {
        formats: formatKeysFromProject(formats.map((f) => f.formatType)),
        /** An older project may carry a style word. It is a hint for the first suggestion and nothing else: no form shows it as a choice. */
        legacyStylePreference: intake?.stylePreference ?? null,
        suggestedCollection: suggested,
      },
      analysis: analysis ? { analyzedAt: analysis.analyzedAt, expiresAt: analysis.expiresAt } : null,
      licensedImages: licensed,
    };
  }

  /** A first suggestion, deterministic: the style matcher of the library over what the project says. The user decides. */
  private suggestCollection(name: string, intake: Obj | null): { id: CollectionId; reasons: string[] } | null {
    const text = `${name} ${intake?.shortDescription ?? ''} ${intake?.targetAudience ?? ''} ${intake?.marketingGoal ?? ''} ${intake?.stylePreference ?? ''}`.toLowerCase();
    const scored = listCollections().map((c) => {
      const hits = [...c.industrySuitability, ...c.audienceSuitability.flatMap((a) => a.toLowerCase().split(/\s+/).filter((w) => w.length > 5))].filter((k) => text.includes(k.toLowerCase()));
      const legacy = ({ minimal: 'minimal_tech', bold: 'bold_startup', cinematic: 'dynamic_events', playful: 'soft_organic', warm: 'lifestyle_human', corporate: 'modern_corporate' } as Record<string, string>)[String(intake?.stylePreference ?? '')] === c.id ? 1 : 0;
      return { c, score: hits.length * 2 + legacy, reasons: [...hits.slice(0, 3).map((h) => `your text mentions "${h}"`), ...(legacy ? ['it matches the style you noted when the project was created'] : [])] };
    });
    const best = scored.sort((a, b) => b.score - a.score || a.c.number - b.c.number)[0];
    return best && best.score > 0 ? { id: best.c.id, reasons: best.reasons } : null;
  }

  async saveDesign(userId: string, projectId: string, raw: unknown) {
    await this.projects.assertOwned(userId, projectId);
    const parsed = parseDesign(raw);
    if (!parsed.ok) throw new UnprocessableEntityException(parsed.message);
    let design = parsed.design;
    const c = getCollection(design.collectionId)!;
    // a design that was made with an older version of its collection keeps that version until the user re-confirms it
    if (design.collectionVersion > c.version) design = { ...design, collectionVersion: c.version };
    const ev = this.evaluate(design);
    // confirming an unreadable or unsupported design is refused: the user edits first
    if (design.confirmed && !ev.canConfirm) {
      const why = [...ev.check.errors, ...(ev.formats?.messages.filter(() => !ev.formats?.ok) ?? [])].join(' ');
      throw new UnprocessableEntityException(`The design cannot be confirmed yet: ${why}`);
    }
    if (design.confirmed && !design.confirmedAt) design = { ...design, confirmedAt: new Date().toISOString() };
    if (!design.confirmed) design = { ...design, confirmedAt: null };
    await this.tables(() => this.prisma.campaignDesignDraft.upsert({ where: { projectId }, create: { projectId, userId, designJson: design as never }, update: { designJson: design as never, userId } }));
    return { design, ...ev };
  }

  /** Another collection for a design: edited and brand colors stay, only colors that were mere defaults follow the new collection. Not saved until PUT. */
  async switchDesign(userId: string, projectId: string, body: { design?: unknown; collectionId?: string }) {
    await this.projects.assertOwned(userId, projectId);
    const parsed = parseDesign(body?.design);
    if (!parsed.ok) throw new UnprocessableEntityException(parsed.message);
    const c = getCollection(String(body?.collectionId ?? ''));
    if (!c || !c.enabled) throw new NotFoundException('Template collection not found');
    const sw = switchCollection(parsed.design, c.id);
    return { design: sw.design, notes: sw.notes, ...this.evaluate(sw.design) };
  }

  async clearDesign(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    await this.tables(() => this.prisma.campaignDesignDraft.deleteMany({ where: { projectId } }));
    return { ok: true };
  }

  // ---- the brand palette analysis (cached) --------------------------------------------------------------------------------------------------------

  private fingerprint(o: Obj): string {
    return createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);
  }

  /**
   * Suggests a palette for a collection from what the project points to. The READINGS of the sources are cached for 24 hours per project and
   * input fingerprint, so changing the collection or editing colors never fetches a site again; only `refresh` (or changed inputs) does.
   */
  async suggestPaletteFor(userId: string, projectId: string, o: { collectionId: string; refresh?: boolean; explicit?: unknown }) {
    const project = await this.projects.assertOwned(userId, projectId);
    const c = getCollection(o.collectionId);
    if (!c || !c.enabled) throw new NotFoundException('Template collection not found');
    const [intake, assets, draftRow] = await Promise.all([
      this.prisma.productIntake.findUnique({ where: { projectId } }),
      this.prisma.projectAsset.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, mimeType: true, filePath: true, fileSize: true } }),
      this.tables(() => this.prisma.campaignDesignDraft.findUnique({ where: { projectId } })),
    ]);
    const fp = this.fingerprint({ w: intake?.websiteUrl ?? null, g: intake?.githubUrl ?? null, a: assets.filter((x) => ['logo', 'image', 'pdf', 'doc', 'other', 'reference'].includes(x.type)).map((x) => [x.id, x.fileSize]) });
    let readings: BrandReading[] | null = null;
    let analyzedAt = new Date();
    let cached = false;
    if (!o.refresh) {
      const hit = await this.tables(() => this.prisma.brandPaletteAnalysis.findFirst({ where: { projectId, fingerprint: fp, expiresAt: { gt: new Date() } }, orderBy: { analyzedAt: 'desc' } }));
      if (hit) {
        readings = (hit.resultJson as unknown as { readings: BrandReading[] }).readings;
        analyzedAt = hit.analyzedAt;
        cached = true;
      }
    }
    if (!readings) {
      readings = await this.readSources(project.id, intake, assets);
      analyzedAt = new Date();
      await this.tables(() => this.prisma.brandPaletteAnalysis.create({ data: { projectId, fingerprint: fp, resultJson: { readings } as never, analyzedAt, expiresAt: new Date(analyzedAt.getTime() + DAY_MS) } }));
    }
    // the colors the user edited by hand are explicit evidence of the highest tier. The caller sends the edits it holds RIGHT NOW (the saved draft may lag
    // a few moments behind the screen, and a color the user just reset must not come back); without that, the saved draft is used.
    const explicit: Partial<Record<PaletteRole, string>> = {};
    if (o.explicit !== undefined && o.explicit !== null && typeof o.explicit === 'object') {
      for (const r of ['primary', 'secondary', 'accent', 'background', 'text'] as const) {
        const v = (o.explicit as Record<string, unknown>)[r];
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) explicit[r] = v.toLowerCase();
      }
    } else {
      const draft = draftRow ? parseDesign(draftRow.designJson) : null;
      if (draft?.ok) for (const r of draft.design.overridden) explicit[r] = draft.design.palette[r];
    }
    const suggestion = suggestPalette({ collectionId: c.id, readings, explicit });
    return { suggestion, analyzedAt, cached, sources: { website: intake?.websiteUrl ?? null, repository: intake?.githubUrl ?? null } };
  }

  private async readSources(projectId: string, intake: Obj | null, assets: Obj[]): Promise<BrandReading[]> {
    const load = async (a: Obj) => readAll(this.storage.read(a.filePath)).catch(() => null);
    const raster = (a: Obj) => /^image\/(png|jpe?g|webp|gif)$/i.test(a.mimeType) && a.fileSize > 0 && a.fileSize <= MAX_PREVIEW_ASSET_BYTES;
    // the approved logo (Get Content) wins; without one this is the newest uploaded logo, as it always was
    const approvedLogo = await this.brand.logoAsset(projectId);
    const logoRow = (approvedLogo && assets.find((a) => a.id === approvedLogo.id && raster(a))) || assets.find((a) => a.type === 'logo' && raster(a));
    const imageRows = assets.filter((a) => (a.type === 'image' || a.type === 'reference') && raster(a)).slice(0, 4);
    const docRows = assets.filter((a) => ['pdf', 'doc', 'other'].includes(a.type) && !/^image\//.test(a.mimeType)).slice(0, 3);
    const guarded = async (label: string, source: BrandReading['source'], fn: () => Promise<BrandReading>): Promise<BrandReading> => {
      try {
        return await Promise.race([fn(), new Promise<BrandReading>((r) => setTimeout(() => r({ source, label, status: 'unavailable', message: 'The source did not answer in time.', candidates: [] }), 25_000))]);
      } catch {
        return { source, label, status: 'failed', message: 'The source could not be read.', candidates: [] };
      }
    };
    const none = (source: BrandReading['source'], label: string, message: string): BrandReading => ({ source, label, status: 'unavailable', message, candidates: [] });
    const [website, repository, logo, images, guidelines] = await Promise.all([
      intake?.websiteUrl ? guarded('Website', 'website', () => this.readers.website(intake.websiteUrl)) : none('website', 'Website', 'No website address was given for this project.'),
      intake?.githubUrl ? guarded('Repository', 'repository', () => this.readers.repository(intake.githubUrl)) : none('repository', 'Repository', 'No repository was given for this project.'),
      guarded('Logo', 'logo', async () => readLogoBrand(logoRow ? await load(logoRow) : null)),
      guarded('Uploaded images', 'uploaded_image', async () => readImagesBrand((await Promise.all(imageRows.map(async (a) => ({ name: a.originalName as string, data: await load(a) })))).filter((x): x is { name: string; data: Buffer } => !!x.data))),
      guarded('Brand documents', 'brand_guidelines', async () => {
        const docs = await new DocumentExtractionTool().extractAll(docRows.map((a) => ({ name: a.originalName, mimeType: a.mimeType, size: a.fileSize, load: async () => (await load(a)) ?? Buffer.alloc(0) })));
        return readGuidelinesBrand(docs.filter((d) => d.status === 'extracted').map((d) => ({ name: d.name, text: d.text })));
      }),
    ]);
    return [guidelines, logo, website, repository, images];
  }

  /** The design with the newest analysis applied: roles the user edited stay. Used by "re-analyze". */
  applyAnalysis(design: CampaignDesign, suggestion: { palette: DesignPalette; evidence: CampaignDesign['paletteEvidence'] }) {
    return applyDetectedPalette(design, suggestion);
  }

  // ---- web visual discovery and licensed pictures ----------------------------------------------------------------------------------------------------

  get providersConfigured(): boolean {
    return this.adapters.some((a) => a.configured);
  }

  private async intentContext(userId: string, projectId: string): Promise<IntentContext> {
    const project = await this.projects.assertOwned(userId, projectId);
    const [intake, draftRow] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.tables(() => this.prisma.campaignDesignDraft.findUnique({ where: { projectId } }))]);
    const d = draftRow ? parseDesign(draftRow.designJson) : null;
    const col = d?.ok ? getCollection(d.design.collectionId) : null;
    const style = col ? getStyle(col.styleId) : null;
    const classes = d?.ok ? [...new Set(formatIdsOf(d.design.formats).map(formatClassOfId).filter((x): x is NonNullable<typeof x> => !!x))] : [];
    return { business: intake?.productName ?? project.name, offering: intake?.shortDescription ?? project.description ?? '', audience: intake?.targetAudience ?? '', imageSubjects: style?.photography.subjects ?? [], mood: style ? [style.name.split(' ')[0].toLowerCase()] : [], formatClasses: classes };
  }

  async discover(userId: string, projectId: string, o: { refresh?: boolean } = {}) {
    const ctx = await this.intentContext(userId, projectId);
    const key = this.fingerprint({ ctx, providers: this.adapters.filter((a) => a.configured).map((a) => a.id) });
    if (!o.refresh) {
      const hit = await this.tables(() => this.prisma.visualDiscoveryRun.findFirst({ where: { projectId, queryKey: key, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }));
      if (hit) {
        const r = hit.resultJson as unknown as DiscoveryResult;
        return { ...r, references: [], cached: true, notes: [...r.notes, 'Reference links are never stored: search again to see them.'] };
      }
    }
    const result = await discoverImages(ctx, this.adapters);
    // Only licensed candidates (and the search itself) are kept for 24 hours, as the picture providers require. Reference results are never stored.
    if (result.providers.some((p) => p.status === 'ok')) await this.tables(() => this.prisma.visualDiscoveryRun.create({ data: { projectId, userId, queryKey: key, resultJson: { ...result, references: [] } as never, expiresAt: new Date(Date.now() + DAY_MS) } }));
    return { ...result, cached: false };
  }

  /**
   * The port the Visual Researcher uses inside a run: configured providers only; null when none is configured (no discovery is claimed).
   * `includePaid: false` (NO AI HYBRID unless the user approved paid search) leaves out providers that bill per request.
   */
  discoveryPort(o: { includePaid?: boolean } = {}): VisualDiscoveryPort | null {
    if (!this.providersConfigured) return null;
    return (ctx, signal) => discoverImages(ctx, this.adapters, { signal, includePaid: o.includePaid !== false });
  }

  /**
   * NO AI HYBRID, automatic stock mode: how the Visual Researcher adds ONE licensed picture during a run. The picture goes through the same single
   * gate as a manual choice (acquire: reference-only, blocked and unconfirmed licenses refused; official provider hosts only; guarded download;
   * size check) and is stored with its provenance. `reviewConfirmed` is never set here: a license that needs a human check is not added automatically.
   */
  acquirePort(userId: string, projectId: string): ImageAcquirePort {
    return async (candidate) => {
      try {
        const done = await this.importCandidate(userId, projectId, candidate, { reviewConfirmed: false, userApproved: true });
        const image: BrandImage = { id: done.asset.id, name: done.asset.originalName, data: done.data, library: { rights: stockRights(candidate.license, { userApproved: true }), analysis: done.analysis, text: `${candidate.title} ${candidate.tags.join(' ')}`.slice(0, 500), width: done.analysis?.width ?? candidate.width, height: done.analysis?.height ?? candidate.height, pageUrl: candidate.pageUrl, via: 'auto_stock' } };
        return { ok: true as const, image };
      } catch (e) {
        const message = e instanceof UnprocessableEntityException ? String(((e.getResponse() as { message?: unknown }).message ?? e.message)).slice(0, 200) : 'The picture could not be added.';
        return { ok: false as const, message };
      }
    };
  }

  /** Downloads, stores and records ONE licensed candidate (provenance + library row). Shared by the manual choice and automatic stock mode. */
  private async importCandidate(userId: string, projectId: string, candidate: ImageCandidate, o: { reviewConfirmed: boolean; userApproved: boolean }) {
    const count = await this.tables(() => this.prisma.imageProvenance.count({ where: { projectId, sourceKind: 'LICENSED_STOCK' } }));
    if (count >= MAX_LICENSED_PER_PROJECT) throw new UnprocessableEntityException(`A project can hold at most ${MAX_LICENSED_PER_PROJECT} licensed pictures.`);
    if ((await this.tables(() => this.prisma.imageProvenance.findFirst({ where: { projectId, provider: candidate.provider, providerImageId: candidate.id } })))) throw new UnprocessableEntityException('That picture is already in the project.');
    const got = await acquireLicensedImage(candidate, { web: this.downloader(), reviewConfirmed: o.reviewConfirmed });
    if (!got.ok) throw new UnprocessableEntityException({ statusCode: 422, message: got.message, code: got.code });
    const analysis = await analyzeImage(got.data);
    // a picture that is a near-copy of one already in the library is not added again
    if (analysis) {
      const rows = await this.prisma.projectImage.findMany({ where: { projectId, status: 'approved', assetId: { not: null } }, select: { title: true, analysisJson: true } });
      const twin = rows.find((r) => typeof (r.analysisJson as Obj | null)?.phash === 'string' && isNearDuplicate((r.analysisJson as Obj).phash, analysis.phash));
      if (twin) throw new UnprocessableEntityException({ statusCode: 422, code: 'duplicate', message: `This picture is nearly identical to "${twin.title}", which is already in the library, so it was not added again.` });
    }
    const ext = got.mimeType.includes('png') ? '.png' : got.mimeType.includes('webp') ? '.webp' : '.jpg';
    const name = `${candidate.provider}-${candidate.id}${ext}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const key = await this.storage.save(projectId, name, got.data);
    const p = got.provenance;
    const rights = stockRights(candidate.license, { userApproved: o.userApproved, reviewConfirmed: o.reviewConfirmed });
    const asset = await this.prisma.projectAsset.create({ data: { projectId, type: 'image', originalName: name, mimeType: got.mimeType, filePath: key, fileSize: got.data.length } });
    const row = await this.prisma.imageProvenance.create({
      data: { projectId, assetId: asset.id, provider: p.provider, providerImageId: p.providerImageId, pageUrl: p.pageUrl, creator: p.creator, creatorUrl: p.creatorUrl, license: p.license, licenseUrl: p.licenseUrl, attribution: p.attribution, attributionRequired: p.attributionRequired, licenseBasis: p.licenseBasis, sha256: p.sha256, width: p.width, height: p.height, acquiredById: userId, sourceKind: 'LICENSED_STOCK', originalUrl: candidate.pageUrl, perceptualHash: analysis?.phash ?? null, rightsJson: rights as never },
    });
    await this.prisma.projectImage
      .upsert({
        where: { projectId_source_dedupeKey: { projectId, source: 'stock', dedupeKey: `${candidate.provider}:${candidate.id}` } },
        create: { projectId, source: 'stock', status: 'approved', dedupeKey: `${candidate.provider}:${candidate.id}`, title: candidate.title.slice(0, 160), pageUrl: candidate.pageUrl, remoteUrl: null, creator: candidate.creator, width: p.width, height: p.height, text: `${candidate.title} ${candidate.tags.join(' ')}`.slice(0, 500), rightsJson: rights as never, analysisJson: (analysis ?? undefined) as never, assetId: asset.id, decidedAt: new Date() },
        update: { status: 'approved', assetId: asset.id, rightsJson: rights as never, analysisJson: (analysis ?? undefined) as never, decidedAt: new Date() },
      })
      .catch(() => undefined);
    await this.activity.log(userId, 'asset.licensed_added', projectId, { provider: p.provider, license: p.license });
    return { asset, row, provenance: p, data: got.data, analysis };
  }

  /** Adds ONE licensed candidate of the latest search to the project. The candidate is looked up by its id in the stored search: the client cannot supply a download address. */
  async addLicensedImage(userId: string, projectId: string, body: { provider: string; id: string; reviewConfirmed?: boolean }) {
    await this.projects.assertOwned(userId, projectId);
    const runs = await this.tables(() => this.prisma.visualDiscoveryRun.findMany({ where: { projectId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 5 }));
    let candidate: ImageCandidate | undefined;
    for (const r of runs) {
      candidate = (r.resultJson as unknown as DiscoveryResult).licensed.find((c) => c.provider === body.provider && c.id === body.id);
      if (candidate) break;
    }
    if (!candidate) throw new NotFoundException('That picture is not in your latest search (searches are kept for 24 hours). Search again.');
    const done = await this.importCandidate(userId, projectId, candidate, { reviewConfirmed: body.reviewConfirmed === true, userApproved: true });
    return { asset: done.asset, provenance: done.row, credit: creditsText([done.provenance]) };
  }

  async listLicensedImages(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    const rows = await this.tables(() => this.prisma.imageProvenance.findMany({ where: { projectId }, orderBy: { acquiredAt: 'desc' } }));
    return { items: rows, credits: creditsText(rows.map((r) => ({ provider: r.provider, attribution: r.attribution, pageUrl: r.pageUrl, license: r.license, attributionRequired: r.attributionRequired }))) };
  }

  // ---- the free check the factory plan shows ---------------------------------------------------------------------------------------------------------

  /**
   * Everything about the approved design that can be checked for free before spending: it must be confirmed, readable and able to produce the
   * chosen formats, and the planner reports where the pictures come from. null when the campaign has no design (it was configured before collections).
   */
  async preflight(projectId: string, hs: HybridSettings, o: { imageOn: boolean; concepts: number; brandImageCount: number; imageUsd: number | null }) {
    const design = hs.design;
    if (!design) return null;
    const c = getCollection(design.collectionId);
    const blockers: { code: 'design_unconfirmed' | 'design_palette' | 'design_formats' | 'design_collection'; message: string }[] = [];
    const warnings: string[] = [];
    if (!c || !c.enabled) {
      return { design, collection: null, blockers: [{ code: 'design_collection' as const, message: `The template collection "${design.collectionId}" is not available. Choose another one.` }], warnings, palette: null, formats: null, sources: null, notes: [] };
    }
    const [licensed, candidates] = await Promise.all([
      this.tables(() => this.prisma.imageProvenance.count({ where: { projectId } })).catch(() => 0),
      this.tables(() => this.prisma.visualDiscoveryRun.findFirst({ where: { projectId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })).catch(() => null),
    ]);
    const hasPicture = (o.imageOn && hs.originals > 0) || o.brandImageCount > 0;
    const ev = this.evaluate(design, { hasPicture, facts: hs.facts, templateCreatives: hs.templateCreatives });
    if (!design.confirmed) blockers.push({ code: 'design_unconfirmed', message: 'Confirm the campaign design (template collection, palette and formats) before starting: it decides how every creative looks.' });
    if (!ev.check.ok) blockers.push({ code: 'design_palette', message: `The palette is not readable: ${ev.check.errors.join(' ')}` });
    if (ev.formats && !ev.formats.ok) blockers.push({ code: 'design_formats', message: `${ev.formats.messages.join(' ')} ${ev.formats.options.plan.join(' ')}${ev.formats.options.collections.length ? ` Collections that support every chosen format: ${ev.formats.options.collections.map((x) => x.name).join(', ')}.` : ''}`.trim() });
    warnings.push(...ev.check.warnings, ...ev.paletteFit.notes.filter((n) => !ev.check.errors.includes(n)), ...(ev.formats?.ok ? ev.formats.messages : []));
    const defaults = PALETTE_DEFAULT_ROLES.filter((r) => design.paletteEvidence[r]?.source === 'collection_default');
    if (defaults.length === 5) warnings.push(`No brand colors were detected or chosen: the ${c.name} default palette is used. Review it before you start.`);
    const sources = planImageSources({ mode: design.imageSourcing, originalsRequested: hs.originals, imageModelOn: o.imageOn, concepts: o.concepts, userImages: Math.max(0, o.brandImageCount - licensed), licensedImages: licensed, licensedCandidates: ((candidates?.resultJson as unknown as DiscoveryResult | undefined)?.licensed ?? []).length, imageUsd: o.imageUsd });
    warnings.push(...sources.warnings);
    return {
      design,
      collection: { id: c.id, name: c.name, version: c.version, latestVersion: c.version, styleId: c.styleId },
      palette: { palette: design.palette, evidence: design.paletteEvidence, overridden: design.overridden, check: ev.check, fit: ev.paletteFit },
      formats: { keys: design.formats, ids: designFormatIds({ design }) ?? [], labels: design.formats.map((k) => FORMAT_OPTIONS[k].label), fit: ev.formats },
      sources,
      blockers,
      warnings,
      notes: [`${c.name}: every template creative is chosen from this collection and drawn with your approved palette; no agent switches to another collection.`],
    };
  }

  /** The default format keys of the design for a new draft (the project's stored defaults). */
  async newDraft(userId: string, projectId: string, collectionId: string) {
    const c = getCollection(collectionId);
    if (!c || !c.enabled) throw new NotFoundException('Template collection not found');
    const d = await this.getDesign(userId, projectId);
    return newDesign(c.id, { formats: d.defaults.formats });
  }
}

const PALETTE_DEFAULT_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
