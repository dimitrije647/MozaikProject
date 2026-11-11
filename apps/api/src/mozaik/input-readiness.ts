/**
 * PROGRESSIVE INPUT REQUIREMENTS. What a project must have before a campaign can start, and what only improves the result.
 *
 *   required     the campaign cannot function without it: the only items that ever block Start
 *   recommended  quality drops without it, the campaign still runs: shown as a warning
 *   optional     missing information has no serious effect: shown as information
 *
 * Every missing item carries the exact fallback LaunchPilot applies, so the user is never told "something is wrong" without being told what
 * will happen instead. The web app only DISPLAYS this result (the server is the single source of truth, so the screen and the API cannot
 * disagree). Pure functions: no I/O, no clock.
 *
 * Nothing here ever invents a value for a missing item; the agents label whatever they propose in its place as an assumption.
 */

export type InputLevel = 'required' | 'recommended' | 'optional';

export interface InputCheck {
  id: string;
  level: InputLevel;
  label: string;
  present: boolean;
  /** What LaunchPilot does when the item is missing (shown to the user as the advisory). */
  whenMissing: string;
}

export interface InputBlocker {
  code: 'missing_name' | 'missing_description';
  message: string;
}

export interface InputReadiness {
  /** false only when a REQUIRED item is missing (and the preset enforces it). */
  ready: boolean;
  /** Every check with its state, required first. */
  checks: InputCheck[];
  /** The blocking problems (empty unless the preset enforces the requirements). Each one says how to fix it. */
  blockers: InputBlocker[];
  /** Missing recommended items (warnings). */
  warnings: string[];
  /** Missing optional items (information). */
  notes: string[];
  counts: { required: { present: number; total: number }; recommended: { present: number; total: number }; optional: { present: number; total: number } };
}

export interface InputFacts {
  projectName: string | null;
  projectDescription: string | null;
  intake: {
    productName: string | null;
    shortDescription: string | null;
    websiteUrl: string | null;
    githubUrl: string | null;
    targetMarket: string | null;
    targetAudience: string | null;
    marketingGoal: string | null;
    campaignDuration: string | null;
    stylePreference: string | null;
  } | null;
  socialProfiles: number;
  assets: { logo: number; images: number; screenshots: number; references: number };
  competitors: number;
  /** Channels the user chose for this run (null/empty = the strategy's recommendation). */
  channels: string[] | null;
  /** The template collection of the campaign design (or, for an older campaign, its style; 'auto' / null = none chosen). */
  style: string | null;
  pinterestConnected: boolean;
  /** Visual references the user attached to this run (uploads, links). */
  referenceCount: number;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Words made of letters/digits (any script); punctuation and lone symbols do not count. */
const wordsOf = (s: string) => clean(s).split(' ').filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));

/**
 * A description is "meaningful" when it says something: at least a short sentence (4 words, 20 characters) that is not just the name repeated.
 * It is deliberately a low bar: the point is to refuse an empty field or a placeholder, not to grade the writing.
 */
export function isMeaningfulDescription(description: string | null | undefined, name?: string | null): boolean {
  const d = clean(description);
  if (d.length < 20 || wordsOf(d).length < 4) return false;
  const n = clean(name).toLowerCase();
  if (n && d.toLowerCase() === n) return false;
  // keyboard mashing / one repeated token is not a description
  const distinct = new Set(wordsOf(d).map((w) => w.toLowerCase()));
  return distinct.size >= 3;
}

export const DESCRIPTION_HELP = 'Write one or two sentences about what the business or product is and who it is for, for example: "AI automation platform that helps people build agents for everyday tasks."';

export function assessInputs(f: InputFacts, opts: { enforce: boolean }): InputReadiness {
  const name = clean(f.intake?.productName) || clean(f.projectName);
  const description = clean(f.intake?.shortDescription) || clean(f.projectDescription);
  const has = (v: string | null | undefined) => clean(v).length > 0;
  const hasImagery = f.assets.logo + f.assets.images + f.assets.screenshots + f.assets.references > 0;

  const checks: InputCheck[] = [
    { id: 'name', level: 'required', label: 'Business or product name', present: name.length >= 2, whenMissing: 'A campaign cannot be made without a name.' },
    { id: 'description', level: 'required', label: 'Short description', present: isMeaningfulDescription(description, name), whenMissing: 'A campaign cannot be made without knowing what the business offers.' },

    { id: 'website', level: 'recommended', label: 'Website', present: has(f.intake?.websiteUrl), whenMissing: 'Website not provided. Website SEO analysis will be skipped and no destination link will be invented.' },
    { id: 'logo', level: 'recommended', label: 'Logo', present: f.assets.logo > 0, whenMissing: 'Logo not provided. LaunchPilot will use a text-based brand identity (the business name).' },
    { id: 'audience', level: 'recommended', label: 'Target audience', present: has(f.intake?.targetAudience), whenMissing: 'Target audience not specified. The AI will propose an audience based on the description and label it as an assumption.' },

    { id: 'market', level: 'optional', label: 'Geographic market', present: has(f.intake?.targetMarket), whenMissing: 'Geographic market not specified. No location is assumed; the strategy stays market-neutral and says so.' },
    { id: 'goal', level: 'optional', label: 'Marketing goal', present: has(f.intake?.marketingGoal), whenMissing: 'Marketing goal not chosen. The strategy proposes a goal and labels it as an assumption.' },
    { id: 'github', level: 'optional', label: 'GitHub repository', present: has(f.intake?.githubUrl), whenMissing: 'No repository supplied. Repository analysis will be skipped.' },
    { id: 'social', level: 'optional', label: 'Social media profiles', present: f.socialProfiles > 0, whenMissing: 'No social profile supplied. Account-specific social analysis will be skipped; a recommended social strategy is still produced.' },
    { id: 'competitors', level: 'optional', label: 'Competitor information', present: f.competitors > 0, whenMissing: 'No competitor supplied. No competitor is named and no competitor figure is invented; category-level positioning is labelled a hypothesis.' },
    { id: 'colors', level: 'optional', label: 'Brand colors', present: hasImagery, whenMissing: 'No brand colors can be read from files. The campaign design suggests a palette from your website, repository or logo when it can, and otherwise uses the default palette of the template collection you choose.' },
    { id: 'photos', level: 'optional', label: 'Existing photographs', present: f.assets.images > 0, whenMissing: 'No photographs supplied. The approved AI-generated originals are used.' },
    { id: 'style', level: 'optional', label: 'Template collection', present: !!f.style && f.style !== 'auto', whenMissing: 'No template collection chosen yet. You choose one of the 10 collections in the campaign design; it decides the look of every creative.' },
    { id: 'channels', level: 'optional', label: 'Marketing channels', present: !!f.channels && f.channels.length > 0, whenMissing: 'No channels chosen. The strategy recommends a sensible set (up to four) and the campaign follows it.' },
    { id: 'duration', level: 'optional', label: 'Campaign duration', present: has(f.intake?.campaignDuration), whenMissing: 'No campaign duration set. The strategy proposes one and labels it as an assumption.' },
    { id: 'references', level: 'optional', label: 'Brand reference images', present: f.referenceCount > 0 || f.assets.references > 0, whenMissing: 'No visual references. The template collection you choose is the visual guidance.' },
  ];

  const blockers: InputBlocker[] = [];
  if (opts.enforce) {
    if (!checks[0].present) blockers.push({ code: 'missing_name', message: 'Hybrid Production needs the business or product name. Add it in the project details, then review the plan again.' });
    if (!checks[1].present) blockers.push({ code: 'missing_description', message: `Hybrid Production needs a short description of what the business offers (at least one short sentence). ${DESCRIPTION_HELP} Add it in the project details, then review the plan again.` });
  }
  const missing = (level: InputLevel) => checks.filter((c) => c.level === level && !c.present);
  const tally = (level: InputLevel) => ({ present: checks.filter((c) => c.level === level && c.present).length, total: checks.filter((c) => c.level === level).length });
  return {
    ready: blockers.length === 0,
    checks,
    blockers,
    warnings: missing('recommended').map((c) => c.whenMissing),
    notes: missing('optional').map((c) => c.whenMissing),
    counts: { required: tally('required'), recommended: tally('recommended'), optional: tally('optional') },
  };
}
