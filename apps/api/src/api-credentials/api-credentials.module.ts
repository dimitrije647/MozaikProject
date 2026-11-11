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

import { CLAUDE_SUBSCRIPTION_MODE, TEXT_AGENT_PROVIDERS } from '@launchpilot/agents';

/** Providers whose keys can be stored for BYOK and used by AI agents later. `anthropic` = Claude through a Claude Console API key. */
export const AI_PROVIDER_KEYS = ['openai', 'gemini', 'anthropic'] as const;

/** Names a client might send for a Claude SUBSCRIPTION mode. It is not offered (see CLAUDE_SUBSCRIPTION_MODE) and is refused explicitly. */
const SUBSCRIPTION_MODE_KEYS = /^(claude|anthropic)[-_ ]?(subscription|plan|pro|max|ultra|oauth|code|login)$/i;

/**
 * Claude keys: only a Claude Console API key (`sk-ant-api...`) is accepted. A Claude.ai / Claude Code OAuth token (`sk-ant-oat...`) is a
 * subscription credential that a third-party app must not collect or use, and an Admin key (`sk-ant-admin...`) cannot call the Messages API.
 */
export function claudeKeyProblem(key: string): string | null {
  if (/^sk-ant-oat/i.test(key)) return 'That is a Claude subscription sign-in token (from a Claude.ai or Claude Code login). LaunchPilot never accepts or stores subscription credentials. Create an API key in Claude Console (platform.claude.com > API keys) instead.';
  if (/^sk-ant-admin/i.test(key)) return 'That is an Anthropic Admin API key, which cannot run Claude models. Create a regular API key in Claude Console.';
  if (!/^sk-ant-api/i.test(key)) return 'That does not look like a Claude Console API key (they start with "sk-ant-api").';
  return null;
}

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
      model: c.model,
      verifiedModel: c.verifiedModel,
      verifiedAt: c.verifiedAt,
      // Ready = a model is chosen AND a real test call succeeded for exactly that model.
      ready: !!c.model && c.verifiedModel === c.model,
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
    if (providerKey === 'anthropic') {
      const problem = claudeKeyProblem(key);
      if (problem) throw new BadRequestException(problem);
    }
    const data = {
      label: label?.trim() || `${providerKey} key`,
      maskedKey: this.crypto.mask(key),
      encryptedKey: this.crypto.encrypt(key),
      isActive: true,
      // A new key has not been tested yet.
      verifiedModel: null,
      verifiedAt: null,
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

  /** Stores the model the user chose for a provider. Does not call the provider. */
  async setModel(userId: string, providerKey: string, model: string) {
    const cred = await this.prisma.apiCredential.findUnique({ where: { userId_providerKey: { userId, providerKey } } });
    if (!cred) throw new NotFoundException('Save an API key for this provider first');
    await this.prisma.apiCredential.update({ where: { id: cred.id }, data: { model } });
    await this.activity.log(userId, 'credential.model_changed', undefined, { providerKey, model });
  }

  /** Records a successful real test call for `model` (the only thing that makes a provider "ready"). */
  async markVerified(userId: string, providerKey: string, model: string) {
    await this.prisma.apiCredential.updateMany({ where: { userId, providerKey }, data: { verifiedModel: model, verifiedAt: new Date() } });
  }

  async clearVerification(userId: string, providerKey: string) {
    await this.prisma.apiCredential.updateMany({ where: { userId, providerKey }, data: { verifiedModel: null, verifiedAt: null } });
  }

  async setDefault(userId: string, providerKey: string) {
    if (SUBSCRIPTION_MODE_KEYS.test(providerKey.trim())) throw new BadRequestException(`A Claude subscription mode is not available: ${CLAUDE_SUBSCRIPTION_MODE.reason}`);
    if (!(AI_PROVIDER_KEYS as readonly string[]).includes(providerKey)) throw new BadRequestException(`${providerKey} is not an AI provider LaunchPilot supports.`);
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
   * Server-side only. Decrypted key plus the user's chosen model for one provider. The lookup is
   * keyed by `userId`, so one user's key can never be returned for another user's request.
   */
  async getDecryptedCredential(userId: string, providerKey: string) {
    const cred = await this.prisma.apiCredential.findUnique({ where: { userId_providerKey: { userId, providerKey } } });
    if (!cred || !cred.isActive) return null;
    return { providerKey, apiKey: this.crypto.decrypt(cred.encryptedKey), model: cred.model, verifiedModel: cred.verifiedModel };
  }

  /**
   * Server-side only, for the agent runtime. Returns the user's decrypted key
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

/**
 * Settings > AI providers: the ONE persistent configuration. The default provider (User.defaultAiProvider) and its chosen model
 * (ApiCredential.model) are stored server-side and used by every new project, campaign, factory run, agent and continuation until the user
 * changes them. Contains no secrets (masked keys only).
 */
@Controller('ai-providers')
export class AiProvidersController {
  constructor(private svc: ApiCredentialsService) {}

  @Get()
  async overview(@CurrentUser() u: AuthUser) {
    const creds = await this.svc.list(u.id);
    const def = creds.find((c) => c.isDefault)?.providerKey ?? null;
    const view = (key: 'openai' | 'anthropic') => {
      const c = creds.find((x) => x.providerKey === key);
      return {
        provider: key,
        mode: 'api_key' as const,
        configured: !!c,
        maskedKey: c?.maskedKey ?? null,
        model: c?.model ?? null,
        verifiedModel: c?.verifiedModel ?? null,
        ready: !!c?.ready,
        isDefault: def === key,
        status: !c ? 'not_configured' : !c.model ? 'no_model' : c.ready ? 'ready' : 'not_verified',
      };
    };
    return {
      defaultProvider: def,
      textProvider: def && (TEXT_AGENT_PROVIDERS as readonly string[]).includes(def) ? def : null,
      providers: { openai: view('openai'), anthropic: view('anthropic') },
      claudeSubscription: CLAUDE_SUBSCRIPTION_MODE,
      billing: 'Every model call is billed by the provider to YOUR key. LaunchPilot never switches providers or models on its own, and nothing is sent before you start a run (or press "Test connection").',
    };
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
  controllers: [ApiCredentialsController, AiProvidersController],
  exports: [ApiCredentialsService],
})
export class ApiCredentialsModule {}
