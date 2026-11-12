'use client';

import Link from 'next/link';
import * as React from 'react';
import { AlertCircle, Check, ClipboardCheck, ImageOff, Play, Recycle, Settings2 } from 'lucide-react';
import { CampaignDesign } from '@/components/campaign-design';
import { InputReadinessCard } from '@/components/input-readiness';
import { StartChecklist, type ChecklistItem } from '@/components/start-checklist';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { KIND_LABEL, PLATFORM_LABEL, SOCIAL_PLATFORMS, VOICE_TONES, VOICE_TONE_LABEL, useCampaignPreflight, type CampaignPlanData, type CampaignVoiceInput, type SocialPlatform, type StartCampaignInput, type VoiceTone } from '@/lib/campaign';
import { MARKETING_GOALS } from '@/lib/constants';
import { useProject, useStartFactory } from '@/lib/hooks';
import type { HybridFactsInput } from '@/lib/hybrid';
import type { FactoryRunData } from '@/lib/types';
import type { CampaignDesignData, CollectionId } from '@/lib/visual';
import { cn, fmtUsd } from '@/lib/utils';

/*
 * "GENERATE CAMPAIGN": the one user journey. Objective and audience (prefilled from the project), the social platforms, the number of concepts,
 * optional research hints, the campaign design (collection, palette, pictures; Get Content is optional inside it), then the FREE plan and ONE
 * budget. There is no preset, no mode, no image model and no per-campaign text model: the provider and model are the defaults saved under
 * Settings > AI providers. Nothing here spends money until "Generate campaign" is pressed after the plan and the budget were approved.
 */

const FACT_FIELDS: { key: keyof HybridFactsInput; label: string; max: number; placeholder: string }[] = [
  { key: 'offer', label: 'Offer', max: 20, placeholder: '20% off' },
  { key: 'offerDetail', label: 'Offer detail', max: 60, placeholder: 'on all summer courses' },
  { key: 'date', label: 'Date', max: 30, placeholder: '14 June 2027' },
  { key: 'location', label: 'Location', max: 40, placeholder: 'Novi Sad' },
  { key: 'quote', label: 'Customer quote', max: 160, placeholder: 'The best course I ever took.' },
  { key: 'attribution', label: 'Quote by', max: 60, placeholder: 'Ana, student' },
  { key: 'stat', label: 'Statistic', max: 12, placeholder: '1,200+' },
  { key: 'statLabel', label: 'Statistic label', max: 50, placeholder: 'divers trained' },
  { key: 'tag', label: 'Tag', max: 30, placeholder: 'New season' },
];

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-cream-300/80 bg-cream-50 p-5">
      <header>
        <h3 className="text-lg">
          <span className="mr-2 font-mono text-sm text-muted">{n}</span>
          {title}
        </h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

const parseBudget = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0.01 && n <= 500 && Math.round(n * 100) === n * 100 ? n : null;
};

export function CampaignSetup({ projectId, initialCollection, onStarted }: { projectId: string; initialCollection?: CollectionId | null; onStarted: (run: FactoryRunData) => void }) {
  const toast = useToast();
  const project = useProject(projectId);
  const intake = project.data?.intake ?? null;
  const preflight = useCampaignPreflight(projectId);
  const start = useStartFactory(projectId);

  const [objective, setObjective] = React.useState('');
  const [audience, setAudience] = React.useState('');
  const [prefilled, setPrefilled] = React.useState(false);
  const [channels, setChannels] = React.useState<SocialPlatform[]>([...SOCIAL_PLATFORMS]);
  const [concepts, setConcepts] = React.useState(3);
  const [competitors, setCompetitors] = React.useState('');
  const [holidays, setHolidays] = React.useState<boolean | null>(null);
  const [refreshResearch, setRefreshResearch] = React.useState(false);
  const [tone, setTone] = React.useState<VoiceTone | ''>('');
  const [humor, setHumor] = React.useState<'auto' | 'on' | 'off'>('auto');
  const [avoid, setAvoid] = React.useState('');
  const [design, setDesign] = React.useState<CampaignDesignData | null>(null);
  const [facts, setFacts] = React.useState<HybridFactsInput>({});
  const [plan, setPlan] = React.useState<CampaignPlanData | null>(null);
  const [planKey, setPlanKey] = React.useState('');
  const [budget, setBudget] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);

  // the project's own information is the default (editable here, used only for this campaign)
  React.useEffect(() => {
    if (prefilled || !project.data) return;
    setPrefilled(true);
    const goal = intake?.marketingGoal ?? '';
    setObjective(MARKETING_GOALS.find((g) => g.value === goal)?.label ?? goal);
    setAudience(intake?.targetAudience ?? '');
  }, [project.data, intake, prefilled]);

  const competitorUrls = competitors
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 5);
  const badUrl = competitorUrls.find((u) => !/^https?:\/\/[^\s]+\.[^\s]+/.test(u));
  const useHolidays = holidays ?? intake?.enableSeasonalCalendar ?? false;
  const avoidList = avoid.split(/[,\n]/).map((w) => w.trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  const voice: CampaignVoiceInput | null = tone || humor !== 'auto' || avoidList.length ? { ...(tone ? { tone } : {}), ...(humor !== 'auto' ? { humor: humor === 'on' } : {}), ...(avoidList.length ? { avoid: avoidList } : {}) } : null;
  const body: StartCampaignInput = {
    ...(objective.trim() ? { objective: objective.trim().slice(0, 300) } : {}),
    ...(audience.trim() ? { targetAudience: audience.trim().slice(0, 300) } : {}),
    channels,
    concepts,
    competitorUrls,
    useHolidayCalendar: useHolidays,
    refreshResearch,
    ...(voice ? { voice } : {}),
    design: { design: design ? { ...design, formats: [] } : null, facts, imagery: { autoStock: design?.autoStock === true } },
  };
  const key = JSON.stringify(body);
  const stale = !!plan && planKey !== key;
  const approved = parseBudget(budget);

  function review() {
    if (badUrl) return toast.error(`"${badUrl}" is not a web address (https://...).`);
    preflight.mutate(body, {
      onSuccess: (p) => {
        setPlan(p);
        setPlanKey(key);
        setConfirmed(false);
        if (!budget && p.budget.suggestedUsd) setBudget(p.budget.suggestedUsd.toFixed(2));
        setTimeout(() => document.getElementById('campaign-plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      },
      onError: (e) => toast.error(e.message),
    });
  }

  function generate() {
    if (!plan || !approved) return;
    start.mutate({ ...body, approvedBudgetUsd: approved, confirmCost: true }, { onSuccess: (r) => onStarted(r), onError: (e) => toast.error(e.message) });
  }

  const typical = plan?.cost.totals.typicalUsd ?? null;
  const below = approved !== null && typical !== null && approved < typical;
  const checklist: ChecklistItem[] = [
    { id: 'channels', label: 'At least one social platform is selected', done: channels.length > 0 },
    { id: 'design', label: 'The campaign design is confirmed', done: !!design?.confirmed, hint: 'Choose a template collection, review the palette and press "Use this design for the campaign".' },
    { id: 'plan', label: 'The plan was reviewed for exactly these settings', done: !!plan && !stale, hint: 'Press "Review plan and cost" (free).' },
    { id: 'blockers', label: 'The plan has no blocker', done: !!plan && !stale && plan.blockers.length === 0, hint: plan?.blockers[0]?.message },
    { id: 'budget', label: 'One campaign budget is approved', done: approved !== null && !below && confirmed, hint: below ? `The budget is below the typical estimate (${fmtUsd(typical)}).` : 'Enter the budget and confirm it.' },
  ];
  const canStart = checklist.every((c) => c.done);

  return (
    <div data-testid="campaign-setup" className="space-y-5">
      <Section n={1} title="Campaign brief" hint="Prefilled from your project. Change it for this campaign only.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign objective" htmlFor="objective" hint="What should this campaign achieve?">
            <Textarea id="objective" rows={2} maxLength={300} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="More sign-ups for the summer course" />
          </Field>
          <Field label="Target audience" htmlFor="audience" hint="Who should it speak to?">
            <Textarea id="audience" rows={2} maxLength={300} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Beginners aged 20-40 in Novi Sad" />
          </Field>
        </div>
        <div data-testid="voice-settings" className="mt-4 grid gap-4 md:grid-cols-3">
          <Field label="Writing style" htmlFor="voice-tone" hint="Automatic reads the brand voice from your project and strategy.">
            <Select id="voice-tone" value={tone} onChange={(e) => setTone(e.target.value as VoiceTone | '')}>
              <option value="">Automatic</option>
              {VOICE_TONES.map((t) => (
                <option key={t} value={t}>
                  {VOICE_TONE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Humor" htmlFor="voice-humor" hint="Never used in regulated industries.">
            <Select id="voice-humor" value={humor} onChange={(e) => setHumor(e.target.value as 'auto' | 'on' | 'off')}>
              <option value="auto">Automatic</option>
              <option value="on">Light humor where it fits</option>
              <option value="off">No humor</option>
            </Select>
          </Field>
          <Field label="Words or claims to avoid" htmlFor="voice-avoid" hint="Comma-separated. Never used in any copy.">
            <Input id="voice-avoid" maxLength={600} value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder="cheap, guaranteed, revolutionary" />
          </Field>
        </div>
      </Section>

      <Section n={2} title="Channels and concepts" hint="Every selected platform gets its own post text and visuals. Web/display ads, a billboard and a flyer are always part of the package (when the collection can draw them).">
        <div data-testid="channel-picker" className="flex flex-wrap gap-2">
          {SOCIAL_PLATFORMS.map((c) => {
            const on = channels.includes(c);
            return (
              <button key={c} type="button" aria-pressed={on} data-testid={`channel-${c}`} onClick={() => setChannels(on ? channels.filter((x) => x !== c) : [...channels, c])} className={cn('rounded-full border px-3 py-1.5 text-sm', on ? 'border-accent bg-accent-soft/50 font-medium text-ink' : 'border-cream-300 bg-white text-muted hover:text-ink')}>
                {on && <Check className="mr-1 inline h-3.5 w-3.5" />}
                {PLATFORM_LABEL[c]}
              </button>
            );
          })}
        </div>
        <Field label="Campaign concepts" htmlFor="concepts" hint="Each concept is a distinct creative idea built on the strategy (1 to 5).">
          <Input id="concepts" type="number" min={1} max={5} className="w-24" value={concepts} onChange={(e) => setConcepts(Math.max(1, Math.min(5, Math.round(Number(e.target.value) || 1))))} />
        </Field>
      </Section>

      <Section n={3} title="Research hints (optional)" hint="Business Research reads your intake, website, repository and uploads. These only add to it.">
        <Field label="Competitor websites" htmlFor="competitors" optional hint="Up to 5 addresses, separated by spaces or new lines. Nothing is invented when you leave this empty." error={badUrl ? `"${badUrl}" is not a web address.` : undefined}>
          <Textarea id="competitors" rows={2} value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="https://competitor.example" />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={useHolidays} onChange={(e) => setHolidays(e.target.checked)} />
          <span>
            Use the public-holiday calendar <span className="block text-xs text-muted">A free service; without it seasonal statements are labelled hypotheses.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={refreshResearch} onChange={(e) => setRefreshResearch(e.target.checked)} />
          <span>
            Run Business Research again <span className="block text-xs text-muted">Normally the project&apos;s current research is reused (no cost). It runs again automatically when your project information changed.</span>
          </span>
        </label>
      </Section>

      <Section n={4} title="Design: template collection, palette and pictures" hint="Get Content (optional) finds your logo, photographs and brand colors. Pictures are used only when approved or licensed; nothing is ever generated by AI.">
        <CampaignDesign projectId={projectId} design={design} onChange={setDesign} initialCollection={initialCollection ?? null} />
        <details className="rounded-xl border border-cream-300/80 bg-white/60 px-4 py-3 text-sm">
          <summary className="cursor-pointer select-none font-medium">Details only you can provide (optional)</summary>
          <p className="mt-1 text-xs text-muted">Templates that show an offer, a date, a quote or a statistic are used only when you give it here: nothing is invented.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FACT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`fact-${f.key}`}>
                <Input id={`fact-${f.key}`} maxLength={f.max} placeholder={f.placeholder} value={facts[f.key] ?? ''} onChange={(e) => setFacts({ ...facts, [f.key]: e.target.value || undefined })} />
              </Field>
            ))}
          </div>
        </details>
      </Section>

      <Section n={5} title="Review the plan and the budget" hint="Free: nothing is sent to any AI provider.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" data-testid="review-plan" loading={preflight.isPending} onClick={review}>
            <ClipboardCheck className="h-4 w-4" /> {plan ? 'Review the plan again' : 'Review plan and cost'}
          </Button>
          {stale && <span className="text-xs text-amber-900">The settings changed since the last review: review the plan again.</span>}
        </div>
        {plan && <PlanReview plan={plan} />}
        {plan && (
          <div data-testid="campaign-budget" className="space-y-3 rounded-xl border border-cream-300 bg-white/70 p-4">
            <p className="text-sm font-semibold">One campaign budget</p>
            <p className="text-xs text-muted">Every paid request of the campaign (all text-model calls of all stages) draws on this one amount. LaunchPilot refuses, before sending, any request that would exceed it. It is not a provider billing cap.</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Approved budget (US dollars)" htmlFor="budget">
                <Input id="budget" inputMode="decimal" className="w-36" value={budget} onChange={(e) => { setBudget(e.target.value); setConfirmed(false); }} />
              </Field>
              <p className="pb-2 text-xs text-muted">
                Typical {fmtUsd(plan.cost.totals.typicalUsd)} · worst case {fmtUsd(plan.cost.totals.maxUsd)}
                {plan.budget.suggestedUsd ? ` · suggested ${fmtUsd(plan.budget.suggestedUsd)}` : ''}
              </p>
            </div>
            {below && <p className="text-xs text-red-700">The approved amount is below the typical estimate: the campaign could not finish.</p>}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" data-testid="confirm-cost" className="mt-1" checked={confirmed} disabled={approved === null} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I reviewed the estimate and approve up to {approved !== null ? fmtUsd(approved) : '…'} for this campaign on my {plan.provider.name} key.</span>
            </label>
          </div>
        )}
        <StartChecklist items={checklist} />
        <Button size="lg" data-testid="generate-campaign" disabled={!canStart} loading={start.isPending} onClick={generate}>
          <Play className="h-4 w-4" /> Generate campaign
        </Button>
      </Section>
    </div>
  );
}

/** The free plan: provider, stages, deliverables, pictures, warnings and the cost estimate. */
export function PlanReview({ plan }: { plan: CampaignPlanData }) {
  const d = plan.deliverables;
  const byKind = d.slots.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind ?? 'social_post']: (m[s.kind ?? 'social_post'] ?? 0) + 1 }), {});
  const im = plan.imagery;
  return (
    <div id="campaign-plan" data-testid="campaign-plan" className="scroll-mt-6 space-y-4">
      {plan.blockers.length > 0 && (
        <ul data-testid="plan-blockers" className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {plan.blockers.map((b) => (
            <li key={b.code + b.message} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {b.message}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-cream-100 px-4 py-3 text-sm">
          <p className="text-[11px] uppercase tracking-wider text-muted">AI provider (from Settings)</p>
          <p className="font-semibold">{plan.provider.name}</p>
          <p className="font-mono text-xs">{plan.provider.model ?? 'no model saved'}</p>
          <Link href="/settings/providers" className="mt-1 inline-flex items-center gap-1 text-xs text-accent-hover hover:underline">
            <Settings2 className="h-3 w-3" /> Change in Settings › AI providers
          </Link>
        </div>
        <div className="rounded-xl bg-cream-100 px-4 py-3 text-sm">
          <p className="text-[11px] uppercase tracking-wider text-muted">Stages</p>
          <ul className="mt-1 space-y-0.5">
            {plan.phases.map((p) => (
              <li key={p.phase} data-phase={p.phase} data-action={p.action} className="flex items-center gap-2">
                {p.action === 'reuse' ? <Recycle className="h-3.5 w-3.5 text-sky-700" /> : <Play className="h-3.5 w-3.5 text-accent" />}
                {p.title}
                <span className="text-xs text-muted">{p.action === 'reuse' && p.reuse ? `reused (${new Date(p.reuse.createdAt).toLocaleDateString()})` : 'runs'}</span>
              </li>
            ))}
          </ul>
        </div>
        <div data-testid="no-ai-statement" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="flex items-center gap-2 font-semibold">
            <ImageOff className="h-4 w-4" /> AI-generated images: 0
          </p>
          <p className="mt-1 text-xs">{plan.statement.imagery}</p>
          <p className="mt-1 text-xs">{plan.statement.agents}</p>
        </div>
      </div>

      <section data-testid="plan-deliverables" className="space-y-2 rounded-xl border border-cream-300/80 bg-white/70 px-4 py-3 text-sm">
        <p className="font-semibold">
          Deliverables: {d.planned} visual{d.planned === 1 ? '' : 's'}
          {plan.library.collection ? ` from ${plan.library.collection.name}` : ''}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(d.byChannel)
            .filter(([c]) => PLATFORM_LABEL[c])
            .map(([c, n]) => (
              <Badge key={c} className="bg-cream-200 text-ink-600">
                {PLATFORM_LABEL[c]}: {n}
              </Badge>
            ))}
          {(['web_ad', 'display_ad', 'billboard', 'flyer'] as const).map((k) => (byKind[k] ? <Badge key={k} className="bg-sky-100 text-sky-800">{KIND_LABEL[k]}: {byKind[k]}</Badge> : null))}
        </div>
        <p className="text-xs text-muted">{d.note}</p>
        {d.notPlanned.length > 0 && (
          <div data-testid="not-planned" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
            <p className="font-medium">Not possible with this design (reported, never faked):</p>
            <ul className="mt-1 list-disc pl-5">
              {d.notPlanned.map((n, i) => (
                <li key={i}>
                  {n.label}: {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {im && (
        <section data-testid="plan-pictures" className="space-y-1 rounded-xl border border-cream-300/80 bg-white/70 px-4 py-3 text-sm">
          <p className="font-semibold">Pictures</p>
          <p className="text-xs">
            {im.approved} approved picture{im.approved === 1 ? '' : 's'}
            {Object.entries(im.approvedBySource).filter(([, n]) => n > 0).length ? ` (${Object.entries(im.approvedBySource).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}
            {im.autoStock ? ' · automatic licensed stock is on' : ''}. {im.estimate.note}
          </p>
        </section>
      )}

      <InputReadinessCard inputs={plan.inputs} />

      <section data-testid="plan-cost" className="space-y-1 rounded-xl border border-cream-300/80 bg-white/70 px-4 py-3 text-xs">
        <p className="text-sm font-semibold">Cost estimate (text-model calls only)</p>
        <table className="w-full max-w-xl text-left">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-medium">Stage</th>
              <th className="py-1 font-medium">Calls (typical / cap)</th>
              <th className="py-1 font-medium">Typical</th>
              <th className="py-1 font-medium">Worst case</th>
            </tr>
          </thead>
          <tbody>
            {plan.cost.text.phases.map((p) => (
              <tr key={p.phase} className="border-t border-cream-300/70">
                <td className="py-1">{plan.phases.find((x) => x.phase === p.phase)?.title ?? p.phase}</td>
                <td className="py-1">{p.runs ? `${p.calls.typical} / ${p.calls.cap}` : 'reused'}</td>
                <td className="py-1">{p.runs ? fmtUsd(p.typicalUsd) : '$0.00'}</td>
                <td className="py-1">{p.runs ? fmtUsd(p.maxUsd) : '$0.00'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted">Estimate from the published prices (read {plan.cost.priceBookVerifiedAt}); token volumes {plan.cost.text.phases.some((p) => p.basis === 'measured') ? 'partly measured from your earlier runs' : 'assumed'}. Not a guarantee or an invoice.</p>
      </section>

      {plan.warnings.length > 0 && (
        <ul data-testid="plan-warnings" className="space-y-1 text-xs text-amber-900">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
