import type { FormatClass } from '../templates/schema';
import { ImageSearchError, type ImageSearchAdapter } from './adapters';
import type { DiscoveryResult, ImageCandidate, ProviderOutcome, SearchIntent } from './types';

/**
 * WEB VISUAL DISCOVERY. From what the project says about its business it builds a few focused search intents (deterministically: no model),
 * asks the CONFIGURED providers, and sorts what comes back into two lists that never mix:
 *
 *   licensed    pictures whose license (per provider, see ./license.ts) allows advertising use or needs a check at the source. They are
 *               candidates only: a picture becomes a project asset when the user chooses it (./acquire.ts).
 *   references  pictures to LOOK at (including Pinterest links). They are never downloaded and never become an asset.
 *
 * Nothing is invented: with no provider configured the result says so and the campaign carries on with the local style library and the
 * project's own pictures. One failing provider never fails the others.
 */

const STOP = new Set(
  ('a an and are as at be by for from has have in into is it its of on or our that the their this to we with you your will can more most new best all any not but than then them they who what when where which while about over under per via ' +
    'i u za na je se da sa od do koji koja koje nas nasa nase vas vasa vase kao ili ali sto su smo ste biti ima imaju sve svoj svoja ' +
    'company business service services product products solution solutions customers customer clients client team platform brand help helps made make makes using use used').split(' '),
);

export const wordsOf = (text: string): string[] => (text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));

export interface IntentContext {
  business: string;
  offering: string;
  valueProposition?: string;
  audience?: string;
  /** subjects of the visual direction (the style library's photography subjects) */
  imageSubjects?: string[];
  mood?: string[];
  formatClasses?: FormatClass[];
  /** the concepts of the campaign (NO AI HYBRID searches for pictures that fit each concept) */
  concepts?: { name: string; visualIdea: string; keyMessage: string }[];
  /** the campaign objective in words */
  objective?: string;
  /** the template collection the pictures must suit */
  collectionId?: string;
  /** what the collection needs from its pictures (one phrase) */
  collectionNeeds?: string;
}

/** The most useful words of the business text, in order of how often and how early they appear. */
export function keywordsOf(ctx: Pick<IntentContext, 'business' | 'offering' | 'valueProposition'>, max = 5): string[] {
  const score = new Map<string, { n: number; first: number }>();
  [ctx.business, ctx.offering, ctx.valueProposition ?? ''].forEach((text, part) =>
    wordsOf(text).forEach((w, i) => {
      const cur = score.get(w);
      if (cur) cur.n++;
      else score.set(w, { n: 1, first: part * 100 + i });
    }),
  );
  return [...score.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([w]) => w);
}

function orientationOf(classes: readonly FormatClass[] | undefined): SearchIntent['orientation'] {
  if (!classes?.length) return null;
  const wide = classes.filter((c) => c === 'landscape' || c === 'banner').length;
  const tall = classes.filter((c) => c === 'story' || c === 'portrait').length;
  if (wide > tall) return 'landscape';
  if (tall > wide) return 'portrait';
  return null;
}

/** Up to four focused queries. The words come from the business text and the visual direction only, so the same inputs always give the same queries. */
export function buildSearchIntents(ctx: IntentContext): SearchIntent[] {
  const kw = keywordsOf(ctx);
  const orientation = orientationOf(ctx.formatClasses);
  const out: SearchIntent[] = [];
  const add = (query: string, why: string) => {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 90);
    if (q.length >= 3 && !out.some((i) => i.query === q)) out.push({ query: q, why, orientation });
  };
  if (kw.length) add(kw.slice(0, 3).join(' '), 'the business itself, from its name and description');
  for (const s of (ctx.imageSubjects ?? []).slice(0, 2)) {
    const sw = wordsOf(s).slice(0, 4);
    if (sw.length) add([...kw.slice(0, 1), ...sw].join(' '), `a photography subject of the visual direction: "${s.slice(0, 70)}"`);
  }
  const mood = (ctx.mood ?? []).map((m) => wordsOf(m)[0]).filter(Boolean)[0];
  if (mood && kw[0]) add(`${mood} ${kw[0]}`, `the mood of the campaign (${mood}) around the business`);
  // concept-aware intents (only when the caller knows the concepts): the visual idea of a concept, then what the collection needs, then the objective
  const extra = !!ctx.concepts?.length || !!ctx.collectionNeeds || !!ctx.objective;
  if (extra) {
    for (const c of (ctx.concepts ?? []).slice(0, 3)) {
      const cw = wordsOf(`${c.visualIdea} ${c.name}`).slice(0, 4);
      if (cw.length) add([...kw.slice(0, 1), ...cw.slice(0, 3)].join(' '), `the concept "${c.name.slice(0, 50)}"`);
    }
    const need = wordsOf(ctx.collectionNeeds ?? '').slice(0, 3);
    if (need.length && kw[0]) add([kw[0], ...need.slice(0, 2)].join(' '), `what the ${ctx.collectionId ?? 'chosen'} collection needs from its pictures`);
    const obj = wordsOf(ctx.objective ?? '').slice(0, 2);
    if (obj.length && kw[0]) add([kw[0], ...obj].join(' '), 'the objective of the campaign');
    if (ctx.audience) {
      const aw = wordsOf(ctx.audience).slice(0, 2);
      if (aw.length && kw[0]) add([kw[0], ...aw].join(' '), 'the audience of the campaign');
    }
  }
  return out.slice(0, extra ? 7 : 4);
}

/** What the Visual Researcher is given to search with. The backend builds it from the environment (configured providers only); tests pass a mock. */
export type VisualDiscoveryPort = (ctx: IntentContext, signal?: AbortSignal) => Promise<DiscoveryResult>;

export interface DiscoverOptions {
  /** how many intents each provider is asked (provider rate limits are small) */
  intentsPerProvider?: number;
  /** false = providers that bill per request are skipped (the Visual Researcher inside a NO AI HYBRID run, unless the user approved paid search). A search the user starts by hand keeps every configured provider. */
  includePaid?: boolean;
  limitPerSearch?: number;
  maxLicensed?: number;
  maxReferences?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

const safeMessage = (e: unknown): { status: ProviderOutcome['status']; message: string } => {
  if (e instanceof ImageSearchError) return { status: e.code === 'rate_limited' ? 'rate_limited' : 'failed', message: e.message };
  return { status: 'failed', message: 'The provider could not be searched.' };
};

export async function discoverImages(ctx: IntentContext, adapters: readonly ImageSearchAdapter[], o: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const intents = buildSearchIntents(ctx);
  const notes: string[] = [];
  const providers: ProviderOutcome[] = [];
  const licensed: ImageCandidate[] = [];
  const references: ImageCandidate[] = [];
  const seen = new Set<string>();
  let blocked = 0;

  const perProvider = await Promise.all(
    adapters.map(async (a) => {
      const base = { id: a.id, label: a.label, kind: a.kind };
      if (a.paid && o.includePaid === false) return { outcome: { ...base, status: 'skipped' as const, message: 'This provider bills per request and paid search was not approved for this campaign, so it was not used.', count: 0 }, found: [] as ImageCandidate[] };
      if (!a.configured) return { outcome: { ...base, status: 'not_configured' as const, message: a.setup, count: 0 }, found: [] as ImageCandidate[] };
      if (!intents.length) return { outcome: { ...base, status: 'skipped' as const, message: 'The project text gave no words to search for.', count: 0 }, found: [] as ImageCandidate[] };
      const found: ImageCandidate[] = [];
      try {
        for (const intent of intents.slice(0, o.intentsPerProvider ?? 2)) found.push(...(await a.search(intent, { limit: o.limitPerSearch ?? 8, signal: o.signal })));
        return { outcome: { ...base, status: 'ok' as const, message: null, count: found.length }, found };
      } catch (e) {
        const m = safeMessage(e);
        return { outcome: { ...base, ...m, count: found.length }, found };
      }
    }),
  );

  for (const { outcome, found } of perProvider) {
    providers.push(outcome);
    for (const c of found) {
      const key = `${c.provider}:${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (c.kind === 'REFERENCE_ONLY') {
        references.push({ ...c, downloadUrl: null, license: { ...c.license, status: 'blocked' } });
      } else if (c.kind === 'LICENSED_STOCK' && c.downloadUrl && c.license.status !== 'blocked' && c.license.commercialUse && c.license.derivatives) {
        licensed.push(c);
      } else blocked++;
    }
  }
  if (blocked) notes.push(`${blocked} result${blocked === 1 ? ' was' : 's were'} left out because the license does not allow use in advertising or the picture cannot be downloaded.`);
  if (!providers.some((p) => p.status === 'ok')) notes.push('No image-search provider answered. The campaign uses the local style library and your own pictures; nothing was invented to fill the gap.');
  licensed.sort((a, b) => (a.license.status === b.license.status ? 0 : a.license.status === 'cleared' ? -1 : 1));
  return {
    intents,
    providers,
    licensed: licensed.slice(0, o.maxLicensed ?? 24),
    references: references.slice(0, o.maxReferences ?? 16),
    notes,
    searchedAt: (o.now?.() ?? new Date()).toISOString(),
  };
}
