import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, registerUser, uniqueEmail } from './helpers';

// Regression guard for the pre-existing features (auth, project CRUD, uploads, isolation).
describe('Existing API regression', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(() => app.close());

  it('auth: register, me, login, logout, bad password', async () => {
    const email = uniqueEmail('auth');
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/register').send({ name: 'A B', email, password: 'password123' }).expect(201);
    expect((await agent.get('/auth/me').expect(200)).body.user.email).toBe(email);
    await agent.post('/auth/logout').expect(200);
    await agent.get('/auth/me').expect(401);
    await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    await agent.post('/auth/login').send({ email, password: 'password123' }).expect(200);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('projects: CRUD, intake, and isolation between users', async () => {
    const u1 = await registerUser(app, 'crud1');
    const u2 = await registerUser(app, 'crud2');
    const p = (await u1.agent.post('/projects').send({ name: 'My Product' }).expect(201)).body;
    await u1.agent.put(`/projects/${p.id}/intake`).send({ productName: 'My Product', websiteUrl: 'https://x.example.com' }).expect(200);
    expect((await u1.agent.get(`/projects/${p.id}`).expect(200)).body.intake.productName).toBe('My Product');
    await u1.agent.patch(`/projects/${p.id}`).send({ status: 'READY' }).expect(200);
    await u2.agent.get(`/projects/${p.id}`).expect(404);
    await u1.agent.delete(`/projects/${p.id}`).expect(200);
    await u1.agent.get(`/projects/${p.id}`).expect(404);
  });

  it('uploads: store, download through the authenticated endpoint, reject bad types, delete', async () => {
    const u = await registerUser(app, 'upload');
    const other = await registerUser(app, 'upload2');
    const p = (await u.agent.post('/projects').send({ name: 'Upload Test' }).expect(201)).body;
    const up = await u.agent.post(`/projects/${p.id}/assets`).attach('files', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' }).expect(201);
    const assetId = up.body[0].id;
    expect((await u.agent.get(`/assets/${assetId}/file`).expect(200)).text).toBe('hello');
    await other.agent.get(`/assets/${assetId}/file`).expect(404);
    await u.agent.post(`/projects/${p.id}/assets`).attach('files', Buffer.from('MZ'), { filename: 'a.exe', contentType: 'application/x-msdownload' }).expect(400);
    await u.agent.delete(`/assets/${assetId}`).expect(200);
  });
});
