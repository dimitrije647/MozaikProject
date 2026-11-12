'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from './api';
import type { FormatClass } from './hybrid';

/**
 * Visual System on the web: the ten template collections, the ONE campaign design of a project, palette suggestions, discovery of licensed
 * pictures. Mirrors what the API returns (apps/api/src/visual). Everything here is free: previews are drawn by the server's real renderer.
 */

export const COLLECTION_IDS = ['minimal_tech', 'bold_startup', 'premium_editorial', 'modern_corporate', 'luxury_hospitality', 'lifestyle_human', 'clean_ecommerce', 'dynamic_events', 'contemporary_geometric', 'soft_organic'] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];

export const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export type DesignPalette = Record<PaletteRole, string>;
export const ROLE_LABELS: Record<PaletteRole, string> = { primary: 'Primary', secondary: 'Secondary', accent: 'Accent', background: 'Background', text: 'Text' };

export type PaletteSource = 'user' | 'brand_guidelines' | 'logo' | 'website' | 'repository' | 'uploaded_image' | 'collection_default';
export const SOURCE_LABELS: Record<PaletteSource, string> = { user: 'Chosen by you', brand_guidelines: 'Brand guidelines', logo: 'Logo', website: 'Website', repository: 'Repository', uploaded_image: 'Uploaded image', collection_default: 'Default' };
export type Confidence = 'high' | 'medium' | 'low';
export interface PaletteEvidence {
  source: PaletteSource;
  confidence: Confidence;
  evidence: string;
}

export const FORMAT_OPTION_KEYS = ['instagram_post', 'instagram_story', 'facebook_post', 'linkedin_post', 'website_banner', 'flyer', 'billboard', 'other'] as const;
export type FormatOptionKey = (typeof FORMAT_OPTION_KEYS)[number];
/** Stored with older designs; V4 never generates images, so the value no longer changes what a campaign does. */
export type ImageSourcing = 'prefer_existing' | 'balanced' | 'prefer_ai';
export interface CampaignDesignData {
  version: 1;
  collectionId: CollectionId;
  collectionVersion: number;
  palette: DesignPalette;
  paletteEvidence: Partial<Record<PaletteRole, PaletteEvidence>>;
  overridden: PaletteRole[];
  formats: FormatOptionKey[];
  preferredTemplates: string[];
  imageSourcing: ImageSourcing;
  /** Fully automatic authorized-stock mode (only licenses the provider clears; credits recorded). Absent = false. */
  autoStock?: boolean;
  confirmed: boolean;
  confirmedAt: string | null;
}

export interface CollectionTemplateInfo {
  id: string;
  name: string;
  version: number;
  classes: FormatClass[];
  requires: string[];
  family: string;
  roles: string[];
}

export interface CollectionData {
  id: CollectionId;
  number: number;
  name: string;
  tagline: string;
  description: string;
  designCategory: string;
  styleId: string;
  industries: string[];
  audiences: string[];
  version: number;
  templates: CollectionTemplateInfo[];
  roles: Record<string, string[]>;
  supportedClasses: FormatClass[];
  supportedFormats: { id: string; label: string }[];
  coverage: { story: boolean; feed: boolean; banner: boolean };
  typographySystem: string;
  layoutPrinciples: string[];
  imageTreatment: string;
  decorativeSystem: string;
  fonts: string[];
  tokens: { corner: number; button: number; mask: string; patterns: string };
  defaultPalette: DesignPalette;
  paletteRules: { background: 'light' | 'dark' | 'either'; hues: number; saturation: string; minTextContrast: number; notes: string[] };
  previews: { templateId: string; class: FormatClass }[];
}

export interface CollectionList {
  version: string;
  formatOptions: { key: FormatOptionKey; label: string; formatIds: string[] }[];
  items: CollectionData[];
}

export interface PaletteCheckData {
  ok: boolean;
  errors: string[];
  warnings: string[];
  ratios: { textOnBackground: number; textOnPrimary: number | null; accentOnBackground: number };
}

export interface FormatFitData {
  ok: boolean;
  unsupported: { formatId: string; label: string; class: FormatClass; templates: string[] }[];
  thin: { formatId: string; label: string; class: FormatClass; templates: string[] }[];
  options: { collections: { id: string; name: string }[]; formats: { id: string; label: string }[]; plan: string[] };
  messages: string[];
}

export interface DesignEvaluation {
  check: PaletteCheckData;
  paletteFit: { ok: boolean; notes: string[] };
  formats: FormatFitData | null;
  canConfirm: boolean;
}

export interface ProjectDesignData {
  projectId: string;
  draft: CampaignDesignData | null;
  draftProblem: string | null;
  updatedAt: string | null;
  defaults: { formats: FormatOptionKey[]; legacyStylePreference: string | null; suggestedCollection: { id: CollectionId; reasons: string[] } | null };
  analysis: { analyzedAt: string; expiresAt: string } | null;
  licensedImages: number;
}

export interface PaletteConflictData {
  role: PaletteRole;
  chosen: { hex: string; source: PaletteSource; evidence: string };
  alternatives: { hex: string; source: PaletteSource; evidence: string }[];
  message: string;
}

export interface PaletteSuggestionData {
  suggestion: {
    collectionId: CollectionId;
    palette: DesignPalette;
    evidence: Record<PaletteRole, PaletteEvidence>;
    conflicts: PaletteConflictData[];
    readings: { source: PaletteSource; label: string; status: 'ok' | 'empty' | 'unavailable' | 'blocked' | 'failed'; message: string | null; colors: string[] }[];
    fallbackRoles: PaletteRole[];
    check: PaletteCheckData;
    notes: string[];
  };
  analyzedAt: string;
  cached: boolean;
  sources: { website: string | null; repository: string | null };
}

// ---- URLs of the free previews (drawn by the server with the real renderer) ----------------------------------------------------------------------

const hex = (c: string) => c.replace('#', '').toLowerCase();

export function paletteQuery(p: DesignPalette): string {
  return `p=${hex(p.primary)}&s=${hex(p.secondary)}&a=${hex(p.accent)}&b=${hex(p.background)}&t=${hex(p.text)}`;
}

export function collectionPreviewUrl(id: string, o: { template?: string; class?: FormatClass; palette?: DesignPalette; image?: boolean } = {}): string {
  const q = [o.template ? `template=${encodeURIComponent(o.template)}` : '', o.class ? `class=${o.class}` : '', o.palette ? paletteQuery(o.palette) : '', o.image === false ? 'image=0' : ''].filter(Boolean).join('&');
  return `/api/collections/${encodeURIComponent(id)}/preview${q ? `?${q}` : ''}`;
}

export function designPreviewUrl(projectId: string, collection: string, o: { template?: string; class?: FormatClass; palette: DesignPalette; projectPicture?: boolean }): string {
  const q = [`collection=${encodeURIComponent(collection)}`, o.template ? `template=${encodeURIComponent(o.template)}` : '', o.class ? `class=${o.class}` : '', paletteQuery(o.palette), o.projectPicture ? 'picture=project' : ''].filter(Boolean).join('&');
  return `/api/projects/${encodeURIComponent(projectId)}/design/preview?${q}`;
}

// ---- contrast (the same math as the server, so the form can warn before it asks) ------------------------------------------------------------------

const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrastRatio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

// ---- hooks ---------------------------------------------------------------------------------------------------------------------------------------

export const useCollections = () => useQuery({ queryKey: ['collections'], queryFn: () => get<CollectionList>('/collections'), staleTime: 10 * 60_000 });

export const keysVisual = { design: (projectId: string) => ['design', projectId] as const, images: (projectId: string) => ['design-images', projectId] as const };

/** The AVAILABLE IMAGES library of a project (lib/images.ts). The saved design carries its automatic-stock choice, so saving a design refreshes it. */
export const keysImages = { library: (projectId: string) => ['image-library', projectId] as const };

export const useProjectDesign = (projectId: string) => useQuery({ queryKey: keysVisual.design(projectId), queryFn: () => get<ProjectDesignData>(`/projects/${projectId}/design`), staleTime: 30_000, enabled: projectId.length > 0 });

export const useNewDesign = (projectId: string) => useMutation({ mutationFn: (collectionId: CollectionId) => post<{ design: CampaignDesignData } & DesignEvaluation>(`/projects/${projectId}/design/new`, { collectionId }) });

export const useSaveDesign = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (design: CampaignDesignData) => put<{ design: CampaignDesignData } & DesignEvaluation>(`/projects/${projectId}/design`, design),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keysVisual.design(projectId) });
      qc.invalidateQueries({ queryKey: keysImages.library(projectId) });
    },
  });
};

export const usePaletteSuggestion = (projectId: string) => useMutation({ mutationFn: (v: { collectionId: CollectionId; refresh?: boolean; explicit?: Partial<Record<PaletteRole, string>> }) => post<PaletteSuggestionData>(`/projects/${projectId}/design/palette`, v) });
