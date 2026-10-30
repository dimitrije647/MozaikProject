import { Injectable } from '@nestjs/common';
import { createReadStream, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { extname, join, resolve, sep } from 'path';
import type { Readable } from 'stream';

/**
 * Storage abstraction. MVP uses the local filesystem; to move to S3, implement this
 * interface with an S3 client and bind it to STORAGE_DRIVER in StorageModule.
 */
export abstract class StorageDriver {
  /** Persists the bytes and returns an opaque storage key (stored in ProjectAsset.filePath). */
  abstract save(projectId: string, originalName: string, data: Buffer): Promise<string>;
  abstract read(key: string): Readable;
  abstract delete(key: string): Promise<void>;
}

@Injectable()
export class LocalStorageService extends StorageDriver {
  private get root() {
    return resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads');
  }

  /** Resolves a key to an absolute path and refuses anything outside the upload root. */
  private pathFor(key: string) {
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async save(projectId: string, originalName: string, data: Buffer) {
    const key = join(projectId, `${randomUUID()}${extname(originalName).toLowerCase()}`);
    const full = this.pathFor(key);
    await fs.mkdir(resolve(full, '..'), { recursive: true });
    await fs.writeFile(full, data);
    return key.split(sep).join('/');
  }

  read(key: string) {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string) {
    await fs.rm(this.pathFor(key), { force: true });
  }
}
