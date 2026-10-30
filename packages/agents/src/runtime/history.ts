import { redact } from '../factory/redact';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * What gets stored in the event history. Mozaik agent-loop events carry the entire model context
 * (prompts = the user's product text, repeated) and the raw provider response, which would bloat the
 * database and duplicate sensitive content, so those are reduced to small summaries.
 * `finding.posted` and `report.generated` carry full structured content for the OTHER AGENTS, but
 * history keeps only counts: the report itself is stored in ProductDiscoveryReport.
 */
export function summarizeForHistory(type: string, payload: unknown): Obj | null {
  const p = isObj(payload) ? payload : {};
  const loopId = typeof p.loopId === 'string' ? p.loopId : undefined;
  switch (type) {
    case 'message_received.started':
      return { loopId, chars: typeof p.content === 'string' ? p.content.length : 0 };
    case 'message_received.completed':
    case 'inference.started':
      return { loopId, model: typeof p.model === 'string' ? p.model : undefined };
    case 'inference.completed': {
      const u = isObj(p.tokenUsage) ? p.tokenUsage : null;
      const out = (u && isObj(u.outputTokenDetails) ? u.outputTokenDetails : {}) as Obj;
      return {
        loopId,
        items: Array.isArray(p.items) ? p.items.length : 0,
        tokenUsage: u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              totalTokens: u.totalTokens,
              reasoningTokens: out.reasoning_tokens,
            }
          : null,
      };
    }
    case 'model.answer': {
      const answer = isObj(p.answer) ? p.answer : {};
      const content = isObj(answer.content) ? answer.content : {};
      return { loopId, chars: typeof content.text === 'string' ? content.text.length : 0 };
    }
    case 'finding.posted': {
      const f = isObj(p.finding) ? p.finding : {};
      return { agent: p.agent, kind: p.kind, fields: Object.keys(f).length };
    }
    case 'crosscheck.answered':
      return {
        phase: p.phase,
        succeeded: p.succeeded,
        failed: p.failed,
        partial: p.partial,
        issueCount: Array.isArray(p.issues) ? p.issues.length : 0,
        issues: Array.isArray(p.issues) ? redact(p.issues) : [],
      };
    case 'report.generated':
      return { stored: 'ProductDiscoveryReport' };
    default:
      return null;
  }
}
