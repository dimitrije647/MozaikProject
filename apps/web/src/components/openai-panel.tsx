'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2, Download, FlaskConical, ShieldAlert, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { useOpenAiModels, useOpenAiStatus, useSaveOpenAiModel, useTestImageModel, useTestOpenAi } from '@/lib/hooks';
import type { ConnectionTestResult, ImageTestResult } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Model selection and "Test connection" for the user's OpenAI key. Nothing here runs on its own:
 * listing models is free but manual, and testing makes one tiny paid call only when pressed.
 */
export function OpenAiPanel() {
  const toast = useToast();
  const status = useOpenAiStatus();
  const models = useOpenAiModels();
  const save = useSaveOpenAiModel();
  const test = useTestOpenAi();
  const imageTest = useTestImageModel();
  const [imageModel, setImageModel] = React.useState('auto');
  const [imageResult, setImageResult] = React.useState<ImageTestResult | null>(null);

  const saved = status.data?.model ?? '';
  const [model, setModel] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const [result, setResult] = React.useState<ConnectionTestResult | null>(null);
  React.useEffect(() => setModel(saved), [saved]);

  const trimmed = model.trim();
  const dirty = trimmed !== saved;
  const validId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(trimmed);
  const options = (models.data?.models ?? []).filter((m) => showAll || m.likelyText);
  const known = models.data ? models.data.models.some((m) => m.id === trimmed) : null;

  function runTest() {
    const ok = window.confirm(
      `Test the connection with model "${trimmed}"?\n\nThis sends ONE tiny request (a few dozen tokens) to OpenAI using your key, so it can cost a tiny amount of your credits.`,
    );
    if (!ok) return;
    setResult(null);
    test.mutate(dirty ? trimmed : undefined, {
      onSuccess: (r) => setResult(r),
      onError: (e) => toast.error(e.message),
    });
  }

  function runImageTest() {
    const ok = window.confirm(
      `Test the image model "${imageModel === 'auto' ? 'chosen automatically from your key' : imageModel}"?\n\nThis sends ONE real image request (lowest quality, 1024x1024) to OpenAI using your key. OpenAI bills it like any image. The picture is discarded. Nothing else is generated.`,
    );
    if (!ok) return;
    setImageResult(null);
    imageTest.mutate(imageModel, { onSuccess: (r) => setImageResult(r), onError: (e) => toast.error(e.message) });
  }

  return (
    <div className="mt-5 space-y-4 border-t border-cream-300/70 pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-sans text-sm font-semibold">Model &amp; connection</h4>
        {status.data?.ready ? (
          <Badge className="bg-emerald-100 text-emerald-800">
            <CheckCircle2 className="h-3 w-3" /> Ready: {status.data.verifiedModel}
          </Badge>
        ) : saved ? (
          <Badge className="bg-amber-100 text-amber-800">Not verified</Badge>
        ) : (
          <Badge className="bg-cream-200 text-ink-600">No model selected</Badge>
        )}
      </div>

      <p className="text-xs text-muted">
        Product Discovery uses exactly this model. LaunchPilot never picks one for you and never switches to a different or more expensive model.
      </p>

      <Field label="Model ID" htmlFor="openai-model" hint="Type any model your account can use, or load the list below. Pick a low-cost model for your first tests." error={trimmed && !validId ? 'Use letters, digits and . _ : / - only.' : undefined}>
        <Input id="openai-model" list="openai-model-options" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. a small, low-cost model from your list" autoComplete="off" spellCheck={false} />
        <datalist id="openai-model-options">
          {options.map((m) => (
            <option key={m.id} value={m.id} />
          ))}
        </datalist>
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => models.refetch()} loading={models.isFetching}>
          <Download className="h-3.5 w-3.5" /> Load my models
        </Button>
        <Button
          size="sm"
          variant="dark"
          onClick={() => save.mutate(trimmed, { onSuccess: () => toast.success('Model saved'), onError: (e) => toast.error(e.message) })}
          loading={save.isPending}
          disabled={!dirty || !validId}
        >
          Save model
        </Button>
        <Button size="sm" onClick={runTest} loading={test.isPending} disabled={!trimmed || !validId}>
          <FlaskConical className="h-3.5 w-3.5" /> Test connection
        </Button>
        {models.data && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show non-text models
          </label>
        )}
      </div>

      {models.isError && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {models.error.message}
        </p>
      )}
      {models.data && (
        <p className="text-xs text-muted">
          {models.data.models.length} models are visible to this key ({options.length} shown).
          {known === false && trimmed && (
            <span className="ml-1 inline-flex items-center gap-1 text-amber-800">
              <ShieldAlert className="h-3 w-3" /> “{trimmed}” is not in this list. Test it before relying on it.
            </span>
          )}
        </p>
      )}

      <div className="space-y-2 rounded-xl border border-cream-300/80 bg-cream-50 p-4" data-testid="image-model-test">
        <h4 className="font-sans text-sm font-semibold">Image model</h4>
        <p className="text-xs text-muted">
          Being <em>listed</em> does not mean a model still works: OpenAI keeps listing models it has shut down, and some need organization verification. The only proof is an image request. This test makes exactly one, only when you press the button, and it is billed by OpenAI.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Image model to test" className="rounded-lg border border-cream-300 bg-white px-2 py-1.5 text-xs text-ink" value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
            <option value="auto">Automatic: a current model your key lists</option>
            {(models.data?.models ?? [])
              .filter((m) => m.imageSupported)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.retired ? ` — shut down on ${m.retired.on}` : ''}
                </option>
              ))}
          </select>
          <Button size="sm" variant="outline" onClick={runImageTest} loading={imageTest.isPending}>
            <FlaskConical className="h-3.5 w-3.5" /> Test image model (billed)
          </Button>
          {models.data?.suggestedImageModel && <span className="text-xs text-muted">Suggested from your list: {models.data.suggestedImageModel}</span>}
        </div>
        {imageResult && (
          <div role="status" className={cn('rounded-xl border px-4 py-3 text-sm', imageResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800')}>
            {imageResult.ok ? (
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4" /> {imageResult.model} produced an image in {imageResult.latencyMs} ms. It was discarded.
              </p>
            ) : (
              <>
                <p className="flex items-center gap-2 font-medium">
                  <XCircle className="h-4 w-4" /> {imageResult.model} cannot be used{imageResult.requestMade ? '' : ' (no request was made)'}
                </p>
                <p className="mt-1 text-xs">{imageResult.error?.explanation}</p>
                {imageResult.error?.status ? (
                  <p className="mt-1 font-mono text-[11px]">
                    HTTP {imageResult.error.status}
                    {imageResult.error.providerCode ? ` · ${imageResult.error.providerCode}` : ''}
                  </p>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>

      {result && (
        <div className={cn('rounded-xl border px-4 py-3 text-sm', result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800')} role="status">
          {result.ok ? (
            <>
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4" /> Connected: {result.model} answered in {result.latencyMs} ms
              </p>
              {result.usage && (
                <p className="mt-1 text-xs">
                  Tokens used by this test: {result.usage.inputTokens} in / {result.usage.outputTokens} out ({result.usage.totalTokens} total)
                </p>
              )}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium">
                <XCircle className="h-4 w-4" /> Not ready: {result.error?.message}
              </p>
              <p className="mt-1 text-xs">
                {result.keyAccepted === true && 'Your key was accepted, but this model could not be used. '}
                {result.keyAccepted === false && 'OpenAI rejected the key itself. '}
                Code: {result.error?.code}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
