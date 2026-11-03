'use client';

import * as React from 'react';
import { AlertCircle, ImageOff, Info, Play } from 'lucide-react';
import { fmtUsd } from '@/components/cost-ui';
import { NoAiStatement } from '@/components/no-ai';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { HybridBlockData, NoAiImageryData } from '@/lib/hybrid';
import { SOURCE_LABEL } from '@/lib/images';
import type { CampaignPackageData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * NO AI HYBRID, the finished campaign. Everything is read from the saved package (`pkg.hybrid.imagery` and `pkg.hybrid.counts`): the numbers are
 * what really happened, never what was planned. A creative that was not made is never counted, and a partial campaign says so with the reasons.
 */

const Card = ({ className, ...p }: React.HTMLAttributes<HTMLElement>) => <section className={cn('rounded-2xl border border-cream-300/80 bg-cream-50 p-4', className)} {...p} />;
const H = ({ children }: { children: React.ReactNode }) => <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h4>;
const num = (n: number) => n.toLocaleString('en-US');
const pretty = (s: string) => s.replace(/_/g, ' ');

/** The NO AI HYBRID block of a package, or null on every other campaign. */
export const noAiOf = (h: HybridBlockData | null | undefined): NoAiImageryData | null => (h?.imagery && h.imagery.mode === 'no_ai_hybrid' ? h.imagery : null);

function Line({ testId, label, value, hint }: { testId: string; label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <li data-testid={testId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-cream-300/70 py-1.5 first:border-t-0">
      <span className="text-sm">
        {label}: <strong className="tabular-nums">{value}</strong>
      </span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </li>
  );
}

/** The approved logo's small picture (the stored copy, through the authenticated file endpoint). */
function BrandLogoThumb({ assetId, name }: { assetId: string; name: string }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-cream-200 p-1 text-muted">
      {failed ? (
        <ImageOff className="h-4 w-4" aria-label="The logo could not be loaded" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/assets/${encodeURIComponent(assetId)}/file`} alt={name} loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

/**
 * GET CONTENT, the result: how many creatives carry the approved logo and, for every one that does not, why. Read from the saved package
 * (`hybrid.brand`); a campaign made without Get Content has no such block and shows nothing here.
 */
export function BrandLogoLine({ hybrid }: { hybrid: HybridBlockData }) {
  const b = hybrid.brand;
  if (!b) return null;
  const logo = b.logo?.approved ? b.logo : null;
  const total = b.withLogo + b.omitted.length;
  const nameOf = (slotId: string) => {
    const c = hybrid.creatives.find((x) => x.slotId === slotId);
    return c ? `${c.templateName} · ${c.width}×${c.height}` : slotId;
  };
  return (
    <div data-testid="brand-logo-line" data-applied={b.withLogo} data-total={total} className="space-y-2 rounded-xl bg-cream-100 px-3 py-2.5">
      <div className="flex items-center gap-3">
        {logo?.assetId && <BrandLogoThumb assetId={logo.assetId} name={logo.fileName ?? 'Approved brand logo'} />}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm">
            <strong>Brand logo</strong>: {logo ? `Approved logo applied in ${b.withLogo} of ${total} creative${total === 1 ? '' : 's'}` : 'no logo was approved for this campaign'}
          </p>
          <p className="text-xs text-muted">
            {logo ? `${logo.fileName ?? 'Approved logo'}${logo.source ? ` · ${pretty(logo.source)}` : ''}${logo.width && logo.height ? ` · ${logo.width} x ${logo.height}` : ''} · ` : 'The creatives use your brand name where a logo would go · '}
            {b.approvedPhotos} approved photograph{b.approvedPhotos === 1 ? '' : 's'}
            {b.contentApprovedAt ? ` · content approved ${formatDate(b.contentApprovedAt)}` : ''}
          </p>
        </div>
      </div>
      {logo && b.omitted.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-900">
            {b.omitted.length} creative{b.omitted.length === 1 ? '' : 's'} without the logo:
          </p>
          <ul data-testid="brand-logo-omitted" className="list-disc space-y-0.5 pl-5 text-xs text-amber-950">
            {b.omitted.map((o) => (
              <li key={o.slotId} data-testid={`brand-logo-omitted-${o.slotId}`} title={o.slotId}>
                <strong>{nameOf(o.slotId)}</strong>: {o.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NoAiSummary({ pkg, hybrid, onContinue }: { pkg: CampaignPackageData; hybrid: HybridBlockData; onContinue?: () => void }) {
  const im = noAiOf(hybrid);
  if (!im) return null;
  const t = hybrid.counts.templates;
  const total = hybrid.counts.total;
  const text = hybrid.counts.text;
  const sp = hybrid.counts.spending;
  const cost = pkg.cost ?? null;
  const partial = t.rendered < t.planned || total.delivered < total.planned;

  // why creatives are missing: the slots the planner could not build, then every other creative that failed or was skipped, then the package's own PARTIAL lines
  const missing = hybrid.creatives.filter((c) => c.status === 'failed' || c.status === 'skipped');
  const reasons: { key: string; text: string }[] = [
    ...im.blockedSlots.map((b) => ({ key: `b:${b.slotId}`, text: `${b.slotId}: ${b.reason}` })),
    ...missing.filter((c) => !im.blockedSlots.some((b) => b.slotId === c.slotId)).map((c) => ({ key: `c:${c.slotId}`, text: `${c.slotId} (${c.templateName}): ${c.reason ?? (c.status === 'failed' ? 'The render failed.' : 'It was not rendered.')}` })),
  ];
  const partialLines = pkg.limitations.filter((l) => /^PARTIAL/i.test(l.trim()));

  // the spending in words: known, uncertain or unknown. Text-model requests are the only paid ones; the image cost is exactly $0.
  const unpriced = cost?.unpricedRequests ?? 0;
  const uncertain = cost?.uncertainUsd ?? 0;
  const spendWord = !cost ? 'No dollar figure was recorded for this campaign.' : unpriced > 0 ? `Estimated: ${unpriced} text request${unpriced === 1 ? ' was' : 's were'} sent without a verified price, so part of the spending is unknown and this figure is a lower bound.` : uncertain > 0 ? `Known, plus up to ${fmtUsd(uncertain)} that may have been billed for requests that returned nothing (not included).` : 'Known: computed from the usage the provider reported, at published prices (not an invoice).';

  return (
    <div data-testid="no-ai-summary" className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Card className="space-y-3">
        <div className="space-y-1">
          <Badge className="bg-ink text-cream-100">NO AI HYBRID</Badge>
          <p className="text-xs text-muted">
            Template library v{hybrid.libraryVersion}
            {hybrid.selection ? ` · templates chosen ${hybrid.selection.mode === 'automatic' ? 'automatically' : hybrid.selection.mode === 'assisted' ? 'with model help' : 'by you'}` : ''}
          </p>
        </div>
        <NoAiStatement testId="no-ai-statement-result" />
        <ul>
          <Line testId="no-ai-discovered" label="Source images discovered" value={num(im.discovered)} hint="found on your website, in your repository, among your uploads and at licensed providers" />
          <Line testId="no-ai-approved" label="Approved images" value={num(im.approved)} hint={`${im.library.length} used in this campaign${im.autoAdded ? ` · ${im.autoAdded} added automatically` : ''}`} />
          <Line testId="no-ai-ai-images" label="AI-generated images" value={im.aiImagesGenerated} hint={`image requests: ${im.imageRequests}${im.refusedAttempts > 0 ? ` · ${im.refusedAttempts} attempt${im.refusedAttempts === 1 ? '' : 's'} refused before anything was sent` : ''}`} />
          <Line testId="no-ai-templates" label="Template creatives generated" value={num(t.rendered)} hint={`of ${num(t.planned)} planned${t.failed ? ` · ${t.failed} failed` : ''}${t.skipped ? ` · ${t.skipped} not rendered` : ''}`} />
          <Line testId="no-ai-total" label="Total final creatives" value={num(total.delivered)} hint={`of ${num(total.planned)} planned · only files that exist are counted`} />
        </ul>
        <BrandLogoLine hybrid={hybrid} />
        <p className="text-xs text-muted">Template creatives are rendered locally from a library template, your brand colors and logo and an existing or licensed picture (typography only when none fits). They are not AI images.</p>
      </Card>

      <Card data-testid="no-ai-spending" className="space-y-3">
        <H>Spending and requests</H>
        <ul>
          <Line testId="no-ai-text-calls" label="Text-model requests" value={num(text.calls)} hint={`${num(text.inputTokens + text.outputTokens)} tokens (${num(text.inputTokens)} in / ${num(text.outputTokens)} out)`} />
          <Line testId="no-ai-spent" label="Known spending" value={fmtUsd(sp.spentUsd)} hint={`text ${fmtUsd(sp.textUsd)}`} />
          <Line testId="no-ai-image-cost" label="Image generation" value={fmtUsd(sp.imageUsd ?? 0)} hint="no image request was made" />
          <Line testId="no-ai-approved-usd" label="Approved budget" value={sp.approvedUsd === null ? 'no limit set' : fmtUsd(sp.approvedUsd)} />
        </ul>
        <p data-testid="no-ai-spend-word" className={cn('text-xs', unpriced > 0 || uncertain > 0 || !cost ? 'text-amber-900' : 'text-muted')}>
          {spendWord}
        </p>
        <p className="text-xs text-muted">{sp.note}</p>
      </Card>

      {partial && (
        <Card data-testid="no-ai-partial" role="alert" className="space-y-3 border-amber-300 bg-amber-50 lg:col-span-2">
          <p className="flex items-start gap-2 text-sm font-semibold text-amber-950">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Partial campaign: {num(t.rendered)} of {num(t.planned)} template creatives were made.
            </span>
          </p>
          {reasons.length > 0 ? (
            <ul data-testid="no-ai-blocked" className="list-disc space-y-0.5 pl-9 text-xs text-amber-950">
              {reasons.map((r) => (
                <li key={r.key}>{r.text}</li>
              ))}
            </ul>
          ) : (
            <p className="pl-6 text-xs text-amber-950">No reason was recorded for the missing creatives.</p>
          )}
          {partialLines.length > 0 && (
            <ul className="space-y-1 pl-6 text-xs text-amber-950">
              {partialLines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          <div data-testid="no-ai-continue-box" className="space-y-2 rounded-xl bg-white/70 px-4 py-3 text-xs text-ink-600">
            <p className="font-medium text-ink">Continue with new images</p>
            <p>
              Add or approve more pictures (upload your own, approve website or GitHub pictures, or allow licensed stock) in the Campaign Design step, then start again with “Continue from saved work” and “Produce a new creative round”. The saved research, audit and strategy (F1 to F3) are reused and not paid for again; only the creative round runs, with a new budget approval. Nothing is generated.
            </p>
            {onContinue && (
              <Button type="button" size="sm" variant="outline" data-testid="no-ai-continue" onClick={onContinue}>
                <Play className="h-3.5 w-3.5" /> Continue with new images
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/** The stored copy of a library picture (library id === asset id), through the authenticated file endpoint. */
function PictureThumb({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-cream-200 text-muted">
      {failed ? (
        <ImageOff className="h-5 w-5" aria-label="The picture could not be loaded" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/assets/${encodeURIComponent(id)}/file`} alt={name} loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

/** The pictures this campaign used with their source and rights, the credits that must be shown, the providers and the notes. */
export function NoAiImagesUsed({ pkg, hybrid }: { pkg: CampaignPackageData; hybrid: HybridBlockData }) {
  const im = noAiOf(hybrid);
  if (!im) return null;
  const nameOf = (id: string) => im.library.find((l) => l.id === id)?.name ?? id;
  const conceptName = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? hybrid.selection?.items.find((i) => i.conceptId === id)?.conceptName ?? id;
  const credits = im.library.filter((l) => l.attributionRequired || l.attribution);
  return (
    <div data-testid="no-ai-images-used" className="space-y-5">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <H>Pictures used</H>
          <span className="text-xs text-muted">
            {im.library.length} picture{im.library.length === 1 ? '' : 's'} · AI-generated images: {im.aiImagesGenerated} · image requests: {im.imageRequests}
          </span>
        </div>
        {im.library.length === 0 ? (
          <p data-testid="no-ai-no-pictures" className="rounded-xl border border-dashed border-cream-300 bg-cream-100/60 px-4 py-5 text-center text-sm text-muted">
            No picture was used: every creative is text-first (typography, colors and the template only). Approve pictures in the Campaign Design step and run a new creative round to use them.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {im.library.map((l) => (
              <li key={l.id} data-testid={`no-ai-image-${l.id}`} className="flex gap-3 rounded-xl bg-cream-100 p-2.5 text-xs">
                <PictureThumb id={l.id} name={l.name} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-sm font-medium" title={l.name}>
                    {l.name}
                  </p>
                  <p className="text-muted">
                    {SOURCE_LABEL[l.source]}
                    {l.via === 'auto_stock' ? ' · added automatically' : ''}
                    {l.width && l.height ? ` · ${l.width} x ${l.height}` : ''}
                  </p>
                  <p>
                    License: {l.license} <span className="text-muted">({l.verification.replace(/_/g, ' ')})</span>
                  </p>
                  {l.attribution && (
                    <p>
                      Credit: {l.attribution}
                      {l.attributionRequired && <Badge className="ml-1.5 bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">credit required</Badge>}
                    </p>
                  )}
                  <p className="text-muted">Used by {l.usedBySlots.length} creative{l.usedBySlots.length === 1 ? '' : 's'}</p>
                  {l.pageUrl && (
                    <a href={l.pageUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                      source
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {credits.length > 0 && (
        <Card data-testid="no-ai-credits" className="space-y-2">
          <H>Credits</H>
          <ul className="space-y-1 text-sm">
            {credits.map((l) => (
              <li key={l.id}>
                <strong>{l.name}</strong>: {l.attribution ?? 'credit required, but the provider gave no text'} <span className="text-xs text-muted">({l.license}{l.attributionRequired ? ', credit required' : ''})</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Credits are recorded with the campaign. Show the ones marked “credit required” wherever you publish the creatives.</p>
        </Card>
      )}

      {im.perConcept.length > 0 && (
        <Card className="space-y-2">
          <H>Which picture each concept used</H>
          <ul className="space-y-1 text-xs">
            {im.perConcept.map((c) => (
              <li key={c.conceptId} className="flex flex-wrap items-baseline gap-x-2">
                <strong>{conceptName(c.conceptId)}</strong>
                <span className="text-muted">{c.imageIds.length ? c.imageIds.map(nameOf).join(' · ') : 'no picture: text-first templates'}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(im.providers.length > 0 || im.notes.length > 0) && (
        <Card className="space-y-2">
          <H>Providers and notes</H>
          {im.providers.length > 0 && (
            <ul data-testid="no-ai-run-providers" className="space-y-1 text-xs">
              {im.providers.map((p) => (
                <li key={p.id}>
                  <strong>{p.label}</strong>: {p.status}
                  {p.count ? ` · ${p.count} result${p.count === 1 ? '' : 's'}` : ''}
                  {p.message ? ` — ${p.message}` : ''}
                </li>
              ))}
            </ul>
          )}
          {im.notes.map((n, i) => (
            <p key={i} className="flex items-start gap-2 text-xs">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" /> <span>{n}</span>
            </p>
          ))}
        </Card>
      )}
    </div>
  );
}
