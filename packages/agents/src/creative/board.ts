import type { SafeProviderError } from '../ai/errors';
import type { CrosscheckRecord, ParticipantStatus, SourceRecord } from '../discovery/f1/board';
import type { ConceptCritique, Rubric } from './schemas';
import type { HybridPlan } from '../hybrid/plan';
import type { DiscoverySummary, ImageryBlock, TemplateCreativeRecord, TemplateQualityReport, TemplateSelectionPlan } from '../hybrid/records';
import type { VisualDirectionBrief } from '../templates/schema';
import type { AssetRecord, ConceptRecord, CopyVariantRecord, ImageAllocationPlan, ImageResultRecord, ImageVariationRecord, LandingContent, LayoutRecord, ReviewFindingRecord, RevisionRecord, SkippedLayout } from './schemas';

/**
 * The F4 shared board: typed in-memory state of one Creative Production run.
 * Single-writer rule (as in F1 to F3): only the Creative Coordinator mutates it, in response to Mozaik events. Binaries are
 * never stored here: only asset ids and metadata.
 */
export const CREATIVE_KEYS = ['copywriter', 'visual', 'layout', 'landing', 'reviewer', 'fixer', 'researcher', 'selector', 'templateReviewer'] as const;
export type CreativeKey = (typeof CREATIVE_KEYS)[number];

export const CREATIVE_INFO: Record<CreativeKey, { code: string; name: string; role: string; usesModel: boolean }> = {
  copywriter: { code: 'A19', name: 'Copywriter', role: 'Channel-specific copy and creative concepts', usesModel: true },
  visual: { code: 'A20', name: 'Visual Creator', role: 'Original base images through the image model', usesModel: true },
  layout: { code: 'A21', name: 'Layout Designer', role: 'Deterministic channel layouts from the base images (no model call)', usesModel: false },
  landing: { code: 'A22', name: 'Landing Content Builder', role: 'Structured landing page content', usesModel: true },
  reviewer: { code: 'A23', name: 'Content & Brand Reviewer', role: 'Deterministic checks plus text and vision review', usesModel: true },
  fixer: { code: 'A24', name: 'Fixer', role: 'Plans and requests repairs, preserves originals (created only when issues are found)', usesModel: false },
  // Hybrid Production only
  researcher: { code: 'A25', name: 'Visual Researcher', role: 'Visual Direction Brief from the brand, the strategy, the style library and the references the user is allowed to share (one optional text-model call refines it)', usesModel: true },
  selector: { code: 'A26', name: 'Template Selector', role: 'Chooses a library template for every template creative (deterministic scoring; optionally one text-model call re-ranks a validated shortlist)', usesModel: false },
  templateReviewer: { code: 'A27', name: 'Template Quality Reviewer', role: 'Verifies the template side of the export: every planned creative exists as a real render with lineage, the right size and no duplicate output', usesModel: false },
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
  /** Several original images per concept (the allocation plan decides how many each). */
  variations?: boolean;
  imageConcurrency?: number;
  approvedBudgetUsd?: number | null;
  /** Hybrid Production: original images and template creatives planned. */
  hybrid?: { originals: number; templateCreatives: number } | null;
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
  /** The allocation plan and one record per planned original image (empty/null with one image per concept). */
  allocation: ImageAllocationPlan | null;
  variations: ImageVariationRecord[];
  /** Art direction notes per concept from the concept critique (before the images); empty when there was none. */
  conceptNotes: Record<string, string>;
  /** The concept critique before the images (null when it did not run), the concept texts it changed, the rubric per review round, and work left out. */
  conceptReview: { critique: ConceptCritique | null; modelReview: 'done' | 'failed' | 'skipped'; flagged: string[]; revised: string[]; note: string } | null;
  conceptHistory: { conceptId: string; field: 'visualIdea'; before: string; after: string; reason: string }[];
  rubrics: { round: number; scores: Rubric }[];
  skipped: { what: string; reason: string }[];
  layouts: LayoutRecord[];
  skippedLayouts: SkippedLayout[];
  /** Hybrid Production: the visual direction, the quota plan, the template selection, what happened to each template creative, and the quality report. */
  direction: VisualDirectionBrief | null;
  directionRefined: boolean;
  /** What web visual discovery found (candidates and reference links; nothing in it is part of the campaign). */
  discovery: DiscoverySummary | null;
  hybridPlan: HybridPlan | null;
  selection: TemplateSelectionPlan | null;
  templateCreatives: TemplateCreativeRecord[];
  templateQuality: TemplateQualityReport | null;
  /** NO AI HYBRID: what the Visual Researcher sourced (pictures, rights, allocation) and how many image requests the guard refused. */
  imagery: ImageryBlock | null;
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
  allocation: ImageAllocationPlan | null = null;
  readonly variations: ImageVariationRecord[] = [];
  conceptNotes: Record<string, string> = {};
  conceptReview: CreativeBoard['conceptReview'] = null;
  readonly conceptHistory: CreativeBoard['conceptHistory'] = [];
  readonly rubrics: CreativeBoard['rubrics'] = [];
  readonly skipped: CreativeBoard['skipped'] = [];
  readonly layouts: LayoutRecord[] = [];
  readonly skippedLayouts: CreativeBoard['skippedLayouts'] = [];
  direction: VisualDirectionBrief | null = null;
  directionRefined = false;
  discovery: DiscoverySummary | null = null;
  hybridPlan: HybridPlan | null = null;
  selection: TemplateSelectionPlan | null = null;
  readonly templateCreatives: TemplateCreativeRecord[] = [];
  templateQuality: TemplateQualityReport | null = null;
  imagery: ImageryBlock | null = null;
  readonly findings: ReviewFindingRecord[] = [];
  readonly revisions: RevisionRecord[] = [];
  readonly crosschecks: CrosscheckRecord[] = [];
  readonly summaries: Record<string, string> = {};
  readonly participantStatuses: ParticipantStatus[] = [];
  round = 0;
  readonly limitations: string[] = [];
  private counters = new Map<string, number>();

  /** Continues numbering after the highest id already present (an image-only continuation starts from an earlier campaign's ids). */
  seedCounters() {
    const max = (list: { id: string }[], prefix: string) => list.reduce((m, x) => Math.max(m, Number(x.id.slice(prefix.length)) || 0), 0);
    this.counters.set('K', max(this.concepts, 'K'));
    this.counters.set('V', max(this.variants, 'V'));
  }

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
      allocation: this.allocation,
      variations: this.variations,
      conceptNotes: this.conceptNotes,
      conceptReview: this.conceptReview,
      conceptHistory: this.conceptHistory,
      rubrics: this.rubrics,
      skipped: this.skipped,
      layouts: this.layouts,
      skippedLayouts: this.skippedLayouts,
      direction: this.direction,
      directionRefined: this.directionRefined,
      discovery: this.discovery,
      hybridPlan: this.hybridPlan,
      selection: this.selection,
      templateCreatives: this.templateCreatives,
      templateQuality: this.templateQuality,
      imagery: this.imagery,
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
