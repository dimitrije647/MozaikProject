/*
 * Pinterest integration constants. Every value here is traceable to the official documentation read on 2026-11-02 (see the
 * "Pinterest (optional)" README section for URLs and quotes). Where the documentation is silent the comment says UNVERIFIED.
 */

/** Official API hosts. The ONLY hosts this integration may call (token + boards + board pins). */
export const PINTEREST_OFFICIAL_API_HOSTS: readonly string[] = ['api.pinterest.com', 'api-sandbox.pinterest.com'];

/** Browser-side authorization page (docs: `https://www.pinterest.com/oauth/`). We never request it server-side. */
export const PINTEREST_AUTHORIZE_URL = 'https://www.pinterest.com/oauth/';

/**
 * Minimal READ-ONLY scopes. Per the official OpenAPI spec (v5.28.0): GET /boards needs `boards:read`; GET /boards/{board_id}/pins
 * needs `boards:read` + `pins:read`. `user_accounts:read` is NOT requested: it would only be needed to read the account's
 * username, and Pinterest's guidelines forbid storing API-accessed information, so we do not need (or keep) a profile label.
 * `*_secret` scopes are not requested either, so secret boards and Pins stay invisible to this app. No `:write` scope, ever.
 */
export const PINTEREST_SCOPES = ['boards:read', 'pins:read'] as const;

/** Fixed API paths (the only ones the client will build). `{board}` is replaced by a validated numeric id. */
export const PINTEREST_PATHS = {
  token: '/v5/oauth/token',
  boards: '/v5/boards',
  boardPins: (boardId: string) => `/v5/boards/${boardId}/pins`,
} as const;

/** Page sizes we ask for (Pinterest allows 1..250, default 25). Kept small: this is a browse-for-inspiration panel. */
export const PINTEREST_BOARD_PAGE_SIZE = 50;
export const PINTEREST_PIN_PAGE_SIZE = 24;

export const PINTEREST_HTTP_TIMEOUT_MS = 10_000;

/** OAuth `state` lifetime. */
export const PINTEREST_STATE_TTL_MS = 10 * 60 * 1000;

/** Refresh the access token this long before it expires. */
export const PINTEREST_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Where the browser returns after the OAuth flow when the caller did not ask for a specific in-app page. */
export const PINTEREST_DEFAULT_RETURN_PATH = '/settings/integrations';

/** Shown with every Pinterest response and in the status. */
export const PINTEREST_NOTICE =
  'Pinterest content is shown for your inspiration only. LaunchPilot does not download, store, analyze or send it to AI. ' +
  'Pick the matching style from our library or describe the direction yourself.';
