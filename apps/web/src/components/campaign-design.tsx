'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Search } from 'lucide-react';
import { AvailableImages } from '@/components/available-images';
import { CollectionCard } from '@/components/collection-card';
import { GetContent } from '@/components/get-content';
import { PaletteEditor } from '@/components/palette-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { CLASS_LABELS, type FormatClass } from '@/lib/hybrid';
import { post } from '@/lib/api';
import {
  FORMAT_OPTION_KEYS,
  PALETTE_ROLES,
  SOURCING_LABELS,
  contrastRatio,
  designPreviewUrl,
  useAddLicensedImage,
  useCollections,
  useDiscoverImages,
  useNewDesign,
  usePaletteSuggestion,
  useProjectDesign,
  useSaveDesign,
  type CampaignDesignData,
  type CollectionData,
  type CollectionId,
  type DesignEvaluation,
  type DesignPalette,
  type ImageSourcing,
  type PaletteRole,
  type PaletteSuggestionData,
} from '@/lib/visual';
import { cn } from '@/lib/utils';

/*
 * THE CAMPAIGN DESIGN: the one place where the look of a campaign is decided. Collection, palette, formats and picture sources live in ONE
 * object (`design`) that the campaign setup owns, saves as a draft per project (so a refresh keeps it) and sends with the start request.
 * Nothing in this file calls an API that spends money: previews are drawn by the server's renderer, discovery uses only free search providers.
 */

const DEFAULT_FORMATS = ['instagram_post', 'instagram_story', 'website_banner'] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Step({ id, letter, title, children, hint }: { id: string; letter: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section data-testid={`design-step-${id}`} className="space-y-2">
      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {letter} · {title}
      </h5>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {children}
    </section>
  );
}

/** Applies a palette suggestion to a design; colors the user edited are never overwritten (unless `all`). */
function applySuggestion(d: CampaignDesignData, s: PaletteSuggestionData['suggestion'], all = false): CampaignDesignData {
  const palette = { ...d.palette };
  const evidence = { ...d.paletteEvidence };
  const overridden = all ? [] : d.overridden;
  for (const r of PALETTE_ROLES) {
    if (overridden.includes(r)) continue;
    palette[r] = s.palette[r];
    evidence[r] = s.evidence[r];
  }
  return { ...d, palette, paletteEvidence: evidence, overridden, confirmed: false, confirmedAt: null };
}

export interface CampaignDesignProps {
  projectId: string;
  design: CampaignDesignData | null;
  onChange: (d: CampaignDesignData | null) => void;
  /** original AI images requested (the picture plan is judged against it) */
  originals: number;
  imageOn: boolean;
  /** the free plan's own words about where the pictures come from, once a plan review exists for exactly these settings */
  sourcePlan?: { summary: string; warnings: string[]; suggestions: { id: string; message: string; set: { originals: number }; fewerRequests: number; savesUsd: number | null }[] } | null;
  onApplyOriginals?: (n: number) => void;
  /** A collection the user came here to use (from the Templates page): applied once, after the saved draft was loaded. */
  initialCollection?: CollectionId | null;
  /** NO AI HYBRID: the picture step is the AVAILABLE IMAGES gallery (existing and licensed pictures) instead of the AI-versus-existing sourcing choice. */
  noAi?: boolean;
}

export function CampaignDesign({ projectId, design, onChange, originals, imageOn, sourcePlan, onApplyOriginals, initialCollection, noAi }: CampaignDesignProps) {
  const toast = useToast();
  const collections = useCollections();
  const projectDesign = useProjectDesign(projectId);
  const newDesign = useNewDesign(projectId);
  const save = useSaveDesign(projectId);
  const suggest = usePaletteSuggestion(projectId);
  const [suggestion, setSuggestion] = React.useState<PaletteSuggestionData | null>(null);
  const [evaluation, setEvaluation] = React.useState<DesignEvaluation | null>(null);
  const [notes, setNotes] = React.useState<string[]>([]);
  const [previewClass, setPreviewClass] = React.useState<FormatClass>('square');
  const loadedDraft = React.useRef(false);
  const lastSaved = React.useRef<string>('');

  const list = collections.data?.items ?? [];
  const current: CollectionData | undefined = design ? list.find((c) => c.id === design.collectionId) : undefined;

  // the saved draft of this project comes back after a refresh (once)
  React.useEffect(() => {
    if (loadedDraft.current || !projectDesign.data) return;
    loadedDraft.current = true;
    const d = projectDesign.data.draft;
    if (d && !design) {
      lastSaved.current = JSON.stringify(d);
      onChange(d);
    }
  }, [projectDesign.data, design, onChange]);

  // arriving from the Templates page with a collection: choose it once (the draft, if any, keeps its edited colors)
  const appliedInitial = React.useRef(false);
  React.useEffect(() => {
    if (appliedInitial.current || !initialCollection || !loadedDraft.current || !collections.data) return;
    const hasDraft = !!projectDesign.data?.draft;
    if (hasDraft && !design) return; // the draft is about to be set by the effect above
    appliedInitial.current = true;
    if (design?.collectionId !== initialCollection) void pick(initialCollection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCollection, collections.data, projectDesign.data, design]);

  // autosave of the draft: only what changed, shortly after the last edit; the server's verdict (readability, formats) comes back with it
  const debounced = useDebounced(design, 700);
  React.useEffect(() => {
    if (!debounced) return;
    const body = JSON.stringify(debounced);
    if (body === lastSaved.current) return;
    lastSaved.current = body;
    save.mutate(debounced, { onSuccess: (r) => setEvaluation({ check: r.check, paletteFit: r.paletteFit, formats: r.formats, canConfirm: r.canConfirm }), onError: () => (lastSaved.current = '') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const previewPalette = useDebounced(design?.palette ?? null, 250);

  async function runSuggestion(id: CollectionId, refresh = false, from: CampaignDesignData | null = design): Promise<PaletteSuggestionData | null> {
    try {
      // the colors the user edited by hand, as they are on the screen right now: they stay the user's
      const explicit = Object.fromEntries((from?.overridden ?? []).map((r) => [r, from!.palette[r]]));
      const s = await suggest.mutateAsync({ collectionId: id, refresh, explicit });
      setSuggestion(s);
      return s;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The brand colors could not be analyzed.');
      return null;
    }
  }

  async function pick(id: CollectionId) {
    if (design?.collectionId === id) return;
    try {
      if (!design) {
        const fresh = await newDesign.mutateAsync(id);
        let d = fresh.design;
        if (!d.formats.length) d = { ...d, formats: [...DEFAULT_FORMATS] };
        setEvaluation({ check: fresh.check, paletteFit: fresh.paletteFit, formats: fresh.formats, canConfirm: fresh.canConfirm });
        const s = await runSuggestion(id, false, null);
        onChange(s ? applySuggestion(d, s.suggestion) : d);
        setNotes([]);
        return;
      }
      const r = await post<{ design: CampaignDesignData; notes: string[] } & DesignEvaluation>(`/projects/${projectId}/design/switch`, { design, collectionId: id });
      setEvaluation({ check: r.check, paletteFit: r.paletteFit, formats: r.formats, canConfirm: r.canConfirm });
      setNotes(r.notes);
      onChange(r.design);
      void runSuggestion(id, false, r.design);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The collection could not be changed.');
    }
  }

  const patch = (p: Partial<CampaignDesignData>) => design && onChange({ ...design, ...p, confirmed: false, confirmedAt: null });
  const editColor = (role: PaletteRole, hex: string) => {
    if (!design) return;
    patch({ palette: { ...design.palette, [role]: hex.toLowerCase() }, paletteEvidence: { ...design.paletteEvidence, [role]: { source: 'user', confidence: 'high', evidence: 'Chosen by you' } }, overridden: [...new Set([...design.overridden, role])] });
  };
  const restoreDefaults = () => {
    if (!design || !current) return;
    patch({ palette: { ...current.defaultPalette }, paletteEvidence: Object.fromEntries(PALETTE_ROLES.map((r) => [r, { source: 'collection_default', confidence: 'low', evidence: `${current.name} default ${r} color` }])) as CampaignDesignData['paletteEvidence'], overridden: [] });
  };
  const resetDetected = () => {
    if (design && suggestion) onChange(applySuggestion(design, suggestion.suggestion, true));
  };
  const reanalyze = async () => {
    if (!design) return;
    const s = await runSuggestion(design.collectionId, true);
    if (s) onChange(applySuggestion(design, s.suggestion));
  };
  // GET CONTENT: the colors it suggests go through the same path as every other suggestion (the palette editor stays the only palette store;
  // colors the user edited are never overwritten). "Reset to detected colors" then returns to these colors.
  const applyContentPalette = (s: PaletteSuggestionData['suggestion'], analyzedAt: string | null): PaletteRole[] => {
    if (!design) return [];
    onChange(applySuggestion(design, s));
    setSuggestion({ suggestion: s, analyzedAt: analyzedAt ?? new Date().toISOString(), cached: true, sources: { website: null, repository: null } });
    return [...design.overridden];
  };
  const toggleFormat = (k: (typeof FORMAT_OPTION_KEYS)[number]) => design && patch({ formats: design.formats.includes(k) ? design.formats.filter((x) => x !== k) : [...design.formats, k] });

  const fit = evaluation?.formats;
  const check = evaluation?.check;
  const liveRatio = design ? contrastRatio(design.palette.text, design.palette.background) : 21;
  const min = current?.paletteRules.minTextContrast ?? 4.5;
  const errors = [...(check?.errors ?? [])];
  if (design && liveRatio < min && !errors.some((e) => /text color/.test(e))) errors.unshift(`The text color has a contrast of ${liveRatio.toFixed(1)}:1 against the background; at least ${min}:1 is needed to be readable.`);
  const paletteNotes = [...(check?.warnings ?? []), ...(evaluation?.paletteFit.notes.filter((n) => !errors.includes(n)) ?? []), ...notes];
  const canConfirm = !!design && errors.length === 0 && (fit ? fit.ok : true);
  const supports = (optKey: string) => {
    const opt = collections.data?.formatOptions.find((o) => o.key === optKey);
    return !current || !opt || opt.formatIds.some((id) => current.supportedFormats.some((f) => f.id === id));
  };
  const previewTemplates = current ? current.templates.filter((t) => t.classes.includes(previewClass) && t.requires.every((r) => r === 'image' || r === 'logo' || r === 'headline' || r === 'support' || r === 'cta' || r === 'eyebrow' || r === 'brand')).slice(0, 6) : [];

  return (
    <section data-testid="campaign-design" aria-label="Campaign design" className="space-y-5 rounded-xl border border-accent/40 bg-white/70 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Campaign design</p>
          <p className="mt-0.5 text-sm text-ink-600">One template collection and one palette for the whole campaign. Every agent and every creative follows this design; nothing here is chosen again anywhere else.</p>
        </div>
        {design && (
          <Badge data-testid="design-status" className={cn(design.confirmed ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900')}>
            {design.confirmed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />} {design.confirmed ? 'Design confirmed' : 'Not confirmed yet'}
          </Badge>
        )}
      </header>

      <Step id="collection" letter="A" title="Choose a template collection" hint={projectDesign.data?.defaults.suggestedCollection && !design ? `Suggested for your project: ${list.find((c) => c.id === projectDesign.data!.defaults.suggestedCollection!.id)?.name ?? ''} (${projectDesign.data.defaults.suggestedCollection.reasons.join('; ')}). It is only a suggestion.` : undefined}>
        {collections.isLoading ? (
          <div className="h-40 animate-pulse rounded-xl bg-cream-200" />
        ) : (
          <div data-testid="collection-grid" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => (
              <CollectionCard key={c.id} c={c} selected={design?.collectionId === c.id} onSelect={() => pick(c.id)} palette={design?.collectionId === c.id ? design.palette : undefined} />
            ))}
          </div>
        )}
        {collections.isError && <p className="text-xs text-red-700">The collections could not be loaded.</p>}
      </Step>

      {/* GET CONTENT (optional): finds the logo, photographs and brand colors in the sources the user supplied; free, starts no campaign and blocks nothing */}
      <GetContent projectId={projectId} design={design} onUsePalette={applyContentPalette} />

      {noAi && !design && (
        <section data-testid="design-step-pictures" className="space-y-2">
          <AvailableImages projectId={projectId} autoStock={false} onAutoStock={null} />
        </section>
      )}

      {design && current && (
        <>
          <Step id="palette" letter="B" title="Review the brand palette" hint="Suggested from your logo, website, repository and files. Change any color: the collection keeps its look and the previews update immediately.">
            {suggest.isPending && <p className="text-xs text-muted">Reading your brand sources…</p>}
            <PaletteEditor
              palette={design.palette}
              evidence={design.paletteEvidence}
              overridden={design.overridden}
              onChange={editColor}
              onResetDetected={suggestion ? resetDetected : undefined}
              onRestoreDefaults={restoreDefaults}
              onReanalyze={reanalyze}
              analyzing={suggest.isPending}
              analysisNote={suggestion ? `${suggestion.cached ? 'Saved analysis' : 'Fresh analysis'} from ${new Date(suggestion.analyzedAt).toLocaleString()}. ${suggestion.suggestion.readings.map((r) => `${r.label}: ${r.status === 'ok' ? 'colors read' : r.message ?? r.status}`).join(' · ')}` : null}
              conflicts={suggestion?.suggestion.conflicts}
              errors={errors}
              notes={paletteNotes}
              minTextContrast={min}
            />
          </Step>

          <Step id="formats" letter="C" title="Choose output formats" hint="The creatives are made in exactly these formats. A format the collection cannot draw is marked and blocks the start until you change it.">
            <div data-testid="format-options" className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
              {collections.data?.formatOptions.map((o) => {
                const on = design.formats.includes(o.key);
                const ok = supports(o.key);
                return (
                  <label key={o.key} data-testid={`format-${o.key}`} className={cn('flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-xs', on ? 'border-accent bg-accent-soft/40' : 'border-cream-300 bg-cream-50', !ok && 'border-amber-300')}>
                    <input type="checkbox" className="mt-0.5" checked={on} onChange={() => toggleFormat(o.key)} />
                    <span>
                      <strong className="text-ink">{o.label}</strong>
                      {!ok && <span className="block text-amber-900">Not supported by {current.name}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {design.formats.length === 0 && <p className="text-xs text-muted">No format chosen: the formats follow the channels of your strategy.</p>}
            {fit && fit.messages.length > 0 && (
              <div data-testid="format-fit" className={cn('space-y-1 rounded-xl border px-3 py-2 text-xs', fit.ok ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-red-300 bg-red-50 text-red-900')}>
                {fit.messages.map((m) => (
                  <p key={m}>{m}</p>
                ))}
                {!fit.ok && (
                  <>
                    <p className="font-medium">Your options (nothing is changed for you):</p>
                    <ul className="list-disc pl-5">
                      {fit.options.collections.length > 0 && <li>Choose a collection that supports every format: {fit.options.collections.map((c) => c.name).join(', ')}.</li>}
                      {fit.options.plan.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </Step>

          {noAi ? (
            <section data-testid="design-step-pictures" className="space-y-2">
              <AvailableImages projectId={projectId} letter="D" autoStock={design.autoStock === true} onAutoStock={(on) => patch({ autoStock: on })} />
            </section>
          ) : (
          <Step id="pictures" letter="D" title="Picture sources" hint="Where the pictures of the creatives come from. The number of original AI images stays exactly what you set above.">
            <div className="grid gap-2 md:grid-cols-3">
              {(Object.keys(SOURCING_LABELS) as ImageSourcing[]).map((m) => (
                <label key={m} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="radio" name="image-sourcing" data-testid={`sourcing-${m}`} className="mt-1" checked={design.imageSourcing === m} onChange={() => patch({ imageSourcing: m })} />
                  <span>
                    <strong>{SOURCING_LABELS[m].title}</strong>
                    <span className="block text-xs text-muted">{SOURCING_LABELS[m].text}</span>
                  </span>
                </label>
              ))}
            </div>
            <p data-testid="source-plan" className="text-xs text-ink-600">
              {sourcePlan ? `Plan: ${sourcePlan.summary}.` : `${imageOn ? originals : 0} paid image request${(imageOn ? originals : 0) === 1 ? '' : 's'} for original AI images (review the plan for the full picture-source plan).`}
            </p>
            {sourcePlan?.warnings.map((w) => (
              <p key={w} className="text-xs text-amber-900">
                {w}
              </p>
            ))}
            {sourcePlan?.suggestions.map((s) => (
              <div key={s.id} data-testid="source-suggestion" className="flex flex-wrap items-center gap-2 rounded-xl bg-cream-100 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1">{s.message}{s.savesUsd !== null ? ` It would save about $${s.savesUsd.toFixed(2)}.` : ''}</span>
                {onApplyOriginals && (
                  <Button type="button" size="sm" variant="outline" onClick={() => onApplyOriginals(s.set.originals)}>
                    Use {s.set.originals} AI image{s.set.originals === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
            ))}
            <DiscoveryPanel projectId={projectId} />
          </Step>
          )}

          <Step id="preview" letter="E" title="Free preview" hint={noAi ? 'Drawn right now by LaunchPilot\'s own renderer with your palette and logo (or brand name). The text and the picture are illustrative samples; nothing is generated and nothing is sent to OpenAI.' : 'Drawn right now by LaunchPilot\'s own renderer with your palette and logo (or brand name). The text and the picture are illustrative samples; nothing is sent to OpenAI.'}>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Preview format">
              {current.supportedClasses.map((cls) => (
                <button key={cls} type="button" role="tab" aria-selected={previewClass === cls} data-testid={`preview-class-${cls}`} onClick={() => setPreviewClass(cls)} className={cn('rounded-full border px-3 py-1 text-xs', previewClass === cls ? 'border-accent bg-accent-soft/50 font-medium text-ink' : 'border-cream-300 bg-cream-50 text-muted hover:text-ink')}>
                  {CLASS_LABELS[cls]}
                </button>
              ))}
            </div>
            <div data-testid="design-previews" className="flex items-end gap-3 overflow-x-auto rounded-xl bg-cream-200/70 p-3">
              {!previewTemplates.length && <p className="text-xs text-muted">No template of {current.name} is designed for this format.</p>}
              {previewTemplates.map((t) => (
                <figure key={t.id} className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img data-testid={`design-preview-${t.id}`} src={designPreviewUrl(projectId, current.id, { template: t.id, class: previewClass, palette: previewPalette ?? design.palette })} alt={`${current.name}: ${t.name} (${CLASS_LABELS[previewClass]})`} className="h-48 w-auto rounded-md bg-white object-contain shadow" />
                  <figcaption className="mt-1 max-w-[14rem] truncate text-[11px] text-muted" title={t.name}>
                    {t.name}
                  </figcaption>
                </figure>
              ))}
            </div>
          </Step>

          <div className="flex flex-wrap items-center gap-3 border-t border-cream-300 pt-3">
            <Button type="button" data-testid="confirm-design" variant={design.confirmed ? 'outline' : 'primary'} disabled={!canConfirm || design.confirmed} onClick={() => onChange({ ...design, confirmed: true, confirmedAt: new Date().toISOString() })}>
              <CheckCircle2 className="h-4 w-4" /> {design.confirmed ? 'Design confirmed' : 'Use this design for the campaign'}
            </Button>
            <span className="text-xs text-muted">
              {design.confirmed ? `${current.name}, your palette and ${design.formats.length || 'the strategy'} format${design.formats.length === 1 ? '' : 's'} are locked in for the next review. Any change asks you to confirm again.` : canConfirm ? 'Confirm to continue to the plan and the budget.' : 'Fix the problems above to confirm.'}
            </span>
          </div>
        </>
      )}
      {!design && !collections.isLoading && <p className="text-xs text-muted">Choose a collection to see its palette, formats and previews.</p>}
    </section>
  );
}

// ---- web visual discovery (free providers only) ----------------------------------------------------------------------------------------------------

function DiscoveryPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const discover = useDiscoverImages(projectId);
  const add = useAddLicensedImage(projectId);
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const data = discover.data;
  const key = (c: { provider: string; id: string }) => `${c.provider}:${c.id}`;
  return (
    <details data-testid="discovery" className="rounded-xl border border-cream-300/80 bg-cream-50 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-muted hover:text-ink">
        <Search className="h-3.5 w-3.5" /> Find licensed pictures on the web (optional, free)
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="text-muted">
          <strong className="text-ink">Only pictures whose license allows advertising use can be added to the project.</strong> Results from search engines and Pinterest are shown for inspiration only: they are never downloaded, never used in a creative and never sent to AI. Nothing is added unless you choose it.
        </p>
        <Button type="button" size="sm" variant="outline" data-testid="discover-run" loading={discover.isPending} onClick={() => discover.mutate({}, { onError: (e) => toast.error(e.message) })}>
          <Search className="h-3.5 w-3.5" /> Search for my business
        </Button>
        {data && (
          <div className="space-y-3" data-testid="discovery-results">
            <ul className="space-y-0.5">
              {data.providers.map((p) => (
                <li key={p.id} data-testid={`provider-${p.id}`}>
                  <strong>{p.label}</strong>: {p.status === 'ok' ? `${p.count} result${p.count === 1 ? '' : 's'}` : p.status === 'not_configured' ? `not configured. ${p.message ?? ''}` : (p.message ?? p.status)}
                </li>
              ))}
            </ul>
            {data.intents.length > 0 && <p className="text-muted">Searched for: {data.intents.map((i) => `“${i.query}”`).join(', ')}</p>}
            {data.notes.map((n) => (
              <p key={n} className="text-amber-900">
                {n}
              </p>
            ))}
            {data.licensed.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-ink">Licensed pictures</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {data.licensed.map((c) => (
                    <li key={key(c)} data-testid="licensed-candidate" className="flex gap-2 rounded-xl bg-cream-100 p-2">
                      {c.thumbnailUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.thumbnailUrl} alt={c.title} referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-md object-cover" />
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="truncate font-medium text-ink" title={c.title}>
                          {c.title}
                        </p>
                        <p className="text-muted">
                          {c.license.license} · {c.provider}
                          {c.creator ? ` · ${c.creator}` : ''}
                        </p>
                        <Badge className={cn('px-2 py-0.5 text-[10px]', c.license.status === 'cleared' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900')}>{c.license.status === 'cleared' ? 'License allows advertising use' : 'Check the license at the source'}</Badge>
                        <a href={c.pageUrl} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-0.5 text-accent underline">
                          source <ExternalLink className="h-3 w-3" />
                        </a>
                        {c.license.status === 'needs_review' && (
                          <label className="flex items-start gap-1.5 text-[11px]">
                            <input type="checkbox" checked={!!checked[key(c)]} onChange={(e) => setChecked((x) => ({ ...x, [key(c)]: e.target.checked }))} /> I checked the license on the source page.
                          </label>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={c.license.status === 'needs_review' && !checked[key(c)]}
                          loading={add.isPending && add.variables?.id === c.id}
                          onClick={() => add.mutate({ provider: c.provider, id: c.id, reviewConfirmed: c.license.status === 'needs_review' }, { onSuccess: () => toast.success('Picture added to the project with its credit.'), onError: (e) => toast.error(e.message) })}
                        >
                          Add to project
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.references.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-ink">Reference only (inspiration)</p>
                <ul className="space-y-1">
                  {data.references.map((c) => (
                    <li key={key(c) + c.pageUrl} data-testid="reference-candidate" className="flex flex-wrap items-center gap-2 rounded-lg bg-cream-100 px-2 py-1.5">
                      <Badge className="bg-cream-200 px-2 py-0.5 text-[10px] text-ink-600">Reference only</Badge>
                      <span className="min-w-0 flex-1 truncate" title={c.title}>
                        {c.title} {c.platform ? `· ${c.platform}` : ''}
                      </span>
                      <a href={c.pageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-accent underline">
                        open <ExternalLink className="h-3 w-3" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

export type { DesignPalette };
