import { extractPage, pageFromText, type ExtractedPage } from './html';
import type { WebExtractTool } from './web-extract';
import type { FetchFailureCode, WebFetchTool } from './web-fetch';

/**
 * Reads one public page for an agent: the SSRF-safe fetcher first; when the served HTML is a JavaScript shell with
 * almost no text, or the site answers with a bot challenge, the rendered text is requested from the extraction
 * provider (if one is configured). A page that robots.txt disallows is never read either way. Every outcome says
 * HOW the page was read, so the source record and the agent can state it.
 */
export type ReadVia = 'html' | 'extract';

export interface ReadFetched {
  finalUrl: string;
  /** null when the text came from the extraction provider after the fetcher was refused. */
  status: number | null;
  bytes: number | null;
  truncated: boolean;
}

export type ReadPageOutcome =
  | { ok: true; page: ExtractedPage; fetched: ReadFetched; via: ReadVia; notes: string[] }
  | { ok: false; code: FetchFailureCode; status: number | null; message: string; notes: string[] };

const MIN_RENDERED_CHARS = 200;

export async function readPage(web: WebFetchTool, extract: WebExtractTool, url: string, signal?: AbortSignal): Promise<ReadPageOutcome> {
  const r = await web.fetchHtml(url, signal);
  if (r.ok) {
    const { page, result } = r;
    const fetched: ReadFetched = { finalUrl: result.finalUrl, status: result.status, bytes: result.bytes, truncated: result.truncated };
    if (!page.likelyJsRendered) return { ok: true, page, fetched, via: 'html', notes: [] };
    const shell = 'The served HTML has almost no visible text: the page is a JavaScript application.';
    if (!extract.configured) return { ok: true, page, fetched, via: 'html', notes: [`${shell} No rendering provider is configured (TAVILY_API_KEY), so only what the server sent was read.`] };
    const e = await extract.extract(result.finalUrl, { signal });
    if (!e.ok) return { ok: true, page, fetched, via: 'html', notes: [`${shell} The rendered text could not be obtained (${e.message}), so only what the server sent was read.`] };
    const rendered = pageFromText(e.text, result.finalUrl);
    if (rendered.text.length < MIN_RENDERED_CHARS) return { ok: true, page, fetched, via: 'html', notes: [`${shell} The rendering provider returned almost no text either, so only what the server sent was read.`] };
    const merged: ExtractedPage = {
      ...page,
      text: rendered.text,
      headings: page.headings.length ? page.headings : rendered.headings,
      title: page.title ?? rendered.title,
      socialLinks: page.socialLinks.length ? page.socialLinks : rendered.socialLinks,
      likelyJsRendered: false,
      injectionSuspected: page.injectionSuspected || rendered.injectionSuspected,
      injectionSamples: [...page.injectionSamples, ...rendered.injectionSamples].slice(0, 3),
    };
    return { ok: true, page: merged, fetched: { ...fetched, truncated: fetched.truncated || e.truncated }, via: 'extract', notes: [`${shell} The rendered text was obtained through the ${e.provider} extraction API.`] };
  }
  const f = r.result;
  if (f.code === 'bot_protected' && extract.configured) {
    const e = await extract.extract(url, { signal });
    if (e.ok) {
      const page = pageFromText(e.text, url);
      if (page.text.length >= MIN_RENDERED_CHARS) {
        return { ok: true, page, fetched: { finalUrl: e.url || url, status: null, bytes: null, truncated: e.truncated }, via: 'extract', notes: [`${f.message} The page text was obtained through the ${e.provider} extraction API instead; HTTP details are unknown.`] };
      }
    }
    return { ok: false, code: f.code, status: f.status ?? null, message: f.message, notes: [e.ok ? 'The extraction API returned almost no text.' : `The extraction API could not read it either (${e.message}).`] };
  }
  return { ok: false, code: f.code, status: f.status ?? null, message: f.message, notes: [] };
}
