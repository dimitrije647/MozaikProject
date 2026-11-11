import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SpendBudget } from './budget';
import { OpenAIClient } from './openai-http';
import { ImageGenerator, type ImageGenSettings } from './openai-images';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '../testing/fake-openai';

// The campaign ledger driving the REAL image generator against a fake OpenAI over real HTTP. Nothing is billed.
// The fake reports 40 input and 1056 output tokens per image, so one gpt-image-1.5 image really costs 40x$5/1M + 1056x$32/1M = $0.033992,
// while its reservation (the published per-image price of medium 1024x1536) is $0.05: the difference is released when the image finishes.

const KEY = 'sk-test-LEDGER1234567890abcdefghijklmn';
const SETTINGS: ImageGenSettings = { model: 'gpt-image-1.5', quality: 'medium', size: '1024x1536' };
const ACTUAL = 0.033992;
const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} !== ${b}`);

describe('the campaign ledger with the real image generator', () => {
  const servers: FakeOpenAI[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  async function setup(approved: number | null, opts: { fake?: FakeOpenAIOptions; limits?: Partial<ConstructorParameters<typeof ImageGenerator>[1]>; maxImageRequests?: number | null } = {}) {
    const fake = await new FakeOpenAI(opts.fake).start();
    servers.push(fake);
    const ledger = new SpendBudget(approved, { maxImageRequests: opts.maxImageRequests ?? null });
    const gen = new ImageGenerator(new OpenAIClient({ apiKey: KEY, baseUrl: fake.url }), { maxImages: 8, maxRetries: 1, retryBaseDelayMs: 5, timeoutMs: 5000, ...opts.limits, spend: ledger.scope('F4') });
    return { fake, ledger, gen };
  }

  it('reserves the published price, settles at the cost the provider reported and releases the difference', async () => {
    const { ledger, gen } = await setup(0.2);
    for (let i = 0; i < 3; i++) assert.equal((await gen.generate(`p${i}`, SETTINGS)).ok, true);
    const s = ledger.snapshot();
    near(s.knownUsd, 3 * ACTUAL);
    near(s.reservedUsd, 0);
    near(s.remainingUsd, 0.2 - 3 * ACTUAL);
    assert.equal(s.remainingBasis, 'exact');
    assert.equal(s.requests.image, 3);
    // the unused part is back: text from another phase may use it
    assert.ok(ledger.scope('F1').tryReserve('text', 0.09));
    assert.equal(ledger.scope('F1').tryReserve('text', 0.01), null);
  });

  it('concurrent workers share the one budget: money is never reserved twice and no request is sent that does not fit', async () => {
    const { fake, ledger, gen } = await setup(0.17);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => gen.generate(`p${i}`, SETTINGS)));
    const generated = results.filter((r) => r.ok).length;
    assert.equal(generated, 4, 'deterministic: an image waits for the ones in flight to settle at their real cost (3 x $0.034 + the next $0.05 fits $0.17; a fifth does not)');
    assert.equal(fake.imageCalls().length, generated, 'a refused request is never sent');
    assert.equal(results.filter((r) => !r.ok && r.error.code === 'spend_limit').length, 8 - generated);
    const s = ledger.snapshot();
    assert.ok(s.committedUsd <= 0.17 + 1e-9, `committed ${s.committedUsd}`);
    near(s.reservedUsd, 0);
    assert.equal(s.blocked, 8 - generated);
  });

  it('a request that TIMES OUT after sending stays as uncertain spend: never forgotten, never counted as free', async () => {
    const { ledger, gen } = await setup(1, { fake: { reply: (r: FakeRequest) => (r.kind === 'image' ? { hang: true } : undefined) }, limits: { timeoutMs: 80, maxRetries: 0 } });
    const r = await gen.generate('hang', SETTINGS);
    assert.equal(r.ok, false);
    const s = ledger.snapshot();
    near(s.uncertainUsd, 0.05);
    near(s.reservedUsd, 0);
    near(s.remainingUsd, 0.95);
    assert.equal(s.remainingBasis, 'estimated');
    assert.equal(s.knownUsd, 0);
  });

  it('cancelling the run does not leak a reservation: what was in flight is kept as uncertain and nothing stays "held"', async () => {
    const { ledger, gen } = await setup(1, { fake: { reply: (r: FakeRequest) => (r.kind === 'image' ? { hang: true } : undefined) }, limits: { timeoutMs: 30_000, maxRetries: 0 } });
    const pending = gen.generate('hang', SETTINGS);
    await new Promise((r) => setTimeout(r, 120));
    near(ledger.snapshot().reservedUsd, 0.05); // held while the request is in flight
    gen.abort();
    const r = await pending;
    assert.equal(r.ok, false);
    const s = ledger.snapshot();
    near(s.reservedUsd, 0);
    near(s.uncertainUsd, 0.05);
    ledger.finalize();
    near(ledger.snapshot().reservedUsd, 0);
  });

  it('a rate limit is waited out under the SAME reservation: nothing is billed for the 429 and nothing is reserved twice', async () => {
    let n = 0;
    const { ledger, gen } = await setup(0.2, { fake: { reply: (r: FakeRequest) => (r.kind === 'image' && ++n === 1 ? { status: 429, headers: { 'Retry-After': '1' }, json: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } } : undefined) } });
    const t0 = Date.now();
    const r = await gen.generate('p', SETTINGS);
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t0 >= 900, 'Retry-After was honoured');
    const s = ledger.snapshot();
    near(s.knownUsd, ACTUAL);
    near(s.reservedUsd, 0);
    assert.equal(s.requests.image, 1, 'one logical request, not two');
  });

  it('the approved maximum number of image requests is a second, independent boundary', async () => {
    const { fake, ledger, gen } = await setup(50, { maxImageRequests: 2, limits: { maxImages: 10 } });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await gen.generate(`p${i}`, SETTINGS));
    assert.deepEqual(results.map((r) => r.ok), [true, true, false, false]);
    assert.equal(fake.imageCalls().length, 2);
    assert.equal(ledger.lastRefusal()?.reason, 'image_request_cap');
  });

  it('a model without a published price: allowed while something is left, recorded from the reported usage, and the rest of the campaign is then protected with its real cost', async () => {
    const unpriced: ImageGenSettings = { model: 'gpt-image-2.5-sunburst', quality: 'medium', size: '1024x1536' };
    const { ledger, gen } = await setup(1);
    ledger.setPlan({ phases: [{ label: 'F4', order: 1, projectedUsd: 0 }], images: { remaining: 4, unitUsd: null } });
    assert.equal(ledger.snapshot().projection.imagesUsd, null, 'unknown stays unknown');
    const r = await gen.generate('first', unpriced);
    assert.equal(r.ok, true);
    const s = ledger.snapshot();
    near(s.knownUsd, 40 * 5e-6 + 1056 * 30e-6); // the provider-reported usage at the token rates
    assert.equal(s.unpriced, 1);
    assert.equal(s.projection.imageBasis, 'observed');
    near(s.projection.imagesUsd, 3 * (40 * 5e-6 + 1056 * 30e-6) * 1.15, 1e-5);
  });

  it('an unpriced request is never started when nothing is left, and an exhausted budget refuses everything that is priced', async () => {
    const unpriced: ImageGenSettings = { model: 'gpt-image-2.5-sunburst', quality: 'medium', size: '1024x1536' };
    const { fake, ledger, gen } = await setup(0.01);
    const text = ledger.scope('F1').tryReserve('text', 0.01)!;
    ledger.scope('F1').settle(text, 0.01);
    const r = await gen.generate('p', unpriced);
    assert.equal(r.ok, false);
    assert.equal(fake.imageCalls().length, 0);
    assert.equal(ledger.lastRefusal()?.reason, 'nothing_left');
  });
});
