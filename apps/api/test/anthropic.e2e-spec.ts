import { INestApplication, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI } from '@launchpilot/agents/dist/testing/fake-openai';
import { campaignRequest, confirmedDesign, createApp, createProject, loginUser, registerUser, startF1, waitForFactory, waitForTerminal, type TestUser } from './helpers';

// CLAUDE PROVIDER (V3, adapted to V4: no per-stage routes, no presets): Settings > AI providers with a Claude Console API key, the persisted default provider/model, the refused subscription
// mode, and a real Mozaik phase run entirely on Claude. Two local fakes (Claude and OpenAI): no network, nothing billed.
describe('Claude provider (Claude API key only; subscription mode unavailable)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let claude: FakeOpenAI;
  let openai: FakeOpenAI;
  const prev = { a: process.env.LAUNCHPILOT_ANTHROPIC_BASE_URL, o: process.env.LAUNCHPILOT_OPENAI_BASE_URL };
  const KEY = 'sk-ant-api03-CLAUDEE2E1234567890abcdefghijklmn';
  const MODEL = 'claude-opus-5-5';

  beforeAll(async () => {
    app = await createApp();
    db = new PrismaClient();
  });
  beforeEach(async () => {
    claude = await new FakeOpenAI({ validKeys: [KEY] }).start();
    openai = await new FakeOpenAI().start();
    process.env.LAUNCHPILOT_ANTHROPIC_BASE_URL = claude.anthropicUrl;
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = openai.url;
  });
  afterEach(async () => {
    await claude.close();
    await openai.close();
  });
  afterAll(async () => {
    process.env.LAUNCHPILOT_ANTHROPIC_BASE_URL = prev.a;
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = prev.o;
    await app.close();
    await db.$disconnect();
  });

  const saveKey = (u: TestUser, apiKey: string, setAsDefault = true) => u.agent.post('/integrations/configure-api-key').send({ providerKey: 'anthropic', apiKey, setAsDefault });

  async function claudeUser(label: string) {
    const user = await registerUser(app, label);
    await saveKey(user, KEY).expect(200);
    await user.agent.put('/integrations/anthropic/model').send({ model: MODEL }).expect(200);
    return user;
  }

  it('accepts only a Claude Console API key: a subscription sign-in token or an Admin key is refused and never stored', async () => {
    const user = await registerUser(app, 'claude-keys');
    const oat = await saveKey(user, 'sk-ant-oat01-SUBSCRIPTIONTOKEN1234567890abcdef').expect(400);
    expect(oat.body.message).toMatch(/subscription sign-in token/);
    await saveKey(user, 'sk-ant-admin01-ADMINKEY1234567890abcdefghijk').expect(400);
    await saveKey(user, 'not-a-claude-key-1234567890abcdef').expect(400);
    expect(await db.apiCredential.count({ where: { userId: user.id } })).toBe(0);

    await saveKey(user, KEY).expect(200);
    const row = await db.apiCredential.findFirstOrThrow({ where: { userId: user.id, providerKey: 'anthropic' } });
    expect(row.encryptedKey).not.toContain('CLAUDEE2E');
    expect(row.model).toBeNull(); // never auto-selected
    const status = (await user.agent.get('/integrations/anthropic/status').expect(200)).body;
    expect(status).toMatchObject({ configured: true, mode: 'api_key', model: null, ready: false, isDefault: true, subscription: { available: false, status: 'unsupported' } });
    expect(JSON.stringify(status)).not.toContain('CLAUDEE2E1234567890');
    expect(claude.requests).toHaveLength(0); // saving a key calls nobody
  });

  it('the subscription mode cannot be selected; the overview never exposes a key', async () => {
    const user = await claudeUser('claude-sub');
    for (const p of ['claude_subscription', 'claude-pro', 'anthropic_max', 'claude-code']) {
      const r = await user.agent.put('/api-credentials/default').send({ providerKey: p }).expect(400);
      expect(r.body.message).toMatch(/subscription mode is not available/);
    }
    await user.agent.put('/api-credentials/default').send({ providerKey: 'nonsense' }).expect(400);
    const o = (await user.agent.get('/ai-providers').expect(200)).body;
    expect(o).toMatchObject({ defaultProvider: 'anthropic', textProvider: 'anthropic', providers: { anthropic: { configured: true, model: MODEL, status: 'not_verified' }, openai: { configured: false } }, claudeSubscription: { available: false } });
    expect(o.claudeSubscription.sources).toContain('https://code.claude.com/docs/en/legal-and-compliance');
    expect(JSON.stringify(o)).not.toContain('CLAUDEE2E1234567890');
  });

  it('lists Claude models (free) and tests the connection with ONE tiny call that uses only the stored key', async () => {
    const user = await claudeUser('claude-test');
    const models = (await user.agent.get('/integrations/anthropic/models').expect(200)).body;
    expect(models.models.map((m: any) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(models.models[0]).toMatchObject({ priced: true, inputPerM: 4, outputPerM: 20 });
    const t = (await user.agent.post('/integrations/anthropic/test').send({}).expect(200)).body;
    expect(t).toMatchObject({ ok: true, model: MODEL, keyAccepted: true });
    const call = claude.requests.find((r) => r.path === '/v1/messages')!;
    expect(call.authorization.replace(/^Bearer /, '')).toBe(KEY);
    expect((call.body as any).max_tokens).toBeLessThanOrEqual(256);
    expect((await user.agent.get('/integrations/anthropic/status')).body).toMatchObject({ ready: true, verifiedModel: MODEL });
    expect(openai.requests).toHaveLength(0);
    // a wrong model id is refused by validation, never sent
    await user.agent.put('/integrations/anthropic/model').send({ model: 'gpt-4.1-mini' }).expect(400);
  });

  it('the provider and model persist across a new session (refresh) and are used by the next run without asking again', async () => {
    const user = await claudeUser('claude-persist');
    const again = await loginUser(app, user.email);
    const o = (await again.get('/ai-providers').expect(200)).body;
    expect(o).toMatchObject({ defaultProvider: 'anthropic', providers: { anthropic: { model: MODEL } } });

    const projectId = await createProject(user, 'Bike Repair Shop');
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Bike Repair Shop', shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en' }).expect(200);
    // the stage resolves the PERSISTED default provider and model itself (the run takes no provider or model)
    const started = await startF1(app, user, projectId);
    expect(started).toMatchObject({ provider: 'anthropic', status: 'RUNNING' });
    const done = await waitForTerminal(user, started.id, 30_000);
    expect(done.status).toBe('COMPLETED');
    // every agent ran on Claude with the saved model; nothing went to OpenAI. V4 Business Research is ONE agent (the Business Researcher):
    // exactly one research analysis and one report synthesis (V3 had several analysts, hence more calls)
    expect(claude.calls('researcher', 'analysis')).toHaveLength(1);
    expect(claude.calls('researcher', 'synthesis')).toHaveLength(1);
    expect(claude.calls()).toHaveLength(2);
    expect(claude.calls().every((r) => r.provider === 'anthropic' && (r.body as any).model === MODEL)).toBe(true);
    expect(openai.requests).toHaveLength(0);
    const report = await db.productDiscoveryReport.findFirstOrThrow({ where: { runId: started.id } });
    expect(report.model).toBe(MODEL);
    expect((report.metadataJson as any).provider).toBe('anthropic');
    expect(JSON.stringify(report.metadataJson)).not.toContain('CLAUDEE2E');
  });

  it('never switches providers: a non-Claude model on the Claude default is refused before anything is sent; another user cannot use this key', async () => {
    const user = await claudeUser('claude-noswitch');
    const projectId = await createProject(user);
    // the API refuses to save a non-Claude model for Claude; a row that holds one anyway (older data) is refused at run time
    await db.apiCredential.updateMany({ where: { userId: user.id, providerKey: 'anthropic' }, data: { model: 'gpt-4.1-mini' } });
    await expect(startF1(app, user, projectId)).rejects.toThrow(/never switches providers/);
    const pre = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({}).expect(200)).body;
    expect(pre.blockers.map((b: any) => b.code)).toContain('model_unavailable');
    await user.agent.post(`/projects/${projectId}/factory`).send({ approvedBudgetUsd: 1, confirmCost: true }).expect(422);
    expect(claude.requests).toHaveLength(0);
    expect(openai.requests).toHaveLength(0);

    const other = await registerUser(app, 'claude-other');
    const theirs = await createProject(other);
    const denied = startF1(app, other, theirs);
    await expect(denied).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(startF1(app, other, theirs)).rejects.toThrow(/OpenAI API key/); // no key of their own: nothing of the first user's is used
    const blocked = (await other.agent.post(`/projects/${theirs}/factory/preflight`).send({}).expect(200)).body;
    expect(blocked.blockers.map((b: any) => b.code)).toContain('no_credentials');
    await other.agent.post(`/projects/${projectId}/factory/preflight`).send({}).expect(404); // and the first user's project is not theirs
    expect(claude.requests).toHaveLength(0);
  });

  it('Campaign Production on Claude: ONE workflow with no preset and no image model; the provider comes from Settings; nothing goes to OpenAI', async () => {
    const user = await claudeUser('claude-factory');
    const projectId = await createProject(user);
    await user.agent.get('/factory/presets').expect(404); // V4: there are no presets to choose from
    const def = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({}).expect(200)).body;
    expect(def.preset).toBeUndefined();
    expect(def.provider).toMatchObject({ id: 'anthropic', name: 'Claude', model: MODEL, source: 'settings' });
    expect(def.statement.aiImages).toMatch(/AI-generated images: 0/);
    expect(def.phases.map((p: any) => p.code)).toEqual(['F1', 'F3', 'F4']);
    expect(def.blockers.map((b: any) => b.code)).not.toContain('provider_unsupported');
    expect(claude.calls()).toHaveLength(0); // the plan is free: at most the (free) model list was read
    expect(openai.requests).toHaveLength(0);
  });

  it('Campaign Production RUNS on Claude: Business Research, Marketing Strategy and Creative Production all complete with the saved Claude model; nothing goes to OpenAI and no image is requested', async () => {
    const user = await claudeUser('claude-campaign');
    const projectId = await createProject(user, 'Bike Repair Shop');
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Bike Repair Shop', shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en' }).expect(200);
    const design = await confirmedDesign(user, projectId, 'premium_editorial');
    const started = (await user.agent.post(`/projects/${projectId}/factory`).send(campaignRequest(design)).expect(201)).body;
    const run = await waitForFactory(user, started.id, 240_000);
    expect(run.status).toBe('completed');
    expect(run.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'completed'], ['F3', 'completed'], ['F4', 'completed']]);
    // the agent work of every stage reached Claude: the Business Researcher, the Marketing Strategist (research + strategy) and the Content Writer
    expect(claude.calls('researcher', 'analysis')).toHaveLength(1);
    expect(claude.calls('researcher', 'synthesis')).toHaveLength(1);
    expect(claude.calls('strategist', 'analysis')).toHaveLength(1);
    expect(claude.calls('strategist', 'synthesis')).toHaveLength(1);
    expect(claude.calls('copywriter').length).toBeGreaterThanOrEqual(1);
    expect(claude.calls().every((r) => r.provider === 'anthropic' && (r.body as any).model === MODEL)).toBe(true);
    expect(openai.requests).toHaveLength(0);
    expect(claude.imageCalls()).toHaveLength(0);
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.deliverables.counts.delivered).toBeGreaterThan(0);
    expect(camp.package.usage.images.requested).toBe(0);
  }, 300_000);
});
