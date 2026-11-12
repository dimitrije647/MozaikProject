import type { SafeProviderError } from '../ai/errors';
import type { ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { NotPlanned } from '../hybrid/deliverables';
import type { HybridPlan } from '../hybrid/plan';
import type { DiscoverySummary, ImageryBlock, TemplateCreativeRecord, TemplateQualityReport, TemplateSelectionPlan } from '../hybrid/records';
import type { VisualDirectionBrief } from '../templates/schema';
import type { AssetRecord, ConceptRecord, CopyVariantRecord, LayoutRecord, ReviewFindingRecord, RevisionRecord, Rubric, SkippedLayout } from './schemas';

/**
 * The F4 shared board: typed in-memory state of one Creative Production run.
 * Single-writer rule (as in F1 and F3): only the Creative Coordinator mutates it, in response to Mozaik events. Binaries are
 * never stored here: only asset ids and metadata.
 *
 * The creative team (V4): four agents with one job each, plus the deterministic coordinator.
 *   A3 Content Writer    concepts on the strategy, platform posts, ad and print copy, revisions          (text model)
 *   A4 Visual Researcher visual direction, approved / licensed pictures, rights, picture per creative  (no model)
 *   A5 Creative Designer template selection and local rendering of every deliverable                   (no model)
 *   A6 Quality Reviewer  checks, one text review (+ an optional sampled vision review), the repair plan (text model)
 */
export const CREATIVE_KEYS = ['writer', 'researcher', 'designer', 'reviewer'] as const;
export type CreativeKey = (typeof CREATIVE_KEYS)[number];

export const CREATIVE_INFO: Record<CreativeKey, { code: string; name: string; role: string; usesModel: boolean }> = {
  writer: { code: 'A3', name: 'Content Writer', role: 'Campaign concepts on the strategy, platform posts (X, TikTok, Facebook, Instagram, LinkedIn), ad and print copy', usesModel: true },
  researcher: { code: 'A4', name: 'Visual Researcher', role: 'Visual direction, approved and licensed pictures with their rights, the picture of every creative (deterministic)', usesModel: false },
  designer: { code: 'A5', name: 'Creative Designer', role: 'Chooses a collection template for every deliverable and renders it locally with the copy, the palette, the logo and the picture (deterministic)', usesModel: false },
  reviewer: { code: 'A6', name: 'Quality Reviewer', role: 'Facts, copy, design, brand, rights and completeness checks; requests bounded corrections', usesModel: true },
};
export const CREATIVE_COORDINATOR_NAME = 'Creative Coordinator';
export const creativeKeyByName = (name: string): CreativeKey | undefined => CREATIVE_KEYS.find((k) => CREATIVE_INFO[k].name === name);

export interface CreativePlan {
  activated: { agent: string; key: CreativeKey; reason: string }[];
  skipped: { agent: string; key: CreativeKey; reason: string }[];
}

export interface CreativeSettingsSnapshot {
  channels: string[];
  concepts: number;
  maxRepairRounds: number;
  maxModelCalls: number;
  visionReviews: number;
  approvedBudgetUsd?: number | null;
}

export interface CreativeBoard {
  plan: CreativePlan | null;
  settings: CreativeSettingsSnapshot | null;
  sources: SourceRecord[];
  concepts: ConceptRecord[];
  variants: CopyVariantRecord[];
  assets: AssetRecord[];
  rubrics: { round: number; scores: Rubric }[];
  skipped: { what: string; reason: string }[];
  layouts: LayoutRecord[];
  skippedLayouts: SkippedLayout[];
  direction: VisualDirectionBrief | null;
  /** What the licensed picture search found (candidates and reference links). */
  discovery: DiscoverySummary | null;
  /** The planned creatives (one per deliverable). */
  hybridPlan: HybridPlan | null;
  /** Deliverables the plan could not include, with the reason. */
  notPlanned: NotPlanned[];
  platforms: string[];
  selection: TemplateSelectionPlan | null;
  templateCreatives: TemplateCreativeRecord[];
  templateQuality: TemplateQualityReport | null;
  /** The pictures the Visual Researcher sourced and their rights. */
  imagery: ImageryBlock | null;
  findings: ReviewFindingRecord[];
  revisions: RevisionRecord[];
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
  readonly assets: AssetRecord[] = [];
  readonly rubrics: CreativeBoard['rubrics'] = [];
  readonly skipped: CreativeBoard['skipped'] = [];
  readonly layouts: LayoutRecord[] = [];
  readonly skippedLayouts: CreativeBoard['skippedLayouts'] = [];
  direction: VisualDirectionBrief | null = null;
  discovery: DiscoverySummary | null = null;
  hybridPlan: HybridPlan | null = null;
  notPlanned: NotPlanned[] = [];
  platforms: string[] = [];
  selection: TemplateSelectionPlan | null = null;
  readonly templateCreatives: TemplateCreativeRecord[] = [];
  templateQuality: TemplateQualityReport | null = null;
  imagery: ImageryBlock | null = null;
  readonly findings: ReviewFindingRecord[] = [];
  readonly revisions: RevisionRecord[] = [];
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

  /** Work that was not done, and why (shown in the quality diagnostic). */
  skip(what: string, reason: string) {
    if (!this.skipped.some((s) => s.what === what)) this.skipped.push({ what, reason });
  }

  note(limitation: string) {
    if (!this.limitations.includes(limitation)) this.limitations.push(limitation);
  }

  /** Replaces the record of a creative (same slot) or adds it. */
  putCreative(t: TemplateCreativeRecord) {
    const i = this.templateCreatives.findIndex((x) => x.slotId === t.slotId);
    if (i >= 0) this.templateCreatives[i] = t;
    else this.templateCreatives.push(t);
  }

  snapshot(): CreativeBoard {
    return structuredClone({
      plan: this.plan,
      settings: this.settings,
      sources: this.sources,
      concepts: this.concepts,
      variants: this.variants,
      assets: this.assets,
      rubrics: this.rubrics,
      skipped: this.skipped,
      layouts: this.layouts,
      skippedLayouts: this.skippedLayouts,
      direction: this.direction,
      discovery: this.discovery,
      hybridPlan: this.hybridPlan,
      notPlanned: this.notPlanned,
      platforms: this.platforms,
      selection: this.selection,
      templateCreatives: this.templateCreatives,
      templateQuality: this.templateQuality,
      imagery: this.imagery,
      findings: this.findings,
      revisions: this.revisions,
      summaries: this.summaries,
      participantStatuses: this.participantStatuses,
      round: this.round,
      limitations: this.limitations,
    });
  }
}
