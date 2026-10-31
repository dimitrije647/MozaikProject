'use client';

import * as React from 'react';
import { AlertCircle, Check, ImageIcon } from 'lucide-react';
import { ApprovalBadge, ConceptsTab, FinalTab, FormatsTab, ImagesTab, LandingTab, ReviewTab } from '@/components/creative-views';
import { Badge } from '@/components/ui/badge';
import { useCampaign, useProject } from '@/lib/hooks';
import type { CampaignFull, FactoryOutcome } from '@/lib/types';
import { cn } from '@/lib/utils';

const TABS = ['Summary', 'Copy & concepts', 'Generated images', 'Channel layouts', 'Landing page', 'Quality review', 'Usage & download'] as const;
type Tab = (typeof TABS)[number];

/**
 * The finished campaign, read from the saved package (never from the live run): summary, copy, images, layouts, landing page,
 * review and the ZIP. It reuses the F4 views, so what is shown here is exactly what the F4 panel and the export contain.
 */
export function CampaignOutputs({ campaignId, projectId, outcome }: { campaignId: string; projectId: string; outcome: FactoryOutcome }) {
  const campaign = useCampaign(campaignId);
  const project = useProject(projectId);
  const [tab, setTab] = React.useState<Tab>('Summary');
  const c = campaign.data;
  const pkg = c?.package;
  if (campaign.isLoading) return <div className="h-48 animate-pulse rounded-2xl bg-cream-200" />;
  if (!c || !pkg) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">The saved campaign package could not be loaded.</p>;
  const audience = project.data?.intake?.targetAudience;
  return (
    <div id="campaign-outputs" className="scroll-mt-6 space-y-5">
      <div role="tablist" aria-label="Campaign outputs" className="flex flex-wrap gap-1 border-b border-cream-300/80">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'Summary' && <SummaryTab campaign={c} audience={audience ?? null} outcome={outcome} />}
        {tab === 'Copy & concepts' && <ConceptsTab pkg={pkg} />}
        {tab === 'Generated images' && <ImagesTab pkg={pkg} assets={c.assets} />}
        {tab === 'Channel layouts' && <FormatsTab pkg={pkg} assets={c.assets} />}
        {tab === 'Landing page' && <LandingTab pkg={pkg} campaignId={c.id} />}
        {tab === 'Quality review' && <ReviewTab pkg={pkg} />}
        {tab === 'Usage & download' && <FinalTab campaign={c} />}
      </div>
    </div>
  );
}

function SummaryTab({ campaign, audience, outcome }: { campaign: CampaignFull; audience: string | null; outcome: FactoryOutcome }) {
  const pkg = campaign.package!;
  const channels = [...new Set(pkg.copyVariants.map((v) => v.channel))];
  const ai = pkg.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded');
  const fallback = pkg.imageAssets.filter((a) => a.kind === 'image' && a.source === 'brand_gradient' && a.status !== 'superseded');
  const open = pkg.reviewFindings.filter((f) => (f.status === 'open' || f.status === 'unresolved') && (f.severity === 'blocker' || f.severity === 'major'));
  const u = pkg.usage;
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted">Campaign</p>
        <h3 className="text-2xl">{pkg.campaignName}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <ApprovalBadge status={pkg.approval.status} /> {pkg.approval.note}
        </p>
        {outcome === 'unresolved' || open.length > 0 ? (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {open.length} blocker/major review issue(s) could not be repaired. This campaign is NOT ready to publish; open the Quality review tab.
          </p>
        ) : null}
        {fallback.length > 0 && (
          <p role="alert" data-testid="summary-images-missing" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {fallback.length} of {pkg.concepts.length} concept(s) have no AI-generated image.{' '}
              {(() => {
                const all = (pkg.imageResults ?? []).filter((r) => r.outcome !== 'generated' && !!r.explanation);
                const real = all.filter((r) => r.requestAttempted || !r.explanation!.startsWith('Not attempted'));
                return [...new Set((real.length ? real : all).map((r) => r.explanation!))].slice(0, 2).join(' ') || 'See the Generated images tab for the reason.';
              })()}
            </span>
          </p>
        )}
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Item k="Target audience (your brief)" v={audience ?? 'not set in the brief'} />
        <Item k="Channels" v={channels.join(', ') || '—'} />
        <Item k="Creative concepts" v={pkg.concepts.map((c) => c.name).join(' · ') || '—'} />
        <Item k="Ad copy variants" v={`${pkg.copyVariants.length}${pkg.copyVariants.some((v) => v.version > 1) ? ` (${pkg.copyVariants.filter((v) => v.version > 1).length} revised after review)` : ''}`} />
        <Item k="Images" v={`${ai.length} of ${pkg.concepts.length} concept(s) have an AI-generated image${fallback.length ? ` · ${fallback.length} use a brand-colored background, NOT an AI image` : ''}`} />
        <Item k="Channel layouts" v={`${pkg.channelLayouts.length}${pkg.skippedLayouts.length ? ` · ${pkg.skippedLayouts.length} format(s) not exported` : ''}`} />
        <Item k="Landing page" v={pkg.landingContent ? 'content ready (local preview, not published)' : 'not produced'} />
        <Item k="Review" v={`${pkg.reviewFindings.length} finding(s) · ${pkg.revisions.filter((r) => r.status === 'applied').length} repair(s) applied · ${open.length} open blocker/major`} />
        <Item k="Text model" v={`${u.text.calls} call(s), ${u.text.totalTokens.toLocaleString()} tokens (this campaign step)`} />
        <Item k="Image model" v={u.images.model ? `${u.images.model} (${u.images.quality}, ${u.images.size}): ${u.images.requested} request(s), ${u.images.generated} generated, ${u.images.failed} failed` : 'none'} />
      </dl>
      {pkg.limitations.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Limitations</h5>
          <ul className="space-y-1 text-sm text-muted">
            {pkg.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge className="bg-cream-200 text-ink-600">
          <ImageIcon className="h-3 w-3" /> {ai.length ? 'Images are generated by your OpenAI image model' : 'No AI image in this campaign'}
        </Badge>
        <Badge className="bg-emerald-100 text-emerald-800">
          <Check className="h-3 w-3" /> Saved: survives a refresh and a restart
        </Badge>
      </p>
    </div>
  );
}

const Item = ({ k, v }: { k: string; v: string }) => (
  <div className="rounded-xl bg-cream-100 px-4 py-3">
    <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
    <dd className="mt-0.5 text-ink">{v}</dd>
  </div>
);
