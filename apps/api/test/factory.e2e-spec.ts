import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { defaultCopy } from '@launchpilot/agents/dist/testing/fake-creative';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { buildPhasePlan, chooseChain, LineageError, mergeSettings, outcomeOf, type Candidates } from '../src/mozaik/factory-plan';
import { configureOpenAi, createApp, createProject, loginUser, registerUser, sleep, waitForTerminal, type TestUser } from './helpers';

// The full campaign (F1 -> F2 -> F3 -> F4) through ONE call: the Factory Orchestrator drives the EXISTING phase services, so every
// phase runs its real Mozaik participants. Only OpenAI (text and images) is faked, over real HTTP; nothing is billed.
const KEY = 'sk-test-FACTORYE2E1234567890abcdefghij';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1-mini'; // a current model; gpt-image-1 was shut down by OpenAI on 2026-10-23
const F1_AGENTS = ['input', 'text', 'web', 'repo', 'files', 'visual', 'synthesizer'];
const F2_AGENTS = ['seo', 'social', 'brand', 'messaging', 'presence', 'auditor'];
const F3_AGENTS = ['audience', 'competitor', 'seasonal', 'scout', 'strategist'];
const F4_AGENTS = ['copywriter', 'landing', 'vcreator', 'creviewer'];

// ---- pure planning logic ----------------------------------------------------------------------------------------------------

describe('Factory plan (pure logic)', () => {
  const d = (n: number) => new Date(2026, 0, n);
  const c = (id: string, day: number, o: Record<string, unknown> = {}) => ({ id, runId: `run-${id}`, createdAt: d(day), model: MODEL, partial: false, usable: true, ...o });
  const cands = (o: Partial<Candidates> = {}): Candidates => ({ f1: [], f2: [], f3: [], f4: [], ...o });
  const opts = { reusePartial: true, rerunCreative: false };

  it('prefers the deepest COHERENT chain, not the newest result of each kind', () => {
    const k = cands({
      f1: [c('f1-new', 9), c('f1-old', 1)],
      f2: [c('f2-a', 3, { f1ReportId: 'f1-old' }) as never],
      f3: [c('f3-a', 5, { f1ReportId: 'f1-old', f2AuditId: 'f2-a' }) as never],
    });
    const { chain, notes } = chooseChain(k, opts);
    expect([chain.f1?.id, chain.f2?.id, chain.f3?.id]).toEqual(['f1-old', 'f2-a', 'f3-a']);
    expect(notes.join(' ')).toMatch(/newer Product Discovery report exists, but/);
    expect(buildPhasePlan(chain, 'continue').map((p) => p.action)).toEqual(['reuse', 'reuse', 'reuse', 'run']);
  });

  it('a strategy whose audit is missing is not reused; the chain ends where the lineage breaks', () => {
    const k = cands({ f1: [c('f1', 1)], f2: [c('f2', 2, { f1ReportId: 'f1' }) as never], f3: [c('f3', 3, { f1ReportId: 'f1', f2AuditId: 'gone' }) as never] });
    const { chain } = chooseChain(k, opts);
    expect([chain.f1?.id, chain.f2?.id, chain.f3?.id]).toEqual(['f1', 'f2', undefined]);
  });

  it('older F1 reports without a Product Manifest are never reused; partial ones only when allowed', () => {
    const old = cands({ f1: [c('v1', 1, { usable: false })] });
    expect(chooseChain(old, opts).chain.f1).toBeUndefined();
    const partial = cands({ f1: [c('p', 1, { partial: true })] });
    expect(chooseChain(partial, opts).chain.f1?.id).toBe('p');
    const off = chooseChain(partial, { ...opts, reusePartial: false });
    expect(off.chain.f1).toBeUndefined();
    expect(off.notes.join(' ')).toMatch(/Partial saved reports are not reused/);
  });

  it('explicit selections must form one chain, or they are refused with the reason', () => {
    const k = cands({
      f1: [c('f1-a', 1), c('f1-b', 2)],
      f2: [c('f2', 3, { f1ReportId: 'f1-a' }) as never],
      f3: [c('f3', 4, { f1ReportId: 'f1-a', f2AuditId: 'f2' }) as never],
    });
    expect(() => chooseChain(k, { ...opts, explicit: { f1ReportId: 'f1-b', f2AuditId: 'f2' } })).toThrow(/built on Product Discovery report f1-a, not on the selected report f1-b/);
    expect(() => chooseChain(k, { ...opts, explicit: { f3StrategyId: 'f3', f2AuditId: 'other' } })).toThrow(LineageError);
    expect(() => chooseChain(k, { ...opts, explicit: { f2AuditId: 'nope' } })).toThrow(/not a completed, saved result of this project/);
    expect(chooseChain(k, { ...opts, explicit: { f3StrategyId: 'f3' } }).chain.f1?.id).toBe('f1-a');
  });

  it('a campaign is reused only for exactly that strategy, unless a new creative round is requested; fresh runs reuse nothing', () => {
    const k = cands({
      f1: [c('f1', 1)],
      f2: [c('f2', 2, { f1ReportId: 'f1' }) as never],
      f3: [c('f3', 3, { f1ReportId: 'f1', f2AuditId: 'f2' }) as never],
      f4: [c('k-other', 5, { f3StrategyId: 'f3-other', approvalStatus: 'approved' }) as never, c('k1', 4, { f3StrategyId: 'f3', approvalStatus: 'approved' }) as never],
    });
    expect(chooseChain(k, opts).chain.f4?.id).toBe('k1');
    expect(chooseChain(k, { ...opts, rerunCreative: true }).chain.f4).toBeUndefined();
    const { chain } = chooseChain(k, opts);
    expect(buildPhasePlan(chain, 'continue').every((p) => p.action === 'reuse')).toBe(true);
    expect(buildPhasePlan(chain, 'fresh').every((p) => p.action === 'run')).toBe(true);
    // a phase after a phase that runs always runs (never a reused result downstream of a re-run)
    expect(buildPhasePlan({ f1: chain.f1, f3: chain.f3 }, 'continue').map((p) => p.action)).toEqual(['reuse', 'run', 'run', 'run']);
  });

  it('presets are conservative, the first test is the default, and an image cap never exceeds the concept count', () => {
    const t = mergeSettings('first_test');
    expect(t.f3).toMatchObject({ maxModelCalls: 14, maxScouts: 3, maxReviews: 3, useHolidayCalendar: false });
    expect(t.f4).toMatchObject({ imageModel: 'auto', imageQuality: 'low', concepts: 1, channels: ['instagram'], landing: true, maxModelCalls: 12, maxImages: 1, maxRegenerations: 0, visionReviews: 0, maxRepairRounds: 2 });
    const d = mergeSettings('demo', { f4: { concepts: 2 } });
    expect(d.f4.maxImages).toBe(2);
    expect(d.f4.maxRegenerations).toBe(0); // costly options are never preselected
    expect(mergeSettings('first_test', { f4: { concepts: 3, maxImages: 9 } }).f4.maxImages).toBe(3);
    expect(mergeSettings('first_test', { f4: { imageModel: null } }).f4).toMatchObject({ imageModel: null, maxImages: 0, maxRegenerations: 0 });
  });

  it('the outcome label never calls a campaign with unresolved issues "approved"', () => {
    expect(outcomeOf('completed', 'approved')).toBe('approved');
    expect(outcomeOf('completed', 'approved_with_notes')).toBe('approved_with_notes');
    expect(outcomeOf('completed', 'unresolved')).toBe('unresolved');
    expect(outcomeOf('running', null)).toBe('in_progress');
    expect(outcomeOf('partial', 'approved')).toBe('partial');
    expect(outcomeOf('cancelled', null)).toBe('cancelled');
  });
});

// ---- the orchestrator through HTTP, real Mozaik runtime, fake OpenAI -----------------------------------------------------------

describe('Factory Orchestrator (one-click F1 -> F2 -> F3 -> F4)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, IMAGE, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const textCalls = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
  const seen = () => new Set(textCalls().map((r) => r.agent));
  const only = (allowed: string[]) => [...seen()].every((a) => allowed.includes(a));

  async function readyUser(label: string, projectName = 'Deep Diving School', key = KEY) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, projectName);
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: projectName, shortDescription: 'Scuba diving courses for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners aged 18 to 35', preferredLanguage: 'en' }).expect(200);
    await configureOpenAi(user, key, MODEL);
    return { user, projectId };
  }
  const direct = async (u: TestUser, projectId: string, path: string, body: object = {}, ms = 60_000) => {
    const r = await waitForTerminal(u, (await u.agent.post(`/projects/${projectId}/runs/${path}`).send(body).expect(201)).body.id, ms);
    expect(r.status).toBe('COMPLETED');
    return r;
  };
  const savedChain = async (u: TestUser, projectId: string, upTo: 1 | 2 | 3) => {
    const f1 = await direct(u, projectId, 'product-discovery');
    const f2 = upTo >= 2 ? await direct(u, projectId, 'marketing-audit') : null;
    const f3 = upTo >= 3 ? await direct(u, projectId, 'market-strategy', { maxScouts: 2 }) : null;
    return { f1ReportId: f1.reportId as string, f2AuditId: f2?.auditId as string, f3StrategyId: f3?.strategyId as string };
  };
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send(body);
  const getF = async (u: TestUser, id: string) => (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
  const waitF = async (u: TestUser, id: string, ms = 150_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await getF(u, id);
      if (!['queued', 'running'].includes(v.status)) return v;
      if (Date.now() > end) throw new Error(`Factory run ${id} still ${v.status} after ${ms} ms`);
      await sleep(100);
    }
  };
  const runFactory = async (u: TestUser, projectId: string, body: object = {}) => waitF(u, (await startF(u, projectId, body).expect(201)).body.id);
  const phase = (v: any, key: string) => v.phases.find((p: any) => p.phase === key);
  const states = (v: any) => v.phases.map((p: any) => p.status);
  const waitUntil = async (fn: () => Promise<boolean> | boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await sleep(50);
    }
    throw new Error('condition not met in time');
  };
  const failing = (agents: string[]): FakeOpenAIOptions['reply'] => (r: FakeRequest): FakeReply | undefined => (agents.includes(r.agent) ? { status: 401, json: { error: { code: 'invalid_api_key', message: `bad ${KEY}` } } } : undefined);

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

  // ---- preflight, credentials, models, validation -----------------------------------------------------------------------------

  it('PREFLIGHT on a fresh project: runs all four phases with the conservative first-test defaults, shows exact limits, and spends nothing', async () => {
    const { user, projectId } = await readyUser('fac-pre');
    const presets = (await user.agent.get('/factory/presets').expect(200)).body;
    expect(presets.default).toBe('first_test');
    expect(presets.presets.demo.f4.maxRegenerations).toBe(0);
    const p = (await preflight(user, projectId).expect(200)).body;
    expect(p).toMatchObject({ ok: true, blockers: [], nothingToRun: false, mode: 'continue', preset: 'first_test', project: { name: 'Deep Diving School' } });
    expect(p.phases.map((x: any) => `${x.code}:${x.action}`)).toEqual(['F1:run', 'F2:run', 'F3:run', 'F4:run']);
    expect(p.models.text).toMatchObject({ id: MODEL, source: 'saved' });
    expect(p.models.image).toMatchObject({ id: IMAGE, requested: 'auto', mode: 'auto', quality: 'low', available: true });
    expect(p.imagePlan).toMatchObject({ enabled: true, model: IMAGE, modelMode: 'auto', conceptsRequested: 1, originalImagesPermitted: 1, plannedRequests: 1, budgetLimitedConcepts: 0, regenerationCap: 0 });
    expect(phase(p, 'strategy').limits).toMatchObject({ maxModelCalls: 14, maxScouts: 3, maxReviews: 3, useHolidayCalendar: false });
    expect(phase(p, 'creative').limits).toMatchObject({ concepts: 1, channels: ['instagram'], landing: true, maxModelCalls: 12, maxImages: 1, maxRegenerations: 0, visionReviews: 0, maxRepairRounds: 2 });
    expect(p.totals).toMatchObject({ phasesToRun: 4, phasesReused: 0, textCallCap: 12 + 12 + 14 + 12, imageRequests: 1, imageRegenerationCap: 0, layouts: 3 });
    expect(p.pricing.dollars).toBeNull();
    expect(p.pricing.note).toMatch(/not an OpenAI spending cap/);
    expect(p.brief.targetAudience).toBe('Beginners aged 18 to 35');
    // free: only the model list was asked; no text or image request
    expect(textCalls()).toHaveLength(0);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
    expect(await db.campaignRun.count({ where: { projectId } })).toBe(0);
  });

  it('refuses safely and for free: no key, unknown text model, image model the key does not list, invalid limits, other users', async () => {
    const noKey = await registerUser(app, 'fac-nokey');
    const nkProject = await createProject(noKey, 'No key project');
    const a = (await preflight(noKey, nkProject).expect(200)).body;
    expect(a.ok).toBe(false);
    expect(a.blockers[0]).toMatchObject({ code: 'no_credentials' });
    expect((await startF(noKey, nkProject).expect(422)).body.message).toMatch(/OpenAI API key/);

    const { user, projectId } = await readyUser('fac-refuse');
    const bad = (await preflight(user, projectId, { model: 'gpt-nonexistent' }).expect(200)).body;
    expect(bad.blockers.map((b: any) => b.code)).toContain('model_unavailable');
    expect((await startF(user, projectId, { model: 'gpt-nonexistent' }).expect(422)).body.message).toMatch(/not available to your OpenAI key/);
    await useFake({ models: [MODEL] }); // the key lists no image model
    const noImg = (await preflight(user, projectId).expect(200)).body;
    expect(noImg.blockers.map((b: any) => b.code)).toContain('image_model_unavailable');
    expect((await startF(user, projectId).expect(422)).body.message).toMatch(/lists no current GPT Image model/);
    // without images it is allowed (brand-colored backgrounds)
    expect((await preflight(user, projectId, { f4: { imageModel: null } }).expect(200)).body.ok).toBe(true);
    await startF(user, projectId, { f4: { imageModel: 'gpt-4.1-mini' } }).expect(400);
    await startF(user, projectId, { f3: { maxModelCalls: 2 } }).expect(400);
    await startF(user, projectId, { f4: { channels: ['myspace'] } }).expect(400);
    await startF(user, projectId, { mode: 'turbo' }).expect(400);
    const other = await registerUser(app, 'fac-other');
    await preflight(other, projectId).expect(404);
    await startF(other, projectId).expect(404);
    expect(textCalls()).toHaveLength(0);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  // ---- the full chain -----------------------------------------------------------------------------------------------------------

  it('FRESH PROJECT: one click runs F1 -> F2 -> F3 -> F4, persists every step, saves a campaign and a valid ZIP; a double start is refused', async () => {
    const { user, projectId } = await readyUser('fac-full');
    const [one, two] = await Promise.all([startF(user, projectId), startF(user, projectId)]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const started = (one.status === 201 ? one : two).body;
    expect(started).toMatchObject({ mode: 'continue', status: expect.stringMatching(/queued|running/), projectId });
    // while it runs, a phase started by hand is refused (the full run owns the project), and the persisted state is readable
    await user.agent.post(`/projects/${projectId}/runs/product-discovery`).send({}).expect(409);
    await waitUntil(async () => (await getF(user, started.id)).currentPhase !== null);
    const mid = await getF(user, started.id); // what a refreshed browser sees
    expect(mid.status).toBe('running');
    expect(['discovery', 'audit', 'strategy', 'creative']).toContain(mid.currentPhase);
    const listed = (await user.agent.get(`/projects/${projectId}/factory-runs`).expect(200)).body;
    expect(listed[0].id).toBe(started.id);

    const done = await waitF(user, started.id);
    expect(done.status).toBe('completed');
    expect(done.outcome).toMatch(/approved/);
    expect(states(done)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(done.phases.every((p: any) => p.action === 'run' && p.runId && p.outputId && p.startedAt && p.completedAt && !p.error)).toBe(true);
    // strict sequence, each phase started after the previous one was saved
    const starts = done.phases.map((p: any) => Date.parse(p.startedAt));
    const ends = done.phases.map((p: any) => Date.parse(p.completedAt));
    for (let i = 1; i < 4; i++) expect(starts[i]).toBeGreaterThanOrEqual(ends[i - 1]);
    expect(done.chain.f1ReportId).toBe(phase(done, 'discovery').outputId);
    expect(done.chain.f2AuditId).toBe(phase(done, 'audit').outputId);
    expect(done.chain.f3StrategyId).toBe(phase(done, 'strategy').outputId);
    expect(done.campaignId).toBe(phase(done, 'creative').outputId);

    // exact lineage in the database
    const f2 = await db.marketingAuditReport.findUniqueOrThrow({ where: { id: done.chain.f2AuditId } });
    const f3 = await db.marketingStrategyReport.findUniqueOrThrow({ where: { id: done.chain.f3StrategyId } });
    const f4 = await db.creativeCampaign.findUniqueOrThrow({ where: { id: done.campaignId } });
    expect(f2.f1ReportId).toBe(done.chain.f1ReportId);
    expect([f3.f1ReportId, f3.f2AuditId]).toEqual([done.chain.f1ReportId, done.chain.f2AuditId]);
    expect([f4.f1ReportId, f4.f2AuditId, f4.f3StrategyId]).toEqual([done.chain.f1ReportId, done.chain.f2AuditId, done.chain.f3StrategyId]);
    expect(f4.status).toBe('completed');

    // every phase's real participants ran; limits were honored; one original image, regeneration off
    expect([...seen()].sort()).toEqual(expect.arrayContaining(['input', 'synthesizer', 'messaging', 'auditor', 'audience', 'scout', 'strategist', 'copywriter', 'landing', 'vcreator', 'creviewer']));
    expect(done.usage.textCalls).toBe(textCalls().length);
    expect(done.usage.byPhase.discovery.textCalls).toBeLessThanOrEqual(12);
    expect(done.usage.byPhase.audit.textCalls).toBeLessThanOrEqual(12);
    expect(done.usage.byPhase.strategy.textCalls).toBeLessThanOrEqual(14);
    expect(done.usage.byPhase.creative.textCalls).toBeLessThanOrEqual(12);
    expect(fake.imageCalls()).toHaveLength(1);
    expect(fake.imageCalls()[0].body).toMatchObject({ model: IMAGE, quality: 'low', n: 1 });
    expect(done.usage.imagesGenerated).toBe(1);
    expect(textCalls().every((r) => r.authorization === `Bearer ${KEY}` && r.body?.model === MODEL)).toBe(true);

    // persisted, ordered, REAL activity: dynamic Channel Scouts (F3), the F4 agents, the review, the saved campaign
    const ev = (await user.agent.get(`/factory-runs/${done.id}/events`).expect(200)).body;
    const kinds = ev.items.map((e: any) => `${e.code}:${e.type}`);
    expect(kinds).toEqual(expect.arrayContaining(['F1:phase.started', 'F2:phase.started', 'F3:participant.registered', 'F3:crosscheck.requested', 'F3:strategy.completed', 'F4:copy.proposed', 'F4:visual.generated', 'F4:layout.completed', 'F4:review.completed', 'F4:campaign.completed']));
    const codes = ev.items.map((e: any) => e.code);
    const joined = ev.items.filter((e: any) => e.code === 'F3' && e.type === 'participant.registered');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.length).toBeLessThanOrEqual(3); // the Channel Scout cap
    expect(codes).toEqual([...codes].sort());
    expect(ev.items.find((e: any) => e.type === 'participant.registered' && e.code === 'F3').summary).toMatch(/Scout joined the run at run time/);
    expect(JSON.stringify([done, ev])).not.toContain(KEY);
    expect(JSON.stringify(ev)).not.toContain('iVBORw0KGgo');

    // the saved campaign, its assets and a working ZIP
    const campaign = (await user.agent.get(`/campaigns/${done.campaignId}`).expect(200)).body;
    expect(campaign.package).toMatchObject({ f1ReportId: done.chain.f1ReportId, f3StrategyId: done.chain.f3StrategyId });
    expect(campaign.package.imageAssets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image')).toHaveLength(1);
    expect(campaign.package.channelLayouts.length).toBeGreaterThanOrEqual(3);
    expect(campaign.package.copyVariants.every((v: any) => v.channel === 'instagram')).toBe(true);
    const zipRes = await user.agent.get(`/campaigns/${done.campaignId}/export`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const zip = await JSZip.loadAsync(zipRes.body as Buffer);
    expect(Object.keys(zip.files).filter((n) => n.endsWith('.png')).length).toBe(campaign.package.imageAssets.length);
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).assetsMissing).toEqual([]);
    const pipe = (await user.agent.get(`/projects/${projectId}/pipeline`).expect(200)).body;
    expect(pipe.phases.map((p: any) => p.state)).toEqual(['completed', 'completed', 'completed', 'completed']);

    // a second full run on a complete chain has nothing to run and costs nothing
    fake.requests.length = 0;
    const again = (await preflight(user, projectId).expect(200)).body;
    expect(again).toMatchObject({ nothingToRun: true, ok: true });
    expect(again.phases.every((p: any) => p.action === 'reuse')).toBe(true);
    expect(again.chain.campaignId).toBe(done.campaignId);
    expect((await startF(user, projectId).expect(409)).body.message).toMatch(/nothing to run/);
    expect(fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'))).toHaveLength(0);

    // survives a restart: a fresh application instance still serves the finished run, its events and the campaign
    const app2 = await createApp();
    try {
      const agent2 = await loginUser(app2, user.email);
      const after = (await agent2.get(`/factory-runs/${done.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: 'completed', campaignId: done.campaignId });
      expect((await agent2.get(`/factory-runs/${done.id}/events`).expect(200)).body.items.length).toBe(ev.items.length);
      await agent2.get(`/campaigns/${done.campaignId}/export`).expect(200);
    } finally {
      await app2.close();
    }
    // other users never see it
    const other = await registerUser(app, 'fac-full-other');
    await other.agent.get(`/factory-runs/${done.id}`).expect(404);
    await other.agent.get(`/factory-runs/${done.id}/events`).expect(404);
    await other.agent.post(`/factory-runs/${done.id}/cancel`).expect(404);
  }, 240_000);

  it('EXISTING F1+F2: the saved results are reused (no F1/F2 call), F3 and F4 run, and the lineage is exact; coherent chain beats "newest of each"', async () => {
    const { user, projectId } = await readyUser('fac-f12');
    const saved = await savedChain(user, projectId, 2);
    const f1b = await direct(user, projectId, 'product-discovery'); // a NEWER F1 that the audit was not built on
    fake.requests.length = 0;
    const p = (await preflight(user, projectId).expect(200)).body;
    expect(p.phases.map((x: any) => `${x.code}:${x.action}`)).toEqual(['F1:reuse', 'F2:reuse', 'F3:run', 'F4:run']);
    expect(p.chain).toMatchObject({ f1ReportId: saved.f1ReportId, f2AuditId: saved.f2AuditId });
    expect(p.chain.f1ReportId).not.toBe(f1b.reportId);
    expect(p.warnings.join(' ')).toMatch(/newer Product Discovery report exists, but the saved audit/);
    expect(phase(p, 'discovery').reuse).toMatchObject({ id: saved.f1ReportId, partial: false });
    expect(phase(p, 'discovery').reuse.summary).toBeTruthy();
    expect(phase(p, 'discovery').measured.tokens).toBeGreaterThan(0); // real accounting of the earlier run
    expect(p.totals).toMatchObject({ phasesToRun: 2, phasesReused: 2, textCallCap: 14 + 12 });

    // explicit selections are validated as one chain: the newer F1 does not match the audit
    const mismatch = await startF(user, projectId, { reports: { f1ReportId: f1b.reportId, f2AuditId: saved.f2AuditId } }).expect(422);
    expect(mismatch.body.message).toMatch(/built on Product Discovery report .*, not on the selected report/);
    expect(textCalls()).toHaveLength(0);

    const done = await runFactory(user, projectId);
    expect(done.status).toBe('completed');
    expect(states(done)).toEqual(['reused', 'reused', 'completed', 'completed']);
    expect(phase(done, 'discovery')).toMatchObject({ action: 'reuse', outputId: saved.f1ReportId, runId: null });
    expect(phase(done, 'audit')).toMatchObject({ action: 'reuse', outputId: saved.f2AuditId, runId: null });
    expect(only([...F3_AGENTS, ...F4_AGENTS])).toBe(true); // no paid F1 or F2 call
    expect(Object.keys(done.usage.byPhase).sort()).toEqual(['creative', 'strategy']);
    const f3 = await db.marketingStrategyReport.findUniqueOrThrow({ where: { id: done.chain.f3StrategyId } });
    expect([f3.f1ReportId, f3.f2AuditId]).toEqual([saved.f1ReportId, saved.f2AuditId]);
    expect((await db.creativeCampaign.findUniqueOrThrow({ where: { id: done.campaignId } })).f3StrategyId).toBe(f3.id);
    expect(await db.productDiscoveryReport.count({ where: { projectId } })).toBe(2); // nothing re-saved
  }, 240_000);

  it('EXISTING F1+F2+F3: only F4 runs, with exactly one image; "new creative round" is explicit; a fresh run reruns F1 but a failure keeps the earlier results', async () => {
    const { user, projectId } = await readyUser('fac-f123');
    const saved = await savedChain(user, projectId, 3);
    fake.requests.length = 0;
    const done = await runFactory(user, projectId);
    expect(done.status).toBe('completed');
    expect(states(done)).toEqual(['reused', 'reused', 'reused', 'completed']);
    expect(only(F4_AGENTS)).toBe(true);
    expect(fake.imageCalls()).toHaveLength(1);
    expect(done.chain).toEqual({ f1ReportId: saved.f1ReportId, f2AuditId: saved.f2AuditId, f3StrategyId: saved.f3StrategyId });
    expect(Object.keys(done.usage.byPhase)).toEqual(['creative']);

    // a complete chain: nothing to run unless a new creative round is requested
    expect((await startF(user, projectId).expect(409)).body.message).toMatch(/nothing to run/);
    const round = (await preflight(user, projectId, { rerunCreative: true }).expect(200)).body;
    expect(round.phases.map((x: any) => x.action)).toEqual(['reuse', 'reuse', 'reuse', 'run']);

    // FRESH is explicit: every phase runs again; here F1 fails, so F2..F4 never start and the earlier results are untouched
    await useFake({ reply: failing(['input', 'text', 'synthesizer']) });
    const fresh = (await preflight(user, projectId, { mode: 'fresh' }).expect(200)).body;
    expect(fresh.phases.map((x: any) => x.action)).toEqual(['run', 'run', 'run', 'run']);
    const failed = await runFactory(user, projectId, { mode: 'fresh' });
    expect(failed.status).toBe('failed');
    expect(states(failed)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(failed.errorMessage).toMatch(/F1 Product Discovery failed/);
    expect(only(F1_AGENTS)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain(KEY);
    const pipe = (await user.agent.get(`/projects/${projectId}/pipeline`).expect(200)).body;
    expect(pipe.phases.map((p: any) => `${p.state}:${!!p.output}`)).toEqual(['failed:true', 'completed:true', 'completed:true', 'completed:true']);
    expect(await db.marketingStrategyReport.count({ where: { projectId } })).toBe(1);
  }, 240_000);

  // ---- failures --------------------------------------------------------------------------------------------------------------------

  it('F2, F3 and F4 failures stop the run at that phase (later phases skipped, nothing retried, earlier results kept)', async () => {
    const { user, projectId } = await readyUser('fac-fail');
    const saved = await savedChain(user, projectId, 1);
    // F2 fails: every auditor is refused
    await useFake({ reply: failing(F2_AGENTS) });
    const f2 = await runFactory(user, projectId, { reports: { f1ReportId: saved.f1ReportId } });
    expect(f2.status).toBe('failed');
    expect(states(f2)).toEqual(['reused', 'failed', 'skipped', 'skipped']);
    expect(phase(f2, 'audit').error).toBeTruthy();
    expect(only(F2_AGENTS)).toBe(true);
    expect(textCalls().length).toBeLessThanOrEqual(12); // within the F2 cap, no automatic retry loop
    await useFake();
    await direct(user, projectId, 'marketing-audit');
    // F3 fails: every researcher and scout is refused
    await useFake({ reply: failing(F3_AGENTS) });
    const f3 = await runFactory(user, projectId);
    expect(f3.status).toBe('failed');
    expect(states(f3)).toEqual(['reused', 'reused', 'failed', 'skipped']);
    expect(f3.errorMessage).toMatch(/F3 Market Research & Strategy failed/);
    expect(only(F3_AGENTS)).toBe(true);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(await db.creativeCampaign.count({ where: { projectId } })).toBe(0);
    // F4 fails: the copywriter is refused, no image is paid for
    await useFake();
    await direct(user, projectId, 'market-strategy', { maxScouts: 2 });
    await useFake({ reply: failing(['copywriter']) });
    const f4 = await runFactory(user, projectId);
    expect(f4.status).toBe('failed');
    expect(states(f4)).toEqual(['reused', 'reused', 'reused', 'failed']);
    expect(fake.imageCalls()).toHaveLength(0);
    expect((await db.creativeCampaign.findUniqueOrThrow({ where: { runId: phase(f4, 'creative').runId } })).status).toBe('failed');
    // the earlier results are all still there and usable
    const pipe = (await user.agent.get(`/projects/${projectId}/pipeline`).expect(200)).body;
    expect(pipe.phases.map((p: any) => !!p.output)).toEqual([true, true, true, false]);
  }, 300_000);

  it('F1 FAILURE on a fresh project: a wrong key stops at F1; the message is safe and nothing else starts', async () => {
    const { user, projectId } = await readyUser('fac-f1fail');
    await useFake({ reply: failing(F1_AGENTS) });
    const done = await runFactory(user, projectId);
    expect(done.status).toBe('failed');
    expect(done.outcome).toBe('failed');
    expect(states(done)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(only(F1_AGENTS)).toBe(true);
    expect(JSON.stringify(done)).not.toContain(KEY);
    expect(await db.campaignRun.count({ where: { projectId } })).toBe(1);
  }, 90_000);

  // ---- F4 budgets, fallbacks, repair ----------------------------------------------------------------------------------------------

  it('F4 limits are enforced: a 4-call text cap is never exceeded; an image cap of 1 for 2 concepts pays for ONE image; a failed image falls back honestly', async () => {
    const { user, projectId } = await readyUser('fac-f4lim');
    await savedChain(user, projectId, 3);
    // text-model budget: copy + landing + visual plan + review fit in 4 calls; cross-checks and repairs are cut first
    fake.requests.length = 0;
    const tiny = await runFactory(user, projectId, { rerunCreative: true, f4: { maxModelCalls: 4 } });
    expect(['completed', 'partial']).toContain(tiny.status);
    expect(textCalls().length).toBeLessThanOrEqual(4);
    expect(tiny.usage.byPhase.creative.textCalls).toBeLessThanOrEqual(4);

    // image budget exhausted: 2 concepts, one original image
    await useFake();
    const two = await runFactory(user, projectId, { rerunCreative: true, f4: { concepts: 2, maxImages: 1 } });
    expect(two.status).toBe('completed');
    expect(fake.imageCalls()).toHaveLength(1);
    const pkg2 = (await user.agent.get(`/campaigns/${two.campaignId}`).expect(200)).body.package;
    expect(pkg2.concepts).toHaveLength(2);
    expect(pkg2.imageAssets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image')).toHaveLength(1);
    expect(pkg2.imageAssets.filter((a: any) => a.kind === 'image' && a.source === 'brand_gradient')).toHaveLength(1);
    expect(pkg2.usage.images).toMatchObject({ requested: 1, generated: 1, regenerations: 0 });
    const limited = (await preflight(user, projectId, { rerunCreative: true, f4: { concepts: 2, maxImages: 1 } }).expect(200)).body;
    expect(limited.warnings.join(' ')).toMatch(/image limit is 1 for 2 concepts: only 1 concept\(s\) get an AI image and the other 1 use brand-colored backgrounds/);
    expect(limited.warnings.join(' ')).toMatch(/never raises the limit for you/);
    expect(limited.imagePlan).toMatchObject({ conceptsRequested: 2, originalImagesPermitted: 1, plannedRequests: 1, budgetLimitedConcepts: 1 });
    // the limit the user chose is recorded per concept: one generated, one skipped because of the maximum
    expect(pkg2.imageResults.map((r: any) => `${r.outcome}:${r.stage}:${r.requestAttempted}`).sort()).toEqual(['generated:null:true', 'skipped:budget:false']);
    expect(two.warnings.join(' ')).toMatch(/configured maximum is 1 image for 2 concepts/);

    // image generation fails: no retry storm, brand-colored backgrounds (clearly NOT AI images), an honest partial campaign
    await useFake({ reply: (r) => (r.agent === 'image' ? { status: 404, json: { error: { code: 'model_not_found', message: `no ${KEY}` } } } : undefined) });
    const fallback = await runFactory(user, projectId, { rerunCreative: true });
    expect(fallback.status).toBe('partial');
    expect(fallback.outcome).toBe('partial');
    expect(fake.imageCalls()).toHaveLength(1);
    const pkg3 = (await user.agent.get(`/campaigns/${fallback.campaignId}`).expect(200)).body.package;
    expect(pkg3.imageAssets.filter((a: any) => a.kind === 'image').every((a: any) => a.source === 'brand_gradient')).toBe(true);
    expect(pkg3.imageAssets.some((a: any) => a.source === 'ai_image')).toBe(false);
    expect(pkg3.limitations.join(' ')).toMatch(/could not be generated|brand-colored/i);
    expect(fallback.usage.imagesFailed).toBe(1);
    expect(JSON.stringify(fallback)).not.toContain(KEY);
    // the failure is explained per concept, in the run itself (not a generic "brand-colored" note)
    expect(pkg3.imageResults).toHaveLength(1);
    expect(pkg3.imageResults[0]).toMatchObject({ outcome: 'failed', requestAttempted: true, stage: 'provider', errorCode: 'model_unavailable', providerStatus: 404, providerCode: 'model_not_found', fallbackUsed: true });
    expect(fallback.errorMessage).toMatch(/1 of 1 concept\(s\) have no AI image/);
    expect(JSON.stringify(pkg3)).not.toContain(KEY);
  }, 300_000);

  it('IMAGE MODEL: retired models are refused before anything is spent even though the key still lists them; "auto" never picks one', async () => {
    const { user, projectId } = await readyUser('fac-retired');
    // the key lists only the shut-down model: listing is not proof of use
    await useFake({ models: [MODEL, 'gpt-image-1'] });
    const none = (await preflight(user, projectId).expect(200)).body;
    expect(none.ok).toBe(false);
    expect(none.blockers.find((b: any) => b.code === 'image_model_unavailable').message).toMatch(/gpt-image-1 is still listed but was shut down by OpenAI/);
    expect((await startF(user, projectId).expect(422)).body.message).toMatch(/no current GPT Image model/);

    // an explicit retired model is refused with the replacements named, even when listed
    await useFake({ models: [MODEL, 'gpt-image-1', 'gpt-image-1-mini'] });
    const explicit = (await preflight(user, projectId, { f4: { imageModel: 'gpt-image-1' } }).expect(200)).body;
    expect(explicit.ok).toBe(false);
    expect(explicit.blockers.map((b: any) => b.code)).toContain('image_model_retired');
    expect(explicit.blockers.find((b: any) => b.code === 'image_model_retired').message).toMatch(/shut down gpt-image-1 on 2026-10-23.*gpt-image-2\.5-sunburst/);
    expect((await startF(user, projectId, { f4: { imageModel: 'gpt-image-1' } }).expect(422)).body.message).toMatch(/shut down gpt-image-1/);

    // "auto" skips the retired model; an explicit current model is accepted
    await useFake({ models: [MODEL, 'gpt-image-1', 'gpt-image-2.5-flare'] });
    const auto = (await preflight(user, projectId).expect(200)).body;
    expect(auto.ok).toBe(true);
    expect(auto.models.image).toMatchObject({ id: 'gpt-image-2.5-flare', requested: 'auto', mode: 'auto' });
    expect(auto.settings.f4.imageModel).toBe('gpt-image-2.5-flare');
    const exp = (await preflight(user, projectId, { f4: { imageModel: 'gpt-image-2.5-flare' } }).expect(200)).body;
    expect(exp.models.image).toMatchObject({ id: 'gpt-image-2.5-flare', mode: 'explicit' });
    // an outage of the model list cannot be turned into a guess
    expect(textCalls()).toHaveLength(0);
    expect(fake.imageCalls()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('FAILED IMAGES (403, organization not verified): a partial campaign that says which concepts have no AI image and why; only the requests in flight are sent', async () => {
    const { user, projectId } = await readyUser('fac-img403');
    await savedChain(user, projectId, 3);
    await useFake({ reply: (r) => (r.agent === 'image' ? { status: 403, json: { error: { code: 'organization_not_verified', type: 'invalid_request_error', message: `Your organization must be verified to use ${IMAGE}. ${KEY}` } } } : undefined) });
    const run = await runFactory(user, projectId, { rerunCreative: true, f4: { concepts: 3, maxImages: 3 } });
    expect(run.status).toBe('partial');
    expect(run.outcome).toBe('partial');
    expect(run.errorMessage).toMatch(/3 of 3 concept\(s\) have no AI image/);
    expect(run.errorMessage).toMatch(/verif/i);
    expect(run.warnings.join(' ')).toMatch(/have no AI image/);
    expect(fake.imageCalls()).toHaveLength(2); // a permission problem hits every concept: the third request is not sent
    const pkg = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body.package;
    expect(pkg.imageResults).toHaveLength(3);
    expect(pkg.imageResults.filter((r: any) => r.requestAttempted)).toHaveLength(2);
    expect(pkg.imageResults.every((r: any) => r.outcome === 'failed' && r.fallbackUsed && r.explanation)).toBe(true);
    expect(pkg.imageResults.find((r: any) => r.requestAttempted)).toMatchObject({ stage: 'provider', errorCode: 'permission_denied', providerStatus: 403, providerCode: 'organization_not_verified' });
    expect(pkg.imageAssets.some((a: any) => a.source === 'ai_image')).toBe(false);
    // the fallbacks of different concepts are not one identical rectangle
    const hashes = pkg.imageAssets.filter((a: any) => a.kind === 'image' && a.source === 'brand_gradient').map((a: any) => a.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
    // the activity says it, per concept
    const ev = (await user.agent.get(`/factory-runs/${run.id}/events`).expect(200)).body;
    const visual = ev.items.filter((e: any) => e.type === 'visual.generated');
    expect(visual).toHaveLength(3);
    expect(visual.every((e: any) => /NO AI image/.test(e.summary))).toBe(true);
    expect(JSON.stringify([run, pkg, ev])).not.toContain(KEY);
  }, 300_000);

  it('the explicit "Test image model" action: refuses a shut-down model without a request, makes exactly one request otherwise, explains a refusal, and has a cooldown', async () => {
    const { user } = await readyUser('fac-imgtest');
    const post = (imageModel: string) => user.agent.post('/integrations/openai/image-test').send({ imageModel });
    // listing never means usable
    await useFake({ models: [MODEL, 'gpt-image-1', IMAGE] });
    const models = (await user.agent.get('/integrations/openai/models').expect(200)).body;
    expect(models.models.find((m: any) => m.id === 'gpt-image-1').retired).toMatchObject({ on: '2026-10-23' });
    expect(models.models.find((m: any) => m.id === IMAGE).retired).toBeNull();
    expect(models.suggestedImageModel).toBe(IMAGE);

    const retired = (await post('gpt-image-1').expect(200)).body;
    expect(retired).toMatchObject({ ok: false, requestMade: false, error: { code: 'retired_model', stage: 'configuration' } });
    expect(retired.error.explanation).toMatch(/shut down gpt-image-1/);
    expect(fake.imageCalls()).toHaveLength(0);

    const ok = (await post('auto').expect(200)).body;
    expect(ok).toMatchObject({ ok: true, model: IMAGE, requestMade: true });
    expect(fake.imageCalls()).toHaveLength(1);
    expect(fake.imageCalls()[0].body).toMatchObject({ model: IMAGE, quality: 'low', size: '1024x1024', n: 1 });
    expect(JSON.stringify(ok)).not.toContain('b64');
    await post(IMAGE).expect(429); // each test is billed: no double clicks

    const { user: u2 } = await readyUser('fac-imgtest2');
    await useFake({ reply: (r) => (r.agent === 'image' ? { status: 403, json: { error: { code: 'organization_not_verified', message: 'Your organization must be verified.' } } } : undefined) });
    const refused = (await u2.agent.post('/integrations/openai/image-test').send({ imageModel: IMAGE }).expect(200)).body;
    expect(refused).toMatchObject({ ok: false, requestMade: true, error: { code: 'permission_denied', stage: 'provider', status: 403, providerCode: 'organization_not_verified' } });
    expect(refused.error.explanation).toMatch(/verif/i);
    expect(fake.imageCalls()).toHaveLength(1); // no automatic retry
    expect(JSON.stringify(refused)).not.toContain(KEY);
    await u2.agent.post('/integrations/openai/image-test').send({ imageModel: 'gpt-4.1-mini' }).expect(400);
  });

  it('a legitimate review issue is repaired inside the factory: the Fixer is created at run time and the Reviewer verifies; an unresolved issue is never labeled approved', async () => {
    const { user, projectId } = await readyUser('fac-fix');
    await savedChain(user, projectId, 3);
    const badCopy = (r: FakeRequest): FakeReply | undefined => {
      if (r.agent !== 'copywriter' || r.kind !== 'analysis' || r.lastUserText.includes('Revise ONLY')) return undefined;
      const copy = defaultCopy(r.lastUserText);
      copy.variants[0].body = `${copy.variants[0].body} Guaranteed results for everyone.`;
      return { text: JSON.stringify(copy) };
    };
    await useFake({ reply: badCopy });
    const done = await runFactory(user, projectId, { rerunCreative: true });
    expect(done.status).toBe('completed');
    expect(done.outcome).toBe('approved');
    const ev = (await user.agent.get(`/factory-runs/${done.id}/events`).expect(200)).body.items.map((e: any) => e.type);
    const regAt = ev.indexOf('participant.registered');
    expect(regAt).toBeGreaterThan(ev.indexOf('review.completed'));
    expect(ev).toEqual(expect.arrayContaining(['fix.requested', 'revision.requested', 'revision.applied', 'revision.completed']));
    expect(ev.filter((t: string) => t === 'review.requested').length).toBe(2);
    expect(fake.imageCalls()).toHaveLength(1); // a text repair never buys another image

    // a copywriter that keeps the promise: the bounded loop ends and the campaign is honestly "unresolved"
    await useFake({
      reply: (r) => {
        if (r.agent === 'copywriter' && r.lastUserText.includes('Revise ONLY')) {
          const variants = JSON.parse(/<variants>\n([\s\S]*?)\n<\/variants>/.exec(r.lastUserText)![1]);
          return { text: JSON.stringify({ revisions: variants.map((v: any) => ({ variantId: v.id, headline: v.headline, body: v.body, ctaText: v.ctaText, hashtags: [], claims: [] })) }) };
        }
        return badCopy(r);
      },
    });
    const stuck = await runFactory(user, projectId, { rerunCreative: true });
    expect(stuck.status).toBe('completed');
    expect(stuck.approvalStatus).toBe('unresolved');
    expect(stuck.outcome).toBe('unresolved');
    expect(stuck.outcome).not.toBe('approved');
    expect(textCalls().length).toBeLessThanOrEqual(12); // the F4 cap holds across the repair rounds
  }, 300_000);

  // ---- cancellation, refresh, restart ----------------------------------------------------------------------------------------------

  it('CANCEL during F1: the active phase is aborted, later phases never start, other projects are untouched', async () => {
    const { user, projectId } = await readyUser('fac-c1');
    const bystander = await createProject(user, 'Bystander');
    await db.campaignRun.create({ data: { projectId: bystander, userId: user.id, mode: 'product_discovery', status: 'RUNNING' } }); // an unrelated running run
    await useFake({ reply: (r) => (F1_AGENTS.includes(r.agent) ? { hang: true } : undefined) });
    const started = (await startF(user, projectId).expect(201)).body;
    await waitUntil(async () => textCalls().length > 0 && !!phase(await getF(user, started.id), 'discovery').runId);
    const cancelled = (await user.agent.post(`/factory-runs/${started.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', outcome: 'cancelled', cancelRequested: true });
    expect(states(cancelled)).toEqual(['cancelled', 'skipped', 'skipped', 'skipped']);
    await sleep(150);
    expect(textCalls().every((r) => r.aborted)).toBe(true);
    const n = textCalls().length;
    await sleep(200);
    expect(textCalls().length).toBe(n); // nothing requested after the cancel
    expect(only(F1_AGENTS)).toBe(true);
    expect(await db.campaignRun.findFirstOrThrow({ where: { projectId: bystander } })).toMatchObject({ status: 'RUNNING' }); // unrelated run untouched
    await user.agent.post(`/factory-runs/${started.id}/cancel`).expect(409); // already finished
    // the project is free again: a normal phase run works right away
    await useFake();
    await direct(user, projectId, 'product-discovery');
  }, 120_000);

  it('CANCEL during F3 keeps F1/F2 and never starts F4; CANCEL during image generation aborts the request and marks the campaign cancelled', async () => {
    const { user, projectId } = await readyUser('fac-c3');
    await savedChain(user, projectId, 2);
    await useFake({ reply: (r) => (r.agent === 'audience' ? { hang: true } : undefined) });
    const s3 = (await startF(user, projectId).expect(201)).body;
    await waitUntil(async () => fake.requests.some((r) => r.agent === 'audience') && phase(await getF(user, s3.id), 'strategy').status === 'running');
    const c3 = (await user.agent.post(`/factory-runs/${s3.id}/cancel`).expect(200)).body;
    expect(c3.status).toBe('cancelled');
    expect(states(c3)).toEqual(['reused', 'reused', 'cancelled', 'skipped']);
    await sleep(200);
    expect(fake.requests.some((r) => F4_AGENTS.includes(r.agent) || r.agent === 'image')).toBe(false);
    expect(await db.marketingStrategyReport.count({ where: { projectId } })).toBe(0);

    await useFake();
    await direct(user, projectId, 'market-strategy', { maxScouts: 2 });
    await useFake({ reply: (r) => (r.agent === 'image' ? { hang: true } : undefined) });
    const s4 = (await startF(user, projectId).expect(201)).body;
    await waitUntil(() => fake.imageCalls().length > 0, 60_000);
    const c4 = (await user.agent.post(`/factory-runs/${s4.id}/cancel`).expect(200)).body;
    expect(c4.status).toBe('cancelled');
    expect(states(c4)).toEqual(['reused', 'reused', 'reused', 'cancelled']);
    await sleep(200);
    expect(fake.imageCalls().every((c) => c.aborted)).toBe(true);
    const camp = await db.creativeCampaign.findUniqueOrThrow({ where: { runId: phase(c4, 'creative').runId } });
    expect([camp.status, camp.packageJson]).toEqual(['cancelled', null]);
    expect(c4.campaignId).toBeNull();
  }, 200_000);

  it('a server restart while a campaign run is active marks it INTERRUPTED (never completed, never resumed, no paid request)', async () => {
    const { user, projectId } = await readyUser('fac-restart');
    const run = await db.campaignRun.create({ data: { projectId, userId: user.id, mode: 'product_discovery', status: 'RUNNING' } });
    const now = new Date().toISOString();
    const phases = ['discovery', 'audit', 'strategy', 'creative'].map((k, i) => ({ phase: k, code: `F${i + 1}`, title: k, action: 'run', status: i === 0 ? 'running' : 'pending', runId: i === 0 ? run.id : null, outputId: null, startedAt: i === 0 ? now : null, completedAt: null, error: null, reused: null }));
    const orphan = await db.factoryRun.create({ data: { projectId, userId: user.id, mode: 'continue', status: 'running', currentPhase: 'discovery', configJson: {}, phasesJson: phases, startedAt: new Date() } });
    fake.requests.length = 0;
    const app2 = await createApp(); // the "restarted" process
    try {
      const agent2 = await loginUser(app2, user.email);
      const v = (await agent2.get(`/factory-runs/${orphan.id}`).expect(200)).body;
      expect(v).toMatchObject({ status: 'interrupted', outcome: 'interrupted', currentPhase: null });
      expect(states(v)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
      expect(v.errorMessage).toMatch(/Nothing was resumed or repeated/);
      expect((await db.campaignRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('INTERRUPTED');
      expect(fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'))).toHaveLength(0);
      await agent2.post(`/factory-runs/${orphan.id}/cancel`).expect(409);
    } finally {
      await app2.close();
    }
  }, 60_000);

  it('a graceful shutdown while a campaign runs marks it INTERRUPTED (the phase aborted, later phases never started, nothing resumed)', async () => {
    const { user, projectId } = await readyUser('fac-shutdown');
    await useFake({ reply: (r) => (F1_AGENTS.includes(r.agent) ? { hang: true } : undefined) });
    const app3 = await createApp(); // a separate "process" that is then shut down
    const agent3 = await loginUser(app3, user.email);
    const started = (await agent3.post(`/projects/${projectId}/factory`).send({}).expect(201)).body;
    await waitUntil(async () => textCalls().length > 0 && !!(await db.factoryRun.findUnique({ where: { id: started.id } }))?.currentPhase);
    await app3.close();
    const f = await db.factoryRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(f.status).toBe('interrupted');
    const ph = f.phasesJson as unknown as { phase: string; status: string; runId: string | null }[];
    expect(ph.map((p) => p.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect((await db.campaignRun.findUniqueOrThrow({ where: { id: ph[0].runId! } })).status).toBe('INTERRUPTED');
    expect(only(F1_AGENTS)).toBe(true);
    await sleep(150);
    expect(textCalls().every((r) => r.aborted)).toBe(true);
  }, 90_000);

  // ---- isolation -------------------------------------------------------------------------------------------------------------------

  it('two users run complete campaigns at the same time: separate keys, separate chains, separate campaigns and ZIPs', async () => {
    const KEY_B = 'sk-test-FACTORYE2E-B-34567890abcdefghij';
    const [a, b] = await Promise.all([readyUser('fac-ca', 'Deep Diving School'), readyUser('fac-cb', 'TaskFlow', KEY_B)]);
    fake.requests.length = 0;
    const [ra, rb] = await Promise.all([startF(a.user, a.projectId), startF(b.user, b.projectId)]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    const [da, dbv] = await Promise.all([waitF(a.user, ra.body.id), waitF(b.user, rb.body.id)]);
    expect([da.status, dbv.status]).toEqual(['completed', 'completed']);
    const keys = new Set(fake.requests.map((r) => r.authorization));
    expect(keys).toEqual(new Set([`Bearer ${KEY}`, `Bearer ${KEY_B}`]));
    expect(da.campaignId).not.toBe(dbv.campaignId);
    const ca = await db.creativeCampaign.findUniqueOrThrow({ where: { id: da.campaignId } });
    const cb = await db.creativeCampaign.findUniqueOrThrow({ where: { id: dbv.campaignId } });
    expect([ca.projectId, cb.projectId]).toEqual([a.projectId, b.projectId]);
    expect(await db.campaignAsset.count({ where: { campaignId: da.campaignId, projectId: { not: a.projectId } } })).toBe(0);
    await a.user.agent.get(`/factory-runs/${dbv.id}`).expect(404);
    await a.user.agent.get(`/campaigns/${dbv.campaignId}/export`).expect(404);
    expect(JSON.stringify([da, dbv])).not.toMatch(/sk-test/);
  }, 300_000);
});
