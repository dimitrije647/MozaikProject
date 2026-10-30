import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InputAnalysis, ProductDiscoveryReport, TextAnalysis } from '../discovery/schemas';

/**
 * A local fake of the OpenAI HTTP API (POST /v1/responses, GET /v1/models) for automated tests.
 * It speaks real HTTP, so the whole pipeline (Mozaik agent loop, gateway, mapper, HTTP client,
 * timeouts, aborts) runs for real while no network call to OpenAI is made and nothing is billed.
 */
export type FakeAgent = 'input' | 'text' | 'synthesizer' | 'other';

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string;
  body: Record<string, any> | null;
  agent: FakeAgent;
  /** Number of requests seen so far for this agent (1-based), including this one. */
  attempt: number;
  /** Set when the client closed the connection before we answered (an aborted request). */
  aborted: boolean;
}

export interface FakeReply {
  status?: number;
  /** Raw body. Defaults to a successful Responses payload when `text` is given. */
  json?: unknown;
  /** Assistant text for a 200 reply (usually a JSON document). */
  text?: string;
  delayMs?: number;
  headers?: Record<string, string>;
  /** Token usage to report. */
  usage?: { input: number; output: number; reasoning?: number };
  /** Never answer (to test timeouts and cancellation). */
  hang?: boolean;
}

export interface FakeOpenAIOptions {
  /** Return undefined to fall back to the default (valid) reply for that agent. */
  reply?: (req: FakeRequest) => FakeReply | undefined | Promise<FakeReply | undefined>;
  /** If set, any other key gets a 401 whose body echoes the (fake) key, like the real API does. */
  validKeys?: string[];
  models?: string[];
}

export function identifyAgent(body: Record<string, any> | null): FakeAgent {
  const text = JSON.stringify(body?.input?.[0] ?? '');
  if (text.includes('You are the Input Analyzer')) return 'input';
  if (text.includes('You are the Text Analyzer')) return 'text';
  if (text.includes('You are the Product Synthesizer')) return 'synthesizer';
  return 'other';
}

/** Pulls the supplied project input back out of a prompt, so canned answers can quote it. */
export function extractProjectInput(body: Record<string, any> | null): { intake?: { shortDescription?: string }; project?: { name?: string } } {
  const items: any[] = Array.isArray(body?.input) ? body!.input : [];
  for (const item of items) {
    const text: string = item?.content?.[0]?.text ?? '';
    const start = text.indexOf('<project_input>');
    const end = text.indexOf('</project_input>');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start + '<project_input>'.length, end));
      } catch {
        return {};
      }
    }
  }
  return {};
}

// ---- Default (valid) answers ---------------------------------------------------------------

export function defaultInputAnalysis(quote: string): InputAnalysis {
  return {
    summary: 'A small business described by the user.',
    category: 'Local service business',
    businessType: 'service',
    problem: 'Customers need a reliable provider.',
    solution: 'The business offers its service directly.',
    valueProposition: 'Reliable, friendly service.',
    businessGoals: ['Get more customers'],
    knownFacts: [
      { id: 'ia-1', statement: 'The user describes the offering.', status: 'claimed', sourceType: 'intake_field', sourceReference: 'intake.shortDescription', confidence: 0.9, explanation: quote ? `Quote: ${quote}` : null },
    ],
    missingInformation: ['Pricing', 'Opening hours'],
    assumptions: [{ id: 'ia-2', statement: 'Customers are mostly local.', status: 'inferred', sourceType: 'ai_inference', sourceReference: null, confidence: 0.4, explanation: 'Based on the type of business.' }],
    confidence: 0.6,
  };
}

export function defaultTextAnalysis(): TextAnalysis {
  const item = (text: string, status: 'claimed' | 'inferred' = 'inferred', basis = 'Inferred from the description') => ({ text, status, basis });
  return {
    explanation: 'The text describes a service offered to local customers.',
    businessType: 'service',
    featuresOrOfferings: [item('Main service', 'claimed', 'intake.shortDescription')],
    customerNeeds: [item('Convenience')],
    differentiators: [item('Personal approach')],
    strengths: [item('Clear offering', 'claimed', 'intake.shortDescription')],
    weaknesses: [item('No pricing information')],
    ambiguities: ['Target audience is not specific'],
    validationQuestions: ['Who is the ideal customer?'],
    messagingOpportunities: [item('Emphasize reliability')],
    evidence: [{ id: 'ta-1', statement: 'The user describes the offering.', status: 'claimed', sourceType: 'intake_field', sourceReference: 'intake.shortDescription', confidence: 0.9, explanation: null }],
  };
}

export function defaultReport(overrides: Partial<ProductDiscoveryReport> = {}): ProductDiscoveryReport {
  const s = (text: string, status: 'claimed' | 'inferred' | 'unknown' = 'inferred', basis = 'Inferred from the supplied description') => ({ text, status, basis });
  return {
    schemaVersion: 1,
    language: 'en',
    partial: false,
    executiveSummary: 'An early-stage assessment based only on the supplied text.',
    overview: { name: 'Test Business', category: 'Local service business', businessType: 'service', summary: 'A local service business.' },
    problemAndSolution: { problem: s('Customers need a reliable provider.'), solution: s('Direct service.', 'claimed', 'intake.shortDescription') },
    valueProposition: s('Reliable, friendly service.'),
    audienceHypotheses: [s('Local customers')],
    featuresServices: [s('Main service', 'claimed', 'intake.shortDescription')],
    differentiators: [s('Personal approach')],
    strengths: [s('Clear offering', 'claimed', 'intake.shortDescription')],
    weaknessesAndRisks: [s('No pricing information', 'unknown')],
    missingInformation: ['Pricing', 'Opening hours'],
    evidenceAndAssumptions: [{ id: 'ev-1', statement: 'The user describes the offering.', status: 'claimed', sourceType: 'intake_field', sourceReference: 'intake.shortDescription', confidence: 0.9, explanation: null }],
    contradictions: [],
    marketingOpportunities: [s('Emphasize reliability')],
    nextSteps: [{ action: 'Collect pricing details', priority: 'high', rationale: 'Pricing is missing.' }],
    followUpQuestions: ['Who is the ideal customer?'],
    ...overrides,
  };
}

function defaultAnswer(agent: FakeAgent, body: Record<string, any> | null): string {
  const input = extractProjectInput(body);
  if (agent === 'input') return JSON.stringify(defaultInputAnalysis(input.intake?.shortDescription ?? ''));
  if (agent === 'text') return JSON.stringify(defaultTextAnalysis());
  if (agent === 'synthesizer') return JSON.stringify(defaultReport());
  return 'OK';
}

// ---- Server --------------------------------------------------------------------------------

export class FakeOpenAI {
  readonly requests: FakeRequest[] = [];
  private readonly counts: Record<FakeAgent, number> = { input: 0, text: 0, synthesizer: 0, other: 0 };
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

  callsFor(agent: FakeAgent) {
    return this.requests.filter((r) => r.agent === agent && r.path === '/v1/responses');
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
    const agent = path.endsWith('/responses') ? identifyAgent(body) : 'other';
    if (path.endsWith('/responses')) this.counts[agent]++;
    const record: FakeRequest = {
      method: req.method ?? '',
      path,
      authorization: String(req.headers.authorization ?? ''),
      body,
      agent,
      attempt: this.counts[agent],
      aborted: false,
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

    const custom = await this.options.reply?.(record);
    const reply = custom ?? {};
    if (reply.hang) return; // keep the connection open
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;

    const status = reply.status ?? 200;
    if (status !== 200) return send(res, status, reply.json ?? { error: { message: 'fake error', code: 'fake' } }, reply.headers);
    const text = reply.text ?? defaultAnswer(agent, body);
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
