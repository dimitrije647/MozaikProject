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
  ReportFull, RunAnalysis,
  AuditAnalysis,
  StartStrategyInput,
  StrategyAnalysis,
  StrategyFull,
  StrategySummary,
  AuditFull,
  AuditSummary,
  SocialDetailInput,
  ReportSummary,
  RunEvent,
  RunView,
  SocialProfile,
  User,
} from './types';

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

// ---- Mozaik runtime (infrastructure smoke test) ----

const POLL_MS = 1000;

/** Recent runs for a project; polls while the newest one is still running. */
export const useProjectRuns = (projectId: string) =>
  useQuery({
    queryKey: keys.runs(projectId),
    queryFn: () => get<RunView[]>(`/projects/${projectId}/runs`),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? POLL_MS : false),
  });

export const useRunEvents = (runId: string | undefined, status: string | undefined) =>
  useQuery({
    queryKey: keys.runEvents(runId ?? 'none', status),
    queryFn: async () => (await get<{ items: RunEvent[] }>(`/runs/${runId}/events?limit=200`)).items,
    enabled: !!runId,
    refetchInterval: status === 'RUNNING' ? POLL_MS : false,
  });

export const useStartSmokeTest = (projectId: string) =>
  useApiMutation(
    () => post<RunView>(`/projects/${projectId}/runs/smoke-test`, { delayMs: 800 }),
    [keys.runs(projectId)],
  );

export const useCancelRun = (projectId: string) =>
  useApiMutation((runId: string) => post<RunView>(`/runs/${runId}/cancel`), [keys.runs(projectId), ['run-events']]);

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

// ---- Product Discovery ----

export const useStartDiscovery = (projectId: string) =>
  useApiMutation(
    (limits: { maxModelCalls?: number; maxOutputTokens?: number; maxReviews?: number }) => post<RunView>(`/projects/${projectId}/runs/product-discovery`, limits),
    [keys.runs(projectId), keys.reports(projectId)],
  );

export const useReports = (projectId: string) =>
  useQuery({ queryKey: keys.reports(projectId), queryFn: () => get<ReportSummary[]>(`/projects/${projectId}/reports`) });

export const useReport = (reportId: string | null | undefined) =>
  useQuery({ queryKey: keys.report(reportId ?? 'none'), queryFn: () => get<ReportFull>(`/reports/${reportId}`), enabled: !!reportId });

export const useRunAnalysis = (runId: string | undefined, status: string | undefined) =>
  useQuery({
    queryKey: keys.analysis(runId ?? 'none', status),
    queryFn: () => get<RunAnalysis>(`/runs/${runId}/analysis`),
    enabled: !!runId,
    refetchInterval: status === 'RUNNING' ? POLL_MS : false,
  });

// ---- F2 Marketing Audit ----

export const useStartAudit = (projectId: string) =>
  useApiMutation(
    (body: { f1ReportId?: string; maxModelCalls?: number; maxOutputTokens?: number; maxReviews?: number; socialDetails?: SocialDetailInput[] }) => post<RunView>(`/projects/${projectId}/runs/marketing-audit`, body),
    [keys.runs(projectId), keys.audits(projectId)],
  );

export const useAudits = (projectId: string) =>
  useQuery({ queryKey: keys.audits(projectId), queryFn: async () => (await get<{ items: AuditSummary[]; nextCursor: string | null }>(`/projects/${projectId}/audits?limit=30`)).items });

export const useAudit = (auditId: string | null | undefined) =>
  useQuery({ queryKey: keys.audit(auditId ?? 'none'), queryFn: () => get<AuditFull>(`/audits/${auditId}`), enabled: !!auditId });

export const useAuditAnalysis = (runId: string | undefined, status: string | undefined) =>
  useQuery({
    queryKey: ['audit-analysis', runId ?? 'none', status] as const,
    queryFn: () => get<AuditAnalysis>(`/runs/${runId}/analysis`),
    enabled: !!runId,
    refetchInterval: status === 'RUNNING' ? POLL_MS : false,
  });

// ---- F3 Market Research & Strategy ----

export const useStartStrategy = (projectId: string) =>
  useApiMutation((body: StartStrategyInput) => post<RunView>(`/projects/${projectId}/runs/market-strategy`, body), [keys.runs(projectId), keys.strategies(projectId)]);

export const useStrategies = (projectId: string) =>
  useQuery({ queryKey: keys.strategies(projectId), queryFn: async () => (await get<{ items: StrategySummary[]; nextCursor: string | null }>(`/projects/${projectId}/strategies?limit=30`)).items });

export const useStrategy = (strategyId: string | null | undefined) =>
  useQuery({ queryKey: keys.strategy(strategyId ?? 'none'), queryFn: () => get<StrategyFull>(`/strategies/${strategyId}`), enabled: !!strategyId });

export const useStrategyAnalysis = (runId: string | undefined, status: string | undefined) =>
  useQuery({
    queryKey: ['strategy-analysis', runId ?? 'none', status] as const,
    queryFn: () => get<StrategyAnalysis>(`/runs/${runId}/strategy-analysis`),
    enabled: !!runId,
    refetchInterval: status === 'RUNNING' ? POLL_MS : false,
  });
