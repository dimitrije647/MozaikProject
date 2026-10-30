import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';

@Module({ imports: [ProjectsModule], providers: [AssetsService], controllers: [AssetsController] })
export class AssetsModule {}
