import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { StartFactoryDto } from './dto/factory.dto';
import { HybridService } from './hybrid.service';

/**
 * Hybrid Production: the template library, the style library and the FREE preview. Nothing here makes a request to OpenAI or Pinterest.
 * Templates and styles are global, read-only data; the preview is scoped to the caller's own project.
 */
@Controller()
export class HybridController {
  constructor(private hybrid: HybridService) {}

  @Get('templates')
  templates(@Query() q: { category?: string; style?: string; industry?: string; channel?: string; class?: string; q?: string }) {
    return this.hybrid.listTemplates(q);
  }

  @Get('templates/:id')
  template(@Param('id') id: string) {
    return this.hybrid.getTemplate(id);
  }

  /** A PNG rendered from the template's own definition by the same renderer the campaign uses. */
  @Get('templates/:id/preview')
  async templatePreview(@Param('id') id: string, @Query() q: { class?: string; palette?: string; style?: string; image?: string }, @Res({ passthrough: true }) res: Response) {
    const png = await this.hybrid.templatePreviewPng(id, q);
    res.set({ 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
    return new StreamableFile(png);
  }

  @Get('styles')
  styles() {
    return this.hybrid.listStyles();
  }

  /** The Hybrid plan with real local renders of the chosen templates. Free: no OpenAI request, nothing stored. */
  @Post('projects/:projectId/hybrid/preview')
  @HttpCode(200)
  preview(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() dto: StartFactoryDto) {
    return this.hybrid.preview(u.id, projectId, dto);
  }
}
