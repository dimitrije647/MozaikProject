import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { StartFactoryDto } from './dto/factory.dto';
import { FactoryService } from './factory.service';

/**
 * The full campaign: F1 -> F2 -> F3 -> F4 driven by one deterministic orchestrator over the existing phase services.
 * Nothing here spends anything except POST /projects/:id/factory, which needs this explicit call (the plan is free).
 */
@Controller()
export class FactoryController {
  constructor(private factory: FactoryService) {}

  @Get('factory/presets')
  presets() {
    return this.factory.presets();
  }

  /** The plan the user confirms: reused vs executed phases, exact limits, models. No paid request is made. */
  @Post('projects/:projectId/factory/preflight')
  @HttpCode(200)
  preflight(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartFactoryDto) {
    return this.factory.preflight(u.id, projectId, dto);
  }

  /** Starts the full campaign. Uses the user's OpenAI credits; only runs from this explicit call. */
  @Post('projects/:projectId/factory')
  start(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartFactoryDto) {
    return this.factory.start(u.id, projectId, dto);
  }

  @Get('projects/:projectId/factory-runs')
  list(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.factory.list(u.id, projectId);
  }

  @Get('factory-runs/:id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.factory.view(u.id, id);
  }

  /** The persisted Mozaik activity of the phases this run executed (agents, cross-checks, joins, reviews, repairs). */
  @Get('factory-runs/:id/events')
  events(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.factory.events(u.id, id, Math.min(Math.max(Number(limit) || 400, 1), 1000));
  }

  @Post('factory-runs/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.factory.cancel(u.id, id);
  }
}
