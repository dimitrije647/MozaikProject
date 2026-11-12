'use client';

import * as React from 'react';
import { AlertCircle, Check, Clapperboard, Download, ExternalLink, ImageOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KIND_LABEL, PLATFORM_LABEL, SOCIAL_PLATFORMS, campaignZipUrl, type CampaignAssetViewData, type CampaignFullData, type CampaignPackageV4, type CopyVariantV4, type DeliverableRecordData } from '@/lib/campaign';
import { useCampaign, useStrategy } from '@/lib/hooks';
import type { CampaignStrategyReportData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * THE CAMPAIGN RESULT: one screen of usable marketing deliverables. Overview, strategy and messaging, social posts, social visuals, advertising,
 * print, sources and licenses, and the ZIP. Agent internals are not the result (they live in "How it was made" on the run). Campaigns made
 * before V4 (no deliverables plan) open in a simpler, read-only legacy view with the same download.
 */

const assetSrc = (a: { url: string }) => `/api${a.url}`;
const APPROVAL: Record<string, { label: string; tone: string }> = {
  approved: { label: 'Approved by the Quality Reviewer', tone: 'bg-emerald-100 text-emerald-800' },
  approved_with_notes: { label: 'Approved with notes', tone: 'bg-amber-100 text-amber-900' },
  unresolved: { label: 'Unresolved issues: not ready to publish', tone: 'bg-red-100 text-red-800' },
};

function Block({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={`result-${id}`} data-testid={`result-${id}`} aria-label={title} className="space-y-3 rounded-2xl border border-cream-300/80 bg-cream-50 p-5">
      <header>
        <h3 className="text-xl">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function ZipButton({ campaignId }: { campaignId: string }) {
  return (
    <Button asChild>
      <a data-testid="download-zip" href={campaignZipUrl(campaignId)} download>
        <Download className="h-4 w-4" /> Download ZIP
      </a>
    </Button>
  );
}

export function CampaignResult({ campaignId }: { campaignId: string }) {
  const c = useCampaign(campaignId);
  if (c.isLoading) return <div className="h-64 animate-pulse rounded-2xl bg-cream-200" />;
  if (!c.data) return <p className="text-sm text-red-700">The campaign could not be loaded.</p>;
  const data = c.data;
  if (!data.package) return <p className="text-sm text-muted">This campaign has no saved package (the run did not finish).</p>;
  return data.package.deliverables ? <V4Result data={data} pkg={data.package} /> : <LegacyResult data={data} pkg={data.package} />;
}

// ---- V4 -------------------------------------------------------------------------------------------------------------------------------------

function Visual({ item, asset, copy }: { item: DeliverableRecordData; asset: CampaignAssetViewData | undefined; copy?: CopyVariantV4 }) {
  return (
    <figure data-testid={`deliverable-${item.id}`} data-status={item.status} className="space-y-1.5 rounded-xl border border-cream-300/80 bg-white/70 p-2">
      {item.status === 'delivered' && asset ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetSrc(asset)} alt={`${item.label} (${item.width} x ${item.height})`} className="max-h-72 w-full rounded-md bg-cream-100 object-contain" loading="lazy" />
      ) : (
        <div className="flex h-40 items-center justify-center rounded-md bg-amber-50 px-3 text-center text-xs text-amber-900">
          <span>
            <AlertCircle className="mx-auto mb-1 h-4 w-4" />
            Not produced: {item.reason ?? 'no reason recorded'}
          </span>
        </div>
      )}
      <figcaption className="text-xs">
        <span className="font-medium">{item.label}</span> <span className="text-muted">{item.width} x {item.height}</span>
        <span className="ml-1">{item.status === 'delivered' ? (item.withPicture ? <Badge className="bg-sky-100 text-sky-800">real picture</Badge> : <Badge className="bg-cream-200 text-ink-600">typography-first</Badge>) : null}</span>
        {copy && <span className="mt-0.5 block text-ink-600">{copy.headline}</span>}
      </figcaption>
    </figure>
  );
}

function Post({ v }: { v: CopyVariantV4 }) {
  const s = v.videoScript;
  return (
    <article data-testid={`post-${v.id}`} className="space-y-2 rounded-xl border border-cream-300/80 bg-white/70 p-4 text-sm">
      <p className="font-semibold">{v.headline}</p>
      <p className="whitespace-pre-line text-ink-700">{v.body}</p>
      <p className="text-xs">
        <strong>CTA:</strong> {v.ctaText}
      </p>
      {v.hashtags.length > 0 && <p className="text-xs text-accent-hover">{v.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}</p>}
      {v.postingFormat && (
        <p className="text-xs text-muted">
          <strong>How to post:</strong> {v.postingFormat}
        </p>
      )}
      {s && (
        <div data-testid="video-script" className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-semibold text-violet-900">
            <Clapperboard className="h-3.5 w-3.5" /> Video concept and script ({s.durationSeconds}s) — script only, no video generated
          </p>
          <p className="mt-1">
            <strong>Hook:</strong> {s.hook}
          </p>
          <ol className="mt-1 space-y-1">
            {s.scenes.map((sc, i) => (
              <li key={i}>
                <span className="font-mono">{sc.seconds}</span> {sc.visual}
                {sc.onScreenText ? <> · on screen: “{sc.onScreenText}”</> : null}
                {sc.voiceover ? <> · voice: “{sc.voiceover}”</> : null}
              </li>
            ))}
          </ol>
          {s.soundNote && <p className="mt-1 text-muted">Sound: {s.soundNote}</p>}
        </div>
      )}
    </article>
  );
}

function StrategySection({ strategyId, pkg }: { strategyId: string; pkg: CampaignPackageV4 }) {
  const s = useStrategy(strategyId);
  const r = s.data?.report as CampaignStrategyReportData | undefined;
  return (
    <Block id="strategy" title="Strategy and messaging" hint="From the Marketing Strategist; the concepts below are built on it.">
      {s.isLoading && <div className="h-24 animate-pulse rounded-xl bg-cream-200" />}
      {r && (
        <div className="space-y-3 text-sm">
          <p>{r.executiveSummary}</p>
          {pkg.copywriting && (
            <p data-testid="voice-summary" className="rounded-lg bg-cream-100 px-3 py-2 text-xs text-ink-700">
              <span className="font-semibold">Writing style:</span> {pkg.copywriting.voice.tone}, {pkg.copywriting.voice.formality}, {pkg.copywriting.voice.personality.join(', ')}
              {pkg.copywriting.voice.sensitivity === 'regulated' ? ' · conservative claims (regulated industry)' : ''} · <span className="font-semibold">Purpose:</span> {pkg.copywriting.goal}
              {pkg.copywriting.voice.evidenceConfidence === 'low' ? ' · the voice is a cautious default; set the writing style in the campaign setup' : ''}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Positioning</p>
              <p>{r.positioning.statement.text}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Value proposition</p>
              <p>{r.valueProposition.text}</p>
            </div>
          </div>
          {r.mainMessages.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Key messages</p>
              <ul className="list-disc pl-5">
                {r.mainMessages.map((m, i) => (
                  <li key={i}>
                    {m.message} <span className="text-xs text-muted">({m.audience})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.contentPillars.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Content pillars</p>
              <ul className="grid gap-2 md:grid-cols-2">
                {r.contentPillars.map((p, i) => (
                  <li key={i} className="rounded-lg bg-white/70 px-3 py-2">
                    <strong>{p.name}</strong>
                    <span className="block text-xs text-ink-600">{p.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.channels.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Channel strategy</p>
              <ul className="space-y-1">
                {r.channels.map((c) => (
                  <li key={c.channel}>
                    <strong>{PLATFORM_LABEL[c.channel] ?? c.channel}</strong> <span className="text-xs text-muted">{c.role} · {c.approach}</span>: {c.rationale}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Campaign concepts</p>
        <ul className="mt-1 grid gap-2 md:grid-cols-2">
          {pkg.concepts.map((k) => (
            <li key={k.id} data-testid={`concept-${k.id}`} className="rounded-lg bg-white/70 px-3 py-2 text-sm">
              <strong>{k.name}</strong>
              <span className="block text-xs text-ink-600">{k.keyMessage}</span>
              <span className="block text-xs text-muted">
                {k.angle} · CTA “{k.ctaText}”
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Block>
  );
}

function V4Result({ data, pkg }: { data: CampaignFullData; pkg: CampaignPackageV4 }) {
  const d = pkg.deliverables!;
  const assetOf = new Map(data.assets.map((a) => [a.id, a]));
  const copyOf = new Map(pkg.copyVariants.map((v) => [v.id, v]));
  const platforms = (d.platforms.length ? d.platforms : [...SOCIAL_PLATFORMS]).filter((p) => PLATFORM_LABEL[p]);
  const [platform, setPlatform] = React.useState(platforms[0] ?? 'instagram');
  const posts = pkg.copyVariants.filter((v) => v.placement === 'social_post' && v.channel === platform);
  const social = d.items.filter((i) => i.kind === 'social_post');
  const ads = d.items.filter((i) => i.kind === 'web_ad' || i.kind === 'display_ad');
  const print = d.items.filter((i) => i.kind === 'billboard' || i.kind === 'flyer');
  const library = pkg.hybrid?.imagery?.library ?? [];
  const used = library.filter((l) => l.usedBySlots.length > 0);
  const approval = APPROVAL[pkg.approval.status];
  const unresolved = pkg.reviewFindings.filter((f) => pkg.approval.unresolvedFindingIds.includes(f.id));
  const copyFor = (kind: string) => pkg.copyVariants.filter((v) => v.placement === kind);
  const visuals = (items: DeliverableRecordData[]) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => (
        <Visual key={i.id} item={i} asset={i.assetId ? assetOf.get(i.assetId) : undefined} copy={i.variantId ? copyOf.get(i.variantId) : undefined} />
      ))}
    </div>
  );
  const copyBlock = (kinds: string[]) =>
    kinds.flatMap((k) => copyFor(k)).length > 0 && (
      <div className="grid gap-2 md:grid-cols-2">
        {kinds.flatMap((k) =>
          copyFor(k).map((v) => (
            <div key={v.id} className="rounded-lg bg-white/70 px-3 py-2 text-sm">
              <p className="text-[11px] uppercase tracking-wider text-muted">{KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k}</p>
              <p className="font-semibold">{v.headline}</p>
              {v.body && <p className="text-ink-700">{v.body}</p>}
              {v.description && <p className="text-xs text-muted">{v.description}</p>}
              <p className="text-xs">CTA: {v.ctaText}</p>
            </div>
          )),
        )}
      </div>
    );

  return (
    <div data-testid="campaign-result" className="space-y-5">
      <Block id="overview" title="Overview">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold">{pkg.campaignName}</p>
            <p className="text-xs text-muted">Created {formatDate(pkg.createdAt)} · {pkg.concepts.length} concept{pkg.concepts.length === 1 ? '' : 's'}</p>
            {approval && <Badge className={cn('mt-2', approval.tone)}>{approval.label}</Badge>}
          </div>
          <ZipButton campaignId={data.id} />
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
          {[
            ['Planned', d.counts.planned],
            ['Produced', d.counts.delivered],
            ['Missing', d.counts.missing],
            ['With a real picture', d.counts.withPicture],
            ['Typography-first', d.counts.typographyFirst],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-white/70 px-3 py-2">
              <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
              <dd className="text-lg font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="flex items-center gap-2 text-xs text-emerald-900">
          <ImageOff className="h-3.5 w-3.5" /> AI-generated images: 0. Every visual is rendered from the template collection, your palette, your logo and approved or licensed pictures.
        </p>
        {(d.counts.missing > 0 || d.notPlanned.length > 0) && (
          <div data-testid="result-missing" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
            <p className="font-medium">Not delivered (reported honestly, never replaced with placeholders):</p>
            <ul className="mt-1 list-disc pl-5">
              {d.items.filter((i) => i.status === 'missing').map((i) => (
                <li key={i.id}>
                  {i.label}: {i.reason ?? 'no reason recorded'}
                </li>
              ))}
              {d.notPlanned.map((n, i) => (
                <li key={`np-${i}`}>
                  {n.label}: {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(pkg.approval.note || unresolved.length > 0) && (
          <div className="text-xs">
            {pkg.approval.note && <p>{pkg.approval.note}</p>}
            {unresolved.map((f) => (
              <p key={f.id} className="flex items-start gap-2 text-red-800">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {f.severity}: {f.finding}
              </p>
            ))}
          </div>
        )}
      </Block>

      <StrategySection strategyId={data.f3StrategyId} pkg={pkg} />

      <Block id="posts" title="Social media posts" hint="Each platform has its own text, hook, CTA and hashtags.">
        <div role="tablist" aria-label="Platform" className="flex flex-wrap gap-1.5">
          {platforms.map((p) => (
            <button key={p} type="button" role="tab" aria-selected={platform === p} data-testid={`tab-${p}`} onClick={() => setPlatform(p)} className={cn('rounded-full border px-3 py-1 text-sm', platform === p ? 'border-accent bg-accent-soft/50 font-medium' : 'border-cream-300 bg-white text-muted hover:text-ink')}>
              {PLATFORM_LABEL[p]} ({pkg.copyVariants.filter((v) => v.placement === 'social_post' && v.channel === p).length})
            </button>
          ))}
        </div>
        {posts.length === 0 ? <p className="text-sm text-muted">No post was written for {PLATFORM_LABEL[platform]}.</p> : <div className="grid gap-3 md:grid-cols-2">{posts.map((v) => <Post key={v.id} v={v} />)}</div>}
      </Block>

      <Block id="social-visuals" title="Social media visuals" hint="Ready-to-use images in each platform's format.">
        {platforms.map((p) => {
          const items = social.filter((i) => i.channel === p);
          if (!items.length) return null;
          return (
            <div key={p} className="space-y-2">
              <p className="text-sm font-semibold">{PLATFORM_LABEL[p]}</p>
              {visuals(items)}
            </div>
          );
        })}
        {social.length === 0 && <p className="text-sm text-muted">No social visual was planned.</p>}
      </Block>

      <Block id="ads" title="Advertising assets" hint="Web banners and display ads with their own copy.">
        {ads.length ? visuals(ads) : <p className="text-sm text-muted">No advertising visual was produced.</p>}
        {copyBlock(['web_ad', 'display_ad'])}
      </Block>

      <Block id="print" title="Print assets" hint="Billboards and flyers.">
        {print.length ? visuals(print) : <p className="text-sm text-muted">No print design was produced.</p>}
        {copyBlock(['billboard', 'flyer'])}
      </Block>

      <Block id="sources" title="Sources and licenses" hint="Where every picture came from and under which rights. The ZIP contains the same information (sources/CREDITS.txt).">
        {used.length === 0 ? (
          <p className="text-sm text-muted">No picture was used: every visual is typography-first (brand colors, type and logo).</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {used.map((l) => (
              <li key={l.id} data-testid={`source-${l.id}`} className="rounded-lg bg-white/70 px-3 py-2">
                <strong>{l.name}</strong> <span className="text-xs text-muted">({l.source}{l.via === 'auto_stock' ? ', added from licensed stock' : ''})</span>
                <span className="block text-xs">
                  License: {l.license} · {l.verification}
                  {l.attributionRequired && l.attribution ? ` · credit required: ${l.attribution}` : l.attribution ? ` · ${l.attribution}` : ''}
                  {` · used in ${l.usedBySlots.length} visual${l.usedBySlots.length === 1 ? '' : 's'}`}
                </span>
                {l.pageUrl && (
                  <a href={l.pageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-hover hover:underline">
                    Source page <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {pkg.limitations.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            {pkg.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </Block>

      <Block id="download" title="Download">
        <div className="flex flex-wrap items-center gap-3">
          <ZipButton campaignId={data.id} />
          <p className="text-xs text-muted">One ZIP: strategy, social posts and visuals per platform, ads, print, brand, sources and licenses, and a README with anything that is missing.</p>
        </div>
      </Block>
    </div>
  );
}

// ---- campaigns made before V4 (read-only) -----------------------------------------------------------------------------------------------------

function LegacyResult({ data, pkg }: { data: CampaignFullData; pkg: CampaignPackageV4 }) {
  const shown = data.assets.filter((a) => a.status !== 'superseded' && a.status !== 'failed');
  return (
    <div data-testid="campaign-result-legacy" className="space-y-5">
      <Block id="overview" title="Overview" hint="This campaign was made before the current version (it may include AI images or a landing page). It is shown read-only.">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold">{pkg.campaignName}</p>
            <p className="text-xs text-muted">
              Created {formatDate(pkg.createdAt)} · {pkg.concepts.length} concept(s) · {pkg.copyVariants.length} text(s) · {shown.length} image(s)
              {data.imageModel ? ` · AI images by ${data.imageModel}` : ''}
            </p>
            {APPROVAL[pkg.approval.status] && <Badge className={cn('mt-2', APPROVAL[pkg.approval.status].tone)}>{APPROVAL[pkg.approval.status].label}</Badge>}
          </div>
          <ZipButton campaignId={data.id} />
        </div>
      </Block>
      <StrategySection strategyId={data.f3StrategyId} pkg={pkg} />
      <Block id="posts" title="Copy">
        <div className="grid gap-3 md:grid-cols-2">
          {pkg.copyVariants.map((v) => (
            <div key={v.id} className="rounded-lg bg-white/70 px-3 py-2 text-sm">
              <p className="text-[11px] uppercase tracking-wider text-muted">
                {PLATFORM_LABEL[v.channel] ?? v.channel} · {v.placement}
              </p>
              <p className="font-semibold">{v.headline}</p>
              <p className="whitespace-pre-line text-ink-700">{v.body}</p>
              <p className="text-xs">CTA: {v.ctaText}</p>
            </div>
          ))}
        </div>
      </Block>
      <Block id="social-visuals" title="Visuals">
        {shown.length === 0 ? (
          <p className="text-sm text-muted">No image is stored for this campaign.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {shown.map((a) => (
              <figure key={a.id} className="space-y-1 rounded-xl border border-cream-300/80 bg-white/70 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assetSrc(a)} alt={`${a.kind} ${a.format ?? ''}`} className="max-h-60 w-full rounded-md bg-cream-100 object-contain" loading="lazy" />
                <figcaption className="text-xs text-muted">
                  {a.kind} · {a.format ?? `${a.width} x ${a.height}`} · {a.source === 'ai_image' ? 'AI image (historical)' : a.source === 'template_render' ? 'template render' : a.source}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Block>
      {pkg.limitations.length > 0 && (
        <Block id="sources" title="Notes">
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            {pkg.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Block>
      )}
      <p className="flex items-center gap-2 text-xs text-muted">
        <Check className="h-3.5 w-3.5" /> The download keeps this campaign&apos;s own layout.
      </p>
    </div>
  );
}
