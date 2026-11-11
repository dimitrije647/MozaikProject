import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { TEMPLATE_LIBRARY, extractPalette, isImageBuffer, isNoAi, mergeHybrid, type BrandImage, type HybridReference, type HybridSettings } from '@launchpilot/agents';
import { ImageLibraryService } from '../visual/image-library.service';
import { PrismaService } from '../common/prisma.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll } from './campaign-assets';

/** Brand images and references are read from the project's own storage only; these bounds keep one campaign from loading unbounded data. */
export const MAX_BRAND_IMAGES = 6;
export const MAX_REFERENCE_IMAGES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RASTER = /^image\/(png|jpe?g|webp)$/i;
const SLOT_KEY = /^K\d{1,2}-T\d{1,3}$/;
/** The link of ONE pin a user chose to remember. It is never fetched: it is only kept so the user can open it again. */
export const PIN_URL = /^https:\/\/(?:[a-z]{2,3}\.|www\.)?pinterest\.[a-z.]{2,6}\/pin\/\d{1,30}\/?(?:\?[^\s#]*)?$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,60}$/;

export interface HybridInputs {
  /** The settings with references normalized (permissions decided by the server, invalid items dropped). */
  hybrid: HybridSettings;
  brandImages: BrandImage[];
  /** Number of brand images available (also when the bytes were not loaded). */
  brandImageCount: number;
  /** Palettes read from reference images the USER uploaded to this project. Links and Pinterest never appear here. */
  referencePalettes: Record<string, string[]>;
  warnings: string[];
}

/**
 * Everything the Hybrid preset reads from the project, behind the project's tenant boundary: brand images and uploaded reference images
 * come only from this project's own assets; links are validated and kept as text, never fetched; Pinterest items are link-only.
 */
@Injectable()
export class HybridInputsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageDriver,
    private library: ImageLibraryService,
  ) {}

  async prepare(projectId: string, raw: HybridSettings | Record<string, unknown> | null | undefined, withData: boolean): Promise<HybridInputs> {
    const warnings: string[] = [];
    let hybrid: HybridSettings;
    // the client sends only an id, a kind and maybe a link: the label and the permission are decided here, never taken from the request
    const input = { ...((raw ?? {}) as Record<string, unknown>) };
    if (Array.isArray(input.references)) {
      input.references = (input.references as Record<string, unknown>[]).map((r) => ({ id: String(r.id ?? '').slice(0, 60), kind: r.kind, label: typeof r.label === 'string' ? r.label : '', url: typeof r.url === 'string' ? r.url : null, permission: typeof r.permission === 'string' ? r.permission : 'link_only_not_analyzed' }));
    }
    try {
      hybrid = mergeHybrid(input);
    } catch (e) {
      throw new UnprocessableEntityException(e instanceof Error ? e.message : 'Hybrid settings are not valid.');
    }
    this.checkOverrides(hybrid);

    const assets = await this.prisma.projectAsset.findMany({ where: { projectId, type: { in: ['image', 'reference'] }, mimeType: { startsWith: 'image/' } }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, mimeType: true, filePath: true, fileSize: true } });
    const usable = (a: { mimeType: string; fileSize: number }) => RASTER.test(a.mimeType) && a.fileSize > 0 && a.fileSize <= MAX_IMAGE_BYTES;
    // a picture the owner REJECTED (in the image gallery or in Get Content) is not used as a brand picture
    const rejected = new Set((await this.prisma.projectImage.findMany({ where: { projectId, status: 'rejected', assetId: { not: null } }, select: { assetId: true } }).catch(() => [])).map((r) => r.assetId));
    const brandRows = assets.filter((a) => a.type === 'image' && usable(a) && !rejected.has(a.id)).slice(0, MAX_BRAND_IMAGES);
    const refRows = new Map(assets.filter((a) => a.type === 'reference' && usable(a)).map((a) => [a.id, a]));

    // references: the server decides what each kind may do; the permission sent by the client is not trusted
    const references: HybridReference[] = [];
    const palettes: Record<string, string[]> = {};
    const seen = new Set<string>();
    let n = 0;
    for (const r of hybrid.references) {
      if (r.kind === 'user_upload') {
        const row = refRows.get(r.id);
        if (!row || seen.has(r.id) || references.filter((x) => x.kind === 'user_upload').length >= MAX_REFERENCE_IMAGES) {
          warnings.push(`The reference image "${r.label || r.id}" is not an uploaded reference image of this project, so it was ignored.`);
          continue;
        }
        seen.add(r.id);
        references.push({ id: row.id, kind: 'user_upload', label: row.originalName.slice(0, 120), url: null, permission: 'owned_by_user' });
        if (withData) {
          const buf = await readAll(this.storage.read(row.filePath)).catch(() => null);
          const colors = buf && isImageBuffer(buf) ? await extractPalette(buf, 5) : [];
          if (colors.length) palettes[row.id] = colors;
          else warnings.push(`No colors could be read from the reference image "${row.originalName}".`);
        }
      } else if (r.kind === 'user_link') {
        if (!r.url || !/^https?:\/\//i.test(r.url)) {
          warnings.push('A reference link without a valid http(s) address was ignored.');
          continue;
        }
        let host = 'link';
        try {
          host = new URL(r.url).hostname.replace(/^www\./, '').slice(0, 60);
        } catch {
          warnings.push('A reference link that is not a valid address was ignored.');
          continue;
        }
        references.push({ id: `link-${++n}`, kind: 'user_link', label: `Link: ${host}`, url: r.url.slice(0, 300), permission: 'link_only_not_analyzed' });
      } else if (r.kind === 'pinterest_board') {
        if (!r.url || !PIN_URL.test(r.url)) {
          warnings.push('A Pinterest reference must be the link of a pin (https://www.pinterest.com/pin/<number>/); it was ignored.');
          continue;
        }
        references.push({ id: `pin-${++n}`, kind: 'pinterest_board', label: 'Pinterest pin (link only)', url: r.url.slice(0, 300), permission: 'platform_restricted_not_stored' });
      } else if (!SAFE_ID.test(r.id)) {
        continue; // brand assets and the style library are added by the server itself, never by the client
      }
    }
    hybrid = { ...hybrid, references };

    // NO AI HYBRID: the pictures are the project's image LIBRARY (approved and rights-cleared only), not every image that was ever uploaded
    if (isNoAi(hybrid)) {
      const lib = await this.library.loadApproved(projectId, { withData });
      for (const s of lib.skipped.slice(0, 4)) warnings.push(`A picture is not used: ${s}`);
      return { hybrid, brandImages: lib.images, brandImageCount: lib.count, referencePalettes: palettes, warnings };
    }
    let brandImages: BrandImage[] = [];
    if (withData) {
      for (const a of brandRows) {
        const data = await readAll(this.storage.read(a.filePath)).catch(() => null);
        if (data && isImageBuffer(data)) brandImages.push({ id: a.id, name: a.originalName.slice(0, 120), data });
      }
    } else brandImages = [];
    return { hybrid, brandImages, brandImageCount: brandRows.length, referencePalettes: palettes, warnings };
  }

  /** Overrides are validated before anything runs: the slot must look like a slot and the template must exist in the library. */
  private checkOverrides(h: HybridSettings) {
    const entries = Object.entries(h.overrides);
    if (entries.length > 60) throw new UnprocessableEntityException('Too many template choices (at most 60).');
    const ids = new Set(TEMPLATE_LIBRARY.filter((t) => t.status === 'active').map((t) => t.id));
    for (const [slot, id] of entries) {
      if (!SLOT_KEY.test(slot)) throw new UnprocessableEntityException(`"${slot.slice(0, 40)}" is not a creative slot (expected a name like K1-T2).`);
      if (typeof id !== 'string' || !ids.has(id)) throw new UnprocessableEntityException(`The template "${String(id).slice(0, 60)}" chosen for ${slot} does not exist in the template library.`);
    }
  }
}
