import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { campaignRequest, confirmedDesign, configureOpenAi, createApp, createProject, registerUser, waitForFactory, type TestUser } from './helpers';

// QUALITY OF THE CAMPAIGN (V4): there is no image model to choose and no image is ever requested (the V3 "Quality First image model" is gone
// with AI image generation). What stays: the free plan shows ONE text-only estimate and ONE campaign budget, nothing starts without that approval,
// the quality work of the Quality Reviewer (review rounds, rubric, bounded repairs) is recorded, the token ceilings reach the runtime, and an
// earlier campaign is never touched. Real Mozaik runtime, fake OpenAI over real HTTP: nothing here is billed.
jest.setTimeout(600_000);

const KEY = 'sk-test-QUALITYFIRST1234567890abcdefghij';
const MODEL = 'gpt-4.1-mini';
// the key also LISTS image models: V4 must ignore them (no image model is ever offered, chosen or called)
const KEY_MODELS = [MODEL, 'gpt-image-1.5', 'gpt-image-2', 'text-embedding-test'];

describe('Quality of the campaign (V4: text-only, one budget, recorded review)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: KEY_MODELS, ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));
  const textCalls = () => fake.requests.filter((r) => r.path.endsWith('/responses'));

  async function readyUser(label: string) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, 'Deep Diving School');
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Deep Diving School', shortDescription: 'Scuba diving courses for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners aged 18 to 35', preferredLanguage: 'en' }).expect(200);
    await configureOpenAi(user, KEY, MODEL);
    const design = await confirmedDesign(user, projectId, 'premium_editorial');
    return { user, projectId, design };
  }
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);

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

  it('the free plan: no image model and no image cost exist (even when the key lists image models); ONE text-only estimate and ONE required budget', async () => {
    const { user, projectId, design } = await readyUser('q-plan');
    const p = (await preflight(user, projectId, { design: { design } }).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.preset).toBeUndefined();
    expect(p.provider).toMatchObject({ id: 'openai', model: MODEL, source: 'settings' });
    expect(p.statement.aiImages).toMatch(/AI-generated images: 0/);
    expect(JSON.stringify(p.cost)).not.toMatch(/gpt-image/);
    expect(JSON.stringify(p.settings)).not.toMatch(/imageModel|imageQuality|approvedImageRequests/);
    expect(p.budget.required).toBe(true);
    expect(p.deliverables.planned).toBeGreaterThan(0);
    expect(paid()).toHaveLength(0); // the preflight is free
  });

  it('a campaign is never started without the ONE approved budget AND the confirmation of the estimate', async () => {
    const { user, projectId, design } = await readyUser('q-budget');
    const none = await startF(user, projectId, { design: { design } }).expect(422);
    expect(none.body.message).toMatch(/approve one campaign budget/);
    await startF(user, projectId, { design: { design }, approvedBudgetUsd: 7 }).expect(422); // approved but not confirmed
    await startF(user, projectId, { design: { design }, confirmCost: true }).expect(422); // confirmed but no amount
    expect(paid()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('FULL RUN: zero image requests, the token ceilings reach the runtime, the quality work is recorded, ONE shared budget, and an earlier campaign is untouched', async () => {
    const { user, projectId, design } = await readyUser('q-full');
    // an earlier campaign of the same project: its saved package must be byte-identical afterwards
    const base = await waitForFactory(user, (await startF(user, projectId, campaignRequest(design, { concepts: 1, channels: ['instagram'] })).expect(201)).body.id);
    expect(base.status).toMatch(/completed|partial/);
    const before = await db.creativeCampaign.findUnique({ where: { id: base.campaignId } });
    const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const beforeHash = hash([before!.packageJson, before!.metadataJson, before!.approvalStatus]);
    await useFake();
    const run = await waitForFactory(user, (await startF(user, projectId, campaignRequest(design, { approvedBudgetUsd: 7, concepts: 2 })).expect(201)).body.id);
    expect(run.status).toMatch(/completed|partial/);
    // the project's Business Research is current, so it is reused; strategy and creative always run for THIS campaign
    expect(run.phases.map((x: any) => [x.code, x.status])).toEqual([['F1', 'reused'], ['F3', 'completed'], ['F4', 'completed']]);
    expect(fake.imageCalls()).toHaveLength(0);

    // token ceilings reached the runtime, never above the model's own limit
    const caps = textCalls().map((r) => Number(r.body?.max_output_tokens)).filter(Boolean);
    expect(Math.max(...caps)).toBeGreaterThanOrEqual(6000);
    expect(Math.max(...caps)).toBeLessThanOrEqual(32_768);

    // the review work really happened and is recorded
    const creative = run.phases.find((p: any) => p.code === 'F4');
    const evTypes = (await db.campaignEvent.findMany({ where: { runId: creative.runId }, select: { eventType: true } })).map((e) => e.eventType);
    expect(evTypes).toContain('review.requested');
    expect(evTypes).toContain('review.completed');
    expect(evTypes).not.toContain('image.generation.requested');
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.quality.reviewRounds).toBeGreaterThanOrEqual(1);
    expect(camp.package.quality.repairRounds).toBeLessThanOrEqual(1); // bounded: at most one repair round
    expect(camp.package.quality.rubric.latest).not.toBeNull();
    expect(camp.package.quality.verdict).toMatch(/review round/);
    expect(run.quality.rubric.criteria.length).toBeGreaterThanOrEqual(6);
    expect(camp.package.imageAssets.filter((a: any) => a.source === 'ai_image')).toHaveLength(0);

    // ONE shared budget: every text call of every stage draws on the same ledger; no image request exists
    expect(run.usage.budget).toMatchObject({ approvedUsd: 7 });
    expect(run.usage.budget.requests.image ?? 0).toBe(0);
    expect(run.usage.budget.remainingUsd).toBeGreaterThan(3);
    expect(run.usage.byPhase.creative.textCalls).toBeGreaterThan(0);
    expect(run.usage.agents.some((a: any) => a.agent === 'Quality Reviewer' && a.calls >= 1)).toBe(true);
    expect(run.usage.agents.some((a: any) => a.agent === 'Content Writer' && a.calls >= 1)).toBe(true);

    // the earlier campaign was not touched
    const after = await db.creativeCampaign.findUnique({ where: { id: base.campaignId } });
    expect(hash([after!.packageJson, after!.metadataJson, after!.approvalStatus])).toBe(beforeHash);
  });
});
