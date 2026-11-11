'use client';

import Link from 'next/link';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, ClipboardCheck, Loader2, Palette, Settings2, Square } from 'lucide-react';
import { ApprovalBadge, ConceptsTab, CreativeAgentsTab, CreativeOverviewTab, FinalTab, FormatsTab, ImagesTab, LandingTab, ReviewTab } from '@/components/creative-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { usageFromEvents } from '@/lib/agent-progress';
import { keys, useCampaign, useCampaigns, useCancelRun, useCreativeAnalysis, useCreativePreflight, useOpenAiModels, useOpenAiStatus, useProjectRuns, useRunEventsFull, useStartCreative, useStrategies, useStrategy } from '@/lib/hooks';
import type { ChannelId, CreativePreflight, RunStatus, StartCreativeInput } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const RUN_STATUS: Record<RunStatus | 'NONE', { label: string; className: string }> = {
  NONE: { label: 'Not run yet', className: 'bg-cream-200 text-ink-600' },
  RUNNING: { label: 'Running', className: 'bg-accent-soft text-accent-hover' },
  COMPLETED: { label: 'Completed', className: 'bg-emerald-100 text-emerald-800' },
  FAILED: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Cancelled', className: 'bg-cream-300 text-ink-600' },
  INTERRUPTED: { label: 'Interrupted', className: 'bg-amber-100 text-amber-800' },
};

const TABS = ['Overview', 'Agents', 'Creative Concepts', 'Generated Images', 'Channel Formats', 'Landing Page', 'Quality Review', 'Final Campaign'] as const;
type Tab = (typeof TABS)[number];
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

/**
 * F4 Creative Production: Copywriter, Visual Creator, Layout Designer, Landing Content Builder, Content & Brand Reviewer and,
 * only when the review finds something to repair, a Fixer created at run time. Text AND images go through the user's own key.
 * Nothing starts without the preflight and an explicit confirmation.
 */
export function CreativeProductionPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const openai = useOpenAiStatus();
  const models = useOpenAiModels();
  const runs = useProjectRuns(projectId);
  const strategies = useStrategies(projectId);
  const campaigns = useCampaigns(projectId);
  const start = useStartCreative(projectId);
  const preflight = useCreativePreflight(projectId);
  const cancel = useCancelRun(projectId);

  const creativeRuns = runs.data?.filter((r) => r.mode === 'creative_production') ?? [];
  const latest = creativeRuns[0];
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const shown = creativeRuns.find((r) => r.id === selectedRunId) ?? latest;
  const running = latest?.status === 'RUNNING';
  const analysis = useCreativeAnalysis(shown?.id, shown?.status);
  const events = useRunEventsFull(shown?.id, shown?.status);
  const campaignId = shown?.campaignId ?? analysis.data?.campaignId ?? campaigns.data?.find((c) => c.runId === shown?.id)?.id ?? null;
  const campaign = useCampaign(campaignId, shown?.status);

  const eligible = strategies.data ?? [];
  const [strategyId, setStrategyId] = React.useState<string | null>(null);
  const selectedStrategy = eligible.find((s) => s.id === strategyId) ?? eligible[0];
  const strategyFull = useStrategy(selectedStrategy?.id);
  const recommended = React.useMemo(() => (strategyFull.data?.report.channels ?? []).map((c) => c.channel), [strategyFull.data]);

  const [imageModel, setImageModel] = React.useState<string>('');
  const [quality, setQuality] = React.useState<'low' | 'medium' | 'high' | 'auto'>('low');
  const [concepts, setConcepts] = React.useState(3);
  const [channels, setChannels] = React.useState<ChannelId[] | null>(null);
  const [landing, setLanding] = React.useState(true);
  const [maxImages, setMaxImages] = React.useState<number | null>(null);
  const [regen, setRegen] = React.useState(false);
  const [maxRegen, setMaxRegen] = React.useState(1);
  const [repairRounds, setRepairRounds] = React.useState(2);
  const [vision, setVision] = React.useState(0);
  const [maxCalls, setMaxCalls] = React.useState(16);
  const [layoutsPerConcept, setLayoutsPerConcept] = React.useState(4);
  const [tab, setTab] = React.useState<Tab>('Overview');
  const [showLog, setShowLog] = React.useState(false);
  const [flight, setFlight] = React.useState<{ key: string; data: CreativePreflight } | null>(null);

  React.useEffect(() => {
    if (latest && latest.status !== 'RUNNING') qc.invalidateQueries({ queryKey: keys.campaigns(projectId) });
  }, [latest?.id, latest?.status, projectId, qc]);
  React.useEffect(() => {
    if (openai.data?.configured && models.data === undefined && !models.isFetching) void models.refetch();
  }, [openai.data?.configured, models]);

  const status = openai.data;
  const configured = !!status?.configured;
  const hasModel = !!status?.model;
  const effectiveChannels = channels ?? (recommended.slice(0, 4) as ChannelId[]);
  const imageOptions = (models.data?.models ?? []).filter((m) => m.imageSupported);
  const body: StartCreativeInput = {
    strategyId: selectedStrategy?.id,
    imageModel: imageModel || undefined,
    imageQuality: imageModel ? quality : undefined,
    concepts,
    channels: effectiveChannels.length ? effectiveChannels : undefined,
    landing,
    maxImages: imageModel ? Math.min(maxImages ?? concepts, concepts) : undefined,
    maxRegenerations: imageModel && regen ? maxRegen : 0,
    maxLayoutsPerConcept: layoutsPerConcept,
    maxRepairRounds: repairRounds,
    visionReviews: vision,
    maxModelCalls: maxCalls,
  };
  const bodyKey = JSON.stringify(body);
  const flightValid = flight?.key === bodyKey ? flight.data : null;
  const canPreflight = configured && hasModel && !running && !!selectedStrategy;
  const usage = usageFromEvents(events.data ?? []);
  const badge = RUN_STATUS[shown?.status ?? 'NONE'];

  function runPreflight() {
    preflight.mutate(body, { onSuccess: (data) => setFlight({ key: bodyKey, data }), onError: (e) => toast.error(e.message) });
  }

  function begin() {
    const f = flightValid;
    if (!f) return;
    const lines = [
      `Start Creative Production with text model "${f.settings.model}"${f.settings.imageModel ? ` and image model "${f.settings.imageModel}" (${f.settings.imageQuality})` : ' and NO image model'}?`,
      '',
      `This uses YOUR OpenAI API credits:`,
      `• up to ${f.estimate.textCalls.enforcedCap} text-model calls (a typical run needs about ${f.estimate.textCalls.typical}, with repairs up to ${f.estimate.textCalls.max})`,
      f.settings.imageModel ? `• ${f.estimate.imageRequests.planned} image request(s)${f.estimate.imageRequests.regenerationEnabled ? `, up to ${f.estimate.imageRequests.max} with regeneration` : ' (regeneration off)'} — OpenAI bills each image by model, quality and size` : '• no image request',
      `• ${f.estimate.layouts.planned} channel layouts rendered locally (no cost)`,
      '',
      'These limits are enforced by LaunchPilot and are NOT an OpenAI spending cap. No price is shown because LaunchPilot does not know your pricing.',
    ];
    if (!window.confirm(lines.join('\n'))) return;
    setSelectedRunId(null);
    setTab('Overview');
    start.mutate(body, { onError: (e) => toast.error(e.message), onSuccess: () => setFlight(null) });
  }

  const toggleChannel = (id: ChannelId) => setChannels((cur) => {
    const base = cur ?? effectiveChannels;
    return base.includes(id) ? base.filter((c) => c !== id) : [...base, id];
  });

  return (
    <Card>
      <CardHeader className="items-center">
        <div>
          <CardTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent">
              <Palette className="h-4 w-4" />
            </span>
            F4 · Creative Production
          </CardTitle>
          <CardDescription>
            From one approved strategy: a Copywriter writes concepts and channel copy, a Visual Creator plans and generates one original base image per concept with the image model you choose, a Layout Designer cuts every channel format from it locally, a Landing Content Builder writes the page, and a Content &amp; Brand Reviewer checks everything. If it finds a problem, a Fixer is created on the spot and asks the owner to correct it, at most twice. The result is a downloadable campaign package.
          </CardDescription>
        </div>
        <Badge className={cn(badge.className)}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {badge.label}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="rounded-2xl bg-cream-100 p-4">
          {strategies.isLoading ? (
            <div className="h-10 animate-pulse rounded-lg bg-cream-200" />
          ) : eligible.length === 0 ? (
            <p role="status" className="flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Prerequisite missing: F4 needs a completed Market Research &amp; Strategy (F3) report, which itself needs F1 and F2. Run the earlier phases first; nothing is made up in their place.
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="flex items-center gap-2">
                  <span className="text-muted">Built on F3 strategy</span>
                  <select aria-label="F3 strategy" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={selectedStrategy?.id ?? ''} onChange={(e) => { setStrategyId(e.target.value); setChannels(null); }}>
                    {eligible.map((s, i) => (
                      <option key={s.id} value={s.id}>
                        {formatDate(s.createdAt)} · {s.model}
                        {s.partial ? ' · partial' : ''}
                        {i === 0 ? ' (latest)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  <span className="text-muted">Text model </span>
                  <strong className="font-mono">{status?.model ?? 'none selected'}</strong>
                </span>
                <label className="flex items-center gap-2">
                  <span className="text-muted">Image model</span>
                  <select aria-label="Image model" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
                    <option value="">None (no image generation)</option>
                    <option value="auto">Automatic: a current model your key lists</option>
                    {imageOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {m.retired ? ` — shut down by OpenAI on ${m.retired.on} (will be refused)` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {imageModel && (
                  <label className="flex items-center gap-2">
                    <span className="text-muted">Quality</span>
                    <select aria-label="Image quality" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
                      <option value="low">low (cheapest)</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="auto">auto</option>
                    </select>
                  </label>
                )}
                <Button asChild size="sm" variant="ghost" className="ml-auto">
                  <Link href="/settings/providers">
                    <Settings2 className="h-3.5 w-3.5" /> AI provider settings
                  </Link>
                </Button>
              </div>
              <p className="text-xs text-muted">
                F1 <span className="font-mono">{selectedStrategy?.f1ReportId}</span> → F2 <span className="font-mono">{selectedStrategy?.f2AuditId}</span> → F3 <span className="font-mono">{selectedStrategy?.id}</span> ({formatDate(selectedStrategy!.createdAt)}). Only this exact chain is used.
                {configured && models.data && imageOptions.length === 0 ? ' Your key lists no gpt-image model, so only the no-image mode is offered.' : ''}
                {configured && models.isError ? ' The model list could not be loaded; you can still run without images.' : ''}
              </p>
            </div>
          )}
          {!openai.isLoading && !configured && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Add your OpenAI API key in Settings &gt; AI providers to run creative production.
            </p>
          )}
          {configured && !hasModel && (
            <p className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Choose a text model in Settings &gt; AI providers. LaunchPilot never picks or switches models for you.
            </p>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 text-xs text-muted">
              Concepts (1 to 5)
              <Input type="number" min={1} max={5} value={concepts} onChange={(e) => setConcepts(clampNum(e.target.value, 1, 5, 3))} />
            </label>
            <label className="space-y-1 text-xs text-muted">
              Layouts per concept (1 to 6)
              <Input type="number" min={1} max={6} value={layoutsPerConcept} onChange={(e) => setLayoutsPerConcept(clampNum(e.target.value, 1, 6, 4))} />
            </label>
            <label className="space-y-1 text-xs text-muted">
              Max text-model calls (4 to 40)
              <Input type="number" min={4} max={40} value={maxCalls} onChange={(e) => setMaxCalls(clampNum(e.target.value, 4, 40, 16))} />
            </label>
            <label className="space-y-1 text-xs text-muted">
              Repair rounds (0 to 3)
              <Input type="number" min={0} max={3} value={repairRounds} onChange={(e) => setRepairRounds(clampNum(e.target.value, 0, 3, 2))} />
            </label>
            {imageModel && (
              <>
                <label className="space-y-1 text-xs text-muted">
                  Max images (0 to {concepts})
                  <Input type="number" min={0} max={concepts} value={Math.min(maxImages ?? concepts, concepts)} onChange={(e) => setMaxImages(clampNum(e.target.value, 0, concepts, concepts))} />
                </label>
                <label className="flex items-center gap-2 self-end pb-2 text-xs text-muted">
                  <input type="checkbox" checked={regen} onChange={(e) => setRegen(e.target.checked)} /> Allow image regeneration
                </label>
                {regen && (
                  <label className="space-y-1 text-xs text-muted">
                    Max regenerations (1 to 5)
                    <Input type="number" min={1} max={5} value={maxRegen} onChange={(e) => setMaxRegen(clampNum(e.target.value, 1, 5, 1))} />
                  </label>
                )}
                <label className="space-y-1 text-xs text-muted">
                  Assets the reviewer may LOOK at per round (0 to 6)
                  <Input type="number" min={0} max={6} value={vision} onChange={(e) => setVision(clampNum(e.target.value, 0, 6, 0))} />
                </label>
              </>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
            <span>Channels:</span>
            {ALL_CHANNELS.map((c) => (
              <label key={c.id} className={cn('flex items-center gap-1', recommended.includes(c.id) ? 'text-ink' : '')} title={recommended.includes(c.id) ? 'Recommended by the strategy' : 'Not in the strategy'}>
                <input type="checkbox" checked={effectiveChannels.includes(c.id)} onChange={() => toggleChannel(c.id)} /> {c.label}
                {recommended.includes(c.id) ? ' ★' : ''}
              </label>
            ))}
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={landing} onChange={(e) => setLanding(e.target.checked)} /> Landing page content
            </label>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-muted">Limits are enforced by LaunchPilot per run, not an OpenAI spending cap. Image requests are billed by OpenAI per image (model, quality, size); layouts cost nothing. Regeneration is off by default: a rejected picture stays visible as an unresolved issue instead of being re-bought.</p>

          <div className="mt-4 flex flex-wrap items-start gap-3">
            <Button variant="outline" onClick={runPreflight} loading={preflight.isPending} disabled={!canPreflight}>
              <ClipboardCheck className="h-4 w-4" /> Preflight (free)
            </Button>
            <Button onClick={begin} loading={start.isPending} disabled={!canPreflight || !flightValid} title={flightValid ? '' : 'Run the preflight first; it shows exactly what will be spent'}>
              <Palette className="h-4 w-4" /> Start Creative Production
            </Button>
            {running && latest && (
              <Button variant="outline" loading={cancel.isPending} onClick={() => cancel.mutate(latest.id, { onError: (e) => toast.error(e.message) })}>
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
          </div>

          {flightValid && (
            <div className="mt-4 rounded-xl border border-accent/40 bg-white/70 p-4 text-sm">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Preflight: exactly this will run</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted">Text model calls</p>
                  <p className="font-semibold">typically {flightValid.estimate.textCalls.typical}, at most {flightValid.estimate.textCalls.enforcedCap}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Image requests</p>
                  <p className="font-semibold">
                    {flightValid.estimate.imageRequests.planned}
                    {flightValid.estimate.imageRequests.regenerationEnabled ? ` (up to ${flightValid.estimate.imageRequests.max} with regeneration)` : ''}
                    {flightValid.settings.imageModel ? ` · ${flightValid.settings.imageModel}, ${flightValid.settings.imageQuality}` : ' · none'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted">Layouts (local, free)</p>
                  <p className="font-semibold">{flightValid.estimate.layouts.planned}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted">
                {flightValid.input.concepts} concept(s) · {flightValid.input.channels.join(', ')} · {flightValid.input.landing ? 'with' : 'without'} landing page · brand colors {flightValid.brand.fromBrand ? `from ${flightValid.brand.logo ? 'your logo / F1' : 'F1'}` : 'not available (neutral palette)'}
                {flightValid.brand.logo ? ` · logo "${flightValid.brand.logo}" will be placed on every layout` : ' · no logo uploaded'} · image model: {flightValid.imageModel.note}
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
                {flightValid.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {creativeRuns.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Run
            <select aria-label="Previous creative runs" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={shown?.id ?? ''} onChange={(e) => setSelectedRunId(e.target.value)}>
              {creativeRuns.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {formatDate(r.startedAt)} · {r.status.toLowerCase()}
                  {i === 0 ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {shown && (
          <div>
            <p className="mb-3 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              Started {formatDate(shown.startedAt)} · {usage.calls} text-model call{usage.calls === 1 ? '' : 's'} · {usage.totalTokens.toLocaleString()} tokens ({usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out), measured
              {analysis.data?.images ? ` · ${analysis.data.images.requestsStarted} image request(s), ${analysis.data.images.generated} generated` : ''}. Everything below is read from the saved run history and the stored campaign.
              <ApprovalBadge status={campaign.data?.approvalStatus ?? analysis.data?.approvalStatus} />
            </p>
            {shown.errorMessage && (
              <p role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {shown.errorMessage}
              </p>
            )}
          </div>
        )}

        {shown ? (
          <>
            <div role="tablist" aria-label="Creative Production" className="flex flex-wrap gap-1 border-b border-cream-300/80">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
                  {t}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'Overview' && <CreativeOverviewTab analysis={analysis.data} campaign={campaign.data} running={shown.status === 'RUNNING'} />}
              {tab === 'Agents' && <CreativeAgentsTab analysis={analysis.data} events={events.data ?? []} />}
              {tab === 'Creative Concepts' && <ConceptsTab pkg={campaign.data?.package} />}
              {tab === 'Generated Images' && <ImagesTab pkg={campaign.data?.package} assets={campaign.data?.assets ?? []} campaignId={campaign.data?.id} />}
              {tab === 'Channel Formats' && <FormatsTab pkg={campaign.data?.package} assets={campaign.data?.assets ?? []} />}
              {tab === 'Landing Page' && <LandingTab pkg={campaign.data?.package} campaignId={campaign.data?.package ? campaignId : null} />}
              {tab === 'Quality Review' && <ReviewTab pkg={campaign.data?.package} />}
              {tab === 'Final Campaign' && <FinalTab campaign={campaign.data} />}
            </div>
            <button onClick={() => setShowLog((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:text-ink">
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showLog && 'rotate-180')} />
              {showLog ? 'Hide' : 'Show'} raw event log ({events.data?.length ?? 0})
            </button>
            {showLog && (
              <ol className="max-h-64 space-y-1 overflow-auto rounded-xl bg-cream-100/70 p-3 font-mono text-[11px]">
                {(events.data ?? []).map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="w-8 shrink-0 text-muted">{e.sequence}</span>
                    <span className={cn(e.eventType === 'participant.registered' && 'font-semibold text-accent', /^revision\./.test(e.eventType) && 'text-amber-900')}>{e.eventType}</span>
                    <span className="truncate text-muted">{e.participant}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-6 py-10 text-center">
            <p className="text-sm font-medium">No campaign yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted">Run the preflight, read the limits, then press “Start Creative Production”. Nothing runs automatically and no image is generated without your choice of an image model.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function clampNum(raw: string, min: number, max: number, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}
