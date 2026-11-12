import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { campaignRequest, confirmedDesign, configureOpenAi, createApp, registerUser, sleep, waitForFactory, type TestUser } from './helpers';

// ONE CAMPAIGN BUDGET (V4): a single amount is the budget of the whole campaign. Every paid request (the text agents of every stage, the reviews
// and the repairs) draws on the same ledger; there are no text and image pools, and V4 requests no image at all. The whole F1 -> F3 -> F4 chain
// runs on the real Mozaik runtime; only OpenAI is faked (over real HTTP). Nothing is billed and no real provider is ever contacted.
jest.setTimeout(600_000);

const KEY = 'sk-test-BUDGETE2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const DESC = 'AI automation platform that helps users create agents for everyday tasks.';
/** V4: Business Research is ONE agent (the fake names it "researcher"). */
const F1_AGENTS = ['researcher'];

describe('ONE shared campaign budget', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));
  const images = () => fake.requests.filter((r) => r.path.endsWith('/images/generations'));
  const texts = () => fake.requests.filter((r) => r.path.endsWith('/responses'));

  async function project(label: string, o: { key?: boolean } = {}) {
    const user = await registerUser(app, label);
    const created = await user.agent.post('/projects').send({ name: 'JigJoy', description: DESC }).expect(201);
    const projectId = created.body.id as string;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: DESC }).expect(200);
    if (o.key !== false) await configureOpenAi(user, KEY, MODEL);
    const design = await confirmedDesign(user, projectId, 'premium_editorial');
    return { user, projectId, design };
  }
  const preflight = (u: TestUser, id: string, design: object, body: object = {}) => u.agent.post(`/projects/${id}/factory/preflight`).send({ design: { design }, ...body });
  const startF = (u: TestUser, id: string, design: Record<string, any>, body: object = {}) => u.agent.post(`/projects/${id}/factory`).send(campaignRequest(design, body));
  const getF = async (u: TestUser, id: string) => (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
  const sum = (b: { knownUsd: number; estimatedUsd: number; uncertainUsd: number; reservedUsd: number }) => b.knownUsd + b.estimatedUsd + b.uncertainUsd + b.reservedUsd;

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

  // ---- the user enters ONE amount -------------------------------------------------------------------------------------------------

  it('one $3 budget is compared with the estimate as ONE budget: there are no pools, a client-sent text pool is ignored, and the review is free', async () => {
    const { user, projectId, design } = await project('bud-pre');
    const p = (await preflight(user, projectId, design, { approvedBudgetUsd: 3, textBudgetUsd: 2 }).expect(200)).body;
    expect(p.cost.budget).toMatchObject({ approvedUsd: 3 });
    expect(['within', 'may_stop_early']).toContain(p.cost.budget.status);
    expect(p.cost.budget).not.toHaveProperty('pools');
    expect(p.budget).not.toHaveProperty('textBudgetUsd');
    expect(p.budget.required).toBe(true);
    expect(JSON.stringify(p.settings)).not.toMatch(/textBudgetUsd/);
    expect(JSON.stringify(p.cost)).not.toMatch(/gpt-image|imagesUsd|imageRequests|"images"/); // text-only: no image price, count or pool exists
    expect(paid()).toHaveLength(0);
  });

  it('a small budget never silently reduces the campaign: the plan keeps its deliverables, says the budget is too small, and nothing starts; no budget at all starts nothing either', async () => {
    const { user, projectId, design } = await project('bud-counts');
    const enough = (await preflight(user, projectId, design, { approvedBudgetUsd: 3 }).expect(200)).body;
    const p = (await preflight(user, projectId, design, { approvedBudgetUsd: 0.01 }).expect(200)).body;
    expect(p.cost.budget.status).toBe('below_estimate');
    expect(p.cost.budget.message).toMatch(/Approve at least/);
    expect(p.deliverables.planned).toBe(enough.deliverables.planned); // nothing was cut to fit the money
    expect(p.settings.concepts).toBe(enough.settings.concepts);
    // and it cannot be started (nothing was changed on the user's behalf)
    await startF(user, projectId, design, { approvedBudgetUsd: 0.01 }).expect(422);
    // V4: every campaign needs ONE approved budget; there is no "no limit" preset any more
    await user.agent.post(`/projects/${projectId}/factory`).send({ design: { design }, confirmCost: true }).expect(422);
    expect(paid()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  // ---- every stage shares ONE ledger -----------------------------------------------------------------------------------------------

  it('a $3 budget covers every stage: one ledger, no image request, unused money stays available, and every counter reconciles (also after a refresh)', async () => {
    const { user, projectId, design } = await project('bud-run');
    const started = await startF(user, projectId, design, { approvedBudgetUsd: 3 }).expect(201);
    const run = await waitForFactory(user, started.body.id);
    expect(run.status).toBe('completed');
    const b = run.usage.budget;
    expect(b).toMatchObject({ source: 'saved', approvedUsd: 3, remainingBasis: 'exact', legacy: null, reservedUsd: 0 });
    expect(b.requests.image ?? 0).toBe(0);
    expect(b.requests.text).toBe(texts().length);
    expect(images()).toHaveLength(0);
    expect(b.breakdown.imagesUsd ?? 0).toBe(0);
    expect(Math.abs(b.breakdown.agentsUsd + (b.breakdown.imagesUsd ?? 0) + b.breakdown.reviewsUsd - (b.knownUsd + b.estimatedUsd))).toBeLessThan(1e-5);
    expect(Math.abs(b.committedUsd - sum(b))).toBeLessThan(1e-6);
    expect(Math.abs(b.remainingUsd - (3 - b.committedUsd))).toBeLessThan(1e-6);
    expect(b.remainingUsd).toBeGreaterThan(2.5); // text costs cents: the rest of the $3 is simply still available
    // it is the same shared ledger in every stage report and in the campaign
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.cost.approvedUsd).toBe(3);
    // refresh: the saved ledger is what a new page load shows
    const again = await getF(user, run.id);
    expect(again.usage.budget).toEqual(b);
    const row = await db.factoryRun.findUnique({ where: { id: run.id } });
    expect(row?.ledgerJson).toMatchObject({ approvedUsd: 3 });
    expect(row?.configJson).toMatchObject({ workflow: 'campaign_production', approvedBudgetUsd: 3, sharedBudget: true, confirmedCost: true });
    expect(row?.configJson).not.toHaveProperty('textBudgetUsd');
    expect(row?.configJson).not.toHaveProperty('preset');
  });

  // ---- exhaustion, cancellation ----------------------------------------------------------------------------------------------------

  it('when the shared budget runs out the run stops BEFORE the next request that does not fit: finished work is kept, the shortfall is reported, the total is never knowingly exceeded', async () => {
    const { user, projectId, design } = await project('bud-exhaust');
    // a budget just above the ESTIMATE (ordinary token volumes), so the campaign may start
    const typical = (await preflight(user, projectId, design, { approvedBudgetUsd: 3 }).expect(200)).body.cost.totals.typicalUsd as number;
    expect(typical).toBeGreaterThan(0);
    const budget = Math.ceil(typical * 1.2 * 100) / 100;
    // ...but every text call reports 100k input tokens (about $0.04 each): far more than the estimate assumed, so the budget is used up mid-campaign
    await useFake({ reply: (r: FakeRequest) => (r.path.endsWith('/responses') ? { usage: { input: 100_000, output: 80 } } : undefined) });
    const started = await startF(user, projectId, design, { approvedBudgetUsd: budget });
    expect(started.status).toBe(201);
    const run = await waitForFactory(user, started.body.id);
    expect(['failed', 'partial']).toContain(run.status); // the budget cannot pay for the whole chain: it stops or delivers a partial campaign, it never overspends
    const b = run.usage.budget;
    expect(b.committedUsd).toBeLessThanOrEqual(budget + 1e-6); // never knowingly beyond the approved total
    expect(b.reservedUsd).toBe(0);
    expect(b.blocked + b.deferred).toBeGreaterThan(0);
    expect(b.refusals.length).toBeGreaterThan(0);
    expect(b.refusals.join(' ')).toMatch(/campaign budget did not start/);
    if (run.status === 'failed') expect(run.failure.budgetContributed).toBe(true);
    expect(images()).toHaveLength(0);
    // nothing was requested after the budget said no: the text requests are bounded by what fits
    expect(texts().length).toBeLessThan(20);
    expect(b.remainingUsd).toBeLessThan(budget);
  });

  it('cancelling a run leaves no reservation held: what was in flight stays as uncertain spend and the saved ledger says so', async () => {
    await useFake({ reply: (r: FakeRequest) => (F1_AGENTS.includes(r.agent) ? { hang: true } : undefined) });
    const { user, projectId, design } = await project('bud-cancel');
    const started = (await startF(user, projectId, design, { approvedBudgetUsd: 3 }).expect(201)).body;
    for (let i = 0; i < 60 && texts().length === 0; i++) await sleep(100);
    expect(texts().length).toBeGreaterThan(0);
    await sleep(200);
    const live = await getF(user, started.id);
    expect(live.usage.budget.source).toBe('live');
    expect(live.usage.budget.reservedUsd).toBeGreaterThan(0); // held while the requests are in flight
    await user.agent.post(`/factory-runs/${started.id}/cancel`).expect(200);
    await sleep(500);
    const done = await getF(user, started.id);
    expect(done.status).toBe('cancelled');
    const b = done.usage.budget;
    expect(b.source).toBe('saved');
    expect(b.reservedUsd).toBe(0);
    expect(b.uncertainUsd).toBeGreaterThan(0); // requests that may have been billed: counted as spent, never forgotten
    expect(b.remainingBasis).toBe('estimated');
    expect(images()).toHaveLength(0);
  });

  // ---- one budget per campaign, history, isolation -----------------------------------------------------------------------------------

  it('a second campaign of the same project is approved with its OWN budget: the current research is not paid for again, and the earlier campaign keeps its own accounting', async () => {
    const { user, projectId, design } = await project('bud-second');
    const first = await waitForFactory(user, (await startF(user, projectId, design, { approvedBudgetUsd: 3 }).expect(201)).body.id);
    expect(first.status).toMatch(/completed|partial/);
    await useFake();
    const second = await waitForFactory(user, (await startF(user, projectId, design, { approvedBudgetUsd: 2 }).expect(201)).body.id);
    expect(second.status).toMatch(/completed|partial/);
    expect(second.phases[0]).toMatchObject({ code: 'F1', status: 'reused' });
    expect(fake.calls().filter((r) => F1_AGENTS.includes(r.agent))).toHaveLength(0); // Business Research was reused, not paid again
    expect(second.usage.budget.approvedUsd).toBe(2);
    const revision = (await user.agent.get(`/campaigns/${second.campaignId}`).expect(200)).body;
    expect(revision.package.cost.approvedUsd).toBe(2); // the new campaign's own budget: a separate, explicitly approved operation
    expect(revision.package.cost.spentUsd).toBeLessThan(2);
    // the earlier campaign keeps its own accounting (campaigns are never merged into one authorization)
    const parent = (await user.agent.get(`/campaigns/${first.campaignId}`).expect(200)).body;
    expect(parent.package.cost.approvedUsd).toBe(3);
    expect((await getF(user, first.id)).usage.budget.approvedUsd).toBe(3);
  });

  it('a run saved BEFORE the shared budget stays readable: its approved total and recorded usage are shown as history; it authorizes nothing new', async () => {
    const { user, projectId, design } = await project('bud-legacy');
    const row = await db.factoryRun.create({
      data: {
        projectId,
        userId: user.id,
        mode: 'fresh',
        status: 'completed',
        configJson: { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 7, textBudgetUsd: 2, confirmedCost: true, settings: null },
        phasesJson: [],
        completedAt: new Date(),
      },
    });
    const v = await getF(user, row.id);
    expect(v.usage.budget).toMatchObject({ source: 'derived', approvedUsd: 7 });
    expect(v.usage.budget.notes.join(' ')).toMatch(/saved before the shared campaign budget existed/);
    expect(v.config).toMatchObject({ workflow: 'legacy', legacyPreset: 'full_production', approvedBudgetUsd: 7 }); // the historical record is not rewritten
    expect(await db.factoryRun.findUnique({ where: { id: row.id } })).toMatchObject({ ledgerJson: null });
    // history is never a new authorization: it cannot start anything
    await startF(user, projectId, design, { approvedBudgetUsd: 0.01 }).expect(422);
  });

  it('tenant isolation: another user cannot see a run\'s budget, cannot cancel it, and cannot read, export or plan for its campaign', async () => {
    const { user, projectId, design } = await project('bud-owner');
    const run = await waitForFactory(user, (await startF(user, projectId, design, { approvedBudgetUsd: 3 }).expect(201)).body.id);
    const stranger = await registerUser(app, 'bud-stranger');
    await configureOpenAi(stranger, KEY, MODEL);
    const before = paid().length;
    await stranger.agent.get(`/factory-runs/${run.id}`).expect(404);
    await stranger.agent.post(`/factory-runs/${run.id}/cancel`).expect(404);
    await stranger.agent.get(`/campaigns/${run.campaignId}`).expect(404);
    await stranger.agent.get(`/campaigns/${run.campaignId}/export`).expect(404);
    await stranger.agent.post(`/projects/${projectId}/factory/preflight`).send({ approvedBudgetUsd: 3 }).expect(404);
    await stranger.agent.post(`/projects/${projectId}/factory`).send({ approvedBudgetUsd: 3, confirmCost: true }).expect(404);
    expect(paid().length).toBe(before);
  });
});
