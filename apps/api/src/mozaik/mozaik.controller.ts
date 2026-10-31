import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ListAuditsQueryDto, ListEventsQueryDto, StartAuditDto, StartDiscoveryDto, StartSmokeTestDto, StartStrategyDto } from './dto/mozaik.dto';
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

  /** F2 Marketing Audit on a completed F1 report. Uses the user's OpenAI credits; only runs from this explicit call. */
  @Post('projects/:projectId/runs/marketing-audit')
  startMarketingAudit(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartAuditDto) {
    return this.mozaik.startMarketingAudit(u.id, projectId, dto);
  }

  @Get('projects/:projectId/audits')
  audits(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() query: ListAuditsQueryDto) {
    return this.mozaik.listAudits(u.id, projectId, query);
  }

  @Get('audits/:auditId')
  audit(@CurrentUser() u: AuthUser, @Param('auditId') auditId: string) {
    return this.mozaik.getAudit(u.id, auditId);
  }

  /** F3 Market Research & Strategy on a completed F2 audit. Uses the user's OpenAI credits; only runs from this explicit call. */
  @Post('projects/:projectId/runs/market-strategy')
  startMarketStrategy(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartStrategyDto) {
    return this.mozaik.startMarketStrategy(u.id, projectId, dto);
  }

  @Get('projects/:projectId/strategies')
  strategies(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() query: ListAuditsQueryDto) {
    return this.mozaik.listStrategies(u.id, projectId, query);
  }

  @Get('strategies/:strategyId')
  strategy(@CurrentUser() u: AuthUser, @Param('strategyId') strategyId: string) {
    return this.mozaik.getStrategy(u.id, strategyId);
  }

  /** Participants (incl. the dynamically created Channel Scouts and why the others were not), sources, findings, cross-checks, usage. */
  @Get('runs/:runId/strategy-analysis')
  strategyAnalysis(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.getStrategyAnalysis(u.id, runId);
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

  /** Agents, sources, findings (evidence) and cross-checks of a run. */
  @Get('runs/:runId/analysis')
  analysis(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.getAnalysis(u.id, runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.cancel(u.id, runId);
  }
}
