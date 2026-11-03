import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FORMAT_CLASSES,
  LIBRARY_VERSION,
  allocateImages,
  isNoAi,
  keywordsOf,
  rankImages,
  uploadRights,
  STYLE_IDS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIBRARY,
  availableFor,
  templateBlockers,
  buildF1Context,
  buildF3Context,
  buildVisualBrief,
  derivePalette,
  designAnchors,
  designBrandColors,
  directionFor,
  forecastContent,
  getCollection,
  getStyle,
  industryTextOf,
  isStyleId,
  listStyles,
  matchStyles,
  placeholderImage,
  renderContent,
  renderTemplate,
  renderTemplatePreview,
  selectTemplates,
  themedTemplates,
  thumbnailJpeg,
  visualDirectionSummary,
  type CreativeInput,
  type FormatClass,
  type StyleId,
  type TemplateDef,
  type TemplateSlot,
  type ChannelId,
} from '@launchpilot/agents';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll } from './campaign-assets';
import { StartFactoryDto } from './dto/factory.dto';
import { FactoryService } from './factory.service';
import { HybridInputsService } from './hybrid-support';
import { ProjectBrandService } from '../visual/project-brand.service';

type Obj = Record<string, any>;

const HEX = /^#[0-9a-fA-F]{6}$/;
const THUMB_WIDTH = 420;

/** What the gallery shows about a template: its declarative definition's metadata, never executable content. */
export function templateCard(t: TemplateDef) {
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    status: t.status,
    category: t.category,
    description: t.description,
    styles: t.styles,
    industries: t.industries,
    channels: t.channels,
    classes: t.classes,
    requires: t.requires,
    density: t.density,
    family: t.family,
    composition: t.composition,
    tone: t.tone,
    sample: t.sample,
    layerCount: t.layers.length,
  };
}

/** Small in-memory LRU for rendered previews (they are pure functions of their parameters). */
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

@Injectable()
export class HybridService {
  private readonly cache = new Lru<Buffer>(160);

  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private storage: StorageDriver,
    private factory: FactoryService,
    private hybridInputs: HybridInputsService,
    private brandSvc: ProjectBrandService,
  ) {}

  // ---- the template library and the style library (global, read-only data) --------------------------------------------------

  listTemplates(q: { category?: string; style?: string; industry?: string; channel?: string; class?: string; q?: string } = {}) {
    const text = (q.q ?? '').toLowerCase().trim();
    const industry = (q.industry ?? '').toLowerCase().trim();
    const items = TEMPLATE_LIBRARY.filter((t) => t.status !== 'draft')
      .filter((t) => !q.category || t.category === q.category)
      .filter((t) => !q.style || t.styles.includes(q.style as StyleId))
      .filter((t) => !industry || t.industries.includes('*') || t.industries.some((i) => i.includes(industry) || industry.includes(i)))
      .filter((t) => !q.channel || t.channels.length === 0 || t.channels.includes(q.channel as ChannelId))
      .filter((t) => !q.class || t.classes.includes(q.class as FormatClass))
      .filter((t) => !text || `${t.name} ${t.description} ${t.composition} ${t.industries.join(' ')}`.toLowerCase().includes(text));
    return { version: LIBRARY_VERSION, total: TEMPLATE_LIBRARY.length, categories: TEMPLATE_CATEGORIES, styles: STYLE_IDS, classes: FORMAT_CLASSES, items: items.map(templateCard) };
  }

  getTemplate(id: string) {
    const t = TEMPLATE_LIBRARY.find((x) => x.id === id);
    if (!t) throw new NotFoundException('Template not found');
    return { ...templateCard(t), layers: t.layers };
  }

  listStyles() {
    return { items: listStyles() };
  }

  /** A PNG preview rendered from the template's own definition (the same renderer as the campaign). Parameters are validated and bounded. */
  async templatePreviewPng(id: string, q: { class?: string; palette?: string; style?: string; image?: string }): Promise<Buffer> {
    const t = TEMPLATE_LIBRARY.find((x) => x.id === id && x.status !== 'draft');
    if (!t) throw new NotFoundException('Template not found');
    const cls = (q.class ?? t.classes[0]) as FormatClass;
    if (!FORMAT_CLASSES.includes(cls) || !t.classes.includes(cls)) throw new BadRequestException(`This template is not designed for ${q.class} formats (it supports ${t.classes.join(', ')}).`);
    const palette = (q.palette ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    if (palette.length > 4 || palette.some((c) => !HEX.test(c))) throw new BadRequestException('palette must be up to 4 hex colors like #3157d5, separated by commas.');
    if (q.style && !isStyleId(q.style)) throw new BadRequestException('Unknown style.');
    const withImage = q.image !== '0';
    const key = `${t.id}@${t.version}|${cls}|${palette.join(',')}|${q.style ?? ''}|${withImage ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = await renderTemplatePreview({ template: t, class: cls, palette: palette.length ? palette : undefined, styleId: q.style as StyleId | undefined, withImage });
    if (!r.ok) throw new BadRequestException(r.message);
    this.cache.set(key, r.png);
    return r.png;
  }

  // ---- the FREE preview: no request to OpenAI or to Pinterest ---------------------------------------------------------------

  /**
   * What a Hybrid Production run would plan, with real local renders of the chosen templates. Uses the strategy that already exists (if any),
   * the local style library, the project's own brand assets and placeholder pictures; the cost estimate comes from the price book.
   * Nothing is sent to OpenAI (not even the model list) and nothing is stored.
   */
  async preview(userId: string, projectId: string, dto: StartFactoryDto = {}) {
    const project = await this.projects.assertOwned(userId, projectId);
    // the preview shows what the creative round WOULD be, also for a project that already has a campaign for its strategy
    const pre = await this.factory.preflight(userId, projectId, { ...dto, preset: dto.preset === 'no_ai_hybrid' ? 'no_ai_hybrid' : 'hybrid_production', rerunCreative: true }, { offline: true });
    const hy = pre.hybrid;
    if (!hy) throw new BadRequestException('The Hybrid preview needs the hybrid_production or no_ai_hybrid preset.');
    const settings = pre.settings;
    const hybrid = settings.hybrid!;
    const inputs = await this.hybridInputs.prepare(projectId, hybrid, true);

    // the project's own logo and palette (local files only)
    const [intake, logoAsset] = await Promise.all([this.prisma.productIntake.findUnique({ where: { projectId } }), this.brandSvc.logoAsset(projectId)]);
    const brandCtx = await this.brandSvc.brandContext(projectId, logoAsset?.id ?? null);
    const logo = logoAsset ? await readAll(this.storage.read(logoAsset.filePath)).catch(() => null) : null;

    // the strategy chain the preview would build on, if one exists
    const [f1Row, f3Row] = await Promise.all([
      pre.chain.f1ReportId ? this.prisma.productDiscoveryReport.findFirst({ where: { id: pre.chain.f1ReportId, projectId, project: { userId } } }) : null,
      pre.chain.f3StrategyId ? this.prisma.marketingStrategyReport.findFirst({ where: { id: pre.chain.f3StrategyId, projectId, project: { userId } } }) : null,
    ]);
    const f1 = f1Row ? buildF1Context(f1Row) : null;
    const f3 = f3Row ? buildF3Context(f3Row) : null;
    // the approved campaign design decides the collection (the only templates offered), the palette and the neutral surfaces
    const design = hybrid.design;
    const collection = design ? (getCollection(design.collectionId) ?? null) : null;
    const lib: readonly TemplateDef[] = collection ? themedTemplates(collection) : TEMPLATE_LIBRARY;
    const derived = await derivePalette(f1?.palette ?? [], logo);
    const palette = design ? designBrandColors(design.palette) : derived.palette;
    const fromBrand = design ? true : derived.fromBrand;
    const anchors = design ? designAnchors(design.palette) : null;
    const channels = hy.slots.length ? ([...new Set(hy.slots.map((s: TemplateSlot) => s.channel))] as ChannelId[]) : (['instagram'] as ChannelId[]);
    const input: CreativeInput = { projectName: intake?.productName ?? project.name, language: f3?.report.language ?? intake?.preferredLanguage ?? 'en', websiteUrl: intake?.websiteUrl ?? null, channels, concepts: settings.f4.concepts, landing: settings.f4.landing };
    const visualBrief =
      f1 && f3
        ? buildVisualBrief(f1, f3, input, palette)
        : {
            business: input.projectName,
            offering: intake?.shortDescription ?? '',
            valueProposition: '',
            campaignGoal: intake?.marketingGoal ?? '',
            audience: { primary: intake?.targetAudience ?? '', secondary: [], segments: [] },
            brand: { tone: intake?.stylePreference ?? '', visualDirection: intake?.stylePreference ?? '', constraints: [], palette, observed: [] },
            locale: { geography: intake?.targetMarket ? [intake.targetMarket] : [], language: input.language },
            channels: channels.map((c) => ({ channel: c, role: '', formats: [] })),
            avoid: [],
          };
    const direction = directionFor({ visualBrief, projectName: input.projectName, channels, palette, hasBrandPalette: fromBrand, settings: hybrid, referencePalettes: inputs.referencePalettes });

    // the template choice for the forecast slots (sample content: no copy exists before the run)
    // NO AI HYBRID: the approved library pictures are ranked and allocated exactly as the run does it (free, local, deterministic)
    const noAi = isNoAi(hybrid);
    const allocation = noAi
      ? allocateImages({
          concepts: Array.from({ length: settings.f4.concepts }, (_, i) => ({ id: `K${i + 1}`, words: [] as string[] })),
          slots: hy.slots.map((s: TemplateSlot) => ({ slotId: s.slotId, conceptId: s.conceptId, index: s.index, formatClass: s.formatClass })),
          images: rankImages(
            inputs.brandImages.map((b) => ({ id: b.id, text: b.library?.text ?? b.name, width: b.library?.analysis?.width ?? null, height: b.library?.analysis?.height ?? null, source: b.library?.rights.source ?? ('upload' as const), rights: b.library?.rights ?? uploadRights(), analysis: b.library?.analysis ?? null })),
            { businessWords: keywordsOf({ business: intake?.productName ?? project.name, offering: intake?.shortDescription ?? '' }, 8), collectionId: collection?.id ?? null, palette },
            { stage: 'selection' },
          ).ranked.map((r) => ({ id: r.id, score: r.score, text: r.subject.text, width: r.subject.width, height: r.subject.height, analysis: r.subject.analysis })),
          maxPerConcept: hybrid.imagery.maxSourcesPerConcept,
        })
      : null;
    const allocOf = new Map((allocation?.slots ?? []).map((a) => [a.slotId, a]));
    const slots: TemplateSlot[] = hy.slots.map((s: TemplateSlot) => {
      const a = allocOf.get(s.slotId);
      if (noAi) return { ...s, variationId: null, source: a?.imageId ? ('brand_image' as const) : ('none' as const), imageId: a?.imageId ?? null, secondaryImageId: a?.secondaryImageId ?? null, focus: a?.focus ?? null };
      return { ...s, source: s.variationId ? ('ai_original' as const) : inputs.brandImageCount ? ('brand_image' as const) : ('none' as const) };
    });
    const contents = new Map(slots.map((s) => [s.slotId, forecastContent(s)]));
    const ctx = { direction, industryText: industryTextOf(visualBrief), objectiveText: visualBrief.campaignGoal, palette, hasLogo: !!logo, brandImageCount: inputs.brandImageCount, brandName: input.projectName, facts: hybrid.facts, library: lib, design, collection, preferred: [...hybrid.preferredTemplates, ...(design?.preferredTemplates ?? [])], overrides: hybrid.overrides, mode: hybrid.selection, basis: 'forecast' as const };
    const sel = selectTemplates({ slots, contents, ctx });

    // real renders (sample text, placeholder or brand picture), reduced to thumbnails
    const byId = new Map(lib.map((t) => [t.id, t]));
    const brandHero = inputs.brandImages[0]?.data;
    const thumbs = new Map<string, { url: string | null; placeholder: boolean; flags: string[]; error: string | null }>();
    const queue = [...sel.plan.items];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const tpl = byId.get(it.templateId);
        if (!tpl) continue;
        try {
          const picked = noAi && it.imageId ? inputs.brandImages.find((b) => b.id === it.imageId)?.data : undefined;
          const usesBrand = noAi ? !!picked : it.sourceKind === 'brand_image' && !!brandHero;
          const hero = usesBrand ? (noAi ? picked : brandHero) : noAi ? undefined : tpl.requires.includes('image') || tpl.layers.some((l) => l.type === 'image') ? await placeholderImage(it.width, it.height, palette, `${it.slotId}`) : undefined;
          const secondary = tpl.layers.some((l) => l.type === 'image' && l.slot === 'secondary') ? await placeholderImage(it.width, it.height, palette, `${it.slotId}-2`) : undefined;
          const res = await renderTemplate({ template: tpl, width: it.width, height: it.height, content: renderContent({ headline: tpl.sample.headline, support: tpl.sample.support ?? null, cta: tpl.sample.cta ?? null, eyebrow: tpl.sample.eyebrow ?? null, variantId: null }, input.projectName, hybrid.facts), palette, styleId: direction.styleId, anchors: anchors ?? undefined, brandName: input.projectName, images: { hero, secondary: noAi ? undefined : secondary }, logo, ...(brandCtx?.logo ? { logoAdapt: true } : {}), ...(noAi && it.focus ? { heroFocus: it.focus as [number, number] } : {}) });
          if (!res.ok) thumbs.set(it.slotId, { url: null, placeholder: false, flags: [], error: res.message });
          else {
            const jpg = await thumbnailJpeg(res.png, THUMB_WIDTH);
            thumbs.set(it.slotId, { url: jpg ? `data:image/jpeg;base64,${jpg.toString('base64')}` : null, placeholder: !usesBrand && !!hero, flags: res.flags, error: jpg ? null : 'The preview could not be reduced.' });
          }
        } catch (e) {
          thumbs.set(it.slotId, { url: null, placeholder: false, flags: [], error: e instanceof Error ? e.message.slice(0, 140) : 'The preview could not be rendered.' });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    // what the user would need to add for more templates to become available
    const probe: TemplateSlot = { slotId: 'probe', conceptId: 'probe', conceptName: '', index: 1, channel: 'instagram', formatId: 'instagram_square', width: 1080, height: 1080, formatClass: 'square', variationId: 'x', source: 'ai_original' };
    const have = availableFor(probe, { headline: 'x', support: 'x', cta: 'x', eyebrow: 'x', variantId: null }, ctx);
    const missing: Record<string, number> = {};
    for (const t of lib.filter((x) => x.status === 'active')) {
      const b = templateBlockers(t, { ...probe, formatClass: t.classes[0] }, have).filter((x) => x.startsWith('needs '));
      for (const need of b) missing[need.slice(6)] = (missing[need.slice(6)] ?? 0) + 1;
    }
    const items = sel.plan.items.map((it) => ({ ...it, thumbnail: thumbs.get(it.slotId) ?? null }));
    const count = (key: (i: (typeof items)[number]) => string) => items.reduce<Record<string, number>>((m, i) => ({ ...m, [key(i)]: (m[key(i)] ?? 0) + 1 }), {});
    return {
      ...pre,
      free: true,
      noOpenAIRequests: true,
      sampleNote: noAi ? 'NO AI HYBRID preview: the pictures are your approved pictures (nothing is generated, nothing is sent to OpenAI); a creative with no picture is text-first. The text on the previews is each template\'s own sample text, not your campaign copy.' : 'Pictures marked "placeholder" stand in for the original AI images, which are generated only when you start the campaign. The text on the previews is each template\'s own sample text, not your campaign copy.',
      visualDirection: { brief: direction, summary: visualDirectionSummary(direction), style: getStyle(direction.styleId), alternatives: matchStyles({ industry: visualBrief.business, text: `${visualBrief.offering} ${visualBrief.valueProposition}`, audience: visualBrief.audience.primary, tone: visualBrief.brand.tone, objective: visualBrief.campaignGoal, channels }).slice(0, 4).map((m) => ({ id: m.style.id, name: m.style.name, score: m.score, reasons: m.reasons.slice(0, 3) })) },
      selection: { ...sel.plan, items },
      distribution: { byCategory: sel.plan.byCategory, byTemplate: sel.plan.byTemplate, byChannel: count((i) => i.channel), byFormat: count((i) => i.format) },
      requirements: {
        logo: logo ? 'found' : 'missing: the brand name is drawn in the logo position',
        brandPalette: fromBrand ? 'measured from your brand' : 'missing: a neutral palette is used',
        brandImages: inputs.brandImageCount,
        strategy: f3 ? 'found: the preview uses your real strategy and brand' : 'not found yet: the preview uses your project details; the full campaign runs the research first',
        unlockableByFacts: missing,
        factsHint: Object.keys(missing).length ? 'Some templates need details only you can provide (an offer, a date, a quote...). Add them in the Hybrid settings to make those templates available; nothing is invented.' : null,
      },
      library: { version: LIBRARY_VERSION, templates: lib.filter((t) => t.status === 'active').length, eligible: sel.plan.eligibleCount, collection: collection ? { id: collection.id, name: collection.name, version: collection.version } : null },
      brand: { palette, fromBrand, logo: !!logo, logoApproved: !!brandCtx?.logo, approvedPhotos: brandCtx?.approvedPhotos ?? 0, projectName: input.projectName },
      ...(noAi && allocation ? { imageAllocation: { approved: inputs.brandImageCount, perConcept: allocation.perConcept, warnings: allocation.warnings } } : {}),
    };
  }
}
