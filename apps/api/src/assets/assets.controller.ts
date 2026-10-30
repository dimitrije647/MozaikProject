import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { AssetsService, MAX_UPLOAD_BYTES } from './assets.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller()
export class AssetsController {
  constructor(private assets: AssetsService) {}

  @Get('projects/:id/assets')
  list(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assets.list(u.id, id);
  }

  @Post('projects/:id/assets')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('type') type?: string,
  ) {
    return this.assets.upload(u.id, id, files, type);
  }

  /** Authenticated file download/preview (files are never served statically). */
  @Get('assets/:id/file')
  async file(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { asset, stream } = await this.assets.open(u.id, id);
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(asset.originalName)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(stream);
  }

  @Delete('assets/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.assets.remove(u.id, id);
  }
}
