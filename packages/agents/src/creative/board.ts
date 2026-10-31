import type { SafeProviderError } from '../ai/errors';
import type { CrosscheckRecord, ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { AssetRecord, ConceptRecord, CopyVariantRecord, ImageResultRecord, LandingContent, LayoutRecord, ReviewFindingRecord, RevisionRecord, SkippedLayout } from './schemas';

/**
 * The F4 shared board: typed in-memory state of one Creative Production run.
 * Single-writer rule (as in F1 to F3): only the Creative Coordinator mutates it, in response to Mozaik events. Binaries are
 * never stored here: only asset ids and metadata.
 */
export const CREATIVE_KEYS = ['copywriter', 'visual', 'layout', 'landing', 'reviewer', 'fixer'] as const;
export type CreativeKey = (typeof CREATIVE_KEYS)[number];

export const CREATIVE_INFO: Record<CreativeKey, { code: string; name: string; role: string; usesModel: boolean }> = {
  copywriter: { code: 'A19', name: 'Copywriter', role: 'Channel-specific copy and creative concepts', usesModel: true },
  visual: { code: 'A20', name: 'Visual Creator', role: 'Original base images through the image model', usesModel: true },
  layout: { code: 'A21', name: 'Layout Designer', role: 'Deterministic channel layouts from the base images (no model call)', usesModel: false },
  landing: { code: 'A22', name: 'Landing Content Builder', role: 'Structured landing page content', usesModel: true },
  reviewer: { code: 'A23', name: 'Content & Brand Reviewer', role: 'Deterministic checks plus text and vision review', usesModel: true },
  fixer: { code: 'A24', name: 'Fixer', role: 'Plans and requests repairs, preserves originals (created only when issues are found)', usesModel: false },
};
export const CREATIVE_COORDINATOR_NAME = 'Creative Coordinator';
export const creativeKeyByName = (name: string): CreativeKey | undefined => CREATIVE_KEYS.find((k) => CREATIVE_INFO[k].name === name);

export interface CreativePlan {
  activated: { agent: string; key: CreativeKey; reason: string; dynamic?: boolean }[];
  skipped: { agent: string; key: CreativeKey; reason: string }[];
}

export interface CreativeSettingsSnapshot {
  channels: string[];
  concepts: number;
  formats: string[];
  imageGeneration: boolean;
  imageModel: string | null;
  imageQuality: string | null;
  imageSize: string | null;
  maxImages: number;
  maxRegenerations: number;
  maxRepairRounds: number;
  maxModelCalls: number;
}

export interface CreativeBoard {
  plan: CreativePlan | null;
  settings: CreativeSettingsSnapshot | null;
  sources: SourceRecord[];
  concepts: ConceptRecord[];
  variants: CopyVariantRecord[];
  landing: LandingContent | null;
  assets: AssetRecord[];
  imageResults: ImageResultRecord[];
  layouts: LayoutRecord[];
  skippedLayouts: SkippedLayout[];
  findings: ReviewFindingRecord[];
  revisions: RevisionRecord[];
  crosschecks: CrosscheckRecord[];
  summaries: Record<string, string>;
  participantStatuses: ParticipantStatus[];
  round: number;
  limitations: string[];
}

export class CreativeBoardStore implements CreativeBoard {
  plan: CreativePlan | null = null;
  settings: CreativeSettingsSnapshot | null = null;
  readonly sources: SourceRecord[] = [];
  concepts: ConceptRecord[] = [];
  variants: CopyVariantRecord[] = [];
  landing: LandingContent | null = null;
  readonly assets: AssetRecord[] = [];
  readonly imageResults: ImageResultRecord[] = [];
  readonly layouts: LayoutRecord[] = [];
  readonly skippedLayouts: CreativeBoard['skippedLayouts'] = [];
  readonly findings: ReviewFindingRecord[] = [];
  readonly revisions: RevisionRecord[] = [];
  readonly crosschecks: CrosscheckRecord[] = [];
  readonly summaries: Record<string, string> = {};
  readonly participantStatuses: ParticipantStatus[] = [];
  round = 0;
  readonly limitations: string[] = [];
  private counters = new Map<string, number>();

  next(prefix: string) {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}${n}`;
  }

  setStatus(agent: string, patch: Partial<Omit<ParticipantStatus, 'agent' | 'code'>> & { error?: SafeProviderError | null }) {
    let s = this.participantStatuses.find((p) => p.agent === agent);
    if (!s) {
      const key = creativeKeyByName(agent);
      s = { agent, code: key ? CREATIVE_INFO[key].code : '--', state: 'waiting', reason: null, findings: 0, error: null };
      this.participantStatuses.push(s);
    }
    Object.assign(s, patch);
    return s;
  }

  addSource(r: SourceRecord) {
    if (!this.sources.some((s) => s.id === r.id)) this.sources.push(r);
  }

  note(limitation: string) {
    if (!this.limitations.includes(limitation)) this.limitations.push(limitation);
  }

  snapshot(): CreativeBoard {
    return structuredClone({
      plan: this.plan,
      settings: this.settings,
      sources: this.sources,
      concepts: this.concepts,
      variants: this.variants,
      landing: this.landing,
      assets: this.assets,
      imageResults: this.imageResults,
      layouts: this.layouts,
      skippedLayouts: this.skippedLayouts,
      findings: this.findings,
      revisions: this.revisions,
      crosschecks: this.crosschecks,
      summaries: this.summaries,
      participantStatuses: this.participantStatuses,
      round: this.round,
      limitations: this.limitations,
    });
  }
}
