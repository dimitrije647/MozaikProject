'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, Rocket, TriangleAlert } from 'lucide-react';
import { CampaignOutputs } from '@/components/campaign-outputs';
import { EmptyState } from '@/components/empty-state';
import { CampaignSetup, FactoryRunView, isActive } from '@/components/factory-ui';
import { Button } from '@/components/ui/button';
import { useFactoryRun, useFactoryRuns, useProject } from '@/lib/hooks';
import { COLLECTION_IDS, type CollectionId } from '@/lib/visual';
import type { FactoryPresetId } from '@/lib/types';
import { formatDate } from '@/lib/utils';

/** The full campaign: plan (free), run (F1 → F4, one click), live agent activity and the finished result. */
export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const runs = useFactoryRuns(id);
  // arriving from the Templates page ("Choose in the campaign design"): the setup opens on Hybrid Production with that collection chosen
  const wanted = useSearchParams().get('collection');
  const initialCollection = (COLLECTION_IDS as readonly string[]).includes(wanted ?? '') ? (wanted as CollectionId) : null;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [setup, setSetup] = React.useState(!!initialCollection);
  // "Continue from saved work" opens the setup with the preset of the stopped run (the plan is free; the budget is approved anew)
  const [setupPreset, setSetupPreset] = React.useState<FactoryPresetId | undefined>(initialCollection ? 'hybrid_production' : undefined);
  // "Continue with new images" (NO AI HYBRID, partial campaign): the same setup, with a new creative round already ticked; the nonce re-creates the form
  const [setupRerun, setSetupRerun] = React.useState(false);
  const [setupNonce, setSetupNonce] = React.useState(0);

  const latest = runs.data?.[0];
  const shownId = selected ?? latest?.id ?? null;
  const run = useFactoryRun(shownId);
  const data = run.data ?? runs.data?.find((r) => r.id === shownId);
  const active = isActive(latest?.status);

  if (project.isLoading) return <div className="h-96 animate-pulse rounded-3xl bg-cream-200" />;
  if (!project.data) return <EmptyState icon={TriangleAlert} title="Project not found" action={<Button asChild><Link href="/projects">Back to projects</Link></Button>} />;
  const p = project.data;
  const showSetup = !active && (!latest || setup);

  return (
    <div className="space-y-8">
      <Link href={`/projects/${id}/workspace`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> {p.name} workspace
      </Link>

      <section className="panel-dark grain relative overflow-hidden p-8 sm:p-10">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Run campaign</p>
          <h1 className="mt-3 text-4xl text-cream-100 sm:text-5xl">{p.name}</h1>
          <p className="mt-3 max-w-3xl text-[15px] text-muted-dark">
            One click runs Product Discovery, the Marketing Audit, Market Research &amp; Strategy and Creative Production in order, each with its own team of Mozaik agents, and saves a campaign package you can download. Saved results from earlier work are reused, not paid for again. The plan shows an estimate in dollars first, and Full Production, Hybrid Production and NO AI HYBRID ask you to approve a spending limit before anything is paid for.
          </p>
        </div>
      </section>

      {runs.isLoading ? (
        <div className="h-48 animate-pulse rounded-2xl bg-cream-200" />
      ) : (
        <>
          {active && <p className="text-sm text-muted">A campaign run is in progress for this project. The individual phase panels are locked until it finishes or is cancelled.</p>}

          {showSetup && (
            <section id="configure-campaign" aria-label="Configure campaign" className="space-y-3">
              <h2 className="text-2xl">{latest ? 'Start another run' : 'Configure and review the plan'}</h2>
              <CampaignSetup
                key={`${setupPreset ?? 'default'}:${setupNonce}`}
                projectId={id}
                initialPreset={setupPreset}
                initialRerunCreative={setupRerun}
                initialCollection={initialCollection}
                onStarted={(r) => {
                  setSelected(r.id);
                  setSetup(false);
                }}
              />
            </section>
          )}

          {data && (
            <section aria-label="Campaign run" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-2xl">Campaign run</h2>
                <div className="flex flex-wrap items-center gap-3">
                  {(runs.data?.length ?? 0) > 1 && (
                    <label className="flex items-center gap-2 text-xs text-muted">
                      Run
                      <select aria-label="Previous campaign runs" className="rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink" value={shownId ?? ''} onChange={(e) => setSelected(e.target.value)}>
                        {runs.data!.map((r, i) => (
                          <option key={r.id} value={r.id}>
                            {formatDate(r.createdAt)} · {r.status}
                            {i === 0 ? ' (latest)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {!active && !setup && (
                    <Button variant="outline" size="sm" onClick={() => setSetup(true)}>
                      <Rocket className="h-3.5 w-3.5" /> Start another run
                    </Button>
                  )}
                </div>
              </div>
              <FactoryRunView
                projectId={id}
                run={data}
                onContinue={() => {
                  setSetupPreset(data.config.preset ?? undefined);
                  setSetup(true);
                  setTimeout(() => document.getElementById('configure-campaign')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                }}
              />
              {data.campaignId && (
                <div className="space-y-3">
                  <h2 className="text-2xl">Final campaign</h2>
                  <CampaignOutputs
                    campaignId={data.campaignId}
                    projectId={id}
                    outcome={data.outcome}
                    onContinueNoAi={() => {
                      setSetupPreset('no_ai_hybrid');
                      setSetupRerun(true);
                      setSetupNonce((n) => n + 1);
                      setSetup(true);
                      setTimeout(() => document.getElementById('configure-campaign')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                    }}
                  />
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
