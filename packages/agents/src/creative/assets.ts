import { createHash, randomUUID } from 'node:crypto';
import type { AssetRecord } from './schemas';

/**
 * Where generated and rendered images live. The Mozaik participants only ever hold asset IDS and metadata (binaries never travel
 * in SemanticEvents or JSON reports): they save through this interface and load bytes when they need them. The backend
 * implements it on top of the project's existing file storage and the CampaignAsset table.
 */
export type NewAsset = Omit<AssetRecord, 'id' | 'sha256' | 'bytes' | 'createdAt'> & { data: Buffer };

export interface AssetStore {
  save(asset: NewAsset): Promise<AssetRecord>;
  load(assetId: string): Promise<Buffer>;
  /** Marks an older version as replaced (the file stays: originals are preserved). */
  markSuperseded(assetId: string): Promise<void>;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** In-memory store for tests and tools. */
export class InMemoryAssetStore implements AssetStore {
  readonly files = new Map<string, Buffer>();
  readonly records = new Map<string, AssetRecord>();

  async save(asset: NewAsset): Promise<AssetRecord> {
    const { data, ...rest } = asset;
    const record: AssetRecord = { ...rest, id: `ast_${randomUUID().slice(0, 8)}`, sha256: sha256(data), bytes: data.length, createdAt: new Date().toISOString() };
    this.files.set(record.id, data);
    this.records.set(record.id, record);
    return record;
  }

  async load(assetId: string): Promise<Buffer> {
    const b = this.files.get(assetId);
    if (!b) throw new Error('Asset not found');
    return b;
  }

  async markSuperseded(assetId: string) {
    const r = this.records.get(assetId);
    if (r) this.records.set(assetId, { ...r, status: 'superseded' });
  }
}
