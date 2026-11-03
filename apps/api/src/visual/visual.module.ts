import { Module } from '@nestjs/common';
import { WebFetchTool, createImageAdaptersFromEnv } from '@launchpilot/agents';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProjectsModule } from '../projects/projects.module';
import { BRAND_READERS, IMAGE_ADAPTERS, IMAGE_DOWNLOADER, VisualService, defaultBrandReaders } from './visual.service';
import { VisualController } from './visual.controller';
import { ImagesController } from './images.controller';
import { GetContentController } from './get-content.controller';
import { GetContentService } from './get-content.service';
import { ProjectBrandService } from './project-brand.service';
import { IMAGE_SOURCES, ImageLibraryService, defaultImageSources } from './image-library.service';

@Module({
  imports: [ProjectsModule, ActivityLogModule],
  controllers: [VisualController, ImagesController, GetContentController],
  providers: [
    VisualService,
    ImageLibraryService,
    ProjectBrandService,
    GetContentService,
    { provide: IMAGE_SOURCES, useFactory: defaultImageSources },
    // nothing is configured by default: a fresh install makes no external image-search request
    { provide: IMAGE_ADAPTERS, useFactory: () => createImageAdaptersFromEnv(process.env) },
    { provide: BRAND_READERS, useFactory: defaultBrandReaders },
    { provide: IMAGE_DOWNLOADER, useFactory: () => () => new WebFetchTool({ timeoutMs: 15_000, maxAssets: 2, maxPages: 1, userAgent: 'LaunchPilotBot/1.0 (licensed picture download; honors robots.txt)' }) },
  ],
  exports: [VisualService, ImageLibraryService, ProjectBrandService],
})
export class VisualModule {}
