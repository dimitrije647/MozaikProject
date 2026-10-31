import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { StorageDriver } from '../storage/storage.service';
import { PipelineService } from './pipeline.service';
import { slugify } from '../common/slug';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private activity: ActivityLogService,
    private storage: StorageDriver,
    private pipeline: PipelineService,
  ) {}

  /** Throws 404 (not 403) for other users' projects so ids cannot be probed. */
  async assertOwned(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async list(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        intake: { select: { productName: true, marketingGoal: true, websiteUrl: true } },
        _count: { select: { assets: true, notes: true, socials: true } },
      },
    });
    // Derived from the saved runs and results (read-only); `status` stays the user's own lifecycle label.
    const pipelines = await this.pipeline.summaries(userId, projects.map((p) => p.id));
    return projects.map((p) => ({ ...p, pipeline: pipelines.get(p.id) ?? null }));
  }

  async create(userId: string, dto: CreateProjectDto) {
    const project = await this.prisma.project.create({
      data: {
        userId,
        name: dto.name.trim(),
        description: dto.description,
        slug: await this.uniqueSlug(userId, dto.name),
      },
    });
    await this.activity.log(userId, 'project.created', project.id, { name: project.name });
    return project;
  }

  async get(userId: string, id: string) {
    await this.assertOwned(userId, id);
    return this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: {
        intake: true,
        assets: { orderBy: { createdAt: 'desc' } },
        socials: true,
        formats: true,
        notes: { orderBy: { updatedAt: 'desc' } },
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateProjectDto) {
    await this.assertOwned(userId, id);
    const project = await this.prisma.project.update({
      where: { id },
      data: { name: dto.name?.trim(), description: dto.description, status: dto.status },
    });
    await this.activity.log(userId, 'project.updated', id, { status: project.status });
    return project;
  }

  async remove(userId: string, id: string) {
    await this.assertOwned(userId, id);
    const [assets, campaignAssets] = await Promise.all([
      this.prisma.projectAsset.findMany({ where: { projectId: id }, select: { filePath: true } }),
      this.prisma.campaignAsset.findMany({ where: { projectId: id }, select: { filePath: true } }),
    ]);
    await this.prisma.project.delete({ where: { id } });
    // Files are removed after the DB row so a failed delete never leaves a project with missing files.
    await Promise.all([...assets, ...campaignAssets].map((a) => this.storage.delete(a.filePath).catch(() => undefined)));
    await this.activity.log(userId, 'project.deleted', undefined, { id });
    return { ok: true };
  }

  private async uniqueSlug(userId: string, name: string) {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; await this.prisma.project.findUnique({ where: { userId_slug: { userId, slug } } }); i++) {
      slug = `${base}-${i}`;
    }
    return slug;
  }
}
