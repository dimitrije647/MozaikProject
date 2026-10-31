import { RuntimeState } from '@mozaik-ai/core';
import { AuditBoardStore } from '../audit/board';
import { F1BoardStore } from '../discovery/f1/board';
import { StrategyBoardStore } from '../strategy/board';
import { CreativeBoardStore } from '../creative/board';
import type { BoardName, FactoryPhase } from './phases';

export type CampaignRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const TERMINAL_STATUSES: readonly CampaignRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export const isTerminal = (s: CampaignRunStatus) => TERMINAL_STATUSES.includes(s);

/**
 * Read-only snapshot of the product brief given to a run. Built by the backend from the
 * intake row. MUST NOT contain secrets (API keys, tokens): this object is held in shared
 * state and may be echoed into events.
 */
export interface CampaignManifest {
  productName: string;
  description?: string | null;
  websiteUrl?: string | null;
  githubUrl?: string | null;
  marketingGoal?: string | null;
  targetMarket?: string | null;
  targetAudience?: string | null;
  language?: string | null;
  [extra: string]: unknown;
}

/** A finding an agent posts to a board. Extension point for future phases. */
export interface Finding {
  id: string;
  phase: FactoryPhase;
  author: string;
  summary: string;
  evidence?: Record<string, unknown>;
  at: string;
}

/** Placeholder board shape; each phase will narrow this when its agents are designed. */
export type Board = Record<string, unknown>;

/** An event as recorded for history. Always sanitized before it is stored here. */
export interface RecordedEvent {
  runId: string;
  sequence: number;
  type: string;
  phase: FactoryPhase | null;
  participant: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

/** Cap for the in-memory event list. Full history lives in PostgreSQL (CampaignEvent). */
export const MAX_IN_MEMORY_EVENTS = 500;

/**
 * Mozaik runtime state for one factory run.
 *
 * Boundaries:
 *  - This object lives only in memory for the lifetime of the run (it is NOT restored after a restart).
 *  - Durable history (status, events) is persisted by the backend via the `onEvent` sink.
 *  - Credentials are never stored here; they live only inside the run's inference runner closure.
 */
export class FactoryRuntimeState extends RuntimeState {
  currentPhase: FactoryPhase | null = null;
  status: CampaignRunStatus = 'running';
  readonly boards: Record<BoardName, Board> = { intake: {}, audit: {}, market: {}, production: {} };
  /** F1 shared board (single writer: the Phase Coordinator). */
  readonly f1 = new F1BoardStore();
  /** F2 shared board (single writer: the Audit Coordinator). */
  readonly f2 = new AuditBoardStore();
  /** F3 shared board (single writer: the Strategy Coordinator). */
  readonly f3 = new StrategyBoardStore();
  /** F4 shared board (single writer: the Creative Coordinator). */
  readonly f4 = new CreativeBoardStore();
  readonly findings: Finding[] = [];
  readonly events: RecordedEvent[] = [];
  readonly startedAt: string = new Date().toISOString();
  completedAt?: string;

  constructor(
    readonly runId: string,
    readonly projectId: string,
    readonly userId: string,
    readonly manifest: Readonly<CampaignManifest>,
  ) {
    super();
  }

  pushEvent(event: RecordedEvent) {
    this.events.push(event);
    if (this.events.length > MAX_IN_MEMORY_EVENTS) this.events.shift();
  }
}
