import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ListEventsQueryDto, StartDiscoveryDto, StartSmokeTestDto } from './dto/mozaik.dto';
import { MozaikService } from './mozaik.service';

@Controller()
export class MozaikController {
  constructor(private mozaik: MozaikService) {}

  /** Infrastructure smoke test only. There is deliberately no campaign-generation endpoint yet. */
  @Post('projects/:projectId/runs/smoke-test')
  startSmokeTest(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartSmokeTestDto) {
    return this.mozaik.startSmokeTest(u.id, projectId, dto);
  }

  /**
   * Product Discovery: real agents on the user's OpenAI key and chosen model. Uses their API credits,
   * so it only ever runs from this explicit call.
   */
  @Post('projects/:projectId/runs/product-discovery')
  startProductDiscovery(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartDiscoveryDto) {
    return this.mozaik.startProductDiscovery(u.id, projectId, dto);
  }

  @Get('projects/:projectId/reports')
  reports(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.mozaik.listReports(u.id, projectId);
  }

  @Get('reports/:reportId')
  report(@CurrentUser() u: AuthUser, @Param('reportId') reportId: string) {
    return this.mozaik.getReport(u.id, reportId);
  }

  @Get('projects/:projectId/runs')
  list(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.mozaik.listRuns(u.id, projectId);
  }

  @Get('runs/:runId')
  get(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.getRun(u.id, runId);
  }

  @Get('runs/:runId/events')
  events(@CurrentUser() u: AuthUser, @Param('runId') runId: string, @Query() query: ListEventsQueryDto) {
    return this.mozaik.listEvents(u.id, runId, query);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.cancel(u.id, runId);
  }
}
