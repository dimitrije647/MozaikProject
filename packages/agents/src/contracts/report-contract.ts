import type { ZodType } from 'zod';
import { REPORT_V2_VERSION } from '../discovery/f1/schemas';
import { AUDIT_REPORT_VERSION } from '../audit/schemas';
import { STRATEGY_REPORT_VERSION } from '../strategy/schemas';

/**
 * THE CONTRACT BETWEEN THE PHASES. F1, F2 and F3 each save a report; the next phase reads it back. Both sides use the same schema
 * (the schemas.ts of each phase) and this module is the ONE place that reads a saved report, so a saved report is never judged by two different rules.
 *
 *  - Every report carries an explicit schema version; this registry says which versions this build can read.
 *  - A report is read, validated and normalized IN MEMORY. The stored row is never changed.
 *  - A report that cannot be read is explained field by field (path, count, limit, expected type). Diagnostics never contain the
 *    report's own text, only its structure.
 *  - What the reader may fill in is limited to what the schema declares as a default; every filled or ignored field is listed
 *    (`notes`), never silent. Nothing is invented and a list that is too long is never silently cut.
 */
export type ReportKind = 'F1' | 'F2' | 'F3';

interface ContractInfo {
  /** "Product Discovery" (the phase that writes it). */
  phase: string;
  /** "Product Discovery report", "Marketing Audit", "Strategy report". */
  noun: string;
  current: number;
  supported: readonly number[];
  /** Versions that exist but cannot be read, with the honest reason (nothing can be derived without inventing facts). */
  unreadableVersions: Record<number, string>;
}

export const REPORT_CONTRACTS: Record<ReportKind, ContractInfo> = {
  F1: {
    phase: 'Product Discovery',
    noun: 'Product Discovery report',
    current: REPORT_V2_VERSION,
    supported: [REPORT_V2_VERSION],
    unreadableVersions: { 1: 'Version 1 reports have no Product Manifest, and the manifest cannot be rebuilt from them without inventing facts.' },
  },
  F2: { phase: 'Marketing Audit', noun: 'Marketing Audit', current: AUDIT_REPORT_VERSION, supported: [AUDIT_REPORT_VERSION], unreadableVersions: {} },
  F3: { phase: 'Market Research & Strategy', noun: 'Strategy report', current: STRATEGY_REPORT_VERSION, supported: [STRATEGY_REPORT_VERSION], unreadableVersions: {} },
};

export type IssueProblem = 'missing' | 'wrong_type' | 'too_many' | 'too_long' | 'too_few' | 'too_short' | 'invalid_value' | 'invalid';

export interface ReportIssue {
  /** "creativeBrief.claimsToAvoid" or "channels[2].findingIds". */
  path: string;
  problem: IssueProblem;
  /** Structure only: "has 9 entries; this version accepts at most 8". Never the stored text. */
  message: string;
  actual?: number;
  limit?: number;
}

export interface ReportFailure {
  report: ReportKind;
  /** Which phase wrote it ("Market Research & Strategy"). */
  phase: string;
  noun: string;
  reportId: string;
  schemaVersion: number | null;
  reason: 'unsupported_version' | 'newer_version' | 'not_an_object' | 'schema_mismatch';
  /** The first issues (at most 8); `issueCount` is the total. */
  issues: ReportIssue[];
  issueCount: number;
  /**
   * true: the content is present and only the FORMAT check rejected it (a list longer than this version allows): the saved data is intact
   * and nothing has to run again once the format is read. false: data is genuinely missing, of the wrong type or from a version that cannot be read.
   */
  contentIntact: boolean;
}

/** What reading a report changed in memory (the stored row is never touched). */
export interface ReadNotes {
  /** `current` = the report matches this version exactly. `normalized` = read after the listed deterministic adjustments. */
  status: 'current' | 'normalized';
  schemaVersion: number;
  /** Fields the report did not have and the schema fills with a declared default (for example a field added in a later release). */
  defaulted: string[];
  /** Fields in the stored report this version does not read (kept in the stored row, not used). */
  ignored: string[];
}

export type StoredRead<T> = { ok: true; data: T; notes: ReadNotes } | { ok: false; failure: ReportFailure };

export interface StoredRow {
  id: string;
  schemaVersion: number;
  reportJson: unknown;
}

const MAX_ISSUES = 8;
const MAX_NOTES = 20;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

const render = (path: readonly PropertyKey[]) =>
  path.reduce<string>((acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), '') || '(report)';

interface ZodLikeIssue {
  code: string;
  path: PropertyKey[];
  origin?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  expected?: string;
  values?: unknown[];
  message?: string;
}

function toIssue(raw: unknown, z: ZodLikeIssue): ReportIssue {
  const path = render(z.path);
  const value = valueAt(raw, z.path);
  const count = Array.isArray(value) ? value.length : typeof value === 'string' ? value.length : undefined;
  switch (z.code) {
    case 'too_big': {
      const limit = Number(z.maximum);
      return z.origin === 'array'
        ? { path, problem: 'too_many', limit, actual: count, message: `has ${count ?? 'more'} entries; this version accepts at most ${limit}` }
        : { path, problem: 'too_long', limit, actual: count, message: `is ${count ?? 'longer'} characters long; this version accepts at most ${limit}` };
    }
    case 'too_small': {
      const limit = Number(z.minimum);
      return z.origin === 'array'
        ? { path, problem: 'too_few', limit, actual: count, message: `has ${count ?? 'fewer'} entries; this version needs at least ${limit}` }
        : { path, problem: 'too_short', limit, actual: count, message: `is ${count ?? 'shorter'} characters long; this version needs at least ${limit}` };
    }
    case 'invalid_type':
      return value === undefined || value === null
        ? { path, problem: 'missing', message: `is missing (a ${z.expected ?? 'value'} is required)` }
        : { path, problem: 'wrong_type', message: `has the wrong type (expected ${z.expected ?? 'another type'})` };
    case 'invalid_value':
      return { path, problem: 'invalid_value', message: `is not one of the accepted values (${(z.values ?? []).slice(0, 8).map(String).join(', ')})` };
    default:
      return { path, problem: 'invalid', message: 'does not match the expected format' };
  }
}

/** Fields present on one side only: what the schema filled in (`defaulted`) and what it did not read (`ignored`). Structure only. */
function compareShapes(raw: unknown, parsed: unknown, base: string, out: { defaulted: Set<string>; ignored: Set<string> }): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    for (let i = 0; i < Math.min(raw.length, parsed.length, 50); i++) compareShapes(raw[i], parsed[i], `${base}[]`, out);
    return;
  }
  if (!isObject(raw) || !isObject(parsed)) return;
  for (const k of Object.keys(parsed)) {
    const here = base ? `${base}.${k}` : k;
    if (raw[k] === undefined && parsed[k] !== undefined) out.defaulted.add(here);
    else compareShapes(raw[k], parsed[k], here, out);
  }
  for (const k of Object.keys(raw)) if (!(k in parsed)) out.ignored.add(base ? `${base}.${k}` : k);
}

/**
 * Reads ONE stored report: version check, schema validation, and the list of deterministic adjustments. Pure and free (no database, no
 * network); the stored row is never modified.
 */
export function readStoredReport<T>(kind: ReportKind, row: StoredRow, schema: ZodType<T>): StoredRead<T> {
  const info = REPORT_CONTRACTS[kind];
  const failure = (reason: ReportFailure['reason'], issues: ReportIssue[], contentIntact: boolean, count = issues.length): StoredRead<T> => ({
    ok: false,
    failure: { report: kind, phase: info.phase, noun: info.noun, reportId: row.id, schemaVersion: Number.isFinite(row.schemaVersion) ? row.schemaVersion : null, reason, issues: issues.slice(0, MAX_ISSUES), issueCount: count, contentIntact },
  });

  if (!info.supported.includes(row.schemaVersion)) {
    if (row.schemaVersion > info.current) return failure('newer_version', [{ path: 'schemaVersion', problem: 'invalid_value', message: `is ${row.schemaVersion}; this version of LaunchPilot reads up to ${info.current}` }], true);
    const why = info.unreadableVersions[row.schemaVersion];
    return failure('unsupported_version', [{ path: 'schemaVersion', problem: 'invalid_value', message: `is ${row.schemaVersion}, which cannot be read${why ? `: ${why}` : ''}` }], false);
  }
  if (!isObject(row.reportJson)) return failure('not_an_object', [{ path: '(report)', problem: 'wrong_type', message: 'is not a JSON object' }], false);

  const parsed = schema.safeParse(row.reportJson);
  if (!parsed.success) {
    const issues = (parsed.error.issues as unknown as ZodLikeIssue[]).map((z) => toIssue(row.reportJson, z));
    // intact = every problem is a limit being exceeded (the content is there); anything missing or mistyped is a real gap
    return failure('schema_mismatch', issues, issues.every((i) => i.problem === 'too_many' || i.problem === 'too_long'), issues.length);
  }
  const diff = { defaulted: new Set<string>(), ignored: new Set<string>() };
  compareShapes(row.reportJson, parsed.data, '', diff);
  const defaulted = [...diff.defaulted].slice(0, MAX_NOTES);
  const ignored = [...diff.ignored].slice(0, MAX_NOTES);
  return { ok: true, data: parsed.data, notes: { status: defaulted.length || ignored.length ? 'normalized' : 'current', schemaVersion: row.schemaVersion, defaulted, ignored } };
}

// ---- words for people ---------------------------------------------------------------------------------------------------

/** One failure in plain words: which report, which field, what is wrong and whether anything has to run again. */
export function describeFailure(f: ReportFailure, consumer?: string): string {
  const who = consumer ? `${consumer} could not read the saved ${f.noun}` : `The saved ${f.noun} could not be read`;
  const first = f.issues[0];
  const where = first ? ` Field "${first.path}" ${first.message}${f.issueCount > 1 ? ` (and ${f.issueCount - 1} more problem${f.issueCount - 1 === 1 ? '' : 's'})` : ''}.` : '';
  const version = f.schemaVersion !== null ? ` (format version ${f.schemaVersion})` : '';
  const tail = f.reason === 'newer_version'
    ? ' It was saved by a newer version of LaunchPilot. Update LaunchPilot; nothing needs to run again.'
    : f.contentIntact
      ? ' The report is saved unchanged and its content is complete: only the format check rejected it, so the research and strategy do not need to run again once the format is accepted.'
      : f.reason === 'unsupported_version'
        ? ` It cannot be converted without inventing facts, so this ${f.phase} has to run again.`
        : ` Information is genuinely missing or damaged in the saved report, so this ${f.phase} has to run again.`;
  return `${who}${version}.${where}${tail}`;
}

export function describeFailures(failures: ReportFailure[], consumer?: string): string {
  return failures.map((f) => describeFailure(f, consumer)).join(' ');
}

/** Thrown when a saved report cannot be read. Carries the structured diagnosis; the message is safe to show. */
export class ReportUnreadableError extends Error {
  constructor(readonly failures: ReportFailure[], readonly consumer: string) {
    super(describeFailures(failures, consumer));
    this.name = 'ReportUnreadableError';
  }
  get contentIntact() {
    return this.failures.every((f) => f.contentIntact);
  }
}

/** Checks a report that was just produced against the schema its reader will use (the producer's boundary check). Empty = conforms. */
export function conformanceIssues(schema: ZodType<unknown>, report: unknown): ReportIssue[] {
  const r = schema.safeParse(report);
  return r.success ? [] : (r.error.issues as unknown as ZodLikeIssue[]).map((z) => toIssue(report, z));
}
