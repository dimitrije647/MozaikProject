import { Module } from '@nestjs/common';
import { PINTEREST_FETCH, PinterestClient, defaultPinterestFetch } from './pinterest.client';
import { PinterestController } from './pinterest.controller';
import { PinterestRateGuard } from './pinterest.rate-guard';
import { PinterestService } from './pinterest.service';

/**
 * OPTIONAL Pinterest integration. With no credentials configured the module is inert: status reports "not configured" and every
 * action refuses with a typed error. PrismaService and CryptoService come from the global PrismaModule.
 */
@Module({
  controllers: [PinterestController],
  providers: [
    PinterestService,
    PinterestClient,
    PinterestRateGuard,
    // The only HTTP function the integration uses. Tests override this token with a mock.
    { provide: PINTEREST_FETCH, useValue: defaultPinterestFetch },
  ],
  exports: [PinterestService],
})
export class PinterestModule {}
