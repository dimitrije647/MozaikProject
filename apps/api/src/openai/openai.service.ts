import { HttpException, HttpStatus, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  ImageGenerator,
  OpenAIClient,
  ProviderError,
  SAFE_PROVIDER_MESSAGES,
  explainImageFailure,
  imageModelProblem,
  isSupportedImageModel,
  looksLikeImageModel,
  pickImageModel,
  resolveOpenAIBaseUrl,
  retiredImageModel,
  toProviderError,
  type ProviderErrorCode,
} from '@launchpilot/agents';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ApiCredentialsService } from '../api-credentials/api-credentials.module';
import { PrismaService } from '../common/prisma.service';

const PROVIDER = 'openai';
const TEST_COOLDOWN_MS = 3000;
const IMAGE_TEST_COOLDOWN_MS = 15_000;
const IMAGE_TEST_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const MODELS_TIMEOUT_MS = 15_000;

// Hints only: the model list endpoint does not say which models can do chat/text, so ids that are
// obviously not text models are flagged. The user can still type any id.
const NOT_TEXT = /(embedding|whisper|tts|dall-e|moderation|davinci|babbage|image|sora|realtime|audio|transcribe|speech|computer-use)/i;

export interface ImageTestResult {
  ok: boolean;
  model: string;
  /** false = no request was made (for example the model was shut down by OpenAI). */
  requestMade: boolean;
  latencyMs: number;
  /** The image itself is discarded: this is a capability test, not a deliverable. */
  error?: { code: ProviderErrorCode | 'retired_model' | 'unsupported_model'; stage: string; status: number | null; providerCode: string | null; explanation: string };
}

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
  private readonly lastImageTest = new Map<string, number>();

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
          .map((m) => ({
            id: m.id,
            ownedBy: m.ownedBy,
            created: m.created,
            likelyText: !NOT_TEXT.test(m.id),
            likelyImage: looksLikeImageModel(m.id),
            imageSupported: isSupportedImageModel(m.id),
            // OpenAI keeps LISTING shut-down models: a listing never means the model still accepts requests
            retired: retiredImageModel(m.id) ? { on: retiredImageModel(m.id)!.retiredOn, replacements: retiredImageModel(m.id)!.replacements } : null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        suggestedImageModel: pickImageModel(models.map((m) => m.id)),
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

  /**
   * "Test image model": ONE real image request (lowest quality, smallest size, a plain prompt), made ONLY when the user presses the
   * button. It is billed by OpenAI like any image. The picture is discarded. A model that OpenAI shut down is refused without a request.
   * This is the only reliable proof that a model works for the account: GET /models can list models that no longer accept requests.
   */
  async testImageModel(userId: string, requested: string): Promise<ImageTestResult> {
    const cred = await this.requireCredential(userId);
    let model = requested;
    if (model === 'auto') {
      const client = new OpenAIClient({ apiKey: cred.apiKey, baseUrl: resolveOpenAIBaseUrl() });
      try {
        model = pickImageModel((await client.listModels(AbortSignal.timeout(MODELS_TIMEOUT_MS))).map((m) => m.id)) ?? '';
      } catch (err) {
        throw providerHttpError(err);
      }
      if (!model) throw new UnprocessableEntityException('Your key lists no current GPT Image model to test.');
    }
    const problem = imageModelProblem(model);
    if (problem) {
      const retired = !!retiredImageModel(model);
      return { ok: false, model, requestMade: false, latencyMs: 0, error: { code: retired ? 'retired_model' : 'unsupported_model', stage: 'configuration', status: null, providerCode: null, explanation: problem } };
    }
    const now = Date.now();
    if (now - (this.lastImageTest.get(userId) ?? 0) < IMAGE_TEST_COOLDOWN_MS) throw new HttpException('Please wait a few seconds before testing an image model again (each test is billed by OpenAI).', HttpStatus.TOO_MANY_REQUESTS);
    this.lastImageTest.set(userId, now);

    const started = Date.now();
    const client = new OpenAIClient({ apiKey: cred.apiKey, baseUrl: resolveOpenAIBaseUrl() });
    const images = new ImageGenerator(client, { maxImages: 1, maxRegenerations: 0, maxRetries: 0, timeoutMs: IMAGE_TEST_TIMEOUT_MS });
    const res = await images.generate('A plain light-blue square with one small white circle in the middle. No text, no letters, no logos.', { model, quality: 'low', size: '1024x1024' }, { signal: AbortSignal.timeout(IMAGE_TEST_TIMEOUT_MS + 5000) });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, kind: 'image', ok: true });
      return { ok: true, model, requestMade: true, latencyMs };
    }
    const why = explainImageFailure(model, res.error);
    await this.activity.log(userId, 'integration.tested', undefined, { providerKey: PROVIDER, model, kind: 'image', ok: false, code: res.error.code });
    return { ok: false, model, requestMade: true, latencyMs, error: { code: res.error.code, stage: why.stage, status: res.error.status ?? null, providerCode: res.error.providerCode ?? null, explanation: why.explanation } };
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
