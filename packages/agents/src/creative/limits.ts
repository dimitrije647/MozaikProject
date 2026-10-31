import type { ChannelId } from '../strategy/channels';

/**
 * Text lengths per channel and placement for the Reviewer's deterministic check. A "platform_max" is a limit the platform
 * enforces (longer text is rejected or cut); a "recommended" value is where platforms truncate with "see more" or what their
 * own guidance suggests. CONFIGURABLE DEFAULTS, not permanent specifications: platforms change them, so each entry says
 * where the number comes from. Lengths are counted in characters of the copy as written.
 */
export type LimitField = 'headline' | 'body' | 'description' | 'hashtags';
export type Placement = 'paid_ad' | 'organic_post' | 'story';

export interface TextLimit {
  field: LimitField;
  max: number;
  kind: 'platform_max' | 'recommended';
  note: string;
}

const meta = (headline: number, body: number): TextLimit[] => [
  { field: 'headline', max: headline, kind: 'recommended', note: `Meta recommends headlines of about ${headline} characters.` },
  { field: 'body', max: body, kind: 'recommended', note: `Meta shows about ${body} characters of primary text before "See more".` },
  { field: 'description', max: 30, kind: 'recommended', note: 'Meta recommends link descriptions of about 30 characters.' },
];

export const CHANNEL_TEXT_LIMITS: Partial<Record<ChannelId, Partial<Record<Placement, TextLimit[]>>>> = {
  facebook: { paid_ad: meta(40, 125), story: [{ field: 'body', max: 125, kind: 'recommended', note: 'Story text overlays stay readable up to about 125 characters.' }] },
  instagram: {
    paid_ad: meta(40, 125),
    organic_post: [{ field: 'hashtags', max: 5, kind: 'recommended', note: 'Instagram recommends three to five hashtags per post.' }],
    story: [{ field: 'body', max: 125, kind: 'recommended', note: 'Story text overlays stay readable up to about 125 characters.' }],
  },
  linkedin: {
    paid_ad: [
      { field: 'body', max: 150, kind: 'recommended', note: 'LinkedIn shows about 150 characters of introductory text before truncation.' },
      { field: 'headline', max: 70, kind: 'recommended', note: 'LinkedIn recommends headlines under 70 characters (maximum 200).' },
      { field: 'description', max: 100, kind: 'recommended', note: 'LinkedIn recommends descriptions under 100 characters.' },
    ],
    organic_post: [{ field: 'body', max: 210, kind: 'recommended', note: 'LinkedIn truncates posts at about 210 characters with "see more".' }],
  },
  google_search: {
    paid_ad: [
      { field: 'headline', max: 30, kind: 'platform_max', note: 'Google responsive search ads allow headlines of 30 characters.' },
      { field: 'body', max: 90, kind: 'platform_max', note: 'Google responsive search ads allow descriptions of 90 characters.' },
    ],
  },
  youtube: {
    paid_ad: [
      { field: 'headline', max: 100, kind: 'platform_max', note: 'YouTube in-feed ads allow headlines of 100 characters.' },
      { field: 'body', max: 70, kind: 'platform_max', note: 'YouTube in-feed ads allow two description lines of 35 characters.' },
    ],
  },
  tiktok: { paid_ad: [{ field: 'body', max: 100, kind: 'platform_max', note: 'TikTok ad text allows 1 to 100 characters.' }] },
  email: {
    paid_ad: [
      { field: 'headline', max: 60, kind: 'recommended', note: 'Email subject lines display fully up to about 60 characters.' },
      { field: 'description', max: 90, kind: 'recommended', note: 'Email preheaders display up to about 90 characters.' },
    ],
    organic_post: [{ field: 'headline', max: 60, kind: 'recommended', note: 'Email subject lines display fully up to about 60 characters.' }],
  },
};

export function limitsFor(channel: string, placement: string): TextLimit[] {
  return CHANNEL_TEXT_LIMITS[channel as ChannelId]?.[placement as Placement] ?? [];
}
