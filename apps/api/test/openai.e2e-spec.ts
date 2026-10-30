import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { configureOpenAi, createApp, registerUser } from './helpers';

// OpenAI BYOK: key storage, model selection, "Test connection". Uses a local fake OpenAI HTTP server
// (no network, no cost). Requires PostgreSQL (see global-setup.js).
describe('OpenAI BYOK: connection test and model selection', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  const KEY = 'sk-test-BYOKKEY1234567890abcdefghijk';

  async function useFake(options?: FakeOpenAIOptions) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI(options).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    app = await createApp();
    db = new PrismaClient();
    await useFake();
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  it('stores the key encrypted, shows only a masked status, and starts with NO model selected', async () => {
    const user = await registerUser(app, 'byok-status');
    const before = (await user.agent.get('/integrations/openai/status').expect(200)).body;
    expect(before).toMatchObject({ configured: false, ready: false, model: null });

    await configureOpenAi(user, KEY);
    const status = (await user.agent.get('/integrations/openai/status').expect(200)).body;
    expect(status).toMatchObject({ configured: true, model: null, ready: false, verifiedModel: null });
    expect(status.maskedKey).toMatch(/^sk-.*••••/);
    expect(JSON.stringify(status)).not.toContain('BYOKKEY1234567890');

    const row = await db.apiCredential.findFirstOrThrow({ where: { userId: user.id, providerKey: 'openai' } });
    expect(row.encryptedKey).not.toContain('BYOKKEY');
    expect(row.model).toBeNull(); // never auto-selected
    expect((await user.agent.get('/api-credentials').expect(200)).body[0]).not.toHaveProperty('encryptedKey');
  });

  it('lists the models visible to the key without selecting one, and requires a saved key', async () => {
    const user = await registerUser(app, 'byok-models');
    await user.agent.get('/integrations/openai/models').expect(404); // no key yet
    await configureOpenAi(user, KEY);
    fake.requests.length = 0;

    const res = (await user.agent.get('/integrations/openai/models').expect(200)).body;
    expect(res.selected).toBeNull();
    expect(res.models.map((m: any) => m.id)).toEqual(['gpt-test-large', 'gpt-test-mini', 'text-embedding-test']);
    expect(res.models.find((m: any) => m.id === 'text-embedding-test').likelyText).toBe(false);
    expect(res.models.find((m: any) => m.id === 'gpt-test-mini').likelyText).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', authorization: `Bearer ${KEY}` });
    expect((await user.agent.get('/integrations/openai/status')).body.model).toBeNull();
  });

  it('validates model ids and stores the selection', async () => {
    const user = await registerUser(app, 'byok-model');
    await user.agent.put('/integrations/openai/model').send({ model: 'gpt-test-mini' }).expect(404); // needs a key first
    await configureOpenAi(user, KEY);
    await user.agent.put('/integrations/openai/model').send({ model: 'has spaces' }).expect(400);
    await user.agent.put('/integrations/openai/model').send({ model: '' }).expect(400);
    await user.agent.put('/integrations/openai/model').send({}).expect(400);
    const ok = await user.agent.put('/integrations/openai/model').send({ model: 'gpt-test-mini' }).expect(200);
    expect(ok.body).toMatchObject({ model: 'gpt-test-mini', ready: false }); // selected is not verified
  });

  it('Test connection makes ONE tiny real call, marks the model verified, and is rate limited against double clicks', async () => {
    const user = await registerUser(app, 'byok-test');
    await configureOpenAi(user, KEY, 'gpt-test-mini');
    fake.requests.length = 0;

    const res = (await user.agent.post('/integrations/openai/test').send({}).expect(200)).body;
    expect(res).toMatchObject({ ok: true, model: 'gpt-test-mini', keyAccepted: true, usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 } });
    expect(typeof res.latencyMs).toBe('number');
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0];
    expect(sent.authorization).toBe(`Bearer ${KEY}`); // the user's own key
    expect(sent.body).toMatchObject({ model: 'gpt-test-mini', max_output_tokens: 32, store: false });

    const status = (await user.agent.get('/integrations/openai/status').expect(200)).body;
    expect(status).toMatchObject({ ready: true, verifiedModel: 'gpt-test-mini' });
    await user.agent.post('/integrations/openai/test').send({}).expect(429); // cooldown
    expect(fake.requests).toHaveLength(1);

    // Replacing the key invalidates the verification; changing the model makes it not-ready.
    await configureOpenAi(user, 'sk-test-REPLACEDKEY1234567890abcdefgh');
    expect((await user.agent.get('/integrations/openai/status')).body).toMatchObject({ ready: false, verifiedModel: null });
  });

  it('requires a chosen model before testing', async () => {
    const user = await registerUser(app, 'byok-nomodel');
    await configureOpenAi(user, KEY);
    await user.agent.post('/integrations/openai/test').send({}).expect(422);
  });

  const failureCases: [string, FakeOpenAIOptions, { code: string; keyAccepted: boolean | null; message: RegExp }][] = [
    ['an invalid key', { validKeys: ['sk-someone-else-xxxxxxxxxxxxxxxxxxxx'] }, { code: 'invalid_api_key', keyAccepted: false, message: /rejected the API key/ }],
    ['insufficient quota', { reply: () => ({ status: 429, json: { error: { message: 'You exceeded your current quota, sk-secret-in-msg', code: 'insufficient_quota', type: 'insufficient_quota' } } }) }, { code: 'insufficient_quota', keyAccepted: true, message: /no remaining quota/ }],
    ['an unavailable model', { reply: () => ({ status: 404, json: { error: { message: 'The model `gpt-test-mini` does not exist', code: 'model_not_found' } } }) }, { code: 'model_unavailable', keyAccepted: true, message: /does not exist or is not available/ }],
    ['a rate limit', { reply: () => ({ status: 429, json: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } }) }, { code: 'rate_limited', keyAccepted: true, message: /rate limit/i }],
    ['a provider outage', { reply: () => ({ status: 503, json: { error: { message: 'overloaded' } } }) }, { code: 'provider_unavailable', keyAccepted: null, message: /temporarily unavailable/ }],
  ];

  it.each(failureCases)('reports %s safely and never marks the model ready', async (_name, options, expected) => {
    await useFake(options);
    const user = await registerUser(app, 'byok-fail');
    await configureOpenAi(user, KEY, 'gpt-test-mini');
    const res = (await user.agent.post('/integrations/openai/test').send({}).expect(200)).body;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe(expected.code);
    expect(res.error.message).toMatch(expected.message);
    expect(res.keyAccepted).toBe(expected.keyAccepted);
    // The provider's own text (which can echo keys) is never passed on.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('BYOKKEY');
    expect(serialized).not.toContain('sk-secret-in-msg');
    expect(serialized).not.toContain('Incorrect API key provided');
    expect((await user.agent.get('/integrations/openai/status')).body.ready).toBe(false);
    await useFake();
  });

  it('a key that authenticates but cannot call the chosen model is not ready, and a later success clears nothing stale', async () => {
    await useFake({ reply: (r) => (r.body?.model === 'gpt-test-large' ? { status: 404, json: { error: { code: 'model_not_found' } } } : undefined) });
    const user = await registerUser(app, 'byok-partial');
    await configureOpenAi(user, KEY, 'gpt-test-mini');
    expect((await user.agent.post('/integrations/openai/test').send({}).expect(200)).body.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 3100)); // cooldown
    const bad = (await user.agent.post('/integrations/openai/test').send({ model: 'gpt-test-large' }).expect(200)).body;
    expect(bad).toMatchObject({ ok: false, keyAccepted: true, error: { code: 'model_unavailable' } });
    const status = (await user.agent.get('/integrations/openai/status')).body;
    expect(status).toMatchObject({ model: 'gpt-test-large', ready: false, verifiedModel: null });
    await useFake();
  }, 15000);

  it('one user cannot see, list, select or test with another user\'s key', async () => {
    const owner = await registerUser(app, 'byok-owner');
    const other = await registerUser(app, 'byok-other');
    await configureOpenAi(owner, KEY, 'gpt-test-mini');
    fake.requests.length = 0;

    expect((await other.agent.get('/integrations/openai/status').expect(200)).body.configured).toBe(false);
    await other.agent.get('/integrations/openai/models').expect(404);
    await other.agent.put('/integrations/openai/model').send({ model: 'gpt-test-mini' }).expect(404);
    await other.agent.post('/integrations/openai/test').send({}).expect(404);
    expect(fake.requests).toHaveLength(0); // the owner's key was never used for the other user
    expect((await owner.agent.get('/integrations/openai/status')).body.model).toBe('gpt-test-mini');
  });

  it('requires authentication', async () => {
    const request = (await import('supertest')).default;
    await request(app.getHttpServer()).get('/integrations/openai/status').expect(401);
    await request(app.getHttpServer()).post('/integrations/openai/test').send({}).expect(401);
  });
});
