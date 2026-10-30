const SENSITIVE_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|credential|bearer)/i;
// Shapes of provider keys: OpenAI (sk-...), Gemini/Google (AIza...), generic bearer tokens.
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/g;

const MAX_DEPTH = 8;

/**
 * Defense in depth: strips anything that looks like a credential from a value before it is
 * stored in shared state, event history or logs. Secrets should never reach here in the first
 * place; this guarantees a mistake in a future agent cannot persist one.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return '[truncated]' as unknown as T;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]') as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Error messages are user-visible and persisted, so sanitize them too. */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redact(msg).slice(0, 500);
}
