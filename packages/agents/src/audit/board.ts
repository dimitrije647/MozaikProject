import type { SafeProviderError } from '../ai/errors';
import type { CrosscheckRecord, ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { EvidenceStatus } from '../discovery/schemas';

/**
 * The F2 shared board: typed in-memory state of one Marketing Audit run.
 *
 * Same single-writer rule as the F1 board: only the Audit Coordinator mutates it, in response to Mozaik
 * events (`source.retrieved`, `finding.posted`, `crosscheck.answered`, `task.completed`). The Audit
 * Synthesizer reads a snapshot when `phase.ready` arrives. Never holds credentials.
 */

export const AUDIT_KEYS = ['seo', 'social', 'brand', 'messaging', 'presence', 'synthesizer'] as const;
export type AuditKey = (typeof AUDIT_KEYS)[number];
export type AuditorKey = Exclude<AuditKey, 'synthesizer'>;
export const AUDITOR_KEYS: readonly AuditorKey[] = ['seo', 'social', 'brand', 'messaging', 'presence'];

export const AUDIT_INFO: Record<AuditKey, { code: string; name: string; role: string; area: string }> = {
  seo: { code: 'A8', name: 'SEO Auditor', role: 'Website SEO and technical signals', area: 'seo' },
  social: { code: 'A9', name: 'Social Media Auditor', role: 'Supplied social profiles, official APIs only', area: 'social' },
  brand: { code: 'A10', name: 'Brand Auditor', role: 'Brand identity consistency', area: 'brand' },
  messaging: { code: 'A11', name: 'Messaging Auditor', role: 'Clarity and credibility of product communication', area: 'messaging' },
  presence: { code: 'A12', name: 'Presence Auditor', role: 'Cross-channel consistency and completeness', area: 'presence' },
  synthesizer: { code: 'A13', name: 'Audit Synthesizer', role: 'Consolidates the audits into the Marketing Audit Report', area: 'cross' },
};

export const AUDIT_COORDINATOR_NAME = 'Audit Coordinator';

export const auditKeyByName = (name: string): AuditKey | undefined => AUDIT_KEYS.find((k) => AUDIT_INFO[k].name === name);

export const AUDIT_AREAS = ['seo', 'social', 'brand', 'messaging', 'presence', 'cross'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What kind of statement a finding is. Decides how strong its evidence class can be. */
export const FINDING_KINDS = ['observation', 'claim_on_source', 'assessment', 'hypothesis', 'gap'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type AuditSourceType = 'website' | 'pagespeed' | 'social_api' | 'user_provided' | 'export' | 'f1_finding' | 'image' | 'ai_inference';

export interface AuditFinding {
  id: string;
  agent: string;
  area: AuditArea;
  kind: FindingKind;
  title: string;
  statement: string;
  classification: EvidenceStatus;
  severity: Severity;
  sourceType: AuditSourceType;
  /** Id of a source in this run's SourceStore, or null. */
  sourceId: string | null;
  /** URL, F1 finding id, "intake.field", page path... */
  locator: string | null;
  /** Verbatim excerpt from the cited source. */
  excerpt: string | null;
  recommendation: string | null;
  confidence: number | null;
  crosscheck: { status: 'not_requested' | 'pending' | 'agreed' | 'disputed' | 'corrected' | 'insufficient'; reviewers: string[] };
  /** Why the system changed the classification, if it did. */
  adjustment: string | null;
  at: string;
}

export interface AuditPlan {
  activated: { agent: string; key: AuditKey; reason: string }[];
  skipped: { agent: string; key: AuditKey; reason: string }[];
}

export interface AuditBoard {
  plan: AuditPlan | null;
  sources: SourceRecord[];
  findings: AuditFinding[];
  missingInformation: { agent: string; text: string }[];
  summaries: Record<string, string>;
  crosschecks: CrosscheckRecord[];
  participantStatuses: ParticipantStatus[];
}

export class AuditBoardStore implements AuditBoard {
  plan: AuditPlan | null = null;
  readonly sources: SourceRecord[] = [];
  readonly findings: AuditFinding[] = [];
  readonly missingInformation: { agent: string; text: string }[] = [];
  readonly summaries: Record<string, string> = {};
  readonly crosschecks: CrosscheckRecord[] = [];
  readonly participantStatuses: ParticipantStatus[] = [];
  private counters = new Map<string, number>();

  setStatus(agent: string, patch: Partial<Omit<ParticipantStatus, 'agent' | 'code'>> & { error?: SafeProviderError | null }) {
    let s = this.participantStatuses.find((p) => p.agent === agent);
    if (!s) {
      const key = auditKeyByName(agent);
      s = { agent, code: key ? AUDIT_INFO[key].code : '--', state: 'waiting', reason: null, findings: 0, error: null };
      this.participantStatuses.push(s);
    }
    Object.assign(s, patch);
    return s;
  }

  addSource(r: SourceRecord) {
    if (!this.sources.some((s) => s.id === r.id)) this.sources.push(r);
  }

  nextFindingId(agent: string) {
    const key = auditKeyByName(agent);
    const prefix = key ? AUDIT_INFO[key].code : 'F';
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }

  findingsBy(agent: string) {
    return this.findings.filter((f) => f.agent === agent);
  }

  snapshot(): AuditBoard {
    return structuredClone({
      plan: this.plan,
      sources: this.sources,
      findings: this.findings,
      missingInformation: this.missingInformation,
      summaries: this.summaries,
      crosschecks: this.crosschecks,
      participantStatuses: this.participantStatuses,
    });
  }
}
