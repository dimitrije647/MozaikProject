import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MarketingAuditReport, PageSpeedTool, WebFetchTool } from '@launchpilot/agents';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { FakePageSpeed, FakeWebsite, htmlPage } from '@launchpilot/agents/dist/testing/fake-services';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { allEvents, configureOpenAi, createApp, createProject, loginUser, registerUser, sleep, waitForTerminal, type TestUser } from './helpers';

// F2 Marketing Audit end to end: HTTP API -> NestJS -> real Mozaik runtime and six audit agents -> fake
// OpenAI / website / PageSpeed servers -> PostgreSQL. Nothing leaves the machine and nothing is billed.
describe('Marketing Audit (real Mozaik agents, fake OpenAI and fixtures)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  const KEY = 'sk-test-AUDITE2E1234567890abcdefghij';
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
      .send({ productName: projectName, shortDescription: 'We fix bicycles in Novi Sad', targetMarket: 'Novi Sad', preferredLanguage: 'en' })
      .expect(200);
    await configureOpenAi(user, key, MODEL);
    return { user, projectId };
  }

  const startF1 = (u: TestUser, projectId: string) => u.agent.post(`/projects/${projectId}/runs/product-discovery`).send({});
  const startAudit = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/runs/marketing-audit`).send(body);

  async function withF1(label: string, key = KEY, projectName = 'Bike Repair Shop') {
    const ctx = await readyUser(label, key, projectName);
    const f1 = await waitForTerminal(ctx.user, (await startF1(ctx.user, ctx.projectId).expect(201)).body.id);
    expect(f1.status).toBe('COMPLETED');
    return { ...ctx, f1ReportId: f1.reportId as string };
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

  it('refuses to start without a completed F1 report, a key or a model, and validates limits; nothing is billed', async () => {
    const { user, projectId } = await readyUser('aud-nof1');
    const noF1 = await startAudit(user, projectId).expect(422);
    expect(noF1.body.message).toMatch(/Product Discovery \(F1\) report/);
    expect(fake.requests).toHaveLength(0);
    expect(await db.campaignRun.count({ where: { userId: user.id } })).toBe(0);

    await startAudit(user, projectId, { maxModelCalls: 99 }).expect(400);
    await startAudit(user, projectId, { maxReviews: 20 }).expect(400);
    await startAudit(user, projectId, { socialDetails: [{ platform: 'myspace' }] }).expect(400);
    await startAudit(user, projectId, { f1ReportId: 'does-not-exist' }).expect(404);

    const keyless = await registerUser(app, 'aud-nokey');
    const p2 = await createProject(keyless);
    await startAudit(keyless, p2).expect(422);
  });

  it('runs on a completed F1 report, saves the audit BEFORE completing, ties it to the exact F1 report and keeps it forever', async () => {
    const { user, projectId, f1ReportId } = await withF1('aud-happy');
    fake.requests.length = 0;
    const started = (await startAudit(user, projectId).expect(201)).body;
    expect(started).toMatchObject({ mode: 'marketing_audit', label: 'Marketing Audit', status: 'RUNNING', provider: 'openai', auditId: null });
    const done = await waitForTerminal(user, started.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.auditId).toBeTruthy();

    // Text-only project: Messaging audits, Presence reports deterministically, SEO/Social/Brand are skipped.
    expect(fake.requests.map((r) => `${r.agent}:${r.kind}`).sort()).toEqual(['auditor:synthesis', 'messaging:analysis']);
    for (const r of fake.requests) {
      expect(r.authorization).toBe(`Bearer ${KEY}`);
      expect(r.body).toMatchObject({ model: MODEL, store: false });
    }

    const full = (await user.agent.get(`/audits/${done.auditId}`).expect(200)).body;
    expect(MarketingAuditReport.safeParse(full.report).success).toBe(true);
    expect(full).toMatchObject({ projectId, runId: started.id, f1ReportId, model: MODEL, schemaVersion: 1 });
    expect(full.report.productContext.f1ReportId).toBe(f1ReportId);
    expect(full.metadata.f1.reportId).toBe(f1ReportId);
    expect(full.metadata.plan.skipped.map((s: any) => s.agent)).toEqual(['SEO Auditor', 'Social Media Auditor', 'Brand Auditor']);
    expect(full.metadata.partial).toBe(false);
    expect(JSON.stringify(full)).not.toContain(KEY);

    const row = await db.marketingAuditReport.findUniqueOrThrow({ where: { runId: started.id } });
    const run = await db.campaignRun.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(run.completedAt!.getTime());

    const events = await allEvents(user, started.id);
    const types = events.map((e) => e.eventType);
    for (const t of ['factory.started', 'phase.started', 'participant.idle', 'task.assigned', 'source.retrieved', 'finding.posted', 'task.completed', 'phase.ready', 'audit.completed', 'phase.completed', 'factory.completed']) expect(types).toContain(t);
    expect(events.find((e) => e.eventType === 'phase.started')!.payload.plan.activated.map((a: any) => a.agent)).toEqual(['Messaging Auditor', 'Presence Auditor', 'Audit Synthesizer']);
    expect(events.find((e) => e.eventType === 'audit.completed')!.payload).toEqual({ stored: 'MarketingAuditReport' });
    expect(JSON.stringify(events)).not.toContain(KEY);

    const analysis = (await user.agent.get(`/runs/${started.id}/analysis`).expect(200)).body;
    expect(analysis).toMatchObject({ kind: 'audit', source: 'report', reportId: done.auditId });
    expect(analysis.f1.reportId).toBe(f1ReportId);
    expect(analysis.aiCalls['Audit Synthesizer']).toBe(1);

    // The F1 side is untouched: same report, same run
    expect((await user.agent.get(`/reports/${f1ReportId}`).expect(200)).body.schemaVersion).toBe(2);
    expect((await user.agent.get(`/projects/${projectId}/runs`).expect(200)).body.map((r: any) => r.mode).sort()).toEqual(['marketing_audit', 'product_discovery']);
  });

  it('paginates audits, never overwrites older ones, and survives a backend restart', async () => {
    const { user, projectId } = await withF1('aud-list');
    const a = await waitForTerminal(user, (await startAudit(user, projectId).expect(201)).body.id);
    const b = await waitForTerminal(user, (await startAudit(user, projectId).expect(201)).body.id);
    expect(a.auditId).not.toBe(b.auditId);

    const page1 = (await user.agent.get(`/projects/${projectId}/audits?limit=1`).expect(200)).body;
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]).toMatchObject({ id: b.auditId, partial: false, model: MODEL });
    expect(page1.nextCursor).toBe(b.auditId);
    const page2 = (await user.agent.get(`/projects/${projectId}/audits?limit=1&cursor=${page1.nextCursor}`).expect(200)).body;
    expect(page2.items[0].id).toBe(a.auditId);
    expect(page2.nextCursor).toBeNull();
    await user.agent.get(`/projects/${projectId}/audits?limit=0`).expect(400);

    const first = (await user.agent.get(`/audits/${a.auditId}`)).body;
    const app2 = await createApp();
    try {
      const agent2 = await loginUser(app2, user.email);
      expect((await agent2.get(`/audits/${a.auditId}`).expect(200)).body).toEqual(first);
      expect((await agent2.get(`/projects/${projectId}/audits`).expect(200)).body.items).toHaveLength(2);
    } finally {
      await app2.close();
    }
  });

  it('isolates users: other users get 404 on audits, analysis and starting; unauthenticated gets 401', async () => {
    const { user, projectId, f1ReportId } = await withF1('aud-iso');
    const done = await waitForTerminal(user, (await startAudit(user, projectId).expect(201)).body.id);
    const intruder = await registerUser(app, 'aud-intruder');
    await intruder.agent.get(`/audits/${done.auditId}`).expect(404);
    await intruder.agent.get(`/projects/${projectId}/audits`).expect(404);
    await intruder.agent.get(`/runs/${done.id}/analysis`).expect(404);
    await startAudit(intruder, projectId).expect(404);
    const own = await readyUser('aud-iso-own');
    await startAudit(own.user, own.projectId, { f1ReportId }).expect(404); // an F1 report of someone else's project
    const request = (await import('supertest')).default;
    await request(app.getHttpServer()).get(`/audits/${done.auditId}`).expect(401);
    await request(app.getHttpServer()).post(`/projects/${projectId}/runs/marketing-audit`).send({}).expect(401);
  });

  it('makes no paid call on page loads or listings; duplicates are rejected without model calls', async () => {
    const { user, projectId } = await withF1('aud-free');
    fake.requests.length = 0;
    await user.agent.get(`/projects/${projectId}/audits`).expect(200);
    await user.agent.get(`/projects/${projectId}/runs`).expect(200);
    expect(fake.requests).toHaveLength(0);

    await useFake({ reply: (r) => (r.kind === 'analysis' ? { delayMs: 300 } : undefined) });
    const results = await Promise.all([startAudit(user, projectId), startAudit(user, projectId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const run = results.find((r) => r.status === 201)!.body;
    expect((await waitForTerminal(user, run.id)).status).toBe('COMPLETED');
    expect(fake.requests).toHaveLength(2);
  });

  it('keeps simultaneous audits of different users isolated: each uses only its own key and data', async () => {
    const keyA = 'sk-test-AUDUSERA1234567890abcdefghij';
    const keyB = 'sk-test-AUDUSERB1234567890abcdefghij';
    const a = await withF1('aud-iso-a', keyA, 'PROJECT-ALPHA');
    const b = await withF1('aud-iso-b', keyB, 'PROJECT-BETA');
    fake.requests.length = 0;
    const [ra, rb] = await Promise.all([startAudit(a.user, a.projectId).expect(201), startAudit(b.user, b.projectId).expect(201)]);
    const [da, db2] = await Promise.all([waitForTerminal(a.user, ra.body.id), waitForTerminal(b.user, rb.body.id)]);
    expect([da.status, db2.status]).toEqual(['COMPLETED', 'COMPLETED']);
    const mine = (m: string) => fake.requests.filter((r) => JSON.stringify(r.body).includes(m));
    expect(mine('PROJECT-ALPHA').length).toBeGreaterThanOrEqual(2);
    expect(mine('PROJECT-ALPHA').every((r) => r.authorization === `Bearer ${keyA}`)).toBe(true);
    expect(mine('PROJECT-BETA').every((r) => r.authorization === `Bearer ${keyB}`)).toBe(true);
    expect((await a.user.agent.get(`/audits/${da.auditId}`)).body.report.productContext.name).toBe('PROJECT-ALPHA');
  });

  it('fails safely on an invalid key: no audit, safe message, key never leaked', async () => {
    const { user, projectId } = await withF1('aud-401');
    await useFake({ validKeys: ['sk-test-someone-elses-key-xxxxxxxxxxxx'] });
    const started = (await startAudit(user, projectId).expect(201)).body;
    const run = await waitForTerminal(user, started.id);
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toMatch(/rejected the API key/);
    expect(run.auditId).toBeNull();
    const stored = JSON.stringify([await db.campaignEvent.findMany({ where: { runId: run.id } }), run]);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain('Incorrect API key provided');
    expect(await db.marketingAuditReport.count({ where: { projectId } })).toBe(0);
  });

  it('cancellation aborts in-flight requests and saves no audit', async () => {
    const { user, projectId } = await withF1('aud-cancel');
    await useFake({ reply: () => ({ hang: true }) });
    const started = (await startAudit(user, projectId).expect(201)).body;
    await sleep(400);
    const cancelled = (await user.agent.post(`/runs/${started.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', auditId: null });
    await sleep(200);
    expect(fake.requests.every((r) => r.aborted)).toBe(true);
    const types = (await allEvents(user, started.id)).map((e) => e.eventType);
    expect(types[types.length - 1]).toBe('factory.cancelled');
    expect(types).not.toContain('audit.completed');
    expect(await db.marketingAuditReport.count({ where: { projectId } })).toBe(0);
  });

  it('an unexpected persistence error becomes a FAILED run, not a crash', async () => {
    const { user, projectId } = await withF1('aud-sinkfail');
    const svc = app.get(MozaikService) as any;
    const original = svc.prisma.marketingAuditReport.create;
    svc.prisma.marketingAuditReport.create = async () => {
      throw new Error('simulated database outage');
    };
    try {
      const run = await waitForTerminal(user, (await startAudit(user, projectId).expect(201)).body.id);
      expect(run.status).toBe('FAILED');
      expect(run.errorMessage).toMatch(/simulated database outage/);
      expect(run.auditId).toBeNull();
    } finally {
      svc.prisma.marketingAuditReport.create = original;
    }
  });

  it('with website fixtures: SEO, Brand, Messaging, Presence audit real pages, cross-check each other, and everything persists', async () => {
    const { user, projectId } = await withF1('aud-site', KEY, 'Deep Diving School');
    const site = await new FakeWebsite().start();
    const ps = await new FakePageSpeed().start();
    site
      .page('/', htmlPage({ title: 'Deep Diving School', paragraphs: ['Over 10,000 customers trust our courses.'], links: [{ href: '/courses', text: 'Courses' }, { href: '/gone', text: 'Old' }, { href: 'https://instagram.com/dds', text: 'Instagram' }] }))
      .page('/courses', htmlPage({ title: 'Courses', description: 'Open water course', paragraphs: ['Open water course.'] }));
    await db.productIntake.update({ where: { projectId }, data: { websiteUrl: site.origin } });
    await db.socialProfile.create({ data: { projectId, platform: 'instagram', url: 'https://instagram.com/dds' } });
    await db.socialProfile.create({ data: { projectId, platform: 'facebook', url: 'https://facebook.com/dds' } });
    try {
      const svc = app.get(MozaikService);
      const web = new WebFetchTool({ policy: { allowedPorts: new Set([Number(new URL(site.origin).port)]), allowLoopbackForTests: true }, timeoutMs: 2000, maxPages: 30 });
      const started = await svc.startMarketingAudit(user.id, projectId, {}, { fixtureSources: true, tools: { web, pagespeed: new PageSpeedTool({ apiKey: 'psi-test-KEY-1234567890', baseUrl: ps.origin }) } });
      const done = await waitForTerminal(user, started.id);
      expect(done.status).toBe('COMPLETED');

      const full = (await user.agent.get(`/audits/${done.auditId}`).expect(200)).body;
      expect(MarketingAuditReport.safeParse(full.report).success).toBe(true);
      expect(full.metadata.plan.activated.map((a: any) => a.agent)).toEqual(['SEO Auditor', 'Social Media Auditor', 'Brand Auditor', 'Messaging Auditor', 'Presence Auditor', 'Audit Synthesizer']);
      expect(full.report.websiteHealth).toMatchObject({ reachable: true, pageSpeed: { status: 'measured' } });
      expect(full.report.websiteHealth.brokenInternalLinks).toBeGreaterThanOrEqual(1);
      expect(full.report.socialPlatforms.find((r: any) => r.platform === 'instagram').access).toBe('unavailable');
      expect(full.metadata.sources.some((s: any) => s.kind === 'pagespeed' && s.origin === 'fixture')).toBe(true);
      expect(full.metadata.crosschecks.length).toBeGreaterThan(0);
      expect(full.metadata.crosschecks.every((c: any) => c.producer !== c.reviewer)).toBe(true);
      const analysis = (await user.agent.get(`/runs/${started.id}/analysis`)).body;
      expect(analysis.findings.some((f: any) => f.agent === 'SEO Auditor' && f.severity)).toBe(true);
      expect(JSON.stringify(full)).not.toContain('psi-test-KEY');
      expect(JSON.stringify(await allEvents(user, started.id))).not.toContain('psi-test-KEY');
    } finally {
      await site.close();
      await ps.close();
    }
  }, 30000);
});
