'use client';

import * as React from 'react';
import { CheckCircle2, Download, FlaskConical, ShieldAlert, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useClaudeModels, useClaudeStatus, useSaveClaudeModel, useTestClaude } from '@/lib/hooks';
import type { ConnectionTestResult } from '@/lib/types';

/**
 * Claude in Settings > AI providers: model selection and "Test connection" for the user's Claude Console API key. Listing models is free but
 * manual; testing makes ONE tiny paid call only when pressed. The subscription mode is shown as unavailable, with the reason and sources.
 */
export function ClaudePanel() {
  const toast = useToast();
  const status = useClaudeStatus();
  const models = useClaudeModels();
  const save = useSaveClaudeModel();
  const test = useTestClaude();
  const saved = status.data?.model ?? '';
  const [model, setModel] = React.useState('');
  const [result, setResult] = React.useState<ConnectionTestResult | null>(null);
  React.useEffect(() => setModel(saved), [saved]);

  const trimmed = model.trim();
  const dirty = trimmed !== saved;
  const validId = /^claude-[a-z0-9][a-z0-9.-]{1,60}$/.test(trimmed);

  function runTest() {
    if (!window.confirm(`Test Claude with model "${trimmed}"?\n\nThis sends ONE tiny request to the Claude API using your key, billed to your Claude Console account (a fraction of a cent).`)) return;
    setResult(null);
    test.mutate(dirty ? trimmed : undefined, { onSuccess: (r) => setResult(r), onError: (e) => toast.error(e.message) });
  }

  return (
    <div className="mt-5 space-y-4 border-t border-cream-200 pt-5" data-testid="claude-panel">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className="bg-emerald-100 text-emerald-800">Claude API key</Badge>
        <Badge className={status.data?.ready ? 'bg-emerald-100 text-emerald-800' : 'bg-cream-200 text-ink-600'} data-testid="claude-status">
          {status.data?.ready ? `Ready: ${status.data.model}` : status.data?.model ? 'Model chosen, not tested yet' : 'Choose a model'}
        </Badge>
        <Badge className="bg-amber-100 text-amber-900" data-testid="claude-subscription-status">Subscription login: unavailable</Badge>
      </div>

      <Field label="Claude model (used by every agent of every new campaign until you change it)">
        <div className="flex gap-2">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus-5-5" list="claude-models" data-testid="claude-model" />
          <datalist id="claude-models">
            {(models.data?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>{`${m.displayName ?? m.id}${m.priced ? ` · $${m.inputPerM}/$${m.outputPerM} per 1M tokens` : ' · no verified price'}`}</option>
            ))}
          </datalist>
          <Button size="sm" variant="outline" onClick={() => models.refetch()} loading={models.isFetching}><Download className="h-4 w-4" /> Load my models</Button>
        </div>
      </Field>
      {models.error && <p className="text-xs text-red-600">{(models.error as Error).message}</p>}
      {trimmed && validId && status.data && !status.data.priced && trimmed === saved && <p className="text-xs text-amber-800">LaunchPilot has no verified API price for this model, so runs with it are counted as unpriced (never as free).</p>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || !validId} loading={save.isPending} onClick={() => save.mutate(trimmed, { onSuccess: () => toast.success('Claude model saved'), onError: (e) => toast.error(e.message) })} data-testid="claude-save-model">Save model</Button>
        <Button size="sm" variant="dark" disabled={!validId} loading={test.isPending} onClick={runTest} data-testid="claude-test"><FlaskConical className="h-4 w-4" /> Test connection</Button>
      </div>
      {result && (
        <p className={`flex items-center gap-2 text-sm ${result.ok ? 'text-emerald-700' : 'text-red-700'}`} data-testid="claude-test-result">
          {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {result.ok ? `Claude answered with ${result.model} in ${result.latencyMs} ms.` : result.error?.message}
        </p>
      )}

      <div className="rounded-xl bg-cream-100 p-3.5 text-xs text-ink-600" data-testid="claude-subscription-note">
        <p className="flex items-center gap-1.5 font-semibold"><ShieldAlert className="h-3.5 w-3.5" /> Why not my Claude Pro/Max subscription?</p>
        <p className="mt-1">{status.data?.subscription.reason}</p>
        <ul className="mt-1.5 list-disc pl-4">
          {(status.data?.subscription.sources ?? []).map((s) => (
            <li key={s}><a className="underline" href={s} target="_blank" rel="noreferrer">{s.replace(/^https:\/\//, '')}</a></li>
          ))}
        </ul>
        <p className="mt-1.5">Billing: every Claude call is billed to the Claude Console organization of your key (API credits included with a Max, Ultra or Team plan are used first when you linked them). LaunchPilot never switches to another provider or model on its own.</p>
      </div>
    </div>
  );
}
