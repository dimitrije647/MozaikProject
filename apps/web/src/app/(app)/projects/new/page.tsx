'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Controller, useForm, type FieldErrors, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { FileUploadDropzone, type PendingFile } from '@/components/file-upload-dropzone';
import { SectionHeader } from '@/components/section-header';
import { ProgressBar, Stepper } from '@/components/stepper';
import { api, post, put, patch } from '@/lib/api';
import { keys } from '@/lib/hooks';
import { DURATIONS, LANGUAGES, MARKETING_GOALS, SOCIAL_PLATFORMS } from '@/lib/constants';
import {
  DRAFT_KEY,
  LIMITS,
  WIZARD_DEFAULTS as DEFAULTS,
  WIZARD_STEPS as STEPS,
  blockingMessage,
  createDraftAutosave,
  createProjectSubmitter,
  firstStepWithError,
  parseDraft,
  wizardSchema,
  type DraftStatus,
  type WizardOutput,
  type WizardValues as Values,
} from '@/lib/project-wizard';
import { cn } from '@/lib/utils';

type FileBuckets = Record<'logo' | 'screenshot' | 'image' | 'doc' | 'reference', PendingFile[]>;
const EMPTY_FILES: FileBuckets = { logo: [], screenshot: [], image: [], doc: [], reference: [] };

export default function NewProjectPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = React.useState(0);
  const [files, setFiles] = React.useState<FileBuckets>(EMPTY_FILES);
  const [saving, setSaving] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftStatus>('idle');
  // Why the wizard did not move on, shown next to the buttons (the field itself may be scrolled away).
  const [blocked, setBlocked] = React.useState('');
  // A Continue click is being validated: a second click must not move two steps.
  const advancing = React.useRef(false);

  const form = useForm<Values, unknown, WizardOutput>({ resolver: zodResolver(wizardSchema), defaultValues: DEFAULTS, mode: 'onTouched' });
  const {
    register,
    control,
    watch,
    trigger,
    reset,
    handleSubmit,
    formState: { errors },
  } = form;

  // One submitter per wizard: concurrent saves share one request and the project row is created once.
  const submitter = React.useMemo(
    () =>
      createProjectSubmitter({
        post,
        put,
        patch,
        upload: (id, kind, list) => {
          const body = new FormData();
          list.forEach((f) => body.append('files', f));
          if (kind !== 'doc') body.append('type', kind);
          return api(`/projects/${id}/assets`, { method: 'POST', body });
        },
      }),
    [],
  );
  const autosave = React.useMemo(
    () => (typeof window === 'undefined' ? null : createDraftAutosave(window.localStorage, setDraft)),
    [],
  );

  // Restore draft on first mount.
  React.useEffect(() => {
    try {
      const restored = parseDraft(localStorage.getItem(DRAFT_KEY));
      if (restored) reset(restored);
    } catch {
      /* storage not readable: start empty */
    }
  }, [reset]);

  // Debounced autosave of the text fields (files cannot be persisted in localStorage). It never blocks the wizard.
  React.useEffect(() => {
    const sub = watch((values) => {
      autosave?.schedule(values);
      setBlocked('');
    });
    const flush = () => autosave?.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      sub.unsubscribe();
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [watch, autosave]);

  function goTo(s: number) {
    autosave?.flush();
    setBlocked('');
    setStep(s);
  }

  async function next() {
    if (advancing.current) return;
    advancing.current = true;
    const from = step;
    try {
      const fields = STEPS[from].fields as unknown as FieldPath<Values>[];
      const ok = await trigger(fields, { shouldFocus: true });
      if (ok) goTo(Math.min(from + 1, STEPS.length - 1));
      else setBlocked(blockingMessage(Object.keys(form.formState.errors).filter((k) => (fields as string[]).includes(k))));
    } finally {
      advancing.current = false;
    }
  }

  async function submit(v: WizardOutput) {
    if (submitter.busy) return;
    setSaving(true);
    try {
      const uploads = Object.fromEntries(Object.entries(files).map(([k, list]) => [k, list.map((p) => p.file)]));
      const id = await submitter.submit(v, uploads, (kind) => setFiles((cur) => ({ ...cur, [kind]: [] })));
      autosave?.clear();
      qc.invalidateQueries({ queryKey: keys.projects });
      qc.invalidateQueries({ queryKey: keys.activity });
      toast.success('Project saved');
      router.push(`/projects/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong. Your progress is kept; try again.');
      setSaving(false);
    }
  }

  // Saving with an error on an earlier step (reachable through the step list): open that step and say why.
  function invalid(errs: FieldErrors<Values>) {
    const keysWithError = Object.keys(errs);
    const at = firstStepWithError(keysWithError);
    if (at !== null && at !== step) setStep(at);
    setBlocked(blockingMessage(keysWithError));
  }

  function onFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    // Enter in a text field submits the form: on steps 1-4 that means Continue, never saving the project early.
    if (step < STEPS.length - 1) {
      e.preventDefault();
      void next();
      return;
    }
    void handleSubmit(submit, invalid)(e);
  }

  const v = watch();
  const setFilesFor = (k: keyof FileBuckets) => (list: PendingFile[]) => setFiles((cur) => ({ ...cur, [k]: list }));
  const descriptionLength = v.shortDescription?.length ?? 0;

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="New project"
        title="Brief your AI marketing team"
        description="Five short steps. Everything you enter here becomes the structured brief for your campaign."
      />

      <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Stepper steps={STEPS} current={step} onSelect={goTo} />
          <div className="px-3">
            <ProgressBar value={(step + 1) / STEPS.length} />
            <p className={cn('mt-2 flex items-center gap-1.5 text-xs', draft === 'error' ? 'text-red-600' : 'text-muted')} data-testid="draft-status">
              {draft === 'saved' ? (
                <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Draft saved on this device</>
              ) : draft === 'error' ? (
                <><AlertCircle className="h-3.5 w-3.5" /> Draft could not be saved on this device. You can continue; your entries stay on this page until you save the project.</>
              ) : (
                'Draft autosaves as you type'
              )}
            </p>
          </div>
        </aside>

        <form onSubmit={onFormSubmit} noValidate>
          <Card className="overflow-hidden">
            <div key={step} className="animate-slide-in space-y-6 p-6 sm:p-8">
              {step === 0 && (
                <>
                  <StepTitle title="Product information" body="The basics. The more specific you are, the better the output." />
                  <Field label="Product name" htmlFor="productName" error={errors.productName?.message}>
                    <Input id="productName" placeholder="e.g. Deep Diving School" {...register('productName')} />
                  </Field>
                  <Field
                    label="Description"
                    htmlFor="shortDescription"
                    optional
                    error={errors.shortDescription?.message}
                    hint="One or two sentences: what it is and who it is for. A campaign needs a short description (a business name and a description are all it requires); everything else on this form is optional."
                  >
                    <Textarea id="shortDescription" aria-invalid={Boolean(errors.shortDescription)} {...register('shortDescription')} />
                    <p className={cn('text-right text-xs tabular-nums', descriptionLength > LIMITS.shortDescription ? 'font-medium text-red-600' : 'text-muted')} data-testid="description-count">
                      {descriptionLength} / {LIMITS.shortDescription}
                    </p>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Website URL" htmlFor="websiteUrl" optional error={errors.websiteUrl?.message}>
                      <Input id="websiteUrl" placeholder="https://" {...register('websiteUrl')} />
                    </Field>
                    <Field label="GitHub repository" htmlFor="githubUrl" optional error={errors.githubUrl?.message}>
                      <Input id="githubUrl" placeholder="https://github.com/org/repo" {...register('githubUrl')} />
                    </Field>
                  </div>
                  <div>
                    <p className="mb-3 text-[13px] font-medium text-ink-700">Brand assets <span className="font-normal text-muted">(optional, uploaded when you save)</span></p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FileUploadDropzone label="Logo" accept="image/*" multiple={false} files={files.logo} onChange={setFilesFor('logo')} />
                      <FileUploadDropzone label="Product screenshots" accept="image/*" files={files.screenshot} onChange={setFilesFor('screenshot')} />
                      <FileUploadDropzone label="Images" accept="image/*" files={files.image} onChange={setFilesFor('image')} />
                      <FileUploadDropzone label="PDFs & docs" accept=".pdf,.doc,.docx,.txt,.md" files={files.doc} onChange={setFilesFor('doc')} />
                      <FileUploadDropzone label="Brand references" accept="image/*,.pdf" files={files.reference} onChange={setFilesFor('reference')} className="sm:col-span-2" />
                    </div>
                  </div>
                </>
              )}

              {step === 1 && (
                <>
                  <StepTitle title="Social presence" body="Link the profiles you already have. Leave the rest blank." />
                  <div className="grid gap-4 sm:grid-cols-2">
                    {SOCIAL_PLATFORMS.map((p) => (
                      <Field key={p.key} label={p.label} htmlFor={`social-${p.key}`} optional error={errors.socials?.[p.key]?.message}>
                        <Input id={`social-${p.key}`} placeholder={p.placeholder} {...register(`socials.${p.key}`)} />
                      </Field>
                    ))}
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <StepTitle title="Marketing goals" body="Tell the team what success looks like." />
                  <Field label="Main goal" optional hint="Leave it empty and the AI proposes a goal from your description (labelled as an assumption). Click a selected goal again to clear it." error={errors.marketingGoal?.message}>
                    <Controller
                      control={control}
                      name="marketingGoal"
                      render={({ field }) => (
                        <div className="grid gap-2 sm:grid-cols-3">
                          {MARKETING_GOALS.map((g) => (
                            <button
                              type="button"
                              key={g.value}
                              onClick={() => field.onChange(field.value === g.value ? '' : g.value)}
                              className={cn(
                                'rounded-xl border px-4 py-3 text-left text-sm font-medium transition-all',
                                field.value === g.value ? 'border-ink bg-ink text-cream-100 shadow-soft' : 'border-cream-300 bg-cream-50 hover:border-ink-600/40',
                              )}
                            >
                              {g.label}
                            </button>
                          ))}
                        </div>
                      )}
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Target market" htmlFor="targetMarket" optional hint="Countries, regions or cities.">
                      <Input id="targetMarket" placeholder="e.g. Croatia, Italy" {...register('targetMarket')} />
                    </Field>
                    <Field label="Campaign duration" htmlFor="campaignDuration">
                      <Select id="campaignDuration" {...register('campaignDuration')}>
                        {DURATIONS.map((d) => <option key={d}>{d}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Target audience" htmlFor="targetAudience" optional hint="Age, interests, problems they have.">
                    <Textarea id="targetAudience" {...register('targetAudience')} />
                  </Field>
                  <Field label="Language" htmlFor="preferredLanguage" className="sm:max-w-xs">
                    <Select id="preferredLanguage" {...register('preferredLanguage')}>
                      {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </Select>
                  </Field>
                </>
              )}

              {step === 3 && (
                <>
                  <StepTitle title="Features" body="Choose what the agents should include when they run." />
                  <div className="space-y-3">
                    <Toggle control={control} name="enableSeasonalCalendar" title="Seasonal calendar" body="Plan content around holidays, seasons and key dates." />
                    <Toggle control={control} name="enableGoogleDriveExport" title="Google Drive export" body="Export finished assets to Drive (needs the Google Drive integration)." />
                  </div>
                  <Field label="Publishing mode">
                    <Controller
                      control={control}
                      name="publishingMode"
                      render={({ field }) => (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <ModeCard active={field.value === 'manual'} onClick={() => field.onChange('manual')} title="Manual" body="You review and post everything yourself." />
                          <ModeCard disabled title="Scheduled" body="Auto-publish on a schedule. Placeholder: not available yet." badge="Later" />
                        </div>
                      )}
                    />
                  </Field>
                </>
              )}

              {step === 4 && (
                <>
                  <StepTitle title="Review & submit" body="Check the brief. You can edit any step before saving. The look of your campaigns (template collection, colors and output formats) is chosen when you run a campaign, not here." />
                  <ReviewList values={v} files={files} goTo={goTo} />
                </>
              )}
            </div>

            {blocked && (
              <p role="alert" data-testid="wizard-blocked" className="flex items-start gap-2 border-t border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700 sm:px-8">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {blocked}
              </p>
            )}
            <div className="flex items-center justify-between border-t border-cream-300/80 bg-cream-100/60 px-6 py-4 sm:px-8">
              <Button type="button" variant="ghost" onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0 || saving}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  key="next"
                  type="button"
                  // A double-click is one Continue (e.detail counts the clicks; keyboard activation is 0).
                  onClick={(e) => {
                    if (e.detail <= 1) void next();
                  }}
                >
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  key="submit"
                  type="submit"
                  size="lg"
                  loading={saving}
                  // The second click of a double-click on Continue lands here once the Review step opens: ignore it.
                  onClick={(e) => {
                    if (e.detail > 1) e.preventDefault();
                  }}
                >
                  <Rocket className="h-4 w-4" /> Save project
                </Button>
              )}
            </div>
          </Card>
        </form>
      </div>
    </div>
  );
}

function StepTitle({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="text-2xl">{title}</h2>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}

function Toggle({
  control,
  name,
  title,
  body,
}: {
  control: ReturnType<typeof useForm<Values>>['control'];
  name: 'enableSeasonalCalendar' | 'enableGoogleDriveExport';
  title: string;
  body: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <label className="flex cursor-pointer items-center justify-between gap-6 rounded-xl border border-cream-300 bg-cream-50 px-5 py-4">
          <span>
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block text-xs text-muted">{body}</span>
          </span>
          <Switch checked={field.value} onCheckedChange={field.onChange} />
        </label>
      )}
    />
  );
}

function ModeCard({ title, body, active, disabled, badge, onClick }: { title: string; body: string; active?: boolean; disabled?: boolean; badge?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-xl border px-4 py-3.5 text-left transition-all',
        active ? 'border-ink bg-ink text-cream-100 shadow-soft' : 'border-cream-300 bg-cream-50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">{title}{badge && <span className="rounded-full bg-cream-200 px-2 py-0.5 text-[10px] uppercase text-muted">{badge}</span>}</span>
      <span className={cn('mt-0.5 block text-xs', active ? 'text-muted-dark' : 'text-muted')}>{body}</span>
    </button>
  );
}

function ReviewList({ values: v, files, goTo }: { values: Values; files: FileBuckets; goTo: (s: number) => void }) {
  const socials = Object.entries(v.socials).filter(([, u]) => u);
  const fileCount = Object.values(files).reduce((n, l) => n + l.length, 0);
  const rows: { step: number; title: string; items: [string, React.ReactNode][] }[] = [
    {
      step: 0,
      title: 'Product',
      items: [
        ['Name', v.productName || '–'],
        ['Description', v.shortDescription || '–'],
        ['Website', v.websiteUrl || '–'],
        ['GitHub', v.githubUrl || '–'],
        ['Assets', fileCount ? `${fileCount} file${fileCount > 1 ? 's' : ''} to upload` : 'None'],
      ],
    },
    { step: 1, title: 'Social presence', items: [['Profiles', socials.length ? socials.map(([p]) => p).join(', ') : 'None']] },
    {
      step: 2,
      title: 'Marketing goals',
      items: [
        ['Goal', MARKETING_GOALS.find((g) => g.value === v.marketingGoal)?.label ?? '–'],
        ['Market', v.targetMarket || '–'],
        ['Audience', v.targetAudience || '–'],
        ['Language', LANGUAGES.find((l) => l.value === v.preferredLanguage)?.label ?? v.preferredLanguage],
        ['Duration', v.campaignDuration],
      ],
    },
    {
      step: 3,
      title: 'Features',
      items: [
        ['Seasonal calendar', v.enableSeasonalCalendar ? 'On' : 'Off'],
        ['Google Drive export', v.enableGoogleDriveExport ? 'On' : 'Off'],
        ['Publishing', 'Manual'],
      ],
    },
  ];
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.title} className="rounded-xl border border-cream-300/80 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-sans text-sm font-semibold">{r.title}</h3>
            <button type="button" onClick={() => goTo(r.step)} className="text-xs font-medium text-accent hover:underline">Edit</button>
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[130px_1fr]">
            {r.items.map(([k, val]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="break-words">{val}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
