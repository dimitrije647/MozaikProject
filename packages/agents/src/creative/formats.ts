import type { ChannelId } from '../strategy/channels';

/**
 * Creative formats the Layout Designer can export. Sizes and safe areas are CONFIGURABLE DEFAULTS, not permanent platform
 * specifications: platforms change them. The safe margins keep text and the logo away from edges and from areas the platform
 * UI typically covers (for example the top and bottom of Stories, where Meta recommends leaving roughly 14% free).
 */
export interface CreativeFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Fractions of the height/width kept free of text, logo and CTA. */
  safe: { top: number; bottom: number; left: number; right: number };
  channels: ChannelId[];
}

export const CREATIVE_FORMATS: Record<string, CreativeFormat> = {
  instagram_square: { id: 'instagram_square', label: 'Instagram feed (square)', width: 1080, height: 1080, safe: { top: 0.07, bottom: 0.07, left: 0.08, right: 0.08 }, channels: ['instagram', 'facebook', 'organic_content', 'community', 'email', 'google_search', 'tiktok'] },
  instagram_portrait: { id: 'instagram_portrait', label: 'Instagram feed (portrait 4:5)', width: 1080, height: 1350, safe: { top: 0.07, bottom: 0.08, left: 0.08, right: 0.08 }, channels: ['instagram', 'facebook'] },
  story: { id: 'story', label: 'Instagram / Facebook Story (9:16)', width: 1080, height: 1920, safe: { top: 0.14, bottom: 0.14, left: 0.08, right: 0.08 }, channels: ['instagram', 'facebook', 'tiktok'] },
  facebook_feed: { id: 'facebook_feed', label: 'Facebook feed (landscape)', width: 1200, height: 628, safe: { top: 0.1, bottom: 0.1, left: 0.06, right: 0.06 }, channels: ['facebook'] },
  linkedin_feed: { id: 'linkedin_feed', label: 'LinkedIn feed (landscape)', width: 1200, height: 627, safe: { top: 0.1, bottom: 0.1, left: 0.06, right: 0.06 }, channels: ['linkedin'] },
  promo_16x9: { id: 'promo_16x9', label: 'General promotional graphic (16:9)', width: 1920, height: 1080, safe: { top: 0.08, bottom: 0.08, left: 0.06, right: 0.06 }, channels: ['youtube', 'linkedin', 'organic_content', 'google_search'] },
};

/** Preferred order per channel: the first formats are the most useful for that channel. */
const PREFERENCE: Partial<Record<ChannelId, string[]>> = {
  instagram: ['instagram_square', 'instagram_portrait', 'story'],
  facebook: ['facebook_feed', 'instagram_square', 'story'],
  linkedin: ['linkedin_feed', 'instagram_square'],
  youtube: ['promo_16x9'],
  tiktok: ['story'],
  google_search: ['promo_16x9', 'instagram_square'],
  email: ['promo_16x9', 'instagram_square'],
  organic_content: ['instagram_square', 'promo_16x9'],
  community: ['instagram_square'],
};

/** Which exports apply to the selected channels (deduplicated, in preference order, capped). */
export function formatsForChannels(channels: ChannelId[], cap: number): { format: CreativeFormat; channel: ChannelId }[] {
  const out: { format: CreativeFormat; channel: ChannelId }[] = [];
  const seen = new Set<string>();
  const queue = channels.map((c) => ({ c, list: [...(PREFERENCE[c] ?? ['instagram_square'])] }));
  while (out.length < cap && queue.some((q) => q.list.length)) {
    for (const q of queue) {
      const id = q.list.shift();
      if (!id || seen.has(id) || out.length >= cap) continue;
      seen.add(id);
      out.push({ format: CREATIVE_FORMATS[id], channel: q.c });
    }
  }
  return out;
}

/** The base image size to request so that most selected formats can be cropped from it without blurry upscaling. */
export function baseSizeFor(formats: CreativeFormat[]): '1024x1024' | '1024x1536' | '1536x1024' {
  const ratio = (f: CreativeFormat) => f.width / f.height;
  const tall = formats.filter((f) => ratio(f) < 0.9).length;
  const wide = formats.filter((f) => ratio(f) > 1.2).length;
  if (tall > 0 && tall >= wide) return '1024x1536';
  if (wide > 0 && wide > tall) return '1536x1024';
  return '1024x1024';
}

/** A format can be cut from a base image without more than this much upscaling (more would look blurry). */
export const MAX_UPSCALE = 1.6;
export const upscaleFactor = (srcW: number, srcH: number, f: CreativeFormat) => Math.max(f.width / srcW, f.height / srcH);
