'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, get, post } from './api';
import type { LibraryProvider } from './images';
import type { FactoryPlan, StartFactoryInput } from './types';
import type { CampaignDesignData } from './visual';

/**
 * Hybrid Production on the web: the shared types and hooks of the Template Library, the Hybrid settings, the FREE preview and the
 * campaign output. Mirrors what the API returns (apps/api/src/mozaik/hybrid.service.ts, packages/agents/src/hybrid/records.ts).
 * Everything here is read-only data or a request that spends nothing; the paid start is the existing factory start.
 */

export const TEMPLATE_CATEGORIES = ['tech_saas', 'hospitality', 'ecommerce', 'professional_services', 'editorial_brand', 'events_entertainment'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  tech_saas: 'Tech / SaaS',
  hospitality: 'Hospitality',
  ecommerce: 'E-commerce',
  professional_services: 'Professional services',
  editorial_brand: 'Editorial / Brand',
  events_entertainment: 'Events / Entertainment',
};
export const FORMAT_CLASSES = ['square', 'portrait', 'story', 'landscape', 'banner'] as const;
export type FormatClass = (typeof FORMAT_CLASSES)[number];
export const CLASS_LABELS: Record<FormatClass, string> = { square: 'Square 1:1', portrait: 'Portrait 4:5', story: 'Story 9:16', landscape: 'Landscape', banner: 'Banner' };

export const STYLE_IDS = ['minimalist_tech', 'premium_editorial', 'bold_startup', 'modern_corporate', 'luxury_hospitality', 'lifestyle_photography', 'clean_ecommerce', 'dynamic_events', 'soft_lifestyle', 'contemporary_geometric'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export interface TemplateSample {
  headline: string;
  support?: string;
  cta?: string;
  eyebrow?: string;
  brand?: string;
  quote?: string;
  attribution?: string;
  stat?: string;
  statLabel?: string;
  date?: string;
  location?: string;
  offer?: string;
  offerDetail?: string;
  tag?: string;
}

export interface TemplateCard {
  id: string;
  name: string;
  version: number;
  status: 'active' | 'draft' | 'deprecated';
  category: TemplateCategory;
  description: string;
  styles: StyleId[];
  industries: string[];
  channels: string[];
  classes: FormatClass[];
  /** Content the template needs; it is only used when the project (or you) can provide all of it. */
  requires: string[];
  density: 'airy' | 'balanced' | 'dense';
  family: string;
  composition: string;
  tone: 'brand' | 'dark' | 'light' | 'duo';
  sample: TemplateSample;
  layerCount: number;
}

export interface TemplateList {
  version: string;
  total: number;
  categories: TemplateCategory[];
  styles: StyleId[];
  classes: FormatClass[];
  items: TemplateCard[];
}

export interface StyleCard {
  id: StyleId;
  name: string;
  description: string;
  typography: { headline: { family: string; weight: number; case: string; tracking: number }; body: { family: string; weight: number }; hierarchy: string };
  color: { background: string; accent: string; logic: string; ink: string; paper: string };
  composition: string[];
  photography: { subjects: string[]; treatment: string[]; avoid: string[] };
  density: 'airy' | 'balanced' | 'dense';
  decorative: string[];
  channels: string[];
  templateCategories: TemplateCategory[];
  industries: string[];
  keywords: string[];
}

export interface TemplateFilters {
  category?: string;
  style?: string;
  industry?: string;
  channel?: string;
  class?: string;
  q?: string;
}

/** A preview PNG rendered by the server from the template's own definition. Same-origin, cookie-authenticated: it works in <img src>. */
export function templatePreviewUrl(id: string, o: { class?: FormatClass; palette?: string[]; style?: StyleId; image?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (o.class) q.set('class', o.class);
  if (o.palette?.length) q.set('palette', o.palette.join(','));
  if (o.style) q.set('style', o.style);
  if (o.image === false) q.set('image', '0');
  const s = q.toString();
  return `/api/templates/${encodeURIComponent(id)}/preview${s ? `?${s}` : ''}`;
}

export const useTemplates = (filters: TemplateFilters = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  const qs = q.toString();
  return useQuery({ queryKey: ['templates', qs], queryFn: () => get<TemplateList>(`/templates${qs ? `?${qs}` : ''}`), staleTime: 5 * 60_000, placeholderData: (p) => p });
};

export const useStyles = () => useQuery({ queryKey: ['styles'], queryFn: () => get<{ items: StyleCard[] }>('/styles'), staleTime: Infinity });

/** The templates the user starred, kept in this browser only (a preference, not project data). The selector treats them as a soft preference. */
export function useFavoriteTemplates() {
  const KEY = 'launchpilot.favoriteTemplates';
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      if (Array.isArray(raw)) setIds(raw.filter((x): x is string => typeof x === 'string').slice(0, 60));
    } catch {
      /* ignore a corrupt value */
    }
  }, []);
  const toggle = (id: string) =>
    setIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 60);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable */
      }
      return next;
    });
  return useMemo(() => ({ ids, has: (id: string) => ids.includes(id), toggle }), [ids]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---- Hybrid settings and the free preview ---------------------------------------------------------------------------------------------

export interface HybridFactsInput {
  offer?: string;
  offerDetail?: string;
  date?: string;
  location?: string;
  quote?: string;
  attribution?: string;
  stat?: string;
  statLabel?: string;
  tag?: string;
}

export interface HybridReferenceInput {
  id: string;
  kind: 'user_upload' | 'user_link' | 'pinterest_board';
  label?: string;
  url?: string;
}

/** Where the pictures of a campaign come from. `generation: 'forbidden'` is NO AI HYBRID: no image is ever generated. */
export interface ImagerySettingsData {
  generation: 'allowed' | 'forbidden';
  autoStock: boolean;
  maxSourcesPerConcept: number;
  allowPaidSearch: boolean;
}

export interface HybridSettingsData {
  originals: number;
  templateCreatives: number;
  /** NO AI HYBRID only (absent on Hybrid Production): the picture rules of the preset. Read-only on the web: the design carries the automatic-stock choice. */
  imagery?: ImagerySettingsData;
  /** LEGACY: mirrors the style of the design's collection. Nothing in the UI sets it any more. */
  style: 'auto' | StyleId;
  /** The approved campaign design: the one place where collection, palette, formats and picture sourcing are decided. */
  design: CampaignDesignData | null;
  selection: 'automatic' | 'assisted' | 'manual';
  overrides: Record<string, string>;
  preferredTemplates: string[];
  allowTemplateFallback: boolean;
  directionRefine: boolean;
  reviewDirection: boolean;
  directionApproved: boolean;
  inspiration: 'style_library' | 'brand_assets' | 'references';
  references: { id: string; kind: string; label: string; url: string | null; permission: string }[];
  facts: HybridFactsInput;
}

/** What the user may change (the API merges it into the preset's defaults and validates it). */
export type HybridSettingsInput = Partial<Omit<HybridSettingsData, 'references' | 'imagery'>> & { references?: HybridReferenceInput[] };

export interface HybridSlot {
  slotId: string;
  conceptId: string;
  conceptName: string;
  index: number;
  channel: string;
  formatId: string;
  width: number;
  height: number;
  formatClass: FormatClass;
  variationId: string | null;
  source: 'ai_original' | 'brand_image' | 'none';
}

export interface VisualReferenceRecord {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  permission: 'owned_by_user' | 'user_provided' | 'original_to_launchpilot' | 'licensed' | 'link_only_not_analyzed' | 'platform_restricted_not_stored';
  used: string;
}

export interface VisualDirectionData {
  styleId: StyleId;
  secondaryStyleIds: StyleId[];
  rationale: string;
  colors: { primary: string; secondary: string; accent: string; ink: string; paper: string; notes: string };
  typography: { headline: string; body: string; notes: string };
  composition: string[];
  mood: string[];
  imageSubjects: string[];
  imageTreatment: string[];
  channelNotes: { channel: string; note: string }[];
  references: VisualReferenceRecord[];
  origin: 'deterministic' | 'model_refined' | 'user_approved';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
}

export interface TemplateSelectionItemData {
  slotId: string;
  conceptId: string;
  conceptName: string;
  index: number;
  templateId: string;
  templateName: string;
  templateVersion: number;
  category: TemplateCategory;
  family: string;
  variationId: string | null;
  sourceKind: 'ai_original' | 'brand_image' | 'none';
  /** NO AI HYBRID: the approved picture this creative is built from (the library id, which is also the asset id), if any. */
  imageId?: string | null;
  secondaryImageId?: string | null;
  channel: string;
  format: string;
  formatClass: FormatClass;
  width: number;
  height: number;
  content: { headline: string; support: string | null; cta: string | null; eyebrow: string | null; variantId: string | null };
  rationale: string;
  score: number;
  alternatives: { templateId: string; score: number }[];
  origin: 'deterministic' | 'assisted' | 'user_override';
}

export interface TemplateSelectionPlanData {
  mode: 'automatic' | 'assisted' | 'manual';
  basis: 'forecast' | 'concepts';
  styleId: StyleId;
  libraryCount: number;
  eligibleCount: number;
  items: TemplateSelectionItemData[];
  byTemplate: Record<string, number>;
  byCategory: Record<string, number>;
  rules: string[];
  warnings: string[];
}

export interface HybridPreviewItem extends TemplateSelectionItemData {
  /** A small JPEG data URL rendered locally from the template's sample content; null when the render failed (see error). */
  thumbnail: { url: string | null; placeholder: boolean; flags: string[]; error: string | null } | null;
}

/** The FREE preview: the plan plus real local renders. No OpenAI request, nothing stored. */
export interface HybridPreviewData extends FactoryPlan {
  free: true;
  noOpenAIRequests: true;
  sampleNote: string;
  /** NO AI HYBRID: how the approved pictures were shared out over the concepts (the same free, deterministic allocation the run uses). */
  imageAllocation?: { approved: number; perConcept: { conceptId: string; imageIds: string[] }[]; warnings: string[] };
  visualDirection: {
    brief: VisualDirectionData;
    summary: string;
    style: StyleCard;
    alternatives: { id: StyleId; name: string; score: number; reasons: string[] }[];
  };
  selection: Omit<TemplateSelectionPlanData, 'items'> & { items: HybridPreviewItem[] };
  distribution: { byCategory: Record<string, number>; byTemplate: Record<string, number>; byChannel: Record<string, number>; byFormat: Record<string, number> };
  requirements: {
    logo: string;
    brandPalette: string;
    brandImages: number;
    strategy: string;
    /** requirement -> how many more library templates it would unlock (e.g. { offer: 3, date: 2 }). */
    unlockableByFacts: Record<string, number>;
    factsHint: string | null;
  };
  library: { version: string; templates: number; eligible: number };
  brand: { palette: string[]; fromBrand: boolean; logo: boolean; projectName: string };
}

/** The Hybrid summary the (paid) preflight carries. */
export interface HybridPlanSummary {
  settings: HybridSettingsData;
  headline: string;
  originals: { planned: number; paidRequests: number; model: string | null; quality: string };
  templateCreatives: { planned: number; paidRequests: 0; note: string };
  total: number;
  perConcept: { conceptId: string; name: string; originals: number; templates: number; channels: string[] }[];
  slots: HybridSlot[];
  rules: string[];
  brandImages: number;
  references: HybridSettingsData['references'];
  directionReview: { required: boolean; approved: boolean };
  /** The free check of the approved campaign design (null for a campaign configured before collections). */
  design?: HybridDesignPlan | null;
  /** NO AI HYBRID only (null / absent on Hybrid Production): the guarantee in words and the state of the picture library. */
  noAi?: NoAiPlanData | null;
  note: string;
  library: { templates: number; version: string };
}

/** The picture library as the plan review sees it (free; nothing is downloaded or generated). */
export interface NoAiImageryPreflight {
  aiImages: 0;
  approved: number;
  approvedBySource: Record<string, number>;
  awaitingAuthorization: { website: number; github: number; stockReview: number; stockCleared: number };
  providers: LibraryProvider[];
  autoStock: boolean;
  estimate: { creativesPlanned: number; concepts: number; approvedPictures: number; picturesWanted: number; enough: boolean; note: string };
  warnings: string[];
}

export interface NoAiPlanData {
  statement: { aiImages: string; imagery: string; agents: string };
  imageRequestCap: 0;
  textModelRequestsMax: number;
  /** null when the creative phase does not run (a saved campaign is reused) */
  imagery: NoAiImageryPreflight | null;
}

export interface HybridDesignPlan {
  collection: { id: string; name: string; version: number } | null;
  palette: { palette: Record<string, string>; evidence: Record<string, { source: string; confidence: string; evidence: string }>; overridden: string[]; check: { ok: boolean; errors: string[]; warnings: string[] } } | null;
  formats: { keys: string[]; ids: string[]; labels: string[] } | null;
  sources: { mode: string; paidImageRequests: number; summary: string; warnings: string[]; totals: Record<string, number>; perConcept: { concept: number; picture: string; reason: string }[]; suggestions: { id: string; message: string; set: { originals: number }; fewerRequests: number; savesUsd: number | null }[] } | null;
  blockers: { code: string; message: string }[];
  notes: string[];
}

/** POST /projects/:id/hybrid/preview. Spends nothing: no OpenAI request, no Pinterest request. */
export const useHybridPreview = (projectId: string) =>
  useMutation<HybridPreviewData, ApiError, StartFactoryInput>({ mutationFn: (body) => post<HybridPreviewData>(`/projects/${projectId}/hybrid/preview`, { ...body, preset: body.preset === 'no_ai_hybrid' ? 'no_ai_hybrid' : 'hybrid_production' }) });

// ---- campaign output ------------------------------------------------------------------------------------------------------------------

export type AssetOrigin = 'AI_GENERATED' | 'TEMPLATE_RENDERED' | 'USER_UPLOADED' | 'BRAND_ASSET' | 'LICENSED_ASSET' | 'FALLBACK';
export const ORIGIN_LABELS: Record<AssetOrigin, string> = {
  AI_GENERATED: 'AI generated',
  TEMPLATE_RENDERED: 'Template render',
  USER_UPLOADED: 'Uploaded by you',
  BRAND_ASSET: 'Brand asset',
  LICENSED_ASSET: 'Licensed asset',
  FALLBACK: 'Fallback (no AI image)',
};

/** The origin of an asset, derived for assets saved before origins existed. A template render is NEVER an AI image. */
export function originOf(a: { kind: string; source: string; origin?: AssetOrigin }): AssetOrigin {
  if (a.origin) return a.origin;
  if (a.kind === 'image') return a.source === 'ai_image' ? 'AI_GENERATED' : 'FALLBACK';
  return 'TEMPLATE_RENDERED';
}

export interface TemplateCreativeData {
  slotId: string;
  conceptId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  variationId: string | null;
  channel: string;
  format: string;
  width: number;
  height: number;
  status: 'rendered' | 'fallback_rendered' | 'failed' | 'skipped';
  assetId: string | null;
  sourceAssetIds: string[];
  origin: AssetOrigin | null;
  flags: string[];
  reason: string | null;
  /** Get Content: whether the approved brand logo was placed on this creative (and why not). Absent on campaigns made before Get Content existed. */
  logo?: { applied: boolean; reason: string | null };
}

/** Get Content: the approved brand content as a campaign used it. `null` / absent on campaigns made without it. */
export interface HybridBrandData {
  logo: { approved: boolean; assetId: string | null; source: string | null; fileName: string | null; width: number | null; height: number | null } | null;
  /** creatives that carry the approved logo */
  withLogo: number;
  /** creatives that omit it, each with the reason */
  omitted: { slotId: string; reason: string }[];
  approvedPhotos: number;
  contentApprovedAt: string | null;
}

export interface TemplateQualityData {
  planned: number;
  rendered: number;
  fallbackRendered: number;
  failed: number;
  skipped: number;
  checkedFiles: number;
  complete: boolean;
  issues: { slotId: string | null; assetId: string | null; kind: string; severity: 'blocker' | 'major' | 'minor'; message: string; repairable: boolean }[];
  summary: string;
}

/** NO AI HYBRID: one picture of the campaign's library as the campaign used it (no file, no secret). */
export interface LibraryImageRecordData {
  id: string;
  name: string;
  source: 'upload' | 'website' | 'github' | 'social' | 'stock';
  kind: string;
  license: string;
  verification: string;
  attribution: string | null;
  attributionRequired: boolean;
  redistributeOriginal: boolean;
  pageUrl: string | null;
  width: number | null;
  height: number | null;
  score: number;
  reasons: string[];
  /** how it entered the campaign: in the library before the run, or added by the Visual Researcher in automatic stock mode */
  via: 'library' | 'auto_stock';
  usedBySlots: string[];
}

/** NO AI HYBRID: what the campaign did about pictures, with the proof that no image was generated. */
export interface NoAiImageryData {
  mode: 'no_ai_hybrid';
  aiImagesGenerated: 0;
  imageRequests: 0;
  /** image requests that something attempted and the guard refused before anything was sent */
  refusedAttempts: number;
  discovered: number;
  approved: number;
  autoAdded: number;
  library: LibraryImageRecordData[];
  perConcept: { conceptId: string; imageIds: string[] }[];
  /** slots that could not be built (no picture and no text-first template fit) */
  blockedSlots: { slotId: string; reason: string }[];
  providers: { id: string; label: string; status: string; message: string | null; count: number }[];
  notes: string[];
}

export interface HybridCountsData {
  originals: { planned: number; requested: number; generated: number; failed: number; skipped: number; blockedByBudget: number };
  templates: { planned: number; rendered: number; fallbackRendered: number; failed: number; skipped: number };
  total: { planned: number; delivered: number };
  text: { calls: number; inputTokens: number; outputTokens: number };
  spending: { approvedUsd: number | null; spentUsd: number; textUsd: number; imageUsd: number | null; note: string };
}

/** `hybrid` of a saved campaign package (absent / null on every other campaign). */
export interface HybridBlockData {
  mode: 'hybrid';
  version: 1;
  settings: HybridSettingsData;
  libraryVersion: string;
  direction: VisualDirectionData | null;
  selection: TemplateSelectionPlanData | null;
  creatives: TemplateCreativeData[];
  counts: HybridCountsData;
  quality: TemplateQualityData | null;
  /** NO AI HYBRID only: the pictures, their rights and the proof that no image was generated. Absent / null on Hybrid Production. */
  imagery?: NoAiImageryData | null;
  /** Get Content: the approved logo and photographs as the campaign used them. Absent / null on campaigns made without it. */
  brand?: HybridBrandData | null;
  notes: string[];
}

export const campaignDownloadUrl = (campaignId: string, what: 'package' | 'originals' | 'templates' | 'creatives') =>
  what === 'package' ? `/api/campaigns/${campaignId}/export` : `/api/campaigns/${campaignId}/export/${what}`;
