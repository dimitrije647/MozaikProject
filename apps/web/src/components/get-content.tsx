'use client';

import * as React from 'react';
import { AlertCircle, Check, CheckCircle2, Circle, ExternalLink, ImageOff, Loader2, MinusCircle, Search, Upload, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  LOGO_SOURCE_LABEL,
  SOURCE_NAME,
  SOURCE_ORDER,
  useApproveLogo,
  useApprovePhotosBatch,
  useCancelGetContent,
  useGetContent,
  useRejectLogo,
  useRejectPhotosBatch,
  useRestoreLogo,
  useStartGetContent,
  useUploadLogo,
  type BatchResult,
  type GetContentRunStatus,
  type GetContentRunView,
  type GetContentSourceStatus,
  type GetContentSourceView,
  type GetContentState,
  type LogoCandidateView,
} from '@/lib/get-content';
import { SOURCE_LABEL, rightsText, sizeText, useApproveImage, useImageLibrary, useRestoreImage, useUploadImages, type LibraryItem } from '@/lib/images';
import { PALETTE_ROLES, ROLE_LABELS, SOURCE_LABELS, isHex, type CampaignDesignData, type Confidence, type PaletteRole, type PaletteSuggestionData } from '@/lib/visual';
import { cn, formatDate } from '@/lib/utils';

/*
 * GET CONTENT: the optional step of the Campaign Design that finds the real logo, useful photographs and brand colors in what the owner already
 * supplied (uploads, official website, GitHub repository, previously approved assets) and lets the owner approve what to use. It is FREE: no image
 * or text model is called, no campaign starts and no budget is involved. Until the button is pressed this component only reads the stored state
 * (one cheap GET). Nothing is selected or approved by default; the palette suggestion is applied only through the Campaign Design's own palette
 * editor (colors the owner edited are never overwritten), and this file keeps no palette of its own.
 */

type PaletteSuggestion = PaletteSuggestionData['suggestion'];

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_TYPE = /^image\/(png|jpe?g|webp|svg\+xml)$/i;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const RASTER = /^image\/(png|jpe?g|webp)$/i;
const LOGO_ATTEST_TEXT = 'I own this logo or have the rights to use it in advertising for this business.';
const PHOTOS_ATTEST_TEXT = 'I own these pictures or have the rights to use them in advertising for this business.';
const REVIEW_TEXT = 'I checked the license at its source.';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const pretty = (s: string) => s.replace(/_/g, ' ');
/** A checkerboard behind a logo, so a white or transparent logo is visible. */
const CHECKER: React.CSSProperties = { backgroundImage: 'conic-gradient(#e9e3d7 25%, #f6f2ea 0 50%, #e9e3d7 0 75%, #f6f2ea 0)', backgroundSize: '16px 16px' };
const CONF_STYLE: Record<Confidence, string> = { high: 'bg-emerald-100 text-emerald-800', medium: 'bg-amber-100 text-amber-900', low: 'bg-cream-200 text-ink-600' };
const CONF_BAR: Record<Confidence, string> = { high: 'bg-emerald-500', medium: 'bg-amber-400', low: 'bg-cream-300' };
const TONE = { ok: 'bg-emerald-100 text-emerald-800', wait: 'bg-amber-100 text-amber-900', no: 'bg-red-100 text-red-700' } as const;

const SOURCE_STATUS: Record<GetContentSourceStatus, { text: string; cls: string }> = {
  pending: { text: 'Waiting', cls: 'bg-cream-200 text-ink-600' },
  running: { text: 'In progress', cls: 'bg-sky-100 text-sky-800' },
  ok: { text: 'Analyzed', cls: 'bg-emerald-100 text-emerald-800' },
  empty: { text: 'Analyzed, nothing found', cls: 'bg-cream-200 text-ink-600' },
  unavailable: { text: 'Not analyzed: unavailable', cls: 'bg-amber-100 text-amber-900' },
  blocked: { text: 'Not analyzed: blocked', cls: 'bg-amber-100 text-amber-900' },
  failed: { text: 'Not analyzed: failed', cls: 'bg-red-100 text-red-700' },
  skipped: { text: 'Skipped', cls: 'bg-cream-200 text-ink-600' },
  cancelled: { text: 'Cancelled', cls: 'bg-cream-200 text-ink-600' },
};

const RUN_STATUS: Record<GetContentRunStatus, { text: string; cls: string }> = {
  running: { text: 'Searching your sources…', cls: 'bg-sky-100 text-sky-800' },
  completed: { text: 'Finished', cls: 'bg-emerald-100 text-emerald-800' },
  partial: { text: 'Finished, but some sources could not be analyzed', cls: 'bg-amber-100 text-amber-900' },
  failed: { text: 'Failed', cls: 'bg-red-100 text-red-700' },
  cancelled: { text: 'Cancelled', cls: 'bg-cream-200 text-ink-600' },
  interrupted: { text: 'Interrupted before it finished', cls: 'bg-amber-100 text-amber-900' },
};

function SourceIcon({ status }: { status: GetContentSourceStatus }) {
  const cls = 'mt-0.5 h-4 w-4 shrink-0';
  if (status === 'running') return <Loader2 aria-hidden className={cn(cls, 'animate-spin text-sky-700')} />;
  if (status === 'ok') return <CheckCircle2 aria-hidden className={cn(cls, 'text-emerald-700')} />;
  if (status === 'failed') return <XCircle aria-hidden className={cn(cls, 'text-red-600')} />;
  if (status === 'unavailable' || status === 'blocked') return <AlertCircle aria-hidden className={cn(cls, 'text-amber-700')} />;
  if (status === 'pending') return <Circle aria-hidden className={cn(cls, 'text-muted')} />;
  return <MinusCircle aria-hidden className={cn(cls, 'text-muted')} />;
}

function Block({ testId, title, hint, children }: { testId: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} aria-label={title} className="space-y-3 rounded-xl border border-cream-300/80 bg-white/60 p-3">
      <div>
        <h6 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h6>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p role="alert" data-testid={testId} className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}

// ---- the sources of one run ---------------------------------------------------------------------------------------------------------------------

function foundText(f: GetContentSourceView['found']): string {
  const parts = [f.logos > 0 && `${f.logos} logo${f.logos === 1 ? '' : 's'}`, f.photos > 0 && `${f.photos} photo${f.photos === 1 ? '' : 's'}`, f.colors > 0 && `${f.colors} color${f.colors === 1 ? '' : 's'}`].filter(Boolean) as string[];
  return parts.join(' · ');
}

/** One row per source with what really happened to it. A source that could not be read says so: it is never described as analyzed. */
function SourcesList({ run }: { run: GetContentRunView }) {
  const rank = (id: string) => {
    const i = SOURCE_ORDER.indexOf(id as (typeof SOURCE_ORDER)[number]);
    return i < 0 ? SOURCE_ORDER.length : i;
  };
  const sources = [...run.sources].sort((a, b) => rank(a.id) - rank(b.id));
  return (
    <ul data-testid="gc-sources" aria-label="Sources" aria-live="polite" className="space-y-1.5 rounded-xl border border-cream-300/80 bg-white/60 px-3 py-2.5 text-xs">
      {sources.map((s) => {
        const st = SOURCE_STATUS[s.status] ?? { text: s.status, cls: 'bg-cream-200 text-ink-600' };
        const found = foundText(s.found);
        return (
          <li key={s.id} data-testid={`gc-source-${s.id}`} data-status={s.status} className="flex items-start gap-2">
            <SourceIcon status={s.status} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <strong className="text-sm text-ink">{s.label || SOURCE_NAME[s.id] || s.id}</strong>
                <Badge className={cn('px-2 py-0.5 text-[10px]', st.cls)}>{st.text}</Badge>
                {found && <span className="text-muted">found {found}</span>}
              </p>
              {s.message && <p className="text-ink-600">{s.message}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RunSummary({ run }: { run: GetContentRunView }) {
  const s = run.summary;
  const row = (k: string, v: React.ReactNode, testId: string) => (
    <div key={k} data-testid={testId} className="rounded-lg bg-cream-100 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="text-sm font-semibold leading-tight">{v}</dd>
    </div>
  );
  return (
    <div className="space-y-2">
      <dl data-testid="gc-summary" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {row('Uploads inspected', s.uploadsInspected, 'gc-summary-uploads')}
        {row('Website inspected', s.websiteInspected ? 'Yes' : 'No', 'gc-summary-website')}
        {row('GitHub inspected', s.githubInspected ? 'Yes' : 'No', 'gc-summary-github')}
        {row('Images found', s.imagesFound, 'gc-summary-images')}
        {row('Eligible for approval', s.imagesEligibleForApproval, 'gc-summary-eligible')}
        {row('Logo candidates', s.logoCandidates, 'gc-summary-logos')}
        {row('Unavailable sources', s.sourcesUnavailable.length ? s.sourcesUnavailable.join(', ') : 'none', 'gc-summary-unavailable')}
      </dl>
      {run.notes.length > 0 && (
        <ul data-testid="gc-notes" className="space-y-1 text-xs text-amber-900">
          {run.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- LOGO ---------------------------------------------------------------------------------------------------------------------------------------

/** A logo candidate's picture, exactly as the server allows it to be shown. A preview of kind 'none' is a neutral placeholder with the server's note, never a guess. */
function LogoPreview({ c }: { c: LogoCandidateView }) {
  const p = c.preview;
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [p.url]);
  if (p.kind === 'none' || !p.url || failed) {
    return (
      <div data-testid={`gc-logo-preview-none-${c.id}`} className="flex h-32 w-full flex-col items-center justify-center gap-1.5 bg-cream-200/70 px-3 text-center text-[11px] text-muted">
        <ImageOff className="h-5 w-5" />
        <span>{failed ? 'The preview could not be loaded.' : (p.note ?? 'No preview is available for this logo.')}</span>
      </div>
    );
  }
  return (
    <div className="relative flex h-32 w-full items-center justify-center overflow-hidden p-3" style={CHECKER}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.url} alt={c.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      {p.kind === 'remote' && <span className="absolute bottom-1 left-1 rounded bg-ink/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white">Preview, not stored</span>}
    </div>
  );
}

function LogoCard({ c, busy, anyBusy, approving, confirming, ticked, onTick, onChoose, onConfirm, onCancel, onReject, onRestore }: {
  c: LogoCandidateView;
  busy: boolean;
  anyBusy: boolean;
  approving: boolean;
  confirming: boolean;
  ticked: boolean;
  onTick: (on: boolean) => void;
  onChoose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onReject: () => void;
  onRestore: () => void;
}) {
  const has = (a: LogoCandidateView['actions'][number]) => c.actions.includes(a);
  const level = Math.max(0, Math.min(1, c.confidence));
  const rightsTone = c.rights.eligible ? 'ok' : c.needs === 'attestation' ? 'wait' : 'no';
  const rightsHeadline = c.rights.eligible ? 'Cleared for use' : c.needs === 'attestation' ? 'Waiting for your rights confirmation' : 'Not usable yet';
  return (
    <li data-testid={`gc-logo-card-${c.id}`} data-source={c.source} data-status={c.status} className={cn('flex flex-col overflow-hidden rounded-2xl border bg-cream-50', c.status === 'rejected' ? 'border-dashed border-cream-300 opacity-80' : 'border-cream-300/80')}>
      <LogoPreview c={c} />
      <div className="flex flex-1 flex-col gap-2 p-3 text-xs">
        <div className="space-y-1">
          <p className="break-words text-sm font-medium" title={c.title}>
            {c.title}
          </p>
          <p className="break-all font-mono text-[11px] text-muted" title={c.fileName}>
            {c.fileName}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-muted">
            <Badge className="bg-cream-200 px-2 py-0.5 text-[11px] text-ink-600">{LOGO_SOURCE_LABEL[c.source] ?? c.source}</Badge>
            {c.svg ? (
              <Badge data-testid={`gc-logo-svg-${c.id}`} title="A vector logo: sharp at any size" className="bg-sky-100 px-2 py-0.5 text-[11px] text-sky-800">
                SVG
              </Badge>
            ) : (
              <Badge className="bg-cream-200 px-2 py-0.5 text-[11px] uppercase text-ink-600">{c.format}</Badge>
            )}
            {c.favicon && (
              <Badge data-testid={`gc-logo-favicon-${c.id}`} title="A small site icon: it may look blurry when enlarged" className="bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900">
                Favicon
              </Badge>
            )}
            {c.status === 'approved' && <Badge className="bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">Approved</Badge>}
            {c.status === 'rejected' && <Badge className="bg-red-100 px-2 py-0.5 text-[11px] text-red-700">Rejected</Badge>}
            <span>{sizeText(c.width, c.height)}</span>
          </p>
        </div>

        <div data-testid={`gc-logo-confidence-${c.id}`} className="space-y-1">
          <p className="flex items-center gap-1.5">
            <Badge className={cn('px-2 py-0.5 text-[10px]', CONF_STYLE[c.confidenceLabel])}>{c.confidenceLabel === 'high' ? 'High' : c.confidenceLabel === 'medium' ? 'Medium' : 'Low'} confidence</Badge>
            <span className="tabular-nums text-muted">{pct(level)} sure this is your logo</span>
          </p>
          <div role="meter" aria-label="Confidence that this is your logo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="h-1.5 overflow-hidden rounded-full bg-cream-200">
            <div className={cn('h-full rounded-full', CONF_BAR[c.confidenceLabel])} style={{ width: pct(level) }} />
          </div>
        </div>

        {c.signals.length > 0 && (
          <ul data-testid={`gc-logo-signals-${c.id}`} className="flex flex-wrap gap-1">
            {c.signals.map((s, i) => (
              <li key={i} className="rounded-full bg-cream-200 px-2 py-0.5 text-[11px] text-ink-600">
                {s}
              </li>
            ))}
          </ul>
        )}

        <div data-testid={`gc-logo-rights-${c.id}`} data-eligible={c.rights.eligible ? 'yes' : 'no'} className="space-y-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge className={cn('px-2 py-0.5 text-[11px]', TONE[rightsTone])}>{rightsHeadline}</Badge>
            <span className="text-muted">{pretty(c.rights.verification)}</span>
          </p>
          <p>
            <span className="text-muted">License:</span> {c.rights.license}
          </p>
          <p className={cn(c.rights.eligible ? 'text-muted' : 'rounded-lg bg-amber-50 px-2 py-1 text-amber-950')}>{c.rights.reason}</p>
        </div>
        {c.note && <p className="text-muted">{c.note}</p>}

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {has('approve') && c.status !== 'approved' && (
            <Button type="button" size="sm" data-testid={`gc-logo-approve-${c.id}`} loading={busy && approving} disabled={anyBusy && !busy} onClick={onChoose}>
              <Check className="h-3.5 w-3.5" /> Choose
            </Button>
          )}
          {has('reject') && (
            <Button type="button" size="sm" variant="outline" data-testid={`gc-logo-reject-${c.id}`} loading={busy && !approving} disabled={anyBusy && !busy} onClick={onReject}>
              Reject
            </Button>
          )}
          {has('restore') && (
            <Button type="button" size="sm" variant="outline" data-testid={`gc-logo-restore-${c.id}`} loading={busy && !approving} disabled={anyBusy && !busy} onClick={onRestore}>
              Restore
            </Button>
          )}
          {has('view_source') && c.pageUrl && (
            <Button asChild size="sm" variant="ghost">
              <a href={c.pageUrl} target="_blank" rel="noreferrer noopener" data-testid={`gc-logo-source-${c.id}`}>
                <ExternalLink className="h-3.5 w-3.5" /> View source
              </a>
            </Button>
          )}
        </div>

        {confirming && (
          <div data-testid={`gc-logo-confirm-${c.id}`} className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/30 p-3">
            <p className="text-[11px] text-muted">LaunchPilot stores this logo in your project and places it on your creatives only after you confirm.</p>
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input type="checkbox" data-testid="gc-logo-attest" className="mt-0.5" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
              <span>{LOGO_ATTEST_TEXT}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" data-testid="gc-logo-attest-confirm" disabled={!ticked} loading={approving && busy} onClick={onConfirm}>
                <Check className="h-3.5 w-3.5" /> Confirm and use this logo
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function LogoBlock({ projectId, state }: { projectId: string; state: GetContentState }) {
  const toast = useToast();
  const approve = useApproveLogo(projectId);
  const reject = useRejectLogo(projectId);
  const restore = useRestoreLogo(projectId);
  const upload = useUploadLogo(projectId);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [done, setDone] = React.useState(false);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const approved = state.logo.approved;
  const candidates = state.logo.candidates;
  const busyId = approve.isPending ? approve.variables?.candidateId : reject.isPending ? reject.variables : restore.isPending ? restore.variables : undefined;
  const anyBusy = approve.isPending || reject.isPending || restore.isPending || upload.isPending;
  const fail = (e: Error) => setError(e.message);

  function approveNow(c: LogoCandidateView, attest: boolean) {
    setError(null);
    approve.mutate(attest ? { candidateId: c.id, attest: true } : { candidateId: c.id }, {
      onSuccess: () => {
        setConfirmId(null);
        setTicked(false);
        toast.success('Logo approved for this project.');
      },
      onError: (e) => {
        setError(e.message);
        // the server asks for the owner's word about a website or repository logo: ask for it here
        if (e.status === 422 && !attest && (c.source === 'website' || c.source === 'github')) {
          setConfirmId(c.id);
          setTicked(false);
        }
      },
    });
  }
  function onChoose(c: LogoCandidateView) {
    setError(null);
    setTicked(false);
    if (c.needs === 'attestation') return setConfirmId(c.id);
    approveNow(c, false);
  }
  function onFile(list: FileList | null) {
    const file = list?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    if (!(LOGO_TYPE.test(file.type) || /\.svg$/i.test(file.name)) || file.size > MAX_LOGO_BYTES) {
      setError(`Not uploaded: ${file.name}. A logo must be one PNG, JPEG, WebP or SVG file up to 5 MB.`);
      return;
    }
    setError(null);
    upload.mutate(file, { onSuccess: () => toast.success('Logo uploaded and approved.'), onError: fail });
  }

  if (done && !approved) {
    return (
      <Block testId="gc-logo" title="Logo">
        <p className="text-xs text-muted">Continuing without a logo for now. Nothing was approved or changed.</p>
        <Button type="button" size="sm" variant="outline" data-testid="gc-logo-show" onClick={() => setDone(false)}>
          Show logo options
        </Button>
      </Block>
    );
  }

  return (
    <Block testId="gc-logo" title="Logo" hint="Your real company logo goes on the creatives. Nothing is chosen for you: pick one, upload another, or continue without.">
      {approved && (
        <div data-testid="gc-logo-approved" className="flex flex-wrap items-center gap-4 rounded-xl border border-emerald-300 bg-emerald-50/60 p-3">
          <div className="flex h-28 w-48 shrink-0 items-center justify-center overflow-hidden rounded-lg p-2 ring-1 ring-ink/10" style={CHECKER}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={approved.previewUrl} alt={`Approved logo: ${approved.title}`} className="max-h-full max-w-full object-contain" />
          </div>
          <div className="min-w-0 flex-1 space-y-1 text-xs">
            <p className="flex flex-wrap items-center gap-1.5">
              <Badge className="bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">
                <CheckCircle2 className="h-3 w-3" /> Approved logo
              </Badge>
              <strong className="text-sm text-ink">{approved.title}</strong>
            </p>
            <p data-testid="gc-logo-approved-on">Approved on {formatDate(approved.approvedAt)}</p>
            <p className="text-muted">
              {approved.format.toUpperCase()} · {sizeText(approved.width, approved.height)} · {approved.source}
            </p>
            <p className="text-muted">
              Rights: {pretty(approved.rights.verification)} · License: {approved.rights.license}
              {approved.rights.attestedAt ? ` · you confirmed the rights on ${formatDate(approved.rights.attestedAt)}` : ''}
            </p>
          </div>
        </div>
      )}

      {candidates.length === 0 && !approved && (
        <p data-testid="gc-logo-empty" className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-4 text-center text-xs text-muted">
          No logo was found in the sources that could be read. You can upload one below or continue without: your creatives then use your brand name where a logo would go.
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <p className="text-xs text-ink-600">
            {candidates.length} logo candidate{candidates.length === 1 ? '' : 's'} found. The confidence says how likely each file is your company logo, from the signals listed on the card.
          </p>
          <ul data-testid="gc-logo-candidates" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {candidates.map((c) => (
              <LogoCard
                key={c.id}
                c={c}
                busy={busyId === c.id}
                anyBusy={anyBusy}
                approving={approve.isPending}
                confirming={confirmId === c.id}
                ticked={ticked}
                onTick={setTicked}
                onChoose={() => onChoose(c)}
                onConfirm={() => ticked && approveNow(c, true)}
                onCancel={() => {
                  setConfirmId(null);
                  setTicked(false);
                }}
                onReject={() => {
                  setError(null);
                  reject.mutate(c.id, { onError: fail });
                }}
                onRestore={() => {
                  setError(null);
                  restore.mutate(c.id, { onError: fail });
                }}
              />
            ))}
          </ul>
        </>
      )}

      {error && <ErrorLine testId="gc-logo-error">{error}</ErrorLine>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="gc-logo-upload-button" loading={upload.isPending} disabled={anyBusy && !upload.isPending} onClick={() => fileInput.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> Upload a different logo
        </Button>
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" data-testid="gc-logo-upload" onChange={(e) => onFile(e.target.files)} />
        {!approved && (
          <Button type="button" size="sm" variant="ghost" data-testid="gc-logo-none" onClick={() => setDone(true)}>
            Continue without a logo
          </Button>
        )}
        <span className="text-[11px] text-muted">One PNG, JPEG, WebP or SVG file up to 5 MB. A file you upload is yours, so it is approved at once.</span>
      </div>
    </Block>
  );
}

// ---- PHOTOGRAPHS --------------------------------------------------------------------------------------------------------------------------------

/** The discovered photographs: candidates and approved pictures from the owner's own sources. Social links and licensed stock have their own flows. */
const isPhoto = (i: LibraryItem) => (i.role ?? 'photo') === 'photo' && (i.source === 'website' || i.source === 'github' || i.source === 'upload');
const isWaiting = (i: LibraryItem) => i.status === 'candidate';
/** A batch can approve it: the server offers the action, the rights are not blocked, and no license check is needed first. */
const batchApprovable = (i: LibraryItem) => i.status === 'candidate' && i.actions.includes('approve') && i.needs !== 'review' && i.rights.status !== 'blocked' && i.rights.status !== 'reference_only';
const STATUS_LABEL: Record<LibraryItem['status'], { text: string; cls: string }> = {
  approved: { text: 'Approved', cls: 'bg-emerald-100 text-emerald-800' },
  candidate: { text: 'Waiting for you', cls: 'bg-cream-200 text-ink-600' },
  rejected: { text: 'Rejected', cls: 'bg-red-100 text-red-700' },
};

function PhotoPreview({ item, className }: { item: LibraryItem; className?: string }) {
  const p = item.preview;
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [p.url]);
  if (p.kind === 'none' || !p.url || failed) {
    return (
      <div data-testid={`gc-photo-preview-none-${item.id}`} className={cn('flex flex-col items-center justify-center gap-1.5 bg-cream-200/70 px-3 text-center text-[11px] text-muted', className)}>
        <ImageOff className="h-5 w-5" />
        <span>{failed ? 'The preview could not be loaded.' : (p.note ?? 'No preview is available for this picture.')}</span>
      </div>
    );
  }
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-cream-200/70', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.url} alt={item.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      {p.kind !== 'asset' && <span className="absolute bottom-1 right-1 rounded bg-ink/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white">{p.kind === 'thumbnail' ? 'Provider thumbnail' : 'Preview, not stored'}</span>}
    </div>
  );
}

function PhotoCard({ item, selected, onToggle, busy, review }: {
  item: LibraryItem;
  selected: boolean;
  onToggle: () => void;
  busy: boolean;
  review: { open: boolean; ticked: boolean; pending: boolean; onOpen: () => void; onTick: (on: boolean) => void; onConfirm: () => void; onCancel: () => void };
}) {
  const t = rightsText(item.rights);
  const selectable = item.actions.includes('approve') || item.actions.includes('reject');
  const relevance = item.relevance ?? item.score;
  return (
    <li data-testid={`gc-photo-card-${item.id}`} data-source={item.source} data-status={item.status} data-selected={selected ? 'yes' : 'no'} className={cn('flex flex-col overflow-hidden rounded-2xl border bg-cream-50', selected ? 'border-accent ring-2 ring-accent/30' : 'border-cream-300/80')}>
      <div className="relative">
        <PhotoPreview item={item} className="h-40 w-full" />
        <label className={cn('absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-white/90 px-2 py-1 text-[11px] font-medium shadow-sm', selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-70')}>
          <input type="checkbox" data-testid={`gc-photo-select-${item.id}`} aria-label={`Select ${item.title}`} checked={selected} disabled={!selectable || busy} onChange={onToggle} /> Select
        </label>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3 text-xs">
        <div className="space-y-1">
          <p className="break-words text-sm font-medium" title={item.title}>
            {item.title}
          </p>
          <p className="flex flex-wrap items-center gap-1.5 text-muted">
            <Badge className="bg-cream-200 px-2 py-0.5 text-[11px] text-ink-600">{SOURCE_LABEL[item.source]}</Badge>
            <Badge className={cn('px-2 py-0.5 text-[11px]', STATUS_LABEL[item.status].cls)}>{STATUS_LABEL[item.status].text}</Badge>
            <span>{sizeText(item.width, item.height)}</span>
          </p>
        </div>
        <p data-testid={`gc-photo-relevance-${item.id}`}>
          {relevance === null ? <span className="text-muted">No relevance score.</span> : (
            <>
              <span className="text-muted">Relevance</span> <strong>{pct(relevance)}</strong>
              {item.scoreEstimated && <span className="ml-1 text-muted">(estimated)</span>}
            </>
          )}
        </p>
        <div data-testid={`gc-photo-rights-${item.id}`} data-eligible={item.rights.eligible ? 'yes' : 'no'} className="space-y-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge className={cn('px-2 py-0.5 text-[11px]', TONE[t.tone])}>{t.headline}</Badge>
            <span className="text-muted">{t.verification}</span>
          </p>
          <p>
            <span className="text-muted">License:</span> {item.rights.license}
          </p>
          {!item.rights.eligible && <p className="rounded-lg bg-amber-50 px-2 py-1 text-amber-950">{item.rights.reason}</p>}
        </div>
        <p data-testid={`gc-photo-usage-${item.id}`} className="rounded-lg bg-cream-100 px-2 py-1.5 text-ink-600">
          <span className="font-medium text-ink">Suggested use:</span> {item.selection}
        </p>
        {item.needs === 'review' && item.status === 'candidate' && (
          <div className="space-y-2">
            <p className="text-amber-900">Its license needs a check at the source, so it cannot be approved in a batch.</p>
            {!review.open && (
              <Button type="button" size="sm" variant="outline" data-testid={`gc-photo-approve-single-${item.id}`} disabled={busy} onClick={review.onOpen}>
                Approve individually
              </Button>
            )}
            {review.open && (
              <div data-testid={`gc-photo-review-${item.id}`} className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/30 p-3">
                <p className="text-[11px]">
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
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input type="checkbox" data-testid="gc-photo-review-check" className="mt-0.5" checked={review.ticked} onChange={(e) => review.onTick(e.target.checked)} />
                  <span>{REVIEW_TEXT}</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" data-testid="gc-photo-review-confirm" disabled={!review.ticked} loading={review.pending} onClick={review.onConfirm}>
                    <Check className="h-3.5 w-3.5" /> Approve with my license check
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={review.onCancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {item.pageUrl && (
          <a href={item.pageUrl} target="_blank" rel="noreferrer noopener" data-testid={`gc-photo-source-${item.id}`} className="mt-auto inline-flex items-center gap-1 text-muted underline underline-offset-2 hover:text-ink">
            <ExternalLink className="h-3 w-3" /> View source
          </a>
        )}
      </div>
    </li>
  );
}

interface BatchOutcome {
  kind: 'approve' | 'reject';
  rows: { result: BatchResult; title: string }[];
}

function PhotosBlock({ projectId, show }: { projectId: string; show: boolean }) {
  const toast = useToast();
  const lib = useImageLibrary(projectId, show);
  const approveBatch = useApprovePhotosBatch(projectId);
  const rejectBatch = useRejectPhotosBatch(projectId);
  const approveOne = useApproveImage(projectId);
  const restore = useRestoreImage(projectId);
  const upload = useUploadImages(projectId);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = React.useState<'skip' | 'none' | null>(null);
  const [sel, setSel] = React.useState<ReadonlySet<string>>(new Set());
  const [attest, setAttest] = React.useState(false);
  const [reviewId, setReviewId] = React.useState<string | null>(null);
  const [reviewTicked, setReviewTicked] = React.useState(false);
  const [outcome, setOutcome] = React.useState<BatchOutcome | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const all = lib.data?.items ?? [];
  const items = all.filter((i) => isPhoto(i) && (i.status === 'candidate' || i.status === 'approved'));
  const rejected = all.filter((i) => isPhoto(i) && i.status === 'rejected');
  const approvedN = items.filter((i) => i.status === 'approved').length;
  const waitingN = items.filter(isWaiting).length;
  const selected = items.filter((i) => sel.has(i.id));
  const toApprove = selected.filter(batchApprovable);
  const toReject = selected.filter((i) => i.actions.includes('reject'));
  const needsAttest = toApprove.some((i) => i.needs === 'attestation');
  const batchBusy = approveBatch.isPending || rejectBatch.isPending;
  const fail = (e: Error) => setError(e.message);

  const toggle = (id: string) =>
    setSel((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function titles(list: LibraryItem[]) {
    return new Map(list.map((i) => [i.id, i.title]));
  }
  function runBatch(kind: 'approve' | 'reject') {
    setError(null);
    setOutcome(null);
    const list = kind === 'approve' ? toApprove : toReject;
    const names = titles(list);
    const onSuccess = (r: { results: BatchResult[] }) => {
      const rows = r.results.map((result) => ({ result, title: names.get(result.id) ?? result.item?.title ?? result.id }));
      setOutcome({ kind, rows });
      const okIds = new Set(r.results.filter((x) => x.ok).map((x) => x.id));
      setSel((cur) => new Set([...cur].filter((id) => !okIds.has(id))));
      setAttest(false);
      const okN = okIds.size;
      if (okN > 0) toast.success(kind === 'approve' ? `${okN} picture${okN === 1 ? '' : 's'} approved.` : `${okN} picture${okN === 1 ? '' : 's'} rejected.`);
    };
    if (kind === 'approve') approveBatch.mutate({ ids: list.map((i) => i.id), ...(needsAttest && attest ? { attest: true } : {}) }, { onSuccess, onError: fail });
    else rejectBatch.mutate({ ids: list.map((i) => i.id) }, { onSuccess, onError: fail });
  }
  function confirmReview(item: LibraryItem) {
    if (!reviewTicked) return;
    setError(null);
    approveOne.mutate(
      { id: item.id, reviewConfirmed: true },
      {
        onSuccess: () => {
          setReviewId(null);
          setReviewTicked(false);
          toast.success('Picture approved for the campaign.');
        },
        onError: fail,
      },
    );
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

  if (collapsed) {
    return (
      <Block testId="gc-photos" title="Photographs">
        <p className="text-xs text-muted">{collapsed === 'skip' ? 'Images skipped for now.' : 'Continuing without images.'} Nothing was approved or changed.</p>
        <Button type="button" size="sm" variant="outline" data-testid="gc-photos-show" onClick={() => setCollapsed(null)}>
          Show images
        </Button>
      </Block>
    );
  }

  return (
    <Block testId="gc-photos" title="Photographs" hint="Useful pictures found in your uploads, on your website and in your repository. Nothing is selected for you; tick the ones you want and approve them.">
      {lib.isLoading && <div className="h-32 animate-pulse rounded-xl bg-cream-200" />}
      {lib.isError && (
        <p role="alert" data-testid="gc-photos-load-error" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> The pictures could not be loaded: {lib.error.message}
          <button type="button" onClick={() => lib.refetch()} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}

      {lib.data && (
        <>
          <p data-testid="gc-photos-counts" className="text-xs text-ink-600">
            <strong>
              {items.length} picture{items.length === 1 ? '' : 's'} found
            </strong>{' '}
            · {approvedN} approved · {waitingN} waiting for you · {rejected.length} rejected · {selected.length} selected
          </p>

          {items.length === 0 ? (
            <p data-testid="gc-photos-empty" className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-4 text-center text-xs text-muted">
              No photograph from your uploads, website or repository is waiting for you. You can upload your own below or continue without images.
            </p>
          ) : (
            <ul data-testid="gc-photos-list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <PhotoCard
                  key={item.id}
                  item={item}
                  selected={sel.has(item.id)}
                  onToggle={() => toggle(item.id)}
                  busy={batchBusy}
                  review={{
                    open: reviewId === item.id,
                    ticked: reviewTicked,
                    pending: approveOne.isPending && approveOne.variables?.id === item.id,
                    onOpen: () => {
                      setReviewId(item.id);
                      setReviewTicked(false);
                    },
                    onTick: setReviewTicked,
                    onConfirm: () => confirmReview(item),
                    onCancel: () => {
                      setReviewId(null);
                      setReviewTicked(false);
                    },
                  }}
                />
              ))}
            </ul>
          )}

          {needsAttest && (
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-accent/40 bg-accent-soft/30 px-3 py-2 text-xs">
              <input type="checkbox" data-testid="gc-photos-attest" className="mt-0.5" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
              <span>{PHOTOS_ATTEST_TEXT}</span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" data-testid="gc-photos-approve" loading={approveBatch.isPending} disabled={toApprove.length === 0 || (needsAttest && !attest) || rejectBatch.isPending} onClick={() => runBatch('approve')}>
              <Check className="h-3.5 w-3.5" /> Approve selected images{toApprove.length > 0 ? ` (${toApprove.length})` : ''}
            </Button>
            <Button type="button" size="sm" variant="outline" data-testid="gc-photos-reject" loading={rejectBatch.isPending} disabled={toReject.length === 0 || approveBatch.isPending} onClick={() => runBatch('reject')}>
              Reject selected{toReject.length > 0 ? ` (${toReject.length})` : ''}
            </Button>
            {waitingN > 0 && (
              <Button type="button" size="sm" variant="ghost" data-testid="gc-photos-select-all" disabled={batchBusy} onClick={() => setSel(new Set(items.filter(isWaiting).filter((i) => i.actions.includes('approve') || i.actions.includes('reject')).map((i) => i.id)))}>
                Select all waiting
              </Button>
            )}
            {selected.length > 0 && (
              <Button type="button" size="sm" variant="ghost" data-testid="gc-photos-select-none" disabled={batchBusy} onClick={() => setSel(new Set())}>
                Clear selection
              </Button>
            )}
          </div>
          {selected.length > 0 && toApprove.length < selected.filter((i) => i.status === 'candidate').length && (
            <p className="text-[11px] text-muted">Some selected pictures cannot be approved in a batch (their rights are blocked or their license needs a check). Their cards say why.</p>
          )}
        </>
      )}

      {error && <ErrorLine testId="gc-photos-error">{error}</ErrorLine>}

      {outcome && (
        <div data-testid="gc-photos-results" className="space-y-1.5 rounded-xl border border-cream-300/80 bg-cream-50 px-3 py-2.5 text-xs">
          <p className="flex items-center justify-between gap-2 font-medium text-ink">
            <span>
              {outcome.kind === 'approve' ? 'Approval' : 'Rejection'} result: {outcome.rows.filter((r) => r.result.ok).length} of {outcome.rows.length} done
            </span>
            <button type="button" onClick={() => setOutcome(null)} className="font-normal text-muted underline underline-offset-2 hover:text-ink">
              Dismiss
            </button>
          </p>
          <ul className="space-y-1">
            {outcome.rows.map(({ result, title }) => (
              <li key={result.id} data-testid={`gc-photos-result-${result.id}`} data-ok={result.ok ? 'yes' : 'no'} className="flex items-start gap-2">
                {result.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />}
                <span className="min-w-0">
                  <strong>{title}</strong>: {result.ok ? (outcome.kind === 'approve' ? 'approved' : 'rejected') : (result.message ?? 'It could not be done.')}
                  {!result.ok && result.code && <span className="ml-1 font-mono text-[10px] text-muted">({result.code})</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.length > 0 && (
        <details data-testid="gc-photos-rejected" className="rounded-xl border border-cream-300/80 bg-cream-50 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-muted hover:text-ink">Rejected pictures ({rejected.length}): restore one if you changed your mind</summary>
          <ul className="mt-2 space-y-1.5">
            {rejected.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={i.title}>
                  {i.title} <span className="text-muted">· {SOURCE_LABEL[i.source]}</span>
                </span>
                <Button type="button" size="sm" variant="outline" data-testid={`gc-photo-restore-${i.id}`} loading={restore.isPending && restore.variables === i.id} disabled={restore.isPending && restore.variables !== i.id} onClick={() => restore.mutate(i.id, { onError: fail })}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="gc-photos-upload" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
          <Upload className="h-3.5 w-3.5" /> Upload replacement pictures
        </Button>
        <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp" data-testid="gc-photos-upload-input" onChange={(e) => onFiles(e.target.files)} />
        <Button type="button" size="sm" variant="ghost" data-testid="gc-photos-skip" onClick={() => setCollapsed('skip')}>
          Skip images
        </Button>
        {approvedN === 0 && (
          <Button type="button" size="sm" variant="ghost" data-testid="gc-photos-none" onClick={() => setCollapsed('none')}>
            Continue without images
          </Button>
        )}
        <span className="text-[11px] text-muted">Pictures you upload are yours and are approved at once. Skipping only hides this list; nothing is approved or changed.</span>
      </div>
    </Block>
  );
}

// ---- BRAND COLORS -------------------------------------------------------------------------------------------------------------------------------

type PaletteChoice = { kind: 'used'; kept: PaletteRole[]; unchanged: boolean } | { kind: 'kept' } | null;

function PaletteBlock({ state, design, onUsePalette }: { state: GetContentState; design: CampaignDesignData | null; onUsePalette: GetContentProps['onUsePalette'] }) {
  const s = state.palette.suggestion;
  const [choice, setChoice] = React.useState<PaletteChoice>(null);
  React.useEffect(() => setChoice(null), [state.palette.analyzedAt]);

  if (!s) {
    return (
      <Block testId="gc-palette" title="Brand colors">
        <p data-testid="gc-palette-none" className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-4 text-center text-xs text-muted">
          No color suggestion was made, so your palette stays as it is. You can still change every color in the palette step below.
        </p>
      </Block>
    );
  }

  const kept = design?.overridden ?? [];
  const mismatch = !!design && !!state.palette.collectionId && state.palette.collectionId !== design.collectionId;
  const same = !!design && PALETTE_ROLES.every((r) => kept.includes(r) || design.palette[r].toLowerCase() === s.palette[r].toLowerCase());
  const analysed = state.palette.analyzedAt ? new Date(state.palette.analyzedAt).toLocaleString() : null;
  const reading = s.readings.map((r) => `${r.label}: ${r.status === 'ok' ? 'colors read' : (r.message ?? r.status)}`).join(' · ');

  function use() {
    if (!design) return;
    const keptRoles = onUsePalette(s!, state.palette.analyzedAt);
    setChoice({ kind: 'used', kept: keptRoles, unchanged: same });
  }

  return (
    <Block testId="gc-palette" title="Brand colors" hint="A recommended palette read from your logo, website, repository and files. It is only a suggestion: it changes nothing until you press “Use suggested palette”.">
      {analysed && <p className="text-[11px] text-muted">Analyzed {analysed}{reading ? `. ${reading}` : ''}</p>}
      <ul data-testid="gc-palette-swatches" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PALETTE_ROLES.map((role) => {
          const hex = s.palette[role];
          const ev = s.evidence[role];
          const now = design?.palette[role];
          return (
            <li key={role} data-testid={`gc-palette-swatch-${role}`} className="flex gap-3 rounded-xl bg-cream-100 p-2.5 text-xs">
              <span className="h-14 w-14 shrink-0 rounded-lg ring-1 ring-ink/10" style={isHex(hex) ? { backgroundColor: hex } : undefined} title={hex} aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <strong className="text-sm text-ink">{ROLE_LABELS[role]}</strong>
                  <span data-testid={`gc-palette-hex-${role}`} className="font-mono">
                    {hex}
                  </span>
                </p>
                {ev && (
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Badge data-testid={`gc-palette-source-${role}`} className="bg-white px-2 py-0.5 text-[10px] text-ink-600">
                      {SOURCE_LABELS[ev.source] ?? ev.source}
                    </Badge>
                    <Badge data-testid={`gc-palette-confidence-${role}`} className={cn('px-2 py-0.5 text-[10px]', CONF_STYLE[ev.confidence])}>
                      {ev.confidence === 'high' ? 'High' : ev.confidence === 'medium' ? 'Medium' : 'Low'} confidence
                    </Badge>
                  </p>
                )}
                {ev && <p className="text-muted">{ev.evidence}</p>}
                {kept.includes(role) ? (
                  <p className="text-amber-900">You edited this color yourself, so it is kept.</p>
                ) : (
                  design && now && now.toLowerCase() !== hex.toLowerCase() && <p className="text-muted">In your palette now: <span className="font-mono">{now}</span></p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {s.conflicts.length > 0 && (
        <div data-testid="gc-palette-conflicts" className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <p className="font-semibold">Your sources disagree</p>
          {s.conflicts.map((c) => (
            <p key={c.role}>{c.message}</p>
          ))}
        </div>
      )}
      {s.check.errors.map((e) => (
        <p key={e} role="alert" className="flex items-start gap-1.5 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {e}
        </p>
      ))}
      {[...s.check.warnings, ...s.notes].map((n) => (
        <p key={n} className="text-xs text-amber-900">
          {n}
        </p>
      ))}

      {mismatch && (
        <p data-testid="gc-palette-mismatch" className="text-xs text-amber-900">
          These colors were analyzed for the {pretty(state.palette.collectionId!)} collection, but your design uses {pretty(design!.collectionId)}. Press “Try again” above to analyze them for your current collection.
        </p>
      )}
      {!design && <p className="text-xs text-amber-900">Choose a template collection first: the palette belongs to the campaign design.</p>}
      {design && !mismatch && same && !choice && <p className="text-xs text-muted">Your palette already matches this suggestion.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" data-testid="gc-palette-use" disabled={!design || mismatch} onClick={use}>
          <Check className="h-3.5 w-3.5" /> Use suggested palette
        </Button>
        <Button type="button" size="sm" variant="outline" data-testid="gc-palette-keep" onClick={() => setChoice({ kind: 'kept' })}>
          Keep my palette
        </Button>
      </div>
      {choice && (
        <p role="status" data-testid="gc-palette-status" data-choice={choice.kind} className="text-xs text-ink-600">
          {choice.kind === 'kept'
            ? 'Your palette stays exactly as it is.'
            : choice.unchanged && choice.kept.length === 0
              ? 'Your palette already matched this suggestion, so nothing changed.'
              : `The suggested colors are now in your palette (see “Review the brand palette” below).${choice.kept.length ? ` Colors you edited yourself were kept: ${choice.kept.map((r) => ROLE_LABELS[r]).join(', ')}.` : ''} “Reset to detected colors” and “Restore collection defaults” in the palette editor bring the earlier colors back.`}
        </p>
      )}
    </Block>
  );
}

// ---- the whole panel ----------------------------------------------------------------------------------------------------------------------------

export interface GetContentProps {
  projectId: string;
  /** the campaign design being edited (null until a collection is chosen) */
  design: CampaignDesignData | null;
  /**
   * Applies a palette suggestion through the Campaign Design's own path (`applySuggestion`): the palette editor stays the only palette store and
   * colors the owner edited are never overwritten. Returns the roles that were kept because the owner edited them.
   */
  onUsePalette: (suggestion: PaletteSuggestion, analyzedAt: string | null) => PaletteRole[];
}

const FRAME = 'space-y-4 rounded-xl border border-cream-300/80 bg-cream-50/60 p-4';

export function GetContent({ projectId, design, onUsePalette }: GetContentProps) {
  const q = useGetContent(projectId);
  const start = useStartGetContent(projectId);
  const cancel = useCancelGetContent(projectId);
  const [hidden, setHidden] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // a new search starts the optional sections from scratch (the lists remount)
  const [round, setRound] = React.useState(0);

  const state = q.data;
  const run = state?.run ?? null;
  const running = run?.status === 'running';

  function begin(refresh: boolean) {
    setError(null);
    start.mutate(
      { ...(refresh ? { refresh: true } : {}), ...(design ? { collectionId: design.collectionId } : {}) },
      {
        onSuccess: () => {
          setHidden(false);
          setRound((n) => n + 1);
        },
        onError: (e) => setError(e.message),
      },
    );
  }

  // ---- never pressed: one card, one button, nothing else is requested -------------------------------------------------------------------------
  if (!run) {
    return (
      <section data-testid="get-content" data-state="idle" aria-label="Get Content" className={cn(FRAME, 'space-y-3')}>
        <header className="space-y-1">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">Get Content (optional)</h5>
          <p className="text-xs text-ink-600">Find your real logo, useful photographs and brand colors from your uploads, website and repository, then approve what you want to use. Free: no AI request, no campaign starts. You can skip this.</p>
        </header>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" data-testid="get-content-run" loading={start.isPending} onClick={() => begin(false)}>
            <Search className="h-3.5 w-3.5" /> Get Content
          </Button>
        </div>
        {error && <ErrorLine testId="get-content-error">{error}</ErrorLine>}
        {q.isError && !error && <p data-testid="get-content-load-error" className="text-[11px] text-muted">The saved Get Content results could not be read ({q.error.message}). You can still press Get Content or continue without it.</p>}
      </section>
    );
  }

  // ---- hidden by "Skip": nothing is stored, the results stay one click away -----------------------------------------------------------------------
  if (hidden) {
    return (
      <section data-testid="get-content" data-state="hidden" aria-label="Get Content" className={cn(FRAME, 'space-y-2')}>
        <div className="flex flex-wrap items-center gap-2">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">Get Content (optional)</h5>
          <p className="min-w-0 flex-1 text-xs text-muted">The results are hidden. Hiding them approved nothing and changed nothing.{running ? ' The search is still running.' : ''}</p>
          <Button type="button" size="sm" variant="outline" data-testid="get-content-show" onClick={() => setHidden(false)}>
            Show results
          </Button>
        </div>
      </section>
    );
  }

  const st = RUN_STATUS[run.status] ?? { text: run.status, cls: 'bg-cream-200 text-ink-600' };
  const photosOn = !running;
  const nothing = !running && !!state && state.logo.candidates.length === 0 && !state.logo.approved && run.summary.imagesFound === 0 && !state.palette.suggestion;

  return (
    <section data-testid="get-content" data-state="results" data-run-status={run.status} aria-label="Get Content" className={FRAME}>
      <header className="space-y-1">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">GET CONTENT RESULTS</h5>
        <p className="text-xs text-ink-600">Free: no AI request was made and no campaign was started. Nothing below is approved until you approve it.</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Badge role="status" data-testid="gc-run-status" data-status={run.status} className={cn('px-2.5 py-1 text-xs', st.cls)}>
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {st.text}
        </Badge>
        <span className="text-[11px] text-muted">
          {run.cached ? `Saved result from ${new Date(run.startedAt).toLocaleString()}: nothing was searched again.` : `Started ${new Date(run.startedAt).toLocaleString()}${run.finishedAt ? `, finished ${new Date(run.finishedAt).toLocaleTimeString()}` : ''}.`}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {running && (
            <Button type="button" size="sm" variant="outline" data-testid="get-content-cancel" loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onError: (e) => setError(e.message) })}>
              Cancel
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" data-testid="get-content-retry" loading={start.isPending} disabled={running} onClick={() => begin(true)}>
            Try again
          </Button>
          <Button type="button" size="sm" variant="ghost" data-testid="get-content-skip" onClick={() => setHidden(true)}>
            Skip
          </Button>
        </span>
      </div>

      {error && <ErrorLine testId="get-content-error">{error}</ErrorLine>}
      {(run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled') && (
        <p className="text-xs text-amber-900">{run.status === 'cancelled' ? 'The search was cancelled. What was found before is shown below.' : 'The search did not finish. What was found before is shown below; press “Try again” to search once more.'} You can also continue without it.</p>
      )}

      <SourcesList run={run} />
      <RunSummary run={run} />

      {running && <p className="text-xs text-muted">The results appear here when the search finishes. It reads only your own sources and costs nothing.</p>}

      {nothing && (
        <p data-testid="gc-nothing" className="rounded-xl border border-dashed border-cream-300 bg-white/60 px-4 py-4 text-sm text-ink-600">
          Nothing useful was found in the sources that could be read{run.summary.sourcesUnavailable.length ? ` (not available: ${run.summary.sourcesUnavailable.join(', ')})` : ''}. You can continue: choose your design, plan the campaign and start it exactly as before. To use your own logo or pictures, upload them below or add them to the project and press “Try again”.
        </p>
      )}

      {!running && state && (
        <>
          <LogoBlock key={`logo-${round}`} projectId={projectId} state={state} />
          <PhotosBlock key={`photos-${round}`} projectId={projectId} show={photosOn} />
          <PaletteBlock key={`palette-${round}`} state={state} design={design} onUsePalette={onUsePalette} />
        </>
      )}

      {!running && state && (state.approved.logo || state.approved.photos > 0) && (
        <div data-testid="gc-approved-summary" className="space-y-1 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs text-emerald-950">
          <p className="flex items-start gap-2 text-sm font-semibold">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /> Approved content is saved for this project and used by the agents when you start the campaign.
          </p>
          <p className="pl-6">
            {state.approved.logo ? 'Logo approved' : 'No logo approved'} · {state.approved.photos} approved photograph{state.approved.photos === 1 ? '' : 's'}
            {state.approved.approvedAt ? ` · last approval ${formatDate(state.approved.approvedAt)}` : ''}
          </p>
        </div>
      )}
    </section>
  );
}
