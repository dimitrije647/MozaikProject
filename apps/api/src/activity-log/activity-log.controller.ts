import { Controller, Get, Query } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('activity')
export class ActivityLogController {
  constructor(private activity: ActivityLogService) {}

  @Get()
  recent(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    return this.activity.recent(u.id, Math.min(Number(limit) || 10, 50));
  }
}
