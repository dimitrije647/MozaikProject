import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';

// FULL PRODUCTION: 20 original AI images, intelligently allocated, with an honest cost estimate, an approved spending limit and an
// image-only continuation. The whole F1 -> F2 -> F3 -> F4 chain runs on the real Mozaik runtime; only OpenAI (text and images) is faked,
// over real HTTP. Nothing is billed and no image comes from a real model.
jest.setTimeout(600_000);

const KEY = 'sk-test-PRODUCTION1234567890abcdefghij';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1.5'; // priced in the price book; not subject to the announced shutdowns of gpt-image-1(-mini)
const F1_AGENTS = ['input', 'text', 'web', 'repo', 'files', 'visual', 'synthesizer'];
const F2_AGENTS = ['seo', 'social', 'brand', 'messaging', 'presence', 'auditor'];
const F3_AGENTS = ['audience', 'competitor', 'seasonal', 'scout', 'strategist'];

describe('Full Production (20 original AI images)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, IMAGE, 'gpt-image-1-mini', 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const textCalls = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));

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
  const waitCampaign = async (u: TestUser, id: string, ms = 300_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const c = (await u.agent.get(`/campaigns/${id}`).expect(200)).body;
      if (c.status !== 'running') return c;
      if (Date.now() > end) throw new Error('campaign still running');
      await sleep(150);
    }
  };
  // ONE campaign budget of $7 for text, images and reviews together (the quality-first preset asks for 'high' images)
const FULL = { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 7, confirmCost: true, f4: { imageModel: IMAGE } };
  const failingImage = (match: RegExp): FakeOpenAIOptions['reply'] => (r: FakeRequest): FakeReply | undefined => (r.kind === 'image' && match.test(String(r.body?.prompt)) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Rejected by the safety system.' } } } : undefined);

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

  it('the new preset appears; First Test and Demo keep exactly their settings', async () => {
    const { user } = await readyUser('prod-presets');
    const { presets, default: def } = (await user.agent.get('/factory/presets').expect(200)).body;
    expect(def).toBe('first_test');
    expect(Object.keys(presets)).toEqual(['first_test', 'demo', 'full_production', 'hybrid_production', 'no_ai_hybrid']);
    expect(presets.first_test.f4).toMatchObject({ concepts: 1, maxImages: 1, variations: false, maxModelCalls: 12, maxRepairRounds: 2 });
    expect(presets.demo.f4).toMatchObject({ concepts: 3, maxImages: 3, variations: false, maxModelCalls: 16, visionReviews: 2 });
    expect(presets.demo.f3).toMatchObject({ maxModelCalls: 24, maxScouts: 4 });
    expect(presets.full_production.f4).toMatchObject({ concepts: 5, maxImages: 20, variations: true, layoutsPerOriginal: 3, imageConcurrency: 3, maxRepairRounds: 3, maxModelCalls: 60, imageModel: 'auto', maxRegenerations: 0 });
    expect(presets.full_production.f1.maxModelCalls).toBe(25);
    expect(presets.full_production.f2.maxModelCalls).toBe(25);
    expect(presets.full_production.f3).toMatchObject({ maxModelCalls: 30, maxScouts: 6 });
  });

  it('PREFLIGHT shows 20 originals over the concepts, the token budgets and an honest cost estimate, and spends nothing', async () => {
    const { user, projectId } = await readyUser('prod-pre');
    const p = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.preset).toBe('full_production');
    expect(p.models.text).toMatchObject({ id: MODEL, source: 'saved' });
    expect(p.models.image).toMatchObject({ id: IMAGE, requested: IMAGE, mode: 'explicit', quality: 'high', strategySetting: 'quality' });
    expect(p.imagePlan).toMatchObject({ variations: true, originalsTarget: 20, allocated: 20, conceptsRequested: 5, plannedRequests: 20 });
    expect(p.allocation).toMatchObject({ target: 20, allocated: 20, basis: 'forecast' });
    expect(p.allocation.perConcept).toHaveLength(5);
    expect(p.allocation.perConcept.reduce((n: number, c: any) => n + c.count, 0)).toBe(20);
    expect(p.allocation.variations).toHaveLength(20);
    expect(p.imagePlan.expectedLayouts).toBe(p.allocation.expectedLayouts);
    expect(p.imagePlan.expectedLayouts).toBeGreaterThan(20);
    expect(p.totals).toMatchObject({ imageRequests: 20, imageRegenerationCap: 0 });
    // token budgets per phase, with the model's real output limit (verified for gpt-4.1-mini)
    expect(p.tokenBudgets.map((t: any) => [t.code, t.maxModelCalls, t.outputTokens])).toEqual([['F1', 25, 6000], ['F2', 25, 6000], ['F3', 30, 6000], ['F4', 60, 6000]]);
    expect(p.tokenBudgets[0].modelLimit).toEqual({ limit: 32768, verified: true });
    // the estimate: text per phase, images 20 x the price book figure, a total, the date of the prices and what it is built on
    expect(p.cost.currency).toBe('USD');
    expect(p.cost.priceBookVerifiedAt).toBe('2026-10-31');
    expect(p.cost.available).toBe(true);
    expect(p.cost.images).toMatchObject({ model: IMAGE, quality: 'high', count: 20, basis: 'per_image_table' });
    expect(p.cost.images.typicalUsd).toBeGreaterThan(2.5); // high-quality images are NOT sized to fit $5: the estimate says so
    expect(p.cost.images.typicalUsd).toBeLessThan(4.5);
    expect(p.cost.text.phases).toHaveLength(4);
    expect(p.cost.totals.typicalUsd).toBeCloseTo(p.cost.text.typicalUsd + p.cost.images.typicalUsd, 3);
    expect(p.cost.totals.maxUsd).toBeGreaterThanOrEqual(p.cost.totals.typicalUsd);
    expect(p.cost.assumptions.length).toBeGreaterThan(0);
    expect(p.cost.budget).toMatchObject({ targetUsd: 5, approvedUsd: null, status: 'no_budget' });
    expect(p.cost.budget).not.toHaveProperty('pools'); // one budget: no text/image split exists any more
    expect(p.budget).toMatchObject({ depth: true, unpricedImagesConfirmationNeeded: false });
    expect(p.budget).not.toHaveProperty('textBudgetUsd');
    expect(p.budget.shared.note).toMatch(/One campaign budget is shared/);
    expect(p.budget).toMatchObject({ required: true, consentNeeded: true });
    expect(p.warnings.join(' ')).toMatch(/shut down gpt-4\.1-mini on 2027-01-14/);
    expect(p.pricing.note).toMatch(/not an OpenAI billing cap/);
    // free: only the model list was asked
    expect(paid()).toHaveLength(0);
  });

  it('a limit below the estimate is explained with four explicit choices and nothing is changed for the user', async () => {
    const { user, projectId } = await readyUser('prod-opts');
    const p = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 0.4, f4: { imageQuality: 'high' } }).expect(200)).body;
    expect(p.cost.budget.status).toBe('below_estimate');
    const ids = p.cost.budget.options.map((o: any) => o.id);
    expect(ids).toContain('raise_budget');
    expect(ids).toContain('lower_quality');
    expect(ids).toContain('fewer_images');
    const fewer = p.cost.budget.options.find((o: any) => o.id === 'fewer_images');
    expect(fewer.set.maxImages).toBeLessThan(20);
    expect(p.imagePlan.originalsTarget).toBe(20); // never reduced silently
    expect(p.settings.f4.maxImages).toBe(20);
    expect(paid()).toHaveLength(0);
  });

  it('nothing is paid for without an approved limit AND a confirmation; a limit below the estimate is refused', async () => {
    const { user, projectId } = await readyUser('prod-consent');
    const noBudget = await startF(user, projectId, { preset: 'full_production', mode: 'fresh' }).expect(422);
    expect(noBudget.body.message).toMatch(/approve a spending limit/);
    await startF(user, projectId, { preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 5 }).expect(422);
    await startF(user, projectId, { preset: 'full_production', mode: 'fresh', confirmCost: true }).expect(422);
    const low = await startF(user, projectId, { ...FULL, approvedBudgetUsd: 0.3 }).expect(422);
    expect(low.body.message).toMatch(/below the typical estimate/);
    expect(paid()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
    // the same plan on the cheapest preset needs no approval (unchanged behaviour)
    expect((await startF(user, projectId, { preset: 'first_test', mode: 'fresh' }).expect(201)).body.status).toMatch(/queued|running/);
    await waitF(user, (await user.agent.get(`/projects/${projectId}/factory-runs`).expect(200)).body[0].id);
  });

  it('FULL RUN: F1 -> F4 with exactly 20 original AI images, cost accounted, ZIP complete, persistent; then ownership is enforced', async () => {
    const { user, projectId } = await readyUser('prod-full');
    const started = (await startF(user, projectId, FULL).expect(201)).body;
    // one factory run per project at a time (concurrent starts are refused, never doubled)
    await startF(user, projectId, FULL).expect(409);
    const run = await waitF(user, started.id);
    expect(run.status).toBe('completed');
    expect(run.config).toMatchObject({ preset: 'full_production', approvedBudgetUsd: 7 });
    expect(run.config.allocation.target).toBe(20);
    expect(run.phases.map((p: any) => p.status)).toEqual(['completed', 'completed', 'completed', 'completed']);

    // the text limits of the preset were really applied, and no phase used more calls than its cap
    const used = (agents: string[]) => textCalls().filter((r) => agents.includes(r.agent)).length;
    expect(used(F1_AGENTS)).toBeLessThanOrEqual(25);
    expect(used(F2_AGENTS)).toBeLessThanOrEqual(25);
    expect(used(F3_AGENTS)).toBeLessThanOrEqual(30);
    expect(used(['copywriter', 'landing', 'vcreator', 'creviewer'])).toBeLessThanOrEqual(60);

    // exactly 20 image requests, 20 different prompts, 20 stored originals
    expect(fake.imageCalls()).toHaveLength(20);
    expect(new Set(fake.imageCalls().map((c) => String(c.body?.prompt))).size).toBe(20);
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const pkg = camp.package;
    expect(pkg.imageCounts).toEqual({ requested: 20, planned: 20, attempted: 20, generated: 20, failed: 0, skipped: 0, blockedByBudget: 0 });
    expect(pkg.imageAllocation.allocated).toBe(20);
    expect(pkg.imageVariations).toHaveLength(20);
    expect(new Set(pkg.imageVariations.map((v: any) => v.generatedAssetId)).size).toBe(20);
    expect(pkg.imageVariations.every((v: any) => v.status === 'generated' && v.providerModel === IMAGE && v.imagePrompt.length > 50)).toBe(true);
    const originals = camp.assets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image');
    expect(originals).toHaveLength(20);
    expect(new Set(originals.map((a: any) => a.sha256)).size).toBe(20);
    expect(originals.every((a: any) => !!a.variationId && !!a.url)).toBe(true);
    // layouts are cut from the originals and name them
    expect(pkg.channelLayouts.length).toBeGreaterThan(20);
    const ids = new Set(originals.map((a: any) => a.id));
    expect(pkg.channelLayouts.every((l: any) => ids.has(l.baseAssetId) && !!l.variationId)).toBe(true);
    expect(camp.imageCounts.generated).toBe(20);
    expect(camp.imageTarget).toBe(20);

    // cost: real, accounted next to the ONE approved campaign budget (an application-side figure)
    expect(pkg.cost.approvedUsd).toBe(7);
    // every phase reserved from the SAME ledger: what each report recorded adds up to what the campaign ledger knows
    const known = (row: { metadataJson: unknown } | null) => (((row?.metadataJson as any)?.usage?.spend?.knownUsd ?? 0) as number) + (((row?.metadataJson as any)?.usage?.spend?.estimatedUsd ?? 0) as number);
    const [f1row, f2row, f3row] = await Promise.all([db.productDiscoveryReport.findFirst({ where: { projectId } }), db.marketingAuditReport.findFirst({ where: { projectId } }), db.marketingStrategyReport.findFirst({ where: { projectId } })]);
    for (const row of [f1row, f2row, f3row]) expect((row!.metadataJson as any).usage.spend.approvedUsd).toBe(7); // each phase sees the whole budget, not a slice of it
    const perPhase = known(f1row) + known(f2row) + known(f3row) + pkg.cost.spentUsd;
    expect(run.usage.budget).toMatchObject({ source: 'saved', approvedUsd: 7, remainingBasis: 'exact', legacy: null });
    expect(Math.abs(run.usage.budget.knownUsd + run.usage.budget.estimatedUsd - perPhase)).toBeLessThan(1e-4);
    expect(run.usage.budget.reservedUsd).toBe(0);
    expect(Math.abs(run.usage.budget.remainingUsd - (7 - run.usage.budget.committedUsd))).toBeLessThan(1e-6);
    expect(run.usage.budget.requests).toMatchObject({ image: 20, imageCap: 20 });
    expect(run.usage.budget.requests.text).toBeGreaterThan(20);
    expect(run.usage.budget.remainingUsd).toBeGreaterThan(5); // most of the budget is simply not needed, and nothing is spent to use it up
    expect(pkg.cost.imageUsd).toBeGreaterThan(0);
    expect(pkg.cost.blockedRequests).toBe(0);
    expect(run.usage.images).toMatchObject({ generated: 20, failed: 0, attempted: 20, blocked: 0 });
    expect(run.usage.images.last).toMatchObject({ status: 'generated', model: IMAGE });
    expect(run.usage.cost.imageUsd).toBeGreaterThan(0);

    // persistence: a browser refresh (a new request) shows exactly the same campaign
    const again = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(again.package.imageCounts).toEqual(pkg.imageCounts);
    expect((await user.agent.get(`/projects/${projectId}/campaigns`).expect(200)).body.items[0]).toMatchObject({ id: run.campaignId, generatedImages: 20, imageTarget: 20 });

    // the ZIP: all 20 originals under images/originals, a manifest that points only at existing files, usage, strategy
    const zipRes = await user.agent.get(`/campaigns/${run.campaignId}/export`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const z = await JSZip.loadAsync(zipRes.body as Buffer);
    const names = Object.keys(z.files);
    expect(names.filter((n) => /^images\/originals\/concept-\d\d-variation-\d\d\.png$/.test(n))).toHaveLength(20);
    for (const f of ['campaign.json', 'strategy/strategy.json', 'strategy/image-allocation.json', 'images/asset-manifest.json', 'usage/usage.json', 'landing/landing-content.json', 'review/findings.json']) expect(names).toContain(f);
    const am = JSON.parse(await z.file('images/asset-manifest.json')!.async('string'));
    expect(am.entries).toHaveLength(20);
    for (const e of am.entries) {
      expect(names).toContain(e.original.file);
      for (const l of e.layouts) expect(names).toContain(l.file);
    }

    // "download all originals": only the 20 images and a list of what each one is
    const orig = await user.agent.get(`/campaigns/${run.campaignId}/export/originals`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const oz = await JSZip.loadAsync(orig.body as Buffer);
    expect(Object.keys(oz.files).filter((n) => /^originals\/concept-\d\d-variation-\d\d\.png$/.test(n))).toHaveLength(20);
    expect(JSON.parse(await oz.file('originals.json')!.async('string')).entries).toHaveLength(20);

    // another user cannot see, continue or export it (404, never 403: ids cannot be probed)
    const other = await registerUser(app, 'prod-other');
    await other.agent.get(`/campaigns/${run.campaignId}`).expect(404);
    await other.agent.get(`/campaigns/${run.campaignId}/export`).expect(404);
    await other.agent.get(`/campaigns/${run.campaignId}/export/originals`).expect(404);
    await other.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({}).expect(404);
    await other.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 1, confirmCost: true }).expect(404);
    // a finished campaign with every image has nothing to continue
    await user.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({}).expect(409);
  });

  it('IMAGE FAILURES: the run is partial with the real count; the missing images are generated WITHOUT rerunning research, as a new campaign', async () => {
    // only the image whose OWN subject says "image 3" is refused (the siblings clause of every prompt also mentions the other images)
    await useFake({ reply: failingImage(/SUBJECT: [^\n]*image 3\b/) });
    const { user, projectId } = await readyUser('prod-cont');
    const run = await waitF(user, (await startF(user, projectId, FULL).expect(201)).body.id);
    expect(run.status).toBe('partial');
    expect(run.errorMessage).toMatch(/of the 20 requested original AI images were generated/);
    expect(run.warnings.join(' ')).toMatch(/Generate the missing images/);
    const first = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const counts = first.package.imageCounts;
    expect(counts.requested).toBe(20);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    expect(counts.generated + counts.failed).toBe(20);
    expect(first.package.approval.status).not.toBe('approved');
    expect(first.assets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image')).toHaveLength(counts.generated);
    expect(first.assets.filter((a: any) => a.source === 'brand_gradient')).toHaveLength(0);
    const missing = counts.failed;

    // the images are fine now; research, copy and landing must not run again
    await useFake();
    const pre = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({ approvedBudgetUsd: 2 }).expect(200)).body;
    expect(pre).toMatchObject({ ok: true, willRequest: missing, mustConfirm: true });
    expect(pre.missing).toHaveLength(missing);
    expect(pre.notRerun).toContain('Market Research & Strategy');
    expect(pre.reuse.originals).toBe(counts.generated);
    expect(pre.cost.images).toMatchObject({ count: missing, model: IMAGE });
    expect(paid()).toHaveLength(0); // the preflight is free
    // billed: refused without an approved limit and an explicit confirmation
    await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({}).expect(422);
    await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 2 }).expect(422);
    expect(paid()).toHaveLength(0);

    const started = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 2, confirmCost: true }).expect(201)).body;
    const runRow = await (async () => {
      const end = Date.now() + 300_000;
      for (;;) {
        const r = (await user.agent.get(`/runs/${started.id}`).expect(200)).body;
        if (r.status !== 'RUNNING') return r;
        if (Date.now() > end) throw new Error('continuation still running');
        await sleep(150);
      }
    })();
    expect(runRow.status).toBe('COMPLETED');
    const second = await waitCampaign(user, runRow.campaignId);
    // only the missing images were requested; no research, strategy, copy, landing or picture-planning request
    expect(fake.imageCalls()).toHaveLength(missing);
    const agents = new Set(textCalls().map((r) => r.agent));
    for (const a of [...F1_AGENTS, ...F2_AGENTS, ...F3_AGENTS, 'copywriter', 'landing', 'vcreator']) expect(agents.has(a as never)).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(second.package.imageCounts).toMatchObject({ requested: 20, generated: 20, failed: 0 });
    expect(second.package.lineage).toMatchObject({ kind: 'image_continuation', revision: 2, parentCampaignId: first.id });
    expect(second.assets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded')).toHaveLength(20);
    expect(second.package.usage.images.requested).toBe(missing);
    expect(second.package.cost.approvedUsd).toBe(2);
    expect(second.package.copyVariants).toEqual(first.package.copyVariants);
    // the earlier campaign is exactly as it was
    const firstAgain = (await user.agent.get(`/campaigns/${first.id}`).expect(200)).body;
    expect(firstAgain.package.imageCounts).toEqual(counts);
    expect(firstAgain.assets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image')).toHaveLength(counts.generated);
    expect(firstAgain.status).toBe('completed');
  });

  it('REUSE: with valid earlier results only F4 runs; research and strategy are not repeated and the 20 images still need consent', async () => {
    const { user, projectId } = await readyUser('prod-reuse');
    const base = await waitF(user, (await startF(user, projectId, { preset: 'first_test', mode: 'fresh' }).expect(201)).body.id);
    expect(base.status).toMatch(/completed|partial/);
    await useFake();
    const ask = { preset: 'full_production', mode: 'continue', rerunCreative: true, f4: { imageModel: IMAGE } };
    const p = (await preflight(user, projectId, ask).expect(200)).body;
    expect(p.phases.map((x: any) => `${x.code}:${x.action}`)).toEqual(['F1:reuse', 'F2:reuse', 'F3:reuse', 'F4:run']);
    // the reused phases cost nothing: only F4 is in the estimate
    expect(p.cost.text.phases.map((x: any) => x.runs)).toEqual([false, false, false, true]);
    expect(p.cost.text.phases[0].typicalUsd).toBe(0);
    await startF(user, projectId, ask).expect(422); // consent is still required
    expect(paid()).toHaveLength(0);
    const run = await waitF(user, (await startF(user, projectId, { ...ask, approvedBudgetUsd: 7, confirmCost: true }).expect(201)).body.id);
    expect(run.status).toBe('completed');
    expect(run.phases.map((x: any) => x.status)).toEqual(['reused', 'reused', 'reused', 'completed']);
    const agents = new Set(textCalls().map((r) => r.agent));
    for (const a of [...F1_AGENTS, ...F2_AGENTS, ...F3_AGENTS]) expect(agents.has(a as never)).toBe(false);
    expect(fake.imageCalls()).toHaveLength(20);
    // F4 got the whole approved amount (nothing was spent by the reused phases)
    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    expect(camp.package.cost.approvedUsd).toBe(7); // the one campaign budget, nothing spent by the reused phases
    expect(camp.package.imageCounts.generated).toBe(20);
  });

  it('direct F4 with several originals per concept also needs an approved limit', async () => {
    const { user, projectId } = await readyUser('prod-direct');
    const chain = await waitF(user, (await startF(user, projectId, { preset: 'first_test', mode: 'fresh' }).expect(201)).body.id);
    expect(chain.status).toMatch(/completed|partial/);
    const before = paid().length;
    const r = await user.agent.post(`/projects/${projectId}/runs/creative-production`).send({ imageModel: IMAGE, variations: true, maxImages: 4, concepts: 2 }).expect(422);
    expect(r.body.message).toMatch(/approved spending limit|approvedBudgetUsd/);
    expect(paid().length).toBe(before);
  });
});
