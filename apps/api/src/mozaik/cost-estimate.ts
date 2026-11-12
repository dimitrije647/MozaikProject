import { PRICE_BOOK_VERIFIED_AT, CLAUDE_PRICE_BOOK_VERIFIED_AT, CLAUDE_PRICE_SOURCE, isClaudeModel, PRICE_SOURCES, maxOutputTokensFor, textCostUsd, textPrice } from '@launchpilot/agents';
import type { PhaseKey } from './factory-plan';

/**
 * The preflight COST ESTIMATE of one campaign. LaunchPilot makes no image request any more, so the only paid requests are the text-model calls
 * of the three stages. Every dollar figure comes from the price book (the provider's published prices, with the date they were read) and from
 * token volumes: measured from the user's own earlier runs where they exist, otherwise from stated assumptions. It is an ESTIMATE, never a
 * guarantee and never an invoice; a model without a published price gets "unavailable", never an invented number. Pure: no I/O, no clock.
 */

export interface PhaseProfile {
  inputPerCall: number;
  outputPerCall: number;
  /** Earlier runs the averages come from (0 = the documented defaults below). */
  samples: number;
}
export type Profiles = Partial<Record<PhaseKey, PhaseProfile>>;

/** Tokens per call assumed when the user has no earlier run of a stage. They are assumptions, listed as such in every estimate. */
export const DEFAULT_PROFILE: Record<PhaseKey, { inputPerCall: number; outputPerCall: number }> = {
  discovery: { inputPerCall: 14000, outputPerCall: 2500 },
  audit: { inputPerCall: 11000, outputPerCall: 1500 },
  strategy: { inputPerCall: 16000, outputPerCall: 4000 },
  creative: { inputPerCall: 12000, outputPerCall: 3000 },
};

export interface CostPhaseInput {
  phase: PhaseKey;
  runs: boolean;
  typicalCalls: number;
  capCalls: number;
  /** The output cap sent with each call of this stage (after the model's own limit was applied). */
  outputCap: number;
}

export interface CostInput {
  textModel: string | null;
  phases: CostPhaseInput[];
  profiles: Profiles;
  approvedUsd: number | null;
}

export interface PhaseCost {
  phase: PhaseKey;
  runs: boolean;
  calls: { typical: number; cap: number };
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  outputCap: number;
  basis: 'measured' | 'assumed';
  typicalUsd: number | null;
  maxUsd: number | null;
}

export type BudgetStatus = 'no_budget' | 'within' | 'may_stop_early' | 'below_estimate' | 'unknown';

export interface CostEstimate {
  currency: 'USD';
  priceBookVerifiedAt: string;
  sources: Record<string, string>;
  /** true when every request that will be made can be priced before it is sent. */
  available: boolean;
  text: { model: string | null; priced: boolean; maxOutputTokensLimit: { limit: number; verified: boolean }; phases: PhaseCost[]; typicalUsd: number | null; maxUsd: number | null };
  totals: { typicalUsd: number | null; maxUsd: number | null };
  budget: { approvedUsd: number | null; suggestedUsd: number | null; status: BudgetStatus; message: string };
  assumptions: string[];
  warnings: string[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const up2 = (n: number) => Math.ceil(n * 100) / 100;

export function estimateCost(i: CostInput): CostEstimate {
  const priced = textPrice(i.textModel) !== null;
  const claude = isClaudeModel(i.textModel);
  const assumptions: string[] = [];
  const phases: PhaseCost[] = i.phases.map((p) => {
    const prof = i.profiles[p.phase];
    const measured = !!prof && prof.samples > 0;
    const def = DEFAULT_PROFILE[p.phase];
    const inTok = measured ? prof!.inputPerCall : def.inputPerCall;
    const outTok = measured ? prof!.outputPerCall : def.outputPerCall;
    if (p.runs) assumptions.push(measured ? `${p.phase}: ${Math.round(inTok)} input / ${Math.round(outTok)} output tokens per call, measured from ${prof!.samples} earlier run(s) of yours.` : `${p.phase}: ${inTok} input / ${outTok} output tokens per call (assumed; you have no earlier run of this stage).`);
    const typical = p.runs ? textCostUsd(i.textModel, { inputTokens: inTok * p.typicalCalls, outputTokens: outTok * p.typicalCalls }) : 0;
    // worst case: every call allowed, 1.5x the usual input and the FULL output cap (Claude also reserves its adaptive-thinking headroom)
    const capPerCall = claude ? p.outputCap + 4096 : p.outputCap;
    const max = p.runs ? textCostUsd(i.textModel, { inputTokens: inTok * 1.5 * p.capCalls, outputTokens: capPerCall * p.capCalls }) : 0;
    return { phase: p.phase, runs: p.runs, calls: { typical: p.typicalCalls, cap: p.capCalls }, inputTokensPerCall: Math.round(inTok), outputTokensPerCall: Math.round(outTok), outputCap: p.outputCap, basis: measured ? 'measured' : 'assumed', typicalUsd: typical === null ? null : r4(typical), maxUsd: max === null ? null : r4(max) };
  });
  const sum = (f: (p: PhaseCost) => number | null) => (phases.some((p) => p.runs && f(p) === null) ? null : r4(phases.reduce((a, p) => a + (f(p) ?? 0), 0)));
  const typical = sum((p) => p.typicalUsd);
  const max = sum((p) => p.maxUsd);
  const warnings: string[] = [];
  if (!priced && i.phases.some((p) => p.runs)) warnings.push(`Cost estimate unavailable for the text model "${i.textModel}": there is no verified price for it. The call and token limits still apply, but LaunchPilot cannot bound the spending in dollars.`);

  // ONE approved total for every paid request of the campaign; the estimate only informs it
  const approved = i.approvedUsd;
  let status: BudgetStatus = 'no_budget';
  let message = 'No spending limit has been set yet.';
  if (approved !== null) {
    if (typical === null) {
      status = 'unknown';
      message = `The estimate is unavailable for this text model, so $${approved.toFixed(2)} cannot be compared with it. The budget is still enforced before every request.`;
    } else if (approved < typical) {
      status = 'below_estimate';
      message = `The approved $${approved.toFixed(2)} is below the typical estimate of $${typical.toFixed(2)}: the campaign could not finish. Approve at least $${up2(max ?? typical).toFixed(2)}.`;
    } else if (max !== null && approved < max) {
      status = 'may_stop_early';
      message = `The approved $${approved.toFixed(2)} covers the typical estimate ($${typical.toFixed(2)}) but not the worst case ($${max.toFixed(2)}). If real usage is higher, requests are refused before they are sent and the campaign is saved as partial.`;
    } else {
      status = 'within';
      message = `The approved $${approved.toFixed(2)} covers the estimate (typical $${typical.toFixed(2)}, worst case ${max === null ? 'unavailable' : `$${max.toFixed(2)}`}).`;
    }
  }
  return {
    currency: 'USD',
    priceBookVerifiedAt: claude ? CLAUDE_PRICE_BOOK_VERIFIED_AT : PRICE_BOOK_VERIFIED_AT,
    sources: claude ? { ...PRICE_SOURCES, pricing: CLAUDE_PRICE_SOURCE } : { ...PRICE_SOURCES },
    available: priced,
    text: { model: i.textModel, priced, maxOutputTokensLimit: maxOutputTokensFor(i.textModel), phases, typicalUsd: typical, maxUsd: max },
    totals: { typicalUsd: typical, maxUsd: max },
    budget: { approvedUsd: approved, suggestedUsd: max === null ? (typical === null ? null : up2(typical * 1.5)) : up2(max), status, message },
    assumptions,
    warnings,
  };
}

/** Average tokens per call over earlier runs: measured from the usage their reports saved. */
export function profileFromUsage(rows: { calls: number; inputTokens: number; outputTokens: number }[]): PhaseProfile | null {
  const ok = rows.filter((r) => r.calls > 0 && r.inputTokens > 0);
  if (!ok.length) return null;
  const calls = ok.reduce((a, r) => a + r.calls, 0);
  return { inputPerCall: ok.reduce((a, r) => a + r.inputTokens, 0) / calls, outputPerCall: ok.reduce((a, r) => a + r.outputTokens, 0) / calls, samples: ok.length };
}
