import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MozaikCampaignRuntime, MAX_EVENTS_PER_RUN, type CampaignRunResult, type DiscoveryRunConfig, type ReportMeta } from '../runtime/campaign-runtime';
import type { RecordedEvent } from '../factory/state';
import { FakeOpenAI, defaultInputAnalysis, defaultReport, defaultTextAnalysis, type FakeOpenAIOptions } from '../testing/fake-openai';
import { buildDiscoveryInput } from './input';
import { ProductDiscoveryReport, toWireSchema } from './schemas';

const KEY = 'sk-test-DISCOVERYKEY1234567890abcdef';
const input = (name = 'Bike Repair') =>
  buildDiscoveryInput({
    project: { name, description: null },
    intake: { productName: name, shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en' },
    socialProfiles: [{ platform: 'instagram', url: 'https://instagram.com/bikes' }],
    assets: [{ originalName: 'logo.png', type: 'logo', mimeType: 'image/png' }],
  });

interface Outcome {
  result: CampaignRunResult;
  events: RecordedEvent[];
  reports: { report: ProductDiscoveryReport; meta: ReportMeta }[];
  runtime: MozaikCampaignRuntime;
  runId: string;
}

let unhandled = 0;
const onUnhandled = () => void unhandled++;

describe('Product Discovery (real Mozaik runtime + fake OpenAI HTTP server)', () => {
  let server: FakeOpenAI;
  const servers: FakeOpenAI[] = [];

  beforeEach(() => {
    unhandled = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const start = async (options?: FakeOpenAIOptions) => {
    const s = await new FakeOpenAI(options).start();
    servers.push(s);
    return s;
  };

  async function runDiscovery(
    srv: FakeOpenAI,
    config: Partial<DiscoveryRunConfig> = {},
    extra: { apiKey?: string; name?: string; runtime?: MozaikCampaignRuntime; onReport?: (r: ProductDiscoveryReport, m: ReportMeta) => Promise<void>; cancelAfterMs?: number } = {},
  ): Promise<Outcome> {
    const runtime = extra.runtime ?? new MozaikCampaignRuntime();
    const runId = `run-${Math.random().toString(36).slice(2)}`;
    const events: RecordedEvent[] = [];
    const reports: Outcome['reports'] = [];
    const handle = await runtime.startRun({
      runId,
      projectId: 'p1',
      userId: 'u1',
      mode: 'product_discovery',
      manifest: { productName: 'x' },
      credentials: { provider: 'openai', apiKey: extra.apiKey ?? KEY },
      discovery: { input: input(extra.name), model: 'gpt-test-mini', baseUrl: srv.url, retryBaseDelayMs: 1, ...config },
      onEvent: (e) => void events.push(e),
      onReport: extra.onReport ?? (async (report, meta) => void reports.push({ report, meta })),
    });
    if (extra.cancelAfterMs !== undefined) setTimeout(() => void handle.cancel(), extra.cancelAfterMs);
    const result = await handle.done;
    return { result, events, reports, runtime, runId };
  }

  const types = (o: Outcome) => o.events.map((e) => e.type);
  const lastIndex = (o: Outcome, t: string) => types(o).lastIndexOf(t);
  const firstIndex = (o: Outcome, t: string) => types(o).indexOf(t);
  const synthText = (srv: FakeOpenAI) => srv.callsFor('synthesizer').map((r) => r.body!.input.map((i: any) => i.content?.[0]?.text ?? '').join('\n')).join('\n');

  it('runs the full F1 pipeline through Mozaik events and saves a validated report before completing', async () => {
    server = await start({
      reply: (r) =>
        r.agent === 'input'
          ? { text: JSON.stringify({ ...defaultInputAnalysis(''), category: 'MARKER_INPUT_ANALYZER_CATEGORY' }), delayMs: 300 }
          : r.agent === 'text'
            ? { text: JSON.stringify({ ...defaultTextAnalysis(), explanation: 'MARKER_TEXT_ANALYZER_EXPLANATION' }), delayMs: 300 }
            : undefined,
    });
    const o = await runDiscovery(server);

    assert.equal(o.result.status, 'completed', String(o.result.errorMessage));
    assert.equal(o.reports.length, 1, 'report was persisted before the run completed');
    assert.ok(ProductDiscoveryReport.safeParse(o.reports[0].report).success);

    // Event choreography (all real Mozaik SemanticEvents).
    const t = types(o);
    for (const [a, b] of [
      ['factory.started', 'phase.started'],
      ['phase.started', 'task.assigned'],
      ['task.assigned', 'finding.posted'],
      ['finding.posted', 'phase.ready'],
      ['phase.ready', 'crosscheck.answered'],
      ['crosscheck.answered', 'report.generated'],
      ['report.generated', 'phase.completed'],
      ['phase.completed', 'factory.completed'],
    ]) {
      assert.ok(firstIndex(o, a) < firstIndex(o, b), `${a} before ${b}`);
    }
    assert.equal(t.filter((x) => x === 'task.assigned').length, 2);
    assert.equal(t.filter((x) => x === 'finding.posted').length, 2);
    assert.equal(t.filter((x) => x === 'report.generated').length, 1);
    assert.equal(t.at(-1), 'factory.completed');
    assert.ok(t.includes('inference.completed') && t.includes('model.answer'), 'Mozaik agent-loop events are present');
    assert.equal(o.events.find((e) => e.type === 'factory.completed')!.phase, 'F1_PRODUCT_DISCOVERY');

    // The analyzers ran concurrently (sequential would take >= 600 ms).
    const assigned = Date.parse(o.events.find((e) => e.type === 'task.assigned')!.occurredAt);
    const ready = Date.parse(o.events.find((e) => e.type === 'phase.ready')!.occurredAt);
    assert.ok(ready - assigned < 560, `analyzers should overlap, took ${ready - assigned} ms`);

    // The synthesizer consumed the ACTUAL findings of both analyzers.
    const prompt = synthText(server);
    assert.ok(prompt.includes('MARKER_INPUT_ANALYZER_CATEGORY'));
    assert.ok(prompt.includes('MARKER_TEXT_ANALYZER_EXPLANATION'));
    assert.equal(server.callsFor('input').length, 1);
    assert.equal(server.callsFor('text').length, 1);
    assert.equal(server.callsFor('synthesizer').length, 1);

    // Request hygiene: user's key, explicit model, output cap, no server-side storage, JSON schema.
    for (const r of server.requests) {
      assert.equal(r.authorization, `Bearer ${KEY}`);
      assert.equal(r.body!.model, 'gpt-test-mini');
      assert.equal(r.body!.store, false);
      assert.equal(r.body!.max_output_tokens, 3500);
      assert.equal(r.body!.text.format.type, 'json_schema');
      assert.equal(r.body!.text.format.strict, true);
    }

    // Usage is tracked from the provider's own numbers; metadata records what was analyzed.
    const meta = o.reports[0].meta;
    assert.equal(meta.usage.total.calls, 3);
    assert.equal(meta.usage.total.inputTokens, 360);
    assert.equal(meta.usage.perAgent['Input Analyzer'].calls, 1);
    assert.equal(meta.model, 'gpt-test-mini');
    assert.deepEqual(meta.inputSnapshot.availableNotAnalyzed.socialProfiles.map((s) => s.platform), ['instagram']);
    assert.equal(meta.partial, false);
    assert.equal(o.reports[0].report.language, 'en');

    // History is compact and secret-free: no prompts, no key, no raw responses.
    const history = JSON.stringify(o.events);
    assert.ok(!history.includes(KEY));
    assert.ok(!history.includes('We fix bicycles in Novi Sad'), 'prompts/user text are not copied into event history');
    const usage = o.events.find((e) => e.type === 'inference.completed')!.payload!.tokenUsage as Record<string, unknown>;
    assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.totalTokens], [120, 60, 180], 'token counts must survive redaction');
    assert.equal(unhandled, 0);
  });

  it('sends nothing to Mozaik Cloud or any host except the configured OpenAI endpoint', async () => {
    // Real @mozaik-ai/cloud-sdk (not stubbed here). If a paired ~/.mozaik/credentials.json or a
    // MOZAIK_API_KEY were honored, runLoop would send events to app.jigjoy.ai; the policy must prevent that.
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      return realFetch(url as string, init);
    }) as typeof fetch;
    const warn = console.warn;
    const log = console.log;
    console.warn = () => undefined;
    console.log = () => undefined;
    try {
      server = await start();
      const o = await runDiscovery(server);
      assert.equal(o.result.status, 'completed');
      await new Promise((r) => setTimeout(r, 1300)); // longer than the cloud client flush interval
    } finally {
      globalThis.fetch = realFetch;
      console.warn = warn;
      console.log = log;
    }
    assert.ok(urls.length >= 3, 'the model calls themselves were observed');
    assert.ok(urls.every((u) => u.startsWith(server.url)), `unexpected outbound request: ${urls.find((u) => !u.startsWith(server.url))}`);
    assert.ok(!urls.some((u) => /jigjoy|mozaik/i.test(u)));
  });

  it('detects contradictions and enforces the evidence policy between analyzers', async () => {
    server = await start({
      reply: (r) => {
        if (r.agent === 'input') {
          const a = defaultInputAnalysis('');
          a.businessType = 'software';
          a.knownFacts = [
            { id: 'a', statement: 'Has 10,000 customers', status: 'verified', sourceType: 'ai_inference', sourceReference: null, confidence: 0.9, explanation: null },
            { id: 'b', statement: 'Won an award in 2020', status: 'claimed', sourceType: 'user_input', sourceReference: 'a quote that the user never wrote', confidence: 0.5, explanation: null },
            { id: 'c', statement: 'Fixes bicycles', status: 'claimed', sourceType: 'user_input', sourceReference: 'We fix bicycles in Novi Sad', confidence: 0.9, explanation: null },
          ];
          return { text: JSON.stringify(a) };
        }
        if (r.agent === 'text') return { text: JSON.stringify({ ...defaultTextAnalysis(), businessType: 'service' }) };
        return undefined;
      },
    });
    const o = await runDiscovery(server);
    assert.equal(o.result.status, 'completed');
    const meta = o.reports[0].meta;
    const kinds = meta.crosscheckIssues.map((i) => i.type);
    assert.ok(kinds.includes('business_type_mismatch'));
    assert.ok(kinds.includes('verified_not_allowed'));
    assert.ok(kinds.includes('unverifiable_source'));

    const facts = meta.findings.input_analysis!.knownFacts;
    assert.equal(facts.find((f) => f.id === 'a')!.status, 'inferred', 'unsupported "verified" is downgraded');
    assert.equal(facts.find((f) => f.id === 'b')!.status, 'inferred', 'untraceable "claimed" is downgraded');
    assert.equal(facts.find((f) => f.id === 'c')!.status, 'claimed', 'a verbatim quote stays claimed');
    assert.ok(!synthText(server).includes('"status": "verified"'), 'the synthesizer never sees a "verified" label');

    // The mismatch reaches the final report even though the (fake) synthesizer ignored it.
    const report = o.reports[0].report;
    assert.ok(report.contradictions.some((c) => c.topic === 'Business classification'));
    assert.ok(report.evidenceAndAssumptions.some((e) => e.status === 'disputed'));
  });

  it('downgrades "verified" labels the synthesizer itself invents', async () => {
    server = await start({
      reply: (r) =>
        r.agent === 'synthesizer'
          ? { text: JSON.stringify(defaultReport({ strengths: [{ text: 'Market leader', status: 'verified', basis: 'trust me' }] })) }
          : undefined,
    });
    const o = await runDiscovery(server);
    assert.equal(o.reports[0].report.strengths[0].status, 'inferred');
    assert.ok(o.reports[0].meta.reportPolicyIssues.some((i) => i.type === 'verified_not_allowed'));
  });

  it('survives one failing analyzer: bounded retries, then a partial report', async () => {
    server = await start({ reply: (r) => (r.agent === 'text' ? { status: 500 } : undefined) });
    const o = await runDiscovery(server, { maxModelCalls: 8 });
    assert.equal(o.result.status, 'completed');
    assert.equal(server.callsFor('text').length, 3, '1 attempt + 2 bounded retries');
    const meta = o.reports[0].meta;
    assert.equal(meta.partial, true);
    assert.equal(o.reports[0].report.partial, true);
    assert.deepEqual(meta.agents.filter((a) => a.status === 'failed').map((a) => [a.name, a.error?.code]), [['Text Analyzer', 'provider_unavailable']]);
    assert.ok(synthText(server).includes('NOT AVAILABLE'));
    assert.ok(types({ events: o.events } as Outcome).includes('phase.ready'));
  });

  it('fails the run when both analyzers fail, without writing a report', async () => {
    server = await start({ reply: (r) => (r.agent !== 'synthesizer' ? { status: 400, json: { error: { code: 'bad' } } } : undefined) });
    const o = await runDiscovery(server);
    assert.equal(o.result.status, 'failed');
    assert.equal(o.reports.length, 0);
    assert.equal(server.callsFor('synthesizer').length, 0, 'no synthesis call is made without findings');
    assert.ok(types(o).includes('phase.failed'));
    assert.match(o.result.errorMessage ?? '', /rejected the request/);
  });

  it('fails (no report) when the synthesizer fails', async () => {
    server = await start({ reply: (r) => (r.agent === 'synthesizer' ? { status: 404, json: { error: { code: 'model_not_found' } } } : undefined) });
    const o = await runDiscovery(server);
    assert.equal(o.result.status, 'failed');
    assert.equal(o.reports.length, 0);
    assert.match(o.result.errorMessage ?? '', /does not exist or is not available/);
  });

  it('repairs malformed JSON once, and fails the agent if the repair is also invalid', async () => {
    server = await start({
      reply: (r) => {
        if (r.agent === 'text' && r.attempt === 1) return { text: '{"explanation": "cut off' };
        return undefined;
      },
    });
    const ok = await runDiscovery(server);
    assert.equal(ok.result.status, 'completed');
    assert.equal(server.callsFor('text').length, 2);
    const repairPrompt = JSON.stringify(server.callsFor('text')[1].body!.input);
    assert.ok(repairPrompt.includes('could not be used'));
    assert.equal(ok.reports[0].meta.partial, false);

    const bad = await start({ reply: (r) => (r.agent === 'text' ? { text: 'definitely not json' } : undefined) });
    const o = await runDiscovery(bad);
    assert.equal(bad.callsFor('text').length, 2, 'exactly one repair attempt');
    assert.equal(o.reports[0].meta.partial, true);
    assert.equal(o.reports[0].meta.agents.find((a) => a.name === 'Text Analyzer')!.error!.code, 'invalid_response');
  });

  it('maps an invalid API key to a safe error and never leaks the key (even if the provider echoes it)', async () => {
    server = await start({ validKeys: ['sk-someone-elses-key-xxxxxxxxxxxx'] });
    const o = await runDiscovery(server);
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.errorMessage ?? '', /rejected the API key/);
    const everything = JSON.stringify([o.events, o.result]);
    assert.ok(!everything.includes(KEY), 'raw key must not appear');
    assert.ok(!everything.includes('Incorrect API key provided'), 'provider message text must not be copied');
    assert.equal(server.requests.length, 2, 'both analyzers tried once; invalid keys are not retried; no synthesis');
    assert.equal(unhandled, 0, 'a provider error must never become an unhandled rejection');
  });

  it('does not retry insufficient quota, but does retry a plain rate limit', async () => {
    const quota = await start({ reply: () => ({ status: 429, json: { error: { code: 'insufficient_quota', type: 'insufficient_quota' } } }) });
    const q = await runDiscovery(quota);
    assert.equal(q.result.status, 'failed');
    assert.match(q.result.errorMessage ?? '', /no remaining quota/);
    assert.equal(quota.requests.length, 2, 'no retries for quota errors');

    const rate = await start({ reply: (r) => (r.agent === 'input' && r.attempt === 1 ? { status: 429, json: { error: { code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '0' } } : undefined) });
    const r = await runDiscovery(rate);
    assert.equal(r.result.status, 'completed');
    assert.equal(rate.callsFor('input').length, 2);
  });

  it('enforces the per-run model-call budget and never exceeds it', async () => {
    server = await start();
    const o = await runDiscovery(server, { maxModelCalls: 2 });
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.errorMessage ?? '', /limit on model calls/);
    assert.equal(server.requests.length, 2, 'the synthesizer call was blocked locally');
    assert.equal(o.reports.length, 0);
  });

  it('times out a hung agent, aborts its request and still produces a partial report', async () => {
    server = await start({ reply: (r) => (r.agent === 'text' ? { hang: true } : undefined) });
    const o = await runDiscovery(server, { agentTimeoutMs: 400 });
    assert.equal(o.result.status, 'completed');
    assert.equal(o.reports[0].meta.partial, true);
    assert.equal(o.reports[0].meta.agents.find((a) => a.name === 'Text Analyzer')!.error!.code, 'timeout');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(server.callsFor('text')[0].aborted, 'the in-flight request was aborted');
  });

  it('cancels mid-flight: aborts in-flight requests and makes no further model calls', async () => {
    server = await start({ reply: () => ({ hang: true }) });
    const o = await runDiscovery(server, {}, { cancelAfterMs: 250 });
    assert.equal(o.result.status, 'cancelled');
    assert.equal(o.reports.length, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(server.requests.length, 2);
    assert.ok(server.requests.every((r) => r.aborted), 'both in-flight requests were aborted');
    assert.equal(types(o).at(-1), 'factory.cancelled');
    assert.equal(o.runtime.activeCount, 0);
  });

  it('does not loop: a bounded event count and exactly the expected model calls', async () => {
    server = await start();
    const o = await runDiscovery(server);
    assert.ok(o.events.length < 60, `unexpectedly many events: ${o.events.length}`);
    assert.ok(o.events.length < MAX_EVENTS_PER_RUN);
    assert.equal(server.requests.length, 3);
    // Each agent produced exactly one answer.
    assert.equal(types(o).filter((x) => x === 'model.answer').length, 3);
  });

  it('keeps concurrent runs isolated: each request carries only its own run\'s key and data', async () => {
    server = await start();
    const keyA = 'sk-userA-ISOLATION-aaaaaaaaaaaaaaaa';
    const keyB = 'sk-userB-ISOLATION-bbbbbbbbbbbbbbbb';
    const runtime = new MozaikCampaignRuntime();
    const [a, b] = await Promise.all([
      runDiscovery(server, {}, { apiKey: keyA, name: 'RUN-A-PROJECT', runtime }),
      runDiscovery(server, {}, { apiKey: keyB, name: 'RUN-B-PROJECT', runtime }),
    ]);
    assert.equal(a.result.status, 'completed');
    assert.equal(b.result.status, 'completed');
    const mine = (marker: string) => server.requests.filter((r) => JSON.stringify(r.body).includes(marker));
    assert.equal(mine('RUN-A-PROJECT').length, 3);
    assert.equal(mine('RUN-B-PROJECT').length, 3);
    assert.ok(mine('RUN-A-PROJECT').every((r) => r.authorization === `Bearer ${keyA}`));
    assert.ok(mine('RUN-B-PROJECT').every((r) => r.authorization === `Bearer ${keyB}`));
    assert.ok(!JSON.stringify([a.events, b.events]).includes('ISOLATION'));
  });

  it('does not save the report (and fails the run) when the sink rejects', async () => {
    server = await start();
    const o = await runDiscovery(server, {}, { onReport: async () => { throw new Error('database unavailable'); } });
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.errorMessage ?? '', /database unavailable/);
    assert.ok(!types(o).includes('factory.completed'));
  });

  it('requires OpenAI credentials, an explicit model and a report sink', async () => {
    const runtime = new MozaikCampaignRuntime();
    const base = { runId: 'x', projectId: 'p', userId: 'u', mode: 'product_discovery' as const, manifest: { productName: 'x' } };
    const discovery = { input: input(), model: 'gpt-test-mini' };
    await assert.rejects(() => runtime.startRun({ ...base, discovery, onReport: async () => undefined }), /OpenAI credentials/);
    await assert.rejects(() => runtime.startRun({ ...base, credentials: { provider: 'gemini', apiKey: 'AIzaxxxxxxxxxxxxxxxxxxxxxxx' }, discovery, onReport: async () => undefined }), /OpenAI only/);
    await assert.rejects(() => runtime.startRun({ ...base, credentials: { provider: 'openai', apiKey: KEY }, discovery: { ...discovery, model: ' ' }, onReport: async () => undefined }), /explicit model/);
    await assert.rejects(() => runtime.startRun({ ...base, credentials: { provider: 'openai', apiKey: KEY }, discovery }), /report sink/);
    assert.equal(runtime.activeCount, 0);
  });
});

describe('Product Discovery schemas and input', () => {
  it('the default answers used by the fake server satisfy the real schemas', () => {
    assert.ok(ProductDiscoveryReport.safeParse(defaultReport()).success);
  });

  it('wire schemas fit OpenAI strict structured outputs', () => {
    const wire = toWireSchema(ProductDiscoveryReport);
    const bad: string[] = [];
    const walk = (n: any, path: string) => {
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (!n || typeof n !== 'object') return;
      for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', '$schema', 'pattern', 'default']) if (k in n) bad.push(`${path}.${k}`);
      if (n.type === 'object') {
        if (n.additionalProperties !== false) bad.push(`${path}: additionalProperties`);
        const keys = Object.keys(n.properties ?? {});
        if (JSON.stringify([...(n.required ?? [])].sort()) !== JSON.stringify(keys.sort())) bad.push(`${path}: required`);
      }
      for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    walk(wire, '$');
    assert.deepEqual(bad, []);
  });

  it('buildDiscoveryInput lists URLs/uploads as not analyzed and bounds long text', () => {
    const long = 'x'.repeat(20_000);
    const i = buildDiscoveryInput({
      project: { name: 'P', description: long },
      intake: { productName: 'P', websiteUrl: 'https://example.com', githubUrl: 'https://github.com/a/b', preferredLanguage: 'sr' },
      assets: [{ originalName: 'brochure.pdf', type: 'pdf', mimeType: 'application/pdf' }],
    });
    assert.equal(i.truncated, true);
    assert.ok((i.project.description ?? '').length <= 6000);
    assert.equal(i.availableNotAnalyzed.websiteUrl, 'https://example.com');
    assert.equal(i.availableNotAnalyzed.uploads[0].name, 'brochure.pdf');
    assert.equal(i.language, 'sr');
    assert.ok(!JSON.stringify(i).includes('apiKey'));
  });
});
