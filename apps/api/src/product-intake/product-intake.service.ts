import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UpsertIntakeDto } from './product-intake.dto';

/** Empty strings from the form are stored as null. */
const clean = (dto: UpsertIntakeDto) =>
  Object.fromEntries(Object.entries(dto).map(([k, v]) => [k, v === '' ? null : v]));

@Injectable()
export class ProductIntakeService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
    private activity: ActivityLogService,
  ) {}

  async get(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.productIntake.findUnique({ where: { projectId } });
  }

  async upsert(userId: string, projectId: string, dto: UpsertIntakeDto) {
    await this.projects.assertOwned(userId, projectId);
    const data = clean(dto) as unknown as UpsertIntakeDto;
    const intake = await this.prisma.productIntake.upsert({
      where: { projectId },
      create: { ...data, projectId },
      update: data,
    });
    await this.activity.log(userId, 'intake.saved', projectId);
    return intake;
  }
}
