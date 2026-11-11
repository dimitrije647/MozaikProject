import { Body, Controller, Get, HttpCode, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { GetContentService } from './get-content.service';

/**
 * GET CONTENT: the optional discovery of a project's logo, photographs and brand colors before a campaign. Free: nothing here calls OpenAI, starts a
 * campaign run or needs a budget. Everything is scoped to the caller's own project. `GET` only reads what was stored; discovery starts only on `POST`.
 */
@Controller('projects/:projectId/get-content')
export class GetContentController {
  constructor(private getContent: GetContentService) {}

  @Get()
  state(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.getContent.state(u.id, projectId);
  }

  /** Starts discovery (or returns the one already running, or a run younger than 24 hours for an unchanged project unless `refresh`). Returns at once. */
  @Post()
  @HttpCode(200)
  start(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { refresh?: boolean; collectionId?: string }) {
    return this.getContent.start(u.id, projectId, { refresh: body?.refresh === true, collectionId: typeof body?.collectionId === 'string' ? body.collectionId : undefined });
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.getContent.cancel(u.id, projectId);
  }

  /** "Upload a different logo": stored as the project's logo and approved at once. */
  @Post('logo/upload')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } }))
  uploadLogo(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.getContent.uploadLogo(u.id, projectId, file);
  }

  /** `attest: true` = the owner confirms they own the logo / hold the rights (website and repository logos). */
  @Post('logo/:candidateId/approve')
  @HttpCode(200)
  approveLogo(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('candidateId') candidateId: string, @Body() body: { attest?: boolean }) {
    return this.getContent.approveLogo(u.id, projectId, candidateId, { attest: body?.attest === true });
  }

  @Post('logo/:candidateId/reject')
  @HttpCode(200)
  rejectLogo(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('candidateId') candidateId: string) {
    return this.getContent.rejectLogo(u.id, projectId, candidateId);
  }

  @Post('logo/:candidateId/restore')
  @HttpCode(200)
  restoreLogo(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('candidateId') candidateId: string) {
    return this.getContent.restoreLogo(u.id, projectId, candidateId);
  }
}
