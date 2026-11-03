import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req, Res, UseFilters } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { ConnectPinterestDto, PinterestPageQueryDto } from './pinterest.dto';
import { PinterestExceptionFilter } from './pinterest.errors';
import { PinterestService } from './pinterest.service';

/**
 * Optional Pinterest integration (read-only inspiration browsing). Every route except the OAuth callback requires the normal
 * LaunchPilot session. Responses that carry Pinterest data are `no-store`: LaunchPilot does not cache them.
 */
@Controller('integrations/pinterest')
@UseFilters(PinterestExceptionFilter)
export class PinterestController {
  constructor(
    private readonly svc: PinterestService,
    private readonly jwt: JwtService,
  ) {}

  /** Works when Pinterest is not configured (that is a normal state, not an error). */
  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() u: AuthUser) {
    return this.svc.status(u.id);
  }

  @Post('connect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectPinterestDto) {
    return this.svc.startConnect(u.id, dto.returnPath);
  }

  /**
   * Pinterest redirects the browser here. The route is @Public (no Authorization header), but the browser still carries the
   * httpOnly session cookie (SameSite=Lax is sent on this top-level navigation). The single-use `state` row says who started the
   * flow and the cookie must belong to that same user. The response is always a redirect to the web app; codes, state and tokens
   * never appear in it.
   */
  @Public()
  @Get('callback')
  async callback(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    const target = await this.svc.handleCallback({ code: query.code, state: query.state, error: query.error }, await this.sessionUserId(req));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  }

  @Delete()
  @Header('Cache-Control', 'no-store')
  disconnect(@CurrentUser() u: AuthUser) {
    return this.svc.disconnect(u.id);
  }

  @Get('boards')
  @Header('Cache-Control', 'no-store')
  boards(@CurrentUser() u: AuthUser, @Query() q: PinterestPageQueryDto) {
    return this.svc.listBoards(u.id, q.bookmark);
  }

  @Get('boards/:boardId/pins')
  @Header('Cache-Control', 'no-store')
  pins(@CurrentUser() u: AuthUser, @Param('boardId') boardId: string, @Query() q: PinterestPageQueryDto) {
    return this.svc.listBoardPins(u.id, boardId, q.bookmark);
  }

  /** The user of the session cookie, or null (no cookie / expired / forged). Never throws. */
  private async sessionUserId(req: Request): Promise<string | null> {
    const token = req.cookies?.[AUTH_COOKIE];
    if (typeof token !== 'string' || !token) return null;
    try {
      return (await this.jwt.verifyAsync<{ sub: string }>(token)).sub ?? null;
    } catch {
      return null;
    }
  }
}
