import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { ApiCredentialsService } from '../src/api-credentials/api-credentials.module';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { CAMPAIGN_RUNTIME } from '../src/mozaik/types/runtime.token';
import { allEvents, createApp, createProject, registerUser, sleep, waitForTerminal } from './helpers';

// Requires PostgreSQL (docker compose, port 5433). Uses the real Mozaik runtime: nothing is mocked
// except where a test explicitly injects a failure.
describe('Mozaik runtime integration (infrastructure smoke test)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    app = await createApp();
    db = new PrismaClient();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('1+2+3+4: creates a run, round-trips events through real Mozaik, persists them, completes', async () => {
    const user = await registerUser(app, 'happy');
    const projectId = await createProject(user);

    const started = await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 150 }).expect(201);
    expect(started.body.status).toBe('RUNNING'); // observable transition RUNNING -> COMPLETED
    expect(started.body.label).toBe('Infrastructure Smoke Test');
    expect(started.body.currentPhase).toBeNull();

    const done = await waitForTerminal(user, started.body.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
    expect(done.errorMessage).toBeNull();

    const events = await allEvents(user, started.body.id);
    const types = events.map((e) => e.eventType);
    expect(types.filter((t) => t === 'participant.joined')).toHaveLength(3); // emitted by Mozaik itself
    expect(types.indexOf('factory.started')).toBeLessThan(types.indexOf('test.acknowledged'));
    expect(types.indexOf('test.acknowledged')).toBeLessThan(types.indexOf('factory.completed'));
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.find((e) => e.eventType === 'test.acknowledged')!.participant).toBe('Smoke Test Participant');
    expect(events.find((e) => e.eventType === 'factory.completed')!.payload.phasesCompleted).toEqual([]);

    // Persisted in PostgreSQL, not just returned from memory.
    expect(await db.campaignEvent.count({ where: { runId: started.body.id } })).toBe(events.length);

    const list = await user.agent.get(`/projects/${projectId}/runs`).expect(200);
    expect(list.body.map((r: any) => r.id)).toContain(started.body.id);
  });

  it('privacy: booting the API disables Mozaik Cloud telemetry unless an operator opts in', () => {
    expect(process.env.LAUNCHPILOT_MOZAIK_CLOUD).toBeUndefined();
    expect(process.env.MOZAIK_API_KEY).toBe('');
    expect(process.env.MOZAIK_PROJECT_KEY).toBe('');
  });

  it('paginates event history with a cursor', async () => {
    const user = await registerUser(app, 'page');
    const projectId = await createProject(user);
    const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
    await waitForTerminal(user, run.id);

    const first = (await user.agent.get(`/runs/${run.id}/events?limit=3`).expect(200)).body;
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBe(3);
    const second = (await user.agent.get(`/runs/${run.id}/events?limit=500&afterSequence=${first.nextCursor}`).expect(200)).body;
    expect(second.items[0].sequence).toBe(4);
    expect(second.nextCursor).toBeNull();
    await user.agent.get(`/runs/${run.id}/events?limit=9999`).expect(400);
  });

  it('5a: a participant failure becomes FAILED with a truthful message', async () => {
    const user = await registerUser(app, 'fail');
    const projectId = await createProject(user);
    await app.get(MozaikService).startSmokeTest(user.id, projectId, {}, { behavior: 'fail' });
    const [run] = (await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body;
    const done = await waitForTerminal(user, run.id);
    expect(done.status).toBe('FAILED');
    expect(done.errorMessage).toMatch(/Injected participant failure/);
    expect((await allEvents(user, run.id)).map((e) => e.eventType)).toContain('factory.failed');
    // The partial unique index frees the project again.
    await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201);
  });

  it('5b: a participant that never answers times out as FAILED', async () => {
    const user = await registerUser(app, 'timeout');
    const projectId = await createProject(user);
    await app.get(MozaikService).startSmokeTest(user.id, projectId, {}, { behavior: 'silent', timeoutMs: 200 });
    const [run] = (await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body;
    const done = await waitForTerminal(user, run.id);
    expect(done.status).toBe('FAILED');
    expect(done.errorMessage).toMatch(/timed out/);
  });

  it('6: cancellation stops work, ends CANCELLED and emits nothing afterwards', async () => {
    const user = await registerUser(app, 'cancel');
    const projectId = await createProject(user);
    const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 5000 }).expect(201)).body;

    const cancelled = await user.agent.post(`/runs/${run.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.completedAt).toBeTruthy();

    const before = await allEvents(user, run.id);
    await sleep(300);
    const after = await allEvents(user, run.id);
    expect(after).toHaveLength(before.length);
    expect(after.map((e) => e.eventType)).not.toContain('test.acknowledged');
    expect(after[after.length - 1].eventType).toBe('factory.cancelled');
    await user.agent.post(`/runs/${run.id}/cancel`).expect(409); // already finished
  });

  it('7: other users cannot see, list, cancel or start runs on someone else\'s project', async () => {
    const owner = await registerUser(app, 'owner');
    const intruder = await registerUser(app, 'intruder');
    const projectId = await createProject(owner);
    const run = (await owner.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 300 }).expect(201)).body;

    await intruder.agent.get(`/runs/${run.id}`).expect(404);
    await intruder.agent.get(`/runs/${run.id}/events`).expect(404);
    await intruder.agent.post(`/runs/${run.id}/cancel`).expect(404);
    await intruder.agent.get(`/projects/${projectId}/runs`).expect(404);
    await intruder.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(404);
    await request(app.getHttpServer()).get(`/runs/${run.id}`).expect(401);
    await request(app.getHttpServer()).post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(401);
    await request(app.getHttpServer()).get('/runs/does-not-exist').expect(401);
    await owner.agent.get('/runs/does-not-exist').expect(404);

    expect((await waitForTerminal(owner, run.id)).status).toBe('COMPLETED'); // intruder did not disturb it
  });

  it('validates the request body', async () => {
    const user = await registerUser(app, 'validate');
    const projectId = await createProject(user);
    await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 999999 }).expect(400);
    await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 'abc' }).expect(400);
  });

  it('8: needs no AI provider or API key, and never touches credentials', async () => {
    const user = await registerUser(app, 'nokey');
    const projectId = await createProject(user);
    const spy = jest.spyOn(ApiCredentialsService.prototype, 'getDecryptedKey');
    try {
      const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
      expect((await waitForTerminal(user, run.id)).status).toBe('COMPLETED');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // ...whereas inference-backed workflows are blocked clearly when no key exists.
    await expect(app.get(MozaikService).prepareInference(user.id)).rejects.toThrow(/API key/);
  });

  it('9: concurrent runs are isolated; a duplicate on the same project is rejected', async () => {
    const a = await registerUser(app, 'conc-a');
    const b = await registerUser(app, 'conc-b');
    const [pa, pb] = [await createProject(a), await createProject(b)];

    const [ra, rb] = await Promise.all([
      a.agent.post(`/projects/${pa}/runs/smoke-test`).send({ delayMs: 120 }),
      b.agent.post(`/projects/${pb}/runs/smoke-test`).send({ delayMs: 60 }),
    ]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    await Promise.all([waitForTerminal(a, ra.body.id), waitForTerminal(b, rb.body.id)]);

    const [ea, eb] = await Promise.all([allEvents(a, ra.body.id), allEvents(b, rb.body.id)]);
    const joinIds = (evs: typeof ea) => evs.filter((e) => e.eventType === 'participant.joined').map((e) => e.payload.id);
    expect(joinIds(ea).filter((id) => joinIds(eb).includes(id))).toEqual([]); // no shared participants
    expect(ea.filter((e) => e.eventType === 'factory.completed')).toHaveLength(1);
    expect(eb.filter((e) => e.eventType === 'factory.completed')).toHaveLength(1);
    expect(await db.campaignEvent.count({ where: { runId: ra.body.id } })).toBe(ea.length);

    // Same project, simultaneous: exactly one wins.
    const dup = await Promise.all([
      a.agent.post(`/projects/${pa}/runs/smoke-test`).send({ delayMs: 200 }),
      a.agent.post(`/projects/${pa}/runs/smoke-test`).send({ delayMs: 200 }),
      a.agent.post(`/projects/${pa}/runs/smoke-test`).send({ delayMs: 200 }),
    ]);
    expect(dup.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    await waitForTerminal(a, dup.find((r) => r.status === 201)!.body.id);
  });

  it('10: credentials never leak into events, run rows, API responses or logs', async () => {
    const CANARY = 'sk-test-LEAKCANARY1234567890abcdef';
    const user = await registerUser(app, 'leak');
    const projectId = await createProject(user);
    await user.agent.post('/integrations/configure-api-key').send({ providerKey: 'openai', apiKey: CANARY, setAsDefault: true }).expect(200);

    const logged: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => (logged.push(String(c)), true));
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => (logged.push(String(c)), true));
    let responses = '';
    try {
      const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
      await waitForTerminal(user, run.id);
      responses += JSON.stringify([run, (await user.agent.get(`/runs/${run.id}`)).body, await allEvents(user, run.id)]);
      responses += JSON.stringify((await user.agent.get(`/projects/${projectId}/runs`)).body);

      // The credential-resolution path itself must not log or persist the key either.
      const creds = await app.get(MozaikService).prepareInference(user.id);
      expect(creds).toEqual({ provider: 'openai', apiKey: CANARY }); // available server-side only
    } finally {
      out.mockRestore();
      err.mockRestore();
    }

    const stored = JSON.stringify([
      await db.campaignEvent.findMany({ where: { run: { userId: user.id } } }),
      await db.campaignRun.findMany({ where: { userId: user.id } }),
    ]);
    expect(responses).not.toContain(CANARY);
    expect(stored).not.toContain(CANARY);
    expect(logged.join('')).not.toContain(CANARY);
    // And the key is stored encrypted at rest.
    const cred = await db.apiCredential.findFirstOrThrow({ where: { userId: user.id } });
    expect(cred.encryptedKey).not.toContain(CANARY);
  });

  it('prepareInference only ever resolves the calling user\'s own key', async () => {
    const withKey = await registerUser(app, 'k1');
    const without = await registerUser(app, 'k2');
    await withKey.agent.post('/integrations/configure-api-key').send({ providerKey: 'gemini', apiKey: 'AIzaUSERONEKEY1234567890abcdefgh', setAsDefault: true }).expect(200);
    const svc = app.get(MozaikService);
    expect((await svc.prepareInference(withKey.id)).provider).toBe('gemini');
    await expect(svc.prepareInference(without.id)).rejects.toThrow(/API key/);
  });
});

describe('Mozaik runtime: initialization failure', () => {
  it('records FAILED (and a usable project) when the runtime cannot start', async () => {
    const app = await createApp((b) =>
      b.overrideProvider(CAMPAIGN_RUNTIME).useValue({
        startRun: async () => {
          throw new Error('runtime exploded');
        },
        getRunStatus: async () => null,
        stopRun: async () => undefined,
        shutdown: async () => undefined,
      }),
    );
    try {
      const user = await registerUser(app, 'init');
      const projectId = await createProject(user);
      const res = await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201);
      expect(res.body.status).toBe('FAILED');
      expect(res.body.errorMessage).toMatch(/runtime exploded/);
      await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201); // not wedged by a stale RUNNING row
    } finally {
      await app.close();
    }
  });
});

describe('Mozaik runtime: persistence boundary', () => {
  it('redacts credential-shaped payloads at the database boundary even if a runtime emits one', async () => {
    const CANARY = 'sk-test-BOUNDARYCANARY1234567890abc';
    // A misbehaving runtime that tries to push a secret through the event sink.
    const leakyRuntime = {
      startRun: async (input: any) => {
        input.onEvent({
          runId: input.runId,
          sequence: 1,
          type: 'finding.posted',
          phase: null,
          participant: 'Leaky Agent',
          payload: { note: `key is ${CANARY}`, apiKey: CANARY, nested: { authorization: `Bearer ${CANARY}` } },
          occurredAt: new Date().toISOString(),
        });
        return { runId: input.runId, status: () => 'completed', done: Promise.resolve({ runId: input.runId, status: 'completed', eventCount: 1 }), cancel: async () => undefined };
      },
      getRunStatus: async () => null,
      stopRun: async () => undefined,
      shutdown: async () => undefined,
    };
    const app = await createApp((b) => b.overrideProvider(CAMPAIGN_RUNTIME).useValue(leakyRuntime));
    const db = new PrismaClient();
    try {
      const user = await registerUser(app, 'boundary');
      const projectId = await createProject(user);
      const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
      await waitForTerminal(user, run.id);
      const rows = await db.campaignEvent.findMany({ where: { runId: run.id } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(CANARY);
      expect(JSON.stringify(rows)).toContain('[redacted]');
    } finally {
      await app.close();
      await db.$disconnect();
    }
  });

  it('never reports COMPLETED when the event history could not be saved', async () => {
    const brokenRuntime = {
      startRun: async (input: any) => {
        // sequence 1 is written twice -> unique constraint violation on the second insert
        const ev = { runId: input.runId, sequence: 1, type: 'factory.started', phase: null, participant: 'x', payload: null, occurredAt: new Date().toISOString() };
        input.onEvent(ev);
        input.onEvent(ev);
        return { runId: input.runId, status: () => 'completed', done: Promise.resolve({ runId: input.runId, status: 'completed', eventCount: 2 }), cancel: async () => undefined };
      },
      getRunStatus: async () => null,
      stopRun: async () => undefined,
      shutdown: async () => undefined,
    };
    const app = await createApp((b) => b.overrideProvider(CAMPAIGN_RUNTIME).useValue(brokenRuntime));
    try {
      const user = await registerUser(app, 'persistfail');
      const projectId = await createProject(user);
      const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({}).expect(201)).body;
      const done = await waitForTerminal(user, run.id);
      expect(done.status).toBe('FAILED');
      expect(done.errorMessage).toMatch(/history could not be fully saved/);
    } finally {
      await app.close();
    }
  });
});

describe('Mozaik runtime: shutdown and restart', () => {
  it('graceful shutdown records active runs as INTERRUPTED; a restart sweeps orphaned RUNNING rows', async () => {
    const db = new PrismaClient();
    const app1 = await createApp();
    const user = await registerUser(app1, 'restart');
    const projectId = await createProject(user);
    const run = (await user.agent.post(`/projects/${projectId}/runs/smoke-test`).send({ delayMs: 8000 }).expect(201)).body;

    await app1.close(); // SIGTERM path: onModuleDestroy -> runtime.shutdown()
    const shutDown = await db.campaignRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(shutDown.status).toBe('INTERRUPTED');
    expect(shutDown.completedAt).toBeTruthy();

    // Simulate a crash: a RUNNING row that no process owns.
    const orphan = await db.campaignRun.create({ data: { projectId, userId: user.id, mode: 'smoke_test' } });
    const app2 = await createApp(); // onModuleInit sweeps orphans
    try {
      const swept = await db.campaignRun.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(swept.status).toBe('INTERRUPTED');
      expect(swept.errorMessage).toMatch(/restarted/);
      const ev = await db.campaignEvent.findMany({ where: { runId: orphan.id } });
      expect(ev.map((e) => e.eventType)).toEqual(['factory.failed']);
    } finally {
      await app2.close();
      await db.$disconnect();
    }
  });
});
