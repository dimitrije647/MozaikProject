import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PrismaClient } from '@prisma/client';
import { FakeOpenAI } from '@launchpilot/agents/dist/testing/fake-openai';
import { StorageDriver } from '../src/storage/storage.service';
// sharp belongs to the agents package; the API reaches the very same copy through that package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: any = require(require.resolve('sharp', { paths: [require.resolve('@launchpilot/agents')] }));
import { binary, campaignRequest, confirmedDesign, configureOpenAi, createApp, createProject, registerUser, waitForFactory, type Agent, type TestUser } from './helpers';

// THE CREATIVE EDITOR over HTTP (owner only): open a creative of a finished campaign, preview new text (the real PNG of the local renderer), save
// it, find it in the results, the asset file and the ZIP, restore the original. A real campaign run on a fake text API (nothing is billed); the
// editor itself makes no request to any provider. A synthetic logo only: no private picture is a fixture.
jest.setTimeout(600_000);

const KEY = 'sk-test-EDITOR1234567890abcdefghijklmnop';
const MODEL = 'gpt-4.1-mini';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const logoPng = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="140"><rect width="140" height="140" rx="24" fill="#0b3d91"/><rect x="160" y="50" width="220" height="40" fill="#f2c94c"/></svg>')).png().toBuffer();
/** a binary POST (the preview answers with a PNG) */
const postBinary = (agent: Agent, path: string, body: object) =>
  agent.post(path).send(body).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('Creative editor (manual text edits, local re-render, no AI)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let fake: FakeOpenAI;
  let previousUrl: string | undefined;
  let owner: TestUser;
  let other: TestUser;
  let campaignId: string;
  let slotId: string;
  let base: string;
  let assetsBefore: Map<string, string>;

  const paid = () => fake.requests.filter((r) => r.path.endsWith('/responses') || r.path.endsWith('/images/generations')).length;
  const url = (s = slotId) => `/campaigns/${campaignId}/creatives/${s}`;
  const pkgOf = async () => (await db.creativeCampaign.findUnique({ where: { id: campaignId } }))!.packageJson as any;
  const zipOf = async (u = owner) => JSZip.loadAsync((await binary(u.agent, `/campaigns/${campaignId}/export`).expect(200)).body as Buffer);

  beforeAll(async () => {
    previousUrl = process.env.LAUNCHPILOT_OPENAI_BASE_URL;
    fake = await new FakeOpenAI({ models: [MODEL] }).start();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = fake.url;
    app = await createApp();
    db = new PrismaClient();
    owner = await registerUser(app, 'editor-owner');
    other = await registerUser(app, 'editor-other');
    const projectId = await createProject(owner, 'Harbour Lane Studio');
    await owner.agent.put(`/projects/${projectId}/intake`).send({ productName: 'Harbour Lane Studio', shortDescription: 'Succession planning for family companies in Novi Sad', targetMarket: 'Novi Sad, Serbia', targetAudience: 'Owners of family companies', preferredLanguage: 'en' }).expect(200);
    await owner.agent.post(`/projects/${projectId}/assets`).field('type', 'logo').attach('files', await logoPng(), { filename: 'logo.png', contentType: 'image/png' }).expect(201);
    await configureOpenAi(owner, KEY, MODEL);
    const design = await confirmedDesign(owner, projectId, 'premium_editorial');
    const run = await waitForFactory(owner, (await owner.agent.post(`/projects/${projectId}/factory`).send(campaignRequest(design, { concepts: 1, channels: ['instagram', 'x'] })).expect(201)).body.id);
    expect(run.status).toMatch(/completed|partial/);
    campaignId = run.campaignId;
    const pkg = await pkgOf();
    const rendered = pkg.hybrid.creatives.filter((c: any) => c.status === 'rendered' && c.assetId);
    expect(rendered.length).toBeGreaterThan(1);
    slotId = (rendered.find((c: any) => c.channel === 'instagram') ?? rendered[0]).slotId;
    assetsBefore = new Map(rendered.map((c: any) => [c.slotId, c.assetId]));
  });
  afterAll(async () => {
    await fake.close();
    process.env.LAUNCHPILOT_OPENAI_BASE_URL = previousUrl;
    await app.close();
    await db.$disconnect();
  });

  it('opens a creative with its fields from the saved specification; another user cannot see, preview or save it', async () => {
    const s = (await owner.agent.get(`${url()}/editor`).expect(200)).body;
    expect(s.editable).toBe(true);
    expect(s.reason).toBeNull();
    expect(s.fields.map((f: any) => f.id)).toContain('headline');
    expect(s.fields.find((f: any) => f.id === 'brand')).toBeUndefined();
    for (const f of s.fields) expect(f.value).toBe(f.original);
    expect(s.imageUrl).toBe(`/campaigns/${campaignId}/assets/${s.assetId}/file`);
    expect(JSON.stringify(s)).not.toMatch(/uploads|filePath|[A-Z]:\\\\|sk-test/);
    base = s.assetId;
    // another user: 404 everywhere (ids cannot be probed)
    await other.agent.get(`${url()}/editor`).expect(404);
    await other.agent.post(`${url()}/preview`).send({ fields: { headline: 'x' }, baseAssetId: base }).expect(404);
    await other.agent.put(url()).send({ fields: { headline: 'x' }, baseAssetId: base }).expect(404);
    await other.agent.post(`${url()}/restore`).send({ baseAssetId: base }).expect(404);
    await owner.agent.get(`${url('not-a-slot')}/editor`).expect(404);
    await owner.agent.get(`${url('../../etc')}/editor`).expect(404);
  });

  it('PREVIEW: the real PNG at the original size, no provider call; bad input and text that cannot fit are refused with the field named', async () => {
    const calls = paid();
    const s = (await owner.agent.get(`${url()}/editor`).expect(200)).body;
    const res = await postBinary(owner.agent, `${url()}/preview`, { fields: { headline: 'Who makes the next decision?' }, baseAssetId: base }).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    const meta = JSON.parse(Buffer.from(res.headers['x-creative-preview'], 'base64url').toString('utf8'));
    const png = res.body as Buffer;
    expect(meta.sha256).toBe(sha(png));
    const m = await sharp(png).metadata();
    expect([m.width, m.height]).toEqual([s.width, s.height]);
    expect(['passed', 'warnings', 'unresolved']).toContain(meta.status);
    // the same text again: the same bytes (what is previewed is what is saved)
    const again = await postBinary(owner.agent, `${url()}/preview`, { fields: { headline: 'Who makes the next decision?' }, baseAssetId: base }).expect(200);
    expect(sha(again.body as Buffer)).toBe(meta.sha256);
    const unknown = await owner.agent.post(`${url()}/preview`).send({ fields: { headline: 'Fine', secretSlot: 'x' }, baseAssetId: base }).expect(422);
    expect(unknown.body.code).toBe('invalid');
    expect(unknown.body.errors.some((e: any) => e.field === 'secretSlot')).toBe(true);
    const empty = await owner.agent.post(`${url()}/preview`).send({ fields: { headline: '   ' }, baseAssetId: base }).expect(422);
    expect(empty.body.errors[0].field).toBe('headline');
    const words = 'Succession planning for family companies that want a calm and orderly handover across generations without any surprises at all';
    const long = await owner.agent.post(`${url()}/preview`).send({ fields: { headline: words.slice(0, 160) }, baseAssetId: base });
    if (long.status !== 200) {
      expect(long.status).toBe(422);
      expect(long.body.code).toBe('does_not_fit');
      expect(long.body.errors[0].field).toBe('headline');
      expect(long.body.errors[0].message).toMatch(/too long.*Shorten/);
    }
    await owner.agent.post(`${url()}/preview`).send({ fields: { headline: 'Stale' }, baseAssetId: 'someone-elses-asset' }).expect(409);
    expect(paid()).toBe(calls);
  });

  it('SAVE: a new asset version with the exact preview bytes; results, asset file and ZIP (image, copy, manifest) show the edit; concurrent stale saves are refused', async () => {
    const calls = paid();
    const fields = { headline: 'Who makes the next decision?' };
    const preview = await postBinary(owner.agent, `${url()}/preview`, { fields, baseAssetId: base }).expect(200);
    const previewSha = sha(preview.body as Buffer);
    // two saves from the same starting point: exactly one wins, the other is told the creative changed
    const [a, b] = await Promise.all([owner.agent.put(url()).send({ fields, baseAssetId: base }), owner.agent.put(url()).send({ fields, baseAssetId: base })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const saved = (a.status === 200 ? a : b).body;
    expect(saved.assetId).not.toBe(base);
    expect(saved.edit).toMatchObject({ revision: 1, state: 'edited', originalAssetId: base });
    expect(saved.fields.find((f: any) => f.id === 'headline')).toMatchObject({ value: fields.headline });
    // the stored file is the previewed image
    const file = (await binary(owner.agent, saved.imageUrl).expect(200)).body as Buffer;
    expect(sha(file)).toBe(previewSha);
    const rows = await db.campaignAsset.findMany({ where: { campaignId, id: { in: [base, saved.assetId] } } });
    expect(rows.find((r) => r.id === base)!.status).toBe('superseded');
    const row = rows.find((r) => r.id === saved.assetId)!;
    expect(row).toMatchObject({ status: 'rendered', parentAssetId: base, sha256: previewSha });
    expect((row.metadataJson as any).renderSpec.content.headline).toBe(fields.headline);
    // the results page reads the package: the creative and its deliverable point at the new file; nothing else changed
    const camp = (await owner.agent.get(`/campaigns/${campaignId}`).expect(200)).body;
    const tc = camp.package.hybrid.creatives.find((c: any) => c.slotId === slotId);
    expect(tc.assetId).toBe(saved.assetId);
    expect(tc.edit.fields.headline).toBe(fields.headline);
    expect(camp.package.deliverables.items.find((i: any) => i.id === slotId).assetId).toBe(saved.assetId);
    for (const c of camp.package.hybrid.creatives.filter((x: any) => x.slotId !== slotId && assetsBefore.has(x.slotId))) expect(c.assetId).toBe(assetsBefore.get(c.slotId));
    // the ZIP: the edited image (exact bytes), its copy and the manifest
    const zip = await zipOf();
    const manifest = JSON.parse(await zip.file('campaign/manifest.json')!.async('string'));
    const entry = manifest.files.find((f: any) => f.assetId === saved.assetId);
    expect(entry).toBeDefined();
    expect(entry.sha256).toBe(previewSha);
    expect(sha(await zip.file(entry.path)!.async('nodebuffer'))).toBe(previewSha);
    expect(manifest.files.some((f: any) => f.assetId === base)).toBe(false);
    const texts = await Promise.all(Object.keys(zip.files).filter((p) => p.endsWith('.txt')).map((p) => zip.file(p)!.async('string')));
    expect(texts.some((t) => t.includes('edited by the owner') && t.includes(fields.headline))).toBe(true);
    const checks = JSON.parse(await zip.file('campaign/review/design-checks.json')!.async('string'));
    expect(checks.creatives.find((c: any) => c.slotId === slotId).repairs[0].detail).toMatch(/edited by the owner/);
    // the old base is stale now
    await owner.agent.put(url()).send({ fields, baseAssetId: base }).expect(409);
    expect(paid()).toBe(calls);
    base = saved.assetId;
  });

  it('a failed save (the file cannot be written) leaves the saved creative and package exactly as they were', async () => {
    const before = JSON.stringify(await pkgOf());
    const count = await db.campaignAsset.count({ where: { campaignId } });
    const storage = app.get(StorageDriver);
    const spy = jest.spyOn(storage, 'save').mockRejectedValueOnce(new Error('disk full'));
    await owner.agent.put(url()).send({ fields: { headline: 'This will not be saved' }, baseAssetId: base }).expect(500);
    spy.mockRestore();
    expect(JSON.stringify(await pkgOf())).toBe(before);
    expect(await db.campaignAsset.count({ where: { campaignId } })).toBe(count);
    expect((await owner.agent.get(`${url()}/editor`).expect(200)).body.assetId).toBe(base);
  });

  it('RESTORE ORIGINAL: the very file the run made, in the results and in the ZIP', async () => {
    const original = (await pkgOf()).hybrid.creatives.find((c: any) => c.slotId === slotId).edit.originalAssetId;
    const s = (await owner.agent.post(`${url()}/restore`).send({ baseAssetId: base }).expect(200)).body;
    expect(s.assetId).toBe(original);
    expect(s.edit).toMatchObject({ state: 'original', revision: 2 });
    for (const f of s.fields) expect(f.value).toBe(f.original);
    const zip = await zipOf();
    const manifest = JSON.parse(await zip.file('campaign/manifest.json')!.async('string'));
    const row = await db.campaignAsset.findUnique({ where: { id: original } });
    expect(manifest.files.find((f: any) => f.assetId === original).sha256).toBe(row!.sha256);
    await owner.agent.post(`${url()}/restore`).send({ baseAssetId: original }).expect(409); // nothing to restore
  });

  it('an OLDER creative without a render specification stays viewable and downloadable but cannot be edited', async () => {
    const pkg = await pkgOf();
    const otherSlot = pkg.hybrid.creatives.find((c: any) => c.slotId !== slotId && c.status === 'rendered' && c.assetId);
    // a creative as campaigns made before this feature store it (test data of this spec only)
    const row = await db.campaignAsset.findUnique({ where: { id: otherSlot.assetId } });
    const { renderSpec: _drop, ...meta } = row!.metadataJson as any;
    void _drop;
    await db.campaignAsset.update({ where: { id: row!.id }, data: { metadataJson: meta } });
    const s = (await owner.agent.get(`${url(otherSlot.slotId)}/editor`).expect(200)).body;
    expect(s.editable).toBe(false);
    expect(s.reason).toBe('This creative was generated before editing support and cannot be safely edited.');
    expect(s.fields).toEqual([]);
    const r = await owner.agent.post(`${url(otherSlot.slotId)}/preview`).send({ fields: { headline: 'x' }, baseAssetId: row!.id }).expect(422);
    expect(r.body.code).toBe('not_editable');
    await binary(owner.agent, `/campaigns/${campaignId}/assets/${row!.id}/file`).expect(200);
    const zip = await zipOf();
    expect(JSON.parse(await zip.file('campaign/manifest.json')!.async('string')).files.some((f: any) => f.assetId === row!.id)).toBe(true);
  });
});
