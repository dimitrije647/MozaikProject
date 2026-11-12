import type { InferenceGateway } from '../../../ai/gateway';
import type { F1Context } from '../../../audit/context';
import type { SourceStore } from '../../../discovery/f1/board';
import type { AssetStore } from '../../../creative/assets';
import type { CreativeBoardStore } from '../../../creative/board';
import type { CreativeInput, F3Context } from '../../../creative/context';
import type { VisualBrief } from '../../../creative/visual-brief';
import type { CampaignDesign } from '../../../collections/design';
import type { TemplateCollection } from '../../../collections/schema';
import type { VisualDiscoveryPort } from '../../../imagery/discovery';
import type { ImageAnalysis } from '../../../imagery/analysis';
import type { ImageRights } from '../../../imagery/rights';
import type { ImageCandidate } from '../../../imagery/types';
import type { HybridSettings } from '../../../hybrid/settings';
import type { TemplateDef } from '../../../templates/schema';
import type { RunContext } from '../../run-context';
import type { PhaseAgent } from '../f1/agent';
import type { CopyPlan } from '../../../copywriting/plan';

export interface F4Settings {
  model: string;
  /** Output cap of the Content Writer's answer. */
  writerTokens: number;
  reviewTokens: number;
  maxModelCalls: number;
  /** Repair rounds after the first review (each: one copy revision + re-renders + one review). Default 1. */
  maxRepairRounds: number;
  /** Rendered creatives the Quality Reviewer may SEE with the model per round. 0 = no vision review. */
  visionReviews: number;
  /** The visual settings of the campaign (design, facts, picture sourcing). */
  visual: HybridSettings;
  approvedBudgetUsd: number | null;
  agentTimeoutMs: number;
  sourcingTimeoutMs: number;
  designTimeoutMs: number;
  reviewTimeoutMs: number;
  repairTimeoutMs: number;
  fixtureSources: boolean;
  now: Date;
}

export interface F4Tools {
  assets: AssetStore;
}

/** A picture of the project's approved library (already read and size-limited by the backend). */
export interface BrandImage {
  id: string;
  name: string;
  data: Buffer;
  /** Where it came from, its rights, its measurements and its words (absent: treated as the user's own upload). */
  library?: LibraryImageInfo;
}

/** What the pipeline knows about one library picture. The bytes are in BrandImage.data. */
export interface LibraryImageInfo {
  rights: ImageRights;
  analysis: ImageAnalysis | null;
  /** title, alt text, file name, tags: what the picture is described by */
  text: string;
  width: number | null;
  height: number | null;
  pageUrl: string | null;
  via: 'library' | 'auto_stock';
}

/** A licensed picture the Visual Researcher chose in automatic stock mode: downloaded through the guarded fetcher, stored with its provenance. */
export type ImageAcquirePort = (candidate: ImageCandidate, signal?: AbortSignal) => Promise<{ ok: true; image: BrandImage } | { ok: false; message: string }>;

/** The visual environment of one run: the collection's templates, the approved pictures and how licensed pictures may be added. */
export interface HybridEnv {
  library: readonly TemplateDef[];
  libraryVersion: string;
  brandName: string;
  brandImages: BrandImage[];
  /** Palettes extracted (by the backend) from reference images the USER owns. Pinterest and links never appear here. */
  referencePalettes: Record<string, string[]>;
  industryText: string;
  /** The approved campaign design and its collection (null = no design: the whole template library and the style matcher are used). */
  design: CampaignDesign | null;
  collection: TemplateCollection | null;
  /** The approved neutral surfaces (ink = the darker, paper = the lighter), used exactly by the renderer. */
  anchors: { ink: string; paper: string } | null;
  /** Licensed picture search (configured providers only); null = none available. */
  discovery: VisualDiscoveryPort | null;
  /** How the Visual Researcher may add licensed pictures during the run (automatic stock mode). null = it may not. */
  acquire: ImageAcquirePort | null;
  /** How many picture candidates the project's image gallery already knows before the run starts. Reported, never used as pictures. */
  discoveredBefore: number;
}

/** The brand material the owner approved with Get Content (absent when the owner never used it). */
export interface BrandContext {
  logo: { approved: true; assetId: string; source: string; fileName: string; width: number | null; height: number | null } | null;
  approvedPhotos: number;
  approvedAt: string | null;
}

/** Everything the F4 participants share for ONE run. Holds no credentials. */
export interface F4Env {
  ctx: RunContext;
  gateway: InferenceGateway;
  store: SourceStore;
  board: CreativeBoardStore;
  f1: F1Context;
  f3: F3Context;
  input: CreativeInput;
  settings: F4Settings;
  tools: F4Tools;
  /** Brand colors (#rrggbb): the approved design palette, else the measured one, else neutral. */
  palette: string[];
  hasBrandPalette: boolean;
  logo: Buffer | null;
  agents: Map<string, PhaseAgent>;
  /** What the business is about (copied from F1/F3, never written by a model): used for the visual direction and the picture search. */
  visualBrief: VisualBrief;
  hybrid: HybridEnv;
  /** Brand content approved with Get Content (logo, photographs); null = the owner did not use Get Content. */
  brand: BrandContext | null;
  /** The copywriting plan (purpose, principles, Brand Voice Profile, placement limits): written by no model, read by the writer and the reviewer. */
  copyPlan: CopyPlan;
}
