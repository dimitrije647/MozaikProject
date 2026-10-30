import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MozaikCampaignRuntime, RuntimeInitError, type CampaignRunInput } from './campaign-runtime';
import type { RecordedEvent } from '../factory/state';

function input(overrides: Partial<CampaignRunInput> = {}) {
  const events: RecordedEvent[] = [];
  const base: CampaignRunInput = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    projectId: 'p1',
    userId: 'u1',
    mode: 'smoke_test',
    manifest: { productName: 'Test' },
    onEvent: (e) => void events.push(e),
    ...overrides,
  };
  return { input: base, events };
}

const types = (events: RecordedEvent[]) => events.map((e) => e.type);

describe('MozaikCampaignRuntime (real Mozaik runtime)', () => {
  it('completes the event round-trip: factory.started -> test.acknowledged -> factory.completed', async () => {
    const runtime = new MozaikCampaignRuntime();
    const { input: i, events } = input();
    const handle = await runtime.startRun(i);
    const result = await handle.done;

    assert.equal(result.status, 'completed');
    const t = types(events);
    // Mozaik's own participant.joined events prove real runtime traffic.
    assert.equal(t.filter((x) => x === 'participant.joined').length, 3);
    assert.ok(t.indexOf('factory.started') < t.indexOf('test.acknowledged'));
    assert.ok(t.indexOf('test.acknowledged') < t.indexOf('factory.completed'));
    assert.equal(t[t.length - 1], 'factory.completed', 'terminal event is last; nothing recorded after close');
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, idx) => idx + 1));

    const ack = events.find((e) => e.type === 'test.acknowledged')!;
    assert.equal(ack.participant, 'Smoke Test Participant');
    const done = events.find((e) => e.type === 'factory.completed')!;
    assert.deepEqual((done.payload as { phasesCompleted: unknown[] }).phasesCompleted, []);
    assert.equal(runtime.activeCount, 0, 'run released from memory');
  });

  it('works with no credentials and makes inference impossible by construction', async () => {
    const runtime = new MozaikCampaignRuntime();
    const { input: i } = input();
    const handle = await runtime.startRun(i);
    assert.equal((await handle.done).status, 'completed');
  });

  it('reports running while waiting and supports cancellation without late events', async () => {
    const runtime = new MozaikCampaignRuntime();
    const { input: i, events } = input({ options: { delayMs: 400 } });
    const handle = await runtime.startRun(i);
    assert.equal(handle.status(), 'running');
    assert.equal(await runtime.getRunStatus(i.runId), 'running');

    const result = await handle.cancel();
    assert.equal(result.status, 'cancelled');
    const countAtCancel = events.length;
    await new Promise((r) => setTimeout(r, 600)); // would have acknowledged by now if the timer leaked
    assert.equal(events.length, countAtCancel);
    assert.ok(!types(events).includes('test.acknowledged'));
    assert.equal(types(events).at(-1), 'factory.cancelled');
    assert.equal(await runtime.getRunStatus(i.runId), null);
  });

  it('turns a participant exception into factory.failed', async () => {
    const runtime = new MozaikCampaignRuntime();
    const { input: i, events } = input({ options: { behavior: 'fail' } });
    const result = await (await runtime.startRun(i)).done;
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage ?? '', /Injected participant failure/);
    const failed = events.find((e) => e.type === 'factory.failed')!;
    assert.equal((failed.payload as { participant: string }).participant, 'Smoke Test Participant');
  });

  it('times out a run whose participant never answers', async () => {
    const runtime = new MozaikCampaignRuntime();
    const { input: i, events } = input({ options: { behavior: 'silent', timeoutMs: 150 } });
    const result = await (await runtime.startRun(i)).done;
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage ?? '', /timed out/);
    assert.equal((events.find((e) => e.type === 'factory.failed')!.payload as { reason: string }).reason, 'timeout');
  });

  it('shutdown marks active runs as interrupted', async () => {
    const runtime = new MozaikCampaignRuntime();
    const a = input({ options: { delayMs: 5000 } });
    const b = input({ options: { delayMs: 5000 } });
    const ha = await runtime.startRun(a.input);
    const hb = await runtime.startRun(b.input);
    await runtime.shutdown();
    assert.equal((await ha.done).status, 'interrupted');
    assert.equal((await hb.done).status, 'interrupted');
    assert.equal(runtime.activeCount, 0);
  });

  it('isolates concurrent runs: events never cross runs', async () => {
    const runtime = new MozaikCampaignRuntime();
    const runs = Array.from({ length: 6 }, () => input({ options: { delayMs: Math.floor(Math.random() * 50) } }));
    const handles = await Promise.all(runs.map((r) => runtime.startRun(r.input)));
    const results = await Promise.all(handles.map((h) => h.done));
    assert.ok(results.every((r) => r.status === 'completed'));
    for (const r of runs) {
      assert.ok(r.events.every((e) => e.runId === r.input.runId));
      assert.equal(types(r.events).filter((t) => t === 'factory.completed').length, 1);
    }
    // Participant ids are per run: manifest ids in joined events must not repeat across runs.
    const ids = runs.flatMap((r) =>
      r.events.filter((e) => e.type === 'participant.joined').map((e) => (e.payload as { id: string }).id),
    );
    assert.equal(new Set(ids).size, ids.length);
  });

  it('credentials passed to startRun never appear in events, results or retained run state', async () => {
    const runtime = new MozaikCampaignRuntime();
    const KEY_A = 'sk-userA-CANARY-1234567890abcdef';
    const KEY_B = 'AIzaUserB-CANARY-1234567890abcdef';
    const a = input({ options: { delayMs: 40 } });
    const b = input({ options: { delayMs: 40 } });
    const [ha, hb] = await Promise.all([
      runtime.startRun({ ...a.input, credentials: { provider: 'openai', apiKey: KEY_A } }),
      runtime.startRun({ ...b.input, credentials: { provider: 'gemini', apiKey: KEY_B } }),
    ]);
    // White-box: the run object must not keep the credentials it was started with.
    for (const id of [a.input.runId, b.input.runId]) {
      const run = (runtime as unknown as { active: Map<string, { input: object; state: object }> }).active.get(id)!;
      assert.ok(!('credentials' in run.input));
      const retained = JSON.stringify({ input: run.input, state: run.state });
      assert.ok(!retained.includes(KEY_A) && !retained.includes(KEY_B));
    }
    const results = await Promise.all([ha.done, hb.done]);
    assert.ok(results.every((r) => r.status === 'completed'));
    const everything = JSON.stringify([a.events, b.events, results]);
    assert.ok(!everything.includes(KEY_A) && !everything.includes(KEY_B));
  });

  it('releases every timer, participant and map entry after completed, failed, timed-out, cancelled and interrupted runs', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const baseline = timers();
    const runtime = new MozaikCampaignRuntime();
    const states: { getParticipants(): readonly unknown[] }[] = [];
    const track = (id: string) =>
      states.push((runtime as unknown as { active: Map<string, { state: (typeof states)[number] }> }).active.get(id)!.state);

    const kinds: Array<[Parameters<typeof input>[0], string]> = [
      [{ options: { delayMs: 20 } }, 'completed'],
      [{ options: { behavior: 'fail' } }, 'failed'],
      [{ options: { behavior: 'silent', timeoutMs: 80 } }, 'failed'],
      [{ options: { delayMs: 5000 } }, 'cancelled'],
      [{ options: { delayMs: 5000 } }, 'interrupted'],
    ];
    for (let round = 0; round < 6; round++) {
      for (const [opts, expected] of kinds) {
        const { input: i } = input(opts);
        const handle = await runtime.startRun(i);
        if (await runtime.getRunStatus(i.runId)) track(i.runId);
        if (expected === 'cancelled') await handle.cancel();
        if (expected === 'interrupted') await handle.cancel('server_shutdown');
        assert.equal((await handle.done).status, expected);
      }
    }
    assert.equal(runtime.activeCount, 0, 'no run left in the active map');
    assert.ok(states.length > 0 && states.every((s) => s.getParticipants().length === 0), 'all participants left the runtime');
    assert.ok(timers() <= baseline, `timers leaked: ${timers()} > baseline ${baseline}`);
  });

  it('rejects duplicate run ids and unimplemented modes with RuntimeInitError', async () => {
    const runtime = new MozaikCampaignRuntime();
    const a = input({ options: { delayMs: 200 } });
    const h = await runtime.startRun(a.input);
    await assert.rejects(() => runtime.startRun(a.input), RuntimeInitError);
    await assert.rejects(() => runtime.startRun({ ...a.input, runId: 'x', mode: 'campaign' as never }), RuntimeInitError);
    await h.cancel();
  });
});
