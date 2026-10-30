import { Body, Controller, Get, Injectable, Module, Param, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, ValidateNested } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectsService } from '../projects/projects.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

export const FORMAT_TYPES = [
  'instagram_post',
  'instagram_story',
  'facebook_post',
  'linkedin_post',
  'website_banner',
  'billboard',
  'flyer',
  'other',
];

class FormatDto {
  @IsIn(FORMAT_TYPES) formatType: string;
  @IsBoolean() enabled: boolean;
}
class ReplaceFormatsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => FormatDto) formats: FormatDto[];
}

@Injectable()
export class CampaignFormatsService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.campaignFormatPreference.findMany({ where: { projectId } });
  }

  async replace(userId: string, projectId: string, formats: FormatDto[]) {
    await this.projects.assertOwned(userId, projectId);
    await this.prisma.$transaction([
      this.prisma.campaignFormatPreference.deleteMany({ where: { projectId } }),
      this.prisma.campaignFormatPreference.createMany({
        data: formats.map((f) => ({ projectId, formatType: f.formatType, enabled: f.enabled })),
        skipDuplicates: true,
      }),
    ]);
    return this.list(userId, projectId);
  }
}

@Controller('projects/:id/formats')
export class CampaignFormatsController {
  constructor(private svc: CampaignFormatsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.list(u.id, id);
  }

  @Put()
  replace(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReplaceFormatsDto) {
    return this.svc.replace(u.id, id, dto.formats);
  }
}

@Module({
  imports: [ProjectsModule],
  providers: [CampaignFormatsService],
  controllers: [CampaignFormatsController],
})
export class CampaignFormatsModule {}
