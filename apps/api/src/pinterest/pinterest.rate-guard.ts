import { Injectable } from '@nestjs/common';
import { PinterestError } from './pinterest.errors';

/**
 * In-process protection so LaunchPilot cannot be used to hammer Pinterest.
 *  - per-user sliding window (default 30 data calls / 60 s);
 *  - app-wide sliding window (default 120 / 60 s), because Pinterest rate-limits per APP (Trial: 1000 read calls per day);
 *  - app-wide cooldown after Pinterest answered 429: no further call is made until it ends.
 * Per-process only: with several API instances each has its own budget (documented limitation).
 */
@Injectable()
export class PinterestRateGuard {
  private readonly perUser = new Map<string, number[]>();
  private appWindow: number[] = [];
  private cooldownUntil = 0;

  // Plain fields (not constructor parameters) so Nest can construct the class and tests can tighten the limits.
  userLimit = 30;
  appLimit = 120;
  windowMs = 60_000;
  now: () => number = () => Date.now();

  /** Throws a typed 429 (without contacting Pinterest) when the budget is spent; otherwise records the call. */
  consume(userId: string): void {
    const t = this.now();
    if (t < this.cooldownUntil) {
      const wait = Math.ceil((this.cooldownUntil - t) / 1000);
      throw new PinterestError('rate_limited', `Pinterest asked us to slow down. Try again in about ${humanWait(wait)}.`, { retryAfterSeconds: wait });
    }
    const mine = prune(this.perUser.get(userId) ?? [], t - this.windowMs);
    this.appWindow = prune(this.appWindow, t - this.windowMs);
    if (mine.length >= this.userLimit || this.appWindow.length >= this.appLimit) {
      const oldest = mine.length >= this.userLimit ? mine[0] : this.appWindow[0];
      const wait = Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000));
      this.perUser.set(userId, mine);
      throw new PinterestError('rate_limited', `LaunchPilot is limiting requests to Pinterest. Try again in ${wait} seconds.`, { retryAfterSeconds: wait });
    }
    mine.push(t);
    this.appWindow.push(t);
    this.perUser.set(userId, mine);
  }

  /** Forgets all counters and the cooldown (tests; also useful after a deployment of new limits). */
  reset(): void {
    this.perUser.clear();
    this.appWindow = [];
    this.cooldownUntil = 0;
  }

  /** Pinterest said 429: stop calling for as long as it asked (default 60 s when it did not say; capped at 24 h). */
  noteUpstreamLimit(retryAfterSeconds: number | undefined): number {
    const seconds = Math.min(Math.max(Math.ceil(retryAfterSeconds ?? 60), 1), 24 * 3600);
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + seconds * 1000);
    return seconds;
  }
}

const prune = (list: number[], since: number) => list.filter((t) => t > since);

export function humanWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}
