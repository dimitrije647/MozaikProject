import type { Refusal, SpendSnapshot } from '@launchpilot/agents';

/**
 * What the screen shows about the ONE campaign budget. It is built from the ledger (live while a run is going, saved when it stopped) and,
 * for runs made before the shared budget existed, from what they recorded (derived: the approved total and the known usage only; their
 * old separate text/image amounts stay visible as history and are never turned into a new authorization). Unknown amounts are null, never 0.
 */
export interface BudgetView {
  source: 'live' | 'saved' | 'derived';
  approvedUsd: number | null;
  knownUsd: number | null;
  estimatedUsd: number | null;
  reservedUsd: number | null;
  uncertainUsd: number | null;
  committedUsd: number | null;
  remainingUsd: number | null;
  /** How far `remainingUsd` can be trusted: exact (all spend measured), estimated (some spend is held, estimated or uncertain), unknown (a request of unknown price finished), uncapped (no limit set). */
  remainingBasis: 'exact' | 'estimated' | 'unknown' | 'uncapped';
  requests: { text: number | null; image: number | null; imageCap: number | null };
  unknownCostRequests: number;
  imagesGenerated: number | null;
  currentPhase: string | null;
  /** Informational only: what the money went to. These are NEVER separate budgets. null = unknown. */
  breakdown: { agentsUsd: number | null; imagesUsd: number | null; reviewsUsd: number | null };
  blocked: number;
  deferred: number;
  /** Plain-language reasons why a request was not started (newest last). */
  refusals: string[];
  /** Honest notes about what the figures can and cannot say. */
  notes: string[];
  /** Runs made with the earlier text/image pools: the historical amounts, shown as history only. */
  legacy: null | { textPoolUsd: number | null; imagePoolUsd: number | null; note: string };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** One refusal in words: why the ledger did not start a request, with the figures that decided it. */
export function refusalText(r: Refusal): string {
  const what = r.kind === 'image' ? 'an image request' : 'a text request';
  const need = r.neededUsd === null ? 'of unknown price' : `needing about ${usd(r.neededUsd)}`;
  switch (r.reason) {
    case 'over_budget':
      return `The campaign budget did not start ${what} ${need}: only ${usd(r.availableUsd ?? 0)} of the approved budget could still be spent.`;
    case 'protected_for_required_work':
      return r.priority <= 2
        ? `The campaign budget did not start ${what} ${need}: ${usd(r.protectedUsd)} is kept for the essential analysis of the phases that follow, and only ${usd(r.availableUsd ?? 0)} could still be spent on it.`
        : `The campaign budget did not start ${what} ${need}: ${usd(r.protectedUsd)} is kept for required work that is not paid for yet (the essential analysis and the required original images come before optional checks), and only ${usd(r.availableUsd ?? 0)} could still be spent on it.`;
    case 'image_request_cap':
      return 'No further image request was started: the approved maximum number of image requests was reached.';
    default:
      return `The campaign budget did not start ${what} ${need}: nothing was left to spend.`;
  }
}

/** From a ledger snapshot (live or saved). */
export function budgetViewOf(s: SpendSnapshot, o: { source: 'live' | 'saved'; currentPhase: string | null; imagesGenerated: number | null; legacyPools?: { text: number | null; image: number | null } | null }): BudgetView {
  const imagesUnknown = s.image.unknown > 0 && s.image.spentUsd + s.image.uncertainUsd === 0;
  const notes: string[] = [];
  if (s.unknownCostRequests > 0) notes.push(`${s.unknownCostRequests} request(s) finished without a known price, so their cost is NOT included in these figures and the remaining budget may be lower than shown.`);
  if (s.uncertainUsd > 0) notes.push(`${usd(s.uncertainUsd)} is held for request(s) that may have been billed although no usable result came back (a timeout or a cancel after sending). It is counted as spent, not as free.`);
  if (s.remainingBasis === 'uncapped') notes.push('No spending limit was set for this run: usage is measured, and only the request limits apply.');
  return {
    source: o.source,
    approvedUsd: s.approvedUsd,
    knownUsd: s.knownUsd,
    estimatedUsd: s.estimatedUsd,
    reservedUsd: s.reservedUsd,
    uncertainUsd: s.uncertainUsd,
    committedUsd: s.committedUsd,
    remainingUsd: s.remainingUsd,
    remainingBasis: s.remainingBasis,
    requests: { text: s.requests.text, image: s.requests.image, imageCap: s.requests.imageCap },
    unknownCostRequests: s.unknownCostRequests,
    imagesGenerated: o.imagesGenerated,
    currentPhase: o.currentPhase,
    breakdown: { agentsUsd: s.breakdown.agentsUsd, imagesUsd: imagesUnknown ? null : s.breakdown.imagesUsd, reviewsUsd: s.breakdown.reviewsUsd },
    blocked: s.blocked,
    deferred: s.deferred,
    refusals: s.refusals.map(refusalText),
    notes,
    legacy: o.legacyPools ? { textPoolUsd: o.legacyPools.text, imagePoolUsd: o.legacyPools.image, note: 'This run was made with separate text and image budgets. Those amounts are kept as history; they are not a spending permission for anything new.' } : null,
  };
}

/** For a run that has no saved ledger (made before the shared budget existed): the approved total and the usage it recorded. Nothing is invented. */
export function derivedBudgetView(o: { approvedUsd: number | null; textUsd: number | null; imageUsd: number | null; imagesGenerated: number | null; textPoolUsd: number | null; imagePoolUsd: number | null; currentPhase: string | null; textCalls: number | null }): BudgetView {
  const imagesUnknown = o.imageUsd === null && (o.imagesGenerated ?? 0) > 0;
  const known = (o.textUsd ?? 0) + (o.imageUsd ?? 0);
  const textKnown = o.textUsd !== null;
  const remaining = o.approvedUsd === null || !textKnown || imagesUnknown ? null : Math.max(0, o.approvedUsd - known);
  const notes = ['This run was saved before the shared campaign budget existed. The figures below are what its recorded usage adds up to, at the published prices; they are not a ledger.'];
  if (imagesUnknown) notes.push('The cost of its images was not recorded, so it is shown as unknown and the remaining amount is unknown.');
  return {
    source: 'derived',
    approvedUsd: o.approvedUsd,
    knownUsd: textKnown ? known : null,
    estimatedUsd: null,
    reservedUsd: null,
    uncertainUsd: null,
    committedUsd: textKnown ? known : null,
    remainingUsd: remaining,
    remainingBasis: remaining === null ? 'unknown' : 'estimated',
    requests: { text: o.textCalls, image: null, imageCap: null },
    unknownCostRequests: imagesUnknown ? o.imagesGenerated ?? 0 : 0,
    imagesGenerated: o.imagesGenerated,
    currentPhase: o.currentPhase,
    breakdown: { agentsUsd: o.textUsd, imagesUsd: o.imageUsd, reviewsUsd: null },
    blocked: 0,
    deferred: 0,
    refusals: [],
    notes,
    legacy: o.textPoolUsd !== null || o.imagePoolUsd !== null ? { textPoolUsd: o.textPoolUsd, imagePoolUsd: o.imagePoolUsd, note: 'This run was made with separate text and image budgets. Those amounts are kept as history; they are not a spending permission for anything new.' } : null,
  };
}

