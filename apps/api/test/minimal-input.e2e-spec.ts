import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { assessInputs, isMeaningfulDescription, type InputFacts } from '../src/mozaik/input-readiness';
import { configureOpenAi, createApp, registerUser, sleep, type TestUser } from './helpers';

// HYBRID PRODUCTION FROM A MINIMAL PROJECT: a business name and one sentence are enough to review the plan, approve ONE spending limit and start.
// Missing optional data is advice (with the fallback LaunchPilot applies), never a blocker. The whole F1 -> F4 chain runs on the real Mozaik
// runtime; only OpenAI (text and images) is faked, over real HTTP. Nothing is billed and no real provider is ever contacted.
jest.setTimeout(600_000);

const KEY = 'sk-test-MINIMALE2E1234567890abcdefghi';
const MODEL = 'gpt-4.1-mini';
const UNPRICED = 'gpt-image-2.5-sunburst'; // billed by tokens: OpenAI publishes no per-image price, so Quality First (the Hybrid default) picks an unpriced model
const PRICED = 'gpt-image-1.5';
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
      'Website not provided. Website SEO analysis will be skipped and no destination link will be invented.',
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

  it('a missing REQUIRED item blocks only where it is enforced (Hybrid Production); other presets only get the advice', () => {
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

describe('Hybrid Production from a minimal project (business name + short description)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;

  async function useFake(options: FakeOpenAIOptions = {}) {
    if (fake) await fake.close();
    fake = await new FakeOpenAI({ models: [MODEL, UNPRICED, PRICED, 'gpt-image-1-mini', 'text-embedding-test'], ...options }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
  }
  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations'));
  const images = () => fake.requests.filter((r) => r.path.endsWith('/images/generations'));

  /** A project with ONLY a name and a short description (as the project form saves them), and a saved (fake) key and model. */
  async function minimal(label: string, o: { description?: string | null; key?: boolean } = {}) {
    const user = await registerUser(app, label);
    const description = o.description === undefined ? DESCRIPTION : o.description;
    const created = await user.agent.post('/projects').send({ name: 'JigJoy', ...(description ? { description } : {}) }).expect(201);
    const projectId = created.body.id as string;
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', ...(description ? { shortDescription: description } : {}) }).expect(200);
    if (o.key !== false) await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send({ preset: 'hybrid_production', mode: 'fresh', ...body });
  const startF = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory`).send({ preset: 'hybrid_production', mode: 'fresh', ...body });
  const waitF = async (u: TestUser, id: string, ms = 420_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = (await u.agent.get(`/factory-runs/${id}`).expect(200)).body;
      if (!['queued', 'running'].includes(v.status)) return v;
      if (Date.now() > end) throw new Error(`Factory run ${id} still ${v.status} after ${ms} ms`);
      await sleep(150);
    }
  };
  /** The one spending approval of the Hybrid preset: a limit, the confirmation, and the maximum number of image requests the plan showed. */
  const APPROVAL = { approvedBudgetUsd: 5, confirmCost: true, approvedImageRequests: 5 };

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
    const { user, projectId } = await minimal('min-pre');
    const res = await preflight(user, projectId).expect(200);
    const p = res.body;
    expect(p.ok).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.inputs.ready).toBe(true);
    expect(p.inputs.counts.required).toEqual({ present: 2, total: 2 });
    expect(p.inputs.warnings).toHaveLength(3); // website, logo, audience
    expect(p.inputs.warnings.join(' ')).toMatch(/Website not provided\. Website SEO analysis will be skipped/);
    expect(p.inputs.warnings.join(' ')).toMatch(/Logo not provided\. LaunchPilot will use a text-based brand identity/);
    expect(p.inputs.warnings.join(' ')).toMatch(/Target audience not specified\. The AI will propose an audience/);
    expect(p.inputs.notes.join(' ')).toMatch(/No template collection chosen yet/);
    expect(p.preset).toBe('hybrid_production');
    // the review itself asks OpenAI for nothing that costs money (only the free model list is read)
    expect(paid()).toHaveLength(0);
  });

  it('unknown image price: no checkbox of its own; the exact model, "unavailable" and the maximum image requests are in the plan, with bounded alternatives', async () => {
    const { user, projectId } = await minimal('min-price');
    const p = (await preflight(user, projectId).expect(200)).body;
    expect(p.models.image).toMatchObject({ id: UNPRICED, priceKnown: false, pricing: 'unavailable', requiresPriceConfirmation: false });
    expect(p.budget).toMatchObject({ consentNeeded: true, unpricedImagesConfirmationNeeded: false, imagePriceUnavailable: true, imageRequestCap: 5, imageRequestsApprovedWithBudget: true });
    expect(p.cost.images).toMatchObject({ model: UNPRICED, basis: 'unavailable', typicalUsd: null, count: 5 });
    expect(p.warnings.join(' ')).toMatch(/Image pricing is not available for gpt-image-2\.5-sunburst/);
    expect(p.warnings.join(' ')).toMatch(/application-level spending target, not a guaranteed billing cap for unpriced requests/);
    expect(p.warnings.join(' ')).toMatch(/Actual charges may differ/);
    expect(p.warnings.join(' ')).not.toMatch(/you must confirm this to start/);
    // two honest ways to keep the cost bounded: a model with a published price, or no images at all
    const alt = p.cost.images.alternatives as { id: string; set: Record<string, unknown>; label: string }[];
    expect(alt.map((a) => a.id)).toEqual(['priced_model', 'image_free']);
    expect(alt[0].set).toEqual({ imageModel: PRICED });
    expect(alt[0].label).toMatch(/published price/);
    expect(alt[1].set).toEqual({ imageFree: true });
    expect(paid()).toHaveLength(0);
  });

  // ---- ONE spending approval ----------------------------------------------------------------------------------------------------

  it('Start still needs the spending approval: no limit, no confirmation, or a too-small limit is refused and nothing is sent', async () => {
    const { user, projectId } = await minimal('min-need-approval');
    const before = fake.requests.length;
    await startF(user, projectId).expect(422);
    await startF(user, projectId, { approvedBudgetUsd: 5 }).expect(422); // limit without the confirmation
    await startF(user, projectId, { confirmCost: true }).expect(422); // confirmation without a limit
    await startF(user, projectId, { approvedBudgetUsd: 5, confirmCost: false, approvedImageRequests: 5 }).expect(422);
    const r = await startF(user, projectId, { approvedBudgetUsd: 0.01, confirmCost: true, approvedImageRequests: 5 }).expect(422); // far below the text estimate
    expect(String(r.body.message)).toMatch(/below|estimate/i);
    expect(paid()).toHaveLength(0);
    // only the free model-list reads happened
    expect(fake.requests.slice(before).every((q) => q.method === 'GET')).toBe(true);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('with an unpublished image price the approval must also name the maximum image requests: missing or different numbers are refused, the old checkbox alone is not enough', async () => {
    const { user, projectId } = await minimal('min-cap');
    const missing = await startF(user, projectId, { approvedBudgetUsd: 5, confirmCost: true }).expect(422);
    expect(String(missing.body.message)).toMatch(/maximum number of image requests this plan makes \(5\)/);
    const wrong = await startF(user, projectId, { approvedBudgetUsd: 5, confirmCost: true, approvedImageRequests: 4 }).expect(422);
    expect(String(wrong.body.message)).toMatch(/\(5\)/);
    const tooMany = await startF(user, projectId, { approvedBudgetUsd: 5, confirmCost: true, approvedImageRequests: 40 }).expect(422);
    expect(String(tooMany.body.message)).toMatch(/approvedImageRequests: 5/);
    // an old client that only sends the separate checkbox does not get around the unified approval
    await startF(user, projectId, { approvedBudgetUsd: 5, confirmCost: true, confirmUnpricedImages: true }).expect(422);
    // a number outside what the API accepts at all
    await startF(user, projectId, { ...APPROVAL, approvedImageRequests: 41 }).expect(400);
    await startF(user, projectId, { ...APPROVAL, approvedImageRequests: -1 }).expect(400);
    expect(paid()).toHaveLength(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('ONE approval starts the campaign: F1 -> F4 complete from only a name and a sentence, exactly 5 image requests, and the approval is stored with the run', async () => {
    const { user, projectId } = await minimal('min-run');
    const started = await startF(user, projectId, APPROVAL).expect(201); // no confirmUnpricedImages anywhere
    const run = await waitF(user, started.body.id);
    expect(run.status).toBe('completed');
    expect(run.phases.map((x: { code: string; status: string }) => [x.code, x.status])).toEqual([['F1', 'completed'], ['F2', 'completed'], ['F3', 'completed'], ['F4', 'completed']]);
    // the maximum approved is the maximum sent
    expect(images()).toHaveLength(5);
    expect(images().every((q) => q.body?.model === UNPRICED)).toBe(true);
    const stored = await db.factoryRun.findUnique({ where: { id: started.body.id } });
    expect(stored?.configJson).toMatchObject({ approvedBudgetUsd: 5, confirmedCost: true, confirmedUnpricedImages: true, approvedImageRequests: 5, imageModel: UNPRICED });
    // the campaign is the 5 + 15 allocation, readable like any other campaign
    const campaign = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const pkg = campaign.package;
    expect(pkg.hybrid.counts.total).toMatchObject({ planned: 20, delivered: 20 });
    expect(pkg.hybrid.counts.originals).toMatchObject({ planned: 5, generated: 5 });
    expect(pkg.hybrid.counts.templates).toMatchObject({ planned: 15, rendered: 15 });
    // the limits written in the package say what was not available instead of hiding it
    const limits = (pkg.limitations as string[]).join('\n');
    expect(limits).toMatch(/No website was supplied, so no destination link appears in any creative/);
    expect(limits).toMatch(/No logo was supplied: the business name is used as a text-based brand identity/);
    expect(limits).toMatch(/No brand colors were available: the palette comes from the built-in style library/);
  });

  it('F2 and F3 adapt: the missing website, social profiles and competitors are reported as "not evaluated", nothing is invented, the chain still completes', async () => {
    const { user, projectId } = await minimal('min-adapt');
    const started = await startF(user, projectId, APPROVAL).expect(201);
    const run = await waitF(user, started.body.id);
    expect(run.status).toBe('completed');
    const f2 = run.phases.find((x: { code: string }) => x.code === 'F2');
    const audit = JSON.stringify((await user.agent.get(`/audits/${f2.outputId}`).expect(200)).body);
    expect(audit).toMatch(/Not evaluated — no website supplied\. Website SEO analysis was skipped/);
    expect(audit).toMatch(/Not evaluated — no social profile supplied/);
    const f3 = run.phases.find((x: { code: string }) => x.code === 'F3');
    const strategy = JSON.stringify((await user.agent.get(`/strategies/${f3.outputId}`).expect(200)).body);
    expect(strategy).toMatch(/no competitor figure is invented/);
    // F1 was told exactly what was missing and that it is not an error
    const f1Calls = fake.requests.filter((q) => q.agent === 'input' && q.kind === 'analysis');
    expect(f1Calls.length).toBeGreaterThan(0);
    expect(f1Calls[0].userText).toMatch(/"notSupplied"/);
    expect(f1Calls[0].userText).toMatch(/"website"/);
    expect(f1Calls[0].userText).toMatch(/"target audience"/);
  });

  it('with a model that HAS a published price there is no image-price notice at all: the same one approval, no approvedImageRequests needed', async () => {
    const { user, projectId } = await minimal('min-priced');
    const p = (await preflight(user, projectId, { f4: { imageModel: PRICED } }).expect(200)).body;
    expect(p.budget).toMatchObject({ unpricedImagesConfirmationNeeded: false, imagePriceUnavailable: false, imageRequestsApprovedWithBudget: false, imageRequestCap: 5 });
    expect(p.cost.images.alternatives).toEqual([]);
    expect(p.models.image).toMatchObject({ priceKnown: true, pricing: 'published' });
    const run = await waitF(user, (await startF(user, projectId, { f4: { imageModel: PRICED }, approvedBudgetUsd: 5, confirmCost: true }).expect(201)).body.id);
    expect(run.status).toBe('completed');
    expect(images()).toHaveLength(5);
  });

  it('"run without original AI images" is a real option: no image model, no image cost, no image request, and the campaign says what it delivers', async () => {
    const { user, projectId } = await minimal('min-free');
    const p = (await preflight(user, projectId, { f4: { imageModel: null } }).expect(200)).body;
    expect(p.models.image).toBeNull();
    expect(p.cost.images).toMatchObject({ basis: 'none', count: 0, typicalUsd: 0 });
    expect(p.budget).toMatchObject({ imageRequestCap: 0, imageRequestsApprovedWithBudget: false, imagePriceUnavailable: false });
    expect(p.hybrid.originals.planned).toBe(0);
    expect(p.hybrid.headline).toMatch(/^0 original AI images/);
    await startF(user, projectId, { f4: { imageModel: null } }).expect(422); // text calls are still paid: the approval is still required
    const run = await waitF(user, (await startF(user, projectId, { f4: { imageModel: null }, approvedBudgetUsd: 3, confirmCost: true }).expect(201)).body.id);
    expect(['completed', 'partial']).toContain(run.status);
    expect(images()).toHaveLength(0);
  });

  // ---- validation: the server is the source of truth ---------------------------------------------------------------------------

  it('a missing REQUIRED item is the only thing that blocks: the same message in the review and in the refused Start; other presets are not affected', async () => {
    const { user, projectId } = await minimal('min-block', { description: null });
    const p = (await preflight(user, projectId).expect(200)).body;
    expect(p.ok).toBe(false);
    expect(p.inputs.ready).toBe(false);
    expect(p.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    expect(p.inputs.blockers).toEqual(p.blockers);
    const refused = await startF(user, projectId, APPROVAL).expect(422);
    expect(refused.body.message).toBe(p.blockers[0].message); // the screen and the API say the same thing
    expect(paid()).toHaveLength(0);
    // a one-word "description" is not a description either
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: 'Dive' }).expect(200);
    expect((await preflight(user, projectId).expect(200)).body.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    // First Test, Demo and Full Production keep their rules: no new blocker, only advice
    for (const preset of ['first_test', 'demo', 'full_production']) {
      const o = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({ preset, mode: 'fresh' }).expect(200)).body;
      expect(o.blockers).toEqual([]);
      expect(o.inputs.blockers).toEqual([]);
      expect(o.inputs.checks.find((c: { id: string }) => c.id === 'description')).toMatchObject({ level: 'required', present: false });
    }
    // writing a real description clears it
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'JigJoy', shortDescription: DESCRIPTION }).expect(200);
    expect((await preflight(user, projectId).expect(200)).body.ok).toBe(true);
  });

  it('genuine configuration blockers stay blockers: no key, a model the key does not list', async () => {
    const noKey = await minimal('min-nokey', { key: false });
    const a = (await preflight(noKey.user, noKey.projectId).expect(200)).body;
    expect(a.ok).toBe(false);
    expect(a.blockers.map((b: { code: string }) => b.code)).toContain('no_credentials');
    await startF(noKey.user, noKey.projectId, APPROVAL).expect(422);
    const gone = await minimal('min-badmodel');
    await useFake({ models: [PRICED] }); // the key lists no text model at all
    const b = (await preflight(gone.user, gone.projectId).expect(200)).body;
    expect(b.blockers.map((x: { code: string }) => x.code)).toContain('model_unavailable');
    expect(paid()).toHaveLength(0);
  });

  it('every preset uses the same ONE approval: Full Production no longer has a separate unknown-price checkbox either', async () => {
    const { user, projectId } = await minimal('min-fullprod');
    const p = (await user.agent.post(`/projects/${projectId}/factory/preflight`).send({ preset: 'full_production', mode: 'fresh' }).expect(200)).body;
    expect(p.models.image.id).toBe(UNPRICED);
    expect(p.budget).toMatchObject({ unpricedImagesConfirmationNeeded: false, imageRequestsApprovedWithBudget: true, imageRequestCap: 20 });
    const old = await user.agent.post(`/projects/${projectId}/factory`).send({ preset: 'full_production', mode: 'fresh', approvedBudgetUsd: 7, confirmCost: true, confirmUnpricedImages: true }).expect(422);
    expect(String(old.body.message)).toMatch(/maximum number of image requests this plan makes \(20\)/); // the old checkbox alone is not an approval any more
    expect(paid()).toHaveLength(0);
  });

  // ---- safety nets that must keep working ---------------------------------------------------------------------------------------

  it('the free preview sends nothing to OpenAI at all (not even the model list), also for a minimal project', async () => {
    const { user, projectId } = await minimal('min-preview');
    const before = fake.requests.length;
    const r = (await user.agent.post(`/projects/${projectId}/hybrid/preview`).send({}).expect(200)).body;
    expect(r.offline).toBe(true);
    expect(r.inputs.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(fake.requests.length - before).toBe(0);
    // a project that lacks the required description: the preview says so (a blocker, with how to fix it) and still sends nothing
    const bare = await minimal('min-preview-bare', { description: null });
    const before2 = fake.requests.length;
    const rb = (await user.agent.post(`/projects/${bare.projectId}/hybrid/preview`).send({}).expect(404)).body; // not this user's project
    void rb;
    const own = (await bare.user.agent.post(`/projects/${bare.projectId}/hybrid/preview`).send({}).expect(200)).body;
    expect(own.ok === false || own.blockers.length > 0).toBe(true);
    expect(own.blockers.map((b: { code: string }) => b.code)).toEqual(['missing_description']);
    expect(fake.requests.length - before2).toBe(0);
  });

  it('project ownership is enforced: another user can neither review nor start a campaign for this project, and nothing is sent', async () => {
    const { projectId } = await minimal('min-owner');
    const stranger = await registerUser(app, 'min-stranger');
    await configureOpenAi(stranger, KEY, MODEL);
    const before = fake.requests.length;
    await preflight(stranger, projectId).expect(404);
    await startF(stranger, projectId, APPROVAL).expect(404);
    await stranger.agent.post(`/projects/${projectId}/hybrid/preview`).send({}).expect(404);
    expect(fake.requests.length - before).toBe(0);
    expect(await db.factoryRun.count({ where: { projectId } })).toBe(0);
  });

  it('a rate limit on an image is waited out (Retry-After), not hammered, and never raises the approved number of image requests', async () => {
    const hits: number[] = [];
    await useFake({
      reply: (r: FakeRequest): FakeReply | undefined => {
        if (r.kind !== 'image') return undefined;
        hits.push(Date.now());
        return hits.length === 1 ? { status: 429, headers: { 'Retry-After': '1' }, json: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for images.' } } } : undefined;
      },
    });
    const { user, projectId } = await minimal('min-ratelimit');
    const run = await waitF(user, (await startF(user, projectId, APPROVAL).expect(201)).body.id);
    expect(['completed', 'partial']).toContain(run.status);
    expect(hits.length).toBeGreaterThanOrEqual(6); // the 429 plus the five images
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(900); // nobody asked again before Retry-After passed
    const usage = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body.package.usage;
    expect(usage.images.requested).toBe(5); // a waited-out 429 is the same request, not a sixth one
    expect(usage.images.rateLimited).toBeGreaterThanOrEqual(1);
  });

  it('nothing in these flows reaches a real provider: every request went to the local fake and carried only the test key', async () => {
    const { user, projectId } = await minimal('min-safety');
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.LAUNCHPILOT_OPENAI_BASE_URL).toBe(fake.url);
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    await waitF(user, (await startF(user, projectId, APPROVAL).expect(201)).body.id);
    expect(fake.requests.length).toBeGreaterThan(10);
    expect(fake.requests.every((q) => q.authorization === `Bearer ${KEY}`)).toBe(true);
  });
});
