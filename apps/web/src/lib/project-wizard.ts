/**
 * New-project wizard logic without React: the form schema, which fields each step owns,
 * draft persistence and the single-flight project submission. The page in
 * app/(app)/projects/new uses these; the tests in project-wizard.test.ts exercise them.
 * The limits mirror the API DTOs (product-intake.dto.ts, projects.dto.ts) so that a value
 * the wizard lets through is never rejected when the project is saved.
 */
import { z } from 'zod';

export const LIMITS = { productName: 120, shortDescription: 2000, targetMarket: 200, targetAudience: 1000 } as const;

/** A length check whose message says how long the text is and how much to cut. */
const tooLong = (label: string, max: number) => (v: string, ctx: z.RefinementCtx) => {
  if (v.length > max)
    ctx.addIssue({ code: 'custom', message: `${label} is too long: ${v.length} characters, the maximum is ${max}. Shorten it by ${v.length - max}.` });
};

/** Empty, or a full http(s) address with a real host name (what the API's IsUrl accepts). Spaces around a pasted address are ignored. */
const optionalUrl = z
  .string()
  .trim()
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && /\.[a-z0-9-]{2,}$/i.test(u.hostname);
    } catch {
      return false;
    }
  }, 'Enter a full address starting with https://, e.g. https://example.com');

export const SOCIAL_KEYS = ['instagram', 'facebook', 'linkedin', 'x', 'reddit', 'tiktok', 'pinterest', 'youtube'] as const;

export const wizardSchema = z.object({
  productName: z
    .string()
    .trim()
    .min(2, 'Give your product or company a name (at least 2 characters)')
    .superRefine(tooLong('Product name', LIMITS.productName)),
  shortDescription: z.string().superRefine(tooLong('Description', LIMITS.shortDescription)),
  websiteUrl: optionalUrl,
  githubUrl: optionalUrl,
  socials: z.object(Object.fromEntries(SOCIAL_KEYS.map((k) => [k, optionalUrl])) as Record<(typeof SOCIAL_KEYS)[number], typeof optionalUrl>),
  marketingGoal: z.string(),
  targetMarket: z.string().superRefine(tooLong('Target market', LIMITS.targetMarket)),
  targetAudience: z.string().superRefine(tooLong('Target audience', LIMITS.targetAudience)),
  preferredLanguage: z.string(),
  campaignDuration: z.string(),
  enableSeasonalCalendar: z.boolean(),
  enableGoogleDriveExport: z.boolean(),
  publishingMode: z.enum(['manual', 'scheduled']),
});
/** What the inputs hold (before trimming). */
export type WizardValues = z.input<typeof wizardSchema>;
/** What is sent to the API (trimmed). */
export type WizardOutput = z.output<typeof wizardSchema>;

export const WIZARD_DEFAULTS: WizardValues = {
  productName: '',
  shortDescription: '',
  websiteUrl: '',
  githubUrl: '',
  socials: Object.fromEntries(SOCIAL_KEYS.map((k) => [k, ''])) as WizardValues['socials'],
  marketingGoal: '',
  targetMarket: '',
  targetAudience: '',
  preferredLanguage: 'en',
  campaignDuration: '1 month',
  enableSeasonalCalendar: false,
  enableGoogleDriveExport: false,
  publishingMode: 'manual',
};

export const WIZARD_STEPS = [
  { title: 'Product', hint: 'What are you promoting?', fields: ['productName', 'shortDescription', 'websiteUrl', 'githubUrl'] },
  { title: 'Social presence', hint: 'Where your audience is', fields: ['socials'] },
  { title: 'Marketing goals', hint: 'Goal, market, audience', fields: ['marketingGoal', 'targetMarket', 'targetAudience', 'preferredLanguage', 'campaignDuration'] },
  { title: 'Features', hint: 'Toggles and publishing', fields: ['enableSeasonalCalendar', 'enableGoogleDriveExport', 'publishingMode'] },
  { title: 'Review', hint: 'Check and save', fields: [] },
] as const;

export const FIELD_LABELS: Record<string, string> = {
  productName: 'Product name',
  shortDescription: 'Description',
  websiteUrl: 'Website URL',
  githubUrl: 'GitHub repository',
  socials: 'Social profile links',
  targetMarket: 'Target market',
  targetAudience: 'Target audience',
};

/** The step that owns a top-level field. */
export function stepOfField(field: string): number {
  const i = WIZARD_STEPS.findIndex((s) => (s.fields as readonly string[]).includes(field));
  return i < 0 ? 0 : i;
}

/** First step that has an error, given the top-level keys of the form errors. */
export function firstStepWithError(errorKeys: string[]): number | null {
  const steps = errorKeys.map(stepOfField);
  return steps.length ? Math.min(...steps) : null;
}

/** Human list of the fields that block a step, for the message next to the Continue button. */
export function blockingMessage(errorKeys: string[]): string {
  const labels = [...new Set(errorKeys.map((k) => FIELD_LABELS[k] ?? k))];
  if (!labels.length) return '';
  return `Please correct ${labels.length === 1 ? 'this field' : 'these fields'} to continue: ${labels.join(', ')}.`;
}

/** Validates the fields of one step. Same schema and field lists the page validates with. */
export function validateStep(values: WizardValues, step: number): { ok: boolean; errors: Record<string, string> } {
  const own = WIZARD_STEPS[step].fields as readonly string[];
  const res = wizardSchema.safeParse(values);
  const errors: Record<string, string> = {};
  if (!res.success) {
    for (const issue of res.error.issues) {
      const key = String(issue.path[0]);
      if (own.includes(key)) errors[issue.path.join('.')] ??= issue.message;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// ---------------------------------------------------------------- draft

export const DRAFT_KEY = 'launchpilot:new-project-draft';

/** Reads a stored draft: unknown keys and values of the wrong type are dropped, missing ones take defaults. */
export function parseDraft(raw: string | null): WizardValues | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const out: WizardValues = { ...WIZARD_DEFAULTS, socials: { ...WIZARD_DEFAULTS.socials } };
  for (const k of Object.keys(WIZARD_DEFAULTS) as (keyof WizardValues)[]) {
    if (k === 'socials') continue;
    if (typeof d[k] === typeof WIZARD_DEFAULTS[k]) (out as Record<string, unknown>)[k] = d[k];
  }
  if (out.publishingMode !== 'manual' && out.publishingMode !== 'scheduled') out.publishingMode = 'manual';
  const socials = d.socials && typeof d.socials === 'object' ? (d.socials as Record<string, unknown>) : {};
  for (const k of SOCIAL_KEYS) if (typeof socials[k] === 'string') out.socials[k] = socials[k] as string;
  return out;
}

export type DraftStatus = 'idle' | 'pending' | 'saved' | 'error';

/**
 * Debounced draft saving. A failure (storage full, blocked, private mode) is reported through
 * onStatus('error') and never thrown; nothing in the wizard waits for it.
 */
export function createDraftAutosave(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  onStatus: (s: DraftStatus) => void,
  delayMs = 600,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: unknown = null;
  const write = () => {
    timer = null;
    try {
      storage.setItem(DRAFT_KEY, JSON.stringify(latest));
      onStatus('saved');
    } catch {
      onStatus('error');
    }
  };
  return {
    schedule(values: unknown) {
      latest = values;
      if (timer) clearTimeout(timer);
      onStatus('pending');
      timer = setTimeout(write, delayMs);
    },
    /** Writes a pending draft now (on step change, before leaving the page). */
    flush() {
      if (timer) {
        clearTimeout(timer);
        write();
      }
    },
    /** Stops a pending write and removes the draft (after the project is saved). */
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        storage.removeItem(DRAFT_KEY);
      } catch {
        /* nothing to clear */
      }
      onStatus('idle');
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------- submission

export interface WizardClient {
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  upload(projectId: string, kind: string, files: File[]): Promise<unknown>;
}

export type UploadBuckets = Record<string, File[]>;

/**
 * Saves the project. Calls made while one is running get the same promise, and the project row is
 * created at most once per wizard: a retry after a later step failed reuses it.
 */
export function createProjectSubmitter(client: WizardClient) {
  let createdId: string | null = null;
  let running: Promise<string> | null = null;

  async function run(v: WizardOutput, uploads: UploadBuckets, onUploaded: (kind: string) => void): Promise<string> {
    if (!createdId) {
      const project = await client.post<{ id: string }>('/projects', {
        name: v.productName,
        description: v.shortDescription || undefined,
      });
      createdId = project.id;
    }
    const id = createdId;
    await client.put(`/projects/${id}/intake`, {
      productName: v.productName,
      shortDescription: v.shortDescription,
      websiteUrl: v.websiteUrl,
      githubUrl: v.githubUrl,
      targetMarket: v.targetMarket,
      targetAudience: v.targetAudience,
      marketingGoal: v.marketingGoal,
      preferredLanguage: v.preferredLanguage,
      campaignDuration: v.campaignDuration,
      publishingMode: v.publishingMode,
      enableSeasonalCalendar: v.enableSeasonalCalendar,
      enableGoogleDriveExport: v.enableGoogleDriveExport,
    });
    await client.put(`/projects/${id}/social-profiles`, {
      profiles: Object.entries(v.socials)
        .filter(([, url]) => url)
        .map(([platform, url]) => ({ platform, url })),
    });
    // Uploaded buckets are reported so the page clears them and a retry only re-sends what failed.
    for (const [kind, files] of Object.entries(uploads)) {
      if (!files.length) continue;
      await client.upload(id, kind, files);
      onUploaded(kind);
    }
    await client.patch(`/projects/${id}`, { status: 'READY' });
    return id;
  }

  return {
    submit(v: WizardOutput, uploads: UploadBuckets, onUploaded: (kind: string) => void = () => {}) {
      running ??= run(v, uploads, onUploaded).finally(() => {
        running = null;
      });
      return running;
    },
    get busy() {
      return running !== null;
    },
    get createdId() {
      return createdId;
    },
  };
}
