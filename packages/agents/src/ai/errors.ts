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
  | 'budget_exceeded'
  /** The approved spending limit (US dollars) of this campaign would be exceeded by the next request. */
  | 'spend_limit'
  | 'source_unavailable'
  /** NO AI HYBRID never generates an image: the request was refused before anything was sent. */
  | 'image_generation_forbidden';

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
  spend_limit: 'The approved spending limit for this campaign would be exceeded, so no further paid request was made.',
  source_unavailable: 'The source this agent needs could not be retrieved or read.',
  image_generation_forbidden: 'NO AI HYBRID never generates images, so the image request was refused before anything was sent to the provider.',
};

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly options: { retryable?: boolean; status?: number; retryAfterMs?: number; provider?: ProviderDiagnostics } = {},
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
  /** What the provider said about this failure (code, parameter, a sanitized message). Never present for authentication failures. */
  get provider() {
    return this.options.provider;
  }
}

/** The machine-readable part of an error body plus a sanitized, truncated message. Safe to store and to show. */
export interface ProviderDiagnostics {
  code?: string;
  type?: string;
  param?: string;
  message?: string;
}

const KEYISH = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}|\bBearer\s+\S+|\bsess-[A-Za-z0-9]{6,}/gi;
/** Removes anything key-shaped, collapses whitespace and truncates. Returns null when nothing is left. */
export function sanitizeProviderText(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(KEYISH, '[redacted]').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

export interface SafeProviderError {
  code: ProviderErrorCode;
  message: string;
  /** A safe sentence with the specifics: for invalid_response which fields broke which rule (paths and zod messages, never values); for timeout how long the request was given and that it may still have been billed. */
  detail?: string;
  /** HTTP status of a provider rejection, when there was one. */
  status?: number;
  /** The provider's own machine-readable code / parameter and a sanitized message (never for authentication failures). */
  providerCode?: string;
  providerParam?: string;
  providerMessage?: string;
}

export const toSafeError = (code: ProviderErrorCode): SafeProviderError => ({ code, message: SAFE_PROVIDER_MESSAGES[code] });

/** The safe error of a ProviderError INCLUDING the provider's diagnostics (status, code, parameter, sanitized message). */
export function toSafeErrorFrom(err: ProviderError): SafeProviderError {
  const out: SafeProviderError = toSafeError(err.code);
  if (err.status !== undefined) out.status = err.status;
  const d = err.provider;
  if (d?.code) out.providerCode = d.code;
  if (d?.param) out.providerParam = d.param;
  if (d?.message) out.providerMessage = d.message;
  return out;
}

/** Maps an HTTP failure to a ProviderError using only status and the body's `error.code`/`type`. */
export function classifyHttpError(status: number, body: unknown, retryAfterHeader?: string | null): ProviderError {
  const err = (body as { error?: { code?: unknown; type?: unknown; param?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : '';
  const type = typeof err?.type === 'string' ? err.type : '';
  // Authentication failures echo parts of the key, so nothing of them is kept. Every other failure keeps a sanitized description.
  const keep = status !== 401 && code !== 'invalid_api_key';
  const provider: ProviderDiagnostics | undefined = keep
    ? { code: code || undefined, type: type || undefined, param: typeof err?.param === 'string' ? err.param.slice(0, 80) : undefined, message: sanitizeProviderText(err?.message) ?? undefined }
    : undefined;
  // The provider's Retry-After is honored (up to a minute) instead of retrying early.
  const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Math.min(Number(retryAfterHeader) * 1000, 60_000) : undefined;

  if (status === 401 || code === 'invalid_api_key') return new ProviderError('invalid_api_key', { status });
  if (code === 'insufficient_quota' || type === 'insufficient_quota') return new ProviderError('insufficient_quota', { status, provider });
  if (status === 429) return new ProviderError('rate_limited', { status, retryable: true, retryAfterMs, provider });
  if (status === 404 || code === 'model_not_found') return new ProviderError('model_unavailable', { status, provider });
  if (status === 403) return new ProviderError('permission_denied', { status, provider });
  if (status >= 500 || status === 408 || status === 409) return new ProviderError('provider_unavailable', { status, retryable: true, retryAfterMs, provider });
  return new ProviderError('bad_request', { status, provider });
}

/** Anything thrown while calling the provider becomes a ProviderError (never the raw error). */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return new ProviderError('timeout');
  if (name === 'AbortError') return new ProviderError('cancelled');
  return new ProviderError('provider_unavailable', { retryable: true });
}
