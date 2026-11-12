import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MozaikService, type CreativeStartOptions, type StrategyStartOptions } from '../src/mozaik/mozaik.service';

export type Agent = ReturnType<typeof request.agent>;

export async function createApp(customize?: (b: TestingModuleBuilder) => TestingModuleBuilder) {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

let counter = 0;
export const uniqueEmail = (label: string) => `${label}-${Date.now()}-${counter++}@test.launchpilot.dev`;

export interface TestUser {
  agent: Agent;
  id: string;
  email: string;
}

/** Registers a user and returns a supertest agent that carries the session cookie. */
export async function registerUser(app: INestApplication, label = 'user'): Promise<TestUser> {
  const agent = request.agent(app.getHttpServer());
  const email = uniqueEmail(label);
  const res = await agent.post('/auth/register').send({ name: 'Test User', email, password: 'password123' }).expect(201);
  return { agent, id: res.body.user.id, email };
}

export async function createProject(user: TestUser, name = 'Smoke Project') {
  const res = await user.agent.post('/projects').send({ name }).expect(201);
  return res.body.id as string;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls GET /runs/:id until it leaves RUNNING. */
export async function waitForTerminal(user: TestUser, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await user.agent.get(`/runs/${runId}`).expect(200);
    if (res.body.status !== 'RUNNING') return res.body as Record<string, any>;
    if (Date.now() > deadline) throw new Error(`Run ${runId} still RUNNING after ${timeoutMs} ms`);
    await sleep(25);
  }
}

export async function allEvents(user: TestUser, runId: string) {
  const res = await user.agent.get(`/runs/${runId}/events?limit=500`).expect(200);
  return res.body.items as { sequence: number; eventType: string; participant: string | null; payload: any }[];
}

export async function loginUser(app: INestApplication, email: string): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/auth/login').send({ email, password: 'password123' }).expect(200);
  return agent;
}

/** Saves an OpenAI key (and optionally a model) the way a user would in Settings. */
export async function configureOpenAi(user: TestUser, apiKey: string, model?: string) {
  await user.agent.post('/integrations/configure-api-key').send({ providerKey: 'openai', apiKey, setAsDefault: true }).expect(200);
  if (model) await user.agent.put('/integrations/openai/model').send({ model }).expect(200);
}

// ---- V4 Campaign Production ---------------------------------------------------------------------------------------------------
// V4 has ONE HTTP entry point that spends anything: POST /projects/:id/factory (after the free preflight). There are no per-stage
// start routes any more. A spec that needs ONE stage on its own (F1, F3 or F4) calls the very same MozaikService method the
// Campaign Production orchestrator calls; the run is then observed over HTTP like any other run (GET /runs/:id).

type Obj = Record<string, any>;
type StageHooks = Record<string, unknown>;
const stages = (app: INestApplication) => app.get(MozaikService);

/** Starts Business Research (F1) for the user's project. Rejects with the same HttpException the orchestrator would see. */
export async function startF1(app: INestApplication, user: TestUser, projectId: string, hooks: StageHooks = {}) {
  return (await stages(app).startProductDiscovery(user.id, projectId, {}, hooks as never)) as Obj;
}

/** Starts Marketing Strategy (F3) on a saved F1 report. */
export async function startF3(app: INestApplication, user: TestUser, projectId: string, f1ReportId: string, o: Partial<StrategyStartOptions> = {}, hooks: StageHooks = {}) {
  return (await stages(app).startMarketStrategy(user.id, projectId, { f1ReportId, objective: null, targetAudience: null, competitorUrls: [], useHolidayCalendar: false, ...o }, hooks as never)) as Obj;
}

/** Starts Creative Production (F4) on a saved strategy. `design` is the campaign design (HybridSettings patch), as the factory passes it. */
export async function startF4(app: INestApplication, user: TestUser, projectId: string, strategyId: string, o: Partial<CreativeStartOptions> = {}, hooks: StageHooks = {}) {
  return (await stages(app).startCreativeProduction(user.id, projectId, { strategyId, channels: ['instagram'], concepts: 1, objective: null, audience: null, design: {}, ...o }, hooks as never)) as Obj;
}

/** F1 -> F3 -> F4 one stage after the other (each waited for), for specs that need a saved chain without the orchestrator. */
export async function runChain(app: INestApplication, user: TestUser, projectId: string, f4: Partial<CreativeStartOptions> = {}, timeoutMs = 60_000) {
  const f1 = await waitForTerminal(user, (await startF1(app, user, projectId)).id, timeoutMs);
  const f3 = await waitForTerminal(user, (await startF3(app, user, projectId, f1.reportId)).id, timeoutMs);
  const f4run = await waitForTerminal(user, (await startF4(app, user, projectId, f3.strategyId, f4)).id, timeoutMs);
  return { f1, f3, f4: f4run };
}

/** The format keys a V4 test design asks for (supported by the collections used in the specs). */
export const TEST_DESIGN_FORMATS = ['instagram_post', 'instagram_story', 'website_banner'];

/** A NEW design draft of the project in the given collection, confirmed (Campaign Production refuses an unconfirmed design). */
export async function confirmedDesign(user: TestUser, projectId: string, collectionId = 'premium_editorial', over: Obj = {}) {
  const d = (await user.agent.post(`/projects/${projectId}/design/new`).send({ collectionId }).expect(200)).body.design;
  return { ...d, formats: TEST_DESIGN_FORMATS, confirmed: true, ...over } as Obj;
}

/** The request body of "Generate Campaign": the design, ONE approved budget and the explicit confirmation of the estimate. */
export const campaignRequest = (design: Obj | null, extra: Obj = {}) => ({ ...(design ? { design: { design } } : {}), approvedBudgetUsd: 5, confirmCost: true, ...extra });

/** Polls GET /factory-runs/:id until the campaign run leaves queued/running. */
export async function waitForFactory(user: TestUser, id: string, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = (await user.agent.get(`/factory-runs/${id}`).expect(200)).body;
    if (!['queued', 'running'].includes(v.status)) return v as Obj;
    if (Date.now() > deadline) throw new Error(`Campaign run ${id} still ${v.status} after ${timeoutMs} ms`);
    await sleep(150);
  }
}

/** Downloads a binary response (ZIP, PNG) as a Buffer. */
export const binary = (agent: Agent, path: string) =>
  agent.get(path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
