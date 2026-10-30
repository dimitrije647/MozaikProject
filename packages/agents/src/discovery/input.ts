/**
 * What the Product Discovery agents are allowed to see: the project's TEXT and structured intake.
 * URLs and uploads are listed as "available but not analyzed" (no crawling, repo or file analysis
 * exists yet). No credentials are ever part of this object.
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
  availableNotAnalyzed: {
    websiteUrl: string | null;
    githubUrl: string | null;
    socialProfiles: { platform: string; url: string }[];
    uploads: { name: string; type: string; mimeType: string }[];
  };
  /** Language code the report must be written in (e.g. "en", "sr"). */
  language: string;
  /** True when some text was shortened to bound token usage. */
  truncated: boolean;
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
    availableNotAnalyzed: {
      websiteUrl: i?.websiteUrl ?? null,
      githubUrl: i?.githubUrl ?? null,
      socialProfiles: (raw.socialProfiles ?? []).slice(0, LIMITS.urls),
      uploads: (raw.assets ?? []).slice(0, LIMITS.uploads).map((a) => ({ name: a.originalName, type: a.type, mimeType: a.mimeType })),
    },
    language: i?.preferredLanguage || 'en',
    truncated,
  };
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
