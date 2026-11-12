import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { configureOpenAi, createApp, createProject, registerUser, sleep, startF1, startF3, startF4, waitForTerminal, type TestUser } from './helpers';

// The workspace stage cards and the project badges are read from THIS endpoint: the persisted state of F1, F3 and F4 (V4: no F2 audit), derived only from
// CampaignRun rows and the saved report / audit / strategy / campaign. Nothing is invented; a completed state needs a saved result.
describe('Project pipeline state (persisted runs and results)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  const KEY = 'sk-test-PIPELINE1234567890abcdefghij';
  const MODEL = 'gpt-test-mini';

  async function useFake(options?: FakeOpenAIOptions) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }

  async function readyUser(label: string, projectName = 'Deep Diving School') {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, projectName);
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: projectName, shortDescription: 'Scuba diving courses for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', preferredLanguage: 'en' }).expect(200);
    await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }

  // V4: the stages have no HTTP start routes; they are started through the service the Campaign Production orchestrator uses
  const startDiscovery = (u: TestUser, projectId: string) => startF1(app, u, projectId);
  const pipeline = async (u: TestUser, projectId: string) => (await u.agent.get(`/projects/${projectId}/pipeline`).expect(200)).body;
  const phase = (p: any, key: string) => p.phases.find((x: any) => x.phase === key);
  const finish = async (u: TestUser, started: Promise<Record<string, any>>, ms = 40_000) => waitForTerminal(u, (await started).id, ms);

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

  it('a new project: nothing has run, so F1 is "not_started" and F3 and F4 are "blocked" with the reason; no result is invented', async () => {
    const { user, projectId } = await readyUser('pipe-new');
    const p = await pipeline(user, projectId);
    expect(p).toMatchObject({ projectId, completed: 0, running: null, next: 'discovery' });
    expect(p.phases.map((x: any) => [x.code, x.state])).toEqual([['F1', 'not_started'], ['F3', 'blocked'], ['F4', 'blocked']]);
    expect(phase(p, 'audit')).toBeUndefined(); // V4 runs no Marketing Audit
    expect(phase(p, 'strategy').blockedBy).toMatch(/completed Business Research \(F1\)/);
    expect(phase(p, 'creative').blockedBy).toMatch(/Strategy \(F3\)/);
    expect(p.phases.every((x: any) => x.output === null && x.latestRun === null && x.runs === 0)).toBe(true);
    // the project list carries the same facts as a light summary; `status` stays the user's own label
    const list = (await user.agent.get('/projects').expect(200)).body;
    const mine = list.find((x: any) => x.id === projectId);
    expect(mine.status).toBe('DRAFT');
    expect(mine.pipeline).toMatchObject({ completed: 0, running: null, next: 'discovery', states: { discovery: 'not_started', strategy: 'blocked' }, hasOutput: { discovery: false } });
  });

  it('F1 completed and saved: the card data carries the real report (summary, counts, model); F3 becomes startable; F4 stays blocked', async () => {
    const { user, projectId } = await readyUser('pipe-f1');
    const run = await finish(user, startDiscovery(user, projectId));
    expect(run.status).toBe('COMPLETED');
    const p = await pipeline(user, projectId);
    const f1 = phase(p, 'discovery');
    expect(f1).toMatchObject({ code: 'F1', state: 'completed', runs: 1, blockedBy: null, note: null });
    expect(f1.latestRun).toMatchObject({ id: run.id, status: 'COMPLETED' });
    expect(f1.output).toMatchObject({ id: run.reportId, runId: run.id, model: MODEL, partial: false, outdated: null });
    expect(f1.output.summary).toMatch(/evidence-aware assessment/);
    expect(f1.output.stats.map((s: any) => s.label)).toEqual(['Agents', 'Findings', 'Sources', 'Tokens']);
    expect(f1.output.stats.find((s: any) => s.label === 'Agents').value).toBeGreaterThan(0);
    expect(f1.output.stats.find((s: any) => s.label === 'Tokens').value).toBeGreaterThan(0);
    expect(phase(p, 'strategy')).toMatchObject({ state: 'not_started', blockedBy: null, output: null });
    expect(phase(p, 'creative').state).toBe('blocked');
    expect(p).toMatchObject({ completed: 1, running: null, next: 'strategy' });
    const mine = (await user.agent.get('/projects').expect(200)).body.find((x: any) => x.id === projectId);
    expect(mine.pipeline).toMatchObject({ completed: 1, next: 'strategy', hasOutput: { discovery: true, strategy: false } });
    // the summary list does not load report content
    expect(JSON.stringify(mine.pipeline)).not.toMatch(/evidence-aware/);
  }, 90_000);

  it('a FAILED run is shown as failed with its safe message and no result; a failed RERUN keeps the earlier completed result visible and says so', async () => {
    const { user, projectId } = await readyUser('pipe-fail');
    await useFake({ reply: () => ({ status: 401, json: { error: { code: 'invalid_api_key', message: `bad ${KEY}` } } }) });
    const failed = await finish(user, startDiscovery(user, projectId), 30_000);
    expect(failed.status).toBe('FAILED');
    let p = await pipeline(user, projectId);
    expect(phase(p, 'discovery')).toMatchObject({ state: 'failed', output: null, runs: 1 });
    expect(phase(p, 'discovery').latestRun).toMatchObject({ status: 'FAILED' });
    expect(phase(p, 'discovery').latestRun.errorMessage).toBeTruthy();
    expect(phase(p, 'strategy').state).toBe('blocked');
    expect(p).toMatchObject({ completed: 0, next: 'discovery' });
    expect(JSON.stringify(p)).not.toContain(KEY);

    await useFake();
    const ok = await finish(user, startDiscovery(user, projectId));
    expect(ok.status).toBe('COMPLETED');
    p = await pipeline(user, projectId);
    expect(phase(p, 'discovery')).toMatchObject({ state: 'completed', runs: 2 });
    expect(phase(p, 'discovery').output.runId).toBe(ok.id);

    await useFake({ reply: () => ({ status: 401, json: { error: { code: 'invalid_api_key' } } }) });
    const rerun = await finish(user, startDiscovery(user, projectId), 30_000);
    expect(rerun.status).toBe('FAILED');
    p = await pipeline(user, projectId);
    const f1 = phase(p, 'discovery');
    expect(f1.state).toBe('failed');
    expect(f1.output.runId).toBe(ok.id); // the earlier result is still there
    expect(f1.note).toMatch(/latest run failed; the result below is from an earlier completed run/);
    expect(p.completed).toBe(1);
    expect(p.next).toBe('strategy');
  }, 120_000);

  it('a RUNNING phase is reported as running while it runs, and as cancelled after the user cancels it (nothing is marked completed)', async () => {
    const { user, projectId } = await readyUser('pipe-run');
    await useFake({ reply: () => ({ hang: true }) });
    const started = await startDiscovery(user, projectId);
    for (let i = 0; i < 100 && fake.requests.length === 0; i++) await sleep(25);
    let p = await pipeline(user, projectId);
    expect(phase(p, 'discovery')).toMatchObject({ state: 'running', output: null });
    expect(phase(p, 'discovery').latestRun).toMatchObject({ id: started.id, status: 'RUNNING', completedAt: null });
    expect(p).toMatchObject({ running: 'discovery', completed: 0 });
    expect((await user.agent.get('/projects').expect(200)).body.find((x: any) => x.id === projectId).pipeline.running).toBe('discovery');
    await user.agent.post(`/runs/${started.id}/cancel`).expect(200);
    p = await pipeline(user, projectId);
    expect(phase(p, 'discovery')).toMatchObject({ state: 'cancelled', output: null });
    expect(p).toMatchObject({ running: null, completed: 0, next: 'discovery' });
  }, 60_000);

  it('a run row marked COMPLETED without its saved result is NOT shown as completed', async () => {
    const { user, projectId } = await readyUser('pipe-orphan');
    const owner = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    await db.campaignRun.create({ data: { projectId, userId: owner.id, mode: 'product_discovery', status: 'COMPLETED', completedAt: new Date() } });
    const p = await pipeline(user, projectId);
    expect(phase(p, 'discovery')).toMatchObject({ state: 'failed', output: null });
    expect(phase(p, 'discovery').note).toMatch(/marked completed but no saved result/);
    expect(p.completed).toBe(0);
  });

  it('the whole chain F1 -> F3 -> F4: every phase completed with its real result; a newer upstream result marks the dependent one as built on an earlier result', async () => {
    const { user, projectId } = await readyUser('pipe-chain');
    const f1 = await finish(user, startDiscovery(user, projectId));
    const f3 = await finish(user, startF3(app, user, projectId, f1.reportId), 50_000);
    const f4 = await finish(user, startF4(app, user, projectId, f3.strategyId, { concepts: 1, channels: ['instagram'] }), 60_000);
    expect([f1.status, f3.status, f4.status]).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    let p = await pipeline(user, projectId);
    expect(p.phases.map((x: any) => x.state)).toEqual(['completed', 'completed', 'completed']);
    expect(p).toMatchObject({ completed: 3, running: null, next: null });
    expect(phase(p, 'strategy').output.id).toBe(f3.strategyId);
    expect(phase(p, 'creative').output).toMatchObject({ id: f4.campaignId, runId: f4.id });
    expect(phase(p, 'creative').output.stats.map((s: any) => s.label)).toEqual(['Concepts', 'Images', 'Layouts', 'Unresolved']);
    expect(phase(p, 'creative').output.stats.find((s: any) => s.label === 'Images').value).toBe(0); // V4 never generates an image
    expect(['approved', 'approved_with_notes', 'unresolved']).toContain(phase(p, 'creative').output.approvalStatus);
    expect(p.phases.every((x: any) => x.output.outdated === null)).toBe(true);
    expect(fake.imageCalls()).toHaveLength(0);

    // a NEW F1 report: F3 was built on the older one; F4 is still built on the newest strategy
    await finish(user, startDiscovery(user, projectId));
    p = await pipeline(user, projectId);
    expect(phase(p, 'discovery').runs).toBe(2);
    expect(phase(p, 'strategy').output.outdated).toMatch(/Built on an earlier F1 result; a newer one exists/);
    expect(phase(p, 'creative').output.outdated).toBeNull(); // still the newest strategy
    expect(phase(p, 'strategy').state).toBe('completed'); // not reset: the result is real, just older than its upstream
  }, 240_000);

  it('another user gets 404 for the pipeline and sees only their own projects in the list summaries', async () => {
    const { user, projectId } = await readyUser('pipe-own');
    const other = await registerUser(app, 'pipe-other');
    await other.agent.get(`/projects/${projectId}/pipeline`).expect(404);
    const list = (await other.agent.get('/projects').expect(200)).body;
    expect(list.find((x: any) => x.id === projectId)).toBeUndefined();
    expect((await user.agent.get(`/projects/${projectId}/pipeline`).expect(200)).body.projectId).toBe(projectId);
  });
});
