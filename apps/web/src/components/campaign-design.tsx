'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
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
  PALETTE_ROLES,
  contrastRatio,
  designPreviewUrl,
  useCollections,
  useNewDesign,
  usePaletteSuggestion,
  useProjectDesign,
  useSaveDesign,
  type CampaignDesignData,
  type CollectionData,
  type CollectionId,
  type DesignEvaluation,
  type DesignPalette,
  type PaletteRole,
  type PaletteSuggestionData,
  type PaletteVariantData,
  type PaletteVariantId,
} from '@/lib/visual';
import { cn } from '@/lib/utils';

/*
 * THE CAMPAIGN DESIGN: the one place where the look of a campaign is decided. Collection, palette, formats and picture sources live in ONE
 * object (`design`) that the campaign setup owns, saves as a draft per project (so a refresh keeps it) and sends with the start request.
 * Nothing in this file calls an API that spends money: previews are drawn by the server's renderer, discovery uses only free search providers.
 */

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
/** The palette option to use: the one asked for, else the one the design already uses, else the recommended one (null: an older server sent none). */
function variantOf(s: PaletteSuggestionData['suggestion'], id?: PaletteVariantId | null): PaletteVariantData | null {
  const list = s.variants ?? [];
  return list.find((v) => v.id === id) ?? list.find((v) => v.id === s.recommendedVariant) ?? list.find((v) => v.recommended) ?? null;
}

/**
 * Applies the analysis to the design. The colors come from a PALETTE OPTION (the recommended one unless the user chose another): roles the user
 * edited by hand are kept (unless `all`), and a role an option adjusted says so in its evidence.
 */
function applySuggestion(d: CampaignDesignData, s: PaletteSuggestionData['suggestion'], all = false, variantId?: PaletteVariantId | null): CampaignDesignData {
  const v = variantOf(s, variantId ?? d.paletteVariant);
  const src = v?.palette ?? s.palette;
  const palette = { ...d.palette };
  const evidence = { ...d.paletteEvidence };
  const overridden = all ? [] : d.overridden;
  for (const r of PALETTE_ROLES) {
    if (overridden.includes(r)) continue;
    palette[r] = src[r];
    evidence[r] = v && src[r] !== s.palette[r] ? { ...s.evidence[r], evidence: `${s.evidence[r].evidence} · adjusted in "${v.label}"`.slice(0, 240) } : s.evidence[r];
  }
  return { ...d, palette, paletteVariant: v ? v.id : null, paletteEvidence: evidence, overridden, confirmed: false, confirmedAt: null };
}

const ROLE_SHORT: Record<PaletteRole, string> = { background: 'Background', primary: 'Primary', secondary: 'Secondary', accent: 'Accent', text: 'Text' };

/** The three close palette options of the analysis: name, swatches with their roles, a small preview, the recommended one marked. */
function PaletteOptions({ projectId, collectionId, previewTemplate, variants, selected, onPick }: { projectId: string; collectionId: string; previewTemplate: string | null; variants: PaletteVariantData[]; selected: PaletteVariantId | null | undefined; onPick: (id: PaletteVariantId) => void }) {
  return (
    <div data-testid="palette-options" className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Palette options">
      {variants.map((v) => {
        const on = selected === v.id;
        return (
          <button key={v.id} type="button" role="radio" aria-checked={on} data-testid={`palette-option-${v.id}`} onClick={() => onPick(v.id)} className={cn('flex flex-col gap-2 rounded-xl border bg-white p-3 text-left transition', on ? 'border-accent ring-2 ring-accent/40' : 'border-cream-300 hover:border-accent/60')}>
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink">{v.label}</span>
              {v.recommended && <Badge className="bg-emerald-100 text-emerald-800">Recommended</Badge>}
            </span>
            <span className="flex gap-1.5">
              {(['background', 'primary', 'secondary', 'accent', 'text'] as PaletteRole[]).map((r) => (
                <span key={r} className="flex flex-col items-center gap-0.5">
                  <span className="h-7 w-7 rounded-md border border-cream-300" style={{ background: v.palette[r] }} title={`${ROLE_SHORT[r]} ${v.palette[r]}`} />
                  <span className="text-[10px] text-muted">{ROLE_SHORT[r]}</span>
                </span>
              ))}
            </span>
            {previewTemplate && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={designPreviewUrl(projectId, collectionId, { template: previewTemplate, class: 'story', palette: v.palette })} alt={`Preview with ${v.label}`} className="h-32 w-auto self-center rounded-md bg-cream-100 object-contain shadow" />
            )}
            <span className="text-xs text-muted">{v.description}</span>
            {!v.check.ok && <span className="text-xs text-red-700">{v.check.errors[0]}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface CampaignDesignProps {
  projectId: string;
  design: CampaignDesignData | null;
  onChange: (d: CampaignDesignData | null) => void;
  /** A collection the user came here to use (from the Templates page): applied once, after the saved draft was loaded. */
  initialCollection?: CollectionId | null;
}

export function CampaignDesign({ projectId, design, onChange, initialCollection }: CampaignDesignProps) {
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
        // V4: no formats are chosen here; the deliverables plan produces every format the collection can draw
        const d = { ...fresh.design, formats: [] };
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
    patch({ palette: { ...design.palette, [role]: hex.toLowerCase() }, paletteVariant: null, paletteEvidence: { ...design.paletteEvidence, [role]: { source: 'user', confidence: 'high', evidence: 'Chosen by you' } }, overridden: [...new Set([...design.overridden, role])] });
  };
  const restoreDefaults = () => {
    if (!design || !current) return;
    patch({ palette: { ...current.defaultPalette }, paletteEvidence: Object.fromEntries(PALETTE_ROLES.map((r) => [r, { source: 'collection_default', confidence: 'low', evidence: `${current.name} default ${r} color` }])) as CampaignDesignData['paletteEvidence'], overridden: [] });
  };
  const resetDetected = () => {
    if (design && suggestion) onChange(applySuggestion(design, suggestion.suggestion, true));
  };
  // the user picks one of the three palette options: it replaces the palette (colors edited by hand included) and is stored with the design
  const pickVariant = (id: PaletteVariantId) => {
    if (design && suggestion) onChange(applySuggestion(design, suggestion.suggestion, true, id));
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

  const check = evaluation?.check;
  const liveRatio = design ? contrastRatio(design.palette.text, design.palette.background) : 21;
  const min = current?.paletteRules.minTextContrast ?? 4.5;
  const errors = [...(check?.errors ?? [])];
  if (design && liveRatio < min && !errors.some((e) => /text color/.test(e))) errors.unshift(`The text color has a contrast of ${liveRatio.toFixed(1)}:1 against the background; at least ${min}:1 is needed to be readable.`);
  const paletteNotes = [...(check?.warnings ?? []), ...(evaluation?.paletteFit.notes.filter((n) => !errors.includes(n)) ?? []), ...notes];
  const canConfirm = !!design && errors.length === 0;
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

      {!design && (
        <section data-testid="design-step-pictures" className="space-y-2">
          <AvailableImages projectId={projectId} autoStock={false} onAutoStock={null} />
        </section>
      )}

      {design && current && (
        <>
          <Step id="palette" letter="B" title="Review the brand palette" hint="Suggested from your logo, website, repository and files. Change any color: the collection keeps its look and the previews update immediately.">
            {suggest.isPending && <p className="text-xs text-muted">Reading your brand sources…</p>}
            {suggestion?.suggestion.variants?.length ? (
              <div className="space-y-2">
                <p className="text-xs text-ink-600">Three close options of your brand colors. The recommended one is used unless you pick another; you can still fine-tune any color below.</p>
                <PaletteOptions projectId={projectId} collectionId={current.id} previewTemplate={current.templates.find((t) => t.classes.includes('story') && !t.requires.includes('image'))?.id ?? current.templates.find((t) => t.classes.includes('story'))?.id ?? null} variants={suggestion.suggestion.variants} selected={design.paletteVariant} onPick={pickVariant} />
              </div>
            ) : null}
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

          <section data-testid="design-step-pictures" className="space-y-2">
            <AvailableImages projectId={projectId} letter="C" autoStock={design.autoStock === true} onAutoStock={(on) => patch({ autoStock: on })} />
          </section>

          <Step id="preview" letter="D" title="Free preview" hint="Drawn right now by LaunchPilot's own renderer with your palette and logo (or brand name). The text and the picture are illustrative samples; nothing is generated and nothing is sent to any AI provider.">
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
              {design.confirmed ? `${current.name} and your palette are locked in for the next review. Any change asks you to confirm again.` : canConfirm ? 'Confirm to continue to the plan and the budget.' : 'Fix the problems above to confirm.'}
            </span>
          </div>
        </>
      )}
      {!design && !collections.isLoading && <p className="text-xs text-muted">Choose a collection to see its palette, formats and previews.</p>}
    </section>
  );
}

export type { DesignPalette };
