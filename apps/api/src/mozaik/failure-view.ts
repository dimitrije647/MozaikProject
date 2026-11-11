import type { BudgetView } from './budget-view';
import type { FactoryPhaseState, PhaseFailure } from './factory-plan';

/**
 * WHY A CAMPAIGN STOPPED, in words a user can act on: the phase, the agent, the specific safe reason, why the images did not start, what was
 * spent (known, uncertain, remaining) and what to do next. Built from the saved phase states, the failure that phase recorded (or, for a run saved
 * before it was recorded, the failure event of the child run: read-only) and the campaign budget. Nothing here contains a credential or provider text.
 */
/**
 * For a run that stopped because a saved report could not be used: what THIS version of LaunchPilot can read of the chain the run used (checked
 * now, read-only, free), so the screen can say whether the saved work is still usable and what "Continue from saved work" would run.
 */
export interface RecoveryView {
  /** Every report the run used can be read by this version and they belong together. */
  ready: boolean;
  reports: { code: string; id: string | null; status: 'current' | 'normalized' | 'unreadable' | 'missing'; message: string }[];
  lineageProblems: string[];
  /** The first phase that did not finish: what "Continue from saved work" runs. */
  resumeFrom: { code: string; title: string } | null;
}

/** The message older builds stored when F4 could not read the strategy. It told the user to run the Strategy again, which was wrong for a recoverable format difference. */
const LEGACY_UNREADABLE = /^A report in the F1 -> F2 -> F3 chain could not be read \(older format\)\. Run the Strategy again\.$/;
const REPORT_CODES = ['report_unreadable', 'report_damaged', 'report_lineage'];

export interface FailureView {
  kind: 'failed' | 'cancelled' | 'interrupted';
  /** "Campaign stopped during F3 Market Research & Strategy." */
  headline: string;
  phase: { code: string; title: string } | null;
  /** The participant that failed first ("Campaign Strategist"), when the run recorded it. */
  agent: string | null;
  code: string | null;
  /** The specific safe reason. */
  reason: string;
  /** Extra specifics (for a timeout: how long the request was given and that it may still have been billed). */
  detail: string | null;
  imageGeneration: { started: boolean; requests: number; why: string };
  spending: { knownUsd: number | null; uncertainUsd: number | null; remainingUsd: number | null; remainingBasis: BudgetView['remainingBasis'] | null; note: string };
  /** Did the campaign budget refuse a request? (false = the budget did not cause this stop). */
  budgetContributed: boolean;
  /** Phases of THIS run that finished and are saved: they are reused, never paid for again, by "Continue from saved work". */
  saved: { code: string; title: string }[];
  /** What would run again. */
  wouldRun: { code: string; title: string }[];
  nextAction: string;
  canContinue: boolean;
  /** Set when the run stopped on a saved report: whether the saved chain is usable now (free check). */
  recovery: RecoveryView | null;
  /**
   * For a run saved by an older build whose stored message advises something that is no longer true (it said to run the Strategy again): the
   * words the screen shows INSTEAD of that stored message. The stored message itself is never changed; it stays visible as "recorded at the time".
   */
  restated: { summary: string; phaseNote: string } | null;
}

/** The same figures as the screen: three decimals below ten cents (a request's worst case is often a cent or two), never an invented zero. */
const usd = (n: number | null) => (n === null ? 'unknown' : `$${n.toFixed(n < 0.1 ? 3 : 2)}`);

const ACTION: Record<string, string> = {
  invalid_api_key: 'Check the OpenAI API key under Settings > AI providers, then continue from saved work.',
  permission_denied: 'Check that your OpenAI key may use the chosen model (project and organization access), then continue from saved work.',
  insufficient_quota: 'Add credit to your OpenAI account (platform.openai.com > Billing), then continue from saved work.',
  rate_limited: 'Wait a few minutes (OpenAI rate limit), then continue from saved work.',
  model_unavailable: 'Choose a model your key can use under Settings > AI providers, then continue from saved work.',
  spend_limit: 'The campaign budget could not pay for the next required request: approve a larger total campaign budget, then continue from saved work.',
  report_unreadable: 'The saved reports are intact; only a format check rejected one of them, so nothing needs to run again. Once LaunchPilot can read the report, use "Continue from saved work": the saved phases are reused and only the unfinished ones run.',
  report_damaged: 'Information is missing or damaged in a saved report, so that phase has to run again (it is named above). The reports that are fine stay saved and are reused.',
  report_lineage: 'The saved reports do not belong together (another project, or built on different results). Choose a consistent set of reports, or run the affected phases again.',
};

export function explainFailure(o: {
  status: string;
  phases: FactoryPhaseState[];
  /** The failure of the failed phase when it was not stored (a run saved before it was). */
  derived: PhaseFailure | null;
  budget: BudgetView | null;
  errorMessage: string | null;
  /** The free check of the saved chain (only for a run that stopped on a saved report). */
  recovery?: RecoveryView | null;
}): FailureView | null {
  if (o.status !== 'failed' && o.status !== 'cancelled' && o.status !== 'interrupted') return null;
  const kind = o.status as FailureView['kind'];
  const bad = o.phases.find((p) => p.status === 'failed' || p.status === 'cancelled') ?? null;
  const creative = o.phases.find((p) => p.phase === 'creative') ?? null;
  const failure: PhaseFailure | null = bad?.failure ?? o.derived;
  const code = failure?.code ?? null;
  const recovery = o.recovery ?? null;
  // a run saved by an older build stored "older format, run the Strategy again"; when this version reads every saved report, that advice is not true
  const legacy = !failure && !!bad && LEGACY_UNREADABLE.test(bad.error ?? '');
  const reportStop = (!!code && REPORT_CODES.includes(code)) || legacy;
  let reason = failure?.message ?? bad?.error ?? o.errorMessage ?? 'The run stopped.';
  let detail = failure?.detail ?? null;
  let restated: FailureView['restated'] = null;
  if (legacy && recovery?.ready && bad) {
    reason = `${bad.code} ${bad.title} could not start: a saved report was rejected by the format check that was in place when this run started.`;
    detail = `Recorded at the time: "${bad.error}" That advice no longer applies: the saved F1, F2 and F3 reports are intact and this version of LaunchPilot reads all of them.`;
    restated = { summary: `${bad.code} ${bad.title} could not start in this run: a saved report was rejected by the format check that was in place then. The saved reports are intact and readable now (see below).`, phaseNote: 'Did not start: the format check of that time rejected a saved report. The saved reports are readable now.' };
  }
  const saved = o.phases.filter((p) => p.status === 'completed' || p.status === 'reused').map((p) => ({ code: p.code, title: p.title }));
  const wouldRun = o.phases.filter((p) => p.status !== 'completed' && p.status !== 'reused').map((p) => ({ code: p.code, title: p.title }));
  const requests = o.budget?.requests.image ?? 0;

  // why no image was requested
  let why: string;
  if (requests > 0) why = `${requests} image request(s) were started before the campaign stopped.`;
  else if (!creative || creative.status === 'skipped' || creative.status === 'pending') why = `Image generation did not start because ${creative?.code ?? 'F4'} ${creative?.title ?? 'Creative Production'} was never reached: ${bad ? `${bad.code} ${bad.title}` : 'an earlier phase'} ${kind === 'cancelled' ? 'was cancelled' : kind === 'interrupted' ? 'was interrupted' : 'failed'} first.`;
  else why = `Image generation did not start: ${creative.code} ${creative.title} stopped before it requested any image (${restated ? 'a saved report was rejected by the format check of that time' : (creative.error ?? reason)}).`;

  const known = o.budget ? (o.budget.knownUsd ?? 0) + (o.budget.estimatedUsd ?? 0) : null;
  const uncertain = o.budget?.uncertainUsd ?? null;
  const refused = (o.budget?.blocked ?? 0) + (o.budget?.deferred ?? 0);
  const note = [
    refused === 0 ? 'The campaign budget refused no request, so the budget did not cause this stop.' : `The campaign budget refused ${refused} request(s) (see the budget details).`,
    uncertain && uncertain > 0 ? `${usd(uncertain)} is held for request(s) that may have been billed although no usable answer came back; it is counted as spent, not as free, and it is an upper estimate (the worst case of the request), not a confirmed provider charge.` : null,
  ].filter(Boolean).join(' ');

  let nextAction: string;
  if (kind === 'cancelled') nextAction = saved.length ? `You cancelled this run. ${saved.map((s) => s.code).join(' and ')} finished and ${saved.length === 1 ? 'is' : 'are'} saved: "Continue from saved work" reuses ${saved.length === 1 ? 'it' : 'them'}. Nothing is retried automatically.` : 'You cancelled this run before any phase finished. Start a new run when you are ready.';
  else if (reportStop && recovery) {
    const bad2 = recovery.reports.filter((r) => r.status === 'unreadable' || r.status === 'missing');
    const keep = recovery.reports.filter((r) => r.status === 'current' || r.status === 'normalized').map((r) => r.code);
    if (recovery.ready) nextAction = `${recovery.reports.map((r) => r.code).join(', ')} ${recovery.reports.length === 1 ? 'is' : 'are'} saved and this version of LaunchPilot can read ${recovery.reports.length === 1 ? 'it' : 'all of them'}. Use "Continue from saved work": ${recovery.reports.length === 1 ? 'it is' : 'they are'} reused (nothing is paid for ${recovery.reports.length === 1 ? 'it' : 'them'} again) and only ${recovery.resumeFrom ? `${recovery.resumeFrom.code} ${recovery.resumeFrom.title}` : 'the unfinished phase'} runs. You approve a new campaign budget first; nothing is retried automatically.`;
    else nextAction = `${bad2.length ? bad2.map((r) => `${r.code}: ${r.message}`).join(' ') : recovery.lineageProblems.join(' ')}${keep.length ? ` ${keep.join(' and ')} ${keep.length === 1 ? 'stays' : 'stay'} saved and ${keep.length === 1 ? 'is' : 'are'} reused.` : ''}`;
  } else if (code && ACTION[code]) nextAction = ACTION[code];
  else if (saved.length) nextAction = `Use "Continue from saved work": ${saved.map((s) => s.code).join(' and ')} ${saved.length === 1 ? 'is' : 'are'} reused (nothing is paid for ${saved.length === 1 ? 'it' : 'them'} again) and ${wouldRun.map((s) => s.code).join(' and ')} run again. You approve a new campaign budget first; nothing is retried automatically.`;
  else nextAction = 'Start a new run. Nothing is retried automatically.';
  if (code === 'timeout' && kind === 'failed' && saved.length) nextAction += ' The request that timed out may already have been billed, so it is better not to repeat it blindly: the next run gives long answers a longer clock.';

  return {
    kind,
    headline: bad ? `Campaign ${kind === 'cancelled' ? 'was cancelled' : kind === 'interrupted' ? 'was interrupted' : 'stopped'} during ${bad.code} ${bad.title}.` : `Campaign ${kind === 'cancelled' ? 'was cancelled' : kind === 'interrupted' ? 'was interrupted' : 'stopped'}.`,
    phase: bad ? { code: bad.code, title: bad.title } : null,
    agent: failure?.agent ?? null,
    code,
    reason,
    detail,
    imageGeneration: { started: requests > 0, requests, why },
    spending: { knownUsd: known, uncertainUsd: uncertain, remainingUsd: o.budget?.remainingUsd ?? null, remainingBasis: o.budget?.remainingBasis ?? null, note },
    budgetContributed: refused > 0,
    saved,
    wouldRun,
    nextAction,
    canContinue: reportStop && recovery ? recovery.ready : true,
    recovery,
    restated,
  };
}
