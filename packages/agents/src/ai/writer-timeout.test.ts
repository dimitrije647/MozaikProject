import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ModelContext, UserMessageItem } from '@mozaik-ai/core';
import { SpendBudget } from './budget';
import { InferenceGateway, readProviderErrorCode } from './gateway';
import { OpenAIClient } from './openai-http';
import { capOutputTokens } from './pricing';
import { generationTimeoutMs, synthesisTaskTimeoutMs, writerOutputCap, writerOutputEstimate } from './timeouts';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '../testing/fake-openai';

// INCIDENT 2026-11-14 (Giardino, gpt-6.1-sol, read from the saved events and the budget ledger): the Content Writer's first answer reached its
// 8,000-token cap and was cut off (billed, unusable JSON); the gateway asked once more with 16,000 tokens, and that request ran into the FIXED
// 90 s clock (F4, unlike F1 and F3, had no clock that grows with the answer). Earlier writer answers on that model: 6,043-7,408 tokens in 71-75 s.
// Fake OpenAI over real HTTP, test-sized clocks (no test waits 90 s). Nothing is billed.

const KEY = 'sk-test-WRITERTIME1234567890abcdefgh';
const MODEL = 'gpt-6.1-sol';

describe('the Content Writer gets room for the answer it has to write', () => {
  it('3 concepts x 5 platforms: the estimate sits above every measured answer, and the first cap leaves a margin (12,000 instead of 8,000)', () => {
    const big = { concepts: 3, platforms: 5, tiktok: true, leadConcepts: 2 };
    assert.ok(writerOutputEstimate(big) > 7408, 'above the largest answer measured for this size');
    assert.equal(writerOutputCap(big, 8000, 16000), 12000);
    assert.equal(capOutputTokens(MODEL, writerOutputCap(big, 8000, 16000)).tokens, 12000, 'the model supports it');
    // small campaigns keep the configured floor; huge ones stop at the ceiling
    assert.equal(writerOutputCap({ concepts: 1, platforms: 2, tiktok: false, leadConcepts: 1 }, 8000, 16000), 8000);
    assert.equal(writerOutputCap({ concepts: 5, platforms: 5, tiktok: true, leadConcepts: 2 }, 8000, 16000), 16000);
    // a smaller model never gets more than it supports
    assert.ok(capOutputTokens('gpt-4o-mini', 20000).tokens <= 16384);
  });

  it('its clock follows its cap and stays bounded: 12,000 tokens = 320 s, a cut-off re-ask at 16,000 = 420 s, never above 600 s per request', () => {
    assert.equal(generationTimeoutMs(12000), 320_000);
    assert.equal(generationTimeoutMs(16000), 420_000);
    assert.equal(synthesisTaskTimeoutMs(12000, 16000), 740_000);
    assert.equal(generationTimeoutMs(100_000), 600_000);
  });
});

describe('InferenceGateway: a cut-off answer, a larger re-ask and its clock', () => {
  const servers: FakeOpenAI[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  const incomplete = (outputTokens: number) => ({ json: { id: 'resp_cut', object: 'response', created_at: 1, model: MODEL, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{"summary":"the copy of', annotations: [] }] }], usage: { input_tokens: 6200, input_tokens_details: { cached_tokens: 0 }, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 6200 + outputTokens } } });
  async function setup(o: { reply: FakeOpenAIOptions['reply']; callTimeoutMs: number; generation?: { tokensPerSecond: number; overheadMs: number; maxMs: number }; cap?: number }) {
    const fake = await new FakeOpenAI({ reply: o.reply }).start();
    servers.push(fake);
    const spend = new SpendBudget(3);
    const gw = new InferenceGateway(new OpenAIClient({ apiKey: KEY, baseUrl: fake.url }), { maxModelCalls: 8, maxOutputTokens: o.cap ?? 8000, callTimeoutMs: o.callTimeoutMs, maxRetries: 2, retryBaseDelayMs: 1, generation: o.generation, escalateTo: 16000, spend: spend.scope('F4') });
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create('Write the campaign copy as JSON.'));
    gw.registerAgent(context.id, 'Content Writer');
    gw.setLongAnswer(context.id, true);
    const run = () => gw.run({ context, model: MODEL, maxOutputTokens: o.cap ?? 8000 } as never);
    return { fake, spend, gw, id: context.id, run };
  }
  const code = (out: Awaited<ReturnType<InferenceGateway['run']>>) => {
    const item = out.items.find((i) => i.type === 'message') as unknown as { text?: string; content?: { text?: string } } | undefined;
    return readProviderErrorCode(item?.content?.text ?? item?.text ?? '');
  };
  const nth = (n: number, a: FakeReplyFn, b: FakeReplyFn) => (req: FakeRequest) => (req.attempt === n ? a(req) : b(req));
  type FakeReplyFn = (req: FakeRequest) => ReturnType<NonNullable<FakeOpenAIOptions['reply']>>;

  it('REPRODUCTION of Giardino: cut off at 8,000 (billed), asked again with 16,000, which then times out on a FIXED clock; the note says all of it', async () => {
    const t = await setup({ callTimeoutMs: 400, reply: nth(1, () => incomplete(8000), () => ({ delayMs: 1200 })) });
    const out = await t.run();
    assert.equal(code(out), 'timeout');
    assert.equal(t.fake.requests.length, 2, 'the cut-off answer was asked again ONCE, the timed-out request was never repeated');
    assert.equal(t.fake.requests[1].body?.max_output_tokens, 16000);
    const s = t.spend.snapshot();
    assert.ok(s.knownUsd > 0.08 && s.knownUsd < 0.1, `the cut-off answer is KNOWN spend (${s.knownUsd})`);
    assert.ok(s.uncertainUsd > 0.16, `the timed-out request stays counted as UNCERTAIN spend at its worst case (${s.uncertainUsd})`);
    assert.equal(s.reservedUsd, 0);
    assert.ok(Math.abs(s.committedUsd - (s.knownUsd + s.uncertainUsd)) < 1e-9, 'counted once: committed = known + uncertain');
    const note = t.gw.failureDetail(t.id, 'timeout')!;
    assert.match(note, /No answer arrived within 0\.4 s \(the answer could be up to 16000 tokens long\)/);
    assert.match(note, /an answer reached its 8000-token limit and was cut off \(8000 output tokens, billed\)/);
  });

  it('REPAIRED: with a clock that follows the cap, the same slow re-ask is accepted', async () => {
    const t = await setup({ callTimeoutMs: 400, generation: { tokensPerSecond: 16000, overheadMs: 800, maxMs: 600_000 }, reply: nth(1, () => incomplete(8000), () => ({ delayMs: 1200 })) });
    assert.equal(code(await t.run()), null);
    assert.equal(t.fake.requests.length, 2);
  });

  it('an answer arriving JUST BEFORE its clock ends is accepted; one arriving after it is a timeout (and never resent)', async () => {
    // cap 8,000 at 8,000 tokens/s = 1 s + 0.5 s overhead = a 1.5 s clock
    const g = { tokensPerSecond: 8000, overheadMs: 500, maxMs: 600_000 };
    const early = await setup({ callTimeoutMs: 100, generation: g, reply: () => ({ delayMs: 1100 }) });
    assert.equal(code(await early.run()), null);
    const late = await setup({ callTimeoutMs: 100, generation: g, reply: () => ({ delayMs: 2200 }) });
    assert.equal(code(await late.run()), 'timeout');
    assert.equal(late.fake.requests.length, 1);
    assert.ok(late.spend.snapshot().uncertainUsd > 0);
  });

  it('a cancelled request is reported as cancelled (not as a timeout), never resent, and its spend stays uncertain', async () => {
    const t = await setup({ callTimeoutMs: 5000, reply: () => ({ delayMs: 2000 }) });
    const pending = t.run();
    await new Promise((r) => setTimeout(r, 200));
    t.gw.abort();
    assert.equal(code(await pending), 'cancelled');
    assert.equal(t.fake.requests.length, 1);
    assert.ok(t.spend.snapshot().uncertainUsd > 0, 'cancelling the client does not prove the provider billed nothing');
    assert.equal(t.gw.failureDetail(t.id, 'cancelled'), undefined, 'no timeout story for a cancel');
  });

  it('a provider rejection (HTTP 429/400) is not a timeout: it bills nothing and is reported with its own code', async () => {
    const t = await setup({ callTimeoutMs: 5000, reply: () => ({ status: 400, json: { error: { message: 'bad', type: 'invalid_request_error' } } }) });
    assert.equal(code(await t.run()), 'bad_request');
    const s = t.spend.snapshot();
    assert.equal(s.uncertainUsd, 0);
    assert.equal(s.knownUsd, 0);
  });
});
