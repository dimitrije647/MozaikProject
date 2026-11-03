'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, get, post } from './api';
import { keysVisual, keysImages } from './visual';

/**
 * AVAILABLE IMAGES on the web (NO AI HYBRID): every picture a campaign could use, where it came from and under which rights. Mirrors what the
 * API returns (apps/api/src/visual/image-library.service.ts). Nothing here calls an image-generation API: the library only lists, finds,
 * approves, rejects and restores pictures. A website or repository picture is downloaded by the server only after the owner attests; a stock
 * picture whose license needs a check is used only after the owner confirms it.
 */

export type LibrarySource = 'upload' | 'website' | 'github' | 'social' | 'stock';
export type LibraryStatus = 'candidate' | 'approved' | 'rejected';
export type RightsStatus = 'cleared' | 'needs_attestation' | 'needs_review' | 'attested' | 'reference_only' | 'blocked';
export type RightsVerification = 'user_owned' | 'provider_license' | 'user_attested' | 'user_reviewed' | 'unverified';
export type LibraryAction = 'approve' | 'reject' | 'restore' | 'view_source' | 'search_alternatives';

export interface LibraryRights {
  status: RightsStatus;
  verification: RightsVerification;
  license: string;
  licenseUrl: string | null;
  /** true = the picture may be used in a campaign right now */
  eligible: boolean;
  reason: string;
  attribution: string | null;
  attributionRequired: boolean;
  commercialUse: boolean;
  derivatives: boolean;
  downloadAllowed: boolean;
  redistributeOriginal: boolean;
  userApproved: boolean;
  attestedAt: string | null;
  reasons: string[];
}

export interface LibraryItem {
  /** For an approved picture this is also the asset id. Stock candidates look like `stock:pixabay:11`. */
  id: string;
  source: LibrarySource;
  status: LibraryStatus;
  title: string;
  pageUrl: string | null;
  creator: string | null;
  width: number | null;
  height: number | null;
  /** asset = a stored copy (same-origin path); remote / thumbnail = an external URL; none = nothing may be shown */
  preview: { kind: 'asset' | 'remote' | 'thumbnail' | 'none'; url: string | null; note: string | null };
  rights: LibraryRights;
  score: number | null;
  relevance: number | null;
  scoreEstimated: boolean;
  reasons: string[];
  /** why the picture is (or is not) selected for the campaign, in a sentence */
  selection: string;
  assetId: string | null;
  /** what the owner must do before the picture can be used */
  needs: 'attestation' | 'review' | null;
  note: string | null;
  actions: LibraryAction[];
  /** Get Content: what the picture is for. Absent on older API responses (= a photograph). */
  role?: 'photo' | 'logo';
}

export interface LibraryProvider {
  id: string;
  label: string;
  kind: 'licensed' | 'reference';
  configured: boolean;
  paid: boolean;
  setup: string | null;
}

export interface SocialReference {
  platform: string;
  url: string;
  origin: string;
  note: string;
  manualImport: boolean;
  access: 'reference_link';
  apiAvailable: false;
}

export interface ImageLibraryData {
  projectId: string;
  items: LibraryItem[];
  counts: { approved: number; candidates: number; rejected: number; restricted: number; upload: number; website: number; github: number; social: number; stock: number; usable: number };
  providers: LibraryProvider[];
  sources: { website: string | null; repository: string | null; social: SocialReference[] };
  autoStock: boolean;
  collectionNeeds: string | null;
  stockSearchedAt: string | null;
  notes: string[];
}

export type DiscoverSource = 'website' | 'github' | 'social' | 'stock';

export interface DiscoverOutcomeData {
  status: 'ok' | 'failed' | 'not_configured' | 'reference_only';
  message: string;
  pages?: number;
  found: number;
  added?: number;
  rejected?: number;
  providers?: number | string[];
  sources?: SocialReference[];
  notes?: string[];
}

export interface DiscoverResult {
  outcomes: Partial<Record<DiscoverSource, DiscoverOutcomeData>>;
  library: ImageLibraryData;
}

export interface AlternativesResult {
  status: 'ok' | 'empty' | 'not_configured' | 'failed';
  message: string;
  items: LibraryItem[];
}

export interface ApproveImageInput {
  id: string;
  /** the owner confirms that they own the picture or hold the rights to use it in advertising (website / repository pictures) */
  attest?: boolean;
  /** the owner checked the license of a stock picture at its source */
  reviewConfirmed?: boolean;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/images`;
const one = (projectId: string, imageId: string, action: string) => `${base(projectId)}/${encodeURIComponent(imageId)}/${action}`;

// ---- hooks -----------------------------------------------------------------------------------------------------------------------------------

export const useImageLibrary = (projectId: string, enabled = true) =>
  useQuery({ queryKey: keysImages.library(projectId), queryFn: () => get<ImageLibraryData>(base(projectId)), enabled: enabled && projectId.length > 0, staleTime: 15_000 });

/** After any change of the library: the library itself, the project (its files) and the saved design (its automatic-stock choice) are read again. */
function useRefresh(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keysImages.library(projectId) });
    qc.invalidateQueries({ queryKey: ['project', projectId] });
    qc.invalidateQueries({ queryKey: keysVisual.design(projectId) });
  };
}

/** Looks for pictures on the website, in the repository, among the social links and at the licensed providers. Downloads nothing. */
export const useDiscoverLibrary = (projectId: string) => {
  const qc = useQueryClient();
  const refresh = useRefresh(projectId);
  return useMutation<DiscoverResult, ApiError, { sources?: DiscoverSource[]; refresh?: boolean }>({
    mutationFn: (v) => post<DiscoverResult>(`${base(projectId)}/discover`, v),
    onSuccess: (r) => {
      if (r.library) qc.setQueryData(keysImages.library(projectId), r.library);
      refresh();
    },
  });
};

export const useApproveImage = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ item: LibraryItem }, ApiError, ApproveImageInput>({
    mutationFn: ({ id, ...body }) => post<{ item: LibraryItem }>(one(projectId, id, 'approve'), body),
    onSuccess: refresh,
  });
};

export const useRejectImage = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ item: LibraryItem }, ApiError, string>({ mutationFn: (id) => post<{ item: LibraryItem }>(one(projectId, id, 'reject')), onSuccess: refresh });
};

export const useRestoreImage = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ item: LibraryItem }, ApiError, string>({ mutationFn: (id) => post<{ item: LibraryItem }>(one(projectId, id, 'restore')), onSuccess: refresh });
};

/** Licensed stock candidates similar to one picture. They can then be approved with useApproveImage (the library is read again: they are candidates of the project now). Spends nothing. */
export const useImageAlternatives = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation<AlternativesResult, ApiError, string>({
    mutationFn: (id) => post<AlternativesResult>(one(projectId, id, 'alternatives')),
    onSuccess: () => qc.invalidateQueries({ queryKey: keysImages.library(projectId) }),
  });
};

/** Upload pictures you own (images only). They appear in the library approved. */
export const useUploadImages = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<unknown, ApiError, File[]>({
    mutationFn: (files) => {
      const body = new FormData();
      body.append('type', 'image');
      files.forEach((f) => body.append('files', f));
      return api(`/projects/${encodeURIComponent(projectId)}/assets`, { method: 'POST', body });
    },
    onSuccess: refresh,
  });
};

// ---- words -----------------------------------------------------------------------------------------------------------------------------------

export const SOURCE_LABEL: Record<LibrarySource, string> = { upload: 'Your upload', website: 'Your website', github: 'GitHub repository', social: 'Social media reference', stock: 'Licensed stock' };

/** The rights of a picture in plain language: what is true now, who vouches for it and under which license. */
export function rightsText(r: LibraryRights): { headline: string; verification: string; tone: 'ok' | 'wait' | 'no' } {
  const verification: Record<RightsVerification, string> = {
    user_owned: 'you uploaded it',
    provider_license: 'license cleared by the provider',
    user_attested: 'you confirmed you hold the rights',
    user_reviewed: 'you checked the license at its source',
    unverified: 'not verified yet',
  };
  const headline: Record<RightsStatus, string> = {
    cleared: 'Cleared for advertising',
    attested: 'Rights confirmed by you',
    needs_attestation: 'Waiting for your rights confirmation',
    needs_review: 'License to be checked by you',
    reference_only: 'Reference only',
    blocked: 'Not allowed in advertising',
  };
  const tone = r.eligible ? 'ok' : r.status === 'blocked' || r.status === 'reference_only' ? 'no' : 'wait';
  return { headline: headline[r.status], verification: verification[r.verification], tone };
}

/** "1600 x 900" or "size unknown". */
export const sizeText = (w: number | null, h: number | null) => (w && h ? `${w} x ${h}` : 'size unknown');
