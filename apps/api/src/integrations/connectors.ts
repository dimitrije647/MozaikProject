/**
 * Provider connector abstraction for OAuth-style integrations.
 *
 * PLACEHOLDER: no real OAuth happens in this phase. Every provider resolves to
 * PlaceholderConnector, which just marks the integration as connected. To implement a
 * real provider, create a class implementing OAuthConnector (build the authorization URL,
 * exchange the callback code for tokens, revoke on disconnect) and register it below.
 */
export interface ConnectResult {
  displayName: string;
  externalAccountId?: string;
  metadata?: Record<string, unknown>;
}

export interface OAuthConnector {
  readonly key: string;
  /** Real connectors return the provider's consent-screen URL here. */
  getAuthorizationUrl(userId: string): Promise<string | null>;
  /** Real connectors exchange `code` for tokens and fetch the account profile. */
  connect(userId: string, input: { displayName?: string; code?: string }): Promise<ConnectResult>;
  disconnect(userId: string): Promise<void>;
}

export class PlaceholderConnector implements OAuthConnector {
  constructor(readonly key: string) {}

  async getAuthorizationUrl() {
    return null;
  }

  async connect(_userId: string, input: { displayName?: string }): Promise<ConnectResult> {
    return {
      displayName: input.displayName?.trim() || 'Demo account (placeholder)',
      metadata: { placeholder: true },
    };
  }

  async disconnect() {
    /* nothing to revoke for a placeholder */
  }
}

const registry = new Map<string, OAuthConnector>();

export function registerConnector(connector: OAuthConnector) {
  registry.set(connector.key, connector);
}

export function getConnector(providerKey: string): OAuthConnector {
  return registry.get(providerKey) ?? new PlaceholderConnector(providerKey);
}
