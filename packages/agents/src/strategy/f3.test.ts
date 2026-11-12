import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MozaikCampaignRuntime, type CampaignRunResult } from '../runtime/campaign-runtime';
import type { StrategyReportMeta, StrategyRunConfig } from '../runtime/programs/f3-program';
import type { RecordedEvent } from '../factory/state';
import { SourceStore } from '../discovery/f1/board';
import { FakeOpenAI } from '../testing/fake-openai';
import { FakeNager, FakeTavily, FakeWebsite, htmlPage } from '../testing/fake-services';
import { makeF1 } from '../testing/chain';
import { HolidayTool } from '../tools/holidays';
import { TavilySearch } from '../tools/web-search';
import { WebFetchTool } from '../tools/web-fetch';
import { CAMPAIGN_SOCIAL_CHANNELS } from './channels';
import type { StrategyInput } from './context';
import { validateStrategyFinding } from './policy';
import type { CampaignStrategyReport, LlmStrategyFinding } from './schemas';

// V4 F3 Strategy end to end: ONE Mozaik agent (the Marketing Strategist) and the deterministic Strategy Coordinator, no Marketing Audit.
// Only the outside world is faked (the model API, competitor websites, Tavily, the holiday API). Nothing is billed.

const KEY = 'sk-test-F3RUNKEY1234567890abcdefghij';
const NOW = new Date('2026-06-15T00:00:00Z');

describe('F3 Strategy (V4: one Marketing Strategist, no F2 audit)', () => {
  const servers: { close(): Promise<void> }[] = [];
  let openai: FakeOpenAI;
  let site: FakeWebsite;
  let tav: FakeTavily;
  let nager: FakeNager;
  const track = async <T extends { close(): Promise<void> }>(s: Promise<T>) => {
    const v = await s;
    servers.push(v);
    return v;
  };

  beforeEach(async () => {
    openai = await track(new FakeOpenAI().start());
    site = await track(new FakeWebsite().start());
    tav = await track(new FakeTavily().start());
    nager = await track(new FakeNager().start());
    nager.holidays = [{ date: '2026-06-28', name: 'Vidovdan', localName: 'Vidovdan' }];
    site.page('/rival-a', htmlPage({ title: 'Rival Dive Centre', description: 'Premium diving courses on the coast', paragraphs: ['Premium diving courses for every level.'] }));
    tav.results = [{ title: 'Rival Dive Centre', url: `${site.origin}/rival-a`, content: 'Premium diving courses.', score: 0.9 }];
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const input = (o: Partial<StrategyInput> = {}): StrategyInput => ({
    projectName: 'Deep Diving School',
    language: 'en',
    geography: ['Serbia', 'Novi Sad'],
    targetAudience: 'Beginners',
    marketingGoal: 'More course sign-ups',
    campaignDuration: '3 months',
    budgetNote: null,
    websiteUrl: null,
    socialProfiles: [],
    competitorUrls: [],
    competitorNames: [],
    useHolidayCalendar: true,
    ...o,
  });

  async function run(cfg: Partial<StrategyRunConfig> = {}) {
    const events: RecordedEvent[] = [];
    const strategies: { report: CampaignStrategyReport; meta: StrategyReportMeta }[] = [];
    const handle = await new MozaikCampaignRuntime().startRun({
      runId: `run-${Math.random().toString(36).slice(2)}`,
      projectId: 'p1',
      userId: 'u1',
      mode: 'market_strategy',
      manifest: { productName: 'x' },
      credentials: { provider: 'openai', apiKey: KEY },
      strategy: {
        f1: makeF1(),
        input: input(),
        model: 'gpt-test-mini',
        baseUrl: openai.url,
        retryBaseDelayMs: 1,
        fixtureSources: true,
        now: NOW,
        agentTimeoutMs: 8000,
        tools: { web: new WebFetchTool({ policy: { allowedPorts: new Set([Number(new URL(site.origin).port)]), allowLoopbackForTests: true }, timeoutMs: 2000, maxPages: 30 }), search: new TavilySearch({ apiKey: 'tvly-test-F3-KEY-1234567890', baseUrl: tav.origin }), holidays: new HolidayTool({ baseUrl: nager.origin }) },
        ...cfg,
      },
      onEvent: (e) => void events.push(e),
      onStrategy: async (report, meta) => void strategies.push({ report, meta }),
    });
    const result: CampaignRunResult = await handle.done;
    return { result, events, strategies };
  }

  it('one agent, two model calls (research, strategy), the five social platforms evaluated, no audit anywhere', async () => {
    const o = await run();
    assert.equal(o.result.status, 'completed', String(o.result.errorMessage));
    assert.equal(openai.calls('strategist', 'analysis').length, 1);
    assert.equal(openai.calls('strategist', 'synthesis').length, 1);
    assert.equal(openai.calls().length, 2, 'no scouts, no cross-checks, no audit');
    const { report, meta } = o.strategies[0];
    assert.deepEqual(meta.participants.map((p) => p.agent), ['Marketing Strategist']);
    assert.equal(meta.f2, null);
    assert.deepEqual(meta.scoutDecisions, []);
    assert.deepEqual(meta.crosschecks, []);
    assert.equal(report.existingMarketing, null);
    assert.equal(report.creativeBrief.provenance.f2AuditId, null);
    assert.deepEqual(report.channelEvaluation.evaluated.map((e) => e.evaluation.channel).sort(), [...CAMPAIGN_SOCIAL_CHANNELS].sort());
    assert.ok(report.channels.every((c) => (CAMPAIGN_SOCIAL_CHANNELS as readonly string[]).includes(c.channel)));
    assert.ok(report.competitorLandscape.sitesRead.length >= 1, 'the competitor page was read by the deterministic gathering');
    assert.ok(report.seasonalOpportunities.holidayCalendar.used);
    const research = openai.calls('strategist', 'analysis')[0].lastUserText;
    assert.match(research, /More course sign-ups/, 'the objective the user configured reaches the model');
    assert.match(research, /Beginners/, 'the target audience the user configured reaches the model');
    assert.doesNotMatch(research, /f2_context|Marketing Audit|SEO/);
  });

  it('a channel outside the five campaign platforms cannot be recommended', () => {
    const issues: never[] = [];
    const f: LlmStrategyFinding = { kind: 'assessment', title: 'YouTube fit', statement: 'YouTube may fit.', classification: 'inferred', importance: 'low', sourceType: 'ai_inference', sourceId: null, locator: null, excerpt: null, reasoning: 'r', confidence: null, recommendation: null, segment: null, competitor: null, opportunity: null, channel: { channel: 'youtube', fit: 'strong', audienceFit: 'a', organicSuitability: 'high', paidSuitability: 'unknown', contentTypes: [], complexity: 'low', constraints: [], measurement: [], risks: [], role: 'primary' } };
    const v = validateStrategyFinding(f, 'Marketing Strategist', { store: new SourceStore(), f1: makeF1(), now: NOW, issues });
    assert.equal(v.area, 'channel');
    assert.ok((issues as { type: string }[]).some((i) => i.type === 'detail_mismatch'));
  });
});
