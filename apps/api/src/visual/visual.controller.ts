import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { VisualService } from './visual.service';

/**
 * Visual System: the ten template collections, the campaign design of a project (the single place where its look is decided), the brand palette
 * analysis, free previews drawn by the real renderer, web visual discovery and licensed pictures. Nothing here makes a request to OpenAI.
 * Collections are global read-only data; everything under /projects/:id is scoped to the caller's own project.
 */
@Controller()
export class VisualController {
  constructor(private visual: VisualService) {}

  @Get('collections')
  collections() {
    return this.visual.listCollections();
  }

  @Get('collections/:id')
  collection(@Param('id') id: string) {
    return this.visual.getCollection(id);
  }

  /** A PNG of a template of the collection drawn by the real renderer with a palette (query p,s,a,b,t = six hex digits). */
  @Get('collections/:id/preview')
  async collectionPreview(@Param('id') id: string, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const png = await this.visual.previewPng(null, null, id, q);
    this.png(res, png);
    return new StreamableFile(png);
  }

  @Get('projects/:projectId/design')
  design(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.visual.getDesign(u.id, projectId);
  }

  @Put('projects/:projectId/design')
  saveDesign(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: Record<string, unknown>) {
    return this.visual.saveDesign(u.id, projectId, body);
  }

  @Delete('projects/:projectId/design')
  clearDesign(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.visual.clearDesign(u.id, projectId);
  }

  /** A fresh design for a collection with the project's default formats (not saved until PUT). */
  @Post('projects/:projectId/design/new')
  @HttpCode(200)
  async newDesign(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { collectionId?: string }) {
    const design = await this.visual.newDraft(u.id, projectId, String(body?.collectionId ?? ''));
    return { design, ...this.visual.evaluate(design) };
  }

  /** Another collection for a design (edited and brand colors stay). Not saved until PUT. */
  @Post('projects/:projectId/design/switch')
  @HttpCode(200)
  switch(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { design?: unknown; collectionId?: string }) {
    return this.visual.switchDesign(u.id, projectId, body);
  }

  /** The recommended palette for a collection from the project's own material. The analysis is cached for 24 hours; `refresh` re-reads the sources. */
  @Post('projects/:projectId/design/palette')
  @HttpCode(200)
  palette(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { collectionId?: string; refresh?: boolean; explicit?: Record<string, string> }) {
    return this.visual.suggestPaletteFor(u.id, projectId, { collectionId: String(body?.collectionId ?? ''), refresh: body?.refresh === true, explicit: body?.explicit });
  }

  /** A preview with the project's own logo (and, with picture=project, its first brand picture). Free. */
  @Get('projects/:projectId/design/preview')
  async preview(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const png = await this.visual.previewPng(u.id, projectId, String(q.collection ?? ''), q);
    this.png(res, png);
    return new StreamableFile(png);
  }

  @Post('projects/:projectId/design/discover')
  @HttpCode(200)
  discover(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { refresh?: boolean }) {
    return this.visual.discover(u.id, projectId, { refresh: body?.refresh === true });
  }

  @Get('projects/:projectId/design/images')
  images(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.visual.listLicensedImages(u.id, projectId);
  }

  @Post('projects/:projectId/design/images')
  @HttpCode(201)
  addImage(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { provider: string; id: string; reviewConfirmed?: boolean }) {
    return this.visual.addLicensedImage(u.id, projectId, { provider: String(body?.provider ?? ''), id: String(body?.id ?? ''), reviewConfirmed: body?.reviewConfirmed === true });
  }

  private png(res: Response, png: Buffer) {
    res.set({ 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=600' });
  }
}
