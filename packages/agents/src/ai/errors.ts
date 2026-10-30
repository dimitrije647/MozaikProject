/**
 * Provider errors, reduced to a small closed set of codes with FIXED, safe messages.
 *
 * Provider error bodies can echo parts of the API key ("Incorrect API key provided: sk-...abcd")
 * or other request details, so their `message` text is never copied into our errors, events,
 * logs or API responses. Only the HTTP status and the machine-readable `error.code`/`type`
 * enum from the body are used to classify.
 */
export type ProviderErrorCode =
  | 'invalid_api_key'
  | 'permission_denied'
  | 'insufficient_quota'
  | 'rate_limited'
  | 'model_unavailable'
  | 'bad_request'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'timeout'
  | 'cancelled'
  | 'budget_exceeded';

export const SAFE_PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_api_key: 'OpenAI rejected the API key. Check or replace the key in Settings > AI providers.',
  permission_denied: 'This API key is not allowed to use that model or resource (check project/organization access).',
  insufficient_quota: 'The OpenAI account has no remaining quota or credit. Check billing on platform.openai.com.',
  rate_limited: 'OpenAI rate limit reached. Wait a moment and try again.',
  model_unavailable: 'That model does not exist or is not available to this API key.',
  bad_request:
    'OpenAI rejected the request. The selected model may not support structured (JSON schema) output, or an output limit is too low.',
  provider_unavailable: 'OpenAI is temporarily unavailable or could not be reached.',
  invalid_response: 'The model returned no usable answer (empty, truncated or malformed).',
  timeout: 'The model did not answer in time.',
  cancelled: 'The run was cancelled.',
  budget_exceeded: 'The per-run limit on model calls was reached, so no further calls were made.',
};

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly options: { retryable?: boolean; status?: number; retryAfterMs?: number } = {},
  ) {
    super(SAFE_PROVIDER_MESSAGES[code]);
    this.name = 'ProviderError';
  }
  get retryable() {
    return this.options.retryable ?? false;
  }
  get status() {
    return this.options.status;
  }
  get retryAfterMs() {
    return this.options.retryAfterMs;
  }
}

export interface SafeProviderError {
  code: ProviderErrorCode;
  message: string;
}

export const toSafeError = (code: ProviderErrorCode): SafeProviderError => ({ code, message: SAFE_PROVIDER_MESSAGES[code] });

/** Maps an HTTP failure to a ProviderError using only status and the body's `error.code`/`type`. */
export function classifyHttpError(status: number, body: unknown, retryAfterHeader?: string | null): ProviderError {
  const err = (body as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : '';
  const type = typeof err?.type === 'string' ? err.type : '';
  const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Math.min(Number(retryAfterHeader) * 1000, 15_000) : undefined;

  if (status === 401 || code === 'invalid_api_key') return new ProviderError('invalid_api_key', { status });
  if (code === 'insufficient_quota' || type === 'insufficient_quota') return new ProviderError('insufficient_quota', { status });
  if (status === 429) return new ProviderError('rate_limited', { status, retryable: true, retryAfterMs });
  if (status === 404 || code === 'model_not_found') return new ProviderError('model_unavailable', { status });
  if (status === 403) return new ProviderError('permission_denied', { status });
  if (status >= 500 || status === 408 || status === 409) return new ProviderError('provider_unavailable', { status, retryable: true, retryAfterMs });
  return new ProviderError('bad_request', { status });
}

/** Anything thrown while calling the provider becomes a ProviderError (never the raw error). */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return new ProviderError('timeout');
  if (name === 'AbortError') return new ProviderError('cancelled');
  return new ProviderError('provider_unavailable', { retryable: true });
}
