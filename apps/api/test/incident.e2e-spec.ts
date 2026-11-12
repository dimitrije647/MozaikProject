import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import type { StartFactoryDto } from '../src/mozaik/dto/factory.dto';
import { explainFailure } from '../src/mozaik/failure-view';
import { FactoryService } from '../src/mozaik/factory.service';
import { campaignRequest, confirmedDesign, configureOpenAi, createApp, registerUser, waitForFactory, type TestUser } from './helpers';

// INCIDENT 2026-11-02 (a real campaign): the strategist, the longest answer of the campaign, did not answer inside the fixed per-request clock;
// the strategy stage failed, the creative stage was never reached and the screen only said "failed". Adapted to V4 (ONE workflow: Business Research
// -> Marketing Strategy -> Creative Production; no audit, no AI images, no presets). These tests reproduce it on the REAL Mozaik runtime with a
// fake OpenAI (real HTTP): nothing is billed and no real provider is contacted. The orchestrator is driven through `FactoryService.start(..., hooks)`,
// the test seam that is not reachable through HTTP.
jest.setTimeout(600_000);

const KEY = 'sk-test-INCIDENTE2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const DESC = 'AI automation platform that helps users create agents for everyday tasks.';
/** V4: Business Research is ONE agent (the fake names it "researcher"). */
const F1_AGENTS = ['researcher'];
const BUDGET = 3;

describe('INCIDENT: a campaign whose strategist outlasted the request clock', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let factory: FactoryService;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  let user: TestUser;
  let projectId: string;
  let design: Record<string, any>;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const images = () => fake.requests.filter((r) => r.path.endsWith('/images/generations'));
  const texts = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
  const called = (names: string[]) => fake.requests.filter((r) => names.includes(r.agent));
  const slowStrategist = (ms: number) => (r: FakeRequest) => (r.agent === 'strategist' ? { delayMs: ms } : undefined);

  const getF = async (u: TestUser, id: string) => (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
  /** Starts a run through the service so a test hook can shorten the per-request clock of one stage. */
  const startWith = async (body: object, hooks: Parameters<FactoryService['start']>[3]) => (await factory.start(user.id, projectId, body as StartFactoryDto, hooks)) as { id: string };

  let failedId: string;
  let failed: any;
  let failedRowBefore: any;
  let callsDuringFailure: { strategist: number; images: number; f1: number };

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    app = await createApp();
    db = new PrismaClient();
    factory = app.get(FactoryService);
    user = await registerUser(app, 'incident');
    projectId = (await user.agent.post('/projects').send({ name: 'JigJoy', description: DESC }).expect(201)).body.id;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: DESC }).expect(200);
    await configureOpenAi(user, KEY, MODEL);
    design = await confirmedDesign(user, projectId, 'premium_editorial');

    // REPRODUCTION: the strategist needs 2.5 s, the request clock of the stage is 1 s (the real run: ~100+ s against a fixed 90 s)
    await useFake({ reply: slowStrategist(2500) });
    const started = await startWith(campaignRequest(design, { approvedBudgetUsd: BUDGET }), { strategy: { callTimeoutMs: 1000 } });
    failedId = started.id;
    failed = await waitForFactory(user, failedId);
    failedRowBefore = await db.factoryRun.findUnique({ where: { id: failedId } });
    callsDuringFailure = { strategist: fake.calls('strategist').length, images: images().length, f1: called(F1_AGENTS).length };
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  it('REPRODUCTION: F1 completed, F3 failed on the strategist, F4 was never reached and no image was requested; the run is "failed", never "completed"', () => {
    expect(failed.status).toBe('failed');
    expect(failed.outcome).toBe('failed');
    expect(failed.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'completed'], ['F3', 'failed'], ['F4', 'skipped']]);
    expect(failed.campaignId).toBeNull();
    expect(callsDuringFailure.f1).toBeGreaterThan(0);
    expect(callsDuringFailure.strategist).toBe(1); // a request that may have been billed is never repeated on its own
    expect(callsDuringFailure.images).toBe(0); // V4 never requests an image
  });

  it('the FIRST failure is named exactly (stage, participant, code, specifics) and is saved with the stage, not only shown', async () => {
    const f3 = failed.phases[1];
    expect(f3).toMatchObject({ code: 'F3', status: 'failed' });
    expect(f3.failure).toMatchObject({ agent: 'Marketing Strategist', code: 'timeout' });
    expect(f3.failure.detail).toMatch(/No answer arrived within 1\.0 s \(the answer could be up to \d+ tokens long\)\. The request had been sent, so it may still have been billed; it was not repeated automatically\./);
    const row = await db.factoryRun.findUnique({ where: { id: failedId } });
    const saved = (row!.phasesJson as any[])[1];
    expect(saved.failure).toEqual(f3.failure); // persisted, so it survives a refresh and a restart
    expect(JSON.stringify(row)).not.toContain(KEY); // and it carries no credential
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it('the screen explains it: where it stopped, who, why, what was spent and what is uncertain, what is left, what to do', () => {
    const x = failed.failure;
    expect(x).toMatchObject({ kind: 'failed', agent: 'Marketing Strategist', code: 'timeout', canContinue: true, budgetContributed: false });
    expect(x.headline).toBe('Campaign stopped during F3 Marketing Strategy.');
    expect(x.phase).toEqual({ code: 'F3', title: 'Marketing Strategy' });
    expect(x.imageGeneration).toMatchObject({ started: false, requests: 0 });
    expect(x.imageGeneration.why).toMatch(/F4 Creative Production was never reached: F3 Marketing Strategy failed first/);
    expect(x.saved.map((s: { code: string }) => s.code)).toEqual(['F1']);
    expect(x.wouldRun.map((s: { code: string }) => s.code)).toEqual(['F3', 'F4']);
    expect(x.spending.uncertainUsd).toBeGreaterThan(0); // the timed-out request is counted as spent, never as free
    expect(x.spending.uncertainUsd).toBe(failed.usage.budget.uncertainUsd);
    expect(x.spending.knownUsd).toBeGreaterThan(0);
    expect(x.spending.remainingUsd).toBeGreaterThan(BUDGET - 0.5);
    expect(x.spending.note).toMatch(/refused no request, so the budget did not cause this stop/);
    expect(x.spending.note).toMatch(/upper estimate .*not a confirmed provider charge/);
    expect(x.nextAction).toMatch(/F1 is reused/);
    expect(x.nextAction).toMatch(/nothing is retried automatically/i);
  });

  it('the unified budget did not cause it: nothing was refused or deferred, the uncertain amount is the timed-out request\'s worst case, and the figures reconcile', () => {
    const b = failed.usage.budget;
    expect(b).toMatchObject({ approvedUsd: BUDGET, source: 'saved', blocked: 0, deferred: 0, reservedUsd: 0 });
    expect(b.refusals).toEqual([]);
    expect(b.uncertainUsd).toBeGreaterThan(0);
    expect(b.uncertainUsd).toBeLessThan(0.5); // one request's reservation, not a campaign-sized amount
    expect(Math.abs(b.committedUsd - (b.knownUsd + b.estimatedUsd + b.uncertainUsd + b.reservedUsd))).toBeLessThan(1e-6);
    expect(Math.abs(b.remainingUsd - (BUDGET - b.committedUsd))).toBeLessThan(1e-6);
  });

  it('another user cannot read the failed run or its reason', async () => {
    const other = await registerUser(app, 'incident-other');
    await other.agent.get(`/factory-runs/${failedId}`).expect(404);
  });

  it('A NEW RUN needs a NEW explicit budget approval: "Generate Campaign" without one starts nothing and sends nothing', async () => {
    await useFake();
    const res = await user.agent.post(`/projects/${projectId}/factory`).send({ design: { design } }).expect(422);
    expect(JSON.stringify(res.body)).toMatch(/budget/i);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'))).toHaveLength(0);
  });

  it('REPAIRED: the next campaign reuses the current Business Research (no F1 agent runs again), the strategist gets a clock that follows its answer, and the campaign completes with zero image requests; the failed run is untouched', async () => {
    // the same slow strategist; the stage now scales the clock of the long answer (a test-sized speed: 7,500 tokens/s + 3 s)
    await useFake({ reply: slowStrategist(2500) });
    const started = await startWith(campaignRequest(design, { approvedBudgetUsd: BUDGET }), { strategy: { callTimeoutMs: 1000, generation: { tokensPerSecond: 7500, overheadMs: 3000 } } });
    expect(started.id).not.toBe(failedId);
    const run = await waitForFactory(user, started.id);
    expect(run.status).toBe('completed');
    expect(run.outcome).toMatch(/approved|approved_with_notes/);
    expect(run.failure).toBeNull();
    expect(run.phases.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['F1', 'reused'], ['F3', 'completed'], ['F4', 'completed']]);
    // the lineage of the saved work is preserved: the very same F1 report, not a copy; V4 builds on no audit
    expect(run.chain.f1ReportId).toBe(failed.phases[0].outputId);
    expect(run.chain.f2AuditId).toBeNull();
    expect(run.chain.f3StrategyId).toBeTruthy();
    expect(called(F1_AGENTS)).toHaveLength(0);
    expect(fake.calls('strategist').length).toBeGreaterThanOrEqual(1);
    expect(images()).toHaveLength(0);
    expect(run.usage.budget).toMatchObject({ approvedUsd: BUDGET, blocked: 0, deferred: 0, reservedUsd: 0 });
    expect(texts().length).toBeGreaterThan(0);
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.deliverables.counts.delivered).toBeGreaterThan(0);
    expect(camp.package.usage.images.requested).toBe(0);
    // the history of the failed run is exactly what it was: nothing was overwritten or deleted
    const after = await db.factoryRun.findUnique({ where: { id: failedId } });
    expect(after).toEqual(failedRowBefore);
    expect((await getF(user, failedId)).status).toBe('failed');
  });

  it('a campaign saved BEFORE the reason was recorded is still readable and explained: the reason is derived read-only from the events of the failed stage', async () => {
    const row = await db.factoryRun.findUnique({ where: { id: failedId } });
    const stripped = (row!.phasesJson as any[]).map(({ failure: _f, ...p }) => p);
    await db.factoryRun.update({ where: { id: failedId }, data: { phasesJson: stripped } }); // the isolated TEST database only
    const old = await getF(user, failedId);
    expect(old.phases[1].failure).toBeUndefined();
    expect(old.failure).toMatchObject({ kind: 'failed', agent: 'Marketing Strategist', code: 'timeout' });
    expect(old.failure.detail).toMatch(/No answer arrived within 1\.0 s/);
    expect(old.failure.imageGeneration.why).toMatch(/F4 Creative Production was never reached/);
    expect(old.status).toBe('failed');
    // and the read did not write anything back
    const again = await db.factoryRun.findUnique({ where: { id: failedId } });
    expect((again!.phasesJson as any[])[1].failure).toBeUndefined();
  });
});

describe('explainFailure: the other ways a campaign can stop', () => {
  const TITLES = { F1: 'Business Research', F3: 'Marketing Strategy', F4: 'Creative Production' } as const;
  const phase = (code: 'F1' | 'F3' | 'F4', status: string, extra: object = {}) => ({ phase: ({ F1: 'discovery', F3: 'strategy', F4: 'creative' } as const)[code], code, title: TITLES[code], action: 'run', status, runId: null, outputId: null, startedAt: null, completedAt: null, error: null, reused: null, ...extra }) as any;
  const budget = (o: object = {}) => ({ knownUsd: 0.5, estimatedUsd: 0, uncertainUsd: 0, remainingUsd: 2.5, remainingBasis: 'exact', requests: { text: 10, image: 0, imageCap: 0 }, blocked: 0, deferred: 0, refusals: [], ...o }) as any;

  it('a run that is not stopped has no failure; a completed or partial campaign is never described as one', () => {
    for (const status of ['completed', 'partial', 'running', 'queued']) expect(explainFailure({ status, phases: [], derived: null, budget: null, errorMessage: null })).toBeNull();
  });

  it('a stop CAUSED by the campaign budget says so (and the budget is blamed only then)', () => {
    const x = explainFailure({ status: 'failed', phases: [phase('F1', 'completed'), phase('F3', 'failed', { error: 'The campaign budget did not start the next request.' }), phase('F4', 'skipped')], derived: { agent: 'Marketing Strategist', code: 'spend_limit', message: 'The budget stopped it.', detail: null }, budget: budget({ blocked: 2, remainingUsd: 0.01 }), errorMessage: null })!;
    expect(x.budgetContributed).toBe(true);
    expect(x.spending.note).toMatch(/refused 2 request/);
    expect(x.nextAction).toMatch(/approve a larger total campaign budget/);
    expect(x.headline).toBe('Campaign stopped during F3 Marketing Strategy.');
  });

  it('a cancelled run is not called failed, keeps its saved stages and starts nothing by itself', () => {
    const x = explainFailure({ status: 'cancelled', phases: [phase('F1', 'completed'), phase('F3', 'cancelled', { error: 'Cancelled.' }), phase('F4', 'skipped')], derived: null, budget: budget(), errorMessage: 'cancelled' })!;
    expect(x).toMatchObject({ kind: 'cancelled', headline: 'Campaign was cancelled during F3 Marketing Strategy.' });
    expect(x.nextAction).toMatch(/You cancelled this run\. F1 finished and is saved/);
    expect(x.imageGeneration.why).toMatch(/F3 Marketing Strategy was cancelled first/);
  });

  it('a failure before anything finished has nothing to reuse and says to start a new run; an unknown budget is "unknown", never $0', () => {
    const x = explainFailure({ status: 'failed', phases: [phase('F1', 'failed', { error: 'No agent produced usable findings.' }), phase('F3', 'skipped'), phase('F4', 'skipped')], derived: null, budget: null, errorMessage: null })!;
    expect(x.saved).toEqual([]);
    expect(x.nextAction).toBe('Start a new run. Nothing is retried automatically.');
    expect(x.reason).toBe('No agent produced usable findings.');
    expect(x.spending).toMatchObject({ knownUsd: null, uncertainUsd: null, remainingUsd: null });
  });

  it('a provider problem gets its own concrete next step (the key, the quota, the model)', () => {
    const base = { status: 'failed', phases: [phase('F1', 'failed')], budget: budget(), errorMessage: null };
    expect(explainFailure({ ...base, derived: { agent: 'Business Researcher', code: 'invalid_api_key', message: 'The key was rejected.', detail: null } })!.nextAction).toMatch(/Check the OpenAI API key/);
    expect(explainFailure({ ...base, derived: { agent: 'Business Researcher', code: 'insufficient_quota', message: 'No credit.', detail: null } })!.nextAction).toMatch(/Add credit/);
  });
});
