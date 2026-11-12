import type { InferenceGateway } from '../../../ai/gateway';
import type { F1Context } from '../../../audit/context';
import type { SourceStore } from '../../../discovery/f1/board';
import type { StrategyBoardStore } from '../../../strategy/board';
import type { StrategyFacts, StrategyInput } from '../../../strategy/context';
import type { StrategyPolicyContext, StrategyPolicyIssue } from '../../../strategy/policy';
import type { HolidayTool } from '../../../tools/holidays';
import type { WebExtractTool } from '../../../tools/web-extract';
import type { WebFetchTool } from '../../../tools/web-fetch';
import type { WebSearchTool } from '../../../tools/web-search';
import type { RunContext } from '../../run-context';

export interface F3Tools {
  web: WebFetchTool;
  search: WebSearchTool;
  /** Rendered-text fallback for JavaScript shells and bot-protected pages. */
  extract: WebExtractTool;
  holidays: HolidayTool;
}

export interface F3Settings {
  model: string;
  /** Output cap of the research answer. The strategy answer may use more (synthTokens). */
  analystTokens: number;
  synthTokens: number;
  /** How long the strategy task may take (follows the clock of its request when the clocks scale). */
  synthTimeoutMs: number;
  maxModelCalls: number;
  /** Deadline of the research task: deterministic gathering plus the research call. */
  agentTimeoutMs: number;
  /** Category search queries per run, competitor SITES per run, and pages read per competitor site. */
  maxSearches: number;
  maxCompetitorPages: number;
  maxPagesPerCompetitor: number;
  /** Test fixtures: marks every source from external tools as "fixture" (never real-world evidence). */
  fixtureSources: boolean;
  /** "Today" for staleness, holiday windows and prompts (injectable for tests). */
  now: Date;
}

/** Everything the F3 participants share for ONE run. Holds no credentials. */
export interface F3Env {
  ctx: RunContext;
  gateway: InferenceGateway;
  store: SourceStore;
  board: StrategyBoardStore;
  f1: F1Context;
  input: StrategyInput;
  settings: F3Settings;
  tools: F3Tools;
  facts: StrategyFacts;
  policyIssues: StrategyPolicyIssue[];
  policyContext(): StrategyPolicyContext;
}
