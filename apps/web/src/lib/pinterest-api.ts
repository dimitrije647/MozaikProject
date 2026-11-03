'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from './api';

/*
 * Client for the OPTIONAL Pinterest integration (GET/POST/DELETE /integrations/pinterest/*). Pinterest content is fetched live and
 * kept only in memory while the panel is open: queries use gcTime 0 and never retry (a retry loop would hammer Pinterest's rate
 * limit), and nothing here is written to localStorage, IndexedDB or the LaunchPilot API.
 */

export type PinterestUiStatus = 'not_configured' | 'not_connected' | 'connected' | 'expired' | 'revoked' | 'error';

export interface PinterestStatus {
  configured: boolean;
  /** Names of missing/invalid server settings (never values). */
  configProblems: string[];
  connected: boolean;
  status: PinterestUiStatus;
  requiredScopes: string[];
  scopes: string[];
  connectedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  message: string;
  notice: string;
}

export interface PinterestBoard {
  id: string;
  name: string;
  description: string | null;
  privacy: string | null;
  pinCount: number | null;
  ownerUsername: string | null;
  ownerProfileUrl: string | null;
  coverImageUrl: string | null;
}

export interface PinterestPin {
  id: string;
  title: string | null;
  description: string | null;
  altText: string | null;
  mediaType: 'image' | 'video' | 'multiple' | 'unknown';
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  pinUrl: string;
  boardId: string | null;
  boardOwnerUsername: string | null;
  boardOwnerProfileUrl: string | null;
}

interface Page<T> {
  items: T[];
  bookmark: string | null;
  notice: string;
}

export const PINTEREST_NOTICE =
  'Pinterest content is shown for your inspiration only. LaunchPilot does not download, store, analyze or send it to AI. Pick the matching style from our library or describe the direction yourself.';

export const pinterestKeys = {
  status: ['pinterest', 'status'] as const,
  boards: ['pinterest', 'boards'] as const,
  pins: (boardId: string) => ['pinterest', 'pins', boardId] as const,
};

/** Cheap and free: reads our own database only (never Pinterest). Works when Pinterest is not configured. */
export const usePinterestStatus = () =>
  useQuery({ queryKey: pinterestKeys.status, queryFn: () => get<PinterestStatus>('/integrations/pinterest/status'), retry: false });

/** Starts the OAuth flow: resolves to Pinterest's authorization URL, which the caller navigates to. */
export function useConnectPinterest() {
  return useMutation({
    mutationFn: (returnPath?: string) => post<{ authorizationUrl: string }>('/integrations/pinterest/connect', returnPath ? { returnPath } : {}),
  });
}

export function useDisconnectPinterest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del<{ ok: true; removed: boolean }>('/integrations/pinterest'),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: ['pinterest', 'boards'] });
      qc.removeQueries({ queryKey: ['pinterest', 'pins'] });
      await qc.invalidateQueries({ queryKey: pinterestKeys.status });
    },
  });
}

const pageQuery = (bookmark: string | undefined) => (bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : '');

/** On-demand and live. `enabled` must only be true after the user connected Pinterest. */
export const usePinterestBoards = (enabled: boolean) =>
  useInfiniteQuery({
    queryKey: pinterestKeys.boards,
    queryFn: ({ pageParam }) => get<Page<PinterestBoard>>(`/integrations/pinterest/boards${pageQuery(pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.bookmark ?? undefined,
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

/** Pins of ONE board the user explicitly picked. Nothing is fetched until `boardId` is set. */
export const usePinterestPins = (boardId: string | null) =>
  useInfiniteQuery({
    queryKey: pinterestKeys.pins(boardId ?? ''),
    queryFn: ({ pageParam }) => get<Page<PinterestPin>>(`/integrations/pinterest/boards/${encodeURIComponent(boardId!)}/pins${pageQuery(pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.bookmark ?? undefined,
    enabled: !!boardId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

export type PinterestLinkResult = { ok: true; pinId: string; url: string } | { ok: false; reason: string };

/**
 * Turns a pasted pinterest.com Pin address into a canonical LINK. Pure string handling: it never opens or fetches the address
 * (Pinterest's guidelines forbid scraping), so it cannot tell whether the Pin exists. Mirrors apps/api/src/pinterest/pinterest-url.ts.
 */
export function normalizePinterestPinUrl(input: string): PinterestLinkResult {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 2048) return { ok: false, reason: 'Paste a Pinterest Pin address like https://www.pinterest.com/pin/1234567890/.' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only http(s) Pinterest addresses are accepted.' };
  if (u.username || u.password || u.port) return { ok: false, reason: 'That address contains credentials or a port, which is not accepted.' };
  const host = u.hostname.toLowerCase();
  if (host === 'pin.it') return { ok: false, reason: 'Short pin.it links cannot be resolved without opening them. Open the Pin and paste its full pinterest.com/pin/... address.' };
  if (!/^(?:[a-z]{2,3}|www)\.pinterest\.com$|^pinterest\.com$/.test(host)) return { ok: false, reason: 'Only pinterest.com Pin addresses are accepted.' };
  const m = /^\/pin\/(\d{5,30})\/?$/.exec(u.pathname);
  if (!m) return { ok: false, reason: 'Use the Pin address (pinterest.com/pin/<number>), not a board, profile or search page.' };
  return { ok: true, pinId: m[1], url: `https://www.pinterest.com/pin/${m[1]}/` };
}

/** Human text for the `?pinterest=error&reason=...` the API callback redirects back with. */
export const PINTEREST_CALLBACK_MESSAGES: Record<string, string> = {
  denied: 'You cancelled the Pinterest authorization. Nothing was connected.',
  invalid_state: 'That Pinterest authorization link expired or was already used. Press Connect to start again.',
  session_mismatch: 'Sign in to LaunchPilot with the same account that started the Pinterest connection, then try again.',
  not_configured: 'Pinterest is not configured on this server.',
  exchange_rejected: 'Pinterest did not accept the authorization. Try connecting again; if it keeps failing, the Pinterest app settings may not match.',
  scope_missing: 'LaunchPilot needs permission to read your boards and Pins. Connect again and allow both read permissions.',
  rate_limited: 'Pinterest asked us to slow down. Try again in a little while.',
  unavailable: 'Pinterest is not reachable right now. Try again later.',
  server_error: 'Something went wrong while connecting Pinterest. Nothing was saved. Try again.',
};
