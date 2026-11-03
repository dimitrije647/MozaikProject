/**
 * The project data Product Discovery works from: text, structured intake and the LIST of available
 * sources (website, repository, uploads, social profiles). The sources themselves are retrieved by
 * deterministic tools at run time; social profiles are listed but never retrieved. No credentials
 * are ever part of this object.
 */
export interface DiscoveryInput {
  project: { name: string; description: string | null };
  intake: {
    productName: string;
    shortDescription: string | null;
    targetMarket: string | null;
    targetAudience: string | null;
    marketingGoal: string | null;
    campaignDuration: string | null;
    stylePreference: string | null;
  } | null;
  notes: { title: string; content: string }[];
  availableSources: {
    websiteUrl: string | null;
    githubUrl: string | null;
    socialProfiles: { platform: string; url: string }[];
    uploads: { name: string; type: string; mimeType: string }[];
  };
  /** Language code the report must be written in (e.g. "en", "sr"). */
  language: string;
  /** True when some text was shortened to bound token usage. */
  truncated: boolean;
  /**
   * What the user did NOT supply (computed, never typed by a model). Missing optional information is normal, not an error: the agents work
   * with what exists, never invent a value for these items, and label anything they propose in their place as an assumption.
   */
  notSupplied?: string[];
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  sr: 'Serbian (Latin script, natural idiomatic Serbian)',
  hr: 'Croatian',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
};

export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

const LIMITS = { description: 6000, field: 2500, note: 1500, notes: 10, urls: 12, uploads: 20 };

export interface RawDiscoveryData {
  project: { name: string; description?: string | null };
  intake?: {
    productName: string;
    shortDescription?: string | null;
    websiteUrl?: string | null;
    githubUrl?: string | null;
    targetMarket?: string | null;
    targetAudience?: string | null;
    marketingGoal?: string | null;
    preferredLanguage?: string | null;
    campaignDuration?: string | null;
    stylePreference?: string | null;
  } | null;
  notes?: { title: string; content: string }[];
  socialProfiles?: { platform: string; url: string }[];
  assets?: { originalName: string; type: string; mimeType: string }[];
}

/** Normalizes and bounds raw project data into the agents' input (pure function). */
export function buildDiscoveryInput(raw: RawDiscoveryData): DiscoveryInput {
  let truncated = false;
  const cap = (value: string | null | undefined, max: number): string | null => {
    if (value == null || value === '') return null;
    if (value.length > max) {
      truncated = true;
      return value.slice(0, max);
    }
    return value;
  };
  const i = raw.intake ?? null;
  const notSupplied = notSuppliedOf(raw);
  return {
    project: { name: cap(raw.project.name, 200) ?? '', description: cap(raw.project.description, LIMITS.description) },
    intake: i && {
      productName: cap(i.productName, 200) ?? '',
      shortDescription: cap(i.shortDescription, LIMITS.description),
      targetMarket: cap(i.targetMarket, LIMITS.field),
      targetAudience: cap(i.targetAudience, LIMITS.field),
      marketingGoal: cap(i.marketingGoal, 100),
      campaignDuration: cap(i.campaignDuration, 100),
      stylePreference: cap(i.stylePreference, 100),
    },
    notes: (raw.notes ?? []).slice(0, LIMITS.notes).map((n) => ({ title: cap(n.title, 160) ?? '', content: cap(n.content, LIMITS.note) ?? '' })),
    availableSources: {
      websiteUrl: i?.websiteUrl ?? null,
      githubUrl: i?.githubUrl ?? null,
      socialProfiles: (raw.socialProfiles ?? []).slice(0, LIMITS.urls),
      uploads: (raw.assets ?? []).slice(0, LIMITS.uploads).map((a) => ({ name: a.originalName, type: a.type, mimeType: a.mimeType })),
    },
    language: i?.preferredLanguage || 'en',
    truncated,
    notSupplied,
  };
}

/** The optional inputs a project does not have, as short labels ("website", "target audience"...). */
export function notSuppliedOf(raw: RawDiscoveryData): string[] {
  const i = raw.intake ?? null;
  const has = (v: string | null | undefined) => (v ?? '').trim().length > 0;
  const out: string[] = [];
  if (!has(i?.websiteUrl)) out.push('website');
  if (!has(i?.githubUrl)) out.push('GitHub repository');
  if (!(raw.socialProfiles ?? []).length) out.push('social media profiles');
  if (!has(i?.targetAudience)) out.push('target audience');
  if (!has(i?.targetMarket)) out.push('geographic market');
  if (!has(i?.marketingGoal)) out.push('marketing goal');
  if (!(raw.assets ?? []).length) out.push('uploaded files (logo, photographs, documents, references)');
  if (!(raw.notes ?? []).length) out.push('notes');
  return out;
}

/** Field paths agents may cite as the source of a claimed fact. */
export const INPUT_FIELD_PATHS = [
  'project.name',
  'project.description',
  'intake.productName',
  'intake.shortDescription',
  'intake.targetMarket',
  'intake.targetAudience',
  'intake.marketingGoal',
  'intake.campaignDuration',
  'intake.stylePreference',
] as const;

/** All supplied text, flattened and normalized, for verbatim-quote checks. */
export function inputCorpus(input: DiscoveryInput): string {
  const parts = [
    input.project.name,
    input.project.description,
    input.intake?.productName,
    input.intake?.shortDescription,
    input.intake?.targetMarket,
    input.intake?.targetAudience,
    input.intake?.marketingGoal,
    ...input.notes.flatMap((n) => [n.title, n.content]),
  ];
  return normalizeText(parts.filter(Boolean).join(' \n '));
}

export const normalizeText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
