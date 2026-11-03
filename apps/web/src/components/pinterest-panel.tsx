'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ExternalLink, Info, Link2, Pin as PinIcon, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import {
  PINTEREST_CALLBACK_MESSAGES,
  PINTEREST_NOTICE,
  normalizePinterestPinUrl,
  pinterestKeys,
  useConnectPinterest,
  useDisconnectPinterest,
  usePinterestBoards,
  usePinterestPins,
  usePinterestStatus,
} from '@/lib/pinterest-api';
import type { PinterestBoard, PinterestPin } from '@/lib/pinterest-api';
import { cn } from '@/lib/utils';

/** What a user-chosen Pinterest reference looks like when it is handed to the caller: a LINK, never the image. */
export interface PinterestLinkRef {
  /**
   * Name of the board the Pin was picked from. It is Pinterest API content shown for display only: Pinterest's guidelines forbid
   * storing information accessed through the API, so callers should NOT persist it (empty string for a pasted link). Persist `pinUrl`.
   */
  boardName: string;
  /** Canonical https://www.pinterest.com/pin/<id>/ address. */
  pinUrl: string;
}

const PINTEREST_DOCS = 'https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/';
const OAUTH_PREFIX = 'https://www.pinterest.com/oauth/';

/**
 * OPTIONAL "browse my own Pinterest boards for inspiration". LaunchPilot works fully without it. Pinterest content is fetched
 * live when the user opens a board, shown here with attribution and a link back to Pinterest, and is never downloaded, stored,
 * analyzed or sent to AI. The only thing that can leave this panel is a LINK the user explicitly chooses (`onSelectLink`).
 */
export function PinterestPanel({ onSelectLink, returnPath, className }: { onSelectLink?: (ref: PinterestLinkRef) => void; returnPath?: string; className?: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const status = usePinterestStatus();
  const connect = useConnectPinterest();
  const disconnect = useDisconnectPinterest();
  const s = status.data;
  const connected = !!s?.connected;

  // The API callback sends the browser back with ?pinterest=connected|error&reason=...; show it once, then clean the address bar.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('pinterest');
    if (!outcome) return;
    const reason = url.searchParams.get('reason') ?? '';
    if (outcome === 'connected') toast.success('Pinterest connected');
    else toast.error(PINTEREST_CALLBACK_MESSAGES[reason] ?? 'Pinterest could not be connected.');
    url.searchParams.delete('pinterest');
    url.searchParams.delete('reason');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    void qc.invalidateQueries({ queryKey: pinterestKeys.status });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startConnect() {
    connect.mutate(returnPath ?? window.location.pathname, {
      onSuccess: (r) => {
        // Only ever navigate to Pinterest's own authorization page.
        if (!r.authorizationUrl.startsWith(OAUTH_PREFIX)) return toast.error('Unexpected authorization address. Nothing was opened.');
        window.location.assign(r.authorizationUrl);
      },
      onError: (e) => toast.error(e.message),
    });
  }

  function runDisconnect() {
    const ok = window.confirm(
      'Disconnect Pinterest?\n\nLaunchPilot deletes the stored connection. To also remove the app’s access on Pinterest’s side, use your Pinterest account settings.',
    );
    if (!ok) return;
    disconnect.mutate(undefined, { onSuccess: () => toast.success('Pinterest disconnected'), onError: (e) => toast.error(e.message) });
  }

  const needsReconnect = !!s && s.configured && (s.status === 'expired' || s.status === 'revoked' || s.status === 'error');

  return (
    <Card className={cn('space-y-4 p-5', className)} data-testid="pinterest-panel">
      <div className="flex flex-wrap items-center gap-2">
        <PinIcon className="h-4 w-4 text-accent" />
        <h4 className="font-sans text-sm font-semibold">Pinterest inspiration</h4>
        <Badge className="bg-cream-200 text-ink-600">Optional</Badge>
        {connected && (
          <Badge className="bg-emerald-100 text-emerald-800">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </Badge>
        )}
        {needsReconnect && <Badge className="bg-amber-100 text-amber-800">Reconnect needed</Badge>}
        {connected && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={runDisconnect} loading={disconnect.isPending}>
            <Unplug className="h-3.5 w-3.5" /> Disconnect
          </Button>
        )}
      </div>

      {status.isLoading && <p className="text-xs text-muted">Checking Pinterest status…</p>}
      {status.isError && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {status.error.message}
          <Button size="sm" variant="outline" onClick={() => status.refetch()}>
            Retry
          </Button>
        </p>
      )}

      {s && !s.configured && <NotConfigured problems={s.configProblems} />}

      {s && s.configured && s.status === 'not_connected' && (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Browse your own Pinterest boards for visual inspiration while you choose a creative direction. Read-only: LaunchPilot asks only to see your public boards and Pins, and never posts, saves or changes anything on Pinterest.
          </p>
          <Button size="sm" onClick={startConnect} loading={connect.isPending}>
            <PinIcon className="h-3.5 w-3.5" /> Connect Pinterest
          </Button>
        </div>
      )}

      {needsReconnect && s && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{s.message}</span>
          <Button size="sm" onClick={startConnect} loading={connect.isPending}>
            <RefreshCw className="h-3.5 w-3.5" /> Reconnect Pinterest
          </Button>
          <Button size="sm" variant="ghost" onClick={runDisconnect} loading={disconnect.isPending}>
            Remove connection
          </Button>
        </div>
      )}

      {connected && <ConnectedBrowser onSelectLink={onSelectLink} />}

      {onSelectLink && <ManualLink onSelectLink={onSelectLink} />}
    </Card>
  );
}

function NotConfigured({ problems }: { problems: string[] }) {
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-cream-300 bg-cream-100/60 p-4 text-sm" data-testid="pinterest-not-configured">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Info className="h-4 w-4 text-muted" /> Pinterest is not set up on this server
      </p>
      <p className="text-muted">
        Pinterest is an optional extra that lets you browse your own boards for visual inspiration. Everything in LaunchPilot works without it: choose a style from the library or describe the direction yourself.
      </p>
      <p className="text-muted">
        To enable it, an administrator creates an app in the{' '}
        <a className="underline" href={PINTEREST_DOCS} target="_blank" rel="noopener noreferrer">
          Pinterest developer portal
        </a>{' '}
        and sets <code className="text-xs">PINTEREST_APP_ID</code>, <code className="text-xs">PINTEREST_APP_SECRET</code> and <code className="text-xs">PINTEREST_REDIRECT_URI</code> on the server (see the README section “Pinterest (optional)”). Pinterest reviews apps before they can read real boards.
      </p>
      {problems.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">What is missing</summary>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Banner() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900" data-testid="pinterest-banner">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> {PINTEREST_NOTICE}
    </p>
  );
}

function ConnectedBrowser({ onSelectLink }: { onSelectLink?: (ref: PinterestLinkRef) => void }) {
  const qc = useQueryClient();
  // Nothing is requested from Pinterest until the user asks to browse; closing drops the data from memory.
  const [open, setOpen] = React.useState(false);
  const boards = usePinterestBoards(open);
  const [board, setBoard] = React.useState<PinterestBoard | null>(null);
  const pins = usePinterestPins(board?.id ?? null);
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());

  // A 409 from Pinterest routes means the connection state changed (expired, revoked, disconnected elsewhere): re-read the status.
  const failure = boards.error ?? pins.error;
  React.useEffect(() => {
    if (failure instanceof ApiError && failure.status === 409) void qc.invalidateQueries({ queryKey: pinterestKeys.status });
  }, [failure, qc]);

  const boardItems = boards.data?.pages.flatMap((p) => p.items) ?? [];
  const pinItems = pins.data?.pages.flatMap((p) => p.items) ?? [];

  if (!open) {
    return (
      <div className="space-y-3">
        <Banner />
        <Button size="sm" onClick={() => setOpen(true)}>
          <PinIcon className="h-3.5 w-3.5" /> Browse my boards
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Banner />

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h5 className="font-sans text-xs font-semibold uppercase tracking-wide text-muted">Your boards</h5>
          {boards.isFetching && <span className="text-xs text-muted">Loading…</span>}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setOpen(false);
              setBoard(null);
            }}
          >
            Close
          </Button>
        </div>
        {boards.isError && <ErrorLine error={boards.error} onRetry={() => boards.refetch()} />}
        {boards.isSuccess && boardItems.length === 0 && <p className="text-sm text-muted">Pinterest returned no boards for this connection.</p>}
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {boardItems.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setBoard(b)}
                aria-pressed={board?.id === b.id}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border bg-white p-2 text-left text-sm transition-colors hover:bg-cream-100',
                  board?.id === b.id ? 'border-accent ring-2 ring-accent/20' : 'border-cream-300/80',
                )}
              >
                {b.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.coverImageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-12 w-12 shrink-0 rounded-lg bg-cream-100 object-cover" />
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-cream-100 text-muted">
                    <PinIcon className="h-4 w-4" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{b.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {b.pinCount !== null ? `${b.pinCount} Pins` : 'Board'}
                    {b.ownerUsername ? ` · @${b.ownerUsername}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {boards.hasNextPage && (
          <Button size="sm" variant="outline" onClick={() => boards.fetchNextPage()} loading={boards.isFetchingNextPage}>
            Load more boards
          </Button>
        )}
      </div>

      {board && (
        <div className="space-y-2" data-testid="pinterest-pins">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="font-sans text-xs font-semibold uppercase tracking-wide text-muted">Pins in “{board.name}”</h5>
            {pins.isFetching && !pins.isFetchingNextPage && <span className="text-xs text-muted">Loading…</span>}
            {board.ownerProfileUrl && (
              <a className="inline-flex items-center gap-1 text-xs underline" href={board.ownerProfileUrl} target="_blank" rel="noopener noreferrer">
                Board by @{board.ownerUsername} on Pinterest <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {pins.isError && <ErrorLine error={pins.error} onRetry={() => pins.refetch()} />}
          {pins.isSuccess && pinItems.length === 0 && <p className="text-sm text-muted">This board has no Pins Pinterest let us read.</p>}
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {pinItems.map((p) => (
              <PinCard
                key={p.id}
                pin={p}
                chosen={picked.has(p.pinUrl)}
                onUse={
                  onSelectLink
                    ? () => {
                        onSelectLink({ boardName: board.name, pinUrl: p.pinUrl });
                        setPicked((cur) => new Set(cur).add(p.pinUrl));
                      }
                    : undefined
                }
              />
            ))}
          </ul>
          {pins.hasNextPage && (
            <Button size="sm" variant="outline" onClick={() => pins.fetchNextPage()} loading={pins.isFetchingNextPage}>
              Load more Pins
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorLine({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-start gap-2 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{error.message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}

/**
 * A Pin shown with attribution. Pinterest's guidelines require linking back to the Pin and making clear the content comes from
 * Pinterest, and forbid covering or filtering it: the image is shown as delivered (no overlay, filter or crop), straight from
 * Pinterest's own address into the browser. The server never downloads it.
 */
function PinCard({ pin, chosen, onUse }: { pin: PinterestPin; chosen: boolean; onUse?: () => void }) {
  const ratio = pin.imageWidth && pin.imageHeight ? `${pin.imageWidth} / ${pin.imageHeight}` : undefined;
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-cream-300/80 bg-white">
      {pin.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={pin.imageUrl} alt={pin.altText ?? pin.title ?? 'Pin from Pinterest'} loading="lazy" referrerPolicy="no-referrer" style={ratio ? { aspectRatio: ratio } : undefined} className="block w-full bg-cream-100 object-contain" />
      ) : (
        <div className="grid h-28 place-items-center bg-cream-100 px-3 text-center text-xs text-muted">
          {pin.mediaType === 'video' ? 'Video Pin: no preview image' : 'No preview available'}. Open it on Pinterest.
        </div>
      )}
      <div className="flex flex-1 flex-col gap-1.5 p-3 text-xs">
        <p className="line-clamp-2 font-medium text-ink">{pin.title ?? 'Untitled Pin'}</p>
        <p className="text-muted">
          From Pinterest
          {pin.boardOwnerUsername &&
            (pin.boardOwnerProfileUrl ? (
              <>
                {' · '}
                <a className="underline" href={pin.boardOwnerProfileUrl} target="_blank" rel="noopener noreferrer">
                  @{pin.boardOwnerUsername}
                </a>
              </>
            ) : (
              ` · @${pin.boardOwnerUsername}`
            ))}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={pin.pinUrl} target="_blank" rel="noopener noreferrer">
            View on Pinterest <ExternalLink className="h-3 w-3" />
          </a>
          {onUse && (
            <Button size="sm" variant={chosen ? 'dark' : 'outline'} onClick={onUse}>
              {chosen ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
              {chosen ? 'Link added' : 'Use link as reference'}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Works without any Pinterest connection: validates a pasted Pin address and hands back a LINK. Never opens or fetches it. */
function ManualLink({ onSelectLink }: { onSelectLink: (ref: PinterestLinkRef) => void }) {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = normalizePinterestPinUrl(value);
    if (!r.ok) {
      setDone(null);
      return setError(r.reason);
    }
    setError(null);
    setDone(r.url);
    setValue('');
    onSelectLink({ boardName: '', pinUrl: r.url });
  }

  return (
    <form onSubmit={submit} className="space-y-1.5 border-t border-cream-300/70 pt-4" data-testid="pinterest-manual-link">
      <label htmlFor="pinterest-link" className="text-[13px] font-medium text-ink-700">
        Or paste a Pinterest Pin link
      </label>
      <div className="flex flex-wrap gap-2">
        <Input id="pinterest-link" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://www.pinterest.com/pin/1234567890/" autoComplete="off" spellCheck={false} className="min-w-[16rem] flex-1" />
        <Button type="submit" size="md" variant="outline" disabled={!value.trim()}>
          <Link2 className="h-4 w-4" /> Use link
        </Button>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : done ? <p className="text-xs text-emerald-700">Link added: {done}</p> : (
        <p className="text-xs text-muted">LaunchPilot only keeps the link. It never opens the Pin, downloads its image or sends it to AI.</p>
      )}
    </form>
  );
}
