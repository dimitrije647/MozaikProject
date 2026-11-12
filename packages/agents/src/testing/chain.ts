import assert from 'node:assert/strict';
import { buildF1Context, type F1Context } from '../audit/context';
import { buildF3Context, type F3Context } from '../creative/context';
import { MozaikCampaignRuntime } from '../runtime/campaign-runtime';
import type { StrategyInput } from '../strategy/context';
import type { CampaignStrategyReport } from '../strategy/schemas';
import { FakeOpenAI, defaultReportV2 } from './fake-openai';

/**
 * A completed F1 -> F3 chain for the F4 tests. F1 and F2 are stored-report fixtures; F3 is produced by running the REAL
 * F3 program on the real Mozaik runtime against the fake OpenAI server (no network, nothing billed). FIXTURE data only.
 */
export const CHAIN_KEY = 'sk-test-CHAINKEY1234567890abcdefghij';
export const NOW = new Date('2026-06-15T00:00:00Z');

export function makeF1(o: { kind?: 'consumer' | 'b2b'; name?: string; palette?: string[]; id?: string } = {}): F1Context {
  const b2b = o.kind === 'b2b';
  const r = defaultReportV2(`"name": "${o.name ?? (b2b ? 'TaskFlow' : 'Deep Diving School')}"`);
  r.productManifest.businessType = b2b ? 'software' : 'education';
  r.productManifest.category = b2b ? 'Task management software' : 'Scuba diving school';
  r.identity.businessType = r.productManifest.businessType;
  r.productManifest.geography = b2b ? ['Europe'] : ['Serbia', 'Novi Sad'];
  r.productManifest.targetCustomers = b2b ? ['Small companies with remote teams'] : ['Beginners who want to learn diving'];
  r.productManifest.valueProposition = b2b ? 'Plan work together in one place' : 'Learn to dive safely with certified instructors';
  r.productManifest.offering = { summary: b2b ? 'A web app for task planning' : 'Scuba courses for beginners', items: ['Main offer'] };
  if (o.palette) r.productManifest.brand = { style: 'Calm', palette: o.palette, notes: null };
  const ctx = buildF1Context({ id: o.id ?? 'f1-report-1', schemaVersion: 2, reportJson: r, metadataJson: { generatedAt: '2026-06-01T00:00:00Z', model: 'gpt-test-mini', findings: [{ id: 'A1-1', agent: 'Input Analyzer', category: 'offering', statement: 'The user describes the main offering.', classification: 'claimed', locator: 'intake.shortDescription', excerpt: null, sourceId: null }], sources: [] } });
  assert.ok(ctx);
  return ctx;
}

export interface Chain {
  f1: F1Context;
  f3: F3Context;
  report: CampaignStrategyReport;
}

export async function buildChain(o: { kind?: 'consumer' | 'b2b'; palette?: string[]; name?: string } = {}): Promise<Chain> {
  const f1 = makeF1({ ...o, id: 'f1-report-1' });
  const fake = await new FakeOpenAI().start();
  const runtime = new MozaikCampaignRuntime();
  const input: StrategyInput = { projectName: o.name ?? 'Deep Diving School', language: 'en', geography: ['Serbia', 'Novi Sad'], targetAudience: 'Beginners', marketingGoal: 'More course sign-ups', campaignDuration: '3 months', budgetNote: null, websiteUrl: null, socialProfiles: [{ platform: 'instagram', url: 'https://instagram.com/dds' }], competitorUrls: [],
      competitorNames: [], useHolidayCalendar: false };
  let captured: CampaignStrategyReport | null = null;
  try {
    const handle = await runtime.startRun({
      runId: 'chain-f3-run',
      projectId: 'chain-project',
      userId: 'chain-user',
      mode: 'market_strategy',
      manifest: { productName: input.projectName },
      credentials: { provider: 'openai', apiKey: CHAIN_KEY },
      strategy: { f1, input, model: 'gpt-test-mini', baseUrl: fake.url, fixtureSources: true, now: NOW, maxModelCalls: 6 },
      onStrategy: async (report) => void (captured = report),
    });
    const result = await handle.done;
    assert.equal(result.status, 'completed', result.errorMessage ?? '');
  } finally {
    await fake.close();
  }
  assert.ok(captured);
  const f3 = buildF3Context({ id: 'f3-strategy-1', f1ReportId: f1.reportId, f2AuditId: null, schemaVersion: 1, reportJson: captured, metadataJson: { generatedAt: NOW.toISOString(), model: 'gpt-test-mini' }, createdAt: NOW });
  assert.ok(f3, 'the F3 report must be valid for F4');
  return { f1, f3, report: captured };
}
