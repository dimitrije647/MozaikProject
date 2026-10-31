import type { CampaignAsset } from '@prisma/client';
import type { AssetRecord, AssetStore, NewAsset } from '@launchpilot/agents';
import type { PrismaService } from '../common/prisma.service';
import type { StorageDriver } from '../storage/storage.service';

/** A stored CampaignAsset row as the agents' AssetRecord (what the Campaign Package and the API expose). */
export function toAssetRecord(row: CampaignAsset): AssetRecord {
  const m = (row.metadataJson ?? {}) as { flags?: string[]; promptMetadata?: AssetRecord['promptMetadata']; usage?: AssetRecord['usage'] };
  return {
    id: row.id,
    kind: row.kind as AssetRecord['kind'],
    conceptId: row.conceptId,
    channel: row.channel as AssetRecord['channel'],
    format: row.format,
    version: row.version,
    parentAssetId: row.parentAssetId,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    sha256: row.sha256,
    source: row.source as AssetRecord['source'],
    model: row.model,
    quality: row.quality as AssetRecord['quality'],
    requestedSize: row.requestedSize as AssetRecord['requestedSize'],
    status: row.status as AssetRecord['status'],
    flags: m.flags ?? [],
    altText: row.altText,
    promptMetadata: m.promptMetadata ?? null,
    usage: m.usage ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * The agents' AssetStore on top of the project's file storage and the CampaignAsset table. Scoped to ONE campaign of ONE
 * project: an agent can only read back what this campaign stored. Binaries never go through the Mozaik events or the
 * database JSON; the record the agents receive carries the row id and metadata only.
 */
export class DbAssetStore implements AssetStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageDriver,
    private readonly projectId: string,
    private readonly campaignId: string,
  ) {}

  async save(asset: NewAsset): Promise<AssetRecord> {
    const { data, flags, promptMetadata, usage, ...rest } = asset;
    const sha256 = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
    const key = await this.storage.save(this.projectId, `${rest.kind}-${rest.conceptId}.png`, data);
    try {
      const row = await this.prisma.campaignAsset.create({
        data: {
          campaignId: this.campaignId,
          projectId: this.projectId,
          kind: rest.kind,
          conceptId: rest.conceptId,
          channel: rest.channel,
          format: rest.format,
          version: rest.version,
          parentAssetId: rest.parentAssetId,
          mimeType: rest.mimeType,
          width: rest.width,
          height: rest.height,
          bytes: data.length,
          sha256,
          source: rest.source,
          model: rest.model,
          quality: rest.quality,
          requestedSize: rest.requestedSize,
          status: rest.status,
          filePath: key,
          altText: rest.altText,
          metadataJson: { flags, promptMetadata, usage },
        },
      });
      return toAssetRecord(row);
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
  }

  async load(assetId: string): Promise<Buffer> {
    const row = await this.prisma.campaignAsset.findFirst({ where: { id: assetId, campaignId: this.campaignId } });
    if (!row) throw new Error('Asset not found');
    return readAll(this.storage.read(row.filePath));
  }

  async markSuperseded(assetId: string) {
    await this.prisma.campaignAsset.updateMany({ where: { id: assetId, campaignId: this.campaignId }, data: { status: 'superseded' } });
  }
}
