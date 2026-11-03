'use client';

import * as React from 'react';
import { AlertCircle, Info, Link2, Plus, Trash2 } from 'lucide-react';
import { CampaignDesign, type CampaignDesignProps } from '@/components/campaign-design';
import { NoAiStatement } from '@/components/no-ai';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import type { HybridFactsInput, HybridReferenceInput, HybridSettingsData, HybridSettingsInput } from '@/lib/hybrid';
import { normalizePinterestPinUrl } from '@/lib/pinterest-api';
import type { Asset } from '@/lib/types';
import { cn } from '@/lib/utils';
import { fmtUsd } from '@/components/cost-ui';

/*
 * The Hybrid Production settings. Everything here only EDITS the request that the free plan review, the free preview and (after the
 * user approves a spending limit) the start send; nothing in this file calls an API that spends money. References are LINKS or the
 * user's own uploaded images: Pinterest content is browsed for inspiration only and is never copied into these settings.
 */

/** The settings as the form works with them: the preset defaults with the user's changes on top; references are the INPUT shape (id, kind, label, url). */
export type HybridView = Omit<HybridSettingsData, 'references'> & { references: HybridReferenceInput[] };

export const HYBRID_RANGE = { originals: { min: 0, max: 40 }, templateCreatives: { min: 0, max: 60 }, concepts: { min: 1, max: 5 } } as const;
const MAX_REFERENCES = 12;
const MAX_UPLOADED_REFERENCES = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 original AI images (paid) + 15 template creatives (free, rendered locally) = 20 finished creatives". */
export function hybridSummaryText(originals: number, templates: number): string {
  return `${plural(originals, 'original AI image')} (paid) + ${plural(templates, 'template creative')} (free, rendered locally) = ${plural(originals + templates, 'finished creative')}`;
}

/** NO AI HYBRID: "0 AI-generated images + 20 template creatives = 20 finished creatives". */
export function noAiSummaryText(templates: number): string {
  return `0 AI-generated images + ${plural(templates, 'template creative')} = ${plural(templates, 'finished creative')}`;
}

// ---- small controls ------------------------------------------------------------------------------------------------------------------------

/** A whole-number field that keeps what the user types, shows the allowed range and only commits a valid value. */
function IntField({ label, value, min, max, onChange, hint, testId }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; hint?: string; testId?: string }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? String(value);
  const t = shown.trim();
  const bad = !/^\d+$/.test(t) || Number(t) < min || Number(t) > max;
  return (
    <label className="space-y-1 text-xs text-muted">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        data-testid={testId}
        aria-invalid={bad}
        className={cn(bad && 'border-red-400 focus:border-red-500')}
        value={shown}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const m = v.trim();
          if (/^\d+$/.test(m) && Number(m) >= min && Number(m) <= max) onChange(Number(m));
        }}
        onBlur={() => setDraft(null)}
      />
      {bad ? (
        <span role="alert" className="block text-[11px] text-red-700">
          Enter a whole number from {min} to {max}.
        </span>
      ) : hint ? (
        <span className="block text-[11px]">{hint}</span>
      ) : null}
    </label>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{children}</h5>;
}

function Radio({ name, checked, onChange, title, text, testId }: { name: string; checked: boolean; onChange: () => void; title: string; text: string; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="radio" name={name} data-testid={testId} className="mt-1" checked={checked} onChange={onChange} />
      <span>
        <strong>{title}</strong>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </label>
  );
}

function Check({ checked, onChange, title, text, testId, disabled }: { checked: boolean; onChange: (on: boolean) => void; title: string; text: React.ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" data-testid={testId} className="mt-1" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{title}</strong>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </label>
  );
}

// ---- facts only the user can supply ----------------------------------------------------------------------------------------------------------

const FACT_FIELDS: { key: keyof HybridFactsInput; label: string; max: number; placeholder: string }[] = [
  { key: 'offer', label: 'Offer', max: 20, placeholder: 'e.g. 20% off' },
  { key: 'offerDetail', label: 'Offer detail', max: 60, placeholder: 'e.g. on your first order' },
  { key: 'date', label: 'Date', max: 30, placeholder: 'e.g. 14 March' },
  { key: 'location', label: 'Location', max: 40, placeholder: 'e.g. your city or venue' },
  { key: 'quote', label: 'Quote', max: 160, placeholder: 'A real quote you may use' },
  { key: 'attribution', label: 'Quote attribution', max: 60, placeholder: 'Who said it' },
  { key: 'stat', label: 'Statistic', max: 12, placeholder: 'e.g. 4.8' },
  { key: 'statLabel', label: 'Statistic label', max: 50, placeholder: 'What the number measures' },
  { key: 'tag', label: 'Tag', max: 30, placeholder: 'e.g. New' },
];

function FactsEditor({ facts, onChange }: { facts: HybridFactsInput; onChange: (f: HybridFactsInput) => void }) {
  const set = (key: keyof HybridFactsInput, v: string) => {
    const next: HybridFactsInput = { ...facts, [key]: v };
    if (!v.trim()) delete next[key];
    onChange(next);
  };
  return (
    <div data-testid="hybrid-facts" className="space-y-2">
      <p className="text-xs text-muted">
        <strong className="text-ink">Some templates need details only you can provide. Nothing is invented: without them those templates are simply not used.</strong> Fill in only what is true for your campaign; leave the rest empty.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {FACT_FIELDS.map((f) => (
          <label key={f.key} className="space-y-1 text-xs text-muted">
            {f.label}
            <Input data-testid={`fact-${f.key}`} maxLength={f.max} placeholder={f.placeholder} className="h-10" value={facts[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

// ---- references: uploaded images and pasted links (never Pinterest content) ----------------------------------------------------------------

const RASTER = /^image\/(png|jpe?g|webp)$/i;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A pasted Pinterest Pin link becomes a 'pinterest_board' reference with the pasted url; any other http(s) link becomes 'user_link'. null + reason = not accepted. */
export function referenceFromLink(raw: string): { ref: HybridReferenceInput } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Paste a link first.' };
  const pin = normalizePinterestPinUrl(text);
  if (pin.ok) return { ref: { id: newId('pin'), kind: 'pinterest_board', label: 'Pinterest Pin (link only)', url: pin.url } };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: 'That does not look like a web address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http(s) links are accepted.' };
  if (u.username || u.password) return { error: 'A link with a user name or password is not accepted.' };
  const href = u.toString();
  if (href.length > 300) return { error: 'The link is longer than 300 characters.' };
  return { ref: { id: newId('link'), kind: 'user_link', label: `Link: ${u.hostname.replace(/^www\./, '')}`.slice(0, 120), url: href } };
}

function ReferencesEditor({ refs, onChange, assets }: { refs: HybridReferenceInput[]; onChange: (r: HybridReferenceInput[]) => void; assets: Asset[] | undefined }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const uploads = (assets ?? []).filter((a) => a.type === 'reference' && RASTER.test(a.mimeType));
  const picked = new Set(refs.filter((r) => r.kind === 'user_upload').map((r) => r.id));
  const links = refs.filter((r) => r.kind !== 'user_upload');
  const full = refs.length >= MAX_REFERENCES;

  function toggleUpload(a: Asset, on: boolean) {
    if (on) {
      if (full || picked.size >= MAX_UPLOADED_REFERENCES) return setError(`At most ${MAX_UPLOADED_REFERENCES} reference images (and ${MAX_REFERENCES} references in total) can be attached.`);
      setError(null);
      onChange([...refs, { id: a.id, kind: 'user_upload', label: a.originalName.slice(0, 120) }]);
    } else onChange(refs.filter((r) => !(r.kind === 'user_upload' && r.id === a.id)));
  }
  function addLink() {
    if (full) return setError(`At most ${MAX_REFERENCES} references can be attached.`);
    const r = referenceFromLink(text);
    if ('error' in r) return setError(r.error);
    if (links.some((l) => l.url === r.ref.url)) return setError('That link is already in the list.');
    setError(null);
    setText('');
    onChange([...refs, r.ref]);
  }

  return (
    <div data-testid="hybrid-references" className="space-y-3 rounded-xl border border-cream-300/80 bg-cream-50 p-3 text-xs">
      <p className="flex items-start gap-2 text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong className="text-ink">Links and Pinterest Pins are LINK-ONLY.</strong> They are recorded so you can find them again, and they are never fetched, never opened, never analyzed and never sent to AI. Images you uploaded to this project are yours: their colors are read locally to guide the direction.
        </span>
      </p>

      <div>
        <p className="mb-1 font-medium text-ink">Your uploaded reference images</p>
        {uploads.length === 0 ? (
          <p className="text-muted">No reference image (PNG, JPEG or WebP) is uploaded to this project. Upload images as “Brand references” in the project files to attach them here.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {uploads.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={picked.has(a.id)} onChange={(e) => toggleUpload(a, e.target.checked)} />
                  <span className="min-w-0 truncate" title={a.originalName}>
                    {a.originalName}
                  </span>
                  <Badge className="bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800">Yours</Badge>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 font-medium text-ink">Paste a link</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input data-testid="reference-link" aria-label="Reference link" placeholder="https://… (a Pinterest Pin link is kept as a Pinterest reference)" className="h-10 min-w-[16rem] flex-1" value={text} onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }} />
          <Button type="button" size="sm" variant="outline" data-testid="reference-add" onClick={addLink} disabled={!text.trim() || full}>
            <Plus className="h-3.5 w-3.5" /> Add link
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-1 flex items-start gap-1.5 text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        {links.length > 0 && (
          <ul className="mt-2 space-y-1">
            {links.map((r) => (
              <li key={r.id} data-kind={r.kind} className="flex flex-wrap items-center gap-2 rounded-lg bg-cream-100 px-2 py-1.5">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={r.url}>
                  {r.url}
                </span>
                <Badge className="bg-cream-200 px-2 py-0.5 text-[10px] text-ink-600">{r.kind === 'pinterest_board' ? 'Pinterest Pin: link only' : 'Link only: not opened or analyzed'}</Badge>
                <button type="button" aria-label={`Remove ${r.url}`} className="text-muted hover:text-red-700" onClick={() => onChange(refs.filter((x) => x.id !== r.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- the panel -----------------------------------------------------------------------------------------------------------------------------

export interface HybridSettingsPanelProps {
  projectId: string;
  value: HybridView;
  onChange: (patch: HybridSettingsInput) => void;
  /** Creative concepts (an F4 setting). */
  concepts: number;
  onConcepts: (n: number) => void;
  /** false = no image model is selected, so no original AI image is requested. */
  imageOn: boolean;
  /** The existing image model, strategy and quality controls (with their hints and warnings). */
  imageFields: React.ReactNode;
  /** The existing channel control. */
  channelPicker: React.ReactNode;
  /** The project's files (reference images can be attached from them). */
  assets: Asset[] | undefined;
  /** The campaign design (the one visual choice), its change handler and the picture-source plan of the plan review. */
  design: CampaignDesignProps['design'];
  onDesign: CampaignDesignProps['onChange'];
  sourcePlan?: CampaignDesignProps['sourcePlan'];
  onApplyOriginals?: (n: number) => void;
  initialCollection?: CampaignDesignProps['initialCollection'];
  /** The estimate of the plan review or the free preview for exactly these settings; null until one exists. */
  estimate: { typicalUsd: number | null; maxUsd: number | null; from: 'plan review' | 'preview' } | null;
  /** The plan's own headline, once the plan was reviewed for exactly these settings. */
  plannedHeadline: string | null;
  /** NO AI HYBRID: no image model, no originals, no regeneration; the pictures come from the AVAILABLE IMAGES gallery of the campaign design. */
  noAi?: boolean;
}

export function HybridSettingsPanel({ projectId, value: v, onChange, concepts, onConcepts, imageOn, imageFields, channelPicker, assets, estimate, plannedHeadline, design, onDesign, sourcePlan, onApplyOriginals, initialCollection, noAi }: HybridSettingsPanelProps) {
  const overrideCount = Object.keys(v.overrides).length;
  const originals = imageOn ? v.originals : 0;
  return (
    <section data-testid={noAi ? 'no-ai-settings' : 'hybrid-settings'} aria-label={noAi ? 'NO AI HYBRID settings' : 'Hybrid Production settings'} className="mt-5 space-y-5 rounded-xl border border-accent/40 bg-white/60 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">{noAi ? 'NO AI HYBRID settings' : 'Hybrid Production settings'}</p>
        <p data-testid="hybrid-summary" className="mt-1 text-base font-semibold">
          {noAi ? noAiSummaryText(v.templateCreatives) : hybridSummaryText(originals, v.templateCreatives)}
        </p>
        {noAi && <NoAiStatement className="mt-2" />}
        <p className="mt-1 text-xs text-muted">
          {noAi
            ? 'The Mozaik agents plan, write, design and review the campaign with the text model; no image is ever generated. Every creative is rendered locally from a library template, your brand colors and logo and an existing or licensed picture (your uploads, approved website and GitHub pictures, licensed stock) or from typography when none fits. The only paid requests are text-model calls.'
            : 'Only the original AI images (and the text calls) are paid OpenAI requests. The template creatives are drawn locally from the originals, your brand colors and logo and a library of templates: no image request is made for them.'}
          {!noAi && !imageOn && v.originals > 0 ? ' No image model is selected, so no original AI image will be requested.' : ''}
        </p>
        <p className="mt-1 text-xs text-muted" data-testid="hybrid-estimate-line">
          {estimate ? (
            <>
              Estimated spending ({estimate.from}): typical <strong className="text-ink">{fmtUsd(estimate.typicalUsd)}</strong>, worst case <strong className="text-ink">{fmtUsd(estimate.maxUsd)}</strong> (an estimate, not a bill).{plannedHeadline ? ` Plan: ${plannedHeadline}.` : ''}
            </>
          ) : (
            'Press “Review plan (free)” or “Preview the plan (free)” to see the estimated spending for these settings.'
          )}
        </p>
      </div>

      <CampaignDesign projectId={projectId} design={design} onChange={onDesign} originals={v.originals} imageOn={imageOn} sourcePlan={sourcePlan} onApplyOriginals={onApplyOriginals} initialCollection={initialCollection} noAi={noAi} />

      <div>
        <Heading>How many creatives</Heading>
        <div className={cn('grid gap-3', noAi ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
          {!noAi && <IntField testId="hybrid-originals" label="Original AI images (paid)" min={HYBRID_RANGE.originals.min} max={HYBRID_RANGE.originals.max} value={v.originals} onChange={(n) => onChange({ originals: n })} hint="0-40. Each is one image request." />}
          <IntField testId="hybrid-templates" label="Template creatives (free)" min={HYBRID_RANGE.templateCreatives.min} max={HYBRID_RANGE.templateCreatives.max} value={v.templateCreatives} onChange={(n) => onChange({ templateCreatives: n })} hint="0-60. Rendered locally, no request." />
          <IntField testId="hybrid-concepts" label="Creative concepts" min={HYBRID_RANGE.concepts.min} max={HYBRID_RANGE.concepts.max} value={concepts} onChange={onConcepts} hint={noAi ? '1-5. The template creatives are shared out over them (5 concepts x 4 = 20).' : '1-5. The originals and templates are shared out over them.'} />
        </div>
      </div>

      {noAi ? (
        <p data-testid="no-ai-no-images" className="rounded-xl bg-cream-100 px-4 py-2.5 text-xs text-ink-600">
          <strong>No image model, image quality, number of AI images or regeneration.</strong> NO AI HYBRID never generates an image, so these settings do not exist for it. The text model is the one saved in Settings.
        </p>
      ) : (
        <div>
          <Heading>Image model and quality (original AI images)</Heading>
          <div className="grid gap-3 sm:grid-cols-3">{imageFields}</div>
          <p className="mt-2 text-[11px] text-muted">Hybrid Production starts with the Quality First strategy and medium quality; high is selectable and costs more per original. The text model is the one saved in Settings.</p>
        </div>
      )}

      <div>
        <Heading>Target channels</Heading>
        {channelPicker}
      </div>

      <div>
        <Heading>Template selection</Heading>
        <div className="grid gap-3 md:grid-cols-3">
          <Radio testId="selection-automatic" name="hybrid-selection" checked={v.selection === 'automatic'} onChange={() => onChange({ selection: 'automatic' })} title="Automatic" text="LaunchPilot scores the templates locally against the direction, channel and format. No model call." />
          <Radio testId="selection-assisted" name="hybrid-selection" checked={v.selection === 'assisted'} onChange={() => onChange({ selection: 'assisted' })} title="Assisted" text="The same scoring, then one extra text-model call may re-rank a validated shortlist." />
          <Radio testId="selection-manual" name="hybrid-selection" checked={v.selection === 'manual'} onChange={() => onChange({ selection: 'manual' })} title="Manual" text="Your own choices per creative (set in the preview); the rest stays automatic." />
        </div>
        {overrideCount > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            {plural(overrideCount, 'manual template choice')} saved in these settings.
            <Button type="button" size="sm" variant="outline" onClick={() => onChange({ overrides: {} })}>
              Clear all manual choices
            </Button>
          </p>
        )}
      </div>

      <div>
        <Heading>My references (optional)</Heading>
        <p className="mb-2 text-xs text-muted">Pictures and links you want the direction to take into account. They are references only: nothing you attach here is copied into a creative. The look of the campaign is decided in the campaign design above.</p>
        <ReferencesEditor refs={v.references} onChange={(references) => onChange({ references, inspiration: references.length ? 'references' : 'style_library' })} assets={assets} />
      </div>

      <div>
        <Heading>Direction and fallback</Heading>
        <div className="grid gap-3 md:grid-cols-3">
          <Check testId="direction-refine" checked={v.directionRefine} onChange={(on) => onChange({ directionRefine: on })} title="Refine the visual direction with the text model" text="One text-model call may sharpen the direction. If it fails or is invalid, the local brief is used instead. On by default." />
          <Check testId="direction-review" checked={v.reviewDirection} onChange={(on) => onChange({ reviewDirection: on })} title="Review the visual direction before starting" text="Start stays disabled until you confirm the direction card in the preview with a checkbox." />
          {!noAi && <Check testId="template-fallback" checked={v.allowTemplateFallback} onChange={(on) => onChange({ allowTemplateFallback: on })} title="If an original image fails: render picture-free template versions (labelled FALLBACK)" text="Off: the creatives of that image are left out and reported. Nothing is replaced silently." />}
        </div>
      </div>

      <div>
        <Heading>Details only you can provide (optional)</Heading>
        <FactsEditor facts={v.facts} onChange={(facts) => onChange({ facts })} />
      </div>

      <p className="rounded-xl bg-cream-100 px-4 py-2.5 text-xs text-ink-600">
        <strong>Campaign budget:</strong> {noAi ? 'NO AI HYBRID needs ONE approved total budget and your confirmation for the text model. Review the plan, then enter the total under the cost estimate: it is shared by the text agents and the reviews (image generation costs $0), and nothing is split for you.' : 'like Full Production, Hybrid Production needs ONE approved total budget and your confirmation. Review the plan, then enter the total under the cost estimate: it is shared by the text agents, the images and the reviews, and nothing is split for you.'} Nothing starts until you press Start.
      </p>
    </section>
  );
}
