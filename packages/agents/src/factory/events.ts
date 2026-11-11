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
  'copy.proposed',
  'landing.proposed',
  'visual.generated',
  'layout.completed',
  'visual.direction.published',
  'template.selection.completed',
  'images.sourcing.requested',
  'images.sourced',
  'image.generation.refused',
  'template.quality.requested',
  'template.quality.completed',
  'concept.review.requested',
  'concept.review.completed',
  'review.requested',
  'review.completed',
  'fix.requested',
  'revision.requested',
  'revision.applied',
  'revision.completed',
  'campaign.completed',
  'factory.completed',
  'factory.failed',
  'factory.cancelled',
] as const;

export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];

/** Infrastructure-only event used by the smoke test. Not part of the marketing pipeline. */
export const SMOKE_ACK_EVENT = 'test.acknowledged' as const;

export type RunMode = 'smoke_test' | 'product_discovery' | 'marketing_audit' | 'market_strategy' | 'creative_production';

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
  /** F4: the Copywriter's concepts and channel copy (text only). */
  'copy.proposed': { agent: string; summary: string; concepts: unknown[]; variants: unknown[]; missingInformation: string[] };
  /** F4: the structured landing page content. */
  'landing.proposed': { agent: string; summary: string; content: unknown; missingInformation: string[] };
  /** F4: a base image (or brand-colored base) was produced and STORED; only the asset reference travels, never the bytes. */
  'visual.generated': { agent: string; conceptId: string; /** null when a planned image failed: no stand-in asset is stored for a single failed image of a concept that has several. */ asset: unknown | null; failed: boolean; error?: SafeProviderError; directionSummary: string; /** What happened to this concept's image (generated / failed / skipped, with the reason). */ result?: unknown; /** Several images per concept: the planned image this event is about, and its full record. */ variationId?: string; variation?: unknown };
  /** F4: the layouts of one concept were rendered (asset references only). */
  'layout.completed': { agent: string; conceptId: string; assets: unknown[]; layouts: unknown[]; skipped: unknown[]; /** Hybrid Production: what happened to each template creative of this report (rendered / fallback / failed / skipped). */ templateCreatives?: unknown[] };
  /** F4 Hybrid Production: the Visual Researcher published the Visual Direction Brief (style, palette, composition, references with their permission status). */
  'visual.direction.published': { agent: string; direction: unknown; refined: boolean; note: string; /** a DiscoverySummary when web visual discovery ran (candidates and reference links only) */ discovery?: unknown };
  /** F4 Hybrid Production: the Template Selector chose a template for every planned template creative (a TemplateSelectionPlan). */
  'template.selection.completed': { agent: string; plan: unknown; mode: 'automatic' | 'assisted' | 'manual'; modelAssisted: boolean; note: string };
  /** F4 NO AI HYBRID: the coordinator asks the Visual Researcher to source and allocate pictures for the planned creatives (existing, website, repository, licensed). */
  'images.sourcing.requested': { slots: number; concepts: number };
  /** F4 NO AI HYBRID: the Visual Researcher answers with the approved pictures, their rights and which picture each creative uses (no bytes). */
  'images.sourced': { agent: string; summary: string; sourcing: unknown };
  /** F4 NO AI HYBRID: something tried to request an AI image and the guard refused it before anything was sent. Carries no prompt and no secret. */
  'image.generation.refused': { agent: string | null; reason: 'no_ai_hybrid'; count: number };
  /** F4 Hybrid Production: the coordinator asks the Template Quality Reviewer to verify the template side of the export. */
  'template.quality.requested': { planned: number };
  'template.quality.completed': { agent: string; report: unknown; error?: string };
  'review.requested': { round: number; scope: { variantIds: string[]; assetIds: string[]; landing: boolean } };
  'review.completed': { agent: string; round: number; findings: unknown[]; summary: string; modelReview: 'done' | 'partial' | 'failed' | 'skipped'; /** The six acceptance criteria as scored by the reviewer (null when only images were reviewed). */ scores?: unknown; /** Review work left out, with the reason (a limit, a failure). */ skipped?: unknown[] };
  /** F4 (depth): the concepts are critiqued BEFORE any image is paid for. */
  'concept.review.requested': { concepts: unknown[] };
  'concept.review.completed': { agent: string; critique: unknown | null; deterministic: unknown[]; modelReview: 'done' | 'failed' | 'skipped' };
  /** F4: the coordinator hands the open findings of a round to the Fixer. */
  'fix.requested': { round: number; findingIds: string[] };
  /** F4: the Fixer asks the owner of a deliverable to correct it (wave 1: copy/landing/image, wave 2: layouts). */
  'revision.requested': { agent: string; round: number; wave: number; operations: unknown[] };
  'revision.applied': { owner: string; round: number; operationIds: string[]; status: 'applied' | 'failed'; note: string; patch: unknown };
  'revision.completed': { agent: string; round: number; results: unknown[] };
  /** F4: carries the finished Campaign Package for the orchestrator to persist. */
  'campaign.completed': { report: unknown; meta: unknown };
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
