export type ProjectStatus = 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'ARCHIVED';
export type IntegrationStatus = 'NOT_CONNECTED' | 'CONFIGURED' | 'CONNECTED' | 'ERROR';

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  defaultAiProvider?: string | null;
  createdAt?: string;
}

export interface Intake {
  id: string;
  projectId: string;
  productName: string;
  shortDescription: string | null;
  websiteUrl: string | null;
  githubUrl: string | null;
  targetMarket: string | null;
  targetAudience: string | null;
  marketingGoal: string | null;
  preferredLanguage: string;
  campaignDuration: string | null;
  stylePreference: string | null;
  publishingMode: string;
  enableSeoAudit: boolean;
  enableSeasonalCalendar: boolean;
  enableGoogleDriveExport: boolean;
}

export interface Asset {
  id: string;
  projectId: string;
  type: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export interface SocialProfile {
  id: string;
  platform: string;
  url: string;
}

export interface FormatPref {
  id: string;
  formatType: string;
  enabled: boolean;
}

export interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  intake: { productName: string; marketingGoal: string | null; websiteUrl: string | null } | null;
  _count: { assets: number; notes: number; socials: number };
}

export interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  intake: Intake | null;
  assets: Asset[];
  socials: SocialProfile[];
  formats: FormatPref[];
  notes: Note[];
}

export interface Provider {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  authType: 'oauth' | 'api_key';
  isEnabled: boolean;
}

export interface UserIntegration {
  providerKey: string;
  status: IntegrationStatus;
  connectionType: 'OAUTH' | 'API_KEY' | 'PLACEHOLDER';
  displayName: string | null;
  externalAccountId: string | null;
  maskedCredential: string | null;
  connectedAt: string | null;
}

export interface MyIntegrations {
  defaultAiProvider: string | null;
  integrations: UserIntegration[];
}

export interface ApiCredentialInfo {
  id: string;
  providerKey: string;
  label: string;
  maskedKey: string;
  isActive: boolean;
  isDefault: boolean;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  eventType: string;
  eventDataJson: Record<string, unknown> | null;
  projectId: string | null;
  createdAt: string;
}

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

/** A Mozaik runtime run. Today only the infrastructure smoke test exists. */
export interface RunView {
  id: string;
  projectId: string;
  mode: string;
  label: string;
  status: RunStatus;
  currentPhase: string | null;
  provider: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface RunEvent {
  id: string;
  sequence: number;
  eventType: string;
  participant: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}
