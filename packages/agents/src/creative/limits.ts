import type { ChannelId } from '../strategy/channels';

/**
 * Text lengths per channel and placement for the Reviewer's deterministic check. A "platform_max" is a limit the platform
 * enforces (longer text is rejected or cut); a "recommended" value is where platforms truncate with "see more" or what their
 * own guidance suggests. CONFIGURABLE DEFAULTS, not permanent specifications: platforms change them, so each entry says
 * where the number comes from. Lengths are counted in characters of the copy as written.
 */
/** post = the whole published text (body plus hashtags), as platforms such as X count it. */
export type LimitField = 'headline' | 'body' | 'description' | 'hashtags' | 'post';
/** V4 placements: social_post, web_ad, display_ad, billboard, flyer. paid_ad / organic_post / story come from campaigns made before V4. */
export type Placement = 'paid_ad' | 'organic_post' | 'story' | 'social_post' | 'web_ad' | 'display_ad' | 'billboard' | 'flyer';

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
  x: {
    social_post: [
      { field: 'post', max: 280, kind: 'platform_max', note: 'X allows 280 characters per post for standard accounts (text and hashtags together).' },
      { field: 'hashtags', max: 2, kind: 'recommended', note: 'X recommends no more than one or two hashtags per post.' },
    ],
  },
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

/** V4 social posts (organic posts of the five platforms) and the ad / print deliverables. */
const SOCIAL_POST_LIMITS: Partial<Record<ChannelId, TextLimit[]>> = {
  instagram: [
    { field: 'body', max: 2200, kind: 'platform_max', note: 'Instagram captions allow 2,200 characters.' },
    { field: 'body', max: 125, kind: 'recommended', note: 'Instagram shows about 125 characters before "more".' },
    { field: 'hashtags', max: 5, kind: 'recommended', note: 'Instagram recommends three to five hashtags per post.' },
  ],
  facebook: [{ field: 'body', max: 125, kind: 'recommended', note: 'Facebook shows about 125 characters of a post before "See more".' }],
  linkedin: [
    { field: 'body', max: 3000, kind: 'platform_max', note: 'LinkedIn posts allow 3,000 characters.' },
    { field: 'body', max: 210, kind: 'recommended', note: 'LinkedIn truncates posts at about 210 characters with "see more".' },
    { field: 'hashtags', max: 5, kind: 'recommended', note: 'LinkedIn suggests a few relevant hashtags, not more than about five.' },
  ],
  tiktok: [
    { field: 'body', max: 2200, kind: 'platform_max', note: 'TikTok captions allow 2,200 characters.' },
    { field: 'body', max: 150, kind: 'recommended', note: 'Short TikTok captions are read in full on the video.' },
    { field: 'hashtags', max: 5, kind: 'recommended', note: 'A handful of relevant hashtags works best on TikTok.' },
  ],
};
const DELIVERABLE_LIMITS: Partial<Record<Placement, TextLimit[]>> = {
  web_ad: [
    { field: 'headline', max: 30, kind: 'recommended', note: 'Google responsive display ads: short headlines of up to 30 characters.' },
    { field: 'body', max: 90, kind: 'recommended', note: 'Google responsive display ads: descriptions of up to 90 characters.' },
  ],
  display_ad: [
    { field: 'headline', max: 30, kind: 'recommended', note: 'Google responsive display ads: short headlines of up to 30 characters.' },
    { field: 'body', max: 90, kind: 'recommended', note: 'Google responsive display ads: descriptions of up to 90 characters.' },
  ],
  billboard: [{ field: 'headline', max: 50, kind: 'recommended', note: 'A billboard is read in a few seconds: about seven words.' }],
  flyer: [{ field: 'body', max: 400, kind: 'recommended', note: 'A flyer stays readable with a short body text.' }],
};

export function limitsFor(channel: string, placement: string): TextLimit[] {
  if (placement === 'social_post') return [...(CHANNEL_TEXT_LIMITS[channel as ChannelId]?.social_post ?? []), ...(SOCIAL_POST_LIMITS[channel as ChannelId] ?? [])];
  if (DELIVERABLE_LIMITS[placement as Placement]) return DELIVERABLE_LIMITS[placement as Placement]!;
  return CHANNEL_TEXT_LIMITS[channel as ChannelId]?.[placement as Placement] ?? [];
}
