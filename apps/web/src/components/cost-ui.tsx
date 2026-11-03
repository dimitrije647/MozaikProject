'use client';

import * as React from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import type { BudgetOptionData, BudgetStatus, CostEstimateData, FactoryPlan } from '@/lib/types';
import { cn } from '@/lib/utils';

/*
 * The cost estimate and the spending consent, shared by the full-campaign plan and the image-only continuation. Every dollar figure
 * comes from the API (published prices read on a stated date, token volumes measured or assumed): nothing is computed or guessed here
 * except comparing the budget the user typed with those figures. A null amount is shown as "Cost estimate unavailable", never as 0.
 * There is ONE campaign budget: the text agents, the images, the reviews and the repairs all draw on the same total.
 */

export const COST_UNAVAILABLE = 'Cost estimate unavailable';

/** A dollar amount; null = unavailable. Cents normally, three decimals below ten cents (per-image prices). */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return COST_UNAVAILABLE;
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 3 : 2)}`;
}

/** A narrow table cell: the short word, with the full "Cost estimate unavailable" as its tooltip. The headline figures always show the full text. */
const cell = (n: number | null | undefined) => (n === null || n === undefined ? <span title={COST_UNAVAILABLE}>unavailable</span> : fmtUsd(n));
const up2 = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
const PHASE_TITLE = { discovery: 'F1 Product Discovery', audit: 'F2 Marketing Audit', strategy: 'F3 Market Research & Strategy', creative: 'F4 Creative Production' } as const;

// ---- the ONE campaign budget the user types -------------------------------------------------------------------------------------------------

/** The budget as the API accepts it: 0.01 to 500 dollars with at most two decimals. null = not a valid amount (yet). */
export function parseLimit(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0.01 && n <= 500 ? n : null;
}

/** The same comparison the API makes between the approved budget and the estimate. */
export function limitStatus(value: number, cost: CostEstimateData): BudgetStatus {
  const { typicalUsd: t, maxUsd: m } = cost.totals;
  if (t === null) return cost.totals.knownPartUsd > value ? 'below_estimate' : 'unknown';
  if (value < t) return 'below_estimate';
  if (m !== null && value < m) return 'may_stop_early';
  return 'within';
}

/**
 * The suggested budget: the preset's target when the estimate fits it, else the "raise the budget" option's value. null = no suggestion
 * (for instance while the image price is unknown: no number can be suggested honestly).
 */
export function suggestedLimit(cost: CostEstimateData): number | null {
  const { targetUsd } = cost.budget;
  const { typicalUsd } = cost.totals;
  if (typicalUsd !== null && targetUsd !== null && typicalUsd <= targetUsd) return targetUsd;
  return cost.budget.options.find((o) => o.id === 'raise_budget')?.set.approvedBudgetUsd ?? null;
}

/**
 * The typed budget and the confirmation. The checkbox is bound to the exact plan (scope) and amount it was ticked for, so changing either
 * un-ticks it: a confirmation never carries over to a different estimate. There is exactly ONE amount; nobody splits it.
 */
export function useSpendingConsent(scope: string, cost: CostEstimateData | null) {
  const [limit, setLimit] = React.useState('');
  const [ack, setAck] = React.useState<string | null>(null);
  const value = parseLimit(limit);
  const status = value !== null && cost ? limitStatus(value, cost) : null;
  const key = `${scope}|${value}`;
  const consent = value !== null && ack === key;
  const setConsent = (on: boolean) => setAck(on && value !== null ? key : null);
  return { limit, setLimit, value, status, consent, setConsent, ready: value !== null && consent && status !== 'below_estimate' };
}
export type SpendingConsentState = ReturnType<typeof useSpendingConsent>;

const HINT: Record<Exclude<BudgetStatus, 'no_budget'>, { tone: string; text: (v: number, c: CostEstimateData) => string }> = {
  within: { tone: 'text-emerald-800', text: (v, c) => `${fmtUsd(v)} covers the estimate (typical ${fmtUsd(c.totals.typicalUsd)}, worst case ${fmtUsd(c.totals.maxUsd)}). Money that one kind of work does not use stays available for the rest.` },
  may_stop_early: { tone: 'text-amber-900', text: (v, c) => `${fmtUsd(v)} covers the typical estimate (${fmtUsd(c.totals.typicalUsd)}) but not the worst case (${fmtUsd(c.totals.maxUsd)}). If real usage is higher, requests are refused before they are sent: the required analysis and the required images come before optional checks, and the campaign is saved as incomplete if something required cannot be paid for.` },
  below_estimate: { tone: 'text-red-700', text: (v, c) => `${fmtUsd(v)} is below ${c.totals.typicalUsd === null ? `the part of this plan that can already be priced (${fmtUsd(c.totals.knownPartUsd)})` : `the typical estimate of ${fmtUsd(c.totals.typicalUsd)}`}: the run could not finish. Raise the budget or change the plan.` },
  unknown: { tone: 'text-amber-900', text: (v, c) => (c.images.basis === 'unavailable' ? `Image pricing is not available. Your approved campaign budget of ${fmtUsd(v)} is an application-level spending target, not a guaranteed billing cap for unpriced requests.` : `The estimate is unavailable for part of this plan, so ${fmtUsd(v)} cannot be compared with it. The budget is still enforced for every request that can be priced.`) },
};

/**
 * Shown INSIDE the budget approval when the image price is not published: the exact image model, the words "Image pricing unavailable", the
 * number of image requests, the warning, and the ways to keep the cost bounded. There is no separate checkbox: ticking the one approval also
 * accepts this, and the approval names the maximum number of image requests (computed from the plan, sent automatically).
 */
export function ImagePricingNotice({ cost, cap, onApply, allowImageFree = true }: { cost: CostEstimateData; cap: number; onApply?: (o: BudgetOptionData) => void; allowImageFree?: boolean }) {
  const img = cost.images;
  if (img.basis !== 'unavailable') return null;
  const alternatives = (img.alternatives ?? []).filter((o) => allowImageFree || o.id !== 'image_free');
  return (
    <div data-testid="image-pricing-notice" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      <p className="text-[11px] font-semibold uppercase tracking-wider">Image pricing</p>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt className="text-[11px] uppercase tracking-wider">Image model</dt>
          <dd data-testid="pricing-model" className="font-mono text-sm font-semibold">{img.model ?? 'none'}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider">Price</dt>
          <dd data-testid="pricing-status" className="text-sm font-semibold">Image pricing unavailable</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider">Image requests</dt>
          <dd data-testid="pricing-requests" className="text-sm font-semibold">
            {img.count} planned, at most {cap}
          </dd>
        </div>
      </dl>
      <p data-testid="pricing-warning">
        <strong>Image pricing is not available. Your approved campaign budget is an application-level spending target, not a guaranteed billing cap for unpriced requests.</strong> Actual charges may differ from the estimates. What is enforced: no more than {cap} image request(s) are sent, the first image goes alone, and the rest of the campaign is then protected with its real cost; nothing is started when nothing is left.
      </p>
      {alternatives.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-medium">To keep the image cost bounded you can instead choose:</p>
          <ul className="space-y-1.5">
            {alternatives.map((o) => (
              <li key={o.id + (o.set.imageModel ?? '')} data-testid="price-alternative" data-option={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button type="button" size="sm" variant="outline" onClick={() => onApply?.(o)}>
                  {o.label}
                </Button>
                <span className="min-w-0 flex-1 text-ink-600">{o.detail}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px]">Nothing changes until you press a button; then review the plan again.</p>
        </div>
      )}
    </div>
  );
}

/** The ONE budget field, the ONE confirmation and (as children) the Start button, which the caller keeps disabled until `spend.ready`. */
export function SpendingConsent({ spend, cost, unified, onApplyOption, noAi, children }: { spend: SpendingConsentState; cost: CostEstimateData; /** Image pricing and the image-request maximum (computed from the plan). `allowImageFree` false = do not offer "run without images". */ unified?: { imageRequestCap: number; priceUnavailable: boolean; allowImageFree?: boolean }; onApplyOption?: (o: BudgetOptionData) => void; /** NO AI HYBRID: only text-model requests are paid; image requests are zero, not unknown. */ noAi?: boolean; children?: React.ReactNode }) {
  const t = cost.totals;
  const quick = [
    ['typical estimate', t.typicalUsd === null ? null : up2(t.typicalUsd)],
    ['worst case', t.maxUsd === null ? null : up2(t.maxUsd)],
  ] as [string, number | null][];
  const hint = spend.status && spend.status !== 'no_budget' ? { tone: HINT[spend.status].tone, text: HINT[spend.status].text(spend.value!, cost) } : null;
  return (
    <div data-testid="spending-consent" className="space-y-3 rounded-xl border border-accent/40 bg-accent-soft/30 px-4 py-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Approve ONE campaign budget to start</p>
        <p className="mt-1 text-xs text-muted">
          {noAi ? 'This plan makes paid text-model requests only; no image request is ever made. Nothing is sent until you set the budget, confirm it and press Start.' : 'This plan makes paid OpenAI requests. Nothing is sent until you set the budget, confirm it and press Start.'}
        </p>
      </div>
      {unified?.priceUnavailable && <ImagePricingNotice cost={cost} cap={unified.imageRequestCap} onApply={onApplyOption} allowImageFree={unified.allowImageFree !== false} />}
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted">
          Total campaign budget (USD)
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-ink">$</span>
            <Input data-testid="spending-limit" inputMode="decimal" aria-label="Total campaign budget in US dollars" placeholder="e.g. 3.00" className="h-10 w-32" value={spend.limit} onChange={(e) => spend.setLimit(e.target.value)} />
          </div>
        </label>
        <div className="flex flex-wrap items-center gap-2 pb-1 text-xs text-muted">
          {quick.map(([name, v]) =>
            v === null ? null : (
              <Button key={name} type="button" size="sm" variant="outline" onClick={() => spend.setLimit(String(v))}>
                Use the {name} ({fmtUsd(v)})
              </Button>
            ),
          )}
        </div>
      </div>
      <p data-testid="shared-budget-note" className="text-[11px] text-muted">
        One budget for everything: the text agents, the images, the reviews and the repairs all draw on this total. Money one kind of work does not use stays available for the rest, and nothing is spent just to use it up. The required analysis and the required original images are protected from optional checks. For orientation only (these are estimates, not separate budgets): text agents about {fmtUsd(cost.text.typicalUsd)}, {noAi ? 'AI images $0.00 (none are generated, so there is no image cost to estimate).' : `images about ${fmtUsd(cost.images.typicalUsd)}.`}
      </p>
      {spend.limit.trim() !== '' && spend.value === null && <p role="alert" className="text-xs text-red-700">Enter an amount from $0.01 to $500 with at most two decimals.</p>}
      {spend.value !== null && hint && (
        <p data-testid="limit-status" data-status={spend.status} className={cn('flex items-start gap-2 text-xs', hint.tone)}>
          {spend.status === 'within' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />} {hint.text}
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input data-testid="consent-checkbox" type="checkbox" className="mt-1" checked={spend.consent} disabled={spend.value === null} onChange={(e) => spend.setConsent(e.target.checked)} />
        <span data-testid="unified-consent-text">
          I approve up to <strong>{spend.value !== null ? fmtUsd(spend.value) : '$…'}</strong> in estimated campaign spending, subject to the disclosed limitations of provider billing.
          {unified?.priceUnavailable && (
            <>
              {' '}
              Image pricing is not available for <strong className="font-mono">{cost.images.model ?? 'the image model'}</strong>: the dollar amount cannot be guaranteed as an external billing cap, and this approval also covers at most <strong>{unified.imageRequestCap}</strong> image request(s).
            </>
          )}
        </span>
      </label>
      <p className="text-[11px] text-muted">
        LaunchPilot checks this budget before every paid request and refuses a request that would knowingly exceed it. It is not an OpenAI billing cap: a request that times out may still be billed, and it is then counted as spent, never as free.
      </p>
      {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
    </div>
  );
}

// ---- the estimate ---------------------------------------------------------------------------------------------------------------------------

/** The four ways out of a plan that does not fit. A button applies its `set` to the form only when the user clicks it. */
export function BudgetOptions({ budget, onApply }: { budget: CostEstimateData['budget']; onApply?: (o: BudgetOptionData) => void }) {
  if (budget.status === 'no_budget' && budget.options.length === 0) return null;
  return (
    <div data-testid="budget-options" data-status={budget.status} className={cn('space-y-2 rounded-xl border px-4 py-3 text-xs', budget.status === 'below_estimate' || budget.options.length > 0 ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-cream-300/80 bg-cream-50 text-muted')}>
      <p className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {budget.message}
      </p>
      {budget.options.length > 0 && (
        <ul className="space-y-2">
          {budget.options.map((o, i) => (
            <li key={`${o.id}-${i}`} data-testid="budget-option" data-option={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button type="button" size="sm" variant="outline" onClick={() => onApply?.(o)}>
                {o.label}
              </Button>
              <span className="min-w-0 flex-1 text-ink-600">
                {o.detail} Estimated total: {fmtUsd(o.estimatedTotalUsd)}.
              </span>
            </li>
          ))}
        </ul>
      )}
      {budget.options.length > 0 && <p className="text-[11px]">Nothing changes until you press a button, and the image count is never reduced by itself. After a change, review the plan again to see the new estimate.</p>}
    </div>
  );
}

function Cell({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl bg-cream-100 px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={cn('text-lg font-semibold leading-tight', tone)}>{v}</dd>
      {sub && <dd className="mt-0.5 text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

/** Estimated spending: text, images, the total (typical and worst case), the price date, the assumptions and every warning. */
export function CostEstimateCard({ cost, tokenBudgets, onApply, noAi }: { cost: CostEstimateData; tokenBudgets?: FactoryPlan['tokenBudgets']; onApply?: (o: BudgetOptionData) => void; /** NO AI HYBRID: the image cost is exactly $0 (0 requests), never "unavailable". */ noAi?: boolean }) {
  const img = cost.images;
  const t = cost.totals;
  const textPhases = cost.text.phases.filter((p) => p.runs);
  const limit = cost.text.maxOutputTokensLimit;
  return (
    <div data-testid="cost-estimate" data-available={cost.available ? 'yes' : 'no'} className="space-y-3 rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Estimated OpenAI spending (an estimate, not a bill)</p>
        <p className="text-[11px] text-muted">
          Prices read on {cost.priceBookVerifiedAt}
          {cost.sources.pricing ? (
            <>
              {' '}
              ·{' '}
              <a href={cost.sources.pricing} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
                OpenAI pricing
              </a>
            </>
          ) : null}
        </p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Cell k="Text models" v={fmtUsd(cost.text.typicalUsd)} sub={<>worst case {fmtUsd(cost.text.maxUsd)} · includes the visual review{cost.text.model ? <> · {cost.text.model}</> : null}</>} />
        <Cell
          k="Images"
          v={noAi ? '$0.00' : img.basis === 'none' ? 'No AI image' : fmtUsd(img.typicalUsd)}
          sub={
            noAi ? (
              'NO AI HYBRID: 0 image requests, so there is no image cost.'
            ) : img.basis === 'none' ? (
              img.note
            ) : img.basis === 'unavailable' ? (
              <>
                {img.count} image(s) · {img.model} · {img.quality} · price not published
              </>
            ) : (
              <>{img.count} × {fmtUsd(img.perImageUsd)}{img.basis === 'upper_bound_auto' ? ' (upper bound: quality “auto” priced as “high”)' : ''} · {img.model} · {img.quality}</>
            )
          }
          tone={img.basis === 'unavailable' ? 'text-amber-900' : undefined}
        />
        <Cell k="Estimated total (typical)" v={fmtUsd(t.typicalUsd)} sub={t.typicalUsd === null && t.knownPartUsd > 0 ? `known part: ${fmtUsd(t.knownPartUsd)}` : undefined} tone={t.typicalUsd === null ? 'text-amber-900' : undefined} />
        <Cell k="Worst case" v={fmtUsd(t.maxUsd)} sub="every call used, full output cap" tone={t.maxUsd === null ? 'text-amber-900' : undefined} />
      </dl>
      {img.basis === 'unavailable' && <p className="text-xs text-amber-900">{img.note}</p>}
      {img.reference && (
        <p data-testid="image-price-reference" className="rounded-lg bg-cream-100 px-3 py-2 text-xs text-muted">
          <strong className="text-ink">For orientation, not an estimate: {fmtUsd(img.reference.totalUsd)}</strong> if these {img.count} image(s) were priced like {img.reference.model}. {img.reference.note}
        </p>
      )}
      {tokenBudgets && tokenBudgets.some((b) => b.runs) && (
        <div className="overflow-x-auto">
          <table data-testid="token-budgets" className="w-full min-w-[34rem] text-left text-xs">
            <caption className="mb-1 text-left text-[11px] uppercase tracking-wider text-muted">Text-model budget per phase (hard limits)</caption>
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Phase</th>
                <th className="py-1 pr-3 font-medium">Max text calls (typical)</th>
                <th className="py-1 pr-3 font-medium">Output tokens per call (cap)</th>
                <th className="py-1 pr-3 font-medium">Typical</th>
                <th className="py-1 font-medium">Worst case</th>
              </tr>
            </thead>
            <tbody>
              {tokenBudgets
                .filter((b) => b.runs)
                .map((b) => {
                  const p = textPhases.find((x) => x.phase === b.phase);
                  return (
                    <tr key={b.phase} data-phase={b.phase} className="border-t border-cream-300/70">
                      <td className="py-1 pr-3">{PHASE_TITLE[b.phase]}</td>
                      <td className="py-1 pr-3">
                        {b.maxModelCalls}
                        {p ? ` (about ${p.calls.typical})` : ''}
                      </td>
                      <td className="py-1 pr-3">{b.outputTokens.toLocaleString()}</td>
                      <td className="py-1 pr-3">{cell(p?.typicalUsd)}</td>
                      <td className="py-1">{cell(p?.maxUsd)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">
            The output limit of {cost.text.model ?? 'the text model'} is {limit.limit.toLocaleString()} tokens per call ({limit.verified ? 'stated on OpenAI’s model page' : 'NOT verified for this model, so a conservative ceiling is used'}); a larger cap is lowered to it, never sent as-is.
          </p>
        </div>
      )}
      {cost.warnings.length > 0 && (
        <ul data-testid="cost-warnings" className="space-y-1 text-xs text-amber-900">
          {cost.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <BudgetOptions budget={cost.budget} onApply={onApply} />
      {cost.assumptions.length > 0 && (
        <details data-testid="cost-assumptions" className="text-xs text-muted">
          <summary className="cursor-pointer">Assumptions behind this estimate ({cost.assumptions.length})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {cost.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
