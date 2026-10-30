import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ProductIntakeService } from './product-intake.service';
import { ProductIntakeController } from './product-intake.controller';

@Module({
  imports: [ProjectsModule],
  providers: [ProductIntakeService],
  controllers: [ProductIntakeController],
})
export class ProductIntakeModule {}
