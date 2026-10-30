import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit() {
    await this.$connect();
  }

  // Disconnect in the LAST shutdown phase, so module destroy hooks (e.g. stopping active
  // Mozaik runs and flushing their final events) can still use the database.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
