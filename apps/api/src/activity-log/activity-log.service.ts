import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class ActivityLogService {
  constructor(private prisma: PrismaService) {}

  /** Logging must never break the main request, so failures are swallowed. */
  async log(userId: string, eventType: string, projectId?: string, data?: Prisma.InputJsonValue) {
    try {
      await this.prisma.activityLog.create({
        data: { userId, projectId, eventType, eventDataJson: data },
      });
    } catch (err) {
      console.warn('activity log failed', err);
    }
  }

  recent(userId: string, limit = 10) {
    return this.prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
