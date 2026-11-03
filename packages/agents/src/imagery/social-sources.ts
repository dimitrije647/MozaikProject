import { platformOfHost } from '../tools/html';

/**
 * SOCIAL MEDIA SOURCES. LaunchPilot has NO integration that reads pictures from Instagram, Facebook, LinkedIn or TikTok, so none is claimed and
 * nothing is fetched from them: no scraping, no Google-search proxy, no login. For every business profile link the project holds, this module says
 * plainly what is possible:
 *
 *   - the link is shown, so a person can open the profile and look
 *   - a picture the owner holds the rights to can be uploaded BY HAND (it then becomes an upload with a note naming the profile)
 *   - nothing on the platform becomes an advertising asset by being public
 *
 * Pinterest results are links only, whatever the account state: a pin never becomes an asset. Social discovery is optional; a campaign needs none.
 */

export type SocialSourcePlatform = 'instagram' | 'facebook' | 'linkedin' | 'pinterest' | 'twitter' | 'youtube' | 'tiktok' | 'reddit' | 'other';

export interface SocialSourceInfo {
  platform: SocialSourcePlatform;
  url: string;
  /** where the link came from */
  origin: 'project_profile' | 'found_on_website';
  /** always 'reference_link': LaunchPilot reads nothing from the platform */
  access: 'reference_link';
  /** LaunchPilot has an authorized read integration for this platform */
  apiAvailable: false;
  /** the plain-language limitation */
  note: string;
  /** how the owner can still use a picture of theirs */
  manualImport: string;
}

const NOTES: Record<SocialSourcePlatform, string> = {
  instagram: 'Instagram media can be read only through Meta\'s official API for an account the owner connects. LaunchPilot has no Meta integration, so nothing is read: the link is a reference.',
  facebook: 'Facebook page media can be read only through Meta\'s official API for a page the owner connects. LaunchPilot has no Meta integration, so nothing is read: the link is a reference.',
  linkedin: 'LinkedIn does not offer a public API for reading company page pictures for this purpose. LaunchPilot has no LinkedIn integration, so nothing is read: the link is a reference.',
  pinterest: 'Pinterest content is link-only in LaunchPilot. A pin is never downloaded, stored, analysed or used in a creative, even when a Pinterest account is connected.',
  twitter: 'LaunchPilot has no integration with X and reads nothing from it: the link is a reference.',
  youtube: 'LaunchPilot has no YouTube picture integration and reads nothing from it: the link is a reference.',
  tiktok: 'LaunchPilot has no TikTok integration and reads nothing from it: the link is a reference.',
  reddit: 'LaunchPilot reads nothing from Reddit: the link is a reference.',
  other: 'LaunchPilot has no integration with this site and reads nothing from it: the link is a reference.',
};

const MANUAL = 'If you own a picture shown there (or hold the rights to it), save it yourself and upload it here. It then counts as your own upload.';

function platformOf(url: string): SocialSourcePlatform | null {
  try {
    const p = platformOfHost(new URL(url).hostname) as string | null;
    if (!p) return null;
    return (['instagram', 'facebook', 'linkedin', 'pinterest', 'twitter', 'youtube', 'tiktok', 'reddit'] as const).includes(p as never) ? (p as SocialSourcePlatform) : 'other';
  } catch {
    return null;
  }
}

export function describeSocialSources(profiles: readonly { platform: string; url: string }[], found: readonly { platform: string; url: string }[] = []): SocialSourceInfo[] {
  const out: SocialSourceInfo[] = [];
  const add = (p: { platform: string; url: string }, origin: SocialSourceInfo['origin']) => {
    if (!/^https?:\/\//i.test(p.url) || out.some((x) => x.url === p.url)) return;
    const detected = platformOf(p.url);
    const claimed = (p.platform ?? '').toLowerCase();
    const platform: SocialSourcePlatform = detected ?? ((['instagram', 'facebook', 'linkedin', 'pinterest', 'twitter', 'youtube', 'tiktok', 'reddit'] as const).find((x) => x === claimed) ?? 'other');
    out.push({ platform, url: p.url.slice(0, 300), origin, access: 'reference_link', apiAvailable: false, note: NOTES[platform], manualImport: MANUAL });
  };
  for (const p of profiles) add(p, 'project_profile');
  for (const p of found) add(p, 'found_on_website');
  return out.slice(0, 12);
}
