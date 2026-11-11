import type { InferenceGateway } from '../../../ai/gateway';
import type { ImageGenerator, ImageQuality, ImageSize } from '../../../ai/openai-images';
import type { F1Context } from '../../../audit/context';
import type { SourceStore } from '../../../discovery/f1/board';
import type { AssetStore } from '../../../creative/assets';
import type { CreativeBoardStore } from '../../../creative/board';
import type { CreativeInput, F3Context } from '../../../creative/context';
import type { ContinuationSeed } from '../../../creative/continuation';
import type { VisualBrief } from '../../../creative/visual-brief';
import type { CampaignDesign } from '../../../collections/design';
import type { TemplateCollection } from '../../../collections/schema';
import type { VisualDiscoveryPort } from '../../../imagery/discovery';
import type { ImageAnalysis } from '../../../imagery/analysis';
import type { ImageRights } from '../../../imagery/rights';
import type { ImageCandidate } from '../../../imagery/types';
import type { HybridSettings } from '../../../hybrid/settings';
import type { TemplateDef } from '../../../templates/schema';
import type { CreativeFormat } from '../../../creative/formats';
import type { ChannelId } from '../../../strategy/channels';
import type { RunContext } from '../../run-context';
import type { PhaseAgent } from '../f1/agent';

export interface F4Settings {
  model: string;
  /** Output cap for copy/landing/visual-planning calls. */
  analystTokens: number;
  reviewTokens: number;
  maxModelCalls: number;
  /** Cross-checks between the copy and the landing page (each costs one call). */
  maxCrossChecks: number;
  /** Review/repair rounds after the first review. Default 2. */
  maxRepairRounds: number;
  /** Exported assets the reviewer may SEE with the vision model per round. 0 = no vision review. */
  visionReviews: number;
  /** false = no image model is called: layouts use deterministic brand-colored backgrounds. */
  imageGeneration: boolean;
  imageModel: string | null;
  imageQuality: ImageQuality;
  imageSize: ImageSize;
  /** The user chose one size for every image (otherwise each image gets the size of the formats cut from it). */
  imageSizeExplicit: boolean;
  allowRegeneration: boolean;
  maxLayoutsPerConcept: number;
  formats: { format: CreativeFormat; channel: ChannelId }[];
  /** Depth: the concepts are critiqued before any image is paid for, and the review gets more room. */
  depth: boolean;
  /** Several original images per concept, placed by the allocation planner. false = one image per concept (First Test, Demo). */
  variations: boolean;
  /** Original AI images planned (the target of the allocation planner). */
  imageTarget: number;
  /** Original images requested at the same time (each is its own provider request). */
  imageConcurrency: number;
  /** Layout formats cut from each original. */
  layoutsPerOriginal: number;
  /** Cap on copy variants over all concepts. */
  maxVariants: number;
  /** Output cap of one picture-planning request (several images are planned per request when it allows). */
  visualPlanTokens: number;
  /** The strategy's channel ranking, best first. */
  channelPriority: ChannelId[];
  /** The approved spending limit in dollars (null = none); enforced by the run's spend controller. */
  approvedBudgetUsd: number | null;
  /** Hybrid Production: a few original AI images plus template creatives rendered locally from them. null on every other preset. */
  hybrid: HybridSettings | null;
  /** NO AI HYBRID: no image-generation request is ever made (imageGeneration is false and the OpenAI client refuses image requests). */
  noAiImages: boolean;
  agentTimeoutMs: number;
  visualTimeoutMs: number;
  reviewTimeoutMs: number;
  repairTimeoutMs: number;
  productionTimeoutMs: number;
  fixtureSources: boolean;
  now: Date;
}

export interface F4Tools {
  /** null when image generation is off. */
  images: ImageGenerator | null;
  assets: AssetStore;
}

/** A brand image of the project (already read and size-limited by the backend). Used as a picture when a concept has no AI original. */
export interface BrandImage {
  id: string;
  name: string;
  data: Buffer;
  /** NO AI HYBRID: where it came from, its rights, its measurements and its words (absent for earlier campaigns and for Hybrid Production) */
  library?: LibraryImageInfo;
}

/** What the NO AI HYBRID pipeline knows about one library picture. The bytes are in BrandImage.data. */
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

/** A licensed picture the Visual Researcher chose in automatic stock mode: downloaded through the guarded fetcher, stored with its provenance, returned as a library picture. */
export type ImageAcquirePort = (candidate: ImageCandidate, signal?: AbortSignal) => Promise<{ ok: true; image: BrandImage } | { ok: false; message: string }>;

/** Hybrid Production environment: the template library, the brand images and the reference palettes the user shared. */
export interface HybridEnv {
  library: readonly TemplateDef[];
  libraryVersion: string;
  brandName: string;
  brandImages: BrandImage[];
  /** Palettes extracted (by the backend) from reference images the USER owns. Pinterest and links never appear here. */
  referencePalettes: Record<string, string[]>;
  industryText: string;
  /** The approved campaign design and its collection (null = a campaign configured before collections). When set, `library` holds ONLY the collection's templates, drawn with its tokens. */
  design: CampaignDesign | null;
  collection: TemplateCollection | null;
  /** The approved neutral surfaces (ink = the darker, paper = the lighter), used exactly by the renderer. */
  anchors: { ink: string; paper: string } | null;
  /** Web visual discovery (configured providers only); null = none available. */
  discovery: VisualDiscoveryPort | null;
  /** NO AI HYBRID: how the Visual Researcher may add licensed pictures during the run (automatic stock mode). null = it may not. */
  acquire: ImageAcquirePort | null;
  /** NO AI HYBRID: how many picture candidates the project's image gallery already knows (website, repository, licensed, uploads) before the run starts. Reported, never used as pictures. */
  discoveredBefore: number;
}

/** The brand material the owner approved with Get Content (absent when the owner never used it: the run then behaves exactly as before). */
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
  /** Brand colors (#rrggbb): F1's measured palette, else derived from the logo, else neutral. */
  palette: string[];
  hasBrandPalette: boolean;
  logo: Buffer | null;
  agents: Map<string, PhaseAgent>;
  /** What the Visual Creator and the image prompts know about the business (copied from F1/F3, never written by a model). */
  visualBrief: VisualBrief;
  /** Set for an image-only continuation: what the earlier campaign already has (copy, landing, plan, originals, layouts). */
  seed: ContinuationSeed | null;
  /** Hybrid Production only. */
  hybrid: HybridEnv | null;
  /** Brand content approved with Get Content (logo, photographs); null = the owner did not use Get Content. */
  brand: BrandContext | null;
  /** NO AI HYBRID: image-generation requests that something attempted and the guard refused (nothing was ever sent). */
  imageRefusals: { count: number };
  /** Creates the Fixer participant on demand (the coordinator joins it to the live runtime). */
  createFixer(): PhaseAgent;
}
