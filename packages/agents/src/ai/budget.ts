/**
 * THE CAMPAIGN BUDGET: one application-side ledger in US dollars, shared by every paid request of a campaign (F1 to F4, the image provider,
 * vision reviews, repairs). There are no separate text and image pools: whoever needs money draws on the same approved total.
 *
 * How a request is paid for, always in this order and always synchronously (JavaScript runs one reservation at a time, so two concurrent
 * workers can never reserve the same money):
 *   1. `tryReserve`  holds the request's worst case (published price, estimated input plus the FULL output cap) BEFORE it is sent. It is
 *                    refused, unsent, when it would knowingly exceed the approved total, or when it would eat into money that must stay
 *                    available for more important work that has not been paid for yet (see priorities below).
 *   2. the request is sent
 *   3. `settle`      replaces the reservation by the cost computed from the usage the provider REPORTED (known), or, when no usage came back,
 *                    keeps the reservation as the cost (estimated). The unused part of the reservation returns to the budget.
 *      `release`     the provider rejected the request before doing any work (HTTP error, rate limit): nothing was billed.
 *      `markUncertain` a timeout or cancel after sending: it may have been billed, so the reservation stays counted (uncertain).
 *
 * PRIORITIES decide what may be bought when money is tight, without fixed pools:
 *   1 essential analysis (F1 to F3 and the copy of F4)      3 template rendering (local, normally no API money)
 *   2 the required original AI images                       4 useful quality checks and corrections     5 optional refinements
 * The ledger holds a REVISABLE projection of the unspent mandatory work (`setPlan`). Priority decides who is held back, never the other way
 * round: essential analysis (1) outranks the images (2), so it is only kept from using the money that the essential analysis of the LATER
 * phases still needs; the required images (2) are protected from the same later analysis; a quality check or refinement (4 or 5) may not use
 * money that ANY mandatory work (analysis or required images) still needs. If analysis itself uses up the money, the images that no longer fit
 * are reported as stopped by the budget, never as done. The projection is recomputed as phases finish and images start, so unused money is
 * never locked away: it simply stays available.
 *
 * What it can NOT do, and the UI must say so: it is not a billing cap at OpenAI. A request that times out may still be billed (it is kept as
 * "uncertain", never as zero). A model without a published price cannot be bounded in dollars: the request-count cap still applies, the first
 * such request runs alone so its real cost is learned, and a request of unknown price is never started when nothing is left.
 */
export type SpendKind = 'text' | 'image';

/** 1 essential analysis, 2 required original images, 3 template rendering, 4 quality checks and corrections, 5 optional refinements. */
export type SpendPriority = 1 | 2 | 3 | 4 | 5;
export const SPEND_PRIORITY = { essential: 1, images: 2, templates: 3, quality: 4, refinement: 5 } as const satisfies Record<string, SpendPriority>;
export const PRIORITY_LABEL: Record<SpendPriority, string> = {
  1: 'Essential analysis',
  2: 'Required original images',
  3: 'Template rendering',
  4: 'Quality checks and corrections',
  5: 'Optional refinements',
};

export interface Reservation {
  readonly id: number;
  readonly kind: SpendKind;
  /** The worst-case amount held while the request is in flight (0 for a request of unknown price). */
  readonly usd: number;
  readonly priced: boolean;
  readonly priority: SpendPriority;
  /** The phase (or run) that made the request: "F1".."F4". */
  readonly scope: string;
}

/** Why a request was refused (unsent). Kept so a failed phase can say WHY in words. */
export interface Refusal {
  kind: SpendKind;
  priority: SpendPriority;
  scope: string;
  reason: 'over_budget' | 'protected_for_required_work' | 'image_request_cap' | 'nothing_left';
  /** The worst case of the refused request (null = unknown price). */
  neededUsd: number | null;
  /** What the budget could still have paid for (after the money kept for required work). */
  availableUsd: number | null;
  /** Money held back for more important work that is still to be paid for. */
  protectedUsd: number;
}

export type RemainingBasis = 'exact' | 'estimated' | 'unknown' | 'uncapped';

export interface SpendSnapshot {
  /** The one approved campaign budget, or null = no dollar cap for this run (usage is measured and the request limits still apply). */
  approvedUsd: number | null;
  /** Known + estimated cost of finished requests. (Kept under its old name; see `knownUsd` and `estimatedUsd` for the split.) */
  spentUsd: number;
  /** Cost computed from the usage the provider reported. */
  knownUsd: number;
  /** Finished requests whose usage was not reported: the reservation stays as their cost. */
  estimatedUsd: number;
  /** Held for requests that are in flight right now. */
  reservedUsd: number;
  /** Requests that may have been billed although no usable result came back (timeout, cancel after sending). Counted at their reservation. */
  uncertainUsd: number;
  committedUsd: number;
  /** approved - committed (never negative). null when there is no cap. */
  remainingUsd: number | null;
  /** How far the remaining figure can be trusted. */
  remainingBasis: RemainingBasis;
  /** Requests refused because they would have exceeded the approved amount. */
  blocked: number;
  /** Requests refused only because the money is needed for more important, unpaid work (or the image-request cap). */
  deferred: number;
  /** Requests that finished or are in flight with NO known price: their cost is NOT counted as zero, it is unknown. */
  unpriced: number;
  /** Requests of unknown price that finished (or may have): the remaining budget is then "estimated" at best. */
  unknownCostRequests: number;
  /** Requests sent so far. `imageCap` = the approved maximum number of image requests (null = none set). */
  requests: { text: number; image: number; imageCap: number | null };
  text: { requests: number; spentUsd: number; uncertainUsd: number; unknown: number };
  image: { requests: number; spentUsd: number; uncertainUsd: number; unknown: number };
  /** Informational breakdown of what was spent (never a separate budget). */
  breakdown: { agentsUsd: number; imagesUsd: number; reviewsUsd: number };
  byPriority: Record<SpendPriority, { usd: number; requests: number }>;
  /** The unspent mandatory work the ledger is protecting right now (null part = unknown, not zero). */
  projection: { essentialUsd: number; imagesUsd: number | null; imagesRemaining: number; imageBasis: 'published' | 'reference' | 'observed' | 'unknown' };
  /** The most recent refusals (newest last), for honest messages. */
  refusals: Refusal[];
  /** The phase this snapshot is for (null = the whole campaign). */
  scope: string | null;
}

/** What the gateway and the image generator need from the ledger. */
export interface SpendController {
  readonly approvedUsd: number | null;
  tryReserve(kind: SpendKind, usd: number | null, opts?: { priority?: SpendPriority }): Reservation | null;
  settle(r: Reservation, actualUsd: number | null): void;
  release(r: Reservation): void;
  markUncertain(r: Reservation): void;
  snapshot(): SpendSnapshot;
  /** Image requests left to make for the REQUIRED originals, and what one costs (null = unknown). Revisable. */
  setImagePlan?(remaining: number, unitUsd: number | null, basis?: 'published' | 'reference' | 'observed'): void;
  /** The real cost of one image became known (the first image of a model without a published price). */
  learnImageUnit?(usd: number): void;
  /** Caps the number of image requests of the whole campaign (the approved image-request maximum). */
  setMaxImageRequests?(n: number | null): void;
  /** true when a projection of the mandatory work exists. */
  readonly hasPlan?: boolean;
  /**
   * Waits while the request would not fit ONLY because other requests still hold their worst-case reservations (they release money as they
   * settle). Returns at once when it fits, or when nothing in flight could free money (the next `tryReserve` then refuses it for good).
   */
  awaitRoom?(kind: SpendKind, usd: number | null, opts?: { priority?: SpendPriority }, signal?: AbortSignal): Promise<void>;
}

export interface LedgerPlan {
  /** Phases in order; `projectedUsd` is the typical text spend of that phase (null = unknown: nothing is protected for it). */
  phases: { label: string; order: number; projectedUsd: number | null }[];
  images?: { remaining: number; unitUsd: number | null; basis?: 'published' | 'reference' | 'observed' };
}

interface Acc {
  known: number;
  estimated: number;
  uncertain: number;
  unknown: number;
  requests: number;
}
const acc = (): Acc => ({ known: 0, estimated: 0, uncertain: 0, unknown: 0, requests: 0 });
const PRIORITIES: SpendPriority[] = [1, 2, 3, 4, 5];
const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export class SpendBudget implements SpendController {
  private nextId = 1;
  private readonly open = new Map<number, Reservation>();
  private readonly by = { text: acc(), image: acc() } as Record<SpendKind, Acc>;
  private readonly byScope = new Map<string, Record<SpendKind, Acc>>();
  /** Spend and requests per phase, priority and kind (key `scope|priority|kind`). */
  private readonly byPrio = new Map<string, { usd: number; requests: number }>();
  /** Money committed per scope and priority 1 (known + estimated + uncertain), to tell how much of a phase's projection is already spent. */
  private readonly p1Spent = new Map<string, number>();
  private blocked = 0;
  private deferred = 0;
  private unpriced = 0;
  private readonly refusals: Refusal[] = [];
  private scopeRefusals = new Map<string, Refusal[]>();
  private plan: LedgerPlan | null = null;
  private done = new Set<string>();
  private images = { remaining: 0, unitUsd: null as number | null, basis: 'unknown' as 'published' | 'reference' | 'observed' | 'unknown' };
  private imagesStarted = 0;
  private maxImages: number | null;
  private closed = false;
  private readonly onChange?: () => void;
  /** Callers waiting for an in-flight request to settle (see awaitRoom). */
  private waiters: (() => void)[] = [];

  /** `approvedUsd` = the total of the whole campaign (null = no cap). */
  constructor(readonly approvedUsd: number | null = null, opts: { maxImageRequests?: number | null; onChange?: () => void } = {}) {
    this.maxImages = opts.maxImageRequests ?? null;
    this.onChange = opts.onChange;
  }

  get hasPlan() {
    return this.plan !== null || this.images.remaining > 0;
  }

  /** The view of ONE phase: it reserves from the shared ledger, and its snapshot reports that phase's own figures. */
  scope(label: string): SpendScope {
    return new SpendScope(this, label);
  }

  // ---- projections (revisable) --------------------------------------------------------------------------------------------------

  setPlan(plan: LedgerPlan) {
    this.plan = plan;
    if (plan.images) this.setImagePlan(plan.images.remaining, plan.images.unitUsd, plan.images.basis);
    this.touch();
  }

  /** A phase finished (or will not run): it no longer needs any of the money projected for it. */
  phaseDone(label: string) {
    this.done.add(label);
    this.touch();
  }

  setImagePlan(remaining: number, unitUsd: number | null, basis: 'published' | 'reference' | 'observed' = 'published') {
    this.images = { remaining: Math.max(0, Math.floor(remaining)), unitUsd: unitUsd === null ? null : Math.max(0, unitUsd), basis: unitUsd === null ? 'unknown' : basis };
    this.touch();
  }

  learnImageUnit(usd: number) {
    this.images.unitUsd = Math.max(0, usd);
    this.images.basis = 'observed';
    this.touch();
  }

  setMaxImageRequests(n: number | null) {
    this.maxImages = n;
    this.touch();
  }

  // ---- accounting ------------------------------------------------------------------------------------------------------------------

  private reservedOf(kind?: SpendKind) {
    let t = 0;
    for (const r of this.open.values()) if (!kind || r.kind === kind) t += r.usd;
    return t;
  }

  private sum(a: Acc) {
    return a.known + a.estimated + a.uncertain;
  }

  /** Money that is spent, held or possibly billed. */
  get committedUsd() {
    return this.sum(this.by.text) + this.sum(this.by.image) + this.reservedOf();
  }

  get remainingUsd(): number | null {
    return this.approvedUsd === null ? null : Math.max(0, this.approvedUsd - this.committedUsd);
  }

  private prio(scope: string, priority: SpendPriority, kind: SpendKind) {
    const key = `${scope}|${priority}|${kind}`;
    let p = this.byPrio.get(key);
    if (!p) this.byPrio.set(key, (p = { usd: 0, requests: 0 }));
    return p;
  }

  /** Spend and requests of one priority (and kind), for one phase or (label null) the whole campaign. */
  private prioTotal(label: string | null, priority: SpendPriority, kind?: SpendKind) {
    let usd = 0;
    let requests = 0;
    for (const [key, v] of this.byPrio) {
      const [scope, pr, k] = key.split('|');
      if ((label === null || scope === label) && Number(pr) === priority && (!kind || k === kind)) {
        usd += v.usd;
        requests += v.requests;
      }
    }
    return { usd, requests };
  }

  private scopeAcc(label: string) {
    let s = this.byScope.get(label);
    if (!s) this.byScope.set(label, (s = { text: acc(), image: acc() }));
    return s;
  }

  private p1Committed(label: string) {
    let t = this.p1Spent.get(label) ?? 0;
    for (const r of this.open.values()) if (r.scope === label && r.priority === 1) t += r.usd;
    return t;
  }

  /** Money that must stay available for work that matters more than a request of this priority from this phase and is not paid for yet. */
  protectedFor(priority: SpendPriority, scope: string): number {
    let later = 0;
    let current = 0;
    if (this.plan) {
      const me = this.plan.phases.find((p) => p.label === scope);
      for (const ph of this.plan.phases) {
        if (this.done.has(ph.label)) continue;
        const left = Math.max(0, (ph.projectedUsd ?? 0) - this.p1Committed(ph.label));
        if (ph.label === scope) current = left;
        else if (!me || ph.order > me.order) later += left;
      }
    }
    const images = (this.images.unitUsd ?? 0) * this.images.remaining;
    if (priority <= 2) return later; // essential analysis outranks the images; the images are protected from the later phases' analysis only
    return current + later + images; // quality checks and refinements: everything mandatory that is still unpaid
  }

  private refuse(r: Refusal) {
    if (r.reason === 'over_budget' || r.reason === 'nothing_left') this.blocked++;
    else this.deferred++;
    this.refusals.push(r);
    if (this.refusals.length > 8) this.refusals.shift();
    const mine = this.scopeRefusals.get(r.scope) ?? [];
    mine.push(r);
    if (mine.length > 8) mine.shift();
    this.scopeRefusals.set(r.scope, mine);
    this.touch();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** The same checks as `tryReserve`, without side effects. */
  private fits(kind: SpendKind, usd: number | null, priority: SpendPriority, scope: string): boolean {
    if (this.closed) return false;
    if (kind === 'image' && this.maxImages !== null && this.imagesStarted >= this.maxImages) return false;
    if (this.approvedUsd === null) return true;
    const available = this.approvedUsd - this.committedUsd;
    const guard = this.protectedFor(priority, scope);
    return usd === null ? available - guard > 0.0005 : this.committedUsd + usd + guard <= this.approvedUsd + 1e-9;
  }

  /**
   * DEFERS a request that does not fit only because other requests still hold their worst-case reservations: those release money as they settle
   * at the cost the provider reports, so refusing now would turn a feasible campaign into a smaller one for no reason. It returns when the
   * request fits, when nothing is in flight (nothing can free money any more: `tryReserve` then refuses it for good), or when `signal` aborts.
   */
  async awaitRoom(kind: SpendKind, usd: number | null, opts: { priority?: SpendPriority; scope?: string } = {}, signal?: AbortSignal): Promise<void> {
    const priority = opts.priority ?? 1;
    const scope = opts.scope ?? 'run';
    for (;;) {
      if (signal?.aborted || this.fits(kind, usd, priority, scope) || this.open.size === 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  /**
   * Holds `usd` for one request. Returns null (the request is NOT sent) when it would knowingly exceed the approved amount, would use money
   * that more important unpaid work needs, or would exceed the approved number of image requests. `usd === null` = unknown price: it cannot
   * be bounded, so it is allowed only while something is left, and counted as unpriced (never as free).
   */
  tryReserve(kind: SpendKind, usd: number | null, opts: { priority?: SpendPriority; scope?: string } = {}): Reservation | null {
    const priority = opts.priority ?? 1;
    const scope = opts.scope ?? 'run';
    if (this.closed) return null;
    if (kind === 'image' && this.maxImages !== null && this.imagesStarted >= this.maxImages) {
      this.refuse({ kind, priority, scope, reason: 'image_request_cap', neededUsd: usd, availableUsd: this.remainingUsd, protectedUsd: 0 });
      return null;
    }
    if (this.approvedUsd !== null) {
      const committed = this.committedUsd;
      const guard = this.protectedFor(priority, scope);
      const available = this.approvedUsd - committed;
      if (usd !== null) {
        if (committed + usd > this.approvedUsd + 1e-9) {
          this.refuse({ kind, priority, scope, reason: 'over_budget', neededUsd: usd, availableUsd: Math.max(0, available), protectedUsd: guard });
          return null;
        }
        if (guard > 0 && committed + usd + guard > this.approvedUsd + 1e-9) {
          this.refuse({ kind, priority, scope, reason: 'protected_for_required_work', neededUsd: usd, availableUsd: Math.max(0, available - guard), protectedUsd: guard });
          return null;
        }
      } else if (available - guard <= 0.0005) {
        // the price is unknown: nothing can prove it fits, but a request is never started when there is demonstrably nothing left for it
        this.refuse({ kind, priority, scope, reason: guard > 0 && available > 0.0005 ? 'protected_for_required_work' : 'nothing_left', neededUsd: null, availableUsd: Math.max(0, available - guard), protectedUsd: guard });
        return null;
      }
    }
    if (usd === null) this.unpriced++;
    const r: Reservation = { id: this.nextId++, kind, usd: usd ?? 0, priced: usd !== null, priority, scope };
    this.open.set(r.id, r);
    this.by[kind].requests++;
    this.scopeAcc(scope)[kind].requests++;
    this.prio(scope, priority, kind).requests++;
    if (kind === 'image') {
      this.imagesStarted++;
      if (priority === 2) this.images.remaining = Math.max(0, this.images.remaining - 1);
    }
    this.touch();
    return r;
  }

  private add(r: Reservation, field: 'known' | 'estimated' | 'uncertain', usd: number) {
    this.by[r.kind][field] += usd;
    this.scopeAcc(r.scope)[r.kind][field] += usd;
    this.prio(r.scope, r.priority, r.kind).usd += usd;
    if (r.priority === 1) this.p1Spent.set(r.scope, (this.p1Spent.get(r.scope) ?? 0) + usd);
  }

  private unknown(r: Reservation) {
    this.by[r.kind].unknown++;
    this.scopeAcc(r.scope)[r.kind].unknown++;
  }

  /**
   * The request finished with a usable result. `actualUsd` = cost computed from the reported usage; null = the usage was not reported, so a
   * priced reservation stays as the (estimated) cost, and a request of UNKNOWN price is recorded as unknown, never as free.
   */
  settle(r: Reservation, actualUsd: number | null) {
    if (!this.open.delete(r.id)) return;
    if (actualUsd !== null) this.add(r, 'known', actualUsd);
    else if (r.priced) this.add(r, 'estimated', r.usd);
    else this.unknown(r);
    this.touch();
    this.wake();
  }

  /** The request was rejected by the provider before any work was done (HTTP error, rate limit): nothing was billed. */
  release(r: Reservation) {
    if (this.open.delete(r.id)) {
      this.touch();
      this.wake();
    }
  }

  /** The request may have been billed although no result came back (timeout or cancel after sending): the reservation stays counted. */
  markUncertain(r: Reservation) {
    if (!this.open.delete(r.id)) return;
    this.add(r, 'uncertain', r.usd);
    if (!r.priced) this.unknown(r);
    this.touch();
    this.wake();
  }

  /** The run is over (finished, cancelled, interrupted): whatever is still in flight may have been billed, so it becomes uncertain. */
  finalize() {
    for (const r of [...this.open.values()]) this.markUncertain(r);
    this.closed = true;
    this.touch();
  }

  private touch() {
    this.onChange?.();
  }

  // ---- views ------------------------------------------------------------------------------------------------------------------------

  /** The whole campaign. */
  snapshot(): SpendSnapshot {
    return this.view(null);
  }

  lastRefusal(label?: string): Refusal | null {
    const list = label ? (this.scopeRefusals.get(label) ?? []) : this.refusals;
    return list.length ? list[list.length - 1] : null;
  }

  view(label: string | null): SpendSnapshot {
    const text = label ? this.scopeAcc(label).text : this.by.text;
    const image = label ? this.scopeAcc(label).image : this.by.image;
    const openOf = (kind: SpendKind) => {
      let t = 0;
      for (const r of this.open.values()) if (r.kind === kind && (!label || r.scope === label)) t += r.usd;
      return t;
    };
    const known = text.known + image.known;
    const estimated = text.estimated + image.estimated;
    const uncertain = text.uncertain + image.uncertain;
    const reserved = openOf('text') + openOf('image');
    const unknownTotal = this.by.text.unknown + this.by.image.unknown;
    const committedAll = this.committedUsd;
    const remaining = this.approvedUsd === null ? null : Math.max(0, this.approvedUsd - committedAll);
    const openUnknown = [...this.open.values()].filter((r) => !r.priced).length;
    const basis: RemainingBasis = this.approvedUsd === null ? 'uncapped' : unknownTotal + openUnknown > 0 ? 'unknown' : estimated + uncertain + this.reservedOf() > 0 ? 'estimated' : 'exact';
    // informational breakdown: the text agents' own work, the checks and corrections (priority 4 and 5), and the images
    const reviewsText = this.prioTotal(label, 4, 'text').usd + this.prioTotal(label, 5, 'text').usd;
    const textAll = text.known + text.estimated + text.uncertain;
    const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, { usd: r6(this.prioTotal(label, p).usd), requests: this.prioTotal(label, p).requests }])) as SpendSnapshot['byPriority'];
    const imagesAll = image.known + image.estimated + image.uncertain;
    const snapshotScope = label ?? null;
    return {
      approvedUsd: this.approvedUsd,
      spentUsd: r6(known + estimated),
      knownUsd: r6(known),
      estimatedUsd: r6(estimated),
      reservedUsd: r6(reserved),
      uncertainUsd: r6(uncertain),
      committedUsd: r6(known + estimated + uncertain + reserved),
      remainingUsd: remaining === null ? null : r6(remaining),
      remainingBasis: basis,
      blocked: this.blocked,
      deferred: this.deferred,
      unpriced: this.unpriced,
      unknownCostRequests: label ? text.unknown + image.unknown : unknownTotal,
      requests: { text: text.requests, image: image.requests, imageCap: this.maxImages },
      text: { requests: text.requests, spentUsd: r6(text.known + text.estimated), uncertainUsd: r6(text.uncertain), unknown: text.unknown },
      image: { requests: image.requests, spentUsd: r6(image.known + image.estimated), uncertainUsd: r6(image.uncertain), unknown: image.unknown },
      breakdown: { agentsUsd: r6(Math.max(0, textAll - reviewsText)), imagesUsd: r6(imagesAll), reviewsUsd: r6(reviewsText) },
      byPriority,
      projection: {
        essentialUsd: r6(this.plan ? this.plan.phases.reduce((a, ph) => (this.done.has(ph.label) ? a : a + Math.max(0, (ph.projectedUsd ?? 0) - this.p1Committed(ph.label))), 0) : 0),
        imagesUsd: this.images.unitUsd === null ? null : r6(this.images.unitUsd * this.images.remaining),
        imagesRemaining: this.images.remaining,
        imageBasis: this.images.basis,
      },
      refusals: (label ? (this.scopeRefusals.get(label) ?? []) : this.refusals).map((x) => ({ ...x })),
      scope: snapshotScope,
    };
  }
}

/** One phase's handle on the shared ledger. */
export class SpendScope implements SpendController {
  constructor(
    private readonly ledger: SpendBudget,
    readonly label: string,
  ) {}

  get approvedUsd() {
    return this.ledger.approvedUsd;
  }

  get hasPlan() {
    return this.ledger.hasPlan;
  }

  tryReserve(kind: SpendKind, usd: number | null, opts: { priority?: SpendPriority } = {}) {
    return this.ledger.tryReserve(kind, usd, { priority: opts.priority, scope: this.label });
  }
  awaitRoom(kind: SpendKind, usd: number | null, opts: { priority?: SpendPriority } = {}, signal?: AbortSignal) {
    return this.ledger.awaitRoom(kind, usd, { priority: opts.priority, scope: this.label }, signal);
  }
  settle(r: Reservation, actualUsd: number | null) {
    this.ledger.settle(r, actualUsd);
  }
  release(r: Reservation) {
    this.ledger.release(r);
  }
  markUncertain(r: Reservation) {
    this.ledger.markUncertain(r);
  }
  setImagePlan(remaining: number, unitUsd: number | null, basis: 'published' | 'reference' | 'observed' = 'published') {
    this.ledger.setImagePlan(remaining, unitUsd, basis);
  }
  learnImageUnit(usd: number) {
    this.ledger.learnImageUnit(usd);
  }
  setMaxImageRequests(n: number | null) {
    this.ledger.setMaxImageRequests(n);
  }
  /** What THIS phase spent, next to the campaign-wide remaining budget. */
  snapshot(): SpendSnapshot {
    return this.ledger.view(this.label);
  }
  lastRefusal() {
    return this.ledger.lastRefusal(this.label);
  }
  /** The whole campaign (all phases). */
  campaign() {
    return this.ledger;
  }
}

/** A phase's handle on the campaign ledger: the shared one when the factory passes it, else a ledger of its own with the run's cap. */
export function scopeFor(ledger: SpendBudget | null | undefined, spendCapUsd: number | null | undefined, label: string): SpendScope {
  return (ledger ?? new SpendBudget(spendCapUsd ?? null)).scope(label);
}
