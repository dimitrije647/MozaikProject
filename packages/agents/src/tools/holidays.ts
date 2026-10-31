/**
 * Public holidays as a deterministic TOOL (F3 Seasonal Intelligence).
 * Source: Nager.Date, a free public API that needs no key:
 *   GET https://date.nager.at/api/v3/PublicHolidays/{year}/{countryCode}  ->  [{ date, localName, name, global, types, ... }]
 * It is only called when the project opted in (intake "seasonal calendar") and a country can be resolved from the
 * project's geography. The response says WHEN a public holiday is. It says nothing about demand: whether a
 * holiday matters for this business is the model's hypothesis and is labeled that way.
 */
export const NAGER_URL = 'https://date.nager.at/api/v3';

export interface Holiday {
  date: string;
  name: string;
  localName: string;
}

export type HolidayOutcome =
  | { ok: true; country: string; year: number; holidays: Holiday[] }
  | { ok: false; code: 'timeout' | 'http_error' | 'invalid_response' | 'cancelled' | 'network_error'; message: string };

export class HolidayTool {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private calls = 0;
  constructor(options: { baseUrl?: string; timeoutMs?: number; maxCalls?: number } = {}) {
    this.baseUrl = options.baseUrl ?? NAGER_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxCalls = options.maxCalls ?? 3;
  }
  private readonly maxCalls: number;
  get callCount() {
    return this.calls;
  }

  async year(country: string, year: number, signal?: AbortSignal): Promise<HolidayOutcome> {
    if (!/^[A-Z]{2}$/.test(country) || !Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, code: 'invalid_response', message: 'Invalid country or year.' };
    if (this.calls >= this.maxCalls) return { ok: false, code: 'http_error', message: 'The per-run limit of holiday calendar requests was reached.' };
    this.calls++;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/PublicHolidays/${year}/${country}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } });
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: 'cancelled', message: 'The holiday calendar request was cancelled.' };
      if (timeout.aborted || (e as { name?: string }).name === 'TimeoutError') return { ok: false, code: 'timeout', message: 'The holiday calendar did not answer in time.' };
      return { ok: false, code: 'network_error', message: 'The holiday calendar could not be reached.' };
    }
    if (!res.ok) return { ok: false, code: 'http_error', message: `The holiday calendar answered HTTP ${res.status}.` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: 'invalid_response', message: 'The holiday calendar returned an unexpected response.' };
    }
    if (!Array.isArray(body)) return { ok: false, code: 'invalid_response', message: 'The holiday calendar returned an unexpected response.' };
    const holidays = body
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object' && typeof (h as Record<string, unknown>).date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String((h as Record<string, unknown>).date)))
      .map((h) => ({ date: String(h.date), name: String(h.name ?? '').slice(0, 100), localName: String(h.localName ?? '').slice(0, 100) }))
      .slice(0, 60);
    return { ok: true, country, year, holidays };
  }
}

// ---- country resolution (deterministic; no guessing) ---------------------------------------------------------------------------

const COUNTRIES: [string, string[]][] = [
  ['RS', ['serbia', 'srbija', 'belgrade', 'beograd', 'novi sad', 'nis', 'niš']],
  ['HR', ['croatia', 'hrvatska', 'zagreb', 'split']],
  ['BA', ['bosnia', 'bosna', 'sarajevo', 'banja luka']],
  ['ME', ['montenegro', 'crna gora', 'podgorica']],
  ['SI', ['slovenia', 'slovenija', 'ljubljana']],
  ['MK', ['north macedonia', 'macedonia', 'makedonija', 'skopje']],
  ['DE', ['germany', 'deutschland', 'berlin', 'munich', 'münchen']],
  ['AT', ['austria', 'österreich', 'vienna', 'wien']],
  ['CH', ['switzerland', 'schweiz', 'zurich', 'zürich']],
  ['US', ['united states', 'usa', 'u.s.', 'america']],
  ['GB', ['united kingdom', 'uk', 'england', 'britain', 'london', 'scotland']],
  ['IE', ['ireland', 'dublin']],
  ['FR', ['france', 'paris']],
  ['IT', ['italy', 'italia', 'rome', 'roma', 'milan']],
  ['ES', ['spain', 'españa', 'madrid', 'barcelona']],
  ['PT', ['portugal', 'lisbon', 'lisboa']],
  ['NL', ['netherlands', 'holland', 'amsterdam']],
  ['BE', ['belgium', 'brussels']],
  ['PL', ['poland', 'polska', 'warsaw']],
  ['CZ', ['czech', 'czechia', 'prague']],
  ['SK', ['slovakia', 'bratislava']],
  ['HU', ['hungary', 'budapest']],
  ['RO', ['romania', 'bucharest']],
  ['BG', ['bulgaria', 'sofia']],
  ['GR', ['greece', 'athens']],
  ['TR', ['turkey', 'türkiye', 'istanbul']],
  ['SE', ['sweden', 'stockholm']],
  ['NO', ['norway', 'oslo']],
  ['DK', ['denmark', 'copenhagen']],
  ['FI', ['finland', 'helsinki']],
  ['CA', ['canada', 'toronto']],
  ['AU', ['australia', 'sydney', 'melbourne']],
];

/** Resolves ONE country from free-text geography. Several different countries (or none) resolve to null: no guessing. */
export function countryCodeFor(geography: string[]): string | null {
  const hay = ` ${geography.join(' ; ').toLowerCase()} `;
  const found = new Set<string>();
  for (const [code, names] of COUNTRIES) for (const n of names) if (new RegExp(`[^a-zà-ž]${n.replace(/[.]/g, '\\.')}[^a-zà-ž]`, 'i').test(hay)) found.add(code);
  return found.size === 1 ? [...found][0] : null;
}

export function upcoming(holidays: Holiday[], now: Date, horizonDays = 366): Holiday[] {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + horizonDays * 86_400_000).toISOString().slice(0, 10);
  return holidays.filter((h) => h.date >= from && h.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
