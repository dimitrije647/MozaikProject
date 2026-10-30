import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MozaikService } from '../src/mozaik/mozaik.service';
import { createApp, registerUser } from './helpers';

// Cross-user BYOK isolation. Requires PostgreSQL (see global-setup.js).
describe('BYOK isolation between users', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const KEY_A = 'sk-userA-ISOLATION-1234567890abcdef';
  const KEY_B = 'sk-userB-ISOLATION-1234567890abcdef';

  beforeAll(async () => {
    app = await createApp();
    db = new PrismaClient();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('two users with the same provider each resolve only their own key', async () => {
    const a = await registerUser(app, 'iso-a');
    const b = await registerUser(app, 'iso-b');
    await a.agent.post('/integrations/configure-api-key').send({ providerKey: 'openai', apiKey: KEY_A, setAsDefault: true }).expect(200);
    await b.agent.post('/integrations/configure-api-key').send({ providerKey: 'openai', apiKey: KEY_B, setAsDefault: true }).expect(200);

    const svc = app.get(MozaikService);
    // Resolved concurrently, repeatedly: results must never cross users.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => svc.prepareInference(i % 2 === 0 ? a.id : b.id).then((c) => ({ i, c }))),
    );
    for (const { i, c } of results) expect(c.apiKey).toBe(i % 2 === 0 ? KEY_A : KEY_B);

    // At rest: two distinct ciphertexts, neither containing a plaintext key.
    const rows = await db.apiCredential.findMany({ where: { userId: { in: [a.id, b.id] } } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.encryptedKey)).size).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/ISOLATION-1234567890abcdef/);
  });

  it('over HTTP a user cannot see, default, remove or reuse another user\'s credentials', async () => {
    const owner = await registerUser(app, 'http-owner');
    const other = await registerUser(app, 'http-other');
    await owner.agent.post('/integrations/configure-api-key').send({ providerKey: 'gemini', apiKey: 'AIzaOWNERKEY1234567890abcdefghij', setAsDefault: true }).expect(200);

    // Listings contain only the caller's data, and never a raw key.
    expect((await other.agent.get('/api-credentials').expect(200)).body).toEqual([]);
    const mine = (await owner.agent.get('/api-credentials').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain('AIzaOWNERKEY');
    expect(Object.keys(mine[0])).not.toContain('encryptedKey');
    const integrations = (await other.agent.get('/integrations/me').expect(200)).body;
    expect(integrations.integrations).toEqual([]);
    expect(integrations.defaultAiProvider).toBeNull();

    // Mutations by the other user cannot touch the owner's key.
    await other.agent.put('/api-credentials/default').send({ providerKey: 'gemini' }).expect(404);
    await other.agent.delete('/api-credentials/gemini').expect(200); // scoped to the caller: deletes nothing of the owner's
    expect((await owner.agent.get('/api-credentials').expect(200)).body).toHaveLength(1);

    // Their runs never consult credentials, and resolving for them yields nothing.
    await expect(app.get(MozaikService).prepareInference(other.id)).rejects.toThrow(/API key/);
  });
});
