import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Put,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsUrl, ValidateNested } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectsService } from '../projects/projects.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

export const PLATFORMS = [
  'instagram',
  'facebook',
  'linkedin',
  'x',
  'reddit',
  'tiktok',
  'pinterest',
  'youtube',
];

class SocialProfileDto {
  @IsIn(PLATFORMS) platform: string;
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }) url: string;
}
class ReplaceSocialProfilesDto {
  @IsArray() @ArrayMaxSize(PLATFORMS.length) @ValidateNested({ each: true }) @Type(() => SocialProfileDto)
  profiles: SocialProfileDto[];
}

@Injectable()
export class SocialProfilesService {
  constructor(
    private prisma: PrismaService,
    private projects: ProjectsService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.projects.assertOwned(userId, projectId);
    return this.prisma.socialProfile.findMany({ where: { projectId }, orderBy: { platform: 'asc' } });
  }

  /** Replaces the whole set: platforms missing from the payload are removed. */
  async replace(userId: string, projectId: string, profiles: SocialProfileDto[]) {
    await this.projects.assertOwned(userId, projectId);
    await this.prisma.$transaction([
      this.prisma.socialProfile.deleteMany({ where: { projectId } }),
      this.prisma.socialProfile.createMany({
        data: profiles.map((p) => ({ projectId, platform: p.platform, url: p.url })),
        skipDuplicates: true,
      }),
    ]);
    return this.list(userId, projectId);
  }
}

@Controller('projects/:id/social-profiles')
export class SocialProfilesController {
  constructor(private svc: SocialProfilesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.list(u.id, id);
  }

  @Put()
  replace(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ReplaceSocialProfilesDto) {
    return this.svc.replace(u.id, id, dto.profiles);
  }
}

@Module({
  imports: [ProjectsModule],
  providers: [SocialProfilesService],
  controllers: [SocialProfilesController],
})
export class SocialProfilesModule {}
