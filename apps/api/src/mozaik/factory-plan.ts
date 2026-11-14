/**
 * Pure planning logic of CAMPAIGN PRODUCTION, LaunchPilot's one production workflow: Business Research (F1) -> Marketing Strategy (F3) ->
 * Creative Production (F4). There are no presets and no modes: every new campaign runs the same stages with the same internal limits, and the
 * only choices are the ones that shape the campaign itself (objective, audience, channels, concepts, design). No I/O: unit-testable.
 *
 * Historical rows: factory runs made before V4 have four phases (F2 Marketing Audit included) and a `preset` in their config. Their saved
 * phase states are read as they are; nothing here rewrites them.
 */

/** 'audit' only appears in historical runs (the SEO/GEO Marketing Audit is no longer run). */
export type PhaseKey = 'discovery' | 'audit' | 'strategy' | 'creative';
/** The stages a NEW campaign runs, in order. */
export const PHASE_ORDER: PhaseKey[] = ['discovery', 'strategy', 'creative'];
/** Display order of every phase a stored run may contain (historical runs include the audit). */
export const ALL_PHASES: PhaseKey[] = ['discovery', 'audit', 'strategy', 'creative'];
export const PHASE_META: Record<PhaseKey, { code: 'F1' | 'F2' | 'F3' | 'F4'; title: string; mode: string }> = {
  discovery: { code: 'F1', title: 'Business Research', mode: 'product_discovery' },
  audit: { code: 'F2', title: 'Marketing Audit (historical)', mode: 'marketing_audit' },
  strategy: { code: 'F3', title: 'Marketing Strategy', mode: 'market_strategy' },
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

/** WHY a phase failed, read from the child run's own failure events; never a provider message, a prompt or a credential. */
export interface PhaseFailure {
  agent: string | null;
  code: string | null;
  message: string;
  detail: string | null;
}

/** One stage of a campaign run as persisted in FactoryRun.phasesJson. */
export interface FactoryPhaseState {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  /** run: the stage is executed (paid) | reuse: the project's current research is used again. */
  action: 'run' | 'reuse';
  status: PhaseStatus;
  runId: string | null;
  outputId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  failure?: PhaseFailure | null;
  reused: ReusedInfo | null;
}

// ---- the campaign configuration -------------------------------------------------------------------------------------------

/** The five social platforms every new campaign is produced for (a subset may be chosen). */
export const SOCIAL_CHANNELS = ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

/**
 * THE campaign configuration of a new run: only what genuinely shapes the campaign. The text provider and model are NOT here: they are the
 * defaults saved under Settings > AI providers, used automatically and never switched.
 */
export interface CampaignSettings {
  /** The campaign objective (defaults to the project's marketing goal). */
  objective: string | null;
  /** Who the campaign speaks to (defaults to the project's target audience). */
  targetAudience: string | null;
  channels: SocialChannel[];
  /** Campaign concepts (1-5). */
  concepts: number;
  competitorUrls: string[];
  useHolidayCalendar: boolean;
  /** Run Business Research again even when the project already has current research. */
  refreshResearch: boolean;
  /** The user's writing-style override; null = the brand voice is inferred from the research. */
  voice: VoiceSettings | null;
}

export interface VoiceSettings {
  tone: 'professional' | 'conversational' | 'playful' | 'premium' | 'technical' | null;
  humor: boolean | null;
  preferredTerms: string[];
  avoid: string[];
}

/** Internal limits of every stage. They are ceilings (each agent stops when its task is done), not budgets to spend, and not user settings. */
export const STAGE_LIMITS = {
  discovery: { maxModelCalls: 5, maxOutputTokens: 6000, typicalCalls: 2 },
  strategy: { maxModelCalls: 5, maxOutputTokens: 8000, typicalCalls: 2 },
  creative: { maxModelCalls: 12, maxOutputTokens: 8000, maxRepairRounds: 1, visionReviews: 2, typicalCalls: 4 },
} as const;

export const DEFAULT_CONCEPTS = 3;

export interface CampaignSettingsPatch {
  objective?: string | null;
  targetAudience?: string | null;
  channels?: string[] | null;
  concepts?: number | null;
  competitorUrls?: string[] | null;
  useHolidayCalendar?: boolean | null;
  refreshResearch?: boolean | null;
  voice?: { tone?: string | null; humor?: boolean | null; preferredTerms?: string[] | null; avoid?: string[] | null } | null;
}

const text = (v: string | null | undefined, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** The defaults come from the project (its intake); the request only overrides what it names. Pure. */
export function campaignSettings(patch: CampaignSettingsPatch, project: { marketingGoal: string | null; targetAudience: string | null; seasonalCalendar: boolean }): CampaignSettings {
  const channels = (patch.channels ?? []).filter((c): c is SocialChannel => (SOCIAL_CHANNELS as readonly string[]).includes(c));
  return {
    objective: text(patch.objective, 300) ?? text(project.marketingGoal, 300),
    targetAudience: text(patch.targetAudience, 300) ?? text(project.targetAudience, 300),
    channels: channels.length ? [...new Set(channels)] : [...SOCIAL_CHANNELS],
    concepts: Math.max(1, Math.min(5, Math.round(patch.concepts ?? DEFAULT_CONCEPTS))),
    competitorUrls: [...new Set((patch.competitorUrls ?? []).map((u) => u.trim()).filter(Boolean))].slice(0, 5),
    useHolidayCalendar: patch.useHolidayCalendar ?? project.seasonalCalendar,
    refreshResearch: patch.refreshResearch === true,
    voice: voiceSettings(patch.voice),
  };
}

const TONES = ['professional', 'conversational', 'playful', 'premium', 'technical'] as const;
const words = (list: string[] | null | undefined, n: number, max: number) => [...new Set((list ?? []).map((w) => (typeof w === 'string' ? w.trim().slice(0, max) : '')).filter(Boolean))].slice(0, n);

/** The writing-style override, or null when the user set nothing (then the voice is inferred). Pure. */
export function voiceSettings(v: CampaignSettingsPatch['voice']): VoiceSettings | null {
  if (!v) return null;
  const tone = (TONES as readonly string[]).includes(v.tone ?? '') ? (v.tone as VoiceSettings['tone']) : null;
  const out: VoiceSettings = { tone, humor: typeof v.humor === 'boolean' ? v.humor : null, preferredTerms: words(v.preferredTerms, 10, 60), avoid: words(v.avoid, 12, 80) };
  return out.tone || out.humor !== null || out.preferredTerms.length || out.avoid.length ? out : null;
}

// ---- reusing the project's research ---------------------------------------------------------------------------------------

export interface ResearchCandidate {
  id: string;
  runId: string;
  createdAt: Date;
  model: string | null;
  partial: boolean;
  /** Reports older than schema version 2 have no Product Manifest and cannot be built on. */
  usable: boolean;
}

/**
 * Business Research is the only stage that is reused: it describes the business, not the campaign. It is reused when the newest usable report
 * is newer than every change to the project's information (intake, uploads, approved brand content); otherwise, or when asked, it runs again.
 * The strategy runs for each campaign (it depends on its objective and audience) except when a campaign whose creative stage failed is continued
 * with unchanged settings (planStrategyResume); the creative stage always runs.
 */
export function planResearch(candidates: ResearchCandidate[], inputsChangedAt: Date | null, refresh: boolean): { reuse: ResearchCandidate | null; note: string | null } {
  if (refresh) return { reuse: null, note: 'Business Research runs again, as requested.' };
  const newest = candidates.find((c) => c.usable);
  if (!newest) return { reuse: null, note: null };
  if (inputsChangedAt && inputsChangedAt > newest.createdAt) return { reuse: null, note: 'The project information changed after the last Business Research, so it runs again.' };
  return { reuse: newest, note: `The project's Business Research of ${newest.createdAt.toISOString().slice(0, 10)} is current and is reused (no paid request for it).${newest.partial ? ' It is partial: some sources could not be read when it was made.' : ''}` };
}

export interface PlannedPhase {
  phase: PhaseKey;
  action: 'run' | 'reuse';
  reuse: ResearchCandidate | null;
}

/** The settings a strategy depends on: two campaigns with the same key and the same Business Research need the same strategy. */
export function strategySettingsKey(s: Pick<CampaignSettings, 'objective' | 'targetAudience' | 'competitorUrls' | 'useHolidayCalendar'>): string {
  return JSON.stringify([s.objective ?? null, s.targetAudience ?? null, [...(s.competitorUrls ?? [])].sort(), s.useHolidayCalendar === true]);
}

/** A strategy saved by an earlier campaign that STOPPED before its creative stage finished. */
export interface StrategyResumeCandidate {
  /** the saved strategy report */
  strategy: ResearchCandidate;
  /** the Business Research it was built on */
  f1ReportId: string;
  /** strategySettingsKey of the campaign that made it */
  settingsKey: string;
  /** that campaign's creative stage did not produce a campaign (failed, cancelled, interrupted, not started) */
  creativeUnfinished: boolean;
}

/**
 * CONTINUING AFTER A FAILED CREATIVE STAGE. A strategy is normally made for each campaign. It is reused - so a campaign whose Creative Production
 * failed does not pay for research and strategy again - ONLY when all of this holds: the Business Research is reused (the same report), the
 * strategy was saved by the newest earlier campaign of the project whose creative stage did not finish, it was built on that same research,
 * the strategy settings (objective, audience, competitors, holiday calendar) are unchanged, the project did not change after it, and the user did
 * not ask for fresh research. Anything else: the strategy runs again.
 */
export function planStrategyResume(o: { research: ResearchCandidate | null; candidate: StrategyResumeCandidate | null; settingsKey: string; inputsChangedAt: Date | null; refresh: boolean }): { reuse: ResearchCandidate | null; note: string | null } {
  const c = o.candidate;
  if (o.refresh || !o.research || !c || !c.creativeUnfinished || !c.strategy.usable) return { reuse: null, note: null };
  if (c.f1ReportId !== o.research.id) return { reuse: null, note: null };
  if (c.settingsKey !== o.settingsKey) return { reuse: null, note: 'The campaign settings that shape the strategy changed since the last attempt, so the strategy runs again.' };
  if (o.inputsChangedAt && o.inputsChangedAt > c.strategy.createdAt) return { reuse: null, note: null };
  return { reuse: c.strategy, note: `The Marketing Strategy saved on ${c.strategy.createdAt.toISOString().slice(0, 10)} by the last campaign, whose Creative Production did not finish, is reused (no paid request for it). Only the creative stage runs again.` };
}

export function buildPhasePlan(research: ResearchCandidate | null, strategy: ResearchCandidate | null = null): PlannedPhase[] {
  return PHASE_ORDER.map((phase) => (phase === 'discovery' && research ? { phase, action: 'reuse' as const, reuse: research } : phase === 'strategy' && strategy && research ? { phase, action: 'reuse' as const, reuse: strategy } : { phase, action: 'run' as const, reuse: null }));
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

/** The honest label of a finished (or running) campaign run. Never "ready" when blocker/major issues remain. */
export function outcomeOf(status: FactoryStatus, approvalStatus: string | null): FactoryOutcome {
  if (status === 'queued' || status === 'running') return 'in_progress';
  if (status === 'completed') return approvalStatus === 'unresolved' ? 'unresolved' : approvalStatus === 'approved_with_notes' ? 'approved_with_notes' : 'approved';
  return status;
}
