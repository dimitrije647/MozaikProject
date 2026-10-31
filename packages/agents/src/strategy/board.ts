import type { SafeProviderError } from '../ai/errors';
import type { CrosscheckRecord, ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { EvidenceStatus } from '../discovery/schemas';
import type { FindingKind } from '../audit/board';
import { CHANNELS, channelById, channelOfScoutName, scoutName, type ChannelId } from './channels';
import type { LlmStrategyFinding } from './schemas';

/**
 * The F3 shared board: typed in-memory state of one Market Research & Strategy run.
 * Same single-writer rule as F1/F2: only the Strategy Coordinator mutates it, in response to Mozaik events.
 * Never holds credentials.
 */
export const BASE_KEYS = ['audience', 'competitor', 'seasonal', 'strategist'] as const;
export type BaseKey = (typeof BASE_KEYS)[number];
/** Base researchers that run first (the Channel Scouts depend on them). */
export const RESEARCHER_KEYS = ['audience', 'competitor', 'seasonal'] as const;
export type ResearcherKey = (typeof RESEARCHER_KEYS)[number];

export const STRATEGY_INFO: Record<BaseKey, { code: string; name: string; role: string; area: StrategyArea }> = {
  audience: { code: 'A14', name: 'Audience Researcher', role: 'Customer segments, needs and barriers (as hypotheses unless evidenced)', area: 'audience' },
  competitor: { code: 'A15', name: 'Competitor Researcher', role: 'Real competitors from retrieved sources and their observable positioning', area: 'competitor' },
  seasonal: { code: 'A17', name: 'Seasonal Intelligence', role: 'Time-sensitive and seasonal opportunities', area: 'seasonal' },
  strategist: { code: 'A18', name: 'Campaign Strategist', role: 'Combines F1, F2 and the research into the campaign strategy', area: 'strategy' },
};
export const SCOUT_CODE = 'A16';
export const STRATEGY_COORDINATOR_NAME = 'Strategy Coordinator';

export type StrategyArea = 'audience' | 'competitor' | 'channel' | 'seasonal' | 'strategy';

export type StrategyAgentKind = { key: BaseKey } | { key: 'scout'; channel: ChannelId };
/** Resolves a participant name to its role (scouts are named "<Channel> Scout"). */
export function strategyRoleByName(name: string): StrategyAgentKind | undefined {
  for (const k of BASE_KEYS) if (STRATEGY_INFO[k].name === name) return { key: k };
  const channel = channelOfScoutName(name);
  return channel ? { key: 'scout', channel } : undefined;
}
export const areaOf = (name: string): StrategyArea => {
  const r = strategyRoleByName(name);
  return !r ? 'strategy' : r.key === 'scout' ? 'channel' : STRATEGY_INFO[r.key].area;
};
const codeOf = (name: string) => {
  const r = strategyRoleByName(name);
  return !r ? '--' : r.key === 'scout' ? SCOUT_CODE : STRATEGY_INFO[r.key].code;
};

export type StrategySourceType = LlmStrategyFinding['sourceType'];

/** A StrategicFinding: one evidence-bearing statement of one participant, with provenance. */
export interface StrategyFinding {
  id: string;
  agent: string;
  area: StrategyArea;
  /** Set for Channel Scout findings. */
  channel: ChannelId | null;
  kind: FindingKind;
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
  crosscheck: { status: 'not_requested' | 'pending' | 'agreed' | 'disputed' | 'corrected' | 'insufficient'; reviewers: string[] };
  adjustment: string | null;
  at: string;
}

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
  scoutDecisions: ScoutDecision[];
  sources: SourceRecord[];
  findings: StrategyFinding[];
  missingInformation: { agent: string; text: string }[];
  summaries: Record<string, string>;
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
  private counters = new Map<string, number>();

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

  /** A14-1, A15-2, A17-1, A16-IG-1 ... Unique per participant. */
  nextFindingId(agent: string) {
    const role = strategyRoleByName(agent);
    const prefix = !role ? 'F' : role.key === 'scout' ? `${SCOUT_CODE}-${channelById(role.channel)!.short}` : STRATEGY_INFO[role.key].code;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
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

export { CHANNELS, scoutName };
