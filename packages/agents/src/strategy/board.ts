import type { SafeProviderError } from '../ai/errors';
import type { CrosscheckRecord, ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { EvidenceStatus } from '../discovery/schemas';
import { CHANNELS, type ChannelId } from './channels';
import type { LlmStrategyFinding, StrategyFindingKind } from './schemas';

/**
 * The F3 shared board: typed in-memory state of one Strategy run.
 * Single-writer rule: only the Strategy Coordinator mutates it, in response to Mozaik events. Never holds credentials.
 *
 * V4: ONE agent, the Marketing Strategist (A2). It gathers the competitor pages and the holiday calendar with deterministic
 * tools, writes its research findings (audience, competitors, the five social channels, timing) in one model call and the
 * campaign strategy from those committed findings in a second one. The earlier researchers, Channel Scouts and cross-checks
 * are gone; strategies saved before V4 keep their stored shape (their agent names are plain data).
 */
export const BASE_KEYS = ['strategist'] as const;
export type BaseKey = (typeof BASE_KEYS)[number];

export const STRATEGY_INFO: Record<BaseKey, { code: string; name: string; role: string; area: StrategyArea }> = {
  strategist: { code: 'A2', name: 'Marketing Strategist', role: 'Researches the audience, competitors, channels and timing from authorized sources, then writes positioning, key messages, content pillars and the channel strategy', area: 'strategy' },
};
export const STRATEGY_COORDINATOR_NAME = 'Strategy Coordinator';

export type StrategyArea = 'audience' | 'competitor' | 'channel' | 'seasonal' | 'strategy';

/** The research area of a finding follows from the typed detail it carries (one agent writes all areas). */
export const areaOfFinding = (f: Pick<LlmStrategyFinding, 'segment' | 'competitor' | 'channel' | 'opportunity'>): StrategyArea =>
  f.segment ? 'audience' : f.competitor ? 'competitor' : f.channel ? 'channel' : f.opportunity ? 'seasonal' : 'strategy';

const codeOf = (name: string) => (name === STRATEGY_INFO.strategist.name ? STRATEGY_INFO.strategist.code : '--');

export type StrategySourceType = LlmStrategyFinding['sourceType'];

/** A StrategicFinding: one evidence-bearing statement, with provenance. */
export interface StrategyFinding {
  id: string;
  agent: string;
  area: StrategyArea;
  /** Set for channel evaluations. */
  channel: ChannelId | null;
  kind: StrategyFindingKind;
  title: string;
  statement: string;
  classification: EvidenceStatus;
  importance: 'high' | 'medium' | 'low';
  sourceType: StrategySourceType;
  sourceId: string | null;
  locator: string | null;
  excerpt: string | null;
  reasoning: string;
  confidence: number | null;
  recommendation: string | null;
  segment: LlmStrategyFinding['segment'];
  competitor: LlmStrategyFinding['competitor'];
  channelEval: LlmStrategyFinding['channel'];
  opportunity: LlmStrategyFinding['opportunity'];
  /** Always not_requested for V4 runs (there is no second analyst to cross-check); older stored strategies carry real values. */
  crosscheck: { status: 'not_requested' | 'pending' | 'agreed' | 'disputed' | 'corrected' | 'insufficient'; reviewers: string[] };
  adjustment: string | null;
  at: string;
}

/** LEGACY: the Channel Scout selection of strategies saved before V4. New runs store an empty list. */
export interface ScoutDecision {
  channel: ChannelId;
  name: string;
  selected: boolean;
  score: number;
  ruleHits: string[];
  reason: string;
}

export interface StrategyPlan {
  activated: { agent: string; key: string; reason: string; dynamic?: boolean }[];
  skipped: { agent: string; key: string; reason: string }[];
}

export interface StrategyBoard {
  plan: StrategyPlan | null;
  /** LEGACY, always empty for V4 runs. */
  scoutDecisions: ScoutDecision[];
  sources: SourceRecord[];
  findings: StrategyFinding[];
  missingInformation: { agent: string; text: string }[];
  summaries: Record<string, string>;
  /** LEGACY, always empty for V4 runs. */
  crosschecks: CrosscheckRecord[];
  participantStatuses: ParticipantStatus[];
}

export class StrategyBoardStore implements StrategyBoard {
  plan: StrategyPlan | null = null;
  scoutDecisions: ScoutDecision[] = [];
  readonly sources: SourceRecord[] = [];
  readonly findings: StrategyFinding[] = [];
  readonly missingInformation: { agent: string; text: string }[] = [];
  readonly summaries: Record<string, string> = {};
  readonly crosschecks: CrosscheckRecord[] = [];
  readonly participantStatuses: ParticipantStatus[] = [];
  private counter = 0;

  setStatus(agent: string, patch: Partial<Omit<ParticipantStatus, 'agent' | 'code'>> & { error?: SafeProviderError | null }) {
    let s = this.participantStatuses.find((p) => p.agent === agent);
    if (!s) {
      s = { agent, code: codeOf(agent), state: 'waiting', reason: null, findings: 0, error: null };
      this.participantStatuses.push(s);
    }
    Object.assign(s, patch);
    return s;
  }

  addSource(r: SourceRecord) {
    if (!this.sources.some((s) => s.id === r.id)) this.sources.push(r);
  }

  /** A2-1, A2-2 ... (the Marketing Strategist's code). */
  nextFindingId(_agent: string) {
    return `${STRATEGY_INFO.strategist.code}-${++this.counter}`;
  }

  findingsBy(agent: string) {
    return this.findings.filter((f) => f.agent === agent);
  }

  snapshot(): StrategyBoard {
    return structuredClone({
      plan: this.plan,
      scoutDecisions: this.scoutDecisions,
      sources: this.sources,
      findings: this.findings,
      missingInformation: this.missingInformation,
      summaries: this.summaries,
      crosschecks: this.crosschecks,
      participantStatuses: this.participantStatuses,
    });
  }
}

export { CHANNELS };
