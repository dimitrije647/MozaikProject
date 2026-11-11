'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, get, post } from './api';
import { keysImages, keysVisual, type PaletteSuggestionData } from './visual';
import type { LibraryItem } from './images';

/**
 * GET CONTENT on the web: the optional step of the Campaign Design that finds the real logo, useful photographs and brand colors in what the
 * user already supplied (uploads, official website, GitHub repository, previously approved assets) so the owner can review and approve them.
 * Mirrors what the API returns (apps/api, /projects/:id/get-content). It costs nothing: no image or text model is called, no campaign run starts
 * and no budget is involved. The ONLY request made on page load is `GET /get-content` (it reads stored results); everything else happens on a
 * click. The palette suggestion is never applied by the server: it goes through the Campaign Design's own palette editor.
 */

export type GetContentSourceId = 'uploads' | 'website' | 'github' | 'existing' | 'palette';
export type GetContentRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type GetContentSourceStatus = 'pending' | 'running' | 'ok' | 'empty' | 'unavailable' | 'blocked' | 'failed' | 'skipped' | 'cancelled';

export interface GetContentSourceView {
  id: GetContentSourceId;
  label: string;
  status: GetContentSourceStatus;
  message: string | null;
  found: { logos: number; photos: number; colors: number };
}

export interface GetContentRunView {
  id: string;
  status: GetContentRunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** true = a saved result younger than 24 hours; nothing was searched again */
  cached: boolean;
  sources: GetContentSourceView[];
  summary: { uploadsInspected: number; websiteInspected: boolean; githubInspected: boolean; imagesFound: number; imagesEligibleForApproval: number; logoCandidates: number; sourcesUnavailable: string[] };
  notes: string[];
}

export type LogoCandidateSource = 'upload' | 'website' | 'github' | 'approved';
export type LogoCandidateAction = 'approve' | 'reject' | 'restore' | 'view_source';

export interface LogoCandidateView {
  id: string;
  source: LogoCandidateSource;
  title: string;
  fileName: string;
  format: string;
  svg: boolean;
  width: number | null;
  height: number | null;
  /** 0..1 */
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  signals: string[];
  favicon: boolean;
  /** asset = a stored copy (same-origin path); remote = an external URL that is not stored; none = nothing may be shown */
  preview: { kind: 'asset' | 'remote' | 'none'; url: string | null; note: string | null };
  pageUrl: string | null;
  rights: { status: string; verification: string; license: string; eligible: boolean; reason: string };
  /** what the owner must do before the logo can be used */
  needs: 'attestation' | null;
  status: 'candidate' | 'approved' | 'rejected';
  note: string | null;
  actions: LogoCandidateAction[];
}

export interface ApprovedLogoView {
  assetId: string;
  source: string;
  title: string;
  format: string;
  width: number | null;
  height: number | null;
  approvedAt: string;
  /** same-origin /api/assets/<id>/file */
  previewUrl: string;
  rights: { verification: string; license: string; attestedAt: string | null };
}

export interface GetContentState {
  projectId: string;
  /** the latest run; null = Get Content was never pressed */
  run: GetContentRunView | null;
  logo: { approved: ApprovedLogoView | null; candidates: LogoCandidateView[] };
  /** the suggestion has the SAME shape as the Campaign Design's palette suggestion; the server never applies it */
  palette: { suggestion: PaletteSuggestionData['suggestion'] | null; analyzedAt: string | null; collectionId: string | null };
  approved: { logo: boolean; photos: number; approvedAt: string | null };
}

export interface BatchResult {
  id: string;
  ok: boolean;
  item?: LibraryItem;
  code?: string;
  message?: string;
}

export interface BatchResponse {
  results: BatchResult[];
}

export interface StartGetContentInput {
  refresh?: boolean;
  collectionId?: string;
}

export const keysGetContent = { state: (projectId: string) => ['get-content', projectId] as const };

/** A state that only knows its run: used when a run was started before the stored state could be read (the state is read again right after). */
const stateOfRun = (projectId: string, run: GetContentRunView): GetContentState => ({
  projectId,
  run,
  logo: { approved: null, candidates: [] },
  palette: { suggestion: null, analyzedAt: null, collectionId: null },
  approved: { logo: false, photos: 0, approvedAt: null },
});

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/get-content`;
const logoUrl = (projectId: string, candidateId: string, action: string) => `${base(projectId)}/logo/${encodeURIComponent(candidateId)}/${action}`;
const images = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/images`;

// ---- hooks -----------------------------------------------------------------------------------------------------------------------------------

/**
 * The stored Get Content state. The only request made on page load. It is read again every second while a run is going (and only then), and
 * once more when the run stops: the pictures the run found are then in the image library, so the library is read again too.
 */
export function useGetContent(projectId: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: keysGetContent.state(projectId),
    queryFn: () => get<GetContentState>(base(projectId)),
    enabled: projectId.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    // the page works without Get Content: a failing endpoint is not hammered
    retry: 1,
    refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? 1000 : false),
  });
  const status = q.data?.run?.status;
  const previous = React.useRef<GetContentRunStatus | undefined>(undefined);
  React.useEffect(() => {
    if (previous.current === 'running' && status && status !== 'running') {
      qc.invalidateQueries({ queryKey: keysImages.library(projectId) });
      qc.invalidateQueries({ queryKey: keysVisual.design(projectId) });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    }
    previous.current = status;
  }, [status, projectId, qc]);
  return q;
}

/** After the owner approves, rejects or uploads something: the Get Content state, the image library, the saved design and the project (its files) are read again. */
function useRefresh(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keysGetContent.state(projectId) });
    qc.invalidateQueries({ queryKey: keysImages.library(projectId) });
    qc.invalidateQueries({ queryKey: keysVisual.design(projectId) });
    qc.invalidateQueries({ queryKey: ['project', projectId] });
  };
}

/** Starts discovery (or returns the run that is going, or a saved result younger than 24 hours unless `refresh`). Returns at once with status 'running'; the state query then polls. */
export const useStartGetContent = (projectId: string) => {
  const qc = useQueryClient();
  const refresh = useRefresh(projectId);
  return useMutation<GetContentRunView, ApiError, StartGetContentInput>({
    mutationFn: (v) => post<GetContentRunView>(base(projectId), v),
    onSuccess: (run) => {
      // the new run is on the screen at once; the state itself is read again right after (and every second while the run goes)
      qc.setQueryData<GetContentState>(keysGetContent.state(projectId), (s) => (s ? { ...s, run } : stateOfRun(projectId, run)));
      refresh();
    },
  });
};

export const useCancelGetContent = (projectId: string) => {
  const qc = useQueryClient();
  const refresh = useRefresh(projectId);
  return useMutation<GetContentRunView, ApiError, void>({
    mutationFn: () => post<GetContentRunView>(`${base(projectId)}/cancel`),
    onSuccess: (run) => {
      qc.setQueryData<GetContentState>(keysGetContent.state(projectId), (s) => (s ? { ...s, run } : s));
      refresh();
    },
  });
};

/** `attest` = the owner confirms that they own the logo or hold the rights (required by the server for a website or repository logo). */
export const useApproveLogo = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ approved: ApprovedLogoView }, ApiError, { candidateId: string; attest?: boolean }>({
    mutationFn: ({ candidateId, attest }) => post<{ approved: ApprovedLogoView }>(logoUrl(projectId, candidateId, 'approve'), attest !== undefined ? { attest } : {}),
    onSuccess: refresh,
  });
};

export const useRejectLogo = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ candidate: LogoCandidateView }, ApiError, string>({ mutationFn: (candidateId) => post<{ candidate: LogoCandidateView }>(logoUrl(projectId, candidateId, 'reject')), onSuccess: refresh });
};

export const useRestoreLogo = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ candidate: LogoCandidateView }, ApiError, string>({ mutationFn: (candidateId) => post<{ candidate: LogoCandidateView }>(logoUrl(projectId, candidateId, 'restore')), onSuccess: refresh });
};

/** Uploads a different logo (one png / jpg / webp / svg, up to 5 MB). An upload is the owner's own file, so it is approved at once. */
export const useUploadLogo = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<{ approved: ApprovedLogoView }, ApiError, File>({
    mutationFn: (file) => {
      const body = new FormData();
      body.append('file', file);
      return api<{ approved: ApprovedLogoView }>(`${base(projectId)}/logo/upload`, { method: 'POST', body });
    },
    onSuccess: refresh,
  });
};

/** Approves several photographs at once. One result per picture: the ones that cannot be approved say why. Website / repository pictures need `attest`. */
export const useApprovePhotosBatch = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<BatchResponse, ApiError, { ids: string[]; attest?: boolean; reviewConfirmed?: boolean }>({
    mutationFn: (v) => post<BatchResponse>(`${images(projectId)}/approve-batch`, v),
    onSuccess: refresh,
  });
};

export const useRejectPhotosBatch = (projectId: string) => {
  const refresh = useRefresh(projectId);
  return useMutation<BatchResponse, ApiError, { ids: string[] }>({ mutationFn: (v) => post<BatchResponse>(`${images(projectId)}/reject-batch`, v), onSuccess: refresh });
};

// ---- words -----------------------------------------------------------------------------------------------------------------------------------

export const SOURCE_ORDER: GetContentSourceId[] = ['uploads', 'website', 'github', 'palette', 'existing'];
export const SOURCE_NAME: Record<GetContentSourceId, string> = { uploads: 'Project uploads', website: 'Website', github: 'GitHub', palette: 'Palette extraction', existing: 'Existing approved assets' };

export const LOGO_SOURCE_LABEL: Record<LogoCandidateSource, string> = { upload: 'Your upload', website: 'Your website', github: 'GitHub repository', approved: 'Previously approved' };
