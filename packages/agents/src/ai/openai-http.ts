import { ProviderError, classifyHttpError, toProviderError } from './errors';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Base URL for OpenAI calls. The override exists ONLY so automated tests can point at a local fake
 * server; outside NODE_ENV=test it is ignored, so a stray env var can never redirect requests that
 * carry users' API keys to another host.
 */
export function resolveOpenAIBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LAUNCHPILOT_OPENAI_BASE_URL;
  if (env.NODE_ENV === 'test' && override) return override.replace(/\/$/, '');
  return OPENAI_BASE_URL;
}

export interface OpenAIModelInfo {
  id: string;
  ownedBy: string | null;
  created: number | null;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * Minimal OpenAI HTTP client (Responses API + model list). The API key sits in a true private
 * field, so it cannot leak through JSON.stringify, util.inspect or object spreading, and it is
 * only ever sent as the Authorization header of requests to the configured base URL.
 */
export class OpenAIClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAIClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? resolveOpenAIBaseUrl()).replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** POST /responses. Throws ProviderError (safe message only) on any failure. */
  async createResponse(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#request('POST', '/responses', body, signal);
  }

  /** GET /models: free, lists the model ids this key can see. */
  async listModels(signal?: AbortSignal): Promise<OpenAIModelInfo[]> {
    const json = (await this.#request('GET', '/models', undefined, signal)) as { data?: unknown };
    const data = Array.isArray(json.data) ? json.data : [];
    return data
      .map((m: { id?: unknown; owned_by?: unknown; created?: unknown }) => ({
        id: typeof m.id === 'string' ? m.id : '',
        ownedBy: typeof m.owned_by === 'string' ? m.owned_by : null,
        created: typeof m.created === 'number' ? m.created : null,
      }))
      .filter((m) => m.id);
  }

  async #request(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // An aborted fetch rejects with the signal's reason (a ProviderError when we aborted it).
      if (signal?.aborted && signal.reason instanceof ProviderError) throw signal.reason;
      throw toProviderError(err);
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      if (res.ok) throw new ProviderError('provider_unavailable', { retryable: true, status: res.status });
    }
    if (!res.ok) throw classifyHttpError(res.status, json, res.headers.get('retry-after'));
    return json as Record<string, unknown>;
  }
}
