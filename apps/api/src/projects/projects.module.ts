import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { PipelineService } from './pipeline.service';

@Module({ providers: [ProjectsService, PipelineService], controllers: [ProjectsController], exports: [ProjectsService, PipelineService] })
export class ProjectsModule {}
