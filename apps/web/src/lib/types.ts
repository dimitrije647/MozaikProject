export type ProjectStatus = 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'ARCHIVED';
export type IntegrationStatus = 'NOT_CONNECTED' | 'CONFIGURED' | 'CONNECTED' | 'ERROR';

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  defaultAiProvider?: string | null;
  createdAt?: string;
}

export interface Intake {
  id: string;
  projectId: string;
  productName: string;
  shortDescription: string | null;
  websiteUrl: string | null;
  githubUrl: string | null;
  targetMarket: string | null;
  targetAudience: string | null;
  marketingGoal: string | null;
  preferredLanguage: string;
  campaignDuration: string | null;
  stylePreference: string | null;
  publishingMode: string;
  enableSeoAudit: boolean;
  enableSeasonalCalendar: boolean;
  enableGoogleDriveExport: boolean;
}

export interface Asset {
  id: string;
  projectId: string;
  type: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export interface SocialProfile {
  id: string;
  platform: string;
  url: string;
}

export interface FormatPref {
  id: string;
  formatType: string;
  enabled: boolean;
}

export interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  intake: { productName: string; marketingGoal: string | null; websiteUrl: string | null } | null;
  _count: { assets: number; notes: number; socials: number };
}

export interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  intake: Intake | null;
  assets: Asset[];
  socials: SocialProfile[];
  formats: FormatPref[];
  notes: Note[];
}

export interface Provider {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  authType: 'oauth' | 'api_key';
  isEnabled: boolean;
}

export interface UserIntegration {
  providerKey: string;
  status: IntegrationStatus;
  connectionType: 'OAUTH' | 'API_KEY' | 'PLACEHOLDER';
  displayName: string | null;
  externalAccountId: string | null;
  maskedCredential: string | null;
  connectedAt: string | null;
}

export interface MyIntegrations {
  defaultAiProvider: string | null;
  integrations: UserIntegration[];
}

export interface ApiCredentialInfo {
  id: string;
  providerKey: string;
  label: string;
  maskedKey: string;
  isActive: boolean;
  isDefault: boolean;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  eventType: string;
  eventDataJson: Record<string, unknown> | null;
  projectId: string | null;
  createdAt: string;
}

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

/** A Mozaik runtime run. Today only the infrastructure smoke test exists. */
export interface RunView {
  id: string;
  projectId: string;
  mode: string;
  label: string;
  status: RunStatus;
  currentPhase: string | null;
  provider: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  reportId: string | null;
}

export interface RunEvent {
  id: string;
  sequence: number;
  eventType: string;
  participant: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

// ---- OpenAI BYOK + Product Discovery ----

export interface OpenAiStatus {
  configured: boolean;
  maskedKey: string | null;
  model: string | null;
  verifiedModel: string | null;
  verifiedAt: string | null;
  /** A model is chosen AND a real test call succeeded for exactly that model. */
  ready: boolean;
  isDefault: boolean;
}

export interface OpenAiModelOption {
  id: string;
  ownedBy: string | null;
  created: number | null;
  likelyText: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  keyAccepted: boolean | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: { code: string; message: string };
}

export type EvidenceStatus = 'verified' | 'claimed' | 'inferred' | 'disputed' | 'unknown';

export interface Statement {
  text: string;
  status: EvidenceStatus;
  basis: string;
}
export interface EvidenceItem {
  id: string;
  statement: string;
  status: EvidenceStatus;
  sourceType: string;
  sourceReference: string | null;
  confidence: number | null;
  explanation: string | null;
}

/** Mirrors ProductDiscoveryReport in @launchpilot/agents (schemaVersion 1). */
export interface ProductDiscoveryReportData {
  schemaVersion: number;
  language: string;
  partial: boolean;
  executiveSummary: string;
  overview: { name: string; category: string; businessType: string; summary: string };
  problemAndSolution: { problem: Statement; solution: Statement };
  valueProposition: Statement;
  audienceHypotheses: Statement[];
  featuresServices: Statement[];
  differentiators: Statement[];
  strengths: Statement[];
  weaknessesAndRisks: Statement[];
  missingInformation: string[];
  evidenceAndAssumptions: EvidenceItem[];
  contradictions: { topic: string; detail: string; sources: string[] }[];
  marketingOpportunities: Statement[];
  nextSteps: { action: string; priority: 'high' | 'medium' | 'low'; rationale: string }[];
  followUpQuestions: string[];
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export interface ReportMetadata {
  model: string;
  provider: string;
  generatedAt: string;
  partial: boolean;
  usage: { total: UsageTotals; perAgent: Record<string, UsageTotals>; callsStarted: number };
  budget: { maxModelCalls: number; maxOutputTokens: number };
  agents: { name: string; status: 'succeeded' | 'failed'; error?: { code: string; message: string } }[];
  crosscheckIssues: { type: string; severity: string; detail: string; agents: string[] }[];
  reportPolicyIssues: { type: string; severity: string; detail: string; agents: string[] }[];
  inputSnapshot: {
    project: { name: string };
    truncated: boolean;
    availableNotAnalyzed: {
      websiteUrl: string | null;
      githubUrl: string | null;
      socialProfiles: { platform: string; url: string }[];
      uploads: { name: string; type: string; mimeType: string }[];
    };
  };
}

export interface ReportSummary {
  id: string;
  runId: string;
  createdAt: string;
  language: string;
  model: string;
  schemaVersion: number;
  partial: boolean;
  executiveSummary: string;
  usage: UsageTotals | null;
}

export interface ReportFull {
  id: string;
  projectId: string;
  runId: string;
  schemaVersion: number;
  language: string;
  model: string;
  createdAt: string;
  report: ProductDiscoveryReportData;
  metadata: ReportMetadata;
}
