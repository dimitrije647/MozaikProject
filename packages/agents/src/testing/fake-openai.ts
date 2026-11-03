import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultAuditAnalysis, defaultAuditReport } from './fake-audit';
import { defaultStrategyAnalysis, defaultStrategyDraft } from './fake-strategy';
import { defaultDirectionRefinement, defaultTemplatePicks, defaultConceptCritique, defaultCopy, defaultCopyRevision, defaultCreativeReview, defaultLanding, defaultLandingRevision, defaultVisual, fakeImageBase64 } from './fake-creative';
import { parseSources } from './prompt-parse';

export { parseSources, type PromptSource } from './prompt-parse';
import type { AgentOutput, CrosscheckAnswer, LlmFinding, ProductDiscoveryReportV2, ReportStatement } from '../discovery/f1/schemas';

/**
 * A local fake of the OpenAI HTTP API (POST /v1/responses, GET /v1/models) for automated tests.
 * It speaks real HTTP, so the whole pipeline (Mozaik agent loop, gateway, mapper, HTTP client,
 * timeouts, aborts, image attachments) runs for real while no network call to OpenAI is made and
 * nothing is billed. Default answers are valid for the F1 schemas and are built from the prompt the
 * request actually carried, so they cite real source ids and excerpts.
 */
export type FakeAgent = 'input' | 'text' | 'web' | 'repo' | 'files' | 'visual' | 'synthesizer' | 'seo' | 'social' | 'brand' | 'messaging' | 'presence' | 'auditor' | 'audience' | 'competitor' | 'seasonal' | 'scout' | 'strategist' | 'copywriter' | 'landing' | 'vcreator' | 'creviewer' | 'vresearcher' | 'tselector' | 'image' | 'other';
export type FakeKind = 'analysis' | 'review' | 'synthesis' | 'test' | 'image';

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string;
  body: Record<string, any> | null;
  agent: FakeAgent;
  kind: FakeKind;
  /** Number of requests seen so far for this agent+kind (1-based), including this one. */
  attempt: number;
  /** Set when the client closed the connection before we answered (an aborted request). */
  aborted: boolean;
  /** Text of every user message in the request (joined). */
  userText: string;
  /** Text of the LAST user message only (what the agent is being asked right now). */
  lastUserText: string;
  /** Number of image parts attached to the request. */
  images: number;
  /** For Channel Scouts: the channel id from the system instruction. */
  channel: string | null;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  /** Assistant text for a 200 reply (usually a JSON document). */
  text?: string;
  delayMs?: number;
  headers?: Record<string, string>;
  usage?: { input: number; output: number; reasoning?: number };
  /** Never answer (to test timeouts and cancellation). */
  hang?: boolean;
}

export interface FakeOpenAIOptions {
  /** Return undefined to fall back to the default (valid) reply. */
  reply?: (req: FakeRequest) => FakeReply | undefined | Promise<FakeReply | undefined>;
  /** If set, any other key gets a 401 whose body echoes the (fake) key, like the real API does. */
  validKeys?: string[];
  models?: string[];
}

const ROLE_MARKERS: [string, FakeAgent][] = [
  ['You are the Input Analyzer', 'input'],
  ['You are the Text Analyzer', 'text'],
  ['You are the Web Analyzer', 'web'],
  ['You are the Repo Analyzer', 'repo'],
  ['You are the File Analyzer', 'files'],
  ['You are the Visual Analyzer', 'visual'],
  ['You are the Product Synthesizer', 'synthesizer'],
  ['You are the SEO Auditor', 'seo'],
  ['You are the Social Media Auditor', 'social'],
  ['You are the Brand Auditor', 'brand'],
  ['You are the Messaging Auditor', 'messaging'],
  ['You are the Presence Auditor', 'presence'],
  ['You are the Audit Synthesizer', 'auditor'],
  ['You are the Audience Researcher', 'audience'],
  ['You are the Competitor Researcher', 'competitor'],
  ['You are Seasonal Intelligence', 'seasonal'],
  ['Scout (A16)', 'scout'],
  ['You are the Campaign Strategist', 'strategist'],
  ['You are the Copywriter (A19)', 'copywriter'],
  ['You are the Landing Content Builder (A22)', 'landing'],
  ['You are the Visual Creator (A20)', 'vcreator'],
  ['You are the Content & Brand Reviewer (A23)', 'creviewer'],
  ['You are the Visual Researcher of a marketing team', 'vresearcher'],
  ['You are the Template Selector of a marketing team', 'tselector'],
];

const items = (body: Record<string, any> | null): any[] => (Array.isArray(body?.input) ? body!.input : []);
const textOf = (item: any): string => (Array.isArray(item?.content) ? item.content.map((c: any) => c?.text ?? '').join('') : '');

export function identifyAgent(body: Record<string, any> | null): FakeAgent {
  const system = textOf(items(body)[0]);
  return ROLE_MARKERS.find(([m]) => system.includes(m))?.[1] ?? 'other';
}

export function userMessages(body: Record<string, any> | null): string[] {
  return items(body).filter((i) => i?.role === 'user').map(textOf);
}

function countImages(body: Record<string, any> | null): number {
  return items(body).reduce((n, i) => n + (Array.isArray(i?.content) ? i.content.filter((c: any) => c?.type === 'input_image').length : 0), 0);
}

// ---- parsing what the prompt carried -----------------------------------------------------------

/** The first line that has real content (not a locator marker or a "key:" label alone). */
const contentLine = (text: string, minLen = 12) =>
  text
    .split('\n')
    .map((l) => l.replace(/^(title|description|text|file|format|repository|description): /, '').trim())
    .find((l) => l.length >= minLen && !/^\[(page|rows|chars)/.test(l) && !/^(pages|format):/.test(l)) ?? '';

export function parseFindingIds(text: string): { id: string; classification: string }[] {
  return [...text.matchAll(/\[(A\d-\d+)\] \((\w+)/g)].map((m) => ({ id: m[1], classification: m[2] }));
}

// ---- default (valid) answers -----------------------------------------------------------------------

const F = (f: Partial<LlmFinding> & Pick<LlmFinding, 'category' | 'statement' | 'classification'>): LlmFinding => ({
  sourceType: 'ai_inference',
  sourceId: null,
  locator: null,
  excerpt: null,
  confidence: 0.6,
  importance: 'medium',
  ...f,
});

export function defaultAnalysis(agent: FakeAgent, userText: string): AgentOutput {
  const sources = parseSources(userText);
  const missing = ['Pricing', 'Opening hours'];
  switch (agent) {
    case 'input':
      return {
        summary: 'A small business described by the user.',
        findings: [
          F({ category: 'offering', statement: 'The user describes the main offering.', classification: 'claimed', sourceType: 'intake_field', locator: 'intake.shortDescription', importance: 'high' }),
          F({ category: 'geography', statement: 'The business targets a local market.', classification: 'claimed', sourceType: 'intake_field', locator: 'intake.targetMarket', importance: 'medium' }),
          F({ category: 'hypothesis', statement: 'Customers are mostly local.', classification: 'inferred', importance: 'low' }),
        ],
        missingInformation: missing,
      };
    case 'text':
      return {
        summary: 'The text describes a service offered to local customers.',
        findings: [
          F({ category: 'value_proposition', statement: 'The stated value is a reliable local service.', classification: 'claimed', sourceType: 'intake_field', locator: 'intake.shortDescription', importance: 'high' }),
          F({ category: 'weakness', statement: 'The description gives no pricing.', classification: 'inferred', importance: 'medium' }),
        ],
        missingInformation: ['Who is the ideal customer?'],
      };
    case 'web': {
      const page = sources.find((s) => s.kind === 'website');
      const search = sources.find((s) => s.kind === 'search_result');
      const findings: LlmFinding[] = [];
      if (page) {
        const title = contentLine(page.text.replace(/^title: /, 'title: '), 6);
        findings.push(F({ category: 'presence', statement: 'The website presents the business under its own name.', classification: 'verified', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: title.slice(0, 120), importance: 'high' }));
        const desc = /description: (.+)/.exec(page.text)?.[1];
        if (desc) findings.push(F({ category: 'offering', statement: 'The website describes what is offered.', classification: 'claimed', sourceType: 'website', sourceId: page.id, locator: page.label, excerpt: desc.slice(0, 160), importance: 'high' }));
      }
      if (search) findings.push(F({ category: 'presence', statement: 'A search result mentions the business.', classification: 'claimed', sourceType: 'search_result', sourceId: search.id, locator: search.label, excerpt: contentLine(search.text.split('\n').slice(2).join('\n'), 10).slice(0, 120), importance: 'low' }));
      return { summary: 'What the website documents.', findings, missingInformation: ['Prices are not shown on the website'] };
    }
    case 'repo': {
      const readme = sources.find((s) => /README/.test(s.label));
      const manifest = sources.find((s) => s.kind === 'repository' && /package\.json|requirements|pom|go\.mod|Cargo|composer/.test(s.label));
      const findings: LlmFinding[] = [];
      if (readme) findings.push(F({ category: 'repository', statement: 'The README describes the project.', classification: 'claimed', sourceType: 'repository', sourceId: readme.id, locator: readme.label, excerpt: contentLine(readme.text, 10).slice(0, 140), importance: 'high' }));
      if (manifest) findings.push(F({ category: 'feature', statement: 'The dependency manifest lists the technology stack.', classification: 'verified', sourceType: 'repository', sourceId: manifest.id, locator: manifest.label, excerpt: contentLine(manifest.text, 8).slice(0, 100), importance: 'medium' }));
      return { summary: 'What the repository contains.', findings, missingInformation: [] };
    }
    case 'files': {
      const doc = sources.find((s) => s.kind === 'document');
      return {
        summary: 'What the uploaded documents say.',
        findings: doc ? [F({ category: 'document', statement: 'The document describes offerings.', classification: 'claimed', sourceType: 'uploaded_file', sourceId: doc.id, locator: doc.label, excerpt: contentLine(doc.text.split('\n').slice(2).join('\n'), 10).slice(0, 140), importance: 'high' })] : [],
        missingInformation: [],
      };
    }
    case 'visual':
      return {
        summary: 'The visual identity of the supplied images.',
        findings: [F({ category: 'visual', statement: 'The imagery uses a restrained colour palette.', classification: 'inferred', sourceType: 'image', locator: 'image 1', importance: 'medium' })],
        missingInformation: [],
      };
    default:
      return { summary: '', findings: [], missingInformation: [] };
  }
}

export function defaultReview(userText: string, verdict: CrosscheckAnswer['answers'][number]['verdict'] = 'agree'): CrosscheckAnswer {
  const m = /<crosscheck_request>\n([\s\S]*?)\n<\/crosscheck_request>/.exec(userText);
  let claims: { claimId: string }[] = [];
  try {
    claims = JSON.parse(m?.[1] ?? '{}').claims ?? [];
  } catch {
    claims = [];
  }
  return { answers: claims.map((c) => ({ claimId: c.claimId, verdict, rationale: 'Consistent with the evidence I analyzed.', correction: verdict === 'correct' ? 'A corrected statement.' : null })) };
}

export function defaultReportV2(userText: string, overrides: Partial<ProductDiscoveryReportV2> = {}): ProductDiscoveryReportV2 {
  const ids = parseFindingIds(userText);
  const of = (code: string) => ids.filter((i) => i.id.startsWith(`${code}-`)).map((i) => i.id);
  const first = (arr: string[]) => (arr.length ? [arr[0]] : []);
  const all = ids.map((i) => i.id);
  const st = (text: string, findingIds: string[], status: ReportStatement['status'] = 'inferred'): ReportStatement => ({ text, status, basis: findingIds.length ? `Findings ${findingIds.join(', ')}` : 'No direct finding', findingIds });
  const name = /"name": "([^"]+)"/.exec(userText)?.[1] ?? 'Test Business';
  const partial = /Set partial=true/.test(userText);
  return {
    schemaVersion: 2,
    language: 'en',
    partial,
    executiveSummary: 'An evidence-aware assessment of the business based on the available sources.',
    identity: { name, category: 'Local service business', industry: null, businessType: 'service', summary: 'A local service business.' },
    problemAndSolution: { problem: st('Customers need a reliable provider.', first(all)), solution: st('The business offers its service directly.', first(all)) },
    offerings: [st('Main service', first(all), 'claimed')],
    valueProposition: st('Reliable, friendly service.', first(all)),
    targetCustomers: [st('Local customers', first(all))],
    differentiation: [st('Personal approach', first(all))],
    websiteFindings: of('A3').length ? [st('The website documents the business.', of('A3'), 'verified')] : [st('Invented website claim', [])],
    repositoryFindings: of('A4').length ? [st('The repository documents the project.', of('A4'))] : [],
    documentFindings: of('A5').length ? [st('The documents describe offerings.', of('A5'))] : [],
    visualFindings: of('A6').length ? [st('The visual identity is restrained.', of('A6'))] : [],
    strengths: [st('Clear offering', first(all))],
    weaknessesRisksUnknowns: [st('No pricing information', [], 'unknown')],
    evidenceSummary: { narrative: 'Findings were cross-checked between agents where possible.', contradictions: [] },
    missingInformation: ['Pricing', 'Opening hours'],
    recommendedInvestigations: [{ action: 'Collect pricing details', priority: 'high', rationale: 'Pricing is missing.' }],
    productManifest: {
      name,
      tagline: null,
      category: 'Local service business',
      industry: null,
      businessType: 'service',
      offering: { summary: 'A local service.', items: ['Main service'] },
      problem: 'Customers need a reliable provider.',
      valueProposition: 'Reliable service.',
      targetCustomers: ['Local customers'],
      geography: ['Local'],
      languages: ['English'],
      goals: ['Get more customers'],
      differentiators: ['Personal approach'],
      brand: null,
      onlinePresence: { website: null, repository: null, socialProfiles: [] },
      openQuestions: ['Who is the ideal customer?'],
      overallConfidence: 0.99,
      confidenceNotes: 'Based on text only.',
      evidenceFindingIds: all.slice(0, 6),
    },
    ...overrides,
  };
}

function defaultAnswer(kind: FakeKind, agent: FakeAgent, userText: string, channel: string | null = null): string {
  if (kind === 'review') return JSON.stringify(defaultReview(userText));
  if (agent === 'copywriter') return JSON.stringify(userText.includes('Revise ONLY the listed variants') ? defaultCopyRevision(userText) : defaultCopy(userText));
  if (agent === 'landing') return JSON.stringify(userText.includes('Fix the landing page content findings') ? defaultLandingRevision(userText) : defaultLanding(userText));
  if (agent === 'vcreator') return JSON.stringify(defaultVisual(userText));
  if (agent === 'vresearcher') return JSON.stringify(defaultDirectionRefinement(userText));
  if (agent === 'tselector') return JSON.stringify(defaultTemplatePicks(userText));
  if (agent === 'creviewer') return JSON.stringify(userText.includes('<concepts_to_critique>') ? defaultConceptCritique(userText) : defaultCreativeReview());
  if (kind === 'synthesis') return JSON.stringify(agent === 'strategist' ? defaultStrategyDraft(userText) : agent === 'auditor' ? defaultAuditReport(userText) : defaultReportV2(userText));
  if (kind === 'analysis') return JSON.stringify(['audience', 'competitor', 'seasonal', 'scout'].includes(agent) ? defaultStrategyAnalysis(agent as never, userText, channel) : ['seo', 'social', 'brand', 'messaging', 'presence'].includes(agent) ? defaultAuditAnalysis(agent as never, userText) : defaultAnalysis(agent, userText));
  return 'OK';
}

// ---- server ------------------------------------------------------------------------------------------

export class FakeOpenAI {
  readonly requests: FakeRequest[] = [];
  private readonly counts = new Map<string, number>();
  private server!: Server;
  private readonly sockets = new Set<import('node:net').Socket>();
  url = '';

  constructor(private readonly options: FakeOpenAIOptions = {}) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Requests to POST /images/generations. */
  imageCalls() {
    return this.requests.filter((r) => r.path.endsWith('/images/generations'));
  }

  calls(agent?: FakeAgent, kind?: FakeKind) {
    return this.requests.filter((r) => r.path.endsWith('/responses') && (!agent || r.agent === agent) && (!kind || r.kind === kind));
  }

  /** Back-compat helper. */
  callsFor(agent: FakeAgent) {
    return this.calls(agent);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, any> | null = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const path = req.url ?? '';
    const isResponses = path.endsWith('/responses');
    const isImage = path.endsWith('/images/generations');
    const agent: FakeAgent = isResponses ? identifyAgent(body) : isImage ? 'image' : 'other';
    const users = userMessages(body);
    const userText = users.join('\n');
    const lastUserText = users[users.length - 1] ?? '';
    const creative = ['copywriter', 'landing', 'vcreator', 'creviewer', 'vresearcher', 'tselector'].includes(agent);
    const kind: FakeKind = isImage ? 'image' : !isResponses || agent === 'other' ? 'test' : creative ? (lastUserText.includes('<crosscheck_request>') ? 'review' : 'analysis') : userText.includes('<crosscheck_request>') ? 'review' : agent === 'synthesizer' || agent === 'auditor' || agent === 'strategist' ? 'synthesis' : 'analysis';
    const countKey = `${agent}:${kind}`;
    if (isResponses || isImage) this.counts.set(countKey, (this.counts.get(countKey) ?? 0) + 1);
    const record: FakeRequest = {
      method: req.method ?? '',
      path,
      authorization: String(req.headers.authorization ?? ''),
      body,
      agent,
      kind,
      attempt: this.counts.get(countKey) ?? 0,
      aborted: false,
      userText,
      lastUserText,
      images: countImages(body),
      channel: agent === 'scout' ? (/Your channel: [^(]+\(id "([a-z_]+)"\)/.exec(textOf(items(body)[0]))?.[1] ?? null) : null,
    };
    this.requests.push(record);
    res.on('close', () => {
      if (!res.writableEnded) record.aborted = true;
    });

    const key = record.authorization.replace(/^Bearer /, '');
    if (this.options.validKeys && !this.options.validKeys.includes(key)) {
      return send(res, 401, { error: { message: `Incorrect API key provided: ${key}.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      const ids = this.options.models ?? ['gpt-test-mini', 'gpt-test-large', 'text-embedding-test'];
      return send(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'openai' })) });
    }

    let reply: FakeReply;
    try {
      reply = (await this.options.reply?.(record)) ?? {};
    } catch (e) {
      // A broken test reply must never leave a request unanswered (that would hang the run, not fail the test).
      return send(res, 500, { error: { message: `fake reply threw: ${e instanceof Error ? e.message : String(e)}`, code: 'fake_reply_error' } });
    }
    if (reply.hang) return; // keep the connection open
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;

    const status = reply.status ?? 200;
    if (status !== 200) return send(res, status, reply.json ?? { error: { message: 'fake error', code: 'fake' } }, reply.headers);
    if (isImage) {
      const b64 = await fakeImageBase64(String(body?.size ?? '1024x1024'), String(body?.prompt ?? ''));
      return send(res, 200, reply.json ?? { created: 1, data: [{ b64_json: b64 }], usage: { input_tokens: 40, output_tokens: 1056, total_tokens: 1096 } }, reply.headers);
    }
    const text = reply.text ?? defaultAnswer(kind, agent, creative ? lastUserText : userText, record.channel);
    const usage = reply.usage ?? { input: 120, output: 60, reasoning: 0 };
    send(
      res,
      200,
      reply.json ?? {
        id: 'resp_fake',
        object: 'response',
        status: 'completed',
        model: body?.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          total_tokens: usage.input + usage.output,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
        },
      },
      reply.headers,
    );
  }
}

function send(res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(json));
}
