import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { enforceTelemetryPolicy } from './telemetry';

// Uses the REAL @mozaik-ai/cloud-sdk (the same createCloudClient() that Mozaik core calls inside
// runLoop). Only `fetch`, console output, cwd and the credentials-file path are controlled.
type Cloud = { createCloudClient: () => { enabled: boolean; send(e: unknown): void; end(): Promise<void> } };
const loadCloud = () => import('@mozaik-ai/cloud-sdk') as unknown as Promise<Cloud>;

const ENV_KEYS = ['MOZAIK_API_KEY', 'MOZAIK_PROJECT_KEY', 'MOZAIK_REDACTION', 'MOZAIK_CREDENTIALS_FILE', 'LAUNCHPILOT_MOZAIK_CLOUD'];

describe('Mozaik Cloud telemetry policy', () => {
  const cwd = process.cwd();
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  let dir: string;
  let calls: { url: string; auth: string; body: string }[];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), 'lp-telemetry-'));
    // A key in a `.env` in the working directory AND a paired-device credentials file: the two
    // "accidental" ways Mozaik Cloud gets enabled besides the process environment.
    writeFileSync(join(dir, '.env'), 'MOZAIK_API_KEY=pk_from_cwd_dotenv\n');
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ 'https://api.app.jigjoy.ai': { projectKey: 'pk_from_paired_file' } }),
    );
    process.env.MOZAIK_CREDENTIALS_FILE = join(dir, 'credentials.json');
    process.chdir(dir);
    calls = [];
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url: String(url), auth: init.headers.authorization, body: init.body });
      return { status: 202, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch;
    console.log = () => undefined;
    console.warn = () => undefined;
  });

  afterEach(() => {
    process.chdir(cwd);
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('CONTROL: without the policy, a cwd .env key enables telemetry and prompts are sent in full', async () => {
    const { createCloudClient } = await loadCloud();
    const client = createCloudClient();
    assert.equal(client.enabled, true);
    client.send({ type: 'model.answer', producerId: 'a', payload: { answer: 'CONFIDENTIAL BRIEF TEXT' } });
    await client.end();
    assert.ok(calls.length > 0);
    assert.equal(calls[0].auth, 'Bearer pk_from_cwd_dotenv');
    assert.ok(calls.map((c) => c.body).join('').includes('CONFIDENTIAL BRIEF TEXT'));
  });

  it('CONTROL: a paired-device credentials file alone also enables it', async () => {
    writeFileSync(join(dir, '.env'), '');
    const { createCloudClient } = await loadCloud();
    const client = createCloudClient();
    assert.equal(client.enabled, true);
    await client.end(); // flush now so its 1 s timer cannot fire during a later test
  });

  it('default policy disables telemetry even with a cwd .env key and a paired credentials file', async () => {
    assert.equal(enforceTelemetryPolicy(), 'disabled');
    const { createCloudClient } = await loadCloud();
    const client = createCloudClient();
    assert.equal(client.enabled, false);
    client.send({ type: 'model.answer', producerId: 'a', payload: { answer: 'CONFIDENTIAL BRIEF TEXT' } });
    await client.end();
    await new Promise((r) => setTimeout(r, 1300)); // longer than the SDK's 1 s flush interval
    assert.equal(calls.length, 0, 'no network request may be made');
  });

  it('default policy also disables it when only the paired credentials file exists', async () => {
    writeFileSync(join(dir, '.env'), '');
    enforceTelemetryPolicy();
    const { createCloudClient } = await loadCloud();
    assert.equal(createCloudClient().enabled, false);
  });

  it('overrides a key present in the process environment', async () => {
    process.env.MOZAIK_API_KEY = 'pk_from_process_env';
    enforceTelemetryPolicy();
    const { createCloudClient } = await loadCloud();
    assert.equal(createCloudClient().enabled, false);
  });

  it('operator opt-in re-enables it but defaults payload redaction to "all"', async () => {
    process.env.LAUNCHPILOT_MOZAIK_CLOUD = 'on';
    process.env.MOZAIK_API_KEY = 'pk_operator_key';
    assert.equal(enforceTelemetryPolicy(), 'enabled-by-operator');
    assert.equal(process.env.MOZAIK_REDACTION, 'all');
    const { createCloudClient } = await loadCloud();
    const client = createCloudClient();
    assert.equal(client.enabled, true);
    client.send({ type: 'model.answer', producerId: 'a', payload: { answer: 'CONFIDENTIAL BRIEF TEXT' } });
    await client.end();
    const sent = calls.map((c) => c.body).join('');
    assert.ok(sent.includes('model.answer'), 'event types are still sent');
    assert.ok(!sent.includes('CONFIDENTIAL BRIEF TEXT'), 'payload content is not');
  });

  it('operator opt-in keeps an explicitly chosen redaction level', () => {
    process.env.LAUNCHPILOT_MOZAIK_CLOUD = 'on';
    process.env.MOZAIK_REDACTION = 'content';
    enforceTelemetryPolicy();
    assert.equal(process.env.MOZAIK_REDACTION, 'content');
  });
});
