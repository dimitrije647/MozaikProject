import type { FactoryPhase } from './phases';

/**
 * Typed event names for the factory, carried by Mozaik `SemanticEvent`s.
 *
 * IMPLEMENTED now (emitted by the infrastructure smoke test):
 *   factory.started, test.acknowledged, factory.completed, factory.failed, factory.cancelled
 *
 * PLANNED (names and payload shapes reserved, nothing emits them yet):
 *   phase.started, phase.ready, phase.completed, phase.failed, finding.posted,
 *   crosscheck.answered, participant.idle, task.assigned, task.completed, check.passed, check.failed
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
  'factory.completed',
  'factory.failed',
  'factory.cancelled',
] as const;

export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];

/** Infrastructure-only event used by the smoke test. Not part of the marketing pipeline. */
export const SMOKE_ACK_EVENT = 'test.acknowledged' as const;

export type RunMode = 'smoke_test';

export type TerminalReason = 'timeout' | 'participant_error' | 'cancelled' | 'server_shutdown';

/** Payloads for events that are emitted today. Keep these JSON-serializable and secret-free. */
export interface FactoryEventPayloads {
  'factory.started': { mode: RunMode; label: string };
  'test.acknowledged': { by: string; receivedEvent: 'factory.started' };
  'factory.completed': { mode: RunMode; phasesCompleted: FactoryPhase[] };
  'factory.failed': { reason: TerminalReason; message: string; participant?: string };
  'factory.cancelled': { reason: TerminalReason };
}

/** Shape reserved for planned events until their contracts are designed. */
export type PlannedEventPayload = Record<string, unknown>;

export type EmittedEventType = keyof FactoryEventPayloads;

export type PayloadFor<T extends string> = T extends EmittedEventType
  ? FactoryEventPayloads[T]
  : PlannedEventPayload;
