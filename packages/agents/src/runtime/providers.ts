import {
  AnthropicMessages,
  GeminiGenerateContent,
  OpenAIResponses,
  supportedModels,
  type InferenceRunnerConfig,
} from '@mozaik-ai/core';
import { AnthropicClient, AnthropicTransport, type ClaudeEffort } from '../ai/anthropic-http';
import { OpenAIClient } from '../ai/openai-http';
import { OpenAITransport, type TextTransport } from '../ai/text-transport';

/**
 * LaunchPilot supports exactly these providers, each with the USER's own API key (BYOK).
 * `anthropic` = Claude through a Claude Console API key. A Claude subscription (Claude.ai / Claude Code login) is NOT a provider here:
 * Anthropic does not permit third-party apps to route requests through plan credentials (see CLAUDE_SUBSCRIPTION_MODE).
 */
export type AiProvider = 'openai' | 'gemini' | 'anthropic';
export const AI_PROVIDERS: readonly AiProvider[] = ['openai', 'gemini', 'anthropic'];
/** Providers whose models can run the text agents of a campaign (F1-F4). Gemini keys can be stored, but no campaign phase runs on them yet. */
export const TEXT_AGENT_PROVIDERS: readonly AiProvider[] = ['openai', 'anthropic'];

/** Provider names as used in Mozaik's model specifications. */
const MOZAIK_PROVIDER: Record<AiProvider, string> = { openai: 'openai', gemini: 'google', anthropic: 'anthropic' };

export interface InferenceCredentials {
  provider: AiProvider;
  apiKey: string;
  /** Claude only: the thinking depth chosen in Settings (not a secret). */
  effort?: ClaudeEffort;
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
          : credentials.provider === 'anthropic'
            ? new AnthropicMessages(undefined, { apiKey: credentials.apiKey })
            : new GeminiGenerateContent(undefined, { apiKey: credentials.apiKey }),
    }));
  return { supportedModels: models };
}

export interface TextTransportOptions {
  /** Test seam for the provider's base URL (the backend only passes a value under NODE_ENV=test). */
  baseUrl?: string;
  /** OpenAI only: NO AI HYBRID / Real Content Production refuses every image request in the client itself. */
  forbidImages?: boolean;
  onImageRefused?: () => void;
}

/**
 * The text transport of ONE run, for the provider the user chose. There is no fallback: a Claude run never sends anything to OpenAI and
 * the reverse. `openai` is the OpenAI client when the provider is OpenAI (needed for its image tools), otherwise null.
 */
export function createTextTransport(credentials: InferenceCredentials, options: TextTransportOptions = {}): { transport: TextTransport; openai: OpenAIClient | null } {
  if (credentials.provider === 'openai') {
    const openai = new OpenAIClient({ apiKey: credentials.apiKey, baseUrl: options.baseUrl, forbidImages: options.forbidImages, onImageRefused: options.onImageRefused });
    return { transport: new OpenAITransport(openai), openai };
  }
  if (credentials.provider === 'anthropic') {
    return { transport: new AnthropicTransport(new AnthropicClient({ apiKey: credentials.apiKey, baseUrl: options.baseUrl }), { effort: credentials.effort }), openai: null };
  }
  throw new Error(`The campaign agents cannot run on ${credentials.provider}. Choose OpenAI or Claude in Settings > AI providers.`);
}
