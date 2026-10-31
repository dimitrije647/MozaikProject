import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ProductDiscoveryReportV2 } from '@launchpilot/agents';
import { buildPdf } from '@launchpilot/agents/dist/testing/fixtures';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { allEvents, configureOpenAi, createApp, createProject, loginUser, registerUser, sleep, waitForTerminal, type TestUser } from './helpers';

// Product Discovery (F1) end to end: HTTP API -> NestJS -> real Mozaik runtime and agents -> fake OpenAI
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
      .send({ productName: projectName, shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en' })
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
    await start(user, projectId, { maxReviews: 20 }).expect(400);
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

    // Text-only idea: A1 + A2 analyze, they cross-check each other, A7 synthesizes. Skipped agents make NO call.
    expect(fake.requests).toHaveLength(5);
    expect(fake.requests.map((r) => `${r.agent}:${r.kind}`).sort()).toEqual(['input:analysis', 'input:review', 'synthesizer:synthesis', 'text:analysis', 'text:review']);
    for (const r of fake.requests) {
      expect(r.authorization).toBe(`Bearer ${KEY}`);
      expect(r.body).toMatchObject({ model: MODEL, store: false });
    }

    // Report: validated, retrievable, with metadata about what was analyzed and what it cost.
    const full = (await user.agent.get(`/reports/${done.reportId}`).expect(200)).body;
    expect(ProductDiscoveryReportV2.safeParse(full.report).success).toBe(true);
    expect(full).toMatchObject({ projectId, runId: started.id, model: MODEL, language: 'en', schemaVersion: 2 });
    expect(full.metadata.usage.total).toMatchObject({ calls: 5, inputTokens: 600, outputTokens: 300 });
    expect(full.metadata.inputSnapshot.intake.shortDescription).toBe('We fix bicycles in Novi Sad');
    expect(full.metadata.inputSnapshot.availableSources.socialProfiles[0].platform).toBe('instagram');
    expect(full.metadata.plan.activated.map((a: any) => a.agent)).toEqual(['Input Analyzer', 'Text Analyzer', 'Product Synthesizer']);
    expect(full.metadata.plan.skipped.map((a: any) => a.agent)).toEqual(['Web Analyzer', 'Repo Analyzer', 'File Analyzer', 'Visual Analyzer']);
    expect(full.metadata.partial).toBe(false);
    const row = await db.productDiscoveryReport.findUniqueOrThrow({ where: { runId: started.id } });
    const run = await db.campaignRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(run.completedAt!.getTime()); // saved before completion

    // Event history: real Mozaik choreography, persisted, compact and free of prompts and keys.
    const events = await allEvents(user, started.id);
    const types = events.map((e) => e.eventType);
    for (const t of ['factory.started', 'phase.started', 'task.assigned', 'finding.posted', 'task.completed', 'phase.ready', 'crosscheck.requested', 'crosscheck.answered', 'participant.idle', 'source.retrieved', 'report.generated', 'phase.completed', 'factory.completed']) {
      expect(types).toContain(t);
    }
    expect(types.filter((t) => t === 'inference.completed')).toHaveLength(5);
    const history = JSON.stringify(events);
    expect(history).not.toContain(KEY);
    expect(events.find((e) => e.eventType === 'inference.completed')!.payload.tokenUsage.totalTokens).toBe(180);

    // The run list links to the report.
    expect((await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body[0].reportId).toBe(done.reportId);
  });

  it('exposes agents, evidence and cross-checks per run, only to the owner', async () => {
    const { user, projectId } = await readyUser('disc-analysis');
    const intruder = await registerUser(app, 'disc-analysis-intruder');
    const started = (await start(user, projectId).expect(201)).body;
    const done = await waitForTerminal(user, started.id);
    const a = (await user.agent.get(`/runs/${started.id}/analysis`).expect(200)).body;
    expect(a).toMatchObject({ runId: started.id, source: 'report', reportId: done.reportId });
    expect(a.findings.length).toBeGreaterThan(0);
    expect(a.findings[0]).toHaveProperty('classification');
    expect(a.crosschecks.length).toBeGreaterThan(0);
    expect(a.participants.filter((p: any) => p.state === 'skipped')).toHaveLength(4);
    expect(a.aiCalls['Product Synthesizer']).toBe(1);
    expect(JSON.stringify(a)).not.toContain(KEY);
    await intruder.agent.get(`/runs/${started.id}/analysis`).expect(404);
  });

  it('reads an uploaded PDF from storage: File Analyzer is activated and its text reaches the model', async () => {
    const { user, projectId } = await readyUser('disc-pdf');
    await user.agent.post(`/projects/${projectId}/assets`).attach('files', buildPdf(['UPLOADED-FIXTURE-PRICE-LIST 300 EUR']), { filename: 'cenovnik.pdf', contentType: 'application/pdf' }).expect(201);
    const started = (await start(user, projectId).expect(201)).body;
    const done = await waitForTerminal(user, started.id);
    expect(done.status).toBe('COMPLETED');
    const files = fake.requests.filter((r) => r.agent === 'files' && r.kind === 'analysis');
    expect(files).toHaveLength(1);
    expect(files[0].userText).toContain('UPLOADED-FIXTURE-PRICE-LIST');
    const a = (await user.agent.get(`/runs/${started.id}/analysis`)).body;
    expect(a.plan.activated.map((x: any) => x.agent)).toContain('File Analyzer');
    expect(a.sources.find((x: any) => x.kind === 'document')).toMatchObject({ label: 'cenovnik.pdf', status: 'retrieved' });
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
    expect(list[0].usage).toMatchObject({ calls: 5 });
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
    await useFake({ reply: (r) => (r.kind === 'analysis' ? { delayMs: 300 } : undefined) });
    const { user, projectId } = await readyUser('disc-dup');
    const intruder = await registerUser(app, 'disc-intruder');
    const results = await Promise.all([start(user, projectId), start(user, projectId), start(user, projectId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const run = results.find((r) => r.status === 201)!.body;
    expect((await waitForTerminal(user, run.id)).status).toBe('COMPLETED');
    expect(fake.requests).toHaveLength(5); // duplicates made no model calls

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
    expect(mine('PROJECT-ALPHA')).toHaveLength(5);
    expect(mine('PROJECT-BETA')).toHaveLength(5);
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

  it('enforces the per-run model-call budget through the API: cross-checks are dropped first', async () => {
    const { user, projectId } = await readyUser('disc-budget');
    const started = (await start(user, projectId, { maxModelCalls: 3 }).expect(201)).body;
    const done = await waitForTerminal(user, started.id);
    expect(done.status).toBe('COMPLETED');
    expect(fake.requests.map((r) => r.kind).sort()).toEqual(['analysis', 'analysis', 'synthesis']);
    const full = (await user.agent.get(`/reports/${done.reportId}`)).body;
    expect(full.metadata.usage.total.calls).toBe(3);
    expect(full.metadata.crosschecks).toEqual([]);
  });

  it('survives one failing agent: a partial report is saved and flagged', async () => {
    await useFake({ reply: (r) => (r.agent === 'text' && r.kind === 'analysis' ? { status: 500 } : undefined) });
    const { user, projectId } = await readyUser('disc-partial');
    const started = (await start(user, projectId, { maxModelCalls: 8 }).expect(201)).body;
    const done = await waitForTerminal(user, started.id, 20_000);
    expect(done.status).toBe('COMPLETED');
    const full = (await user.agent.get(`/reports/${done.reportId}`)).body;
    expect(full.report.partial).toBe(true);
    expect(full.metadata.participants.find((a: any) => a.agent === 'Text Analyzer')).toMatchObject({ state: 'failed', error: { code: 'provider_unavailable' } });
  }, 30000);

  it('cancellation aborts in-flight requests and saves no report', async () => {
    await useFake({ reply: () => ({ hang: true }) });
    const { user, projectId } = await readyUser('disc-cancel');
    const started = (await start(user, projectId).expect(201)).body;
    await sleep(400);
    const cancelled = (await user.agent.post(`/runs/${started.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', reportId: null });
    await sleep(200);
    expect(fake.requests.length).toBe(2); // both analysts were in flight
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
