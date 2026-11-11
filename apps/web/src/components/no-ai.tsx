'use client';

import * as React from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { NoAiPlanData } from '@/lib/hybrid';
import { SOURCE_LABEL, type LibraryProvider, type LibrarySource } from '@/lib/images';
import { cn } from '@/lib/utils';

/*
 * NO AI HYBRID, the pieces every screen shares: the three-line statement, the state of the licensed image providers and the picture summary
 * of the plan review. The statement is a fact the server enforces (no image-generation request of any kind is ever made); the words here only
 * restate it. Nothing in this file calls an API.
 */

export const NO_AI_STATEMENT = { aiImages: 'AI-generated images: 0', imagery: 'Existing/licensed imagery: enabled', agents: 'AI agents for strategy and copywriting: enabled' } as const;

/** "AI-generated images: 0 / Existing/licensed imagery: enabled / AI agents for strategy and copywriting: enabled". `statement` = the server's own words, when a plan has them. */
export function NoAiStatement({ testId = 'no-ai-statement', statement = NO_AI_STATEMENT, className }: { testId?: string; statement?: { aiImages: string; imagery: string; agents: string }; className?: string }) {
  return (
    <ul data-testid={testId} aria-label="NO AI HYBRID" className={cn('grid gap-x-6 gap-y-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950 sm:grid-cols-3', className)}>
      {[statement.aiImages, statement.imagery, statement.agents].map((s) => (
        <li key={s} className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /> {s}
        </li>
      ))}
    </ul>
  );
}

/** Which licensed providers are configured on this server and what to do about the ones that are not. A "paid" provider bills per request and is used only when the user allowed it. */
export function ProviderList({ providers, testId = 'image-providers' }: { providers: LibraryProvider[]; testId?: string }) {
  if (providers.length === 0) return <p className="text-xs text-muted">No image provider is known to this server.</p>;
  return (
    <ul data-testid={testId} className="space-y-1 text-xs">
      {providers.map((p) => (
        <li key={p.id} data-provider={p.id} data-configured={p.configured ? 'yes' : 'no'} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="text-ink">{p.label}</strong>
          <Badge className={cn('px-2 py-0.5 text-[10px]', p.kind === 'licensed' ? 'bg-sky-100 text-sky-800' : 'bg-cream-200 text-ink-600')}>{p.kind === 'licensed' ? 'licensed' : 'reference only'}</Badge>
          {p.paid && <Badge className="bg-amber-100 px-2 py-0.5 text-[10px] text-amber-900">paid: bills per request</Badge>}
          <span className={p.configured ? 'text-emerald-800' : 'text-muted'}>{p.configured ? 'configured' : `not configured${p.setup ? ` — ${p.setup}` : ''}`}</span>
        </li>
      ))}
    </ul>
  );
}

const sourceName = (k: string) => SOURCE_LABEL[k as LibrarySource] ?? k;

/** The picture side of a reviewed NO AI HYBRID plan: what is approved, what waits for the owner, which providers work, whether there is enough, the warnings. */
export function NoAiImagerySummary({ noAi }: { noAi: NoAiPlanData }) {
  const im = noAi.imagery;
  if (!im) {
    return (
      <p data-testid="no-ai-imagery" className="rounded-xl bg-cream-100 px-4 py-3 text-xs text-muted">
        The creative phase is not part of this run (a saved campaign is reused), so no picture is needed.
      </p>
    );
  }
  const by = Object.entries(im.approvedBySource).filter(([, n]) => n > 0);
  const aw = im.awaitingAuthorization;
  const waiting = [aw.website > 0 && `${aw.website} from your website`, aw.github > 0 && `${aw.github} from GitHub`, aw.stockReview > 0 && `${aw.stockReview} licensed stock picture${aw.stockReview === 1 ? '' : 's'} whose license you must check`, aw.stockCleared > 0 && `${aw.stockCleared} licensed stock picture${aw.stockCleared === 1 ? '' : 's'} cleared by the provider (not added yet)`].filter(Boolean) as string[];
  return (
    <div data-testid="no-ai-imagery" className="space-y-3 rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-xs">
      <p className="font-semibold uppercase tracking-wider text-muted">Pictures for the creatives (your own, approved and licensed only)</p>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div data-testid="no-ai-approved" className="rounded-lg bg-cream-100 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wider text-muted">Approved pictures</dt>
          <dd className="text-lg font-semibold">{im.approved}</dd>
          <dd className="text-[11px] text-muted">{by.length ? by.map(([k, n]) => `${sourceName(k)}: ${n}`).join(' · ') : 'none yet'}</dd>
        </div>
        <div data-testid="no-ai-awaiting" className="rounded-lg bg-cream-100 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wider text-muted">Waiting for your authorization</dt>
          <dd className="text-lg font-semibold">{aw.website + aw.github + aw.stockReview}</dd>
          <dd className="text-[11px] text-muted">{waiting.length ? waiting.join(' · ') : 'nothing is waiting'}</dd>
        </div>
        <div data-testid="no-ai-enough" className={cn('rounded-lg px-3 py-2', im.estimate.enough ? 'bg-emerald-50' : 'bg-amber-50')}>
          <dt className="text-[11px] uppercase tracking-wider text-muted">Pictures needed</dt>
          <dd className="text-lg font-semibold">
            {im.estimate.approvedPictures} of about {im.estimate.picturesWanted}
          </dd>
          <dd className="text-[11px] text-muted">{im.estimate.enough ? 'enough for the plan' : 'fewer than ideal: some creatives will be text-first'}</dd>
        </div>
      </dl>
      <p data-testid="no-ai-estimate-note" className={im.estimate.enough ? 'text-muted' : 'text-amber-900'}>
        {im.estimate.note}
      </p>
      <p className="text-muted">
        Automatic stock mode is <strong className="text-ink">{im.autoStock ? 'on' : 'off'}</strong>
        {im.autoStock ? ': pictures whose license the provider clears may be added during the run, with their credit.' : ': nothing is added without your approval.'}
      </p>
      <div>
        <p className="mb-1 font-medium text-ink">Image providers</p>
        <ProviderList providers={im.providers} testId="no-ai-providers" />
      </div>
      {im.warnings.length > 0 && (
        <ul data-testid="no-ai-warnings" className="space-y-1 text-amber-900">
          {im.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
