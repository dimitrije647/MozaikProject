export type AuthType = 'oauth' | 'api_key';

export interface ProviderDefinition {
  key: string;
  name: string;
  category: 'AI' | 'Social' | 'Google' | 'Developer';
  description: string;
  authType: AuthType;
}

/** Source of truth for the provider list; synced into IntegrationProvider on startup. */
export const PROVIDER_CATALOG: ProviderDefinition[] = [
  { key: 'openai', name: 'OpenAI', category: 'AI', authType: 'api_key', description: 'GPT models for copy, strategy and analysis. Bring your own API key.' },
  { key: 'gemini', name: 'Gemini', category: 'AI', authType: 'api_key', description: 'Google Gemini models for text and image understanding. Bring your own API key.' },
  { key: 'google', name: 'Google', category: 'Google', authType: 'oauth', description: 'Sign-in and account-level access for Google services, Search Console and Analytics.' },
  { key: 'google_drive', name: 'Google Drive', category: 'Google', authType: 'oauth', description: 'Export campaign assets and reports straight to a Drive folder.' },
  { key: 'google_calendar', name: 'Google Calendar', category: 'Google', authType: 'oauth', description: 'Push the seasonal marketing calendar and publishing slots to Calendar.' },
  { key: 'youtube', name: 'YouTube', category: 'Social', authType: 'oauth', description: 'Read channel stats and publish video content.' },
  { key: 'meta', name: 'Meta', category: 'Social', authType: 'oauth', description: 'Facebook Pages and Instagram Business accounts for publishing and insights.' },
  { key: 'x', name: 'X', category: 'Social', authType: 'oauth', description: 'Post and schedule on X, and track engagement.' },
  { key: 'github', name: 'GitHub', category: 'Developer', authType: 'oauth', description: 'Read repositories, README and releases to understand your product.' },
];
