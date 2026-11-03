import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conformanceIssues } from '../contracts/report-contract';
import { readF3Report } from '../creative/context';
import { SourceStore } from '../discovery/f1/board';
import { defaultStrategyDraft } from '../testing/fake-strategy';
import { makeF1, makeF2 } from '../testing/chain';
import { StrategyBoardStore, type StrategyFinding } from './board';
import { CHANNELS } from './channels';
import { finalizeStrategy, type StrategyPolicyIssue } from './policy';
import { CampaignStrategyReport, STORED_LIMITS, StrategyDraft, type StrategyDraft as Draft } from './schemas';

/**
 * PRODUCER / CONSUMER CONTRACT. F3's policy layer ADDS to the strategist's draft (audit claims, the scout's finding, disputed findings) after the
 * draft was validated. These tests build the WORST CASE of every such addition and require that what the producer finishes is exactly what the
 * consumer (F4's reader) accepts. This is the test that did not exist when F3 stored 9 claims and F4's schema allowed 8.
 */
const NOW = new Date('2026-06-15T00:00:00Z');

const finding = (id: string, over: Partial<StrategyFinding> = {}): StrategyFinding => ({
  id, agent: 'Audience Analyst', area: 'audience', channel: null, kind: 'observation', title: `Finding ${id}`, statement: `Statement of ${id}`, classification: 'inferred', importance: 'medium',
  sourceType: 'ai_inference', sourceId: null, locator: null, excerpt: null, reasoning: 'Because.', confidence: 0.5, recommendation: null, segment: null, competitor: null, channelEval: null, opportunity: null,
  crosscheck: { status: 'not_requested', reviewers: [] }, adjustment: null, at: '2026-06-15T00:00:00Z', ...over,
});

const evalFor = (channel: (typeof CHANNELS)[number]['id']) => ({ channel, fit: 'strong' as const, audienceFit: 'Good', organicSuitability: 'high' as const, paidSuitability: 'medium' as const, contentTypes: ['Post'], complexity: 'low' as const, constraints: [], measurement: ['Clicks'], risks: [], role: 'primary' as const });

/** The largest input the policy layer can face: every list the policy appends to is filled by the strategist to its draft limit, then extended. */
function worstCase() {
  const f1 = makeF1();
  const base = makeF2(f1.reportId);
  const f2 = { ...base, findings: Array.from({ length: 15 }, (_, i) => ({ id: `A11-${i + 1}`, agent: 'Messaging Auditor', area: 'messaging', kind: 'claim_on_source', title: `Flagged claim ${i + 1}`, statement: `The website claims outcome number ${i + 1} without evidence.`, classification: 'claimed', severity: 'high', locator: 'home', excerpt: `claim ${i + 1}`, recommendation: 'Publish evidence.' })) };

  const board = new StrategyBoardStore();
  const known: string[] = Array.from({ length: 8 }, (_, i) => `A12-${i + 1}`);
  for (const id of known) board.findings.push(finding(id));
  const six = CHANNELS.slice(0, 6);
  six.forEach((c) => board.findings.push(finding(`A16-${c.short}-1`, { agent: `${c.name} Scout`, area: 'channel', channel: c.id, channelEval: evalFor(c.id) })));
  for (let i = 1; i <= 60; i++) board.findings.push(finding(`A14-${i}`, { classification: 'disputed' }));

  const draft: Draft = StrategyDraft.parse(
    defaultStrategyDraft('', {
      channels: six.map((c, i) => ({ channel: c.id, role: i === 0 ? ('primary' as const) : ('secondary' as const), approach: 'organic' as const, rationale: 'Recommended.', formats: ['Post'], findingIds: known })),
      disagreements: Array.from({ length: 6 }, (_, i) => ({ topic: `Topic ${i}`, positions: ['a', 'b'], resolution: 'Open', resolved: false, findingIds: [`A14-${i + 1}`] })),
      creativeBrief: { ...defaultStrategyDraft('').creativeBrief, claimsToAvoid: Array.from({ length: 8 }, (_, i) => ({ claim: `Strategist claim ${i + 1} that must not be made`, reason: 'No evidence.' })), channels: six.slice(0, 5).map((c) => ({ channel: c.id, formats: ['Post'], notes: 'n' })) },
    }),
  );
  return { f1, f2, board, draft };
}

function finish(w: ReturnType<typeof worstCase>) {
  const issues: StrategyPolicyIssue[] = [];
  const out = finalizeStrategy(w.draft, w.board, { store: new SourceStore(), f1: w.f1, f2: w.f2, now: NOW, issues }, {
    f1: w.f1, f2: w.f2, input: { projectName: 'X', language: 'en', geography: [], targetAudience: null, marketingGoal: null, campaignDuration: null, budgetNote: null, websiteUrl: null, socialProfiles: [], competitorUrls: [], competitorNames: [], useHolidayCalendar: false },
    facts: { competitors: null, holidays: null }, now: NOW, partial: false, fixtureSources: false, runId: 'run-1', searchProvider: 'none', searchConfigured: false,
  });
  return { ...out, issues: [...issues, ...out.issues] };
}

describe('Producer/consumer contract of the F3 strategy report', () => {
  it('1. the worst case the policy layer can produce is always accepted by the reader F4 uses', () => {
    const { report } = finish(worstCase());
    const parsed = CampaignStrategyReport.safeParse(report);
    assert.ok(parsed.success, parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const asRow = { id: 's1', f1ReportId: 'f1', f2AuditId: 'f2', schemaVersion: report.schemaVersion, reportJson: JSON.parse(JSON.stringify(report)), metadataJson: {}, createdAt: NOW };
    const read = readF3Report(asRow);
    assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.failure.issues));
  });

  it('2. each list the policy extends reaches the stored limit and no further', () => {
    const { report } = finish(worstCase());
    assert.equal(report.creativeBrief.claimsToAvoid.length, STORED_LIMITS.claimsToAvoid, 'the strategist\'s 8 first, then audit-flagged claims up to the limit');
    assert.deepEqual(report.creativeBrief.claimsToAvoid.slice(0, 8).map((c) => c.claim), Array.from({ length: 8 }, (_, i) => `Strategist claim ${i + 1} that must not be made`), 'the strategist\'s own claims are never displaced by audit claims');
    assert.ok(report.channels.every((c) => c.findingIds.length === STORED_LIMITS.channelFindingIds), 'the scout finding is added to a channel that already cites 8 findings');
    assert.equal(report.disagreements.length, STORED_LIMITS.disagreements);
    assert.ok(report.disagreements.slice(0, 6).every((d, i) => d.topic === `Topic ${i}`), 'the strategist\'s own disagreements come first');
  });

  it('3. nothing is cut silently: every cut is recorded as a policy issue that says how many entries were left out', () => {
    const { issues } = finish(worstCase());
    const capped = issues.filter((i) => i.type === 'list_capped').map((i) => i.detail);
    assert.equal(capped.length, 2);
    assert.match(capped.find((d) => /claim\(s\) to avoid/.test(d))!, /^11 claim\(s\) to avoid are not listed/); // 8 + 15 = 23 candidates, 12 listed
    assert.match(capped.find((d) => /disagreement/.test(d))!, /^10 further disagreement\(s\) are not listed/); // the draft's 6 cover 6 of the 60 disputed findings: 6 + 54 = 60 candidates, 50 listed
  });

  it('4. the boundary check of the producer (the one F3 runs before it saves) is silent on the worst case and names the exact field when a report does not conform', () => {
    const { report } = finish(worstCase());
    assert.deepEqual(conformanceIssues(CampaignStrategyReport, report), []);
    const broken = JSON.parse(JSON.stringify(report));
    broken.creativeBrief.claimsToAvoid.push({ claim: 'one too many', reason: 'r' });
    assert.deepEqual(conformanceIssues(CampaignStrategyReport, broken).map((i) => [i.path, i.problem, i.actual, i.limit]), [['creativeBrief.claimsToAvoid', 'too_many', 13, 12]]);
  });

  it('5. the draft the MODEL writes is still held to the stricter limits (the stored limits do not loosen what the strategist may output)', () => {
    const tooMany = defaultStrategyDraft('', { creativeBrief: { ...defaultStrategyDraft('').creativeBrief, claimsToAvoid: Array.from({ length: 9 }, (_, i) => ({ claim: `c${i}`, reason: 'r' })) } });
    assert.equal(StrategyDraft.safeParse(tooMany).success, false);
    const nine = defaultStrategyDraft('', { channels: [{ channel: 'instagram', role: 'primary', approach: 'organic', rationale: 'r', formats: [], findingIds: Array.from({ length: 9 }, (_, i) => `A${i}`) }] });
    assert.equal(StrategyDraft.safeParse(nine).success, false);
    const sevenDisputes = defaultStrategyDraft('', { disagreements: Array.from({ length: 7 }, (_, i) => ({ topic: `t${i}`, positions: ['a'], resolution: 'r', resolved: false, findingIds: [] })) });
    assert.equal(StrategyDraft.safeParse(sevenDisputes).success, false);
  });

  it('6. a report one entry over a stored limit is rejected, and precisely (the schema is not simply loosened)', () => {
    const { report } = finish(worstCase());
    const over = JSON.parse(JSON.stringify(report));
    over.creativeBrief.claimsToAvoid.push({ claim: 'one too many', reason: 'r' });
    over.channels[0].findingIds.push('A99-1');
    const r = CampaignStrategyReport.safeParse(over);
    assert.equal(r.success, false);
    if (!r.success) assert.deepEqual(r.error.issues.map((i) => i.path.join('.')).sort(), ['channels.0.findingIds', 'creativeBrief.claimsToAvoid']);
  });
});
