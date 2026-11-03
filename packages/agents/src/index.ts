// Public API of @launchpilot/agents. The backend imports only from here and never touches
// individual agents or Mozaik types directly.
export * from './factory/phases';
export * from './factory/events';
export * from './factory/state';
export { redact, safeErrorMessage } from './factory/redact';
export * from './runtime/campaign-runtime';
export * from './runtime/participant-registry';
export { AI_PROVIDERS, buildInferenceRunnerConfig, type AiProvider, type InferenceCredentials } from './runtime/providers';
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
  ANALYST_KEYS,
  COORDINATOR_NAME,
  F1BoardStore,
  SourceStore,
  type AgentKey,
  type AnalystKey,
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
export { REVIEWERS } from './runtime/programs/f1/coordinator';
export { buildDiscoveryInput, type DiscoveryInput, type RawDiscoveryData } from './discovery/input';

// ---- F2 Marketing Audit ----
export * from './audit/board';
export * from './audit/schemas';
export * from './audit/context';
export * from './contracts/report-contract';
export * from './contracts/chain-check';
export { finalizeAuditReport, validateAuditFinding, type AuditPolicyIssue } from './audit/policy';
export * from './tools/seo';
export * from './tools/pagespeed';
export * from './tools/social';
export * from './tools/presence';
export { planF2, type AuditRunConfig, type AuditReportMeta, type AuditSink } from './runtime/programs/f2-program';
export type { AuditInput, F2Tools } from './runtime/programs/f2/env';
export { AUDIT_REVIEWERS } from './runtime/programs/f2/coordinator';

// ---- F3 Market Research & Strategy ----
export * from './strategy/channels';
export * from './strategy/schemas';
export * from './strategy/board';
export * from './strategy/context';
export { evaluateScouts, SCOUT_THRESHOLD, type ScoutContext } from './strategy/scouts';
export { finalizeStrategy, validateStrategyFinding, scrubFigures, type StrategyPolicyIssue } from './strategy/policy';
export * from './tools/holidays';
export * from './tools/competitors';
export { planF3, type StrategyRunConfig, type StrategyReportMeta, type StrategySink } from './runtime/programs/f3-program';
export type { F3Tools } from './runtime/programs/f3/env';
export { planF4, estimateCreativeRun, type CreativeRunConfig, type CreativeReportMeta, type CreativeSink } from './runtime/programs/f4-program';
export type { F4Tools } from './runtime/programs/f4/env';
export { ImageGenerator, IMAGE_SIZES, IMAGE_QUALITIES, isSupportedImageModel, looksLikeImageModel, DEFAULT_IMAGE_LIMITS as DEFAULT_IMAGE_GENERATION_LIMITS, type ImageQuality, type ImageSize, type ImageUsageSnapshot, type ImageGenSettings, type ImageBudgetLimits, type ImageResult as ImageGenerationResult } from './ai/openai-images';
export * from './creative/schemas';
export * from './ai/image-models';
export { SYSTEMATIC_IMAGE_FAILURES, explainImageFailure, completeImageResults, reconstructImageResults, distinctReasons, countVariations, conceptResultFromVariations } from './creative/image-results';
export * from './ai/pricing';
export { prepareContinuationSeed, missingSlots, ContinuationError, type ContinuationSeed } from './creative/continuation';
export { PRIORITY_LABEL, SPEND_PRIORITY, SpendBudget, SpendScope, scopeFor, type LedgerPlan, type Refusal, type RemainingBasis, type Reservation, type SpendController, type SpendKind, type SpendPriority, type SpendSnapshot } from './ai/budget';
export { planImageAllocation, forecastAllocation, apportion, VISUAL_ROLES, PERSPECTIVES, LIGHTING, HARD_MAX_IMAGES, HARD_MAX_PER_CONCEPT, type AllocConcept, type AllocationInput } from './creative/image-allocation';
export * from './creative/context';
export * from './creative/formats';
export * from './creative/assets';
export * from './creative/palette';
export { CREATIVE_INFO, CREATIVE_KEYS, CREATIVE_COORDINATOR_NAME, creativeKeyByName, type CreativeBoard, type CreativeKey, type CreativePlan, type CreativeSettingsSnapshot } from './creative/board';
export { renderLandingHtml } from './creative/landing-html';
export { buildCampaignZip, buildOriginalsZip, buildCreativesZip, creativesZipFileName, templateFileName, originalsZipFileName, zipFileName, safeName, campaignMarkdown, creditsFromImagery, type ExportManifest, type ExportFile, type ExportSource } from './creative/export';
export { CREATIVE_INSTRUCTIONS } from './creative/prompts';
export { renderLayout, type LayoutResult } from './creative/layout';

// ---- Hybrid Production (template library, visual direction, template selection) ----
export { HYBRID_DEFAULTS, HYBRID_LIMITS, HYBRID_PRESET, NO_AI_DEFAULTS, NO_AI_PRESET, DEFAULT_IMAGERY, ImagerySettings, isNoAi, HybridSettings, HybridFacts, HybridReference, mergeHybrid } from './hybrid/settings';
export * from './hybrid/records';
export { planHybrid, evenThenWeighted, slotsFromSelection, HYBRID_FORMATS, type HybridPlan, type HybridPlanInput, type TemplateSlot } from './hybrid/plan';
export { selectTemplates, scoreTemplate, availableFor, blockers as templateBlockers, objectiveKind, applyAssisted, stableHash, type SelectorContext, type SelectionInput, type SelectionResult, type Candidate } from './hybrid/selector';
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
export { summarizeDiscovery } from './runtime/programs/f4/hybrid-agents';
export { sourceImages, AUTO_STOCK_MAX, type SourcingOutcome } from './runtime/programs/f4/image-sourcing';
export type { LibraryImageInfo, ImageAcquirePort, BrandContext } from './runtime/programs/f4/env';
export * from './brand';
export * from './imagery';
export { WebFetchTool } from './tools/web-fetch';
export { GitHubRepositoryTool } from './tools/github';
export { DocumentExtractionTool } from './tools/documents';
