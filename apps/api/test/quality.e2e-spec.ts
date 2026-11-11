import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';

// QUALITY FIRST: the image model is chosen by capability for Full Production (and still cheapest-first for First Test and Demo), the
// choice is shown before anything runs and is carried through the whole campaign; image prompts are creative briefs; text and image
// ONE shared campaign budget; the quality work (concept critique, rubric, deterministic repairs) is recorded. Real Mozaik runtime, fake OpenAI
// over real HTTP: nothing here is billed.
jest.setTimeout(600_000);

const KEY = 'sk-test-QUALITYFIRST1234567890abcdefghij';
const MODEL = 'gpt-4.1-mini';
const KEY_MODELS = [MODEL, 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08', 'chatgpt-image-latest', 'text-embedding-test'];

describe('Quality First image model and the quality of the campaign', () => {
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
    return { user, projectId };
  }
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);
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

  it('Full Production defaults to QUALITY FIRST: the most capable current model of the key, shown before anything runs, labelled unverified, with its price marked unknown', async () => {
    const { user, projectId } = await readyUser('q-default');
    const p = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh' }).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.settings.f4.imageModelStrategy).toBe('quality');
    expect(p.settings.f4.imageQuality).toBe('high');
    expect(p.models.image).toMatchObject({ id: 'gpt-image-2.5-sunburst', requested: 'auto', mode: 'auto', strategy: 'quality', verification: 'listed_not_tested', available: true, priceKnown: false, requiresPriceConfirmation: false, pricing: 'unavailable' });
    expect(p.models.image.reason).toMatch(/most capable model for image generation and editing/);
    expect(p.models.image.alternatives.slice(0, 3)).toEqual(['gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5']);
    expect(p.models.image.alternatives).not.toContain('gpt-image-1'); // retired
    expect(p.models.image.alternatives).not.toContain('chatgpt-image-latest'); // not a model this adapter can call
    expect(p.models.image.documented.qualities).toContain('xhigh');
    expect(p.models.image.note).toMatch(/does not prove your account may use the model/);
    // honest money: unavailable image price, a clearly labelled reference, never a guarantee
    expect(p.cost.images).toMatchObject({ model: 'gpt-image-2.5-sunburst', quality: 'high', count: 20, basis: 'unavailable', typicalUsd: null });
    expect(p.cost.images.reference).toMatchObject({ model: 'gpt-image-2' });
    expect(p.cost.images.reference.note).toMatch(/NOT an estimate/);
    expect(p.cost.available).toBe(false);
    expect(p.cost.totals.typicalUsd).toBeNull();
    expect(p.warnings.join(' ')).toMatch(/Image pricing is not available for gpt-image-2\.5-sunburst/);
    expect(p.warnings.join(' ')).toMatch(/application-level spending target, not a guaranteed billing cap/);
    expect(p.budget).toMatchObject({ unpricedImagesConfirmationNeeded: false, imageRequestsApprovedWithBudget: true, imageRequestCap: 20, depth: true });
    expect(p.budget).not.toHaveProperty('textBudgetUsd');
    expect(paid()).toHaveLength(0); // the preflight is free
  });

  it('First Test and Demo keep the economical automatic choice; an explicit model is preserved; retired and unsupported choices are refused before anything is spent', async () => {
    const { user, projectId } = await readyUser('q-others');
    for (const preset of ['first_test', 'demo']) {
      const p = (await preflight(user, projectId, { preset, mode: 'fresh' }).expect(200)).body;
      expect(p.models.image).toMatchObject({ id: 'gpt-image-1-mini', strategy: 'economy', mode: 'auto' });
      expect(p.settings.f4.imageModelStrategy).toBe('economy');
      expect(p.models.image.priceKnown).toBe(true);
    }
    // an explicit model is never overridden by the strategy
    const explicit = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: 'gpt-image-1.5' } }).expect(200)).body;
    expect(explicit.models.image).toMatchObject({ id: 'gpt-image-1.5', requested: 'gpt-image-1.5', mode: 'explicit', strategy: null });
    // the strategy can be chosen without naming a model
    const bal = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModelStrategy: 'balanced' } }).expect(200)).body;
    expect(bal.models.image).toMatchObject({ id: 'gpt-image-2', strategy: 'balanced' });
    // retired and wrong-quality choices are refused with the reason
    const retired = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: 'gpt-image-1' } }).expect(200)).body;
    expect(retired.ok).toBe(false);
    expect(retired.blockers.map((b: any) => b.code)).toContain('image_model_retired');
    const badQuality = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: 'gpt-image-1.5', imageQuality: 'xhigh' } }).expect(200)).body;
    expect(badQuality.ok).toBe(false);
    expect(badQuality.blockers.map((b: any) => b.code)).toContain('image_quality_unsupported');
    const goodQuality = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'xhigh' } }).expect(200)).body;
    expect(goodQuality.ok).toBe(true);
    expect(paid()).toHaveLength(0);
  });

  it('an image model with an unpublished price is never started without the ONE approval naming the maximum image requests', async () => {
    const { user, projectId } = await readyUser('q-unpriced');
    const body = { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 7, confirmCost: true };
    const r = await startF(user, projectId, body).expect(422);
    expect(r.body.message).toMatch(/Image pricing is not available for gpt-image-2\.5-sunburst/);
    expect(paid()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('FULL RUN with the quality-first model: every one of the 20 requests uses it at the chosen quality, prompts are creative briefs, ONE shared budget, quality work is recorded, and an earlier campaign is untouched', async () => {
    const { user, projectId } = await readyUser('q-full');
    // an earlier campaign of the same project: its saved package must be byte-identical afterwards
    const base = await waitF(user, (await startF(user, projectId, { preset: 'first_test', mode: 'fresh' }).expect(201)).body.id);
    expect(base.status).toMatch(/completed|partial/);
    const before = await db.creativeCampaign.findUnique({ where: { id: base.campaignId } });
    const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
    const beforeHash = hash([before!.packageJson, before!.metadataJson, before!.approvalStatus]);
    await useFake();
    const ask = { preset: 'full_production', mode: 'continue', rerunCreative: true, approvedBudgetUsd: 7, confirmCost: true, approvedImageRequests: 20 };
    const run = await waitF(user, (await startF(user, projectId, ask).expect(201)).body.id);
    expect(run.status).toMatch(/completed|partial/);
    expect(run.phases.map((x: any) => x.status)).toEqual(['reused', 'reused', 'reused', 'completed']);

    // the selected model is carried through F4: 20 requests, all with it, all at 'high', each with its own brief-style prompt
    const calls = fake.imageCalls();
    expect(calls).toHaveLength(20);
    expect(calls.every((c) => c.body?.model === 'gpt-image-2.5-sunburst' && c.body?.quality === 'high')).toBe(true);
    const prompts = calls.map((c) => String(c.body?.prompt));
    expect(new Set(prompts).size).toBe(20);
    for (const part of ['CONCEPTUAL MARKETING VISUAL', 'CAMPAIGN GOAL:', 'AUDIENCE:', 'BRAND IDENTITY:', 'CREATIVE CONCEPT', 'THIS IMAGE:', 'MEDIUM AND STYLE:', 'SUBJECT:', 'SETTING:', 'FOCAL POINT:', 'COMPOSITION:', 'LIGHT AND MOOD:', 'PLACEMENT:', 'CONSTRAINTS:']) {
      expect(prompts.every((x) => x.includes(part))).toBe(true);
    }
    expect(new Set(prompts.map((x) => /SUBJECT: (.*)/.exec(x)?.[1])).size).toBe(20);
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.imageVariations.every((v: any) => v.providerModel === 'gpt-image-2.5-sunburst' && v.quality === 'high')).toBe(true);
    expect(camp.assets.filter((a: any) => a.source === 'ai_image').every((a: any) => a.model === 'gpt-image-2.5-sunburst')).toBe(true);

    // token budgets reached the runtime: the preset's 6000-token ceiling was really sent, never above the model's own limit
    const caps = textCalls().map((r) => Number(r.body?.max_output_tokens)).filter(Boolean);
    expect(Math.max(...caps)).toBeGreaterThanOrEqual(6000);
    expect(Math.max(...caps)).toBeLessThanOrEqual(32_768);

    // the depth work really happened and is recorded
    const evTypes = (await db.campaignEvent.findMany({ where: { runId: run.phases[3].runId }, select: { eventType: true } })).map((e) => e.eventType);
    expect(evTypes).toContain('concept.review.requested');
    expect(evTypes).toContain('concept.review.completed');
    expect(camp.package.quality.conceptCritique).toMatchObject({ ran: true, modelReview: 'done' });
    expect(camp.package.quality.reviewRounds).toBeGreaterThanOrEqual(1);
    expect(camp.package.quality.rubric.latest).not.toBeNull();
    expect(camp.package.quality.verdict).toMatch(/review round/);
    expect(run.quality.rubric.criteria).toHaveLength(6);

    // ONE shared budget: text and images draw on the same ledger; what is not needed is simply not spent
    const spend = (await db.creativeCampaign.findUnique({ where: { id: run.campaignId } }))!.metadataJson as any;
    expect(spend.usage.spend.approvedUsd).toBe(7);
    expect(spend.usage.spend).not.toHaveProperty('caps');
    expect(spend.usage.spend.text.spentUsd + spend.usage.spend.image.spentUsd).toBeLessThanOrEqual(7);
    expect(run.usage.budget).toMatchObject({ approvedUsd: 7, legacy: null });
    expect(run.usage.budget).not.toHaveProperty('textPoolUsd');
    expect(run.usage.budget.requests).toMatchObject({ image: 20, imageCap: 20 });
    expect(run.usage.budget.remainingUsd).toBeGreaterThan(3);
    expect(run.usage.byPhase.creative.textCalls).toBeGreaterThan(0);
    expect(run.usage.agents.some((a: any) => a.agent === 'Content & Brand Reviewer' && a.calls >= 1)).toBe(true);

    // the earlier campaign was not touched
    const after = await db.creativeCampaign.findUnique({ where: { id: base.campaignId } });
    expect(hash([after!.packageJson, after!.metadataJson, after!.approvalStatus])).toBe(beforeHash);
  });

  it('the direct F4 start and the image continuation also require the image-request maximum inside the one approval', async () => {
    const { user, projectId } = await readyUser('q-direct');
    const chain = await waitF(user, (await startF(user, projectId, { preset: 'first_test', mode: 'fresh' }).expect(201)).body.id);
    expect(chain.status).toMatch(/completed|partial/);
    const before = paid().length;
    const r = await user.agent.post(`/projects/${projectId}/runs/creative-production`).send({ imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'high', variations: true, maxImages: 4, concepts: 2, approvedBudgetUsd: 5 }).expect(422);
    expect(r.body.message).toMatch(/Image pricing is not available for gpt-image-2\.5-sunburst/);
    expect(paid().length).toBe(before);
    // the run view exposes what was confirmed
    const withConfirm = await waitF(user, (await startF(user, projectId, { preset: 'full_production', mode: 'continue', rerunCreative: true, approvedBudgetUsd: 7, confirmCost: true, approvedImageRequests: 4, f4: { maxImages: 4, concepts: 2 } }).expect(201)).body.id);
    expect(withConfirm.config).toMatchObject({ confirmedUnpricedImages: true, approvedBudgetUsd: 7 });
    expect(withConfirm.config.textBudgetUsd).toBeNull();
  });

  it('a failed paid image request never switches the model on its own', async () => {
    await useFake({ reply: (r) => (r.kind === 'image' ? { status: 403, json: { error: { code: 'permission_denied', message: 'Your organization must be verified to use gpt-image-2.5-sunburst.' } } } : undefined) });
    const { user, projectId } = await readyUser('q-nofallback');
    const run = await waitF(user, (await startF(user, projectId, { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 7, confirmCost: true, approvedImageRequests: 20 }).expect(201)).body.id);
    expect(run.status).toBe('partial');
    const models = new Set(fake.imageCalls().map((c) => c.body?.model));
    expect([...models]).toEqual(['gpt-image-2.5-sunburst']); // not a single request with another model
    expect(fake.imageCalls().length).toBeLessThanOrEqual(3); // a systematic error stops the paid requests
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.imageCounts.generated).toBe(0);
    expect(camp.package.imageVariations.some((v: any) => /organization verification/.test(v.explanation ?? ''))).toBe(true);
  });
});
