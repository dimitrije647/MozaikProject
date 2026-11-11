import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { readF1Report } from '../audit/context';
import { readF2Report } from '../strategy/context';
import { readF3Report, buildF3Context } from '../creative/context';
import { CampaignStrategyReport, F4CreativeBrief, STORED_LIMITS } from '../strategy/schemas';
import { checkSavedChain } from './chain-check';
import { REPORT_CONTRACTS, ReportUnreadableError, describeFailure, readStoredReport } from './report-contract';

/**
 * THE 2026-11-02 INCIDENT, from the sanitized copies of the three saved rows (see testing/fixtures/incident-2026-11-02/README.md):
 * F3 stored 9 claimsToAvoid, F4's schema allowed 8, and F4 told the user "older format, run the Strategy again".
 */
const FX = path.join(__dirname, '..', 'testing', 'fixtures', 'incident-2026-11-02');
const load = (f: string) => {
  const r = JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
  return { ...r, createdAt: new Date(r.createdAt) };
};
const fresh = () => ({ f1: load('f1-row.json'), f2: load('f2-row.json'), f3: load('f3-row.json') });

/** The F3 contract exactly as it was when the incident happened: the brief's claimsToAvoid was limited to the strategist's 8. */
const PRE_FIX_CONTRACT = CampaignStrategyReport.extend({
  creativeBrief: F4CreativeBrief.extend({ claimsToAvoid: z.array(z.object({ claim: z.string().max(240), reason: z.string().max(240) })).max(8) }),
});

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
};

describe('Report contract: the saved F1 -> F2 -> F3 chain of the incident', () => {
  it('1. REPRODUCES the original failure: the pre-fix contract rejects the saved strategy at creativeBrief.claimsToAvoid (9 entries, limit 8)', () => {
    const { f3 } = fresh();
    const r = readStoredReport('F3', f3, PRE_FIX_CONTRACT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failure.reason, 'schema_mismatch');
    assert.equal(r.failure.issueCount, 1, 'exactly one problem, not a pile of them');
    assert.deepEqual(r.failure.issues[0], { path: 'creativeBrief.claimsToAvoid', problem: 'too_many', limit: 8, actual: 9, message: 'has 9 entries; this version accepts at most 8' });
    assert.equal(r.failure.contentIntact, true, 'the content is there; only a length limit rejected it');
    assert.equal(r.failure.reportId, 'fx-f3-strategy');
    assert.equal(f3.reportJson.creativeBrief.claimsToAvoid.length, 9);
  });

  it('2. the repaired reader accepts the saved F1, F2 and F3 reports exactly as stored', () => {
    const { f1, f2, f3 } = fresh();
    const r1 = readF1Report(f1);
    const r2 = readF2Report(f2);
    const r3 = readF3Report(f3);
    assert.ok(r1.ok && r2.ok && r3.ok);
    if (!(r1.ok && r2.ok && r3.ok)) return;
    for (const r of [r1, r2, r3]) assert.equal(r.notes.status, 'current', 'no adjustment was needed: nothing was patched up');
    assert.equal(r3.context.report.creativeBrief.claimsToAvoid.length, 9, 'no claim to avoid was dropped');
    assert.equal(r3.context.strategyId, 'fx-f3-strategy');
    assert.equal(r3.context.f1ReportId, 'fx-f1-report');
    assert.equal(r3.context.f2AuditId, 'fx-f2-audit');
    assert.ok(buildF3Context(f3), 'the older entry point returns the same context');
  });

  it('3. reading never changes the stored report (deep-frozen input, byte-identical output)', () => {
    const { f1, f2, f3 } = fresh();
    const before = JSON.stringify([f1, f2, f3]);
    deepFreeze(f1);
    deepFreeze(f2);
    deepFreeze(f3);
    assert.ok(readF1Report(f1).ok && readF2Report(f2).ok && readF3Report(f3).ok);
    assert.equal(JSON.stringify([f1, f2, f3]), before);
  });

  it('4. the free chain check passes with the exact user-facing sentences and a consistent lineage', () => {
    const { f1, f2, f3 } = fresh();
    const c = checkSavedChain({ projectId: 'fx-project', f1, f2, f3 });
    assert.equal(c.ok, true);
    assert.deepEqual(c.lineageProblems, []);
    assert.deepEqual(c.reports.map((r) => [r.report, r.status, r.message]), [
      ['F1', 'current', 'Existing Product Discovery report is compatible and will be reused.'],
      ['F2', 'current', 'Existing Marketing Audit is compatible and will be reused.'],
      ['F3', 'current', 'Existing strategy is compatible and will be reused.'],
    ]);
    assert.equal(c.contexts.f3?.report.creativeBrief.claimsToAvoid.length, 9);
  });

  it('5. the stored limit is the one the producer uses (the two can no longer drift apart silently)', () => {
    assert.equal(STORED_LIMITS.claimsToAvoid, 12);
    const { f3 } = fresh();
    const within = (n: number) => ({ ...f3, reportJson: { ...f3.reportJson, creativeBrief: { ...f3.reportJson.creativeBrief, claimsToAvoid: Array.from({ length: n }, (_, i) => ({ claim: `Claim ${i}`, reason: 'r' })) } } });
    assert.equal(readF3Report(within(12)).ok, true);
    const over = readF3Report(within(13));
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.failure.issues[0].message, 'has 13 entries; this version accepts at most 12');
  });
});

describe('Report contract: what is NOT accepted, with a precise explanation', () => {
  it('6. an unknown (newer) schema version is refused with its own reason, never guessed at', () => {
    const { f3 } = fresh();
    const r = readF3Report({ ...f3, schemaVersion: 7 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failure.reason, 'newer_version');
    assert.match(describeFailure(r.failure, 'Creative Production'), /Creative Production could not read the saved Strategy report \(format version 7\)\. Field "schemaVersion" is 7; this version of LaunchPilot reads up to 1\. It was saved by a newer version of LaunchPilot\. Update LaunchPilot; nothing needs to run again\./);
  });

  it('7. an F1 report of version 1 (no Product Manifest) is refused honestly: it cannot be rebuilt without inventing facts', () => {
    const { f1 } = fresh();
    const r = readF1Report({ ...f1, schemaVersion: 1 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failure.reason, 'unsupported_version');
    assert.equal(r.failure.contentIntact, false);
    assert.match(r.failure.issues[0].message, /no Product Manifest.*without inventing facts/);
    assert.match(describeFailure(r.failure), /has to run again/);
  });

  it('8. a corrupt report is never silently accepted: a missing required field, a wrong type and a non-object are each named', () => {
    const { f3 } = fresh();
    const missing = structuredClone(f3);
    delete missing.reportJson.creativeBrief.objective;
    const m = readF3Report(missing);
    assert.equal(m.ok, false);
    if (!m.ok) {
      assert.deepEqual(m.failure.issues.map((i) => [i.path, i.problem]), [['creativeBrief.objective', 'missing']]);
      assert.equal(m.failure.contentIntact, false, 'genuinely missing data is not a format difference');
      assert.match(describeFailure(m.failure, 'Creative Production'), /genuinely missing or damaged.*has to run again/);
    }
    const wrong = structuredClone(f3);
    wrong.reportJson.channels = 'instagram';
    const w = readF3Report(wrong);
    assert.equal(w.ok, false);
    if (!w.ok) assert.equal(w.failure.issues[0].problem, 'wrong_type');
    const notObject = readF3Report({ ...f3, reportJson: '{"truncated": ' });
    assert.equal(notObject.ok, false);
    if (!notObject.ok) assert.equal(notObject.failure.reason, 'not_an_object');
    assert.equal(readF3Report({ ...f3, reportJson: null }).ok, false);
    assert.equal(readF3Report({ ...f3, reportJson: [] }).ok, false);
  });

  it('9. every problem of a damaged report is counted and the first ones are listed (not just the first)', () => {
    const { f3 } = fresh();
    const bad = structuredClone(f3);
    delete bad.reportJson.creativeBrief.objective;
    bad.reportJson.creativeBrief.claimsToAvoid = Array.from({ length: 30 }, () => ({ claim: 'c', reason: 'r' }));
    bad.reportJson.kpis = 'none';
    const r = readF3Report(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failure.issueCount, 3);
    assert.deepEqual(r.failure.issues.map((i) => i.path).sort(), ['creativeBrief.claimsToAvoid', 'creativeBrief.objective', 'kpis']);
    assert.equal(r.failure.contentIntact, false, 'one real gap makes the whole report not-intact');
  });

  it('10. a diagnosis describes the structure only: no stored text is ever copied into it', () => {
    const { f3 } = fresh();
    const bad = structuredClone(f3);
    bad.reportJson.creativeBrief.claimsToAvoid = Array.from({ length: 13 }, (_, i) => ({ claim: `SECRET-CLAIM-TEXT-${i}`, reason: 'SECRET-REASON' }));
    bad.reportJson.executiveSummary = 'x'.repeat(5000);
    const r = readF3Report(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    const text = JSON.stringify(r.failure) + describeFailure(r.failure, 'Creative Production') + new ReportUnreadableError([r.failure], 'Creative Production').message;
    assert.doesNotMatch(text, /SECRET/);
    assert.doesNotMatch(text, /xxxxxxxx/);
    assert.match(text, /executiveSummary/);
  });
});

describe('Report contract: deterministic adjustments are listed, never silent', () => {
  it('11. a field added in a later release is filled with its declared default and listed as an adjustment; the stored row keeps its shape', () => {
    const { f3 } = fresh();
    const older = structuredClone(f3);
    for (const k of ['userSuppliedNames', 'namesNotFound', 'pagesRetrieved', 'sitesRead']) delete older.reportJson.competitorLandscape[k];
    delete older.reportJson.existingMarketing.contradictions;
    const r = readF3Report(older);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notes.status, 'normalized');
    assert.deepEqual(r.notes.defaulted.sort(), ['competitorLandscape.namesNotFound', 'competitorLandscape.pagesRetrieved', 'competitorLandscape.sitesRead', 'competitorLandscape.userSuppliedNames', 'existingMarketing.contradictions']);
    assert.equal('userSuppliedNames' in older.reportJson.competitorLandscape, false, 'the stored report was not rewritten');
    const chain = checkSavedChain({ projectId: 'fx-project', f1: load('f1-row.json'), f2: load('f2-row.json'), f3: older });
    assert.equal(chain.ok, true);
    assert.equal(chain.reports[2].status, 'normalized');
    assert.match(chain.reports[2].message, /compatible after 5 deterministic adjustments .* and will be reused/);
  });

  it('12. a field this version does not read is listed as ignored (kept in the stored row), not dropped without a word', () => {
    const { f3 } = fresh();
    const newer = structuredClone(f3);
    newer.reportJson.creativeBrief.futureField = { anything: true };
    const r = readF3Report(newer);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notes.status, 'normalized');
    assert.deepEqual(r.notes.ignored, ['creativeBrief.futureField']);
    assert.equal(newer.reportJson.creativeBrief.futureField.anything, true);
  });

  it('13. a list that is too long is NOT cut to fit: the content stays and the explanation says so', () => {
    const { f3 } = fresh();
    const longer = structuredClone(f3);
    longer.reportJson.kpis = Array.from({ length: 9 }, () => structuredClone(f3.reportJson.kpis[0]));
    const r = readF3Report(longer);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failure.contentIntact, true);
    assert.deepEqual(r.failure.issues.map((i) => [i.path, i.actual, i.limit]), [['kpis', 9, 8]]);
    assert.equal(longer.reportJson.kpis.length, 9);
  });
});

describe('Report contract: the free preflight catches incompatible inputs before anything is spent', () => {
  it('14. an unreadable strategy fails the chain check with the exact report, field and the fact that nothing needs to run again', () => {
    const { f1, f2, f3 } = fresh();
    const longer = structuredClone(f3);
    longer.reportJson.kpis = Array.from({ length: 9 }, () => structuredClone(f3.reportJson.kpis[0]));
    const c = checkSavedChain({ projectId: 'fx-project', f1, f2, f3: longer });
    assert.equal(c.ok, false);
    assert.equal(c.contexts.f3, null);
    assert.ok(c.contexts.f1 && c.contexts.f2, 'the readable reports still give their contexts');
    const f = c.reports.find((r) => r.report === 'F3')!;
    assert.equal(f.status, 'unreadable');
    assert.equal(f.id, 'fx-f3-strategy');
    assert.match(f.message, /Field "kpis" has 9 entries; this version accepts at most 8\./);
    assert.match(f.message, /do not need to run again/);
    assert.equal(c.reports.find((r) => r.report === 'F1')!.status, 'current', 'the readable reports are still reported as reusable');
  });

  it('15. lineage: another project, a strategy built on a different audit or report, and ids written inside the reports are all checked', () => {
    const { f1, f2, f3 } = fresh();
    const other = checkSavedChain({ projectId: 'someone-elses-project', f1, f2, f3 });
    assert.equal(other.ok, false);
    assert.ok(other.lineageProblems.some((p) => /does not belong to this project/.test(p)));

    const wrongAudit = checkSavedChain({ projectId: 'fx-project', f1, f2, f3: { ...f3, f2AuditId: 'some-other-audit' } });
    assert.equal(wrongAudit.ok, false);
    assert.ok(wrongAudit.lineageProblems.includes('The saved strategy was not built on the saved Marketing Audit.'));

    const embedded = structuredClone(f3);
    embedded.reportJson.creativeBrief.provenance.f1ReportId = 'a-different-report';
    const e = checkSavedChain({ projectId: 'fx-project', f1, f2, f3: embedded });
    assert.equal(e.ok, false);
    assert.ok(e.lineageProblems.includes('The strategy brief refers to a different Product Discovery report than the saved one.'));
  });

  it('16. a missing report is reported as missing (not as "older format")', () => {
    const { f1, f2 } = fresh();
    const c = checkSavedChain({ projectId: 'fx-project', f1, f2, f3: null });
    assert.equal(c.ok, false);
    assert.deepEqual(c.reports.map((r) => r.status), ['current', 'current', 'missing']);
    assert.match(c.reports[2].message, /was not found among the saved results of this project/);
  });

  it('17. the registry names the supported versions of every report (explicit, not implied)', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(REPORT_CONTRACTS).map(([k, v]) => [k, v.supported])), { F1: [2], F2: [1], F3: [1] });
  });
});
