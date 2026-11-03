'use client';

import Link from 'next/link';
import * as React from 'react';
import { AlertCircle, Check, CircleDashed, ClipboardCheck, Download, Loader2, MinusCircle, OctagonX, Play, Recycle, Settings2, Square, UserPlus, XCircle } from 'lucide-react';
import { CostEstimateCard, SpendingConsent, fmtUsd, suggestedLimit, useSpendingConsent } from '@/components/cost-ui';
import { HybridPlanBlock, HybridPreviewSection } from '@/components/hybrid-preview';
import type { HybridPreviewState } from '@/components/hybrid-preview';
import { HybridSettingsPanel } from '@/components/hybrid-settings';
import type { HybridView } from '@/components/hybrid-settings';
import { Badge } from '@/components/ui/badge';
import { InputReadinessCard } from '@/components/input-readiness';
import { StartChecklist, type ChecklistItem } from '@/components/start-checklist';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useCancelFactory, useFactoryEvents, useFactoryPresets, useFactoryPreflight, useOpenAiModels, useOpenAiStatus, useProject, useStartFactory } from '@/lib/hooks';
import { useHybridPreview } from '@/lib/hybrid';
import type { HybridSettingsInput, StyleId } from '@/lib/hybrid';
import type { CollectionId } from '@/lib/visual';
import type { BudgetOptionData, ChannelId, FactoryActivityItem, FactoryFailureData, FactoryOutcome, FactoryPhaseData, FactoryPhaseStatus, FactoryPlan, FactoryPlanPhase, FactoryPresetId, FactoryRunData, FactorySettingsData, FactoryUsage, ImageAllocationData, ImageModelChoiceData, ImageModelStrategy, ImageQuality, OpenAiModelOption, StartFactoryInput } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * The full campaign: configuration and plan (free), the live run and the finished result. Everything shown is read from the
 * persisted FactoryRun, its child runs and their recorded Mozaik events. Nothing is simulated and nothing starts by itself.
 */

const ALL_CHANNELS: { id: ChannelId; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'google_search', label: 'Google Search' },
  { id: 'email', label: 'Email' },
  { id: 'organic_content', label: 'Organic content' },
  { id: 'community', label: 'Community' },
];

export const isActive = (s: string | undefined) => s === 'queued' || s === 'running';

const PHASE_STATUS: Record<FactoryPhaseStatus, { label: string; badge: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending', badge: 'bg-cream-200 text-ink-600', icon: <CircleDashed className="h-3 w-3" /> },
  reused: { label: 'Reused saved result', badge: 'bg-sky-100 text-sky-800', icon: <Recycle className="h-3 w-3" /> },
  running: { label: 'Running', badge: 'bg-accent-soft text-accent-hover', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  completed: { label: 'Completed', badge: 'bg-emerald-100 text-emerald-800', icon: <Check className="h-3 w-3" /> },
  failed: { label: 'Failed', badge: 'bg-red-100 text-red-700', icon: <XCircle className="h-3 w-3" /> },
  cancelled: { label: 'Cancelled', badge: 'bg-cream-300 text-ink-600', icon: <MinusCircle className="h-3 w-3" /> },
  skipped: { label: 'Not run', badge: 'bg-cream-200 text-muted', icon: <MinusCircle className="h-3 w-3" /> },
};

const BANNER: Record<FactoryOutcome, { tone: string; title: string; text: string }> = {
  in_progress: { tone: 'border-accent/40 bg-accent-soft/50 text-ink', title: 'Campaign running', text: 'The phases run one after another. Each result is saved before the next phase starts.' },
  approved: { tone: 'border-emerald-300 bg-emerald-50 text-emerald-900', title: 'Completed and approved', text: 'The campaign package is saved and no blocker, major or minor review issue remains.' },
  approved_with_notes: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Completed with notes', text: 'The campaign package is saved. Minor issues or limitations remain; read the review before using it.' },
  unresolved: { tone: 'border-red-300 bg-red-50 text-red-800', title: 'Completed with unresolved review issues', text: 'The campaign package is saved, but blocker or major issues could not be repaired. It is NOT ready to publish.' },
  partial: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Partial campaign', text: 'The campaign package is saved, but at least one creative step failed or timed out. See the phase details and the review.' },
  failed: { tone: 'border-red-300 bg-red-50 text-red-800', title: 'Campaign failed', text: 'A required phase failed, so the run stopped. Earlier saved results are untouched and nothing was retried automatically.' },
  cancelled: { tone: 'border-cream-300 bg-cream-100 text-ink', title: 'Campaign cancelled', text: 'The active phase was stopped and the remaining phases were not started. Results saved earlier are untouched.' },
  interrupted: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Campaign interrupted', text: 'The server stopped while this run was in progress. Nothing was resumed or repeated, so no further paid request was made.' },
};

function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

// ---- configuration and the free plan ------------------------------------------------------------------------------------------------------

function Num({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <label className="space-y-1 text-xs text-muted">
      {label}
      <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(Math.max(Math.round(Number(e.target.value)) || min, min), max))} />
      {hint && <span className="block text-[10px]">{hint}</span>}
    </label>
  );
}

const PRESET_INFO: Record<FactoryPresetId, { title: string; text: string }> = {
  first_test: { title: 'First test (lowest cost)', text: '1 concept, Instagram only, 1 low-quality image, landing page, regeneration and vision review off, F3 up to 14 calls / 3 scouts.' },
  demo: { title: 'Demo quality', text: '3 concepts, strategy-recommended channels, medium-quality images, 2 vision reviews. Costlier; never preselected.' },
  full_production: { title: 'Full Production — 20 AI Images', text: '5 concepts, 20 original AI images (several per concept) at high quality with the most capable image model your key lists (Quality First), strategy-recommended channels, richer research and copy, Depth on (extra cross-checks and a concept critique before the images), up to 3 repair rounds and 4 vision reviews. ONE campaign budget is shared by the text agents, the images and the reviews; the estimate is shown before anything runs and you approve that one total to start. Never preselected.' },
  hybrid_production: { title: 'Hybrid Production — 5 AI images + 15 template creatives', text: '5 original AI images + 15 template creatives = 20 finished creatives. Only the 5 originals are image requests; the 15 template creatives are rendered locally from the originals, your brand colors and logo and a library of templates, so they need no image request. 5 concepts, the most capable image model your key lists (Quality First) at medium quality (high is selectable), a visual direction and a template for every creative that you can preview for free and change by hand. ONE campaign budget is shared by the text agents, the images and the reviews; the estimate is shown before anything runs and you approve that one total to start. Never preselected.' },
  no_ai_hybrid: {
    title: 'NO AI HYBRID — 0 AI images + 20 template creatives',
    text: 'The Mozaik AI agents plan, write, design and review the campaign with the text model, but NO AI image is ever generated: 0 AI-generated images + 20 template creatives = 20 finished creatives (5 concepts x 4). The pictures come from your uploads, the website and GitHub pictures you approve and licensed stock images with their credit; a creative with no fitting picture is drawn with typography only. There is no image model, no image quality, no number of AI images and no regeneration. ONE campaign budget covers the text model; the estimate is shown before anything runs and you approve that one total to start. Never preselected.',
  },
};
const PRESET_ORDER: FactoryPresetId[] = ['first_test', 'demo', 'full_production', 'hybrid_production', 'no_ai_hybrid'];

/** What NO AI HYBRID never sends: the server refuses (422) an image model, a picture count, originals or regeneration instead of ignoring them. */
const IMAGE_F4_KEYS = ['imageModel', 'imageQuality', 'imageModelStrategy', 'maxImages', 'maxRegenerations', 'variations', 'imageConcurrency', 'layoutsPerOriginal'];
const withoutImageKeys = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([k]) => !IMAGE_F4_KEYS.includes(k))) as T;
/** NO AI HYBRID's Hybrid settings as the request carries them: no originals and no fallback for originals, and the design says "existing pictures" (the draft itself is left as the user made it). */
const noAiHybridInput = (h: HybridSettingsInput): HybridSettingsInput => ({
  ...(Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'originals' && k !== 'allowTemplateFallback')) as HybridSettingsInput),
  ...(h.design ? { design: { ...h.design, imageSourcing: 'prefer_existing' as const } } : {}),
});

/** The settings the Hybrid form sends: the user's changes on top of the preset defaults (the API merges and validates them). */
function viewOf(base: HybridView, ov: HybridSettingsInput): HybridView {
  const v: HybridView = { ...base, ...(Object.fromEntries(Object.entries(ov).filter(([, x]) => x !== undefined)) as Partial<HybridView>) };
  return v;
}

/** The image model, strategy and quality controls (shared by the advanced settings and the Hybrid panel). */
function ImageModelFields({ f4, imageModels, imageOptions, patch }: { f4: FactorySettingsData['f4']; imageModels: OpenAiModelOption[]; imageOptions: string[]; patch: (v: NonNullable<StartFactoryInput['f4']>) => void }) {
  return (
    <>
      <label className="space-y-1 text-xs text-muted">
        Image model
        <select aria-label="Image model" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={f4.imageModel ?? ''} onChange={(e) => patch({ imageModel: e.target.value || null })}>
          <option value="auto">Automatic: a current model your key lists</option>
          <option value="">None (brand-colored backgrounds)</option>
          {f4.imageModel && f4.imageModel !== 'auto' && !imageOptions.includes(f4.imageModel) && <option value={f4.imageModel}>{f4.imageModel} (not listed for your key)</option>}
          {imageModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.retired ? ` — shut down by OpenAI on ${m.retired.on} (will be refused)` : ''}
            </option>
          ))}
        </select>
        <span className="block text-[11px]">A model that is merely listed may still be refused. “Automatic” never picks a shut-down model.</span>
      </label>
      <label className="space-y-1 text-xs text-muted">
        Image model strategy
        <select aria-label="Image model strategy" data-testid="image-model-strategy" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={f4.imageModelStrategy} disabled={f4.imageModel !== 'auto'} onChange={(e) => patch({ imageModelStrategy: e.target.value as ImageModelStrategy })}>
          {(Object.keys(STRATEGY_INFO) as ImageModelStrategy[]).map((s) => (
            <option key={s} value={s}>
              {STRATEGY_INFO[s].label}
            </option>
          ))}
        </select>
        <span className="block text-[11px]">{f4.imageModel === 'auto' ? `${STRATEGY_INFO[f4.imageModelStrategy].label}: ${STRATEGY_INFO[f4.imageModelStrategy].text} This is a documented preference, not a measured quality result.` : 'Used only when the image model is “Automatic”. A model you choose yourself is used as it is.'}</span>
      </label>
      <label className="space-y-1 text-xs text-muted">
        Image quality
        <select aria-label="Image quality" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={f4.imageQuality} disabled={!f4.imageModel} onChange={(e) => patch({ imageQuality: e.target.value as ImageQuality })}>
          <option value="low">low (cheapest)</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh (GPT Image 2.5 only)</option>
          <option value="max">max (GPT Image 2.5 only)</option>
          <option value="auto">auto</option>
        </select>
        <span className="block text-[11px]">If the chosen model does not support a quality, the review says so and nothing starts; the value is never changed for you.</span>
      </label>
    </>
  );
}

/** The channel checkboxes (null = the strategy's recommended channels). */
function ChannelPicker({ channels, onToggle }: { channels: ChannelId[] | null; onToggle: (id: ChannelId) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
      <span>Channels {channels ? '' : '(the strategy’s recommended ones, up to 4)'}:</span>
      {ALL_CHANNELS.map((c) => (
        <label key={c.id} className="flex items-center gap-1">
          <input type="checkbox" checked={!!channels?.includes(c.id)} onChange={() => onToggle(c.id)} /> {c.label}
        </label>
      ))}
    </div>
  );
}

const STRATEGY_INFO: Record<ImageModelStrategy, { label: string; text: string }> = {
  economy: { label: 'Economy', text: 'The cheapest current image model your key lists.' },
  balanced: { label: 'Balanced', text: 'A current, fully priced mid-tier model first.' },
  quality: { label: 'Quality First', text: 'The most capable current image model of your key, ahead of price. It can cost much more than the others.' },
};

export function CampaignSetup({ projectId, onStarted, initialPreset, initialCollection, initialRerunCreative }: { projectId: string; onStarted: (run: FactoryRunData) => void; initialPreset?: FactoryPresetId; initialCollection?: CollectionId | null; /** open with "Produce a new creative round" ticked (NO AI HYBRID: continue with new images) */ initialRerunCreative?: boolean }) {
  const toast = useToast();
  const presets = useFactoryPresets();
  const openai = useOpenAiStatus();
  const models = useOpenAiModels();
  const preflight = useFactoryPreflight(projectId);
  const start = useStartFactory(projectId);
  const project = useProject(projectId);
  const hybridPreview = useHybridPreview(projectId);

  const [preset, setPreset] = React.useState<FactoryPresetId>(initialPreset ?? 'first_test');
  // Hybrid Production: the user's changes on top of the preset defaults, the free preview and the confirmation of its visual direction
  const [hybridOv, setHybridOv] = React.useState<HybridSettingsInput>({});
  const [pv, setPv] = React.useState<HybridPreviewState | null>(null);
  const [pvError, setPvError] = React.useState<string | null>(null);
  const pvSeq = React.useRef(0);
  const [dirAck, setDirAck] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'continue' | 'fresh'>('continue');
  const [rerunCreative, setRerunCreative] = React.useState(initialRerunCreative ?? false);
  const [reusePartial, setReusePartial] = React.useState(true);
  const [ov, setOv] = React.useState<Required<Pick<StartFactoryInput, 'f1' | 'f2' | 'f3' | 'f4'>>>({ f1: {}, f2: {}, f3: {}, f4: {} });
  // Depth is a plan setting (it changes the calls), so it is part of the review key; null = the preset's own value
  const [depthOv, setDepthOv] = React.useState<boolean | null>(null);
  const [plan, setPlan] = React.useState<{ key: string; data: FactoryPlan; rev: number } | null>(null);
  const reviews = React.useRef(0);
  const [applied, setApplied] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (openai.data?.configured && models.data === undefined && !models.isFetching) void models.refetch();
  }, [openai.data?.configured, models]);

  const base = presets.data?.presets[preset];
  const eff = base && { f1: { ...base.f1, ...ov.f1 }, f2: { ...base.f2, ...ov.f2 }, f3: { ...base.f3, ...ov.f3 }, f4: { ...base.f4, ...ov.f4 }, depth: depthOv ?? base.depth };
  const imageModels = (models.data?.models ?? []).filter((m) => m.imageSupported);
  const imageOptions = imageModels.map((m) => m.id);
  const patch = <K extends 'f1' | 'f2' | 'f3' | 'f4'>(k: K, v: NonNullable<StartFactoryInput[K]>) => setOv((o) => ({ ...o, [k]: { ...o[k], ...v } }));

  const isHybrid = preset === 'hybrid_production';
  // NO AI HYBRID shares the Hybrid settings (design, templates, facts) but never has an image model, originals, a picture count or regeneration
  const isNoAi = preset === 'no_ai_hybrid';
  const usesHybrid = isHybrid || isNoAi;
  const baseHybrid = base?.hybrid ?? null;
  const hv: HybridView | null = baseHybrid ? viewOf({ ...baseHybrid, references: baseHybrid.references.map((r) => ({ id: r.id, kind: r.kind as 'user_upload' | 'user_link' | 'pinterest_board', label: r.label, ...(r.url ? { url: r.url } : {}) })) }, hybridOv) : null;
  const patchHybrid = (p: HybridSettingsInput) => setHybridOv((o) => ({ ...o, ...p }));

  // the typed spending limit is NOT part of the key: editing it must not throw away a reviewed plan (the checkbox is bound to plan and amount)
  const bodyFor = (hov: HybridSettingsInput): StartFactoryInput => ({
    preset,
    mode,
    reusePartial,
    ...(mode === 'continue' && rerunCreative ? { rerunCreative: true } : {}),
    ...(depthOv !== null ? { depth: depthOv } : {}),
    f1: ov.f1,
    f2: ov.f2,
    f3: ov.f3,
    f4: isNoAi ? withoutImageKeys(ov.f4) : ov.f4,
    ...(usesHybrid ? { hybrid: isNoAi ? noAiHybridInput(hov) : hov } : {}),
  });
  const body = bodyFor(hybridOv);
  const key = JSON.stringify(body);
  const valid = plan?.key === key ? plan.data : null;
  const channels = eff?.f4.channels ?? null;
  // Hybrid: the free preview of exactly this form, and the confirmation of its visual direction (bound to that one preview)
  const pvCurrent = !!pv && pv.key === key;
  const needsDirection = usesHybrid && !!hv?.reviewDirection;
  const directionOk = !needsDirection || (pvCurrent && !!pv && dirAck === `${pv.key}#${pv.rev}`);
  const startBody: StartFactoryInput = needsDirection ? { ...body, hybrid: { ...hybridOv, directionApproved: true } } : body;
  const needsConsent = !!valid && valid.budget.consentNeeded && !valid.nothingToRun;
  // the confirmation belongs to this exact review: a new review (new estimate) or another amount un-ticks it
  const spend = useSpendingConsent(`${key}#${plan?.rev ?? 0}`, valid?.cost ?? null);

  const run = valid?.phases.filter((p) => p.action === 'run').map((p) => p.code) ?? [];
  const label = !valid ? 'Start campaign' : valid.totals.phasesReused === 0 ? 'Start campaign (F1 → F4)' : `Continue campaign — ${run.join(' and ')} remaining`;
  // ONE confirmation for every preset. An unpublished image price is accepted inside the budget approval, which names the maximum image-request count.
  const unified = !!valid && needsConsent && !isNoAi ? { imageRequestCap: valid.budget.imageRequestCap ?? valid.cost.images.count, priceUnavailable: valid.budget.imagePriceUnavailable === true } : undefined;
  const inputBlockers = valid?.inputs?.blockers ?? [];
  // the missing design has its own item in the checklist (it is the same thing the user does in "Campaign design")
  const designBlocker = valid?.blockers.find((b) => b.code === 'design_missing');
  const otherBlockers = valid ? valid.blockers.filter((b) => !inputBlockers.some((i) => i.code === b.code) && b.code !== 'design_missing') : [];
  // EVERY condition that keeps Start disabled is an item of this list (shown to the user); the button is enabled exactly when none is open
  const checklist: ChecklistItem[] = [{ id: 'review', label: 'Review the plan (free)', done: !!valid, hint: 'Press “Review plan (free)”: it shows exactly what will run and what it can cost. Nothing is sent to OpenAI.' }];
  if (usesHybrid) checklist.push({ id: 'design', label: 'Choose and confirm the campaign design', done: !!hv?.design?.confirmed && !designBlocker, testId: 'design-needed', hint: designBlocker?.message ?? 'In “Campaign design” choose a template collection, review the palette and the formats, then press “Use this design for the campaign”.' });
  if (valid) {
    checklist.push({ id: 'project', label: 'The project has a business name and a short description', done: inputBlockers.length === 0, hint: inputBlockers[0]?.message });
    checklist.push({ id: 'config', label: 'No configuration problem (API key, models, permissions)', done: otherBlockers.length === 0, hint: otherBlockers[0]?.message });
    if (valid.nothingToRun) checklist.push({ id: 'work', label: 'Something left to run', done: false, hint: 'Every phase already has a saved result for this chain. Choose “Run every phase again”, or tick “new creative round”.' });
    if (needsDirection) checklist.push({ id: 'direction', label: 'Confirm the visual direction', done: directionOk, testId: 'direction-needed', hint: 'You asked to review the visual direction: run “Preview the plan (free)” below and confirm the direction card.' });
    if (needsConsent) {
      checklist.push({ id: 'limit', label: 'Enter the total campaign budget', done: spend.value !== null, hint: isNoAi ? 'Type the most you accept to spend on the whole campaign, from $0.01 to $500, under the cost estimate. It is shared by the text agents and the reviews; image generation costs $0.' : 'Type the most you accept to spend on the whole campaign, from $0.01 to $500, under the cost estimate. It is shared by the text agents, the images and the reviews.' });
      if (spend.value !== null && spend.status === 'below_estimate') checklist.push({ id: 'limit-fits', label: 'The budget covers the estimate', done: false, hint: 'The budget is below the estimate, so the run could not finish. Raise it or use one of the options under the estimate.' });
      checklist.push({ id: 'approve', label: 'Tick the one spending approval', done: spend.consent && spend.ready, hint: spend.value === null ? 'Enter the budget first, then tick the confirmation.' : 'Tick the confirmation under the cost estimate.' });
    }
  }
  const canStart = !!valid && checklist.every((i) => i.done) && !start.isPending;
  const firstOpen = checklist.find((i) => !i.done);

  function review() {
    setApplied(null);
    // the typed budget travels with the review (not with the key): the estimate then compares it with the one budget
    const typed: StartFactoryInput = spend.value !== null ? { approvedBudgetUsd: spend.value } : {};
    preflight.mutate(
      { ...body, ...typed },
      {
        onSuccess: (data) => {
          setPlan({ key, data, rev: ++reviews.current });
          // suggest the preset's target (or the "raise the budget" value) once; never overwrite what the user typed
          const s = data.budget.consentNeeded ? suggestedLimit(data.cost) : null;
          if (s !== null && !spend.limit.trim()) spend.setLimit(String(s));
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }
  function begin() {
    if (!valid || !canStart) return;
    if (needsConsent) {
      // the typed budget and the ONE ticked confirmation ARE the confirmation of a plan with paid requests; the maximum number of image requests is computed from the plan
      start.mutate({ ...startBody, approvedBudgetUsd: spend.value!, confirmCost: true, ...(unified?.priceUnavailable ? { approvedImageRequests: unified.imageRequestCap } : {}) }, { onSuccess: onStarted, onError: (e) => toast.error(e.message) });
      return;
    }
    const t = valid.totals;
    const img = valid.models.image;
    const text = [
      `${label}?`,
      '',
      `This uses YOUR OpenAI API credits (text model "${valid.models.text.id}"${img ? `, image model "${img.id}" at quality "${img.quality}"` : ', no image model'}):`,
      `• phases that will run: ${valid.phases.filter((p) => p.action === 'run').map((p) => p.code).join(', ')}; reused saved results: ${valid.phases.filter((p) => p.action === 'reuse').map((p) => p.code).join(', ') || 'none'}`,
      `• at most ${t.textCallCap} text-model calls in total (hard limits per phase)`,
      `• ${t.imageRequests} image request(s)${t.imageRegenerationCap ? ` plus up to ${t.imageRegenerationCap} regeneration(s)` : ', regeneration off'}`,
      `• ${t.layouts} channel layouts rendered locally (no cost)`,
      `• estimated cost: typical ${fmtUsd(valid.cost.totals.typicalUsd)}, worst case ${fmtUsd(valid.cost.totals.maxUsd)} (an estimate from OpenAI's published prices, not a bill)`,
      '',
      'The limits are enforced by LaunchPilot and are NOT an OpenAI spending cap. A failed phase stops the run and is never retried automatically.',
    ].join('\n');
    if (!window.confirm(text)) return;
    start.mutate(startBody, { onSuccess: onStarted, onError: (e) => toast.error(e.message) });
  }

  /** The FREE Hybrid preview of the form (or of `hov`, the settings about to be saved). Sends no request to OpenAI or Pinterest. */
  function runPreview(hov: HybridSettingsInput = hybridOv) {
    const b = bodyFor(hov);
    const k = JSON.stringify(b);
    const seq = ++pvSeq.current;
    setPvError(null);
    hybridPreview.mutate(b, {
      onSuccess: (data) => {
        if (seq === pvSeq.current) setPv({ key: k, data, rev: ++reviews.current });
      },
      onError: (e) => {
        if (seq === pvSeq.current) setPvError(e.message);
      },
    });
  }
  /** A manual template choice for one creative: it switches Automatic selection to Manual and refreshes the preview. null = back to the automatic choice. */
  function overrideSlot(slotId: string, templateId: string | null) {
    const overrides = { ...(hv?.overrides ?? {}) };
    if (templateId) overrides[slotId] = templateId;
    else delete overrides[slotId];
    const next: HybridSettingsInput = { ...hybridOv, overrides, ...(templateId && hv?.selection === 'automatic' ? { selection: 'manual' as const } : {}) };
    setHybridOv(next);
    runPreview(next);
  }
  function switchStyle(id: StyleId) {
    const next: HybridSettingsInput = { ...hybridOv, style: id };
    setHybridOv(next);
    runPreview(next);
  }

  /** A budget option edits the form only when the user presses its button; the plan must then be reviewed again. */
  function applyOption(o: BudgetOptionData) {
    const s = o.set;
    if (s.approvedBudgetUsd !== undefined) spend.setLimit(String(s.approvedBudgetUsd));
    // NO AI HYBRID has no image option (no model, quality or count to change): only the budget can be applied
    if (isNoAi) return;
    const f4: NonNullable<StartFactoryInput['f4']> = {};
    if (s.imageModel) f4.imageModel = s.imageModel;
    if (s.imageFree) f4.imageModel = null;
    if (s.imageQuality) f4.imageQuality = s.imageQuality as ImageQuality;
    // Hybrid Production: the number of original AI images is a Hybrid setting, not an F4 one
    const hybridImages = isHybrid && s.maxImages !== undefined;
    if (s.maxImages !== undefined && !isHybrid) f4.maxImages = s.maxImages;
    if (hybridImages) patchHybrid({ originals: s.maxImages });
    if (Object.keys(f4).length || hybridImages) {
      if (Object.keys(f4).length) patch('f4', f4);
      setApplied(`${o.label}: the settings were changed. Review the plan again to see the new estimate.`);
    }
  }

  const startButton = (testId: string) => (
    <Button data-testid={testId} onClick={begin} disabled={!canStart} loading={start.isPending} title={firstOpen ? `${firstOpen.label}${firstOpen.hint ? `: ${firstOpen.hint}` : ''}` : ''}>
      <Play className="h-4 w-4" /> {label}
    </Button>
  );

  const toggleChannel = (id: ChannelId) => {
    const cur = channels ?? [];
    const next = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id];
    patch('f4', { channels: next.length ? next : null });
  };

  if (!eff) return <div className="h-40 animate-pulse rounded-2xl bg-cream-200" />;
  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-cream-100 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Settings preset</legend>
            {PRESET_ORDER.filter((p) => !!presets.data?.presets[p]).map((p) => (
              <label key={p} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="preset" data-testid={`preset-${p}`} checked={preset === p} onChange={() => { setPreset(p); setOv({ f1: {}, f2: {}, f3: {}, f4: {} }); setDepthOv(null); setApplied(null); spend.setLimit(''); setHybridOv({}); setPv(null); setPvError(null); setDirAck(null); pvSeq.current++; }} className="mt-1" />
                <span>
                  <strong>{PRESET_INFO[p].title}</strong>
                  <span className="block text-xs text-muted">{PRESET_INFO[p].text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">What to run</legend>
            <label className="flex cursor-pointer items-start gap-2">
              <input type="radio" name="mode" checked={mode === 'continue'} onChange={() => setMode('continue')} className="mt-1" />
              <span>
                <strong>Continue from saved work (recommended)</strong>
                <span className="block text-xs text-muted">Reuses ONE coherent chain of completed reports and runs only what is missing. No completed phase is paid for again.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input type="radio" name="mode" checked={mode === 'fresh'} onChange={() => setMode('fresh')} className="mt-1" />
              <span>
                <strong>Run every phase again</strong>
                <span className="block text-xs text-muted">Starts from F1 and ignores saved results (spends more; earlier results stay saved).</span>
              </span>
            </label>
            {mode === 'continue' && (
              <>
                <label className="flex items-center gap-2 pt-1 text-xs text-muted">
                  <input type="checkbox" checked={rerunCreative} onChange={(e) => setRerunCreative(e.target.checked)} /> Produce a new creative round even if a campaign already exists for this strategy
                </label>
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={reusePartial} onChange={(e) => setReusePartial(e.target.checked)} /> Reuse saved reports that are marked partial (they are flagged in the plan)
                </label>
              </>
            )}
          </fieldset>
        </div>

        {usesHybrid && hv && (
          <HybridSettingsPanel
            projectId={projectId}
            value={hv}
            onChange={patchHybrid}
            concepts={eff.f4.concepts}
            onConcepts={(n) => patch('f4', { concepts: n })}
            imageOn={!isNoAi && !!eff.f4.imageModel}
            noAi={isNoAi}
            imageFields={isNoAi ? null : <ImageModelFields f4={eff.f4} imageModels={imageModels} imageOptions={imageOptions} patch={(v) => patch('f4', v)} />}
            channelPicker={<ChannelPicker channels={channels} onToggle={toggleChannel} />}
            design={hv.design ?? null}
            onDesign={(d) => patchHybrid({ design: d })}
            sourcePlan={valid?.hybrid?.design?.sources ?? null}
            onApplyOriginals={(n) => patchHybrid({ originals: n })}
            initialCollection={initialCollection}
            assets={project.data?.assets}
            estimate={valid ? { typicalUsd: valid.cost.totals.typicalUsd, maxUsd: valid.cost.totals.maxUsd, from: 'plan review' } : pvCurrent && pv ? { typicalUsd: pv.data.cost.totals.typicalUsd, maxUsd: pv.data.cost.totals.maxUsd, from: 'preview' } : null}
            plannedHeadline={valid?.hybrid?.headline ?? null}
          />
        )}

        <details className="mt-4 text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 text-muted hover:text-ink">
            <Settings2 className="h-3.5 w-3.5" /> Limits and creative settings (enforced per phase)
          </summary>
          <div className="mt-4 space-y-5">
            <div>
              <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Depth</h5>
              <label className="flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" data-testid="depth-toggle" className="mt-0.5" checked={eff.depth} onChange={(e) => setDepthOv(e.target.checked)} />
                <span>
                  <strong className="text-ink">Depth</strong>: more cross-check passes in the research, the audit and the strategy, and a concept critique before the images are generated. It costs a few extra text calls, and only when there is something to review. There is no separate text budget: everything you approve is ONE campaign budget.
                </span>
              </label>
            </div>
            <div>
              <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">F1 and F2 (only if they run)</h5>
              <div className="grid gap-3 sm:grid-cols-4">
                <Num label="F1 max model calls" min={3} max={40} value={eff.f1.maxModelCalls} onChange={(n) => patch('f1', { maxModelCalls: n })} />
                <Num label="F1 max cross-checks" min={0} max={8} value={eff.f1.maxReviews} onChange={(n) => patch('f1', { maxReviews: n })} />
                <Num label="F2 max model calls" min={3} max={30} value={eff.f2.maxModelCalls} onChange={(n) => patch('f2', { maxModelCalls: n })} />
                <Num label="F2 max cross-checks" min={0} max={8} value={eff.f2.maxReviews} onChange={(n) => patch('f2', { maxReviews: n })} />
              </div>
            </div>
            <div>
              <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">F3 Market Research &amp; Strategy</h5>
              <div className="grid gap-3 sm:grid-cols-4">
                <Num label="Max model calls" min={6} max={40} value={eff.f3.maxModelCalls} onChange={(n) => patch('f3', { maxModelCalls: n })} />
                <Num label="Max Channel Scouts" min={0} max={6} value={eff.f3.maxScouts} onChange={(n) => patch('f3', { maxScouts: n })} />
                <Num label="Max cross-checks" min={0} max={10} value={eff.f3.maxReviews} onChange={(n) => patch('f3', { maxReviews: n })} />
                <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                  <input type="checkbox" checked={eff.f3.useHolidayCalendar} onChange={(e) => patch('f3', { useHolidayCalendar: e.target.checked })} /> Seasonal calendar (free public API)
                </label>
              </div>
            </div>
            <div>
              <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">F4 Creative Production</h5>
              <div className="grid gap-3 sm:grid-cols-4">
                {!usesHybrid && <ImageModelFields f4={eff.f4} imageModels={imageModels} imageOptions={imageOptions} patch={(v) => patch('f4', v)} />}
                {!usesHybrid && (
                  <>
                    <Num label="Creative concepts" min={1} max={5} value={eff.f4.concepts} onChange={(n) => patch('f4', eff.f4.variations ? { concepts: n } : { concepts: n, maxImages: Math.min(eff.f4.maxImages, n) })} />
                    {eff.f4.variations ? (
                      <Num label="Original AI images (all concepts)" min={0} max={40} value={eff.f4.maxImages} onChange={(n) => patch('f4', { maxImages: n })} hint={eff.f4.imageModel ? 'Total number of originals, up to 40; the planner shares them out over the concepts' : 'No image model: 0'} />
                    ) : (
                      <Num label="Original AI images" min={0} max={eff.f4.concepts} value={Math.min(eff.f4.maxImages, eff.f4.concepts)} onChange={(n) => patch('f4', { maxImages: n })} hint={eff.f4.imageModel ? undefined : 'No image model: 0'} />
                    )}
                    <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                      <input type="checkbox" data-testid="variations-toggle" checked={eff.f4.variations} disabled={!eff.f4.imageModel} onChange={(e) => patch('f4', { variations: e.target.checked })} /> Several original images per concept (the count above is then the total)
                    </label>
                  </>
                )}
                {!isNoAi && <Num label="Images requested at once" min={1} max={4} value={eff.f4.imageConcurrency} onChange={(n) => patch('f4', { imageConcurrency: n })} hint="1-4; each image is its own request" />}
                <Num label="Max text-model calls" min={4} max={80} value={eff.f4.maxModelCalls} onChange={(n) => patch('f4', { maxModelCalls: n })} />
                <Num label="Repair rounds" min={0} max={3} value={eff.f4.maxRepairRounds} onChange={(n) => patch('f4', { maxRepairRounds: n })} />
                <Num label="Assets the reviewer may look at" min={0} max={6} value={eff.f4.visionReviews} onChange={(n) => patch('f4', { visionReviews: n })} hint="Vision review; 0 = off" />
                <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                  <input type="checkbox" checked={eff.f4.landing} onChange={(e) => patch('f4', { landing: e.target.checked })} /> Landing page content
                </label>
              </div>
              {!usesHybrid && (
                <>
                  <div className="mt-3">
                    <ChannelPicker channels={channels} onToggle={toggleChannel} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={eff.f4.maxRegenerations > 0} disabled={!eff.f4.imageModel} onChange={(e) => patch('f4', { maxRegenerations: e.target.checked ? 1 : 0 })} /> Allow image regeneration (each extra image is billed)
                    </label>
                    {eff.f4.maxRegenerations > 0 && <Num label="Max regenerations" min={1} max={5} value={eff.f4.maxRegenerations} onChange={(n) => patch('f4', { maxRegenerations: n })} />}
                  </div>
                </>
              )}
            </div>
            <p className="max-w-3xl text-xs text-muted">These limits are enforced by LaunchPilot for each phase. They are not an OpenAI spending cap; reviewing the plan shows an estimate in dollars. A failed phase is never retried automatically.</p>
          </div>
        </details>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button data-testid="review-plan" variant="outline" onClick={review} loading={preflight.isPending}>
            <ClipboardCheck className="h-4 w-4" /> Review plan (free)
          </Button>
          {startButton('start-campaign')}
          {!valid && <span className="text-xs text-muted">Nothing runs until you review the plan and confirm.</span>}
        </div>
        {/* with a spending approval the checklist sits next to the Start button under the plan; otherwise here */}
        {!(valid && needsConsent) && <div className="mt-3"><StartChecklist items={checklist} /></div>}
        {applied && (
          <p role="status" data-testid="option-applied" className="mt-3 flex items-start gap-2 text-xs text-amber-900">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {applied}
          </p>
        )}
      </div>

      {usesHybrid && hv && (
        <HybridPreviewSection
          noAi={isNoAi}
          projectId={projectId}
          state={pv}
          currentKey={key}
          pending={hybridPreview.isPending}
          error={pvError}
          onRun={() => runPreview()}
          settings={hv}
          onSwitchStyle={switchStyle}
          onOverride={overrideSlot}
          directionApproved={directionOk && needsDirection}
          onApproveDirection={(on) => setDirAck(on && pv ? `${pv.key}#${pv.rev}` : null)}
        />
      )}

      {valid && (
        <PlanCard
          plan={valid}
          onApplyOption={applyOption}
          directionApproved={needsDirection ? directionOk : undefined}
          footer={
            needsConsent ? (
              <div className="space-y-3">
                <SpendingConsent spend={spend} cost={valid.cost} unified={unified} onApplyOption={applyOption} noAi={isNoAi}>
                  {startButton('start-campaign-consent')}
                </SpendingConsent>
                <StartChecklist items={checklist} />
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}

const num = (n: unknown) => (typeof n === 'number' ? n : 0);

function limitsText(p: FactoryPlanPhase, noAi = false): string {
  const l = (p.limits ?? {}) as Record<string, any>;
  const e = p.expected;
  if (p.phase === 'discovery' || p.phase === 'audit') return `up to ${l.maxModelCalls} model calls · up to ${l.maxReviews} cross-checks`;
  if (p.phase === 'strategy') return `up to ${l.maxModelCalls} model calls (typically about ${e?.textCalls?.typical ?? '?'}) · up to ${l.maxScouts} Channel Scouts created at run time · up to ${l.maxReviews} cross-checks · seasonal calendar ${l.useHolidayCalendar ? 'on' : 'off'}`;
  const ch = Array.isArray(l.channels) ? l.channels.join(', ') : 'the strategy’s recommended channels';
  return [
    `${l.concepts} concept(s) for ${ch}`,
    l.landing ? 'landing page' : 'no landing page',
    l.imageModel ? `${num(e?.imageRequests?.planned)} original image(s) with ${l.imageModel} (${l.imageQuality})` : noAi ? 'AI-generated images: 0 (your approved pictures, licensed stock or typography)' : 'no AI image (brand-colored backgrounds)',
    noAi ? 'no image regeneration' : l.maxRegenerations > 0 ? `regeneration up to ${l.maxRegenerations}` : 'regeneration off',
    `${num(e?.layouts?.planned)} layouts (local, free)`,
    `vision review ${l.visionReviews ? `of ${l.visionReviews} asset(s)` : 'off'}`,
    `up to ${l.maxRepairRounds} repair rounds`,
    `up to ${l.maxModelCalls} text calls (typically about ${e?.textCalls?.typical ?? '?'})`,
  ].join(' · ');
}

/** Four different numbers, never one: concepts asked for, originals the limit permits, requests planned, concepts left to brand-colored backgrounds. */
function ImagePlan({ p }: { p: NonNullable<FactoryPlan['imagePlan']> }) {
  return (
    <div data-testid="image-plan" className={cn('rounded-xl border px-4 py-3 text-xs', p.budgetLimitedConcepts > 0 || !p.enabled ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-cream-300/80 bg-cream-50 text-muted')}>
      <p className="font-semibold uppercase tracking-wider">Images in this run</p>
      {!p.enabled ? (
        <p className="mt-1">No image model: every concept uses a brand-colored background and no AI image is generated.</p>
      ) : p.variations ? (
        <p className="mt-1">
          {p.conceptsRequested} concept(s) · {p.originalsTarget} original AI image(s) requested in total, {p.allocated} placed by the planner · {p.plannedRequests} image request(s) planned, {p.imageConcurrency} at a time · about {p.expectedLayouts} channel layout(s) cut locally from them (free)
          {p.allocated < p.originalsTarget ? ` · ${p.originalsTarget - p.allocated} cannot be placed without exceeding the per-concept limit` : ''}.
        </p>
      ) : (
        <p className="mt-1">
          {p.conceptsRequested} concept(s) requested · {p.originalImagesPermitted} original AI image(s) permitted by the limit · {p.plannedRequests} image request(s) planned
          {p.regenerationCap ? ` (+ up to ${p.regenerationCap} regeneration)` : ''}
          {p.budgetLimitedConcepts > 0 ? ` · ${p.budgetLimitedConcepts} concept(s) will use a brand-colored background, NOT an AI image, because of the limit` : ''}.
        </p>
      )}
    </div>
  );
}

/** How the original images will be shared out over the concepts. Before the run this is only a FORECAST with equal weights. */
function AllocationTable({ a }: { a: ImageAllocationData }) {
  return (
    <div data-testid="allocation-table" data-basis={a.basis} className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Original images per concept {a.basis === 'forecast' ? '(forecast)' : ''}</p>
      {a.basis === 'forecast' && <p className="text-xs text-muted">A forecast with equal weights: the concepts do not exist yet. The real split is made from the real concepts and their channels once the Copywriter has delivered them, and it is saved with the campaign.</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Concept</th>
              <th className="py-1 pr-3 font-medium">Images</th>
              <th className="py-1 pr-3 font-medium">Channels</th>
              <th className="py-1 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {a.perConcept.map((c) => (
              <tr key={c.conceptId} className="border-t border-cream-300/70 align-top">
                <td className="py-1 pr-3">{c.name}</td>
                <td className="py-1 pr-3 font-semibold">{c.count}</td>
                <td className="py-1 pr-3">{c.channels.join(', ') || '—'}</td>
                <td className="py-1 text-muted">{c.reason}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-cream-300 font-semibold">
              <td className="py-1 pr-3">Total</td>
              <td className="py-1 pr-3">
                {a.allocated}
                {a.allocated !== a.target ? ` of ${a.target} requested` : ''}
              </td>
              <td className="py-1 pr-3" colSpan={2}>
                about {a.expectedLayouts} channel layout(s), at most {a.maxPerConcept} originals per concept
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const VERIFICATION: Record<'listed_not_tested' | 'not_listed' | 'unknown', { tone: string; title: string; text: string }> = {
  listed_not_tested: { tone: 'border-amber-300 bg-amber-50 text-amber-900', title: 'Listed for your key, generation permission not tested', text: 'Your key lists this model, but nobody has proved that your account may generate images with it (OpenAI can require organization verification or a project permission). Only a billed image request can show it.' },
  not_listed: { tone: 'border-red-300 bg-red-50 text-red-800', title: 'Not listed for your key', text: 'Your OpenAI key does not list this model, so image requests would be refused.' },
  unknown: { tone: 'border-cream-300 bg-cream-50 text-ink-600', title: 'Availability not checked', text: 'The model list of your key could not be read, so the model was not pre-checked. If it is unavailable, the run says so and uses brand-colored backgrounds.' },
};

/** The exact image model the run will use, shown before anything starts: who chose it, why (a documented preference, never a measured result) and what is not yet proven. */
function ImageModelChoice({ m }: { m: ImageModelChoiceData }) {
  const auto = m.mode === 'auto';
  const v = VERIFICATION[m.verification ?? 'unknown'];
  return (
    <div data-testid="image-model-choice" data-model={m.id ?? ''} data-mode={m.mode ?? 'explicit'} className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/20 px-4 py-3 text-xs">
      <p className="font-semibold uppercase tracking-wider text-muted">Image model for this run</p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <strong className="font-mono text-base text-ink">{m.id ?? 'none usable'}</strong>
        <Badge className="bg-cream-200 text-ink-600">quality {m.quality}</Badge>
        <Badge className={auto ? 'bg-accent-soft text-accent-hover' : 'bg-cream-200 text-ink-600'}>{auto ? `chosen automatically${m.strategy ? ` · ${STRATEGY_INFO[m.strategy].label}` : ''}` : 'chosen by you'}</Badge>
        {m.documented && <Badge className="bg-cream-200 text-ink-600">{m.documented.tier}</Badge>}
      </p>
      {m.reason && (
        <p>
          {m.reason} <span className="text-muted">This is what OpenAI documents about the model, a preference and not a measured result of image quality.</span>
        </p>
      )}
      {m.documented && (
        <p className="text-muted">
          Documented: {m.documented.positioning} · qualities: {m.documented.qualities.join(', ')}
        </p>
      )}
      {!auto && m.strategySetting && <p className="text-muted">The image model strategy ({STRATEGY_INFO[m.strategySetting].label}) is not used: you chose this model yourself.</p>}
      {m.alternatives && m.alternatives.length > 0 && (
        <p className="text-muted">
          Other current models on your key: <span className="font-mono">{m.alternatives.join(', ')}</span>. Change the strategy or choose one under “Limits and creative settings”.
        </p>
      )}
      <div data-testid="image-model-verification" data-verification={m.verification ?? 'unknown'} className={cn('rounded-lg border px-3 py-2', v.tone)}>
        <p className="font-medium">{v.title}</p>
        <p>
          {v.text}
          {m.verification === 'listed_not_tested' && (
            <>
              {' '}
              To check it before a full run, use <Link href="/settings/providers" className="font-medium underline underline-offset-2">Settings &gt; AI providers &gt; “Test image model (billed)”</Link>.
            </>
          )}
        </p>
      </div>
      {m.priceKnown === false && <p className="text-amber-900">No published price: the image cost is unknown until the first image is generated, and you confirm this before you can start.</p>}
      {m.warning && (
        <p className="flex items-start gap-2 text-amber-900">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {m.warning}
        </p>
      )}
      {m.verification !== 'listed_not_tested' && <p className="text-muted">{m.note}</p>}
    </div>
  );
}

/** The Full Production summary: everything the user is about to approve, in one place. */
function ProductionSummary({ plan }: { plan: FactoryPlan }) {
  const ip = plan.imagePlan;
  const img = plan.models.image;
  const noAi = plan.preset === 'no_ai_hybrid';
  const items: [string, React.ReactNode][] = [
    ['Preset', PRESET_INFO[plan.preset].title],
    ['Text model', <span className="font-mono">{plan.models.text.id ?? 'none selected'}</span>],
    ['Image model', noAi ? 'none: NO AI HYBRID never generates images' : ip?.enabled ? <span><span className="font-mono">{img?.id ?? ip.model ?? 'none usable'}</span> · quality {ip.quality}{ip.modelMode === 'auto' ? ` · chosen automatically${img?.strategy ? ` (${STRATEGY_INFO[img.strategy].label})` : ''}` : ''}</span> : 'none (brand-colored backgrounds)'],
    ['Depth', plan.settings.depth ? 'on: extra cross-checks and a concept critique' : 'off'],
    ['Concepts', plan.settings.f4.concepts],
    noAi ? ['AI-generated images', 0] : ['Original AI images (target)', ip?.enabled ? ip.originalsTarget : 0],
    plan.hybrid ? ['Template creatives', `${plan.hybrid.templateCreatives.planned} (rendered locally, free)`] : ['Expected channel layouts', ip ? `about ${ip.expectedLayouts} (local, free)` : '—'],
  ];
  return (
    <dl data-testid="production-summary" className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-xl bg-cream-100 px-4 py-3">
          <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
          <dd className="mt-0.5 font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PlanCard({ plan, onApplyOption, footer, directionApproved }: { plan: FactoryPlan; onApplyOption?: (o: BudgetOptionData) => void; footer?: React.ReactNode; directionApproved?: boolean }) {
  // several originals per concept (Full Production, or any plan where the user switched it on)
  const noAi = plan.preset === 'no_ai_hybrid';
  const hybrid = (plan.preset === 'hybrid_production' || noAi) && !!plan.hybrid;
  const full = !hybrid && (plan.preset === 'full_production' || !!plan.imagePlan?.variations);
  const costCard = !plan.nothingToRun && <CostEstimateCard cost={plan.cost} tokenBudgets={full || hybrid ? plan.tokenBudgets : undefined} onApply={onApplyOption} noAi={noAi} />;
  return (
    <section aria-label="Campaign plan" className="space-y-4 rounded-2xl border border-accent/40 bg-white/70 p-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Plan: exactly this will run</p>
        <h3 className="text-xl">{plan.project.name}</h3>
        <p className="text-xs text-muted">
          {[plan.brief.targetAudience && `Audience: ${plan.brief.targetAudience}`, plan.brief.marketingGoal && `Objective: ${plan.brief.marketingGoal}`, plan.brief.targetMarket && `Market: ${plan.brief.targetMarket}`, plan.brief.language && `Language: ${plan.brief.language}`].filter(Boolean).join(' · ') || 'No audience or objective set in the brief.'}
        </p>
      </div>
      {plan.blockers.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {plan.blockers.map((b) => (
            <li key={b.code} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {b.message}
            </li>
          ))}
        </ul>
      )}
      {plan.reportChecks && plan.reportChecks.length > 0 && (
        <ul data-testid="report-checks" aria-label="Saved reports check" className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
          {plan.reportChecks.map((c) => (
            <li key={c.code} data-report={c.code} data-status={c.status} className={cn('flex items-start gap-2', c.status === 'unreadable' || c.status === 'missing' ? 'text-red-700' : 'text-ink-700')}>
              {c.status === 'unreadable' || c.status === 'missing' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />}
              <span>
                <span className="font-mono text-[11px] text-muted">{c.code}</span> {c.message}
                {c.adjustments && c.adjustments.length > 0 && <span className="block text-xs text-muted">Adjustments (in memory only; the saved report is unchanged): {c.adjustments.join(' · ')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {plan.inputs && <InputReadinessCard inputs={plan.inputs} />}
      <ol className="space-y-2">
        {plan.phases.map((p) => (
          <li key={p.phase} data-phase={p.phase} data-action={p.action} className={cn('rounded-xl border px-4 py-3 text-sm', p.action === 'reuse' ? 'border-sky-200 bg-sky-50/60' : 'border-cream-300/80 bg-cream-50')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted">{p.code}</span>
              <strong>{p.title}</strong>
              <Badge className={p.action === 'reuse' ? 'bg-sky-100 text-sky-800' : 'bg-accent-soft text-accent-hover'}>{p.action === 'reuse' ? 'Reuse saved result' : 'Run'}</Badge>
              {p.reuse?.partial && <Badge className="bg-amber-100 text-amber-800">partial</Badge>}
              {p.measured && (
                <span className="ml-auto text-xs text-muted">
                  {p.action === 'reuse' ? 'already spent' : 'last run measured'}: {p.measured.calls} calls, {p.measured.tokens.toLocaleString()} tokens
                </span>
              )}
            </div>
            {p.action === 'reuse' && p.reuse ? (
              <p className="mt-1 text-xs text-muted">
                Saved {formatDate(p.reuse.createdAt)} · {p.reuse.model ?? 'unknown model'} · <span className="font-mono">{p.reuse.id}</span>
                {p.reuse.summary ? ` — ${p.reuse.summary}` : ''}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">{limitsText(p, noAi)}</p>
            )}
          </li>
        ))}
      </ol>
      <dl className="grid gap-3 text-sm sm:grid-cols-5">
        {[
          ['Phases to run', plan.totals.phasesToRun],
          ['Reused', plan.totals.phasesReused],
          ['Text calls (hard cap)', plan.totals.textCallCap],
          ['AI images', plan.totals.imageRequests + (plan.totals.imageRegenerationCap ? ` (+${plan.totals.imageRegenerationCap})` : '')],
          ['Local layouts', plan.totals.layouts],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl bg-cream-100 px-4 py-3">
            <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
            <dd className="text-xl font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">
        Text model <strong className="font-mono">{plan.models.text.id ?? 'none selected'}</strong> ({plan.models.text.source === 'saved' ? 'saved in Settings' : 'chosen here'}) · Depth {plan.settings.depth ? 'on' : 'off'}
        {plan.models.image ? '' : ' · no image model for this run.'}
      </p>
      {plan.models.image && <ImageModelChoice m={plan.models.image} />}
      {plan.imagePlan && !noAi && <ImagePlan p={plan.imagePlan} />}
      {plan.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-900">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {hybrid ? (
        <div data-testid={noAi ? 'no-ai-hybrid-plan' : 'hybrid-production-plan'} className="space-y-4 rounded-xl border border-accent/30 bg-accent-soft/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{noAi ? 'NO AI HYBRID' : 'Hybrid Production'}: what you are about to approve</p>
          <ProductionSummary plan={plan} />
          <HybridPlanBlock plan={plan} directionApproved={directionApproved} />
          {costCard}
        </div>
      ) : full ? (
        <div data-testid="full-production-plan" className="space-y-4 rounded-xl border border-accent/30 bg-accent-soft/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Full Production: what you are about to approve</p>
          <ProductionSummary plan={plan} />
          {plan.allocation && <AllocationTable a={plan.allocation} />}
          {costCard}
        </div>
      ) : (
        costCard
      )}
      <p className="rounded-xl bg-cream-100 px-4 py-2.5 text-xs text-ink-600">
        These limits are enforced by LaunchPilot for each phase and are <strong>not an OpenAI spending cap</strong>. The dollar figures are estimates from OpenAI&apos;s published prices ({plan.cost.available ? 'every request of this plan can be priced' : 'the estimate is unavailable for part of this plan'}), never an invoice; {noAi ? 'no image is generated, so no image is billed (only the text-model calls are paid)' : hybrid ? 'every original AI image is billed by OpenAI, the template creatives are rendered locally and are not' : 'every image is billed by OpenAI'}.
      </p>
      {footer}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Cost and limitations</summary>
        <p className="mt-2 max-w-3xl">{plan.pricing.note}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {plan.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// ---- the live run ----------------------------------------------------------------------------------------------------------------------------

export function OutcomeBanner({ run }: { run: FactoryRunData }) {
  const b = BANNER[run.outcome];
  return (
    <div role="status" data-outcome={run.outcome} className={cn('flex items-start gap-3 rounded-2xl border px-5 py-4', b.tone)}>
      {run.status === 'running' || run.status === 'queued' ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" /> : run.outcome === 'approved' ? <Check className="mt-0.5 h-5 w-5 shrink-0" /> : run.outcome === 'interrupted' ? <OctagonX className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />}
      <div>
        <p className="font-semibold">
          {b.title}
          {isActive(run.status) && run.currentPhase ? `: ${run.phases.find((p) => p.phase === run.currentPhase)?.code} ${run.phases.find((p) => p.phase === run.currentPhase)?.title}` : ''}
        </p>
        <p className="text-sm">{b.text}</p>
        {run.errorMessage && run.outcome !== 'approved' && <p data-testid="run-error" className="mt-1 text-sm">{run.failure?.restated?.summary ?? run.errorMessage}</p>}
      </div>
    </div>
  );
}

/**
 * WHY the campaign stopped: where, which participant, the specific safe reason, why no image was requested, what was spent (known and uncertain),
 * what is left, and what to do. A stopped campaign is never described as a success, and nothing here starts paid work by itself.
 */
export function FailureCard({ failure: f, onContinue }: { failure: FactoryFailureData; onContinue?: () => void }) {
  const usd = (n: number | null) => (n === null ? 'unknown' : fmtUsd(n));
  const row = (k: string, v: React.ReactNode) => (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
  return (
    <section data-testid="failure-card" data-kind={f.kind} data-code={f.code ?? ''} aria-label="Why the campaign stopped" className="space-y-3 rounded-2xl border border-red-200 bg-red-50/60 px-5 py-4 text-red-950">
      <p data-testid="failure-headline" className="font-semibold">{f.headline}</p>
      <dl className="space-y-2">
        {f.agent && row('Agent', <span data-testid="failure-agent">{f.agent}</span>)}
        {row('Reason', <span data-testid="failure-reason">{f.reason}{f.detail ? <> <span className="text-red-900/80">{f.detail}</span></> : null}</span>)}
        {row('Images', <span data-testid="failure-images">{f.imageGeneration.why}</span>)}
        {row('Known spending', <span data-testid="failure-known">{usd(f.spending.knownUsd)}</span>)}
        {row('Uncertain charges', <span data-testid="failure-uncertain">{f.spending.uncertainUsd ? `${usd(f.spending.uncertainUsd)} (held for request(s) that may have been billed; counted as spent, not a confirmed charge)` : 'none'}</span>)}
        {row('Remaining budget', <span data-testid="failure-remaining">{usd(f.spending.remainingUsd)}{f.spending.remainingBasis && f.spending.remainingBasis !== 'exact' ? ` (${f.spending.remainingBasis})` : ''}</span>)}
        {f.saved.length > 0 && row('Saved work', <span data-testid="failure-saved">{f.saved.map((s) => `${s.code} ${s.title}`).join(' · ')} (kept; never paid for again)</span>)}
        {f.recovery && row('Saved reports now', (
          <ul data-testid="failure-recovery" data-ready={f.recovery.ready ? 'true' : 'false'} className="space-y-0.5">
            {f.recovery.reports.map((r) => (
              <li key={r.code} data-report={r.code} data-status={r.status}><span className="font-mono text-[11px]">{r.code}</span> {r.message}</li>
            ))}
            {f.recovery.lineageProblems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        ))}
      </dl>
      <p className="text-xs text-red-900/80">{f.spending.note}</p>
      <p data-testid="failure-next" className="text-sm"><strong>Recommended next action:</strong> {f.nextAction}</p>
      {onContinue && f.canContinue && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" data-testid="failure-continue" onClick={onContinue}>
            <Play className="h-3.5 w-3.5" /> Continue from saved work
          </Button>
          <span className="text-xs text-red-900/80">Opens the plan (free). Nothing is sent to OpenAI until you review it and approve a new campaign budget.</span>
        </div>
      )}
    </section>
  );
}

function PhaseCard({ p, projectId, current, restatedNote }: { p: FactoryPhaseData; projectId: string; current: boolean; restatedNote?: string }) {
  const s = PHASE_STATUS[p.status];
  return (
    <li data-phase={p.phase} data-status={p.status} className={cn('rounded-2xl border px-4 py-3 text-sm', current ? 'border-accent bg-accent-soft/40' : p.status === 'reused' ? 'border-sky-200 bg-sky-50/60' : 'border-cream-300/80 bg-cream-50')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-mono text-[11px] text-muted">{p.code}</span>
          <p className="font-medium leading-tight">{p.title}</p>
        </div>
        <Badge className={s.badge}>
          {s.icon}
          {s.label}
        </Badge>
      </div>
      <p className="mt-2 text-xs text-muted">
        {p.status === 'reused' && p.reused ? `Saved ${formatDate(p.reused.createdAt)} by ${p.reused.model ?? 'unknown model'}${p.reused.partial ? ' (partial)' : ''}; no new run, no new cost.` : null}
        {p.status === 'completed' ? `Saved ${p.completedAt ? formatDate(p.completedAt) : ''}${p.startedAt && p.completedAt ? ` · took ${fmtDuration(Date.parse(p.completedAt) - Date.parse(p.startedAt))}` : ''}` : null}
        {p.status === 'running' ? `Started ${p.startedAt ? formatDate(p.startedAt) : ''}` : null}
        {p.status === 'pending' ? 'Waiting for the previous phase to be saved.' : null}
        {p.status === 'skipped' ? 'Not started because an earlier phase did not complete.' : null}
      </p>
      {p.error && <p role="alert" className="mt-1 text-xs text-red-700">{restatedNote ?? p.error}</p>}
      {(p.outputId || p.runId) && (
        <p className="mt-2 text-xs">
          <Link href={`/projects/${projectId}/workspace#phase-${p.code.toLowerCase()}`} className="text-accent-hover underline-offset-2 hover:underline">
            View {p.code} {p.status === 'running' ? 'run' : 'report'}
          </Link>
        </p>
      )}
    </li>
  );
}

const SPECIAL: Record<string, string> = {
  'participant.registered': 'border-accent bg-accent-soft/40 font-medium',
  'revision.requested': 'border-amber-400 bg-amber-50/60',
  'revision.applied': 'border-amber-400 bg-amber-50/60',
  'fix.requested': 'border-amber-400 bg-amber-50/60',
  'review.completed': 'border-sky-300',
  // Hybrid Production
  'visual.direction.published': 'border-violet-300 bg-violet-50/50',
  'template.selection.completed': 'border-violet-300 bg-violet-50/50',
  'template.quality.completed': 'border-sky-300',
  'campaign.completed': 'border-emerald-400 bg-emerald-50/60 font-medium',
};

export function ActivityFeed({ items, active }: { items: FactoryActivityItem[]; active: boolean }) {
  const [minor, setMinor] = React.useState(false);
  const box = React.useRef<HTMLOListElement>(null);
  const shown = items.filter((i) => minor || i.importance !== 'minor');
  React.useEffect(() => {
    if (active && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, active]);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Agent activity: recorded Mozaik events ({items.length})</h4>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={minor} onChange={(e) => setMinor(e.target.checked)} /> Show assignments and unused agents
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">{active ? 'Waiting for the first agent event…' : 'No agent activity was recorded (every phase reused a saved result).'}</p>
      ) : (
        <ol ref={box} aria-label="Agent activity" className="max-h-[26rem] space-y-1 overflow-auto rounded-xl bg-cream-100/70 p-3 text-xs">
          {shown.map((e, i) => (
            <li key={e.id} data-type={e.type} className={cn('grid grid-cols-[3rem_2.5rem_1fr] gap-2 border-l-2 pl-2', SPECIAL[e.type] ?? 'border-transparent', i > 0 && shown[i - 1].code !== e.code && 'mt-2')}>
              <span className="font-mono text-muted">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="font-mono text-muted">{e.code}</span>
              <span className="min-w-0">
                {e.type === 'participant.registered' && <UserPlus className="mr-1 inline h-3 w-3 text-accent" />}
                <span className="font-mono text-[11px] text-muted">{e.type}</span> <strong>{e.participant ?? ''}</strong> <span className="text-ink-700">{e.summary}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const IMAGE_STATUS: Record<string, string> = { generated: 'generated', failed: 'failed', blocked_by_budget: 'stopped by the budget', skipped: 'not requested', planned: 'not requested' };

/**
 * Live image counts of the creative phase, read from the image results the run has recorded so far (never a guess): planned (the
 * target), attempted, generated, failed, stopped by the budget, the latest image, the image model and the spend so far. A
 * one-image-per-concept run (First Test, Demo) records no per-image results, so it shows only what its events do say: planned,
 * generated and failed.
 */
function ImageProgress({ run }: { run: FactoryRunData }) {
  const f4 = run.config.settings?.f4;
  const creative = run.phases.find((p) => p.phase === 'creative');
  if (!f4 || !f4.imageModel || creative?.action !== 'run' || creative.status === 'pending' || creative.status === 'skipped') return null;
  const several = f4.variations;
  const u = run.usage;
  const im = u?.images ?? null;
  // the target: the number of originals asked for (several per concept), else one per concept
  const planned = several ? f4.maxImages : Math.min(f4.maxImages, f4.concepts);
  const n = (v: number | undefined) => (u ? (v ?? 0) : '…');
  const generated = several ? im?.generated : u?.imagesGenerated;
  const failed = several ? im?.failed : u?.imagesFailed;
  const finished = (generated ?? 0) + (failed ?? 0) + (several && im ? im.blocked + im.skipped : 0);
  const cost = u?.cost ?? null;
  const approved = run.config.approvedBudgetUsd ?? null;
  const est = run.config.estimate ?? null;
  // the model the plan resolved before the run started (never the word "auto"), or the one the latest image used
  const model = im?.last?.model ?? (run.config.imageModel && run.config.imageModel !== 'auto' ? run.config.imageModel : f4.imageModel);
  const stat = (k: string, v: React.ReactNode, tone?: string) => (
    <div className="rounded-xl bg-cream-100 px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={cn('text-xl font-semibold', tone)}>{v}</dd>
    </div>
  );
  return (
    <section data-testid="image-progress" aria-label="Original AI images" className="space-y-3 rounded-2xl border border-cream-300/80 bg-cream-50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Original AI images{several ? ' (several per concept)' : ''}</h4>
        <p className="text-xs text-muted">
          Image model <strong className="font-mono">{model === 'auto' ? 'automatic (the first image request names it)' : model}</strong> · quality {f4.imageQuality}
          {several ? ` · ${f4.imageConcurrency} at a time` : ''}
        </p>
      </div>
      <dl className={cn('grid gap-3', several ? 'sm:grid-cols-5' : 'sm:grid-cols-3')}>
        {stat(several ? 'Images planned (target)' : 'Images planned', planned)}
        {several && stat('Attempted', n(im?.attempted))}
        {stat('Generated', n(generated), generated ? 'text-emerald-700' : undefined)}
        {stat('Failed', n(failed), failed ? 'text-red-700' : undefined)}
        {several && stat('Blocked by budget', n(im?.blocked), im?.blocked ? 'text-amber-800' : undefined)}
      </dl>
      {planned > 0 && (
        <div role="progressbar" aria-label="Images with a recorded result" aria-valuemin={0} aria-valuemax={planned} aria-valuenow={Math.min(finished, planned)} className="h-1.5 overflow-hidden rounded-full bg-cream-200">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, (finished / planned) * 100)}%` }} />
        </div>
      )}
      {several && (
        <>
          <p data-testid="image-current" className="text-xs text-muted">
            {im?.last ? (
              <>
                Current: <strong className="text-ink">{im.last.conceptName} — {im.last.variationName}</strong> ({IMAGE_STATUS[im.last.status] ?? im.last.status})
              </>
            ) : isActive(run.status) ? (
              'Current: no image result has been recorded yet.'
            ) : (
              'No image result was recorded.'
            )}
            {im && im.skipped > 0 ? ` · ${im.skipped} not requested` : ''}
          </p>
          <div data-testid="run-cost" className="rounded-xl bg-cream-100 px-4 py-3 text-xs">
            <p>
              <span className="text-muted">Spent so far:</span> <strong className="text-sm">{cost ? (cost.totalUsd === null ? 'unavailable (no verified price for part of it)' : fmtUsd(cost.totalUsd)) : '…'}</strong>
              {approved !== null ? <> of the approved <strong>{fmtUsd(approved)}</strong></> : <span className="text-muted"> (no spending limit was set for this run)</span>}
              {cost ? <span className="text-muted"> · text {cost.textUsd === null ? 'unavailable' : fmtUsd(cost.textUsd)} · images {cost.imageUsd === null ? 'none priced yet' : fmtUsd(cost.imageUsd)}</span> : null}
            </p>
            {approved !== null && cost?.totalUsd != null && (
              <div role="progressbar" aria-label="Spend against the approved limit" aria-valuemin={0} aria-valuemax={approved} aria-valuenow={Math.min(cost.totalUsd, approved)} className="mt-2 h-1.5 overflow-hidden rounded-full bg-cream-200">
                <div className={cn('h-full rounded-full transition-all', cost.totalUsd > approved * 0.8 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, (cost.totalUsd / approved) * 100)}%` }} />
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted">
              {est ? `Estimate shown at the start: typical ${fmtUsd(est.typicalUsd)}, worst case ${fmtUsd(est.maxUsd)} (prices read ${est.priceBookVerifiedAt}). ` : ''}
              {cost?.note ?? ''}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

const BASIS: Record<NonNullable<FactoryUsage['budget']>['remainingBasis'], string> = {
  exact: 'exact: every cost so far is measured',
  estimated: 'estimated: some spend is held, estimated or uncertain',
  unknown: 'unknown: a request finished without a known price',
  uncapped: 'no limit was set',
};

/**
 * The ONE campaign budget of a run: total approved, known spend, estimated spend, what is held for requests in flight, charges that may have
 * been billed (uncertain), what is left and how far that figure can be trusted. The breakdown is informational and never a separate budget;
 * an unknown amount is "unknown", never 0.
 */
function RunBudget({ b, finished, noAi }: { b: NonNullable<FactoryUsage['budget']>; finished: boolean; /** NO AI HYBRID: the image requests and the image cost are exactly zero */ noAi?: boolean }) {
  const cell = (testId: string, k: string, v: React.ReactNode, hint?: React.ReactNode) => (
    <div key={testId} data-testid={testId} className="rounded-lg bg-white/70 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="text-base font-semibold">{v}</dd>
      {hint && <dd className="text-[11px] text-muted">{hint}</dd>}
    </div>
  );
  const remainingTrusted = b.remainingBasis === 'exact' || b.remainingBasis === 'uncapped';
  return (
    <div data-testid="run-budget" data-source={b.source} data-basis={b.remainingBasis} className="space-y-2 rounded-xl bg-cream-100 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Campaign budget (one budget for text, images and reviews)</p>
        <p className="text-[11px] text-muted">{b.source === 'live' ? 'live' : b.source === 'saved' ? 'saved' : 'derived from what the run recorded'}{b.currentPhase && !finished ? ` · phase ${b.currentPhase}` : ''}</p>
      </div>
      <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cell('budget-approved', 'Total approved', b.approvedUsd === null ? 'no limit' : fmtUsd(b.approvedUsd))}
        {cell('budget-known', 'Known spending', usd(b.knownUsd), 'from the usage OpenAI reported')}
        {cell('budget-estimated', 'Estimated spending', usd(b.estimatedUsd), 'finished, usage not reported')}
        {cell('budget-reserved', 'Held now', usd(b.reservedUsd), 'requests in flight')}
        {cell('budget-uncertain', 'Uncertain charges', usd(b.uncertainUsd), 'may have been billed (timeout or cancel)')}
        {cell('budget-remaining', remainingTrusted ? 'Remaining available' : 'Remaining (estimated)', b.remainingUsd === null ? (b.approvedUsd === null ? '—' : 'unknown') : fmtUsd(b.remainingUsd), BASIS[b.remainingBasis])}
      </dl>
      <p data-testid="budget-requests" className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span>Text requests started: <strong>{b.requests.text ?? '—'}</strong></span>
        <span>Image requests started: <strong>{noAi ? 0 : (b.requests.image ?? '—')}</strong>{noAi ? ' (NO AI HYBRID makes none)' : b.requests.imageCap !== null ? ` of at most ${b.requests.imageCap}` : ''}</span>
        <span>Images generated: <strong>{noAi ? 0 : (b.imagesGenerated ?? '—')}</strong></span>
        {b.currentPhase && !finished && <span>Current phase: <strong>{b.currentPhase}</strong></span>}
      </p>
      <p data-testid="budget-breakdown" className="text-muted">
        Where it went (information only, never separate budgets): text agents {usd(b.breakdown.agentsUsd)} · AI images {noAi ? '$0.00 (none are generated)' : usd(b.breakdown.imagesUsd)} · reviews {usd(b.breakdown.reviewsUsd)}.
      </p>
      {b.notes.map((n, i) => (
        <p key={i} className="flex items-start gap-2 text-amber-900">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {n}
        </p>
      ))}
      {b.refusals.length > 0 && (
        <ul data-testid="budget-refusals" className="space-y-1 text-amber-900">
          {b.refusals.map((r, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r}
            </li>
          ))}
        </ul>
      )}
      {b.legacy && (
        <p data-testid="budget-legacy" className="text-muted">
          {b.legacy.note} (historical: text {fmtUsd(b.legacy.textPoolUsd)}, images {fmtUsd(b.legacy.imagePoolUsd)}.)
        </p>
      )}
      <p className="text-[11px] text-muted">An application-side figure from provider-reported usage at published prices, not an OpenAI invoice and not a billing cap. A request that timed out may still be billed.</p>
    </div>
  );
}

/** A known actual cost; null = unknown (no verified price for part of it), never shown as 0. */
const usd = (n: number | null | undefined) => (n === undefined ? '—' : n === null ? 'unknown' : fmtUsd(n));
const tok = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString());

/**
 * What the run really used, read from the usage OpenAI reported: the models, calls and tokens per phase and per agent, the known cost
 * (unknown stays "unknown") and the ONE campaign budget with what is spent, held, uncertain and left. The breakdown only informs.
 */
function RunUsage({ run }: { run: FactoryRunData }) {
  const u = run.usage;
  if (!u) return null;
  const f4 = run.config.settings?.f4;
  // the model the latest image used, else the one the plan resolved before the run started; "auto" is only shown when nothing has named it yet
  const concrete = (m: string | null | undefined) => (m && m !== 'auto' ? m : null);
  const imageModel = u.images?.last?.model ?? concrete(run.config.imageModel) ?? concrete(f4?.imageModel);
  const creativeRuns = run.phases.find((p) => p.phase === 'creative')?.action === 'run';
  const noAi = run.config.preset === 'no_ai_hybrid';
  const imageLabel = noAi ? 'none (NO AI HYBRID)' : !creativeRuns ? 'not used (F4 reused)' : !(run.config.imageModel || f4?.imageModel) ? 'none' : (imageModel ?? 'automatic (the first image request names it)');
  const rows = run.phases.filter((p) => !!u.byPhase[p.phase]);
  const agents = [...(u.agents ?? [])].sort((a, b) => run.phases.findIndex((p) => p.phase === a.phase) - run.phases.findIndex((p) => p.phase === b.phase) || b.calls - a.calls);
  const code = (phase: string) => run.phases.find((p) => p.phase === phase)?.code ?? phase;
  const b = u.budget;
  const finished = !isActive(run.status);
  return (
    <section data-testid="run-usage" aria-label="Models and usage" className="space-y-3 rounded-2xl border border-cream-300/80 bg-cream-50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Models and usage (read from what OpenAI reported)</h4>
        <p className="text-xs text-muted">
          Text model <strong className="font-mono text-ink">{run.config.textModel ?? 'none'}</strong> · image model{' '}
          <strong className="font-mono text-ink">{imageLabel}</strong>
          {creativeRuns && f4?.imageModel ? ` · quality ${f4.imageQuality}` : ''}
        </p>
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table data-testid="usage-by-phase" className="w-full min-w-[30rem] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Phase</th>
                <th className="py-1 pr-3 font-medium">Text calls</th>
                <th className="py-1 pr-3 font-medium">Input tokens</th>
                <th className="py-1 pr-3 font-medium">Output tokens</th>
                <th className="py-1 font-medium">Known cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const v = u.byPhase[p.phase]!;
                return (
                  <tr key={p.phase} data-phase={p.phase} className="border-t border-cream-300/70">
                    <td className="py-1 pr-3">
                      {p.code} {p.title}
                    </td>
                    <td className="py-1 pr-3">{v.textCalls}</td>
                    <td className="py-1 pr-3">{tok(v.inputTokens)}</td>
                    <td className="py-1 pr-3">{tok(v.outputTokens)}</td>
                    <td className="py-1">{usd(v.usd)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-cream-300 font-semibold">
                <td className="py-1 pr-3">Text total</td>
                <td className="py-1 pr-3">{u.textCalls}</td>
                <td className="py-1 pr-3">{u.inputTokens.toLocaleString()}</td>
                <td className="py-1 pr-3">{u.outputTokens.toLocaleString()}</td>
                <td className="py-1">{usd(u.cost?.textUsd)}</td>
              </tr>
              {(u.imagesGenerated > 0 || u.imagesFailed > 0) && (
                <tr className="border-t border-cream-300/70">
                  <td className="py-1 pr-3">AI images</td>
                  <td className="py-1 pr-3" colSpan={3}>
                    {u.imagesGenerated} generated{u.imagesFailed ? `, ${u.imagesFailed} failed` : ''}
                  </td>
                  <td className="py-1">{u.cost ? (u.cost.imageUsd === null && u.imagesGenerated > 0 ? 'unknown' : usd(u.cost.imageUsd ?? 0)) : '—'}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
      {agents.length > 0 && (
        <details data-testid="usage-by-agent" className="text-xs">
          <summary className="cursor-pointer select-none text-muted hover:text-ink">Calls and tokens by agent ({agents.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Phase</th>
                  <th className="py-1 pr-3 font-medium">Agent</th>
                  <th className="py-1 pr-3 font-medium">Calls</th>
                  <th className="py-1 pr-3 font-medium">Input tokens</th>
                  <th className="py-1 pr-3 font-medium">Output tokens</th>
                  <th className="py-1 font-medium">Known cost</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={`${a.phase}|${a.agent}`} data-agent={a.agent} className="border-t border-cream-300/70">
                    <td className="py-1 pr-3 font-mono">{code(a.phase)}</td>
                    <td className="py-1 pr-3">{a.agent}</td>
                    <td className="py-1 pr-3">{a.calls}</td>
                    <td className="py-1 pr-3">{a.inputTokens.toLocaleString()}</td>
                    <td className="py-1 pr-3">{a.outputTokens.toLocaleString()}</td>
                    <td className="py-1">{usd(a.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-muted">Agents that made no model call (tools, local layouts) do not appear. “unknown” means the text model has no verified price, so no dollar figure is invented.</p>
          </div>
        </details>
      )}
      {b && <RunBudget b={b} finished={finished} noAi={noAi} />}
    </section>
  );
}

export function FactoryRunView({ projectId, run, onContinue }: { projectId: string; run: FactoryRunData; onContinue?: () => void }) {
  const toast = useToast();
  const events = useFactoryEvents(run.id, run.status);
  const cancel = useCancelFactory(projectId);
  const active = isActive(run.status);
  const now = useNow(active);
  const elapsed = run.startedAt ? fmtDuration((run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.startedAt)) : '—';
  const u = run.usage;
  const done = run.phases.filter((p) => p.status === 'completed' || p.status === 'reused').length;
  const stat = (k: string, v: React.ReactNode, hint?: string) => (
    <div className="rounded-xl bg-cream-100 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
      <p className="text-lg font-semibold">{v}</p>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
  return (
    <div data-testid="factory-run" data-status={run.status} className="space-y-5">
      <OutcomeBanner run={run} />
      {run.failure && <FailureCard failure={run.failure} onContinue={onContinue} />}
      <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {stat('Status', run.status)}
        {stat('Phases saved', `${done} of 4`, `${run.phases.filter((p) => p.status === 'reused').length} reused`)}
        {stat('Started', run.startedAt ? new Date(run.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'queued')}
        {stat('Elapsed', elapsed)}
        {stat('Text-model calls', u ? u.textCalls : '…', u ? `${u.totalTokens.toLocaleString()} tokens` : undefined)}
        {run.config.preset === 'no_ai_hybrid' ? stat('AI images', 0, 'NO AI HYBRID never generates any') : stat('AI images', u ? u.imagesGenerated : '…', u && u.imagesFailed ? `${u.imagesFailed} failed (brand background used)` : undefined)}
      </div>
      {run.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-900">
          {run.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <ImageProgress run={run} />
      <RunUsage run={run} />
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Phases">
        {run.phases.map((p) => (
          <PhaseCard key={p.phase} p={p} projectId={projectId} current={run.currentPhase === p.phase} restatedNote={run.failure?.restated && run.failure.phase?.code === p.code ? run.failure.restated.phaseNote : undefined} />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {active && (
          <Button variant="danger" loading={cancel.isPending} onClick={() => window.confirm('Cancel the campaign run? The active phase is stopped and later phases are not started. Paid calls already made stay billed; saved results are kept.') && cancel.mutate(run.id, { onError: (e) => toast.error(e.message) })}>
            <Square className="h-3.5 w-3.5" /> Cancel campaign
          </Button>
        )}
        {run.campaignId && (
          <>
            <Button asChild variant="outline">
              <a href="#campaign-outputs">Open final campaign</a>
            </Button>
            <Button asChild>
              <a href={`/api/campaigns/${run.campaignId}/export`} download>
                <Download className="h-4 w-4" /> Download ZIP
              </a>
            </Button>
          </>
        )}
        <Button asChild variant="ghost">
          <Link href={`/projects/${projectId}/workspace`}>View phase reports in the workspace</Link>
        </Button>
        {u && Object.keys(u.byPhase).length > 0 && (
          <span className="text-xs text-muted">
            Calls by phase: {Object.entries(u.byPhase).map(([k, v]) => `${run.phases.find((p) => p.phase === k)?.code} ${v?.textCalls}`).join(' · ')}
          </span>
        )}
      </div>
      <ActivityFeed items={events.data?.items ?? []} active={active} />
    </div>
  );
}
