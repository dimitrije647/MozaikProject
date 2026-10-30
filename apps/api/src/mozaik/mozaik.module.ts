import { Logger, Module } from '@nestjs/common';
import { MozaikCampaignRuntime } from '@launchpilot/agents';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { ProjectsModule } from '../projects/projects.module';
import { MozaikController } from './mozaik.controller';
import { MozaikService } from './mozaik.service';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';

@Module({
  imports: [ProjectsModule, ApiCredentialsModule],
  controllers: [MozaikController],
  providers: [
    MozaikService,
    {
      provide: CAMPAIGN_RUNTIME,
      // One runtime adapter per process; every run inside it gets its own isolated Mozaik runtime.
      useFactory: () => new MozaikCampaignRuntime({ logger: new Logger('MozaikRuntime') }),
    },
  ],
})
export class MozaikModule {}
