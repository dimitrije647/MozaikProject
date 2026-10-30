import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CryptoService } from './crypto.service';

@Global()
@Module({ providers: [PrismaService, CryptoService], exports: [PrismaService, CryptoService] })
export class PrismaModule {}
