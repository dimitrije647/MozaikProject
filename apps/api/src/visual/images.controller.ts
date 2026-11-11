import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ImageLibraryService } from './image-library.service';

/**
 * The AVAILABLE IMAGES gallery of a project (NO AI HYBRID): the pictures a campaign can use, where each came from and under which rights.
 * Nothing here makes a request to OpenAI. Everything is scoped to the caller's own project.
 */
@Controller('projects/:projectId/images')
export class ImagesController {
  constructor(private library: ImageLibraryService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.library.list(u.id, projectId);
  }

  /** Looks for pictures on the project's website, in its repository, among its social links and at the licensed providers. Downloads nothing. */
  @Post('discover')
  @HttpCode(200)
  discover(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { sources?: string[]; refresh?: boolean }) {
    return this.library.discover(u.id, projectId, { sources: Array.isArray(body?.sources) ? body.sources.map(String).slice(0, 6) : undefined, refresh: body?.refresh === true });
  }

  /** `attest: true` = the owner confirms the rights (website / repository pictures); `reviewConfirmed: true` = the license was checked at its source (stock). */
  @Post(':imageId/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('imageId') imageId: string, @Body() body: { attest?: boolean; reviewConfirmed?: boolean }) {
    return this.library.approve(u.id, projectId, imageId, { attest: body?.attest === true, reviewConfirmed: body?.reviewConfirmed === true });
  }

  /** Get Content: several pictures at once (each through the same rights rules; a failing one never stops the rest). */
  @Post('approve-batch')
  @HttpCode(200)
  approveBatch(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { ids?: string[]; attest?: boolean; reviewConfirmed?: boolean }) {
    return this.library.approveBatch(u.id, projectId, Array.isArray(body?.ids) ? body.ids.map(String) : [], { attest: body?.attest === true, reviewConfirmed: body?.reviewConfirmed === true });
  }

  @Post('reject-batch')
  @HttpCode(200)
  rejectBatch(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Body() body: { ids?: string[] }) {
    return this.library.rejectBatch(u.id, projectId, Array.isArray(body?.ids) ? body.ids.map(String) : []);
  }

  @Post(':imageId/reject')
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('imageId') imageId: string) {
    return this.library.reject(u.id, projectId, imageId);
  }

  @Post(':imageId/restore')
  @HttpCode(200)
  restore(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('imageId') imageId: string) {
    return this.library.restore(u.id, projectId, imageId);
  }

  @Post(':imageId/alternatives')
  @HttpCode(200)
  alternatives(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string, @Param('imageId') imageId: string) {
    return this.library.alternatives(u.id, projectId, imageId);
  }
}
