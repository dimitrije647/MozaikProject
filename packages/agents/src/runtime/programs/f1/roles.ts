import type { SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { researcherMessage, sourceBlock } from '../../../discovery/f1/prompts';
import type { ExtractedPage } from '../../../tools/html';
import { readPage } from '../../../tools/page-reader';
import { SearchError } from '../../../tools/web-search';
import type { F1Agent } from './agent';
import type { F1Env } from './env';

/**
 * The deterministic "gather" steps of the Business Researcher. Tools (HTTP, GitHub API, parsers) do the retrieval; the model only
 * ever sees the compact, delimited result. Every retrieval is published as a `source.retrieved` event, success or failure, so the UI
 * shows exactly what was and was not read. A source that fails is a note, never fatal on its own.
 */
export type Prep =
  | { kind: 'ready'; message: string; images?: { mediaType: string; base64: string }[] }
  | { kind: 'fail'; error: SafeProviderError };

/** What one gather step contributed: evidence blocks for the model and notes on what could not be read. */
interface Gathered {
  blocks: string[];
  notes: string[];
}

type NewSource = Pick<SourceRecord, 'kind' | 'label' | 'status'> & Partial<Omit<SourceRecord, 'id' | 'retrievedAt' | 'excerpt' | 'chars'>>;

function addSource(env: F1Env, agent: F1Agent, rec: NewSource, text?: string): SourceRecord {
  const r = env.store.add(
    { live: false, fixture: false, url: null, httpStatus: null, bytes: null, error: null, producer: agent.name, ...rec },
    text,
  );
  env.ctx.emit('source.retrieved', { agent: agent.name, source: r }, agent.participant);
  return r;
}

const pageBody = (p: ExtractedPage, cap: number) =>
  [
    p.title && `title: ${p.title}`,
    p.description && `description: ${p.description}`,
    p.siteName && `site_name: ${p.siteName}`,
    p.lang && `lang: ${p.lang}`,
    p.headings.length && `headings: ${p.headings.slice(0, 20).join(' | ')}`,
    p.jsonLdTypes.length && `structured_data_types: ${p.jsonLdTypes.join(', ')}`,
    p.organization?.name && `declared_organization: ${p.organization.name}`,
    p.socialLinks.length && `social_links_on_page: ${p.socialLinks.map((l) => `${l.platform} ${l.url}`).join(' | ')}`,
    `text: ${p.text.slice(0, cap)}`,
  ]
    .filter(Boolean)
    .join('\n');

async function gatherWeb(env: F1Env, agent: F1Agent): Promise<Gathered> {
  const { web, search, extract } = env.tools;
  const signal = agent.signal;
  const fixture = env.settings.fixtureSources;
  const url = env.input.availableSources.websiteUrl!;
  const blocks: string[] = [];
  const notes: string[] = [];
  let pages = 0;

  const fetchOne = async (target: string, cap: number) => {
    const res = await readPage(web, extract, target, signal);
    if (!res.ok) {
      addSource(env, agent, { kind: 'website', label: target, url: target, status: 'failed', live: true, fixture, httpStatus: res.status, error: res.message, notes: res.notes });
      notes.push(`${target}: ${res.message}`);
      return null;
    }
    const { page, fetched } = res;
    const rec = addSource(
      env,
      agent,
      {
        kind: 'website',
        label: page.title ?? fetched.finalUrl,
        url: fetched.finalUrl,
        status: 'retrieved',
        live: true,
        fixture,
        httpStatus: fetched.status,
        bytes: fetched.bytes,
        injectionSuspected: page.injectionSuspected,
        notes: [...res.notes, ...(fetched.truncated ? ['Page was larger than the size limit and was truncated.'] : []), ...(page.injectionSuspected ? ['Contains text that looks like instructions to an AI. Treated as data only.'] : [])],
      },
      `${pageBody(page, 12_000)}`,
    );
    blocks.push(sourceBlock(rec, pageBody(page, cap)));
    pages++;
    return { page, finalUrl: fetched.finalUrl };
  };

  const home = await fetchOne(url, 3500);
  if (home) {
    const links = web.relevantLinks(home.page, home.finalUrl, Math.max(0, Math.min(3, env.settings.maxWebPages - 1)));
    for (const link of links) {
      if (signal.aborted) break;
      await fetchOne(link, 2500);
    }
  }

  // Search (optional, only with a configured official provider). Results are leads, never verification.
  // Two bounded queries: what the search engine shows for the business, and mentions OUTSIDE its own site.
  if (search.configured) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    const name = (env.input.intake?.productName ?? env.input.project.name).trim();
    const seen = new Set<string>();
    const runQuery = async (query: string, options: { excludeDomains?: string[] }, note: string) => {
      const results = await search.search(query, { maxResults: 5, language: env.input.language, signal, ...options });
      let added = 0;
      for (const r of results) {
        const key = r.url.replace(/\/$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const text = `${r.title}\n${r.url}\n${r.snippet}`;
        const rec = addSource(env, agent, { kind: 'search_result', label: r.title || r.url, url: r.url, status: 'retrieved', live: true, fixture, notes: [`Search provider: ${search.provider}. ${note} A snippet is a lead, not verification.`] }, text);
        blocks.push(sourceBlock(rec, text));
        added++;
      }
      return added;
    };
    try {
      const first = await runQuery(`${name} ${host}`.trim(), {}, 'Query: the business name and its domain.');
      const mentions = host ? await runQuery(`"${name}"`, { excludeDomains: [host] }, `Query: mentions of the business name on sites other than ${host}.`) : 0;
      if (!first && !mentions) notes.push('The search returned no results.');
    } catch (e) {
      const msg = e instanceof SearchError ? e.message : 'Search failed.';
      addSource(env, agent, { kind: 'search_result', label: 'Web search', status: 'failed', live: true, fixture, error: msg });
      notes.push(`Web search failed: ${msg}`);
    }
  } else {
    addSource(env, agent, { kind: 'search_result', label: 'Web search', status: 'skipped', error: 'No search provider is configured (set TAVILY_API_KEY). No general web search was performed.' });
  }

  if (pages) notes.unshift(`Retrieved ${pages} page(s) of the website.`);
  return { blocks, notes };
}

async function gatherRepo(env: F1Env, agent: F1Agent): Promise<Gathered> {
  const fixture = env.settings.fixtureSources;
  const url = env.input.availableSources.githubUrl!;
  const res = await env.tools.github.inspect(url, agent.signal);
  if (!res.ok) {
    addSource(env, agent, { kind: 'repository', label: url, url, status: 'failed', live: true, fixture, error: res.message });
    return { blocks: [], notes: [`Repository ${url}: ${res.message}`] };
  }
  const s = res.snapshot;
  const totalBytes = Object.values(s.languages).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(s.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k} ${Math.round((v / totalBytes) * 100)}%`)
    .join(', ');
  const meta = [
    `repository: ${s.fullName}`,
    `description: ${s.description ?? '(none)'}`,
    s.homepage && `homepage: ${s.homepage}`,
    `topics: ${s.topics.join(', ') || '(none)'}`,
    `license: ${s.license ?? '(none)'}`,
    `stars: ${s.stars ?? 'n/a'}; archived: ${s.archived}; last push: ${s.pushedAt ?? 'n/a'}`,
    `default branch: ${s.defaultBranch}`,
    `languages: ${langs || '(not available)'}`,
    `top-level entries: ${s.topLevel.map((e) => `${e.name}${e.type === 'dir' ? '/' : ''}`).join(', ') || '(not available)'}`,
    `file paths${s.pathsTruncated ? ' (truncated list)' : ''}:\n${s.paths.slice(0, 120).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
  const common = { live: true, fixture, url: s.url, httpStatus: 200 } as const;
  const blocks: string[] = [];
  const metaRec = addSource(env, agent, { kind: 'repository', label: `${s.fullName} (metadata and structure)`, status: 'retrieved', ...common }, meta);
  blocks.push(sourceBlock(metaRec, meta));
  if (s.readme) {
    const rec = addSource(env, agent, { kind: 'repository', label: `${s.readme.path} (README)`, status: 'retrieved', ...common, notes: s.readme.truncated ? ['README truncated.'] : [] }, s.readme.text);
    blocks.push(sourceBlock(rec, s.readme.text.slice(0, 5000)));
  }
  for (const m of s.manifests) {
    const rec = addSource(env, agent, { kind: 'repository', label: m.path, status: 'retrieved', ...common }, m.text);
    blocks.push(sourceBlock(rec, m.text.slice(0, 1500)));
  }
  const notes = [`Repository inspected through the official GitHub API (${s.apiCalls} calls). Nothing was cloned or executed.${s.incomplete.length ? ` Not retrieved (do not guess): ${s.incomplete.join(', ')}.` : ''}`];
  return { blocks, notes };
}

async function gatherFiles(env: F1Env, agent: F1Agent): Promise<Gathered> {
  const docs = await env.tools.documents.extractAll(env.documents, agent.signal);
  const blocks: string[] = [];
  const problems: string[] = [];
  for (const d of docs) {
    if (d.status !== 'extracted') {
      addSource(env, agent, { kind: 'document', label: d.name, status: d.status === 'failed' ? 'failed' : d.status === 'unsupported' ? 'unsupported' : 'skipped', error: d.reason });
      problems.push(`${d.name}: ${d.reason}`);
      continue;
    }
    const full = d.sections.map((s) => `[${s.locator}]\n${s.text}`).join('\n');
    const rec = addSource(env, agent, { kind: 'document', label: d.name, status: 'retrieved', notes: [...d.notes, ...(d.truncated ? ['Text was truncated to the size limit.'] : [])] }, full);
    blocks.push(sourceBlock(rec, `file: ${d.name}\nformat: ${d.format}${d.pages ? `\npages: ${d.pages}` : ''}\n${full.slice(0, 6000)}`));
  }
  return { blocks, notes: problems.map((p) => `Document not read: ${p}`) };
}

interface PreparedImages {
  images: { mediaType: string; base64: string }[];
  meta: { name: string; kind: string; width: number; height: number; palette: { hex: string; share: number }[] }[];
  notes: string[];
}

async function gatherImages(env: F1Env, agent: F1Agent): Promise<PreparedImages> {
  const results = await env.tools.images.prepareAll(env.images, agent.signal);
  const prepared = results.filter((r) => r.prepared).map((r) => r.prepared!);
  for (const r of results) {
    if (r.prepared) {
      const p = r.prepared;
      addSource(env, agent, { kind: 'image', label: p.name, status: 'retrieved', notes: [`Resized ${p.originalWidth}x${p.originalHeight} to ${p.width}x${p.height}; metadata removed.`] }, `${p.name}: measured palette ${p.palette.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ')}`);
    } else {
      addSource(env, agent, { kind: 'image', label: r.name, status: r.status === 'skipped' ? 'skipped' : 'failed', error: r.reason });
    }
  }
  const notes = results.filter((r) => !r.prepared).map((r) => `Image ${r.name} not used: ${r.reason}`);
  if (prepared.length) env.palette = [...new Set(prepared.flatMap((p) => p.palette.map((c) => c.hex)))].slice(0, 6);
  return { images: prepared.map((p) => ({ mediaType: p.mimeType, base64: p.base64 })), meta: prepared, notes };
}

/** Which gather steps run (decided by planF1 from what the user supplied). The project input is always analyzed. */
export interface ResearchSteps {
  web: boolean;
  repo: boolean;
  files: boolean;
  images: boolean;
}

/**
 * Runs every activated gather step one after the other (each publishes its own sources) and builds the ONE analysis message.
 * The project input can always be analyzed, so it fails only when the task was stopped (deadline or cancellation) while retrieving.
 */
export async function prepareResearch(env: F1Env, agent: F1Agent, steps: ResearchSteps): Promise<Prep> {
  const blocks: string[] = [];
  const notes: string[] = [];
  const take = (g: Gathered) => {
    blocks.push(...g.blocks);
    notes.push(...g.notes);
  };
  if (steps.web) take(await gatherWeb(env, agent));
  if (steps.repo && !agent.signal.aborted) take(await gatherRepo(env, agent));
  if (steps.files && !agent.signal.aborted) take(await gatherFiles(env, agent));
  const pictures: PreparedImages = steps.images && !agent.signal.aborted ? await gatherImages(env, agent) : { images: [], meta: [], notes: [] };
  notes.push(...pictures.notes);
  if (agent.signal.aborted) return { kind: 'fail', error: { code: 'cancelled', message: 'The research was stopped before the analysis.' } };
  return { kind: 'ready', message: researcherMessage(env.input, blocks, { notes, images: pictures.meta }), images: pictures.images.length ? pictures.images : undefined };
}
