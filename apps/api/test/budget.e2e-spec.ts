import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { fakeImageBase64 } from '@launchpilot/agents/dist/testing/fake-creative';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { configureOpenAi, createApp, registerUser, sleep, type TestUser } from './helpers';

// ONE CAMPAIGN BUDGET: a single amount is the budget of the whole campaign. Every paid request (text agents, images, reviews, repairs) draws
// on the same ledger; there are no text and image pools. The whole F1 -> F4 chain runs on the real Mozaik runtime; only OpenAI is faked
// (over real HTTP). Nothing is billed and no real provider is ever contacted.
jest.setTimeout(600_000);

const KEY = 'sk-test-BUDGETE2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const PRICED = 'gpt-image-1.5';
const UNPRICED = 'gpt-image-2.5-sunburst';
const DESC = 'AI automation platform that helps users create agents for everyday tasks.';
const F1_AGENTS = ['input', 'text', 'web', 'repo', 'files', 'visual', 'synthesizer'];

describe('ONE shared campaign budget', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, PRICED, UNPRICED, 'gpt-image-1-mini', 'text-embedding-test'], ...options }).start();
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
    return { user, projectId };
  }
  const HYBRID = { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: PRICED } };
  const preflight = (u: TestUser, id: string, body: object = {}) => u.agent.post(`/projects/${id}/factory/preflight`).send({ ...HYBRID, ...body });
  const startF = (u: TestUser, id: string, body: object = {}) => u.agent.post(`/projects/${id}/factory`).send({ ...HYBRID, ...body });
  const getF = async (u: TestUser, id: string) => (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
  const waitF = async (u: TestUser, id: string, ms = 420_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await getF(u, id);
      if (!['queued', 'running'].includes(v.status)) return v;
      if (Date.now() > end) throw new Error(`Factory run ${id} still ${v.status} after ${ms} ms`);
      await sleep(150);
    }
  };
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

  it('one $3 budget is compared with the estimate as ONE budget: there are no text and image pools, a client-sent text pool is ignored, and the review is free', async () => {
    const { user, projectId } = await project('bud-pre');
    const p = (await preflight(user, projectId, { approvedBudgetUsd: 3, textBudgetUsd: 2 }).expect(200)).body;
    expect(p.cost.budget).toMatchObject({ approvedUsd: 3 });
    expect(['within', 'may_stop_early']).toContain(p.cost.budget.status);
    expect(p.cost.budget).not.toHaveProperty('pools');
    expect(p.budget).not.toHaveProperty('textBudgetUsd');
    expect(p.settings.textBudgetUsd).toBeNull();
    expect(p.warnings.join(' ')).toMatch(/A separate text budget is no longer used: there is ONE campaign budget/);
    expect(p.budget.shared.note).toMatch(/One campaign budget is shared by the text agents, the images, the reviews and the repairs/);
    expect(p.budget.shared.protectedImagesUsd).toBeGreaterThan(0); // the required originals are protected from optional work
    expect(paid()).toHaveLength(0);
    // the same request through the other presets: still one number
    for (const preset of ['first_test', 'demo', 'full_production']) {
      const o = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({ preset, mode: 'fresh', approvedBudgetUsd: 3, f4: { imageModel: PRICED } }).expect(200)).body;
      expect(o.cost.budget).not.toHaveProperty('pools');
      expect(o.cost.budget.approvedUsd).toBe(3);
    }
    expect(paid()).toHaveLength(0);
  });

  it('a small budget never silently reduces the campaign: the plan keeps its creative counts and says the budget is too small, with the options to choose from', async () => {
    const { user, projectId } = await project('bud-counts');
    const p = (await preflight(user, projectId, { approvedBudgetUsd: 0.05 }).expect(200)).body;
    expect(p.cost.budget.status).toBe('below_estimate');
    expect(p.hybrid.originals.planned).toBe(5);
    expect(p.hybrid.templateCreatives.planned).toBe(15);
    expect(p.totals.imageRequests).toBe(5);
    expect(p.budget.imageRequestCap).toBe(5);
    expect(p.cost.budget.options.map((o: { id: string }) => o.id)).toContain('raise_budget');
    // and it cannot be started (nothing was changed on the user's behalf)
    await startF(user, projectId, { approvedBudgetUsd: 0.05, confirmCost: true }).expect(422);
    expect(paid()).toHaveLength(0);
  });

  // ---- text and images share ONE ledger --------------------------------------------------------------------------------------------

  it('a $3 budget covers text AND images: both draw on one ledger, unused money stays available, and every counter reconciles (also after a refresh)', async () => {
    const { user, projectId } = await project('bud-run');
    const started = await startF(user, projectId, { approvedBudgetUsd: 3, confirmCost: true }).expect(201);
    const run = await waitF(user, started.body.id);
    expect(run.status).toBe('completed');
    const b = run.usage.budget;
    expect(b).toMatchObject({ source: 'saved', approvedUsd: 3, remainingBasis: 'exact', legacy: null, reservedUsd: 0 });
    expect(b.requests.image).toBe(5);
    expect(b.requests.imageCap).toBe(5);
    expect(b.requests.text).toBe(texts().length);
    expect(images()).toHaveLength(5);
    // the images really cost what the provider reported (40 input + 1056 output tokens each at the gpt-image-1.5 rates), not what was reserved
    expect(Math.abs(b.breakdown.imagesUsd - 5 * 0.033992)).toBeLessThan(1e-5);
    expect(Math.abs(b.breakdown.agentsUsd + b.breakdown.imagesUsd + b.breakdown.reviewsUsd - (b.knownUsd + b.estimatedUsd))).toBeLessThan(1e-5);
    expect(Math.abs(b.committedUsd - sum(b))).toBeLessThan(1e-6);
    expect(Math.abs(b.remainingUsd - (3 - b.committedUsd))).toBeLessThan(1e-6);
    expect(b.remainingUsd).toBeGreaterThan(2.5); // text cost cents: the rest of the $3 is simply still available
    // it is the same shared ledger in every phase report and in the campaign
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.cost.approvedUsd).toBe(3);
    // refresh: the saved ledger is what a new page load shows
    const again = await getF(user, run.id);
    expect(again.usage.budget).toEqual(b);
    const row = await db.factoryRun.findUnique({ where: { id: run.id } });
    expect(row?.ledgerJson).toMatchObject({ approvedUsd: 3, requests: { image: 5, imageCap: 5 } });
    expect(row?.configJson).toMatchObject({ approvedBudgetUsd: 3, sharedBudget: true, imageRequestCap: 5 });
    expect(row?.configJson).not.toHaveProperty('textBudgetUsd');
  });

  it('First Test and Demo stay compatible: no budget is required (usage is measured, "no limit"), and a budget that is given is the one enforced', async () => {
    const { user, projectId } = await project('bud-compat');
    const first = await waitF(user, (await startF(user, projectId, { preset: 'first_test', f4: undefined }).expect(201)).body.id);
    expect(first.status).toMatch(/completed|partial/);
    expect(first.usage.budget).toMatchObject({ approvedUsd: null, remainingBasis: 'uncapped', source: 'saved' });
    expect(first.usage.budget.requests.text).toBeGreaterThan(5);
    const demo = await waitF(user, (await startF(user, projectId, { preset: 'demo', approvedBudgetUsd: 2, f4: undefined }).expect(201)).body.id);
    expect(demo.status).toMatch(/completed|partial/);
    expect(demo.usage.budget).toMatchObject({ approvedUsd: 2, legacy: null });
    expect(demo.usage.budget.committedUsd).toBeLessThanOrEqual(2);
  });

  // ---- exhaustion, uncertainty, cancellation -------------------------------------------------------------------------------------

  it('when the shared budget runs out the run stops BEFORE the next request that does not fit: finished work is kept, the shortfall is reported, the total is never exceeded', async () => {
    // every text call reports 100k input tokens (about $0.04 each): far more than the estimate assumed, so the budget is used up mid-campaign
    await useFake({ reply: (r: FakeRequest) => (r.path.endsWith('/responses') ? { usage: { input: 100_000, output: 80 } } : undefined) });
    const { user, projectId } = await project('bud-exhaust');
    const started = await startF(user, projectId, { approvedBudgetUsd: 1, confirmCost: true });
    expect(started.status).toBe(201); // $1 covers the ESTIMATE (it assumes ordinary token volumes), so it starts; the real usage below is far larger
    const run = await waitF(user, started.body.id);
    expect(['failed', 'partial']).toContain(run.status); // the budget cannot pay for the whole chain: it stops or delivers a partial campaign, it never overspends
    const b = run.usage.budget;
    expect(b.committedUsd).toBeLessThanOrEqual(1 + 1e-6); // never knowingly beyond the approved total
    expect(b.reservedUsd).toBe(0);
    expect(b.blocked + b.deferred).toBeGreaterThan(0);
    expect(b.refusals.length).toBeGreaterThan(0);
    expect(b.refusals.join(' ')).toMatch(/campaign budget did not start/);
    // essential analysis outranks the images, so the text phases finished; the required images that no longer fit are reported, never claimed as done
    expect(run.status).toBe('partial');
    expect(run.errorMessage).toMatch(/original AI images were generated .*stopped by a budget/);
    expect(run.errorMessage).toMatch(/Generate the missing images/); // the way to finish without repeating the research
    expect(run.phases.map((p: { status: string }) => p.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(images().length).toBeLessThan(5);
    expect(b.requests.image).toBe(images().length); // nothing was sent that did not fit
    // nothing was requested after the budget said no: the text requests are bounded by what fits
    expect(texts().length).toBeLessThan(40);
    expect(b.remainingUsd).toBeLessThan(1);
  });

  it('images of a model without a published price that report no usage are UNKNOWN in the budget, never $0; the remaining figure says it is not exact', async () => {
    const b64 = await fakeImageBase64('1024x1536');
    await useFake({ reply: (r: FakeRequest) => (r.kind === 'image' ? { json: { created: 1, data: [{ b64_json: b64 }] } } : undefined) }); // no usage field at all
    const { user, projectId } = await project('bud-unknown');
    const started = await startF(user, projectId, { f4: { imageModel: UNPRICED }, approvedBudgetUsd: 3, confirmCost: true, approvedImageRequests: 5 }).expect(201);
    const run = await waitF(user, started.body.id);
    expect(run.status).toMatch(/completed|partial/);
    const b = run.usage.budget;
    expect(b.requests.image).toBe(5);
    expect(b.unknownCostRequests).toBe(5);
    expect(b.remainingBasis).toBe('unknown');
    expect(b.breakdown.imagesUsd).toBeNull(); // "unknown", not 0
    expect(b.notes.join(' ')).toMatch(/finished without a known price, so their cost is NOT included/);
    expect(b.knownUsd).toBeLessThan(0.05); // only the text is known
  });

  it('cancelling a run leaves no reservation held: what was in flight stays as uncertain spend and the saved ledger says so', async () => {
    await useFake({ reply: (r: FakeRequest) => (F1_AGENTS.includes(r.agent) ? { hang: true } : undefined) });
    const { user, projectId } = await project('bud-cancel');
    const started = (await startF(user, projectId, { approvedBudgetUsd: 3, confirmCost: true }).expect(201)).body;
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

  // ---- continuation, history, isolation ---------------------------------------------------------------------------------------------

  it('"Generate the missing images" uses ONE budget of its own: only the missing images are requested, the research is not paid for again, and the earlier campaign is untouched', async () => {
    // two images fail in the first campaign
    await useFake({ reply: (r: FakeRequest) => (r.kind === 'image' && [2, 4].includes(r.attempt) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Rejected.' } } } : undefined) });
    const { user, projectId } = await project('bud-cont');
    const first = await waitF(user, (await startF(user, projectId, { approvedBudgetUsd: 3, confirmCost: true }).expect(201)).body.id);
    expect(first.status).toBe('partial');
    expect(first.usage.budget.requests.image).toBe(5);
    await useFake();
    const textBefore = texts().length;
    const pre = (await user.agent.post(`/campaigns/${first.campaignId}/continue-images/preflight`).send({ approvedBudgetUsd: 1 }).expect(200)).body;
    expect(pre).toMatchObject({ ok: true, willRequest: 2, mustConfirm: true });
    expect(pre.cost.budget).not.toHaveProperty('pools');
    expect(pre.cost.budget.approvedUsd).toBe(1);
    expect(paid()).toHaveLength(0); // reviewing is free
    await user.agent.post(`/campaigns/${first.campaignId}/continue-images`).send({}).expect(422); // billed images need ONE budget and ONE confirmation
    await user.agent.post(`/campaigns/${first.campaignId}/continue-images`).send({ approvedBudgetUsd: 1 }).expect(422);
    const started = (await user.agent.post(`/campaigns/${first.campaignId}/continue-images`).send({ approvedBudgetUsd: 1, confirmCost: true }).expect(201)).body;
    let row: any;
    for (let i = 0; i < 1500; i++) {
      row = (await user.agent.get(`/runs/${started.id}`).expect(200)).body;
      if (row.status !== 'RUNNING') break;
      await sleep(150);
    }
    expect(row.status).toBe('COMPLETED');
    expect(images()).toHaveLength(2); // only the missing ones
    let revision: any;
    for (let i = 0; i < 400; i++) {
      revision = (await user.agent.get(`/campaigns/${row.campaignId}`).expect(200)).body;
      if (revision.status !== 'running') break;
      await sleep(150);
    }
    expect(revision.package.lineage).toMatchObject({ kind: 'image_continuation', parentCampaignId: first.campaignId });
    expect(revision.package.cost.approvedUsd).toBe(1); // the continuation's own budget: a separate, explicitly approved operation
    expect(revision.package.cost.spentUsd).toBeLessThan(1);
    expect(revision.package.imageCounts.generated).toBe(5);
    expect(revision.package.hybrid.counts.total).toEqual({ planned: 20, delivered: 20 });
    expect(texts().length - textBefore).toBeLessThan(12); // no F1-F3 and no copy again
    // the earlier campaign keeps its own accounting (revisions are never merged into one authorization)
    const parent = (await user.agent.get(`/campaigns/${first.campaignId}`).expect(200)).body;
    expect(parent.package.cost.approvedUsd).toBe(3);
  });

  it('a run saved BEFORE the shared budget stays readable: its approved total and recorded usage are shown, its old text/image amounts are history only', async () => {
    const { user, projectId } = await project('bud-legacy');
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
    expect(v.usage.budget).toMatchObject({ source: 'derived', approvedUsd: 7, legacy: { textPoolUsd: 2, imagePoolUsd: 5 } });
    expect(v.usage.budget.legacy.note).toMatch(/not a spending permission for anything new/);
    expect(v.usage.budget.notes.join(' ')).toMatch(/saved before the shared campaign budget existed/);
    expect(v.config.textBudgetUsd).toBe(2); // the historical record is not rewritten
    expect(await db.factoryRun.findUnique({ where: { id: row.id } })).toMatchObject({ ledgerJson: null });
    // history is never a new authorization: it cannot start anything
    await startF(user, projectId, { approvedBudgetUsd: 0.01 }).expect(422);
  });

  it('tenant isolation: another user cannot see a run\'s budget, cannot cancel it, and cannot continue or review its campaign', async () => {
    const { user, projectId } = await project('bud-owner');
    const run = await waitF(user, (await startF(user, projectId, { approvedBudgetUsd: 3, confirmCost: true }).expect(201)).body.id);
    const stranger = await registerUser(app, 'bud-stranger');
    await configureOpenAi(stranger, KEY, MODEL);
    const before = paid().length;
    await stranger.agent.get(`/factory-runs/${run.id}`).expect(404);
    await stranger.agent.post(`/factory-runs/${run.id}/cancel`).expect(404);
    await stranger.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({}).expect(404);
    await stranger.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 1, confirmCost: true }).expect(404);
    await stranger.agent.post(`/projects/${projectId}/factory/preflight`).send({ ...HYBRID, approvedBudgetUsd: 3 }).expect(404);
    expect(paid().length).toBe(before);
  });
});
