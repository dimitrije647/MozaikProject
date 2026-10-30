'use client';

import * as React from 'react';
import { Check, Info, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { IntegrationDialog } from '@/components/integration-dialog';
import { ProviderIcon } from '@/components/integration-card';
import { useCredentials, useDisconnect, useMyIntegrations, useProviders, useSetDefaultProvider } from '@/lib/hooks';
import type { Provider } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function ProvidersSettingsPage() {
  const providers = useProviders();
  const creds = useCredentials();
  const mine = useMyIntegrations();
  const setDefault = useSetDefaultProvider();
  const disconnect = useDisconnect();
  const toast = useToast();
  const [dialog, setDialog] = React.useState<Provider | null>(null);

  const aiProviders = (providers.data ?? []).filter((p) => p.authType === 'api_key');
  const integrationFor = (key: string) => mine.data?.integrations.find((i) => i.providerKey === key);

  return (
    <div className="space-y-6">
      {/* BYOK explainer */}
      <div className="panel-dark grain relative overflow-hidden p-7">
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-accent"><KeyRound className="h-5 w-5" /></span>
          <div>
            <h2 className="font-serif text-2xl text-cream-100">Bring your own key</h2>
            <p className="mt-1.5 max-w-xl text-sm text-muted-dark">
              The provider you mark as default will be used by <strong className="text-cream-100">all AI agents</strong> on your projects.
              You pay your provider directly. Keys are encrypted on the server and never sent back to your browser.
            </p>
          </div>
        </div>
      </div>

      <p className="flex items-center gap-2 text-xs text-muted">
        <Info className="h-3.5 w-3.5" /> Agents are not enabled yet. Your key is stored now so it is ready when they are.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {aiProviders.map((p) => {
          const cred = creds.data?.find((c) => c.providerKey === p.key);
          const integration = integrationFor(p.key);
          const isDefault = !!cred?.isDefault;
          return (
            <Card key={p.key} className={cn('flex flex-col p-6 transition-all', isDefault && 'ring-2 ring-accent/60')}>
              <div className="flex items-start justify-between gap-3">
                <ProviderIcon providerKey={p.key} />
                <div className="flex gap-1.5">
                  {isDefault && <Badge className="bg-accent text-white"><Check className="h-3 w-3" /> Default</Badge>}
                  <Badge className={cred ? 'bg-emerald-100 text-emerald-800' : 'bg-cream-200 text-ink-600'}>
                    {cred ? 'Key saved' : 'No key'}
                  </Badge>
                </div>
              </div>
              <h3 className="mt-4 font-sans text-base font-semibold">{p.name}</h3>
              <p className="mt-1 text-sm text-muted">{p.description}</p>

              {cred && (
                <p className="mt-4 flex items-center gap-2 rounded-xl bg-cream-100 px-3.5 py-2.5 font-mono text-xs text-ink-600">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> {cred.maskedKey}
                </p>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={cred ? 'outline' : 'primary'} onClick={() => setDialog(p)}>
                  {cred ? 'Replace key' : 'Add API key'}
                </Button>
                {cred && !isDefault && (
                  <Button
                    size="sm"
                    variant="dark"
                    loading={setDefault.isPending && setDefault.variables === p.key}
                    onClick={() => setDefault.mutate(p.key, { onSuccess: () => toast.success(`${p.name} is now your default`), onError: (e) => toast.error(e.message) })}
                  >
                    Make default
                  </Button>
                )}
                {cred && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-muted hover:text-red-600"
                    aria-label={`Remove ${p.name} key`}
                    onClick={() => {
                      if (window.confirm(`Delete the stored ${p.name} key?`)) {
                        disconnect.mutate(p.key, { onSuccess: () => toast.success('Key removed'), onError: (e) => toast.error(e.message) });
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <IntegrationDialog provider={dialog} integration={dialog ? integrationFor(dialog.key) : undefined} onClose={() => setDialog(null)} />
    </div>
  );
}
