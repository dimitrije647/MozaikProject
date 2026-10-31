import type { SafeProviderError } from '../../../ai/errors';
import type { SourceRecord } from '../../../discovery/f1/board';
import { evidenceMessage, inputAnalyzerMessage, sourceBlock, textAnalyzerMessage, visualMessage } from '../../../discovery/f1/prompts';
import type { ExtractedPage } from '../../../tools/html';
import { SearchError } from '../../../tools/web-search';
import type { F1Agent } from './agent';
import type { F1Env } from './env';

/**
 * The deterministic "gather" step of each analyst. Tools (HTTP, GitHub API, parsers) do the retrieval;
 * the model only ever sees the compact, delimited result. Every retrieval is published as a
 * `source.retrieved` event, success or failure, so the UI shows exactly what was and was not read.
 */
export type Prep =
  | { kind: 'ready'; message: string; images?: { mediaType: string; base64: string }[] }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; error: SafeProviderError };

const fail = (message: string): Prep => ({ kind: 'fail', error: { code: 'source_unavailable', message } });

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
    `text: ${p.text.slice(0, cap)}`,
  ]
    .filter(Boolean)
    .join('\n');

export async function prepareInput(env: F1Env): Promise<Prep> {
  return { kind: 'ready', message: inputAnalyzerMessage(env.input) };
}

export async function prepareText(env: F1Env): Promise<Prep> {
  return { kind: 'ready', message: textAnalyzerMessage(env.input) };
}

export async function prepareWeb(env: F1Env, agent: F1Agent): Promise<Prep> {
  const { web, search } = env.tools;
  const signal = agent.signal;
  const fixture = env.settings.fixtureSources;
  const url = env.input.availableSources.websiteUrl!;
  const blocks: string[] = [];
  const notes: string[] = [];
  let pages = 0;

  const fetchOne = async (target: string, cap: number) => {
    const res = await web.fetchHtml(target, signal);
    if (!res.ok) {
      addSource(env, agent, { kind: 'website', label: target, url: target, status: 'failed', live: true, fixture, httpStatus: res.result.status ?? null, error: res.result.message });
      notes.push(`${target}: ${res.result.message}`);
      return null;
    }
    const { page, result } = res;
    const rec = addSource(
      env,
      agent,
      { kind: 'website', label: page.title ?? result.finalUrl, url: result.finalUrl, status: 'retrieved', live: true, fixture, httpStatus: result.status, bytes: result.bytes, injectionSuspected: page.injectionSuspected, notes: [...(result.truncated ? ['Page was larger than the size limit and was truncated.'] : []), ...(page.injectionSuspected ? ['Contains text that looks like instructions to an AI. Treated as data only.'] : [])] },
      `${pageBody(page, 12_000)}`,
    );
    blocks.push(sourceBlock(rec, pageBody(page, cap)));
    pages++;
    return { page, finalUrl: result.finalUrl };
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
  if (search.configured) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    try {
      const results = await search.search(`${env.input.intake?.productName ?? env.input.project.name} ${host}`.trim(), { maxResults: 5, language: env.input.language, signal });
      for (const r of results) {
        const text = `${r.title}\n${r.url}\n${r.snippet}`;
        const rec = addSource(env, agent, { kind: 'search_result', label: r.title || r.url, url: r.url, status: 'retrieved', live: true, fixture, notes: [`Search provider: ${search.provider}. A snippet is a lead, not verification.`] }, text);
        blocks.push(sourceBlock(rec, text));
      }
      if (!results.length) notes.push('The search returned no results.');
    } catch (e) {
      const msg = e instanceof SearchError ? e.message : 'Search failed.';
      addSource(env, agent, { kind: 'search_result', label: 'Web search', status: 'failed', live: true, fixture, error: msg });
      notes.push(`Web search failed: ${msg}`);
    }
  } else {
    addSource(env, agent, { kind: 'search_result', label: 'Web search', status: 'skipped', error: 'No search provider is configured (set TAVILY_API_KEY). No general web search was performed.' });
  }

  if (!blocks.length) return fail(`The website could not be retrieved and no search results are available. ${notes[0] ?? ''}`.trim());
  const extra = `Retrieved ${pages} page(s) of the website.${notes.length ? `\nRetrieval problems (do not guess what these contained):\n- ${notes.join('\n- ')}` : ''}`;
  return { kind: 'ready', message: evidenceMessage('Web Analyzer', env.input, blocks, extra) };
}

export async function prepareRepo(env: F1Env, agent: F1Agent): Promise<Prep> {
  const fixture = env.settings.fixtureSources;
  const url = env.input.availableSources.githubUrl!;
  const res = await env.tools.github.inspect(url, agent.signal);
  if (!res.ok) {
    addSource(env, agent, { kind: 'repository', label: url, url, status: 'failed', live: true, fixture, error: res.message });
    return fail(res.message);
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
  const extra = `Repository inspected through the official GitHub API (${s.apiCalls} calls). Nothing was cloned or executed.${s.incomplete.length ? `\nNot retrieved (do not guess): ${s.incomplete.join(', ')}.` : ''}`;
  return { kind: 'ready', message: evidenceMessage('Repo Analyzer', env.input, blocks, extra) };
}

export async function prepareFiles(env: F1Env, agent: F1Agent): Promise<Prep> {
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
  if (!blocks.length) return problems.length ? fail(`No uploaded document could be read. ${problems[0]}`) : { kind: 'skip', reason: 'No readable documents.' };
  const extra = problems.length ? `Documents that could not be read (do not guess their content):\n- ${problems.join('\n- ')}` : '';
  return { kind: 'ready', message: evidenceMessage('File Analyzer', env.input, blocks, extra) };
}

export async function prepareVisual(env: F1Env, agent: F1Agent): Promise<Prep> {
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
  if (!prepared.length) {
    const failed = results.find((r) => r.status === 'failed');
    return failed ? fail(`No image could be processed. ${failed.reason}`) : { kind: 'skip', reason: results[0]?.reason ?? 'No usable images.' };
  }
  env.palette = [...new Set(prepared.flatMap((p) => p.palette.map((c) => c.hex)))].slice(0, 6);
  return {
    kind: 'ready',
    message: visualMessage(env.input, prepared),
    images: prepared.map((p) => ({ mediaType: p.mimeType, base64: p.base64 })),
  };
}
