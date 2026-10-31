'use client';

import Link from 'next/link';
import * as React from 'react';
import { AlertCircle, Check, CircleDashed, ClipboardCheck, Download, Loader2, MinusCircle, OctagonX, Play, Recycle, Settings2, Square, UserPlus, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useCancelFactory, useFactoryEvents, useFactoryPresets, useFactoryPreflight, useOpenAiModels, useOpenAiStatus, useStartFactory } from '@/lib/hooks';
import type { ChannelId, FactoryActivityItem, FactoryOutcome, FactoryPhaseData, FactoryPhaseStatus, FactoryPlan, FactoryPlanPhase, FactoryPresetId, FactoryRunData, StartFactoryInput } from '@/lib/types';
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

export function CampaignSetup({ projectId, onStarted }: { projectId: string; onStarted: (run: FactoryRunData) => void }) {
  const toast = useToast();
  const presets = useFactoryPresets();
  const openai = useOpenAiStatus();
  const models = useOpenAiModels();
  const preflight = useFactoryPreflight(projectId);
  const start = useStartFactory(projectId);

  const [preset, setPreset] = React.useState<FactoryPresetId>('first_test');
  const [mode, setMode] = React.useState<'continue' | 'fresh'>('continue');
  const [rerunCreative, setRerunCreative] = React.useState(false);
  const [reusePartial, setReusePartial] = React.useState(true);
  const [ov, setOv] = React.useState<Required<Pick<StartFactoryInput, 'f1' | 'f2' | 'f3' | 'f4'>>>({ f1: {}, f2: {}, f3: {}, f4: {} });
  const [plan, setPlan] = React.useState<{ key: string; data: FactoryPlan } | null>(null);

  React.useEffect(() => {
    if (openai.data?.configured && models.data === undefined && !models.isFetching) void models.refetch();
  }, [openai.data?.configured, models]);

  const base = presets.data?.presets[preset];
  const eff = base && { f1: { ...base.f1, ...ov.f1 }, f2: { ...base.f2, ...ov.f2 }, f3: { ...base.f3, ...ov.f3 }, f4: { ...base.f4, ...ov.f4 } };
  const imageModels = (models.data?.models ?? []).filter((m) => m.imageSupported);
  const imageOptions = imageModels.map((m) => m.id);
  const patch = <K extends 'f1' | 'f2' | 'f3' | 'f4'>(k: K, v: NonNullable<StartFactoryInput[K]>) => setOv((o) => ({ ...o, [k]: { ...o[k], ...v } }));

  const body: StartFactoryInput = { preset, mode, reusePartial, ...(mode === 'continue' && rerunCreative ? { rerunCreative: true } : {}), f1: ov.f1, f2: ov.f2, f3: ov.f3, f4: ov.f4 };
  const key = JSON.stringify(body);
  const valid = plan?.key === key ? plan.data : null;
  const channels = eff?.f4.channels ?? null;

  const run = valid?.phases.filter((p) => p.action === 'run').map((p) => p.code) ?? [];
  const label = !valid ? 'Start campaign' : valid.totals.phasesReused === 0 ? 'Start campaign (F1 → F4)' : `Continue campaign — ${run.join(' and ')} remaining`;
  const canStart = !!valid && valid.ok && !valid.nothingToRun && !start.isPending;

  function review() {
    preflight.mutate(body, { onSuccess: (data) => setPlan({ key, data }), onError: (e) => toast.error(e.message) });
  }
  function begin() {
    if (!valid) return;
    const t = valid.totals;
    const text = [
      `${label}?`,
      '',
      `This uses YOUR OpenAI API credits (text model "${valid.models.text.id}"${valid.models.image ? `, image model "${valid.models.image.id}" at quality "${valid.models.image.quality}"` : ', no image model'}):`,
      `• phases that will run: ${valid.phases.filter((p) => p.action === 'run').map((p) => p.code).join(', ')}; reused saved results: ${valid.phases.filter((p) => p.action === 'reuse').map((p) => p.code).join(', ') || 'none'}`,
      `• at most ${t.textCallCap} text-model calls in total (hard limits per phase)`,
      `• ${t.imageRequests} image request(s)${t.imageRegenerationCap ? ` plus up to ${t.imageRegenerationCap} regeneration(s)` : ', regeneration off'}`,
      `• ${t.layouts} channel layouts rendered locally (no cost)`,
      '',
      'The limits are enforced by LaunchPilot and are NOT an OpenAI spending cap. A failed phase stops the run and is never retried automatically.',
    ].join('\n');
    if (!window.confirm(text)) return;
    start.mutate(body, { onSuccess: onStarted, onError: (e) => toast.error(e.message) });
  }

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
            {(['first_test', 'demo'] as const).map((p) => (
              <label key={p} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="preset" checked={preset === p} onChange={() => { setPreset(p); setOv({ f1: {}, f2: {}, f3: {}, f4: {} }); }} className="mt-1" />
                <span>
                  <strong>{p === 'first_test' ? 'First test (lowest cost)' : 'Demo quality'}</strong>
                  <span className="block text-xs text-muted">{p === 'first_test' ? '1 concept, Instagram only, 1 low-quality image, landing page, regeneration and vision review off, F3 up to 14 calls / 3 scouts.' : '3 concepts, strategy-recommended channels, medium-quality images, 2 vision reviews. Costlier; never preselected.'}</span>
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

        <details className="mt-4 text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 text-muted hover:text-ink">
            <Settings2 className="h-3.5 w-3.5" /> Limits and creative settings (enforced per phase)
          </summary>
          <div className="mt-4 space-y-5">
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
                <label className="space-y-1 text-xs text-muted">
                  Image model
                  <select aria-label="Image model" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={eff.f4.imageModel ?? ''} onChange={(e) => patch('f4', { imageModel: e.target.value || null })}>
                    <option value="auto">Automatic: a current model your key lists</option>
                    <option value="">None (brand-colored backgrounds)</option>
                    {eff.f4.imageModel && eff.f4.imageModel !== 'auto' && !imageOptions.includes(eff.f4.imageModel) && <option value={eff.f4.imageModel}>{eff.f4.imageModel} (not listed for your key)</option>}
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
                  Image quality
                  <select aria-label="Image quality" className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={eff.f4.imageQuality} disabled={!eff.f4.imageModel} onChange={(e) => patch('f4', { imageQuality: e.target.value as 'low' })}>
                    <option value="low">low (cheapest)</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="auto">auto</option>
                  </select>
                </label>
                <Num label="Creative concepts" min={1} max={5} value={eff.f4.concepts} onChange={(n) => patch('f4', { concepts: n, maxImages: Math.min(eff.f4.maxImages, n) })} />
                <Num label="Original AI images" min={0} max={eff.f4.concepts} value={Math.min(eff.f4.maxImages, eff.f4.concepts)} onChange={(n) => patch('f4', { maxImages: n })} hint={eff.f4.imageModel ? undefined : 'No image model: 0'} />
                <Num label="Max text-model calls" min={4} max={40} value={eff.f4.maxModelCalls} onChange={(n) => patch('f4', { maxModelCalls: n })} />
                <Num label="Repair rounds" min={0} max={3} value={eff.f4.maxRepairRounds} onChange={(n) => patch('f4', { maxRepairRounds: n })} />
                <Num label="Assets the reviewer may look at" min={0} max={6} value={eff.f4.visionReviews} onChange={(n) => patch('f4', { visionReviews: n })} hint="Vision review; 0 = off" />
                <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                  <input type="checkbox" checked={eff.f4.landing} onChange={(e) => patch('f4', { landing: e.target.checked })} /> Landing page content
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
                <span>Channels {channels ? '' : '(the strategy’s recommended ones, up to 4)'}:</span>
                {ALL_CHANNELS.map((c) => (
                  <label key={c.id} className="flex items-center gap-1">
                    <input type="checkbox" checked={!!channels?.includes(c.id)} onChange={() => toggleChannel(c.id)} /> {c.label}
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={eff.f4.maxRegenerations > 0} disabled={!eff.f4.imageModel} onChange={(e) => patch('f4', { maxRegenerations: e.target.checked ? 1 : 0 })} /> Allow image regeneration (each extra image is billed)
                </label>
                {eff.f4.maxRegenerations > 0 && <Num label="Max regenerations" min={1} max={5} value={eff.f4.maxRegenerations} onChange={(n) => patch('f4', { maxRegenerations: n })} />}
              </div>
            </div>
            <p className="max-w-3xl text-xs text-muted">These limits are enforced by LaunchPilot for each phase. They are not an OpenAI spending cap, no price is shown, and a failed phase is never retried automatically.</p>
          </div>
        </details>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={review} loading={preflight.isPending}>
            <ClipboardCheck className="h-4 w-4" /> Review plan (free)
          </Button>
          <Button onClick={begin} disabled={!canStart} loading={start.isPending} title={valid ? (valid.nothingToRun ? 'Every phase already has a saved result' : '') : 'Review the plan first; it shows exactly what will run and what it can cost'}>
            <Play className="h-4 w-4" /> {label}
          </Button>
          {!valid && <span className="text-xs text-muted">Nothing runs until you review the plan and confirm.</span>}
          {valid?.nothingToRun && <span className="text-xs text-muted">Every phase already has a saved result for this chain. Choose “Run every phase again”, or tick “new creative round”.</span>}
        </div>
      </div>

      {valid && <PlanCard plan={valid} />}
    </div>
  );
}

const num = (n: unknown) => (typeof n === 'number' ? n : 0);

function limitsText(p: FactoryPlanPhase): string {
  const l = (p.limits ?? {}) as Record<string, any>;
  const e = p.expected;
  if (p.phase === 'discovery' || p.phase === 'audit') return `up to ${l.maxModelCalls} model calls · up to ${l.maxReviews} cross-checks`;
  if (p.phase === 'strategy') return `up to ${l.maxModelCalls} model calls (typically about ${e?.textCalls?.typical ?? '?'}) · up to ${l.maxScouts} Channel Scouts created at run time · up to ${l.maxReviews} cross-checks · seasonal calendar ${l.useHolidayCalendar ? 'on' : 'off'}`;
  const ch = Array.isArray(l.channels) ? l.channels.join(', ') : 'the strategy’s recommended channels';
  return [
    `${l.concepts} concept(s) for ${ch}`,
    l.landing ? 'landing page' : 'no landing page',
    l.imageModel ? `${num(e?.imageRequests?.planned)} original image(s) with ${l.imageModel} (${l.imageQuality})` : 'no AI image (brand-colored backgrounds)',
    l.maxRegenerations > 0 ? `regeneration up to ${l.maxRegenerations}` : 'regeneration off',
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
      {p.enabled ? (
        <p className="mt-1">
          {p.conceptsRequested} concept(s) requested · {p.originalImagesPermitted} original AI image(s) permitted by the limit · {p.plannedRequests} image request(s) planned
          {p.regenerationCap ? ` (+ up to ${p.regenerationCap} regeneration)` : ''}
          {p.budgetLimitedConcepts > 0 ? ` · ${p.budgetLimitedConcepts} concept(s) will use a brand-colored background, NOT an AI image, because of the limit` : ''}.
        </p>
      ) : (
        <p className="mt-1">No image model: every concept uses a brand-colored background and no AI image is generated.</p>
      )}
    </div>
  );
}

export function PlanCard({ plan }: { plan: FactoryPlan }) {
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
              <p className="mt-1 text-xs text-muted">{limitsText(p)}</p>
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
        Text model <strong className="font-mono">{plan.models.text.id ?? 'none selected'}</strong> ({plan.models.text.source === 'saved' ? 'saved in Settings' : 'chosen here'})
        {plan.models.image ? (
          <>
            {' '}
            · image model <strong className="font-mono">{plan.models.image.id ?? 'none usable'}</strong>
            {plan.models.image.mode === 'auto' ? ' (chosen automatically)' : ''} ({plan.models.image.quality}): {plan.models.image.note}
          </>
        ) : (
          ' · no image model for this run.'
        )}
      </p>
      {plan.imagePlan && <ImagePlan p={plan.imagePlan} />}
      {plan.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-900">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <p className="rounded-xl bg-cream-100 px-4 py-2.5 text-xs text-ink-600">
        These limits are enforced by LaunchPilot for each phase and are <strong>not an OpenAI spending cap</strong>. No dollar estimate is shown because LaunchPilot does not know your pricing; text usage is measured in tokens and every image is billed by OpenAI.
      </p>
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
        {run.errorMessage && run.outcome !== 'approved' && <p className="mt-1 text-sm">{run.errorMessage}</p>}
      </div>
    </div>
  );
}

function PhaseCard({ p, projectId, current }: { p: FactoryPhaseData; projectId: string; current: boolean }) {
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
      {p.error && <p role="alert" className="mt-1 text-xs text-red-700">{p.error}</p>}
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

export function FactoryRunView({ projectId, run }: { projectId: string; run: FactoryRunData }) {
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
      <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {stat('Status', run.status)}
        {stat('Phases saved', `${done} of 4`, `${run.phases.filter((p) => p.status === 'reused').length} reused`)}
        {stat('Started', run.startedAt ? new Date(run.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'queued')}
        {stat('Elapsed', elapsed)}
        {stat('Text-model calls', u ? u.textCalls : '…', u ? `${u.totalTokens.toLocaleString()} tokens` : undefined)}
        {stat('AI images', u ? u.imagesGenerated : '…', u && u.imagesFailed ? `${u.imagesFailed} failed (brand background used)` : undefined)}
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
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Phases">
        {run.phases.map((p) => (
          <PhaseCard key={p.phase} p={p} projectId={projectId} current={run.currentPhase === p.phase} />
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
