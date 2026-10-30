import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConnectionType, IntegrationStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PROVIDER_CATALOG } from './provider-catalog';
import { getConnector } from './connectors';
import { ConfigureApiKeyDto, ConnectPlaceholderDto } from './integrations.dto';

@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private credentials: ApiCredentialsService,
    private activity: ActivityLogService,
  ) {}

  async onModuleInit() {
    for (const p of PROVIDER_CATALOG) {
      await this.prisma.integrationProvider.upsert({
        where: { key: p.key },
        create: { ...p },
        update: { name: p.name, category: p.category, description: p.description, authType: p.authType },
      });
    }
  }

  providers() {
    return this.prisma.integrationProvider.findMany({ where: { isEnabled: true }, orderBy: { name: 'asc' } });
  }

  /** Current user's integration state. Contains no secrets, only masked credentials. */
  async mine(userId: string) {
    const [items, user] = await Promise.all([
      this.prisma.userIntegration.findMany({ where: { userId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    return {
      defaultAiProvider: user.defaultAiProvider,
      integrations: items.map((i) => ({
        providerKey: i.providerKey,
        status: i.status,
        connectionType: i.connectionType,
        displayName: i.displayName,
        externalAccountId: i.externalAccountId,
        maskedCredential: i.maskedCredential,
        connectedAt: i.connectedAt,
        updatedAt: i.updatedAt,
      })),
    };
  }

  private async provider(key: string) {
    const provider = await this.prisma.integrationProvider.findUnique({ where: { key } });
    if (!provider || !provider.isEnabled) throw new NotFoundException(`Unknown provider: ${key}`);
    return provider;
  }

  async configureApiKey(userId: string, dto: ConfigureApiKeyDto) {
    const provider = await this.provider(dto.providerKey);
    if (provider.authType !== 'api_key') {
      throw new BadRequestException(`${provider.name} is connected with OAuth, not an API key`);
    }
    const saved = await this.credentials.save(userId, provider.key, dto.apiKey, dto.label);
    if (dto.setAsDefault) await this.credentials.setDefault(userId, provider.key);
    await this.prisma.userIntegration.upsert({
      where: { userId_providerKey: { userId, providerKey: provider.key } },
      create: {
        userId,
        providerKey: provider.key,
        status: IntegrationStatus.CONFIGURED,
        connectionType: ConnectionType.API_KEY,
        displayName: dto.label?.trim() || provider.name,
        maskedCredential: saved.maskedKey,
        connectedAt: new Date(),
      },
      update: {
        status: IntegrationStatus.CONFIGURED,
        connectionType: ConnectionType.API_KEY,
        displayName: dto.label?.trim() || provider.name,
        maskedCredential: saved.maskedKey,
        connectedAt: new Date(),
      },
    });
    await this.activity.log(userId, 'integration.configured', undefined, { providerKey: provider.key });
    return this.mine(userId);
  }

  /** PLACEHOLDER connect flow for OAuth providers; see connectors.ts. */
  async connectPlaceholder(userId: string, dto: ConnectPlaceholderDto) {
    const provider = await this.provider(dto.providerKey);
    if (provider.authType !== 'oauth') {
      throw new BadRequestException(`${provider.name} uses an API key. Use configure-api-key.`);
    }
    const result = await getConnector(provider.key).connect(userId, { displayName: dto.displayName });
    const data = {
      status: IntegrationStatus.CONNECTED,
      connectionType: ConnectionType.PLACEHOLDER,
      displayName: result.displayName,
      externalAccountId: result.externalAccountId ?? null,
      metadataJson: (result.metadata ?? {}) as object,
      connectedAt: new Date(),
    };
    await this.prisma.userIntegration.upsert({
      where: { userId_providerKey: { userId, providerKey: provider.key } },
      create: { userId, providerKey: provider.key, ...data },
      update: data,
    });
    await this.activity.log(userId, 'integration.connected', undefined, { providerKey: provider.key });
    return this.mine(userId);
  }

  async disconnect(userId: string, providerKey: string) {
    const provider = await this.provider(providerKey);
    if (provider.authType === 'api_key') {
      await this.credentials.remove(userId, provider.key);
    } else {
      await getConnector(provider.key).disconnect(userId);
    }
    await this.prisma.userIntegration.deleteMany({ where: { userId, providerKey: provider.key } });
    await this.activity.log(userId, 'integration.disconnected', undefined, { providerKey: provider.key });
    return this.mine(userId);
  }
}
