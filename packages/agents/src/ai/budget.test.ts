import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SPEND_PRIORITY, SpendBudget, scopeFor } from './budget';

// The campaign budget: ONE ledger in US dollars shared by every paid request (text, images, reviews, repairs). No text and image pools.

const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} !== ${b}`);

describe('one shared campaign budget', () => {
  it('text and images draw on the same total: whatever text used is no longer available for images', () => {
    const b = new SpendBudget(3);
    const text = b.tryReserve('text', 1.3)!;
    assert.ok(text);
    b.settle(text, 1.25);
    near(b.snapshot().remainingUsd, 1.75);
    assert.ok(b.tryReserve('image', 1.7), 'the images may use everything the text left');
    assert.equal(b.tryReserve('image', 0.1), null, 'and nothing more: 1.25 + 1.70 + 0.10 > 3.00');
    assert.equal(b.snapshot().blocked, 1);
  });

  it('unused money is never locked away: cheap text leaves the rest for the images (no fixed 2 + 1 split)', () => {
    const b = new SpendBudget(3);
    const t = b.tryReserve('text', 0.5)!;
    b.settle(t, 0.13); // the text cost far less than its reservation
    assert.ok(b.tryReserve('image', 2.8), 'a "$1 image pool" would have refused this');
    near(b.snapshot().knownUsd, 0.13);
    near(b.snapshot().reservedUsd, 2.8);
  });

  it('a reservation is held before the call, replaced by the reported cost afterwards, and the unused part returns', () => {
    const b = new SpendBudget(1);
    const r = b.tryReserve('text', 0.4)!;
    near(b.snapshot().reservedUsd, 0.4);
    near(b.snapshot().remainingUsd, 0.6);
    b.settle(r, 0.1);
    const s = b.snapshot();
    near(s.reservedUsd, 0);
    near(s.knownUsd, 0.1);
    near(s.remainingUsd, 0.9, 1e-9);
    assert.equal(s.remainingBasis, 'exact');
  });

  it('a rejected request (HTTP error, rate limit) is released: nothing was billed, nothing is leaked', () => {
    const b = new SpendBudget(1);
    const r = b.tryReserve('image', 0.9)!;
    assert.equal(b.tryReserve('image', 0.2), null);
    b.release(r);
    near(b.snapshot().remainingUsd, 1);
    assert.ok(b.tryReserve('image', 0.9));
  });

  it('a timeout or cancel after sending keeps the reservation as UNCERTAIN spend; the remaining figure says it is estimated', () => {
    const b = new SpendBudget(1);
    const r = b.tryReserve('text', 0.3)!;
    b.markUncertain(r);
    const s = b.snapshot();
    near(s.uncertainUsd, 0.3);
    near(s.reservedUsd, 0);
    near(s.remainingUsd, 0.7);
    assert.equal(s.remainingBasis, 'estimated');
    assert.equal(b.tryReserve('text', 0.75), null, 'an uncertain charge is never counted as zero');
  });

  it('finalize(): whatever is still in flight when the run ends may have been billed, so it becomes uncertain (no leaked reservation)', () => {
    const b = new SpendBudget(2);
    b.tryReserve('text', 0.4);
    b.tryReserve('image', 0.5);
    b.finalize();
    const s = b.snapshot();
    near(s.reservedUsd, 0);
    near(s.uncertainUsd, 0.9);
    near(s.committedUsd, 0.9);
    assert.equal(b.tryReserve('text', 0.01), null, 'a finished run starts nothing');
  });

  it('a finished request without reported usage keeps its reservation as an ESTIMATED cost; one of unknown price is recorded as unknown, not as 0', () => {
    const b = new SpendBudget(2);
    const priced = b.tryReserve('text', 0.2)!;
    b.settle(priced, null);
    const unpriced = b.tryReserve('image', null)!;
    assert.ok(unpriced.priced === false);
    b.settle(unpriced, null);
    const s = b.snapshot();
    near(s.estimatedUsd, 0.2);
    near(s.knownUsd, 0);
    assert.equal(s.unpriced, 1);
    assert.equal(s.unknownCostRequests, 1);
    assert.equal(s.remainingBasis, 'unknown', 'the remaining budget cannot be shown as an exact figure');
    near(s.remainingUsd, 1.8);
  });

  it('a request of unknown price is never started when nothing is left; the image-request cap always applies', () => {
    const b = new SpendBudget(1, { maxImageRequests: 2 });
    const a = b.tryReserve('text', 1)!;
    b.settle(a, 1);
    assert.equal(b.tryReserve('image', null), null, 'nothing is left: an unknown price cannot be assumed to fit');
    assert.equal(b.lastRefusal()?.reason, 'nothing_left');
    const c = new SpendBudget(5, { maxImageRequests: 2 });
    assert.ok(c.tryReserve('image', null));
    assert.ok(c.tryReserve('image', null));
    assert.equal(c.tryReserve('image', null), null, 'the third image request exceeds the approved maximum');
    assert.equal(c.lastRefusal()?.reason, 'image_request_cap');
    assert.equal(c.snapshot().requests.image, 2);
    assert.equal(c.snapshot().requests.imageCap, 2);
  });

  it('without an approved amount nothing is capped (usage is only measured)', () => {
    const b = new SpendBudget(null);
    assert.ok(b.tryReserve('image', 999));
    assert.equal(b.snapshot().remainingBasis, 'uncapped');
    assert.equal(b.snapshot().remainingUsd, null);
  });
});

describe('concurrency: reservations are atomic and campaign-wide', () => {
  it('many concurrent workers cannot reserve the same money: exactly floor(budget / cost) succeed', async () => {
    const b = new SpendBudget(1);
    const granted: number[] = [];
    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i % 5)); // interleave like real workers
        const r = b.tryReserve(i % 2 ? 'text' : 'image', 0.3);
        if (r) {
          granted.push(r.id);
          await new Promise((res) => setTimeout(res, 1));
          b.settle(r, 0.3);
        }
      }),
    );
    assert.equal(granted.length, 3);
    near(b.snapshot().knownUsd, 0.9);
    assert.equal(b.snapshot().blocked, 37);
    assert.ok(b.snapshot().committedUsd <= 1 + 1e-9);
  });

  it('phases share ONE ledger: what F1 spent is gone for F4, and each phase reports its own figures', () => {
    const ledger = new SpendBudget(3);
    const f1 = ledger.scope('F1');
    const f4 = ledger.scope('F4');
    const a = f1.tryReserve('text', 0.6)!;
    f1.settle(a, 0.5);
    const b = f4.tryReserve('image', 2.0)!;
    f4.settle(b, 1.9);
    near(f1.snapshot().knownUsd, 0.5);
    near(f4.snapshot().knownUsd, 1.9);
    near(ledger.snapshot().knownUsd, 2.4);
    near(f4.snapshot().remainingUsd, 0.6); // the campaign's remaining, seen from any phase
    assert.equal(f4.tryReserve('image', 0.7), null);
    assert.equal(scopeFor(ledger, 99, 'F2').approvedUsd, 3, 'a passed ledger wins over a per-run cap');
    assert.equal(scopeFor(null, 4, 'F2').approvedUsd, 4, 'a run without a campaign ledger gets one with its own cap');
  });
});

describe('deferral: a request waits for in-flight reservations to settle instead of being refused for good', () => {
  it('it does not fit only because another request holds its worst case: it waits, then fits when that one settles for less', async () => {
    const b = new SpendBudget(1);
    const first = b.tryReserve('image', 0.6)!;
    assert.equal(b.snapshot().blocked, 0);
    let fitted = false;
    const waiting = b.awaitRoom('image', 0.5).then(() => (fitted = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fitted, false, 'still waiting: 0.6 + 0.5 > 1.0 while the first is held');
    b.settle(first, 0.3); // the provider reported far less than the reservation
    await waiting;
    assert.ok(b.tryReserve('image', 0.5), '0.3 + 0.5 <= 1.0');
    assert.equal(b.snapshot().blocked, 0, 'waiting is not a refusal');
  });

  it('when nothing is in flight nothing can free money: it returns at once and the next reservation is refused for good', async () => {
    const b = new SpendBudget(1);
    const a = b.tryReserve('text', 0.9)!;
    b.settle(a, 0.9);
    await b.awaitRoom('text', 0.5); // returns immediately: no reservation is open
    assert.equal(b.tryReserve('text', 0.5), null);
    assert.equal(b.snapshot().blocked, 1);
  });

  it('it stops waiting when the run is cancelled (no stuck request) and when the held request becomes uncertain', async () => {
    const b = new SpendBudget(1);
    const held = b.tryReserve('image', 0.9)!;
    const ac = new AbortController();
    const waiting = b.awaitRoom('image', 0.5, {}, ac.signal);
    ac.abort();
    await waiting; // resolved by the abort
    const second = b.awaitRoom('image', 0.5);
    b.markUncertain(held); // still counted as spent, but no longer "in flight": the waiter is woken and the next reserve refuses
    await second;
    assert.equal(b.tryReserve('image', 0.5), null);
  });
});

describe('priorities: required work is protected without fixed pools', () => {
  const plan = () => {
    const b = new SpendBudget(3, { maxImageRequests: 5 });
    b.setPlan({
      phases: [
        { label: 'F1', order: 1, projectedUsd: 0.2 },
        { label: 'F2', order: 2, projectedUsd: 0.2 },
        { label: 'F3', order: 3, projectedUsd: 0.3 },
        { label: 'F4', order: 4, projectedUsd: 0.4 },
      ],
      images: { remaining: 5, unitUsd: 0.25, basis: 'published' },
    });
    return b;
  };

  it('an early optional call cannot use the money the required analysis and the required images still need', () => {
    const b = plan(); // required: 0.2 + 0.2 + 0.3 + 0.4 + 5 x 0.25 = 2.35
    const f1 = b.scope('F1');
    // 0.60 left over: a quality check of 0.5 fits, one of 0.7 would eat into mandatory work
    assert.ok(f1.tryReserve('text', 0.5, { priority: SPEND_PRIORITY.quality }), 'fits above the protected 2.35 (committed 0 + 0.5 + 2.35 <= 3)');
    assert.equal(f1.tryReserve('text', 0.2, { priority: SPEND_PRIORITY.quality }), null, '0.5 + 0.2 + 2.35 > 3');
    assert.equal(b.lastRefusal()?.reason, 'protected_for_required_work');
    near(b.lastRefusal()?.protectedUsd ?? 0, 2.35 - 0 /* F1's own 0.2 is part of it */, 1e-6);
    assert.equal(b.snapshot().deferred, 1);
    assert.equal(b.snapshot().blocked, 0);
  });

  it('essential analysis OUTRANKS the images: it is held back only for the essential analysis of the later phases, never for the images', () => {
    const b = plan();
    const f1 = b.scope('F1');
    // protected for a priority-1 call in F1: F2 0.2 + F3 0.3 + F4 0.4 = 0.9 (the images are not part of it); 3 - 0.9 may be spent now
    assert.ok(f1.tryReserve('text', 2.1, { priority: SPEND_PRIORITY.essential }));
    assert.equal(f1.tryReserve('text', 0.05, { priority: SPEND_PRIORITY.essential }), null);
    assert.equal(b.lastRefusal()?.reason, 'protected_for_required_work');
    near(b.lastRefusal()?.protectedUsd ?? 0, 0.9);
  });

  it('required images are protected from earlier optional text, yet may use everything the earlier phases left', () => {
    const b = plan();
    for (const [phase, usd] of [['F1', 0.05], ['F2', 0.05], ['F3', 0.1]] as const) {
      const s = b.scope(phase);
      const r = s.tryReserve('text', 0.3, { priority: 1 })!;
      s.settle(r, usd);
      b.phaseDone(phase);
    }
    // the text phases cost 0.2 of the projected 0.7: the unused 0.5 is simply available again
    const f4 = b.scope('F4');
    assert.ok(f4.tryReserve('text', 0.4, { priority: 1 }));
    const spent = b.snapshot();
    near(spent.reservedUsd, 0.4);
    for (let i = 0; i < 5; i++) assert.ok(f4.tryReserve('image', 0.25, { priority: SPEND_PRIORITY.images }), `image ${i + 1}`);
    assert.equal(f4.tryReserve('image', 0.25, { priority: SPEND_PRIORITY.images }), null, 'the sixth image exceeds the approved maximum of 5');
  });

  it('a quality check is refused before an image would be (when money gets short), never the other way round', () => {
    const b = new SpendBudget(1.0);
    b.setPlan({ phases: [{ label: 'F4', order: 1, projectedUsd: 0 }], images: { remaining: 3, unitUsd: 0.3, basis: 'published' } }); // 0.9 protected
    const f4 = b.scope('F4');
    assert.equal(f4.tryReserve('text', 0.2, { priority: SPEND_PRIORITY.quality }), null, '0.2 + 0.9 > 1.0: the review waits for the images');
    for (let i = 0; i < 3; i++) assert.ok(f4.tryReserve('image', 0.3, { priority: SPEND_PRIORITY.images }));
    near(b.snapshot().projection.imagesRemaining, 0);
    assert.equal(f4.tryReserve('text', 0.2, { priority: SPEND_PRIORITY.quality }), null, 'only 0.1 is left in any case');
    assert.ok(f4.tryReserve('text', 0.09, { priority: SPEND_PRIORITY.quality }), 'a small check still fits once the images are paid for');
  });

  it('when the first image of an unpriced model shows the real cost, the rest of the campaign is protected with it', () => {
    const b = new SpendBudget(3);
    b.setPlan({ phases: [{ label: 'F4', order: 1, projectedUsd: 0 }], images: { remaining: 4, unitUsd: null } });
    assert.equal(b.snapshot().projection.imagesUsd, null, 'unknown stays unknown: never invented');
    assert.equal(b.snapshot().projection.imageBasis, 'unknown');
    b.scope('F4').learnImageUnit(0.3);
    near(b.snapshot().projection.imagesUsd, 1.2);
    assert.equal(b.snapshot().projection.imageBasis, 'observed');
  });

  it('a phase that is done releases its projection: the unused money is back in play', () => {
    const b = plan();
    near(b.snapshot().projection.essentialUsd, 1.1);
    b.phaseDone('F1');
    b.phaseDone('F2');
    near(b.snapshot().projection.essentialUsd, 0.7);
  });
});

describe('the snapshot reconciles', () => {
  it('known + estimated + reserved + uncertain = committed, remaining = approved - committed, and the breakdown only informs', () => {
    const b = new SpendBudget(3);
    const t = b.tryReserve('text', 0.4, { priority: 1 })!;
    b.settle(t, 0.3);
    const q = b.tryReserve('text', 0.2, { priority: 4 })!;
    b.settle(q, 0.1);
    const i = b.tryReserve('image', 0.5, { priority: 2 })!;
    b.settle(i, 0.45);
    const e = b.tryReserve('text', 0.05, { priority: 1 })!;
    b.settle(e, null);
    const u = b.tryReserve('image', 0.3, { priority: 2 })!;
    b.markUncertain(u);
    const open = b.tryReserve('text', 0.15, { priority: 4 })!;
    assert.ok(open);
    const s = b.snapshot();
    near(s.knownUsd, 0.85);
    near(s.estimatedUsd, 0.05);
    near(s.uncertainUsd, 0.3);
    near(s.reservedUsd, 0.15);
    near(s.committedUsd, s.knownUsd + s.estimatedUsd + s.uncertainUsd + s.reservedUsd);
    near(s.remainingUsd, 3 - 1.35);
    near(s.spentUsd, s.knownUsd + s.estimatedUsd);
    near(s.breakdown.agentsUsd, 0.35); // 0.30 + 0.05 estimated
    near(s.breakdown.reviewsUsd, 0.1);
    near(s.breakdown.imagesUsd, 0.45 + 0.3);
    assert.deepEqual([s.requests.text, s.requests.image], [4, 2]);
    assert.equal(s.byPriority[4].requests, 2);
  });

  it('the new run counters never go negative and a fully spent budget reports 0 remaining', () => {
    const b = new SpendBudget(0.5);
    const r = b.tryReserve('text', 0.5)!;
    b.settle(r, 0.62); // the provider reported more than the reservation: the figure is never hidden
    const s = b.snapshot();
    near(s.knownUsd, 0.62);
    assert.equal(s.remainingUsd, 0);
  });
});
