'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, del, get, patch, post, put } from './api';
import type {
  ActivityItem,
  ApiCredentialInfo,
  Asset,
  FormatPref,
  MyIntegrations,
  Note,
  ProjectDetail,
  ProjectSummary,
  ConnectionTestResult,
  OpenAiModelOption,
  OpenAiStatus,
  Provider,
  ReportFull,
  StrategyFull,
  StrategySummary,
  PipelineData,
  FactoryActivityItem,
  FactoryRunData,
  AuditFull,
  AuditSummary,
  ReportSummary,
  RunEvent,
  RunView,
  SocialProfile,
  User,
} from './types';
import type { CampaignFullData, CampaignListItem, StartCampaignInput } from './campaign';

export const keys = {
  me: ['me'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  providers: ['providers'] as const,
  myIntegrations: ['my-integrations'] as const,
  credentials: ['credentials'] as const,
  activity: ['activity'] as const,
  runs: (projectId: string) => ['runs', projectId] as const,
  openai: ['openai-status'] as const,
  reports: (projectId: string) => ['reports', projectId] as const,
  report: (id: string) => ['report', id] as const,
  audits: (projectId: string) => ['audits', projectId] as const,
  audit: (id: string) => ['audit', id] as const,
  strategies: (projectId: string) => ['strategies', projectId] as const,
  strategy: (id: string) => ['strategy', id] as const,
  campaigns: (projectId: string) => ['campaigns', projectId] as const,
  pipeline: (projectId: string) => ['pipeline', projectId] as const,
  factoryRuns: (projectId: string) => ['factory-runs', projectId] as const,
  factoryRun: (id: string) => ['factory-run', id] as const,
  factoryEvents: (id: string) => ['factory-events', id] as const,
  campaign: (id: string) => ['campaign', id] as const,
  // status is part of the key so the history is refetched when the run reaches a terminal state
  analysis: (runId: string, status?: string) => ['run-analysis', runId, status] as const,
  runEvents: (runId: string, status?: string) => ['run-events', runId, status] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => (await get<{ user: User }>('/auth/me')).user,
    retry: false,
    staleTime: 60_000,
  });
}

export const useProjects = () =>
  useQuery({ queryKey: keys.projects, queryFn: () => get<ProjectSummary[]>('/projects') });

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: () => get<ProjectDetail>(`/projects/${id}`) });

export const useProviders = () =>
  useQuery({ queryKey: keys.providers, queryFn: () => get<Provider[]>('/integrations/providers') });

export const useMyIntegrations = () =>
  useQuery({ queryKey: keys.myIntegrations, queryFn: () => get<MyIntegrations>('/integrations/me') });

export const useCredentials = () =>
  useQuery({ queryKey: keys.credentials, queryFn: () => get<ApiCredentialInfo[]>('/api-credentials') });

export const useActivity = (limit = 8) =>
  useQuery({ queryKey: [...keys.activity, limit], queryFn: () => get<ActivityItem[]>(`/activity?limit=${limit}`) });

/** Mutation helper that invalidates the given query keys on success. */
function useApiMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  invalidate: readonly (readonly unknown[])[],
) {
  const qc = useQueryClient();
  return useMutation<TData, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      invalidate.forEach((queryKey) => qc.invalidateQueries({ queryKey }));
    },
  });
}

export const useUpdateProject = (id: string) =>
  useApiMutation(
    (data: { name?: string; description?: string; status?: string }) => patch(`/projects/${id}`, data),
    [keys.projects, keys.project(id)],
  );

export const useDeleteProject = () =>
  useApiMutation((id: string) => del(`/projects/${id}`), [keys.projects, keys.activity]);

export const useCreateNote = (projectId: string) =>
  useApiMutation(
    (data: { title: string; content: string }) => post<Note>(`/projects/${projectId}/notes`, data),
    [keys.project(projectId)],
  );

export const useUpdateNote = (projectId: string) =>
  useApiMutation(
    ({ id, ...data }: { id: string; title?: string; content?: string }) => patch<Note>(`/notes/${id}`, data),
    [keys.project(projectId)],
  );

export const useDeleteNote = (projectId: string) =>
  useApiMutation((id: string) => del(`/notes/${id}`), [keys.project(projectId)]);

export const useDeleteAsset = (projectId: string) =>
  useApiMutation((id: string) => del(`/assets/${id}`), [keys.project(projectId)]);

export const useConfigureApiKey = () =>
  useApiMutation(
    (data: { providerKey: string; apiKey: string; label?: string; setAsDefault?: boolean }) =>
      post<MyIntegrations>('/integrations/configure-api-key', data),
    [keys.myIntegrations, keys.credentials, keys.me],
  );

export const useConnectPlaceholder = () =>
  useApiMutation(
    (data: { providerKey: string; displayName?: string }) =>
      post<MyIntegrations>('/integrations/connect-placeholder', data),
    [keys.myIntegrations],
  );

export const useDisconnect = () =>
  useApiMutation(
    (providerKey: string) => post<MyIntegrations>('/integrations/disconnect', { providerKey }),
    [keys.myIntegrations, keys.credentials, keys.me],
  );

export const useSetDefaultProvider = () =>
  useApiMutation(
    (providerKey: string) => put('/api-credentials/default', { providerKey }),
    [keys.myIntegrations, keys.credentials, keys.me],
  );

export const useUpdateProfile = () =>
  useApiMutation((data: { name?: string; avatarUrl?: string }) => patch<User>('/users/me', data), [keys.me]);

export const useChangePassword = () =>
  useApiMutation(
    (data: { currentPassword: string; newPassword: string }) => patch('/users/me/password', data),
    [],
  );

export type { Asset, FormatPref, SocialProfile };

// ---- Mozaik runs ----

const POLL_MS = 1000;

/** Recent runs for a project; polls while the newest one is still running. */
export const useProjectRuns = (projectId: string) =>
  useQuery({
    queryKey: keys.runs(projectId),
    queryFn: () => get<RunView[]>(`/projects/${projectId}/runs`),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? POLL_MS : false),
  });

// ---- OpenAI BYOK (Settings > AI providers) ----

export const useOpenAiStatus = () =>
  useQuery({ queryKey: keys.openai, queryFn: () => get<OpenAiStatus>('/integrations/openai/status') });

/** Lazy and free (GET /models): only fetched when the user presses "Load my models". */
export const useOpenAiModels = () =>
  useQuery({
    queryKey: ['openai-models'],
    queryFn: () => get<{ selected: string | null; models: OpenAiModelOption[] }>('/integrations/openai/models'),
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });

export const useSaveOpenAiModel = () =>
  useApiMutation((model: string) => put<OpenAiStatus>('/integrations/openai/model', { model }), [keys.openai, keys.credentials, keys.myIntegrations]);

/** Makes ONE tiny paid inference call. Only ever triggered by an explicit button press. */
export const useTestOpenAi = () =>
  useApiMutation((model?: string) => post<ConnectionTestResult>('/integrations/openai/test', model ? { model } : {}), [keys.openai, keys.credentials]);


// ---- Claude BYOK (Settings > AI providers): Claude Console API key only, never a subscription login ----

export interface ClaudeSubscriptionMode {
  available: false;
  status: 'unsupported';
  reason: string;
  sources: string[];
}
export interface ClaudeStatus {
  mode: 'api_key';
  subscription: ClaudeSubscriptionMode;
  isDefault: boolean;
  configured: boolean;
  maskedKey: string | null;
  model: string | null;
  verifiedModel: string | null;
  verifiedAt: string | null;
  ready: boolean;
  priced: boolean;
}
export interface ClaudeModelOption {
  id: string;
  displayName: string | null;
  createdAt: string | null;
  priced: boolean;
  inputPerM: number | null;
  outputPerM: number | null;
}

interface ProviderView { provider: 'openai' | 'anthropic'; configured: boolean; maskedKey: string | null; model: string | null; verifiedModel: string | null; ready: boolean; isDefault: boolean; status: string }
export interface AiProvidersOverview {
  defaultProvider: string | null;
  textProvider: 'openai' | 'anthropic' | null;
  providers: { openai: ProviderView; anthropic: ProviderView };
  claudeSubscription: ClaudeSubscriptionMode;
  billing: string;
}
export const useAiProviders = () => useQuery({ queryKey: ['ai-providers'], queryFn: () => get<AiProvidersOverview>('/ai-providers') });

/**
 * THE text provider the agents will use (the saved default: OpenAI or Claude), in the shape the phase panels read. A user whose default is
 * Claude sees Claude's key/model/readiness here, never OpenAI's.
 */
export function useTextProviderStatus() {
  const q = useAiProviders();
  const p = q.data ? (q.data.textProvider === 'anthropic' ? q.data.providers.anthropic : q.data.providers.openai) : undefined;
  return { ...q, data: p ? { ...p, providerName: p.provider === 'anthropic' ? 'Claude' : 'OpenAI' } : undefined };
}

export const useClaudeStatus = () => useQuery({ queryKey: ['anthropic'], queryFn: () => get<ClaudeStatus>('/integrations/anthropic/status') });

/** Lazy and free (GET /v1/models): only fetched when the user presses "Load my models". */
export const useClaudeModels = () =>
  useQuery({
    queryKey: ['anthropic-models'],
    queryFn: () => get<{ selected: string | null; priceBookVerifiedAt: string; pricedModels: string[]; models: ClaudeModelOption[] }>('/integrations/anthropic/models'),
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });

export const useSaveClaudeModel = () => useApiMutation((model: string) => put<ClaudeStatus>('/integrations/anthropic/model', { model }), [['anthropic'], keys.credentials, keys.myIntegrations]);

/** Makes ONE tiny paid Claude call. Only ever triggered by an explicit button press. */
export const useTestClaude = () => useApiMutation((model?: string) => post<ConnectionTestResult>('/integrations/anthropic/test', model ? { model } : {}), [['anthropic'], keys.credentials]);

// ---- saved results (current and historical; read-only: stages are started only by Campaign Production) ----

export const useReports = (projectId: string) =>
  useQuery({ queryKey: keys.reports(projectId), queryFn: () => get<ReportSummary[]>(`/projects/${projectId}/reports`) });

export const useReport = (reportId: string | null | undefined) =>
  useQuery({ queryKey: keys.report(reportId ?? 'none'), queryFn: () => get<ReportFull>(`/reports/${reportId}`), enabled: !!reportId });

/** HISTORICAL Marketing Audits (V4 runs none). */
export const useAudits = (projectId: string) =>
  useQuery({ queryKey: keys.audits(projectId), queryFn: async () => (await get<{ items: AuditSummary[]; nextCursor: string | null }>(`/projects/${projectId}/audits?limit=30`)).items });

export const useAudit = (auditId: string | null | undefined) =>
  useQuery({ queryKey: keys.audit(auditId ?? 'none'), queryFn: () => get<AuditFull>(`/audits/${auditId}`), enabled: !!auditId });

export const useStrategies = (projectId: string) =>
  useQuery({ queryKey: keys.strategies(projectId), queryFn: async () => (await get<{ items: StrategySummary[]; nextCursor: string | null }>(`/projects/${projectId}/strategies?limit=30`)).items });

export const useStrategy = (strategyId: string | null | undefined) =>
  useQuery({ queryKey: keys.strategy(strategyId ?? 'none'), queryFn: () => get<StrategyFull>(`/strategies/${strategyId}`), enabled: !!strategyId });

export const useCampaigns = (projectId: string) =>
  useQuery({ queryKey: keys.campaigns(projectId), queryFn: async () => (await get<{ items: CampaignListItem[]; nextCursor: string | null }>(`/projects/${projectId}/campaigns?limit=30`)).items });

export const useCampaign = (campaignId: string | null | undefined) =>
  useQuery({ queryKey: keys.campaign(campaignId ?? 'none'), queryFn: () => get<CampaignFullData>(`/campaigns/${campaignId}`), enabled: !!campaignId });

// ---- Persisted pipeline state ----

/**
 * The persisted state of the Campaign Production stages for a project (saved runs and results). It refetches whenever the run list changes (a run
 * started, finished, failed or was cancelled) and polls while a phase is running, so the cards never show stale placeholders.
 */
export const usePipeline = (projectId: string) => {
  const runs = useProjectRuns(projectId);
  const signature = (runs.data ?? []).map((r) => `${r.id}:${r.status}`).join('|');
  return useQuery({
    queryKey: [...keys.pipeline(projectId), signature] as const,
    queryFn: () => get<PipelineData>(`/projects/${projectId}/pipeline`),
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
};

// ---- Campaign Production: the one workflow (Business Research -> Marketing Strategy -> Creative Production) ----

const ACTIVE_FACTORY = ['queued', 'running'];

/** "Generate Campaign": starts the paid run (only after the user reviewed the free plan and approved one budget). */
export const useStartFactory = (projectId: string) =>
  useApiMutation((body: StartCampaignInput) => post<FactoryRunData>(`/projects/${projectId}/factory`, body), [keys.factoryRuns(projectId), keys.runs(projectId), keys.campaigns(projectId)]);

export const useFactoryRuns = (projectId: string) =>
  useQuery({
    queryKey: keys.factoryRuns(projectId),
    queryFn: () => get<FactoryRunData[]>(`/projects/${projectId}/factory-runs`),
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE_FACTORY.includes(r.status)) ? 2000 : false),
  });

/** One run, read from the database: a browser refresh or a server restart never loses or invents progress. */
export const useFactoryRun = (id: string | null | undefined) =>
  useQuery({
    queryKey: keys.factoryRun(id ?? 'none'),
    queryFn: () => get<FactoryRunData>(`/factory-runs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (!q.state.data || ACTIVE_FACTORY.includes(q.state.data.status) ? 1500 : false),
  });

export const useFactoryEvents = (id: string | null | undefined, status: string | undefined) =>
  useQuery({
    queryKey: [...keys.factoryEvents(id ?? 'none'), status] as const,
    queryFn: () => get<{ items: FactoryActivityItem[]; total: number }>(`/factory-runs/${id}/events?limit=600`),
    enabled: !!id,
    refetchInterval: !status || ACTIVE_FACTORY.includes(status) ? 1500 : false,
  });

export const useCancelFactory = (projectId: string) =>
  useApiMutation((id: string) => post<FactoryRunData>(`/factory-runs/${id}/cancel`), [keys.factoryRuns(projectId), keys.runs(projectId), ['factory-run']]);
