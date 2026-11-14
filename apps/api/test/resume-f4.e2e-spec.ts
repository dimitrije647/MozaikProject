import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import type { StartFactoryDto } from '../src/mozaik/dto/factory.dto';
import { FactoryService } from '../src/mozaik/factory.service';
import { campaignRequest, confirmedDesign, configureOpenAi, createApp, registerUser, waitForFactory, type TestUser } from './helpers';

// INCIDENT 2026-11-14 (Giardino, a real campaign): F1 and F3 completed, then the Content Writer's long answer ran into a fixed clock and F4 failed.
// "Continue from saved work" promised that F1 and F3 are reused, but the strategy always ran again (paid twice). These tests reproduce the failure
// on the REAL Mozaik runtime with a fake OpenAI over real HTTP (test-sized clocks: nothing waits 90 s, nothing is billed) and pin the recovery:
// the next campaign reuses BOTH saved stages and only F4 runs.
jest.setTimeout(600_000);

const KEY = 'sk-test-RESUMEF4E2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const DESC = 'A garden cafe and bar with breakfast, lunch and evening events in the city centre.';
const BUDGET = 3;

describe('CONTINUE AFTER A FAILED CONTENT WRITER: saved research and strategy are reused, only F4 runs again', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let factory: FactoryService;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  let user: TestUser;
  let projectId: string;
  let design: Record<string, any>;
  let failed: any;
  let failedRowBefore: any;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const writerCopy = (r: FakeRequest) => r.agent === 'copywriter' && !r.userText.includes('Revise ONLY the listed copy');
  const startWith = async (body: object, hooks: Parameters<FactoryService['start']>[3] = {}) => (await factory.start(user.id, projectId, body as StartFactoryDto, hooks)) as { id: string };
  // the writer's clock follows its cap: ceil(cap / 100,000 tokens/s) s + 0.5 s = 1.5 s here (stands for minutes in a real run); per-request limit 0.5 s
  const clocks = { creative: { callTimeoutMs: 500, generation: { tokensPerSecond: 100_000, overheadMs: 500, maxMs: 600_000 } } };

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    app = await createApp();
    db = new PrismaClient();
    factory = app.get(FactoryService);
    user = await registerUser(app, 'resume-f4');
    projectId = (await user.agent.post('/projects').send({ name: 'Giardino', description: DESC }).expect(201)).body.id;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Giardino', shortDescription: DESC }).expect(200);
    await configureOpenAi(user, KEY, MODEL);
    design = await confirmedDesign(user, projectId, 'premium_editorial');
    // REPRODUCTION: the Content Writer answers after 3.5 s, its clock is 1.5 s
    await useFake({ reply: (r) => (writerCopy(r) ? { delayMs: 3500 } : undefined) });
    const started = await startWith(campaignRequest(design, { approvedBudgetUsd: BUDGET }), clocks);
    failed = await waitForFactory(user, started.id);
    failedRowBefore = await db.factoryRun.findUnique({ where: { id: started.id } });
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  it('REPRODUCTION: F1 and F3 saved, F4 failed on the Content Writer timeout; the request was not repeated and is uncertain spend, not free', () => {
    expect(failed.status).toBe('failed');
    expect(failed.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'completed'], ['F3', 'completed'], ['F4', 'failed']]);
    expect(failed.phases[2].failure).toMatchObject({ agent: 'Content Writer', code: 'timeout' });
    expect(failed.phases[2].failure.detail).toMatch(/No answer arrived within 1\.5 s \(the answer could be up to \d+ tokens long\)\. The request had been sent, so it may still have been billed; it was not repeated automatically\./);
    expect(fake.requests.filter(writerCopy)).toHaveLength(1);
    const b = failed.usage.budget;
    expect(b.uncertainUsd).toBeGreaterThan(0);
    expect(b.knownUsd).toBeGreaterThan(0);
    expect(Math.abs(b.committedUsd - (b.knownUsd + b.uncertainUsd))).toBeLessThan(0.0001); // counted once
    expect(failed.usage.providerRequests).toBeGreaterThanOrEqual(failed.usage.textCalls); // the timed-out request is a provider request too
    expect(failed.failure.saved.map((s: { code: string }) => s.code)).toEqual(['F1', 'F3']);
    expect(failed.failure.wouldRun.map((s: { code: string }) => s.code)).toEqual(['F4']);
    expect(failed.failure.nextAction).toMatch(/F1 and F3 are reused \(nothing is paid for them again\)/);
  });

  it('CONTINUE: the next campaign with the same settings REUSES F1 and F3 (no research or strategy request) and only F4 runs, now with a clock that fits the answer', async () => {
    await useFake({ reply: (r) => (writerCopy(r) ? { delayMs: 1000 } : undefined) }); // slower than the per-request limit, inside the writer's clock
    const started = await startWith(campaignRequest(design, { approvedBudgetUsd: BUDGET }), clocks);
    const done = await waitForFactory(user, started.id);
    expect(done.status).toBe('completed');
    expect(done.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'reused'], ['F3', 'reused'], ['F4', 'completed']]);
    expect(done.phases[1].outputId).toBe(failed.phases[1].outputId); // the very strategy the failed run saved
    expect(fake.calls('researcher')).toHaveLength(0);
    expect(fake.calls('strategist')).toHaveLength(0);
    expect(fake.requests.filter(writerCopy)).toHaveLength(1);
    expect(fake.requests.filter((r) => r.path.endsWith('/images/generations'))).toHaveLength(0);
    expect(JSON.stringify(done.warnings)).toMatch(/Marketing Strategy saved on .* is reused \(no paid request for it\)/);
    // the failed run is history: unchanged
    const after = await db.factoryRun.findUnique({ where: { id: failed.id } });
    expect(after!.phasesJson).toEqual(failedRowBefore!.phasesJson);
    expect(after!.ledgerJson).toEqual(failedRowBefore!.ledgerJson);
    expect(after!.status).toBe('failed');
  });

  it('only a FAILED creative stage is continued: after a completed campaign, or with other strategy settings, the strategy runs again', async () => {
    await useFake();
    const changed = await startWith(campaignRequest(design, { approvedBudgetUsd: BUDGET, objective: 'Fill the evening events with new guests' }));
    const done = await waitForFactory(user, changed.id);
    expect(done.status).toBe('completed');
    expect(done.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'reused'], ['F3', 'completed'], ['F4', 'completed']]);
    expect(fake.calls('strategist').length).toBeGreaterThan(0);
  });
});
