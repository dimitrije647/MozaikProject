import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions } from '@launchpilot/agents/dist/testing/fake-openai';
import { assessInputs, isMeaningfulDescription, type InputFacts } from '../src/mozaik/input-readiness';
import { campaignRequest, confirmedDesign, configureOpenAi, createApp, registerUser, waitForFactory, type TestUser } from './helpers';

// CAMPAIGN PRODUCTION FROM A MINIMAL PROJECT (V4): a business name and one sentence are enough to review the plan, approve ONE campaign budget and
// start. Missing optional data is advice (with the fallback LaunchPilot applies), never a blocker; the only other thing a campaign needs is its
// confirmed design (template collection and palette). The whole F1 -> F3 -> F4 chain runs on the real Mozaik runtime; only OpenAI is faked, over
// real HTTP. Nothing is billed, no image is ever requested and no real provider is ever contacted.
jest.setTimeout(600_000);

const KEY = 'sk-test-MINIMALE2E1234567890abcdefghi';
const MODEL = 'gpt-4.1-mini';
const DESCRIPTION = 'AI automation platform that helps users create agents for everyday tasks.';

const baseFacts = (o: Partial<InputFacts> = {}): InputFacts => ({
  projectName: 'JigJoy',
  projectDescription: null,
  intake: { productName: 'JigJoy', shortDescription: DESCRIPTION, websiteUrl: null, githubUrl: null, targetMarket: null, targetAudience: null, marketingGoal: null, campaignDuration: null, stylePreference: null },
  socialProfiles: 0,
  assets: { logo: 0, images: 0, screenshots: 0, references: 0 },
  competitors: 0,
  channels: null,
  style: 'auto',
  pinterestConnected: false,
  referenceCount: 0,
  ...o,
});

describe('input readiness (pure): required blocks, recommended warns, optional informs', () => {
  it('a meaningful description is a short sentence that says something; placeholders and the name alone are not', () => {
    expect(isMeaningfulDescription(DESCRIPTION, 'JigJoy')).toBe(true);
    expect(isMeaningfulDescription('Scuba diving courses for beginners in Novi Sad', 'Deep Diving School')).toBe(true);
    expect(isMeaningfulDescription('Škola ronjenja za početnike u Novom Sadu')).toBe(true); // any script
    for (const bad of ['', '   ', 'test', 'asdf asdf asdf', 'JigJoy', 'Great product!!!', 'a b c d e f', null, undefined]) expect(isMeaningfulDescription(bad as string, 'JigJoy')).toBe(false);
    expect(isMeaningfulDescription('JigJoy', 'JigJoy')).toBe(false);
  });

  it('only the name and the description are REQUIRED; website, logo and audience are RECOMMENDED; everything else is OPTIONAL', () => {
    const r = assessInputs(baseFacts(), { enforce: true });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.counts.required).toEqual({ present: 2, total: 2 });
    expect(r.checks.filter((c) => c.level === 'required').map((c) => c.id)).toEqual(['name', 'description']);
    expect(r.checks.filter((c) => c.level === 'recommended').map((c) => c.id)).toEqual(['website', 'logo', 'audience']);
    // the exact advice the user sees, each with the fallback that is applied
    expect(r.warnings).toEqual([
      'Website not provided. Business research uses the other sources and no destination link will be invented.',
      'Logo not provided. LaunchPilot will use a text-based brand identity (the business name).',
      'Target audience not specified. The AI will propose an audience based on the description and label it as an assumption.',
    ]);
    for (const id of ['market', 'goal', 'github', 'social', 'competitors', 'colors', 'photos', 'style', 'channels', 'duration', 'references']) {
      expect(r.checks.find((c) => c.id === id)).toMatchObject({ level: 'optional', present: false });
    }
    expect(r.notes).toContain('No template collection chosen yet. You choose one of the 10 collections in the campaign design; it decides the look of every creative.');
    expect(r.notes.join(' ')).not.toMatch(/Pinterest/); // a Pinterest account is never part of a campaign
    expect(r.notes).toContain('No social profile supplied. Account-specific social analysis will be skipped; a recommended social strategy is still produced.');
    expect(r.notes.join(' ')).not.toMatch(/invent(?!ed)/); // the advice never promises to invent anything
  });

  it('a missing REQUIRED item blocks only where it is enforced (Campaign Production); the advisory reading only gets the advice', () => {
    const noDesc = baseFacts({ intake: { ...baseFacts().intake!, shortDescription: 'Dive' } });
    const enforced = assessInputs(noDesc, { enforce: true });
    expect(enforced.ready).toBe(false);
    expect(enforced.blockers.map((b) => b.code)).toEqual(['missing_description']);
    expect(enforced.blockers[0].message).toMatch(/short description of what the business offers/);
    expect(enforced.blockers[0].message).toMatch(/for example/);
    const advisory = assessInputs(noDesc, { enforce: false });
    expect(advisory.ready).toBe(true);
    expect(advisory.blockers).toEqual([]);
    expect(advisory.checks.find((c) => c.id === 'description')).toMatchObject({ level: 'required', present: false });
    // the project's own description (set when the project was created) counts too
    expect(assessInputs(baseFacts({ intake: null, projectDescription: DESCRIPTION }), { enforce: true }).ready).toBe(true);
    // no name at all
    expect(assessInputs(baseFacts({ projectName: '', intake: null, projectDescription: DESCRIPTION }), { enforce: true }).blockers.map((b) => b.code)).toEqual(['missing_name']);
  });

  it('what the user DID supply is never advised about', () => {
    const full = assessInputs(
      baseFacts({
        intake: { productName: 'JigJoy', shortDescription: DESCRIPTION, websiteUrl: 'https://jigjoy.example', githubUrl: 'https://github.com/a/b', targetMarket: 'Serbia', targetAudience: 'Busy founders', marketingGoal: 'sign_ups', campaignDuration: '1 month', stylePreference: 'minimal' },
        socialProfiles: 2,
        assets: { logo: 1, images: 2, screenshots: 1, references: 1 },
        competitors: 1,
        channels: ['instagram'],
        style: 'bold_startup',
        pinterestConnected: true,
        referenceCount: 1,
      }),
      { enforce: true },
    );
    expect(full.warnings).toEqual([]);
    expect(full.notes).toEqual([]);
    expect(full.counts).toEqual({ required: { present: 2, total: 2 }, recommended: { present: 3, total: 3 }, optional: { present: 11, total: 11 } });
  });
});

describe('Campaign Production from a minimal project (business name + short description)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));
  const images = () => fake.requests.filter((r) => r.path.endsWith('/images/generations'));

  /** A project with ONLY a name and a short description (as the project form saves them), a saved (fake) key and model, and a confirmed design. */
  async function minimal(label: string, o: { description?: string | null; key?: boolean } = {}) {
    const user = await registerUser(app, label);
    const description = o.description === undefined ? DESCRIPTION : o.description;
    const created = await user.agent.post('/projects').send({ name: 'JigJoy', ...(description ? { description } : {}) }).expect(201);
    const projectId = created.body.id as string;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', ...(description ? { shortDescription: description } : {}) }).expect(200);
    if (o.key !== false) await configureOpenAi(user, KEY, MODEL);
    const design = await confirmedDesign(user, projectId, 'premium_editorial');
    return { user, projectId, design };
  }
  const preflight = (u: TestUser, projectId: string, design: object | null, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send({ ...(design ? { design: { design } } : {}), ...body });
  const startF = (u: TestUser, projectId: string, design: object | null, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send({ ...(design ? { design: { design } } : {}), ...body });
  /** The ONE spending approval: a limit and the confirmation of the estimate (V4 asks for nothing about images: none is ever requested). */
  const APPROVAL = { approvedBudgetUsd: 5, confirmCost: true };

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

  // ---- the plan: no blocker, only advice -------------------------------------------------------------------------------------------------

  it('the plan can be reviewed: no blocker, the missing recommended items are WARNINGS with their fallback, nothing paid is requested', async () => {
    const { user, projectId, design } = await minimal('min-pre');
    const p = (await preflight(user, projectId, design).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.inputs.ready).toBe(true);
    expect(p.inputs.counts.required).toEqual({ present: 2, total: 2 });
    expect(p.inputs.warnings).toHaveLength(3); // website, logo, audience
    expect(p.inputs.warnings.join(' ')).toMatch(/Website not provided\./);
    expect(p.inputs.warnings.join(' ')).toMatch(/Logo not provided\. LaunchPilot will use a text-based brand identity/);
    expect(p.inputs.warnings.join(' ')).toMatch(/Target audience not specified\. The AI will propose an audience/);
    expect(p.inputs.notes.join(' ')).not.toMatch(/No template collection chosen yet/); // the confirmed design names it
    expect(p.preset).toBeUndefined(); // V4: one workflow, no preset
    expect(p.statement.aiImages).toMatch(/AI-generated images: 0/);
    // the review itself asks OpenAI for nothing that costs money (only the free model list is read)
    expect(paid()).toHaveLength(0);
  });

  it('the design is the only other thing a campaign needs: without one the plan names the blocker and Start is refused with the same words', async () => {
    const { user, projectId } = await minimal('min-nodesign');
    const p = (await preflight(user, projectId, null).expect(200)).body;
    expect(p.ok).toBe(false);
    expect(p.blockers.map((b: { code: string }) => b.code)).toEqual(['design_missing']);
    expect(p.inputs.notes.join(' ')).toMatch(/No template collection chosen yet/);
    const refused = await startF(user, projectId, null, APPROVAL).expect(422);
    expect(refused.body.message).toBe(p.blockers[0].message);
    expect(paid()).toHaveLength(0);
  });

  // ---- ONE spending approval ----------------------------------------------------------------------------------------------------

  it('Start still needs the spending approval: no limit, no confirmation, or a too-small limit is refused and nothing is sent', async () => {
    const { user, projectId, design } = await minimal('min-need-approval');
    const before = fake.requests.length;
    await startF(user, projectId, design).expect(422);
    await startF(user, projectId, design, { approvedBudgetUsd: 5 }).expect(422); // limit without the confirmation
    await startF(user, projectId, design, { confirmCost: true }).expect(422); // confirmation without a limit
    await startF(user, projectId, design, { approvedBudgetUsd: 5, confirmCost: false }).expect(422);
    const r = await startF(user, projectId, design, { approvedBudgetUsd: 0.01, confirmCost: true }).expect(422); // far below the text estimate
    expect(String(r.body.message)).toMatch(/below|estimate/i);
    // a number outside what the API accepts at all
    await startF(user, projectId, design, { approvedBudgetUsd: 501, confirmCost: true }).expect(400);
    await startF(user, projectId, design, { approvedBudgetUsd: -1, confirmCost: true }).expect(400);
    expect(paid()).toHaveLength(0);
    // only the free model-list reads happened
    expect(fake.requests.slice(before).every((q) => q.method === 'GET')).toBe(true);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('ONE approval starts the campaign: F1 -> F3 -> F4 complete from only a name and a sentence, zero image requests, and the approval is stored with the run', async () => {
    const { user, projectId, design } = await minimal('min-run');
    const started = await startF(user, projectId, design, APPROVAL).expect(201);
    const run = await waitForFactory(user, started.body.id);
    expect(run.status).toBe('completed');
    expect(run.phases.map((x: { code: string; status: string }) => [x.code, x.status])).toEqual([['F1', 'completed'], ['F3', 'completed'], ['F4', 'completed']]);
    expect(images()).toHaveLength(0);
    const stored = await db.factoryRun.findUnique({ where: { id: started.body.id } });
    expect(stored?.configJson).toMatchObject({ workflow: 'campaign_production', approvedBudgetUsd: 5, confirmedCost: true, sharedBudget: true });
    // the campaign is readable like any other campaign: a deliverables plan, every creative a template render
    const campaign = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const pkg = campaign.package;
    expect(pkg.deliverables.counts.planned).toBeGreaterThan(0);
    expect(pkg.deliverables.counts.delivered).toBeGreaterThan(0);
    expect(pkg.imageAssets.every((a: { source: string }) => a.source === 'template_render')).toBe(true);
    // the limits written in the package say what was not available instead of hiding it
    const limits = (pkg.limitations as string[]).join('\n');
    expect(limits).toMatch(/No website was supplied, so no destination link appears in any creative/);
    expect(limits).toMatch(/No logo was supplied: the business name is used as a text-based brand identity/);
    expect(limits).toMatch(/No AI image was generated or requested/);
  });

  it('F1 and F3 adapt: the missing website, audience and competitors are named, nothing is invented, the chain still completes', async () => {
    const { user, projectId, design } = await minimal('min-adapt');
    const started = await startF(user, projectId, design, APPROVAL).expect(201);
    const run = await waitForFactory(user, started.body.id);
    expect(run.status).toBe('completed');
    expect(run.phases.find((x: { code: string }) => x.code === 'F2')).toBeUndefined(); // V4 runs no SEO/GEO audit
    const f3 = run.phases.find((x: { code: string }) => x.code === 'F3');
    const strategy = (await user.agent.get(`/strategies/${f3.outputId}`).expect(200)).body;
    expect(strategy.f2AuditId).toBeNull();
    expect(strategy.report.competitorLandscape.userSuppliedUrls).toBe(0);
    // no competitor is presented as confirmed without one of its pages having been read
    expect(strategy.report.competitorLandscape.profiles.filter((x: any) => x.competitor?.existence === 'confirmed')).toHaveLength(0);
    // F1 was told exactly what was missing and that it is not an error
    const f1Calls = fake.requests.filter((q) => q.agent === 'researcher' && q.kind === 'analysis');
    expect(f1Calls.length).toBeGreaterThan(0);
    expect(f1Calls[0].userText).toMatch(/notSupplied/);
    expect(f1Calls[0].userText).toMatch(/"website"/);
    expect(f1Calls[0].userText).toMatch(/"target audience"/);
  });

  // ---- validation: the server is the source of truth ---------------------------------------------------------------------------

  it('a missing REQUIRED item blocks: the same message in the review and in the refused Start; a real description clears it', async () => {
    const { user, projectId, design } = await minimal('min-block', { description: null });
    const p = (await preflight(user, projectId, design).expect(200)).body;
    expect(p.ok).toBe(false);
    expect(p.inputs.ready).toBe(false);
    expect(p.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    expect(p.inputs.blockers).toEqual(p.blockers);
    const refused = await startF(user, projectId, design, APPROVAL).expect(422);
    expect(refused.body.message).toBe(p.blockers[0].message); // the screen and the API say the same thing
    expect(paid()).toHaveLength(0);
    // a one-word "description" is not a description either
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: 'Dive' }).expect(200);
    expect((await preflight(user, projectId, design).expect(200)).body.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    // writing a real description clears it
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: DESCRIPTION }).expect(200);
    expect((await preflight(user, projectId, design).expect(200)).body.ok).toBe(true);
  });

  it('genuine configuration blockers stay blockers: no key, a model the key does not list', async () => {
    const noKey = await minimal('min-nokey', { key: false });
    const a = (await preflight(noKey.user, noKey.projectId, noKey.design).expect(200)).body;
    expect(a.ok).toBe(false);
    expect(a.blockers.map((b: { code: string }) => b.code)).toContain('no_credentials');
    await startF(noKey.user, noKey.projectId, noKey.design, APPROVAL).expect(422);
    const gone = await minimal('min-badmodel');
    await useFake({ models: ['text-embedding-test'] }); // the key lists no text model at all
    const b = (await preflight(gone.user, gone.projectId, gone.design).expect(200)).body;
    expect(b.blockers.map((x: { code: string }) => x.code)).toContain('model_unavailable');
    expect(paid()).toHaveLength(0);
  });

  // ---- safety nets that must keep working ---------------------------------------------------------------------------------------

  it('the plan review sends nothing paid to OpenAI (at most the free model list), also for a minimal project', async () => {
    const { user, projectId, design } = await minimal('min-preview');
    const before = fake.requests.length;
    const r = (await preflight(user, projectId, design).expect(200)).body;
    expect(r.inputs.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(fake.requests.slice(before).every((q) => q.method === 'GET' && q.path.endsWith('/models'))).toBe(true);
    // a project that lacks the required description: the plan says so (a blocker, with how to fix it) and still sends nothing paid
    const bare = await minimal('min-preview-bare', { description: null });
    await preflight(user, bare.projectId, bare.design).expect(404); // not this user's project
    const own = (await preflight(bare.user, bare.projectId, bare.design).expect(200)).body;
    expect(own.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    expect(paid()).toHaveLength(0);
  });

  it('project ownership is enforced: another user can neither review nor start a campaign for this project, and nothing is sent', async () => {
    const { projectId, design } = await minimal('min-owner');
    const stranger = await registerUser(app, 'min-stranger');
    await configureOpenAi(stranger, KEY, MODEL);
    const before = fake.requests.length;
    await preflight(stranger, projectId, design).expect(404);
    await startF(stranger, projectId, design, APPROVAL).expect(404);
    await stranger.agent.get(`/projects/${projectId}/design`).expect(404);
    expect(fake.requests.length - before).toBe(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('nothing in these flows reaches a real provider: every request went to the local fake and carried only the test key', async () => {
    const { user, projectId, design } = await minimal('min-safety');
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.LAUNCHPILOT_OPENAI_BASE_URL).toBe(fake.url);
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    await waitForFactory(user, (await startF(user, projectId, null, campaignRequest(design)).expect(201)).body.id);
    expect(fake.requests.length).toBeGreaterThan(4);
    expect(fake.requests.every((q) => q.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(images()).toHaveLength(0);
  });
});
