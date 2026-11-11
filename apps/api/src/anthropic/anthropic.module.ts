import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Injectable, Module, NotFoundException, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import {
  AnthropicClient,
  CLAUDE_PRICED_MODELS,
  CLAUDE_PRICE_BOOK_VERIFIED_AT,
  CLAUDE_SUBSCRIPTION_MODE,
  ProviderError,
  claudePrice,
  resolveAnthropicBaseUrl,
  toProviderError,
  type ProviderErrorCode,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ApiCredentialsModule, ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { providerHttpError } from '../openai/openai.service';

const PROVIDER = 'anthropic';
const TEST_COOLDOWN_MS = 3000;
const TEST_TIMEOUT_MS = 30_000;
const MODELS_TIMEOUT_MS = 15_000;

/** Claude model ids ("claude-opus-5-5"). Only ids of this shape are stored for the Claude provider. */
export const CLAUDE_MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9.-]{1,60}$/;

class SetClaudeModelDto {
  @IsString() @Matches(CLAUDE_MODEL_PATTERN, { message: 'model must be a Claude model id such as claude-opus-5-5' }) model: string;
}
class TestClaudeDto {
  @IsOptional() @IsString() @Matches(CLAUDE_MODEL_PATTERN, { message: 'model must be a Claude model id such as claude-opus-5-5' }) model?: string;
}

/**
 * Claude through the Claude API with the user's OWN Console API key. The key is stored encrypted per user (ApiCredential) and never returned.
 * No subscription credential of any kind is read, accepted or forwarded (see CLAUDE_SUBSCRIPTION_MODE).
 */
@Injectable()
export class AnthropicService {
  private readonly lastTest = new Map<string, number>();
  constructor(
    private prisma: PrismaService,
    private credentials: ApiCredentialsService,
    private activity: ActivityLogService,
  ) {}

  async status(userId: string) {
    const [cred, user] = await Promise.all([
      this.prisma.apiCredential.findUnique({ where: { userId_providerKey: { userId, providerKey: PROVIDER } } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    const base = { mode: 'api_key' as const, subscription: CLAUDE_SUBSCRIPTION_MODE, isDefault: user.defaultAiProvider === PROVIDER };
    if (!cred) return { ...base, configured: false, maskedKey: null, model: null, verifiedModel: null, verifiedAt: null, ready: false, priced: false };
    return {
      ...base,
      configured: true,
      maskedKey: cred.maskedKey,
      model: cred.model,
      verifiedModel: cred.verifiedModel,
      verifiedAt: cred.verifiedAt,
      ready: !!cred.model && cred.verifiedModel === cred.model,
      priced: !!claudePrice(cred.model),
    };
  }

  /** GET /v1/models with the user's key: free, selects nothing. Each model says whether LaunchPilot has a verified API price for it. */
  async listModels(userId: string) {
    const cred = await this.requireCredential(userId);
    try {
      const client = new AnthropicClient({ apiKey: cred.apiKey, baseUrl: resolveAnthropicBaseUrl() });
      const models = await client.listModels(AbortSignal.timeout(MODELS_TIMEOUT_MS));
      return {
        selected: cred.model,
        priceBookVerifiedAt: CLAUDE_PRICE_BOOK_VERIFIED_AT,
        pricedModels: CLAUDE_PRICED_MODELS,
        models: models.map((m) => {
          const p = claudePrice(m.id);
          return { id: m.id, displayName: m.displayName, createdAt: m.createdAt, priced: !!p, inputPerM: p?.inputPerM ?? null, outputPerM: p?.outputPerM ?? null };
        }),
      };
    } catch (err) {
      throw providerHttpError(err);
    }
  }

  async setModel(userId: string, model: string) {
    await this.credentials.setModel(userId, PROVIDER, model);
    return this.status(userId);
  }

  /** ONE minimal real Claude call (a few dozen tokens, billed to the user's key), made only when the user presses the button. */
  async testConnection(userId: string, modelOverride?: string) {
    const cred = await this.requireCredential(userId);
    const model = modelOverride ?? cred.model;
    if (!model) throw new UnprocessableEntityException('Choose a Claude model first (Settings > AI providers).');
    const now = Date.now();
    if (now - (this.lastTest.get(userId) ?? 0) < TEST_COOLDOWN_MS) throw new HttpException('Please wait a few seconds before testing again.', HttpStatus.TOO_MANY_REQUESTS);
    this.lastTest.set(userId, now);
    if (modelOverride && modelOverride !== cred.model) await this.credentials.setModel(userId, PROVIDER, modelOverride);

    const started = Date.now();
    try {
      const client = new AnthropicClient({ apiKey: cred.apiKey, baseUrl: resolveAnthropicBaseUrl() });
      const res = (await client.createMessage({ model, max_tokens: 256, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, AbortSignal.timeout(TEST_TIMEOUT_MS))) as { usage?: { input_tokens?: number; output_tokens?: number } };
      await this.credentials.markVerified(userId, PROVIDER, model);
      await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, ok: true });
      const u = res.usage;
      return { ok: true, model, latencyMs: Date.now() - started, keyAccepted: true, usage: u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } : undefined };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : toProviderError(err);
      await this.credentials.clearVerification(userId, PROVIDER);
      await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, ok: false, code: pe.code });
      return { ok: false, model, latencyMs: Date.now() - started, keyAccepted: keyAccepted(pe.code), error: { code: pe.code, message: pe.message } };
    }
  }

  private async requireCredential(userId: string) {
    const cred = await this.credentials.getDecryptedCredential(userId, PROVIDER);
    if (!cred) throw new NotFoundException('No Claude API key is configured. Add a Claude Console API key under Settings > AI providers.');
    return cred;
  }
}

function keyAccepted(code: ProviderErrorCode): boolean | null {
  if (code === 'invalid_api_key') return false;
  if (code === 'provider_unavailable' || code === 'timeout' || code === 'cancelled') return null;
  return true;
}

@Controller('integrations/anthropic')
export class AnthropicController {
  constructor(private svc: AnthropicService) {}

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.svc.status(u.id);
  }

  /** Free: lists the Claude models this key can use. Never selects one. */
  @Get('models')
  models(@CurrentUser() u: AuthUser) {
    return this.svc.listModels(u.id);
  }

  @Put('model')
  setModel(@CurrentUser() u: AuthUser, @Body() dto: SetClaudeModelDto) {
    return this.svc.setModel(u.id, dto.model);
  }

  /** Makes ONE tiny paid Claude call, only when explicitly requested. */
  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() u: AuthUser, @Body() dto: TestClaudeDto) {
    return this.svc.testConnection(u.id, dto.model);
  }
}

@Module({
  imports: [ApiCredentialsModule],
  providers: [AnthropicService],
  controllers: [AnthropicController],
})
export class AnthropicModule {}
