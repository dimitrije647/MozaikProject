import type { SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { audienceMessage, competitorMessage, scoutMessage, seasonalMessage, srcBlock } from '../../../strategy/prompts';
import type { ChannelId } from '../../../strategy/channels';
import type { CompetitorLead } from '../../../strategy/context';
import type { StrategyAgentOutput, LlmStrategyFinding } from '../../../strategy/schemas';
import { competitorQueries, hostKey, pickCandidates } from '../../../tools/competitors';
import { countryCodeFor, upcoming, type Holiday } from '../../../tools/holidays';
import type { ExtractedPage } from '../../../tools/html';
import { SearchError, type SearchResult } from '../../../tools/web-search';
import type { PhaseAgent } from '../f1/agent';
import type { F3Env } from './env';

/**
 * The deterministic "gather" step of each F3 participant. Tools (search, SSRF-safe fetch, holiday calendar) do the
 * retrieval within hard limits; the model only sees the compact, delimited result. Every retrieval, success or
 * failure, is published as `source.retrieved`.
 */
export type F3Prep =
  | { kind: 'ready'; message: string }
  | { kind: 'direct'; output: StrategyAgentOutput; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; error: SafeProviderError };

type NewSource = Pick<SourceRecord, 'kind' | 'label' | 'status'> & Partial<Omit<SourceRecord, 'id' | 'retrievedAt' | 'excerpt' | 'chars'>>;

function addSource(env: F3Env, agent: PhaseAgent, rec: NewSource, text?: string): SourceRecord {
  const r = env.store.add({ live: false, fixture: false, url: null, httpStatus: null, bytes: null, error: null, producer: agent.name, ...rec }, text);
  env.ctx.emit('source.retrieved', { agent: agent.name, source: r }, agent.participant);
  return r;
}

const msgCtx = (env: F3Env) => ({ f1: env.f1, f2: env.f2, input: env.input, now: env.settings.now });
const webOrigin = (env: F3Env) => (env.settings.fixtureSources ? 'fixture' : 'public_page') as 'fixture' | 'public_page';
const apiOrigin = (env: F3Env) => (env.settings.fixtureSources ? 'fixture' : 'live_api') as 'fixture' | 'live_api';

const gapFinding = (title: string, statement: string, recommendation: string | null): LlmStrategyFinding => ({
  kind: 'gap',
  title,
  statement,
  classification: 'unknown',
  importance: 'medium',
  sourceType: 'ai_inference',
  sourceId: null,
  locator: null,
  excerpt: null,
  reasoning: 'No source material was available, and nothing is invented to fill the gap.',
  confidence: null,
  recommendation,
  segment: null,
  competitor: null,
  channel: null,
  opportunity: null,
});

// ---- A14 Audience Researcher --------------------------------------------------------------------------------------------------

export async function prepareAudience(env: F3Env): Promise<F3Prep> {
  return { kind: 'ready', message: audienceMessage(msgCtx(env)) };
}

// ---- A15 Competitor Researcher ------------------------------------------------------------------------------------------------

const pageBody = (p: ExtractedPage, url: string) =>
  [`url: ${url}`, p.title && `title: ${p.title}`, p.description && `description: ${p.description}`, p.siteName && `site_name: ${p.siteName}`, p.headings.length && `headings: ${p.headings.slice(0, 14).join(' | ')}`, `text: ${p.text.slice(0, 2200)}`].filter(Boolean).join('\n');

export async function prepareCompetitor(env: F3Env, agent: PhaseAgent): Promise<F3Prep> {
  const { web, search } = env.tools;
  const { settings, input } = env;
  const signal = agent.signal;
  const fixture = settings.fixtureSources;
  const pm = env.f1.report.productManifest;
  const facts = { provider: search.provider, searchUsed: false, queries: [] as string[], leads: [] as CompetitorLead[], userSupplied: input.competitorUrls.length, gaps: [] as string[] };
  env.facts.competitors = facts;
  const blocks: string[] = [];
  const own = [hostKey(input.websiteUrl ?? ''), hostKey(pm.onlinePresence.website ?? '')];
  const fetched = new Set<string>();
  let pages = 0;

  const fetchCompetitor = async (url: string, origin: CompetitorLead['origin'], title: string, snippet: string) => {
    const lead: CompetitorLead = { title, url, snippet, origin, fetched: false, sourceId: null, note: null };
    facts.leads.push(lead);
    const res = await web.fetchHtml(url, signal);
    if (!res.ok) {
      lead.note = res.result.message;
      addSource(env, agent, { kind: 'website', label: url, url, status: 'failed', live: true, fixture, origin: webOrigin(env), httpStatus: res.result.status ?? null, error: res.result.message });
      facts.gaps.push(`${url}: ${res.result.message}`);
      return;
    }
    const { page, result } = res;
    const rec = addSource(env, agent, { kind: 'website', label: page.title ?? result.finalUrl, url: result.finalUrl, status: 'retrieved', live: true, fixture, origin: webOrigin(env), httpStatus: result.status, bytes: result.bytes, injectionSuspected: page.injectionSuspected, notes: page.injectionSuspected ? ['Contains text that looks like instructions to an AI. Treated as data only.'] : [] }, pageBody(page, result.finalUrl));
    lead.fetched = true;
    lead.sourceId = rec.id;
    blocks.push(srcBlock(rec, pageBody(page, result.finalUrl)));
    pages++;
    fetched.add(hostKey(result.finalUrl) ?? url);
  };

  // 1. competitors the user named come first (never invented)
  for (const u of input.competitorUrls.slice(0, settings.maxCompetitorPages)) {
    const c = web.checkUrl(u);
    if (!c.ok) {
      facts.gaps.push(`${u}: the supplied competitor URL was rejected (${c.message}).`);
      addSource(env, agent, { kind: 'website', label: u, url: u, status: 'failed', origin: 'user_provided', error: c.message });
      continue;
    }
    if (pages >= settings.maxCompetitorPages || signal.aborted) break;
    await fetchCompetitor(u, 'user_supplied', u, '');
  }

  // 2. bounded search (official provider only); results are LEADS
  if (search.configured && settings.maxSearches > 0 && !signal.aborted) {
    facts.queries = competitorQueries({ category: pm.category, offering: pm.offering.summary, geography: env.input.geography, maxQueries: settings.maxSearches });
    const all: SearchResult[] = [];
    for (const q of facts.queries) {
      if (signal.aborted) break;
      try {
        all.push(...(await search.search(q, { maxResults: 5, language: input.language, signal })));
        facts.searchUsed = true;
      } catch (e) {
        const msg = e instanceof SearchError ? e.message : 'Search failed.';
        facts.gaps.push(`Web search failed: ${msg}`);
        addSource(env, agent, { kind: 'search_result', label: 'Competitor search', status: 'failed', live: true, fixture, origin: apiOrigin(env), error: msg });
        break;
      }
    }
    const candidates = pickCandidates(all, [...own, ...[...fetched]], Math.max(0, settings.maxCompetitorPages - pages));
    for (const r of candidates) {
      const text = `${r.title}\n${r.url}\n${r.snippet}`;
      const rec = addSource(env, agent, { kind: 'search_result', label: r.title || r.url, url: r.url, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), notes: [`Search provider: ${search.provider}. A snippet is a lead, not verification.`] }, text);
      blocks.push(srcBlock(rec, text));
    }
    for (const r of candidates) {
      if (pages >= settings.maxCompetitorPages || signal.aborted) break;
      await fetchCompetitor(r.url, 'search_lead', r.title, r.snippet);
    }
    if (facts.searchUsed && !all.length) facts.gaps.push('The search returned no results.');
    else if (facts.searchUsed && !candidates.length) facts.gaps.push('The search results contained no candidate competitor sites (only the business itself, directories or social networks).');
  } else if (!search.configured) {
    facts.gaps.push('No search provider is configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY), so no competitor search was performed.');
    addSource(env, agent, { kind: 'search_result', label: 'Competitor search', status: 'skipped', error: 'No search provider is configured. No search was performed.' });
  }
  if (!input.competitorUrls.length) facts.gaps.push('No competitor URLs were supplied by the user.');

  if (!blocks.length) {
    return {
      kind: 'direct',
      reason: 'No competitor material could be retrieved: reported as insufficient research, without a model call.',
      output: {
        summary: 'There is not enough live research to identify competitors. No competitor is named, because naming one without a source would be invented.',
        findings: [gapFinding('Insufficient live competitor research', 'No competitor page or search result could be retrieved, so no competitor is named and no competitive positioning is claimed.', 'Add competitor website URLs to the project, or configure a search provider (TAVILY_API_KEY), and run the strategy again.')],
        missingInformation: facts.gaps.slice(0, 8),
      },
    };
  }
  return { kind: 'ready', message: competitorMessage(msgCtx(env), blocks, facts) };
}

// ---- A17 Seasonal Intelligence ------------------------------------------------------------------------------------------------

export async function prepareSeasonal(env: F3Env, agent: PhaseAgent): Promise<F3Prep> {
  const { settings, input } = env;
  const fixture = settings.fixtureSources;
  const note = (n: string) => ({ used: false, country: null as string | null, note: n, holidays: [] as { date: string; name: string }[] });
  if (!input.useHolidayCalendar) {
    env.facts.holidays = note('The public-holiday calendar is switched off for this project (intake: seasonal calendar). Seasonal analysis is limited to labeled hypotheses.');
    return { kind: 'ready', message: seasonalMessage(msgCtx(env), null, 'No holiday calendar is available: every seasonal statement must be a labeled hypothesis.') };
  }
  const country = countryCodeFor(input.geography);
  if (!country) {
    env.facts.holidays = note('The holiday calendar was not queried: a single country could not be determined from the geography. Seasonal analysis is limited to labeled hypotheses.');
    return { kind: 'ready', message: seasonalMessage(msgCtx(env), null, 'No holiday calendar is available: every seasonal statement must be a labeled hypothesis.') };
  }
  const year = settings.now.getUTCFullYear();
  const years = settings.now.getUTCMonth() >= 8 ? [year, year + 1] : [year];
  const all: Holiday[] = [];
  const errors: string[] = [];
  for (const y of years) {
    const res = await env.tools.holidays.year(country, y, agent.signal);
    if (res.ok) all.push(...res.holidays);
    else errors.push(res.message);
  }
  const list = upcoming(all, settings.now);
  if (!list.length) {
    const msg = errors[0] ?? 'The calendar returned no upcoming holidays.';
    addSource(env, agent, { kind: 'holiday_calendar', label: `Public holidays ${country}`, status: 'failed', live: true, fixture, origin: apiOrigin(env), error: msg });
    env.facts.holidays = { used: false, country, note: `The holiday calendar could not be used: ${msg}`, holidays: [] };
    return { kind: 'ready', message: seasonalMessage(msgCtx(env), null, `The holiday calendar was unavailable (${msg}): every seasonal statement must be a labeled hypothesis.`) };
  }
  const text = [`country: ${country}`, `source: Nager.Date public holiday API (date.nager.at), requested now`, ...list.map((h) => `${h.date} | ${h.name} | ${h.localName}`)].join('\n');
  const rec = addSource(env, agent, { kind: 'holiday_calendar', label: `Public holidays ${country} (${years.join(', ')})`, url: `https://date.nager.at/api/v3/PublicHolidays/${years[0]}/${country}`, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), httpStatus: 200 }, text);
  env.facts.holidays = { used: true, country, note: `Public holidays for ${country} from the Nager.Date API${fixture ? ' (FIXTURE data)' : ''}.`, holidays: list.map((h) => ({ date: h.date, name: h.name })) };
  const block = `<holiday_calendar>\n${srcBlock(rec, text)}\n</holiday_calendar>`;
  return { kind: 'ready', message: seasonalMessage(msgCtx(env), block, 'A public-holiday calendar is supplied. Dates in it are observations of the calendar; whether a holiday matters for demand is your hypothesis.') };
}

// ---- A16 Channel Scouts (dynamic) ---------------------------------------------------------------------------------------------

export async function prepareScout(env: F3Env, _agent: PhaseAgent, channel: ChannelId): Promise<F3Prep> {
  const upstream = env.board.findings.filter((f) => f.area === 'audience' || f.area === 'competitor' || f.area === 'seasonal');
  const decision = env.board.scoutDecisions.find((d) => d.channel === channel);
  return { kind: 'ready', message: scoutMessage(msgCtx(env), channel, decision, upstream, env.board.summaries) };
}
