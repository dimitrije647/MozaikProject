import { Logger, Module } from '@nestjs/common';
import { MozaikCampaignRuntime } from '@launchpilot/agents';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { ProjectsModule } from '../projects/projects.module';
import { VisualModule } from '../visual/visual.module';
import { FactoryController } from './factory.controller';
import { FactoryService } from './factory.service';
import { HybridController } from './hybrid.controller';
import { HybridService } from './hybrid.service';
import { HybridInputsService } from './hybrid-support';
import { MozaikController } from './mozaik.controller';
import { MozaikService } from './mozaik.service';
import { CAMPAIGN_RUNTIME } from './types/runtime.token';

@Module({
  imports: [ProjectsModule, ApiCredentialsModule, VisualModule],
  controllers: [MozaikController, FactoryController, HybridController],
  providers: [
    MozaikService,
    FactoryService,
    HybridService,
    HybridInputsService,
    {
      provide: CAMPAIGN_RUNTIME,
      // One runtime adapter per process; every run inside it gets its own isolated Mozaik runtime.
      useFactory: () => new MozaikCampaignRuntime({ logger: new Logger('MozaikRuntime') }),
    },
  ],
})
export class MozaikModule {}
