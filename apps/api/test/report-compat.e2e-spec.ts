import fs from 'node:fs';
import path from 'node:path';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { defaultStrategyDraft } from '@launchpilot/agents/dist/testing/fake-strategy';
import { explainFailure, type RecoveryView } from '../src/mozaik/failure-view';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { configureOpenAi, createApp, registerUser, startF3, startF4, waitForTerminal, type TestUser } from './helpers';

// HISTORICAL COMPATIBILITY (V4). INCIDENT 2026-11-02 (second): a REAL campaign of V3 had paid for F1, F2 and F3, and F4 refused to start 76 ms after F3
// finished with "A report in the F1 -> F2 -> F3 chain could not be read (older format). Run the Strategy again." The saved strategy held 9 claimsToAvoid;
// F4's schema allowed 8.
//
// V4 runs no F2 audit and no AI images, and every new campaign writes its own strategy. What must keep working: the saved V3 reports (F1, the F2 audit,
// the V3 strategy that names its audit) stay READABLE, the failed V3 run is still explained truthfully, and Creative Production can still be built on a
// saved V3 strategy. The three saved reports are in the repo as SANITIZED fixtures (same structure, same lengths, no business text). They are seeded into
// the isolated test database exactly as the real run left them; OpenAI is faked over real HTTP: nothing is billed and the real database is not touched.
jest.setTimeout(600_000);

const KEY = 'sk-test-REPORTCOMPAT1234567890abcdefghi';
const MODEL = 'gpt-4.1-mini';
const FIXTURES = path.resolve(__dirname, '../../../packages/agents/src/testing/fixtures/incident-2026-11-02');
const LEGACY = 'A report in the F1 -> F2 -> F3 chain could not be read (older format). Run the Strategy again.';
/** The agents of the stages BEFORE Creative Production (V4 names, plus the V3 names a fake could still report). */
const BEFORE_F4 = ['researcher', 'strategist', 'input', 'text', 'web', 'repo', 'files', 'visual', 'synthesizer', 'audience', 'competitor', 'seasonal', 'scout'];
const F4_OPTIONS = { channels: ['instagram'], concepts: 1 };

type Row = Record<string, any>;
const fixture = (name: string): Row => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('HISTORICAL COMPATIBILITY: the saved V3 chain of the incident in V4', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  let seq = 0;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));
  const images = () => fake.requests.filter((r) => r.path.endsWith('/images/generations'));
  const called = (names: string[]) => fake.requests.filter((r) => names.includes(r.agent));

  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const getF = async (u: TestUser, id: string) => (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
  /** Creative Production asked directly (the F4 door): resolves with the started run or with the HttpException it was refused with. */
  const f4Door = (u: TestUser, projectId: string, strategyId: string) => app.get(MozaikService).startCreativeProduction(u.id, projectId, { strategyId, objective: null, audience: null, design: {}, ...F4_OPTIONS }).then((run) => ({ run, err: null as any }), (err) => ({ run: null, err }));

  async function readyProject(label: string) {
    const user = await registerUser(app, label);
    const projectId = (await user.agent.post('/projects').send({ name: 'FIRMENFELS GRUPPE', description: 'Compliance software for regulated companies.' }).expect(201)).body.id;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'FIRMENFELS GRUPPE', shortDescription: 'Compliance software for regulated companies.', targetMarket: 'Switzerland', preferredLanguage: 'en' }).expect(200);
    await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }

  /**
   * Seeds the saved chain of the incident into a project of the TEST database, exactly as the real run left it (completed child runs, the three
   * reports with their original structure) and, optionally, the failed V3 Factory run with the legacy message. `tweakF3` edits the F3 report (for the
   * corrupt/unknown-version cases). Ids are made unique per call so the suite can be run again.
   */
  async function seedIncident(user: TestUser, projectId: string, o: { failedRun?: boolean; withoutF3?: boolean; tweakF3?: (row: Row) => void } = {}) {
    const tag = `${Date.now().toString(36)}${seq++}`;
    const ids = { f1: `fx-f1-report-${tag}`, f2: `fx-f2-audit-${tag}`, f3: `fx-f3-strategy-${tag}`, r1: `fx-f1-run-${tag}`, r2: `fx-f2-run-${tag}`, r3: `fx-f3-run-${tag}` };
    const retag = (name: string): Row => JSON.parse(JSON.stringify(fixture(name)).replace(/fx-f1-report/g, ids.f1).replace(/fx-f2-audit/g, ids.f2).replace(/fx-f3-strategy/g, ids.f3).replace(/fx-f1-run/g, ids.r1).replace(/fx-f2-run/g, ids.r2).replace(/fx-f3-run/g, ids.r3).replace(/fx-project/g, projectId));
    const [r1, r2, r3] = [retag('f1-row.json'), retag('f2-row.json'), retag('f3-row.json')];
    o.tweakF3?.(r3);
    const run = (id: string, mode: string, at: string) => db.campaignRun.create({ data: { id, projectId, userId: user.id, mode, status: 'COMPLETED', startedAt: new Date(at), completedAt: new Date(at) } });
    const base = (r: Row) => ({ id: r.id, projectId, runId: r.runId, schemaVersion: r.schemaVersion, language: r.language, model: r.model, reportJson: r.reportJson, metadataJson: r.metadataJson, createdAt: new Date(r.createdAt) });
    await run(ids.r1, 'product_discovery', r1.createdAt);
    await db.productDiscoveryReport.create({ data: base(r1) });
    await run(ids.r2, 'marketing_audit', r2.createdAt);
    await db.marketingAuditReport.create({ data: { ...base(r2), f1ReportId: ids.f1 } });
    if (!o.withoutF3) {
      await run(ids.r3, 'market_strategy', r3.createdAt);
      await db.marketingStrategyReport.create({ data: { ...base(r3), f1ReportId: ids.f1, f2AuditId: ids.f2 } });
    }

    let failedRunId: string | null = null;
    if (o.failedRun) {
      const at = (s: number) => new Date(Date.parse(r3.createdAt) + s).toISOString();
      const phases = [
        { code: 'F1', error: null, phase: 'discovery', runId: null, title: 'Product Discovery', action: 'reuse', reused: { model: r1.model, partial: false, createdAt: r1.createdAt }, status: 'reused', outputId: ids.f1, startedAt: null, completedAt: at(0) },
        { code: 'F2', error: null, phase: 'audit', runId: null, title: 'Marketing Audit', action: 'reuse', reused: { model: r2.model, partial: false, createdAt: r2.createdAt }, status: 'reused', outputId: ids.f2, startedAt: null, completedAt: at(0) },
        { code: 'F3', error: null, phase: 'strategy', runId: ids.r3, title: 'Market Research & Strategy', action: 'run', reused: null, status: 'completed', outputId: ids.f3, startedAt: at(-240_000), completedAt: at(100) },
        { code: 'F4', error: LEGACY, phase: 'creative', runId: null, title: 'Creative Production', action: 'run', reused: null, status: 'failed', outputId: null, startedAt: at(110), completedAt: at(190) },
      ];
      const created = await db.factoryRun.create({
        data: {
          projectId, userId: user.id, mode: 'continue', status: 'failed', cancelRequested: false, configJson: { preset: 'hybrid_production', mode: 'continue', approvedBudgetUsd: 4 }, phasesJson: phases, warningsJson: [],
          // the ledger of the real run (17 text requests, 0 images, nothing refused or uncertain)
          ledgerJson: {
            text: { unknown: 0, requests: 17, spentUsd: 0.48445, uncertainUsd: 0 }, image: { unknown: 0, requests: 0, spentUsd: 0, uncertainUsd: 0 }, scope: null, blocked: 0, deferred: 0, knownUsd: 0.48445, refusals: [], requests: { text: 17, image: 0, imageCap: 5 }, spentUsd: 0.48445, unpriced: 0,
            breakdown: { agentsUsd: 0.386122, imagesUsd: 0, reviewsUsd: 0.098328 }, byPriority: { 1: { usd: 0.386122, requests: 9 }, 2: { usd: 0, requests: 0 }, 3: { usd: 0, requests: 0 }, 4: { usd: 0.098328, requests: 8 }, 5: { usd: 0, requests: 0 } },
            projection: { imagesUsd: 0.21, imageBasis: 'reference', essentialUsd: 0.6825, imagesRemaining: 5 }, approvedUsd: 4, reservedUsd: 0, committedUsd: 0.48445, estimatedUsd: 0, remainingUsd: 3.51555, uncertainUsd: 0, remainingBasis: 'exact', unknownCostRequests: 0,
          } as never,
          f1ReportId: ids.f1, f2AuditId: ids.f2, f3StrategyId: ids.f3, errorMessage: `F4 Creative Production could not start: ${LEGACY}`, startedAt: new Date(at(-240_000)), completedAt: new Date(at(200)),
        },
      });
      failedRunId = created.id;
    }
    return { ids, failedRunId };
  }

  const snapshot = async (ids: { f1: string; f2: string; f3: string }, failedRunId: string | null) =>
    JSON.stringify({
      f1: await db.productDiscoveryReport.findUnique({ where: { id: ids.f1 } }),
      f2: await db.marketingAuditReport.findUnique({ where: { id: ids.f2 } }),
      f3: await db.marketingStrategyReport.findUnique({ where: { id: ids.f3 } }),
      failed: failedRunId ? await db.factoryRun.findUnique({ where: { id: failedRunId } }) : null,
    });

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

  describe('explainFailure: the saved-report cases (pure)', () => {
    const phase = (code: string, title: string, phaseKey: string, status: string, over: Row = {}) => ({ code, title, phase: phaseKey, status, action: 'run', error: null, runId: null, reused: null, outputId: null, startedAt: null, completedAt: null, ...over });
    const phases = (f4: Row) => [phase('F1', 'Product Discovery', 'discovery', 'reused', { action: 'reuse', outputId: 'a' }), phase('F2', 'Marketing Audit', 'audit', 'reused', { action: 'reuse', outputId: 'b' }), phase('F3', 'Market Research & Strategy', 'strategy', 'completed', { outputId: 'c' }), phase('F4', 'Creative Production', 'creative', 'failed', f4)] as never;
    const ready: RecoveryView = { ready: true, lineageProblems: [], resumeFrom: { code: 'F4', title: 'Creative Production' }, reports: [{ code: 'F1', id: 'a', status: 'current', message: 'ok1' }, { code: 'F2', id: 'b', status: 'current', message: 'ok2' }, { code: 'F3', id: 'c', status: 'current', message: 'ok3' }] };
    const run = (over: Row) => explainFailure({ status: 'failed', phases: phases(over.f4 as Row), derived: null, budget: null, errorMessage: null, recovery: (over.recovery ?? null) as never });

    it('the legacy message with a readable chain is restated and Continue is offered; without the check it is left as recorded', () => {
      const withReady = run({ f4: { error: LEGACY }, recovery: ready })!;
      expect(withReady.restated).not.toBeNull();
      expect(withReady.canContinue).toBe(true);
      expect(withReady.nextAction).toMatch(/only F4 Creative Production runs/);
      const without = run({ f4: { error: LEGACY } })!;
      expect(without.restated).toBeNull(); // nothing is claimed about the reports when they were not checked
      expect(without.reason).toBe(LEGACY);
    });

    it('the legacy message with a chain that is STILL unreadable is not restated; Continue is not offered and the exact problem is named', () => {
      const bad: RecoveryView = { ...ready, ready: false, reports: [ready.reports[0], ready.reports[1], { code: 'F3', id: 'c', status: 'unreadable', message: 'The saved Strategy report could not be read. Field "kpis" has 9 entries; this version accepts at most 8.' }] };
      const v = run({ f4: { error: LEGACY }, recovery: bad })!;
      expect(v.restated).toBeNull();
      expect(v.canContinue).toBe(false);
      expect(v.nextAction).toMatch(/F3: The saved Strategy report could not be read\. Field "kpis" has 9 entries/);
      expect(v.nextAction).toMatch(/F1 and F2 stay saved and are reused/);
    });

    it('a new-style failure (code report_unreadable) is explained from its own message and never restated', () => {
      const v = run({ f4: { error: 'x', failure: { agent: 'Creative Production', code: 'report_unreadable', message: 'Creative Production could not read the saved Strategy report.', detail: 'F3 s1 (format version 1): kpis has 9 entries; this version accepts at most 8' } }, recovery: ready })!;
      expect(v.restated).toBeNull();
      expect(v.code).toBe('report_unreadable');
      expect(v.reason).toBe('Creative Production could not read the saved Strategy report.');
      expect(v.nextAction).toMatch(/only F4 Creative Production runs/);
    });

    it('any other failure is untouched by this logic', () => {
      const v = run({ f4: { error: 'The model timed out', failure: { agent: 'Visual Director', code: 'timeout', message: 'The model did not answer in time.', detail: null } } })!;
      expect(v.restated).toBeNull();
      expect(v.recovery).toBeNull();
      expect(v.code).toBe('timeout');
    });
  });

  // ---- the incident chain, seeded exactly as the real run left it ---------------------------------------------------------------------------

  describe('the saved V3 chain of the incident (F1, F2 and F3 paid for; F4 refused to start)', () => {
    let user: TestUser;
    let projectId: string;
    let ids: { f1: string; f2: string; f3: string; r1: string; r2: string; r3: string };
    let failedRunId: string;
    let before: string;
    let built: any;
    let builtPaid: FakeRequest[] = [];

    beforeAll(async () => {
      ({ user, projectId } = await readyProject('compat-incident'));
      const seeded = await seedIncident(user, projectId, { failedRun: true });
      ids = seeded.ids;
      failedRunId = seeded.failedRunId!;
      before = await snapshot(ids, failedRunId);
    });

    it('the seeded F3 has the incident\'s shape: 9 claimsToAvoid (more than the 8 F4 used to accept), schema version 1, lineage intact (it names its F2 audit)', async () => {
      const f3 = await db.marketingStrategyReport.findUniqueOrThrow({ where: { id: ids.f3 } });
      const report = f3.reportJson as Row;
      expect(report.creativeBrief.claimsToAvoid).toHaveLength(9);
      expect(f3).toMatchObject({ schemaVersion: 1, f1ReportId: ids.f1, f2AuditId: ids.f2 });
      expect(report.creativeBrief.provenance).toMatchObject({ f1ReportId: ids.f1, f2AuditId: ids.f2 });
    });

    it('the failed V3 run is explained for what it is: F4 never started, the saved reports are intact and READABLE NOW; the advice "run the Strategy again" is not given', async () => {
      const v = await getF(user, failedRunId);
      expect(v.status).toBe('failed');
      expect(v.config).toMatchObject({ workflow: 'legacy', legacyPreset: 'hybrid_production' }); // the historical record is shown as it was
      expect(v.failure.headline).toBe('Campaign stopped during F4 Creative Production.');
      expect(v.failure.recovery.ready).toBe(true);
      // V4 reads the F1 report and the strategy (the audit is history: no V4 stage reads it)
      expect(v.failure.recovery.reports.map((r: Row) => [r.code, r.status])).toEqual([['F1', 'current'], ['F3', 'current']]);
      expect(v.failure.recovery.resumeFrom).toEqual({ code: 'F4', title: 'Creative Production' });
      expect(v.failure.canContinue).toBe(true);
      expect(v.failure.saved.map((s: Row) => s.code)).toEqual(['F1', 'F2', 'F3']);
      expect(v.failure.wouldRun.map((s: Row) => s.code)).toEqual(['F4']);
      expect(v.failure.reason).toMatch(/could not start: a saved report was rejected by the format check that was in place when this run started/);
      expect(v.failure.reason).not.toMatch(/Run the Strategy again/);
      expect(v.failure.detail).toContain(LEGACY); // what was recorded at the time stays visible
      expect(v.failure.nextAction).toMatch(/F1, F3 are saved and this version of LaunchPilot can read all of them/);
      expect(v.failure.imageGeneration).toMatchObject({ started: false, requests: 0 });
      expect(v.failure.imageGeneration.why).not.toMatch(/Run the Strategy again/);
      expect(v.failure.spending.knownUsd).toBeCloseTo(0.48445, 4);
      // the screen shows a restatement INSTEAD of the stale stored advice; the stored text itself is history and is never changed or hidden from the API
      expect(v.failure.restated.summary).toMatch(/^F4 Creative Production could not start in this run: a saved report was rejected by the format check that was in place then\. The saved reports are intact and readable now/);
      expect(v.failure.restated.phaseNote).not.toMatch(/Run the Strategy again/);
      expect(v.errorMessage).toContain(LEGACY);
      expect(v.phases[3].error).toBe(LEGACY);
      expect(v.chain).toMatchObject({ f1ReportId: ids.f1, f2AuditId: ids.f2, f3StrategyId: ids.f3 });
    });

    it('FREE PREFLIGHT of a NEW campaign on this project: ONE workflow (Strategy and Creative always run for the new campaign); no paid request is made', async () => {
      const p = (await preflight(user, projectId).expect(200)).body;
      expect(p.phases.map((x: Row) => x.code)).toEqual(['F1', 'F3', 'F4']);
      expect(p.phases.slice(1).map((x: Row) => x.action)).toEqual(['run', 'run']);
      expect(p.phases.find((x: Row) => x.code === 'F2')).toBeUndefined();
      expect(paid()).toHaveLength(0); // the model list is free; nothing was inferred
    });

    it('BUILT ON THE SAVED V3 STRATEGY: Creative Production reads it (9 claims) and finishes; nothing earlier runs again and no image is requested', async () => {
      const { run, err } = await f4Door(user, projectId, ids.f3);
      expect(err).toBeNull();
      built = await waitForTerminal(user, run!.id, 120_000);
      builtPaid = paid();
      expect(built.status).toBe('COMPLETED');
      expect(built.campaignId).toBeTruthy();
      // nothing of the paid research or strategy was requested again
      expect(called(BEFORE_F4)).toHaveLength(0);
      expect(images()).toHaveLength(0);
      const camp = (await user.agent.get(`/campaigns/${built.campaignId}`).expect(200)).body;
      expect(camp.package.deliverables.counts.delivered).toBeGreaterThan(0);
      expect(camp.assets.filter((a: Row) => a.kind === 'image' && a.source === 'ai_image')).toHaveLength(0);
    });

    it('LINEAGE: the new campaign is built on exactly the saved F3 and F1 of the incident; it names no audit (V4 runs none)', async () => {
      const camp = await db.creativeCampaign.findUniqueOrThrow({ where: { id: built.campaignId } });
      expect(camp).toMatchObject({ f1ReportId: ids.f1, f3StrategyId: ids.f3, f2AuditId: null });
      expect((camp.metadataJson as Row).chain).toEqual({ f1ReportId: ids.f1, f3StrategyId: ids.f3 });
      expect(JSON.stringify(camp.packageJson).length).toBeGreaterThan(1000);
    });

    it('THE ORIGINALS ARE UNTOUCHED: the saved F1, F2 and F3 and the failed run are byte-identical afterwards (the failed run stays failed, as history)', async () => {
      expect(await snapshot(ids, failedRunId)).toBe(before);
      const failed = await getF(user, failedRunId);
      expect(failed.status).toBe('failed');
      expect(failed.phases[3]).toMatchObject({ code: 'F4', status: 'failed', error: LEGACY });
      expect(await db.factoryRun.count({ where: { projectId } })).toBe(1); // the stage was asked directly: no new campaign run row
    });

    it('NO AUTOMATIC RETRIES and no surprise spending: no image request at all; the strategy was not rewritten', () => {
      expect(builtPaid.filter((r) => r.path.endsWith('/images/generations'))).toHaveLength(0);
      expect(builtPaid.filter((r) => r.agent === 'strategist')).toHaveLength(0);
    });

    it('existing outputs stay readable through the API: the saved strategy and the saved audit still serve their full reports and the project lists them', async () => {
      const s = (await user.agent.get(`/strategies/${ids.f3}`).expect(200)).body;
      expect(s.report.creativeBrief.claimsToAvoid).toHaveLength(9);
      expect(s).toMatchObject({ id: ids.f3, f2AuditId: ids.f2 });
      expect((await user.agent.get(`/projects/${projectId}/strategies`).expect(200)).body.items.some((i: Row) => i.id === ids.f3)).toBe(true);
      const audit = (await user.agent.get(`/audits/${ids.f2}`).expect(200)).body;
      expect(audit.id).toBe(ids.f2);
      expect((await user.agent.get(`/projects/${projectId}/audits`).expect(200)).body.items.some((i: Row) => i.id === ids.f2)).toBe(true);
    });

    it('ISOLATION: another user cannot see the failed run, the reports or the audit, and cannot preflight this project', async () => {
      const other = await registerUser(app, 'compat-other');
      await other.agent.get(`/factory-runs/${failedRunId}`).expect(404);
      await other.agent.get(`/strategies/${ids.f3}`).expect(404);
      await other.agent.get(`/audits/${ids.f2}`).expect(404);
      await preflight(other, projectId).expect(404);
    });

    it('ISOLATION: a project cannot build on another project\'s saved strategy, even when it names it', async () => {
      const { user: second, projectId: secondProject } = await readyProject('compat-second');
      await expect(startF4(app, second, secondProject, ids.f3, F4_OPTIONS)).rejects.toBeInstanceOf(NotFoundException);
      expect(paid()).toHaveLength(0);
    });
  });

  // ---- unreadable inputs are caught for free, with the exact field ---------------------------------------------------------------------

  describe('a saved report that really cannot be read is refused BEFORE anything is sent, with the report and the field', () => {
    it('an F3 over even the new limit: Creative Production names the report, the field, the count and the limit instead of "older format"', async () => {
      const { user, projectId } = await readyProject('compat-door');
      const { ids } = await seedIncident(user, projectId, { tweakF3: (r) => { r.reportJson.creativeBrief.claimsToAvoid = Array.from({ length: 13 }, (_, i) => ({ claim: `Claim ${i}`, reason: 'Reason' })); } });
      const { err } = await f4Door(user, projectId, ids.f3);
      expect(err).not.toBeNull();
      expect(err.getStatus()).toBe(422);
      const body = err.getResponse() as Row;
      expect(body.code).toBe('report_unreadable');
      expect(body.reports[0]).toMatchObject({ report: 'F3', reportId: ids.f3, schemaVersion: 1, contentIntact: true });
      expect(body.reports[0].issues[0]).toEqual({ path: 'creativeBrief.claimsToAvoid', problem: 'too_many', limit: 12, actual: 13, message: 'has 13 entries; this version accepts at most 12' });
      expect(String(body.message)).toMatch(/Field "creativeBrief\.claimsToAvoid" has 13 entries; this version accepts at most 12\./);
      expect(String(body.message)).not.toContain(LEGACY);
      expect(String(body.message)).not.toMatch(/older format/);
      // the stored report is served unchanged (read-only): nothing was "fixed" or rewritten
      expect((await user.agent.get(`/strategies/${ids.f3}`).expect(200)).body.report.creativeBrief.claimsToAvoid).toHaveLength(13);
      expect(paid()).toHaveLength(0);
      expect(await db.creativeCampaign.count({ where: { projectId } })).toBe(0);
    });

    it('a corrupt report (a required field missing) and a report of an unknown newer version are each refused with their own reason; neither is "fixed" by guessing', async () => {
      const a = await readyProject('compat-corrupt');
      const sa = await seedIncident(a.user, a.projectId, { tweakF3: (r) => { delete r.reportJson.creativeBrief.objective; } });
      const damaged = (await f4Door(a.user, a.projectId, sa.ids.f3)).err.getResponse() as Row;
      expect(damaged.code).toBe('report_damaged');
      expect(String(damaged.message)).toMatch(/Field "creativeBrief\.objective" is missing \(a string is required\)/);
      expect(String(damaged.message)).toMatch(/has to run again/);

      const b = await readyProject('compat-newer');
      const sb = await seedIncident(b.user, b.projectId, { tweakF3: (r) => { r.schemaVersion = 9; } });
      const newer = (await f4Door(b.user, b.projectId, sb.ids.f3)).err.getResponse() as Row;
      expect(newer.code).toBe('report_unreadable');
      expect(String(newer.message)).toMatch(/\(format version 9\)\. Field "schemaVersion" is 9; this version of LaunchPilot reads up to 1\. It was saved by a newer version of LaunchPilot\. Update LaunchPilot; nothing needs to run again\./);
      expect(paid()).toHaveLength(0);
    });

    it('a strategy whose brief points at another business research report than the saved one is a lineage problem, named as such', async () => {
      const { user, projectId } = await readyProject('compat-lineage');
      const { ids } = await seedIncident(user, projectId, { tweakF3: (r) => { r.reportJson.creativeBrief.provenance.f1ReportId = 'some-other-report'; } });
      const body = (await f4Door(user, projectId, ids.f3)).err.getResponse() as Row;
      expect(body.code).toBe('report_lineage');
      expect(String(body.message)).toMatch(/The strategy brief refers to a different Product Discovery report than the saved one\./);
      expect(paid()).toHaveLength(0);
    });
  });

  // ---- the producer/consumer contract with the REAL pipeline ------------------------------------------------------------------------------

  describe('what F3 produces, F4 can always read (the real pipeline on the fake provider)', () => {
    it('a NEW V4 strategy on the saved V3 business research (8 claims to avoid from the strategist), and F4 reads what F3 just saved', async () => {
      await useFake({
        reply: (r: FakeRequest) => {
          if (r.agent !== 'strategist' || r.kind !== 'synthesis') return undefined;
          const base = defaultStrategyDraft(r.userText);
          return { text: JSON.stringify(defaultStrategyDraft(r.userText, { creativeBrief: { ...base.creativeBrief, claimsToAvoid: Array.from({ length: 8 }, (_, i) => ({ claim: `Strategist claim number ${i + 1} that must not be used`, reason: 'Nothing supports it.' })) } })) };
        },
      });
      const { user, projectId } = await readyProject('compat-pipeline');
      const { ids } = await seedIncident(user, projectId, { withoutF3: true }); // the saved V3 F1 (and its audit, as history); F3 is produced now
      const f3run = await waitForTerminal(user, (await startF3(app, user, projectId, ids.f1)).id, 120_000);
      expect(f3run.status).toBe('COMPLETED');
      const f3 = await db.marketingStrategyReport.findUniqueOrThrow({ where: { id: f3run.strategyId } });
      expect(f3).toMatchObject({ f1ReportId: ids.f1, f2AuditId: null }); // V4 builds on no audit
      const claims = (f3.reportJson as Row).creativeBrief.claimsToAvoid as Row[];
      expect(claims.length).toBeGreaterThanOrEqual(8);
      expect(claims.length).toBeLessThanOrEqual(12);
      expect(claims.slice(0, 8).map((c) => c.claim)).toEqual(Array.from({ length: 8 }, (_, i) => `Strategist claim number ${i + 1} that must not be used`));
      // and the producer's own boundary check found nothing to report
      const policy = ((f3.metadataJson as Row).policyIssues ?? []) as Row[];
      expect(policy.filter((i) => i.type === 'report_contract')).toEqual([]);
      // F4 reads it at once
      const f4run = await waitForTerminal(user, (await startF4(app, user, projectId, f3run.strategyId, F4_OPTIONS)).id, 120_000);
      expect(f4run.status).toBe('COMPLETED');
      expect(called(['researcher'])).toHaveLength(0); // the saved F1 was not repeated
      expect(images()).toHaveLength(0);
    });
  });
});
