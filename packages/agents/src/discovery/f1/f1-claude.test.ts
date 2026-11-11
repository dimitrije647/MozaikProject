import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MozaikCampaignRuntime, type CampaignRunResult, type ReportMeta } from '../../runtime/campaign-runtime';
import type { RecordedEvent } from '../../factory/state';
import { FakeOpenAI } from '../../testing/fake-openai';
import { buildDiscoveryInput } from '../input';
import { ProductDiscoveryReportV2 } from './schemas';

// F1 on CLAUDE: the REAL Mozaik runtime, participants, cross-checks and events, with every agent talking to the Claude Messages API (a local fake:
// nothing is billed). Proves the provider switch is end to end: same agents, same structured outputs, one provider for the whole run.

const KEY = 'sk-ant-api03-F1CLAUDE1234567890abcdefghijkl';

describe('F1 Product Discovery on Claude (real Mozaik agents)', () => {
  const servers: FakeOpenAI[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('every agent of the run uses the configured Claude model through the Messages API; structured answers validate; events are real', async () => {
    const fake = await new FakeOpenAI({ validKeys: [KEY] }).start();
    servers.push(fake);
    const events: RecordedEvent[] = [];
    const reports: { report: ProductDiscoveryReportV2; meta: ReportMeta }[] = [];
    let unhandled = 0;
    const onUnhandled = () => void unhandled++;
    process.on('unhandledRejection', onUnhandled);
    let result: CampaignRunResult;
    try {
      const handle = await new MozaikCampaignRuntime().startRun({
        runId: 'run-claude-f1',
        projectId: 'p1',
        userId: 'u1',
        mode: 'product_discovery',
        manifest: { productName: 'Bike Repair' },
        credentials: { provider: 'anthropic', apiKey: KEY },
        discovery: {
          input: buildDiscoveryInput({ project: { name: 'Bike Repair' }, intake: { productName: 'Bike Repair', shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en', websiteUrl: null, githubUrl: null }, socialProfiles: [], assets: [] }),
          model: 'claude-opus-5-5',
          baseUrl: fake.anthropicUrl,
          retryBaseDelayMs: 1,
          fixtureSources: true,
          agentTimeoutMs: 8000,
          reviewTimeoutMs: 4000,
        },
        onEvent: (e) => void events.push(e),
        onReport: async (report, meta) => void reports.push({ report, meta }),
      });
      result = await handle.done;
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(result.status, 'completed', String(result.errorMessage));
    assert.ok(ProductDiscoveryReportV2.safeParse(reports[0].report).success, 'the Claude answers became a valid report');
    const meta = reports[0].meta;
    assert.equal(meta.provider, 'anthropic');
    assert.equal(meta.model, 'claude-opus-5-5');
    // the same work as on OpenAI: 2 analyses + 2 cross-check reviews + 1 synthesis, ALL on Claude, none anywhere else
    assert.deepEqual(fake.calls().map((r) => `${r.agent}:${r.kind}`).sort(), ['input:analysis', 'input:review', 'synthesizer:synthesis', 'text:analysis', 'text:review']);
    assert.ok(fake.requests.every((r) => r.provider === 'anthropic' && r.path === '/v1/messages'), 'no request went to an OpenAI endpoint');
    assert.ok(fake.calls().every((r) => (r.body as { model?: string }).model === 'claude-opus-5-5'), 'the explicitly chosen model is honored by every agent');
    assert.ok(fake.calls().every((r) => (r.body as any).output_config?.format?.type === 'json_schema'), 'structured outputs for every agent');
    // real Mozaik coordination: the participants, the cross-check request and its answers are events of the run
    const types = new Set(events.map((e) => e.type));
    for (const t of ['phase.started', 'participant.idle']) assert.ok(types.has(t), `event ${t} was emitted`);
    assert.ok(events.length > 10);
    assert.ok(meta.usage.total.calls === 5 && meta.usage.total.inputTokens > 0);
    assert.equal(unhandled, 0);
  });
});
