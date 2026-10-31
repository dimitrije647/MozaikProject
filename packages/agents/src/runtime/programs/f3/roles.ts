import type { SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { audienceMessage, competitorMessage, competitorPresenceBlock, scoutMessage, seasonalMessage, srcBlock } from '../../../strategy/prompts';
import type { ChannelId } from '../../../strategy/channels';
import type { CompetitorLead, StrategyFacts } from '../../../strategy/context';
import type { StrategyAgentOutput, LlmStrategyFinding } from '../../../strategy/schemas';
import { competitorQueries, hostKey, namedCompetitorQuery, pickCandidates, pickNamed } from '../../../tools/competitors';
import { countryCodeFor, upcoming, type Holiday } from '../../../tools/holidays';
import { pageRole, type ExtractedPage } from '../../../tools/html';
import { readPage, type ReadPageOutcome } from '../../../tools/page-reader';
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

/** One competitor page as the model sees it. Pages of one site share `competitor_site`, so the model treats them as one competitor. */
const pageBody = (p: ExtractedPage, url: string, site: string, role: string) =>
  [
    `url: ${url}`,
    `competitor_site: ${site}`,
    `page_role: ${role}`,
    p.title && `title: ${p.title}`,
    p.description && `description: ${p.description}`,
    p.siteName && `site_name: ${p.siteName}`,
    p.headings.length && `headings: ${p.headings.slice(0, 14).join(' | ')}`,
    p.jsonLdTypes.length && `structured_data_types: ${p.jsonLdTypes.join(', ')}`,
    p.organization?.name && `declared_organization: ${p.organization.name}`,
    p.socialLinks.length && `social_links_on_page: ${p.socialLinks.map((l) => `${l.platform} ${l.url}`).join(' | ')}`,
    `text: ${p.text.slice(0, 2200)}`,
  ]
    .filter(Boolean)
    .join('\n');

const searchFailure = (e: unknown) => (e instanceof SearchError ? e.message : 'Search failed.');

export async function prepareCompetitor(env: F3Env, agent: PhaseAgent): Promise<F3Prep> {
  const { web, search, extract } = env.tools;
  const { settings, input } = env;
  const signal = agent.signal;
  const fixture = settings.fixtureSources;
  const pm = env.f1.report.productManifest;
  const names = (input.competitorNames ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  const facts: NonNullable<StrategyFacts['competitors']> = { provider: search.provider, searchUsed: false, queries: [], leads: [], userSupplied: input.competitorUrls.length, userNamed: names.length, notFoundNames: [], gaps: [], pagesRetrieved: 0, extractUsed: false };
  env.facts.competitors = facts;
  const blocks: string[] = [];
  const own = [hostKey(input.websiteUrl ?? ''), hostKey(pm.onlinePresence.website ?? '')];
  const fetchedHosts = new Set<string>();
  const country = countryCodeFor(input.geography) ?? undefined;
  const maxSites = settings.maxCompetitorPages;
  const perSite = settings.maxPagesPerCompetitor;
  let sites = 0;

  const recordPage = (r: Extract<ReadPageOutcome, { ok: true }>, site: string, role: string) => {
    const p = r.page;
    const text = pageBody(p, r.fetched.finalUrl, site, role);
    const notes = [...r.notes, ...(p.injectionSuspected ? ['Contains text that looks like instructions to an AI. Treated as data only.'] : []), `Competitor site ${site}: ${role} page${r.via === 'extract' ? ', read through the extraction provider' : ''}.`];
    const rec = addSource(env, agent, { kind: 'website', label: p.title ?? r.fetched.finalUrl, url: r.fetched.finalUrl, status: 'retrieved', live: true, fixture, origin: webOrigin(env), httpStatus: r.fetched.status, bytes: r.fetched.bytes, injectionSuspected: p.injectionSuspected, notes }, text);
    blocks.push(srcBlock(rec, text));
    facts.pagesRetrieved++;
    if (r.via === 'extract') facts.extractUsed = true;
    return rec;
  };

  /** Reads one competitor site: its home page, then up to `perSite - 1` relevant same-site pages (pricing, about, services). */
  const readSite = async (url: string, origin: CompetitorLead['origin'], title: string, snippet: string) => {
    const lead: CompetitorLead = { title, url, snippet, origin, fetched: false, sourceId: null, note: null, host: hostKey(url), pages: 0, via: null, socialPlatforms: [], structuredDataTypes: [] };
    facts.leads.push(lead);
    const home = await readPage(web, extract, url, signal);
    if (!home.ok) {
      lead.note = home.message;
      addSource(env, agent, { kind: 'website', label: url, url, status: 'failed', live: true, fixture, origin: webOrigin(env), httpStatus: home.status, error: home.message, notes: home.notes });
      facts.gaps.push(`${url}: ${home.message}`);
      return;
    }
    const site = hostKey(home.fetched.finalUrl) ?? lead.host ?? url;
    const rec = recordPage(home, site, 'home');
    Object.assign(lead, { fetched: true, sourceId: rec.id, host: site, pages: 1, via: home.via, title: home.page.title ?? title });
    sites++;
    fetchedHosts.add(site);
    const social = new Set(home.page.socialLinks.map((l) => l.platform));
    const structured = new Set(home.page.jsonLdTypes);
    for (const link of web.relevantLinks(home.page, home.fetched.finalUrl, Math.max(0, perSite - 1))) {
      if (signal.aborted) break;
      const sub = await readPage(web, extract, link, signal);
      if (!sub.ok) {
        addSource(env, agent, { kind: 'website', label: link, url: link, status: 'failed', live: true, fixture, origin: webOrigin(env), httpStatus: sub.status, error: sub.message, notes: sub.notes });
        continue;
      }
      recordPage(sub, site, pageRole(link));
      lead.pages++;
      for (const l of sub.page.socialLinks) social.add(l.platform);
      for (const t of sub.page.jsonLdTypes) structured.add(t);
    }
    lead.socialPlatforms = [...social];
    lead.structuredDataTypes = [...structured].slice(0, 8);
  };

  // 1. competitors the user named by URL come first (never invented)
  for (const u of input.competitorUrls) {
    if (sites >= maxSites || signal.aborted) break;
    const c = web.checkUrl(u);
    if (!c.ok) {
      facts.gaps.push(`${u}: the supplied competitor URL was rejected (${c.message}).`);
      addSource(env, agent, { kind: 'website', label: u, url: u, status: 'failed', origin: 'user_provided', error: c.message });
      continue;
    }
    await readSite(u, 'user_supplied', u, '');
  }

  // 2. competitors the user named: one bounded lookup each; a name that matches nothing is reported, never guessed
  if (names.length && !search.configured) {
    facts.gaps.push(`The named competitor(s) ${names.map((n) => `"${n}"`).join(', ')} could not be looked up: no search provider is configured. Add their website URLs instead.`);
    facts.notFoundNames.push(...names);
  }
  if (names.length && search.configured) {
    for (const name of names) {
      if (sites >= maxSites || signal.aborted) break;
      const q = namedCompetitorQuery(name, input.geography);
      facts.queries.push(q);
      let results: SearchResult[];
      try {
        results = await search.search(q, { maxResults: 5, language: input.language, country, signal });
        facts.searchUsed = true;
      } catch (e) {
        const msg = searchFailure(e);
        facts.gaps.push(`Web search failed while looking up "${name}": ${msg}`);
        addSource(env, agent, { kind: 'search_result', label: `Lookup: ${name}`, status: 'failed', live: true, fixture, origin: apiOrigin(env), error: msg });
        break;
      }
      const hit = pickNamed(name, results, [...own, ...fetchedHosts]);
      if (!hit) {
        facts.notFoundNames.push(name);
        facts.gaps.push(`"${name}": no website matching this name appeared in the search results, so it was not analyzed (add its URL to include it).`);
        continue;
      }
      const text = `${hit.title}\n${hit.url}\n${hit.snippet}`;
      const rec = addSource(env, agent, { kind: 'search_result', label: hit.title || hit.url, url: hit.url, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), notes: [`Search provider: ${search.provider}. Found by looking up the competitor name "${name}" supplied by the user. A snippet is a lead, not verification.`] }, text);
      blocks.push(srcBlock(rec, text));
      await readSite(hit.url, 'user_named', hit.title || name, hit.snippet);
    }
  }

  // 3. bounded category search (official provider only); results are LEADS
  if (search.configured && settings.maxSearches > 0 && sites < maxSites && !signal.aborted) {
    const queries = competitorQueries({ category: pm.category, offering: pm.offering.summary, geography: input.geography, maxQueries: settings.maxSearches, language: input.language });
    facts.queries.push(...queries);
    const all: SearchResult[] = [];
    let searched = 0;
    for (const q of queries) {
      if (signal.aborted) break;
      try {
        all.push(...(await search.search(q, { maxResults: 5, language: input.language, country, signal })));
        facts.searchUsed = true;
        searched++;
      } catch (e) {
        const msg = searchFailure(e);
        facts.gaps.push(`Web search failed: ${msg}`);
        addSource(env, agent, { kind: 'search_result', label: 'Competitor search', status: 'failed', live: true, fixture, origin: apiOrigin(env), error: msg });
        break;
      }
    }
    const candidates = pickCandidates(all, [...own, ...fetchedHosts], Math.max(0, maxSites - sites));
    for (const r of candidates) {
      const text = `${r.title}\n${r.url}\n${r.snippet}`;
      const rec = addSource(env, agent, { kind: 'search_result', label: r.title || r.url, url: r.url, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), notes: [`Search provider: ${search.provider}. A snippet is a lead, not verification.`] }, text);
      blocks.push(srcBlock(rec, text));
    }
    for (const r of candidates) {
      if (sites >= maxSites || signal.aborted) break;
      await readSite(r.url, 'search_lead', r.title, r.snippet);
    }
    if (searched && !all.length) facts.gaps.push('The search returned no results.');
    else if (searched && !candidates.length && sites < maxSites) facts.gaps.push('The search results contained no candidate competitor sites (only the business itself, directories or social networks).');
  } else if (!search.configured) {
    facts.gaps.push('No search provider is configured (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY), so no competitor search was performed.');
    addSource(env, agent, { kind: 'search_result', label: 'Competitor search', status: 'skipped', error: 'No search provider is configured. No search was performed.' });
  }
  if (!input.competitorUrls.length && !names.length) facts.gaps.push('No competitor URLs or names were supplied by the user.');

  if (!blocks.length) {
    return {
      kind: 'direct',
      reason: 'No competitor material could be retrieved: reported as insufficient research, without a model call.',
      output: {
        summary: 'There is not enough live research to identify competitors. No competitor is named, because naming one without a source would be invented.',
        findings: [gapFinding('Insufficient live competitor research', 'No competitor page or search result could be retrieved, so no competitor is named and no competitive positioning is claimed.', 'Add competitor website URLs or names to the project, or configure a search provider (TAVILY_API_KEY), and run the strategy again.')],
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
  return { kind: 'ready', message: scoutMessage(msgCtx(env), channel, decision, upstream, env.board.summaries, competitorPresenceBlock(env.facts.competitors)) };
}
