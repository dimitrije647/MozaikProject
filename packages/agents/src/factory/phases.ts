/**
 * The stages of LaunchPilot's one production workflow (Campaign Production): Business Research -> Marketing Strategy -> Creative Production.
 * F2_MARKETING_AUDIT is kept ONLY so events of historical runs keep a valid phase name; V4 never runs it and nothing requires it.
 */
export const FACTORY_PHASES = [
  'F1_PRODUCT_DISCOVERY',
  'F2_MARKETING_AUDIT',
  'F3_MARKET_STRATEGY',
  'F4_CREATIVE_PRODUCTION',
] as const;

export type FactoryPhase = (typeof FACTORY_PHASES)[number];

/** The shared board each phase writes its output to. */
export type BoardName = 'intake' | 'audit' | 'market' | 'production';

export interface PhaseContract {
  readonly phase: FactoryPhase;
  readonly order: number;
  readonly label: string;
  readonly description: string;
  /** Phases whose boards must be complete before this one starts. */
  readonly requires: readonly FactoryPhase[];
  /** Board this phase owns and writes to. */
  readonly produces: BoardName;
  /** Event that opens the phase / event that must be emitted to close it. */
  readonly entryEvent: 'phase.started';
  readonly exitEvent: 'phase.completed';
}

export const PHASE_CONTRACTS: Readonly<Record<FactoryPhase, PhaseContract>> = {
  F1_PRODUCT_DISCOVERY: {
    phase: 'F1_PRODUCT_DISCOVERY',
    order: 1,
    label: 'Business Research',
    description: 'Business Researcher: the company, its offering, audience and market from authorized sources.',
    requires: [],
    produces: 'intake',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F2_MARKETING_AUDIT: {
    phase: 'F2_MARKETING_AUDIT',
    order: 2,
    label: 'Marketing Audit (historical, not run since V4)',
    description: 'Historical only: runs saved before V4.',
    requires: ['F1_PRODUCT_DISCOVERY'],
    produces: 'audit',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F3_MARKET_STRATEGY: {
    phase: 'F3_MARKET_STRATEGY',
    order: 3,
    label: 'Marketing Strategy',
    description: 'Marketing Strategist: positioning, key messages, content pillars and channel strategy.',
    requires: ['F1_PRODUCT_DISCOVERY'],
    produces: 'market',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F4_CREATIVE_PRODUCTION: {
    phase: 'F4_CREATIVE_PRODUCTION',
    order: 4,
    label: 'Creative Production & QA',
    description: 'Content Writer, Visual Researcher, Creative Designer and Quality Reviewer: copy, approved pictures, template rendering, review and export. No AI images.',
    requires: ['F1_PRODUCT_DISCOVERY', 'F3_MARKET_STRATEGY'],
    produces: 'production',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
};
