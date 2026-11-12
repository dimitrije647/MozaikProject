import type { DeliverableKind } from '../creative/schemas';
import type { ChannelId } from '../strategy/channels';
import type { FormatClass } from '../templates/schema';

/**
 * The planned creatives of a campaign ("slots"). They come from the deliverables plan (hybrid/deliverables.ts): one creative per planned
 * deliverable, each with its channel, its exact format and, after picture sourcing, the approved picture it is drawn with. Nothing here calls
 * a model and nothing generates an image.
 */

/** The formats a channel may fall back to when no template of the collection fits the planned one (social posts only; print and ads never move). */
export const HYBRID_FORMATS: Record<ChannelId, string[]> = {
  x: ['x_post', 'instagram_square'],
  instagram: ['instagram_portrait', 'instagram_square', 'story'],
  facebook: ['facebook_feed', 'instagram_square', 'story'],
  linkedin: ['linkedin_feed', 'instagram_square', 'instagram_portrait'],
  youtube: ['promo_16x9', 'landing_hero'],
  tiktok: ['story'],
  google_search: ['promo_16x9', 'web_banner', 'instagram_square', 'landing_hero'],
  email: ['landing_hero', 'promo_16x9', 'web_banner', 'instagram_square'],
  organic_content: ['instagram_square', 'instagram_portrait', 'promo_16x9'],
  community: ['instagram_square', 'instagram_portrait'],
};

export interface TemplateSlot {
  slotId: string;
  conceptId: string;
  conceptName: string;
  /** 1-based position within the concept. */
  index: number;
  channel: ChannelId;
  formatId: string;
  width: number;
  height: number;
  formatClass: FormatClass;
  /** LEGACY (campaigns with AI originals). Always null in V4. */
  variationId: string | null;
  /** brand_image = an approved picture is assigned; none = typography-first. ('ai_original' only in campaigns made before V4.) */
  source: 'ai_original' | 'brand_image' | 'none';
  /** The approved library picture this creative is built from (set after picture sourcing), a second picture for templates that have one, and the crop focus. */
  imageId?: string | null;
  secondaryImageId?: string | null;
  focus?: [number, number] | null;
  /** V4: which deliverable this creative is, how it is labelled and where it goes in the ZIP. */
  kind?: DeliverableKind;
  label?: string;
  folder?: string;
  /** true = the format may not be adapted (a billboard never becomes a square post). */
  fixedFormat?: boolean;
}

export interface HybridPlan {
  slots: TemplateSlot[];
  perConcept: { conceptId: string; name: string; templates: number; channels: ChannelId[] }[];
  rules: string[];
  warnings: string[];
}
