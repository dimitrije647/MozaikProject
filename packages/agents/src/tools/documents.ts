/**
 * Local text extraction for uploaded documents. A deterministic TOOL: no AI, no network.
 *
 * Safety: files are parsed, never executed. Macros, embedded scripts, links and commands inside
 * documents are ignored (DOCX macros are detected and reported but never run). Size, page count,
 * extracted-text size, parse time and number of files are all bounded.
 */
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export type DocFormat = 'pdf' | 'docx' | 'txt' | 'md' | 'json' | 'csv';

export interface DocumentInput {
  name: string;
  mimeType: string;
  size: number;
  /** Reads the stored bytes (already authorized by the caller). */
  load(): Promise<Buffer>;
}

export interface DocumentLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  parseTimeoutMs: number;
  maxPdfPages: number;
}

export const DEFAULT_DOC_LIMITS: DocumentLimits = {
  maxFiles: 5,
  maxFileBytes: 8 * 1024 * 1024,
  maxCharsPerFile: 20_000,
  maxTotalChars: 40_000,
  parseTimeoutMs: 15_000,
  maxPdfPages: 40,
};

export interface DocumentSection {
  /** "page 3", "rows 1-20", "chars 0-4000" */
  locator: string;
  text: string;
}

export interface ExtractedDocument {
  name: string;
  format: DocFormat | null;
  status: 'extracted' | 'unsupported' | 'failed' | 'skipped';
  /** Why a file is unsupported, failed or skipped. */
  reason: string | null;
  text: string;
  chars: number;
  truncated: boolean;
  pages: number | null;
  sections: DocumentSection[];
  notes: string[];
}

const EXT: Record<string, DocFormat> = { pdf: 'pdf', docx: 'docx', txt: 'txt', md: 'md', markdown: 'md', json: 'json', csv: 'csv' };

export function detectFormat(name: string): DocFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXT[ext] ?? null;
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
const looksBinary = (b: Buffer) => b.subarray(0, 2000).includes(0);

const empty = (name: string, format: DocFormat | null, status: ExtractedDocument['status'], reason: string | null): ExtractedDocument => ({
  name,
  format,
  status,
  reason,
  text: '',
  chars: 0,
  truncated: false,
  pages: null,
  sections: [],
  notes: [],
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export class DocumentExtractionTool {
  constructor(private readonly limits: DocumentLimits = DEFAULT_DOC_LIMITS) {}

  async extractAll(inputs: DocumentInput[], signal?: AbortSignal): Promise<ExtractedDocument[]> {
    const out: ExtractedDocument[] = [];
    let total = 0;
    for (const [i, input] of inputs.entries()) {
      if (signal?.aborted) break;
      if (i >= this.limits.maxFiles) {
        out.push(empty(input.name, detectFormat(input.name), 'skipped', `Only the first ${this.limits.maxFiles} documents are analyzed per run.`));
        continue;
      }
      if (total >= this.limits.maxTotalChars) {
        out.push(empty(input.name, detectFormat(input.name), 'skipped', 'The total text limit for this run was reached.'));
        continue;
      }
      const doc = await this.extractOne(input, this.limits.maxTotalChars - total);
      total += doc.chars;
      out.push(doc);
    }
    return out;
  }

  async extractOne(input: DocumentInput, charBudget = this.limits.maxCharsPerFile): Promise<ExtractedDocument> {
    const format = detectFormat(input.name);
    if (!format) return empty(input.name, null, 'unsupported', 'Unsupported file type. Supported: PDF, DOCX, TXT, Markdown, JSON, CSV.');
    if (input.size > this.limits.maxFileBytes) return empty(input.name, format, 'skipped', `File is larger than ${Math.round(this.limits.maxFileBytes / 1024 / 1024)} MB.`);

    let buf: Buffer;
    try {
      buf = await input.load();
    } catch {
      return empty(input.name, format, 'failed', 'The stored file could not be read.');
    }
    if (buf.length > this.limits.maxFileBytes) return empty(input.name, format, 'skipped', 'File is too large.');

    const cap = Math.min(this.limits.maxCharsPerFile, charBudget);
    try {
      const raw = await withTimeout(this.parse(format, buf), this.limits.parseTimeoutMs);
      const full = raw.sections.map((s) => s.text).join('\n\n').trim();
      if (!full) return { ...empty(input.name, format, 'failed', 'No readable text was found (it may be scanned or image-only).'), pages: raw.pages, notes: raw.notes };
      // Trim sections to the character budget, keeping their locators.
      let used = 0;
      const sections: DocumentSection[] = [];
      let truncated = false;
      for (const s of raw.sections) {
        if (used >= cap) {
          truncated = true;
          break;
        }
        const take = s.text.slice(0, cap - used);
        if (take.length < s.text.length) truncated = true;
        if (take.trim()) sections.push({ locator: s.locator, text: take });
        used += take.length;
      }
      const text = sections.map((s) => s.text).join('\n\n');
      return { name: input.name, format, status: 'extracted', reason: null, text, chars: text.length, truncated: truncated || raw.truncated, pages: raw.pages, sections, notes: raw.notes };
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'timeout') return empty(input.name, format, 'failed', 'Parsing took too long and was stopped.');
      if (msg === 'mismatch') return empty(input.name, format, 'failed', `The file content does not match its .${format} extension.`);
      return empty(input.name, format, 'failed', 'The file could not be parsed (corrupt, encrypted or unsupported content).');
    }
  }

  private async parse(format: DocFormat, buf: Buffer): Promise<{ sections: DocumentSection[]; pages: number | null; truncated: boolean; notes: string[] }> {
    switch (format) {
      case 'pdf': {
        if (!isPdf(buf)) throw new Error('mismatch');
        const res = await parsePdfInWorker(buf, this.limits.maxPdfPages, this.limits.parseTimeoutMs);
        const pages = res.pages;
        return {
          sections: pages.map((t, i) => ({ locator: `page ${i + 1}`, text: t })).filter((s) => s.text),
          pages: res.numpages,
          truncated: res.numpages > this.limits.maxPdfPages,
          notes: res.numpages > this.limits.maxPdfPages ? [`Only the first ${this.limits.maxPdfPages} of ${res.numpages} pages were read.`] : [],
        };
      }
      case 'docx': {
        if (!isZip(buf)) throw new Error('mismatch');
        const notes: string[] = [];
        if (buf.includes(Buffer.from('vbaProject.bin'))) notes.push('The file contains macros. They were NOT executed and are ignored.');
        const mammoth = (await import('mammoth')) as unknown as { extractRawText(o: { buffer: Buffer }): Promise<{ value: string }> };
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return { sections: chunk(value, 'chars'), pages: null, truncated: false, notes };
      }
      case 'json': {
        if (looksBinary(buf)) throw new Error('mismatch');
        const text = decodeText(buf);
        try {
          return { sections: chunk(JSON.stringify(JSON.parse(text), null, 1), 'chars'), pages: null, truncated: false, notes: [] };
        } catch {
          return { sections: chunk(text, 'chars'), pages: null, truncated: false, notes: ['Not valid JSON; read as plain text.'] };
        }
      }
      case 'csv': {
        if (looksBinary(buf)) throw new Error('mismatch');
        const lines = decodeText(buf).split(/\r?\n/).filter((l) => l.trim());
        const head = lines.slice(0, 41);
        return {
          sections: [{ locator: `rows 1-${head.length}`, text: head.join('\n') }],
          pages: null,
          truncated: lines.length > head.length,
          notes: [`${lines.length} non-empty rows in total (header included); the first ${head.length} are read.`],
        };
      }
      default: {
        if (looksBinary(buf)) throw new Error('mismatch');
        return { sections: chunk(decodeText(buf), 'chars'), pages: null, truncated: false, notes: [] };
      }
    }
  }
}

/**
 * PDFs are the riskiest input (complex binary format, old parser), so each one is parsed in its OWN
 * worker thread: a fresh parser per file (pdf-parse keeps state between calls in one process), a
 * memory cap, and a hard kill on timeout instead of a promise we merely stop waiting for.
 */
const PDF_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
// pdf.js unconditionally require()s the NATIVE addon @napi-rs/canvas when it is imported in Node (it is only needed to
// render pages, never to read text). Loading a native addon inside a worker thread crashed the whole process with an
// access violation (0xC0000005) when the thread exited under load. So the addon is made unloadable here.
const Module = require('node:module');
const realCreateRequire = Module.createRequire;
Module.createRequire = (...args) => {
  const real = realCreateRequire(...args);
  const guarded = (id) => {
    if (id === '@napi-rs/canvas') throw new Error('disabled: text extraction does not need a canvas');
    return real(id);
  };
  return Object.assign(guarded, real);
};
(async () => {
  try {
    const log = console.log;
    console.log = () => {};
    let pdfjs;
    try {
      pdfjs = await import(workerData.lib);
    } finally {
      console.log = log;
    }
    // isEvalSupported:false closes the known "font eval" code-execution hole in older pdf.js builds.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(workerData.buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
    const pages = [];
    const limit = Math.min(doc.numPages, workerData.max);
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim());
    }
    const numpages = doc.numPages;
    await doc.destroy();
    parentPort.postMessage({ ok: true, numpages, pages });
  } catch (e) {
    parentPort.postMessage({ ok: false, message: String(e && e.message) });
  }
})();
`;

function parsePdfInWorker(buf: Buffer, max: number, timeoutMs: number): Promise<{ numpages: number; pages: string[] }> {
  return new Promise((resolve, reject) => {
    const lib = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    const worker = new Worker(PDF_WORKER, { eval: true, workerData: { lib, buf, max }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('timeout'));
    }, timeoutMs);
    // The worker is left to EXIT ON ITS OWN after answering: terminating it while pdf.js still has native work in flight
    // (WASM decoders) crashed the whole process with an access violation under heavy load. Only a worker that does not
    // exit within a grace period is terminated.
    const done = (fn: () => void, graceful = false) => {
      clearTimeout(timer);
      if (graceful) {
        const grace = setTimeout(() => void worker.terminate(), 3000);
        grace.unref();
        worker.once('exit', () => clearTimeout(grace));
      } else void worker.terminate();
      fn();
    };
    worker.once('message', (m: { ok: boolean; numpages: number; pages: string[]; message?: string }) => done(() => (m.ok ? resolve(m) : reject(new Error('parse'))), true));
    worker.once('error', (e) => done(() => reject(e)));
  });
}

const decodeText = (b: Buffer) => b.toString('utf8').replace(/^﻿/, '');

function chunk(text: string, unit: string, size = 4000): DocumentSection[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  const out: DocumentSection[] = [];
  for (let i = 0; i < t.length; i += size) out.push({ locator: `${unit} ${i}-${Math.min(i + size, t.length)}`, text: t.slice(i, i + size) });
  return out;
}
