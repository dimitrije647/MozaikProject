import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ContinueImagesDto } from './dto/factory.dto';
import { ListAuditsQueryDto, ListEventsQueryDto, StartAuditDto, StartCreativeDto, StartDiscoveryDto, StartSmokeTestDto, StartStrategyDto } from './dto/mozaik.dto';
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

  /**
   * F4 Creative Production on a completed F3 strategy. Uses the user's OpenAI credits for text AND images (gpt-image-*);
   * only runs from this explicit call. The preflight below shows the exact limits first and spends nothing.
   */
  @Post('projects/:projectId/runs/creative-production')
  startCreativeProduction(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartCreativeDto) {
    return this.mozaik.startCreativeProduction(u.id, projectId, dto);
  }

  @Post('projects/:projectId/runs/creative-production/preflight')
  @HttpCode(200)
  preflightCreativeProduction(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartCreativeDto) {
    return this.mozaik.preflightCreativeProduction(u.id, projectId, dto);
  }

  /**
   * Image-only continuation: generate ONLY the missing original images of a finished campaign, as a new campaign that reuses the
   * strategy, copy, landing content and the images that succeeded. The preflight is free; starting is billed and needs an approved
   * spending limit and an explicit confirmation.
   */
  @Post('campaigns/:campaignId/continue-images/preflight')
  @HttpCode(200)
  preflightContinueImages(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Body() dto: ContinueImagesDto) {
    return this.mozaik.preflightImageContinuation(u.id, campaignId, dto);
  }

  @Post('campaigns/:campaignId/continue-images')
  continueImages(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Body() dto: ContinueImagesDto) {
    return this.mozaik.startImageContinuation(u.id, campaignId, dto);
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

  /** Landing page preview as a self-contained HTML document with a strict CSP (no scripts, no external resources). */
  @Get('campaigns/:campaignId/landing-preview')
  async landingPreview(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Res({ passthrough: true }) res: Response) {
    const html = await this.mozaik.getLandingPreview(u.id, campaignId);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return html;
  }

  /** The Campaign Package as a ZIP: image binaries, JSON, copy, landing content and preview, review, manifest. */
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

  /** Only the original AI images (and a list of what each one is), as a ZIP. */
  @Get('campaigns/:campaignId/export/originals')
  async exportOriginals(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Res({ passthrough: true }) res: Response) {
    const { zip, filename } = await this.mozaik.exportOriginals(u.id, campaignId);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return new StreamableFile(zip);
  }

  /** Hybrid Production: only the template creatives (rendered locally; not AI images), as a ZIP. */
  @Get('campaigns/:campaignId/export/templates')
  async exportTemplates(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Res({ passthrough: true }) res: Response) {
    const { zip, filename } = await this.mozaik.exportCreatives(u.id, campaignId, 'templates');
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return new StreamableFile(zip);
  }

  /** Hybrid Production: every finished creative (original AI images and template creatives), as a ZIP. */
  @Get('campaigns/:campaignId/export/creatives')
  async exportCreatives(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Res({ passthrough: true }) res: Response) {
    const { zip, filename } = await this.mozaik.exportCreatives(u.id, campaignId, 'all');
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return new StreamableFile(zip);
  }

  /** Participants (incl. the Fixer created at run time), cross-checks, usage and the timeline of real participant events. */
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
