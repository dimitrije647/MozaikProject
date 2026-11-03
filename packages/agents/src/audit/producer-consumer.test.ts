import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readF2Report } from '../strategy/context';
import { makeF1 } from '../testing/chain';
import { defaultAuditReport } from '../testing/fake-audit';
import { AuditBoardStore, type AuditFinding } from './board';
import { finalizeAuditReport } from './policy';
import { AuditReportDraft, MarketingAuditReport, STORED_AUDIT_LIMITS } from './schemas';

/**
 * PRODUCER / CONSUMER CONTRACT of the F2 audit. The policy layer adds EVERY disputed finding the auditor left out to the contradictions, after
 * the draft was validated (limit 10). The stored audit must accept what the policy produces; F3 reads it back with the stored schema.
 */
const disputed = (i: number): AuditFinding => ({
  id: `A9-${i}`, agent: 'Messaging Auditor', area: 'messaging', kind: 'claim_on_source', title: `Disputed claim ${i}`, statement: `The site states outcome ${i}.`, classification: 'disputed', severity: 'medium',
  sourceType: 'ai_inference', sourceId: null, locator: null, excerpt: null, recommendation: null, confidence: 0.5, crosscheck: { status: 'disputed', reviewers: ['Presence Auditor'] }, adjustment: null, at: '2026-06-15T00:00:00Z',
});

function finish(disputes: number) {
  const board = new AuditBoardStore();
  for (let i = 1; i <= disputes; i++) board.findings.push(disputed(i));
  const draft = AuditReportDraft.parse(
    defaultAuditReport('', { contradictions: Array.from({ length: 10 }, (_, i) => ({ topic: `Draft contradiction ${i + 1}`, detail: 'Two agents disagree.', findingIds: [`A9-${i + 1}`], status: 'open' as const })) }),
  );
  const f1 = makeF1();
  return finalizeAuditReport(draft, board, { f1, facts: { site: null, siteError: null, pagespeed: null, social: [], presence: null }, partial: false, websiteUrl: null, fixtureSources: false });
}

describe('Producer/consumer contract of the F2 audit report', () => {
  it('1. an audit with more disputed findings than the draft allows is still accepted by the reader F3 uses (the draft\'s 10 are kept, the rest are appended)', () => {
    const { report, issues } = finish(25);
    assert.equal(report.contradictions.length, 25);
    assert.deepEqual(report.contradictions.slice(0, 10).map((c) => c.topic), Array.from({ length: 10 }, (_, i) => `Draft contradiction ${i + 1}`));
    assert.equal(issues.filter((i) => i.type === 'list_capped').length, 0, 'nothing needed cutting');
    const parsed = MarketingAuditReport.safeParse(report);
    assert.ok(parsed.success, parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const read = readF2Report({ id: 'a1', f1ReportId: 'f1', schemaVersion: report.schemaVersion, reportJson: JSON.parse(JSON.stringify(report)), metadataJson: {}, createdAt: new Date('2026-06-15T00:00:00Z') });
    assert.ok(read.ok);
  });

  it('2. beyond the stored limit the list is cut ONCE, visibly: the issue says how many were left out', () => {
    const { report, issues } = finish(60);
    assert.equal(report.contradictions.length, STORED_AUDIT_LIMITS.contradictions);
    const cut = issues.filter((i) => i.type === 'list_capped');
    assert.equal(cut.length, 1);
    assert.match(cut[0].detail, /^20 further contradiction\(s\) are not listed/);
    assert.ok(MarketingAuditReport.safeParse(report).success);
  });

  it('3. the model\'s own draft is still limited to 10 contradictions', () => {
    const eleven = defaultAuditReport('', { contradictions: Array.from({ length: 11 }, (_, i) => ({ topic: `t${i}`, detail: 'd', findingIds: [], status: 'open' as const })) });
    assert.equal(AuditReportDraft.safeParse(eleven).success, false);
  });
});
