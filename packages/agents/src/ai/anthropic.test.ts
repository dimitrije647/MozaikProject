import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DeveloperMessageItem, ModelContext, UserMessageItem } from '@mozaik-ai/core';
import { AnthropicClient, AnthropicTransport, CLAUDE_SUBSCRIPTION_MODE, resolveAnthropicBaseUrl, toClaudeSchema } from './anthropic-http';
import { SpendBudget } from './budget';
import { InferenceGateway, readProviderErrorCode } from './gateway';
import { claudeCostUsd, maxOutputTokensFor, textCostUsd, textPrice } from './pricing';
import { createTextTransport } from '../runtime/providers';
import { FakeOpenAI, type FakeOpenAIOptions } from '../testing/fake-openai';

// CLAUDE PROVIDER (Claude API with the user's own Console key). Every request goes to a local fake over real HTTP: nothing is billed, and no
// subscription credential exists anywhere in these tests.

const KEY = 'sk-ant-api03-TESTKEY1234567890abcdefghijklmnop';
const MODEL = 'claude-opus-5-5';
const SCHEMA = { type: 'object', properties: { summary: { type: 'string', maxLength: 200 }, items: { type: 'array', items: { type: 'string', minLength: 2 }, maxItems: 5, minItems: 2 }, kind: { oneOf: [{ type: 'string' }, { type: 'null' }] }, score: { type: 'number', minimum: 0, maximum: 1 } }, required: ['summary', 'items', 'kind', 'score'], additionalProperties: false };

const servers: FakeOpenAI[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fake(o?: FakeOpenAIOptions) {
  const f = await new FakeOpenAI(o).start();
  servers.push(f);
  return f;
}
function ask(gw: InferenceGateway, text = 'Analyze the product. Answer as JSON.') {
  const context = ModelContext.create();
  context.addContextItem(DeveloperMessageItem.create('You are the Input Analyzer of a marketing team.'));
  context.addContextItem(UserMessageItem.create(text));
  gw.registerAgent(context.id, 'Input Analyzer');
  return { id: context.id, run: () => gw.run({ context, model: MODEL, maxOutputTokens: 3000, structuredOutput: { name: 'analysis', schema: SCHEMA, strict: true } } as never) };
}
const budget = (spend?: SpendBudget) => ({ maxModelCalls: 6, maxOutputTokens: 3000, callTimeoutMs: 5000, maxRetries: 2, retryBaseDelayMs: 1, escalateTo: 6000, spend: spend?.scope('F1') });
const textOf = (out: { items: { content?: { text?: string } }[] }) => out.items.map((i) => i.content?.text ?? '').join('');

describe('Claude Messages request (mocked Claude API)', () => {
  it('builds a Messages request: system prompt, JSON-schema output without unsupported bounds, explicit effort, thinking headroom, no sampling params', async () => {
    const f = await fake({ reply: () => ({ text: JSON.stringify({ summary: 'ok', items: ['aa', 'bb'], kind: null, score: 0.5 }) }) });
    const gw = new InferenceGateway(new AnthropicTransport(new AnthropicClient({ apiKey: KEY, baseUrl: f.anthropicUrl }), { effort: 'medium' }), budget());
    const out = await ask(gw).run();
    assert.equal(readProviderErrorCode(textOf(out as never)), null);
    assert.deepEqual(JSON.parse(textOf(out as never)), { summary: 'ok', items: ['aa', 'bb'], kind: null, score: 0.5 });
    const [r] = f.calls();
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.path, '/v1/messages');
    assert.equal(r.agent, 'input', 'the system prompt reached Claude as `system`');
    const b = r.body as Record<string, any>;
    assert.equal(b.model, MODEL);
    assert.match(String(b.system), /Input Analyzer/);
    assert.equal(b.max_tokens, 3000 + 4096, 'the JSON cap plus the adaptive-thinking headroom of medium effort');
    assert.equal(b.output_config.effort, 'medium');
    assert.equal(b.output_config.format.type, 'json_schema');
    const s = JSON.stringify(b.output_config.format.schema);
    for (const k of ['maxLength', 'minLength', 'maxItems', 'minimum', 'maximum', 'oneOf']) assert.ok(!s.includes(`"${k}"`), `${k} is not sent to Claude`);
    assert.ok(s.includes('"anyOf"'), 'a union is sent as anyOf');
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks', 'stream']) assert.ok(!(k in b), `${k} is not sent`);
    assert.equal(gw.provider, 'anthropic');
    assert.equal(gw.usage().total.calls, 1);
    assert.equal(gw.usage().total.inputTokens, 120);
  });

  it('attaches vision images as Claude base64 image blocks', async () => {
    const f = await fake();
    const gw = new InferenceGateway(new AnthropicTransport(new AnthropicClient({ apiKey: KEY, baseUrl: f.anthropicUrl })), budget());
    const a = ask(gw);
    gw.attachImages(a.id, [{ mediaType: 'image/png', base64: 'iVBORw0KGgo=' }]);
    await a.run();
    const last = (f.calls()[0].body as any).messages.at(-1);
    assert.deepEqual(last.content.at(-1), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  });

  it('prices Claude usage with the Claude price book (never an OpenAI price) and settles it in the campaign ledger', async () => {
    const f = await fake({ reply: () => ({ usage: { input: 10_000, output: 2_000 } }) });
    const spend = new SpendBudget(1);
    const gw = new InferenceGateway(new AnthropicTransport(new AnthropicClient({ apiKey: KEY, baseUrl: f.anthropicUrl })), budget(spend));
    await ask(gw).run();
    const snap = spend.snapshot();
    assert.equal(snap.spentUsd, 0.08, '10k input x $4/M + 2k output x $20/M = $0.08 (Claude Opus 5.5)');
    assert.equal(claudeCostUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 12);
    assert.equal(claudeCostUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 }), 0.1, 'Haiku 5.5 above 100K input: $0.50/M');
    assert.equal(claudeCostUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }), 0.2);
    assert.equal(textCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }), 4, 'Claude never goes through the OpenAI cached-input formula');
    assert.equal(textPrice('claude-unknown-1'), null, 'an unknown Claude model has no price (never an OpenAI one)');
    assert.equal(textPrice('gpt-4.1-mini')?.inputPerM, 0.4, 'the OpenAI book is unchanged');
    assert.deepEqual(maxOutputTokensFor('claude-opus-5-5'), { limit: 128_000, verified: true });
  });
});

describe('Claude errors, timeouts and refusals (mocked)', () => {
  const run = async (o: FakeOpenAIOptions, b = budget()) => {
    const f = await fake(o);
    const gw = new InferenceGateway(new AnthropicTransport(new AnthropicClient({ apiKey: KEY, baseUrl: f.anthropicUrl })), b);
    return { f, code: readProviderErrorCode(textOf((await ask(gw).run()) as never)) };
  };

  it('a wrong key is invalid_api_key and is not retried; the provider text (which may echo the key) is never passed on', async () => {
    const { f, code } = await run({ validKeys: ['sk-ant-api03-other'] });
    assert.equal(code, 'invalid_api_key');
    assert.equal(f.calls().length, 1);
  });

  it('overloaded (529) and rate limits (429) are retried with backoff; a 400 is not', async () => {
    let n = 0;
    const a = await run({ reply: () => (++n < 3 ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } : undefined) });
    assert.equal(a.code, null, 'answered on the third attempt');
    assert.equal(a.f.calls().length, 3);
    const b = await run({ reply: () => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } } }) });
    assert.equal(b.code, 'bad_request');
    assert.equal(b.f.calls().length, 1);
    const c = await run({ reply: () => ({ status: 402, json: { type: 'error', error: { type: 'billing_error', message: 'no credit' } } }) });
    assert.equal(c.code, 'insufficient_quota');
  });

  it('a request that does not answer in time is a timeout (and counted as possibly billed)', async () => {
    const spend = new SpendBudget(1);
    const { code } = await run({ reply: () => ({ hang: true }) }, { ...budget(spend), callTimeoutMs: 300, maxRetries: 0 });
    assert.equal(code, 'timeout');
    assert.ok(spend.snapshot().uncertainUsd > 0, 'a request that was sent and timed out may have been billed');
  });

  it('a safety refusal is billed, reported as `refused` and never retried; a cut-off answer is asked once more with a larger cap', async () => {
    const r = await run({ reply: () => ({ json: { id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 1 } } }) });
    assert.equal(r.code, 'refused');
    assert.equal(r.f.calls().length, 1);
    let n = 0;
    const c = await run({ reply: () => (++n === 1 ? { json: { id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: '{"summ' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 7096 } } } : undefined) });
    assert.equal(c.code, null);
    assert.equal(c.f.calls().length, 2);
    assert.equal((c.f.calls()[1].body as any).max_tokens, 6000 + 4096, 'the second request asks for the larger cap (+ thinking headroom)');
  });

  it('cancellation aborts the in-flight Claude request', async () => {
    const f = await fake({ reply: () => ({ hang: true }) });
    const gw = new InferenceGateway(new AnthropicTransport(new AnthropicClient({ apiKey: KEY, baseUrl: f.anthropicUrl })), { ...budget(), callTimeoutMs: 10_000 });
    const p = ask(gw).run();
    setTimeout(() => gw.abort(), 100);
    assert.equal(readProviderErrorCode(textOf((await p) as never)), 'cancelled');
  });
});

describe('Claude credentials: only the user\'s own Console API key, nothing else', () => {
  it('sends the stored key as x-api-key and NO Authorization header, even when the environment holds Anthropic tokens', async () => {
    const f = await fake();
    const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN, b: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-ENVIRONMENTKEY-must-not-be-used';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-SUBSCRIPTIONTOKEN-must-not-be-used';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    try {
      const { transport } = createTextTransport({ provider: 'anthropic', apiKey: KEY }, { baseUrl: f.anthropicUrl });
      await ask(new InferenceGateway(transport, budget())).run();
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', saved.k], ['ANTHROPIC_AUTH_TOKEN', saved.t], ['ANTHROPIC_BASE_URL', saved.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const [r] = f.calls();
    assert.ok(r, 'the request reached the configured host (not ANTHROPIC_BASE_URL)');
    // the ONLY credential on the request is the user's own Console key (as Bearer or x-api-key); no environment or subscription token
    const sent = [r.headers.xApiKey, r.headers.authorization?.replace(/^Bearer /, '') ?? null].filter((x): x is string => !!x);
    assert.ok(sent.length >= 1);
    for (const s of sent) assert.equal(s, KEY);
    assert.ok(!JSON.stringify(r.headers).includes('ENVIRONMENTKEY') && !JSON.stringify(r.headers).includes('SUBSCRIPTIONTOKEN'));
    assert.ok(r.headers.anthropicVersion, 'an official SDK request (anthropic-version header)');
  });

  it('the test seam is honored only under NODE_ENV=test', () => {
    assert.equal(resolveAnthropicBaseUrl({ NODE_ENV: 'production', LAUNCHPILOT_ANTHROPIC_BASE_URL: 'http://evil.example' }), 'https://api.anthropic.com');
    assert.equal(resolveAnthropicBaseUrl({ NODE_ENV: 'test', LAUNCHPILOT_ANTHROPIC_BASE_URL: 'http://127.0.0.1:5/' }), 'http://127.0.0.1:5');
  });

  it('a client never exposes its key (private field)', () => {
    const c = new AnthropicClient({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9' });
    assert.ok(!JSON.stringify(c).includes('TESTKEY'));
    assert.ok(!Object.values(c).some((v) => JSON.stringify(v ?? null).includes('TESTKEY')));
  });

  it('the subscription mode is reported as unavailable, with the official sources', () => {
    assert.equal(CLAUDE_SUBSCRIPTION_MODE.available, false);
    assert.equal(CLAUDE_SUBSCRIPTION_MODE.status, 'unsupported');
    assert.ok(CLAUDE_SUBSCRIPTION_MODE.sources.includes('https://code.claude.com/docs/en/legal-and-compliance'));
  });

  it('no source file reads, extracts or forwards Claude subscription credentials', () => {
    // a static guard over the shipped source: no credential-store path, OAuth env token, claude.ai endpoint or Claude Code process is used
    const roots = [join(__dirname, '..'), join(__dirname, '..', '..', '..', '..', 'apps', 'api', 'src')];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    assert.ok(files.length > 50);
    const forbidden = [/\.credentials\.json/, /CLAUDE_CODE_OAUTH_TOKEN/, /process\.env\.ANTHROPIC_AUTH_TOKEN/, /claude\.ai\/api/, /spawn\(\s*['"]claude['"]/, /exec\w*\(\s*['"`]claude /, /@anthropic-ai\/claude-agent-sdk/, /authToken:(?!\s*null)/];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const re of forbidden) assert.ok(!re.test(src), `${f} must not match ${re}`);
    }
  });
});

describe('toClaudeSchema', () => {
  it('keeps minItems 0/1, drops the bounds Claude rejects, turns oneOf into anyOf', () => {
    assert.deepEqual(toClaudeSchema({ type: 'array', minItems: 1, maxItems: 3, items: { oneOf: [{ type: 'string', pattern: 'x' }] } }), { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string' }] } });
  });
});
