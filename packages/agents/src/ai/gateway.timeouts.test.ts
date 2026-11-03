import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ModelContext, UserMessageItem } from '@mozaik-ai/core';
import { SpendBudget } from './budget';
import { InferenceGateway, readProviderErrorCode } from './gateway';
import { OpenAIClient } from './openai-http';
import { DEFAULT_GENERATION_TIMEOUT, generationTimeoutMs, resolveGeneration, synthesisTaskTimeoutMs } from './timeouts';
import { FakeOpenAI, type FakeOpenAIOptions } from '../testing/fake-openai';

// INCIDENT 2026-11-02 (a real Hybrid Production run): the F3 Campaign Strategist (output cap 8,000 tokens) was still writing when the fixed 90 s
// per-request clock ran out; the phase failed after 17 paid calls although every researcher had succeeded. These tests pin the repaired behavior
// with a fake OpenAI over real HTTP. Nothing is billed.

const KEY = 'sk-test-TIMEOUTS1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';

describe('the clock of a request that writes a long structured answer', () => {
  it('grows with the tokens it may produce, at a speed slower than anything measured, and never exceeds its maximum', () => {
    assert.equal(DEFAULT_GENERATION_TIMEOUT.tokensPerSecond, 40); // measured: 53 to 70 tokens/s in the failed run, up to 93 earlier
    assert.equal(generationTimeoutMs(8000), 220_000); // 8,000 tokens at 40/s = 200 s + 20 s before the first token (the old fixed limit was 90 s)
    assert.equal(generationTimeoutMs(2500), 83_000); // 63 s + 20 s
    assert.equal(generationTimeoutMs(1_000_000), 600_000);
    // a synthesis task: the first attempt plus the one larger re-ask that follows an answer that was cut off by its cap
    assert.equal(synthesisTaskTimeoutMs(8000, 16000), 220_000 + 420_000);
    assert.equal(synthesisTaskTimeoutMs(8000, undefined), 220_000);
    assert.equal(synthesisTaskTimeoutMs(8000, 8000), 220_000, 'nothing to escalate to');
  });

  it('it scales unless the caller fixed the per-request limit; an explicit setting always wins', () => {
    assert.deepEqual(resolveGeneration(undefined, false), DEFAULT_GENERATION_TIMEOUT);
    assert.equal(resolveGeneration(undefined, true), undefined, 'a fixed callTimeoutMs is respected as it is');
    assert.deepEqual(resolveGeneration({ tokensPerSecond: 10 }, true), { ...DEFAULT_GENERATION_TIMEOUT, tokensPerSecond: 10 });
  });
});

describe('InferenceGateway: per-request clock', () => {
  const servers: FakeOpenAI[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function gateway(o: { fake?: FakeOpenAIOptions; callTimeoutMs: number; generation?: { tokensPerSecond: number; overheadMs: number; maxMs: number }; spend?: SpendBudget }) {
    const fake = await new FakeOpenAI(o.fake).start();
    servers.push(fake);
    const gw = new InferenceGateway(new OpenAIClient({ apiKey: KEY, baseUrl: fake.url }), {
      maxModelCalls: 10,
      maxOutputTokens: 7500,
      callTimeoutMs: o.callTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      generation: o.generation,
      spend: o.spend?.scope('F3'),
    });
    return { fake, gw };
  }
  const ask = (gw: InferenceGateway) => {
    const context = ModelContext.create();
    context.addContextItem(UserMessageItem.create('Write the strategy as a JSON document.'));
    gw.registerAgent(context.id, 'Campaign Strategist');
    return { id: context.id, run: () => gw.run({ context, model: MODEL, maxOutputTokens: 7500 } as never) };
  };
  const text = (out: Awaited<ReturnType<InferenceGateway['run']>>) => {
    const item = out.items.find((i) => i.type === 'message') as unknown as { text?: string; content?: { text?: string } } | undefined;
    return item?.content?.text ?? item?.text ?? '';
  };

  it('REPRODUCTION: a long answer that takes longer than the fixed limit times out, is NOT repeated (it may be billed) and is kept as uncertain spend', async () => {
    const spend = new SpendBudget(5);
    const { fake, gw } = await gateway({ callTimeoutMs: 400, spend, fake: { reply: () => ({ delayMs: 1200 }) } });
    const a = ask(gw);
    gw.setLongAnswer(a.id, true); // no `generation` configured: nothing scales, exactly the old behavior
    const out = await a.run();
    assert.equal(readProviderErrorCode(text(out)), 'timeout');
    assert.equal(fake.requests.length, 1, 'a timed-out request is never sent again automatically');
    const s = spend.snapshot();
    assert.ok(s.uncertainUsd > 0, 'the worst case of the request stays counted as spent, never as free');
    assert.equal(s.reservedUsd, 0);
    assert.equal(s.knownUsd, 0);
    // and the failure says WHY, specifically and safely
    assert.match(gw.failureDetail(a.id, 'timeout') ?? '', /No answer arrived within 0\.4 s \(the answer could be up to 7500 tokens long\)\. The request had been sent, so it may still have been billed; it was not repeated automatically\./);
  });

  it('REPAIRED: the same slow answer is accepted once the clock follows the size of the answer (and only for requests marked as long answers)', async () => {
    const { fake, gw } = await gateway({ callTimeoutMs: 400, generation: { tokensPerSecond: 7500, overheadMs: 1500, maxMs: 600_000 }, fake: { reply: () => ({ delayMs: 1200 }) } });
    const long = ask(gw);
    gw.setLongAnswer(long.id, true);
    const ok = await long.run();
    assert.equal(readProviderErrorCode(text(ok)), null, 'the strategist-like request got 1 + 1.5 s and the answer arrived after 1.2 s');
    assert.equal(fake.requests.length, 1);
    // a request that is NOT a long answer keeps its own, short clock
    const short = ask(gw);
    const out = await short.run();
    assert.equal(readProviderErrorCode(text(out)), 'timeout');
    assert.ok(gw.failureDetail(short.id, 'timeout'));
  });

  it('the clock starts when the request is SENT: waiting for room in the campaign budget does not use it up', async () => {
    const spend = new SpendBudget(1);
    const held = spend.scope('F3').tryReserve('text', 0.995)!; // another request is in flight and holds almost all of the budget (the next worst case is about 0.0125)
    const { fake, gw } = await gateway({ callTimeoutMs: 500, spend });
    const a = ask(gw);
    const pending = a.run();
    await new Promise((r) => setTimeout(r, 900)); // longer than the request's whole clock
    assert.equal(fake.requests.length, 0, 'nothing was sent yet: it waits for the other request to settle');
    spend.scope('F3').settle(held, 0.02); // the other one finished for far less than its worst case
    const out = await pending;
    assert.equal(readProviderErrorCode(text(out)), null, 'it was then sent with its full clock and answered');
    assert.equal(fake.requests.length, 1);
  });
});
