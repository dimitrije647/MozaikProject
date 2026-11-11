import type { InferenceGateway } from '../../../ai/gateway';
import type { AuditBoardStore, AuditKey } from '../../../audit/board';
import type { AuditFacts, F1Context, SocialDetails } from '../../../audit/context';
import type { AuditPolicyIssue } from '../../../audit/policy';
import type { SourceStore } from '../../../discovery/f1/board';
import type { DocumentExtractionTool, DocumentInput } from '../../../tools/documents';
import type { ImageInput, ImagePreparationTool } from '../../../tools/images';
import type { PageSpeedTool } from '../../../tools/pagespeed';
import type { SiteAudit } from '../../../tools/seo';
import type { YouTubeTool } from '../../../tools/social';
import type { WebFetchTool } from '../../../tools/web-fetch';
import type { RunContext } from '../../run-context';
import type { PhaseAgent } from '../f1/agent';

/** The current project data F2 audits (what exists NOW; F1 supplies the product understanding). */
export interface AuditInput {
  projectName: string;
  language: string;
  websiteUrl: string | null;
  socialProfiles: { platform: string; url: string }[];
  /** Typed in by the user. Always "user provided", never verified. */
  socialDetails: SocialDetails[];
  /** The user's own words about the desired brand style (intake), if any. */
  styleNotes: string | null;
}

export interface F2Tools {
  web: WebFetchTool;
  pagespeed: PageSpeedTool;
  youtube: YouTubeTool;
  documents: DocumentExtractionTool;
  images: ImagePreparationTool;
}

export interface F2Settings {
  model: string;
  auditorTokens: number;
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
  /** Deadline for the shared website collection (crawl + robots + sitemap + link scan). */
  collectTimeoutMs: number;
  /** Pages analyzed in detail (home included). */
  maxPages: number;
  /** Extra internal links only status-checked. */
  maxLinkChecks: number;
  /** Test fixtures: marks every source from external tools as "fixture" (never real-world evidence). */
  fixtureSources: boolean;
}

/** Everything the F2 participants share for ONE run. Holds no credentials. */
export interface F2Env {
  ctx: RunContext;
  gateway: InferenceGateway;
  store: SourceStore;
  board: AuditBoardStore;
  f1: F1Context;
  input: AuditInput;
  settings: F2Settings;
  tools: F2Tools;
  documents: DocumentInput[];
  images: ImageInput[];
  facts: AuditFacts;
  policyIssues: AuditPolicyIssue[];
  agents: Map<AuditKey, PhaseAgent>;
  /** finalUrl -> source id of the page's record (written once by the SEO Auditor's collection step). */
  pageSources: Map<string, string>;
  /** Other sources produced by the shared collection (robots, sitemap, link scan, PageSpeed). */
  siteSourceIds: string[];
  siteP?: Promise<SiteAudit | null>;
  psP?: Promise<void>;
}
