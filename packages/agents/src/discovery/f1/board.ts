import type { SafeProviderError } from '../../ai/errors';
import type { EvidenceStatus } from '../schemas';
import { normalizeText } from '../input';

/**
 * The F1 shared board: the typed, in-memory state all Product Discovery participants work on.
 *
 * Single-writer rule: only the Phase Coordinator mutates the board, in response to Mozaik events
 * (`source.retrieved`, `finding.posted`, `task.completed`). The Business Researcher publishes events; it never
 * writes the board directly, and reads a snapshot of it when `phase.ready` arrives to write the report.
 * The board never holds credentials.
 */

/**
 * V4: ONE agent. The Business Researcher gathers every authorized source deterministically (intake, website, optional search,
 * public repository, uploaded documents and images), makes ONE evidence analysis call and then ONE synthesis call (report and
 * Product Manifest). Earlier runs had seven agents (Input/Text/Web/Repo/File/Visual Analyzers and a Product Synthesizer); their
 * names survive only in the events and reports those runs saved.
 */
export const AGENT_KEYS = ['researcher'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_INFO: Record<AgentKey, { code: string; name: string; role: string }> = {
  researcher: { code: 'A1', name: 'Business Researcher', role: 'Reads the authorized business sources (intake, website, repository, documents, images), extracts evidenced facts and writes the Product Discovery report and Product Manifest' },
};

export const COORDINATOR_NAME = 'Phase Coordinator';

export const keyByName = (name: string): AgentKey | undefined => AGENT_KEYS.find((k) => AGENT_INFO[k].name === name);

// ---- Sources ---------------------------------------------------------------------------------

export type SourceKind = 'user_input' | 'website' | 'search_result' | 'repository' | 'document' | 'image' | 'robots' | 'sitemap' | 'pagespeed' | 'social_profile' | 'f1_report' | 'holiday_calendar' | 'f2_audit' | 'f3_strategy';

/** Where the data of a source came from (F2 distinguishes these in every report). */
export type SourceOrigin = 'public_page' | 'live_api' | 'user_provided' | 'export' | 'fixture' | 'previous_phase';
export type SourceStatus = 'retrieved' | 'failed' | 'skipped' | 'unsupported';

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  /** URL, repository, file name or "Project intake". */
  label: string;
  url: string | null;
  status: SourceStatus;
  /** Retrieved from the real world just now (website, API). False for user-supplied content. */
  live: boolean;
  /** Test fixture (fake server/data). Never evidence about the real world. */
  fixture: boolean;
  httpStatus: number | null;
  bytes: number | null;
  chars: number | null;
  error: string | null;
  /** Short excerpt (<= 400 chars) for display. The full text lives in the SourceStore. */
  excerpt: string | null;
  retrievedAt: string;
  producer: string;
  /** The text contains phrases that look like instructions to an AI (it is still only data). */
  injectionSuspected: boolean;
  notes: string[];
  /** Set by F2 sources. */
  origin?: SourceOrigin;
}

/** Full source texts for the duration of one run (not persisted). Also caches retrieval results. */
export class SourceStore {
  private readonly records = new Map<string, SourceRecord>();
  private readonly texts = new Map<string, string>();
  private n = 0;

  add(input: Omit<SourceRecord, 'id' | 'retrievedAt' | 'excerpt' | 'chars' | 'injectionSuspected' | 'notes'> & Partial<Pick<SourceRecord, 'injectionSuspected' | 'notes'>>, text?: string): SourceRecord {
    const record: SourceRecord = {
      injectionSuspected: false,
      notes: [],
      ...input,
      id: `S${++this.n}`,
      retrievedAt: new Date().toISOString(),
      chars: text !== undefined ? text.length : null,
      excerpt: text ? text.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    };
    this.records.set(record.id, record);
    if (text !== undefined) this.texts.set(record.id, text);
    return record;
  }

  get(id: string) {
    return this.records.get(id);
  }
  text(id: string) {
    return this.texts.get(id) ?? '';
  }
  all() {
    return [...this.records.values()];
  }
  /** Whether `excerpt` appears verbatim (whitespace/case-insensitively) in the stored source text. */
  contains(id: string, excerpt: string) {
    const needle = normalizeText(excerpt);
    return needle.length >= 6 && normalizeText(this.text(id)).includes(needle);
  }
}

// ---- Findings, cross-checks, participants -----------------------------------------------------

export const FINDING_CATEGORIES = [
  'identity',
  'industry',
  'problem',
  'offering',
  'feature',
  'goal',
  'geography',
  'language',
  'customer_segment',
  'claim',
  'value_proposition',
  'usp',
  'differentiator',
  'communication',
  'presence',
  'repository',
  'document',
  'visual',
  'strength',
  'weakness',
  'risk',
  'hypothesis',
  'discrepancy',
  'missing_info',
  'other',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export type FindingSourceType = 'intake_field' | 'user_input' | 'website' | 'search_result' | 'repository' | 'uploaded_file' | 'image' | 'ai_inference';
export type Importance = 'high' | 'medium' | 'low';
export type CrosscheckStatus = 'not_requested' | 'pending' | 'agreed' | 'disputed' | 'corrected' | 'insufficient';

export interface Finding {
  id: string;
  agent: string;
  category: FindingCategory;
  statement: string;
  classification: EvidenceStatus;
  sourceType: FindingSourceType;
  sourceId: string | null;
  /** Field path, URL, repository file or "page N". */
  locator: string | null;
  /** Verbatim excerpt from the source (<= 300 chars). */
  excerpt: string | null;
  confidence: number | null;
  importance: Importance;
  crosscheck: { status: CrosscheckStatus; reviewers: string[] };
  /** Why the system changed the classification, if it did. */
  adjustment: string | null;
  at: string;
}

export type Verdict = 'agree' | 'disagree' | 'correct' | 'insufficient_evidence';

export interface CrosscheckRecord {
  id: string;
  requestId: string;
  claimId: string;
  producer: string;
  reviewer: string;
  verdict: Verdict | null;
  rationale: string | null;
  correction: string | null;
  status: 'pending' | 'answered' | 'timed_out' | 'failed';
  error: string | null;
  requestedAt: string;
  answeredAt: string | null;
}

export type ParticipantState = 'waiting' | 'working' | 'done' | 'failed' | 'skipped' | 'timed_out';

export interface ParticipantStatus {
  agent: string;
  code: string;
  state: ParticipantState;
  reason: string | null;
  findings: number;
  error: SafeProviderError | null;
}

export interface F1Plan {
  activated: { agent: string; key: AgentKey; reason: string }[];
  skipped: { agent: string; key: AgentKey; reason: string }[];
}

export interface F1Board {
  plan: F1Plan | null;
  sources: SourceRecord[];
  findings: Finding[];
  missingInformation: { agent: string; text: string }[];
  summaries: Record<string, string>;
  crosschecks: CrosscheckRecord[];
  participantStatuses: ParticipantStatus[];
}

export class F1BoardStore implements F1Board {
  plan: F1Plan | null = null;
  readonly sources: SourceRecord[] = [];
  readonly findings: Finding[] = [];
  readonly missingInformation: { agent: string; text: string }[] = [];
  readonly summaries: Record<string, string> = {};
  readonly crosschecks: CrosscheckRecord[] = [];
  readonly participantStatuses: ParticipantStatus[] = [];
  private findingCounter = new Map<string, number>();

  setStatus(agent: string, patch: Partial<Omit<ParticipantStatus, 'agent' | 'code'>>) {
    let s = this.participantStatuses.find((p) => p.agent === agent);
    if (!s) {
      const key = keyByName(agent);
      s = { agent, code: key ? AGENT_INFO[key].code : '--', state: 'waiting', reason: null, findings: 0, error: null };
      this.participantStatuses.push(s);
    }
    Object.assign(s, patch);
    return s;
  }

  addSource(r: SourceRecord) {
    if (!this.sources.some((s) => s.id === r.id)) this.sources.push(r);
  }

  nextFindingId(agent: string) {
    const key = keyByName(agent);
    const prefix = key ? AGENT_INFO[key].code : 'F';
    const n = (this.findingCounter.get(prefix) ?? 0) + 1;
    this.findingCounter.set(prefix, n);
    return `${prefix}-${n}`;
  }

  addFinding(f: Finding) {
    this.findings.push(f);
  }

  findingsBy(agent: string) {
    return this.findings.filter((f) => f.agent === agent);
  }

  /** Serializable copy (no functions, no secrets). */
  snapshot(): F1Board {
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
