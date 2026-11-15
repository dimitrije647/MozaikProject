import { Body, Controller, Get, HttpCode, Param, Post, Put, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { CreativeEditDto, CreativeRestoreDto } from './dto/mozaik.dto';
import { CreativeEditorService } from './creative-editor.service';

/**
 * The creative editor of a finished campaign (owner only; 404 for anyone else). Text changes are rendered by the local template renderer: no
 * model call, no image generation. The preview answers with the real PNG; its checks travel in the X-Creative-Preview header.
 */
@Controller('campaigns/:campaignId/creatives/:slotId')
export class CreativeEditorController {
  constructor(private editor: CreativeEditorService) {}

  @Get('editor')
  state(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Param('slotId') slotId: string) {
    return this.editor.state(u.id, campaignId, slotId);
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Param('slotId') slotId: string, @Body() dto: CreativeEditDto, @Res({ passthrough: true }) res: Response) {
    const { png, meta } = await this.editor.preview(u.id, campaignId, slotId, dto);
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'X-Creative-Preview': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url'),
      'Access-Control-Expose-Headers': 'X-Creative-Preview',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(png);
  }

  @Put()
  save(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Param('slotId') slotId: string, @Body() dto: CreativeEditDto) {
    return this.editor.save(u.id, campaignId, slotId, dto);
  }

  @Post('restore')
  @HttpCode(200)
  restore(@CurrentUser() u: AuthUser, @Param('campaignId') campaignId: string, @Param('slotId') slotId: string, @Body() dto: CreativeRestoreDto) {
    return this.editor.restore(u.id, campaignId, slotId, dto);
  }
}
