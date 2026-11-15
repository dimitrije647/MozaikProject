'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, RotateCcw, Save, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { ApiError, get, post, put } from '@/lib/api';
import { keys } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/*
 * THE CREATIVE EDITOR (MVP): the text of ONE creative, changed by its owner. Every preview is the REAL image rendered by the server's template
 * renderer from the creative's stored design (no AI call, no HTML text drawn over the old image); Save stores exactly that image, and the ZIP
 * exports it. Nothing is saved without Save; closing with unsaved changes asks first.
 */

interface Field {
  id: string;
  label: string;
  value: string;
  original: string;
  multiline: boolean;
  maxLength: number;
  required: boolean;
}
interface Check {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}
export interface EditorState {
  campaignId: string;
  slotId: string;
  label: string;
  format: string;
  width: number;
  height: number;
  assetId: string;
  imageUrl: string;
  version: number;
  design: 'passed' | 'warnings' | 'unresolved' | null;
  quality: string | null;
  publishReady: boolean | null;
  blockers: string[];
  warnings: Check[];
  edit: { revision: number; state: 'original' | 'edited'; originalAssetId: string; editedAt: string | null } | null;
  editable: boolean;
  reason: string | null;
  fields: Field[];
}
interface PreviewMeta {
  sha256: string;
  width: number;
  height: number;
  status: 'passed' | 'warnings' | 'unresolved';
  fitting: 'unchanged_layout' | 'repaired' | 'variant';
  notes: string[];
  warnings: Check[];
}
type FieldErrors = Record<string, string>;

const DEBOUNCE_MS = 650;
const STATUS: Record<string, { label: string; tone: string }> = {
  passed: { label: 'Design checks passed', tone: 'bg-emerald-100 text-emerald-800' },
  warnings: { label: 'Passed with warnings', tone: 'bg-amber-100 text-amber-900' },
  unresolved: { label: 'Needs correction (not publish-ready)', tone: 'bg-red-100 text-red-800' },
};
const FITTING: Record<PreviewMeta['fitting'], string> = {
  unchanged_layout: 'The design is unchanged: the new text fits it.',
  repaired: 'The spacing or details of the design were adjusted for the new text.',
  variant: 'The layout of this design was adapted so the new text fits.',
};

const path = (campaignId: string, slotId: string) => `/campaigns/${campaignId}/creatives/${encodeURIComponent(slotId)}`;
const valuesOf = (fields: Field[]) => Object.fromEntries(fields.map((f) => [f.id, f.value]));
const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).every((k) => (a[k] ?? '') === (b[k] ?? ''));

/** API error bodies: { message, code, errors: [{ field, message }] } */
async function errorOf(res: Response): Promise<{ message: string; code?: string; errors: { field: string; message: string }[] }> {
  try {
    const b = await res.json();
    return { message: Array.isArray(b.message) ? b.message.join(', ') : (b.message ?? res.statusText), code: b.code, errors: Array.isArray(b.errors) ? b.errors : [] };
  } catch {
    return { message: res.statusText || 'Request failed', errors: [] };
  }
}

export function CreativeEditorDialog({ campaignId, slotId, onClose }: { campaignId: string; slotId: string | null; onClose: () => void }) {
  const open = !!slotId;
  const [dirty, setDirty] = React.useState(false);
  const close = React.useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes to this creative. Close without saving?')) return;
    setDirty(false);
    onClose();
  }, [dirty, onClose]);
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : undefined)}>
      {slotId && (
        <DialogContent title="Edit creative" description="Change the text on this visual. The preview is the real image that is saved and exported." className="max-h-[94vh] max-w-6xl overflow-y-auto p-5 sm:p-7" data-testid="creative-editor">
          <EditorBody key={slotId} campaignId={campaignId} slotId={slotId} onDirty={setDirty} onDone={() => (setDirty(false), onClose())} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function EditorBody({ campaignId, slotId, onDirty, onDone }: { campaignId: string; slotId: string; onDirty: (d: boolean) => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['creative-editor', campaignId, slotId], queryFn: () => get<EditorState>(`${path(campaignId, slotId)}/editor`), staleTime: 0 });
  const s = q.data;
  const saved = React.useMemo(() => (s ? valuesOf(s.fields) : {}), [s]);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ url: string; meta: PreviewMeta; forKey: string } | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const seq = React.useRef(0);
  const abort = React.useRef<AbortController | null>(null);

  // the draft starts from the saved text (and again after a save or a restore)
  React.useEffect(() => {
    if (s) {
      setDraft(valuesOf(s.fields));
      setErrors({});
      setFormError(null);
    }
  }, [s]);
  const dirty = !!s && !same(draft, saved);
  React.useEffect(() => onDirty(dirty), [dirty, onDirty]);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // an older preview image is released when a newer one replaces it; a pending request is aborted when the editor closes
  React.useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);
  React.useEffect(() => () => abort.current?.abort(), []);

  // local validation (the server validates again)
  const localErrors = React.useMemo(() => {
    const out: FieldErrors = {};
    for (const f of s?.fields ?? []) {
      const v = (draft[f.id] ?? '').trim();
      if (!v && f.required) out[f.id] = `${f.label} cannot be empty.`;
      else if (v.length > f.maxLength) out[f.id] = `${f.label} is longer than ${f.maxLength} characters.`;
    }
    return out;
  }, [draft, s]);
  const draftKey = JSON.stringify(draft);

  // DEBOUNCED PREVIEW: the newest text wins; an older answer is ignored, a pending request is aborted
  React.useEffect(() => {
    if (!s?.editable || !dirty || Object.keys(localErrors).length) {
      abort.current?.abort();
      setRendering(false);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setRendering(true);
      try {
        const res = await fetch(`/api${path(campaignId, slotId)}/preview`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: draft, baseAssetId: s.assetId }), signal: ctrl.signal });
        if (mine !== seq.current) return;
        if (!res.ok) {
          const e = await errorOf(res);
          if (e.code === 'superseded') return;
          setErrors(Object.fromEntries(e.errors.filter((x) => x.field !== '*').map((x) => [x.field, x.message])));
          setFormError(e.errors.some((x) => x.field !== '*') ? null : e.message);
          return;
        }
        const raw = atob((res.headers.get('X-Creative-Preview') ?? '').replace(/-/g, '+').replace(/_/g, '/'));
        const meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)))) as PreviewMeta;
        const blob = await res.blob();
        if (mine !== seq.current) return;
        setErrors({});
        setFormError(null);
        setPreview({ url: URL.createObjectURL(blob), meta, forKey: draftKey });
      } catch (e) {
        if ((e as Error).name !== 'AbortError' && mine === seq.current) setFormError('The preview could not be rendered. Try again.');
      } finally {
        if (mine === seq.current) setRendering(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, s?.assetId, s?.editable, dirty, localErrors]);

  if (q.isLoading) return <div className="h-96 animate-pulse rounded-2xl bg-cream-200" />;
  if (!s) return <p className="text-sm text-red-700">{q.error instanceof ApiError ? q.error.message : 'This creative could not be loaded.'}</p>;

  const allErrors = { ...errors, ...localErrors };
  const current = dirty && preview && preview.forKey === draftKey ? preview : null;
  const shownUrl = dirty && preview ? preview.url : `/api${s.imageUrl}`;
  const status = current ? current.meta.status : s.design;
  const checks = current ? current.meta.warnings : s.warnings;
  const stalePreview = dirty && (!preview || preview.forKey !== draftKey);
  const originals = Object.fromEntries(s.fields.map((f) => [f.id, f.original]));
  const canSave = s.editable && dirty && !saving && !rendering && !Object.keys(allErrors).length && !!current;

  const refresh = async (next: EditorState) => {
    qc.setQueryData(['creative-editor', campaignId, slotId], next);
    await qc.invalidateQueries({ queryKey: keys.campaign(campaignId) });
    setPreview(null);
  };
  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const next = await put<EditorState>(path(campaignId, slotId), { fields: draft, baseAssetId: s.assetId });
      await refresh(next);
      toast.success('Saved. The campaign and its ZIP now use the edited creative.');
      onDirty(false);
    } catch (e) {
      const msg = e instanceof ApiError ? (e.status === 409 ? 'This creative was changed elsewhere. Close and open it again to edit the latest version.' : e.message) : 'The changes could not be saved. Nothing was changed.';
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };
  const restore = async () => {
    if (!window.confirm('Restore the original generated version of this creative? Your edited text is replaced by the original.')) return;
    setSaving(true);
    try {
      const next = await post<EditorState>(`${path(campaignId, slotId)}/restore`, { baseAssetId: s.assetId });
      await refresh(next);
      toast.success('The original version is restored.');
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'The original could not be restored.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="relative mx-auto w-full overflow-hidden rounded-xl border border-cream-300 bg-cream-100" style={{ aspectRatio: `${s.width} / ${s.height}`, maxHeight: '70vh', maxWidth: `calc(70vh * ${s.width / s.height})` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="creative-editor-preview" src={shownUrl} alt={`${s.label} (${s.width} x ${s.height})`} className={cn('h-full w-full object-contain transition-opacity', (rendering || stalePreview) && 'opacity-60')} />
          {rendering && (
            <div className="absolute inset-0 flex items-center justify-center" aria-live="polite">
              <span className="flex items-center gap-2 rounded-full bg-ink/80 px-3 py-1.5 text-xs text-cream-100">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering preview…
              </span>
            </div>
          )}
        </div>
        <p className="text-center text-xs text-muted">
          {s.label} · {s.format} · {s.width} x {s.height} px{s.edit?.state === 'edited' ? ` · edited (revision ${s.edit.revision})` : ''}
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {status && <Badge className={STATUS[status]?.tone}>{STATUS[status]?.label ?? status}</Badge>}
          {dirty && <Badge className="bg-cream-200 text-ink-600">Unsaved changes</Badge>}
        </div>
        {!s.editable ? (
          <div data-testid="creative-editor-locked" className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {s.reason}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) void save();
            }}
          >
            {s.fields.map((f) => {
              const err = allErrors[f.id];
              const common = {
                id: `field-${f.id}`,
                name: f.id,
                value: draft[f.id] ?? '',
                maxLength: f.maxLength,
                'aria-invalid': !!err,
                'aria-describedby': err ? `err-${f.id}` : undefined,
                onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [f.id]: e.target.value })),
                className: cn('w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/40', err ? 'border-red-400' : 'border-cream-300'),
              };
              return (
                <div key={f.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={`field-${f.id}`} className="text-sm font-medium">
                      {f.label}
                      {!f.required && <span className="ml-1 text-xs font-normal text-muted">(optional)</span>}
                    </label>
                    <span className="text-[11px] text-muted">
                      {(draft[f.id] ?? '').length}/{f.maxLength}
                    </span>
                  </div>
                  {f.multiline ? <textarea rows={f.id === 'headline' ? 2 : 3} {...common} /> : <input type="text" {...common} />}
                  {err && (
                    <p id={`err-${f.id}`} role="alert" className="text-xs text-red-700">
                      {err}
                    </p>
                  )}
                  {(draft[f.id] ?? '') !== f.original && <p className="text-[11px] text-muted">Original: {f.original}</p>}
                </div>
              );
            })}
            {current && <p className="text-xs text-muted">{FITTING[current.meta.fitting]}</p>}
            {formError && (
              <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {formError}
              </p>
            )}
            {checks.length > 0 && (
              <details className="rounded-lg bg-white/70 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">Design checks to look at ({checks.length})</summary>
                <ul className="mt-1 space-y-1">
                  {checks.map((c) => (
                    <li key={c.id} className={c.status === 'fail' ? 'text-red-800' : 'text-amber-900'}>
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" disabled={!canSave} loading={saving} data-testid="creative-editor-save">
                <Save className="h-4 w-4" /> Save changes
              </Button>
              <Button type="button" variant="outline" disabled={saving || same(draft, originals)} onClick={() => setDraft(originals)}>
                <Undo2 className="h-4 w-4" /> Reset to original text
              </Button>
              {s.edit?.state === 'edited' && (
                <Button type="button" variant="ghost" disabled={saving} onClick={() => void restore()} data-testid="creative-editor-restore">
                  <RotateCcw className="h-4 w-4" /> Restore original version
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={() => (dirty && !window.confirm('Discard your unsaved changes?') ? undefined : onDone())}>
                Cancel
              </Button>
            </div>
            {dirty && stalePreview && !rendering && !Object.keys(allErrors).length && <p className="text-[11px] text-muted">The preview updates when you pause typing.</p>}
          </form>
        )}
      </div>
    </div>
  );
}
