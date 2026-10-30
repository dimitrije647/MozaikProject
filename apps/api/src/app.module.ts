import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './common/prisma.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { ProductIntakeModule } from './product-intake/product-intake.module';
import { AssetsModule } from './assets/assets.module';
import { SocialProfilesModule } from './social-profiles/social-profiles.module';
import { CampaignFormatsModule } from './campaign-formats/campaign-formats.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ApiCredentialsModule } from './api-credentials/api-credentials.module';
import { WorkspaceNotesModule } from './workspace-notes/workspace-notes.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { HealthModule } from './health/health.module';
import { StorageModule } from './storage/storage.module';
import { MozaikModule } from './mozaik/mozaik.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    ActivityLogModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    ProductIntakeModule,
    AssetsModule,
    SocialProfilesModule,
    CampaignFormatsModule,
    ApiCredentialsModule,
    IntegrationsModule,
    WorkspaceNotesModule,
    MozaikModule,
    HealthModule,
  ],
  // Every route requires a session unless it is marked @Public().
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
