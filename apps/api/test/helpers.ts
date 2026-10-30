import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

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
