'use client';

import * as React from 'react';
import { AlertCircle, Check, CircleDashed, Download, ExternalLink, GitFork, Loader2, MinusCircle, OctagonX, Sparkles, UserPlus, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CampaignAssetView, CampaignFull, CampaignPackageData, CreativeAnalysis, F1Participant, ImageResultData, IssueSeverity, ReviewFindingData, RunEvent } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * F4 views. Everything here is read from the persisted run: the saved Campaign Package, the CampaignAsset rows (served through
 * the authenticated file endpoint) and the recorded Mozaik events. Nothing is invented for display.
 */

const Empty = ({ text }: { text: string }) => <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-6 text-center text-sm text-muted">{text}</p>;

const STATE: Record<F1Participant['state'], { label: string; icon: React.ReactNode; className: string }> = {
  waiting: { label: 'Waiting', icon: <CircleDashed className="h-4 w-4 text-muted-dark" />, className: '' },
  working: { label: 'Working…', icon: <Loader2 className="h-4 w-4 animate-spin text-accent" />, className: 'text-accent-hover' },
  done: { label: 'Done', icon: <Check className="h-4 w-4 text-emerald-600" />, className: 'text-emerald-700' },
  failed: { label: 'Failed', icon: <XCircle className="h-4 w-4 text-red-600" />, className: 'text-red-600' },
  timed_out: { label: 'Timed out', icon: <OctagonX className="h-4 w-4 text-amber-600" />, className: 'text-amber-700' },
  skipped: { label: 'Skipped', icon: <MinusCircle className="h-4 w-4 text-muted-dark" />, className: 'text-muted' },
};

const SEVERITY: Record<IssueSeverity, string> = { blocker: 'bg-red-200 text-red-900', major: 'bg-red-100 text-red-700', minor: 'bg-amber-100 text-amber-800', info: 'bg-cream-200 text-ink-600' };
const FINDING_STATUS: Record<ReviewFindingData['status'], string> = { open: 'bg-amber-100 text-amber-800', fixed: 'bg-emerald-100 text-emerald-800', unresolved: 'bg-red-100 text-red-700', accepted: 'bg-cream-200 text-ink-600' };
const APPROVAL: Record<string, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'bg-emerald-100 text-emerald-800' },
  approved_with_notes: { label: 'Approved with notes', className: 'bg-amber-100 text-amber-800' },
  unresolved: { label: 'Unresolved issues', className: 'bg-red-100 text-red-700' },
};
const SUPPORT: Record<string, string> = { brief: 'bg-emerald-100 text-emerald-800', f1: 'bg-emerald-100 text-emerald-800', f2: 'bg-emerald-100 text-emerald-800', f3: 'bg-emerald-100 text-emerald-800', user: 'bg-sky-100 text-sky-800', hypothesis: 'bg-red-100 text-red-700' };
const AGENT_CODES: Record<string, string> = { Copywriter: 'A19', 'Visual Creator': 'A20', 'Layout Designer': 'A21', 'Landing Content Builder': 'A22', 'Content & Brand Reviewer': 'A23', Fixer: 'A24' };
const FORMAT_LABEL: Record<string, string> = { instagram_square: 'Instagram feed 1080×1080', instagram_portrait: 'Instagram feed 1080×1350', story: 'Story 1080×1920', facebook_feed: 'Facebook feed 1200×628', linkedin_feed: 'LinkedIn feed 1200×627', promo_16x9: 'Promo 16:9 1920×1080' };

/** Image URLs go through the Next proxy to the authenticated API endpoint; nothing is served statically. */
export const assetSrc = (a: { url: string }) => `/api${a.url}`;
const conceptName = (pkg: CampaignPackageData | null | undefined, id: string) => pkg?.concepts.find((c) => c.id === id)?.name ?? id;

export function ApprovalBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const a = APPROVAL[status] ?? { label: status, className: 'bg-cream-200 text-ink-600' };
  return <Badge className={a.className}>{a.label}</Badge>;
}

// ---- Overview ------------------------------------------------------------------------------------------------------------------------

export function CreativeOverviewTab({ analysis, campaign, running }: { analysis: CreativeAnalysis | undefined; campaign: CampaignFull | undefined; running: boolean }) {
  if (!analysis) return <Empty text="The run appears here as soon as it starts." />;
  const p = analysis.progress;
  const pkg = campaign?.package ?? null;
  const chain = analysis.chain;
  const plan = analysis.plan;
  const state = (n: string) => analysis.participants.find((x) => x.agent === n)?.state ?? (plan?.skipped.some((s) => s.agent === n) ? 'skipped' : 'waiting');
  const names = ['Copywriter', 'Visual Creator', 'Layout Designer', 'Landing Content Builder', 'Content & Brand Reviewer', 'Fixer'];
  const fixerDynamic = plan?.activated.find((a) => a.agent === 'Fixer' && a.dynamic);
  return (
    <div className="space-y-5">
      {chain && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['F1 Product Discovery', chain.f1ReportId],
            ['F2 Marketing Audit', chain.f2AuditId],
            ['F3 Strategy', chain.f3StrategyId],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-cream-100 px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
              <p className="truncate font-mono text-xs" title={v}>{v}</p>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat k="Concepts" v={pkg?.concepts.length ?? p.concepts} />
        <Stat k="Copy variants" v={pkg?.copyVariants.length ?? p.variants} />
        <Stat k="Generated images" v={pkg ? pkg.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded').length : p.images} hint={p.imagesFailed ? `${p.imagesFailed} failed` : undefined} />
        <Stat k="Channel layouts" v={pkg?.channelLayouts.length ?? p.layouts} hint={p.skippedLayouts ? `${p.skippedLayouts} skipped` : undefined} />
        <Stat k="Review rounds" v={p.round} />
        <Stat k="Findings" v={pkg?.reviewFindings.length ?? p.findings} />
        <Stat k="Repairs applied" v={pkg ? pkg.revisions.filter((r) => r.status === 'applied').length : p.repairsApplied} />
        <div className="rounded-xl bg-cream-100 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wider text-muted">Approval</p>
          <p className="mt-1">{running ? <span className="text-sm text-muted">in progress</span> : <ApprovalBadge status={pkg?.approval.status ?? analysis.approvalStatus} />}</p>
        </div>
      </div>
      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Participants</h5>
        <ol className="grid gap-2 sm:grid-cols-2">
          {names.map((n) => {
            const st = state(n);
            const ui = STATE[st] ?? STATE.waiting;
            const reason = plan?.activated.find((a) => a.agent === n)?.reason ?? plan?.skipped.find((a) => a.agent === n)?.reason;
            return (
              <li key={n} className={cn('flex items-start gap-3 rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3', n === 'Fixer' && fixerDynamic && 'border-accent/60 bg-accent-soft/40')}>
                <span className="mt-0.5">{ui.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="font-mono text-[11px] text-muted">{AGENT_CODES[n]}</span> {n}
                    {n === 'Fixer' && fixerDynamic && (
                      <Badge className="bg-accent text-white">
                        <UserPlus className="h-3 w-3" /> created at run time
                      </Badge>
                    )}
                  </span>
                  <span className="block text-xs text-muted">{reason ?? (n === 'Fixer' ? 'Created only if the review finds something to repair' : '')}</span>
                </span>
                <span className={cn('text-xs font-medium', ui.className)}>{ui.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
      {analysis.settings && (
        <div className="rounded-xl bg-cream-100 px-4 py-3 text-xs text-muted">
          <span className="font-semibold text-ink">Settings used: </span>
          {analysis.settings.channels.join(', ')} · {analysis.settings.concepts} concept(s) · formats {analysis.settings.formats.join(', ')} ·{' '}
          {analysis.settings.imageGeneration ? `images by ${analysis.settings.imageModel} (${analysis.settings.imageQuality}, ${analysis.settings.imageSize}), at most ${analysis.settings.maxImages} + ${analysis.settings.maxRegenerations} regeneration(s)` : 'no image model (brand-colored backgrounds)'} · up to {analysis.settings.maxRepairRounds} repair round(s) · text calls capped at {analysis.settings.maxModelCalls}
        </div>
      )}
      {(pkg?.limitations.length || analysis.why) && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Why it ended, and what limits it</h5>
          <ul className="space-y-1 text-sm">
            {analysis.why && <li className="text-ink">{analysis.why}</li>}
            {pkg?.limitations.map((l, i) => (
              <li key={i} className="flex gap-2 text-muted">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: number | string; hint?: string }) {
  return (
    <div className="rounded-xl bg-cream-100 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
      <p className="text-xl font-semibold">{v}</p>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

// ---- Agents: participants, per-agent usage and the timeline of REAL events ------------------------------------------------------------

const HIGHLIGHT: Record<string, string> = {
  'participant.registered': 'bg-accent-soft text-accent-hover font-semibold',
  'crosscheck.requested': 'text-sky-800',
  'crosscheck.answered': 'text-sky-800',
  'revision.requested': 'text-amber-900 font-medium',
  'revision.applied': 'text-amber-900',
  'fix.requested': 'text-amber-900 font-medium',
  'review.completed': 'font-medium',
  'campaign.completed': 'text-emerald-800 font-semibold',
};

export function CreativeAgentsTab({ analysis, events }: { analysis: CreativeAnalysis | undefined; events: RunEvent[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  if (!analysis?.plan) return <Empty text="Agents appear when the run starts." />;
  const names = [...analysis.plan.activated.map((a) => a.agent), ...analysis.plan.skipped.map((a) => a.agent)].filter((n, i, arr) => arr.indexOf(n) === i);
  const calls = (n: string) => analysis.aiCalls[n] ?? 0;
  const usage = (n: string) => analysis.usage?.perAgent?.[n];
  return (
    <div className="space-y-5">
      <ol className="space-y-2">
        {names.map((n) => {
          const p = analysis.participants.find((x) => x.agent === n) ?? { agent: n, state: analysis.plan!.skipped.some((s) => s.agent === n) ? ('skipped' as const) : ('waiting' as const) };
          const ui = STATE[p.state] ?? STATE.waiting;
          const dynamic = analysis.plan!.activated.find((a) => a.agent === n)?.dynamic;
          const u = usage(n);
          const isOpen = open === n;
          const mine = events.filter((e) => e.participant === n);
          return (
            <li key={n} className={cn('rounded-xl border border-cream-300/80 bg-cream-50', dynamic && 'border-accent/60')}>
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(isOpen ? null : n)} aria-expanded={isOpen}>
                {ui.icon}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="font-mono text-[11px] text-muted">{AGENT_CODES[n] ?? ''}</span> {n}
                    {dynamic && (
                      <Badge className="bg-accent text-white">
                        <UserPlus className="h-3 w-3" /> registered at run time
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted">{p.error?.message ?? p.reason ?? analysis.plan!.activated.find((a) => a.agent === n)?.reason ?? analysis.plan!.skipped.find((a) => a.agent === n)?.reason ?? ''}</span>
                </span>
                <span className="hidden text-xs text-muted sm:block">{calls(n) > 0 ? `${calls(n)} AI call${calls(n) === 1 ? '' : 's'} · ${(u?.totalTokens ?? 0).toLocaleString()} tokens` : p.state === 'skipped' ? 'no AI call' : 'tool / no AI call'}</span>
                <span className={cn('text-xs font-medium', ui.className)}>{ui.label}</span>
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-cream-300/70 px-4 py-3 text-sm">
                  {analysis.summaries[n] && <p className="text-sm">{analysis.summaries[n]}</p>}
                  {u && (
                    <p className="text-xs text-muted">
                      {u.calls} call{u.calls === 1 ? '' : 's'} · {u.inputTokens.toLocaleString()} in / {u.outputTokens.toLocaleString()} out
                    </p>
                  )}
                  <p className="text-[11px] text-muted">Events by this participant ({mine.length}): {[...new Set(mine.map((e) => e.eventType))].join(', ') || 'none recorded'}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {analysis.crosschecks.length > 0 && (
        <div>
          <h5 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
            <GitFork className="h-3.5 w-3.5" /> Cross-checks between participants ({analysis.crosschecks.length})
          </h5>
          <ul className="divide-y divide-cream-300/70 rounded-xl border border-cream-300/80 bg-cream-50 text-xs">
            {analysis.crosschecks.map((c, i) => (
              <li key={`${c.requestId}-${c.claimId}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-mono text-muted">{c.claimId}</span>
                <span>
                  <strong>{c.producer}</strong> → <strong>{c.reviewer}</strong>
                </span>
                <Badge className={c.verdict === 'agree' ? 'bg-emerald-100 text-emerald-800' : c.verdict === 'disagree' ? 'bg-red-100 text-red-700' : c.verdict === 'correct' ? 'bg-amber-100 text-amber-800' : 'bg-cream-200 text-ink-600'}>{c.verdict ?? c.status}</Badge>
                {c.rationale && <span className="basis-full text-muted">{c.rationale}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h5 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
          <Sparkles className="h-3.5 w-3.5" /> What actually happened (recorded Mozaik events, in order)
        </h5>
        {analysis.timeline.length === 0 ? (
          <Empty text="No events recorded yet." />
        ) : (
          <ol className="max-h-[28rem] space-y-1 overflow-auto rounded-xl bg-cream-100/70 p-3 text-xs">
            {analysis.timeline.map((t) => (
              <li key={t.sequence} className={cn('grid grid-cols-[2.5rem_11rem_1fr] gap-2', HIGHLIGHT[t.type])}>
                <span className="font-mono text-muted">{t.sequence}</span>
                <span className="truncate font-mono">{t.type}</span>
                <span className="min-w-0">
                  <span className="font-medium">{t.participant ?? '—'}</span>
                  {t.summary && <span className="text-muted"> · {t.summary}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ---- Concepts and copy --------------------------------------------------------------------------------------------------------------------

export function ConceptsTab({ pkg }: { pkg: CampaignPackageData | null | undefined }) {
  if (!pkg) return <Empty text="Concepts and copy appear when the Copywriter has delivered." />;
  return (
    <div className="space-y-4">
      {pkg.concepts.map((c) => {
        const variants = pkg.copyVariants.filter((v) => v.conceptId === c.id);
        return (
          <section key={c.id} className="rounded-2xl border border-cream-300/80 bg-cream-50 p-4">
            <header className="mb-3">
              <h4 className="text-base font-semibold">
                <span className="mr-2 font-mono text-xs text-muted">{c.id}</span>
                {c.name}
              </h4>
              <p className="text-sm text-muted">{c.angle}</p>
              <p className="mt-1 text-sm">
                <strong>Key message:</strong> {c.keyMessage} · <strong>Audience:</strong> {c.audience} · <strong>CTA:</strong> {c.ctaText} ({c.ctaType})
              </p>
              <p className="text-xs text-muted">Visual idea: {c.visualIdea}</p>
            </header>
            <ul className="grid gap-3 md:grid-cols-2">
              {variants.map((v) => (
                <li key={v.id} className="rounded-xl bg-white/70 p-3 ring-1 ring-cream-300/60">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className="font-mono">{v.id}</span>
                    <Badge className="bg-cream-200 text-ink-600">{v.channel}</Badge>
                    <Badge className="bg-cream-200 text-ink-600">{v.placement.replace('_', ' ')}</Badge>
                    <span>{v.length}</span>
                    {v.version > 1 && <Badge className="bg-amber-100 text-amber-800">revised · v{v.version}</Badge>}
                  </div>
                  <p className="font-semibold">{v.headline}</p>
                  <p className="mt-1 text-sm">{v.body}</p>
                  {v.description && <p className="mt-1 text-xs italic text-muted">{v.description}</p>}
                  <p className="mt-2 text-xs">
                    <strong>CTA:</strong> {v.ctaText}
                    {v.hashtags.length ? <span className="text-muted"> · {v.hashtags.join(' ')}</span> : null}
                  </p>
                  {v.claims.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {v.claims.map((cl, i) => (
                        <li key={i} className={cn('rounded-full px-2 py-0.5 text-[11px]', SUPPORT[cl.support])} title={cl.ref ?? ''}>
                          {cl.text} · {cl.support}
                        </li>
                      ))}
                    </ul>
                  )}
                  {v.history.length > 0 && (
                    <details className="mt-2 text-xs text-muted">
                      <summary className="cursor-pointer">Earlier version{v.history.length === 1 ? '' : 's'} (kept)</summary>
                      {v.history.map((h) => (
                        <p key={h.version} className="mt-1 border-l-2 border-cream-300 pl-2">
                          v{h.version}: <em>{h.headline}</em> — {h.body} <span className="text-[10px]">(replaced because: {h.reason})</span>
                        </p>
                      ))}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---- Generated images -----------------------------------------------------------------------------------------------------------------------

export function ImagesTab({ pkg, assets }: { pkg: CampaignPackageData | null | undefined; assets: CampaignAssetView[] }) {
  const bases = assets.filter((a) => a.kind === 'image');
  if (!bases.length) return <Empty text={pkg ? 'No base image was stored for this campaign.' : 'Images appear as the Visual Creator stores them.'} />;
  const current = bases.filter((a) => a.status !== 'superseded');
  const old = bases.filter((a) => a.status === 'superseded');
  const missing = current.filter((a) => a.source !== 'ai_image');
  const unexplained = (pkg?.imageResults ?? []).filter((r) => r.outcome !== 'generated' && !!r.explanation);
  // a concept that was "Not attempted" only echoes the earlier failure: list it only when nothing else explains
  const real = unexplained.filter((r) => r.requestAttempted || !r.explanation!.startsWith('Not attempted'));
  const reasons = [...new Set((real.length ? real : unexplained).map((r) => r.explanation!))];
  return (
    <div className="space-y-5">
      {missing.length > 0 && (
        <div role="alert" data-testid="images-missing" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="flex items-start gap-2 font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {missing.length} of {current.length} concept(s) have NO AI-generated image. The tiles marked “NOT an AI image” are brand-colored backgrounds that stand in for it.
          </p>
          {reasons.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-9 text-xs">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 pl-6 text-xs">No reason was recorded for this older campaign; see the review and limitations.</p>
          )}
        </div>
      )}
      <p className="text-xs text-muted">
        Base images are generated once per concept with the image model you chose, through your own OpenAI key, and saved to the project. A brand-colored background is never a generated picture: the reason is shown on its tile. Prompts are not stored; only their length and a short description.
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {current.map((a) => (
          <ImageCard key={a.id} a={a} name={conceptName(pkg, a.conceptId)} result={pkg?.imageResults?.find((r) => r.conceptId === a.conceptId)} />
        ))}
      </ul>
      {old.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">Earlier versions kept after regeneration ({old.length})</summary>
          <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {old.map((a) => (
              <ImageCard key={a.id} a={a} name={conceptName(pkg, a.conceptId)} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const STAGE_LABEL: Record<NonNullable<ImageResultData['stage']>, string> = {
  configuration: 'Image model / configuration',
  budget: 'Image limit you configured',
  planning: 'Picture planning',
  provider: 'OpenAI refused or failed the request',
  decoding: 'OpenAI response could not be decoded',
  storage: 'Storing the delivered image failed',
  cancelled: 'Run cancelled',
};

function ImageCard({ a, name, result }: { a: CampaignAssetView; name: string; result?: ImageResultData }) {
  const ai = a.source === 'ai_image';
  return (
    <li data-image-kind={ai ? 'ai' : 'fallback'} className={cn('overflow-hidden rounded-2xl border bg-cream-50', ai ? 'border-cream-300/80' : 'border-red-300')}>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={assetSrc(a)} alt={ai ? (a.altText ?? name) : `Brand-colored background for ${name} (not an AI image)`} width={a.width} height={a.height} loading="lazy" className={cn('aspect-square w-full object-cover', !ai && 'opacity-80')} />
        <span className={cn('absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold', ai ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white')}>{ai ? 'AI-generated image' : 'NOT an AI image'}</span>
      </div>
      <div className="space-y-1 p-3 text-xs">
        <p className="text-sm font-medium">
          {name} <span className="font-mono text-[11px] text-muted">v{a.version}</span>
        </p>
        <p className="text-muted">
          {ai ? `${a.model} · ${a.quality} · ${a.requestedSize}` : 'brand-colored background, no image was generated for this concept'} · {a.width}×{a.height} · {(a.bytes / 1024).toFixed(0)} KB
        </p>
        {!ai && (
          <div className="rounded-lg bg-red-50 px-2 py-1.5 text-red-800">
            <p className="font-medium">
              {result?.stage ? (result.stage === 'provider' && !result.requestAttempted ? 'Not sent: an earlier image request already failed' : STAGE_LABEL[result.stage]) : 'Why there is no AI image'}
              {result && !(result.stage === 'provider' && !result.requestAttempted) ? (result.requestAttempted ? ' · an image request was made' : ' · no image request was made') : ''}
            </p>
            <p>{result?.explanation ?? 'No reason could be derived for this campaign.'}</p>
            {result?.reconstructed ? <p className="mt-0.5 text-[11px] italic">Reconstructed from the events this run recorded: the campaign was saved before per-concept image results existed.</p> : null}
            {result?.providerStatus ? (
              <p className="mt-0.5 font-mono text-[11px]">
                HTTP {result.providerStatus}
                {result.providerCode ? ` · ${result.providerCode}` : ''}
                {result.model ? ` · ${result.model}` : ''}
              </p>
            ) : null}
          </div>
        )}
        {a.promptMetadata && <p className="text-muted">Direction: {a.promptMetadata.directionSummary} ({a.promptMetadata.promptChars} prompt characters)</p>}
        {a.usage && <p className="text-muted">Provider-reported tokens: {a.usage.total.toLocaleString()}</p>}
        <div className="flex gap-2 pt-1">
          <Button asChild size="sm" variant="outline">
            <a href={assetSrc(a)} download={`${name}-v${a.version}.png`}>
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={assetSrc(a)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </Button>
        </div>
      </div>
    </li>
  );
}

// ---- Channel formats --------------------------------------------------------------------------------------------------------------------------

export function FormatsTab({ pkg, assets }: { pkg: CampaignPackageData | null | undefined; assets: CampaignAssetView[] }) {
  const layouts = assets.filter((a) => a.kind === 'layout' && a.status !== 'superseded');
  if (!layouts.length) return <Empty text="Channel layouts appear as the Layout Designer renders them (locally, from the base images)." />;
  const byConcept = new Map<string, CampaignAssetView[]>();
  for (const a of layouts) byConcept.set(a.conceptId, [...(byConcept.get(a.conceptId) ?? []), a]);
  const superseded = assets.filter((a) => a.kind === 'layout' && a.status === 'superseded').length;
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted">
        Each format is cut from the concept&apos;s base image at its exact pixel size (never stretched), with the headline, supporting line, call to action and your logo placed inside the safe area, then measured for text fit and contrast. {superseded ? `${superseded} earlier version(s) replaced by repairs are kept.` : ''}
      </p>
      {[...byConcept.entries()].map(([conceptId, list]) => (
        <section key={conceptId}>
          <h4 className="mb-2 text-sm font-semibold">{conceptName(pkg, conceptId)}</h4>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((a) => {
              const l = pkg?.channelLayouts.find((x) => x.assetId === a.id);
              return (
                <li key={a.id} className="overflow-hidden rounded-2xl border border-cream-300/80 bg-cream-50">
                  <div className="flex items-center justify-center bg-cream-200/60 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assetSrc(a)} alt={a.altText ?? ''} width={a.width} height={a.height} loading="lazy" className="max-h-72 w-auto max-w-full rounded-lg shadow-sm" />
                  </div>
                  <div className="space-y-1 p-3 text-xs">
                    <p className="text-sm font-medium">{FORMAT_LABEL[a.format ?? ''] ?? a.format}</p>
                    <p className="text-muted">
                      {a.channel} · {a.width}×{a.height} · v{a.version}
                      {l ? ` · copy ${l.variantId}` : ''}
                    </p>
                    {a.flags.length > 0 && (
                      <p className="flex flex-wrap gap-1">
                        {a.flags.map((f) => (
                          <span key={f} className={cn('rounded-full px-2 py-0.5 text-[10px]', /overflow|low_contrast|collides/.test(f) ? 'bg-amber-100 text-amber-800' : 'bg-cream-200 text-ink-600')}>
                            {f}
                          </span>
                        ))}
                      </p>
                    )}
                    <Button asChild size="sm" variant="outline" className="mt-1">
                      <a href={assetSrc(a)} download={`${conceptName(pkg, conceptId)}-${a.format}.png`}>
                        <Download className="h-3.5 w-3.5" /> Download PNG
                      </a>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {pkg && pkg.skippedLayouts.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Formats not exported, and why</h5>
          <ul className="space-y-1 text-sm">
            {pkg.skippedLayouts.map((s, i) => (
              <li key={i} className="flex gap-2 text-muted">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{conceptName(pkg, s.conceptId)}</strong> · {FORMAT_LABEL[s.format] ?? s.format} ({s.channel}): {s.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---- Landing page -----------------------------------------------------------------------------------------------------------------------------

export function LandingTab({ pkg, campaignId }: { pkg: CampaignPackageData | null | undefined; campaignId: string | null }) {
  const l = pkg?.landingContent;
  if (!l) return <Empty text={pkg ? 'No landing page content was produced for this campaign.' : 'Landing page content appears when the Landing Content Builder has delivered.'} />;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted">SEO title · meta description</p>
          <p className="font-medium">{l.seoTitle}</p>
          <p className="text-muted">{l.metaDescription}</p>
        </div>
        <div className="rounded-xl bg-ink p-4 text-cream-100">
          <p className="text-lg font-semibold">{l.hero.headline}</p>
          <p className="mt-1 text-sm opacity-90">{l.hero.description}</p>
          <span className="mt-3 inline-block rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white">{l.hero.ctaText}</span>
        </div>
        <p>{l.valueProposition}</p>
        {l.benefits.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted">Benefits</p>
            <ul className="mt-1 space-y-1">
              {l.benefits.map((b, i) => (
                <li key={i}>
                  <strong>{b.title}</strong> — {b.text} <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', SUPPORT[b.evidence])}>{b.evidence}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {l.sections.map((s, i) => (
          <div key={i}>
            <p className="font-medium">{s.title}</p>
            <p className="text-muted">{s.body}</p>
          </div>
        ))}
        {l.howItWorks.length > 0 && (
          <ol className="list-decimal space-y-0.5 pl-5">
            {l.howItWorks.map((h, i) => (
              <li key={i}>
                <strong>{h.step}</strong> {h.text}
              </li>
            ))}
          </ol>
        )}
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted">Trust signals</p>
          {l.trustSignals.length === 0 ? (
            <p className="text-muted">None: the supplied material contains no reviews, certifications or numbers that could be used, so none were invented.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {l.trustSignals.map((t, i) => (
                <li key={i}>
                  {t.text} <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', SUPPORT[t.evidence])}>{t.evidence}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {l.faq.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted">FAQ</p>
            {l.faq.map((f, i) => (
              <details key={i} className="mt-1">
                <summary className="cursor-pointer font-medium">{f.q}</summary>
                <p className="text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        )}
        <p className="text-xs text-muted">Primary objective: {l.ctaObjective} · mobile order: {l.mobileHierarchy.join(' → ') || '—'}</p>
      </div>
      <div>
        <p className="mb-2 text-xs text-muted">Local preview (a fixed template with your text; scripts and external resources are blocked, nothing is published).</p>
        {campaignId ? (
          <iframe title="Landing page preview" src={`/api/campaigns/${campaignId}/landing-preview`} sandbox="" className="h-[36rem] w-full rounded-2xl border border-cream-300/80 bg-white" />
        ) : (
          <Empty text="The preview is available once the campaign is saved." />
        )}
      </div>
    </div>
  );
}

// ---- Quality review -----------------------------------------------------------------------------------------------------------------------

export function ReviewTab({ pkg }: { pkg: CampaignPackageData | null | undefined }) {
  if (!pkg) return <Empty text="The review appears when the Content & Brand Reviewer has finished." />;
  const a = pkg.approval;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-cream-100 px-4 py-3 text-sm">
        <ApprovalBadge status={a.status} />
        <span>{a.note}</span>
        <span className="text-xs text-muted">{a.rounds} repair round(s)</span>
      </div>
      {pkg.reviewFindings.length === 0 ? (
        <Empty text="No issue was found." />
      ) : (
        <ul className="space-y-2">
          {pkg.reviewFindings.map((f) => (
            <li key={f.id} className="rounded-xl border border-cream-300/80 bg-cream-50 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-muted">{f.id}</span>
                <Badge className={SEVERITY[f.severity]}>{f.severity}</Badge>
                <span className="font-mono text-xs">{f.kind}</span>
                {f.assetRef && <span className="font-mono text-xs text-muted">on {f.assetRef}</span>}
                <Badge className={FINDING_STATUS[f.status]}>{f.status}</Badge>
                <span className="ml-auto text-[11px] text-muted">
                  round {f.round}
                  {f.resolvedInRound ? ` → fixed in round ${f.resolvedInRound}` : ''} · {f.source === 'deterministic' ? 'measured / rule' : f.source === 'llm_vision' ? 'vision review' : 'text review'} · owner: {f.responsibleAgent}
                </span>
              </div>
              <p className="mt-1">{f.finding}</p>
              <p className="text-xs text-muted">Evidence: {f.evidence}</p>
              <p className="text-xs text-muted">Suggested correction: {f.suggestedCorrection}</p>
            </li>
          ))}
        </ul>
      )}
      {pkg.revisions.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Repairs requested by the Fixer</h5>
          <ul className="space-y-2">
            {pkg.revisions.map((r) => (
              <li key={r.id} className="rounded-xl bg-cream-100/70 px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-muted">round {r.round}</span>
                  <span className="font-mono">{r.findingId}</span>
                  <Badge className="bg-cream-200 text-ink-600">{r.operation.replace('_', ' ')}</Badge>
                  <span>
                    Fixer → <strong>{r.owner}</strong>
                  </span>
                  <Badge className={r.status === 'applied' ? 'bg-emerald-100 text-emerald-800' : r.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-cream-200 text-ink-600'}>{r.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted">{r.note}</p>
                {(r.before || r.after) && (
                  <p className="mt-1 text-xs">
                    {r.before && (
                      <span className="block text-muted">
                        Before: <s>{r.before}</s>
                      </span>
                    )}
                    {r.after && <span className="block">After: {r.after}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---- Final campaign package ---------------------------------------------------------------------------------------------------------------

export function FinalTab({ campaign }: { campaign: CampaignFull | undefined }) {
  const pkg = campaign?.package;
  if (!campaign || !pkg) return <Empty text="The campaign package is assembled when the run finishes and is saved; it stays available after a restart." />;
  const u = pkg.usage;
  const json = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(pkg, null, 2))}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-ink p-5 text-cream-100">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider text-accent">Campaign package</p>
          <p className="truncate text-lg font-semibold">{pkg.campaignName}</p>
          <p className="text-xs text-muted-dark">
            {pkg.id} · schema v{pkg.schemaVersion} · {formatDate(pkg.createdAt)} · language {pkg.language}
          </p>
        </div>
        <ApprovalBadge status={pkg.approval.status} />
        <Button asChild>
          <a href={`/api/campaigns/${campaign.id}/export`} download>
            <Download className="h-4 w-4" /> Download ZIP
          </a>
        </Button>
        <Button asChild variant="outline" className="border-white/20 text-cream-100 hover:bg-white/10">
          <a href={json} download={`campaign-${pkg.id}.json`}>
            campaign.json
          </a>
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat k="Concepts" v={pkg.concepts.length} />
        <Stat k="Copy variants" v={pkg.copyVariants.length} />
        <Stat k="Generated images" v={pkg.imageAssets.filter((a) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded').length} hint={`${pkg.imageAssets.filter((a) => a.status === 'superseded').length} earlier version(s) kept`} />
        <Stat k="Channel layouts" v={pkg.channelLayouts.length} hint={`${pkg.skippedLayouts.length} skipped`} />
        <Stat k="Review findings" v={pkg.reviewFindings.length} hint={`${pkg.approval.unresolvedFindingIds.length} unresolved`} />
        <Stat k="Repairs" v={pkg.revisions.length} hint={`${pkg.revisions.filter((r) => r.status === 'applied').length} applied`} />
      </div>
      <div className="rounded-xl bg-cream-100 px-4 py-3 text-sm">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Usage (measured; no price is shown)</p>
        <p>
          Text model: {u.text.calls} call(s), {u.text.inputTokens.toLocaleString()} input / {u.text.outputTokens.toLocaleString()} output tokens.
        </p>
        <p>
          Images: {u.images.requested} request(s) ({u.images.generated} generated, {u.images.failed} failed, {u.images.regenerations} regeneration(s)) of at most {u.images.limits.maxImages} + {u.images.limits.maxRegenerations}
          {u.images.model ? ` with ${u.images.model} (${u.images.quality}, ${u.images.size})` : ''}
          {u.images.providerReportedTokens ? `; provider-reported tokens ${u.images.providerReportedTokens.total.toLocaleString()}` : ''}.
        </p>
        <p>Layouts: {u.layouts.rendered} rendered locally without any model call ({u.layouts.skipped} skipped).</p>
      </div>
      <p className="text-xs text-muted">
        The ZIP contains every image binary (current and superseded versions), campaign.json, the copy as text files, the landing content and its HTML preview, the review findings and repairs, a README and a manifest with SHA-256 hashes. It contains no credentials and no image prompts.
      </p>
      <p className="text-xs text-muted">
        Built on F1 <span className="font-mono">{pkg.f1ReportId}</span> → F2 <span className="font-mono">{pkg.f2ReportId}</span> → F3 <span className="font-mono">{pkg.f3StrategyId}</span> (run <span className="font-mono">{pkg.runId}</span>).
      </p>
    </div>
  );
}
