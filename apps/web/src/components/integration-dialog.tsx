'use client';

import * as React from 'react';
import { Info, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { useConfigureApiKey, useConnectPlaceholder } from '@/lib/hooks';
import type { Provider, UserIntegration } from '@/lib/types';

export function IntegrationDialog({
  provider,
  integration,
  onClose,
}: {
  provider: Provider | null;
  integration?: UserIntegration;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!provider} onOpenChange={(o) => !o && onClose()}>
      {provider && (
        <DialogContent
          title={provider.authType === 'api_key' ? `${provider.name} API key` : `Connect ${provider.name}`}
          description={
            provider.authType === 'api_key'
              ? 'Your key is encrypted on the server and never shown again.'
              : provider.description
          }
        >
          {provider.authType === 'api_key' ? (
            <ApiKeyForm provider={provider} integration={integration} onDone={onClose} />
          ) : (
            <OAuthPlaceholderForm provider={provider} integration={integration} onDone={onClose} />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function ApiKeyForm({
  provider,
  integration,
  onDone,
}: {
  provider: Provider;
  integration?: UserIntegration;
  onDone: () => void;
}) {
  const toast = useToast();
  const configure = useConfigureApiKey();
  const [apiKey, setApiKey] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [setAsDefault, setSetAsDefault] = React.useState(true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    configure.mutate(
      { providerKey: provider.key, apiKey, label: label || undefined, setAsDefault },
      {
        onSuccess: () => {
          toast.success(`${provider.name} key saved securely`);
          onDone();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {integration?.maskedCredential && (
        <p className="rounded-xl bg-cream-100 px-3.5 py-2.5 text-sm text-ink-600">
          Current key: <span className="font-mono">{integration.maskedCredential}</span>. Saving a new key replaces it.
        </p>
      )}
      <Field label="API key" htmlFor="apiKey">
        <Input
          id="apiKey"
          type="password"
          autoComplete="off"
          placeholder={provider.key === 'openai' ? 'sk-...' : 'AIza...'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          required
        />
      </Field>
      <Field label="Label" htmlFor="label" optional>
        <Input id="label" placeholder="e.g. Personal key" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <label className="flex items-center justify-between gap-4 rounded-xl border border-cream-300 px-4 py-3">
        <span>
          <span className="block text-sm font-medium">Use as default AI provider</span>
          <span className="block text-xs text-muted">All AI agents will use this key later.</span>
        </span>
        <Switch checked={setAsDefault} onCheckedChange={setSetAsDefault} />
      </label>
      <p className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        Stored with AES-256-GCM. Only a masked version is ever returned to the browser.
      </p>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={configure.isPending} disabled={apiKey.trim().length < 8}>
          Save key
        </Button>
      </div>
    </form>
  );
}

function OAuthPlaceholderForm({
  provider,
  integration,
  onDone,
}: {
  provider: Provider;
  integration?: UserIntegration;
  onDone: () => void;
}) {
  const toast = useToast();
  const connect = useConnectPlaceholder();
  const [displayName, setDisplayName] = React.useState(integration?.displayName ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    connect.mutate(
      { providerKey: provider.key, displayName: displayName || undefined },
      {
        onSuccess: () => {
          toast.success(`${provider.name} connected (placeholder)`);
          onDone();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Placeholder flow.</strong> Real {provider.name} OAuth is not wired up yet. This marks the
          integration as connected so the rest of the app can be built against it.
        </p>
      </div>
      <Field label="Account label" htmlFor="displayName" optional hint="Shown on the integration card.">
        <Input
          id="displayName"
          placeholder={`My ${provider.name} account`}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={connect.isPending}>
          {integration ? 'Save' : `Connect ${provider.name}`}
        </Button>
      </div>
    </form>
  );
}
