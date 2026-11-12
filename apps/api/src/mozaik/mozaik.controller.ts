import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ListAuditsQueryDto, ListEventsQueryDto, StartSmokeTestDto } from './dto/mozaik.dto';
import { MozaikService } from './mozaik.service';

@Controller()
export class MozaikController {
  constructor(private mozaik: MozaikService) {}

  /**
   * Infrastructure smoke test only. Campaigns are generated ONLY by Campaign Production (POST /projects/:id/factory); the stages have no start
   * route of their own any more. The reads below serve current AND historical results (including pre-V4 audits and campaigns).
   */
  @Post('projects/:projectId/runs/smoke-test')
  startSmokeTest(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartSmokeTestDto) {
    return this.mozaik.startSmokeTest(u.id, projectId, dto);
  }

  /** HISTORICAL Marketing Audits (V4 no longer runs one); read-only. */
  @Get('projects/:projectId/audits')
  audits(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() query: ListAuditsQueryDto) {
    return this.mozaik.listAudits(u.id, projectId, query);
  }

  @Get('audits/:auditId')
  audit(@CurrentUser() u: AuthUser, @Param('auditId') auditId: string) {
    return this.mozaik.getAudit(u.id, auditId);
  }

  @Get('projects/:projectId/strategies')
  strategies(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() query: ListAuditsQueryDto) {
    return this.mozaik.listStrategies(u.id, projectId, query);
  }

  @Get('strategies/:strategyId')
  strategy(@CurrentUser() u: AuthUser, @Param('strategyId') strategyId: string) {
    return this.mozaik.getStrategy(u.id, strategyId);
  }

  /** Participants, sources, findings and usage of a strategy run. */
  @Get('runs/:runId/strategy-analysis')
  strategyAnalysis(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.getStrategyAnalysis(u.id, runId);
  }

  @Get('projects/:projectId/campaigns')
  campaigns(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() query: ListAuditsQueryDto) {
    return this.mozaik.listCampaigns(u.id, projectId, query);
  }

  @Get('campaigns/:campaignId')
  campaign(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string) {
    return this.mozaik.getCampaign(u.id, campaignId);
  }

  @Get('campaigns/:campaignId/assets')
  campaignAssets(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string) {
    return this.mozaik.getCampaignAssets(u.id, campaignId);
  }

  /** Authenticated asset binary for the owner only; never served statically, never cached by shared caches. */
  @Get('campaigns/:campaignId/assets/:assetId/file')
  async campaignAssetFile(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Param('assetId') assetId: string, @Res({ passthrough: true }) res: Response) {
    const { asset, stream } = await this.mozaik.openCampaignAsset(u.id, campaignId, assetId);
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.bytes),
      'Content-Disposition': `inline; filename="${asset.kind}-${asset.conceptId}-v${asset.version}.png"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(stream);
  }

  @Get('campaigns/:campaignId/reviews')
  campaignReviews(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string) {
    return this.mozaik.getCampaignReviews(u.id, campaignId);
  }

  /** THE campaign download: one ZIP (strategy, social posts and visuals per platform, ads, print, brand, sources, README). */
  @Get('campaigns/:campaignId/export')
  async exportCampaign(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Res({ passthrough: true }) res: Response) {
    const { zip, filename } = await this.mozaik.exportCampaign(u.id, campaignId);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(zip);
  }

  /** Participants, usage and the timeline of real participant events of a creative run. */
  @Get('runs/:runId/creative-analysis')
  creativeAnalysis(@CurrentUser() u: AuthUser, @Param('runId') runId: string) {
    return this.mozaik.getCreativeAnalysis(u.id, runId);
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

  /** Agents, sources and findings (evidence) of a run. */
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
