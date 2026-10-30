import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ProductIntakeService } from './product-intake.service';
import { UpsertIntakeDto } from './product-intake.dto';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('projects/:id/intake')
export class ProductIntakeController {
  constructor(private intake: ProductIntakeService) {}

  @Get()
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.intake.get(u.id, id);
  }

  @Put()
  put(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpsertIntakeDto) {
    return this.intake.upsert(u.id, id, dto);
  }
}
