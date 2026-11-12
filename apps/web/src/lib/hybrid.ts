'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { LibraryProvider } from './images';
import type { CampaignDesignData } from './visual';

/**
 * The Template Library and the campaign design settings on the web. Mirrors what the API returns (apps/api/src/mozaik/hybrid.service.ts,
 * packages/agents/src/hybrid/settings.ts). Everything here is read-only data or a request that spends nothing.
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

// ---- the campaign design settings sent with a campaign ---------------------------------------------------------------------------------

/** Facts only the user can supply (an offer, a date, a quote...). A template that needs one is not used without it: nothing is invented. */
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

/** Where the pictures of a campaign come from. LaunchPilot never generates an image. */
export interface ImagerySettingsData {
  autoStock: boolean;
  maxSourcesPerConcept: number;
  allowPaidSearch: boolean;
}

/** The design settings of a campaign (the API normalizes them; see packages/agents/src/hybrid/settings.ts). */
export interface HybridSettingsData {
  imagery?: ImagerySettingsData;
  /** The approved campaign design: collection, palette and picture sourcing. */
  design: CampaignDesignData | null;
  selection: 'automatic' | 'assisted' | 'manual';
  overrides: Record<string, string>;
  preferredTemplates: string[];
  inspiration: 'style_library' | 'brand_assets' | 'references';
  references: { id: string; kind: string; label: string; url: string | null; permission: string }[];
  facts: HybridFactsInput;
}

/** What the campaign setup sends (the API merges it into its defaults and validates it). */
export interface HybridSettingsInput {
  design?: CampaignDesignData | null;
  facts?: HybridFactsInput;
  preferredTemplates?: string[];
  imagery?: Partial<ImagerySettingsData>;
}

/** The picture library as the plan review sees it (free; nothing is downloaded or generated). */
export interface ImageryPreflightData {
  aiImages: 0;
  approved: number;
  approvedBySource: Record<string, number>;
  awaitingAuthorization: { website: number; github: number; stockReview: number; stockCleared: number };
  providers: LibraryProvider[];
  autoStock: boolean;
  estimate: { creativesPlanned: number; concepts: number; approvedPictures: number; picturesWanted: number; enough: boolean; note: string };
  warnings: string[];
}
