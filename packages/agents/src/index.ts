// Public API of @launchpilot/agents. The backend imports only from here and never touches
// individual agents or Mozaik types directly.
export * from './factory/phases';
export * from './factory/events';
export * from './factory/state';
export { redact, safeErrorMessage } from './factory/redact';
export * from './runtime/campaign-runtime';
export * from './runtime/participant-registry';
export { AI_PROVIDERS, TEXT_AGENT_PROVIDERS, buildInferenceRunnerConfig, createTextTransport, type AiProvider, type InferenceCredentials } from './runtime/providers';
export { AnthropicClient, AnthropicTransport, ANTHROPIC_BASE_URL, CLAUDE_EFFORTS, CLAUDE_SUBSCRIPTION_MODE, resolveAnthropicBaseUrl, toClaudeSchema, type ClaudeEffort, type ClaudeModelInfo } from './ai/anthropic-http';
export { OpenAITransport, type TextTransport, type TextCall, type TextResult } from './ai/text-transport';
export { CLOUD_OPT_IN_ENV, enforceTelemetryPolicy, type TelemetryMode } from './runtime/telemetry';
export * from './ai/errors';
export { DEFAULT_GENERATION_TIMEOUT, generationTimeoutMs, resolveGeneration, synthesisTaskTimeoutMs, type GenerationTimeout } from './ai/timeouts';
export { InferenceGateway, DEFAULT_BUDGET, PROVIDER_ERROR_PREFIX, readProviderErrorCode, type InferenceBudget, type UsageSnapshot, type UsageTotals } from './ai/gateway';
export { OpenAIClient, OPENAI_BASE_URL, resolveOpenAIBaseUrl, type OpenAIModelInfo } from './ai/openai-http';
export * from './discovery/schemas';
export * from './discovery/f1/schemas';
export {
  AGENT_INFO,
  AGENT_KEYS,
  COORDINATOR_NAME,
  F1BoardStore,
  SourceStore,
  type AgentKey,
  type CrosscheckRecord,
  type F1Board,
  type F1Plan,
  type Finding as F1Finding,
  type ParticipantStatus,
  type SourceRecord,
} from './discovery/f1/board';
export { finalizeReportV2, validateFinding, analyzedSections, type PolicyIssue, type AnalyzedSections } from './discovery/f1/policy';
export * from './tools/url-safety';
export * from './tools/web-fetch';
export * from './tools/web-search';
export * from './tools/web-extract';
export * from './tools/page-reader';
export * from './tools/github';
export * from './tools/documents';
export * from './tools/images';
export { buildDiscoveryInput, type DiscoveryInput, type RawDiscoveryData } from './discovery/input';

// ---- historical F2 Marketing Audit (read-only: V4 no longer runs an audit; saved audits stay readable) ----
export * from './audit/schemas';
export * from './audit/context';
export * from './contracts/report-contract';
export * from './contracts/chain-check';

// ---- F3 Strategy (one agent: the Marketing Strategist) ----
export * from './strategy/channels';
export * from './strategy/schemas';
export * from './strategy/board';
export * from './strategy/context';
export { finalizeStrategy, validateStrategyFinding, scrubFigures, type StrategyPolicyIssue } from './strategy/policy';
export * from './tools/holidays';
export * from './tools/competitors';
export { planF3, type StrategyRunConfig, type StrategyReportMeta, type StrategySink } from './runtime/programs/f3-program';
export type { F3Tools } from './runtime/programs/f3/env';
// ---- F4 Creative Production (Content Writer, Visual Researcher, Creative Designer, Quality Reviewer; no AI images) ----
export { F4Program, planF4, estimateCreativeRun, type CreativeRunConfig, type CreativeReportMeta, type CreativeSink } from './runtime/programs/f4-program';
export type { F4Tools } from './runtime/programs/f4/env';
export * from './creative/schemas';
export * from './copywriting';
export { LEGACY_IMAGE_SIZES, LEGACY_IMAGE_QUALITIES } from './creative/legacy-schemas';
export * from './ai/pricing';
export { PRIORITY_LABEL, SPEND_PRIORITY, SpendBudget, SpendScope, scopeFor, type LedgerPlan, type Refusal, type RemainingBasis, type Reservation, type SpendController, type SpendKind, type SpendPriority, type SpendSnapshot } from './ai/budget';
export * from './creative/context';
export * from './creative/formats';
export * from './creative/assets';
export * from './creative/palette';
export { CREATIVE_INFO, CREATIVE_KEYS, CREATIVE_COORDINATOR_NAME, creativeKeyByName, type CreativeBoard, type CreativeKey, type CreativePlan, type CreativeSettingsSnapshot } from './creative/board';
export { buildCampaignZip, zipFileName, safeName, creditsFromImagery, type ExportManifest, type ExportFile, type ExportSource, type ExportOptions } from './creative/export';
export { legacyCampaignMarkdown, legacyTemplateFileName } from './creative/export-legacy';
export { CreativeRenderSpec, RENDERER_VERSION, applyCreativeRevision, creativeOf, editDiagnostics, editorFields, renderEdit, renderSpec, restoreOriginalRevision, sha256Of, validateEdits, type EditInputs, type EditResult, type EditorField, type FieldError } from './creative/editor';
export { CREATIVE_INSTRUCTIONS } from './creative/prompts';
export { planRepairs, slotsShowing, type RepairPlan, type RerenderOp } from './creative/repair';

// ---- the visual side (template library, campaign design, deliverables plan, template selection) ----
export { DEFAULT_HYBRID_SETTINGS, DEFAULT_IMAGERY, ImagerySettings, HybridSettings, HybridFacts, HybridReference, mergeHybrid } from './hybrid/settings';
export * from './hybrid/records';
export { HYBRID_FORMATS, type HybridPlan, type TemplateSlot } from './hybrid/plan';
export { planDeliverables, PLATFORM_DELIVERABLES, CAMPAIGN_DELIVERABLES, MAX_DELIVERABLES, folderOf, type DeliverablesInput, type DeliverablesPlan, type NotPlanned } from './hybrid/deliverables';
export { selectTemplates, scoreTemplate, availableFor, blockers as templateBlockers, objectiveKind, stableHash, type SelectorContext, type SelectionInput, type SelectionResult, type Candidate } from './hybrid/selector';
export { directionFor, industryTextOf, type DirectionContext } from './hybrid/direction';
export { contentForSlot, forecastContent, renderContent, supportingTextOf } from './hybrid/content';
export { hybridCounts, hybridNotes, buildHybridBlock, brandBlockOf } from './hybrid/report';
export { verifyTemplateExport } from './hybrid/quality';
export { TemplateDef, StyleDef, VisualDirectionBrief, validateTemplate, formatClassOf, FORMAT_CLASSES, STYLE_IDS, TEMPLATE_CATEGORIES, REFERENCE_KINDS, PERMISSION_STATUS, TEXT_SLOTS, type FormatClass, type StyleId, type TemplateCategory, type CreativeContent, type TemplateRenderInput, type TemplateRenderResult, type Requirement } from './templates/schema';
export { TEMPLATE_LIBRARY, LIBRARY_BY_CATEGORY, LIBRARY_VERSION, validateLibrary } from './templates/library';
export { STYLES, getStyle, listStyles, matchStyles, isStyleId } from './templates/styles';
export { buildVisualDirection, visualDirectionForPrompt, visualDirectionSummary, referenceMayContribute, REFERENCE_POLICY, type VisualDirectionInput, type VisualReferenceInput } from './templates/visual-direction';
export { extractPalette, isImageBuffer } from './templates/image-palette';
export { renderTemplate } from './templates/render';
export { renderTemplatePreview, placeholderImage, previewSizeFor, PREVIEW_PALETTE } from './templates/preview';
export type { BrandImage } from './runtime/programs/f4/env';
export { buildVisualBrief, type VisualBrief } from './creative/visual-brief';
export { thumbnailJpeg } from './hybrid/thumbnail';

// ---- Visual System 2.0: template collections, the campaign design, brand palette analysis, image sources ----
export { COLLECTION_IDS, COLLECTION_ROLES, ROLE_LABELS, PALETTE_ROLES, isCollectionId, TemplateCollection, CollectionTokens, DesignPaletteSchema, type CollectionId, type CollectionRole, type DesignPalette, type PaletteRole } from './collections/schema';
export { COLLECTIONS, COLLECTIONS_VERSION, getCollection, listCollections, collectionForStyle, collectionTemplates, themedTemplates, themedTemplate, coverageOf, validateCollections, needsFacts, type CollectionCoverage, type CollectionIssue } from './collections/registry';
export { applyCollection, themeLayer, fontsOf } from './collections/theme';
export * from './collections/design';
export { checkDesignFit, designFormatIds, type DesignFit, type FormatFit } from './hybrid/design-plan';
export { lockDesign } from './hybrid/direction';
export { summarizeDiscovery, campaignDirection } from './runtime/programs/f4/agents';
export { sourceImages, AUTO_STOCK_MAX, type SourcingOutcome } from './runtime/programs/f4/image-sourcing';
export type { LibraryImageInfo, ImageAcquirePort, BrandContext } from './runtime/programs/f4/env';
export * from './brand';
export * from './imagery';
export { WebFetchTool } from './tools/web-fetch';
export { GitHubRepositoryTool } from './tools/github';
export { DocumentExtractionTool } from './tools/documents';
