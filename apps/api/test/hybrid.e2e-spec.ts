import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { FakeOpenAI, type FakeOpenAIOptions, type FakeReply, type FakeRequest } from '@launchpilot/agents/dist/testing/fake-openai';
import { mergeSettings } from '../src/mozaik/factory-plan';
import { configureOpenAi, createApp, createProject, registerUser, sleep, type TestUser } from './helpers';
import request from 'supertest';

// HYBRID PRODUCTION: a few original AI images plus template creatives rendered locally. The whole F1 -> F2 -> F3 -> F4 chain runs on the
// real Mozaik runtime; only OpenAI (text and images) is faked, over real HTTP. Nothing is billed, no image comes from a real model, and
// there is no Pinterest request anywhere (the Pinterest adapter is a separate module that these flows never touch).
jest.setTimeout(600_000);

const KEY = 'sk-test-HYBRIDE2E1234567890abcdefghijk';
const MODEL = 'gpt-4.1-mini';
const IMAGE = 'gpt-image-1.5';
const F_AGENTS = ['input', 'text', 'web', 'repo', 'files', 'visual', 'synthesizer', 'seo', 'social', 'brand', 'messaging', 'presence', 'auditor', 'audience', 'competitor', 'seasonal', 'scout', 'strategist', 'copywriter', 'landing', 'vcreator'];

describe('Hybrid Production', () => {
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

  async function readyUser(label: string, withKey = true) {
    const user = await registerUser(app, label);
    const projectId = await createProject(user, 'Deep Diving School');
    await user.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Deep Diving School', shortDescription: 'Scuba diving courses for beginners in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Beginners aged 18 to 35', preferredLanguage: 'en' }).expect(200);
    if (withKey) await configureOpenAi(user, KEY, MODEL);
    return { user, projectId };
  }
  const preflight = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/factory/preflight`).send(body);
  const preview = (u: TestUser, projectId: string, body: object = {}) => u.agent.post(`/projects/${projectId}/hybrid/preview`).send(body);
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
  const zipOf = async (u: TestUser, path: string) => {
    const res = await u.agent.get(path).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    return JSZip.loadAsync(res.body as Buffer);
  };
  const HYBRID = { preset: 'hybrid_production', mode: 'fresh', approvedBudgetUsd: 5, confirmCost: true, f4: { imageModel: IMAGE } };
  const failImageAttempts = (attempts: number[]): FakeOpenAIOptions['reply'] => (r: FakeRequest): FakeReply | undefined => (r.kind === 'image' && attempts.includes(r.attempt) ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'Rejected by the safety system.' } } } : undefined);

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

  // ---- presets: the new one exists, the others are unchanged ----------------------------------------------------------------------

  it('the Hybrid preset exists with the specified defaults; First Test, Demo and Full Production keep exactly their settings', async () => {
    const { user } = await readyUser('hyb-presets');
    const { presets, default: def } = (await user.agent.get('/factory/presets').expect(200)).body;
    expect(def).toBe('first_test');
    expect(Object.keys(presets)).toEqual(['first_test', 'demo', 'full_production', 'hybrid_production', 'no_ai_hybrid']);
    expect(presets.hybrid_production.f4).toMatchObject({ concepts: 5, maxImages: 5, imageQuality: 'medium', imageModelStrategy: 'quality', variations: true, imageModel: 'auto', maxRegenerations: 0 });
    expect(presets.hybrid_production.hybrid).toMatchObject({ originals: 5, templateCreatives: 15, style: 'auto', selection: 'automatic', allowTemplateFallback: false, reviewDirection: false });
    expect(presets.hybrid_production.model).toBeNull(); // the saved text model is kept
    // the other presets did not change
    expect(presets.first_test.f4).toMatchObject({ concepts: 1, maxImages: 1, variations: false, maxModelCalls: 12, imageQuality: 'low', imageModelStrategy: 'economy' });
    expect(presets.demo.f4).toMatchObject({ concepts: 3, maxImages: 3, variations: false, maxModelCalls: 16, visionReviews: 2 });
    expect(presets.full_production.f4).toMatchObject({ concepts: 5, maxImages: 20, variations: true, layoutsPerOriginal: 3, imageConcurrency: 3, imageQuality: 'high', imageModelStrategy: 'quality' });
    for (const k of ['first_test', 'demo', 'full_production']) expect(presets[k].hybrid).toBeNull();
    expect(mergeSettings('hybrid_production', { hybrid: { originals: 8, templateCreatives: 12 } }).f4.maxImages).toBe(8);
    expect(mergeSettings('full_production').hybrid).toBeNull();
  });

  // ---- the template library and the style library ---------------------------------------------------------------------------------------

  it('the template library: a typed catalog with filters, definitions, real PNG previews and the style library; all authenticated', async () => {
    const { user } = await readyUser('hyb-lib', false);
    const all = (await user.agent.get('/templates').expect(200)).body;
    expect(all.version).toMatch(/builtin/);
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(all.categories).toHaveLength(6);
    const card = all.items[0];
    expect(card).toMatchObject({ status: 'active', version: expect.any(Number), classes: expect.any(Array), requires: expect.any(Array), styles: expect.any(Array) });
    expect(card).not.toHaveProperty('layers'); // the list carries metadata only
    const one = (await user.agent.get(`/templates/${card.id}`).expect(200)).body;
    expect(one.layers.length).toBeGreaterThan(1);
    expect(JSON.stringify(one)).not.toMatch(/https?:\/\/|<script|javascript:/i); // data only: no URL, no HTML, no code
    await user.agent.get('/templates/does_not_exist').expect(404);
    // filters
    const cat = card.category as string;
    const byCat = (await user.agent.get(`/templates?category=${cat}`).expect(200)).body.items;
    expect(byCat.length).toBeGreaterThan(0);
    expect(byCat.every((t: any) => t.category === cat)).toBe(true);
    const byClass = (await user.agent.get('/templates?class=story').expect(200)).body.items;
    expect(byClass.every((t: any) => t.classes.includes('story'))).toBe(true);
    expect((await user.agent.get('/templates?q=zzzzzz-no-match').expect(200)).body.items).toHaveLength(0);
    // a real preview rendered from the definition: a PNG of the right shape, adapted to a palette
    const cls = card.classes[0] as string;
    const png = await user.agent.get(`/templates/${card.id}/preview?class=${cls}&palette=%236d28d9,%230b1020,%2322d3ee`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    // validated input
    await user.agent.get(`/templates/${card.id}/preview?class=nonsense`).expect(400);
    await user.agent.get(`/templates/${card.id}/preview?palette=red`).expect(400);
    await user.agent.get(`/templates/${card.id}/preview?style=nope`).expect(400);
    const unsupported = (['square', 'portrait', 'story', 'landscape', 'banner'] as const).find((c) => !card.classes.includes(c));
    if (unsupported) await user.agent.get(`/templates/${card.id}/preview?class=${unsupported}`).expect(400); // never stretched into a class it was not designed for
    // styles
    const styles = (await user.agent.get('/styles').expect(200)).body.items;
    expect(styles).toHaveLength(10);
    expect(styles.map((s: any) => s.id)).toEqual(expect.arrayContaining(['minimalist_tech', 'premium_editorial', 'bold_startup', 'modern_corporate', 'luxury_hospitality', 'lifestyle_photography', 'clean_ecommerce', 'dynamic_events', 'soft_lifestyle', 'contemporary_geometric']));
    // not reachable without a session
    await request(app.getHttpServer()).get('/templates').expect(401);
    await request(app.getHttpServer()).get(`/templates/${card.id}/preview`).expect(401);
    expect(paid()).toHaveLength(0);
  });

  // ---- preflight and the FREE preview ---------------------------------------------------------------------------------------------

  it('PREFLIGHT: 5 original AI images (paid) + 15 template creatives (free) = 20, an honest cost, and nothing is spent', async () => {
    const { user, projectId } = await readyUser('hyb-pre');
    const p = (await preflight(user, projectId, { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.preset).toBe('hybrid_production');
    expect(p.models.text).toMatchObject({ id: MODEL, source: 'saved' });
    expect(p.models.image).toMatchObject({ id: IMAGE, quality: 'medium', strategySetting: 'quality' });
    expect(p.hybrid.headline).toBe('5 original AI images + 15 template creatives = 20 finished creatives');
    expect(p.hybrid.originals).toMatchObject({ planned: 5, paidRequests: 5, model: IMAGE });
    expect(p.hybrid.templateCreatives).toMatchObject({ planned: 15, paidRequests: 0 });
    expect(p.hybrid.slots).toHaveLength(15);
    expect(p.hybrid.perConcept.every((c: any) => c.originals === 1 && c.templates === 3)).toBe(true);
    expect(p.imagePlan.originalImagesPermitted).toBe(5);
    expect(p.totals.imageRequests).toBe(5);
    expect(p.totals.layouts).toBe(15);
    expect(p.budget.required).toBe(true);
    expect(p.hybrid.note).toMatch(/not a guarantee/);
    expect(JSON.stringify(p.hybrid)).not.toMatch(/saving/i);
    expect(textCalls()).toHaveLength(0);
    expect(fake.imageCalls()).toHaveLength(0);
    // configurable
    const q = (await preflight(user, projectId, { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE, concepts: 4 }, hybrid: { originals: 8, templateCreatives: 12 } }).expect(200)).body;
    expect(q.hybrid.originals.planned).toBe(8);
    expect(q.hybrid.templateCreatives.planned).toBe(12);
    expect(q.imagePlan.originalImagesPermitted).toBe(8);
    expect(paid()).toHaveLength(0);
  });

  it('FREE PREVIEW: makes NO request to OpenAI at all (not even the model list), renders the chosen templates for real and never shows placeholders as generated images', async () => {
    const { user, projectId } = await readyUser('hyb-prev');
    const before = fake.requests.length;
    const r = (await preview(user, projectId, { f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(fake.requests.length - before).toBe(0);
    expect(r).toMatchObject({ free: true, noOpenAIRequests: true, offline: true, preset: 'hybrid_production' });
    expect(r.selection.items).toHaveLength(15);
    const withThumb = r.selection.items.filter((i: any) => i.thumbnail?.url?.startsWith('data:image/jpeg;base64,'));
    expect(withThumb.length).toBe(15);
    expect(withThumb.filter((i: any) => i.thumbnail.placeholder).length).toBeGreaterThan(0);
    expect(r.sampleNote).toMatch(/placeholder/i);
    expect(r.sampleNote).toMatch(/not your campaign copy/i);
    // the plan: templates come from the library, fit their slot, and the distribution is visible
    expect(r.selection.items.every((i: any) => i.rationale.length > 10 && i.templateVersion >= 1)).toBe(true);
    expect(Object.values(r.distribution.byTemplate).reduce((a: number, b) => a + (b as number), 0)).toBe(15);
    expect(r.visualDirection.brief.styleId).toBeTruthy();
    expect(r.visualDirection.alternatives.length).toBeGreaterThan(0);
    expect(r.requirements).toMatchObject({ brandImages: 0 });
    expect(r.cost.totals).toBeDefined();
    expect(r.models.image.note).toMatch(/not checked against your key/i);
    // works for a user without a key too, and a project of another user is invisible
    const noKey = await readyUser('hyb-prev-nokey', false);
    const ok = (await preview(noKey.user, noKey.projectId, { f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(ok.selection.items).toHaveLength(15);
    await preview(noKey.user, projectId, {}).expect(404);
    // a manual choice for a slot is honored when valid and reported when not
    const slot = r.selection.items[0];
    const alt = (await user.agent.get(`/templates?class=${slot.formatClass}`).expect(200)).body.items.find((t: any) => t.id !== slot.templateId && t.requires.every((x: string) => ['image', 'logo', 'headline', 'support', 'cta', 'eyebrow', 'brand'].includes(x)));
    if (alt) {
      const m = (await preview(user, projectId, { f4: { imageModel: IMAGE }, hybrid: { selection: 'manual', overrides: { [slot.slotId]: alt.id } } }).expect(200)).body;
      const item = m.selection.items.find((i: any) => i.slotId === slot.slotId);
      expect(item.templateId).toBe(alt.id);
      expect(item.origin).toBe('user_override');
    }
    expect(fake.requests.length - before).toBe(0);
  });

  it('FREE PREVIEW also works for a project that already has a finished campaign (it shows the creative round that WOULD run)', async () => {
    const { user, projectId } = await readyUser('hyb-prev-again');
    const run = await waitF(user, (await startF(user, projectId, HYBRID).expect(201)).body.id);
    expect(run.status).toBe('completed');
    const calls = fake.requests.length;
    const r = (await preview(user, projectId, { f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(fake.requests.length - calls).toBe(0);
    expect(r.selection.items).toHaveLength(15);
    expect(r.phases.find((p: any) => p.phase === 'creative').action).toBe('run');
    expect(r.phases.filter((p: any) => p.action === 'reuse')).toHaveLength(3); // the research is reused, not repeated
  });

  it('input validation: bad slot names, unknown templates, wrong ranges and direction review are refused before anything runs', async () => {
    const { user, projectId } = await readyUser('hyb-val');
    await preview(user, projectId, { hybrid: { overrides: { 'not a slot': 'editorial_minimal' } } }).expect(422);
    await preview(user, projectId, { hybrid: { overrides: { 'K1-T1': 'no_such_template' } } }).expect(422);
    await preview(user, projectId, { hybrid: { originals: 99 } }).expect(400);
    await preview(user, projectId, { hybrid: { templateCreatives: -1 } }).expect(400);
    await preview(user, projectId, { hybrid: { style: 'made_up_style' } }).expect(400);
    await preview(user, projectId, { hybrid: { references: [{ id: 'x', kind: 'user_link', url: 'javascript:alert(1)' }] } }).expect(400);
    // starting needs the approved limit and the confirmation like every paid plan
    await startF(user, projectId, { preset: 'hybrid_production', mode: 'fresh', f4: { imageModel: IMAGE } }).expect(422);
    // the user asked to review the direction: it must be confirmed
    const noConfirm = await startF(user, projectId, { ...HYBRID, hybrid: { reviewDirection: true } }).expect(422);
    expect(noConfirm.body.message).toMatch(/review the visual direction/i);
    expect(paid()).toHaveLength(0);
  });

  it('references: links and Pinterest items are LINK-ONLY with permissions decided by the server; foreign or unknown uploads are ignored', async () => {
    const { user, projectId } = await readyUser('hyb-ref');
    const stranger = await readyUser('hyb-ref-other', false);
    const up = await stranger.user.agent.post(`/projects/${stranger.projectId}/assets`).field('type', 'reference').attach('files', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), { filename: 'ref.png', contentType: 'image/png' }).expect(201);
    const foreignId = up.body[0]?.id ?? up.body.items?.[0]?.id ?? up.body.assets?.[0]?.id;
    const p = (
      await preview(user, projectId, {
        f4: { imageModel: IMAGE },
        hybrid: {
          inspiration: 'references',
          references: [
            { id: 'a', kind: 'user_link', url: 'https://example.com/moodboard', permission: 'owned_by_user' },
            { id: 'b', kind: 'pinterest_board', url: 'https://www.pinterest.com/pin/123456789/', permission: 'owned_by_user', label: 'my secret board title' },
            { id: 'c', kind: 'pinterest_board', url: 'https://www.pinterest.com/someone/board/' },
            { id: foreignId ?? 'nope', kind: 'user_upload' },
          ],
        },
      }).expect(200)
    ).body;
    const refs = p.hybrid.references as { kind: string; permission: string; label: string; url: string | null }[];
    const link = refs.find((r) => r.kind === 'user_link')!;
    expect(link.permission).toBe('link_only_not_analyzed');
    const pin = refs.find((r) => r.kind === 'pinterest_board')!;
    expect(pin.permission).toBe('platform_restricted_not_stored');
    expect(pin.label).toBe('Pinterest pin (link only)'); // the client's label is not kept
    expect(refs.filter((r) => r.kind === 'pinterest_board')).toHaveLength(1); // a board address is not a pin link
    expect(refs.some((r) => r.kind === 'user_upload')).toBe(false); // another user's file is never reachable
    expect(p.warnings.join(' ')).toMatch(/ignored/);
    // the recorded direction lists them with what was (not) done; nothing from them reached the colors
    const dir = p.visualDirection.brief;
    expect(dir.references.find((r: any) => r.kind === 'pinterest_board')?.used).toMatch(/Not analyzed/);
    expect(dir.references.find((r: any) => r.kind === 'user_link')?.used).toMatch(/Link only/);
    expect(paid()).toHaveLength(0);
  });

  // ---- full runs --------------------------------------------------------------------------------------------------------------------

  it('FULL RUN: F1 -> F4 with exactly 5 image requests, 15 template creatives, honest lineage, downloads, ownership', async () => {
    const { user, projectId } = await readyUser('hyb-full');
    const started = (await startF(user, projectId, HYBRID).expect(201)).body;
    const run = await waitF(user, started.id);
    if (process.env.HYBRID_DEBUG && run.status !== 'completed') {
      const c = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
      console.log('COPY', JSON.stringify(c.package.concepts.map((k: any) => k.id)), JSON.stringify(c.package.copyVariants.map((v: any) => `${v.conceptId}/${v.channel}/${v.placement}`)), JSON.stringify(c.package.channelLayouts.length));
      console.log('RUN', run.status, run.errorMessage, JSON.stringify(run.warnings), JSON.stringify(c.package.hybrid.creatives.map((x: any) => `${x.slotId}:${x.status}:${x.reason}`)), JSON.stringify(c.package.limitations), JSON.stringify(c.package.hybrid.notes), JSON.stringify(c.package.hybrid.counts));
    }
    expect(run.status).toBe('completed');
    expect(run.config).toMatchObject({ preset: 'hybrid_production', approvedBudgetUsd: 5 });
    expect(run.config.settings.hybrid).toMatchObject({ originals: 5, templateCreatives: 15 });
    expect(fake.imageCalls()).toHaveLength(5);
    const prompts = fake.imageCalls().map((c) => String(c.body?.prompt));
    expect(new Set(prompts).size).toBe(5);
    expect(prompts.every((x) => /VISUAL DIRECTION:/.test(x) && /no text, letters, logos or watermarks/i.test(x))).toBe(true);
    // a model-free selection and (by default) a refined direction: at most one extra text call for the direction
    expect(fake.calls('tselector')).toHaveLength(0);
    expect(fake.calls('vresearcher').length).toBeLessThanOrEqual(1);

    const camp = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const h = camp.package.hybrid;
    expect(h.mode).toBe('hybrid');
    expect(h.counts.originals).toMatchObject({ planned: 5, requested: 5, generated: 5 });
    expect(h.counts.templates).toMatchObject({ planned: 15, rendered: 15, failed: 0 });
    expect(h.counts.total).toEqual({ planned: 20, delivered: 20 });
    expect(camp.package.usage.images.requested).toBe(5);
    expect(h.counts.spending.approvedUsd).toBeGreaterThan(0);
    // the stored assets keep the lineage after a round trip through the database
    const aiImages = camp.assets.filter((a: any) => a.kind === 'image' && a.source === 'ai_image');
    const templates = camp.assets.filter((a: any) => a.kind === 'layout' && a.status !== 'superseded');
    expect(aiImages).toHaveLength(5);
    expect(templates).toHaveLength(15);
    expect(templates.every((a: any) => a.source === 'template_render' && a.origin === 'TEMPLATE_RENDERED' && !!a.templateId && a.templateVersion >= 1 && a.sourceAssetIds?.length >= 1 && a.rights?.basis === 'original_template' && !!a.url)).toBe(true);
    const originalIds = new Set(aiImages.map((a: any) => a.id));
    expect(templates.every((a: any) => a.sourceAssetIds.some((id: string) => originalIds.has(id)))).toBe(true);
    expect(aiImages.every((a: any) => a.origin === undefined || a.origin === 'AI_GENERATED')).toBe(true);
    expect((await user.agent.get(`/projects/${projectId}/campaigns`).expect(200)).body.items[0]).toMatchObject({ id: run.campaignId, generatedImages: 5 }); // template creatives are not counted as AI images
    // a template creative really is a different picture from its original
    const file = await user.agent.get(templates[0].url.replace(/^\/api/, '')).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((file.body as Buffer).length).toBeGreaterThan(2000);

    // downloads
    const full = await zipOf(user, `/campaigns/${run.campaignId}/export`);
    const names = Object.keys(full.files);
    expect(names.filter((n) => /^images\/originals\/concept-\d\d-variation-\d\d\.png$/.test(n))).toHaveLength(5);
    expect(names.filter((n) => /^images\/templates\/concept-\d\d\/.+\.png$/.test(n))).toHaveLength(15);
    for (const f of ['campaign.json', 'manifest.json', 'visual-direction/visual-direction.json', 'layouts/selection.json', 'strategy/strategy.json', 'usage/usage.json']) expect(names).toContain(f);
    const manifest = JSON.parse(await full.file('manifest.json')!.async('string'));
    expect(manifest.hybrid.productionMode).toBe('hybrid_production');
    expect(manifest.assetsMissing).toEqual([]);
    for (const t of manifest.hybrid.templateCreatives) expect(names).toContain(t.file);
    expect(names.some((n) => /pinterest/i.test(n))).toBe(false);
    expect(Object.keys((await zipOf(user, `/campaigns/${run.campaignId}/export/originals`)).files).filter((n) => n.endsWith('.png'))).toHaveLength(5);
    expect(Object.keys((await zipOf(user, `/campaigns/${run.campaignId}/export/templates`)).files).filter((n) => n.endsWith('.png'))).toHaveLength(15);
    expect(Object.keys((await zipOf(user, `/campaigns/${run.campaignId}/export/creatives`)).files).filter((n) => n.endsWith('.png'))).toHaveLength(20);

    // ownership: other users get 404 everywhere
    const other = await registerUser(app, 'hyb-other');
    for (const path of ['', '/export', '/export/originals', '/export/templates', '/export/creatives']) await other.agent.get(`/campaigns/${run.campaignId}${path}`).expect(404);
    // a Full Production-style campaign has no template creatives to download
    expect(camp.package.imageCounts.generated).toBe(5);
  });

  it('PARTIAL: 2 of 5 images fail; the run is partial with real counts; the missing parts are completed WITHOUT rerunning research or copy', async () => {
    await useFake({ reply: failImageAttempts([2, 4]) });
    const { user, projectId } = await readyUser('hyb-part');
    const run = await waitF(user, (await startF(user, projectId, HYBRID).expect(201)).body.id);
    expect(run.status).toBe('partial');
    expect(run.errorMessage).toMatch(/of the 5 requested original AI images were generated/);
    const first = (await user.agent.get(`/campaigns/${run.campaignId}`).expect(200)).body;
    const h = first.package.hybrid;
    expect(h.counts.originals).toMatchObject({ planned: 5, generated: 3, failed: 2 });
    expect(h.counts.templates.rendered).toBe(9);
    expect(h.counts.total).toEqual({ planned: 20, delivered: 12 });
    expect(h.creatives.filter((c: any) => c.status === 'skipped').every((c: any) => !!c.reason && c.assetId === null)).toBe(true);
    expect(first.package.approval.status).not.toBe('approved');
    expect(first.assets.filter((a: any) => a.source === 'brand_gradient')).toHaveLength(0);

    // the images are fine now
    await useFake();
    const pre = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images/preflight`).send({ approvedBudgetUsd: 2 }).expect(200)).body;
    expect(pre).toMatchObject({ ok: true, willRequest: 2, mustConfirm: true });
    expect(pre.hybrid).toMatchObject({ templatesPlanned: 15, templatesDelivered: 9 });
    expect(paid()).toHaveLength(0);
    await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({}).expect(422); // billed images need consent
    const started = (await user.agent.post(`/campaigns/${run.campaignId}/continue-images`).send({ approvedBudgetUsd: 2, confirmCost: true }).expect(201)).body;
    const end = Date.now() + 300_000;
    let row: any;
    for (;;) {
      row = (await user.agent.get(`/runs/${started.id}`).expect(200)).body;
      if (row.status !== 'RUNNING') break;
      if (Date.now() > end) throw new Error('continuation still running');
      await sleep(150);
    }
    expect(row.status).toBe('COMPLETED');
    const second = await waitCampaign(user, row.campaignId);
    expect(fake.imageCalls()).toHaveLength(2);
    const agents = new Set(textCalls().map((r) => r.agent));
    for (const a of F_AGENTS) expect(agents.has(a as never)).toBe(false);
    expect(second.package.hybrid.counts.total).toEqual({ planned: 20, delivered: 20 });
    expect(second.package.lineage).toMatchObject({ kind: 'image_continuation', parentCampaignId: first.id });
    expect(second.assets.filter((a: any) => a.kind === 'layout' && a.status !== 'superseded')).toHaveLength(15);
    // the earlier campaign is exactly as it was
    const firstAgain = (await user.agent.get(`/campaigns/${first.id}`).expect(200)).body;
    expect(firstAgain.package.hybrid.counts.total).toEqual({ planned: 20, delivered: 12 });
  });

  it('every other preset still behaves as before: a First Test plan has no Hybrid block and no template participants', async () => {
    const { user, projectId } = await readyUser('hyb-regress');
    const p = (await preflight(user, projectId, { preset: 'first_test' }).expect(200)).body;
    expect(p.hybrid).toBeNull();
    expect(p.settings.hybrid).toBeNull();
    const f = (await preflight(user, projectId, { preset: 'full_production', mode: 'fresh', f4: { imageModel: IMAGE } }).expect(200)).body;
    expect(f.hybrid).toBeNull();
    expect(f.imagePlan.originalsTarget).toBe(20);
  });
});
