import { readF1Report, type F1Context } from '../audit/context';
import { readF2Report, type F2Context } from '../strategy/context';
import { readF3Report, type F3Context } from '../creative/context';
import { describeFailure, type ReadNotes, type ReportFailure, type ReportKind } from './report-contract';

/**
 * THE FREE CHECK OF A SAVED CHAIN (F1 -> F2 -> F3). Everything a later phase is going to read is read here first, without a database write,
 * a network request or a paid call: does each report exist, can this build read it, does it belong to the project, and do the reports point at
 * each other consistently (row columns and the ids embedded in the reports). The result is what the user sees before approving any spending.
 */
export interface ChainRow {
  id: string;
  projectId: string;
  schemaVersion: number;
  reportJson: unknown;
  metadataJson: unknown;
  createdAt: Date;
}
export interface ChainRows {
  projectId: string;
  f1?: ChainRow | null;
  f2?: (ChainRow & { f1ReportId: string }) | null;
  f3?: (ChainRow & { f1ReportId: string; f2AuditId: string }) | null;
  /** Which reports the next phase will actually read (default: all three). */
  expect?: ReportKind[];
}

export type ReportStatus = 'current' | 'normalized' | 'unreadable' | 'missing';

export interface ReportCheck {
  report: ReportKind;
  id: string | null;
  status: ReportStatus;
  schemaVersion: number | null;
  /** One sentence for the user: "Existing strategy is compatible and will be reused." or exactly what is wrong. */
  message: string;
  /** Fields this build filled with a declared default / does not read (a `normalized` report). */
  defaulted: string[];
  ignored: string[];
  failure: ReportFailure | null;
}

export interface ChainCheck {
  /** Every expected report is readable and the lineage is consistent: safe to build on. */
  ok: boolean;
  reports: ReportCheck[];
  lineageProblems: string[];
  failures: ReportFailure[];
  /** The contexts that could be read (null for a report that was not asked for, is missing or cannot be read). When `ok`, every asked-for one is set. */
  contexts: { f1: F1Context | null; f2: F2Context | null; f3: F3Context | null };
}

const NAME: Record<ReportKind, string> = { F1: 'Existing Product Discovery report', F2: 'Existing Marketing Audit', F3: 'Existing strategy' };

function okMessage(report: ReportKind, status: 'current' | 'normalized', n: number): string {
  return status === 'current' ? `${NAME[report]} is compatible and will be reused.` : `${NAME[report]} is compatible after ${n} deterministic adjustment${n === 1 ? '' : 's'} (listed below) and will be reused.`;
}

export function checkSavedChain(rows: ChainRows): ChainCheck {
  const expect = rows.expect ?? (['F1', 'F2', 'F3'] as ReportKind[]);
  const reports: ReportCheck[] = [];
  const failures: ReportFailure[] = [];
  const lineage: string[] = [];
  let f1: F1Context | null = null;
  let f2: F2Context | null = null;
  let f3: F3Context | null = null;

  const consider = <R extends ChainRow, C>(report: ReportKind, row: R | null | undefined, read: (row: R) => { ok: true; context: C; notes: ReadNotes } | { ok: false; failure: ReportFailure }): C | null => {
    if (!row) {
      reports.push({ report, id: null, status: 'missing', schemaVersion: null, message: `${NAME[report]} was not found among the saved results of this project.`, defaulted: [], ignored: [], failure: null });
      return null;
    }
    if (row.projectId !== rows.projectId) {
      lineage.push(`${NAME[report]} does not belong to this project.`);
      reports.push({ report, id: row.id, status: 'unreadable', schemaVersion: row.schemaVersion, message: `${NAME[report]} does not belong to this project.`, defaulted: [], ignored: [], failure: null });
      return null;
    }
    const r = read(row);
    if (!r.ok) {
      failures.push(r.failure);
      reports.push({ report, id: row.id, status: 'unreadable', schemaVersion: row.schemaVersion, message: describeFailure(r.failure), defaulted: [], ignored: [], failure: r.failure });
      return null;
    }
    const n = r.notes.defaulted.length + r.notes.ignored.length;
    reports.push({ report, id: row.id, status: r.notes.status, schemaVersion: row.schemaVersion, message: okMessage(report, r.notes.status, n), defaulted: r.notes.defaulted, ignored: r.notes.ignored, failure: null });
    return r.context;
  };

  if (expect.includes('F1')) f1 = consider('F1', rows.f1, readF1Report);
  if (expect.includes('F2')) f2 = consider('F2', rows.f2, readF2Report);
  if (expect.includes('F3')) f3 = consider('F3', rows.f3, readF3Report);

  // the reports must point at each other: the row columns AND the ids written inside the reports
  const link = (what: string, a: string | undefined | null, b: string | undefined | null) => {
    if (a && b && a !== b) lineage.push(what);
  };
  if (rows.f1 && rows.f2) link('The saved Marketing Audit was not built on the saved Product Discovery report.', rows.f2.f1ReportId, rows.f1.id);
  if (rows.f1 && rows.f3) link('The saved strategy was not built on the saved Product Discovery report.', rows.f3.f1ReportId, rows.f1.id);
  if (rows.f2 && rows.f3) link('The saved strategy was not built on the saved Marketing Audit.', rows.f3.f2AuditId, rows.f2.id);
  if (f2 && rows.f1) link('The Marketing Audit refers to a different Product Discovery report than the saved one.', f2.report.productContext.f1ReportId, rows.f1.id);
  if (f3 && rows.f1) {
    link('The strategy refers to a different Product Discovery report than the saved one.', f3.report.productContext.f1ReportId, rows.f1.id);
    link('The strategy brief refers to a different Product Discovery report than the saved one.', f3.report.creativeBrief.provenance.f1ReportId, rows.f1.id);
  }
  if (f3 && rows.f2) {
    link('The strategy refers to a different Marketing Audit than the saved one.', f3.report.existingMarketing.f2AuditId, rows.f2.id);
    link('The strategy brief refers to a different Marketing Audit than the saved one.', f3.report.creativeBrief.provenance.f2AuditId, rows.f2.id);
  }

  const ok = reports.every((r) => r.status === 'current' || r.status === 'normalized') && lineage.length === 0 && (!expect.includes('F1') || !!f1) && (!expect.includes('F2') || !!f2) && (!expect.includes('F3') || !!f3);
  return { ok, reports, lineageProblems: lineage, failures, contexts: { f1, f2, f3 } };
}
