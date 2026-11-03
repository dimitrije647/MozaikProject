import type { LicenseVerdict } from './types';

/**
 * LICENSE VERDICTS for the providers LaunchPilot can search. Based on each provider's own license and API terms (read on 2026-11-02); where a
 * term is not clear the verdict says needs_review, never cleared. A license that allows commercial use is not by itself permission to use a
 * picture of an identifiable person in an advertisement, so pictures that show people are always sent to review.
 *
 * Not supported on purpose:
 *   - Pinterest, Google Images, Bing, Brave and Tavily image results: they grant no reuse right at all (REFERENCE_ONLY)
 *   - Unsplash: its API requires hotlinked image URLs and a download-tracking call, and does not clearly cover storing a cropped derivative
 *     for an advertisement; it can be added when Unsplash confirms that use.
 */

const PEOPLE = /\b(person|people|man|men|woman|women|girl|boy|child|children|kid|baby|portrait|face|model|couple|family|team|crowd|selfie|human)\b/i;

export const showsPeople = (tags: readonly string[], title = ''): boolean => PEOPLE.test(`${tags.join(' ')} ${title}`);

const PEOPLE_NOTE = 'The picture appears to show people. A license for commercial use does not clear showing an identifiable person in an advertisement: check the source, or use another picture.';

export function pixabayVerdict(o: { tags: readonly string[]; title: string; user: string | null; pageUrl: string }): LicenseVerdict {
  const people = showsPeople(o.tags, o.title);
  return {
    status: people ? 'needs_review' : 'cleared',
    license: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/license-summary/',
    commercialUse: true,
    derivatives: true,
    redistributeOriginal: false,
    attributionRequired: false,
    attribution: o.user ? `Image by ${o.user} on Pixabay` : null,
    reasons: [
      'The Pixabay Content License allows commercial use and modification (cropping, resizing, text overlays); credit is optional. It does not allow selling the picture on its own.',
      ...(people ? [PEOPLE_NOTE] : []),
    ],
  };
}

export function pexelsVerdict(o: { tags: readonly string[]; title: string; photographer: string | null }): LicenseVerdict {
  const people = showsPeople(o.tags, o.title);
  return {
    status: people ? 'needs_review' : 'cleared',
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    commercialUse: true,
    derivatives: true,
    redistributeOriginal: false,
    attributionRequired: false,
    attribution: o.photographer ? `Photo by ${o.photographer} on Pexels` : null,
    reasons: [
      'The Pexels License allows free commercial use and modification without attribution. It forbids implying an endorsement by the people or brands shown and selling unaltered copies.',
      'Pexels asks for a visible credit to the photographer and a link to Pexels when its API is used.',
      ...(people ? [PEOPLE_NOTE] : []),
    ],
  };
}

/** Openverse reports the license of each work but "does not verify its licensing status": every result needs a check at the source. */
export function openverseVerdict(o: { license: string | null; version: string | null; licenseUrl: string | null; attribution: string | null; tags: readonly string[]; title: string }): LicenseVerdict {
  const raw = (o.license ?? '').toLowerCase().trim();
  const name = raw ? `${raw === 'cc0' ? 'CC0' : raw === 'pdm' ? 'Public Domain Mark' : `CC ${raw.toUpperCase()}`}${o.version ? ` ${o.version}` : ''}` : 'unknown license';
  const base = { license: name, licenseUrl: o.licenseUrl };
  if (!raw) return { ...base, status: 'blocked', commercialUse: false, derivatives: false, attributionRequired: false, attribution: null, reasons: ['No license is stated, so no use is allowed.'] };
  if (/(^|-)nc(-|$)|nc-sampling/.test(raw)) return { ...base, status: 'blocked', commercialUse: false, derivatives: false, attributionRequired: true, attribution: o.attribution, reasons: ['A NonCommercial license does not allow use in a client\'s advertising.'] };
  if (/(^|-)nd(-|$)/.test(raw)) return { ...base, status: 'blocked', commercialUse: true, derivatives: false, attributionRequired: true, attribution: o.attribution, reasons: ['A NoDerivatives license does not allow cropping or laying text over the picture.'] };
  const people = showsPeople(o.tags, o.title);
  const review = (reasons: string[], attributionRequired: boolean, redistributeOriginal = false): LicenseVerdict => ({ ...base, status: 'needs_review', commercialUse: true, derivatives: true, redistributeOriginal, attributionRequired, attribution: o.attribution, reasons: [...reasons, 'Openverse does not verify licenses: confirm the license on the original page before the picture is used.', ...(people ? [PEOPLE_NOTE] : [])] });
  if (raw === 'cc0' || raw === 'pdm') return review(['Public domain dedication: no conditions on use.'], false, true);
  if (raw === 'by') return review(['CC BY allows commercial use and adaptation if the creator is credited and changes are indicated.'], true, true);
  if (/sa$|-sa$/.test(raw) || raw.includes('-sa')) return review(['CC BY-SA requires adaptations to be shared under the same license; whether an advertisement counts as an adaptation is unclear, so this picture is risky for a client\'s ad.'], true);
  return { ...base, status: 'blocked', commercialUse: false, derivatives: false, attributionRequired: false, attribution: o.attribution, reasons: [`The license "${raw}" is not one LaunchPilot recognizes as allowing advertising use.`] };
}

/** A picture found on the open web (a search engine, Pinterest...): no right to reuse it is granted by being found. */
export function referenceVerdict(platform: string | null): LicenseVerdict {
  return {
    status: 'blocked',
    license: 'No license: reference only',
    licenseUrl: null,
    commercialUse: false,
    derivatives: false,
    attributionRequired: false,
    attribution: null,
    reasons: [`${platform ? `${platform} results` : 'Search results'} grant no right to download, copy, alter or reuse the picture. It is shown for inspiration, with a link to its source.`],
  };
}
