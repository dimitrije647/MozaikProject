import type { InferenceGateway } from '../../../ai/gateway';
import type { ImageGenerator, ImageQuality, ImageSize } from '../../../ai/openai-images';
import type { F1Context } from '../../../audit/context';
import type { SourceStore } from '../../../discovery/f1/board';
import type { AssetStore } from '../../../creative/assets';
import type { CreativeBoardStore } from '../../../creative/board';
import type { CreativeInput, F3Context } from '../../../creative/context';
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
  allowRegeneration: boolean;
  maxLayoutsPerConcept: number;
  formats: { format: CreativeFormat; channel: ChannelId }[];
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
  /** Creates the Fixer participant on demand (the coordinator joins it to the live runtime). */
  createFixer(): PhaseAgent;
}
