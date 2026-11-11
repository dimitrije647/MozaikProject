import Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessages, type InferenceInput } from '@mozaik-ai/core';
import { ProviderError, classifyHttpError, toProviderError } from './errors';
import { claudeCostUsd, claudeReserveUsd, maxOutputTokensFor } from './pricing';
import type { AttachedImage, TextCall, TextResult, TextTransport } from './text-transport';

/**
 * CLAUDE THROUGH THE CLAUDE API ONLY.
 *
 * LaunchPilot authenticates to Anthropic with the user's own Claude Console API key and nothing else. It never reads, copies or forwards a
 * Claude.ai / Claude Code subscription credential, OAuth token, session cookie or local credential file, and it never starts or proxies
 * through a Claude Code process. Anthropic's terms do not permit a third-party application to route requests through Free/Pro/Max/Ultra plan
 * credentials on behalf of its users (https://code.claude.com/docs/en/legal-and-compliance, "Authentication and credential use"); a
 * subscription-based mode is therefore reported as unavailable (see `CLAUDE_SUBSCRIPTION_MODE`). Max, Ultra and Team plans include monthly
 * API credits that a Console organization can draw on with an ordinary API key, which is the supported way to use a plan's allowance here.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The test seam: honored ONLY under NODE_ENV=test, so a stray variable can never send users' keys to another host. */
export function resolveAnthropicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LAUNCHPILOT_ANTHROPIC_BASE_URL;
  if (env.NODE_ENV === 'test' && override) return override.replace(/\/$/, '');
  return ANTHROPIC_BASE_URL;
}

/** Why the subscription mode is not offered, with the official sources. Shown in Settings > AI providers. */
export const CLAUDE_SUBSCRIPTION_MODE = {
  available: false as const,
  status: 'unsupported' as const,
  reason:
    'Anthropic does not permit third-party applications to offer Claude.ai login or to route requests through Free, Pro, Max or Ultra plan credentials, and developers may not collect, store or intermediate Claude.ai credentials or session tokens. LaunchPilot therefore uses Claude only through a Claude Console API key. If you have a Max, Ultra or Team plan, its monthly API credits can be linked to a Console organization and used by that key.',
  sources: [
    'https://code.claude.com/docs/en/legal-and-compliance',
    'https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account',
    'https://platform.claude.com/docs/en/manage-claude/authentication',
    'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
  ],
};

export type ClaudeEffort = 'low' | 'medium' | 'high';
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high'];
/**
 * Current Claude models think adaptively and that thinking counts against `max_tokens`. A JSON answer that LaunchPilot capped at N tokens
 * would be cut off by the thinking before it starts, so this headroom is added on top. The reservation uses the full value, so the budget
 * stays a true worst case.
 */
const THINKING_HEADROOM: Record<ClaudeEffort, number> = { low: 1024, medium: 4096, high: 8192 };

export interface ClaudeModelInfo {
  id: string;
  displayName: string | null;
  createdAt: string | null;
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * Minimal Claude API client on the official SDK. The key lives in a private field; the SDK is told explicitly to use only that key
 * (`authToken: null`, explicit `baseURL`), so it can never pick up an environment token, a login profile or another user's credential.
 * SDK retries are off: the gateway owns retries, the call budget and the spend ledger.
 */
export class AnthropicClient {
  readonly #sdk: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.#sdk = new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      baseURL: (options.baseUrl ?? resolveAnthropicBaseUrl()).replace(/\/$/, ''),
      maxRetries: 0,
      timeout: 600_000, // the gateway's own AbortSignal is the real clock
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** POST /v1/messages. Throws ProviderError (safe message only) on any failure. */
  async createMessage(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return (await this.#sdk.messages.create(body as never, { signal })) as unknown as Record<string, unknown>;
    } catch (err) {
      throw fromSdkError(err, signal);
    }
  }

  /** GET /v1/models: free, lists the model ids this key can use. */
  async listModels(signal?: AbortSignal): Promise<ClaudeModelInfo[]> {
    try {
      const out: ClaudeModelInfo[] = [];
      for await (const m of this.#sdk.models.list({ limit: 100 }, { signal })) {
        const r = m as unknown as { id?: unknown; display_name?: unknown; created_at?: unknown };
        if (typeof r.id === 'string' && r.id) out.push({ id: r.id, displayName: typeof r.display_name === 'string' ? r.display_name : null, createdAt: typeof r.created_at === 'string' ? r.created_at : null });
        if (out.length >= 500) break;
      }
      return out;
    } catch (err) {
      throw fromSdkError(err, signal);
    }
  }
}

/** SDK errors become ProviderErrors built from status and the machine-readable error type only (never the provider's text as-is). */
function fromSdkError(err: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted && signal.reason instanceof ProviderError) return signal.reason;
  // the SDK reports every abort as a user abort: the signal's reason says whether it was the per-request clock
  if (signal?.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') return new ProviderError('timeout');
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('cancelled');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout');
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const h = err.headers as { get?: (k: string) => string | null } | undefined;
    return classifyHttpError(err.status, err.error, typeof h?.get === 'function' ? h.get('retry-after') : null);
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('provider_unavailable', { retryable: true });
  return toProviderError(err);
}

// Mozaik's Anthropic mapper (ModelContext <-> Messages API content blocks). Constructing the endpoint only stores config; no client is made.
const claudeMapper = new AnthropicMessages().endpointMapper;

/** Claude structured outputs accept a subset of JSON Schema: unions as anyOf, no numeric/string/array bounds (zod still enforces them). */
export function toClaudeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toClaudeSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems', 'pattern', '$schema', 'default'].includes(k)) continue;
    if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
    out[k === 'oneOf' ? 'anyOf' : k] = toClaudeSchema(v);
  }
  return out;
}

export interface AnthropicTransportOptions {
  /** Thinking depth / token spend (`output_config.effort`). Explicit, so model defaults (which differ per model) never change behaviour silently. */
  effort?: ClaudeEffort;
}

/** The Claude Messages API as a gateway transport. */
export class AnthropicTransport implements TextTransport {
  readonly provider = 'anthropic' as const;
  private readonly effort: ClaudeEffort;
  constructor(readonly client: AnthropicClient, options: AnthropicTransportOptions = {}) {
    this.effort = options.effort ?? 'medium';
  }

  build(input: InferenceInput, cap: number, images: AttachedImage[] | undefined): TextCall {
    const req = claudeMapper.toRequest({ ...input, maxOutputTokens: cap, reasoningEffort: undefined, streaming: false }) as Record<string, unknown> & {
      messages: { role: string; content: unknown[] }[];
      output_config?: { format?: { type: string; schema: unknown }; effort?: string };
    };
    if (images?.length) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      if (lastUser) for (const img of images) lastUser.content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
    const outputConfig: Record<string, unknown> = { ...(req.output_config ?? {}), effort: this.effort };
    if (req.output_config?.format) outputConfig.format = { type: 'json_schema', schema: toClaudeSchema(req.output_config.format.schema) };
    const limit = maxOutputTokensFor(input.model).limit;
    const maxTokens = Math.min(limit, cap + THINKING_HEADROOM[this.effort]);
    // no temperature/top_p/top_k (rejected by current Claude models), no prefill, no fallbacks: the model the user chose is the model that answers
    const body = { ...req, max_tokens: maxTokens, output_config: outputConfig };
    delete (body as Record<string, unknown>).thinking; // current models think adaptively by default; `effort` controls the depth
    return { body, model: input.model, maxTokens };
  }

  send(call: TextCall, signal: AbortSignal) {
    return this.client.createMessage(call.body, signal);
  }

  parse(raw: Record<string, unknown>, call: TextCall): TextResult {
    const content = Array.isArray(raw.content) ? raw.content : [];
    const output = claudeMapper.toResponse({ ...raw, content });
    const usage = raw.usage as Record<string, number | null> | undefined;
    return {
      output,
      cutOff: raw.stop_reason === 'max_tokens',
      refused: raw.stop_reason === 'refusal',
      costUsd: usage ? claudeCostUsd(call.model, usage) : null,
    };
  }

  reserveUsd(call: TextCall) {
    return claudeReserveUsd(call.model, JSON.stringify(call.body).length, call.maxTokens);
  }
}
