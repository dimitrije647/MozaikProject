import {
  GeminiGenerateContent,
  OpenAIResponses,
  supportedModels,
  type InferenceRunnerConfig,
} from '@mozaik-ai/core';

/** LaunchPilot supports exactly these providers (BYOK). Anthropic is intentionally not offered. */
export type AiProvider = 'openai' | 'gemini';
export const AI_PROVIDERS: readonly AiProvider[] = ['openai', 'gemini'];

/** Provider names as used in Mozaik's model specifications. */
const MOZAIK_PROVIDER: Record<AiProvider, string> = { openai: 'openai', gemini: 'google' };

export interface InferenceCredentials {
  provider: AiProvider;
  apiKey: string;
}

type ModelList = NonNullable<InferenceRunnerConfig['supportedModels']>;

/**
 * Builds the inference configuration for ONE run.
 *
 * Isolation: Mozaik endpoints accept `apiKey` in their constructor, and each run owns its
 * own `defineRuntime()` closure. The key therefore lives only inside this run's endpoint
 * objects. `process.env` is never read or written, so concurrent runs for different users
 * cannot see each other's credentials.
 *
 * Without credentials the model list is empty: any inference attempt fails with
 * "Unsupported model" instead of silently falling back to an environment key.
 */
export function buildInferenceRunnerConfig(credentials?: InferenceCredentials): InferenceRunnerConfig {
  if (!credentials) return { supportedModels: [] };
  if (!AI_PROVIDERS.includes(credentials.provider)) {
    throw new Error(`Unsupported AI provider: ${String(credentials.provider)}`);
  }
  const wanted = MOZAIK_PROVIDER[credentials.provider];
  const models: ModelList = supportedModels
    .filter((m) => m.specification.provider === wanted)
    .map((m) => ({
      specification: m.specification,
      endpoint:
        credentials.provider === 'openai'
          ? new OpenAIResponses(undefined, { apiKey: credentials.apiKey })
          : new GeminiGenerateContent(undefined, { apiKey: credentials.apiKey }),
    }));
  return { supportedModels: models };
}
