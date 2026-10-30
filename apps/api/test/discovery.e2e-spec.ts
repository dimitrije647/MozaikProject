import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ProductDiscoveryReport } from '@launchpilot/agents';
import { FakeOpenAI, defaultInputAnalysis, defaultTextAnalysis, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { allEvents, configureOpenAi, createApp, createProject, loginUser, registerUser, sleep, waitForTerminal, type TestUser } from './helpers';

// Product Discovery end to end: HTTP API -> NestJS -> real Mozaik runtime and agents -> fake OpenAI
// HTTP server -> PostgreSQL. No call ever leaves the machine and nothing is billed.
describe('Product Discovery (real Mozaik agents, fake OpenAI)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  const KEY = 'sk-test-DISCOVERYE2E1234567890abcdef';
  const MODEL = 'gpt-test-mini';

  async function useFake(options?: FakeOpenAIOptions) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI(options).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }

  /** A user with a project that has real intake text, and an OpenAI key + model configured. */
  async function readyUser(label: string, key = KEY, projectName = 'Bike Repair Shop') {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, projectName);
    await user.agent
      .put(`/projects/${projectId}/intake`)
      .send({ productName: projectName, shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en', websiteUrl: 'https://bikes.example.com' })
      .expect(200);
    await user.agent.put(`/projects/${projectId}/social-profiles`).send({ profiles: [{ platform: 'instagram', url: 'https://instagram.com/bikes' }] }).expect(200);
    await configureOpenAi(user, key, MODEL);
    return { user, projectId };
  }

  const start = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/runs/product-discovery`).send(body);

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    app = await createApp();
    db = new PrismaClient();
  });
  beforeEach(async () => {
    await useFake();
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  it('refuses to start without a key or without an explicit model, and validates limits', async () => {
    const user = await registerUser(app, 'disc-nokey');
    const projectId = await createProject(user);
    const noKey = await start(user, projectId).expect(422);
    expect(noKey.body.message).toMatch(/OpenAI API key/);

    await configureOpenAi(user, KEY); // key but no model
    const noModel = await start(user, projectId).expect(422);
    expect(noModel.body.message).toMatch(/Choose an OpenAI model/);

    await start(user, projectId, { maxModelCalls: 1 }).expect(400);
    await start(user, projectId, { maxModelCalls: 99 }).expect(400);
    await start(user, projectId, { maxOutputTokens: 5 }).expect(400);
    await start(user, projectId, { model: 'bad model!' }).expect(400);
    expect(fake.requests).toHaveLength(0);
    expect(await db.campaignRun.count({ where: { userId: user.id } })).toBe(0); // nothing was started
  });

  it('runs the agents on the user\'s key and model, saves the report BEFORE completing, and exposes live events', async () => {
    const { user, projectId } = await readyUser('disc-happy');
    const started = (await start(user, projectId).expect(201)).body;
    expect(started).toMatchObject({ mode: 'product_discovery', label: 'Product Discovery', status: 'RUNNING', provider: 'openai', reportId: null });

    const done = await waitForTerminal(user, started.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.reportId).toBeTruthy();

    // Exactly the three model calls, with the user's key, the explicit model and safe request options.
    expect(fake.requests).toHaveLength(3);
    for (const r of fake.requests) {
      expect(r.authorization).toBe(`Bearer ${KEY}`);
      expect(r.body).toMatchObject({ model: MODEL, store: false, max_output_tokens: 3500 });
    }

    // Report: validated, retrievable, with metadata about what was analyzed and what it cost.
    const full = (await user.agent.get(`/reports/${done.reportId}`).expect(200)).body;
    expect(ProductDiscoveryReport.safeParse(full.report).success).toBe(true);
    expect(full).toMatchObject({ projectId, runId: started.id, model: MODEL, language: 'en', schemaVersion: 1 });
    expect(full.metadata.usage.total).toMatchObject({ calls: 3, inputTokens: 360, outputTokens: 180 });
    expect(full.metadata.inputSnapshot.intake.shortDescription).toBe('We fix bicycles in Novi Sad');
    expect(full.metadata.inputSnapshot.availableNotAnalyzed.websiteUrl).toBe('https://bikes.example.com');
    expect(full.metadata.inputSnapshot.availableNotAnalyzed.socialProfiles[0].platform).toBe('instagram');
    expect(full.metadata.agents.map((a: any) => a.name).sort()).toEqual(['Input Analyzer', 'Product Synthesizer', 'Text Analyzer']);
    const row = await db.productDiscoveryReport.findUniqueOrThrow({ where: { runId: started.id } });
    const run = await db.campaignRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(run.completedAt!.getTime()); // saved before completion

    // Event history: real Mozaik choreography, persisted, compact and free of prompts and keys.
    const events = await allEvents(user, started.id);
    const types = events.map((e) => e.eventType);
    for (const t of ['factory.started', 'phase.started', 'task.assigned', 'finding.posted', 'task.completed', 'phase.ready', 'crosscheck.answered', 'report.generated', 'phase.completed', 'factory.completed']) {
      expect(types).toContain(t);
    }
    expect(types.filter((t) => t === 'inference.completed')).toHaveLength(3);
    const history = JSON.stringify(events);
    expect(history).not.toContain(KEY);
    expect(history).not.toContain('We fix bicycles in Novi Sad');
    expect(events.find((e) => e.eventType === 'inference.completed')!.payload.tokenUsage.totalTokens).toBe(180);

    // The run list links to the report.
    expect((await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body[0].reportId).toBe(done.reportId);
  });

  it('keeps the report after a backend restart, and never overwrites older reports on rerun', async () => {
    const { user, projectId } = await readyUser('disc-restart');
    const first = (await start(user, projectId).expect(201)).body;
    const firstDone = await waitForTerminal(user, first.id);
    const firstReport = (await user.agent.get(`/reports/${firstDone.reportId}`)).body;

    const second = (await start(user, projectId).expect(201)).body;
    const secondDone = await waitForTerminal(user, second.id);
    expect(secondDone.reportId).not.toBe(firstDone.reportId);

    const list = (await user.agent.get(`/projects/${projectId}/reports`).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: secondDone.reportId, model: MODEL, partial: false });
    expect(list[0].usage).toMatchObject({ calls: 3 });
    expect((await user.agent.get(`/reports/${firstDone.reportId}`)).body).toEqual(firstReport); // untouched

    // "Restart": a brand-new application instance reads the same data from PostgreSQL.
    const app2 = await createApp();
    try {
      const agent2 = await loginUser(app2, user.email);
      const again = (await agent2.get(`/reports/${firstDone.reportId}`).expect(200)).body;
      expect(again).toEqual(firstReport);
      expect((await agent2.get(`/projects/${projectId}/reports`).expect(200)).body).toHaveLength(2);
    } finally {
      await app2.close();
    }
  });

  it('makes no paid call on page loads, listings, status checks or smoke tests', async () => {
    const { user, projectId } = await readyUser('disc-free');
    fake.requests.length = 0;
    await user.agent.get('/integrations/openai/status').expect(200);
    await user.agent.get('/api-credentials').expect(200);
    await user.agent.get(`/projects/${projectId}/runs`).expect(200);
    await user.agent.get(`/projects/${projectId}/reports`).expect(200);
    await user.agent.get(`/projects/${projectId}`).expect(200);
    const smoke = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
    expect((await waitForTerminal(user, smoke.id)).status).toBe('COMPLETED'); // existing smoke test still works
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects duplicate runs and isolates other users', async () => {
    await useFake({ reply: (r) => (r.agent === 'synthesizer' ? undefined : { text: r.agent === 'input' ? JSON.stringify(defaultInputAnalysis('')) : JSON.stringify(defaultTextAnalysis()), delayMs: 300 }) });
    const { user, projectId } = await readyUser('disc-dup');
    const intruder = await registerUser(app, 'disc-intruder');
    const results = await Promise.all([start(user, projectId), start(user, projectId), start(user, projectId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const run = results.find((r) => r.status === 201)!.body;
    expect((await waitForTerminal(user, run.id)).status).toBe('COMPLETED');
    expect(fake.requests).toHaveLength(3); // duplicates made no model calls

    const reportId = (await user.agent.get(`/runs/${run.id}`)).body.reportId;
    await intruder.agent.get(`/reports/${reportId}`).expect(404);
    await intruder.agent.get(`/projects/${projectId}/reports`).expect(404);
    await start(intruder, projectId).expect(404);
    await intruder.agent.get(`/runs/${run.id}`).expect(404);
    const request = (await import('supertest')).default;
    await request(app.getHttpServer()).get(`/reports/${reportId}`).expect(401);
    await request(app.getHttpServer()).post(`/projects/${projectId}/runs/product-discovery`).send({}).expect(401);
  });

  it('keeps simultaneous analyses of different users isolated: each uses only its own key and data', async () => {
    const keyA = 'sk-test-USERAISOLATION1234567890abcdef';
    const keyB = 'sk-test-USERBISOLATION1234567890abcdef';
    const a = await readyUser('disc-iso-a', keyA, 'PROJECT-ALPHA');
    const b = await readyUser('disc-iso-b', keyB, 'PROJECT-BETA');
    const [ra, rb] = await Promise.all([start(a.user, a.projectId).expect(201), start(b.user, b.projectId).expect(201)]);
    const [da, db2] = await Promise.all([waitForTerminal(a.user, ra.body.id), waitForTerminal(b.user, rb.body.id)]);
    expect([da.status, db2.status]).toEqual(['COMPLETED', 'COMPLETED']);

    const mine = (marker: string) => fake.requests.filter((r) => JSON.stringify(r.body).includes(marker));
    expect(mine('PROJECT-ALPHA')).toHaveLength(3);
    expect(mine('PROJECT-BETA')).toHaveLength(3);
    expect(mine('PROJECT-ALPHA').every((r) => r.authorization === `Bearer ${keyA}`)).toBe(true);
    expect(mine('PROJECT-BETA').every((r) => r.authorization === `Bearer ${keyB}`)).toBe(true);
    expect((await a.user.agent.get(`/reports/${da.reportId}`)).body.metadata.inputSnapshot.project.name).toBe('PROJECT-ALPHA');
    expect((await b.user.agent.get(`/reports/${db2.reportId}`)).body.metadata.inputSnapshot.project.name).toBe('PROJECT-BETA');
  });

  it('fails safely on an invalid key: no report, safe message, key never leaked (even if the provider echoes it)', async () => {
    await useFake({ validKeys: ['sk-test-someone-elses-key-xxxxxxxxxxxx'] });
    const { user, projectId } = await readyUser('disc-401');
    const logged: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => (logged.push(String(c)), true));
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => (logged.push(String(c)), true));
    let run: Record<string, any>;
    try {
      const started = (await start(user, projectId).expect(201)).body;
      run = await waitForTerminal(user, started.id);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toMatch(/rejected the API key/);
    expect(run.reportId).toBeNull();
    const stored = JSON.stringify([await db.campaignEvent.findMany({ where: { runId: run.id } }), await db.campaignRun.findMany({ where: { userId: user.id } })]);
    for (const haystack of [stored, JSON.stringify(run), JSON.stringify(await allEvents(user, run.id)), logged.join('')]) {
      expect(haystack).not.toContain(KEY);
      expect(haystack).not.toContain('Incorrect API key provided');
    }
    expect(await db.productDiscoveryReport.count({ where: { projectId } })).toBe(0);
  });

  it('enforces the per-run model-call budget through the API', async () => {
    // The text analyzer answers badly once, so a repair call is needed; with a budget of 3 the synthesizer is blocked.
    await useFake({ reply: (r) => (r.agent === 'text' && r.attempt === 1 ? { text: '{"broken' } : undefined) });
    const { user, projectId } = await readyUser('disc-budget');
    const started = (await start(user, projectId, { maxModelCalls: 3 }).expect(201)).body;
    const done = await waitForTerminal(user, started.id);
    expect(done.status).toBe('FAILED');
    expect(done.errorMessage).toMatch(/limit on model calls/);
    expect(fake.requests).toHaveLength(3);
    expect(done.reportId).toBeNull();
  });

  it('survives one failing agent: a partial report is saved and flagged', async () => {
    await useFake({ reply: (r) => (r.agent === 'text' ? { status: 500 } : undefined) });
    const { user, projectId } = await readyUser('disc-partial');
    const started = (await start(user, projectId, { maxModelCalls: 8 }).expect(201)).body;
    const done = await waitForTerminal(user, started.id, 20_000);
    expect(done.status).toBe('COMPLETED');
    const full = (await user.agent.get(`/reports/${done.reportId}`)).body;
    expect(full.report.partial).toBe(true);
    expect(full.metadata.agents.find((a: any) => a.name === 'Text Analyzer')).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });
  }, 30000);

  it('cancellation aborts in-flight requests and saves no report', async () => {
    await useFake({ reply: () => ({ hang: true }) });
    const { user, projectId } = await readyUser('disc-cancel');
    const started = (await start(user, projectId).expect(201)).body;
    await sleep(400);
    const cancelled = (await user.agent.post(`/runs/${started.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', reportId: null });
    await sleep(200);
    expect(fake.requests.length).toBe(2);
    expect(fake.requests.every((r) => r.aborted)).toBe(true);
    const types = (await allEvents(user, started.id)).map((e) => e.eventType);
    expect(types[types.length - 1]).toBe('factory.cancelled');
    expect(types).not.toContain('report.generated');
    expect(await db.productDiscoveryReport.count({ where: { projectId } })).toBe(0);
  });

  it('graceful shutdown marks an in-flight analysis INTERRUPTED and aborts its provider requests', async () => {
    await useFake({ reply: () => ({ hang: true }) });
    const local = await createApp();
    try {
      const user = await registerUser(local, 'disc-shutdown');
      const projectId = await createProject(user);
      await configureOpenAi(user, KEY, MODEL);
      const started = (await start(user, projectId).expect(201)).body;
      await sleep(300);
      await local.close(); // SIGTERM path
      const run = await db.campaignRun.findUniqueOrThrow({ where: { id: started.id } });
      expect(run.status).toBe('INTERRUPTED');
      expect(run.errorMessage).toMatch(/server was shutting down/);
      await sleep(100);
      expect(fake.requests.every((r) => r.aborted)).toBe(true);
    } catch (e) {
      await local.close().catch(() => undefined);
      throw e;
    }
  });

  it('an unexpected runtime error becomes a FAILED run, not a crash', async () => {
    const { user, projectId } = await readyUser('disc-sinkfail');
    // Break report persistence: the run must fail truthfully instead of claiming success.
    const prismaCreate = jest.spyOn(db.productDiscoveryReport, 'create'); // (db is a separate client; use the app's service)
    prismaCreate.mockRestore();
    const svc = app.get(MozaikService) as any;
    const original = svc.prisma.productDiscoveryReport.create;
    svc.prisma.productDiscoveryReport.create = async () => {
      throw new Error('simulated database outage');
    };
    try {
      const started = (await start(user, projectId).expect(201)).body;
      const done = await waitForTerminal(user, started.id);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/simulated database outage/);
      expect(done.reportId).toBeNull();
    } finally {
      svc.prisma.productDiscoveryReport.create = original;
    }
  });
});
