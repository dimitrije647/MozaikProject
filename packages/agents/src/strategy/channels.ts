/**
 * Marketing channels F3 can evaluate. Each one can become a dedicated Channel Scout, a separate Mozaik
 * participant that is created only when the Strategy Coordinator finds the channel relevant (see scouts.ts).
 */
export const CHANNELS = [
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
export const scoutName = (id: ChannelId) => `${channelById(id)!.name} Scout`;
export const channelOfScoutName = (name: string): ChannelId | undefined => CHANNELS.find((c) => scoutName(c.id) === name)?.id;
