/**
 * Marketing channel ids. New campaigns (V4) plan the five social platforms in CAMPAIGN_SOCIAL_CHANNELS; the other ids stay
 * valid because strategies and campaigns saved earlier use them.
 */
export const CHANNELS = [
  { id: 'x', name: 'X', short: 'X', social: 'x' },
  { id: 'instagram', name: 'Instagram', short: 'IG', social: 'instagram' },
  { id: 'facebook', name: 'Facebook', short: 'FB', social: 'facebook' },
  { id: 'linkedin', name: 'LinkedIn', short: 'LI', social: 'linkedin' },
  { id: 'youtube', name: 'YouTube', short: 'YT', social: 'youtube' },
  { id: 'tiktok', name: 'TikTok', short: 'TT', social: 'tiktok' },
  { id: 'google_search', name: 'Google Search', short: 'GS', social: null },
  { id: 'email', name: 'Email Marketing', short: 'EM', social: null },
  { id: 'organic_content', name: 'Organic Content', short: 'OC', social: null },
  { id: 'community', name: 'Community', short: 'CM', social: null },
] as const;

export type ChannelId = (typeof CHANNELS)[number]['id'];
export const CHANNEL_IDS = CHANNELS.map((c) => c.id) as unknown as readonly [ChannelId, ...ChannelId[]];

export const channelById = (id: string) => CHANNELS.find((c) => c.id === id);

/** The social platforms every new campaign covers: the Marketing Strategist evaluates each one and the strategy may only recommend these. */
export const CAMPAIGN_SOCIAL_CHANNELS = ['x', 'tiktok', 'facebook', 'instagram', 'linkedin'] as const satisfies readonly ChannelId[];
export type CampaignSocialChannel = (typeof CAMPAIGN_SOCIAL_CHANNELS)[number];
export const isCampaignSocialChannel = (id: string): id is CampaignSocialChannel => (CAMPAIGN_SOCIAL_CHANNELS as readonly string[]).includes(id);
