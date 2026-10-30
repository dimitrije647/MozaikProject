import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

/** Providers whose keys can be stored for BYOK and used by AI agents later. */
export const AI_PROVIDER_KEYS = ['openai', 'gemini'] as const;

class SetDefaultDto {
  @IsString() @MinLength(1) @MaxLength(40) providerKey: string;
}

@Injectable()
export class ApiCredentialsService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private activity: ActivityLogService,
  ) {}

  /** Raw keys never leave the server: only masked values are returned. */
  async list(userId: string) {
    const [creds, user] = await Promise.all([
      this.prisma.apiCredential.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    return creds.map((c) => ({
      id: c.id,
      providerKey: c.providerKey,
      label: c.label,
      maskedKey: c.maskedKey,
      isActive: c.isActive,
      isDefault: user.defaultAiProvider === c.providerKey,
      updatedAt: c.updatedAt,
    }));
  }

  async save(userId: string, providerKey: string, apiKey: string, label?: string) {
    if (!(AI_PROVIDER_KEYS as readonly string[]).includes(providerKey)) {
      throw new BadRequestException(`${providerKey} does not use an API key`);
    }
    const key = apiKey.trim();
    // Format check only. Live validation against the provider is a future step.
    if (key.length < 20 || /\s/.test(key)) {
      throw new BadRequestException('That does not look like a valid API key');
    }
    const data = {
      label: label?.trim() || `${providerKey} key`,
      maskedKey: this.crypto.mask(key),
      encryptedKey: this.crypto.encrypt(key),
      isActive: true,
    };
    await this.prisma.apiCredential.upsert({
      where: { userId_providerKey: { userId, providerKey } },
      create: { userId, providerKey, ...data },
      update: data,
    });
    // The first stored key becomes the default automatically.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.defaultAiProvider) {
      await this.prisma.user.update({ where: { id: userId }, data: { defaultAiProvider: providerKey } });
    }
    await this.activity.log(userId, 'credential.saved', undefined, { providerKey });
    return { providerKey, maskedKey: data.maskedKey };
  }

  async setDefault(userId: string, providerKey: string) {
    const cred = await this.prisma.apiCredential.findUnique({
      where: { userId_providerKey: { userId, providerKey } },
    });
    if (!cred) throw new NotFoundException('Save an API key for this provider first');
    await this.prisma.user.update({ where: { id: userId }, data: { defaultAiProvider: providerKey } });
    await this.activity.log(userId, 'credential.default_changed', undefined, { providerKey });
    return { defaultProvider: providerKey };
  }

  async remove(userId: string, providerKey: string) {
    await this.prisma.apiCredential.deleteMany({ where: { userId, providerKey } });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.defaultAiProvider === providerKey) {
      const next = await this.prisma.apiCredential.findFirst({ where: { userId } });
      await this.prisma.user.update({
        where: { id: userId },
        data: { defaultAiProvider: next?.providerKey ?? null },
      });
    }
    await this.activity.log(userId, 'credential.removed', undefined, { providerKey });
    return { ok: true };
  }

  /**
   * Server-side only, for the future agent runtime. Returns the user's decrypted key
   * for a provider (or their default). Never expose this through a controller.
   */
  async getDecryptedKey(userId: string, providerKey?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const key = providerKey ?? user.defaultAiProvider;
    if (!key) return null;
    const cred = await this.prisma.apiCredential.findUnique({
      where: { userId_providerKey: { userId, providerKey: key } },
    });
    return cred?.isActive ? { providerKey: key, apiKey: this.crypto.decrypt(cred.encryptedKey) } : null;
  }
}

@Controller('api-credentials')
export class ApiCredentialsController {
  constructor(private svc: ApiCredentialsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.id);
  }

  @Put('default')
  setDefault(@CurrentUser() u: AuthUser, @Body() dto: SetDefaultDto) {
    return this.svc.setDefault(u.id, dto.providerKey);
  }

  @Delete(':providerKey')
  remove(@CurrentUser() u: AuthUser, @Param('providerKey') providerKey: string) {
    return this.svc.remove(u.id, providerKey);
  }
}

@Module({
  providers: [ApiCredentialsService],
  controllers: [ApiCredentialsController],
  exports: [ApiCredentialsService],
})
export class ApiCredentialsModule {}
