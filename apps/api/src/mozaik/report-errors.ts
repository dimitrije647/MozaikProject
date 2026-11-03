import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import { ReportUnreadableError, type ChainCheck, type ReportFailure } from '@launchpilot/agents';
import type { PhaseFailure } from './factory-plan';

/**
 * A phase that needs a saved report and cannot read it stops BEFORE anything is requested, and says exactly which report, which field and
 * whether anything has to run again. Three codes (never the generic "older format, run it again"):
 *   report_unreadable  the content is intact; only the format check rejected it. Nothing has to run again.
 *   report_damaged     information is genuinely missing or damaged (or the version cannot be read): that phase has to run again.
 *   report_lineage     the saved reports do not belong together (another project, or built on different results).
 */
export type ReportErrorCode = 'report_unreadable' | 'report_damaged' | 'report_lineage';
export const REPORT_ERROR_CODES: readonly string[] = ['report_unreadable', 'report_damaged', 'report_lineage'];

const structure = (f: ReportFailure) => `${f.report} ${f.reportId} (format version ${f.schemaVersion ?? 'unknown'}): ${f.issues.map((i) => `${i.path} ${i.message}`).join('; ')}${f.issueCount > f.issues.length ? ` (and ${f.issueCount - f.issues.length} more)` : ''}`;

/** The words and the code for a chain that cannot be built on (exact report, field and whether anything has to run again). */
export function chainProblem(consumer: string, check: ChainCheck): { code: ReportErrorCode; message: string; detail: string } {
  const failures = check.failures;
  const parts: string[] = [];
  if (failures.length) parts.push(new ReportUnreadableError(failures, consumer).message);
  if (check.lineageProblems.length) parts.push(`${consumer} needs saved reports that belong together: ${check.lineageProblems.join(' ')}`);
  const missing = check.reports.filter((r) => r.status === 'missing');
  if (missing.length) parts.push(missing.map((r) => r.message).join(' '));
  // a report that is gone is not a format question: that phase has to run again
  const code: ReportErrorCode = failures.length || missing.length ? (!missing.length && failures.every((f) => f.contentIntact) ? 'report_unreadable' : 'report_damaged') : 'report_lineage';
  return { code, message: parts.join(' ') || `${consumer} could not use the saved reports.`, detail: [...failures.map(structure), ...check.lineageProblems].join(' | ').slice(0, 900) };
}

export function chainException(consumer: string, check: ChainCheck): UnprocessableEntityException {
  const { code, message, detail } = chainProblem(consumer, check);
  return new UnprocessableEntityException({ statusCode: 422, error: 'Unprocessable Entity', message, code, consumer, reports: check.failures, lineage: check.lineageProblems, detail });
}

/** The structured failure of a thrown report error (what the run records for the phase), or null for any other error. */
export function reportFailureOf(err: unknown): PhaseFailure | null {
  if (!(err instanceof HttpException)) return null;
  const body = err.getResponse() as Record<string, unknown> | string;
  if (typeof body !== 'object' || body === null || typeof body.code !== 'string' || !REPORT_ERROR_CODES.includes(body.code)) return null;
  return { agent: typeof body.consumer === 'string' ? body.consumer : null, code: body.code, message: String(body.message ?? '').slice(0, 700), detail: typeof body.detail === 'string' ? body.detail : null };
}
