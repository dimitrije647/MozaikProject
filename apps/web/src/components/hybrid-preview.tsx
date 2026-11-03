'use client';

import * as React from 'react';
import { AlertCircle, Check, ClipboardCheck, Eye, ImageOff, Loader2, RotateCcw } from 'lucide-react';
import { fmtUsd } from '@/components/cost-ui';
import type { HybridView } from '@/components/hybrid-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CATEGORY_LABELS, useTemplates } from '@/lib/hybrid';
import type { HybridFactsInput, HybridPreviewData, HybridPreviewItem, StyleId, TemplateCard, TemplateCategory, VisualReferenceRecord } from '@/lib/hybrid';
import { NoAiImagerySummary, NoAiStatement } from '@/components/no-ai';
import type { LibraryItem } from '@/lib/images';
import { useImageLibrary } from '@/lib/images';
import type { FactoryPlan } from '@/lib/types';
import { cn } from '@/lib/utils';

/*
 * The FREE preview of a Hybrid Production plan and the Hybrid block of the reviewed plan. Everything shown here comes from the API:
 * the thumbnails are rendered by the server from each template's own SAMPLE text and a placeholder (or a brand) picture. It is a
 * preview of a plan, never a campaign: no original AI image exists yet and no request was made to OpenAI or Pinterest.
 */

const pretty = (s: string) => s.replace(/_/g, ' ');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

export interface HybridPreviewState {
  /** The request key (the form at the time of the preview): the preview is stale when the form no longer matches. */
  key: string;
  data: HybridPreviewData;
  /** Counts previews so that a confirmation of the direction belongs to one exact preview. */
  rev: number;
}

export const PERMISSION_LABEL: Record<VisualReferenceRecord['permission'], { label: string; tone: string }> = {
  owned_by_user: { label: 'Yours', tone: 'bg-emerald-100 text-emerald-800' },
  user_provided: { label: 'Yours', tone: 'bg-emerald-100 text-emerald-800' },
  original_to_launchpilot: { label: 'LaunchPilot original', tone: 'bg-sky-100 text-sky-800' },
  licensed: { label: 'Licensed', tone: 'bg-sky-100 text-sky-800' },
  link_only_not_analyzed: { label: 'Link only — not opened or analyzed', tone: 'bg-cream-200 text-ink-600' },
  platform_restricted_not_stored: { label: 'Pinterest — shown to you only, never stored, analyzed or sent to AI', tone: 'bg-amber-100 text-amber-900' },
};

const SOURCE_TEXT: Record<HybridPreviewItem['sourceKind'], string> = {
  ai_original: 'Uses the original AI image of this concept',
  brand_image: 'Uses a brand image of your project',
  none: 'No picture (picture-free template)',
};

const STRATEGY_NAME: Record<string, string> = { quality: 'Quality First', balanced: 'Balanced', economy: 'Economy' };

// ---- what a template needs --------------------------------------------------------------------------------------------------------------

const FACT_KEYS: (keyof HybridFactsInput)[] = ['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag'];
const NEED_LABEL: Record<string, string> = { offerDetail: 'offer detail', statLabel: 'statistic label', stat: 'statistic' };

/** What a template needs that the project (or the user) cannot supply for this slot: details only the user can give, a picture, a logo. Mirrors the server's availability rule. */
function missingFor(t: TemplateCard, item: Pick<HybridPreviewItem, 'sourceKind'>, facts: HybridFactsInput, hasLogo: boolean): string[] {
  const out: string[] = [];
  for (const r of t.requires) {
    if ((FACT_KEYS as string[]).includes(r)) {
      if (!facts[r as keyof HybridFactsInput]?.trim()) out.push(NEED_LABEL[r] ?? r);
    } else if (r === 'image') {
      if (item.sourceKind === 'none') out.push('a picture');
    } else if (r === 'logo') {
      if (!hasLogo) out.push('a logo');
    }
  }
  return out;
}

// ---- small pieces ---------------------------------------------------------------------------------------------------------------------------

function Stat({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl bg-cream-100 px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={cn('text-lg font-semibold leading-tight', tone)}>{v}</dd>
      {sub && <dd className="mt-0.5 text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-600">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Bars({ title, data, label, repeatAt, testId, wide }: { title: string; data: Record<string, number>; label?: (k: string) => string; repeatAt?: number; testId: string; wide?: boolean }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return (
    <div data-testid={testId}>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted">None.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([k, n]) => {
            const repeated = repeatAt !== undefined && n >= repeatAt;
            return (
              <li key={k} className={cn('grid items-center gap-2 text-xs', wide ? 'grid-cols-[minmax(0,15rem)_1fr_1.5rem]' : 'grid-cols-[minmax(0,7rem)_1fr_1.5rem]')}>
                <span className="truncate" title={label?.(k) ?? k}>
                  {label?.(k) ?? k}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-cream-200">
                  <span className={cn('block h-full rounded-full', repeated ? 'bg-amber-500' : 'bg-accent')} style={{ width: `${(n / max) * 100}%` }} />
                </span>
                <span className={cn('text-right font-semibold', repeated && 'text-amber-800')}>{n}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---- estimated spending, split by kind ------------------------------------------------------------------------------------------------------

/** Original image requests, template creatives and text calls kept apart, then the total. Every figure comes from the plan's cost estimate. */
export function HybridCostBreakdown({ plan }: { plan: FactoryPlan }) {
  const h = plan.hybrid;
  const c = plan.cost;
  const img = c.images;
  if (!h) return null;
  // NO AI HYBRID: the image cost is exactly $0 (0 requests), never "unavailable"
  const noAi = plan.preset === 'no_ai_hybrid';
  const imageValue = noAi || img.basis === 'none' ? '$0.00' : fmtUsd(img.typicalUsd);
  const requests = `${h.originals.paidRequests} request${h.originals.paidRequests === 1 ? '' : 's'}`;
  const imageSub =
    noAi ? (
      '0 image requests: NO AI HYBRID never generates images.'
    ) : img.basis === 'none' ? (
      img.note
    ) : img.basis === 'unavailable' ? (
      <>
        {requests} · {img.model} · {img.quality} · price not published
      </>
    ) : (
      <>
        {requests} × {fmtUsd(img.perImageUsd)} · {img.model} · {img.quality}
        {img.basis === 'upper_bound_auto' ? ' (upper bound: quality “auto” priced as “high”)' : ''}
      </>
    );
  const total = c.totals;
  return (
    <div data-testid="hybrid-cost" className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">Estimated spending, by kind (an estimate from published prices, not a bill)</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Stat k={noAi ? 'AI-generated images' : 'Original image requests (paid)'} v={imageValue} sub={imageSub} tone={!noAi && img.basis === 'unavailable' ? 'text-amber-900' : undefined} />
        <Stat k={`Template creatives planned: ${h.templateCreatives.planned} (free)`} v="$0.00" sub="Rendered locally: no image request, no cost per template creative." />
        <Stat k="Text-model calls (paid)" v={fmtUsd(c.text.typicalUsd)} sub={<>up to {plan.totals.textCallCap} calls · worst case {fmtUsd(c.text.maxUsd)}{c.text.model ? <> · {c.text.model}</> : null}</>} />
        <Stat k="Total estimate (typical)" v={fmtUsd(total.typicalUsd)} sub={`worst case ${fmtUsd(total.maxUsd)} · prices read on ${c.priceBookVerifiedAt}`} tone={total.typicalUsd === null ? 'text-amber-900' : undefined} />
      </dl>
    </div>
  );
}

// ---- the reviewed plan (PlanCard) -----------------------------------------------------------------------------------------------------------

/** The Hybrid summary of a reviewed plan: the headline, the counts, the split per concept, the rules and the spending by kind. */
export function HybridPlanBlock({ plan, directionApproved }: { plan: FactoryPlan; /** The user confirmed the direction card of the current preview (the plan itself cannot know). */ directionApproved?: boolean }) {
  const h = plan.hybrid;
  if (!h) return null;
  const approved = directionApproved ?? h.directionReview.approved;
  const model = plan.models.image?.id ?? h.originals.model;
  const noAi = plan.preset === 'no_ai_hybrid';
  return (
    <div data-testid="hybrid-plan" className="space-y-4">
      <div>
        <p className="text-base font-semibold" data-testid="hybrid-headline">
          {h.headline}
        </p>
        <p className="mt-1 text-xs text-muted">{noAi ? 'Every creative is rendered locally from a library template, your brand colors and logo and an existing or licensed picture (or typography when none fits): no image request and no cost per creative.' : h.templateCreatives.note}</p>
      </div>
      {noAi && h.noAi && (
        <>
          <NoAiStatement testId="no-ai-statement-plan" statement={h.noAi.statement} />
          <NoAiImagerySummary noAi={h.noAi} />
        </>
      )}
      {h.design?.collection && (
        <div data-testid="plan-design" className="space-y-1.5 rounded-xl bg-cream-100 px-4 py-3 text-xs">
          <p className="font-semibold text-ink">
            Campaign design: {h.design.collection.name} <span className="font-normal text-muted">(collection version {h.design.collection.version})</span>
          </p>
          {h.design.palette && (
            <p className="flex flex-wrap items-center gap-2">
              <span className="flex overflow-hidden rounded-md border border-cream-300">
                {Object.values(h.design.palette.palette).map((c) => (
                  <span key={c} className="h-4 w-5" style={{ background: c }} title={c} />
                ))}
              </span>
              <span className="text-muted">{h.design.palette.overridden.length ? `${h.design.palette.overridden.join(', ')} edited by you` : 'palette as detected or suggested'}</span>
            </p>
          )}
          {h.design.formats && <p className="text-muted">Formats: {h.design.formats.labels.join(', ') || 'follow the strategy channels'}</p>}
          {h.design.sources && !noAi && (
            <p data-testid="plan-sources" className="text-muted">
              Pictures: {h.design.sources.summary}.
            </p>
          )}
          {h.design.notes.map((n) => (
            <p key={n} className="text-muted">
              {n}
            </p>
          ))}
        </div>
      )}
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        {noAi ? (
          <Stat k="AI-generated images" v={0} sub={`0 image requests (cap ${h.noAi?.imageRequestCap ?? 0})`} />
        ) : (
          <Stat k="Original AI images (paid)" v={h.originals.planned} sub={`${h.originals.paidRequests} request(s) · ${model ?? 'no image model'} · ${h.originals.quality}`} />
        )}
        <Stat k="Template creatives (free)" v={h.templateCreatives.planned} sub="rendered locally" />
        <Stat k="Finished creatives" v={h.total} />
        {noAi ? <Stat k="Text-model requests (max)" v={h.noAi?.textModelRequestsMax ?? plan.totals.textCallCap} sub="the only paid requests" /> : <Stat k="Brand images found" v={h.brandImages} sub={`${h.library.templates} templates in the library`} />}
      </dl>
      {h.perConcept.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Concept</th>
                {!noAi && <th className="py-1 pr-3 font-medium">Original AI images</th>}
                <th className="py-1 pr-3 font-medium">Template creatives</th>
                <th className="py-1 font-medium">Channels</th>
              </tr>
            </thead>
            <tbody>
              {h.perConcept.map((c) => (
                <tr key={c.conceptId} className="border-t border-cream-300/70">
                  <td className="py-1 pr-3">{c.name}</td>
                  {!noAi && <td className="py-1 pr-3 font-semibold">{c.originals}</td>}
                  <td className="py-1 pr-3 font-semibold">{c.templates}</td>
                  <td className="py-1">{c.channels.map(pretty).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">A forecast with equal weights: the real concepts exist only after the research and copy phases run.</p>
        </div>
      )}
      <p className="text-xs text-muted">{noAi ? 'The template creatives are not AI images. The cost shown is for the text-model calls only: no image request is made, so image generation costs $0. It is an estimate, not a guarantee.' : h.note}</p>
      {h.rules.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{noAi ? 'How the creatives are planned' : 'How the originals and templates are planned'} ({h.rules.length})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {h.rules.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      {h.directionReview.required && (
        <p data-testid="direction-review-note" className={cn('flex items-start gap-2 text-xs', approved ? 'text-emerald-800' : 'text-amber-900')}>
          {approved ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {approved ? 'You confirmed the visual direction.' : 'You asked to review the visual direction first: run the free preview and confirm the direction card to enable Start.'}
        </p>
      )}
      {h.references.length > 0 && (
        <div className="text-xs">
          <p className="font-medium text-ink">References in these settings</p>
          <ul className="mt-1 space-y-1">
            {h.references.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span>{r.label}</span>
                <Badge className={cn('px-2 py-0.5 text-[10px]', PERMISSION_LABEL[r.permission as VisualReferenceRecord['permission']]?.tone ?? 'bg-cream-200 text-ink-600')}>{PERMISSION_LABEL[r.permission as VisualReferenceRecord['permission']]?.label ?? r.permission}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      <HybridCostBreakdown plan={plan} />
    </div>
  );
}

// ---- the visual direction -------------------------------------------------------------------------------------------------------------------

function Swatch({ name, hex }: { name: string; hex: string }) {
  const ok = HEX.test(hex);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="h-8 w-8 shrink-0 rounded-lg border border-black/10" style={ok ? { backgroundColor: hex } : undefined} aria-hidden />
      <span>
        <span className="block font-medium capitalize">{name}</span>
        <span className="block font-mono text-[11px] text-muted">{hex}</span>
      </span>
    </div>
  );
}

function DirectionCard({
  d,
  styleChosenByUser,
  designLocked,
  stale,
  busy,
  reviewRequired,
  approved,
  onApprove,
  onSwitchStyle,
}: {
  d: HybridPreviewData['visualDirection'];
  styleChosenByUser: boolean;
  /** the campaign design decides the collection and the palette: no other style is offered */
  designLocked: boolean;
  stale: boolean;
  busy: boolean;
  reviewRequired: boolean;
  approved: boolean;
  onApprove: (on: boolean) => void;
  onSwitchStyle: (id: StyleId) => void;
}) {
  const b = d.brief;
  const c = b.colors;
  return (
    <section data-testid="direction-card" aria-label="Visual direction" className="space-y-4 rounded-xl border border-accent/40 bg-white/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Visual direction</p>
          <h4 className="text-lg" data-testid="direction-style">
            {d.style.name}
          </h4>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className="bg-cream-200 text-ink-600">{designLocked ? 'collection and palette chosen by you' : styleChosenByUser ? 'style chosen by you' : 'style matched automatically'}</Badge>
          <Badge className="bg-cream-200 text-ink-600">confidence {b.confidence}</Badge>
          <Badge className="bg-cream-200 text-ink-600">{b.origin === 'deterministic' ? 'built locally' : b.origin === 'model_refined' ? 'refined by the text model' : 'approved by you'}</Badge>
        </div>
      </div>
      <p className="text-sm text-ink-600">{d.summary}</p>
      <p className="text-xs text-muted">{b.rationale}</p>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Palette</p>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {(['primary', 'secondary', 'accent', 'ink', 'paper'] as const).map((k) => (
            <Swatch key={k} name={k} hex={c[k]} />
          ))}
        </div>
        {c.notes && <p className="mt-1 text-xs text-muted">{c.notes}</p>}
      </div>

      <div className="text-xs">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Typography</p>
        <p className="mt-1">
          Headlines: <strong>{b.typography.headline}</strong> · Body: <strong>{b.typography.body}</strong>
        </p>
        {b.typography.notes && <p className="text-muted">{b.typography.notes}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Bullets title="Composition" items={b.composition} />
        <Bullets title="Mood" items={b.mood} />
        <Bullets title="Image subjects" items={b.imageSubjects} />
        <Bullets title="Image treatment" items={b.imageTreatment} />
      </div>

      {b.channelNotes.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Notes per channel ({b.channelNotes.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {b.channelNotes.map((n, i) => (
              <li key={i}>
                <strong className="text-ink">{pretty(n.channel)}:</strong> {n.note}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div data-testid="direction-references">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">References behind this direction</p>
        {b.references.length === 0 ? (
          <p className="text-xs text-muted">None.</p>
        ) : (
          <ul className="space-y-1.5">
            {b.references.map((r) => {
              const p = PERMISSION_LABEL[r.permission] ?? { label: r.permission, tone: 'bg-cream-200 text-ink-600' };
              return (
                <li key={r.id} data-permission={r.permission} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium">{r.label}</span>
                  <Badge className={cn('px-2 py-0.5 text-[10px]', p.tone)}>{p.label}</Badge>
                  <span className="text-muted">{r.used}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {b.limitations.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-900">
          {b.limitations.map((l, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
            </li>
          ))}
        </ul>
      )}

      {!designLocked && d.alternatives.length > 0 && (
        <div data-testid="direction-alternatives">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Other styles that fit (one click re-runs the preview)</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.alternatives.map((a) => {
              const current = a.id === b.styleId;
              return (
                <li key={a.id} className={cn('flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs', current ? 'border-accent bg-accent-soft/30' : 'border-cream-300/80 bg-cream-50')}>
                  <span className="min-w-0">
                    <strong className="block text-sm">{a.name}</strong>
                    <span className="text-muted">{a.reasons.join(' · ') || 'Matches the brief.'}</span>
                  </span>
                  <Button type="button" size="sm" variant="outline" data-testid={`alt-style-${a.id}`} disabled={current || busy} onClick={() => onSwitchStyle(a.id)}>
                    {current ? 'Current' : 'Use this style'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className={cn('rounded-xl border px-4 py-3 text-sm', reviewRequired ? 'border-amber-300 bg-amber-50' : 'border-cream-300/80 bg-cream-50')}>
        {reviewRequired ? (
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" data-testid="direction-approve" className="mt-1" checked={approved} disabled={stale || busy} onChange={(e) => onApprove(e.target.checked)} />
            <span>
              <strong>I reviewed this visual direction and I confirm it.</strong>
              <span className="block text-xs text-muted">{stale ? 'The settings changed since this preview: preview again to confirm the current direction.' : 'Start stays disabled until you confirm. Changing any setting asks for a new confirmation.'}</span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted">The campaign follows this direction. If you want to approve it before anything starts, switch on “Review the visual direction before starting” in the settings.</p>
        )}
      </div>
    </section>
  );
}

// ---- one planned template creative ------------------------------------------------------------------------------------------------------------

function SlotCard({ item, templates, templatesState, facts, hasLogo, overrideId, onOverride, busy, stale, noAi, picture }: { item: HybridPreviewItem; templates: TemplateCard[]; templatesState: 'loading' | 'error' | 'ready'; facts: HybridFactsInput; hasLogo: boolean; overrideId: string | undefined; onOverride: (slotId: string, templateId: string | null) => void; busy: boolean; stale: boolean; /** NO AI HYBRID: the picture is one of the user's approved pictures, never a placeholder for an AI image */ noAi?: boolean; picture?: LibraryItem | null }) {
  const t = item.thumbnail;
  const compatible = templates.filter((x) => x.status === 'active' && x.classes.includes(item.formatClass));
  const groups = new Map<TemplateCategory, TemplateCard[]>();
  for (const x of compatible) groups.set(x.category, [...(groups.get(x.category) ?? []), x]);
  const knownIds = new Set(compatible.map((x) => x.id));
  return (
    <li data-testid="slot-card" data-slot={item.slotId} data-template={item.templateId} data-origin={item.origin} className="flex flex-col gap-2 rounded-xl border border-cream-300/80 bg-cream-50 p-3 text-xs">
      <div className="relative flex min-h-[8rem] items-center justify-center overflow-hidden rounded-lg bg-cream-200">
        {t?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.url} alt={`Preview of ${item.templateName} for ${item.channel}, ${item.format}`} className="max-h-64 w-auto max-w-full object-contain" style={{ aspectRatio: `${item.width} / ${item.height}` }} />
        ) : (
          <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-muted">
            <ImageOff className="h-5 w-5" />
            <span>{t?.error ? `This preview could not be rendered: ${t.error}` : 'No preview image'}</span>
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-ink/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">Preview</span>
        {t?.url && t.placeholder && !noAi && <span className="absolute inset-x-0 bottom-0 bg-amber-100/95 px-2 py-1 text-center text-[10px] font-medium text-amber-900">Placeholder picture — the real original is generated when you start</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="text-sm">{item.templateName}</strong>
        <span className="font-mono text-[10px] text-muted">v{item.templateVersion}</span>
        <Badge className="bg-cream-200 px-2 py-0.5 text-[10px] text-ink-600">{CATEGORY_LABELS[item.category] ?? pretty(item.category)}</Badge>
        {item.origin === 'user_override' && <Badge className="bg-accent-soft px-2 py-0.5 text-[10px] text-accent-hover">your choice</Badge>}
        {item.origin === 'assisted' && <Badge className="bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">re-ranked by the text model</Badge>}
      </div>
      <p className="text-muted">
        <span className="font-mono text-[10px]">{item.slotId}</span> · {pretty(item.channel)} · {pretty(item.format)} · {item.width}×{item.height}
      </p>
      <p data-testid={noAi ? 'slot-picture' : undefined}>
        {noAi ? (item.imageId ? `Picture: ${picture?.title ?? 'an approved picture of your library'}${picture ? ` (${picture.rights.license})` : ''}` : 'Text-first: no approved picture fits this creative, so it is drawn with typography only') : SOURCE_TEXT[item.sourceKind]}
      </p>
      <p className="text-muted">{item.rationale}</p>
      {t && t.flags.length > 0 && <p className="text-[11px] text-amber-900">Render notes: {t.flags.map(pretty).join(', ')}</p>}
      <div className="mt-auto space-y-1">
        <label className="block text-[11px] font-medium text-ink-600">
          Template for this creative
          <select
            aria-label={`Template for ${item.slotId}`}
            data-testid="slot-override"
            className="mt-0.5 w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-1.5 text-xs text-ink"
            value={overrideId ?? ''}
            disabled={busy || stale || templatesState !== 'ready'}
            onChange={(e) => onOverride(item.slotId, e.target.value || null)}
          >
            <option value="">{templatesState === 'loading' ? 'Loading templates…' : templatesState === 'error' ? 'Template list unavailable' : `Automatic — ${item.templateName}`}</option>
            {overrideId && !knownIds.has(overrideId) && <option value={overrideId}>{overrideId} (not compatible with this format)</option>}
            {[...groups.entries()].map(([cat, list]) => (
              <optgroup key={cat} label={CATEGORY_LABELS[cat] ?? pretty(cat)}>
                {list.map((x) => {
                  const need = missingFor(x, item, facts, hasLogo);
                  return (
                    <option key={x.id} value={x.id} disabled={need.length > 0}>
                      {x.name} v{x.version}
                      {x.id === item.templateId ? ' (current)' : ''}
                      {need.length ? ` — needs ${need.join(', ')}` : ''}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </label>
        {overrideId && (
          <Button type="button" size="sm" variant="ghost" data-testid="slot-reset" disabled={busy || stale} onClick={() => onOverride(item.slotId, null)}>
            <RotateCcw className="h-3 w-3" /> Reset
          </Button>
        )}
      </div>
    </li>
  );
}

// ---- the preview section --------------------------------------------------------------------------------------------------------------------

export interface HybridPreviewSectionProps {
  state: HybridPreviewState | null;
  /** The key of the form right now; a preview with another key is stale. */
  currentKey: string;
  pending: boolean;
  error: string | null;
  onRun: () => void;
  /** The settings in the form (their facts decide which templates can be chosen by hand). */
  settings: HybridView;
  onSwitchStyle: (id: StyleId) => void;
  /** templateId null = back to the automatic choice for this slot. */
  onOverride: (slotId: string, templateId: string | null) => void;
  directionApproved: boolean;
  onApproveDirection: (on: boolean) => void;
  /** NO AI HYBRID: the pictures are the user's approved ones and nothing is ever generated. `projectId` names the picture of every creative. */
  noAi?: boolean;
  projectId?: string;
}

export function HybridPreviewSection({ state, currentKey, pending, error, onRun, settings, onSwitchStyle, onOverride, directionApproved, onApproveDirection, noAi, projectId }: HybridPreviewSectionProps) {
  const templates = useTemplates();
  const library = useImageLibrary(projectId ?? '', !!noAi && !!projectId);
  const pictures = new Map((library.data?.items ?? []).map((i) => [i.id, i]));
  const d = state?.data ?? null;
  const stale = !!state && state.key !== currentKey;
  const templatesState: 'loading' | 'error' | 'ready' = templates.data ? 'ready' : templates.isError ? 'error' : 'loading';
  const list = templates.data?.items ?? [];

  const items = d ? [...d.selection.items].sort((a, b) => a.conceptId.localeCompare(b.conceptId, undefined, { numeric: true }) || a.index - b.index) : [];
  const byConcept = new Map<string, { name: string; items: HybridPreviewItem[] }>();
  for (const it of items) {
    const g = byConcept.get(it.conceptId) ?? { name: it.conceptName, items: [] };
    g.items.push(it);
    byConcept.set(it.conceptId, g);
  }
  const conceptCounts: Record<string, number> = {};
  for (const g of byConcept.values()) conceptCounts[g.name] = g.items.length;
  const nameOfTemplate = (id: string) => items.find((i) => i.templateId === id)?.templateName ?? id;
  const h = d?.hybrid ?? null;
  const img = d?.models.image ?? null;

  return (
    <section data-testid="hybrid-preview" aria-label="Free preview of the Hybrid plan" className="space-y-4 rounded-2xl border border-dashed border-accent/50 bg-white/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Free preview</p>
          <h3 className="text-xl">Preview the plan</h3>
          <p className="mt-1 max-w-3xl text-xs text-muted">
            {noAi ? 'See the visual direction, the template and the picture for every creative and a real rendering of each one. It costs nothing and creates nothing: the previews are drawn on this server from the template library and your approved pictures. No image is generated.' : 'See the visual direction, the template for every creative and a real rendering of each one. It costs nothing and creates nothing: the pictures are drawn on this server from the template library.'}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button data-testid="hybrid-preview-run" onClick={onRun} loading={pending}>
            <Eye className="h-4 w-4" /> Preview the plan (free)
          </Button>
          <p className="text-[11px] text-muted" data-testid="hybrid-preview-free">
            No request is sent to OpenAI or Pinterest.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" data-testid="hybrid-preview-error" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {!d && !pending && !error && (
        <div data-testid="hybrid-preview-empty" className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-8 text-center text-sm text-muted">
          <ClipboardCheck className="mx-auto mb-2 h-5 w-5" />
          No preview yet. Press “Preview the plan (free)” to see the visual direction and the planned template creatives for the settings above.
        </div>
      )}

      {!d && pending && (
        <div data-testid="hybrid-preview-loading" aria-busy="true">
          <p className="mb-3 flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Rendering the previews on this server. No request is sent to OpenAI or Pinterest.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-56 animate-pulse rounded-xl bg-cream-200" />
            ))}
          </div>
        </div>
      )}

      {d && (
        <div className={cn('space-y-5 transition-opacity', (stale || pending) && 'opacity-60')} aria-busy={pending}>
          <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <p className="font-semibold uppercase tracking-wider">Preview only: this is not your campaign</p>
            <p className="mt-1">{d.sampleNote}</p>
            <p className="mt-1">Nothing was generated, nothing was saved and no request was made to OpenAI or Pinterest.</p>
          </div>
          {stale && (
            <p role="status" data-testid="hybrid-preview-stale" className="flex items-start gap-2 text-xs text-amber-900">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> The settings changed after this preview was made. Press “Preview the plan (free)” again to refresh it.
            </p>
          )}
          {pending && (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating the preview…
            </p>
          )}

          {d.blockers.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {d.blockers.map((b) => (
                <li key={b.code} className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {b.message}
                </li>
              ))}
            </ul>
          )}
          {d.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-900">
              {d.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}

          <div data-testid="hybrid-preview-counts">
            <p className="text-base font-semibold">{h?.headline ?? `${plural(items.length, 'template creative')} planned`}</p>
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {noAi ? <Stat k="AI-generated images" v={0} sub="never generated" /> : <Stat k="Original AI images (paid)" v={h?.originals.planned ?? 0} sub="generated only when you start" />}
              <Stat k="Template creatives (free)" v={h?.templateCreatives.planned ?? items.length} sub="rendered locally" />
              <Stat k="Finished creatives" v={h?.total ?? items.length} />
              {noAi ? <Stat k="Approved pictures" v={d.imageAllocation?.approved ?? 0} sub={`${d.library.eligible} of ${d.library.templates} templates usable here`} /> : <Stat k="Templates usable here" v={`${d.library.eligible} of ${d.library.templates}`} sub={`library ${d.library.version}`} />}
            </dl>
          </div>

          <DirectionCard d={d.visualDirection} styleChosenByUser={settings.style !== 'auto'} designLocked={!!settings.design} stale={stale} busy={pending} reviewRequired={settings.reviewDirection} approved={directionApproved} onApprove={onApproveDirection} onSwitchStyle={onSwitchStyle} />

          {noAi && d.imageAllocation && (
            <div data-testid="picture-allocation" className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Which approved picture each concept uses</p>
              <ul className="space-y-1 text-xs">
                {d.imageAllocation.perConcept.map((c) => (
                  <li key={c.conceptId} className="flex flex-wrap items-baseline gap-x-2">
                    <strong>{byConcept.get(c.conceptId)?.name ?? c.conceptId}</strong>
                    <span className="text-muted">{c.imageIds.length ? c.imageIds.map((id) => pictures.get(id)?.title ?? id).join(' · ') : 'no picture: text-first templates'}</span>
                  </li>
                ))}
              </ul>
              {d.imageAllocation.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 text-xs text-amber-900">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                </p>
              ))}
              <p className="text-[11px] text-muted">One picture may serve several creatives; each reuse is cropped differently. 20 creatives do not need 20 pictures.</p>
            </div>
          )}
          {!noAi && h && h.perConcept.length > 0 && (
            <div data-testid="original-placement" className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Where each original is used</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Concept</th>
                      <th className="py-1 pr-3 font-medium">Original AI images</th>
                      <th className="py-1 pr-3 font-medium">Feeds these template creatives</th>
                      <th className="py-1 font-medium">Other creatives</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.perConcept.map((c) => {
                      const slots = h.slots.filter((s) => s.conceptId === c.conceptId);
                      const fed = slots.filter((s) => s.source === 'ai_original');
                      const rest = slots.filter((s) => s.source !== 'ai_original');
                      return (
                        <tr key={c.conceptId} className="border-t border-cream-300/70 align-top">
                          <td className="py-1 pr-3">{c.name}</td>
                          <td className="py-1 pr-3 font-semibold">{c.originals}</td>
                          <td className="py-1 pr-3">{c.originals > 0 && fed.length ? fed.map((s) => s.slotId).join(', ') : '—'}</td>
                          <td className="py-1 text-muted">{rest.length ? `${rest.map((s) => s.slotId).join(', ')} (${rest.some((s) => s.source === 'brand_image') ? 'brand image' : 'no picture'})` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted">A template creative that uses an original takes the original of its own concept. Until you start, the pictures in the preview are placeholders.</p>
            </div>
          )}

          <div data-testid="hybrid-distribution" className="space-y-2 rounded-xl border border-cream-300/80 bg-cream-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Distribution</p>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)]">
              <Bars testId="dist-concept" title="By concept" data={conceptCounts} />
              <Bars testId="dist-channel" title="By channel" data={d.distribution.byChannel} label={pretty} />
              <Bars testId="dist-category" title="By category" data={d.distribution.byCategory} label={(k) => CATEGORY_LABELS[k as TemplateCategory] ?? pretty(k)} />
              <Bars testId="dist-template" title="By template" data={d.distribution.byTemplate} label={nameOfTemplate} repeatAt={3} wide />
            </div>
            <p className="text-[11px] text-muted">A template used three times or more is drawn in amber. Choose another template for a creative below if you want more variety.</p>
          </div>

          <div className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Planned template creatives ({items.length})</p>
            {items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">No template creative is planned for these settings (template creatives = 0, or no template fits).</p>
            ) : (
              [...byConcept.entries()].map(([cid, g]) => {
                const pc = h?.perConcept.find((c) => c.conceptId === cid);
                return (
                  <div key={cid} data-testid="concept-group" data-concept={cid} className="space-y-2">
                    <h4 className="flex flex-wrap items-baseline gap-2 text-base">
                      {g.name}
                      <span className="text-xs font-normal text-muted">
                        {pc && !noAi ? `${plural(pc.originals, 'original AI image')} + ${plural(g.items.length, 'template creative')}` : plural(g.items.length, 'template creative')}
                      </span>
                    </h4>
                    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {g.items.map((it) => (
                        <SlotCard key={it.slotId} item={it} templates={list} templatesState={templatesState} facts={settings.facts} hasLogo={d.brand.logo} overrideId={settings.overrides[it.slotId]} onOverride={onOverride} busy={pending} stale={stale} noAi={noAi} picture={it.imageId ? (pictures.get(it.imageId) ?? null) : null} />
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
          </div>

          {(d.selection.warnings.length > 0 || d.selection.rules.length > 0) && (
            <div className="space-y-2 text-xs">
              {d.selection.warnings.length > 0 && (
                <ul className="space-y-1 text-amber-900">
                  {d.selection.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}
              {d.selection.rules.length > 0 && (
                <details className="text-muted">
                  <summary className="cursor-pointer">How the templates were chosen ({d.selection.rules.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {d.selection.rules.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div data-testid="hybrid-requirements" className="space-y-2 rounded-xl border border-cream-300/80 bg-cream-50 p-4 text-xs">
            <p className="font-semibold uppercase tracking-wider text-muted">What the templates can use from your project</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {[
                ['Logo', d.requirements.logo],
                ['Brand colors', d.requirements.brandPalette],
                ['Brand images', `${d.requirements.brandImages} found`],
                ['Strategy', d.requirements.strategy],
              ].map(([k, v]) => (
                <li key={k} className={cn(/missing|not found/i.test(v) ? 'text-amber-900' : 'text-ink-600')}>
                  <strong>{k}:</strong> {v}
                </li>
              ))}
            </ul>
            {Object.keys(d.requirements.unlockableByFacts).length > 0 && (
              <p data-testid="unlockable">
                <strong>More templates would become available with these details:</strong>{' '}
                {Object.entries(d.requirements.unlockableByFacts)
                  .map(([k, n]) => `${NEED_LABEL[k] ?? k} (+${n})`)
                  .join(', ')}
                . {d.requirements.factsHint ?? ''}
              </p>
            )}
          </div>

          {noAi ? (
            <div data-testid="hybrid-preview-model" className="space-y-1 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-950">
              <p className="font-semibold uppercase tracking-wider">Image model</p>
              <p>None. NO AI HYBRID never selects an image model and never sends an image request.</p>
            </div>
          ) : (
          <div data-testid="hybrid-preview-model" className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 p-4 text-xs">
            <p className="font-semibold uppercase tracking-wider text-muted">Image model for the originals</p>
            <p>
              <strong className="font-mono text-sm">{img?.id && img.id !== 'auto' ? img.id : img ? 'chosen when you start' : 'none'}</strong>
              {img ? ` · quality ${img.quality}` : ' · no image model: no original AI image is generated'}
              {img?.mode === 'auto' && img.strategy ? ` · ${STRATEGY_NAME[img.strategy] ?? img.strategy}` : ''}
            </p>
            {img && (
              <p className="text-muted">
                {img.mode === 'auto' ? 'This is the model the Quality First strategy would pick from the models OpenAI documents; it is not checked against your key until you start.' : 'The model you chose; it is not checked against your key until you start.'} {img.note}
              </p>
            )}
          </div>
          )}

          <HybridCostBreakdown plan={d} />
          <p className="text-[11px] text-muted">This is the estimate for the preview of these settings. The plan review under “Review plan (free)” checks your OpenAI key and models and gives the figures you approve.</p>
        </div>
      )}
    </section>
  );
}
