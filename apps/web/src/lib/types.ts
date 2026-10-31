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
  /** Derived from the saved runs and results; `status` above is the user's own lifecycle label. */
  pipeline?: PipelineSummaryData | null;
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
  /** Set for Marketing Audit runs once their report is saved. */
  auditId: string | null;
  /** Set for Market Research & Strategy runs once their report is saved. */
  strategyId: string | null;
  /** Set for Creative Production runs (the campaign row exists from the start). */
  campaignId?: string | null;
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
  /** Looks like an image model (gpt-image, dall-e). */
  likelyImage?: boolean;
  /** A GPT Image model LaunchPilot can call for F4 (dall-e uses another contract and is not offered). */
  imageSupported?: boolean;
  /** OpenAI shut this model down: it can still be LISTED, but requests are refused. */
  retired?: { on: string; replacements: string[] } | null;
}

/** POST /integrations/openai/image-test: ONE billed image request, only on an explicit press. The image is discarded. */
export interface ImageTestResult {
  ok: boolean;
  model: string;
  requestMade: boolean;
  latencyMs: number;
  error?: { code: string; stage: string; status: number | null; providerCode: string | null; explanation: string };
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
  activated?: number | null;
  skipped?: number | null;
}

export interface ReportFull {
  id: string;
  projectId: string;
  runId: string;
  schemaVersion: number;
  language: string;
  model: string;
  createdAt: string;
  /** schemaVersion 1 = legacy text-only report, 2 = F1 seven-agent report. */
  report: ProductDiscoveryReportData | ProductDiscoveryReportV2Data;
  metadata: ReportMetadata | ReportMetadataV2;
}

// ---- F1 (schemaVersion 2) ----

export interface V2Statement {
  text: string;
  status: EvidenceStatus;
  basis: string;
  findingIds: string[];
}

export interface ProductManifestData {
  name: string;
  tagline: string | null;
  category: string;
  industry: string | null;
  businessType: string;
  offering: { summary: string; items: string[] };
  problem: string | null;
  valueProposition: string | null;
  targetCustomers: string[];
  geography: string[];
  languages: string[];
  goals: string[];
  differentiators: string[];
  brand: { style: string | null; palette: string[]; notes: string | null } | null;
  onlinePresence: { website: string | null; repository: string | null; socialProfiles: string[] };
  openQuestions: string[];
  overallConfidence: number;
  confidenceNotes: string;
  evidenceFindingIds: string[];
}

export interface ProductDiscoveryReportV2Data {
  schemaVersion: number;
  language: string;
  partial: boolean;
  executiveSummary: string;
  identity: { name: string; category: string; industry: string | null; businessType: string; summary: string };
  problemAndSolution: { problem: V2Statement; solution: V2Statement };
  offerings: V2Statement[];
  valueProposition: V2Statement;
  targetCustomers: V2Statement[];
  differentiation: V2Statement[];
  websiteFindings: V2Statement[];
  repositoryFindings: V2Statement[];
  documentFindings: V2Statement[];
  visualFindings: V2Statement[];
  strengths: V2Statement[];
  weaknessesRisksUnknowns: V2Statement[];
  evidenceSummary: { narrative: string; contradictions: { topic: string; detail: string; findingIds: string[]; status: 'open' | 'resolved' }[] };
  missingInformation: string[];
  recommendedInvestigations: { action: string; priority: 'high' | 'medium' | 'low'; rationale: string }[];
  productManifest: ProductManifestData;
}

export type CrosscheckStatus = 'not_requested' | 'pending' | 'agreed' | 'disputed' | 'corrected' | 'insufficient';

export interface F1Finding {
  id: string;
  agent: string;
  category: string;
  statement: string;
  classification: EvidenceStatus;
  sourceType: string;
  sourceId: string | null;
  locator: string | null;
  excerpt: string | null;
  confidence: number | null;
  importance: string;
  adjustment?: string | null;
  createdAt?: string;
  crosscheck: { status: CrosscheckStatus; reviewers: string[] };
}

export interface F1Source {
  id: string;
  agent: string;
  kind: string;
  label: string;
  url?: string | null;
  status: 'retrieved' | 'failed' | 'skipped' | 'unsupported';
  live: boolean;
  fixture: boolean;
  httpStatus?: number | null;
  error?: string | null;
  notes: string[];
  injectionSuspected?: boolean;
  retrievedAt?: string;
}

export interface F1Participant {
  agent: string;
  state: 'waiting' | 'working' | 'done' | 'failed' | 'skipped' | 'timed_out';
  reason?: string | null;
  error?: { code: string; message: string } | null;
}

export interface F1Crosscheck {
  requestId: string;
  claimId: string;
  producer: string;
  reviewer: string;
  status: 'pending' | 'answered' | 'timed_out' | 'failed';
  verdict?: 'agree' | 'disagree' | 'correct' | 'insufficient_evidence' | null;
  rationale?: string | null;
  correction?: string | null;
  error?: string | null;
}

export interface F1Plan {
  activated: { key: string; agent: string; reason: string }[];
  skipped: { key: string; agent: string; reason: string }[];
}

export interface ReportMetadataV2 {
  schemaVersion: number;
  model: string;
  provider: string;
  generatedAt: string;
  partial: boolean;
  usage: { total: UsageTotals; perAgent: Record<string, UsageTotals>; callsStarted: number };
  budget: { maxModelCalls: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  plan: F1Plan;
  participants: F1Participant[];
  sources: F1Source[];
  findings: F1Finding[];
  crosschecks: F1Crosscheck[];
  aiCalls: Record<string, number>;
  analyzed: { website: boolean; repository: boolean; documents: boolean; visual: boolean };
  notAnalyzed: { label: string; reason: string }[];
  policyIssues: { type: string; detail: string }[];
  tools: { search: string; searchConfigured: boolean; fixtureSources: boolean };
}

/** GET /runs/:id/analysis: from the saved report when there is one, otherwise folded from events. */
export interface RunAnalysis {
  runId: string;
  status: RunStatus;
  source: 'report' | 'events';
  reportId: string | null;
  plan: F1Plan | null;
  participants: F1Participant[];
  sources: F1Source[];
  findings: F1Finding[];
  crosschecks: F1Crosscheck[];
  usage: ReportMetadataV2['usage'] | null;
  aiCalls: Record<string, number>;
  notAnalyzed: { label: string; reason: string }[];
  tools: ReportMetadataV2['tools'] | null;
  policyIssues: { type: string; detail: string }[];
}

// ---- F2 Marketing Audit ----

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AuditArea = 'seo' | 'social' | 'brand' | 'messaging' | 'presence' | 'cross';

export interface AuditStatementData {
  text: string;
  status: EvidenceStatus;
  severity: Severity | null;
  basis: string;
  recommendation: string | null;
  findingIds: string[];
}

export interface AuditSectionData {
  assessment: string;
  statements: AuditStatementData[];
}

export interface MetricRow {
  label: string;
  value: string;
}

export interface MarketingAuditReportData {
  schemaVersion: number;
  language: string;
  partial: boolean;
  executiveSummary: string;
  seo: AuditSectionData;
  social: AuditSectionData;
  brand: AuditSectionData;
  messaging: AuditSectionData;
  presence: AuditSectionData;
  mainProblems: { title: string; area: AuditArea; severity: Severity; status: EvidenceStatus; description: string; impact: string; recommendation: string; findingIds: string[] }[];
  contradictions: { topic: string; detail: string; findingIds: string[]; status: 'open' | 'resolved' }[];
  strengths: AuditStatementData[];
  weaknesses: AuditStatementData[];
  opportunities: { title: string; priority: 'high' | 'medium' | 'low'; area: AuditArea; rationale: string; effort: 'low' | 'medium' | 'high'; findingIds: string[] }[];
  additionalLimitations: string[];
  f3Handoff: { positioningQuestions: string[]; audienceHypothesesToTest: string[]; channelHypotheses: string[]; priorityThemes: string[]; constraints: string[] };
  productContext: { f1ReportId: string; f1SchemaVersion: number; f1GeneratedAt: string | null; name: string; category: string; businessType: string; summary: string; offering: string; valueProposition: string | null; targetCustomers: string[]; f1Confidence: number; f1Partial: boolean };
  websiteHealth: {
    websiteUrl: string | null;
    reachable: boolean | null;
    pagesAnalyzed: number;
    robots: string;
    sitemap: string;
    brokenInternalLinks: number | null;
    pageSpeed: { status: 'measured' | 'unavailable'; note: string; metrics: MetricRow[] };
    perPage: { url: string; status: number; title: string | null; metaDescription: string | null; h1Count: number; canonical: string | null; noindex: boolean; viewport: boolean; structuredData: string[] }[];
  };
  socialPlatforms: { platform: string; url: string | null; access: 'live_api' | 'user_provided' | 'export' | 'fixture' | 'unavailable' | 'not_supplied' | 'invalid'; note: string; metrics: MetricRow[] }[];
  channels: { platform: string; url: string | null; state: string; linkedFromWebsite: boolean | null }[];
  limitations: string[];
  evidenceAppendix: {
    findings: { id: string; agent: string; area: string; kind: string; title: string; statement: string; classification: EvidenceStatus; severity: Severity; sourceId: string | null; locator: string | null; excerpt: string | null; recommendation: string | null; crosscheck: string; at: string }[];
    sources: { id: string; kind: string; label: string; status: string; origin: string; live: boolean; fixture: boolean; error: string | null }[];
  };
}

export interface AuditFindingData {
  id: string;
  agent: string;
  area: AuditArea;
  kind: string;
  title: string;
  statement: string;
  classification: EvidenceStatus;
  severity: Severity;
  sourceType: string;
  sourceId: string | null;
  locator: string | null;
  excerpt: string | null;
  recommendation: string | null;
  confidence: number | null;
  adjustment: string | null;
  at: string;
  crosscheck: { status: CrosscheckStatus; reviewers: string[] };
}

export interface AuditSource extends Omit<F1Source, 'kind'> {
  kind: string;
  origin?: string;
}

export interface AuditMetadata {
  schemaVersion: number;
  model: string;
  generatedAt: string;
  partial: boolean;
  usage: ReportMetadataV2['usage'];
  budget: { maxModelCalls: number; auditorTokens: number; reviewTokens: number; synthTokens: number };
  f1: { reportId: string; schemaVersion: number; generatedAt: string | null; model: string | null; partial: boolean };
  plan: F1Plan;
  participants: F1Participant[];
  sources: AuditSource[];
  findings: AuditFindingData[];
  crosschecks: F1Crosscheck[];
  aiCalls: Record<string, number>;
  notAnalyzed: { label: string; reason: string }[];
  policyIssues: { type: string; detail: string }[];
  tools: { pagespeed: { configured: boolean; calls: number }; youtube: { configured: boolean; calls: number }; fixtureSources: boolean };
}

export interface AuditSummary {
  id: string;
  runId: string;
  f1ReportId: string;
  createdAt: string;
  language: string;
  model: string;
  schemaVersion: number;
  partial: boolean;
  executiveSummary: string;
  usage: UsageTotals | null;
  activated: number | null;
  skipped: number | null;
  findings: number | null;
}

export interface AuditFull {
  id: string;
  projectId: string;
  runId: string;
  f1ReportId: string;
  schemaVersion: number;
  language: string;
  model: string;
  createdAt: string;
  report: MarketingAuditReportData;
  metadata: AuditMetadata;
}

/** GET /runs/:id/analysis for a Marketing Audit run (the same endpoint F1 uses). */
export interface AuditAnalysis {
  runId: string;
  status: RunStatus;
  kind: 'audit' | 'discovery';
  source: 'report' | 'events';
  reportId: string | null;
  plan: F1Plan | null;
  participants: F1Participant[];
  sources: AuditSource[];
  findings: AuditFindingData[];
  crosschecks: F1Crosscheck[];
  usage: ReportMetadataV2['usage'] | null;
  aiCalls: Record<string, number>;
  notAnalyzed: { label: string; reason: string }[];
  policyIssues: { type: string; detail: string }[];
  f1?: AuditMetadata['f1'] | null;
}

export interface SocialDetailInput {
  platform: string;
  bio?: string;
  followers?: number;
  postsPerMonth?: number;
}

// ---- F3 Market Research & Strategy ----

export type StrategyArea = 'audience' | 'competitor' | 'channel' | 'seasonal' | 'strategy';
export type ChannelId = 'instagram' | 'facebook' | 'linkedin' | 'youtube' | 'tiktok' | 'google_search' | 'email' | 'organic_content' | 'community';

export interface SegmentDetailData {
  name: string;
  kind: 'b2b' | 'b2c' | 'mixed';
  needs: string[];
  painPoints: string[];
  motivations: string[];
  barriers: string[];
  decisionProcess: string | null;
  messagingPreferences: string[];
  productFit: 'strong' | 'moderate' | 'weak' | 'unknown';
}
export interface CompetitorDetailData {
  name: string;
  url: string | null;
  relation: 'direct' | 'indirect' | 'unverified';
  existence: 'confirmed' | 'unconfirmed';
  positioning: string | null;
  offerings: string[];
  differentiators: string[];
  weaknesses: string[];
  crowdedTheme: string | null;
}
export interface ChannelDetailData {
  channel: ChannelId;
  fit: 'strong' | 'moderate' | 'weak' | 'unsuitable';
  audienceFit: string;
  organicSuitability: 'high' | 'medium' | 'low';
  paidSuitability: 'high' | 'medium' | 'low' | 'unknown';
  contentTypes: string[];
  complexity: 'low' | 'medium' | 'high';
  constraints: string[];
  measurement: string[];
  risks: string[];
  role: 'primary' | 'secondary' | 'test' | 'skip';
}
export interface OpportunityDetailData {
  name: string;
  window: string;
  startDate: string | null;
  endDate: string | null;
  dateBasis: 'public_holiday_api' | 'recurring_pattern' | 'user_provided' | 'speculative';
  leadTimeWeeks: number | null;
  relevance: string;
  regionNote: string | null;
}

/** A StrategicFinding on the F3 board. */
export interface StrategyFindingData {
  id: string;
  agent: string;
  area: StrategyArea;
  channel: ChannelId | null;
  kind: string;
  title: string;
  statement: string;
  classification: EvidenceStatus;
  importance: 'high' | 'medium' | 'low';
  sourceType: string;
  sourceId: string | null;
  locator: string | null;
  excerpt: string | null;
  reasoning: string;
  confidence: number | null;
  recommendation: string | null;
  segment: SegmentDetailData | null;
  competitor: CompetitorDetailData | null;
  channelEval: ChannelDetailData | null;
  opportunity: OpportunityDetailData | null;
  crosscheck: { status: CrosscheckStatus; reviewers: string[] };
  adjustment: string | null;
  at: string;
}

export interface ScoutDecisionData {
  channel: ChannelId;
  name: string;
  selected: boolean;
  score: number;
  ruleHits: string[];
  reason: string;
}

export interface StrategyStatementData {
  text: string;
  status: EvidenceStatus;
  basis: string;
  caveat: string | null;
  findingIds: string[];
}

export interface F4CreativeBriefData {
  objective: string;
  audiencePrimary: string;
  audienceSecondary: string[];
  messagingPriorities: string[];
  channels: { channel: ChannelId; formats: string[]; notes: string }[];
  visualDirection: string | null;
  brandConstraints: string[];
  claimsToAvoid: { claim: string; reason: string }[];
  requiredEvidence: string[];
  deliverables: { type: string; channel: ChannelId | null; count: number }[];
  suggestedConceptCount: number;
  toneOfVoice: string | null;
  productIdentity: { name: string; category: string; businessType: string; summary: string; valueProposition: string | null };
  language: string;
  visualPalette: string[];
  visualBasis: 'f1_measured_palette' | 'none';
  provenance: { f1ReportId: string; f2AuditId: string; strategyRunId: string | null };
}

type FindingRef = { findingId: string; agent: string; status: EvidenceStatus; confidence: number | null; sourceId: string | null; locator: string | null; crosscheck: string };

export interface CampaignStrategyReportData {
  schemaVersion: number;
  language: string;
  partial: boolean;
  executiveSummary: string;
  priorityAudiences: { segmentName: string; priority: 'primary' | 'secondary' | 'later'; rationale: string; findingIds: string[] }[];
  campaignGoals: { goal: string; measuredBy: string; rationale: string; findingIds: string[] }[];
  valueProposition: StrategyStatementData;
  positioning: { statement: StrategyStatementData; differentiators: StrategyStatementData[]; crowdedThemesToAvoid: string[] };
  mainMessages: { message: string; audience: string; proofNeeded: string[]; findingIds: string[] }[];
  channels: { channel: ChannelId; role: 'primary' | 'secondary' | 'test'; approach: 'organic' | 'paid' | 'mixed'; rationale: string; formats: string[]; findingIds: string[] }[];
  organicPaid: { approach: string; paidRole: string; budgetNote: string };
  timing: { window: string; rationale: string; dateBasis: OpportunityDetailData['dateBasis']; findingIds: string[] }[];
  contentPillars: { name: string; description: string; channels: ChannelId[]; findingIds: string[] }[];
  campaignStructure: { phase: string; duration: string; objective: string; activities: string[] }[];
  kpis: { kpi: string; channel: ChannelId | null; measuredBy: string }[];
  risks: { risk: string; mitigation: string; findingIds: string[] }[];
  strategicPriorities: { priority: string; rationale: string; findingIds: string[] }[];
  disagreements: { topic: string; positions: string[]; resolution: string; resolved: boolean; findingIds: string[] }[];
  openQuestions: string[];
  additionalLimitations: string[];
  productContext: { f1ReportId: string; f1SchemaVersion: number; f1GeneratedAt: string | null; name: string; category: string; businessType: string; summary: string; offering: string; valueProposition: string | null; targetCustomers: string[]; geography: string[]; f1Confidence: number };
  existingMarketing: { f2AuditId: string; f2SchemaVersion: number; f2GeneratedAt: string | null; ageDays: number | null; stale: boolean; partial: boolean; mainProblems: { title: string; severity: string; area: string; status: EvidenceStatus }[]; contradictions?: { topic: string; detail: string; status: 'open' | 'resolved' }[]; notes: string[] };
  audienceResearch: { segment: SegmentDetailData; status: EvidenceStatus; statement: string; reasoning: string; ref: FindingRef }[];
  competitorLandscape: {
    searchProvider: string;
    searchUsed: boolean;
    userSuppliedUrls: number;
    userSuppliedNames?: number;
    namesNotFound?: string[];
    pagesRetrieved?: number;
    sitesRead?: { name: string; host: string | null; origin: string; pages: number; via: string; socialPlatforms: string[] }[];
    profiles: { competitor: CompetitorDetailData; status: EvidenceStatus; statement: string; ref: FindingRef }[];
    gaps: string[];
  };
  channelEvaluation: {
    evaluated: { scout: string; evaluation: ChannelDetailData; status: EvidenceStatus; statement: string; reasoning: string; ref: FindingRef }[];
    notSelected: { channel: ChannelId; reason: string; score: number }[];
    selection: { channel: ChannelId; selected: boolean; score: number; ruleHits: string[]; reason: string }[];
  };
  seasonalOpportunities: { holidayCalendar: { used: boolean; country: string | null; note: string; holidays: { date: string; name: string }[] }; opportunities: { opportunity: OpportunityDetailData; status: EvidenceStatus; statement: string; ref: FindingRef }[] };
  evidence: {
    findingCount: number;
    byStatus: Record<string, number>;
    crosschecks: { claimId: string; producer: string; reviewer: string; verdict: string | null; rationale: string | null; status: string }[];
    sources: { id: string; kind: string; label: string; status: string; origin: string; live: boolean; fixture: boolean; error: string | null }[];
    findings: { id: string; agent: string; kind: string; title: string; statement: string; classification: EvidenceStatus; sourceId: string | null; locator: string | null; excerpt: string | null; crosscheck: string; at: string }[];
  };
  limitations: string[];
  metrics: MetricRow[];
  creativeBrief: F4CreativeBriefData;
}

export interface StrategyMetadata {
  schemaVersion: number;
  model: string;
  generatedAt: string;
  partial: boolean;
  usage: ReportMetadataV2['usage'];
  budget: { maxModelCalls: number; maxScouts: number; maxReviews: number; analystTokens: number; reviewTokens: number; synthTokens: number };
  f1: { reportId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean };
  f2: { auditId: string; schemaVersion: number; generatedAt: string | null; ageDays: number | null; partial: boolean };
  plan: (Omit<F1Plan, 'activated'> & { activated: (F1Plan['activated'][number] & { dynamic?: boolean })[] });
  scoutDecisions: ScoutDecisionData[];
  participants: F1Participant[];
  sources: AuditSource[];
  findings: StrategyFindingData[];
  crosschecks: F1Crosscheck[];
  aiCalls: Record<string, number>;
  notAnalyzed: { label: string; reason: string }[];
  policyIssues: { type: string; detail: string }[];
  tools: { search: { provider: string; configured: boolean; used: boolean }; holidays: { used: boolean; calls: number }; fixtureSources: boolean };
}

export interface StrategySummary {
  id: string;
  runId: string;
  f1ReportId: string;
  f2AuditId: string;
  createdAt: string;
  language: string;
  model: string;
  schemaVersion: number;
  partial: boolean;
  executiveSummary: string;
  usage: UsageTotals | null;
  scouts: number | null;
  findings: number | null;
}

export interface StrategyFull {
  id: string;
  projectId: string;
  runId: string;
  f1ReportId: string;
  f2AuditId: string;
  schemaVersion: number;
  language: string;
  model: string;
  createdAt: string;
  report: CampaignStrategyReportData;
  metadata: StrategyMetadata;
}

/** GET /runs/:id/strategy-analysis: from the saved report when there is one, otherwise folded from the persisted events. */
export interface StrategyAnalysis {
  runId: string;
  status: RunStatus;
  kind: 'strategy' | 'audit' | 'discovery';
  source: 'report' | 'events';
  reportId: string | null;
  plan: StrategyMetadata['plan'] | null;
  scoutDecisions: ScoutDecisionData[];
  participants: F1Participant[];
  sources: AuditSource[];
  findings: StrategyFindingData[];
  crosschecks: F1Crosscheck[];
  usage: ReportMetadataV2['usage'] | null;
  aiCalls: Record<string, number>;
  notAnalyzed: { label: string; reason: string }[];
  policyIssues: { type: string; detail: string }[];
  f1?: StrategyMetadata['f1'] | null;
  f2?: StrategyMetadata['f2'] | null;
}

export interface StartStrategyInput {
  auditId?: string;
  maxModelCalls?: number;
  maxScouts?: number;
  maxReviews?: number;
  maxOutputTokens?: number;
  competitorUrls?: string[];
  competitorNames?: string[];
  goal?: string;
  budgetNote?: string;
  useHolidayCalendar?: boolean;
}

// ---- F4 Creative Production ----

export type CampaignStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ApprovalStatus = 'approved' | 'approved_with_notes' | 'unresolved';
export type ClaimSupport = 'brief' | 'f1' | 'f2' | 'f3' | 'user' | 'hypothesis';
export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'info';

export interface ConceptData {
  id: string;
  name: string;
  angle: string;
  keyMessage: string;
  audience: string;
  ctaType: string;
  ctaText: string;
  visualIdea: string;
}

export interface CopyVariantData {
  id: string;
  conceptId: string;
  channel: ChannelId;
  placement: string;
  length: string;
  headline: string;
  body: string;
  description: string | null;
  ctaText: string;
  ctaType: string;
  hashtags: string[];
  claims: { text: string; support: ClaimSupport; ref: string | null }[];
  version: number;
  history: { version: number; headline: string; body: string; ctaText: string; reason: string }[];
}

export interface CampaignAssetData {
  id: string;
  kind: 'image' | 'layout';
  conceptId: string;
  channel: ChannelId | null;
  format: string | null;
  version: number;
  parentAssetId: string | null;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  source: 'ai_image' | 'brand_gradient';
  model: string | null;
  quality: string | null;
  requestedSize: string | null;
  status: 'generated' | 'rendered' | 'superseded' | 'failed';
  flags: string[];
  altText: string | null;
  promptMetadata: { promptChars: number; directionSummary: string } | null;
  usage: { input: number; output: number; total: number } | null;
  createdAt: string;
}

/** An asset as the API lists it: the metadata plus the authenticated file URL (relative to the API). */
export interface CampaignAssetView extends CampaignAssetData {
  url: string;
}

export interface ChannelLayoutData {
  id: string;
  conceptId: string;
  variantId: string;
  assetId: string;
  baseAssetId: string;
  format: string;
  channel: ChannelId;
  headline: string;
  ctaText: string;
  flags: string[];
}

export interface LandingContentData {
  seoTitle: string;
  metaDescription: string;
  hero: { headline: string; description: string; ctaText: string };
  valueProposition: string;
  benefits: { title: string; text: string; evidence: ClaimSupport; ref: string | null }[];
  sections: { title: string; body: string }[];
  howItWorks: { step: string; text: string }[];
  faq: { q: string; a: string }[];
  trustSignals: { text: string; evidence: ClaimSupport; ref: string | null }[];
  ctas: { objective: string; text: string }[];
  ctaObjective: string;
  mobileHierarchy: string[];
}

export interface ReviewFindingData {
  id: string;
  round: number;
  kind: string;
  severity: IssueSeverity;
  assetRef: string | null;
  finding: string;
  evidence: string;
  suggestedCorrection: string;
  responsibleAgent: 'copywriter' | 'landing' | 'layout' | 'visual';
  source: 'deterministic' | 'llm_text' | 'llm_vision';
  status: 'open' | 'fixed' | 'unresolved' | 'accepted';
  resolvedInRound: number | null;
}

export interface RevisionData {
  id: string;
  round: number;
  findingId: string;
  operation: 'revise_copy' | 'revise_landing' | 'rerender_layout' | 'regenerate_image' | 'none';
  owner: string;
  status: 'applied' | 'failed' | 'skipped';
  before: string | null;
  after: string | null;
  note: string;
}

export interface CampaignUsage {
  text: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; perAgent: Record<string, { calls: number; totalTokens: number }> };
  images: { model: string | null; quality: string | null; size: string | null; requested: number; generated: number; failed: number; regenerations: number; limits: { maxImages: number; maxRegenerations: number }; providerReportedTokens: { input: number; output: number; total: number } | null };
  layouts: { rendered: number; skipped: number };
}

/** What happened to ONE concept's original image: generated, failed (stage + the provider's own words) or skipped (limit / configuration). */
export interface ImageResultData {
  conceptId: string;
  conceptName: string;
  model: string | null;
  /** false = no request was made for this concept. */
  requestAttempted: boolean;
  outcome: 'generated' | 'failed' | 'skipped';
  stage: 'configuration' | 'budget' | 'planning' | 'provider' | 'decoding' | 'storage' | 'cancelled' | null;
  errorCode: string | null;
  providerStatus: number | null;
  providerCode: string | null;
  message: string | null;
  explanation: string | null;
  /** true = the layouts use a brand-colored background instead of an AI image. */
  fallbackUsed: boolean;
  assetId: string;
  /** true = derived afterwards from the run's recorded events (the campaign was saved before results were recorded). */
  reconstructed?: boolean;
}

export interface CampaignPackageData {
  id: string;
  projectId: string;
  runId: string;
  f1ReportId: string;
  f2ReportId: string;
  f3StrategyId: string;
  schemaVersion: number;
  campaignName: string;
  language: string;
  concepts: ConceptData[];
  copyVariants: CopyVariantData[];
  imageAssets: CampaignAssetData[];
  /** One entry per concept (absent in campaigns saved before this existed). */
  imageResults?: ImageResultData[];
  channelLayouts: ChannelLayoutData[];
  skippedLayouts: { conceptId: string; format: string; channel: ChannelId; reason: string }[];
  landingContent: LandingContentData | null;
  reviewFindings: ReviewFindingData[];
  revisions: RevisionData[];
  approval: { status: ApprovalStatus; rounds: number; unresolvedFindingIds: string[]; note: string };
  usage: CampaignUsage;
  limitations: string[];
  createdAt: string;
}

export interface CampaignSummary {
  id: string;
  projectId: string;
  runId: string;
  f1ReportId: string;
  f2AuditId: string;
  f3StrategyId: string;
  schemaVersion: number;
  language: string;
  model: string;
  imageModel: string | null;
  status: CampaignStatus;
  approvalStatus: ApprovalStatus | null;
  campaignName: string;
  createdAt: string;
  concepts: number | null;
  variants: number | null;
  layouts: number | null;
  generatedImages: number | null;
  findings: number | null;
  unresolved: number | null;
  usage: CampaignUsage | null;
}

export interface CreativeSettingsSnapshot {
  channels: string[];
  concepts: number;
  formats: string[];
  imageGeneration: boolean;
  imageModel: string | null;
  imageQuality: string | null;
  imageSize: string | null;
  maxImages: number;
  maxRegenerations: number;
  maxRepairRounds: number;
  maxModelCalls: number;
}

export interface ImageUsageData {
  model: string | null;
  quality: string | null;
  size: string | null;
  requestsStarted: number;
  attempts: number;
  generated: number;
  failed: number;
  regenerationsStarted: number;
  limits: { maxImages: number; maxRegenerations: number };
  tokens: { input: number; output: number; total: number } | null;
}

export interface CreativeMetadata {
  schemaVersion: number;
  model: string;
  imageModel: string | null;
  generatedAt: string;
  partial: boolean;
  usage: ReportMetadataV2['usage'];
  images: ImageUsageData | null;
  settings: CreativeSettingsSnapshot | null;
  plan: StrategyMetadata['plan'];
  participants: F1Participant[];
  sources: AuditSource[];
  crosschecks: F1Crosscheck[];
  summaries: Record<string, string>;
  aiCalls: Record<string, number>;
  why: string;
  modelReviewFailed: boolean;
  chain: { f1ReportId: string; f2AuditId: string; f3StrategyId: string };
  brand?: { palette: string[]; fromBrand: boolean; logo: boolean } | null;
}

export interface CampaignFull extends CampaignSummary {
  package: CampaignPackageData | null;
  metadata: CreativeMetadata | null;
  assets: CampaignAssetView[];
}

export interface CampaignReviews {
  campaignId: string;
  status: CampaignStatus;
  approval: CampaignPackageData['approval'] | null;
  findings: ReviewFindingData[];
  revisions: RevisionData[];
  limitations: string[];
}

export interface CreativeTimelineEntry {
  sequence: number;
  type: string;
  participant: string | null;
  at: string;
  summary: string;
}

export interface CreativeProgress {
  concepts: number;
  variants: number;
  landing: boolean;
  images: number;
  imagesFailed: number;
  layouts: number;
  skippedLayouts: number;
  round: number;
  findings: number;
  repairsApplied: number;
  repairsFailed: number;
}

/** GET /runs/:id/creative-analysis: from the saved campaign when there is one, otherwise folded from the persisted events. */
export interface CreativeAnalysis {
  runId: string;
  status: RunStatus;
  kind: 'creative';
  source: 'report' | 'events';
  campaignId: string | null;
  campaignStatus: CampaignStatus | null;
  approvalStatus: ApprovalStatus | null;
  progress: CreativeProgress;
  timeline: CreativeTimelineEntry[];
  plan: StrategyMetadata['plan'] | null;
  participants: F1Participant[];
  sources: AuditSource[];
  crosschecks: F1Crosscheck[];
  usage: ReportMetadataV2['usage'] | null;
  aiCalls: Record<string, number>;
  images: ImageUsageData | null;
  settings: CreativeSettingsSnapshot | null;
  chain: { f1ReportId: string; f2AuditId: string; f3StrategyId: string } | null;
  summaries: Record<string, string>;
  why: string | null;
  partial: boolean;
  brand: { palette: string[]; fromBrand: boolean; logo: boolean } | null;
  imageModel: string | null;
  model: string | null;
}

export interface StartCreativeInput {
  model?: string;
  strategyId?: string;
  imageModel?: string;
  imageQuality?: 'low' | 'medium' | 'high' | 'auto';
  imageSize?: '1024x1024' | '1024x1536' | '1536x1024';
  concepts?: number;
  channels?: ChannelId[];
  landing?: boolean;
  maxImages?: number;
  maxRegenerations?: number;
  maxLayoutsPerConcept?: number;
  maxRepairRounds?: number;
  visionReviews?: number;
  maxModelCalls?: number;
  maxOutputTokens?: number;
}

/** POST .../creative-production/preflight: what will run, with the exact limits. Spends nothing. */
export interface CreativePreflight {
  ok: boolean;
  chain: { f1ReportId: string; f2AuditId: string; f3StrategyId: string; strategyCreatedAt: string; strategyPartial: boolean; campaignName: string };
  input: { projectName: string; language: string; websiteUrl: string | null; channels: ChannelId[]; concepts: number; landing: boolean };
  settings: { model: string; imageModel: string | null; imageQuality: string; imageSize: string | null; maxImages: number; maxRegenerations: number; maxLayoutsPerConcept: number; maxRepairRounds: number; visionReviews: number; maxModelCalls: number; maxOutputTokens?: number };
  estimate: { textCalls: { typical: number; max: number; enforcedCap: number }; imageRequests: { planned: number; max: number; regenerationEnabled: boolean }; layouts: { planned: number; note: string } };
  brand: { palette: string[]; fromBrand: boolean; logo: string | null };
  imageModel: { available: boolean | null; note: string; requested?: string | null; mode?: 'none' | 'auto' | 'explicit' };
  notes: string[];
}

// ---- Persisted pipeline state (GET /projects/:id/pipeline) ----

export type PhaseKey = 'discovery' | 'audit' | 'strategy' | 'creative';
export type PhaseState = 'not_started' | 'blocked' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface PipelineOutputData {
  id: string;
  runId: string;
  createdAt: string;
  model: string | null;
  partial: boolean | null;
  summary: string | null;
  stats: { label: string; value: string | number }[];
  approvalStatus: string | null;
  /** A newer result exists upstream than the one this was built on. */
  outdated: string | null;
}

export interface PipelinePhaseData {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  state: PhaseState;
  blockedBy: string | null;
  latestRun: { id: string; status: RunStatus; startedAt: string; completedAt: string | null; errorMessage: string | null } | null;
  /** The newest COMPLETED result, even when the latest run failed or is running. */
  output: PipelineOutputData | null;
  runs: number;
  note: string | null;
}

export interface PipelineData {
  projectId: string;
  phases: PipelinePhaseData[];
  completed: number;
  running: PhaseKey | null;
  next: PhaseKey | null;
}

/** The light summary the project list carries (states and counts only). */
export interface PipelineSummaryData {
  completed: number;
  running: PhaseKey | null;
  next: PhaseKey | null;
  states: Record<PhaseKey, PhaseState>;
  hasOutput: Record<PhaseKey, boolean>;
}

// ---- Full campaign (F1 -> F2 -> F3 -> F4) ----

export type FactoryStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type FactoryOutcome = 'in_progress' | 'approved' | 'approved_with_notes' | 'unresolved' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type FactoryPhaseStatus = 'pending' | 'reused' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type FactoryMode = 'continue' | 'fresh';
export type FactoryPresetId = 'first_test' | 'demo';

export interface FactoryPhaseData {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  action: 'run' | 'reuse';
  status: FactoryPhaseStatus;
  runId: string | null;
  outputId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  reused: { createdAt: string; model: string | null; partial: boolean } | null;
}

export interface FactorySettingsData {
  model: string | null;
  f1: { maxModelCalls: number; maxReviews: number; maxOutputTokens: number | null };
  f2: { maxModelCalls: number; maxReviews: number; maxOutputTokens: number | null };
  f3: { maxModelCalls: number; maxScouts: number; maxReviews: number; maxOutputTokens: number | null; useHolidayCalendar: boolean; competitorUrls: string[]; goal: string | null; budgetNote: string | null };
  f4: {
    imageModel: string | null;
    imageQuality: 'low' | 'medium' | 'high' | 'auto';
    imageSize: string | null;
    concepts: number;
    channels: ChannelId[] | null;
    landing: boolean;
    maxImages: number;
    maxRegenerations: number;
    maxLayoutsPerConcept: number;
    maxRepairRounds: number;
    visionReviews: number;
    maxModelCalls: number;
    maxOutputTokens: number | null;
  };
}

export interface FactoryUsage {
  textCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imagesGenerated: number;
  imagesFailed: number;
  byPhase: Partial<Record<PhaseKey, { textCalls: number; totalTokens: number }>>;
}

export interface FactoryRunData {
  id: string;
  projectId: string;
  mode: FactoryMode;
  status: FactoryStatus;
  outcome: FactoryOutcome;
  currentPhase: PhaseKey | null;
  cancelRequested: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  warnings: string[];
  phases: FactoryPhaseData[];
  chain: { f1ReportId: string | null; f2AuditId: string | null; f3StrategyId: string | null };
  campaignId: string | null;
  campaignName: string | null;
  approvalStatus: ApprovalStatus | null;
  config: { preset: FactoryPresetId | null; mode: FactoryMode; rerunCreative: boolean; reusePartial: boolean; textModel: string | null; imageModel: string | null; settings: FactorySettingsData | null };
  usage: FactoryUsage | null;
}

export interface FactoryActivityItem {
  id: string;
  runId: string;
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  sequence: number;
  type: string;
  participant: string | null;
  at: string;
  summary: string;
  importance: 'major' | 'normal' | 'minor';
}

export interface FactoryPlanPhase {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  action: 'run' | 'reuse';
  reuse: { id: string; runId: string; createdAt: string; model: string | null; partial: boolean; summary: string | null; approvalStatus: string | null } | null;
  limits: Record<string, unknown> | null;
  expected: { textCalls?: { cap: number; typical: number | null }; imageRequests?: { planned: number; max: number; regenerationEnabled: boolean }; layouts?: { planned: number; note: string }; maxScouts?: number; maxReviews?: number } | null;
  measured: { calls: number; tokens: number; images?: number } | null;
}

export interface FactoryPlan {
  ok: boolean;
  blockers: { code: string; message: string }[];
  warnings: string[];
  nothingToRun: boolean;
  project: { id: string; name: string };
  brief: { language: string | null; targetAudience: string | null; marketingGoal: string | null; targetMarket: string | null };
  mode: FactoryMode;
  preset: FactoryPresetId;
  reusePartial: boolean;
  rerunCreative: boolean;
  chain: { f1ReportId: string | null; f2AuditId: string | null; f3StrategyId: string | null; campaignId: string | null };
  models: { text: { id: string | null; source: 'saved' | 'override' }; image: { id: string | null; requested?: string | null; mode?: 'none' | 'auto' | 'explicit'; quality: string; available: boolean | null; note: string } | null };
  /** Concepts requested / originals permitted / requests planned / concepts left to brand-colored backgrounds. null when F4 is reused. */
  imagePlan?: { enabled: boolean; model: string | null; modelMode: 'none' | 'auto' | 'explicit'; conceptsRequested: number; originalImagesPermitted: number; plannedRequests: number; budgetLimitedConcepts: number; regenerationCap: number } | null;
  settings: FactorySettingsData;
  phases: FactoryPlanPhase[];
  totals: { phasesToRun: number; phasesReused: number; textCallCap: number; imageRequests: number; imageRegenerationCap: number; layouts: number };
  pricing: { dollars: number | null; note: string };
  limitations: string[];
}

export interface FactoryPresets {
  default: FactoryPresetId;
  presets: Record<FactoryPresetId, FactorySettingsData>;
}

/** Overrides sent on top of the chosen preset (the backend merges and validates). */
export interface StartFactoryInput {
  preset?: FactoryPresetId;
  mode?: FactoryMode;
  rerunCreative?: boolean;
  reusePartial?: boolean;
  model?: string;
  f1?: Partial<Pick<FactorySettingsData['f1'], 'maxModelCalls' | 'maxReviews'>>;
  f2?: Partial<Pick<FactorySettingsData['f2'], 'maxModelCalls' | 'maxReviews'>>;
  f3?: Partial<Pick<FactorySettingsData['f3'], 'maxModelCalls' | 'maxScouts' | 'maxReviews' | 'useHolidayCalendar'>>;
  f4?: Partial<Omit<FactorySettingsData['f4'], 'imageSize' | 'maxOutputTokens'>>;
}
