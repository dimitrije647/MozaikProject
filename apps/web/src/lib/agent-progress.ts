import type { RunEvent, RunStatus } from './types';

export type StepState = 'waiting' | 'working' | 'done' | 'failed' | 'stopped';

export interface ProgressStep {
  key: 'input' | 'text' | 'checker' | 'synthesizer';
  name: string;
  description: string;
  state: StepState;
  detail?: string;
}

const P = (e: RunEvent) => (e.payload ?? {}) as Record<string, any>;

/**
 * Derives the agent timeline ONLY from persisted Mozaik events (the same history the backend
 * stores), never from client-side timers: what you see is what actually happened.
 */
export function deriveProgress(events: RunEvent[], runStatus: RunStatus | undefined): ProgressStep[] {
  const assigned = (name: string) => events.some((e) => e.eventType === 'task.assigned' && P(e).agent === name);
  const completed = (name: string) => events.find((e) => e.eventType === 'task.completed' && P(e).agent === name);
  const has = (type: string) => events.some((e) => e.eventType === type);

  const analyzer = (key: 'input' | 'text', name: string, description: string): ProgressStep => {
    const done = completed(name);
    if (done) {
      const ok = P(done).outcome === 'succeeded';
      return { key, name, description, state: ok ? 'done' : 'failed', detail: ok ? 'Finding posted' : P(done).error?.message ?? 'Failed' };
    }
    return { key, name, description, state: assigned(name) ? 'working' : 'waiting' };
  };

  const input = analyzer('input', 'Input Analyzer', 'Understands the raw idea: category, problem, value, known facts and gaps');
  const text = analyzer('text', 'Text Analyzer', 'Deeper reading of the text: offerings, needs, strengths, ambiguities');

  const bothReported = input.state !== 'waiting' && input.state !== 'working' && text.state !== 'waiting' && text.state !== 'working';
  const crosschecked = events.find((e) => e.eventType === 'crosscheck.answered');
  const phaseFailed = events.find((e) => e.eventType === 'phase.failed');
  const checker: ProgressStep = {
    key: 'checker',
    name: 'Evidence Cross-Checker',
    description: 'Waits for both analyzers, enforces the evidence rules, flags contradictions',
    state: crosschecked ? 'done' : phaseFailed && P(phaseFailed).reason === 'all_analyzers_failed' ? 'failed' : bothReported ? 'working' : 'waiting',
    detail: crosschecked ? `${P(crosschecked).issueCount ?? 0} issue(s) flagged${P(crosschecked).partial ? ', partial input' : ''}` : undefined,
  };

  const synthDone = completed('Product Synthesizer');
  const synthesizer: ProgressStep = {
    key: 'synthesizer',
    name: 'Product Synthesizer',
    description: 'Reviews both findings and the cross-check, then writes the report',
    state: synthDone ? (P(synthDone).outcome === 'succeeded' ? 'done' : 'failed') : crosschecked ? 'working' : 'waiting',
    detail: synthDone && P(synthDone).outcome !== 'succeeded' ? P(synthDone).error?.message : has('report.generated') ? 'Report generated' : undefined,
  };

  const steps = [input, text, checker, synthesizer];
  // If the run ended without finishing a step, show it as stopped rather than "working".
  if (runStatus && runStatus !== 'RUNNING') {
    for (const s of steps) if (s.state === 'working') s.state = 'stopped';
  }
  return steps;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Sums the token counts OpenAI returned, from the persisted `inference.completed` events. */
export function usageFromEvents(events: RunEvent[]): UsageSummary {
  const total: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const e of events) {
    if (e.eventType !== 'inference.completed') continue;
    const u = P(e).tokenUsage;
    total.calls += 1;
    if (u) {
      total.inputTokens += Number(u.inputTokens) || 0;
      total.outputTokens += Number(u.outputTokens) || 0;
      total.totalTokens += Number(u.totalTokens) || 0;
    }
  }
  return total;
}
