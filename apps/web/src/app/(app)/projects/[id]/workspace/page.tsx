'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CalendarRange, Loader2, Play, Plug, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { PipelineBadge, PipelineCards, PipelineStrip, toSummary } from '@/components/pipeline-ui';
import { MarketingAuditPanel } from '@/components/marketing-audit-panel';
import { MarketStrategyPanel } from '@/components/market-strategy-panel';
import { CreativeProductionPanel } from '@/components/creative-production-panel';
import { ProductDiscoveryPanel } from '@/components/product-discovery-panel';
import { RuntimeTestPanel } from '@/components/runtime-test-panel';
import { ProjectStatusBadge } from '@/components/project-status-badge';
import { STATUS_META } from '@/components/integration-card';
import { useFactoryRuns, useMyIntegrations, useProject, usePipeline, useProviders } from '@/lib/hooks';
import { FORMAT_OPTIONS, LANGUAGES, MARKETING_GOALS, STYLES } from '@/lib/constants';
import { cn } from '@/lib/utils';

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const mine = useMyIntegrations();
  const providers = useProviders();
  const pipeline = usePipeline(id);
  const factoryRuns = useFactoryRuns(id);
  const factoryActive = factoryRuns.data?.some((r) => r.status === 'queued' || r.status === 'running') ?? false;

  if (project.isLoading) return <div className="h-96 animate-pulse rounded-3xl bg-cream-200" />;
  if (!project.data) {
    return <EmptyState icon={TriangleAlert} title="Project not found" action={<Button asChild><Link href="/projects">Back to projects</Link></Button>} />;
  }
  const p = project.data;
  const intake = p.intake;
  const flags = intake as unknown as Record<string, boolean> | null;
  const connected = (mine.data?.integrations ?? []).filter((i) => i.status === 'CONNECTED' || i.status === 'CONFIGURED');

  return (
    <div className="space-y-8">
      <Link href={`/projects/${id}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> {p.name}
      </Link>

      {/* Banner */}
      <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-300/70 bg-amber-50 px-5 py-4 text-sm text-amber-900">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p><strong className="font-semibold">Nothing runs until you confirm it.</strong> “Run campaign” shows the plan and the limits first (free), then runs Product Discovery (F1), the Marketing Audit (F2), Market Research &amp; Strategy (F3) and Creative Production (F4) in order on your own OpenAI key, reusing completed work. The phase panels below stay available for running one phase at a time.</p>
      </div>

      {/* Hero */}
      <section className="panel-dark grain relative overflow-hidden p-8 sm:p-10">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Campaign workspace</p>
            <h1 className="mt-3 text-4xl text-cream-100 sm:text-5xl">{p.name}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ProjectStatusBadge status={p.status} />
              <PipelineBadge dark summary={toSummary(pipeline.data)} />
              <span className="text-sm text-muted-dark">{MARKETING_GOALS.find((g) => g.value === intake?.marketingGoal)?.label ?? 'No goal set'}</span>
            </div>
          </div>
          <Button asChild size="lg" title="Review the plan and limits, then run F1 to F4 in one go">
            <Link href={`/projects/${id}/campaign`}>
              {factoryActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {factoryActive ? 'View campaign run' : 'Run campaign'}
            </Link>
          </Button>
        </div>

        {/* Pipeline: the persisted state of each phase */}
        <PipelineStrip pipeline={pipeline.data} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Stage cards: real saved state and results of F1 to F4 and the export */}
        <PipelineCards pipeline={pipeline.data} loading={pipeline.isLoading} flags={flags} />

        {/* Side panels */}
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Campaign settings</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row k="Market" v={intake?.targetMarket} />
              <Row k="Language" v={LANGUAGES.find((l) => l.value === intake?.preferredLanguage)?.label} />
              <Row k="Duration" v={intake?.campaignDuration} />
              <Row k="Style" v={STYLES.find((s) => s.value === intake?.stylePreference)?.label} />
              <Row k="Publishing" v={intake?.publishingMode} />
              <div className="border-t border-cream-300/70 pt-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-muted">Formats</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.formats.filter((f) => f.enabled).map((f) => (
                    <span key={f.id} className="rounded-full bg-cream-200 px-2.5 py-1 text-xs">{FORMAT_OPTIONS.find((o) => o.key === f.formatType)?.label}</span>
                  ))}
                  {p.formats.length === 0 && <span className="text-muted">None</span>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4" /> Integrations</CardTitle>
              <Button asChild size="sm" variant="ghost"><Link href="/settings/integrations">Manage</Link></Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {connected.length === 0 ? (
                <p className="text-sm text-muted">Nothing connected yet.</p>
              ) : (
                connected.map((i) => (
                  <div key={i.providerKey} className="flex items-center justify-between text-sm">
                    <span>{providers.data?.find((x) => x.key === i.providerKey)?.name ?? i.providerKey}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted"><span className={cn('h-1.5 w-1.5 rounded-full', STATUS_META[i.status].dot)} />{STATUS_META[i.status].label}</span>
                  </div>
                ))
              )}
              <p className="flex items-center gap-2 border-t border-cream-300/70 pt-3 text-xs text-muted">
                <CalendarRange className="h-3.5 w-3.5" />
                Default AI: <strong className="text-ink">{providers.data?.find((x) => x.key === mine.data?.defaultAiProvider)?.name ?? 'not set'}</strong>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div id="phase-f1" className="scroll-mt-6"><ProductDiscoveryPanel projectId={id} /></div>

      <div id="phase-f2" className="scroll-mt-6"><MarketingAuditPanel projectId={id} /></div>

      <div id="phase-f3" className="scroll-mt-6"><MarketStrategyPanel projectId={id} /></div>

      <div id="phase-f4" className="scroll-mt-6"><CreativeProductionPanel projectId={id} /></div>

      <RuntimeTestPanel projectId={id} />
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{k}</span>
      <span className="truncate text-right font-medium capitalize">{v || '–'}</span>
    </div>
  );
}
