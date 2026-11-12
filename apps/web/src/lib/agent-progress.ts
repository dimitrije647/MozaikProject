import type { FactoryActivityItem, PhaseKey } from './types';

/*
 * THE MOZAIK TEAM of Campaign Production (V4) and its progress, derived ONLY from the persisted Mozaik events of the run (the same history the
 * backend stores), never from client-side timers: what you see is what actually happened. Historical runs (pre-V4 agent names) still render:
 * their participants are listed by the names they recorded.
 */

export type StepState = 'waiting' | 'working' | 'done' | 'failed' | 'skipped';

export interface TeamMember {
  code: string;
  name: string;
  stage: PhaseKey;
  role: string;
  /** false = deterministic (no model call, no cost). */
  usesModel: boolean;
}

export const CAMPAIGN_TEAM: TeamMember[] = [
  { code: 'A1', name: 'Business Researcher', stage: 'discovery', role: 'Reads your intake, website, repository, documents and images; extracts evidenced facts', usesModel: true },
  { code: 'A2', name: 'Marketing Strategist', stage: 'strategy', role: 'Positioning, key messages, content pillars and the channel strategy', usesModel: true },
  { code: 'A3', name: 'Content Writer', stage: 'creative', role: 'Concepts, platform posts, ad and print copy, TikTok script', usesModel: true },
  { code: 'A4', name: 'Visual Researcher', stage: 'creative', role: 'Approved and licensed pictures, rights and provenance', usesModel: false },
  { code: 'A5', name: 'Creative Designer', stage: 'creative', role: 'Chooses templates and renders every format locally', usesModel: false },
  { code: 'A6', name: 'Quality Reviewer', stage: 'creative', role: 'Facts, brand, rights and format checks; bounded corrections', usesModel: true },
];

/** Deterministic coordinators (no model calls). */
export const COORDINATORS = ['Phase Coordinator', 'Strategy Coordinator', 'Creative Coordinator', 'Factory Orchestrator'];

export interface MemberProgress extends TeamMember {
  state: StepState;
  detail: string | null;
}

/** The state of every team member, from the run's recorded task events. */
export function teamProgress(events: FactoryActivityItem[], runActive: boolean): MemberProgress[] {
  return CAMPAIGN_TEAM.map((m) => {
    const mine = events.filter((e) => e.participant === m.name || e.summary.startsWith(m.name));
    const completed = [...mine].reverse().find((e) => e.type === 'task.completed');
    const assigned = mine.some((e) => e.type === 'task.assigned' || e.type === 'participant.registered');
    const idle = mine.find((e) => e.type === 'participant.idle');
    let state: StepState = 'waiting';
    if (completed) state = /failed|timed_out/.test(completed.summary) ? 'failed' : /skipped/.test(completed.summary) ? 'skipped' : 'done';
    else if (idle) state = 'skipped';
    else if (assigned || mine.length) state = runActive ? 'working' : 'failed';
    return { ...m, state, detail: completed?.summary ?? idle?.summary ?? null };
  });
}

/** Participants a historical run recorded that are not part of the V4 team (shown as they were, read-only). */
export function otherParticipants(events: FactoryActivityItem[]): string[] {
  const known = new Set([...CAMPAIGN_TEAM.map((m) => m.name), ...COORDINATORS]);
  return [...new Set(events.map((e) => e.participant).filter((p): p is string => !!p && !known.has(p)))];
}
