import type { InferenceGateway } from '../../../ai/gateway';
import type { DiscoveryInput } from '../../../discovery/input';
import type { F1BoardStore, SourceStore } from '../../../discovery/f1/board';
import type { PolicyIssue } from '../../../discovery/f1/policy';
import type { DocumentExtractionTool, DocumentInput } from '../../../tools/documents';
import type { GitHubRepositoryTool } from '../../../tools/github';
import type { ImageInput, ImagePreparationTool } from '../../../tools/images';
import type { WebExtractTool } from '../../../tools/web-extract';
import type { WebFetchTool } from '../../../tools/web-fetch';
import type { WebSearchTool } from '../../../tools/web-search';
import type { RunContext } from '../../run-context';

export interface F1Tools {
  web: WebFetchTool;
  search: WebSearchTool;
  /** Rendered-text fallback for JavaScript shells and bot-protected pages. */
  extract: WebExtractTool;
  github: GitHubRepositoryTool;
  documents: DocumentExtractionTool;
  images: ImagePreparationTool;
}

export interface F1Settings {
  model: string;
  /** Output cap for analysts. Reviews use a smaller cap, the synthesizer a larger one. */
  analystTokens: number;
  reviewTokens: number;
  synthTokens: number;
  /** How long the synthesis task may take (follows the clock of its request when the clocks scale). */
  synthTimeoutMs: number;
  maxModelCalls: number;
  maxReviews: number;
  /** Deeper work: after the usual one-review-per-producer round, claims that were not reviewed yet are reviewed by ANOTHER agent (up to maxReviews). */
  depth: boolean;
  agentTimeoutMs: number;
  reviewTimeoutMs: number;
  maxWebPages: number;
  /** Test fixtures: marks every source from external tools as "fixture" (never real-world evidence). */
  fixtureSources: boolean;
}

/** Everything the F1 participants share for ONE run. Holds no credentials. */
export interface F1Env {
  ctx: RunContext;
  gateway: InferenceGateway;
  store: SourceStore;
  board: F1BoardStore;
  input: DiscoveryInput;
  settings: F1Settings;
  tools: F1Tools;
  documents: DocumentInput[];
  images: ImageInput[];
  policyIssues: PolicyIssue[];
  /** Measured palette of analyzed images (hex), set by the Visual Analyzer's tool step. */
  palette: string[];
}
