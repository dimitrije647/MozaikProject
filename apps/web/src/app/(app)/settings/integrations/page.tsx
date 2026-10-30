'use client';

import * as React from 'react';
import { Plug } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { IntegrationCard } from '@/components/integration-card';
import { IntegrationDialog } from '@/components/integration-dialog';
import { useToast } from '@/components/ui/toast';
import { useDisconnect, useMyIntegrations, useProviders } from '@/lib/hooks';
import type { Provider } from '@/lib/types';

const CATEGORY_ORDER = ['AI', 'Google', 'Social', 'Developer'];

export default function IntegrationsSettingsPage() {
  const providers = useProviders();
  const mine = useMyIntegrations();
  const disconnect = useDisconnect();
  const toast = useToast();
  const [dialog, setDialog] = React.useState<Provider | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);

  function remove(p: Provider) {
    if (!window.confirm(`Disconnect ${p.name}?${p.authType === 'api_key' ? ' The stored API key will be deleted.' : ''}`)) return;
    setBusyKey(p.key);
    disconnect.mutate(p.key, {
      onSuccess: () => toast.success(`${p.name} disconnected`),
      onError: (e) => toast.error(e.message),
      onSettled: () => setBusyKey(null),
    });
  }

  if (providers.isLoading || mine.isLoading) {
    return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-56 animate-pulse rounded-2xl bg-cream-200" />)}</div>;
  }
  if (!providers.data?.length) {
    return <EmptyState icon={Plug} title="No providers available" description="The provider catalog is empty. Restart the API to resync it." />;
  }

  const grouped = CATEGORY_ORDER.map((cat) => ({ cat, items: providers.data!.filter((p) => p.category === cat) })).filter((g) => g.items.length);
  const byKey = new Map((mine.data?.integrations ?? []).map((i) => [i.providerKey, i]));

  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-sm text-muted">
        AI providers use your own API key. Google, Meta, X and GitHub use a <strong className="text-ink">placeholder</strong> connection
        for now: the real OAuth flows plug into the same cards later.
      </p>

      {grouped.map((g) => (
        <section key={g.cat}>
          <h2 className="mb-4 font-sans text-sm font-semibold uppercase tracking-wider text-muted">{g.cat}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((p) => (
              <IntegrationCard
                key={p.key}
                provider={p}
                integration={byKey.get(p.key)}
                isDefault={mine.data?.defaultAiProvider === p.key}
                busy={busyKey === p.key}
                onConnect={() => setDialog(p)}
                onConfigure={() => setDialog(p)}
                onDisconnect={() => remove(p)}
              />
            ))}
          </div>
        </section>
      ))}

      <IntegrationDialog provider={dialog} integration={dialog ? byKey.get(dialog.key) : undefined} onClose={() => setDialog(null)} />
    </div>
  );
}
