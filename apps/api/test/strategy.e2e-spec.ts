import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CampaignStrategyReport, HolidayTool, TavilySearch, WebFetchTool } from '@launchpilot/agents';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { FakeNager, FakeTavily, FakeWebsite, htmlPage } from '@launchpilot/agents/dist/testing/fake-services';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { allEvents, configureOpenAi, createApp, createProject, loginUser, registerUser, sleep, waitForTerminal, type TestUser } from './helpers';

// F3 Market Research & Strategy end to end: HTTP API -> NestJS -> real Mozaik runtime with DYNAMICALLY created Channel
// Scouts -> fake OpenAI / competitor sites / search / holiday servers -> PostgreSQL. Nothing leaves the machine.
describe('Market Research & Strategy (real Mozaik agents, dynamic scouts, fake OpenAI and fixtures)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  const KEY = 'sk-test-STRATE2E1234567890abcdefghij';
  const MODEL = 'gpt-test-mini';

  async function useFake(options?: FakeOpenAIOptions) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI(options).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }

  async function readyUser(label: string, key = KEY, projectName = 'Bike Repair Shop') {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, projectName);
    await user.agent
      .put(`/projects/${projectId}/intake`)
      .send({ productName: projectName, shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad, Serbia', preferredLanguage: 'en' })
      .expect(200);
    await configureOpenAi(user, key, MODEL);
    return { user, projectId };
  }

  const startF1 = (u: TestUser, projectId: string) => u.agent.post(`/projects/${projectId}/runs/product-discovery`).send({});
  const startF2 = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/runs/marketing-audit`).send(body);
  const startF3 = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/runs/market-strategy`).send(body);

  async function withF1(label: string, key = KEY, projectName = 'Bike Repair Shop') {
    const ctx = await readyUser(label, key, projectName);
    const f1 = await waitForTerminal(ctx.user, (await startF1(ctx.user, ctx.projectId).expect(201)).body.id);
    expect(f1.status).toBe('COMPLETED');
    return { ...ctx, f1ReportId: f1.reportId as string };
  }
  async function withF2(label: string, key = KEY, projectName = 'Bike Repair Shop') {
    const ctx = await withF1(label, key, projectName);
    const f2 = await waitForTerminal(ctx.user, (await startF2(ctx.user, ctx.projectId).expect(201)).body.id);
    expect(f2.status).toBe('COMPLETED');
    return { ...ctx, auditId: f2.auditId as string };
  }

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

  it('refuses to start without a completed F1 and F2, validates limits, and never bills for a refusal', async () => {
    const { user, projectId } = await readyUser('str-nof1');
    const none = await startF3(user, projectId).expect(422);
    expect(none.body.message).toMatch(/Product Discovery \(F1\) report and a Marketing Audit \(F2\)/);

    const withOnlyF1 = await withF1('str-nof2');
    const noF2 = await startF3(withOnlyF1.user, withOnlyF1.projectId).expect(422);
    expect(noF2.body.message).toMatch(/needs a completed Marketing Audit \(F2\)/);
    await startF3(withOnlyF1.user, withOnlyF1.projectId, { auditId: 'does-not-exist' }).expect(404);

    fake.requests.length = 0;
    await startF3(user, projectId, { maxModelCalls: 2 }).expect(400);
    await startF3(user, projectId, { maxScouts: 9 }).expect(400);
    await startF3(user, projectId, { maxReviews: 50 }).expect(400);
    await startF3(user, projectId, { competitorUrls: ['not a url'] }).expect(400);
    await startF3(user, projectId, { competitorUrls: ['ftp://x.test/a'] }).expect(400);
    expect(fake.requests).toHaveLength(0);
    expect(await db.campaignRun.count({ where: { userId: user.id, mode: 'market_strategy' } })).toBe(0);
  });

  it('runs F1 -> F2 -> F3 through the real runtime: dynamic scouts, saved BEFORE completing, tied to the exact F1 report and F2 audit', async () => {
    const { user, projectId, f1ReportId, auditId } = await withF2('str-happy');
    fake.requests.length = 0;
    const started = (await startF3(user, projectId, { maxScouts: 3 }).expect(201)).body;
    expect(started).toMatchObject({ mode: 'market_strategy', label: 'Market Research & Strategy', status: 'RUNNING', provider: 'openai', strategyId: null });
    const done = await waitForTerminal(user, started.id, 20_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.strategyId).toBeTruthy();

    // Without search or competitor URLs the Competitor Researcher reports insufficient research and spends NO model call.
    const calls = fake.requests.map((r) => `${r.agent}:${r.kind}`);
    expect(calls.filter((c) => c === 'competitor:analysis')).toHaveLength(0);
    expect(calls.filter((c) => c === 'scout:analysis')).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining(['audience:analysis', 'seasonal:analysis', 'strategist:synthesis']));
    for (const r of fake.requests) {
      expect(r.authorization).toBe(`Bearer ${KEY}`);
      expect(r.body).toMatchObject({ model: MODEL, store: false });
    }

    const full = (await user.agent.get(`/strategies/${done.strategyId}`).expect(200)).body;
    expect(CampaignStrategyReport.safeParse(full.report).success).toBe(true);
    expect(full).toMatchObject({ projectId, runId: started.id, f1ReportId, f2AuditId: auditId, model: MODEL, schemaVersion: 1 });
    expect(full.report.creativeBrief.provenance).toMatchObject({ f1ReportId, f2AuditId: auditId, strategyRunId: started.id });
    expect(full.metadata.f2.auditId).toBe(auditId);
    expect(full.metadata.scoutDecisions).toHaveLength(9);
    expect(full.metadata.scoutDecisions.filter((d: any) => d.selected)).toHaveLength(3);
    expect(full.report.competitorLandscape.profiles).toHaveLength(0);
    expect(full.report.competitorLandscape.gaps.join(' ')).toMatch(/No search provider/);
    expect(JSON.stringify(full)).not.toContain(KEY);

    const row = await db.marketingStrategyReport.findUniqueOrThrow({ where: { runId: started.id } });
    const run = await db.campaignRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(run.completedAt!.getTime());

    const events = await allEvents(user, started.id);
    const types = events.map((e) => e.eventType);
    for (const t of ['factory.started', 'phase.started', 'participant.registered', 'participant.idle', 'task.assigned', 'source.retrieved', 'finding.posted', 'crosscheck.requested', 'crosscheck.answered', 'phase.ready', 'strategy.completed', 'phase.completed', 'factory.completed']) expect(types).toContain(t);
    expect(types.filter((t) => t === 'participant.registered')).toHaveLength(3);
    expect(types.indexOf('participant.registered')).toBeGreaterThan(types.indexOf('finding.posted'));
    expect(events.find((e) => e.eventType === 'strategy.completed')!.payload).toEqual({ stored: 'MarketingStrategyReport' });
    expect(JSON.stringify(events)).not.toContain(KEY);

    for (const path of [`/runs/${started.id}/strategy-analysis`, `/runs/${started.id}/analysis`]) {
      const a = (await user.agent.get(path).expect(200)).body;
      expect(a).toMatchObject({ kind: 'strategy', source: 'report', reportId: done.strategyId });
      expect(a.scoutDecisions).toHaveLength(9);
      expect(a.plan.activated.filter((p: any) => p.dynamic)).toHaveLength(3);
      expect(a.aiCalls['Campaign Strategist']).toBe(1);
      expect(a.f2.auditId).toBe(auditId);
    }
    // F1 and F2 are untouched
    expect((await user.agent.get(`/reports/${f1ReportId}`).expect(200)).body.schemaVersion).toBe(2);
    expect((await user.agent.get(`/audits/${auditId}`).expect(200)).body.f1ReportId).toBe(f1ReportId);
    expect((await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body.map((r: any) => r.mode).sort()).toEqual(['market_strategy', 'marketing_audit', 'product_discovery']);
  }, 60000);

  it('paginates strategies, never overwrites older ones, and survives a backend restart', async () => {
    const { user, projectId } = await withF2('str-list');
    const a = await waitForTerminal(user, (await startF3(user, projectId, { maxScouts: 1 }).expect(201)).body.id, 20_000);
    const b = await waitForTerminal(user, (await startF3(user, projectId, { maxScouts: 1 }).expect(201)).body.id, 20_000);
    expect(a.strategyId).not.toBe(b.strategyId);
    const page1 = (await user.agent.get(`/projects/${projectId}/strategies?limit=1`).expect(200)).body;
    expect(page1.items[0]).toMatchObject({ id: b.strategyId, partial: false, model: MODEL, scouts: 1 });
    const page2 = (await user.agent.get(`/projects/${projectId}/strategies?limit=1&cursor=${page1.nextCursor}`).expect(200)).body;
    expect(page2.items[0].id).toBe(a.strategyId);
    expect(page2.nextCursor).toBeNull();
    const first = (await user.agent.get(`/strategies/${a.strategyId}`)).body;
    const app2 = await createApp();
    try {
      const agent2 = await loginUser(app2, user.email);
      expect((await agent2.get(`/strategies/${a.strategyId}`).expect(200)).body).toEqual(first);
      expect((await agent2.get(`/projects/${projectId}/strategies`).expect(200)).body.items).toHaveLength(2);
    } finally {
      await app2.close();
    }
  }, 60000);

  it('isolates users and projects: no cross-user or cross-project use of audits; a tampered F1/F2 pair is refused', async () => {
    const { user, projectId, auditId, f1ReportId } = await withF2('str-iso');
    const done = await waitForTerminal(user, (await startF3(user, projectId, { maxScouts: 1 }).expect(201)).body.id, 20_000);
    const intruder = await registerUser(app, 'str-intruder');
    await intruder.agent.get(`/strategies/${done.strategyId}`).expect(404);
    await intruder.agent.get(`/projects/${projectId}/strategies`).expect(404);
    await intruder.agent.get(`/runs/${done.id}/strategy-analysis`).expect(404);
    await startF3(intruder, projectId).expect(404);

    // the same user's OTHER project cannot borrow this project's audit
    const other = await readyUser('str-iso-other');
    await startF3(user, other.projectId, { auditId }).expect(404);
    await startF3(other.user, other.projectId, { auditId }).expect(404);

    // a (corrupted) audit that points at an F1 report of another project is refused, not combined
    const foreignF1 = await withF1('str-iso-f1');
    await db.marketingAuditReport.update({ where: { id: auditId }, data: { f1ReportId: foreignF1.f1ReportId } });
    try {
      const res = await startF3(user, projectId, { auditId }).expect(422);
      expect(res.body.message).toMatch(/does not belong to this project/);
    } finally {
      await db.marketingAuditReport.update({ where: { id: auditId }, data: { f1ReportId } });
    }
    const request = (await import('supertest')).default;
    await request(app.getHttpServer()).get(`/strategies/${done.strategyId}`).expect(401);
    await request(app.getHttpServer()).post(`/projects/${projectId}/runs/market-strategy`).send({}).expect(401);
  }, 60000);

  it('makes no paid call on page loads or listings; a duplicate start is rejected without model calls', async () => {
    const { user, projectId } = await withF2('str-free');
    fake.requests.length = 0;
    await user.agent.get(`/projects/${projectId}/strategies`).expect(200);
    await user.agent.get(`/projects/${projectId}/runs`).expect(200);
    expect(fake.requests).toHaveLength(0);
    await useFake({ reply: (r) => (r.kind === 'analysis' ? { delayMs: 300 } : undefined) });
    const results = await Promise.all([startF3(user, projectId, { maxScouts: 1 }), startF3(user, projectId, { maxScouts: 1 })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await waitForTerminal(user, results.find((r) => r.status === 201)!.body.id, 20_000)).status).toBe('COMPLETED');
  }, 60000);

  it('keeps simultaneous strategies of different users isolated: each uses only its own key and data', async () => {
    const keyA = 'sk-test-STRUSERA1234567890abcdefghij';
    const keyB = 'sk-test-STRUSERB1234567890abcdefghij';
    const a = await withF2('str-iso-a', keyA, 'PROJECT-ALPHA');
    const b = await withF2('str-iso-b', keyB, 'PROJECT-BETA');
    fake.requests.length = 0;
    const [ra, rb] = await Promise.all([startF3(a.user, a.projectId, { maxScouts: 2 }).expect(201), startF3(b.user, b.projectId, { maxScouts: 2 }).expect(201)]);
    const [da, db2] = await Promise.all([waitForTerminal(a.user, ra.body.id, 20_000), waitForTerminal(b.user, rb.body.id, 20_000)]);
    expect([da.status, db2.status]).toEqual(['COMPLETED', 'COMPLETED']);
    const mine = (m: string) => fake.requests.filter((r) => JSON.stringify(r.body).includes(m));
    expect(mine('PROJECT-ALPHA').length).toBeGreaterThanOrEqual(5);
    expect(mine('PROJECT-ALPHA').every((r) => r.authorization === `Bearer ${keyA}`)).toBe(true);
    expect(mine('PROJECT-BETA').every((r) => r.authorization === `Bearer ${keyB}`)).toBe(true);
    expect((await a.user.agent.get(`/strategies/${da.strategyId}`)).body.report.productContext.name).toBe('PROJECT-ALPHA');
  }, 60000);

  it('fails safely on an invalid key: no strategy, safe message, and no scout is ever created', async () => {
    const { user, projectId } = await withF2('str-401');
    await useFake({ validKeys: ['sk-test-someone-elses-key-xxxxxxxxxxxx'] });
    const run = await waitForTerminal(user, (await startF3(user, projectId).expect(201)).body.id, 20_000);
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toMatch(/rejected the API key/);
    expect(run.strategyId).toBeNull();
    const events = await allEvents(user, run.id);
    expect(events.map((e) => e.eventType)).not.toContain('participant.registered');
    const stored = JSON.stringify([await db.campaignEvent.findMany({ where: { runId: run.id } }), run]);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain('Incorrect API key provided');
    expect(await db.marketingStrategyReport.count({ where: { projectId } })).toBe(0);
  }, 60000);

  it('cancellation after the scouts were created aborts their requests and saves nothing; the live analysis shows the dynamic participants from the persisted events', async () => {
    const { user, projectId } = await withF2('str-cancel');
    await useFake({ reply: (r) => (r.agent === 'scout' ? { hang: true } : undefined) });
    const started = (await startF3(user, projectId, { maxScouts: 2 }).expect(201)).body;
    let analysis: any;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      analysis = (await user.agent.get(`/runs/${started.id}/strategy-analysis`).expect(200)).body;
      if ((analysis.plan?.activated ?? []).filter((p: any) => p.dynamic).length >= 2 && fake.calls('scout').length >= 2) break;
    }
    expect(analysis.source).toBe('events');
    expect(analysis.kind).toBe('strategy');
    expect(analysis.plan.activated.filter((p: any) => p.dynamic)).toHaveLength(2);
    expect(analysis.scoutDecisions.filter((d: any) => d.selected)).toHaveLength(2);
    expect(analysis.plan.skipped.some((p: any) => /Scout$/.test(p.agent))).toBe(true);
    const cancelled = (await user.agent.post(`/runs/${started.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', strategyId: null });
    await sleep(200);
    expect(fake.requests.filter((r) => r.agent === 'scout').every((r) => r.aborted)).toBe(true);
    const types = (await allEvents(user, started.id)).map((e) => e.eventType);
    expect(types[types.length - 1]).toBe('factory.cancelled');
    expect(types).not.toContain('strategy.completed');
    expect(await db.marketingStrategyReport.count({ where: { projectId } })).toBe(0);
  }, 60000);

  it('an unexpected persistence error becomes a FAILED run, not a crash', async () => {
    const { user, projectId } = await withF2('str-sinkfail');
    const svc = app.get(MozaikService) as any;
    const original = svc.prisma.marketingStrategyReport.create;
    svc.prisma.marketingStrategyReport.create = async () => {
      throw new Error('simulated database outage');
    };
    try {
      const run = await waitForTerminal(user, (await startF3(user, projectId, { maxScouts: 1 }).expect(201)).body.id, 20_000);
      expect(run.status).toBe('FAILED');
      expect(run.errorMessage).toMatch(/simulated database outage/);
      expect(run.strategyId).toBeNull();
    } finally {
      svc.prisma.marketingStrategyReport.create = original;
    }
  }, 60000);

  it('with competitor pages, search and holiday fixtures: competitors are confirmed from retrieved pages, holidays come from the calendar, and everything persists', async () => {
    const { user, projectId } = await withF2('str-fix', KEY, 'Deep Diving School');
    const rivalA = await new FakeWebsite().start();
    const rivalB = await new FakeWebsite().start();
    const tav = await new FakeTavily().start();
    const nager = await new FakeNager().start();
    rivalA.page('/', htmlPage({ title: 'Rival Dive Centre', paragraphs: ['Premium diving courses.'] }));
    rivalB.page('/', htmlPage({ title: 'Blue Depths', paragraphs: ['Premium instruction.'] }));
    tav.results = [
      { title: 'Rival Dive Centre', url: `${rivalA.origin}/`, content: 'Premium diving courses.', score: 0.9 },
      { title: 'Blue Depths', url: `${rivalB.origin}/`, content: 'Premium instruction.', score: 0.8 },
    ];
    const year = new Date().getUTCFullYear();
    nager.holidays = [{ date: `${year}-12-24`, name: 'Christmas Eve', localName: 'Badnji dan' }, { date: `${year + 1}-01-01`, name: 'New Year', localName: 'Nova godina' }];
    try {
      const svc = app.get(MozaikService);
      const web = new WebFetchTool({ policy: { allowedPorts: new Set([rivalA, rivalB].map((s) => Number(new URL(s.origin).port))), allowLoopbackForTests: true }, timeoutMs: 2000, maxPages: 20 });
      const started = await svc.startMarketStrategy(user.id, projectId, { useHolidayCalendar: true, competitorUrls: [] }, { fixtureSources: true, now: new Date(`${year}-11-20T00:00:00Z`), tools: { web, search: new TavilySearch({ apiKey: 'tvly-test-KEY-1234567890', baseUrl: tav.origin }), holidays: new HolidayTool({ baseUrl: nager.origin }) } });
      const done = await waitForTerminal(user, started.id, 25_000);
      expect(done.status).toBe('COMPLETED');
      const full = (await user.agent.get(`/strategies/${done.strategyId}`).expect(200)).body;
      expect(CampaignStrategyReport.safeParse(full.report).success).toBe(true);
      expect(full.report.competitorLandscape.searchUsed).toBe(true);
      expect(full.report.competitorLandscape.profiles.filter((p: any) => p.competitor.existence === 'confirmed').length).toBeGreaterThanOrEqual(1);
      expect(full.report.seasonalOpportunities.holidayCalendar).toMatchObject({ used: true, note: expect.stringContaining('FIXTURE') });
      expect(full.metadata.sources.some((s: any) => s.kind === 'holiday_calendar' && s.origin === 'fixture')).toBe(true);
      expect(full.metadata.sources.some((s: any) => s.kind === 'search_result' && s.origin === 'fixture')).toBe(true);
      expect(full.metadata.crosschecks.length).toBeGreaterThan(0);
      expect(full.metadata.crosschecks.every((c: any) => c.producer !== c.reviewer)).toBe(true);
      expect(full.metadata.tools.search.used).toBe(true);
      expect(JSON.stringify(full)).not.toContain('tvly-test-KEY');
      expect(JSON.stringify(await allEvents(user, started.id))).not.toContain('tvly-test-KEY');
    } finally {
      await Promise.all([rivalA.close(), rivalB.close(), tav.close(), nager.close()]);
    }
  }, 60000);
});
