/**
 * Pure planning logic of the full-campaign orchestration: presets, settings merge, the choice of ONE coherent chain of saved
 * results to reuse, the resulting phase plan and the honest outcome label. No I/O: everything here is unit-testable and the
 * service feeds it what is actually persisted.
 */
export type PhaseKey = 'discovery' | 'audit' | 'strategy' | 'creative';
export const PHASE_ORDER: PhaseKey[] = ['discovery', 'audit', 'strategy', 'creative'];
export const PHASE_META: Record<PhaseKey, { code: 'F1' | 'F2' | 'F3' | 'F4'; title: string; mode: string }> = {
  discovery: { code: 'F1', title: 'Product Discovery', mode: 'product_discovery' },
  audit: { code: 'F2', title: 'Marketing Audit', mode: 'marketing_audit' },
  strategy: { code: 'F3', title: 'Market Research & Strategy', mode: 'market_strategy' },
  creative: { code: 'F4', title: 'Creative Production', mode: 'creative_production' },
};

export type FactoryStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export const ACTIVE_FACTORY_STATUSES: FactoryStatus[] = ['queued', 'running'];
export type PhaseStatus = 'pending' | 'reused' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type FactoryOutcome = 'in_progress' | 'approved' | 'approved_with_notes' | 'unresolved' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export interface ReusedInfo {
  createdAt: string;
  model: string | null;
  partial: boolean;
}

/** One phase of the factory run as persisted in FactoryRun.phasesJson. */
export interface FactoryPhaseState {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  /** run: the phase is executed for real (paid) | reuse: an earlier saved result is used. */
  action: 'run' | 'reuse';
  status: PhaseStatus;
  /** The child CampaignRun (its events are the agent activity). null for reused phases and before the start. */
  runId: string | null;
  /** The saved report / audit / strategy / campaign this phase produced or reused. */
  outputId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** A safe, user-facing message (never a provider message or a credential). */
  error: string | null;
  reused: ReusedInfo | null;
}

// ---- settings and presets ------------------------------------------------------------------------------------------------

export type ChannelId = 'instagram' | 'facebook' | 'linkedin' | 'youtube' | 'tiktok' | 'google_search' | 'email' | 'organic_content' | 'community';
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';

export interface FactorySettings {
  /** Text model override for every phase; null = the model saved in Settings (never switched silently). */
  model: string | null;
  f1: { maxModelCalls: number; maxReviews: number; maxOutputTokens: number | null };
  f2: { maxModelCalls: number; maxReviews: number; maxOutputTokens: number | null };
  f3: { maxModelCalls: number; maxScouts: number; maxReviews: number; maxOutputTokens: number | null; useHolidayCalendar: boolean; competitorUrls: string[]; goal: string | null; budgetNote: string | null };
  f4: {
    /** null = no image model: layouts use brand-colored backgrounds. "auto" = a current GPT Image model from the key's own list (resolved before the run). */
    imageModel: string | null;
    imageQuality: ImageQuality;
    imageSize: ImageSize | null;
    concepts: number;
    /** null = the strategy's recommended channels (up to 4). */
    channels: ChannelId[] | null;
    landing: boolean;
    maxImages: number;
    maxRegenerations: number;
    maxLayoutsPerConcept: number;
    maxRepairRounds: number;
    visionReviews: number;
    maxModelCalls: number;
    maxOutputTokens: number | null;
  };
}

export type PresetId = 'first_test' | 'demo';

/**
 * FIRST TEST: the lowest-cost real run (one concept, one channel, one low-quality image, regeneration and vision off).
 * DEMO: richer output, still bounded; costlier options (regeneration) stay off and are never preselected for the user.
 */
export const PRESETS: Record<PresetId, FactorySettings> = {
  first_test: {
    model: null,
    f1: { maxModelCalls: 12, maxReviews: 3, maxOutputTokens: null },
    f2: { maxModelCalls: 12, maxReviews: 3, maxOutputTokens: null },
    f3: { maxModelCalls: 14, maxScouts: 3, maxReviews: 3, maxOutputTokens: null, useHolidayCalendar: false, competitorUrls: [], goal: null, budgetNote: null },
    f4: { imageModel: 'auto', imageQuality: 'low', imageSize: null, concepts: 1, channels: ['instagram'], landing: true, maxImages: 1, maxRegenerations: 0, maxLayoutsPerConcept: 4, maxRepairRounds: 2, visionReviews: 0, maxModelCalls: 12, maxOutputTokens: null },
  },
  demo: {
    model: null,
    f1: { maxModelCalls: 16, maxReviews: 4, maxOutputTokens: null },
    f2: { maxModelCalls: 14, maxReviews: 4, maxOutputTokens: null },
    f3: { maxModelCalls: 24, maxScouts: 4, maxReviews: 6, maxOutputTokens: null, useHolidayCalendar: false, competitorUrls: [], goal: null, budgetNote: null },
    f4: { imageModel: 'auto', imageQuality: 'medium', imageSize: null, concepts: 3, channels: null, landing: true, maxImages: 3, maxRegenerations: 0, maxLayoutsPerConcept: 4, maxRepairRounds: 2, visionReviews: 2, maxModelCalls: 16, maxOutputTokens: null },
  },
};

type Patch<T> = { [K in keyof T]?: T[K] | null | undefined };
export interface SettingsPatch {
  model?: string | null;
  f1?: Patch<FactorySettings['f1']>;
  f2?: Patch<FactorySettings['f2']>;
  f3?: Patch<FactorySettings['f3']>;
  f4?: Patch<FactorySettings['f4']>;
}

const pick = <T extends object>(base: T, patch: Patch<T> | undefined, nullable: (keyof T)[] = []): T => {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {}) as [keyof T, unknown][]) {
    if (v === undefined) continue;
    if (v === null && !nullable.includes(k)) continue; // null only means "none" for fields where that is meaningful
    (out as Record<keyof T, unknown>)[k] = v;
  }
  return out;
};

export function mergeSettings(preset: PresetId, patch: SettingsPatch = {}): FactorySettings {
  const base = structuredClone(PRESETS[preset]);
  const f4 = pick(base.f4, patch.f4, ['imageModel', 'channels', 'imageSize', 'maxOutputTokens']);
  // an explicit image cap can never exceed the number of concepts (one base image per concept)
  f4.maxImages = Math.min(f4.maxImages, f4.concepts);
  return {
    model: patch.model ?? base.model,
    f1: pick(base.f1, patch.f1, ['maxOutputTokens']),
    f2: pick(base.f2, patch.f2, ['maxOutputTokens']),
    f3: pick(base.f3, patch.f3, ['maxOutputTokens', 'goal', 'budgetNote']),
    f4: f4.imageModel ? f4 : { ...f4, maxImages: 0, maxRegenerations: 0, visionReviews: f4.visionReviews },
  };
}

// ---- choosing ONE coherent chain of saved results -------------------------------------------------------------------------

export interface Cand {
  id: string;
  runId: string;
  createdAt: Date;
  model: string | null;
  partial: boolean;
  /** F1 only: older reports (schemaVersion < 2) have no Product Manifest and cannot feed F2. */
  usable: boolean;
}
export interface F2Cand extends Cand {
  f1ReportId: string;
}
export interface F3Cand extends Cand {
  f1ReportId: string;
  f2AuditId: string;
}
export interface F4Cand extends Cand {
  f3StrategyId: string;
  approvalStatus: string | null;
}
/** Every COMPLETED, saved result of ONE project, newest first. */
export interface Candidates {
  f1: Cand[];
  f2: F2Cand[];
  f3: F3Cand[];
  f4: F4Cand[];
}
export interface Chain {
  f1?: Cand;
  f2?: F2Cand;
  f3?: F3Cand;
  f4?: F4Cand;
}

export class LineageError extends Error {}

export interface ChainOptions {
  reusePartial: boolean;
  rerunCreative: boolean;
  explicit?: { f1ReportId?: string | null; f2AuditId?: string | null; f3StrategyId?: string | null };
}

const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));

/**
 * The deepest coherent chain F1 <- F2 <- F3 (each result must have been built on exactly the one before it, all saved and
 * completed, all from this project). Not "the newest of each table": a strategy is only reused together with the very audit and
 * report it was built on. Ties go to the newest top result.
 */
export function chooseChain(c: Candidates, o: ChainOptions): { chain: Chain; notes: string[] } {
  const notes: string[] = [];
  const ok = (x: Cand) => x.usable && (o.reusePartial || !x.partial);
  const f1s = byId(c.f1);
  const f2s = byId(c.f2);
  const f3s = byId(c.f3);
  let chain: Chain = {};

  const ex = o.explicit ?? {};
  if (ex.f3StrategyId || ex.f2AuditId || ex.f1ReportId) {
    const need = <T>(v: T | undefined, what: string, id: string): T => {
      if (!v) throw new LineageError(`The selected ${what} (${id}) is not a completed, saved result of this project.`);
      return v;
    };
    let f3: F3Cand | undefined;
    let f2: F2Cand | undefined;
    let f1: Cand | undefined;
    if (ex.f3StrategyId) {
      f3 = need(f3s.get(ex.f3StrategyId), 'strategy', ex.f3StrategyId);
      f2 = need(f2s.get(f3.f2AuditId), 'audit the strategy was built on', f3.f2AuditId);
      if (ex.f2AuditId && ex.f2AuditId !== f2.id) throw new LineageError(`The selected strategy was built on audit ${f2.id}, not on the selected audit ${ex.f2AuditId}.`);
    } else if (ex.f2AuditId) f2 = need(f2s.get(ex.f2AuditId), 'audit', ex.f2AuditId);
    if (f2) {
      f1 = need(f1s.get(f2.f1ReportId), 'Product Discovery report the audit was built on', f2.f1ReportId);
      if (ex.f1ReportId && ex.f1ReportId !== f1.id) throw new LineageError(`The selected audit was built on Product Discovery report ${f1.id}, not on the selected report ${ex.f1ReportId}.`);
      if (f3 && f3.f1ReportId !== f1.id) throw new LineageError('The selected strategy, audit and Product Discovery report do not form one chain.');
    } else if (ex.f1ReportId) f1 = need(f1s.get(ex.f1ReportId), 'Product Discovery report', ex.f1ReportId);
    for (const x of [f1, f2, f3]) if (x && !x.usable) throw new LineageError('A selected report is from an earlier version without a Product Manifest and cannot be reused. Run Product Discovery again.');
    for (const x of [f1, f2, f3]) if (x && !ok(x)) throw new LineageError('A selected report is partial. Enable "reuse partial reports" to build on it deliberately.');
    chain = { f1, f2, f3 };
  } else {
    for (const s of c.f3) {
      const a = f2s.get(s.f2AuditId);
      const f = a && f1s.get(a.f1ReportId);
      if (a && f && ok(s) && ok(a) && ok(f) && s.f1ReportId === a.f1ReportId) {
        chain = { f1: f, f2: a, f3: s };
        break;
      }
    }
    if (!chain.f3) {
      for (const a of c.f2) {
        const f = f1s.get(a.f1ReportId);
        if (f && ok(a) && ok(f)) {
          chain = { f1: f, f2: a };
          break;
        }
      }
    }
    if (!chain.f2) {
      const f = c.f1.find(ok);
      if (f) chain = { f1: f };
    }
    // say so when a newer result exists that is NOT part of the coherent chain
    const newest = (list: Cand[]) => list.find(ok);
    const nf1 = newest(c.f1);
    if (chain.f1 && nf1 && nf1.id !== chain.f1.id && nf1.createdAt > chain.f1.createdAt) notes.push('A newer Product Discovery report exists, but the saved audit/strategy was built on an earlier one. The coherent chain is reused, not the newest report of each kind.');
    const nf2 = newest(c.f2);
    if (chain.f2 && nf2 && nf2.id !== chain.f2.id && nf2.createdAt > chain.f2.createdAt) notes.push('A newer Marketing Audit exists, but the saved strategy was built on an earlier one. The coherent chain is reused.');
    const partialSkipped = !o.reusePartial && (c.f1.some((x) => x.partial) || c.f2.some((x) => x.partial) || c.f3.some((x) => x.partial));
    if (partialSkipped) notes.push('Partial saved reports are not reused (the setting is off), so the phases that depend on them run again.');
  }
  if (chain.f3 && !o.rerunCreative) {
    const camp = c.f4.find((k) => k.f3StrategyId === chain.f3!.id);
    if (camp) chain.f4 = camp;
  }
  return { chain, notes };
}

export interface PlannedPhase {
  phase: PhaseKey;
  action: 'run' | 'reuse';
  reuse: Cand | null;
}

/** continue = reuse what the chain provides; fresh = run every phase. A phase after a phase that runs always runs. */
export function buildPhasePlan(chain: Chain, mode: 'continue' | 'fresh'): PlannedPhase[] {
  const picks: Record<PhaseKey, Cand | undefined> = { discovery: chain.f1, audit: chain.f2, strategy: chain.f3, creative: chain.f4 };
  let mustRun = mode === 'fresh';
  return PHASE_ORDER.map((phase) => {
    const reuse = !mustRun ? (picks[phase] ?? null) : null;
    if (!reuse) mustRun = true;
    return { phase, action: reuse ? ('reuse' as const) : ('run' as const), reuse };
  });
}

export function initialPhases(plan: PlannedPhase[]): FactoryPhaseState[] {
  return plan.map((p) => ({
    phase: p.phase,
    code: PHASE_META[p.phase].code,
    title: PHASE_META[p.phase].title,
    action: p.action,
    status: 'pending',
    runId: null,
    outputId: p.reuse?.id ?? null,
    startedAt: null,
    completedAt: null,
    error: null,
    reused: p.reuse ? { createdAt: p.reuse.createdAt.toISOString(), model: p.reuse.model, partial: p.reuse.partial } : null,
  }));
}

/** The honest label of a finished (or running) factory run. Never "ready" when blocker/major issues remain. */
export function outcomeOf(status: FactoryStatus, approvalStatus: string | null): FactoryOutcome {
  if (status === 'queued' || status === 'running') return 'in_progress';
  if (status === 'completed') return approvalStatus === 'unresolved' ? 'unresolved' : approvalStatus === 'approved_with_notes' ? 'approved_with_notes' : 'approved';
  return status;
}

/** Expected text-model call counts of F3 (counts only; a hard cap always applies). */
export function f3Expected(s: FactorySettings['f3']) {
  const typical = 2 + s.maxScouts + Math.min(s.maxReviews, s.maxScouts + 1) + 1; // audience + seasonal, scouts, cross-checks, strategist
  return { cap: s.maxModelCalls, typical: Math.min(s.maxModelCalls, typical) };
}
