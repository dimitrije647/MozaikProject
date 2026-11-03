'use client';

import * as React from 'react';
import { AlertCircle, Check, ClipboardCheck, Loader2, Play } from 'lucide-react';
import { CostEstimateCard, SpendingConsent, useSpendingConsent } from '@/components/cost-ui';
import { StartChecklist, type ChecklistItem } from '@/components/start-checklist';
import { VARIATION_STATUS, imageCountsLine, variationsOf } from '@/components/creative-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useCampaigns, useContinueImages, useContinueImagesPreflight, useCreativeAnalysis, useRun } from '@/lib/hooks';
import type { BudgetOptionData, CampaignFull, ContinueImagesInput, ContinueImagesPlan } from '@/lib/types';
import { cn } from '@/lib/utils';

/*
 * "Generate the missing images" (Hybrid Production: "Complete missing creatives"): an image-only continuation of a finished campaign. The
 * preflight is free and shows the missing images, what is reused and the estimate; starting needs a typed spending limit and a ticked
 * confirmation. It starts a NEW campaign (a revision) and never changes this one. Nothing here starts by itself.
 *
 * Hybrid Production also completes TEMPLATE creatives that were never rendered. They are rendered locally and cost nothing: when no
 * original image is missing (the preflight says mustConfirm: false) the panel asks for no spending limit and no confirmation; when images
 * are missing the billed flow is exactly the same as for any other campaign.
 */

type Quality = '' | 'low' | 'medium' | 'high' | 'auto';

/** The preflight as the API returns it: mustConfirm is false when no image is missing, and Hybrid campaigns carry a template summary. */
type Plan = Omit<ContinueImagesPlan, 'mustConfirm'> & { mustConfirm: boolean; hybrid?: { templatesPlanned: number; templatesDelivered: number; note: string } };

/** Template creatives of a Hybrid campaign that still have to be rendered (never rendered) or rendered again (made without their original). */
export function pendingTemplates(c: CampaignFull | undefined): { missing: number; fallback: number } {
  const hy = c?.package?.hybrid;
  if (!hy) return { missing: 0, fallback: 0 };
  const t = hy.counts.templates;
  return { missing: Math.max(0, t.planned - t.rendered - t.fallbackRendered), fallback: hy.creatives.filter((x) => x.status === 'fallback_rendered').length };
}

/** Whether this campaign has planned originals or (Hybrid) template creatives that do not exist, i.e. whether the panel is offered at all. */
export function hasMissingCreatives(c: CampaignFull | undefined): boolean {
  const pkg = c?.package;
  if (!c || c.status !== 'completed' || !pkg) return false;
  // NO AI HYBRID never generates an image: "Generate the missing images" does not exist for it (a partial campaign continues with new pictures instead)
  if (pkg.hybrid?.imagery) return false;
  const vars = variationsOf(pkg);
  if (vars.length === 0) return false;
  const imagesMissing = !!pkg.imageCounts && pkg.imageCounts.generated < pkg.imageCounts.requested && vars.some((v) => v.status !== 'generated');
  const t = pendingTemplates(c);
  return imagesMissing || t.missing + t.fallback > 0;
}

export function ContinueImagesPanel({ campaign, projectId, onOpen }: { campaign: CampaignFull; projectId: string; onOpen: (campaignId: string) => void }) {
  const toast = useToast();
  const pkg = campaign.package!;
  const counts = pkg.imageCounts ?? null;
  const hybrid = !!pkg.hybrid;
  const tpl = pendingTemplates(campaign);
  const tplCount = tpl.missing + tpl.fallback;
  const preflight = useContinueImagesPreflight(campaign.id);
  const start = useContinueImages(projectId, campaign.id);
  const campaigns = useCampaigns(projectId);

  const [quality, setQuality] = React.useState<Quality>('');
  const [model, setModel] = React.useState<string | null>(null);
  const [maxImages, setMaxImages] = React.useState<number | null>(null);
  const [plan, setPlan] = React.useState<{ key: string; data: Plan; rev: number } | null>(null);
  const reviews = React.useRef(0);
  const [applied, setApplied] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);

  const missingNow = variationsOf(pkg).filter((v) => v.status !== 'generated').length;
  // no original image is missing: only template creatives are completed (local, free, no spending limit); known from the package and confirmed by the preflight
  const onlyTemplates = hybrid && missingNow === 0;
  const body: ContinueImagesInput = { ...(quality ? { imageQuality: quality } : {}), ...(model ? { imageModel: model } : {}), ...(maxImages !== null ? { maxImages } : {}) };
  const key = JSON.stringify(body);
  const valid = plan?.key === key ? plan.data : null;
  const spend = useSpendingConsent(`${key}#${plan?.rev ?? 0}`, valid?.cost ?? null);
  // no original image is missing: only template creatives are completed (free). An unpublished image price is accepted inside the ONE budget
  // approval, which names the maximum number of image requests (the number the review showed).
  const free = !!valid && !valid.mustConfirm;
  const priceUnknown = !free && !!valid && valid.cost.images.basis === 'unavailable' && valid.cost.images.count > 0;
  const checklist: ChecklistItem[] = [{ id: 'review', label: hybrid ? 'Review the missing creatives (free)' : 'Review the missing images (free)', done: !!valid, hint: 'Reviewing is free and sends nothing to OpenAI.' }];
  if (valid && !free) {
    checklist.push({ id: 'config', label: 'No configuration problem', done: valid.ok, hint: 'The review reported a problem; fix it and review again.' });
    checklist.push({ id: 'work', label: 'At least one image to request', done: valid.willRequest > 0, hint: 'Nothing is left to request.' });
    checklist.push({ id: 'limit', label: 'Enter the budget for this continuation', done: spend.value !== null, hint: 'Type the most you accept to spend on these images (and their review), from $0.01 to $500.' });
    if (spend.value !== null && spend.status === 'below_estimate') checklist.push({ id: 'limit-fits', label: 'The budget covers the estimate', done: false, hint: 'Raise the budget or use one of the options under the estimate.' });
    checklist.push({ id: 'approve', label: 'Tick the spending approval', done: spend.consent && spend.ready, hint: 'Enter the budget first, then tick the confirmation.' });
  }
  const canStart = !!valid && (free ? valid.ok : checklist.every((i) => i.done)) && !start.isPending && !runId;
  // continuations of THIS campaign that already exist (also after a page refresh)
  const earlier = (campaigns.data ?? []).filter((c) => c.lineage?.parentCampaignId === campaign.id);

  function review() {
    setApplied(null);
    preflight.mutate(body, { onSuccess: (data) => setPlan({ key, data: data as Plan, rev: ++reviews.current }), onError: (e) => toast.error(e.message) });
  }
  function begin() {
    if (!canStart) return;
    // free (only template creatives, rendered locally): nothing is billed, so no limit and no confirmation are sent
    if (free) {
      start.mutate({}, { onSuccess: (r) => setRunId(r.id), onError: (e) => toast.error(e.message) });
      return;
    }
    // the typed limit and the ticked confirmation are the confirmation of this paid request
    start.mutate({ ...body, approvedBudgetUsd: spend.value!, confirmCost: true, ...(priceUnknown ? { approvedImageRequests: valid!.willRequest } : {}) }, { onSuccess: (r) => setRunId(r.id), onError: (e) => toast.error(e.message) });
  }
  /** A budget option edits the form only when the user presses its button; the plan must then be reviewed again. */
  function applyOption(o: BudgetOptionData) {
    const s = o.set;
    if (s.approvedBudgetUsd !== undefined) spend.setLimit(String(s.approvedBudgetUsd));
    if (s.imageModel) setModel(s.imageModel);
    if (s.imageQuality) setQuality(s.imageQuality as Quality);
    if (s.maxImages !== undefined) setMaxImages(Math.max(1, s.maxImages));
    if (s.imageModel || s.imageQuality || s.maxImages !== undefined) setApplied(`${o.label}: the settings were changed. Review the missing images again to see the new estimate.`);
  }

  const startButton = (
    <Button data-testid="continue-images-start" onClick={begin} disabled={!canStart} loading={start.isPending} title={checklist.find((i) => !i.done) ? `${checklist.find((i) => !i.done)!.label}: ${checklist.find((i) => !i.done)!.hint ?? ''}` : ''}>
      <Play className="h-4 w-4" />{' '}
      {free ? `Render ${tplCount} missing template creative${tplCount === 1 ? '' : 's'} (free)` : `Generate ${valid ? valid.willRequest : ''} missing image${valid?.willRequest === 1 ? '' : 's'}`}
    </Button>
  );

  return (
    <section data-testid="continue-images-panel" aria-label={hybrid ? 'Complete missing creatives' : 'Generate the missing images'} className="space-y-4 rounded-2xl border border-amber-300 bg-amber-50/60 p-5">
      <div>
        <h3 className="text-xl">{hybrid ? 'Complete missing creatives' : 'Generate the missing images'}</h3>
        {counts && (
          <p data-testid="continue-counts" className="mt-1 text-sm font-medium">
            {imageCountsLine(counts)}
          </p>
        )}
        {hybrid && pkg.hybrid && (
          <p data-testid="continue-template-counts" className="mt-1 text-sm font-medium">
            {pkg.hybrid.counts.templates.rendered + pkg.hybrid.counts.templates.fallbackRendered} of {pkg.hybrid.counts.templates.planned} planned template creatives exist
            {tpl.fallback > 0 ? ` (${tpl.fallback} FALLBACK: made without its original)` : ''}
          </p>
        )}
        {hybrid ? (
          <p className="mt-1 max-w-3xl text-xs text-muted">
            This creates a NEW campaign (revision {(pkg.lineage?.revision ?? 1) + 1}) that reuses the strategy, the copy, the landing page and every image that succeeded.{' '}
            {onlyTemplates
              ? `No original image is missing, so it only renders the ${tplCount} template creative(s) that do not exist yet, locally and for free: no image request is made and no spending limit is asked.`
              : `It requests ONLY the ${missingNow} missing original image(s), which OpenAI bills, and also renders the ${tplCount} template creative(s) that do not exist yet locally, which costs nothing.`}{' '}
            This campaign is not changed. Reviewing is free.
          </p>
        ) : (
          <p className="mt-1 max-w-3xl text-xs text-muted">
            This creates a NEW campaign (revision {(pkg.lineage?.revision ?? 1) + 1}) that reuses the strategy, the copy, the landing page and every image that succeeded, and requests ONLY the {missingNow} missing image(s). This campaign is not changed. Reviewing is free; generating is billed by OpenAI.
          </p>
        )}
      </div>

      {earlier.length > 0 && (
        <ul data-testid="earlier-continuations" className="space-y-1 text-xs">
          {earlier.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white/70 px-3 py-2">
              <span>
                Revision {c.lineage?.revision ?? '?'} of this campaign · {c.status === 'running' ? 'still generating' : c.status}
                {c.imageCounts ? ` · ${c.imageCounts.generated} of ${c.imageCounts.requested} originals` : ''}
              </span>
              {c.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {c.status === 'completed' && (
                <Button size="sm" variant="outline" onClick={() => onOpen(c.id)}>
                  Open revision {c.lineage?.revision}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {runId ? (
        <Progress runId={runId} parentName={campaign.campaignName} parentRevision={pkg.lineage?.revision ?? 1} onOpen={onOpen} templatesOnly={free} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4 text-xs text-muted">
            {!onlyTemplates && (
              <>
                <label className="space-y-1">
                  Image quality
                  <select aria-label="Image quality for the missing images" className="block rounded-lg border border-cream-300 bg-cream-50 px-2 py-2 text-sm text-ink" value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                    <option value="">Same as the earlier campaign</option>
                    <option value="low">low (cheapest)</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="auto">auto</option>
                  </select>
                </label>
                <label className="space-y-1">
                  Request at most
                  <Input type="number" min={1} max={missingNow} placeholder={`all ${missingNow}`} className="h-10 w-28" value={maxImages ?? ''} onChange={(e) => setMaxImages(e.target.value === '' ? null : Math.min(Math.max(Math.round(Number(e.target.value)) || 1, 1), missingNow))} />
                </label>
              </>
            )}
            {model && !onlyTemplates && (
              <span className="pb-2">
                Image model: <strong className="font-mono text-ink">{model}</strong>{' '}
                <button type="button" onClick={() => setModel(null)} className="underline underline-offset-2 hover:text-ink">
                  use the earlier model
                </button>
              </span>
            )}
            <Button data-testid="continue-images-review" variant="outline" onClick={review} loading={preflight.isPending}>
              <ClipboardCheck className="h-4 w-4" /> {hybrid ? 'Review the missing creatives (free)' : 'Review the missing images (free)'}
            </Button>
          </div>
          {applied && (
            <p role="status" data-testid="option-applied" className="flex items-start gap-2 text-xs text-amber-900">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {applied}
            </p>
          )}

          {valid && (
            <div data-testid="continue-images-plan" className="space-y-3">
              {valid.missing.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Missing images ({valid.missing.length})</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {valid.missing.map((m) => {
                    const st = VARIATION_STATUS[m.status];
                    return (
                      <li key={m.variationId} data-testid="missing-image" data-status={m.status} className="rounded-xl border border-cream-300/80 bg-white/70 px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">
                            {m.conceptName} — {m.variationName ?? m.variationId}
                          </strong>
                          <Badge className={cn('px-2 py-0.5 text-[11px]', st.badge)}>{st.label}</Badge>
                          <span className="text-muted">{m.size}</span>
                        </div>
                        <p className="mt-0.5 text-muted">{m.explanation ?? 'No reason was recorded for this image.'}</p>
                      </li>
                    );
                  })}
                </ul>
              </div>
              )}
              <div data-testid="continue-reuse" className="rounded-xl bg-cream-100 px-4 py-3 text-xs">
                <p>
                  <strong>Reused as they are:</strong> {valid.reuse.concepts} concept(s), {valid.reuse.copyVariants} copy variant(s), {valid.reuse.landing ? 'the landing page' : 'no landing page'}, {valid.reuse.originals} original image(s) that succeeded and {valid.reuse.layouts} layout(s) built from them.
                </p>
                <p className="mt-1">
                  <strong>Not rerun:</strong> {valid.notRerun.join(', ')}.
                </p>
                {free ? (
                  <p className="mt-1">
                    <strong>Will request now:</strong> no image. The {tplCount} missing template creative(s) are rendered locally from the originals you already have.
                  </p>
                ) : (
                  <p className="mt-1">
                    <strong>Will request now:</strong> {valid.willRequest} image(s) with <span className="font-mono">{valid.settings.imageModel ?? 'no model'}</span> at quality {valid.settings.imageQuality}, {valid.settings.imageConcurrency} at a time, plus up to {valid.settings.visionReviews} visual review(s)
                    {valid.settings.textModel ? <> by <span className="font-mono">{valid.settings.textModel}</span></> : null}.
                  </p>
                )}
                {valid.hybrid && !free && <p data-testid="continue-hybrid-note" className="mt-1">{valid.hybrid.note}</p>}
                {!free && <p className="mt-1 text-muted">{valid.imageModel.note}</p>}
                {!free && valid.imageModel.warning && (
                  <p className="mt-1 flex items-start gap-2 text-amber-900">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {valid.imageModel.warning}
                  </p>
                )}
              </div>
              {free ? (
                <div data-testid="continue-free" className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
                  <p className="flex items-start gap-2 text-sm font-medium">
                    <Check className="mt-0.5 h-4 w-4 shrink-0" /> Free: rendered locally, no spending limit needed
                  </p>
                  <p>{valid.hybrid?.note ?? 'Template creatives that do not exist yet are rendered locally from the originals (no image request, no cost).'}</p>
                  <p>No original image is missing, so nothing is requested from OpenAI and you are not asked for a spending limit or a confirmation.</p>
                  <div>{startButton}</div>
                </div>
              ) : (
                <>
                  <CostEstimateCard cost={valid.cost} onApply={applyOption} />
                  <SpendingConsent spend={spend} cost={valid.cost} unified={{ imageRequestCap: valid.willRequest, priceUnavailable: priceUnknown, allowImageFree: false }} onApplyOption={applyOption}>
                    {startButton}
                  </SpendingConsent>
                  <StartChecklist items={checklist} />
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Progress of the started continuation, polled from the run (never simulated), and the link to the new campaign once it is saved. */
function Progress({ runId, parentName, parentRevision, onOpen, templatesOnly }: { runId: string; parentName: string; parentRevision: number; onOpen: (campaignId: string) => void; templatesOnly?: boolean }) {
  const run = useRun(runId);
  const status = run.data?.status;
  const analysis = useCreativeAnalysis(runId, status);
  const img = analysis.data?.images ?? null;
  const done = status === 'COMPLETED';
  const failed = status === 'FAILED' || status === 'CANCELLED' || status === 'INTERRUPTED';
  return (
    <div data-testid="continue-progress" data-status={status ?? 'starting'} role="status" className={cn('space-y-2 rounded-xl border px-4 py-3 text-sm', done ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : failed ? 'border-red-300 bg-red-50 text-red-800' : 'border-accent/40 bg-accent-soft/40')}>
      <p className="flex items-center gap-2 font-medium">
        {done ? <Check className="h-4 w-4" /> : failed ? <AlertCircle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
        {done ? `The new campaign is ready: revision ${parentRevision + 1} of ${parentName}` : failed ? `The continuation ${status!.toLowerCase()}` : `${templatesOnly ? 'Rendering the missing template creatives' : 'Generating the missing images'} (revision ${parentRevision + 1} of ${parentName})…`}
      </p>
      <p className="text-xs">
        {templatesOnly ? 'No image request is made: the template creatives are rendered locally.' : img ? `Image requests started: ${img.requestsStarted} · generated: ${img.generated} · failed: ${img.failed}` : analysis.data ? `Images generated so far: ${analysis.data.progress.images} · failed: ${analysis.data.progress.imagesFailed}` : 'Waiting for the first image result…'}
        {run.data?.currentPhase && !done && !failed ? ` · ${run.data.currentPhase}` : ''}
      </p>
      {failed && <p className="text-xs">{run.data?.errorMessage ?? 'The run did not finish.'} The earlier campaign is unchanged and nothing was retried automatically.</p>}
      {done && run.data?.campaignId && (
        <Button data-testid="open-new-campaign" size="sm" onClick={() => onOpen(run.data!.campaignId!)}>
          Open the new campaign
        </Button>
      )}
    </div>
  );
}
