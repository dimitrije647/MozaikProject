'use client';

import { useMutation } from '@tanstack/react-query';
import { post, type ApiError } from './api';
import type { HybridSettingsData, HybridSettingsInput, ImageryPreflightData } from './hybrid';
import type { InputReadinessData, PhaseKey } from './types';

/*
 * CAMPAIGN PRODUCTION (V4): the one production workflow. Types of the free plan (POST /projects/:id/factory/preflight), the start request
 * (POST /projects/:id/factory) and the V4 campaign package the result screen reads. Nothing here spends money: only the start does, after
 * the user approved one budget.
 */

export const SOCIAL_PLATFORMS = ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const PLATFORM_LABEL: Record<string, string> = { x: 'X', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn' };

export type DeliverableKind = 'social_post' | 'web_ad' | 'display_ad' | 'billboard' | 'flyer';
export const KIND_LABEL: Record<DeliverableKind, string> = { social_post: 'Social post', web_ad: 'Web banner', display_ad: 'Display ad', billboard: 'Billboard', flyer: 'Flyer' };

export interface CampaignSettingsData {
  objective: string | null;
  targetAudience: string | null;
  channels: SocialPlatform[];
  concepts: number;
  competitorUrls: string[];
  useHolidayCalendar: boolean;
  refreshResearch: boolean;
}

/** The writing style of a campaign (all optional; without it the brand voice is inferred from the research). */
export const VOICE_TONES = ['professional', 'conversational', 'playful', 'premium', 'technical'] as const;
export type VoiceTone = (typeof VOICE_TONES)[number];
export const VOICE_TONE_LABEL: Record<VoiceTone, string> = { professional: 'Professional', conversational: 'Conversational', playful: 'Playful', premium: 'Premium', technical: 'Technical' };
export interface CampaignVoiceInput {
  tone?: VoiceTone;
  humor?: boolean;
  preferredTerms?: string[];
  avoid?: string[];
}

export interface StartCampaignInput {
  objective?: string;
  targetAudience?: string;
  channels?: SocialPlatform[];
  concepts?: number;
  competitorUrls?: string[];
  useHolidayCalendar?: boolean;
  refreshResearch?: boolean;
  voice?: CampaignVoiceInput;
  design?: HybridSettingsInput;
  approvedBudgetUsd?: number;
  confirmCost?: boolean;
}

export interface DeliverableSlotData {
  slotId: string;
  conceptId: string;
  conceptName: string;
  index: number;
  channel: string;
  formatId: string;
  width: number;
  height: number;
  formatClass: string;
  kind?: DeliverableKind;
  label?: string;
  folder?: string;
}

export interface NotPlannedData {
  kind: DeliverableKind;
  label: string;
  format: string;
  conceptId: string | null;
  reason: string;
}

export type BudgetStatus = 'no_budget' | 'within' | 'may_stop_early' | 'below_estimate' | 'unknown';

/** Text-only estimate: LaunchPilot makes no image request. null = unknown (no verified price), never 0. */
export interface CampaignCostEstimate {
  currency: 'USD';
  priceBookVerifiedAt: string;
  sources: Record<string, string>;
  available: boolean;
  text: { model: string | null; priced: boolean; phases: { phase: PhaseKey; runs: boolean; calls: { typical: number; cap: number }; basis: 'measured' | 'assumed'; typicalUsd: number | null; maxUsd: number | null }[]; typicalUsd: number | null; maxUsd: number | null };
  totals: { typicalUsd: number | null; maxUsd: number | null };
  budget: { approvedUsd: number | null; suggestedUsd: number | null; status: BudgetStatus; message: string };
  assumptions: string[];
  warnings: string[];
}

export interface CampaignPlanData {
  ok: boolean;
  offline: boolean;
  blockers: { code: string; message: string }[];
  warnings: string[];
  project: { id: string; name: string };
  brief: { objective: string | null; targetAudience: string | null; language: string | null; targetMarket: string | null };
  settings: CampaignSettingsData;
  design: HybridSettingsData;
  provider: { id: 'openai' | 'anthropic' | 'gemini'; name: string; model: string | null; source: 'settings' };
  phases: { phase: PhaseKey; code: string; title: string; action: 'run' | 'reuse'; reuse: { id: string; createdAt: string; model: string | null; partial: boolean } | null }[];
  deliverables: { platforms: string[]; planned: number; byChannel: Record<string, number>; slots: DeliverableSlotData[]; notPlanned: NotPlannedData[]; rules: string[]; note: string };
  statement: { aiImages: string; imagery: string; agents: string };
  imagery: ImageryPreflightData | null;
  inputs: InputReadinessData;
  library: { templates: number; version: string | number; collection: { id: string; name: string } | null };
  cost: CampaignCostEstimate;
  budget: CampaignCostEstimate['budget'] & { required: boolean };
  limitations: string[];
}

export const useCampaignPreflight = (projectId: string) =>
  useMutation<CampaignPlanData, ApiError, StartCampaignInput>({ mutationFn: (body) => post<CampaignPlanData>(`/projects/${projectId}/factory/preflight`, body) });

// ---- the V4 campaign package (GET /campaigns/:id -> package) ----------------------------------------------------------------------

export interface VideoScriptData {
  hook: string;
  durationSeconds: number;
  scenes: { seconds: string; visual: string; onScreenText: string; voiceover: string }[];
  soundNote: string;
}

export interface CopyVariantV4 {
  id: string;
  conceptId: string;
  channel: string;
  placement: string;
  headline: string;
  body: string;
  description: string | null;
  ctaText: string;
  hashtags: string[];
  version: number;
  postingFormat?: string | null;
  videoScript?: VideoScriptData | null;
  visualLine?: string | null;
  /** copywriting principles this piece applies (internal) */
  principles?: string[];
}

/** The copywriting plan stored with a campaign (absent on older campaigns). */
export interface CopywritingPlanData {
  purpose: string;
  goal: string;
  primary: string[];
  optional: string[];
  excluded: { id: string; reason: string }[];
  voice: { tone: string; formality: string; directness: string; technicalDepth: string; personality: string[]; humor: string; sensitivity: string; evidenceConfidence: string; basis: string[] };
}

export interface ConceptV4 {
  id: string;
  name: string;
  angle: string;
  keyMessage: string;
  audience: string;
  ctaText: string;
  visualIdea: string;
}

export interface DeliverableRecordData {
  id: string;
  kind: DeliverableKind;
  label: string;
  conceptId: string;
  channel: string;
  format: string;
  width: number;
  height: number;
  folder: string;
  status: 'delivered' | 'missing';
  assetId: string | null;
  variantId: string | null;
  withPicture: boolean;
  reason: string | null;
}

export interface DeliverablesData {
  version: 1;
  platforms: string[];
  items: DeliverableRecordData[];
  notPlanned: NotPlannedData[];
  rules: string[];
  counts: { planned: number; delivered: number; missing: number; withPicture: number; typographyFirst: number };
}

export interface LibraryImageRecordData {
  id: string;
  name: string;
  source: string;
  kind: string;
  license: string;
  verification: string;
  attribution: string | null;
  attributionRequired: boolean;
  redistributeOriginal: boolean;
  pageUrl: string | null;
  via: 'library' | 'auto_stock';
  usedBySlots: string[];
}

export interface CampaignPackageV4 {
  id: string;
  schemaVersion: number;
  campaignName: string;
  language: string;
  f3StrategyId: string;
  concepts: ConceptV4[];
  copyVariants: CopyVariantV4[];
  imageAssets: { id: string; kind: string; conceptId: string; channel: string | null; format: string | null; width: number; height: number; status: string; source: string; altText: string | null }[];
  deliverables: DeliverablesData | null;
  copywriting?: CopywritingPlanData | null;
  hybrid: { imagery?: { library: LibraryImageRecordData[]; notes?: string[] } | null; brand?: { logo?: { name?: string | null } | null } | null } | null;
  reviewFindings: { id: string; severity: string; kind: string; finding: string; status: string }[];
  approval: { status: 'approved' | 'approved_with_notes' | 'unresolved'; rounds: number; unresolvedFindingIds: string[]; note: string };
  usage: { text: { calls: number; totalTokens: number } };
  limitations: string[];
  createdAt: string;
  /** LEGACY (campaigns made before V4) */
  landingContent?: unknown;
  channelLayouts?: { id: string; conceptId: string; channel: string; format: string; assetId: string }[];
}

export interface CampaignAssetViewData {
  id: string;
  kind: string;
  conceptId: string;
  channel: string | null;
  format: string | null;
  width: number;
  height: number;
  status: string;
  source: string;
  url: string;
}

export interface CampaignFullData {
  id: string;
  projectId: string;
  runId: string;
  f1ReportId: string;
  f2AuditId: string | null;
  f3StrategyId: string;
  schemaVersion: number;
  model: string;
  imageModel: string | null;
  status: string;
  approvalStatus: 'approved' | 'approved_with_notes' | 'unresolved' | null;
  campaignName: string;
  createdAt: string;
  concepts: number | null;
  variants: number | null;
  deliverables: DeliverablesData['counts'] | null;
  package: CampaignPackageV4 | null;
  metadata: { partial?: boolean; brand?: { palette: string[]; fromBrand: boolean; logo: boolean } } | null;
  assets: CampaignAssetViewData[];
}

export interface CampaignListItem {
  id: string;
  runId: string;
  campaignName: string;
  status: string;
  approvalStatus: string | null;
  schemaVersion: number;
  createdAt: string;
  imageModel: string | null;
  f2AuditId: string | null;
  deliverables: DeliverablesData['counts'] | null;
}

export const campaignZipUrl = (campaignId: string) => `/api/campaigns/${campaignId}/export`;
