/**
 * The four stages of the LaunchPilot marketing factory.
 *
 * CONTRACTS ONLY: no phase is executed yet. These definitions are what future agent packages
 * register against (see participant-registry.ts). The infrastructure smoke test runs with
 * `currentPhase = null` and never completes a phase.
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
    label: 'Product Discovery',
    description: 'Product analysis, sources and evidence.',
    requires: [],
    produces: 'intake',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F2_MARKETING_AUDIT: {
    phase: 'F2_MARKETING_AUDIT',
    order: 2,
    label: 'Marketing Audit',
    description: 'SEO, social media, brand and messaging audit.',
    requires: ['F1_PRODUCT_DISCOVERY'],
    produces: 'audit',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F3_MARKET_STRATEGY: {
    phase: 'F3_MARKET_STRATEGY',
    order: 3,
    label: 'Market Research & Strategy',
    description: 'Audience, competitors, channel scouts, seasonal planner and campaign strategy.',
    requires: ['F1_PRODUCT_DISCOVERY', 'F2_MARKETING_AUDIT'],
    produces: 'market',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
  F4_CREATIVE_PRODUCTION: {
    phase: 'F4_CREATIVE_PRODUCTION',
    order: 4,
    label: 'Creative Production & QA',
    description: 'Copywriting, image generation, layout, review, correction and export.',
    requires: ['F1_PRODUCT_DISCOVERY', 'F2_MARKETING_AUDIT', 'F3_MARKET_STRATEGY'],
    produces: 'production',
    entryEvent: 'phase.started',
    exitEvent: 'phase.completed',
  },
};
