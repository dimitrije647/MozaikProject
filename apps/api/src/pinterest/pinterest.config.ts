import { PINTEREST_OFFICIAL_API_HOSTS } from './pinterest.constants';

export interface PinterestConfig {
  /** True only when every required setting is present AND valid. Otherwise every Pinterest action refuses. */
  configured: boolean;
  /** Safe, human-readable reasons (setting names only, never values). Empty when configured. */
  problems: string[];
  appId: string;
  appSecret: string;
  redirectUri: string;
  /** Origin only, no trailing slash, e.g. `https://api.pinterest.com`. */
  apiBase: string;
  /** True when apiBase is NOT an official Pinterest host (local mock server). Never possible in production. */
  testBase: boolean;
  /** Only for Pinterest apps created before 2025-09-25 (docs: `continuous_refresh=true`). */
  continuousRefresh: boolean;
}

const DEFAULT_BASE = 'https://api.pinterest.com';

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

/**
 * Reads the Pinterest settings from the environment on every call (so tests and key rotation need no restart).
 * Absent or invalid credentials => `configured: false`. Nothing is ever defaulted or invented.
 */
export function readPinterestConfig(env: NodeJS.ProcessEnv = process.env): PinterestConfig {
  const problems: string[] = [];
  const appId = (env.PINTEREST_APP_ID ?? '').trim();
  const appSecret = (env.PINTEREST_APP_SECRET ?? '').trim();
  const redirectUri = (env.PINTEREST_REDIRECT_URI ?? '').trim();
  if (!appId) problems.push('PINTEREST_APP_ID is not set');
  if (!appSecret) problems.push('PINTEREST_APP_SECRET is not set');
  if (!redirectUri) problems.push('PINTEREST_REDIRECT_URI is not set');
  else {
    try {
      const u = new URL(redirectUri);
      const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
      // Our own safety rule (the docs only require an exact match with the registered URI): an authorization code must not
      // travel over plain http except to a loopback address during local development.
      if (!okScheme) problems.push('PINTEREST_REDIRECT_URI must be https (http is allowed only for localhost)');
      if (u.hash) problems.push('PINTEREST_REDIRECT_URI must not contain a fragment');
    } catch {
      problems.push('PINTEREST_REDIRECT_URI is not a valid URL');
    }
  }

  let apiBase = DEFAULT_BASE;
  let testBase = false;
  const rawBase = (env.PINTEREST_API_BASE ?? '').trim();
  if (rawBase) {
    try {
      const u = new URL(rawBase);
      if (u.protocol === 'https:' && !u.port && PINTEREST_OFFICIAL_API_HOSTS.includes(u.hostname)) {
        apiBase = u.origin;
      } else if (env.NODE_ENV !== 'production' && env.PINTEREST_ALLOW_TEST_BASE === '1' && (u.protocol === 'http:' || u.protocol === 'https:')) {
        // Local mock servers only. Refused in production no matter what the flag says.
        apiBase = u.origin;
        testBase = true;
      } else {
        problems.push(`PINTEREST_API_BASE must be one of: ${PINTEREST_OFFICIAL_API_HOSTS.map((h) => `https://${h}`).join(', ')}`);
      }
    } catch {
      problems.push('PINTEREST_API_BASE is not a valid URL');
    }
  }

  return {
    configured: problems.length === 0,
    problems,
    appId,
    appSecret,
    redirectUri,
    apiBase,
    testBase,
    continuousRefresh: (env.PINTEREST_CONTINUOUS_REFRESH ?? '') === '1',
  };
}
