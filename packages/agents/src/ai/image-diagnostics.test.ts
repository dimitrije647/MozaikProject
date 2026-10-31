import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { classifyHttpError, sanitizeProviderText, toSafeErrorFrom } from './errors';
import { imageModelProblem, pickImageModel, retiredImageModel } from './image-models';
import { brandGradient } from '../creative/layout';
import { completeImageResults, distinctReasons, explainImageFailure, reconstructImageResults } from '../creative/image-results';
import { CampaignPackage, ImageResultRecord } from '../creative/schemas';

// Image-generation diagnostics: what OpenAI says is kept (sanitized), what is known about retired models is applied,
// and every explanation is built from facts. No network, nothing is billed.

const KEY = 'sk-proj-AbCdEf1234567890abcdefGHIJKL';
const AFTER_SHUTDOWN = new Date('2026-10-31T00:00:00Z');
const BEFORE_SHUTDOWN = new Date('2026-06-15T00:00:00Z');

describe('provider diagnostics', () => {
  it('keeps status, code, type, param and a sanitized message of a failed request', () => {
    const e = toSafeErrorFrom(classifyHttpError(400, { error: { code: 'invalid_value', type: 'invalid_request_error', param: 'quality', message: `Invalid value for quality. Key ${KEY} and Bearer abc.DEF-123 were sent.` } }));
    assert.equal(e.code, 'bad_request');
    assert.equal(e.status, 400);
    assert.equal(e.providerCode, 'invalid_value');
    assert.equal(e.providerParam, 'quality');
    assert.match(e.providerMessage ?? '', /Invalid value for quality/);
    assert.doesNotMatch(JSON.stringify(e), /sk-proj|Bearer abc/);
  });

  it('never keeps the text of an authentication failure (it echoes parts of the key)', () => {
    const e = toSafeErrorFrom(classifyHttpError(401, { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` } }));
    assert.equal(e.code, 'invalid_api_key');
    assert.equal(e.providerMessage, undefined);
    assert.doesNotMatch(JSON.stringify(e), /sk-proj|Incorrect API key/);
  });

  it('a 403 keeps the verification reason; a 404 keeps model_not_found; both stay safe', () => {
    const e403 = toSafeErrorFrom(classifyHttpError(403, { error: { code: 'organization_not_verified', message: 'Your organization must be verified.' } }));
    assert.equal(e403.code, 'permission_denied');
    assert.equal(e403.providerCode, 'organization_not_verified');
    const e404 = toSafeErrorFrom(classifyHttpError(404, { error: { code: 'model_not_found', message: 'The model does not exist' } }));
    assert.equal(e404.code, 'model_unavailable');
    assert.equal(e404.providerCode, 'model_not_found');
  });

  it('sanitizeProviderText redacts keys, bearer tokens and session ids and bounds the length', () => {
    const t = sanitizeProviderText(`  a   key ${KEY}\n and sess-ABCDEFGHIJKLMNOP1234 and Bearer tok.en-1 ${'x'.repeat(500)}`, 100);
    assert.ok(t && t.length <= 100);
    assert.doesNotMatch(t!, /sk-proj|sess-ABC|tok\.en/);
    assert.equal(sanitizeProviderText(undefined), null);
    assert.equal(sanitizeProviderText('   '), null);
  });
});

describe('image model lifecycle', () => {
  it('gpt-image-1 is retired from 2026-10-23, not before; dall-e models earlier', () => {
    assert.ok(retiredImageModel('gpt-image-1', AFTER_SHUTDOWN));
    assert.equal(retiredImageModel('gpt-image-1', BEFORE_SHUTDOWN), null);
    assert.ok(retiredImageModel('dall-e-3', AFTER_SHUTDOWN));
    assert.equal(retiredImageModel('gpt-image-2.5-flare', AFTER_SHUTDOWN), null);
  });

  it('imageModelProblem names the shutdown date and the replacements; a text model is rejected', () => {
    assert.match(imageModelProblem('gpt-image-1', AFTER_SHUTDOWN) ?? '', /shut down gpt-image-1 on 2026-10-23.*gpt-image-2\.5-sunburst/);
    assert.equal(imageModelProblem('gpt-image-1', BEFORE_SHUTDOWN), null);
    assert.match(imageModelProblem('gpt-4.1-mini', AFTER_SHUTDOWN) ?? '', /Only GPT Image models/);
  });

  it('the automatic choice skips retired models and dated snapshots, and follows the preference order', () => {
    const listed = ['gpt-4.1-mini', 'gpt-image-1', 'gpt-image-1-2025-04-15', 'dall-e-3', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];
    assert.equal(pickImageModel(listed, AFTER_SHUTDOWN), 'gpt-image-2.5-flare');
    assert.equal(pickImageModel([...listed, 'gpt-image-1-mini'], AFTER_SHUTDOWN), 'gpt-image-1-mini');
    assert.equal(pickImageModel(['gpt-image-1', 'dall-e-3', 'gpt-4.1-mini'], AFTER_SHUTDOWN), null, 'only retired models are listed: nothing is chosen');
    assert.equal(pickImageModel(['gpt-image-1'], BEFORE_SHUTDOWN), 'gpt-image-1', 'before the shutdown it was a valid choice');
  });
});

describe('failure explanations', () => {
  const err = (status: number, error: Record<string, unknown>) => toSafeErrorFrom(classifyHttpError(status, { error }));

  it('a rejection of a retired model says it was shut down, names replacements and does not blame the settings', () => {
    const x = explainImageFailure('gpt-image-1', err(400, { code: 'invalid_request', message: 'bad' }), AFTER_SHUTDOWN);
    assert.equal(x.stage, 'provider');
    assert.match(x.explanation, /shut down gpt-image-1 on 2026-10-23/);
    assert.match(x.explanation, /still appear in your model list/);
  });

  it('403 points at organization verification and project permission', () => {
    const x = explainImageFailure('gpt-image-2.5-flare', err(403, { code: 'organization_not_verified', message: 'must be verified' }), AFTER_SHUTDOWN);
    assert.match(x.explanation, /verification|permission/);
    assert.match(x.explanation, /must be verified/);
  });

  it('a generic 400 shows the status, code, parameter and provider message', () => {
    const x = explainImageFailure('gpt-image-2.5-flare', err(400, { code: 'invalid_value', param: 'size', message: 'Unsupported size' }), AFTER_SHUTDOWN);
    assert.match(x.explanation, /HTTP 400.*code invalid_value.*parameter size/);
    assert.match(x.explanation, /Unsupported size/);
  });

  it('an invalid response is a decoding failure', () => {
    const x = explainImageFailure('m', { code: 'invalid_response', message: 'x' }, AFTER_SHUTDOWN);
    assert.equal(x.stage, 'decoding');
    assert.match(x.explanation, /invalid response/);
  });

  it('completeImageResults gives every concept a result: no model selected, or the picture plan failed', () => {
    const concepts = [{ id: 'K1', name: 'A' }, { id: 'K2', name: 'B' }];
    const none = completeImageResults({ concepts, results: [], baseAssetOf: () => null, imageGeneration: false, model: null, planningError: null });
    assert.ok(none.every((r) => r.outcome === 'skipped' && r.stage === 'configuration' && !r.requestAttempted));
    const failed = completeImageResults({ concepts, results: [], baseAssetOf: (id) => `base-${id}`, imageGeneration: true, model: 'm', planningError: 'timeout' });
    assert.ok(failed.every((r) => r.outcome === 'failed' && r.stage === 'planning' && !r.requestAttempted && /timeout/.test(r.explanation ?? '')));
    assert.equal(failed[0].assetId, 'base-K1');
    const kept = completeImageResults({ concepts, results: [{ ...failed[0], outcome: 'generated', stage: null }], baseAssetOf: () => null, imageGeneration: true, model: 'm', planningError: null });
    assert.equal(kept[0].outcome, 'generated');
    assert.equal(kept[1].stage, 'planning');
  });
});

describe('brand-colored fallbacks and stored packages', () => {
  it('the first six concepts get six different brand-colored backgrounds', async () => {
    const palette = ['#0b3a53', '#e8a33d'];
    const raws = await Promise.all([0, 1, 2, 3, 4, 5].map(async (v) => (await sharp(await brandGradient(64, palette, v)).raw().toBuffer()).toString('base64')));
    assert.equal(new Set(raws).size, 6);
  });

  it('a result record rejects unknown stages; an older package without imageResults still parses with an empty list', () => {
    assert.throws(() => ImageResultRecord.parse({ conceptId: 'K1', conceptName: 'A', model: null, requestAttempted: false, outcome: 'failed', stage: 'nonsense', errorCode: null, providerStatus: null, providerCode: null, message: null, explanation: null, fallbackUsed: true, assetId: '' }));
    const shape = CampaignPackage.shape.imageResults;
    assert.deepEqual(shape.parse(undefined), []);
  });
});

describe('campaigns saved before per-concept results existed', () => {
  const concepts = [{ id: 'K1', name: 'Pogled koji se pamti' }, { id: 'K2', name: 'Ukusi domace kuhinje' }, { id: 'K3', name: 'Nocne zurke' }];
  const gradient = (id: string, conceptId: string) => ({ id, conceptId, kind: 'image', source: 'brand_gradient', status: 'rendered', model: null });

  it('derives the reason from the recorded failure and the shutdown date, and flags every record as reconstructed', () => {
    const out = reconstructImageResults({
      concepts,
      assets: [gradient('a1', 'K1'), gradient('a2', 'K2'), gradient('a3', 'K3')],
      visualEvents: concepts.map((c) => ({ conceptId: c.id, failed: true, error: { code: 'bad_request', message: 'The request was not accepted by the AI provider.' } })),
      imageModel: 'gpt-image-1',
      at: AFTER_SHUTDOWN,
    });
    assert.equal(out.length, 3);
    for (const r of out) {
      assert.equal(r.reconstructed, true);
      assert.equal(r.outcome, 'failed');
      assert.equal(r.requestAttempted, true);
      assert.equal(r.fallbackUsed, true);
      assert.match(r.explanation ?? '', /shut down gpt-image-1 on 2026-10-23/);
    }
    assert.deepEqual(out.map((r) => r.assetId), ['a1', 'a2', 'a3']);
  });

  it('does not claim a shutdown for a campaign made before it; AI images stay generated; a gradient without any event is a skipped concept', () => {
    const before = reconstructImageResults({ concepts: concepts.slice(0, 1), assets: [gradient('a1', 'K1')], visualEvents: [{ conceptId: 'K1', failed: true, error: { code: 'bad_request', message: '' } }], imageModel: 'gpt-image-1', at: BEFORE_SHUTDOWN });
    assert.doesNotMatch(before[0].explanation ?? '', /shut down/);
    const mixed = reconstructImageResults({
      concepts: concepts.slice(0, 2),
      assets: [{ id: 'ai1', conceptId: 'K1', kind: 'image', source: 'ai_image', status: 'generated', model: 'gpt-image-1-mini' }, gradient('g2', 'K2')],
      visualEvents: [{ conceptId: 'K1', failed: false }],
      imageModel: 'gpt-image-1-mini',
      at: AFTER_SHUTDOWN,
    });
    assert.equal(mixed[0].outcome, 'generated');
    assert.equal(mixed[0].fallbackUsed, false);
    assert.equal(mixed[1].outcome, 'skipped');
    assert.equal(mixed[1].requestAttempted, false);
    assert.equal(mixed[1].stage, 'budget');
  });
});

describe('distinctReasons', () => {
  const r = (outcome: string, requestAttempted: boolean, explanation: string | null) => ({ outcome, requestAttempted, explanation });
  it('lists a real failure once and drops the "Not attempted" echoes of it', () => {
    const out = distinctReasons([r('failed', true, 'OpenAI refused (HTTP 403).'), r('failed', true, 'OpenAI refused (HTTP 403).'), r('failed', false, 'Not attempted: an earlier image request already failed. OpenAI refused (HTTP 403).'), r('generated', true, null)]);
    assert.deepEqual(out, ['OpenAI refused (HTTP 403).']);
  });
  it('keeps a budget skip next to a real failure, and falls back to the echoes only when nothing else explains', () => {
    assert.deepEqual(distinctReasons([r('failed', true, 'A'), r('skipped', false, 'Image generation was skipped because the configured maximum is 1 image for 3 concepts.')]), ['A', 'Image generation was skipped because the configured maximum is 1 image for 3 concepts.']);
    assert.deepEqual(distinctReasons([r('failed', false, 'Not attempted: x')]), ['Not attempted: x']);
    assert.deepEqual(distinctReasons([r('generated', true, null)]), []);
  });
});
