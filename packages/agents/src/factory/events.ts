import type { FactoryPhase } from './phases';
import type { SafeProviderError } from '../ai/errors';

/**
 * Typed event names for the factory, carried by Mozaik `SemanticEvent`s.
 *
 * IMPLEMENTED (F1 Product Discovery + the infrastructure smoke test):
 *   factory.started, phase.started, task.assigned, source.retrieved, finding.posted, task.completed,
 *   participant.idle, crosscheck.requested, crosscheck.answered, phase.ready, report.generated,
 *   phase.completed, phase.failed, factory.completed, factory.failed, factory.cancelled,
 *   test.acknowledged (smoke test only)
 *
 * PLANNED, names reserved, nothing emits them yet:
 *   check.passed, check.failed
 */
export const FACTORY_EVENT_TYPES = [
  'factory.started',
  'phase.started',
  'finding.posted',
  'crosscheck.requested',
  'crosscheck.answered',
  'source.retrieved',
  'participant.idle',
  'phase.ready',
  'phase.completed',
  'phase.failed',
  'task.assigned',
  'task.completed',
  'check.passed',
  'check.failed',
  'report.generated',
  'audit.completed',
  'strategy.completed',
  'participant.registered',
  'factory.completed',
  'factory.failed',
  'factory.cancelled',
] as const;

export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];

/** Infrastructure-only event used by the smoke test. Not part of the marketing pipeline. */
export const SMOKE_ACK_EVENT = 'test.acknowledged' as const;

export type RunMode = 'smoke_test' | 'product_discovery' | 'marketing_audit' | 'market_strategy';

export type TerminalReason = 'timeout' | 'participant_error' | 'cancelled' | 'server_shutdown';

export interface AgentOutcome {
  agent: string;
  error?: SafeProviderError;
}

/** Payloads for events that are emitted today. Keep these JSON-serializable and secret-free. */
export interface FactoryEventPayloads {
  'factory.started': { mode: RunMode; label: string };
  /** `plan` lists which agents were activated and which skipped, each with the reason. */
  'phase.started': { phase: FactoryPhase; agents: string[]; plan?: unknown };
  'task.assigned': { agent: string; task: string };
  /** A deterministic tool retrieved (or failed to retrieve) a source. `source` is a SourceRecord. */
  'source.retrieved': { agent: string; source: unknown };
  /** Carries the agent's structured findings: this is how the other participants receive them. */
  'finding.posted': { agent: string; summary: string; findings: unknown[]; missingInformation: string[] };
  'task.completed': { agent: string; outcome: 'succeeded' | 'failed' | 'skipped'; error?: SafeProviderError; reason?: string };
  /** An agent that was not activated (no input for it). Not a failure. */
  'participant.idle': { agent: string; reason: string; skipped: boolean; /** F3 Channel Scouts that were not created. */ channel?: string; score?: number; ruleHits?: string[] };
  'crosscheck.requested': { requestId: string; producer: string; reviewer: string; claims: unknown[] };
  'crosscheck.answered': { requestId: string; producer: string; reviewer: string; status: 'answered' | 'failed'; answers: unknown[]; error?: SafeProviderError };
  'phase.ready': { phase: FactoryPhase; succeeded: string[]; failed: AgentOutcome[]; skipped: string[]; crosschecks: { requested: number; answered: number; failed: number } };
  'report.generated': { report: unknown; meta: unknown };
  /** F2: carries the finished Marketing Audit Report for the orchestrator to persist. */
  'audit.completed': { report: unknown; meta: unknown };
  /** F3: carries the finished Campaign Strategy Report for the orchestrator to persist. */
  'strategy.completed': { report: unknown; meta: unknown };
  /**
   * A participant was created and joined the Mozaik runtime AFTER the phase started (F3 Channel Scouts).
   * Not selected candidates are announced with `participant.idle` (skipped) and their reason.
   */
  'participant.registered': { agent: string; role: string; channel: string | null; reason: string; score: number | null; ruleHits: string[] };
  'phase.completed': { phase: FactoryPhase };
  'phase.failed': { phase: FactoryPhase; reason: string; errors: AgentOutcome[] };
  'test.acknowledged': { by: string; receivedEvent: 'factory.started' };
  'factory.completed': { mode: RunMode; phasesCompleted: FactoryPhase[] };
  'factory.failed': { reason: TerminalReason; message: string; participant?: string; code?: string };
  'factory.cancelled': { reason: TerminalReason };
}

/** Shape reserved for planned events until their contracts are designed. */
export type PlannedEventPayload = Record<string, unknown>;

export type EmittedEventType = keyof FactoryEventPayloads;

export type PayloadFor<T extends string> = T extends EmittedEventType ? FactoryEventPayloads[T] : PlannedEventPayload;
