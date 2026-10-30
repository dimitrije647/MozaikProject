import type { FactoryPhase } from './phases';
import type { SafeProviderError } from '../ai/errors';

/**
 * Typed event names for the factory, carried by Mozaik `SemanticEvent`s.
 *
 * IMPLEMENTED (Product Discovery / F1 + the infrastructure smoke test):
 *   factory.started, phase.started, task.assigned, finding.posted, task.completed, phase.ready,
 *   crosscheck.answered, report.generated, phase.completed, phase.failed,
 *   factory.completed, factory.failed, factory.cancelled, test.acknowledged (smoke test only)
 *
 * PLANNED, names reserved, nothing emits them yet:
 *   participant.idle, check.passed, check.failed
 */
export const FACTORY_EVENT_TYPES = [
  'factory.started',
  'phase.started',
  'finding.posted',
  'crosscheck.answered',
  'participant.idle',
  'phase.ready',
  'phase.completed',
  'phase.failed',
  'task.assigned',
  'task.completed',
  'check.passed',
  'check.failed',
  'report.generated',
  'factory.completed',
  'factory.failed',
  'factory.cancelled',
] as const;

export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];

/** Infrastructure-only event used by the smoke test. Not part of the marketing pipeline. */
export const SMOKE_ACK_EVENT = 'test.acknowledged' as const;

export type RunMode = 'smoke_test' | 'product_discovery';

export type TerminalReason = 'timeout' | 'participant_error' | 'cancelled' | 'server_shutdown';

export type FindingKind = 'input_analysis' | 'text_analysis';

export interface AgentOutcome {
  agent: string;
  error?: SafeProviderError;
}

/** Payloads for events that are emitted today. Keep these JSON-serializable and secret-free. */
export interface FactoryEventPayloads {
  'factory.started': { mode: RunMode; label: string };
  'phase.started': { phase: FactoryPhase; agents: string[] };
  'task.assigned': { agent: string; task: FindingKind };
  /** Carries the agent's full structured finding: this is how the other agents receive it. */
  'finding.posted': { agent: string; kind: FindingKind; finding: unknown };
  'task.completed': { agent: string; outcome: 'succeeded' | 'failed'; error?: SafeProviderError };
  'phase.ready': { phase: FactoryPhase; succeeded: string[]; failed: AgentOutcome[] };
  'crosscheck.answered': {
    phase: FactoryPhase;
    succeeded: string[];
    failed: AgentOutcome[];
    partial: boolean;
    issues: unknown[];
    findings: unknown;
  };
  'report.generated': { report: unknown; meta: unknown };
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
