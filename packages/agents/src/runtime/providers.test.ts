import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, safeErrorMessage } from '../factory/redact';
import { buildInferenceRunnerConfig } from './providers';
import { ParticipantRegistry } from './participant-registry';
import { PHASE_CONTRACTS, FACTORY_PHASES } from '../factory/phases';

describe('buildInferenceRunnerConfig', () => {
  it('returns no models without credentials (inference impossible)', () => {
    assert.deepEqual(buildInferenceRunnerConfig().supportedModels, []);
  });

  it('exposes only the chosen provider models and never touches process.env', () => {
    const before = { ...process.env };
    const openai = buildInferenceRunnerConfig({ provider: 'openai', apiKey: 'sk-aaaaaaaaaaaaaaaa' });
    const gemini = buildInferenceRunnerConfig({ provider: 'gemini', apiKey: 'AIzaBBBBBBBBBBBBBBBB' });
    assert.ok(openai.supportedModels!.length > 0);
    assert.ok(openai.supportedModels!.every((m) => m.specification.provider === 'openai'));
    assert.ok(gemini.supportedModels!.length > 0);
    assert.ok(gemini.supportedModels!.every((m) => m.specification.provider === 'google'));
    assert.deepEqual({ ...process.env }, before);
  });

  it('gives each run its own endpoint instances', () => {
    const a = buildInferenceRunnerConfig({ provider: 'openai', apiKey: 'sk-userAAAAAAAAAAAA' });
    const b = buildInferenceRunnerConfig({ provider: 'openai', apiKey: 'sk-userBBBBBBBBBBBB' });
    assert.notEqual(a.supportedModels![0].endpoint, b.supportedModels![0].endpoint);
  });

  it('rejects providers other than openai and gemini', () => {
    assert.throws(() => buildInferenceRunnerConfig({ provider: 'anthropic' as never, apiKey: 'x' }), /Unsupported AI provider/);
  });
});

describe('redact', () => {
  it('masks sensitive keys and credential-shaped strings, deeply', () => {
    const out = redact({
      apiKey: 'whatever',
      nested: { Authorization: 'Bearer abcdefghijklmnop', ok: 'fine', list: ['sk-abcdefghijklmnopqrstuv', 'AIzaSyABCDEFGHIJKLMNOP'] },
    });
    const s = JSON.stringify(out);
    assert.ok(!s.includes('whatever') && !s.includes('abcdefghijklmnop') && !s.includes('sk-abcdefghijklmnopqrstuv') && !s.includes('AIzaSy'));
    assert.equal((out.nested as { ok: string }).ok, 'fine');
  });
});

describe('redact keeps harmless token counters', () => {
  it('does not treat usage counters as secrets, but still masks real tokens', () => {
    const out = redact({ tokenUsage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, maxOutputTokens: 3500, access_token: 'abc', accessToken: 'abc', token: 'abc', authToken: 'abc' }) as Record<string, any>;
    assert.deepEqual(out.tokenUsage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    assert.equal(out.maxOutputTokens, 3500);
    for (const k of ['access_token', 'accessToken', 'token', 'authToken']) assert.equal(out[k], '[redacted]', k);
  });
});

describe('redact leaves ordinary hyphenated words alone', () => {
  it('does not mangle user text that merely contains "sk-"', () => {
    const text = 'A task-management and risk-assessment-platform for desk-booking teams, see https://a.example/disk-usage-report';
    assert.equal(redact(text), text);
    assert.equal(redact({ note: text }).note, text);
    assert.equal(redact('key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here'), 'key [redacted] here');
  });
});

describe('safeErrorMessage', () => {
  it('strips keys from error messages that get persisted and shown to users', () => {
    const msg = safeErrorMessage(new Error('401 Incorrect API key provided: sk-live-ABCDEFGHIJKLMNOP'));
    assert.ok(!msg.includes('ABCDEFGHIJKLMNOP'));
    assert.match(msg, /redacted/);
  });
});

describe('phase contracts and participant registry', () => {
  it('declares four ordered phases whose dependencies only point backwards', () => {
    assert.equal(FACTORY_PHASES.length, 4);
    for (const p of FACTORY_PHASES) {
      const c = PHASE_CONTRACTS[p];
      assert.ok(c.requires.every((r) => PHASE_CONTRACTS[r].order < c.order));
    }
  });

  it('registers participants per phase and rejects duplicates', () => {
    const registry = new ParticipantRegistry();
    const create = (() => {
      throw new Error('not called');
    }) as never;
    registry.register({ phase: 'F1_PRODUCT_DISCOVERY', name: 'a', create });
    assert.equal(registry.forPhase('F1_PRODUCT_DISCOVERY').length, 1);
    assert.equal(registry.forPhase('F2_MARKETING_AUDIT').length, 0);
    assert.throws(() => registry.register({ phase: 'F1_PRODUCT_DISCOVERY', name: 'a', create }), /already registered/);
  });
});
