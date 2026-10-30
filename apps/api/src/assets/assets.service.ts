import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { StorageDriver } from '../storage/storage.service';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const ASSET_TYPES = ['logo', 'screenshot', 'image', 'pdf', 'doc', 'reference', 'other'];

const ALLOWED_MIME = [/^image\//, /^application\/pdf$/, /^text\//, /^application\/(msword|vnd\.openxmlformats-officedocument\..+)$/];

@Injectable()
export class AssetsService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private storage: StorageDriver,
    private activity: ActivityLogService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.projectAsset.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upload(userId: string, projectId: string, files: Express.Multer.File[], type?: string) {
    await this.projects.assertOwned(userId, projectId);
    if (!files?.length) throw new BadRequestException('No files uploaded');
    const bad = files.find((f) => !ALLOWED_MIME.some((re) => re.test(f.mimetype)));
    if (bad) throw new BadRequestException(`Unsupported file type: ${bad.originalname}`);

    const created = [];
    for (const file of files) {
      const key = await this.storage.save(projectId, file.originalname, file.buffer);
      created.push(
        await this.prisma.projectAsset.create({
          data: {
            projectId,
            type: type && ASSET_TYPES.includes(type) ? type : this.guessType(file.mimetype),
            originalName: file.originalname,
            mimeType: file.mimetype,
            filePath: key,
            fileSize: file.size,
          },
        }),
      );
    }
    await this.activity.log(userId, 'asset.uploaded', projectId, { count: created.length });
    return created;
  }

  private async owned(userId: string, assetId: string) {
    const asset = await this.prisma.projectAsset.findFirst({
      where: { id: assetId, project: { userId } },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    return asset;
  }

  async open(userId: string, assetId: string) {
    const asset = await this.owned(userId, assetId);
    return { asset, stream: this.storage.read(asset.filePath) };
  }

  async remove(userId: string, assetId: string) {
    const asset = await this.owned(userId, assetId);
    await this.prisma.projectAsset.delete({ where: { id: asset.id } });
    await this.storage.delete(asset.filePath).catch(() => undefined);
    await this.activity.log(userId, 'asset.deleted', asset.projectId);
    return { ok: true };
  }

  private guessType(mime: string) {
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    return 'doc';
  }
}
