import { HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  OpenAIClient,
  ProviderError,
  SAFE_PROVIDER_MESSAGES,
  resolveOpenAIBaseUrl,
  toProviderError,
  type ProviderErrorCode,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';

const PROVIDER = 'openai';
const TEST_COOLDOWN_MS = 3000;
const TEST_TIMEOUT_MS = 30_000;
const MODELS_TIMEOUT_MS = 15_000;

// Hints only: the model list endpoint does not say which models can do chat/text, so ids that are
// obviously not text models are flagged. The user can still type any id.
const NOT_TEXT = /(embedding|whisper|tts|dall-e|moderation|davinci|babbage|image|sora|realtime|audio|transcribe|speech|computer-use)/i;

export interface ConnectionTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  /** true: OpenAI accepted the key. false: it rejected it. null: could not tell (outage, timeout). */
  keyAccepted: boolean | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: { code: ProviderErrorCode; message: string };
}

/** Provider errors become safe API errors: fixed message + code, never the provider's own text. */
export function providerHttpError(err: unknown): HttpException {
  const pe = toProviderError(err);
  return new HttpException({ statusCode: HttpStatus.UNPROCESSABLE_ENTITY, message: pe.message, code: pe.code }, HttpStatus.UNPROCESSABLE_ENTITY);
}

@Injectable()
export class OpenAiService {
  private readonly lastTest = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private credentials: ApiCredentialsService,
    private activity: ActivityLogService,
  ) {}

  /** Safe status for the UI: only masked data. */
  async status(userId: string) {
    const [cred, user] = await Promise.all([
      this.prisma.apiCredential.findUnique({ where: { userId_providerKey: { userId, providerKey: PROVIDER } } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultAiProvider: true } }),
    ]);
    if (!cred) {
      return { configured: false, maskedKey: null, model: null, verifiedModel: null, verifiedAt: null, ready: false, isDefault: false };
    }
    return {
      configured: true,
      maskedKey: cred.maskedKey,
      model: cred.model,
      verifiedModel: cred.verifiedModel,
      verifiedAt: cred.verifiedAt,
      ready: !!cred.model && cred.verifiedModel === cred.model,
      isDefault: user.defaultAiProvider === PROVIDER,
    };
  }

  /**
   * Lists the model ids visible to the user's key (GET /models: free, no inference). It does not
   * select anything and never changes the user's model.
   */
  async listModels(userId: string) {
    const cred = await this.requireCredential(userId);
    try {
      const client = new OpenAIClient({ apiKey: cred.apiKey, baseUrl: resolveOpenAIBaseUrl() });
      const models = await client.listModels(AbortSignal.timeout(MODELS_TIMEOUT_MS));
      return {
        selected: cred.model,
        models: models
          .map((m) => ({ id: m.id, ownedBy: m.ownedBy, created: m.created, likelyText: !NOT_TEXT.test(m.id) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    } catch (err) {
      throw providerHttpError(err);
    }
  }

  async setModel(userId: string, model: string) {
    await this.credentials.setModel(userId, PROVIDER, model);
    return this.status(userId);
  }

  /**
   * "Test connection": ONE minimal real inference call (a few dozen tokens) against the chosen
   * model, made only when the user explicitly asks. Success marks that exact model as verified.
   * Failures return a safe, fixed message; the provider's own error text is never passed on.
   */
  async testConnection(userId: string, modelOverride?: string): Promise<ConnectionTestResult> {
    const cred = await this.requireCredential(userId);
    const model = modelOverride ?? cred.model;
    if (!model) throw new UnprocessableEntityException('Choose a model first (Settings > AI providers).');

    // Guard against accidental repeated paid calls (double clicks).
    const now = Date.now();
    if (now - (this.lastTest.get(userId) ?? 0) < TEST_COOLDOWN_MS) {
      throw new HttpException('Please wait a few seconds before testing again.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastTest.set(userId, now);

    if (modelOverride && modelOverride !== cred.model) await this.credentials.setModel(userId, PROVIDER, modelOverride);

    const started = Date.now();
    try {
      const client = new OpenAIClient({ apiKey: cred.apiKey, baseUrl: resolveOpenAIBaseUrl() });
      const res = (await client.createResponse(
        { model, input: 'Reply with the single word OK.', max_output_tokens: 32, store: false },
        AbortSignal.timeout(TEST_TIMEOUT_MS),
      )) as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      await this.credentials.markVerified(userId, PROVIDER, model);
      await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, ok: true });
      const u = res.usage;
      return {
        ok: true,
        model,
        latencyMs: Date.now() - started,
        keyAccepted: true,
        usage: u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } : undefined,
      };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : toProviderError(err);
      // A failed test must never leave an older "verified" mark on a model that no longer works.
      await this.credentials.clearVerification(userId, PROVIDER);
      await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, ok: false, code: pe.code });
      return {
        ok: false,
        model,
        latencyMs: Date.now() - started,
        keyAccepted: keyAccepted(pe.code),
        error: { code: pe.code, message: SAFE_PROVIDER_MESSAGES[pe.code] },
      };
    }
  }

  private async requireCredential(userId: string) {
    const cred = await this.credentials.getDecryptedCredential(userId, PROVIDER);
    if (!cred) throw new NotFoundException('No OpenAI API key is configured. Add one under Settings > AI providers.');
    return cred;
  }
}

function keyAccepted(code: ProviderErrorCode): boolean | null {
  if (code === 'invalid_api_key') return false;
  if (code === 'provider_unavailable' || code === 'timeout' || code === 'cancelled') return null;
  return true; // model_unavailable, permission_denied, insufficient_quota, rate_limited, bad_request: past authentication
}
