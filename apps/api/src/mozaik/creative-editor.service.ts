import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CampaignPackage,
  CreativeRenderSpec,
  applyCreativeRevision,
  creativeOf,
  editDiagnostics,
  editorFields,
  exportEligibility,
  renderEdit,
  restoreOriginalRevision,
  sha256Of,
  validateEdits,
  type EditInputs,
  type EditResult,
  type FieldError,
  type ImageRights,
} from '@launchpilot/agents';
import { PrismaService } from '../common/prisma.service';
import { StorageDriver } from '../storage/storage.service';
import { readAll, toAssetRecord } from './campaign-assets';

/** Why an older creative cannot be edited (shown as it is). */
export const NOT_EDITABLE_OLD = 'This creative was generated before editing support and cannot be safely edited.';

const SLOT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
/** at most this many renders run at once on the server (all users), and one per user (a newer preview replaces a waiting one) */
const MAX_PARALLEL = 2;
/** previews per user per minute */
const RATE = 60;
const CACHE_BYTES = 96 * 1024 * 1024;

type Pkg = CampaignPackage;
type Ready = { spec: CreativeRenderSpec; inputs: EditInputs };

/**
 * THE CREATIVE EDITOR on the server: project-scoped (only the owner's campaign, only a creative of that campaign), deterministic and local (the
 * agents' renderer; no model, no image generation). A preview returns the real PNG the save stores; a save writes the new file first, then the
 * new asset row, the superseded old one and the campaign package in ONE transaction guarded by the package's update time (a stale edit is
 * refused, never merged); a failed save removes its file and leaves the previous version intact. The original file is never touched.
 * (The package is stored as parsed, without the generic redaction pass: it holds no credential, and that pass truncates deeply nested records.)
 */
@Injectable()
export class CreativeEditorService {
  private readonly buffers = new Map<string, Buffer>();
  private cached = 0;
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly latest = new Map<string, number>();
  private readonly perUser = new Map<string, Promise<unknown>>();
  private readonly rate = new Map<string, number[]>();

  constructor(
    private prisma: PrismaService,
    private storage: StorageDriver,
  ) {}

  // ---- reading -----------------------------------------------------------------------------------------------------------------------------

  private async owned(userId: string, campaignId: string, slotId: string) {
    if (!SLOT_ID.test(slotId)) throw new NotFoundException('Creative not found');
    // 404 for other users' campaigns so ids cannot be probed
    const row = await this.prisma.creativeCampaign.findFirst({ where: { id: campaignId, project: { userId } } });
    if (!row) throw new NotFoundException('Campaign not found');
    if (!row.packageJson) throw new ConflictException('The campaign is not finished yet');
    const parsed = CampaignPackage.safeParse(row.packageJson);
    if (!parsed.success) throw new UnprocessableEntityException('The stored campaign package could not be read');
    const tc = creativeOf(parsed.data, slotId);
    if (!tc?.assetId) throw new NotFoundException('Creative not found');
    const asset = await this.prisma.campaignAsset.findFirst({ where: { id: tc.assetId, campaignId } });
    if (!asset) throw new NotFoundException('Creative not found');
    return { row, pkg: parsed.data, tc, asset };
  }

  /** The stored specification and its pictures and logo, verified (same files, still approved); null + reason when it cannot be edited safely. */
  private async ready(projectId: string, metadata: unknown): Promise<Ready | { reason: string }> {
    const raw = (metadata as { renderSpec?: unknown } | null)?.renderSpec;
    const parsed = raw ? CreativeRenderSpec.safeParse(raw) : null;
    if (!parsed?.success) return { reason: NOT_EDITABLE_OLD };
    const spec = parsed.data;
    const picture = async (ref: { id: string; sha256: string } | null): Promise<Buffer | null | string> => {
      if (!ref) return null;
      const img = await this.prisma.projectImage.findFirst({ where: { projectId, assetId: ref.id }, include: { asset: true } });
      if (!img?.asset || img.status !== 'approved' || !exportEligibility(img.rightsJson as unknown as ImageRights).eligible) return 'A picture of this creative is no longer approved in the image library, so it cannot be rendered again.';
      const data = await this.file(`img:${ref.id}`, img.asset.filePath);
      if (!data || sha256Of(data) !== ref.sha256) return 'A picture of this creative has changed since it was generated, so it cannot be rendered again exactly.';
      return data;
    };
    const hero = await picture(spec.hero);
    if (typeof hero === 'string') return { reason: hero };
    const secondary = await picture(spec.secondary);
    if (typeof secondary === 'string') return { reason: secondary };
    let logo: Buffer | null = null;
    if (spec.logo) {
      const logos = await this.prisma.projectAsset.findMany({ where: { projectId, type: 'logo' }, orderBy: { createdAt: 'desc' }, take: 20 });
      for (const l of logos) {
        const data = await this.file(`logo:${l.id}`, l.filePath);
        if (data && sha256Of(data) === spec.logo.sha256) {
          logo = data;
          break;
        }
      }
      if (!logo) return { reason: 'The logo this creative was generated with is no longer in the project, so it cannot be rendered again exactly.' };
    }
    return { spec, inputs: { hero, secondary, logo } };
  }

  /** Project files, read once and kept (bounded): the same Buffer is reused, so the picture analysis is cached too. */
  private async file(key: string, filePath: string): Promise<Buffer | null> {
    const hit = this.buffers.get(`${key}|${filePath}`);
    if (hit) return hit;
    const data = await readAll(this.storage.read(filePath)).catch(() => null);
    if (!data) return null;
    while (this.cached + data.length > CACHE_BYTES && this.buffers.size) {
      const [k, v] = this.buffers.entries().next().value as [string, Buffer];
      this.buffers.delete(k);
      this.cached -= v.length;
    }
    this.buffers.set(`${key}|${filePath}`, data);
    this.cached += data.length;
    return data;
  }

  private view(campaignId: string, pkg: Pkg, tc: NonNullable<ReturnType<typeof creativeOf>>, asset: { id: string; width: number; height: number; version: number }, ready: Ready | { reason: string }) {
    const item = pkg.deliverables?.items.find((i) => i.id === tc.slotId);
    const editable = 'spec' in ready;
    const current = editable ? ready.spec.content : {};
    return {
      campaignId,
      slotId: tc.slotId,
      label: item?.label ?? tc.format,
      channel: tc.channel,
      format: tc.format,
      width: asset.width,
      height: asset.height,
      assetId: asset.id,
      imageUrl: `/campaigns/${campaignId}/assets/${asset.id}/file`,
      version: asset.version,
      design: tc.design?.status ?? null,
      quality: item?.quality ?? null,
      publishReady: item?.publishReady ?? null,
      blockers: item?.blockers ?? [],
      warnings: (tc.design?.checks ?? []).filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => ({ id: c.id, status: c.status, detail: c.detail })).slice(0, 12),
      edit: tc.edit ? { revision: tc.edit.revision, state: tc.edit.state, originalAssetId: tc.edit.originalAssetId, editedAt: tc.edit.editedAt } : null,
      editable,
      reason: editable ? null : ready.reason,
      fields: editable ? editorFields(ready.spec, current) : [],
    };
  }

  async state(userId: string, campaignId: string, slotId: string) {
    const { row, pkg, tc, asset } = await this.owned(userId, campaignId, slotId);
    return this.view(campaignId, pkg, tc, asset, await this.ready(row.projectId, asset.metadataJson));
  }

  // ---- rendering (bounded) -----------------------------------------------------------------------------------------------------------------

  private limit(userId: string) {
    const now = Date.now();
    const hits = (this.rate.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= RATE) throw new HttpException('Too many previews: wait a moment.', HttpStatus.TOO_MANY_REQUESTS);
    hits.push(now);
    this.rate.set(userId, hits);
  }

  /** One render per user at a time; a preview that is no longer the newest when its turn comes is skipped; at most MAX_PARALLEL overall. */
  private async exclusive<T>(userId: string, preview: boolean, work: () => Promise<T>): Promise<T> {
    const ticket = (this.latest.get(userId) ?? 0) + 1;
    this.latest.set(userId, ticket);
    const prev = this.perUser.get(userId) ?? Promise.resolve();
    const mine = prev.catch(() => undefined).then(async () => {
      if (preview && this.latest.get(userId) !== ticket) throw new ConflictException({ message: 'A newer preview replaced this one.', code: 'superseded' });
      while (this.running >= MAX_PARALLEL) await new Promise<void>((r) => this.waiters.push(r));
      this.running++;
      try {
        return await work();
      } finally {
        this.running--;
        this.waiters.shift()?.();
      }
    });
    this.perUser.set(userId, mine);
    void mine.finally(() => {
      if (this.perUser.get(userId) === mine) this.perUser.delete(userId);
    }).catch(() => undefined);
    return mine;
  }

  private async rendered(userId: string, campaignId: string, slotId: string, body: { fields?: unknown; baseAssetId?: string }, preview: boolean) {
    const ctx = await this.owned(userId, campaignId, slotId);
    if (body.baseAssetId !== ctx.tc.assetId) throw new ConflictException({ message: 'This creative was changed in the meantime. Reload it before editing.', code: 'stale' });
    const ready = await this.ready(ctx.row.projectId, ctx.asset.metadataJson);
    if (!('spec' in ready)) throw new UnprocessableEntityException({ message: ready.reason, code: 'not_editable' });
    const v = validateEdits(ready.spec, body.fields);
    if (!v.ok) throw new UnprocessableEntityException({ message: 'Check the highlighted fields.', code: 'invalid', errors: v.errors });
    this.limit(userId);
    const result = await this.exclusive(userId, preview, () => renderEdit(ready.spec, v.values, ready.inputs));
    if (!result.ok) throw new UnprocessableEntityException({ message: result.errors[0]?.message ?? 'The new text does not fit this design.', code: 'does_not_fit', errors: result.errors satisfies FieldError[] });
    return { ...ctx, ready, values: v.values, result };
  }

  /** The real PNG of the edited text (not saved) and what the checks say about it. */
  async preview(userId: string, campaignId: string, slotId: string, body: { fields?: unknown; baseAssetId?: string }) {
    const { result } = await this.rendered(userId, campaignId, slotId, body, true);
    return { png: result.png, meta: summary(result) };
  }

  /** Saves the edited text: the new file, a new asset version, the old one superseded and the package, atomically. */
  async save(userId: string, campaignId: string, slotId: string, body: { fields?: unknown; baseAssetId?: string }) {
    const { row, tc, asset, ready, values, result } = await this.rendered(userId, campaignId, slotId, body, false);
    const key = await this.storage.save(row.projectId, `layout-${tc.conceptId}.png`, result.png);
    try {
      const fields = Object.fromEntries(editorFields(result.spec).map((f) => [f.id, values[f.id] ?? f.value]));
      await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.creativeCampaign.findUnique({ where: { id: campaignId } });
        const pkg = fresh?.packageJson ? CampaignPackage.safeParse(fresh.packageJson) : null;
        const cur = pkg?.success ? creativeOf(pkg.data, slotId) : null;
        if (!fresh || !pkg?.success || !cur || cur.assetId !== asset.id) throw new ConflictException({ message: 'This creative was changed in the meantime. Reload it before editing.', code: 'stale' });
        const oldMeta = (asset.metadataJson ?? {}) as Record<string, unknown>;
        const created = await tx.campaignAsset.create({
          data: {
            campaignId,
            projectId: row.projectId,
            kind: asset.kind,
            conceptId: asset.conceptId,
            channel: asset.channel,
            format: asset.format,
            version: asset.version + 1,
            parentAssetId: asset.id,
            mimeType: 'image/png',
            width: result.width,
            height: result.height,
            bytes: result.png.length,
            sha256: result.sha256,
            source: asset.source,
            model: null,
            quality: null,
            requestedSize: null,
            status: 'rendered',
            filePath: key,
            altText: (fields.headline ?? asset.altText ?? '').slice(0, 200),
            metadataJson: { ...oldMeta, flags: [...result.flags, 'edited_by_owner'], renderSpec: result.spec, edit: { by: 'owner', revision: (cur.edit?.revision ?? 0) + 1 } } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.campaignAsset.update({ where: { id: asset.id }, data: { status: 'superseded' } });
        const next = applyCreativeRevision(pkg.data, { slotId, previousAssetId: asset.id, asset: toAssetRecord(created), design: editDiagnostics(result, cur.edit?.originalDesign ?? cur.design), flags: result.flags, fields, original: ready.spec.original, at: new Date().toISOString() });
        const upd = await tx.creativeCampaign.updateMany({ where: { id: campaignId, updatedAt: fresh.updatedAt }, data: { packageJson: next as unknown as Prisma.InputJsonValue } });
        if (upd.count !== 1) throw new ConflictException({ message: 'The campaign was changed in the meantime. Reload it before editing.', code: 'stale' });
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
    return this.state(userId, campaignId, slotId);
  }

  /** Back to the ORIGINAL generated file (the very one the run made): no render, nothing deleted. */
  async restore(userId: string, campaignId: string, slotId: string, body: { baseAssetId?: string }) {
    const { tc } = await this.owned(userId, campaignId, slotId);
    if (body.baseAssetId !== tc.assetId) throw new ConflictException({ message: 'This creative was changed in the meantime. Reload it before editing.', code: 'stale' });
    if (!tc.edit || tc.edit.state !== 'edited') throw new ConflictException({ message: 'This creative shows its original version already.', code: 'not_edited' });
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.creativeCampaign.findUnique({ where: { id: campaignId } });
      const pkg = fresh?.packageJson ? CampaignPackage.safeParse(fresh.packageJson) : null;
      const cur = pkg?.success ? creativeOf(pkg.data, slotId) : null;
      if (!fresh || !pkg?.success || !cur?.edit || cur.assetId !== body.baseAssetId) throw new ConflictException({ message: 'This creative was changed in the meantime. Reload it before editing.', code: 'stale' });
      const original = await tx.campaignAsset.findFirst({ where: { id: cur.edit.originalAssetId, campaignId } });
      if (!original) throw new NotFoundException('The original version of this creative was not found');
      await tx.campaignAsset.update({ where: { id: original.id }, data: { status: 'rendered' } });
      await tx.campaignAsset.update({ where: { id: cur.assetId! }, data: { status: 'superseded' } });
      const next = restoreOriginalRevision(pkg.data, { slotId, previousAssetId: cur.assetId!, original: toAssetRecord({ ...original, status: 'rendered' }), at: new Date().toISOString() });
      const upd = await tx.creativeCampaign.updateMany({ where: { id: campaignId, updatedAt: fresh.updatedAt }, data: { packageJson: next as unknown as Prisma.InputJsonValue } });
      if (upd.count !== 1) throw new ConflictException({ message: 'The campaign was changed in the meantime. Reload it before editing.', code: 'stale' });
    });
    return this.state(userId, campaignId, slotId);
  }
}

/** What the modal shows about a preview (no paths, no internals). */
function summary(r: Extract<EditResult, { ok: true }>) {
  return {
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    status: r.status,
    fitting: r.fitting,
    notes: r.notes,
    warnings: r.pre.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => ({ id: c.id, status: c.status, detail: c.detail.slice(0, 240) })).slice(0, 10),
  };
}
