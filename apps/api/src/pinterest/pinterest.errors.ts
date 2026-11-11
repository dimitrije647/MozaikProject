import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';

export type PinterestErrorCode =
  | 'not_configured'
  | 'not_connected'
  | 'reconnect_required'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'invalid_request'
  | 'oauth_rejected'
  | 'scope_missing';

const STATUS: Record<PinterestErrorCode, number> = {
  // 409 (not 401): the web app treats a 401 as "your LaunchPilot session ended" and signs the user out.
  not_configured: 409,
  not_connected: 409,
  reconnect_required: 409,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  upstream_unavailable: 502,
  upstream_error: 502,
  invalid_request: 400,
  oauth_rejected: 400,
  scope_missing: 400,
};

export interface PinterestErrorExtras {
  /** Seconds the caller should wait (429). Honors Retry-After when Pinterest sent one. */
  retryAfterSeconds?: number;
  /** HTTP status Pinterest answered with. Diagnostic only. */
  upstreamStatus?: number;
  /** Pinterest's numeric `code` field. Diagnostic only; Pinterest's message text is never relayed. */
  upstreamCode?: number;
}

/**
 * Typed, user-facing Pinterest failure. The message is written by us (never copied from an upstream body) and can never
 * contain a token, a secret or Pinterest content.
 */
export class PinterestError extends HttpException {
  readonly retryAfterSeconds?: number;
  constructor(
    readonly code: PinterestErrorCode,
    message: string,
    readonly extras: PinterestErrorExtras = {},
  ) {
    super({ statusCode: STATUS[code], error: code, code, message, ...extras }, STATUS[code]);
    this.retryAfterSeconds = extras.retryAfterSeconds;
  }
}

/** Adds the standard `Retry-After` header to 429 responses, otherwise leaves Nest's default rendering alone. */
@Catch(PinterestError)
export class PinterestExceptionFilter implements ExceptionFilter {
  catch(err: PinterestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err.retryAfterSeconds && err.retryAfterSeconds > 0) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterSeconds)));
    res.setHeader('Cache-Control', 'no-store');
    res.status(err.getStatus()).json(err.getResponse());
  }
}
