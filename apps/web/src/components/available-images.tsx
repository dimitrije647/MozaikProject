'use client';

import * as React from 'react';
import { AlertCircle, Check, ExternalLink, ImageOff, Search, Upload } from 'lucide-react';
import { ProviderList } from '@/components/no-ai';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  SOURCE_LABEL,
  rightsText,
  sizeText,
  useApproveImage,
  useDiscoverLibrary,
  useImageAlternatives,
  useImageLibrary,
  useRejectImage,
  useRestoreImage,
  useUploadImages,
  type AlternativesResult,
  type DiscoverSource,
  type LibraryItem,
} from '@/lib/images';
import { cn } from '@/lib/utils';

/*
 * AVAILABLE IMAGES: the pictures a NO AI HYBRID campaign can be built from, where each one came from and under which rights. Nothing here
 * generates an image or calls a paid service. A website or repository picture is downloaded by the server only after the owner confirms
 * the rights; a licensed stock picture whose license needs a check is used only after the owner confirms it; social media links are
 * references only (LaunchPilot never copies platform content). The server's verdict (rights.eligible and its reason) is shown as it is.
 */

type TabId = 'upload' | 'website' | 'github' | 'social' | 'stock' | 'approved' | 'restricted';

const TABS: { id: TabId; label: string; help: string }[] = [
  { id: 'upload', label: 'My uploaded images', help: 'Pictures you uploaded to this project. They are yours, so they are approved as soon as they arrive.' },
  { id: 'website', label: 'Website candidates', help: 'Pictures found on your website. LaunchPilot downloads one only after you confirm that you own it or hold the rights to use it in advertising.' },
  { id: 'github', label: 'GitHub assets', help: 'Pictures found in your repository (logos, screenshots, banners). Same rule as the website: nothing is downloaded before you confirm the rights.' },
  { id: 'social', label: 'Social media references', help: 'Links to your social profiles. They are references only: LaunchPilot never copies platform content, and no API reads pictures from these platforms.' },
  { id: 'stock', label: 'Licensed stock images', help: 'Pictures from licensed providers, with their license and credit. A license that needs a check is used only after you checked it at its source.' },
  { id: 'approved', label: 'Approved images', help: 'Everything approved whose rights allow advertising use. Only these can appear in a creative.' },
  { id: 'restricted', label: 'Unavailable / restricted', help: 'Pictures whose license does not allow advertising use, reference-only pictures and the ones you rejected. You can restore a picture you rejected.' },
];

const isRestricted = (i: LibraryItem) => i.status === 'rejected' || i.rights.status === 'blocked' || i.rights.status === 'reference_only';
const inTab = (i: LibraryItem, t: TabId): boolean => {
  if (t === 'approved') return i.status === 'approved' && i.rights.eligible;
  // a social link has its own tab; it is a reference, not a picture that was taken away
  if (t === 'restricted') return i.source !== 'social' && isRestricted(i);
  if (t === 'social') return i.source === 'social';
  return i.source === t && !isRestricted(i);
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const STATUS_LABEL: Record<LibraryItem['status'], { text: string; cls: string }> = {
  approved: { text: 'Approved', cls: 'bg-emerald-100 text-emerald-800' },
  candidate: { text: 'Candidate', cls: 'bg-cream-200 text-ink-600' },
  rejected: { text: 'Rejected', cls: 'bg-red-100 text-red-700' },
};
const TONE = { ok: 'bg-emerald-100 text-emerald-800', wait: 'bg-amber-100 text-amber-900', no: 'bg-red-100 text-red-700' } as const;

const OUTCOME_LABEL: Record<DiscoverSource, string> = { website: 'Your website', github: 'GitHub repository', social: 'Social media', stock: 'Licensed stock' };
const OUTCOME_STATUS: Record<string, { text: string; cls: string }> = {
  ok: { text: 'searched', cls: 'bg-emerald-100 text-emerald-800' },
  failed: { text: 'failed', cls: 'bg-red-100 text-red-700' },
  not_configured: { text: 'not configured', cls: 'bg-amber-100 text-amber-900' },
  reference_only: { text: 'reference only', cls: 'bg-cream-200 text-ink-600' },
};

const ATTEST_TEXT = 'I own this picture or have the rights to use it in advertising for this business.';
const REVIEW_TEXT = 'I checked the license at its source.';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const RASTER = /^image\/(png|jpe?g|webp)$/i;

interface Confirm {
  id: string;
  kind: 'attestation' | 'review';
  where: 'list' | 'alt';
}

// ---- one picture --------------------------------------------------------------------------------------------------------------------------

/** The picture itself, exactly as the server allows it to be shown. A preview of kind 'none' is a neutral placeholder with the server's note, never a guessed picture. */
function Preview({ item, className }: { item: LibraryItem; className?: string }) {
  const p = item.preview;
  const [failed, setFailed] = React.useState(false);
  // an approved picture gets a stored copy: the preview changes, so a failure of the old one no longer applies
  React.useEffect(() => setFailed(false), [p.url]);
  if (p.kind === 'none' || !p.url || failed) {
    return (
      <div data-testid={`image-preview-none-${item.id}`} className={cn('flex flex-col items-center justify-center gap-1.5 bg-cream-200/70 px-3 text-center text-[11px] text-muted', className)}>
        <ImageOff className="h-5 w-5" />
        <span>{failed ? 'The preview could not be loaded.' : (p.note ?? 'No preview is available for this picture.')}</span>
      </div>
    );
  }
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-cream-200/70', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.url} alt={item.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      {p.kind !== 'asset' && <span className="absolute bottom-1 left-1 rounded bg-ink/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white">{p.kind === 'thumbnail' ? 'Provider thumbnail' : 'Preview, not stored'}</span>}
    </div>
  );
}

/** The rights of one picture in plain language. eligible = false is "Not usable yet" with the server's own reason. */
function Rights({ item }: { item: LibraryItem }) {
  const r = item.rights;
  const t = rightsText(r);
  return (
    <div data-testid={`image-rights-${item.id}`} data-eligible={r.eligible ? 'yes' : 'no'} className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={cn('px-2 py-0.5 text-[11px]', TONE[t.tone])}>{t.headline}</Badge>
        {!r.eligible && <Badge className="bg-red-50 px-2 py-0.5 text-[11px] text-red-700 ring-1 ring-red-200">Not usable yet</Badge>}
        <span className="text-muted">{t.verification}</span>
      </div>
      <p>
        <span className="text-muted">License:</span>{' '}
        {r.licenseUrl ? (
          <a href={r.licenseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 underline underline-offset-2">
            {r.license} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          r.license
        )}
      </p>
      <p className={cn(r.eligible ? 'text-muted' : 'rounded-lg bg-amber-50 px-2 py-1 text-amber-950')}>{r.reason}</p>
      {(r.attribution || r.attributionRequired) && (
        <p>
          <span className="text-muted">Credit:</span> {r.attribution ?? 'not provided'}
          {r.attributionRequired && <Badge className="ml-1.5 bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">credit required</Badge>}
        </p>
      )}
      <details className="text-muted">
        <summary className="cursor-pointer select-none hover:text-ink">Rights details</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>Use in advertising: {r.commercialUse ? 'allowed' : 'not allowed'}</li>
          <li>Crops and text on top of it: {r.derivatives ? 'allowed' : 'not allowed'}</li>
          <li>Download by LaunchPilot: {r.downloadAllowed ? 'allowed' : 'not allowed'}</li>
          <li>The original file in the download package: {r.redistributeOriginal ? 'allowed' : 'not included (only the finished creatives)'}</li>
          {r.attestedAt && <li>You confirmed the rights on {new Date(r.attestedAt).toLocaleDateString()}</li>}
          {r.reasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Score({ item }: { item: LibraryItem }) {
  if (item.score === null) return <p className="text-muted">No relevance score: this picture cannot be used.</p>;
  return (
    <p data-testid={`image-score-${item.id}`}>
      <span className="text-muted">Relevance</span> <strong>{pct(item.relevance ?? item.score)}</strong>
      {item.relevance !== null && (
        <>
          {' '}
          <span className="text-muted">· fit score</span> <strong>{pct(item.score)}</strong>
        </>
      )}
      {item.scoreEstimated && <span className="ml-1 text-muted">(estimated)</span>}
    </p>
  );
}

/** Shown under a picture that needs the owner's word before it can be used. Only one is open at a time, so its test ids are unique. */
function ConfirmPanel({ item, kind, ticked, onTick, onConfirm, onCancel, pending }: { item: LibraryItem; kind: Confirm['kind']; ticked: boolean; onTick: (on: boolean) => void; onConfirm: () => void; onCancel: () => void; pending: boolean }) {
  const attest = kind === 'attestation';
  return (
    <div data-testid={`image-confirm-${item.id}`} className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/30 p-3">
      {attest ? (
        <p className="text-[11px] text-muted">LaunchPilot downloads this picture only after you confirm. It is then stored in your project and can appear in your creatives.</p>
      ) : (
        <div className="space-y-1 text-[11px]">
          <p>
            <span className="text-muted">License:</span> <strong>{item.rights.license}</strong>
            {item.rights.licenseUrl && (
              <>
                {' '}
                <a href={item.rights.licenseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                  read the license <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            {item.pageUrl && (
              <>
                {' · '}
                <a href={item.pageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                  source page <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
          <p className="text-muted">The provider could not clear this license by itself. Check it at the source before you use the picture in advertising.</p>
        </div>
      )}
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input type="checkbox" data-testid={attest ? 'image-attest-checkbox' : 'image-review-checkbox'} className="mt-0.5" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
        <span>{attest ? ATTEST_TEXT : REVIEW_TEXT}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" data-testid={attest ? 'image-attest-confirm' : 'image-review-confirm'} disabled={!ticked} loading={pending} onClick={onConfirm}>
          <Check className="h-3.5 w-3.5" /> {attest ? 'Confirm and approve' : 'Approve with my license check'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface CardCtx {
  busyId: string | null;
  confirm: Confirm | null;
  ticked: boolean;
  setTicked: (on: boolean) => void;
  alts: { forId: string; result: AlternativesResult } | null;
  /** the library's current status of a picture (an alternative that was approved meanwhile) */
  statusOf: (id: string) => LibraryItem['status'] | undefined;
  searchingId: string | null;
  onApprove: (item: LibraryItem, where: Confirm['where']) => void;
  onConfirm: (item: LibraryItem) => void;
  onCancel: () => void;
  onReject: (item: LibraryItem) => void;
  onRestore: (item: LibraryItem) => void;
  onAlternatives: (item: LibraryItem) => void;
  onCloseAlternatives: () => void;
  approving: boolean;
}

function ImageCard({ item, ctx }: { item: LibraryItem; ctx: CardCtx }) {
  const has = (a: LibraryItem['actions'][number]) => item.actions.includes(a);
  // the server decides what is allowed; a reference or a blocked license never shows an Approve button, whatever the list says
  const canApprove = has('approve') && item.source !== 'social' && item.rights.status !== 'reference_only' && item.rights.status !== 'blocked';
  const busy = ctx.busyId === item.id;
  const reasons = item.reasons.slice(0, 4);
  return (
    <li data-testid={`image-card-${item.id}`} data-source={item.source} data-status={item.status} data-eligible={item.rights.eligible ? 'yes' : 'no'} className="flex flex-col overflow-hidden rounded-2xl border border-cream-300/80 bg-cream-50">
      <Preview item={item} className="h-40 w-full" />
      <div className="flex flex-1 flex-col gap-2 p-3 text-xs">
        <div className="space-y-1">
          <p className="break-words text-sm font-medium" title={item.title}>
            {item.title}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-muted">
            <Badge className="bg-cream-200 px-2 py-0.5 text-[11px] text-ink-600">{SOURCE_LABEL[item.source]}</Badge>
            <Badge className={cn('px-2 py-0.5 text-[11px]', STATUS_LABEL[item.status].cls)}>{STATUS_LABEL[item.status].text}</Badge>
            {item.source === 'social' && <Badge className="bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900">Reference only</Badge>}
            <span data-testid={`image-size-${item.id}`}>{sizeText(item.width, item.height)}</span>
            {item.creator && <span>· {item.creator}</span>}
          </p>
        </div>

        {item.source === 'social' ? (
          <div className="space-y-1">
            <p>{item.note ?? 'A link to a social profile. LaunchPilot never copies platform content.'}</p>
            <p className="text-muted">To use a picture from this profile, save it yourself and add it with “Upload my own”: a picture you upload is yours.</p>
          </div>
        ) : (
          <>
            <Rights item={item} />
            <Score item={item} />
            {reasons.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-muted">
                {reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            {item.note && <p className="text-muted">{item.note}</p>}
          </>
        )}
        <p data-testid={`image-selection-${item.id}`} className="rounded-lg bg-cream-100 px-2 py-1.5 text-ink-600">
          <span className="font-medium text-ink">In the campaign:</span> {item.selection}
        </p>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {canApprove && (
            <Button type="button" size="sm" data-testid={`image-approve-${item.id}`} loading={busy && ctx.approving} disabled={!!ctx.busyId && !busy} onClick={() => ctx.onApprove(item, 'list')}>
              <Check className="h-3.5 w-3.5" /> Approve for campaign
            </Button>
          )}
          {has('reject') && (
            <Button type="button" size="sm" variant="outline" data-testid={`image-reject-${item.id}`} loading={busy && !ctx.approving} disabled={!!ctx.busyId && !busy} onClick={() => ctx.onReject(item)}>
              Reject
            </Button>
          )}
          {has('restore') && (
            <Button type="button" size="sm" variant="outline" data-testid={`image-restore-${item.id}`} loading={busy && !ctx.approving} disabled={!!ctx.busyId && !busy} onClick={() => ctx.onRestore(item)}>
              Restore
            </Button>
          )}
          {has('view_source') && item.pageUrl && (
            <Button asChild size="sm" variant="ghost">
              <a href={item.pageUrl} target="_blank" rel="noreferrer noopener" data-testid={`image-source-${item.id}`}>
                <ExternalLink className="h-3.5 w-3.5" /> View source
              </a>
            </Button>
          )}
          {has('search_alternatives') && (
            <Button type="button" size="sm" variant="ghost" data-testid={`image-alternatives-${item.id}`} loading={ctx.searchingId === item.id} onClick={() => ctx.onAlternatives(item)}>
              <Search className="h-3.5 w-3.5" /> Search alternatives
            </Button>
          )}
        </div>

        {ctx.confirm?.id === item.id && ctx.confirm.where === 'list' && <ConfirmPanel item={item} kind={ctx.confirm.kind} ticked={ctx.ticked} onTick={ctx.setTicked} onConfirm={() => ctx.onConfirm(item)} onCancel={ctx.onCancel} pending={ctx.approving && busy} />}

        {ctx.alts?.forId === item.id && (
          <div data-testid={`image-alternatives-panel-${item.id}`} className="space-y-2 rounded-xl border border-cream-300 bg-white/70 p-3">
            <div className="flex items-start justify-between gap-2">
              <p className={ctx.alts.result.status === 'ok' ? 'font-medium text-ink' : 'text-amber-900'}>{ctx.alts.result.message}</p>
              <button type="button" onClick={ctx.onCloseAlternatives} className="shrink-0 text-muted underline underline-offset-2 hover:text-ink">
                Close
              </button>
            </div>
            {ctx.alts.result.items.length > 0 && (
              <ul className="grid gap-2">
                {ctx.alts.result.items.map((alt) => (
                  <li key={alt.id} data-testid={`image-alt-card-${alt.id}`} className="space-y-1.5 rounded-lg bg-cream-100 p-2">
                    <div className="flex gap-2">
                      <Preview item={alt} className="h-16 w-16 shrink-0 rounded-md" />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate font-medium" title={alt.title}>
                          {alt.title}
                        </p>
                        <p className="text-muted">
                          {rightsText(alt.rights).headline} · {alt.rights.license}
                          {alt.creator ? ` · ${alt.creator}` : ''} · {sizeText(alt.width, alt.height)}
                        </p>
                        {!alt.rights.eligible && <p className="text-amber-900">Not usable yet: {alt.rights.reason}</p>}
                        {alt.rights.attributionRequired && <p className="text-muted">Credit required{alt.rights.attribution ? `: ${alt.rights.attribution}` : ''}</p>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {ctx.statusOf(alt.id) === 'approved' && <Badge className="bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">Approved</Badge>}
                      {ctx.statusOf(alt.id) !== 'approved' && alt.rights.status !== 'blocked' && alt.rights.status !== 'reference_only' && (
                        <Button type="button" size="sm" variant="outline" data-testid={`image-alt-approve-${alt.id}`} disabled={!!ctx.busyId && ctx.busyId !== alt.id} loading={ctx.busyId === alt.id && ctx.approving} onClick={() => ctx.onApprove(alt, 'alt')}>
                          <Check className="h-3.5 w-3.5" /> Approve for campaign
                        </Button>
                      )}
                      {alt.pageUrl && (
                        <Button asChild size="sm" variant="ghost">
                          <a href={alt.pageUrl} target="_blank" rel="noreferrer noopener">
                            <ExternalLink className="h-3.5 w-3.5" /> View source
                          </a>
                        </Button>
                      )}
                    </div>
                    {ctx.confirm?.id === alt.id && ctx.confirm.where === 'alt' && <ConfirmPanel item={alt} kind={ctx.confirm.kind} ticked={ctx.ticked} onTick={ctx.setTicked} onConfirm={() => ctx.onConfirm(alt)} onCancel={ctx.onCancel} pending={ctx.approving && ctx.busyId === alt.id} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ---- the section --------------------------------------------------------------------------------------------------------------------------

export interface AvailableImagesProps {
  projectId: string;
  /** the campaign design's choice (false without a design) */
  autoStock: boolean;
  /** null = there is no design yet: the automatic mode is part of the design */
  onAutoStock: ((on: boolean) => void) | null;
  /** the step letter of the campaign design, when it is shown as one of its steps */
  letter?: string;
  /** the category shown first (default: approved images) */
  initialTab?: string;
}

export function AvailableImages({ projectId, autoStock, onAutoStock, letter, initialTab }: AvailableImagesProps) {
  const toast = useToast();
  const lib = useImageLibrary(projectId);
  const discover = useDiscoverLibrary(projectId);
  const approve = useApproveImage(projectId);
  const reject = useRejectImage(projectId);
  const restore = useRestoreImage(projectId);
  const alternatives = useImageAlternatives(projectId);
  const upload = useUploadImages(projectId);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const errorLine = React.useRef<HTMLParagraphElement>(null);
  const [tab, setTab] = React.useState<TabId>(TABS.some((t) => t.id === initialTab) ? (initialTab as TabId) : 'approved');
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const [ticked, setTicked] = React.useState(false);
  const [alts, setAlts] = React.useState<{ forId: string; result: AlternativesResult } | null>(null);
  const [refresh, setRefresh] = React.useState(false);

  React.useEffect(() => {
    if (error) errorLine.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  const data = lib.data;
  const items = data?.items ?? [];
  const inTabItems = (t: TabId) => items.filter((i) => inTab(i, t));
  const providers = data?.providers ?? [];
  const licensedConfigured = providers.some((p) => p.kind === 'licensed' && p.configured);
  const canToggle = !!onAutoStock && !!data && (licensedConfigured || autoStock);
  const fail = (e: Error) => setError(e.message);

  const busyId = approve.isPending ? (approve.variables?.id ?? null) : reject.isPending ? (reject.variables ?? null) : restore.isPending ? (restore.variables ?? null) : null;

  function approveNow(item: LibraryItem, v: { attest?: boolean; reviewConfirmed?: boolean } = {}) {
    setError(null);
    approve.mutate(
      { id: item.id, ...v },
      {
        onSuccess: () => {
          setConfirm(null);
          setTicked(false);
          toast.success('Picture approved for the campaign.');
        },
        onError: fail,
      },
    );
  }
  function onApprove(item: LibraryItem, where: Confirm['where']) {
    setError(null);
    setTicked(false);
    if (item.needs === 'attestation') return setConfirm({ id: item.id, kind: 'attestation', where });
    if (item.needs === 'review') return setConfirm({ id: item.id, kind: 'review', where });
    approveNow(item);
  }
  function onConfirm(item: LibraryItem) {
    if (!confirm || !ticked) return;
    approveNow(item, confirm.kind === 'attestation' ? { attest: true } : { reviewConfirmed: true });
  }
  function onReject(item: LibraryItem) {
    setError(null);
    reject.mutate(item.id, { onError: fail });
  }
  function onRestore(item: LibraryItem) {
    setError(null);
    restore.mutate(item.id, { onError: fail });
  }
  function onAlternatives(item: LibraryItem) {
    setError(null);
    alternatives.mutate(item.id, { onSuccess: (result) => setAlts({ forId: item.id, result }), onError: fail });
  }
  function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    if (fileInput.current) fileInput.current.value = '';
    const ok = files.filter((f) => RASTER.test(f.type) && f.size <= MAX_UPLOAD_BYTES).slice(0, 20);
    const skipped = files.filter((f) => !ok.includes(f));
    setError(skipped.length ? `Not uploaded: ${skipped.map((f) => f.name).join(', ')}. Only PNG, JPEG and WebP pictures up to 15 MB (at most 20 at a time) can be used.` : null);
    if (ok.length === 0) return;
    upload.mutate(ok, { onSuccess: () => toast.success(`${ok.length} picture${ok.length === 1 ? '' : 's'} uploaded and approved.`), onError: fail });
  }
  function onDiscover() {
    setError(null);
    discover.mutate(refresh ? { refresh: true } : {}, { onError: fail });
  }

  const ctx: CardCtx = {
    busyId,
    confirm,
    ticked,
    setTicked,
    alts,
    statusOf: (id) => items.find((i) => i.id === id)?.status,
    searchingId: alternatives.isPending ? (alternatives.variables ?? null) : null,
    onApprove,
    onConfirm,
    onCancel: () => {
      setConfirm(null);
      setTicked(false);
    },
    onReject,
    onRestore,
    onAlternatives,
    onCloseAlternatives: () => setAlts(null),
    approving: approve.isPending,
  };

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const shown = inTabItems(active.id);
  const outcomes = discover.data?.outcomes;
  const c = data?.counts;
  // linked profiles that the item list does not show (the list is the source of truth when it has them)
  const listedUrls = new Set(items.filter((i) => i.source === 'social').map((i) => i.pageUrl));
  const profiles = (data?.sources.social ?? []).filter((s) => !listedUrls.has(s.url));

  return (
    <section data-testid="available-images" aria-label="Available images" className="space-y-4 rounded-xl border border-cream-300/80 bg-cream-50/60 p-4">
      <header className="space-y-1">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {letter && <span>{letter} · </span>}
          <span>AVAILABLE IMAGES</span>
        </h5>
        <p className="text-xs text-ink-600">
          The pictures your creatives can be built from: your uploads, approved website and GitHub pictures and licensed stock. Nothing is generated and nothing is used before its rights allow advertising use.
        </p>
        <p data-testid="images-no-ai" className="text-xs font-semibold text-emerald-900">
          AI-generated images: 0
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="images-upload" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> Upload my own
        </Button>
        <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden data-testid="images-upload-input" onChange={(e) => onFiles(e.target.files)} />
        <Button type="button" size="sm" data-testid="images-discover" loading={discover.isPending} onClick={onDiscover}>
          <Search className="h-3.5 w-3.5" /> Find images
        </Button>
        {(data?.stockSearchedAt || discover.data) && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} /> Ignore saved search results
          </label>
        )}
        <span className="text-[11px] text-muted">Searching is free: it looks at your website, your repository, your social links and the licensed providers, and downloads nothing.</span>
      </div>

      {error && (
        <p ref={errorLine} role="alert" data-testid="images-error" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <div data-testid="auto-stock-block" className="space-y-1 rounded-xl border border-cream-300/80 bg-white/60 px-3 py-2.5 text-xs">
        <label className={cn('flex items-start gap-2', canToggle ? 'cursor-pointer' : 'cursor-not-allowed opacity-80')}>
          <input type="checkbox" data-testid="auto-stock-toggle" className="mt-0.5" checked={autoStock} disabled={!canToggle} onChange={(e) => onAutoStock?.(e.target.checked)} />
          <span>
            <strong className="text-sm text-ink">Fully automatic authorized-stock mode</strong>
            <span className="block text-muted">During the run the Visual Researcher may add licensed stock pictures by itself. It uses only licenses the provider clears for advertising, never a license that needs a check, and it records the credit of every picture it adds. Pictures you reject stay rejected.</span>
          </span>
        </label>
        {!onAutoStock && <p className="text-amber-900">Choose a template collection first: this choice is part of the campaign design.</p>}
        {onAutoStock && data && !licensedConfigured && <p className="text-amber-900">Disabled: no licensed image provider is configured on this server, so nothing could be added automatically. {providers.filter((p) => p.kind === 'licensed' && p.setup).map((p) => `${p.label}: ${p.setup}`).join(' · ')}</p>}
        {autoStock && data && !licensedConfigured && onAutoStock && <p className="text-amber-900">The mode is on in your design but cannot work here; switch it off, or configure a provider.</p>}
      </div>

      {outcomes && (
        <ul data-testid="images-outcomes" className="space-y-1.5 rounded-xl border border-cream-300/80 bg-white/60 px-3 py-2.5 text-xs">
          {(['website', 'github', 'social', 'stock'] as const).map((k) => {
            const o = outcomes[k];
            if (!o) return null;
            const st = OUTCOME_STATUS[o.status] ?? { text: o.status, cls: 'bg-cream-200 text-ink-600' };
            return (
              <li key={k} data-testid={`images-outcome-${k}`} data-status={o.status} className="space-y-0.5">
                <p className="flex flex-wrap items-center gap-1.5">
                  <strong>{OUTCOME_LABEL[k]}</strong>
                  <Badge className={cn('px-2 py-0.5 text-[10px]', st.cls)}>{st.text}</Badge>
                  <span className="text-muted">
                    found {o.found}
                    {o.pages !== undefined ? ` · ${o.pages} page${o.pages === 1 ? '' : 's'} read` : ''}
                    {o.added !== undefined ? ` · ${o.added} new` : ''}
                    {o.rejected ? ` · ${o.rejected} not usable` : ''}
                  </span>
                </p>
                <p>{o.message}</p>
                {(o.notes ?? []).map((n) => (
                  <p key={n} className="text-muted">
                    {n}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {lib.isLoading && <div className="h-40 animate-pulse rounded-xl bg-cream-200" />}
      {lib.isError && (
        <p role="alert" data-testid="images-load-error" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> The images could not be loaded: {lib.error.message}
          <button type="button" onClick={() => lib.refetch()} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}

      {data && (
        <>
          <p data-testid="images-counts" className="text-xs text-ink-600">
            <strong>{c?.usable ?? 0} usable</strong> · {c?.approved ?? 0} approved · {c?.candidates ?? 0} waiting for you · {c?.rejected ?? 0} rejected · {c?.restricted ?? 0} restricted
            <span className="text-muted">
              {' '}
              — by source: {c?.upload ?? 0} uploaded, {c?.website ?? 0} website, {c?.github ?? 0} GitHub, {c?.social ?? 0} social, {c?.stock ?? 0} stock
            </span>
          </p>
          <p className="text-xs text-muted">
            {data.sources.website ? <>Website: {data.sources.website}</> : 'No website is saved in this project'}
            {' · '}
            {data.sources.repository ? <>Repository: {data.sources.repository}</> : 'no repository is saved'}.
            {!data.sources.website && !data.sources.repository ? ' Without them only your uploads and licensed stock can be used.' : ''}
          </p>
          {data.collectionNeeds && <p className="text-xs text-ink-600">Your template collection: {data.collectionNeeds}</p>}
          {data.notes.map((n) => (
            <p key={n} className="flex items-start gap-2 text-xs text-amber-900">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {n}
            </p>
          ))}

          <div role="tablist" aria-label="Image categories" className="flex flex-wrap gap-1.5">
            {TABS.map((t) => {
              const n = inTabItems(t.id).length + (t.id === 'social' ? profiles.length : 0);
              return (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`images-tab-${t.id}`} onClick={() => setTab(t.id)} className={cn('rounded-full border px-3 py-1 text-xs', tab === t.id ? 'border-accent bg-accent-soft/50 font-medium text-ink' : 'border-cream-300 bg-cream-50 text-muted hover:text-ink')}>
                  {t.label} <span className="tabular-nums text-muted">({n})</span>
                </button>
              );
            })}
          </div>

          <div role="tabpanel" data-testid={`images-panel-${active.id}`} className="space-y-3">
            <p className="text-xs text-muted">{active.help}</p>
            {shown.length === 0 && (active.id !== 'social' || profiles.length === 0) && (
              <p data-testid="images-empty" className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-xs text-muted">
                {active.id === 'approved'
                  ? 'No approved picture yet. Until you approve one the creatives are drawn with typography only (text-first). Upload a picture you own or approve a candidate.'
                  : active.id === 'restricted'
                    ? 'Nothing is restricted or rejected.'
                    : active.id === 'upload'
                      ? 'You have not uploaded a picture yet. “Upload my own” adds PNG, JPEG or WebP files.'
                      : 'Nothing here yet. “Find images” looks for pictures; it is free and downloads nothing.'}
              </p>
            )}
            {shown.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((item) => (
                  <ImageCard key={item.id} item={item} ctx={ctx} />
                ))}
              </ul>
            )}
            {active.id === 'social' && profiles.length > 0 && (
              <ul data-testid="images-social-profiles" className="space-y-1.5">
                {profiles.map((s) => (
                  <li key={s.url} className="flex flex-wrap items-center gap-2 rounded-xl bg-cream-100 px-3 py-2 text-xs">
                    <Badge className="bg-amber-100 px-2 py-0.5 text-[10px] text-amber-900">Reference only</Badge>
                    <strong className="capitalize">{s.platform}</strong>
                    <span className="min-w-0 flex-1 text-muted">
                      {s.note}
                      {s.manualImport ? ' To use a picture from this profile, save it yourself and use “Upload my own”.' : ''}
                    </span>
                    <a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                      View source <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Image providers</p>
            <ProviderList providers={providers} testId="images-providers" />
          </div>
        </>
      )}
    </section>
  );
}
